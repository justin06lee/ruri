import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { writeJsonAtomic } from "./atomic.js";
import { configPath } from "./configDir.js";
import type { SecretMeta } from "../shared/protocol.js";
import { isMissing, warn } from "./log.js";

/**
 * The vault: passwords, tokens and the accounts they belong to, held by ruri
 * so the model can *use* them without ever *reading* them.
 *
 * The problem this solves is ordinary: "ssh into the box and sudo apt
 * update" needs a password, and typing it into a chat with a language model
 * puts it in that model's context, in its provider's logs, and in the
 * transcript on disk — permanently, for a value whose whole job is to not be
 * anywhere. So it stays here, and only its *name* is ever said out loud.
 *
 * Two paths get the value to where it's needed, because ruri drives more
 * than one harness:
 *
 *  - **Placeholders.** The model writes `{{deploy-box}}` into a command or a
 *    file, and ruri swaps in the real value at the last possible moment —
 *    inside the PreToolUse hook, after the model has finished writing and
 *    before the tool runs. What the model wrote, and therefore what its
 *    context holds, is the handle. (Claude sessions: it needs a tool hook.)
 *  - **The environment.** Every secret is also handed to the harness
 *    process as `$RURI_SECRET_<NAME>` (and `$RURI_USER_<NAME>`), so a shell
 *    command can reference it under any harness at all, hook or no hook.
 *    Handed to that process alone (env(), below): ruri's own environment
 *    never holds them, so the terminals and every other child ruri starts
 *    never see them either.
 *
 * Both leave the value out of the conversation. Neither can stop a model
 * that deliberately prints one — so anything ruri sees come back gets
 * redacted on the way into the transcript, and the instruction the model
 * gets is explicit about never echoing them.
 *
 * The values come from two places. ruri's own file on this machine
 * (secrets.json, mode 0600) is the one it always had. The other is the
 * ghostly vault, when this machine has one (server/vault.ts keeps the two
 * in step): what the owner shares there is read into memory here and
 * never written down by ruri, so taking a secret back in the vault takes
 * it back from ruri too. From there on the two are used alike — and where
 * both hold a name, the vault's is the one that answers to it.
 */

interface SecretRecord {
  id: string;
  name: string;
  username?: string;
  note?: string;
  value: string;
  updated: number;
}

/** One the ghostly vault holds: here in memory for as long as ghostly lists
 *  it, and on ruri's disk never. Its id is the vault's own. */
export interface GhostlyRecord {
  id: string;
  name: string;
  username?: string;
  /** Empty when ghostly would not hand it over (humanOnly) or the read failed. */
  value: string;
  /** The owner marked it for people only: listed, never read. */
  humanOnly?: boolean;
  /** The shared collection it is in; none for one in the agent's own vault. */
  collection?: string;
  /** When ruri last read it. */
  updated: number;
}

function secretsFile(): string {
  return configPath("secrets.json");
}

/** The environment-variable half of a name: RURI_SECRET_<THIS>. */
function envSlug(name: string): string {
  return name
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

/** What makes two names the same secret: they would share an environment
 *  variable, or (a name with no letter or digit in it) are spelled alike. */
function nameKey(name: string): string {
  return envSlug(name) || name.trim().toLowerCase();
}

/** Placeholder handles a name answers to: {{name}}, and its env slug. */
function handles(name: string): string[] {
  const slug = envSlug(name);
  return slug && slug !== name ? [name, slug] : [name];
}

export class SecretStore {
  /** The ones kept in ruri's own file on this machine. */
  private local: SecretRecord[] = [];
  /** The ones the ghostly vault holds, as last read: memory only. */
  private ghostly: GhostlyRecord[] = [];
  /** What each of the vault's is for, in the user's words, by its id. The
   *  vault has no place for it that ghostly writes, so it is kept here. */
  private notes: Record<string, string> = {};
  private readonly file = secretsFile();

  constructor() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as {
        secrets?: SecretRecord[];
        ghostlyNotes?: Record<string, string>;
      };
      this.local = (Array.isArray(raw.secrets) ? raw.secrets : []).filter(
        (r) => typeof r?.name === "string" && typeof r?.value === "string",
      );
      if (raw.ghostlyNotes && typeof raw.ghostlyNotes === "object") {
        this.notes = Object.fromEntries(
          Object.entries(raw.ghostlyNotes).filter(([, note]) => typeof note === "string" && note),
        );
      }
    } catch (err) {
      if (!isMissing(err)) warn("secrets", err, "new SecretStore");
      this.local = [];
    }
  }

  private save(): void {
    try {
      // every save is a fresh temp file renamed into place, so the mode
      // takes each time rather than only on the first. The vault's values
      // are not in what is written: only ruri's own, and the notes.
      writeJsonAtomic(
        this.file,
        { secrets: this.local, ...(Object.keys(this.notes).length > 0 ? { ghostlyNotes: this.notes } : {}) },
        2,
        0o600,
      );
    } catch (err) {
      warn("secrets", err, "save");
      // best-effort persistence
    }
  }

  /**
   * The ones a name answers with, the vault's first: where both places
   * hold a name, the vault's is used and the other waits behind it. One
   * of the vault's that ruri holds no value for — kept for people only,
   * or not read yet — is not among them: there is nothing to use, so it
   * is not offered to a model and stands in front of nothing.
   */
  private get records(): SecretRecord[] {
    const seen = new Set<string>();
    const out: SecretRecord[] = [];
    const held = this.ghostly.filter((g) => g.value).map((g) => this.asRecord(g));
    for (const r of [...held, ...this.local]) {
      const key = nameKey(r.name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    return out;
  }

  private asRecord(g: GhostlyRecord): SecretRecord {
    const note = this.notes[g.id];
    return {
      id: g.id,
      name: g.name,
      ...(g.username ? { username: g.username } : {}),
      ...(note ? { note } : {}),
      value: g.value,
      updated: g.updated,
    };
  }

  /** What the UI is allowed to know: everything except the values. */
  meta(): SecretMeta[] {
    // by name, the one that answers to it: another of that name is behind it
    const answers = new Map(this.records.map((r) => [nameKey(r.name), r.id]));
    const behind = (r: { id: string; name: string }): boolean =>
      (answers.get(nameKey(r.name)) ?? r.id) !== r.id;
    return [
      ...this.ghostly.map((g): SecretMeta => {
        const note = this.notes[g.id];
        return {
          id: g.id,
          name: g.name,
          ...(g.username ? { username: g.username } : {}),
          ...(note ? { note } : {}),
          hasValue: g.value.length > 0,
          updated: g.updated,
          store: "ghostly",
          ...(g.humanOnly ? { humanOnly: true } : {}),
          ...(g.collection ? { collection: g.collection } : {}),
          ...(behind(g) ? { shadowed: true } : {}),
        };
      }),
      ...this.local.map((r): SecretMeta => ({
        id: r.id,
        name: r.name,
        ...(r.username ? { username: r.username } : {}),
        ...(r.note ? { note: r.note } : {}),
        hasValue: r.value.length > 0,
        updated: r.updated,
        ...(behind(r) ? { shadowed: true } : {}),
      })),
    ];
  }

  /* ── the vault's ────────────────────────────────────────────────── */

  /** Everything the vault shares, as just read: what is no longer in the
   *  list is no longer here. */
  setGhostly(records: GhostlyRecord[]): void {
    this.ghostly = records.map((r) => ({ ...r }));
  }

  /** One of the vault's, by its id — value and all, for the server alone. */
  ghostlyOne(id: string): GhostlyRecord | undefined {
    return this.ghostly.find((g) => g.id === id);
  }

  /** The vault's one of this name, however it is cased. */
  ghostlyNamed(name: string): GhostlyRecord | undefined {
    const wanted = name.trim().toLowerCase();
    return this.ghostly.find((g) => g.name.trim().toLowerCase() === wanted);
  }

  /** Every one of the vault's, as held. */
  ghostlyAll(): GhostlyRecord[] {
    return this.ghostly.map((g) => ({ ...g }));
  }

  /** What one of the vault's is for. Kept in ruri's file, by the item's id. */
  noteGhostly(id: string, note: string | undefined): void {
    const next = note?.trim();
    if ((this.notes[id] ?? "") === (next ?? "")) return;
    if (next) this.notes[id] = next;
    else delete this.notes[id];
    this.save();
  }

  /** One of ruri's own, by its id — value and all, for the server alone. */
  localOne(
    id: string,
  ): { id: string; name: string; username?: string; note?: string; value: string } | undefined {
    const found = this.local.find((r) => r.id === id);
    return found ? { ...found } : undefined;
  }

  /** ruri's own one of this name, however it is cased. */
  localNamed(name: string): { id: string } | undefined {
    const wanted = name.trim().toLowerCase();
    return this.local.find((r) => r.name.toLowerCase() === wanted);
  }

  /* ── ruri's own ─────────────────────────────────────────────────── */

  /** Add or edit one. An absent `secret` leaves the stored value alone, so
   *  fixing a typo in a note never costs you the password. */
  upsert(patch: { id?: string; name: string; username?: string; note?: string; secret?: string }): void {
    const name = patch.name.trim();
    if (!name) return;
    const existing = patch.id
      ? this.local.find((r) => r.id === patch.id)
      : this.local.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.name = name;
      existing.username = patch.username?.trim() || undefined;
      existing.note = patch.note?.trim() || undefined;
      if (patch.secret !== undefined && patch.secret !== "") existing.value = patch.secret;
      existing.updated = Date.now();
    } else {
      this.local.push({
        id: randomUUID(),
        name,
        ...(patch.username?.trim() ? { username: patch.username.trim() } : {}),
        ...(patch.note?.trim() ? { note: patch.note.trim() } : {}),
        value: patch.secret ?? "",
        updated: Date.now(),
      });
    }
    this.save();
  }

  remove(id: string): void {
    this.local = this.local.filter((r) => r.id !== id);
    this.save();
  }

  /**
   * The harness process's environment: every secret, under its slug. Read
   * fresh when a session is built, so a deleted secret stops existing the
   * next time a harness starts — and passed to that process explicitly,
   * never through ruri's own environment.
   */
  env(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const record of this.records) {
      const slug = envSlug(record.name);
      if (!slug) continue;
      if (record.value) out[`RURI_SECRET_${slug}`] = record.value;
      if (record.username) out[`RURI_USER_${slug}`] = record.username;
    }
    return out;
  }

  /**
   * Swap `{{name}}` for the value it stands for — plus `{{name.user}}` for
   * the account it belongs to. Unknown handles are left exactly as written:
   * a placeholder ruri doesn't know is not a secret, it's a typo or a
   * template, and silently blanking it would be worse than passing it on.
   */
  fill(text: string): string {
    if (!text.includes("{{") || this.records.length === 0) return text;
    let out = text;
    for (const record of this.records) {
      for (const handle of handles(record.name)) {
        const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        out = out.replace(new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`, "gi"), record.value);
        if (record.username) {
          out = out.replace(
            new RegExp(`\\{\\{\\s*${escaped}\\.(?:user|username)\\s*\\}\\}`, "gi"),
            record.username,
          );
        }
      }
    }
    return out;
  }

  /** True if anything in here looks like a placeholder worth filling. */
  wanted(text: string): boolean {
    return this.records.length > 0 && text.includes("{{");
  }

  /** Fill placeholders through a whole tool input, however deep they sit. */
  fillInput<T>(input: T): T {
    if (typeof input === "string") return this.fill(input) as unknown as T;
    if (Array.isArray(input)) return input.map((v) => this.fillInput(v)) as unknown as T;
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, this.fillInput(v)]),
      ) as unknown as T;
    }
    return input;
  }

  /**
   * Put the handles back. Anything ruri is about to write into a transcript
   * goes through here first, so a command that echoed a password leaves the
   * name behind rather than the password — on screen and on disk both.
   */
  redact(text: string): string {
    if (!text) return text;
    let out = text;
    // every value held, the ones standing behind another of their name too
    for (const record of [...this.ghostly, ...this.local]) {
      // a short value would match half the words in a log line
      if (record.value.length < 6) continue;
      out = out.replaceAll(record.value, `{{${record.name}}}`);
    }
    return out;
  }

  /** Redaction through a whole structure — a tool input on its way to a
   *  permission card, which the hook may already have filled in. */
  redactInput<T>(input: T): T {
    if (typeof input === "string") return this.redact(input) as unknown as T;
    if (Array.isArray(input)) return input.map((v) => this.redactInput(v)) as unknown as T;
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, this.redactInput(v)]),
      ) as unknown as T;
    }
    return input;
  }

  /** The names, for the line the model is told about them in. */
  names(): string[] {
    return this.records.map((r) => r.name);
  }

  /** How the model is told what it has — names and accounts, never values. */
  briefing(placeholders = true): string {
    if (this.records.length === 0) return "";
    const lines = this.records.map((r) => {
      const slug = envSlug(r.name);
      const parts = [placeholders ? `- {{${r.name}}}` : `- $RURI_SECRET_${slug}`];
      if (r.username) {
        parts.push(
          placeholders
            ? `account "${r.username}" (also {{${r.name}.user}})`
            : `account "${r.username}" (also $RURI_USER_${slug})`,
        );
      }
      if (r.note) parts.push(r.note);
      return `${parts[0]}${parts.length > 1 ? ` — ${parts.slice(1).join("; ")}` : ""}${placeholders ? `, or $RURI_SECRET_${slug} in a shell` : ""}`;
    });
    return [
      "<ruri:vault>",
      "The user keeps credentials in ruri's vault. You can USE them; you cannot read them, and you must not try to.",
      "",
      ...lines,
      "",
      ...(placeholders
        ? [
            "Two ways to use one:",
            "- In a file or a command you write, put the handle literally: {{name}}. ruri replaces it with the real value after you finish writing and before the tool runs.",
            '- In a shell command, use the environment variable: it is already set in your shell, e.g. `sudo -S true <<< "$RURI_SECRET_NAME"`.',
          ]
        : [
            'Use the environment variable in a shell command; it is already set in your shell, e.g. `sudo -S true <<< "$RURI_SECRET_NAME"`.',
            "This harness cannot substitute {{handles}} before its tools run, so use the environment variable instead.",
          ]),
      "",
      "Never echo, cat, print, or log a value. Never ask the user to paste one — you already have it. If a command's output happens to contain one, do not repeat it back.",
      "</ruri:vault>",
    ].join("\n");
  }
}
