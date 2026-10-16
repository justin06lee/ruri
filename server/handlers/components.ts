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
  leadOf,
  type NamedComponent,
  type PermissionRequest,
  type ServerMessage,
} from "../../shared/protocol.js";
import { channelProject, ownerProject } from "../channel.js";
import { anchorsAt, codeSig, worktreesOf } from "../checkouts.js";
import { type ComponentHost, writeIndexFile } from "../components.js";
import type { ServerContext } from "../context.js";
import {
  parseRef,
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
  codeMarks,
  reanchor,
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
function fromProposal(proposal: ComponentProposal, name: string, confirmed: boolean) {
  return {
    name,
    files: proposal.files,
    note: proposal.note,
    exact: true,
    ...(proposal.slug ? { slug: proposal.slug } : {}),
    ...(proposal.uses ? { uses: proposal.uses } : {}),
    ...(proposal.tags ? { tags: proposal.tags } : {}),
    ...(proposal.deps ? { deps: proposal.deps } : {}),
    ...(proposal.sig ? { sig: proposal.sig } : {}),
    ...(proposal.checkout ? { filedIn: proposal.checkout } : {}),
    ...(proposal.anchors ? { anchors: proposal.anchors } : {}),
    ...(confirmed ? { confirmed: true } : {}),
  };
}

/**
 * Whether naming from this chat puts a card up for the user. Not in
 * bypass, where ruri stops asking. And not from a teammate's chat or the
 * liaison's: the user talks to the lead, and a card in a chat they aren't
 * in sat there unanswered while the agent's turn waited on it — the entry
 * goes straight in, and they rename it on the Components page.
 */
function asksUser(ctx: ServerContext, channelId: string): boolean {
  const owner = ownerProject(ctx, channelId);
  if (!owner || leadOf(owner)?.id !== channelId) return false;
  const mode = channelProject(ctx, channelId)?.permissionMode ?? DEFAULT_PERMISSION_MODE;
  return mode !== "bypassPermissions";
}

/** The checkout a proposal's files are in: the one it names, or — for a
 *  tool call that didn't say — the project's folder or the first of its
 *  worktrees that has all of them. */
function checkoutOf(projectDir: string, proposal: ComponentProposal): string {
  if (proposal.checkout) return proposal.checkout;
  const has = (root: string) => proposal.files.every((f) => fs.existsSync(path.join(root, parseRef(f).path)));
  if (has(projectDir)) return projectDir;
  return worktreesOf(projectDir).find(has) ?? projectDir;
}

export function createComponentHost(ctx: ServerContext): ComponentHost {
  return {
    list: (channelId) => {
      const owner = ownerProject(ctx, channelId);
      return owner ? ctx.components.items(owner.id) : [];
    },
    propose: (channelId, proposal) =>
      new Promise((resolve) => {
        const owner = ownerProject(ctx, channelId);
        if (!owner) {
          resolve(null);
          return;
        }
        const checkout = checkoutOf(owner.path, proposal);
        // The screenshot is copied now, not when the card is answered. The
        // card is the whole point of it — being asked to name something you
        // cannot see is being asked to guess — and the model's own copy is
        // routinely a scratch file that will not survive the wait.
        const shot = proposal.shot ? storeShot(proposal.shot, checkout) : undefined;
        const sig =
          proposal.sig ??
          codeSig(
            checkout,
            proposal.files.filter((f) => parseRef(f).line === undefined),
          );
        const filedIn = checkout !== owner.path ? checkout : undefined;
        const shown: ComponentProposal = {
          name: proposal.name,
          files: proposal.files,
          note: proposal.note,
          ...(proposal.slug ? { slug: proposal.slug } : {}),
          ...(proposal.uses?.length ? { uses: proposal.uses } : {}),
          ...(proposal.tags?.length ? { tags: proposal.tags } : {}),
          ...(proposal.deps?.length ? { deps: proposal.deps } : {}),
          ...(shot ? { image: shot } : {}),
          ...(sig ? { sig } : {}),
          ...(filedIn ? { checkout: filedIn } : {}),
          ...(proposal.uses?.length || proposal.files.some((f) => parseRef(f).line !== undefined)
            ? {
                anchors:
                  proposal.anchors ??
                  anchorsAt(
                    [checkout],
                    [
                      ...(proposal.uses ?? []),
                      ...proposal.files.filter((f) => parseRef(f).line !== undefined),
                    ],
                  ),
              }
            : {}),
        };
        // Where nobody is to be asked, the card would only ever be a
        // confirmation: the model has already named the thing and
        // photographed it. So the entry is written the moment it is
        // proposed, star and screenshot and all, and the name stays the
        // user's to change on the components page whenever they look.
        const straight = shown.name.trim();
        if (!asksUser(ctx, channelId)) {
          if (!straight) {
            resolve(null);
            return;
          }
          const item = ctx.components.add(owner.id, fromProposal(shown, straight, false));
          if (shown.image) ctx.components.addShot(owner.id, item.id, shown.image, sig, filedIn);
          pushComponents(ctx, owner.id, owner.path);
          resolve({ name: item.name, slug: item.slug, asked: false });
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
    // the card the naming tool puts up, from the shell: written at once
    // where nobody is asked (inside propose, before this returns), asked
    // about otherwise
    ask: (proposal) => {
      const asked = asksUser(ctx, channelId);
      void ctx.componentHost.propose(channelId, proposal);
      return asked ? "asked" : "added";
    },
    items: (projectId) => ctx.components.items(projectId),
    find: (projectId, handle) => ctx.components.find(projectId, handle),
    add: (projectId, input) => ctx.components.add(projectId, input),
    update: (projectId, componentId, patch, filed) =>
      ctx.components.update(projectId, componentId, patch, {
        ...(filed?.sig ? { sig: filed.sig } : {}),
        ...(filed?.in ? { filedIn: filed.in } : {}),
        ...(filed?.anchors ? { anchors: filed.anchors } : {}),
      }),
    remove: (projectId, componentId) => ctx.components.remove(projectId, componentId),
    shoot: (projectId, componentId, file, filed) => {
      const project = ctx.store.get(projectId);
      const shot = storeShot(file, project?.path);
      return shot ? ctx.components.addShot(projectId, componentId, shot, filed?.sig, filed?.in) : false;
    },
    copyShots: (projectId, componentId, shots) => {
      // newest first there, newest first here
      for (const shot of [...shots].reverse()) ctx.components.addShot(projectId, componentId, shot);
    },
    current: (projectId, componentId, filed) => {
      ctx.components.current(projectId, componentId, filed?.sig, filed?.in);
    },
    dir: (projectId) => ctx.components.dir(projectId),
    setDir: (projectId, dir) => ctx.components.setDir(projectId, dir),
    noteInstall: (projectId, componentId, paths) => ctx.components.noteInstall(projectId, componentId, paths),
    follow: async (projectId, componentId) => {
      const item = ctx.components.items(projectId).find((i) => i.id === componentId);
      if (item) await followFiles(ctx, projectId, [item]);
    },
    changed: (projectId) => pushComponents(ctx, projectId, ctx.store.get(projectId)?.path),
  };
}

/* ── keeping it true to the code ──────────────────────────────────── */

/**
 * Hold a project's entries up against its code now (ComponentStore.check):
 * what each one's own files say in the project's folder, which of them are
 * nowhere — not there, not in any of its worktrees — and its line refs
 * found again. Answers whether anything moved.
 */
export function checkLibrary(ctx: ServerContext, projectId: string): boolean {
  const project = ctx.store.get(projectId);
  if (!project) return false;
  const trees = worktreesOf(project.path);
  const read = new Map<string, string[] | null>();
  return ctx.components.check(projectId, (item) => {
    const missing = item.files.filter((ref) => {
      const rel = parseRef(ref).path;
      return ![project.path, ...trees].some((dir) => fs.existsSync(path.join(dir, rel)));
    });
    // the classes and names of its own code, only for a place with no
    // anchor yet — most entries never need them read
    const unanchored = item.uses?.some((ref) => parseRef(ref).line !== undefined && !item.anchors?.[ref]);
    const marks = unanchored ? codeMarks(project.path, item.files, item.slug) : undefined;
    const anchored = item.uses?.length
      ? reanchor(project.path, item.uses, item.anchors, read, marks)
      : undefined;
    const sig = codeSig(project.path, item.files);
    const wip = item.filedIn && fs.existsSync(item.filedIn) ? codeSig(item.filedIn, item.files) : undefined;
    return { missing, ...(sig ? { sig } : {}), ...(wip ? { wip } : {}), ...(anchored ?? {}) };
  });
}

/** Files already followed through git and found nowhere, per project — not
 *  asked about again after every turn (forgotten on a refresh). */
const lostFiles = new Map<string, Set<string>>();

/**
 * Follow entries' files that are no longer where they say through git's
 * renames, and write down where they went. A file in one of the project's
 * worktrees is still there. An entry whose own code is all gone stays as
 * it is, marked missing — taking it out is left to the refresh the user
 * asks for.
 */
async function followFiles(ctx: ServerContext, projectId: string, items: NamedComponent[]): Promise<boolean> {
  const project = ctx.store.get(projectId);
  if (!project || items.length === 0) return false;
  const tidy = await tidyFiles(project.path, items, worktreesOf(project.path));
  let moved = false;
  const lost = lostFiles.get(projectId) ?? new Set<string>();
  for (const entry of tidy) {
    const item = items.find((i) => i.id === entry.id);
    if (entry.gone || !item) {
      for (const ref of item?.files ?? []) lost.add(parseRef(ref).path);
      continue;
    }
    // moved ones re-pointed; one that went nowhere is let go, as long as
    // the entry has code of its own left
    ctx.components.update(projectId, entry.id, {
      ...(entry.files ? { files: entry.files } : {}),
      ...(entry.uses ? { uses: entry.uses } : {}),
    });
    moved = true;
  }
  lostFiles.set(projectId, lost);
  if (moved) checkLibrary(ctx, projectId);
  if (moved) pushComponents(ctx, projectId, project.path);
  return moved;
}

/**
 * The library's first look at its code the new way (ComponentStore.rebase):
 * git's word on which entries really changed since their picture and note
 * — the marks turns used to stamp let go — and then the first check, which
 * finds each drifted line it reaches again by its own classes.
 */
async function settleLibrary(ctx: ServerContext, projectId: string): Promise<void> {
  const project = ctx.store.get(projectId);
  if (!project || ctx.components.checked(projectId) || settling.has(projectId)) return;
  settling.add(projectId);
  try {
    const items = ctx.components.items(projectId).map((item) => {
      // what a turn stamped is not evidence: git is asked from the picture
      // and note on
      const { changedAt: _changedAt, ...rest } = item;
      return rest as NamedComponent;
    });
    const oldest = Math.min(Date.now(), ...items.map(currentAsOf));
    const [history, dirty] = await Promise.all([fileHistory(project.path, oldest), dirtyFiles(project.path)]);
    const changed = changesSince(items, history, dirty, mtimeIn(project.path));
    ctx.components.rebase(projectId, new Map(changed.map((change) => [change.id, change.at])));
    checkLibrary(ctx, projectId);
    pushComponents(ctx, projectId, project.path);
  } catch (err) {
    warn("components", err, "settleLibrary");
  } finally {
    settling.delete(projectId);
  }
}
const settling = new Set<string>();

/**
 * A turn in the project has finished: hold the library up against the code
 * it left (a merge of a branch whose agent re-took a picture is no change),
 * and follow any of its files that went missing. A library not yet settled
 * the new way is settled first.
 */
export function libraryAfterTurn(ctx: ServerContext, projectId: string): void {
  const project = ctx.store.get(projectId);
  if (!project) return;
  if (!ctx.components.checked(projectId)) {
    void settleLibrary(ctx, projectId);
    return;
  }
  const moved = checkLibrary(ctx, projectId);
  if (moved) pushComponents(ctx, projectId, project.path);
  const lost = lostFiles.get(projectId);
  const astray = ctx.components
    .items(projectId)
    .filter((item) => item.missing?.some((ref) => !lost?.has(parseRef(ref).path)));
  if (astray.length)
    void followFiles(ctx, projectId, astray).catch((err: unknown) => warn("components", err, "followFiles"));
}

/** Every project's library settled and checked, one after another, as the
 *  app starts — in the background, so nothing waits on git. */
export async function settleLibraries(ctx: ServerContext): Promise<void> {
  for (const project of ctx.store.list()) {
    try {
      if (!ctx.components.checked(project.id)) await settleLibrary(ctx, project.id);
      else if (checkLibrary(ctx, project.id)) pushComponents(ctx, project.id, project.path);
    } catch (err) {
      warn("components", err, "settleLibraries");
    }
  }
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
  // taken of the app running from the project's own folder
  const project = ctx.store.get(projectId);
  ctx.components.addShot(
    projectId,
    item.id,
    { ...meta, url },
    project ? codeSig(project.path, item.files) : undefined,
  );
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
    ctx.components.reviewed(
      project.id,
      item.id,
      { looks: componentStale(item).picture },
      codeSig(project.path, item.files),
    );
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
        ctx.components.reviewed(
          project.id,
          item.id,
          { ...(outcome.note ? { note: outcome.note } : {}), looks: outcome.looks },
          codeSig(project.path, item.files),
        );
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
  const sessionId =
    kept ??
    ctx.store.addMember(projectId, {
      name: PHOTO_CHAT,
      duty: "takes the pictures of the component library's entries",
    })?.id;
  if (!sessionId) return undefined;
  ctx.photographers.set(projectId, sessionId);
  if (!kept) ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
  dispatch(ctx, sessionId, photoPrompt(targets), []);
  return "started";
}

/** What the pictures chat is called on the project's team. */
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
    if (!ctx.components.checked(projectId)) await settleLibrary(ctx, projectId);
    // pictures whose files went since the library loaded are no pictures:
    // their entries are photographed with the rest
    ctx.components.pruneShots(projectId);
    lostFiles.delete(projectId);
    const tidy = await tidyFiles(project.path, ctx.components.items(projectId), worktreesOf(project.path));
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
    // what changed is decided by the code (checkLibrary); git's commits
    // are what the review reads to say how
    checkLibrary(ctx, projectId);
    const changes = new Map(
      changesSince(items, history, dirty, mtimeIn(project.path)).map((change) => [change.id, change]),
    );

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
        true,
      ),
    );
    // already copied when the card went up, so it is kept with the
    // entry no matter what has happened to the model's own file
    if (pending.proposal.image) {
      ctx.components.addShot(
        owner.id,
        item.id,
        pending.proposal.image,
        pending.proposal.sig,
        pending.proposal.checkout,
      );
    }
    pushComponents(ctx, owner.id, owner.path);
    pending.resolve({ name: item.name, slug: item.slug, asked: true });
  },
  component_update: (ctx, _ws, msg) => {
    const project = ctx.store.get(msg.projectId);
    // the user is the one renaming it here: the name is theirs now
    const sig = project && msg.files ? codeSig(project.path, msg.files) : undefined;
    const anchors = project && msg.uses ? anchorsAt([project.path], msg.uses) : undefined;
    ctx.components.update(
      msg.projectId,
      msg.componentId,
      {
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
      },
      {
        confirm: true,
        ...(msg.found === false ? { accept: true } : {}),
        ...(sig ? { sig } : {}),
        ...(anchors ? { anchors } : {}),
      },
    );
    pushComponents(ctx, msg.projectId, project?.path);
  },
  component_remove: (ctx, _ws, msg) => {
    ctx.components.remove(msg.projectId, msg.componentId);
    pushComponents(ctx, msg.projectId, ctx.store.get(msg.projectId)?.path);
  },
  component_shot: (ctx, _ws, msg) => {
    const { url } = storeUpload(msg.upload);
    const { data: _data, regions: _regions, ...meta } = msg.upload;
    // a picture dropped on the page now shows the code as it is now
    const project = ctx.store.get(msg.projectId);
    const item = ctx.components.items(msg.projectId).find((i) => i.id === msg.componentId);
    const sig = project && item ? codeSig(project.path, item.files) : undefined;
    ctx.components.addShot(msg.projectId, msg.componentId, { ...meta, url }, sig);
    pushComponents(ctx, msg.projectId, project?.path);
  },
  /** "Still right": its picture and note show it as its code is now. */
  component_current: (ctx, _ws, msg) => {
    const project = ctx.store.get(msg.projectId);
    const item = ctx.components.items(msg.projectId).find((i) => i.id === msg.componentId);
    if (!project || !item) return;
    ctx.components.current(msg.projectId, msg.componentId, codeSig(project.path, item.files));
    pushComponents(ctx, msg.projectId, project.path);
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
    // a file only on a branch not merged yet is read from its worktree
    ws.send(
      JSON.stringify({
        type: "component_code",
        projectId: msg.projectId,
        componentId: msg.componentId,
        files: readComponent([project.path, ...worktreesOf(project.path)], item),
      } satisfies ServerMessage),
    );
  },
  library_dir: (ctx, _ws, msg) => {
    ctx.components.setDir(msg.projectId, msg.dir);
    pushComponents(ctx, msg.projectId, ctx.store.get(msg.projectId)?.path);
  },
} satisfies Partial<Handlers>;
