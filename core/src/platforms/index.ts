import type { Context } from "koishi";

import type { Messenger } from "../messengers/index.js";
import { MilkyTranslator } from "./milky.js";
import { OneBotTranslator } from "./onebot.js";

export function registerPlatforms(ctx: Context, messenger: Messenger): () => void {
  const disposeMilky = messenger.use(new MilkyTranslator(ctx));
  const disposeOneBot = messenger.use(new OneBotTranslator(ctx));
  return () => {
    disposeMilky();
    disposeOneBot();
  };
}
