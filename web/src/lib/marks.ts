import type { ModelChoice } from "../../../shared/protocol";

/**
 * Who made the model a chat runs on — the lab whose mark, beside its
 * product's, is doodled over an empty chat (components/Marks.tsx). Pure:
 * a model value and what the catalog says of it in, a lab (or nothing)
 * out.
 *
 * Model values come as Claude's bare ids ("claude-opus-5-5", "opus"),
 * `<harness>:<model>` for every other harness ("codex:gpt-6-astra",
 * "gemini:gemini-3-pro"), OpenCode's `<harness>:<provider>/<model>`
 * ("opencode:google/gemini-3-pro", or its own gateway's
 * "opencode:opencode/muse-spark-1.3" serving other labs' models), or a
 * harness's bare id when it named no models ("goose").
 */

export type Lab =
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "deepseek"
  | "moonshot"
  | "alibaba"
  | "zhipu"
  | "mistral"
  | "meta"
  | "minimax";

export const LABS: readonly Lab[] = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "deepseek",
  "moonshot",
  "alibaba",
  "zhipu",
  "mistral",
  "meta",
  "minimax",
];

/** Every harness ruri can run (yagami's presets). A bare value naming one
 *  is that harness's default model; anything else bare is Claude's. */
const HARNESSES = new Set([
  "claude",
  "claude-acp",
  "codex",
  "codex-acp",
  "opencode",
  "gemini",
  "goose",
  "qwen",
  "kimi",
  "grok",
  "cursor",
  "copilot",
  "kilo",
  "cline",
  "auggie",
  "amp",
  "droid",
]);

/** A provider segment (OpenCode's, OpenRouter's) that names a lab outright. */
const PROVIDER_LABS: Record<string, Lab> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  "google-vertex": "google",
  "google-vertex-anthropic": "anthropic",
  gemini: "google",
  xai: "xai",
  "x-ai": "xai",
  deepseek: "deepseek",
  moonshot: "moonshot",
  moonshotai: "moonshot",
  "moonshotai-cn": "moonshot",
  kimi: "moonshot",
  "kimi-for-coding": "moonshot",
  alibaba: "alibaba",
  "alibaba-cn": "alibaba",
  qwen: "alibaba",
  dashscope: "alibaba",
  zhipu: "zhipu",
  zhipuai: "zhipu",
  "zhipuai-coding-plan": "zhipu",
  zai: "zhipu",
  "z-ai": "zhipu",
  "zai-coding-plan": "zhipu",
  mistral: "mistral",
  mistralai: "mistral",
  meta: "meta",
  "meta-llama": "meta",
  minimax: "minimax",
  "minimax-cn": "minimax",
};

/** What a model's own name gives away, first match wins. */
const NAME_LABS: Array<[RegExp, Lab]> = [
  [/claude|(?:^|[^a-z])(?:opus|sonnet|haiku|fable)(?:[^a-z]|$)/, "anthropic"],
  [/devstral|codestral|magistral|ministral|mistral|mixtral|pixtral/, "mistral"],
  [/chatgpt|gpt|codex|(?:^|[^a-z0-9])o\d/, "openai"],
  [/gemini|gemma/, "google"],
  [/grok/, "xai"],
  [/deepseek/, "deepseek"],
  [/kimi|moonshot/, "moonshot"],
  [/qwen|qwq|qvq/, "alibaba"],
  [/glm|zhipu|(?:^|[^a-z])z-?ai(?:[^a-z]|$)/, "zhipu"],
  [/llama|muse/, "meta"],
  [/minimax|abab|hailuo/, "minimax"],
];

/** A harness that only ever runs its own maker's models. */
const HARNESS_LABS: Record<string, Lab> = {
  claude: "anthropic",
  "claude-acp": "anthropic",
  codex: "openai",
  "codex-acp": "openai",
  gemini: "google",
  qwen: "alibaba",
  kimi: "moonshot",
  grok: "xai",
};

export interface MarkPick {
  /** Who made the model; unset when nothing says. */
  lab?: Lab;
  /** The harness serving it — "claude" for Claude's own. */
  harness: string;
  /** The model's name, for when there is no lab to draw. */
  name: string;
}

/** The harness a model value belongs to, and the rest of it. */
function split(model: string, provider: string | undefined): { harness: string; rest: string } {
  const colon = model.indexOf(":");
  if (colon > 0) return { harness: provider ?? model.slice(0, colon), rest: model.slice(colon + 1) };
  if (provider) return { harness: provider, rest: model === provider ? "" : model };
  if (HARNESSES.has(model) && model !== "claude") return { harness: model, rest: "" };
  return { harness: "claude", rest: model };
}

export function labFromName(name: string): Lab | undefined {
  const lower = name.toLowerCase();
  return NAME_LABS.find(([pattern]) => pattern.test(lower))?.[1];
}

/**
 * Whose marks a model gets: the lab a provider segment names, else the one
 * its name gives away, else the one its harness only ever runs, else none.
 */
export function markFor(model: string, choice?: Pick<ModelChoice, "provider" | "displayName">): MarkPick {
  const { harness, rest } = split(model, choice?.provider);
  const segments = rest.split("/").filter(Boolean);
  const own = segments[segments.length - 1] ?? "";
  const name = choice?.displayName || own || harness;
  const lab =
    segments
      .slice(0, -1)
      .map((segment) => PROVIDER_LABS[segment.toLowerCase()])
      .find(Boolean) ??
    labFromName(own) ??
    (choice?.displayName ? labFromName(choice.displayName) : undefined) ??
    HARNESS_LABS[harness];
  return lab ? { lab, harness, name } : { harness, name };
}
