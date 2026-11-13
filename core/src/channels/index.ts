import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Context, Logger } from "koishi";

import { Conversation } from "../conversations/index.js";
import type { ConversationCompactConfig } from "../conversations/index.js";
import { ChannelResources, type Disposer, type ResourceReader, type Resources } from "../resources/index.js";
import { type ChannelContext, type ChannelKey, deriveChannelKey } from "./context.js";

// ─── Types ─────────────────────────────────────────────────────────────────

type ChannelManifest = ChannelContext & { readonly createdAt: string };

/** 准入/扫描类日志的节流窗口：同一 (平台|频道|原因) 5 分钟内只放行一条。 */
export const ADMISSION_LOG_WINDOW_MS = 5 * 60_000;

/**
 * 准入失败日志节流器。
 *
 * 为什么需要：白名单外/缺 channelId/manifest 损坏这三条路径原先都是直接 `return`，
 * 一条日志都没有，磁盘上却留下 `guild-milky-7777` 这类孤儿目录 —— 消息被静默丢弃
 * 却无从查证。加上日志后最怕刷屏（一个非白名单群每 5 秒一条），所以按
 * (code|平台|频道|原因) 做窗口节流，并把被压掉的条数带回下一条日志。
 */
export class AdmissionThrottle {
  private readonly seen = new Map<string, { at: number; suppressed: number }>();

  public constructor(
    private readonly windowMs: number = ADMISSION_LOG_WINDOW_MS,
    private readonly limit = 500,
  ) {}

  public allow(key: string, now: number = Date.now()): { allowed: boolean; suppressed: number } {
    const entry = this.seen.get(key);
    if (entry && now - entry.at < this.windowMs) {
      entry.suppressed += 1;
      return { allowed: false, suppressed: entry.suppressed };
    }
    const suppressed = entry?.suppressed ?? 0;
    if (!entry && this.seen.size >= this.limit) this.prune(now);
    this.seen.set(key, { at: now, suppressed: 0 });
    return { allowed: true, suppressed };
  }

  public reset(): void {
    this.seen.clear();
  }

  public get size(): number {
    return this.seen.size;
  }

  private prune(now: number): void {
    for (const [key, value] of this.seen) {
      if (now - value.at >= this.windowMs) this.seen.delete(key);
    }
  }
}

export interface ChannelsOptions {
  readonly basePath: string;
  readonly logLevel?: number;
  readonly imageInput?: boolean;
  readonly readTimeoutMs?: number;
  readonly compactConfig?: ConversationCompactConfig;
}

// ─── Channel ───────────────────────────────────────────────────────────────

export class Channel {
  public readonly resources: ChannelResources;
  public readonly conversation: Conversation;

  public constructor(
    public readonly context: ChannelContext,
    public readonly root: string,
    imageInput = false,
    readTimeoutMs = 10_000,
    compactConfig: ConversationCompactConfig = { minMessages: 20, maxFailures: 3 },
  ) {
    this.resources = new ChannelResources(root, imageInput, readTimeoutMs);
    this.conversation = new Conversation(root, compactConfig);
  }
}

// ─── Channels ──────────────────────────────────────────────────────────────

export class Channels implements Resources {
  private readonly channelsPath: string;
  private readonly manifests = new Map<string, ChannelManifest>();
  private readonly channels = new Map<string, Channel>();
  private readonly creating = new Map<string, Promise<Channel>>();
  private readonly readers = new Map<string, ResourceReader>();
  private readonly readerDisposers = new Map<ResourceReader, Map<Channel, Disposer>>();
  private readonly imageInput: boolean;
  private readonly readTimeoutMs: number;
  private readonly compactConfig: ConversationCompactConfig;
  private readonly logger: Logger;
  /** manifest 损坏日志节流：同一目录同一原因 5 分钟一条 */
  private readonly admission = new AdmissionThrottle();
  private readonly started: Promise<void>;

  public constructor(ctx: Context, options: ChannelsOptions) {
    this.channelsPath = resolve(options.basePath, "channels");
    this.imageInput = options.imageInput ?? false;
    this.readTimeoutMs = options.readTimeoutMs ?? 10_000;
    this.compactConfig = options.compactConfig ?? { minMessages: 20, maxFailures: 3 };
    this.logger = ctx.logger("channels");
    this.logger.level = options.logLevel ?? 2;
    this.started = this.scan();
  }

  public start(): Promise<void> {
    return this.started;
  }

  public async resolve(ctx: ChannelContext): Promise<Channel> {
    ctx = normalizeLegacyScope(ctx);
    await this.started;
    const key = deriveChannelKey(ctx);
    const cached = this.channels.get(key);
    if (cached) return cached;
    const creating = this.creating.get(key);
    if (creating) return creating;
    const task = this.create(ctx, key);
    this.creating.set(key, task);
    try {
      return await task;
    } finally {
      this.creating.delete(key);
    }
  }

  public async get(ctx: ChannelContext): Promise<ChannelResources> {
    return (await this.resolve(ctx)).resources;
  }

  public use(reader: ResourceReader): Disposer {
    if (this.readers.has(reader.scheme)) throw new Error(`Resource reader for scheme "${reader.scheme}" is already registered`);
    const disposers = new Map<Channel, Disposer>();
    this.readers.set(reader.scheme, reader);
    this.readerDisposers.set(reader, disposers);
    for (const channel of this.channels.values()) {
      disposers.set(channel, channel.resources.use(reader));
    }
    return () => {
      if (this.readers.get(reader.scheme) !== reader) return;
      this.readers.delete(reader.scheme);
      this.readerDisposers.delete(reader);
      for (const dispose of disposers.values()) dispose();
    };
  }

  public async reset(ctx: ChannelContext): Promise<void> {
    const channel = await this.resolve(ctx);
    this.logger.debug("channels.reset", { key: deriveChannelKey(ctx), root: channel.root });
    await Promise.all([
      fs.rm(join(channel.root, "sessions"), { recursive: true, force: true }),
      channel.resources.assets.clear(),
      channel.resources.artifacts.clear(),
    ]);
    this.channels.delete(deriveChannelKey(ctx));
  }

  private async create(ctx: ChannelContext, key: ChannelKey): Promise<Channel> {
    const root = await this.ensureRoot(ctx);
    const channel = new Channel(ctx, root, this.imageInput, this.readTimeoutMs, this.compactConfig);
    for (const reader of this.readers.values()) {
      this.readerDisposers.get(reader)!.set(channel, channel.resources.use(reader));
    }
    await channel.conversation.init();
    this.channels.set(key, channel);
    this.logger.debug("channels.resolve.created", { key, root });
    return channel;
  }

  private async scan(): Promise<void> {
    await fs.mkdir(this.channelsPath, { recursive: true });
    for (const entry of await fs.readdir(this.channelsPath, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory()) {
        this.logger.error("storage.directory.invalid", { entry: entry.name });
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(await fs.readFile(join(this.channelsPath, entry.name, "channel.json"), "utf8")) as unknown;
        const manifest = parseManifest(raw);
        const canonical = channelDirectoryName(manifest);

        if (entry.name === canonical) {
          // Directory name is already canonical; rewrite manifest if raw was normalized (e.g. userId added)
          if (!manifestMatchesRaw(raw, manifest)) {
            await fs.writeFile(join(this.channelsPath, entry.name, "channel.json"), `${JSON.stringify(manifest, null, 2)}\n`);
          }
          this.manifests.set(deriveChannelKey(manifest), manifest);
          continue;
        }

        // Directory name differs from canonical — check known legacy formats
        const legacyNames = legacyDirectoryNames(raw, manifest);
        if (legacyNames.includes(entry.name)) {
          await this.migrateLegacyDirectory(entry.name, canonical, manifest);
          this.manifests.set(deriveChannelKey(manifest), manifest);
        } else {
          throw new Error("Manifest directory name does not match directory");
        }
      } catch (cause) {
        this.logManifestFailure(entry.name, raw, cause);
      }
    }
  }

  /**
   * manifest 坏掉的频道不会进内存表：它的历史与上下文对运维等于消失了。
   * 旧实现只打 `{ directoryName, cause }`，`cause` 是 Error 实例 —— 序列化后是 `{}`，
   * 于是既看不到平台/频道，也看不到真正原因，等同于静默。现在给出
   * 「平台 + 频道 id + 可读原因」，并按目录+原因节流。
   */
  private logManifestFailure(directoryName: string, raw: unknown, cause: unknown): void {
    try {
      const reason = cause instanceof Error ? cause.message : String(cause);
      const scope = describeDirectoryScope(directoryName, raw);
      const key = `storage.manifest_invalid|${scope.platform}|${scope.channelId}|${reason}`;
      const { allowed, suppressed } = this.admission.allow(key);
      if (!allowed) return;
      this.logger.warn({
        code: "storage.manifest_invalid",
        directoryName,
        ...scope,
        reason,
        ...(suppressed > 0 ? { suppressedSinceLastLog: suppressed } : {}),
      });
    } catch {
      // 日志失败不能影响启动扫描
    }
  }

  private async migrateLegacyDirectory(sourceDirectory: string, destinationDirectory: string, manifest: ChannelManifest): Promise<void> {
    const destination = join(this.channelsPath, destinationDirectory);
    if (sourceDirectory !== destinationDirectory) {
      try {
        const destinationStat = await fs.lstat(destination);
        if (destinationStat.isSymbolicLink()) throw new Error("Channel storage migration destination is a symbolic link");

        // A prior version may have created the canonical directory while the legacy shared directory
        // remained. Preserve both by quarantining the canonical copy, then migrate the legacy data.
        const quarantine = join(this.channelsPath, `.conflict-${destinationDirectory}-${randomUUID()}`);
        await fs.rename(destination, quarantine);
        this.logger.warn("storage.manifest_conflict_quarantined", { sourceDirectory, destinationDirectory, quarantine });
      } catch (cause) {
        if (!(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")) throw cause;
      }
      await fs.rename(join(this.channelsPath, sourceDirectory), destination);
      await fs.writeFile(join(destination, "channel.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      this.logger.info("storage.manifest_migrated", { sourceDirectory, destinationDirectory });
      return;
    }
    await fs.writeFile(join(destination, "channel.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  private async ensureRoot(ctx: ChannelContext): Promise<string> {
    const key = deriveChannelKey(ctx);
    if (!this.manifests.has(key)) {
      const directory = channelDirectoryName(ctx);
      const root = join(this.channelsPath, directory);
      try {
        const stat = await fs.lstat(root);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Channel storage destination is not a directory");
        const manifest = parseManifest(JSON.parse(await fs.readFile(join(root, "channel.json"), "utf8")));
        if (deriveChannelKey(manifest) !== key) throw new Error("Channel storage integrity mismatch");
        this.manifests.set(key, manifest);
      } catch (cause) {
        if (!(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")) throw cause;
        const temporary = join(this.channelsPath, `.${directory}.${randomUUID()}.tmp`);
        const manifest = { ...ctx, createdAt: new Date().toISOString() } as ChannelManifest;
        try {
          await fs.mkdir(temporary);
          await fs.writeFile(join(temporary, "channel.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
          await fs.rename(temporary, root);
        } finally {
          await fs.rm(temporary, { recursive: true, force: true });
        }
        this.manifests.set(key, manifest);
      }
    }
    const root = join(this.channelsPath, channelDirectoryName(ctx));
    if ((await fs.lstat(root)).isSymbolicLink()) throw new Error("Channel directory is a symbolic link");
    const realRoot = await fs.realpath(root);
    const rel = relative(this.channelsPath, realRoot);
    if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error("Resolved storage path escapes its channel root");
    return root;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

export function channelDirectoryName(ctx: ChannelContext): string {
  switch (ctx.type) {
    case "channel": {
      const guildId = ctx.guildId;
      return ["channel", encodeDirectorySegment(ctx.platform), encodeDirectorySegment(guildId), encodeDirectorySegment(ctx.channelId)].join("-");
    }
    case "guild": {
      const guildId = ctx.guildId;
      return ["guild", encodeDirectorySegment(ctx.platform), encodeDirectorySegment(guildId)].join("-");
    }
    case "direct": {
      const userId = ctx.userId;
      const selfId = ctx.selfId;
      return ["direct", encodeDirectorySegment(ctx.platform), encodeDirectorySegment(userId), encodeDirectorySegment(selfId)].join("-");
    }
  }
}

function encodeDirectorySegment(value: string): string {
  return [...value].map((char) => (/[A-Za-z0-9]/.test(char) ? char : `%${char.codePointAt(0)!.toString(16)}%`)).join("");
}

/** `encodeDirectorySegment` 的逆运算，用于从目录名反解出人类可读的 id。 */
function decodeDirectorySegment(value: string): string {
  try {
    return value.replace(/%([0-9a-f]+)%/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
  } catch {
    return value;
  }
}

/**
 * manifest 读不出来时，尽最大努力从「原始 JSON」和「目录名」（canonical 命名
 * `channel-<platform>-<guild>-<channel>` / `guild-<platform>-<guild>` /
 * `direct-<platform>-<user>-<self>`）还原平台与频道，供日志定位。
 */
function describeDirectoryScope(directoryName: string, raw: unknown): { platform: string; type: string; channelId: string } {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const pick = (key: string): string => {
    const value = source[key];
    return typeof value === "string" && value.trim() ? value.trim() : "";
  };
  const segments = directoryName.split("-").map((segment) => decodeDirectorySegment(segment));
  const kind = segments[0] ?? "";
  const known = kind === "channel" || kind === "guild" || kind === "direct" || kind === "shared";
  const type = pick("type") || kind || "unknown";
  const platform = pick("platform") || (known ? (segments[1] ?? "") : "");
  let channelId = pick("channelId");
  if (!channelId) {
    if (type === "channel") channelId = segments[3] ?? segments[2] ?? "";
    else if (type === "guild" || type === "shared") channelId = segments[2] ?? "";
    else if (type === "direct") channelId = segments[2] ?? "";
  }
  return { platform, type, channelId };
}

function legacyDirectoryNames(raw: unknown, manifest: ChannelManifest): string[] {
  const names: string[] = [];
  const obj = raw as Record<string, unknown> | null;

  // Legacy shared: old type "shared" with directory "shared-<platform>-<channelId>"
  if (typeof obj === "object" && obj !== null && obj.type === "shared") {
    names.push(["shared", encodeDirectorySegment(manifest.platform), encodeDirectorySegment(manifest.channelId)].join("-"));
  }

  // Legacy direct: old directory used channelId where canonical now uses userId
  if (typeof obj === "object" && obj !== null && obj.type === "direct" && typeof obj.channelId === "string" && typeof obj.selfId === "string") {
    const channelIdDir = [
      "direct",
      encodeDirectorySegment(manifest.platform),
      encodeDirectorySegment(obj.channelId as string),
      encodeDirectorySegment(obj.selfId as string),
    ].join("-");
    if (channelIdDir !== channelDirectoryName(manifest)) {
      names.push(channelIdDir);
    }
  }

  return names;
}

function manifestMatchesRaw(raw: unknown, manifest: ChannelManifest): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(manifest)) {
    if (obj[key] !== (manifest as unknown as Record<string, unknown>)[key]) return false;
  }
  return Object.keys(obj).length === Object.keys(manifest).length;
}

/**
 * Normalise a legacy ChannelContext (type: "shared" | "direct" without userId)
 * to the canonical ChannelContext shape so old callers keep working during migration.
 */
function normalizeLegacyScope(ctx: ChannelContext): ChannelContext {
  const raw = ctx as ChannelContext & { type: string };
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime migration for old "shared" type
  if ((raw.type as string) === "shared") {
    const legacy = ctx as unknown as { platform: string; channelId: string; guildId?: string };
    const guildId = legacy.guildId ?? legacy.channelId;
    if (guildId !== legacy.channelId) {
      return { type: "channel", platform: legacy.platform, channelId: legacy.channelId, guildId };
    }
    return { type: "guild", platform: legacy.platform, channelId: legacy.channelId, guildId };
  }
  if (raw.type === "direct") {
    const legacy = ctx as unknown as { platform: string; channelId: string; selfId: string; userId?: string };
    if (!legacy.userId) {
      return { type: "direct", platform: legacy.platform, channelId: legacy.channelId, selfId: legacy.selfId, userId: legacy.channelId };
    }
  }
  return ctx;
}

function assertContext(ctx: ChannelContext): void {
  if (ctx.type !== "channel" && ctx.type !== "guild" && ctx.type !== "direct")
    throw new TypeError("ChannelContext.type must be 'channel', 'guild', or 'direct'");
  if (typeof ctx.platform !== "string" || ctx.platform.length === 0) throw new TypeError("ChannelContext.platform must be a non-empty string");
  if (typeof ctx.channelId !== "string" || ctx.channelId.length === 0) throw new TypeError("ChannelContext.channelId must be a non-empty string");
  if (ctx.type === "channel" && (typeof ctx.guildId !== "string" || ctx.guildId.length === 0))
    throw new TypeError("ChannelContext.guildId must be a non-empty string for type 'channel'");
  if (ctx.type === "guild" && (typeof ctx.guildId !== "string" || ctx.guildId.length === 0))
    throw new TypeError("ChannelContext.guildId must be a non-empty string for type 'guild'");
  if (ctx.type === "direct" && (typeof ctx.selfId !== "string" || ctx.selfId.length === 0))
    throw new TypeError("ChannelContext.selfId must be a non-empty string for type 'direct'");
  if (ctx.type === "direct" && (typeof ctx.userId !== "string" || ctx.userId.length === 0))
    throw new TypeError("ChannelContext.userId must be a non-empty string for type 'direct'");
}

function parseManifest(value: unknown): ChannelManifest {
  if (typeof value !== "object" || value === null) throw new Error("Channel manifest is not an object");
  const raw = value as Record<string, unknown>;
  if (typeof raw.platform !== "string" || typeof raw.createdAt !== "string") throw new Error("Channel manifest is invalid");

  // Legacy "shared" type migration
  if (raw.type === "shared") {
    const channelId = raw.channelId as string;
    const rawGuildId = raw.guildId;
    const guildId = (rawGuildId as string | undefined) ?? channelId;
    if (guildId !== channelId) {
      return { type: "channel", platform: raw.platform, channelId, guildId, createdAt: raw.createdAt } as ChannelManifest;
    }
    return { type: "guild", platform: raw.platform, channelId, guildId, createdAt: raw.createdAt } as ChannelManifest;
  }

  if (raw.type === "direct") {
    const selfId = raw.selfId as string;
    const channelId = raw.channelId as string;
    // Legacy manifests don't have userId — use channelId as fallback
    const userId = (raw.userId as string) ?? channelId;
    if (!selfId) throw new Error("Channel manifest selfId is invalid");
    return { type: "direct", platform: raw.platform, channelId, selfId, userId, createdAt: raw.createdAt } as ChannelManifest;
  }

  // New format — validate and pass through
  if (raw.type === "channel") {
    if (typeof raw.guildId !== "string" || typeof raw.channelId !== "string") throw new Error("Channel manifest is invalid");
    return raw as unknown as ChannelManifest;
  }
  if (raw.type === "guild") {
    if (typeof raw.guildId !== "string") throw new Error("Channel manifest is invalid");
    // Ensure channelId is present (= guildId for guild type)
    const channelId = (raw.channelId as string) ?? (raw.guildId as string);
    return { ...raw, channelId } as unknown as ChannelManifest;
  }

  throw new Error("Channel manifest type is invalid");
}

export { type ChannelContext, type ChannelKey, deriveChannelKey, contextFromSession, contextFromRecord } from "./context.js";
