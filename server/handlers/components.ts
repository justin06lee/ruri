/**
 * The component index from the app's side: the host the model's naming
 * tools reach (the card that asks the user for a name), the repo sweep that
 * names and photographs what nobody has yet, and the components page's
 * messages. The index itself is server/components.ts.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type Attachment,
  type AttachmentUpload,
  type ComponentProposal,
  DEFAULT_PERMISSION_MODE,
  type NamedComponent,
  type PermissionRequest,
} from "../../shared/protocol.js";
import { channelProject, ownerProject } from "../channel.js";
import { type ComponentHost, writeIndexFile } from "../components.js";
import type { ServerContext } from "../context.js";
import { isMissing, warn } from "../log.js";
import { IMAGE_MIME } from "../mime.js";
import { withProjectRunning, type ShotTarget } from "../shots.js";
import { sweepProject } from "../sweep.js";
import { storedFilePath, storeUpload } from "../uploads.js";
import type { Handlers } from "./types.js";

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
          const item = ctx.components.add(owner.id, {
            name: straight,
            files: shown.files,
            note: shown.note,
          });
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
function storeShot(file: string, projectDir?: string): Attachment | undefined {
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

/** Push a project's component index to disk and to every client. */
export function pushComponents(ctx: ServerContext, projectId: string, projectDir?: string): void {
  const items = ctx.components.items(projectId);
  if (projectDir) writeIndexFile(projectDir, items);
  ctx.clients.broadcast({ type: "components", projectId, items });
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

/**
 * Name everything in a project that isn't named yet, and then go and take
 * its picture.
 *
 * Two passes, and the second one is optional in every sense: the naming
 * pass is a handful of small-model calls over the repo and always runs;
 * the picture pass starts the project's own dev server, opens it in a
 * hidden window, and photographs each component by the selector the first
 * pass wrote down. A project that isn't a page, a headless ruri, or a dev
 * server that never comes up all land in the same place — entries with no
 * screenshot, which the user can drop one onto.
 */
async function runSweep(ctx: ServerContext, projectId: string, wantShots: boolean): Promise<void> {
  const project = ctx.store.get(projectId);
  if (!project || ctx.sweeping.has(projectId)) return;
  ctx.sweeping.add(projectId);
  sweepNote(ctx, projectId, "reading the repo…");
  try {
    // Taken before the read, so a file edited while the sweep runs is read
    // again next time rather than being skipped as "already seen".
    const startedAt = Date.now();
    const { found } = await sweepProject(
      project,
      ctx.components.items(projectId),
      (note) => sweepNote(ctx, projectId, note),
      ctx.components.sweptAt(projectId),
    );
    for (const part of found) ctx.components.add(projectId, { ...part, found: true });
    ctx.components.markSwept(projectId, startedAt);
    pushComponents(ctx, projectId, project.path);

    // Everything unphotographed gets a look in, not just what this sweep
    // named — the dev server is already starting, and an entry from six
    // months ago is exactly as picture-less as one from a minute ago.
    const targets: ShotTarget[] = ctx.components
      .items(projectId)
      .filter((item) => item.selector && item.shots.length === 0)
      .map((item) => ({
        id: item.id,
        selector: item.selector!,
        ...(item.route ? { route: item.route } : {}),
        ...(item.clicks?.length ? { clicks: item.clicks } : {}),
      }));
    const named = found.length === 0 ? "nothing new to name" : `named ${found.length}`;
    const capture = ctx.options.capture;
    if (!wantShots || !capture || targets.length === 0) {
      sweepNote(ctx, projectId, named, false);
      return;
    }
    const shots = await withProjectRunning(
      project.path,
      (note) => sweepNote(ctx, projectId, note),
      (url) => capture(url, targets),
    );
    let pinned = 0;
    for (const [componentId, data] of Object.entries(shots ?? {})) {
      const item = ctx.components.items(projectId).find((i) => i.id === componentId);
      if (!item) continue;
      pinShot(ctx, projectId, item, data);
      pinned += 1;
    }
    pushComponents(ctx, projectId, project.path);
    sweepNote(ctx, projectId, `${named}, ${pinned || "no"} picture${pinned === 1 ? "" : "s"}`, false);
  } catch (err) {
    warn("server", err, "runSweep");
    sweepNote(ctx, projectId, "the sweep didn't finish — try it again", false);
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
    const item = ctx.components.add(owner.id, {
      name,
      files: msg.files ?? pending.proposal.files,
      note: msg.note ?? pending.proposal.note,
    });
    // already copied when the card went up, so it is kept with the
    // entry no matter what has happened to the model's own file
    if (pending.proposal.image) ctx.components.addShot(owner.id, item.id, pending.proposal.image);
    pushComponents(ctx, owner.id, owner.path);
    pending.resolve(name);
  },
  component_update: (ctx, _ws, msg) => {
    ctx.components.update(msg.projectId, msg.componentId, {
      ...(msg.name !== undefined ? { name: msg.name } : {}),
      ...(msg.aliases !== undefined ? { aliases: msg.aliases } : {}),
      ...(msg.files !== undefined ? { files: msg.files } : {}),
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
} satisfies Partial<Handlers>;
