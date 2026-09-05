/**
 * A chat's model, effort and mode are its own.
 *
 * Picking one in a chat used to write it on the project, and every chat in
 * the project — including one mid-turn — moved with it. Now the pick lands
 * on the session; the project's value is only what a NEW chat starts on;
 * and a sibling that was riding the old default is pinned to it before the
 * default moves, so nothing changes under it.
 *
 * Runs against a scratch config dir, no server, no model.
 * Run manually: bun run settings-test
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env["RURI_CONFIG_DIR"] = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-settings-"));

const { ProjectStore } = await import("../server/projects.js");
const { DEFAULT_EFFORT, DEFAULT_MODEL, DEFAULT_PERMISSION_MODE } = await import("../shared/protocol.js");

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail));
  }
}

const store = new ProjectStore();
const project = store.add("scratch", process.env["RURI_CONFIG_DIR"]!);
const a = project.sessions[0]!;
const b = store.newSession(project.id)!;

/* ── a fresh project: everything is the built-in default ───────────── */
check("a new chat runs on the defaults", store.effectiveSettings(a.id)?.model === DEFAULT_MODEL);

/* ── a pick in one chat stays in that chat ─────────────────────────── */
store.setSessionSettings(a.id, { model: "codex:gpt-5.6-sol" });
check("the chat that picked runs on its pick", store.effectiveSettings(a.id)?.model === "codex:gpt-5.6-sol");
check("its sibling does not move", store.effectiveSettings(b.id)?.model === DEFAULT_MODEL, store.effectiveSettings(b.id));
check("the sibling is pinned, not inheriting", store.findSession(b.id)?.session.model === DEFAULT_MODEL);

/* ── a new chat starts on the last pick ────────────────────────────── */
const c = store.newSession(project.id)!;
check("a new chat starts on the last pick", store.effectiveSettings(c.id)?.model === "codex:gpt-5.6-sol");

/* ── the same for effort and mode ──────────────────────────────────── */
store.setSessionSettings(c.id, { effort: "low", permissionMode: "plan" });
check("effort is per chat", store.effectiveSettings(c.id)?.effort === "low" && store.effectiveSettings(a.id)?.effort === DEFAULT_EFFORT);
check(
  "mode is per chat",
  store.effectiveSettings(c.id)?.permissionMode === "plan" && store.effectiveSettings(a.id)?.permissionMode === DEFAULT_PERMISSION_MODE,
);

/* ── a pick that moves the default a second time ───────────────────── */
store.setSessionSettings(b.id, { model: "haiku" });
check("the second picker runs on its pick", store.effectiveSettings(b.id)?.model === "haiku");
check("the first picker keeps its own", store.effectiveSettings(a.id)?.model === "codex:gpt-5.6-sol");
check("the chat that inherited the old default keeps it", store.effectiveSettings(c.id)?.model === "codex:gpt-5.6-sol");
check("and the next new chat starts on the newest pick", store.effectiveSettings(store.newSession(project.id)!.id)?.model === "haiku");

/* ── a fork keeps what it forked from ──────────────────────────────── */
const fork = store.newSession(project.id)!;
store.copySessionSettings(c.id, fork.id);
check("a fork keeps the source chat's settings", store.effectiveSettings(fork.id)?.effort === "low" && store.effectiveSettings(fork.id)?.model === "codex:gpt-5.6-sol");

/* ── it all survives a reload ──────────────────────────────────────── */
const again = new ProjectStore();
check("per-chat settings persist", again.effectiveSettings(a.id)?.model === "codex:gpt-5.6-sol" && again.effectiveSettings(c.id)?.effort === "low");

/* ── the wholesale form still clears the chats' own picks ──────────── */
for (const s of again.get(project.id)!.sessions) delete s.model;
again.update(project.id, { model: "opus" });
check("a project-wide pick reaches every chat", again.get(project.id)!.sessions.every((s) => again.effectiveSettings(s.id)?.model === "opus"));

/* ── a pick during a turn waits for the turn ───────────────────────── */

// The manager never hands a change to a session mid-turn. A fake session
// standing in the manager's map records what reaches it; the manager's own
// (wrapped) status hook is what a real session would call when it idles.
const { SessionManager } = await import("../server/sessions.js");
const reached: string[] = [];
const fake = {
  status: "working" as "working" | "idle",
  lastSessionId: undefined,
  dead: false,
  send() {},
  interrupt() {},
  setModel(model: string) {
    reached.push(`model:${model}`);
  },
  setPermissionMode(mode: string) {
    reached.push(`mode:${mode}`);
  },
  setEffort(effort: string) {
    reached.push(`effort:${effort}`);
  },
  rewindFiles: () => Promise.resolve({ canRewind: false }),
  dispose() {
    reached.push("dispose");
  },
  respondPermission: () => false,
  respondQuestion: () => false,
  respondInput: () => false,
};
const statuses: string[] = [];
const manager = new SessionManager({
  onEvent() {},
  onDelta() {},
  onProgress() {},
  onStatus(_id: string, status: string) {
    statuses.push(status);
  },
  onPermission() {},
  onSessionId() {},
  onContext() {},
  onChain() {},
  onModels() {},
} as never);
const inner = manager as unknown as { sessions: Map<string, unknown>; events: { onStatus(id: string, status: string): void } };
inner.sessions.set("chat", fake);

manager.setEffort("chat", "low");
manager.setPermissionMode("chat", "plan");
manager.setModel("chat", "haiku");
check("nothing reaches a session mid-turn", reached.length === 0, reached);

fake.status = "idle";
inner.events.onStatus("chat", "idle");
check("the real status hook still fires", statuses.includes("idle"));
check("and the picks land, in order, once the turn is over", reached.join(" ") === "effort:low mode:plan model:haiku", reached);

reached.length = 0;
manager.setEffort("chat", "high");
check("an idle session takes a pick at once", reached.join(" ") === "effort:high", reached);

fs.rmSync(process.env["RURI_CONFIG_DIR"]!, { recursive: true, force: true });
console.log(failed === 0 ? "\nall passed" : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
