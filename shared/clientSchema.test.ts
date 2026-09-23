import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { clientMessageSchema, describeIssue } from "./clientSchema.js";
import type { AttachmentUpload, ClientMessage } from "./protocol.js";

const upload: AttachmentUpload = {
  id: "att-1",
  kind: "image",
  mediaType: "image/png",
  name: "shot.png",
  n: 1,
  data: "aGVsbG8=",
  regions: [{ n: 2, data: "aGk=", mediaType: "image/png", rect: { x: 0, y: 0, w: 10, h: 10 } }],
};

/**
 * One valid message of every type. The mapped type is what makes this
 * complete: a type missing from here, or one here the union lacks, fails
 * typecheck — so the runtime test below, comparing these keys with the
 * schema's arms, is comparing the schema with the union itself.
 */
const samples: { [K in ClientMessage["type"]]: Extract<ClientMessage, { type: K }> } = {
  add_project: { type: "add_project", name: "ruri", path: "/tmp/ruri", folder: "work" },
  pick_folder: { type: "pick_folder", target: "music" },
  permissions_check: { type: "permissions_check" },
  permissions_request: { type: "permissions_request", id: "screen" },
  remove_project: { type: "remove_project", projectId: "p" },
  send: { type: "send", projectId: "p", text: "hi", attachments: [upload] },
  send_split: { type: "send_split", projectId: "p", text: "a\n\nb" },
  queue_remove: { type: "queue_remove", projectId: "p", itemId: "i" },
  queue_move: { type: "queue_move", projectId: "p", itemId: "i", beforeId: "j" },
  queue_merge: { type: "queue_merge", projectId: "p", itemId: "i", intoId: "j" },
  queue_unmerge: { type: "queue_unmerge", projectId: "p", itemId: "q1" },
  queue_edit: { type: "queue_edit", projectId: "p", itemId: "i" },
  queue_update: {
    type: "queue_update",
    projectId: "p",
    itemId: "i",
    text: "t",
    attachments: [upload],
    split: true,
  },
  queue_edit_cancel: { type: "queue_edit_cancel", projectId: "p", itemId: "i" },
  queue_send: { type: "queue_send", projectId: "p" },
  remove_event: { type: "remove_event", projectId: "p", eventId: "e" },
  agent_log: { type: "agent_log", projectId: "p", key: "k" },
  agent_start: { type: "agent_start", projectId: "p", key: "k", text: "go", model: "haiku" },
  agent_send: { type: "agent_send", projectId: "p", key: "k", text: "more" },
  agent_stop: { type: "agent_stop", projectId: "p", key: "k" },
  rewind: { type: "rewind", projectId: "p", eventId: "e" },
  fork: { type: "fork", projectId: "p", eventId: "e" },
  recent_list: { type: "recent_list", projectId: "p" },
  transcript_get: { type: "transcript_get", projectId: "p" },
  view: { type: "view", channels: ["a", "b"], live: true, board: false },
  history_get: { type: "history_get", projectId: "p" },
  recent_import: { type: "recent_import", projectId: "p", id: "codex:abc" },
  draft: {
    type: "draft",
    projectId: "p",
    text: "half a thought",
    attachments: [
      {
        id: "d",
        kind: "file",
        mediaType: "text/plain",
        name: "a.txt",
        n: 1,
        regions: [{ x: 1, y: 2, w: 3, h: 4, n: 2 }],
      },
    ],
  },
  interrupt: { type: "interrupt", projectId: "p" },
  terminal_list: { type: "terminal_list", projectId: "p" },
  terminal_new: { type: "terminal_new", projectId: "p" },
  terminal_open: { type: "terminal_open", projectId: "p", termId: "t", cols: 80, rows: 24 },
  terminal_input: { type: "terminal_input", projectId: "p", termId: "t", data: "ls\r" },
  terminal_resize: { type: "terminal_resize", projectId: "p", termId: "t", cols: 120, rows: 40 },
  terminal_close: { type: "terminal_close", projectId: "p", termId: "t" },
  permission_response: { type: "permission_response", requestId: "r", allow: true, always: false },
  question_response: {
    type: "question_response",
    requestId: "r",
    answers: {
      answers: { q: "yes" },
      annotations: { q: { notes: "n" } },
      response: "ok",
      values: { q: ["a", "b"] },
    },
  },
  set_model: { type: "set_model", projectId: "p", model: "opus" },
  set_permission_mode: { type: "set_permission_mode", projectId: "p", mode: "plan" },
  set_effort: { type: "set_effort", projectId: "p", effort: "high" },
  idea_add: { type: "idea_add", projectId: "p", text: "an idea" },
  idea_update: { type: "idea_update", projectId: "p", ideaId: "i", text: "better", done: true },
  idea_remove: { type: "idea_remove", projectId: "p", ideaId: "i" },
  component_named: {
    type: "component_named",
    requestId: "r",
    name: "Header",
    files: ["a.tsx"],
    note: "n",
    skip: false,
  },
  component_update: {
    type: "component_update",
    projectId: "p",
    componentId: "c",
    name: "Header",
    aliases: ["top bar"],
    files: ["a.tsx"],
    note: "n",
    selector: ".header",
    route: "/",
    clicks: ["#menu"],
  },
  component_remove: { type: "component_remove", projectId: "p", componentId: "c" },
  component_shot: { type: "component_shot", projectId: "p", componentId: "c", upload },
  component_unshot: { type: "component_unshot", projectId: "p", componentId: "c", shotId: "s" },
  components_sweep: { type: "components_sweep", projectId: "p", shots: true },
  catchup_rebuild: { type: "catchup_rebuild", projectId: "p" },
  memory_rebuild: { type: "memory_rebuild", projectId: "p" },
  sheet_get: { type: "sheet_get", projectId: "p" },
  component_seen: { type: "component_seen", projectId: "p", componentId: "c" },
  component_code: { type: "component_code", projectId: "p", componentId: "c" },
  library_dir: { type: "library_dir", projectId: "p", dir: "src/components/ui" },
  secret_save: { type: "secret_save", id: "s", name: "box", username: "root", note: "n", secret: "hunter2" },
  secret_remove: { type: "secret_remove", id: "s" },
  skills_refresh: { type: "skills_refresh", projectId: "p" },
  commands_refresh: { type: "commands_refresh" },
  skill_toggle: { type: "skill_toggle", scope: "global", name: "bmo", on: false },
  skill_install: { type: "skill_install", projectId: "p", scope: "project", source: "github:x/y" },
  skill_remove: { type: "skill_remove", scope: "project", name: "bmo" },
  skill_update: { type: "skill_update" },
  skill_read: { type: "skill_read", scope: "global", name: "bmo" },
  tracker_add: { type: "tracker_add", projectId: "p", text: "bug", note: "n" },
  tracker_update: {
    type: "tracker_update",
    projectId: "p",
    itemId: "i",
    status: "liked",
    note: "n",
    text: "t",
  },
  tracker_remove: { type: "tracker_remove", projectId: "p", itemId: "i" },
  tracker_attach: { type: "tracker_attach", projectId: "p", itemId: "i", upload },
  tracker_detach: { type: "tracker_detach", projectId: "p", itemId: "i", attachmentId: "a" },
  tracker_review: { type: "tracker_review", projectId: "p" },
  toggle_star: { type: "toggle_star", projectId: "p" },
  toggle_hidden: { type: "toggle_hidden", projectId: "p" },
  rename_project: { type: "rename_project", projectId: "p", name: "new name" },
  new_session: { type: "new_session", projectId: "p" },
  remove_session: { type: "remove_session", sessionId: "s" },
  rename_session: { type: "rename_session", sessionId: "s", title: "Frontend UI" },
  set_workspace: { type: "set_workspace", path: "/Users/me/work" },
  set_music_dir: { type: "set_music_dir", path: "/Users/me/Music" },
  toggle_model_star: { type: "toggle_model_star", model: "haiku" },
  set_model_role: { type: "set_model_role", model: "haiku", role: "small" },
  reset_home: { type: "reset_home" },
  refresh_models: { type: "refresh_models" },
  check_harnesses: { type: "check_harnesses", id: "codex" },
  set_harness_auto: { type: "set_harness_auto", id: "claude", auto: false },
  integrations_get: { type: "integrations_get", projectId: "p" },
  plugins_search: { type: "plugins_search", harness: "claude", query: "stripe" },
  mcp_add: {
    type: "mcp_add",
    add: {
      harness: "claude",
      name: "sentry",
      scope: "user",
      transport: "http",
      url: "https://mcp.sentry.dev/mcp",
    },
  },
  mcp_remove: { type: "mcp_remove", harness: "codex", name: "motion", scope: "codex" },
  plugin_install: { type: "plugin_install", harness: "claude", id: "stripe@claude-plugins-official" },
  plugin_uninstall: { type: "plugin_uninstall", harness: "codex", id: "browser@openai-bundled" },
  plugin_enable: { type: "plugin_enable", id: "stripe@claude-plugins-official", enabled: false },
  marketplace_add: {
    type: "marketplace_add",
    harness: "claude",
    source: "anthropics/claude-plugins-official",
  },
  marketplace_remove: { type: "marketplace_remove", harness: "codex", name: "debug" },
  bridge_takeover: { type: "bridge_takeover", projectId: "p" },
  bridge_release: { type: "bridge_release", projectId: "p" },
  bridge_close: { type: "bridge_close", projectId: "p" },
  set_pref: { type: "set_pref", key: "ruri-theme", value: "dark" },
  store_picture: { type: "store_picture", upload },
  window_drag: { type: "window_drag", phase: "move" },
  talk_get: { type: "talk_get" },
  talk_set: {
    type: "talk_set",
    policy: {
      everyone: { to: "anyone", projects: [], chats: [] },
      projects: { p: { to: "listed", projects: ["q"], chats: ["c"] } },
      chats: { c: { to: "nobody", projects: [], chats: [] } },
    },
  },
};

/** The `type` literal of every arm the schema has. */
function schemaTypes(): string[] {
  const union = clientMessageSchema as unknown as { options: Array<{ shape: { type: { value: string } } }> };
  return union.options.map((arm) => arm.shape.type.value);
}

/** The `type` literals written in protocol.ts's ClientMessage union, read
 *  off the source — a check that does not lean on typecheck having run. */
function protocolTypes(): string[] {
  const source = fs.readFileSync(path.join(import.meta.dir, "protocol.ts"), "utf8");
  const start = source.indexOf("export type ClientMessage =");
  const end = source.indexOf(";\n\n", start);
  const block = source.slice(start, end);
  return [...block.matchAll(/type: "([a-z_]+)"/g)].map((m) => m[1]!);
}

describe("the schema and the union agree", () => {
  test("every arm is a distinct type", () => {
    const types = schemaTypes();
    expect(new Set(types).size).toBe(types.length);
  });

  test("the schema's types are exactly the union's", () => {
    const fromSchema = schemaTypes().sort();
    expect(fromSchema).toEqual(protocolTypes().sort());
    expect(fromSchema).toEqual(Object.keys(samples).sort());
  });
});

describe("valid messages", () => {
  for (const [type, sample] of Object.entries(samples)) {
    test(`${type} round-trips`, () => {
      const parsed = clientMessageSchema.safeParse(JSON.parse(JSON.stringify(sample)));
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual(sample);
    });
  }

  test("a field the type does not name is dropped, not passed on", () => {
    const parsed = clientMessageSchema.parse({ type: "interrupt", projectId: "p", admin: true });
    expect(parsed).toEqual({ type: "interrupt", projectId: "p" });
  });
});

describe("malformed messages are refused, with a path", () => {
  const cases: Array<[string, unknown, string]> = [
    ["an unknown type", { type: "drop_tables" }, "type"],
    ["no type at all", { projectId: "p" }, "type"],
    ["an empty id", { type: "interrupt", projectId: "" }, "projectId"],
    ["a missing id", { type: "rewind", projectId: "p" }, "eventId"],
    ["a number for text", { type: "send", projectId: "p", text: 42 }, "text"],
    [
      "a bad attachment inside a list",
      { type: "send", projectId: "p", text: "t", attachments: [{ ...upload, kind: "exe" }] },
      "attachments.0.kind",
    ],
    [
      "an attachment number below zero",
      { type: "tracker_attach", projectId: "p", itemId: "i", upload: { ...upload, n: -1 } },
      "upload.n",
    ],
    [
      "a permission mode that does not exist",
      { type: "set_permission_mode", projectId: "p", mode: "yolo" },
      "mode",
    ],
    ["a role that does not exist", { type: "set_model_role", model: "m", role: "boss" }, "role"],
    ["a string for a boolean", { type: "permission_response", requestId: "r", allow: "yes" }, "allow"],
    [
      "a string for a terminal size",
      { type: "terminal_open", projectId: "p", termId: "t", cols: "80", rows: 24 },
      "cols",
    ],
    [
      "a skill scope that does not exist",
      { type: "skill_toggle", scope: "system", name: "x", on: true },
      "scope",
    ],
    [
      "an answer that is not a string",
      { type: "question_response", requestId: "r", answers: { answers: { q: 1 } } },
      "answers.answers.q",
    ],
    ["a view with a non-array channels", { type: "view", channels: "a", live: true }, "channels"],
    ["an empty pref key", { type: "set_pref", key: "", value: "x" }, "key"],
    ["an id longer than the cap", { type: "secret_remove", id: "x".repeat(501) }, "id"],
  ];
  for (const [what, message, where] of cases) {
    test(what, () => {
      const parsed = clientMessageSchema.safeParse(message);
      expect(parsed.success).toBe(false);
      const line = describeIssue(parsed.error!);
      expect(line.startsWith(`${where}: `)).toBe(true);
    });
  }

  test("a message with no path to point at still says something", () => {
    const parsed = clientMessageSchema.safeParse("not an object");
    expect(parsed.success).toBe(false);
    expect(describeIssue(parsed.error!).length).toBeGreaterThan(0);
  });
});
