import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Finding a Linux app the way the desktop finds it: its .desktop entry —
 * by id, by the name the app grid shows, or by its command — for the
 * bridge's native side (desktop/linuxApps.ts). No Electron here, so it is
 * testable on its own.
 */

export interface DesktopEntry {
  /** The file's name without .desktop: org.gnome.TextEditor. */
  id: string;
  file: string;
  name: string;
  exec: string;
  wmClass?: string;
  hidden: boolean;
}

/** Where .desktop entries live, most personal first. */
function entryDirs(): string[] {
  const home = os.homedir();
  const dataHome = process.env["XDG_DATA_HOME"] || path.join(home, ".local", "share");
  const dataDirs = (process.env["XDG_DATA_DIRS"] || "/usr/local/share:/usr/share").split(":");
  return [
    dataHome,
    ...dataDirs,
    path.join(home, ".local", "share", "flatpak", "exports", "share"),
    "/var/lib/flatpak/exports/share",
    "/var/lib/snapd/desktop",
  ].map((dir) => path.join(dir, "applications"));
}

function readEntry(file: string): DesktopEntry | undefined {
  try {
    return parseEntry(file, fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** A .desktop file's [Desktop Entry] section; undefined for anything that
 *  is not an application someone could start. */
export function parseEntry(file: string, text: string): DesktopEntry | undefined {
  const fields: Record<string, string> = {};
  let inMain = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inMain = line === "[Desktop Entry]";
      continue;
    }
    if (!inMain) continue;
    const eq = line.indexOf("=");
    if (eq > 0) fields[line.slice(0, eq).trim()] ??= line.slice(eq + 1).trim();
  }
  if (fields["Type"] && fields["Type"] !== "Application") return undefined;
  if (!fields["Exec"] || !fields["Name"]) return undefined;
  return {
    id: path.basename(file, ".desktop"),
    file,
    name: fields["Name"],
    exec: fields["Exec"],
    ...(fields["StartupWMClass"] ? { wmClass: fields["StartupWMClass"] } : {}),
    hidden: fields["NoDisplay"] === "true" || fields["Hidden"] === "true",
  };
}

function allEntries(): DesktopEntry[] {
  const seen = new Set<string>();
  const out: DesktopEntry[] = [];
  for (const dir of entryDirs()) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".desktop") || seen.has(name)) continue;
      seen.add(name);
      const entry = readEntry(path.join(dir, name));
      if (entry) out.push(entry);
    }
  }
  return out;
}

/** An Exec line as argv, per the desktop entry spec: quoting honoured,
 *  file codes filled with the files, every other field code dropped. */
export function execArgv(exec: string, files: string[]): string[] {
  const words: string[] = [];
  let word = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < exec.length; i += 1) {
    const ch = exec[i]!;
    if (quoted) {
      if (ch === "\\" && i + 1 < exec.length) word += exec[(i += 1)]!;
      else if (ch === '"') quoted = false;
      else word += ch;
    } else if (ch === '"') {
      quoted = true;
      started = true;
    } else if (ch === " " || ch === "\t") {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += ch;
      started = true;
    }
  }
  if (started) words.push(word);
  const out: string[] = [];
  for (const w of words) {
    if (w === "%f" || w === "%u") out.push(...files.slice(0, 1));
    else if (w === "%F" || w === "%U") out.push(...files);
    else if (/^%[a-zA-Z]$/.test(w)) continue;
    else out.push(w.replace(/%%/g, "%").replace(/%[a-zA-Z]/g, ""));
  }
  return out;
}

function onPath(command: string): string | undefined {
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // next
    }
  }
  return undefined;
}

export interface Resolved {
  name: string;
  argv: string[];
  /** What its windows' WM_CLASS is likely to be, lowercased — for an app
   *  that hands the launch to a copy already running and exits. */
  classes: string[];
  address: string;
}

/** Where an app named like a person names it actually is: a .desktop
 *  entry by id or name, a .desktop file, or a command. */
export function resolveApp(app: string, files: string[] = [], entries?: DesktopEntry[]): Resolved {
  const fromEntry = (entry: DesktopEntry): Resolved => {
    const argv = execArgv(entry.exec, files);
    const bin = path.basename(argv[0] ?? entry.id);
    const last = entry.id.split(".").at(-1) ?? entry.id;
    return {
      name: entry.name,
      argv,
      classes: [
        ...new Set([entry.wmClass, entry.id, last, bin].filter(Boolean).map((c) => c!.toLowerCase())),
      ],
      address: entry.file,
    };
  };
  if (app.endsWith(".desktop") && fs.existsSync(app)) {
    const entry = readEntry(app);
    if (!entry) throw new Error(`${app} is not an application's .desktop entry`);
    return fromEntry(entry);
  }
  if (app.includes("/") && fs.existsSync(app)) {
    const full = path.resolve(app);
    return {
      name: path.basename(full),
      argv: [full, ...files],
      classes: [path.basename(full).toLowerCase()],
      address: full,
    };
  }
  const want = app.replace(/\.desktop$/, "").toLowerCase();
  const candidates = entries ?? allEntries();
  const ranked = [
    (e: DesktopEntry) => e.id.toLowerCase() === want,
    (e: DesktopEntry) => e.name.toLowerCase() === want,
    (e: DesktopEntry) => (e.id.split(".").at(-1) ?? "").toLowerCase() === want,
    (e: DesktopEntry) => path.basename(execArgv(e.exec, [])[0] ?? "").toLowerCase() === want,
  ];
  for (const test of ranked) {
    const found = candidates.filter(test).sort((a, b) => Number(a.hidden) - Number(b.hidden))[0];
    if (found) return fromEntry(found);
  }
  const command = onPath(app);
  if (command)
    return { name: app, argv: [command, ...files], classes: [app.toLowerCase()], address: command };
  throw new Error(
    `no app called "${app}" — give its name as the app grid shows it, its .desktop id (org.gnome.TextEditor), or a command`,
  );
}
