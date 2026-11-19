import {
  createProvider,
  isSessionProvider,
  loadHostEngineConfig,
  loadProviders,
  parseModelRef,
  type ModelRef,
  type EngineModel,
  type Provider,
  type ProviderConfigEntry,
} from "@justin06lee/yagami";
import type { ModelChoice } from "../shared/protocol.js";
import { warn } from "./log.js";
import { localModel, lookLocal, servingLocal, SIZED, type LocalModel } from "./ollama.js";

/** A Claude model as its source describes it — the startup catalog gives all
 *  of this, a live session's own report only the first two. */
export interface RawClaudeModel extends Omit<EngineModel, "provider"> {
  id: string;
  display_name: string;
  description?: string;
  resolved_model?: string;
}

function modelCapabilities(model: EngineModel): Omit<ModelChoice, "value" | "displayName"> {
  return {
    ...(model.reasoning_efforts?.length
      ? {
          reasoningEfforts: model.reasoning_efforts.map((effort) => ({
            value: effort.id,
            ...(effort.description ? { description: effort.description } : {}),
          })),
        }
      : {}),
    ...(model.default_reasoning_effort ? { defaultEffort: model.default_reasoning_effort } : {}),
    ...(model.input_modalities?.length ? { inputModalities: [...model.input_modalities] } : {}),
    ...(model.supports_adaptive_thinking ? { supportsAdaptiveThinking: true } : {}),
    ...(model.supports_fast_mode ? { supportsFastMode: true } : {}),
    ...(model.supports_auto_mode ? { supportsAutoMode: true } : {}),
    ...(model.supports_personality ? { supportsPersonality: true } : {}),
    ...(model.multi_agent ? { multiAgent: model.multi_agent } : {}),
    ...(model.service_tiers?.length
      ? {
          serviceTiers: model.service_tiers.map((tier) => ({
            value: tier.id,
            label: tier.display_name,
            ...(tier.description ? { description: tier.description } : {}),
          })),
        }
      : {}),
    ...(model.default_service_tier ? { defaultServiceTier: model.default_service_tier } : {}),
    ...(model.is_default ? { providerDefault: true } : {}),
  };
}

/** "claude-haiku-4-5-20251001" → "Haiku 4.5". An id with no version in it
 *  ("opus[1m]", "sonnet") has nothing to give and says so. */
function nameFromId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const bare = id.replace(/\[1m\]$/, "").replace(/^claude-/, "");
  const match = /^([a-z]+)-((?:\d+-)*\d+)$/.exec(bare);
  if (!match) return undefined;
  // a dated build spells its release date out at the end — that is not
  // another version part, so anything that long is dropped
  const version = match[2]!
    .split("-")
    .filter((part) => part.length < 8)
    .join(".");
  if (!version) return undefined;
  return `${match[1]![0]!.toUpperCase()}${match[1]!.slice(1)} ${version}`;
}

/** "Fable 5.1 · Most capable for…" → "Fable 5.1"; "Opus 5 with 1M context ·
 *  …" → "Opus 5". Only trusted when it actually carries a number. */
function nameFromDescription(description: string | undefined): string | undefined {
  const head = description
    ?.split("·")[0]
    ?.replace(/\s+with\s+.*$/i, "")
    .trim();
  return head && /\d/.test(head) ? head : undefined;
}

/**
 * Claude's model list, cleaned for the catalog and the picker.
 *
 * The "default" alias goes (the picker has its own quiet default row), and
 * marketing parentheticals come off the names. What goes *on* is the version:
 * the CLI's display names are bare families — "Opus", "Fable", "Haiku", each
 * of which has been several different models — while the version is sitting
 * in the id the alias resolves to and in the first words of the description.
 * Those are read in that order, so the picker says which model it means.
 *
 * `known` carries names already worked out from a richer source: a live
 * session reports ids and bare display names only, and without this its
 * report would quietly strip the versions back off again.
 *
 * One parenthetical earns a replacement rather than a deletion. Cutting
 * "(1M context)" leaves the big-window model and the ordinary one sharing a
 * name, and that choice is the size of the context gauge's denominator —
 * five times over. So when two entries land on the same name, the `[1m]` one
 * keeps a short mark. A catalog listing only the big one says nothing,
 * because there is nothing to confuse it with.
 */
export function cleanClaudeModels(
  list: RawClaudeModel[],
  known?: ReadonlyMap<string, string>,
): ModelChoice[] {
  // the "default" alias goes, but which model it stands for is kept: the
  // first entry resolving to the same one is the catalog's own default
  // (shared/modelLine.ts catalogDefault), so ruri never has to name one
  const recommended = list.find((m) => m.id === "default")?.resolved_model;
  const standsFor = recommended
    ? list.find((m) => m.id !== "default" && m.resolved_model === recommended)?.id
    : undefined;
  const named = list
    .filter((m) => m.id !== "default")
    .map((m) => ({
      ...(m.id === standsFor ? { providerDefault: true as const } : {}),
      value: m.id,
      displayName:
        nameFromId(m.resolved_model) ??
        nameFromId(m.id) ??
        nameFromDescription(m.description) ??
        known?.get(m.id) ??
        m.display_name.replace(/\s*\(.*\)\s*$/, ""),
      ...modelCapabilities(m),
    }));
  const seen = new Map<string, number>();
  for (const m of named) seen.set(m.displayName, (seen.get(m.displayName) ?? 0) + 1);
  return named.map((m) =>
    m.value.includes("[1m]") && (seen.get(m.displayName) ?? 0) > 1
      ? { ...m, displayName: `${m.displayName} 1M` }
      : m,
  );
}

/**
 * A model's own name, nothing else: ACP harnesses group their catalogs and
 * prepend the group to the label ("OpenCode Zen/Big Pickle") — display
 * names carry no provenance, so everything up to the last "/" comes off.
 */
function bareModelName(name: string): string {
  const last = name.split("/").pop()?.trim();
  return last || name;
}

/** The harness local models run on, and how it names the ones Ollama
 *  serves: "opencode:ollama/bonsai-2:latest" (server/ollama.ts). */
const LOCAL_HARNESS = "opencode";
const LOCAL_PREFIX = "ollama/";
/** Under this many tokens of window, a session is briefed in a few lines
 *  (server/briefing.ts localBriefing). */
const SMALL_WINDOW = 65_536;

/** Ollama's name for a model, when the harness model is one of its. */
function localName(providerId: string | undefined, model: string | undefined): string | undefined {
  return providerId === LOCAL_HARNESS && model?.startsWith(LOCAL_PREFIX)
    ? model.slice(LOCAL_PREFIX.length)
    : undefined;
}

/**
 * The catalog's local models as ruri lists them: marked as running on this
 * machine, under Ollama's own name for them, with what Ollama says they
 * take. The copies ruri made to give them room are not models of their own
 * and go, and so does one Ollama says cannot call tools — in a coding
 * harness it could only talk. None has a reasoning level. With no word from Ollama (ruri could not
 * reach it, OpenCode could) they are listed as OpenCode reported them.
 */
export function localChoices(choices: ModelChoice[], local: readonly LocalModel[]): ModelChoice[] {
  const byName = new Map(local.map((model) => [model.name, model]));
  return choices.flatMap((choice) => {
    const name = localName(choice.provider, choice.value.slice(choice.value.indexOf(":") + 1));
    if (name === undefined) return [choice];
    if (name.endsWith(SIZED)) return [];
    const model = byName.get(name);
    if (model && !model.tools) return [];
    // the levels OpenCode lists are its default model's: set to a local
    // model, a session of its has none to choose
    const { reasoningEfforts: _levels, defaultEffort: _level, ...rest } = choice;
    return [
      {
        ...rest,
        displayName: name,
        local: "Ollama",
        ...(model ? { inputModalities: model.vision ? ["text", "image"] : ["text"] } : {}),
      },
    ];
  });
}

/**
 * Non-Claude coding harnesses (Codex, OpenCode, Gemini, any ACP agent),
 * driven through yagami's provider layer. Claude sessions keep the full
 * AgentSession treatment (tools, permissions, streaming); every other
 * harness runs verbatim through its own agentic session — see
 * ProviderAgentSession, with ProviderTurnSession as the fallback for
 * providers yagami can't open a session on.
 *
 * Model ids follow yagami's convention: "codex:gpt-5.6-sol" routes to Codex,
 * a bare "codex" means that harness's default model, and anything else is
 * a Claude model.
 */
export class ProviderRegistry {
  private readonly config: Record<string, ProviderConfigEntry>;
  /** Installed non-Claude providers, detected once at startup. */
  private readonly installed = new Map<string, Provider>();
  /** Claude itself — only used to list its models before a session runs. */
  private claude: Provider | undefined;

  constructor() {
    let host: ReturnType<typeof loadHostEngineConfig>;
    try {
      host = loadHostEngineConfig();
    } catch (err) {
      warn("providers", err, "new ProviderRegistry");
      host = {};
    }
    this.config = host.providerConfig ?? {};
    try {
      const { providers } = loadProviders(this.config, { appName: "ruri" });
      for (const [id, provider] of providers) {
        if (id === "claude") this.claude = provider;
        else this.installed.set(id, provider);
      }
    } catch (err) {
      warn("providers", err, "new ProviderRegistry");
      // no providers is fine — ruri just stays Claude-only
    }
  }

  /**
   * Split a model id into provider + native model (Claude when no prefix).
   * A local model's native id is the one it is served by: its copy with a
   * window a harness fits in, which asking for it here makes if it is not
   * there yet (server/ollama.ts) — so every chat set to one has it by the
   * time it runs, and no model nobody uses is ever copied.
   */
  parse(model: string | undefined): ModelRef {
    const ref = parseModelRef(model, [...this.installed.keys(), "claude"]);
    const local = localName(ref.providerId, ref.model);
    return local === undefined ? ref : { ...ref, model: `${LOCAL_PREFIX}${servingLocal(local)}` };
  }

  /** Have what a chat on this model needs before its first prompt: a
   *  local model's copy with room, which asking for it makes. */
  prepare(model: string | undefined): void {
    this.parse(model);
  }

  /**
   * Whether a chat on this model has too little room for ruri's whole
   * briefing: a local model served with a window under SMALL_WINDOW, or
   * one whose window is not known yet. Only a local model is ever small.
   */
  small(model: string | undefined): boolean {
    const ref = parseModelRef(model, [...this.installed.keys(), "claude"]);
    const name = localName(ref.providerId, ref.model);
    return name !== undefined && (localModel(name)?.window ?? 0) < SMALL_WINDOW;
  }

  /** Build a provider instance working in the given project directory,
   *  with `env` (the vault) laid over the harness process's environment. */
  createFor(id: string, workDir: string, env?: Record<string, string>): Provider {
    const configured = this.config[id] ?? {};
    const entry: ProviderConfigEntry = env
      ? { ...configured, env: { ...configured.env, ...env } }
      : configured;
    // Only affects the run()-per-turn FALLBACK path: codex defaults to
    // read-only there (API safety), and a ruri session is a coding session.
    // The agentic openSession path ignores this — the harness's own config
    // governs, verbatim.
    const patched: ProviderConfigEntry =
      id === "codex" && !entry.sandbox ? { ...entry, sandbox: "workspace-write" } : entry;
    const provider = createProvider(id, patched, { workDir, appName: "ruri" });
    if (id === LOCAL_HARNESS && isSessionProvider(provider)) {
      // A session set to a local model has no reasoning level to choose,
      // and asking for one fails its first turn ("effort not found"): the
      // levels are checked against the list the session opened with, which
      // is its default model's.
      const open = provider.openSession.bind(provider);
      provider.openSession = (options) => {
        if (localName(id, options.model) === undefined) return open(options);
        const { effort: _effort, ...rest } = options;
        return open(rest);
      };
    }
    return provider;
  }

  /** Whether this harness can branch a warm conversation at a reported turn. */
  canForkSession(id: string): boolean {
    const provider = this.installed.get(id);
    return provider !== undefined && isSessionProvider(provider) && provider.sessionCapabilities.fork;
  }

  /**
   * Model choices across every installed harness, ready for the picker:
   * Claude's own models (bare ids — the same list a live session reports,
   * so the picker is full before any session has run) and every other
   * harness's models as qualified ids. listModels can spawn a short-lived
   * process per provider, so this runs once in the background with a
   * timeout; a harness that won't answer still contributes its
   * default-model entry.
   *
   * Ollama is asked beside them what it serves, which is what says which of
   * OpenCode's models are local ones and how big a window each is served
   * with (`windows`, by catalog value).
   */
  async modelChoices(): Promise<{
    claude: ModelChoice[];
    harnesses: ModelChoice[];
    windows: Map<string, number>;
  }> {
    const probe = (provider: Provider) =>
      Promise.race([
        provider.listModels(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 15_000)),
      ]);
    const [local, claude, harnesses] = await Promise.all([
      this.installed.has(LOCAL_HARNESS) ? lookLocal() : Promise.resolve([]),
      (async () => {
        try {
          if (!this.claude) return [];
          return cleanClaudeModels(await probe(this.claude));
        } catch (err) {
          warn("providers", err, "probe");
          return [];
        }
      })(),
      Promise.all(
        [...this.installed.entries()].map(async ([id, provider]) => {
          // only an agentic harness has an approval flow to drive, so this is
          // what tells the composer whether a permission mode means anything
          const agentic = isSessionProvider(provider);
          try {
            const models = await probe(provider);
            if (models.length > 0) {
              return models.map((m) => ({
                value: `${id}:${m.id}`,
                displayName: bareModelName(m.display_name),
                provider: id,
                providerLabel: provider.label,
                agentic,
                ...modelCapabilities(m),
              }));
            }
          } catch (err) {
            warn("providers", err, "probe");
            // fall through to the default-model entry
          }
          return [
            {
              value: id,
              displayName: provider.label,
              provider: id,
              providerLabel: provider.label,
              agentic,
            },
          ];
        }),
      ).then((lists) => lists.flat()),
    ]);
    return {
      claude,
      harnesses: localChoices(harnesses, local),
      windows: new Map(local.map((model) => [`${LOCAL_HARNESS}:${LOCAL_PREFIX}${model.name}`, model.window])),
    };
  }
}
