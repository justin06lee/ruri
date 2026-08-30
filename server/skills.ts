import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SkillInfo } from "../shared/protocol.js";

/**
 * Skills: the folders of instructions a harness reads before it starts, and
 * the two places they live — `~/.claude/skills` for every project on the
 * machine, `<project>/.claude/skills` for this one only.
 *
 * ruri doesn't reimplement any of that. The filesystem is the truth (it is
 * what the harness itself reads), `bmo` is the installer, and this file is
 * the thin layer that lists what's there and shells out for the rest.
 *
 * Turning one off is the one thing neither Claude Code nor bmo has a word
 * for, so ruri gives it one: the skill folder moves to a sibling
 * `skills-off/` directory, out of the tree the harness scans, and moves back
 * when it's turned on again. Nothing is deleted, and bmo's own metadata
 * still points at a skill it can update.
 */

/** Where the two scopes live, and where a parked skill waits. */
function dirs(scope: "global" | "project", projectDir?: string): { on: string; off: string } | undefined {
  const root =
    scope === "global" ? path.join(os.homedir(), ".claude") : projectDir && path.join(projectDir, ".claude");
  if (!root) return undefined;
  return { on: path.join(root, "skills"), off: path.join(root, "skills-off") };
}

/**
 * The frontmatter of a SKILL.md, as far as we care: name and description.
 * Deliberately small — this is not a YAML parser, it is a reader for the two
 * scalar keys the format guarantees, including the single-quoted form bmo
 * writes (where a quote inside is doubled).
 */
function frontmatter(file: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  if (!raw.startsWith("---")) return {};
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return {};
  const out: Record<string, string> = {};
  for (const line of raw.slice(3, end).split("\n")) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if (value.startsWith("'") && value.endsWith("'") && value.length > 1) {
      value = value.slice(1, -1).replaceAll("''", "'");
    } else if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
      value = value.slice(1, -1).replaceAll('\\"', '"');
    }
    out[match[1]!] = value;
  }
  return out;
}

/** Every skill folder directly under one directory. */
function listDir(dir: string, scope: "global" | "project", enabled: boolean): SkillInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SkillInfo[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const folder = path.join(dir, name);
    const manifest = path.join(folder, "SKILL.md");
    if (!fs.existsSync(manifest)) continue;
    const meta = frontmatter(manifest);
    out.push({
      name,
      description: meta["description"] ?? "",
      scope,
      path: folder,
      enabled,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** What bmo knows about the skills it installed, keyed "scope/name". */
function bmoMeta(cwd: string): Map<string, { source?: string; updated?: number }> {
  const out = new Map<string, { source?: string; updated?: number }>();
  try {
    const raw = runSync("bmo", ["list", "--json"], cwd);
    const rows = JSON.parse(raw) as Array<{
      name?: string;
      scope?: string;
      source?: string;
      updated_at?: string;
    }>;
    for (const row of rows) {
      if (!row?.name || !row.scope) continue;
      const updated = row.updated_at ? Date.parse(row.updated_at) : NaN;
      out.set(`${row.scope}/${row.name}`, {
        ...(row.source ? { source: row.source } : {}),
        ...(Number.isFinite(updated) ? { updated } : {}),
      });
    }
  } catch {
    // bmo not installed, or nothing tracked — the filesystem still answers
  }
  return out;
}

/** A short command, run to completion. Throws with whatever it printed. */
function runSync(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    // this one blocks the loop, so it is kept short — the filesystem scan
    // already answered; bmo is only being asked where things came from
    timeout: 5_000,
    // bmo is a Go binary in ~/go/bin, which a GUI app's PATH often misses
    env: { ...process.env, PATH: `${process.env["PATH"] ?? ""}:${path.join(os.homedir(), "go", "bin")}:/opt/homebrew/bin:/usr/local/bin` },
  });
}

/** The same, without blocking the event loop — for the slow ones. */
function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        timeout: 120_000,
        env: {
          ...process.env,
          PATH: `${process.env["PATH"] ?? ""}:${path.join(os.homedir(), "go", "bin")}:/opt/homebrew/bin:/usr/local/bin`,
        },
      },
      (err, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        if (err) reject(new Error(output || err.message));
        else resolve(output);
      },
    );
  });
}

/** Everything installed: all global skills, plus one project's own. */
export function scanSkills(projectDir?: string): SkillInfo[] {
  const found: SkillInfo[] = [];
  for (const scope of ["global", "project"] as const) {
    const where = dirs(scope, projectDir);
    if (!where) continue;
    found.push(...listDir(where.on, scope, true), ...listDir(where.off, scope, false));
  }
  const meta = bmoMeta(projectDir ?? os.homedir());
  return found.map((skill) => ({ ...skill, ...(meta.get(`${skill.scope}/${skill.name}`) ?? {}) }));
}

/** Park a skill out of the harness's way, or bring it back. */
export function toggleSkill(
  scope: "global" | "project",
  projectDir: string | undefined,
  name: string,
  on: boolean,
): string {
  const where = dirs(scope, projectDir);
  if (!where) throw new Error("no project to keep a local skill in");
  if (name.includes("/") || name.includes("..")) throw new Error("not a skill name");
  const from = path.join(on ? where.off : where.on, name);
  const to = path.join(on ? where.on : where.off, name);
  if (!fs.existsSync(from)) throw new Error(`${name} is not there`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  return `${name} ${on ? "on" : "off"}`;
}

/** `bmo add` — the source is anything bmo takes: repo, folder, zip, url. */
export function installSkill(
  scope: "global" | "project",
  projectDir: string | undefined,
  source: string,
): Promise<string> {
  const cwd = scope === "project" ? projectDir : os.homedir();
  if (!cwd) return Promise.reject(new Error("no project to install into"));
  return run("bmo", ["add", source, ...(scope === "project" ? ["--project"] : []), "--yes"], cwd);
}

export function removeSkill(
  scope: "global" | "project",
  projectDir: string | undefined,
  name: string,
): Promise<string> {
  const cwd = scope === "project" ? projectDir : os.homedir();
  if (!cwd) return Promise.reject(new Error("no project to remove from"));
  // a parked skill is invisible to bmo; bring it back first so remove lands
  if (fs.existsSync(path.join(dirs(scope, projectDir)?.off ?? "", name))) {
    try {
      toggleSkill(scope, projectDir, name, true);
    } catch {
      // it will fail again below, with a better message
    }
  }
  return run("bmo", ["remove", name, `--${scope}`, "--yes"], cwd);
}

/** `bmo update` — pull whatever the sources changed. */
export function updateSkills(projectDir?: string): Promise<string> {
  return run("bmo", ["update", "--yes"], projectDir ?? os.homedir());
}

/**
 * One skill's SKILL.md as prose: the frontmatter comes off (its two keys are
 * already on screen above the body) and the rest is markdown, to be rendered
 * rather than shown as a file.
 */
export function readSkill(
  scope: "global" | "project",
  projectDir: string | undefined,
  name: string,
): string {
  if (name.includes("/") || name.includes("..")) throw new Error("not a skill name");
  const where = dirs(scope, projectDir);
  if (!where) throw new Error("no project");
  for (const root of [where.on, where.off]) {
    const file = path.join(root, name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.startsWith("---")) return raw;
    const end = raw.indexOf("\n---", 3);
    return end === -1 ? raw : raw.slice(end + 4).replace(/^\n+/, "");
  }
  throw new Error(`${name} has no SKILL.md`);
}

/**
 * The line a non-Claude harness gets about this project's local skills.
 * Claude Code loads them itself; everything else has never heard of them, so
 * it is told they exist and where to read one.
 */
export function localSkillsBriefing(projectDir: string): string {
  const local = listDir(path.join(projectDir, ".claude", "skills"), "project", true);
  if (local.length === 0) return "";
  return [
    "<ruri:skills>",
    "This project keeps skills — folders of instructions for specific kinds of work.",
    "Read the matching one BEFORE starting that work, not after:",
    "",
    ...local.map((skill) => `- ${skill.path}/SKILL.md — ${skill.description || skill.name}`),
    "</ruri:skills>",
  ].join("\n");
}
