import {
  createProvider,
  isSessionProvider,
  loadHostEngineConfig,
  loadProviders,
  parseModelRef,
  type ModelRef,
  type Provider,
  type ProviderConfigEntry,
} from "@justin06lee/yagami";
import type { ModelChoice } from "../shared/protocol.js";

/** A Claude model as its source describes it — the startup catalog gives all
 *  of this, a live session's own report only the first two. */
export interface RawClaudeModel {
  id: string;
  display_name: string;
  description?: string;
  resolved_model?: string;
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
  const head = description?.split("·")[0]?.replace(/\s+with\s+.*$/i, "").trim();
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
  const named = list
    .filter((m) => m.id !== "default")
    .map((m) => ({
      value: m.id,
      displayName:
        nameFromId(m.resolved_model) ??
        nameFromId(m.id) ??
        nameFromDescription(m.description) ??
        known?.get(m.id) ??
        m.display_name.replace(/\s*\(.*\)\s*$/, ""),
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
export function bareModelName(name: string): string {
  const last = name.split("/").pop()?.trim();
  return last || name;
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
    } catch {
      host = {};
    }
    this.config = host.providerConfig ?? {};
    try {
      const { providers } = loadProviders(this.config, { appName: "ruri" });
      for (const [id, provider] of providers) {
        if (id === "claude") this.claude = provider;
        else this.installed.set(id, provider);
      }
    } catch {
      // no providers is fine — ruri just stays Claude-only
    }
  }

  /** Split a model id into provider + native model (Claude when no prefix). */
  parse(model: string | undefined): ModelRef {
    return parseModelRef(model, [...this.installed.keys(), "claude"]);
  }

  /** Build a provider instance working in the given project directory. */
  createFor(id: string, workDir: string): Provider {
    const entry = this.config[id] ?? {};
    // Only affects the run()-per-turn FALLBACK path: codex defaults to
    // read-only there (API safety), and a ruri session is a coding session.
    // The agentic openSession path ignores this — the harness's own config
    // governs, verbatim.
    const patched: ProviderConfigEntry =
      id === "codex" && !entry.sandbox ? { ...entry, sandbox: "workspace-write" } : entry;
    return createProvider(id, patched, { workDir, appName: "ruri" });
  }

  /**
   * Model choices across every installed harness, ready for the picker:
   * Claude's own models (bare ids — the same list a live session reports,
   * so the picker is full before any session has run) and every other
   * harness's models as qualified ids. listModels can spawn a short-lived
   * process per provider, so this runs once in the background with a
   * timeout; a harness that won't answer still contributes its
   * default-model entry.
   */
  async modelChoices(): Promise<{ claude: ModelChoice[]; harnesses: ModelChoice[] }> {
    const probe = (provider: Provider) =>
      Promise.race([
        provider.listModels(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 15_000)),
      ]);
    const [claude, harnesses] = await Promise.all([
      (async () => {
        try {
          if (!this.claude) return [];
          return cleanClaudeModels(await probe(this.claude));
        } catch {
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
              }));
            }
          } catch {
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
    return { claude, harnesses };
  }
}
