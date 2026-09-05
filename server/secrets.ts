import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SecretMeta } from "../shared/protocol.js";

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
 *  - **The environment.** Every secret is also exported to the harness
 *    process as `$RURI_SECRET_<NAME>` (and `$RURI_USER_<NAME>`), so a shell
 *    command can reference it under any harness at all, hook or no hook.
 *
 * Both leave the value out of the conversation. Neither can stop a model
 * that deliberately prints one — so anything ruri sees come back gets
 * redacted on the way into the transcript, and the instruction the model
 * gets is explicit about never echoing them.
 */

interface SecretRecord {
  id: string;
  name: string;
  username?: string;
  note?: string;
  value: string;
  updated: number;
}

function secretsFile(): string {
  return path.join(
    process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"),
    "secrets.json",
  );
}

/** The environment-variable half of a name: RURI_SECRET_<THIS>. */
export function envSlug(name: string): string {
  return name
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

/** Placeholder handles a name answers to: {{name}}, and its env slug. */
function handles(name: string): string[] {
  const slug = envSlug(name);
  return slug && slug !== name ? [name, slug] : [name];
}

export class SecretStore {
  private records: SecretRecord[] = [];

  constructor() {
    try {
      const raw = JSON.parse(fs.readFileSync(secretsFile(), "utf8")) as { secrets?: SecretRecord[] };
      this.records = (Array.isArray(raw.secrets) ? raw.secrets : []).filter(
        (r) => typeof r?.name === "string" && typeof r?.value === "string",
      );
    } catch {
      this.records = [];
    }
  }

  private save(): void {
    try {
      const file = secretsFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // written by hand rather than through writeFileSync's mode option: the
      // mode only applies when the file is created, and this file outlives
      // the first save
      fs.writeFileSync(file, JSON.stringify({ secrets: this.records }, null, 2));
      fs.chmodSync(file, 0o600);
    } catch {
      // best-effort persistence
    }
  }

  /** What the UI is allowed to know: everything except the values. */
  meta(): SecretMeta[] {
    return this.records.map((r) => ({
      id: r.id,
      name: r.name,
      ...(r.username ? { username: r.username } : {}),
      ...(r.note ? { note: r.note } : {}),
      hasValue: r.value.length > 0,
      updated: r.updated,
    }));
  }

  /** Add or edit one. An absent `secret` leaves the stored value alone, so
   *  fixing a typo in a note never costs you the password. */
  save1(patch: {
    id?: string;
    name: string;
    username?: string;
    note?: string;
    secret?: string;
  }): void {
    const name = patch.name.trim();
    if (!name) return;
    const existing = patch.id
      ? this.records.find((r) => r.id === patch.id)
      : this.records.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.name = name;
      existing.username = patch.username?.trim() || undefined;
      existing.note = patch.note?.trim() || undefined;
      if (patch.secret !== undefined && patch.secret !== "") existing.value = patch.secret;
      existing.updated = Date.now();
    } else {
      this.records.push({
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
    this.records = this.records.filter((r) => r.id !== id);
    this.save();
  }

  /**
   * Push the vault into ruri's own environment, so every harness ruri
   * spawns inherits it — the one path that works without a tool hook, and
   * therefore the one that works on harnesses ruri cannot hook.
   *
   * Removals are cleared too: a deleted secret stops existing everywhere the
   * next session looks.
   */
  applyEnv(): void {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("RURI_SECRET_") || key.startsWith("RURI_USER_")) delete process.env[key];
    }
    Object.assign(process.env, this.env());
  }

  /** The harness process's environment: every secret, under its slug. */
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
    for (const record of this.records) {
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
            "- In a shell command, use the environment variable: it is already set in your shell, e.g. `sudo -S true <<< \"$RURI_SECRET_NAME\"`.",
          ]
        : [
            "Use the environment variable in a shell command; it is already set in your shell, e.g. `sudo -S true <<< \"$RURI_SECRET_NAME\"`.",
            "This harness cannot substitute {{handles}} before its tools run, so use the environment variable instead.",
          ]),
      "",
      "Never echo, cat, print, or log a value. Never ask the user to paste one — you already have it. If a command's output happens to contain one, do not repeat it back.",
      "</ruri:vault>",
    ].join("\n");
  }
}
