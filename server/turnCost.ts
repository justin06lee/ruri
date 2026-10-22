/**
 * What one turn cost, in dollars at API list prices.
 *
 * The Claude CLI's result line carries `total_cost_usd`, but a CLI that
 * stays up across turns (every chat's does) reports there the running
 * total of its whole process, not the turn's. Taken as the turn's cost
 * and added up by the ledger, every earlier turn was counted again on
 * each new one: a week that cost about $3.75k read as $27k
 * (docs/token-efficiency.md). A turn's cost is the step in that total.
 */

/** A model call's usage, as the API and the CLI's result line report it. */
export interface CallUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } | null;
}

/** Dollars per million tokens. A cache write costs 1.25× input for five
 *  minutes' keep and 2× for an hour's. */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

/** List prices (October 2026), most specific first. */
const PRICES: [RegExp, Price][] = [
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/haiku-5-5/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  [/haiku/, { input: 1, output: 5, cacheRead: 0.1 }],
];

/** What a call (or a turn's summed calls) cost on one model, or undefined
 *  for a model with no price here: no figure beats a made-up one. */
export function priceUsage(usage: CallUsage | undefined, model: string | undefined): number | undefined {
  if (!usage || !model) return undefined;
  const price = PRICES.find(([match]) => match.test(model))?.[1];
  if (!price) return undefined;
  const written = usage.cache_creation_input_tokens ?? 0;
  const hour = Math.min(usage.cache_creation?.ephemeral_1h_input_tokens ?? 0, written);
  const dollars =
    (usage.input_tokens ?? 0) * price.input +
    (written - hour) * price.input * 1.25 +
    hour * price.input * 2 +
    (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
    (usage.output_tokens ?? 0) * price.output;
  return dollars / 1_000_000;
}

/**
 * One chat's turns, priced from the CLI's running total. The first result
 * a chat sees has nothing to step from (and a resumed CLI may carry an
 * earlier process's total over), so that turn is priced from its own
 * tokens. A total that drops is a new process counting from nothing.
 */
export class CostMeter {
  private last: number | undefined;

  turn(total: number | undefined, usage: CallUsage | undefined, model: string | undefined): number | undefined {
    if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return priceUsage(usage, model);
    const last = this.last;
    this.last = total;
    if (last === undefined) return priceUsage(usage, model);
    return total < last ? total : total - last;
  }
}
