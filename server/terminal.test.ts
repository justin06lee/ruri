import { expect, test } from "bun:test";
import { dimension } from "./terminal.js";

// A dimension is spliced into an expect script, so anything that is not a
// plain integer in range falls back rather than reaching the shell.

test("a whole number from 1 to 1000 is taken as it is", () => {
  expect(dimension(80, 120)).toBe(80);
  expect(dimension(1, 120)).toBe(1);
  expect(dimension(1000, 120)).toBe(1000);
});

test("out of range falls back", () => {
  expect(dimension(0, 120)).toBe(120);
  expect(dimension(-24, 120)).toBe(120);
  expect(dimension(1001, 120)).toBe(120);
});

test("anything that is not an integer falls back", () => {
  expect(dimension(80.5, 120)).toBe(120);
  expect(dimension(Number.NaN, 120)).toBe(120);
  expect(dimension(Number.POSITIVE_INFINITY, 120)).toBe(120);
  expect(dimension("80", 120)).toBe(120);
  expect(dimension("80; rm -rf /", 120)).toBe(120);
  expect(dimension(undefined, 24)).toBe(24);
  expect(dimension(null, 24)).toBe(24);
  expect(dimension({ valueOf: () => 80 }, 24)).toBe(24);
});
