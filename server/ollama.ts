import { warn } from "./log.js";

/**
 * Local models: what an Ollama on this machine serves, and the room a chat
 * on one needs.
 *
 * OpenCode finds a running Ollama by itself and lists its models as
 * `ollama/<name>`, so they reach the catalog through the OpenCode harness
 * with nothing done here (`opencode:ollama/<name>`). What it does not do is
 * give them room. Ollama loads a model with a 4096-token window unless the
 * model says otherwise, and its OpenAI-style endpoint — the one OpenCode
 * calls — has no way to ask for more. OpenCode's own instructions and tool
 * list are well past that, so the model is handed the tail of its prompt:
 * it never sees its tools, and answers that it wrote a file it never
 * touched.
 *
 * Ollama's own answer is a model of the same weights with the window
 * written into it, and that is what this file keeps: `<name>-ruri`, made
 * from `<name>` with `num_ctx` set. It shares the model's files, so it
 * costs no disk; it is made the first time a chat is set to the model and
 * again when the model it came from is newer; `ollama rm <name>-ruri`
 * takes it away until it is next wanted. A model that already sets a
 * window that size or larger is served as it is.
 *
 * Never throws: no Ollama, or one that is not running, is no local models.
 */

/** A chat-capable model Ollama holds. */
export interface LocalModel {
  /** Ollama's name for it: "bonsai-2:latest". */
  name: string;
  /** The model a chat on it is served by: itself, or its copy with room. */
  serve: string;
  /** The context window it is served with, in tokens. */
  window: number;
  /** What Ollama says it can do. A model that cannot call tools cannot
   *  work in a coding harness, and is left out of the catalog. */
  tools: boolean;
  vision: boolean;
  thinking: boolean;
}

/** What marks a copy made here: the end of its tag. */
export const SIZED = "-ruri";
/** The window a local model is given when it names none of its own: room
 *  for OpenCode's instructions and tools (about 10k tokens) and a working
 *  conversation, on a machine with ordinary memory. */
const DEFAULT_WINDOW = 32_768;
const LOOK_MS = 2_000;
const SHOW_MS = 5_000;
const CREATE_MS = 60_000;

interface Tag {
  name?: string;
  model?: string;
  digest?: string;
  modified_at?: string;
}

interface Shown {
  capabilities?: string[];
  parameters?: string;
  model_info?: Record<string, unknown>;
}

interface Held extends LocalModel {
  /** The copy is missing, older than its model, or sized otherwise. */
  needs: boolean;
}

/** What the last look found, by Ollama's name. */
const known = new Map<string, Held>();
/** What Ollama said of a model, kept while its digest stands. */
const shown = new Map<string, { digest: string; info: Shown }>();
/** Copies being made right now. */
const making = new Map<string, Promise<void>>();

/**
 * Where Ollama listens: `RURI_OLLAMA` when set — empty for none, which is
 * what tests and scripts set — else its usual place on this machine. Not
 * `OLLAMA_HOST`: OpenCode looks on 127.0.0.1:11434 whatever that says, and
 * a model listed here that it cannot reach would be a model that fails.
 */
export function ollamaOrigin(): string | undefined {
  const set = process.env["RURI_OLLAMA"];
  if (set === undefined) return "http://127.0.0.1:11434";
  const trimmed = set.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  return /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** The window a model with none of its own is given (`RURI_OLLAMA_CTX`). */
function wantedWindow(): number {
  const set = Number(process.env["RURI_OLLAMA_CTX"]);
  return Number.isFinite(set) && set >= 2_048 ? Math.floor(set) : DEFAULT_WINDOW;
}

async function ask<T>(url: string, ms: number, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(ms),
    ...(body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`ollama answered ${res.status}`);
  return (await res.json()) as T;
}

/** What Ollama says of one model, asked once per digest. */
async function show(origin: string, tag: Tag & { name: string }): Promise<Shown> {
  const held = shown.get(tag.name);
  if (held && tag.digest && held.digest === tag.digest) return held.info;
  const info = await ask<Shown>(`${origin}/api/show`, SHOW_MS, { model: tag.name });
  if (tag.digest) shown.set(tag.name, { digest: tag.digest, info });
  return info;
}

/** `num_ctx` as a model's own parameters set it ("num_ctx    8192"). */
function ownWindow(info: Shown): number | undefined {
  const match = /^\s*num_ctx\s+(\d+)\s*$/m.exec(info.parameters ?? "");
  return match ? Number(match[1]) : undefined;
}

/** The longest context the weights were trained for ("qwen35.context_length"). */
function trainedWindow(info: Shown): number | undefined {
  for (const [key, value] of Object.entries(info.model_info ?? {})) {
    if (key.endsWith(".context_length") && typeof value === "number" && value > 0) return value;
  }
  return undefined;
}

const when = (stamp: string | undefined): number => (stamp ? Date.parse(stamp) || 0 : 0);

/**
 * Ask Ollama what it holds. The copies made here are not models of their
 * own and are left out; so is anything that only embeds.
 */
export async function lookLocal(): Promise<LocalModel[]> {
  const origin = ollamaOrigin();
  if (!origin) {
    known.clear();
    return [];
  }
  let tags: Array<Tag & { name: string }>;
  try {
    const listed = await ask<{ models?: Tag[] }>(`${origin}/api/tags`, LOOK_MS);
    tags = (listed.models ?? [])
      .map((tag) => ({ ...tag, name: tag.name || tag.model || "" }))
      .filter((tag) => tag.name);
  } catch {
    // not installed, or not running: nothing to say, and nothing to warn of
    known.clear();
    return [];
  }
  const byName = new Map(tags.map((tag) => [tag.name, tag]));
  const want = wantedWindow();
  const found = await Promise.all(
    tags
      .filter((tag) => !tag.name.endsWith(SIZED))
      .map(async (tag): Promise<Held | undefined> => {
        try {
          const info = await show(origin, tag);
          // an Ollama too old to say what a model can do is taken at its word
          const can = info.capabilities;
          if (can && !can.includes("completion")) return undefined;
          const own = ownWindow(info);
          const wanted = Math.min(trainedWindow(info) ?? want, want);
          const base = {
            name: tag.name,
            tools: !can || can.includes("tools"),
            vision: !!can?.includes("vision"),
            thinking: !!can?.includes("thinking"),
          };
          if (own !== undefined && own >= wanted)
            return { ...base, serve: tag.name, window: own, needs: false };
          const copy = byName.get(tag.name + SIZED);
          const fresh =
            copy !== undefined &&
            when(copy.modified_at) >= when(tag.modified_at) &&
            ownWindow(await show(origin, copy)) === wanted;
          return { ...base, serve: tag.name + SIZED, window: wanted, needs: !fresh };
        } catch (err) {
          warn("ollama", err, `show ${tag.name}`);
          return undefined;
        }
      }),
  );
  known.clear();
  for (const model of found) if (model) known.set(model.name, model);
  return [...known.values()].map(({ needs: _needs, ...model }) => model);
}

/** Make a model's copy with room, once at a time per model. */
function size(model: Held): Promise<void> {
  const running = making.get(model.name);
  if (running) return running;
  const origin = ollamaOrigin();
  if (!origin) return Promise.resolve();
  const made = ask(`${origin}/api/create`, CREATE_MS, {
    model: model.serve,
    from: model.name,
    parameters: { num_ctx: model.window },
    stream: false,
  })
    .then(() => {
      model.needs = false;
    })
    .catch((err: unknown) => warn("ollama", err, `create ${model.serve}`))
    .finally(() => making.delete(model.name));
  making.set(model.name, made);
  return made;
}

/**
 * The Ollama model to ask for when a chat is on `name`: its copy with room,
 * made now if it is not there (a copy is a few bytes over files already on
 * disk, so it is there long before the harness has started and asked for
 * it). A name the last look did not find is asked for as it is.
 */
export function servingLocal(name: string): string {
  const model = known.get(name);
  if (!model) return name;
  if (model.needs) void size(model);
  return model.serve;
}

/** The same, waited for — for a caller that can wait, and for tests. */
export async function sizeLocal(name: string): Promise<string> {
  const model = known.get(name);
  if (!model) return name;
  if (model.needs) await size(model);
  return model.serve;
}

/** What the last look found for `name`. */
export function localModel(name: string): LocalModel | undefined {
  const model = known.get(name);
  if (!model) return undefined;
  const { needs: _needs, ...rest } = model;
  return rest;
}
