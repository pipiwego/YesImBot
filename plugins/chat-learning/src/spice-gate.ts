// spice-gate.ts —— 语气词稀疏门控 + 冲度预算 + 干净轻巧网感词盘（清洗糙汉词，服务 Style Compass）

type Word = {
  readonly w: string;
  readonly e: number;
  readonly t: "thing" | "self" | "person";
  readonly pos: string;
  readonly priv?: boolean;
};

type Cluster = {
  readonly id: string;
  readonly base: number;
  readonly minSafety: number;
  readonly moves: readonly string[];
  readonly cue: string;
  readonly read: string;
  readonly words: readonly Word[];
  readonly needBanter?: boolean;
};

export interface TurnCtx {
  channel: string;
  isPrivate: boolean;
  isMaster: boolean;
  text: string;
  sceneGate?: "work_delivery" | "comfort" | "casual"; // 向量/LLM 传入的场景闸门
  inMove?: string; // 向量/LLM 传入的 15 类 in_move 分类结果
  safety: 0 | 1 | 2 | 3; // 0生人 1普通群友 2互损老友 3Misaki(群里)
  hour: number;
  mood?: number; // mood: -1烦躁 0平 1开心（情绪余温）
  lastBotReply?: string;
  netRatio?: number; // Style Compass 计算的 net 配比（仅 net >= 0.35 时才允许给轻巧词）
}

export interface SpiceEvalResult {
  readonly words: string[];
  readonly hadRecentSpice: boolean;
  readonly hurtTriggered: boolean;
  readonly inCooldown: boolean;
  readonly hintLine: string;
}

interface ChanState {
  turn: number;
  budget: number;
  cool: number;
  recent: string[];
  hurt: number;
  banter: number;
}

const SPICE_TABLE = {
  veto: "难过|想哭|哭了|分手|挂科|被裁|裁员|生病|住院|去世|走了|焦虑|抑郁|失眠|崩溃了|撑不住|好累|不想活",
  hurt: "^(哦+|嗯+|行吧|算了|好吧|。+|…+|\\.+|你好凶|有必要吗|不至于吧?|没意思)$",
  banterIn: "急了|破防|就这|典|你不行|菜就|嘴硬|笑死你|bot就是|笨蛋|人工智障",
  clusters: [
    {
      id: "logic",
      base: 0.28,
      minSafety: 1,
      moves: ["hot_take", "meme_throw", "argue", "random_chat"],
      cue: "我觉得|其实|根本|反正|所以说|才是|应该|不就是|难道",
      read: "离谱逻辑或暴论",
      words: [
        { w: "不是", e: 1, t: "thing", pos: "句首短顿", priv: true },
        { w: "并非…", e: 1, t: "thing", pos: "二字反讽前缀", priv: true },
        { w: "不如…", e: 1, t: "thing", pos: "跨界拉踩短缀" },
        { w: "啊？", e: 0, t: "thing", pos: "单独一行" },
      ],
    },
    {
      id: "funny",
      base: 0.24,
      minSafety: 0,
      moves: ["daily_share", "self_mock", "show_off", "random_chat", "meme_throw"],
      cue: "哈哈|笑死|居然|竟然|结果|离谱|绷|乐",
      read: "荒诞好笑的日常或小翻车",
      words: [
        { w: "难绷", e: 1, t: "thing", pos: "句首或单独", priv: true },
        { w: "绷不住了", e: 1, t: "self", pos: "句尾", priv: true },
        { w: "好家伙", e: 0, t: "thing", pos: "句首", priv: true },
      ],
    },
    {
      id: "outrage",
      base: 0.22,
      minSafety: 1,
      moves: ["daily_share", "random_chat", "complain", "hot_take"],
      cue: "有个人|同事|室友|队友|网上|新闻|主播|老板|甲方|路人",
      read: "围观第三方奇葩操作",
      words: [
        { w: "离谱", e: 0, t: "thing", pos: "任意", priv: true },
        { w: "这也行", e: 0, t: "thing", pos: "句尾", priv: true },
        { w: "逆天", e: 1, t: "thing", pos: "只评事不评人", priv: true },
      ],
    },
    {
      id: "doom",
      base: 0.22,
      minSafety: 1,
      moves: ["flag", "self_mock", "tech_bug", "urge_team", "complain"],
      cue: "输了|又输|翻车|没了|完蛋|这次一定|保证|flag|立个|稳了|连跪|迟到|洒",
      read: "Flag立稳或小倒霉翻车",
      words: [
        { w: "寄", e: 1, t: "thing", pos: "单独或句尾", priv: false },
        { w: "完了", e: 0, t: "thing", pos: "句首", priv: true },
        { w: "好家伙", e: 0, t: "thing", pos: "句首", priv: true },
      ],
    },
    {
      id: "crash",
      base: 0.2,
      minSafety: 0,
      moves: ["tech_bug"],
      cue: "报错|崩了|闪退|蓝屏|error|Error|炸了|卡死|打不开|跑不起来",
      read: "程序或硬件物理罢工",
      words: [
        { w: "崩了", e: 0, t: "thing", pos: "任意", priv: true },
        { w: "炸了", e: 0, t: "thing", pos: "任意", priv: true },
      ],
    },
    {
      id: "stereo",
      base: 0.18,
      minSafety: 2,
      moves: ["flag", "hot_take", "show_off", "argue", "self_mock"],
      cue: "又|果然|每次|老样子|我就说|一如既往|还是",
      read: "熟人一如既往兑现预言",
      words: [
        { w: "经典", e: 1, t: "thing", pos: "句首" },
        { w: "没…闹麻了", e: 1, t: "thing", pos: "短促拆台句式" },
        { w: "…不赖", e: 0, t: "thing", pos: "冷幽默轻夸", priv: true },
      ],
    },
    {
      id: "counter",
      base: 0.35,
      minSafety: 2,
      moves: ["tease_bot", "argue"],
      needBanter: true,
      cue: "诗音|你|bot|机器人|笨|蠢|菜",
      read: "对方先挑衅开涮，体面回敬",
      words: [
        { w: "嘴硬", e: 1, t: "person", pos: "任意" },
        { w: "就这", e: 1, t: "thing", pos: "短促反问" },
      ],
    },
    {
      id: "wow",
      base: 0.2,
      minSafety: 0,
      moves: ["show_off", "daily_share"],
      cue: "做了|画了|拿到|抽到|买了|上岸|通过|出了|出货|双金|金光",
      read: "对方晒出货或成果，酸溜溜挑刺或暗夸",
      words: [
        { w: "有点东西", e: 0, t: "thing", pos: "任意", priv: true },
        { w: "好家伙", e: 0, t: "thing", pos: "句首", priv: true },
      ],
    },
  ] satisfies readonly Cluster[],
  softPriv: ["欸——", "呜", "真是的", "笨蛋"] as const,
  banAlways: "傻逼|sb|nmsl|寄吧|小丑|下头|普信|蝻|女拳|孝子|我是你爹|屌|逼|我草|卧槽|妈的|老哥|牛逼|死妈|像史",
};

const S = new Map<string, ChanState>();
const C: readonly Cluster[] = SPICE_TABLE.clusters;
const re = (s: string) => new RegExp(s, "i");
const VETO = re(SPICE_TABLE.veto);
const HURT = re(SPICE_TABLE.hurt);
const BANTER_IN = re(SPICE_TABLE.banterIn);
const NO_SPICE_MOVES = new Set(["late_emo", "praise_bot", "ask_help", "complain_serious"]);

const MOVE_PRIMARY_CLUSTER: Record<string, string> = {
  hot_take: "logic",
  meme_throw: "funny",
  self_mock: "funny",
  daily_share: "funny",
  complain: "outrage",
  flag: "doom",
  urge_team: "doom",
  tech_bug: "crash",
  show_off: "wow",
  tease_bot: "counter",
  argue: "counter",
};

// 观测上轮是否已损过人或用过网感梗词（用于触发多轮审美疲劳回落）
const FATIGUE_MARKERS = [
  "难绷",
  "绷不住了",
  "好家伙",
  "逆天",
  "离谱",
  "寄",
  "经典",
  "嘴硬",
  "有点东西",
  "记本子上",
  "小本子",
  "吃席",
  "痛风",
];

export function hasRecentBanterOrMeme(replyText: string | undefined): boolean {
  if (!replyText) return false;
  return FATIGUE_MARKERS.some((w) => replyText.includes(w)) || /(^|\n)不是[，, ]/.test(replyText);
}

const ALL_WORDS = [
  ...new Set(C.flatMap((c) => c.words.filter((w) => w.e >= 1 && w.w !== "不是" && w.w !== "？").map((w) => w.w))),
];

const spiky = (r: string) =>
  ALL_WORDS.filter((w) => r.includes(w)).concat(/(^|\n)不是[，, ]/.test(r) ? ["不是"] : []);

const BUDGET_MAX = 3;
const REGEN = 0.5;

function st(ch: string): ChanState {
  let s = S.get(ch);
  if (!s) {
    s = { turn: 0, budget: 2, cool: 0, recent: [], hurt: 0, banter: 0 };
    S.set(ch, s);
  }
  return s;
}

export function observeReply(ch: string, reply: string): void {
  const s = st(ch);
  const used = spiky(reply);
  if (!used.length) return;
  const cost = Math.max(...used.map((w) => C.flatMap((c) => c.words).find((x) => x.w === w)?.e ?? 1)) + 1;
  s.budget = Math.max(0, s.budget - cost);
  s.cool = Math.max(s.cool, 1 + Math.ceil(cost / 2));
  s.recent = [...used, ...s.recent].slice(0, 10);
}

function maxEdge(c: TurnCtx, s: ChanState): number {
  if (c.isPrivate && c.isMaster) return 1;
  const cap = [0, 1, 2, 3][c.safety] - (s.hurt > 0 ? 2 : 0) - (c.mood === 1 ? 1 : 0);
  return Math.min(cap, Math.floor(s.budget));
}

export function evaluateSpice(c: TurnCtx): SpiceEvalResult {
  const s = st(c.channel);
  s.turn++;
  s.budget = Math.min(BUDGET_MAX, s.budget + REGEN);
  s.cool = Math.max(0, s.cool - 1);
  s.hurt = Math.max(0, s.hurt - 1);
  s.banter = Math.max(0, s.banter - 1);
  const t = c.text.trim();
  const hadSpice = hasRecentBanterOrMeme(c.lastBotReply);

  if (hadSpice && HURT.test(t)) {
    s.hurt = 6;
    s.budget = 0;
    return {
      words: [],
      hadRecentSpice: true,
      hurtTriggered: true,
      inCooldown: true,
      hintLine: `刚才可能有点扎到对方，这轮收起锋芒轻巧找补一句，不玩梗`,
    };
  }
  if (BANTER_IN.test(t) || c.inMove === "tease_bot" || c.inMove === "argue") {
    s.banter = Math.max(s.banter, 3);
  }
  if (
    c.sceneGate === "comfort" ||
    c.sceneGate === "work_delivery" ||
    c.inMove === "late_emo" ||
    NO_SPICE_MOVES.has(c.inMove ?? "") ||
    VETO.test(t) ||
    (c.netRatio !== undefined && c.netRatio < 0.35)
  ) {
    return {
      words: [],
      hadRecentSpice: hadSpice,
      hurtTriggered: false,
      inCooldown: s.cool > 0,
      hintLine: "",
    };
  }
  if (s.cool > 0) {
    return {
      words: [],
      hadRecentSpice: hadSpice,
      hurtTriggered: false,
      inCooldown: true,
      hintLine: "",
    };
  }

  const primaryClusterId = c.inMove ? MOVE_PRIMARY_CLUSTER[c.inMove] : undefined;
  const cand = C.map((cl) => {
    const moveHit = cl.moves.includes(c.inMove ?? "") ? 1.0 : 0;
    const primaryBonus = cl.id === primaryClusterId ? 0.5 : 0;
    const cueHit = re(cl.cue).test(t) ? 1.0 : 0;
    return {
      cl,
      sc: moveHit + primaryBonus + cueHit,
    };
  })
    .filter((x) => x.sc >= 1.2 && c.safety >= x.cl.minSafety && (!x.cl.needBanter || s.banter > 0))
    .sort((a, b) => b.sc - a.sc);

  if (!cand.length) {
    return { words: [], hadRecentSpice: hadSpice, hurtTriggered: false, inCooldown: false, hintLine: "" };
  }

  const { cl } = cand[0]!;
  const lim = maxEdge(c, s);
  const pool = cl.words.filter(
    (w) =>
      w.e <= lim &&
      !s.recent.includes(w.w) &&
      (!(c.isPrivate && c.isMaster) || w.priv) &&
      (w.t !== "person" || s.banter > 0 || c.safety >= 2),
  );
  if (!pool.length) {
    return { words: [], hadRecentSpice: hadSpice, hurtTriggered: false, inCooldown: false, hintLine: "" };
  }

  const pick = [...pool].slice(0, 2);
  const formatted = pick.map((w) => `「${w.w}」(${w.pos})`).join(" / ");
  return {
    words: pick.map((w) => w.w),
    hadRecentSpice: hadSpice,
    hurtTriggered: false,
    inCooldown: false,
    hintLine: `spice: ${formatted}`,
  };
}

export function spiceHint(c: TurnCtx): string {
  const res = evaluateSpice(c);
  return res.hintLine;
}
