import * as fs from "node:fs";
import * as os from "node:os";
import type { VaultJob, VaultState } from "../shared/protocol.js";
import { GhostlyError, type Ghostly, type GhostlyItem } from "./ghostly.js";
import { errorMessage, warn } from "./log.js";
import type { GhostlyRecord, SecretStore } from "./secrets.js";
import { readTailnet, type Tailnet, type TailnetDevice } from "./tailnet.js";
import { findVaults, type Fetch } from "./vaultFinder.js";
import {
  agentPasswordFile,
  agentScript,
  copyForAWhile,
  runScript,
  serverScript,
  signupsScript,
  type Outcome,
  type Where,
} from "./vaultSetup.js";

/**
 * The vault, kept in step: what the ghostly vault shares with this
 * machine's agent, read into the secret store's memory, and every change
 * the user makes on the Passwords page sent to wherever that secret lives.
 *
 * Where a secret lives is decided once, when it is made: in the ghostly
 * vault when this machine has one that answers, in ruri's own file
 * otherwise. Nothing moves on its own — "Move to ghostly" is a button.
 *
 * When ruri asks the vault:
 *  - at launch, and on Refresh: who the agent is, the list, every value;
 *  - when the Passwords page opens (not more than once a minute), and
 *    every quarter of an hour: the list alone. An item the owner stopped
 *    sharing leaves ruri's memory then; a new one has its value read; a
 *    value changed in the vault is picked up at the next Refresh, since
 *    the list carries nothing that says a value changed;
 *  - after each thing saved here.
 * No more often than that on purpose: each listing is written to the
 * owner's event log, an entry per item, and a log full of ruri's polling
 * would bury the reads that mean something.
 *
 * A vault that does not answer leaves what ruri already holds alone, as
 * ghostly itself does from its cached copy: chats keep working through an
 * outage. Only a list that came back without an item takes it away.
 *
 * Getting a vault at all is on the same page: the user's devices on their
 * tailnet, which of them serve a vault (server/vaultFinder.ts), and one
 * job at a time to act on that — ruri enrolled with a vault found there,
 * a vault set up on a device that has none, ghostly installed here
 * (server/vaultSetup.ts). The tailnet is looked at when the page opens,
 * not more than once a minute, and when asked.
 */

/** The list alone is checked this often on its own… */
const RELIST_MS = 15 * 60_000;
/** …and no more than this often because a page asked. The tailnet, too. */
const PAGE_MS = 60_000;
/** The lines a job's card keeps. */
const JOB_LINES = 40;
/** The agent's account on a vault: <name>@ghostly.local. */
const AGENT_NAME = "ruri";

/** What the setup side reaches for; a test's stand-ins replace any of them. */
export interface VaultHelpers {
  readTailnet: () => Promise<Tailnet>;
  /** How a vault is asked about itself (the real fetch, unless a test's). */
  fetch?: Fetch;
  run: (where: Where, script: string, onLine: (line: string) => void) => Promise<Outcome>;
  copy: (value: string) => Promise<void>;
}

/** What the Passwords page sends to add or edit one. */
export interface SecretPatch {
  id?: string;
  name: string;
  username?: string;
  note?: string;
  secret?: string;
  generate?: boolean;
  collection?: string;
}

const NONE: VaultState = { installed: false, enrolled: false, ok: false, collections: [], syncing: false };

export class Vault {
  private state: VaultState = NONE;
  /** Everything here runs one after another: a save never lands in the
   *  middle of a listing. */
  private line: Promise<unknown> = Promise.resolve();
  /** The refresh waiting its turn, so asking twice is asking once. */
  private queued: { full: boolean; done: Promise<void> } | null = null;
  /** When the vault was last asked, answered or not. */
  private askedAt = 0;
  /** What `failed` says is about a read, so the next clean read unsays it
   *  — where a save that was refused stays said until something works. */
  private readFailed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The tailnet as last read, with what the page is not shown: addresses. */
  private devices: TailnetDevice[] = [];
  private looking: Promise<void> | null = null;
  /** The device a server job is about, and who signed in to it. */
  private jobAt: { host: string; user?: string } | null = null;
  private readonly helpers: VaultHelpers;

  constructor(
    private readonly secrets: SecretStore,
    private readonly ghostly: Ghostly,
    /** Told after anything that changes what a window shows. */
    private readonly changed: () => void,
    helpers: Partial<VaultHelpers> = {},
  ) {
    this.state = { ...NONE, installed: ghostly.where() !== null };
    this.helpers = { readTailnet, run: runScript, copy: copyForAWhile, ...helpers };
  }

  view(): VaultState {
    return { ...this.state, collections: [...this.state.collections] };
  }

  /** New secrets go to the vault: it is here, enrolled, and answered last time. */
  get usable(): boolean {
    return this.state.installed && this.state.enrolled && this.state.ok;
  }

  /** The first read, and the slow look after it. */
  start(): void {
    void this.refresh(true);
    this.timer = setInterval(() => void this.refresh(false), RELIST_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private then<T>(work: () => Promise<T>): Promise<T> {
    const next = this.line.then(work, work);
    this.line = next.catch(() => undefined);
    return next;
  }

  private set(patch: Partial<VaultState>): void {
    this.state = { ...this.state, ...patch };
    this.changed();
  }

  /** A page opened: the list, unless the vault was asked within the minute
   *  — and the tailnet, unless it was looked at within the minute. */
  opened(): void {
    const seen = this.state.tailnet?.at;
    if (!this.looking && (!seen || Date.now() - seen >= PAGE_MS)) void this.look();
    if (this.state.syncing || this.queued) return;
    if (Date.now() - this.askedAt < PAGE_MS) return;
    void this.refresh(false);
  }

  /**
   * Ask the vault what is shared. `full` asks who the agent is and reads
   * every value again; without it only the list is checked, and values
   * are read for what is new.
   */
  refresh(full: boolean): Promise<void> {
    if (this.queued && (this.queued.full || !full)) return this.queued.done;
    const entry = { full, done: Promise.resolve() };
    entry.done = this.then(async () => {
      if (this.queued === entry) this.queued = null;
      await this.pull(full);
    });
    this.queued = entry;
    return entry.done;
  }

  private async pull(full: boolean, known?: { name: string; value: string }): Promise<void> {
    // asked for by hand, or at launch: what an earlier save said is past
    if (full) delete this.state.failed;
    if (this.ghostly.where() === null) {
      // not here (or no longer): nothing of the vault's is held
      this.secrets.setGhostly([]);
      this.state = { ...NONE, ...this.kept() };
      this.changed();
      return;
    }
    this.askedAt = Date.now();
    this.set({ installed: true, syncing: true });
    try {
      if (full || !this.state.ok) {
        const status = await this.ghostly.status();
        this.state = {
          ...this.state,
          enrolled: true,
          ok: status.ok,
          server: status.server,
          account: status.email,
          collections: status.collections,
        };
        if (status.ok) delete this.state.problem;
        else this.state.problem = status.problem ?? "the vault is not usable right now";
        // an unreachable vault may still list from its cached copy: go on
      }
      const items = await this.ghostly.list();
      const failures = await this.take(items, full, known);
      this.state = { ...this.state, enrolled: true, syncedAt: Date.now() };
      // a read that failed is said, until a read that did not
      if (failures) {
        this.state.failed = failures;
        this.readFailed = true;
      } else if (this.readFailed) {
        delete this.state.failed;
        this.readFailed = false;
      }
    } catch (err) {
      const said = err instanceof GhostlyError ? err.said : errorMessage(err);
      if (err instanceof GhostlyError && err.unenrolled) {
        // no agent on this machine: nothing of the vault's can be held
        this.secrets.setGhostly([]);
        this.state = { ...NONE, installed: true, ...this.kept() };
      } else {
        this.state = { ...this.state, ok: false, problem: said };
        warn("vault", said, "ghostly");
      }
    } finally {
      this.state = { ...this.state, syncing: false };
      this.changed();
    }
  }

  /**
   * Turn a listing into what the store holds: logins with a password, each
   * with its value — the one already held unless this is a full read, the
   * one just written when ruri wrote it, else read from the vault. Returns
   * a line about the reads that failed, when any did.
   */
  private async take(
    items: GhostlyItem[],
    full: boolean,
    known?: { name: string; value: string },
  ): Promise<string | undefined> {
    const records: GhostlyRecord[] = [];
    const failed: string[] = [];
    let why = "";
    for (const item of items) {
      if (item.type !== "login" || !item.fields.includes("password")) continue;
      const before = this.secrets.ghostlyOne(item.id);
      const base = {
        id: item.id,
        name: item.name,
        ...(item.username ? { username: item.username } : {}),
        ...(item.collections[0] ? { collection: item.collections[0] } : {}),
      };
      if (item.humanOnly) {
        records.push({ ...base, value: "", humanOnly: true, updated: before?.updated ?? Date.now() });
        continue;
      }
      if (known && item.name.trim().toLowerCase() === known.name.trim().toLowerCase()) {
        records.push({ ...base, value: known.value, updated: Date.now() });
        continue;
      }
      if (!full && before?.value) {
        records.push({ ...base, value: before.value, updated: before.updated });
        continue;
      }
      try {
        records.push({ ...base, value: await this.ghostly.read(item.id), updated: Date.now() });
      } catch (err) {
        // keep what was held: one failed read is not the item taken away
        records.push({ ...base, value: before?.value ?? "", updated: before?.updated ?? Date.now() });
        failed.push(item.name);
        why ||= err instanceof GhostlyError ? err.said : errorMessage(err);
      }
    }
    this.secrets.setGhostly(records);
    if (failed.length === 0) return undefined;
    return `ghostly could not read ${failed.map((name) => `"${name}"`).join(", ")}: ${why}`;
  }

  /** What outlasts the vault going away: what was said, the tailnet, the job. */
  private kept(): Partial<VaultState> {
    const { failed, tailnet, job } = this.state;
    return { ...(failed ? { failed } : {}), ...(tailnet ? { tailnet } : {}), ...(job ? { job } : {}) };
  }

  /** Run one change; what goes wrong is said on the page, not thrown. */
  private change(work: () => Promise<void>): Promise<void> {
    return this.then(async () => {
      const { failed: _before, ...rest } = this.state;
      this.state = rest;
      this.readFailed = false;
      try {
        await work();
      } catch (err) {
        this.state = { ...this.state, failed: err instanceof GhostlyError ? err.said : errorMessage(err) };
      } finally {
        this.changed();
      }
    });
  }

  /** Add or edit a secret, wherever it lives. */
  save(patch: SecretPatch): Promise<void> {
    return this.change(async () => {
      const name = patch.name.trim();
      const held = patch.id ? this.secrets.ghostlyOne(patch.id) : undefined;
      if (held) {
        await this.edit(held, patch);
        return;
      }
      // one of ruri's own: by its id, or (as ever) a new one by a name it
      // has — and anything at all while there is no vault to put it in
      const own = Boolean(patch.id) || !name || this.secrets.localNamed(name) !== undefined;
      if (own || !this.usable || !(patch.secret || patch.generate)) {
        if (patch.generate) {
          throw new GhostlyError(
            "only the ghostly vault makes a password, and this one is not kept there",
            own ? "type one instead" : (this.state.problem ?? "type one instead"),
          );
        }
        this.secrets.upsert({
          ...(patch.id ? { id: patch.id } : {}),
          name: patch.name,
          ...(patch.username !== undefined ? { username: patch.username } : {}),
          ...(patch.note !== undefined ? { note: patch.note } : {}),
          ...(patch.secret !== undefined ? { secret: patch.secret } : {}),
        });
        return;
      }
      // a new one, for the vault — or the vault's own of that name, edited
      const existing = this.secrets.ghostlyNamed(name);
      if (existing) {
        await this.edit(existing, patch);
        return;
      }
      const username = patch.username?.trim();
      await this.ghostly.put(
        name,
        {
          ...(username ? { username } : {}),
          ...(patch.generate ? { generate: true } : {}),
          ...(patch.collection ? { collection: patch.collection } : {}),
        },
        patch.generate ? undefined : patch.secret,
      );
      // the list again, to learn the id the vault gave it
      await this.pull(false, patch.generate ? undefined : { name, value: patch.secret! });
      const made = this.secrets.ghostlyNamed(name);
      if (made) this.secrets.noteGhostly(made.id, patch.note);
    });
  }

  /** Edit one of the vault's. Its name stays: ghostly has no rename. */
  private async edit(held: GhostlyRecord, patch: SecretPatch): Promise<void> {
    const username = patch.username?.trim() ?? "";
    const renamed = username !== (held.username ?? "");
    if (patch.secret || patch.generate || renamed) {
      // ghostly sets an account name only along with a password, so a
      // changed name alone sends back the value ruri already holds
      const value = patch.generate ? undefined : patch.secret || held.value;
      if (!patch.generate && !value) {
        throw new GhostlyError(
          `"${held.name}" is kept for people only, so ruri holds no value to send back with the new account name`,
          "type its password as well, or change the account in a Bitwarden app",
        );
      }
      await this.ghostly.put(
        held.name,
        { update: true, ...(renamed ? { username } : {}), ...(patch.generate ? { generate: true } : {}) },
        value,
      );
      const next = patch.generate ? await this.ghostly.read(held.id) : value!;
      this.secrets.setGhostly(
        this.secrets.ghostlyAll().map((g) => {
          if (g.id !== held.id) return g;
          const { username: _was, ...rest } = g;
          // people-only stays people-only: the value is not kept past this
          return {
            ...rest,
            ...(username ? { username } : {}),
            value: g.humanOnly ? "" : next,
            updated: Date.now(),
          };
        }),
      );
    }
    this.secrets.noteGhostly(held.id, patch.note);
  }

  /** Forget one: the vault's goes to the vault's trash, ruri's own is gone. */
  remove(id: string): Promise<void> {
    return this.change(async () => {
      if (!this.secrets.ghostlyOne(id)) {
        this.secrets.remove(id);
        return;
      }
      await this.ghostly.remove(id);
      this.secrets.setGhostly(this.secrets.ghostlyAll().filter((g) => g.id !== id));
      this.secrets.noteGhostly(id, undefined);
    });
  }

  /** Move one of ruri's own into the vault: stored there first, and only
   *  then taken out of ruri's file. */
  move(id: string): Promise<void> {
    return this.change(async () => {
      const local = this.secrets.localOne(id);
      if (!local) return;
      if (!this.usable) {
        throw new GhostlyError(
          this.state.problem ?? "there is no ghostly vault on this machine to move it to",
        );
      }
      if (!local.value)
        throw new GhostlyError(`"${local.name}" has no value yet, so there is nothing to move`);
      if (this.secrets.ghostlyNamed(local.name)) {
        throw new GhostlyError(
          `the vault already has one named "${local.name}"`,
          "forget one of the two, or rename this one first",
        );
      }
      await this.ghostly.put(local.name, local.username ? { username: local.username } : {}, local.value);
      await this.pull(false, { name: local.name, value: local.value });
      const made = this.secrets.ghostlyNamed(local.name);
      if (!made) {
        throw new GhostlyError(
          `ghostly stored "${local.name}" but does not list it`,
          "it is still in ruri's own file as well",
        );
      }
      this.secrets.noteGhostly(made.id, local.note);
      this.secrets.remove(local.id);
    });
  }

  /* ── finding a vault, and setting one up ─────────────────────────── */

  /** Look at the tailnet again: which devices are on, which serve a vault. */
  look(): Promise<void> {
    if (this.looking) return this.looking;
    const before = this.state.tailnet;
    this.set({ tailnet: { ...(before ?? { state: "connected", devices: [] }), looking: true } });
    this.looking = (async () => {
      try {
        const tailnet = await this.helpers.readTailnet();
        this.devices = tailnet.devices;
        const found = await findVaults({
          tailnet,
          ...(this.helpers.fetch ? { fetch: this.helpers.fetch } : {}),
        });
        this.set({ tailnet: { ...found, user: os.userInfo().username, looking: false } });
      } catch (err) {
        warn("vault", `looking at the tailnet: ${errorMessage(err)}`, "tailnet");
        this.set({ tailnet: { ...(before ?? { state: "off", devices: [] }), looking: false } });
      } finally {
        this.looking = null;
      }
    })();
    return this.looking;
  }

  private get busy(): boolean {
    return this.state.job?.running === true;
  }

  /** A new job's card, replacing whatever card was up. */
  private begin(job: Omit<VaultJob, "running" | "since" | "lines">, lines: string[] = []): void {
    this.set({ job: { ...job, running: true, since: Date.now(), lines: lines.slice(-JOB_LINES) } });
  }

  /** One more line on the job's card. */
  private say(line: string): void {
    const job = this.state.job;
    if (job) this.set({ job: { ...job, lines: [...job.lines, line].slice(-JOB_LINES) } });
  }

  /** The job stopped: where it stands, or why it could not go on. */
  private end(patch: Partial<VaultJob>): void {
    const job = this.state.job;
    if (!job) return;
    const { error: _was, needsPassword: _asked, ...rest } = job;
    this.set({ job: { ...rest, ...patch, running: false } });
  }

  /**
   * Enroll ruri's agent with the vault at `server` — or check again how
   * far that has got: `ghostly init` picks up where it left off, and
   * stops at each step only the owner can do, which the card then says.
   */
  enroll(server: string, name = AGENT_NAME): Promise<void> {
    if (this.busy) return Promise.resolve();
    const was = this.state.job;
    const again = was?.kind === "enroll" && was.server === server;
    const device = this.state.tailnet?.devices.find((d) => d.vault?.server === server)?.name;
    this.begin(
      {
        kind: "enroll",
        server,
        email: `${name}@ghostly.local`,
        ...(device ? { device } : {}),
        ...(again && was.stage ? { stage: was.stage } : {}),
        ...(again && was.fingerprint ? { fingerprint: was.fingerprint } : {}),
      },
      again ? was.lines : [],
    );
    this.say(again ? "Checking again" : `Enrolling ruri with the vault on ${device ?? server}`);
    return this.then(async () => {
      try {
        if (this.ghostly.where() === null) {
          throw new GhostlyError("ghostly is not installed on this machine", "install it first");
        }
        const got = await this.ghostly.init(server, name);
        this.say(
          {
            done: "Enrolled",
            account: "Waiting for its account to be made",
            confirm: "Waiting for it to be confirmed",
            collection: "Waiting for a collection to be shared with it",
          }[got.stage],
        );
        this.end({ stage: got.stage, ...(got.fingerprint ? { fingerprint: got.fingerprint } : {}) });
        if (got.stage === "done") await this.pull(true);
      } catch (err) {
        this.end({ error: err instanceof GhostlyError ? err.said : errorMessage(err) });
      }
    });
  }

  /** Where a server job's scripts run: here, or signed in to the device. */
  private where(host: string, user: string | undefined, password: string | undefined): Where | null {
    const device = this.devices.find((d) => d.host === host);
    if (!device) return null;
    if (device.self) return { local: true };
    return {
      local: false,
      login: {
        user: user || os.userInfo().username,
        address: device.addresses[0] ?? device.host,
        ...(password ? { password } : {}),
      },
    };
  }

  /** Set a vault up on a device of the tailnet: here, or over SSH. */
  async setUp(host: string, user?: string, password?: string): Promise<void> {
    if (this.busy) return;
    const where = this.where(host, user, password);
    const name = this.devices.find((d) => d.host === host)?.name ?? host;
    const signIn = where && !where.local ? where.login.user : undefined;
    this.jobAt = { host, ...(signIn ? { user: signIn } : {}) };
    this.begin({ kind: "server", device: name, ...(signIn ? { user: signIn } : {}) });
    if (!where) {
      this.end({ error: `${name} isn't on the tailnet any more. Look again.` });
      return;
    }
    this.say(where.local ? "Setting a vault up on this machine" : `Signing in to ${name} as ${signIn}`);
    const out = await this.helpers.run(where, serverScript(), (line) => this.say(line));
    if (out.done && out.url) {
      this.say(`The vault is up at ${out.url}`);
      this.end({ stage: "signups", server: out.url });
      void this.look();
    } else {
      this.end({ error: out.error ?? "It stopped.", ...(out.needsPassword ? { needsPassword: true } : {}) });
    }
  }

  /** Close signups on the vault just set up, once the owner has an account. */
  async signupsOff(password?: string): Promise<void> {
    const job = this.state.job;
    if (this.busy || job?.kind !== "server" || job.stage !== "signups" || !this.jobAt) return;
    const where = this.where(this.jobAt.host, this.jobAt.user, password);
    this.begin({ ...job }, job.lines);
    if (!where) {
      this.end({ error: `${job.device ?? "That device"} isn't on the tailnet any more. Look again.` });
      return;
    }
    const out = await this.helpers.run(where, signupsScript(), (line) => this.say(line));
    if (out.done) {
      this.say("Signups are closed: only addresses you invite can make an account now");
      this.end({ stage: "done" });
    } else {
      this.end({ error: out.error ?? "It stopped.", ...(out.needsPassword ? { needsPassword: true } : {}) });
    }
  }

  /** Install ghostly on this machine, then look for it again. */
  async install(): Promise<void> {
    if (this.busy) return;
    this.begin({ kind: "agent", device: os.hostname().replace(/\.local$/i, "") });
    this.say("Installing ghostly on this machine");
    const out = await this.helpers.run({ local: true }, agentScript(), (line) => this.say(line));
    if (out.done) {
      this.end({ stage: "done" });
      await this.refresh(true);
    } else {
      this.end({ error: out.error ?? "It stopped." });
    }
  }

  /** Put the agent's password on this machine's clipboard for a while,
   *  to make its account with. It never goes to the page. */
  async copyPassword(): Promise<void> {
    const job = this.state.job;
    if (job?.kind !== "enroll" || job.stage !== "account") return;
    try {
      const value = fs.readFileSync(agentPasswordFile(), "utf8").trim();
      if (!value) throw new Error("ghostly has not made the agent's password yet");
      await this.helpers.copy(value);
      if (this.state.job === job) this.set({ job: { ...job, copied: Date.now() } });
    } catch (err) {
      if (this.state.job === job) this.set({ job: { ...job, error: errorMessage(err) } });
    }
  }

  /** Put the card away. One still running is left to finish first. */
  closeJob(): void {
    if (this.busy || !this.state.job) return;
    const { job: _gone, ...rest } = this.state;
    this.state = rest;
    this.jobAt = null;
    this.changed();
  }
}
