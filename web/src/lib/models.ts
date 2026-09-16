import type { ModelChoice } from "../../../shared/protocol";

/** The name to put on a card asking for permission: the harness the channel
 *  runs on, since it is the one asking — not Claude by default. */
export function harnessName(models: ModelChoice[], model: string | undefined, fallback: string): string {
  const choice = models.find((m) => m.value === (model || fallback));
  return choice?.providerLabel ?? "Claude";
}

/** "claude-fable-5-1[1m]" → "Fable 5.1": a label for a model id the catalog
 *  has not described yet (the composer's trigger before the catalog lands). */
export function roughName(id: string): string {
  const bare = id.replace(/^claude-/, "").replace(/\[1m\]$/, "").replace(/-\d{8}$/, "");
  const match = /^([a-z]+)(?:-(\d+(?:-\d+)*))?$/.exec(bare);
  if (!match) return id;
  const family = `${match[1]![0]!.toUpperCase()}${match[1]!.slice(1)}`;
  return match[2] ? `${family} ${match[2].replace(/-/g, ".")}` : family;
}
