import { createWebLLMProxy } from "./proxy.mjs";
import { models } from "./catalog.mjs";

globalThis.DiscordTranslatorWebLLM = createWebLLMProxy({
  models,
  extensionApi: globalThis.browser ?? globalThis.chrome,
  Shared: globalThis.DiscordTranslatorShared
});
