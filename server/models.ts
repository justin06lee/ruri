/**
 * The model picker: Claude models plus every installed non-Claude harness,
 * probed at startup so the list is full before any session has run, and
 * re-probed on demand (opening Settings asks) so it tracks what the
 * harnesses actually serve. A live session's own report replaces the
 * probed Claude list when it lands, so a refresh never clobbers it.
 */
import type { ModelChoice, ServerMessage } from "../shared/protocol.js";
import { cleanClaudeModels, ProviderRegistry } from "./providers.js";

export class Models {
  /** Replaced on a re-probe, which also picks up harnesses installed since launch. */
  registry = new ProviderRegistry();
  claudeModels: ModelChoice[] = [];
  /** Names worked out from the startup catalog, which is the only source that
   *  says which version a family is on. A live session reports ids and bare
   *  display names, so it borrows from here rather than undoing them. */
  readonly claudeNames = new Map<string, string>();
  providerModels: ModelChoice[] = [];
  /** Each model's context window, as a turn on it last reported it — for a
   *  chat that hasn't run a turn on it yet (server/turns.ts contextWindow). */
  readonly windows = new Map<string, number>();
  /** Told the ids of Claude's catalog whenever a list of it lands. */
  onClaude: ((ids: string[]) => void) | undefined;
  private probing = false;
  probedAt = 0;

  constructor(private readonly broadcast: (message: ServerMessage) => void) {}

  allModels = (): ModelChoice[] => [...this.claudeModels, ...this.providerModels];

  probeModels = (redetect = false): void => {
    if (this.probing) return;
    this.probing = true;
    this.probedAt = Date.now();
    // a fresh registry also picks up harnesses installed since launch
    if (redetect) this.registry = new ProviderRegistry();
    void this.registry
      .modelChoices()
      .then(({ claude, harnesses }) => {
        for (const m of claude) this.claudeNames.set(m.value, m.displayName);
        if (this.claudeModels.length === 0 && claude.length > 0) this.claudeModels = claude;
        if (claude.length > 0) this.onClaude?.(claude.map((m) => m.value));
        this.providerModels = harnesses;
        if (this.allModels().length > 0) this.broadcast({ type: "models", models: this.allModels() });
      })
      .finally(() => {
        this.probing = false;
      });
  };

  /** A live Claude session's own list (SessionEvents.onModels). */
  report = (list: ModelChoice[]): void => {
    const named = cleanClaudeModels(
      list.map((m) => ({ id: m.value, display_name: m.displayName })),
      this.claudeNames,
    );
    const cleaned = named.map((model) => ({
      ...list.find((candidate) => candidate.value === model.value),
      ...model,
    }));
    if (cleaned.length === 0 || JSON.stringify(cleaned) === JSON.stringify(this.claudeModels)) return;
    this.claudeModels = cleaned;
    this.onClaude?.(cleaned.map((m) => m.value));
    this.broadcast({ type: "models", models: this.allModels() });
  };
}
