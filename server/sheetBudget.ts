import * as fs from "node:fs";
import * as path from "node:path";
import type { LayerSheet } from "../shared/protocol.js";
import { isMissing, warn } from "./log.js";

/**
 * How long a layer's sheet may be, and the lines a sheet must not hold.
 *
 * A sheet used to keep each section to a count — twelve map lines, six
 * rules, ten files — whatever the lines said. Most real sheets sat at the
 * rules' cap, and agents with a seventh trap crammed two unrelated rules
 * into one line to fit. What matters is that a session can read the whole
 * sheet before it works, so the sheet keeps a budget of words instead, and
 * any section may take what it needs of it.
 *
 * And a key file's line says what the file does: "app/web/src/App.tsx —
 * its job" was the format echoed back as the line, ten times in one sheet.
 */

/** A sheet's whole length, at most, in words (a few lines' grace for the
 *  user, whose edits on the page are never refused). */
export const SHEET_WORDS = Number(process.env["RURI_SHEET_WORDS"]) || 1000;

/** The most lines a section takes, whatever the budget — a runaway answer,
 *  not a limit anyone should meet. */
export const SECTION_MAX = 40;

const count = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** A sheet's length in words, every section counted. */
export function sheetWords(sheet: LayerSheet): number {
  return (
    count(sheet.summary) +
    sheet.map.reduce((n, place) => n + count(`${place.name} ${place.files.join(" ")}`), 0) +
    sheet.flows.reduce((n, flow) => n + count(`${flow.name} ${flow.steps.join(" ")}`), 0) +
    [...sheet.files, ...sheet.rules, ...sheet.edges].reduce((n, line) => n + count(line), 0)
  );
}

/** Below these a section gives nothing more to the budget. */
const FLOORS = { map: 6, files: 6, rules: 4, edges: 3, flows: 1 } as const;

/** A sheet brought within the budget: the section with the most lines past
 *  its floor gives up its last (least central) line, and again, until it
 *  fits — for a sheet a model wrote. */
export function withinBudget(sheet: LayerSheet, budget = SHEET_WORDS): LayerSheet {
  const out: LayerSheet = {
    ...sheet,
    map: sheet.map.slice(0, SECTION_MAX),
    flows: sheet.flows.slice(0, SECTION_MAX),
    files: sheet.files.slice(0, SECTION_MAX),
    rules: sheet.rules.slice(0, SECTION_MAX),
    edges: sheet.edges.slice(0, SECTION_MAX),
  };
  while (sheetWords(out) > budget) {
    const spare = (Object.keys(FLOORS) as Array<keyof typeof FLOORS>)
      .map((key) => ({ key, over: out[key].length - FLOORS[key] }))
      .filter((s) => s.over > 0)
      .sort((a, b) => b.over - a.over)[0];
    if (!spare) break;
    out[spare.key] = out[spare.key].slice(0, -1) as never;
  }
  return out;
}

/** The words standing in for a file's job when nobody wrote it. */
const PLACEHOLDER =
  /^(?:its job|what it is for|what it does|job|purpose|description|tbd|todo|\?+|\.{2,}|…|-+)$/i;

export function placeholderJob(job: string): boolean {
  return PLACEHOLDER.test(job.trim());
}

/**
 * What a file says it is for, from the comment it opens with — the first
 * sentence of a doc block or of its leading comment lines, skipping a
 * licence header. Undefined when it opens with code.
 */
export function describeJob(projectDir: string, file: string): string | undefined {
  let text: string;
  try {
    const fd = fs.openSync(path.join(projectDir, file), "r");
    const buffer = Buffer.alloc(8192);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    text = buffer.subarray(0, read).toString("utf8");
  } catch (err) {
    if (!isMissing(err)) warn("sheets", err, "describeJob");
    return undefined;
  }
  const rows = text.split("\n");
  const said: string[] = [];
  let inBlock = false;
  for (const raw of rows.slice(0, 80)) {
    const row = raw.trim();
    if (!inBlock && (row === "" || /^#!|^"use (strict|client|server)"|^'use /.test(row))) {
      if (said.length) break;
      continue;
    }
    if (!inBlock && /^\/\*\*?/.test(row)) {
      inBlock = !row.includes("*/");
      const rest = row
        .replace(/^\/\*\*?/, "")
        .replace(/\*\/.*$/, "")
        .trim();
      if (rest) said.push(rest);
      if (!inBlock) break;
      continue;
    }
    if (inBlock) {
      if (row.includes("*/")) {
        const rest = row
          .replace(/\*\/.*$/, "")
          .replace(/^\*\s?/, "")
          .trim();
        if (rest) said.push(rest);
        break;
      }
      said.push(row.replace(/^\*\s?/, ""));
      continue;
    }
    const line = /^(?:\/\/[/!]?|#+(?!!)|--|;+)\s?(.*)$/.exec(row);
    if (line) {
      said.push(line[1]!);
      continue;
    }
    if (/^("""|''')/.test(row)) {
      const rest = row.slice(3);
      const end = rest.indexOf(row.slice(0, 3));
      said.push(end === -1 ? rest : rest.slice(0, end));
      if (end !== -1) break;
      inBlock = false;
      continue;
    }
    break;
  }
  const prose = said
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/@\w+.*$/, "")
    .trim();
  if (!prose || /copyright|spdx|license|eslint|prettier|@ts-/i.test(prose.slice(0, 60))) return undefined;
  const sentence = /^(.+?[.!?])(\s|$)/.exec(prose)?.[1] ?? prose;
  const job = sentence.length > 140 ? `${sentence.slice(0, 137).trimEnd()}…` : sentence;
  return job.replace(/\.$/, "");
}
