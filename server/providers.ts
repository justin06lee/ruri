import {
  createProvider,
  loadHostEngineConfig,
  loadProviders,
  parseModelRef,
  type ModelRef,
  type Provider,
  type ProviderConfigEntry,
} from "@justin06lee/yagami";
import type { ModelChoice } from "../shared/protocol.js";

/**
 * Non-Claude coding harnesses (Codex, OpenCode, Gemini, any ACP agent),
 * driven through yagami's provider layer. Claude sessions keep the full
 * AgentSession treatment (tools, permissions, streaming); everything else
 * runs sandboxed completion turns with resume — see ProviderTurnSession.
 *
 * Model ids follow yagami's convention: "codex:gpt-5.3" routes to Codex,
 * a bare "codex" means that harness's default model, and anything else is
 * a Claude model.
 */
export class ProviderRegistry {
  private readonly config: Record<string, ProviderConfigEntry>;
  /** Installed providers, detected once at startup (claude excluded). */
  private readonly installed = new Map<string, Provider>();

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
        if (id !== "claude") this.installed.set(id, provider);
      }
    } catch {
      // no providers is fine — ruri just stays Claude-only
    }
  }

  /** Split a model id into provider + native model (Claude when no prefix). */
  parse(model: string | undefined): ModelRef {
    return parseModelRef(model, this.installed.keys());
  }

  /** Build a provider instance working in the given project directory. */
  createFor(id: string, workDir: string): Provider {
    const entry = this.config[id] ?? {};
    // Codex defaults to read-only in yagami (API safety); a ruri session is
    // a coding session, so it gets workspace-write unless config says else.
    const patched: ProviderConfigEntry =
      id === "codex" && !entry.sandbox ? { ...entry, sandbox: "workspace-write" } : entry;
    return createProvider(id, patched, { workDir, appName: "ruri" });
  }

  /**
   * Model choices across every installed harness, qualified ids ready for
   * the picker. listModels can spawn a short-lived process per provider, so
   * this runs once in the background with a timeout; a harness that won't
   * answer still contributes its default-model entry.
   */
  async modelChoices(): Promise<ModelChoice[]> {
    const choices = await Promise.all(
      [...this.installed.entries()].map(async ([id, provider]) => {
        try {
          const models = await Promise.race([
            provider.listModels(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000)),
          ]);
          if (models.length > 0) {
            return models.map((m) => ({
              value: `${id}:${m.id}`,
              displayName: `${provider.label} · ${m.display_name}`,
              provider: id,
            }));
          }
        } catch {
          // fall through to the default-model entry
        }
        return [{ value: id, displayName: `${provider.label} · default`, provider: id }];
      }),
    );
    return choices.flat();
  }
}
