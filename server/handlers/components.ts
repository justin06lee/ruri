/**
 * The component library from the app's side: the host the model's naming
 * tools reach (the card that asks the user for a name), the `ruri`
 * command's view of the app, the refresh that brings the library up to
 * date with the code and photographs what has no current picture, and the
 * library page's messages. The library
 * itself is server/components.ts; the command, server/library.ts.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  componentStale,
  type Attachment,
  type AttachmentUpload,
  type ComponentProposal,
  DEFAULT_PERMISSION_MODE,
  type NamedComponent,
  type PermissionRequest,
  type ServerMessage,
} from "../../shared/protocol.js";
import { channelProject, ownerProject } from "../channel.js";
import { type ComponentHost, writeIndexFile } from "../components.js";
import type { ServerContext } from "../context.js";
import {
  readComponent,
  skillDir,
  writeLibrarySkill,
  type LibraryHost,
  type LibraryProject,
} from "../library.js";
import { isMissing, warn } from "../log.js";
import { IMAGE_MIME } from "../mime.js";
import { dispatch } from "../dispatch.js";
import {
  changesSince,
  currentAsOf,
  dirtyFiles,
  fileHistory,
  mtimeIn,
  tidyFiles,
  type EntryChange,
  type FileCommit,
} from "../libraryRefresh.js";
import { photoPrompt, type PhotoTarget } from "../photographer.js";
import { withProjectRunning, type ShotTarget } from "../shots.js";
import { reviewComponents, smallModelEnabled, type ReviewEntry } from "../smallmodel.js";
import { describeFile, sweepProject } from "../sweep.js";
import { storedFilePath, storeUpload } from "../uploads.js";
import type { Handlers } from "./types.js";

/**
 * What a proposal writes into the library, under the name it was given.
 * Its files are its own as named — the tool and `ruri register` both take
 * a component's own files apart from the places it reaches into — so the
 * guesswork splitFiles does for a sweep is not done here; a file named
 * with a line is still a place it reaches.
 */
function fromProposal(proposal: ComponentProposal, name: string) {
  return {
    name,
    files: proposal.files,
    note: proposal.note,
    exact: true,
    ...(proposal.slug ? { slug: proposal.slug } : {}),
    ...(proposal.uses ? { uses: proposal.uses } : {}),
    ...(proposal.tags ? { tags: proposal.tags } : {}),
    ...(proposal.deps ? { deps: proposal.deps } : {}),
  };
}

export function createComponentHost(ctx: ServerContext): ComponentHost {
  return {
    list: (channelId) => {
      const owner = ownerProject(ctx, channelId);
      return owner ? ctx.components.items(owner.id) : [];
    },
    propose: (channelId, proposal) =>
      new Promise<string | null>((resolve) => {
        const owner = ownerProject(ctx, channelId);
        if (!owner) {
          resolve(null);
          return;
        }
        // The screenshot is copied now, not when the card is answered. The
        // card is the whole point of it — being asked to name something you
        // cannot see is being asked to guess — and the model's own copy is
        // routinely a scratch file that will not survive the wait.
        const shot = proposal.shot ? storeShot(proposal.shot, owner.path) : undefined;
        const shown: ComponentProposal = {
          name: proposal.name,
          files: proposal.files,
          note: proposal.note,
          ...(proposal.slug ? { slug: proposal.slug } : {}),
          ...(proposal.uses?.length ? { uses: proposal.uses } : {}),
          ...(proposal.tags?.length ? { tags: proposal.tags } : {}),
          ...(proposal.deps?.length ? { deps: proposal.deps } : {}),
          ...(shot ? { image: shot } : {}),
        };
        // Bypass is the mode where ruri stops asking, and the card is only
        // ever a confirmation: the model has already named the thing and
        // photographed it. So in bypass the entry is written the moment it
        // is proposed, star and screenshot and all, and the name stays
        // yours to change on the components page whenever you look.
        const mode = channelProject(ctx, channelId)?.permissionMode ?? DEFAULT_PERMISSION_MODE;
        const straight = shown.name.trim();
        if (mode === "bypassPermissions" && straight) {
          const item = ctx.components.add(owner.id, fromProposal(shown, straight));
          if (shown.image) ctx.components.addShot(owner.id, item.id, shown.image);
          pushComponents(ctx, owner.id, owner.path);
          resolve(straight);
          return;
        }
        const requestId = randomUUID();
        ctx.pendingComponents.set(requestId, { channelId, proposal: shown, resolve });
        const request: PermissionRequest = {
          requestId,
          projectId: channelId,
          toolName: "name_component",
          kind: "component",
          input: shown,
          ts: Date.now(),
        };
        ctx.permissions.set(requestId, request);
        ctx.clients.broadcast({ type: "permission_request", request });
      }),
  };
}

/** An image the model pointed at, stored the way every attachment is. A
 *  relative path is read against the project it was named from, since that
 *  is the directory the model was working in. */
export function storeShot(file: string, projectDir?: string): Attachment | undefined {
  try {
    const full = path.isAbsolute(file) ? file : path.resolve(projectDir ?? ".", file);
    const data = fs.readFileSync(full).toString("base64");
    const ext = path.extname(full).slice(1).toLowerCase();
    const upload: AttachmentUpload = {
      id: randomUUID(),
      kind: "image",
      mediaType: IMAGE_MIME[ext] ?? "image/png",
      name: path.basename(full),
      n: 1,
      data,
    };
    const { url } = storeUpload(upload);
    const { data: _data, regions: _regions, ...meta } = upload;
    return { ...meta, url };
  } catch (err) {
    if (!isMissing(err)) warn("server", err, "storeShot");
    return undefined;
  }
}

/** Push a project's component library everywhere it is read: the file in
 *  the project, Claude's skill, and every window. */
export function pushComponents(ctx: ServerContext, projectId: string, projectDir?: string): void {
  const items = ctx.components.items(projectId);
  const dir = ctx.components.dir(projectId);
  if (projectDir) writeIndexFile(projectDir, items);
  const project = ctx.store.get(projectId);
  if (project) writeLibrarySkill(projectId, project.name, items, dir);
  ctx.clients.broadcast({ type: "components", projectId, items, ...(dir ? { dir } : {}) });
}

/** Where a session's `ruri` command posts to (server/library.ts): this
 *  server, as the chat it belongs to. */
export function libraryEndpoint(ctx: ServerContext, channelId: string): string {
  return `http://127.0.0.1:${ctx.listeningPort}/library/${channelId}`;
}

/** A project's skill written, if it isn't there yet — a session is about
 *  to be handed it, and a plugin folder that isn't there is no plugin. */
export function ensureLibrarySkill(ctx: ServerContext, projectId: string): void {
  if (fs.existsSync(path.join(skillDir(projectId), "skills", "components", "SKILL.md"))) return;
  const project = ctx.store.get(projectId);
  if (!project) return;
  writeLibrarySkill(projectId, project.name, ctx.components.items(projectId), ctx.components.dir(projectId));
}

/**
 * The `ruri` command's view of the app, for a session in `channelId`
 * (server/library.ts runs the command). Undefined for a channel that
 * belongs to no project — Home has no library.
 */
export function libraryHost(ctx: ServerContext, channelId: string): LibraryHost | undefined {
  const owner = ownerProject(ctx, channelId);
  if (!owner) return undefined;
  const open = (): LibraryProject[] =>
    ctx.store.list().map((p) => ({ id: p.id, name: p.name, path: p.path }));
  return {
    here: { id: owner.id, name: owner.name, path: owner.path },
    projects: open,
    // the card the naming tool puts up, from the shell: written at once in
    // bypass (inside propose, before this returns), asked about otherwise
    ask: (proposal) => {
      const mode = channelProject(ctx, channelId)?.permissionMode ?? DEFAULT_PERMISSION_MODE;
      void ctx.componentHost.propose(channelId, proposal);
      return mode === "bypassPermissions" ? "added" : "asked";
    },
    items: (projectId) => ctx.components.items(projectId),
    find: (projectId, handle) => ctx.components.find(projectId, handle),
    add: (projectId, input) => ctx.components.add(projectId, input),
    update: (projectId, componentId, patch) => ctx.components.update(projectId, componentId, patch),
    remove: (projectId, componentId) => ctx.components.remove(projectId, componentId),
    shoot: (projectId, componentId, file) => {
      const project = ctx.store.get(projectId);
      const shot = storeShot(file, project?.path);
      return shot ? ctx.components.addShot(projectId, componentId, shot) : false;
    },
    copyShots: (projectId, componentId, shots) => {
      // newest first there, newest first here
      for (const shot of [...shots].reverse()) ctx.components.addShot(projectId, componentId, shot);
    },
    dir: (projectId) => ctx.components.dir(projectId),
    setDir: (projectId, dir) => ctx.components.setDir(projectId, dir),
    noteInstall: (projectId, componentId, paths) => ctx.components.noteInstall(projectId, componentId, paths),
    changed: (projectId) => pushComponents(ctx, projectId, ctx.store.get(projectId)?.path),
  };
}

/* ── the repo sweep ───────────────────────────────────────────────── */

function sweepNote(ctx: ServerContext, projectId: string, note: string, busy = true): void {
  ctx.clients.broadcast({ type: "sweep", projectId, busy, ...(note ? { note } : {}) });
}

/** A component's screenshot, filed like any other upload. */
function pinShot(ctx: ServerContext, projectId: string, item: NamedComponent, data: string): void {
  const upload: AttachmentUpload = {
    id: randomUUID(),
    kind: "image",
    mediaType: "image/png",
    name: `${item.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "component"}.png`,
    n: 1,
    data,
  };
  const { url } = storeUpload(upload);
  const { data: _data, regions: _regions, ...meta } = upload;
  ctx.components.addShot(projectId, item.id, { ...meta, url });
}

/** Review batches: entries per small-model call, and calls at once. */
const REVIEW_BATCH = 5;
const REVIEW_AT_ONCE = 3;
/** Characters of each of an entry's files the review reads. */
const REVIEW_HEAD = 900;

/** A commit as the review and the pictures chat read it. */
function commitLine(commit: FileCommit): string {
  return `${new Date(commit.at).toISOString().slice(0, 10)} ${commit.subject}`;
}

/**
 * Look at what changed under the entries that have fallen behind their
 * code, and bring their notes up to date — the small model, a few entries a
 * call. What it says changed their look is left with an out-of-date
 * picture, for the picture pass. Answers how many notes it rewrote.
 */
async function reviewStale(
  ctx: ServerContext,
  project: { id: string; name: string; path: string },
  changes: Map<string, EntryChange>,
  onNote: (note: string) => void,
): Promise<number> {
  const stale = ctx.components.items(project.id).filter((item) => {
    const behind = componentStale(item);
    return behind.note || behind.picture;
  });
  if (stale.length === 0) return 0;
  // with nothing to go on — no commits past the grace, no edits in the
  // tree (a turn changed it, and its work is committed with the picture it
  // left) — there is nothing to read: the note stands, and a picture that
  // is behind is retaken rather than guessed at
  const blind = stale.filter((item) => !changes.get(item.id));
  for (const item of blind) {
    ctx.components.reviewed(project.id, item.id, { looks: componentStale(item).picture });
  }
  const readable = stale.filter((item) => changes.get(item.id));
  if (readable.length === 0 || !smallModelEnabled()) return 0;
  const batches: NamedComponent[][] = [];
  for (let at = 0; at < readable.length; at += REVIEW_BATCH) {
    batches.push(readable.slice(at, at + REVIEW_BATCH));
  }
  let done = 0;
  let rewritten = 0;
  let next = 0;
  onNote(`reading what changed under ${readable.length}…`);
  const workers = Array.from({ length: Math.min(REVIEW_AT_ONCE, batches.length) }, async () => {
    for (;;) {
      const batch = batches[next++];
      if (!batch) return;
      const entries: ReviewEntry[] = batch.map((item) => {
        const change = changes.get(item.id)!;
        return {
          slug: item.slug,
          name: item.name,
          note: item.note,
          files: item.files.slice(0, 3).flatMap((file) => {
            const read = describeFile(project.path, file.split(":")[0]!.trim(), REVIEW_HEAD);
            return read ? [read] : [];
          }),
          commits: change.commits.slice(0, 10).map(commitLine),
          uncommitted: change.uncommitted,
        };
      });
      const outcomes = await reviewComponents(project.name, entries);
      for (const outcome of outcomes) {
        const item = batch.find((i) => i.slug === outcome.slug);
        if (!item) continue;
        if (outcome.note && outcome.note !== item.note) rewritten += 1;
        ctx.components.reviewed(project.id, item.id, {
          ...(outcome.note ? { note: outcome.note } : {}),
          looks: outcome.looks,
        });
      }
      done += 1;
      onNote(`reading what changed — ${done} of ${batches.length}`);
    }
  });
  await Promise.all(workers);
  return rewritten;
}

/**
 * Hand what still has no current picture to the project's pictures chat —
 * the one this made last time when it is still there, a new one when not.
 * Answers the chat's title, or undefined when one is already at it.
 */
function startPhotographer(
  ctx: ServerContext,
  projectId: string,
  targets: PhotoTarget[],
): "started" | "busy" | undefined {
  const prior = ctx.photographers.get(projectId);
  const kept = prior && ctx.store.findSession(prior)?.project.id === projectId ? prior : undefined;
  if (kept && ctx.turns.progress.has(kept)) return "busy";
  const sessionId = kept ?? ctx.store.newSession(projectId)?.id;
  if (!sessionId) return undefined;
  ctx.photographers.set(projectId, sessionId);
  ctx.store.setSessionTitle(sessionId, PHOTO_CHAT);
  ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
  dispatch(ctx, sessionId, photoPrompt(targets), []);
  return "started";
}

/** What the pictures chat is called in the sidebar. */
const PHOTO_CHAT = "Library pictures";

/**
 * Bring a project's library up to date with its code, and fill it in.
 *
 *  1. Files: an entry's files that moved are followed through git's
 *     renames; ones that are gone are dropped, and an entry with nothing
 *     left is retired (kept beside the library, not deleted).
 *  2. Changes: git's commits and uncommitted edits to each entry's own
 *     files since its picture and note were current (server/libraryRefresh.ts).
 *     Turns that edited them already said so as they ended.
 *  3. New: the repo read for interface nobody has named (server/sweep.ts).
 *  4. Review: the small model reads what changed under each entry that
 *     fell behind, rewrites notes that stopped being true, and says whose
 *     look changed.
 *  5. Pictures: every entry with no picture, or one its look has left
 *     behind — first the mechanical pass (the project's dev server, a
 *     hidden window, each selector's rectangle), then, for whatever that
 *     couldn't reach, the pictures chat: an agent that runs the app and
 *     photographs each one (server/photographer.ts).
 */
async function runSweep(ctx: ServerContext, projectId: string, wantShots: boolean): Promise<void> {
  const project = ctx.store.get(projectId);
  if (!project || ctx.sweeping.has(projectId)) return;
  ctx.sweeping.add(projectId);
  const note = (text: string) => sweepNote(ctx, projectId, text);
  const said: string[] = [];
  try {
    // Taken before the read, so a file edited while the sweep runs is read
    // again next time rather than being skipped as "already seen".
    const startedAt = Date.now();

    note("checking the library against the repo…");
    const tidy = await tidyFiles(project.path, ctx.components.items(projectId));
    for (const entry of tidy) {
      if (entry.gone) continue;
      ctx.components.update(projectId, entry.id, {
        ...(entry.files ? { files: entry.files } : {}),
        ...(entry.uses ? { uses: entry.uses } : {}),
      });
    }
    const retired = ctx.components.retire(
      projectId,
      tidy.filter((entry) => entry.gone).map((entry) => entry.id),
    );
    const moved = tidy.length - retired.length;
    if (moved) said.push(`${moved} re-pointed`);
    if (retired.length) said.push(`${retired.length} gone`);

    const items = ctx.components.items(projectId);
    const oldest = Math.min(Date.now(), ...items.map(currentAsOf));
    const [history, dirty] = await Promise.all([fileHistory(project.path, oldest), dirtyFiles(project.path)]);
    const changes = new Map(
      changesSince(items, history, dirty, mtimeIn(project.path)).map((change) => [change.id, change]),
    );
    for (const change of changes.values()) ctx.components.noteChange(projectId, change.id, change.at);

    const { found } = await sweepProject(
      project,
      ctx.components.items(projectId),
      note,
      ctx.components.sweptAt(projectId),
    );
    for (const part of found) ctx.components.add(projectId, { ...part, found: true });
    ctx.components.markSwept(projectId, startedAt);
    if (found.length) said.push(`named ${found.length}`);
    pushComponents(ctx, projectId, project.path);

    const rewritten = await reviewStale(ctx, project, changes, note);
    if (rewritten) said.push(`${rewritten} note${rewritten === 1 ? "" : "s"} updated`);
    pushComponents(ctx, projectId, project.path);

    // Everything without a current picture gets a look in, not just what
    // this run named — an entry from six months ago is exactly as
    // picture-less as one from a minute ago.
    const unpictured = () =>
      ctx.components
        .items(projectId)
        .filter((item) => item.shots.length === 0 || componentStale(item).picture);
    const capture = ctx.options.capture;
    const targets: ShotTarget[] = unpictured()
      .filter((item) => item.selector)
      .map((item) => ({
        id: item.id,
        selector: item.selector!,
        ...(item.route ? { route: item.route } : {}),
        ...(item.clicks?.length ? { clicks: item.clicks } : {}),
      }));
    if (wantShots && capture && targets.length) {
      const shots = await withProjectRunning(project.path, note, (url) => capture(url, targets));
      let pinned = 0;
      for (const [componentId, data] of Object.entries(shots ?? {})) {
        const item = ctx.components.items(projectId).find((i) => i.id === componentId);
        if (!item) continue;
        pinShot(ctx, projectId, item, data);
        pinned += 1;
      }
      if (pinned) said.push(`${pinned} picture${pinned === 1 ? "" : "s"}`);
      pushComponents(ctx, projectId, project.path);
    }

    const left = unpictured();
    if (wantShots && left.length) {
      const photos: PhotoTarget[] = left.map((item) => {
        const commits = changes.get(item.id)?.commits.map(commitLine);
        return item.shots.length === 0
          ? { item, why: "none" }
          : { item, why: "changed", ...(commits?.length ? { commits } : {}) };
      });
      const started = startPhotographer(ctx, projectId, photos);
      if (started === "started") said.push(`${left.length} to photograph in “${PHOTO_CHAT}”`);
      else if (started === "busy") said.push(`pictures still being taken in “${PHOTO_CHAT}”`);
    }
    sweepNote(ctx, projectId, said.length ? said.join(", ") : "all up to date", false);
  } catch (err) {
    warn("server", err, "runSweep");
    sweepNote(ctx, projectId, "the update didn't finish — try it again", false);
  } finally {
    ctx.sweeping.delete(projectId);
  }
}

export const componentHandlers = {
  component_named: (ctx, _ws, msg) => {
    const pending = ctx.pendingComponents.get(msg.requestId);
    if (!pending) return;
    ctx.pendingComponents.delete(msg.requestId);
    ctx.permissions.delete(msg.requestId);
    ctx.clients.broadcast({ type: "permission_resolved", requestId: msg.requestId });
    const owner = ownerProject(ctx, pending.channelId);
    const name = (msg.name ?? pending.proposal.name).trim();
    if (msg.skip || !name || !owner) {
      // nothing is written down, including the copy of the screenshot
      // taken when the card went up
      const orphan = pending.proposal.image?.url;
      if (orphan) fs.rmSync(storedFilePath(orphan), { force: true });
      pending.resolve(null);
      return;
    }
    const item = ctx.components.add(
      owner.id,
      fromProposal(
        {
          ...pending.proposal,
          files: msg.files ?? pending.proposal.files,
          note: msg.note ?? pending.proposal.note,
        },
        name,
      ),
    );
    // already copied when the card went up, so it is kept with the
    // entry no matter what has happened to the model's own file
    if (pending.proposal.image) ctx.components.addShot(owner.id, item.id, pending.proposal.image);
    pushComponents(ctx, owner.id, owner.path);
    pending.resolve(name);
  },
  component_update: (ctx, _ws, msg) => {
    ctx.components.update(msg.projectId, msg.componentId, {
      ...(msg.name !== undefined ? { name: msg.name } : {}),
      ...(msg.slug !== undefined ? { slug: msg.slug } : {}),
      ...(msg.aliases !== undefined ? { aliases: msg.aliases } : {}),
      ...(msg.files !== undefined ? { files: msg.files } : {}),
      ...(msg.uses !== undefined ? { uses: msg.uses } : {}),
      ...(msg.tags !== undefined ? { tags: msg.tags } : {}),
      ...(msg.deps !== undefined ? { deps: msg.deps } : {}),
      ...(msg.note !== undefined ? { note: msg.note } : {}),
      ...(msg.selector !== undefined ? { selector: msg.selector } : {}),
      ...(msg.route !== undefined ? { route: msg.route } : {}),
      ...(msg.clicks !== undefined ? { clicks: msg.clicks } : {}),
    });
    pushComponents(ctx, msg.projectId, ctx.store.get(msg.projectId)?.path);
  },
  component_remove: (ctx, _ws, msg) => {
    ctx.components.remove(msg.projectId, msg.componentId);
    pushComponents(ctx, msg.projectId, ctx.store.get(msg.projectId)?.path);
  },
  component_shot: (ctx, _ws, msg) => {
    const { url } = storeUpload(msg.upload);
    const { data: _data, regions: _regions, ...meta } = msg.upload;
    ctx.components.addShot(msg.projectId, msg.componentId, { ...meta, url });
    pushComponents(ctx, msg.projectId, ctx.store.get(msg.projectId)?.path);
  },
  component_unshot: (ctx, _ws, msg) => {
    ctx.components.removeShot(msg.projectId, msg.componentId, msg.shotId);
    pushComponents(ctx, msg.projectId, ctx.store.get(msg.projectId)?.path);
  },
  components_sweep: (ctx, _ws, msg) => {
    void runSweep(ctx, msg.projectId, msg.shots !== false);
  },
  /** The star comes off what has been looked at — one card, or the page. */
  component_seen: (ctx, _ws, msg) => {
    if (ctx.components.see(msg.projectId, msg.componentId)) {
      pushComponents(ctx, msg.projectId, ctx.store.get(msg.projectId)?.path);
    }
  },
  /** A component's code, for the window that opened it. */
  component_code: (ctx, ws, msg) => {
    const project = ctx.store.get(msg.projectId);
    const item = ctx.components.items(msg.projectId).find((i) => i.id === msg.componentId);
    if (!project || !item) return;
    ws.send(
      JSON.stringify({
        type: "component_code",
        projectId: msg.projectId,
        componentId: msg.componentId,
        files: readComponent(project.path, item),
      } satisfies ServerMessage),
    );
  },
  library_dir: (ctx, _ws, msg) => {
    ctx.components.setDir(msg.projectId, msg.dir);
    pushComponents(ctx, msg.projectId, ctx.store.get(msg.projectId)?.path);
  },
} satisfies Partial<Handlers>;
