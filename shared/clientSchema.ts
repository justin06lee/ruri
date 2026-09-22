import { z } from "zod";
import type { ClientMessage } from "./protocol.js";

/**
 * The wire protocol, checked at runtime. handleMessage used to take
 * JSON.parse's word for what a message was; a page with the token can
 * still send anything, and a field of the wrong shape landed in code that
 * trusted the type. Every member of ClientMessage has an arm here, and the
 * `z.ZodType<ClientMessage>` annotation is the check that they agree: an
 * arm whose output is not assignable to the type fails typecheck. Unknown
 * fields are dropped (z.object's default), so nothing the type does not
 * name gets through either.
 */

/** Ids (sessions, projects, items, requests): short, never empty. */
const id = z.string().min(1).max(500);
/** The harnesses whose MCP servers and plugins ruri manages. */
const integrationHarness = z.enum(["claude", "codex"]);
/** Free text a person or a model wrote: generous, but not unbounded. */
const text = z.string().max(2_000_000);
/** A short label — a name, a model id, a scope. */
const label = z.string().max(2_000);
/** A path on disk. */
const filePath = z.string().max(4_000);
/** Base64 bytes of an upload. The socket's own payload cap (ws, 100 MiB)
 *  is the real limit; this only keeps the type honest above it. */
const bytes = z.string().max(150_000_000);

const attachmentKind = z.enum(["image", "video", "file"]);
const permissionMode = z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]);
const permissionId = z.enum([
  "accessibility",
  "screen",
  "automation",
  "fullDisk",
  "desktop",
  "documents",
  "downloads",
  "removable",
  "network",
]);
const pickTarget = z.enum(["workspace", "music"]);
const trackerStatus = z.enum(["open", "liked", "rejected"]);
const modelRole = z.enum(["small", "default"]);
const skillScope = z.enum(["global", "project"]);

const draftRegion = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  n: z.number().int(),
});

const attachmentBase = {
  id,
  kind: attachmentKind,
  mediaType: z.string().max(200),
  name: z.string().max(1_000),
  n: z.number().int().min(0),
  url: z.string().max(2_000).optional(),
};

const attachmentUpload = z.object({
  ...attachmentBase,
  data: bytes,
  regions: z
    .array(
      z.object({
        n: z.number().int(),
        data: bytes,
        mediaType: z.string().max(200),
        rect: draftRegion.omit({ n: true }).optional(),
      }),
    )
    .optional(),
});

const draftAttachmentUpload = z.object({
  ...attachmentBase,
  data: bytes.optional(),
  regions: z.array(draftRegion).optional(),
});

const askAnswers = z.object({
  answers: z.record(z.string(), z.string().max(100_000)),
  annotations: z
    .record(
      z.string(),
      z.object({ preview: z.string().max(100_000).optional(), notes: z.string().max(100_000).optional() }),
    )
    .optional(),
  response: z.string().max(100_000).optional(),
  values: z.record(z.string(), z.array(z.string().max(100_000))).optional(),
});

const projectId = { projectId: id };
const optionalProjectId = { projectId: id.optional() };

export const clientMessageSchema: z.ZodType<ClientMessage> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_project"), name: label, path: filePath, folder: label.optional() }),
  z.object({ type: z.literal("pick_folder"), target: pickTarget.optional() }),
  z.object({ type: z.literal("permissions_check") }),
  z.object({ type: z.literal("permissions_request"), id: permissionId.optional() }),
  z.object({ type: z.literal("remove_project"), ...projectId }),
  z.object({
    type: z.literal("send"),
    ...projectId,
    text,
    attachments: z.array(attachmentUpload).optional(),
    now: z.literal(true).optional(),
  }),
  z.object({
    type: z.literal("send_split"),
    ...projectId,
    text,
    attachments: z.array(attachmentUpload).optional(),
    now: z.literal(true).optional(),
  }),
  z.object({ type: z.literal("queue_remove"), ...projectId, itemId: id }),
  z.object({ type: z.literal("queue_move"), ...projectId, itemId: id, beforeId: id.optional() }),
  z.object({ type: z.literal("queue_merge"), ...projectId, itemId: id, intoId: id }),
  z.object({ type: z.literal("queue_unmerge"), ...projectId, itemId: id }),
  z.object({ type: z.literal("queue_edit"), ...projectId, itemId: id }),
  z.object({
    type: z.literal("queue_update"),
    ...projectId,
    itemId: id,
    text,
    attachments: z.array(attachmentUpload).optional(),
    split: z.boolean().optional(),
  }),
  z.object({ type: z.literal("queue_edit_cancel"), ...projectId, itemId: id }),
  z.object({ type: z.literal("queue_send"), ...projectId }),
  z.object({ type: z.literal("remove_event"), ...projectId, eventId: id }),
  z.object({ type: z.literal("agent_log"), ...projectId, key: id }),
  z.object({ type: z.literal("agent_start"), ...projectId, key: id, text, model: label.optional() }),
  z.object({ type: z.literal("agent_send"), ...projectId, key: id, text }),
  z.object({ type: z.literal("agent_stop"), ...projectId, key: id }),
  z.object({ type: z.literal("rewind"), ...projectId, eventId: id }),
  z.object({ type: z.literal("fork"), ...projectId, eventId: id }),
  z.object({ type: z.literal("recent_list"), ...projectId }),
  z.object({ type: z.literal("transcript_get"), ...projectId }),
  z.object({
    type: z.literal("view"),
    channels: z.array(id).max(1_000),
    live: z.boolean(),
    board: z.boolean().optional(),
    meters: z.boolean().optional(),
    awake: z.boolean().optional(),
  }),
  z.object({ type: z.literal("history_get"), ...projectId }),
  z.object({ type: z.literal("recent_import"), ...projectId, id }),
  z.object({
    type: z.literal("draft"),
    ...projectId,
    text,
    attachments: z.array(draftAttachmentUpload).optional(),
  }),
  z.object({ type: z.literal("interrupt"), ...projectId }),
  z.object({ type: z.literal("terminal_list"), ...projectId }),
  z.object({ type: z.literal("terminal_new"), ...projectId }),
  // sizes are checked again where they are used (terminal.ts): a bad one
  // there falls back to a default rather than refusing the tab
  z.object({
    type: z.literal("terminal_open"),
    ...projectId,
    termId: id,
    cols: z.number(),
    rows: z.number(),
  }),
  z.object({ type: z.literal("terminal_input"), ...projectId, termId: id, data: z.string().max(1_000_000) }),
  z.object({
    type: z.literal("terminal_resize"),
    ...projectId,
    termId: id,
    cols: z.number(),
    rows: z.number(),
  }),
  z.object({ type: z.literal("terminal_close"), ...projectId, termId: id }),
  z.object({
    type: z.literal("permission_response"),
    requestId: id,
    allow: z.boolean(),
    always: z.boolean().optional(),
  }),
  z.object({ type: z.literal("question_response"), requestId: id, answers: askAnswers.optional() }),
  z.object({ type: z.literal("set_model"), ...projectId, model: label }),
  z.object({ type: z.literal("set_permission_mode"), ...projectId, mode: permissionMode }),
  z.object({ type: z.literal("set_effort"), ...projectId, effort: z.string().max(32) }),
  z.object({
    type: z.literal("idea_add"),
    ...projectId,
    text,
    attachments: z.array(attachmentUpload).max(50).optional(),
  }),
  z.object({
    type: z.literal("idea_update"),
    ...projectId,
    ideaId: id,
    text: text.optional(),
    done: z.boolean().optional(),
    attachments: z.array(draftAttachmentUpload).max(50).optional(),
  }),
  z.object({ type: z.literal("idea_remove"), ...projectId, ideaId: id }),
  z.object({
    type: z.literal("component_named"),
    requestId: id,
    name: label.optional(),
    files: z.array(filePath).max(1_000).optional(),
    note: text.optional(),
    skip: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("component_update"),
    ...projectId,
    componentId: id,
    name: label.optional(),
    aliases: z.array(label).max(100).optional(),
    files: z.array(filePath).max(1_000).optional(),
    note: text.optional(),
    selector: label.optional(),
    route: label.optional(),
    clicks: z.array(label).max(100).optional(),
  }),
  z.object({ type: z.literal("component_remove"), ...projectId, componentId: id }),
  z.object({ type: z.literal("component_shot"), ...projectId, componentId: id, upload: attachmentUpload }),
  z.object({ type: z.literal("component_unshot"), ...projectId, componentId: id, shotId: id }),
  z.object({ type: z.literal("components_sweep"), ...projectId, shots: z.boolean().optional() }),
  z.object({ type: z.literal("catchup_rebuild"), ...projectId }),
  z.object({ type: z.literal("component_seen"), ...projectId, componentId: id.optional() }),
  z.object({
    type: z.literal("secret_save"),
    id: id.optional(),
    name: label,
    username: label.optional(),
    note: text.optional(),
    secret: z.string().max(100_000).optional(),
  }),
  z.object({ type: z.literal("secret_remove"), id }),
  z.object({ type: z.literal("skills_refresh"), ...optionalProjectId }),
  z.object({ type: z.literal("commands_refresh"), ...optionalProjectId }),
  z.object({
    type: z.literal("skill_toggle"),
    ...optionalProjectId,
    scope: skillScope,
    name: label,
    on: z.boolean(),
  }),
  z.object({ type: z.literal("skill_install"), ...optionalProjectId, scope: skillScope, source: label }),
  z.object({ type: z.literal("skill_remove"), ...optionalProjectId, scope: skillScope, name: label }),
  z.object({ type: z.literal("skill_update"), ...optionalProjectId }),
  z.object({ type: z.literal("skill_read"), ...optionalProjectId, scope: skillScope, name: label }),
  z.object({ type: z.literal("tracker_add"), ...projectId, text, note: text.optional() }),
  z.object({
    type: z.literal("tracker_update"),
    ...projectId,
    itemId: id,
    status: trackerStatus.optional(),
    note: text.optional(),
    text: text.optional(),
  }),
  z.object({ type: z.literal("tracker_remove"), ...projectId, itemId: id }),
  z.object({ type: z.literal("tracker_attach"), ...projectId, itemId: id, upload: attachmentUpload }),
  z.object({ type: z.literal("tracker_detach"), ...projectId, itemId: id, attachmentId: id }),
  z.object({ type: z.literal("tracker_review"), ...projectId }),
  z.object({ type: z.literal("toggle_star"), ...projectId }),
  z.object({ type: z.literal("toggle_hidden"), ...projectId }),
  z.object({ type: z.literal("rename_project"), ...projectId, name: label }),
  z.object({ type: z.literal("new_session"), ...projectId }),
  z.object({ type: z.literal("remove_session"), sessionId: id }),
  z.object({ type: z.literal("rename_session"), sessionId: id, title: label }),
  z.object({ type: z.literal("set_workspace"), path: filePath }),
  z.object({ type: z.literal("set_music_dir"), path: filePath }),
  z.object({ type: z.literal("toggle_model_star"), model: label }),
  z.object({ type: z.literal("set_model_role"), model: label, role: modelRole }),
  z.object({ type: z.literal("reset_home") }),
  z.object({ type: z.literal("refresh_models") }),
  z.object({ type: z.literal("check_harnesses"), id: id.optional() }),
  z.object({ type: z.literal("set_harness_auto"), id, auto: z.boolean() }),
  z.object({ type: z.literal("integrations_get"), projectId: id.optional() }),
  z.object({ type: z.literal("plugins_search"), harness: integrationHarness, query: z.string().max(200) }),
  z.object({
    type: z.literal("mcp_add"),
    add: z.object({
      harness: integrationHarness,
      name: z.string().min(1).max(64),
      scope: z.enum(["user", "local", "project"]),
      transport: z.enum(["stdio", "http", "sse"]),
      command: z.string().max(4000).optional(),
      args: z.array(z.string().max(4000)).max(100).optional(),
      url: z.string().max(4000).optional(),
      env: z.record(z.string().max(200), z.string().max(8000)).optional(),
      headers: z.record(z.string().max(200), z.string().max(8000)).optional(),
    }),
    projectId: id.optional(),
  }),
  z.object({
    type: z.literal("mcp_remove"),
    harness: integrationHarness,
    name: z.string().min(1).max(200),
    scope: z.enum(["user", "local", "project", "codex", "plugin"]),
    projectId: id.optional(),
  }),
  z.object({
    type: z.literal("plugin_install"),
    harness: integrationHarness,
    id,
    scope: z.enum(["user", "project", "local"]).optional(),
    projectId: id.optional(),
  }),
  z.object({ type: z.literal("plugin_uninstall"), harness: integrationHarness, id }),
  z.object({ type: z.literal("plugin_enable"), id, enabled: z.boolean() }),
  z.object({
    type: z.literal("marketplace_add"),
    harness: integrationHarness,
    source: z.string().min(1).max(2000),
  }),
  z.object({
    type: z.literal("marketplace_remove"),
    harness: integrationHarness,
    name: z.string().min(1).max(200),
  }),
  z.object({ type: z.literal("bridge_takeover"), ...projectId }),
  z.object({ type: z.literal("bridge_release"), ...projectId }),
  z.object({ type: z.literal("bridge_close"), ...projectId }),
  z.object({ type: z.literal("set_pref"), key: z.string().min(1).max(200), value: z.string().max(100_000) }),
]);

/** Why a message was refused, in a line: the first issue, with its path. */
export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid message";
  const where = issue.path.map(String).join(".");
  return where ? `${where}: ${issue.message}` : issue.message;
}
