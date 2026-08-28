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

/**
 * Claude's supportedModels list, cleaned for the catalog: the "default"
 * alias goes (the picker has its own quiet default row), and marketing
 * parentheticals ("(recommended)", "(1M context)") come off the names.
 */
export function cleanClaudeModels(list: ModelChoice[]): ModelChoice[] {
  return list
    .filter((m) => m.value !== "default")
    .map((m) => ({ ...m, displayName: m.displayName.replace(/\s*\(.*\)\s*$/, "") }));
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
          return cleanClaudeModels(
            (await probe(this.claude)).map((m) => ({ value: m.id, displayName: m.display_name })),
          );
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
