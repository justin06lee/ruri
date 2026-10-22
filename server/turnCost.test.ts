import { describe, expect, test } from "bun:test";
import { CostMeter, priceUsage } from "./turnCost.js";

const OPUS = "claude-opus-5-5";

describe("priceUsage", () => {
  test("prices each kind of token at its own rate, an hour's cache write at twice input", () => {
    // Opus 5.5: $4 in, $20 out, $0.20 cache read; 5-minute write 1.25×, 1-hour 2×
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 2_000_000,
      cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 1_000_000 },
    };
    expect(priceUsage(usage, OPUS)).toBeCloseTo(4 + 20 + 0.2 + 5 + 8, 6);
  });

  test("a turn seen in a transcript: what the CLI's own total stepped by", () => {
    // one of the lead's turns on 2026-10-22: the CLI's total went $3.40 → $4.49
    const usage = {
      input_tokens: 4,
      output_tokens: 1313,
      cache_read_input_tokens: 148_433,
      cache_creation_input_tokens: 128_948,
      cache_creation: { ephemeral_1h_input_tokens: 128_948 },
    };
    expect(priceUsage(usage, OPUS)).toBeCloseTo(1.09, 2);
  });

  test("no price for a model it does not know, and none without usage", () => {
    expect(priceUsage({ input_tokens: 10 }, "gpt-9")).toBeUndefined();
    expect(priceUsage(undefined, OPUS)).toBeUndefined();
    expect(priceUsage({ input_tokens: 10 }, undefined)).toBeUndefined();
  });
});

describe("CostMeter", () => {
  const usage = { output_tokens: 1000 }; // $0.02 on Opus 5.5

  test("each turn costs what the CLI's running total stepped by, not the total", () => {
    const meter = new CostMeter();
    expect(meter.turn(2.97, usage, OPUS)).toBeCloseTo(0.02, 6); // the first: priced from its tokens
    expect(meter.turn(3.1, usage, OPUS)).toBeCloseTo(0.13, 6);
    expect(meter.turn(3.16, usage, OPUS)).toBeCloseTo(0.06, 6);
    expect(meter.turn(3.16, usage, OPUS)).toBe(0); // a turn the CLI answered for nothing
  });

  test("a total that drops is a new process counting from nothing", () => {
    const meter = new CostMeter();
    meter.turn(5, usage, OPUS);
    meter.turn(6, usage, OPUS);
    expect(meter.turn(0.4, usage, OPUS)).toBeCloseTo(0.4, 6);
    expect(meter.turn(0.5, usage, OPUS)).toBeCloseTo(0.1, 6);
  });

  test("with no total from the CLI, the turn is priced from its tokens", () => {
    const meter = new CostMeter();
    expect(meter.turn(undefined, usage, OPUS)).toBeCloseTo(0.02, 6);
  });
});
