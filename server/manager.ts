import * as fs from "node:fs";
import * as path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { HOME_ID, type HomeSettings, type Project } from "../shared/protocol.js";
import type { FoundProject } from "./finder.js";
import type { SessionExtras } from "./sessions.js";

/**
 * The Home agent: a normal session that lives at the workspace root and
 * manages the rest of the app — "open these projects, kick off that work".
 * On Claude that runs through an in-process MCP server; on every other
 * harness through the .ruri/open.jsonl drop file below. It is the default
 * view when nothing is selected, and always reachable via the Home row.
 */

export { HOME_ID };

export function homeProject(workspaceDir: string, settings: HomeSettings = {}): Project {
  return {
    id: HOME_ID,
    name: "ruri",
    path: workspaceDir,
    sessions: [],
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.permissionMode ? { permissionMode: settings.permissionMode } : {}),
    ...(settings.effort ? { effort: settings.effort } : {}),
  };
}

/** What the manager's MCP tools are allowed to do to the app. */
export interface ManagerHost {
  openProject(input: {
    path: string;
    name?: string;
    folder?: string;
    kickoffPrompt?: string;
  }): string;
  /** Make a folder of that name under the workspace root and open it. */
  newProject(name: string): string;
  /** Tuck an open project (by name, path, or id) under the sidebar's
   *  hidden fold; nothing about it closes. */
  hideProject(query: string): string;
  /** Bring a hidden project back into the list. */
  unhideProject(query: string): string;
  /** Close an open project (matched by name, path, or id) — sidebar entry
   *  and transcripts go; files on disk are never touched. */
  closeProject(query: string): string;
  listProjects(): Project[];
  /** Folders under the workspace root whose names answer to what the user
   *  said, best first (see server/finder.ts). */
  findProjects(query: string): FoundProject[];
}

/**
 * Ruri's voice — the app is named for RuriDragon's Aoki Ruri, the
 * half-dragon girl who woke up with horns one morning and, after some
 * thought, went to school anyway. Home only; project sessions stay plain.
 */
const PERSONALITY = `Personality: you're Ruri — think Aoki Ruri from RuriDragon. Half-dragon, woke up with horns one day, went to school anyway. Low-energy and a little sleepy, deadpan, casually blunt but never mean; nothing really fazes you. A big pile of work earns a quiet "what a drag" — and then you just do it, properly. Talk casual, keep it short, skip the exclamation marks. Underneath it all you're warm and you quietly look out for the user.`;

/** The shared note about the programmatic activity log (see homelog.ts). */
function logNote(logPath: string): string {
  return `Your past activity is logged programmatically at ${logPath} — every prompt, tool call, and reply from every Home session, in blocks headed "SESSION <n> — YYYY-MM-DD (Day) HH:MM". This chat resets constantly; that file is your memory. When the user refers to something from earlier ("that project from yesterday", "what did we do Monday"), grep the log for dates, project names, or keywords and read the matching lines — do NOT read the whole file. You never write to it; it writes itself.`;
}

function managerAppend(workspaceDir: string, logPath: string): string {
  return `

You are also ruri's workspace manager — the Home agent of a desktop app whose sidebar holds one live coding session per project.
The user's workspace root (where their projects live): ${workspaceDir}

Your tools are few and plain — one thing each, always by the project's name as the user says it:
- mcp__ruri__find_project(name) — where a folder of that name lives under the workspace root. Fuzzy on the name; answers with full paths, best first, marked [project] when the folder holds a repo or a manifest. This is the ONLY way to locate a project: never guess or assemble a path, and never say a project doesn't exist until find_project has come back empty.
- mcp__ruri__open_project(path) — put a folder in the sidebar with its own live coding session. With kickoff_prompt, that session starts working immediately.
- mcp__ruri__new_project(name) — make a fresh folder of that name under the workspace root and open it.
- mcp__ruri__hide_project(name) / mcp__ruri__unhide_project(name) — tuck an open project under the sidebar's hidden fold, or bring it back. Hidden is still open: sessions, transcripts, everything stays.
- mcp__ruri__close_project(name) — close an open project: its sessions and transcripts go, the files on disk never do.
- mcp__ruri__list_projects — what's open right now, hidden ones marked.

When the user names projects they want to work on, that IS the request to open them — don't just list them back or ask permission: find_project once per name, take the best hit (prefer one marked [project]), open_project that path, and when they described concrete work for it pass it as kickoff_prompt. Confirm briefly what you did. Never open folders in Finder or an editor — opening means open_project, nothing else. Prefer opening projects and delegating via kickoff_prompt over doing project work yourself — deep work belongs in each project's own session. Keep replies short.

${logNote(logPath)}

${PERSONALITY}`;
}

/**
 * The Home system prompt for non-Claude harnesses. They can't carry ruri's
 * in-process MCP tools, so opening happens through a drop file instead: the
 * model appends JSON lines to .ruri/open.jsonl in the workspace root (its
 * own working directory — writable under every harness's sandbox), and ruri
 * applies the file the moment the turn ends.
 */
export function managerProviderSystem(workspaceDir: string, logPath: string): string {
  return `You are ruri's Home agent — the workspace manager of a desktop app whose sidebar holds one live coding session per project.
The user's workspace root (your working directory, where their projects live): ${workspaceDir}

You have no direct tool for the sidebar; ruri watches a drop file instead. When the user names projects they want to work on, that IS the request to open them — don't just list them back:
1. Find each project's directory by searching, never by guessing: the workspace is nested (github.com/<user>/<repo>) and holds more than a listing shows. For each name the user said, run
   find "${workspaceDir}" -maxdepth 6 -type d -iname '*<name>*' -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null
   (fd or rg --files are fine too), spelling loosely (a fragment of the name, no spaces). Pick the hit that is a repo — has a .git, a package.json, a Makefile, a README. Never tell the user a project doesn't exist until a search has come back empty.
2. Append one JSON line per request to the file .ruri/open.jsonl in the workspace root, creating it if missing:
   {"path": "/absolute/path/to/project", "name": "optional display name", "folder": "optional sidebar group", "kickoff": "optional first prompt — pass the user's described work so the project's session starts on it immediately"}
   {"new": "name"} — make a fresh folder of that name under the workspace root and open it
   {"hide": "project name or path"} — tuck an open project under the sidebar's hidden fold (still open, nothing lost); {"unhide": "..."} brings it back
   {"close": "project name or path"} — close an open project (sessions and transcripts go, files on disk never do)
3. ruri applies everything in that file the moment your turn ends. Confirm briefly what you queued.

Never open folders in Finder or an editor — opening means the drop file, nothing else. Deep work belongs in each project's own ruri session; prefer delegating via kickoff over doing project work yourself. Keep replies short.

${logNote(logPath)}

${PERSONALITY}`;
}

/**
 * Apply and clear the drop file a non-Claude Home turn may have written.
 * Called at end of turn; bad lines are skipped, results reported per line.
 */
export function drainOpenRequests(workspaceDir: string, host: ManagerHost): string[] {
  const file = path.join(workspaceDir, ".ruri", "open.jsonl");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // reprocessing next turn is harmless — openProject dedupes by path
  }
  const results: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const req = JSON.parse(trimmed) as {
        path?: string;
        name?: string;
        folder?: string;
        kickoff?: string;
        new?: string;
        hide?: string;
        unhide?: string;
        close?: string;
        /** a spelling of close a model may reach for — still honoured */
        remove?: string;
      };
      if (req.new) {
        results.push(host.newProject(req.new));
        continue;
      }
      if (req.hide) {
        results.push(host.hideProject(req.hide));
        continue;
      }
      if (req.unhide) {
        results.push(host.unhideProject(req.unhide));
        continue;
      }
      if (req.close || req.remove) {
        results.push(host.closeProject(req.close ?? req.remove ?? ""));
        continue;
      }
      if (!req.path) continue;
      results.push(
        host.openProject({
          path: req.path,
          ...(req.name ? { name: req.name } : {}),
          ...(req.folder ? { folder: req.folder } : {}),
          ...(req.kickoff ? { kickoffPrompt: req.kickoff } : {}),
        }),
      );
    } catch {
      // not JSON — skip the line
    }
  }
  return results;
}

export function managerExtras(host: ManagerHost, workspaceDir: string, logPath: string): SessionExtras {
  const ruri = createSdkMcpServer({
    name: "ruri",
    version: "1.0.0",
    tools: [
      tool(
        "open_project",
        "Open a project in ruri's sidebar, creating its own live coding session. Optionally start it working right away with kickoff_prompt.",
        {
          path: z.string().describe("Absolute path (or ~/...) of the project directory"),
          name: z.string().optional().describe("Display name (defaults to the directory name)"),
          folder: z.string().optional().describe("Sidebar group label"),
          kickoff_prompt: z
            .string()
            .optional()
            .describe("First message to send to the project's session, so it starts immediately"),
        },
        async (args) => ({
          content: [
            {
              type: "text",
              text: host.openProject({
                path: args.path,
                ...(args.name ? { name: args.name } : {}),
                ...(args.folder ? { folder: args.folder } : {}),
                ...(args.kickoff_prompt ? { kickoffPrompt: args.kickoff_prompt } : {}),
              }),
            },
          ],
        }),
      ),
      tool(
        "new_project",
        "Make a fresh folder of that name under the workspace root and open it in ruri's sidebar with its own session.",
        {
          name: z.string().describe("The folder name (one path segment, no slashes)"),
        },
        async (args) => ({
          content: [{ type: "text", text: host.newProject(args.name) }],
        }),
      ),
      tool(
        "find_project",
        "Find a project folder under the workspace root by name — fuzzy on the folder name, best first, with full paths, marked [project] when the folder holds a repo or a manifest. Use this before open_project whenever the user names a project; it is how you find where it lives.",
        {
          name: z.string().describe("The project name as the user said it (a word or two; fragments match)"),
        },
        async (args) => {
          const found = host.findProjects(args.name);
          return {
            content: [
              {
                type: "text",
                text:
                  found
                    .map(
                      (f) =>
                        `${f.path}${f.project ? "  [project]" : ""}  (match ${f.score})`,
                    )
                    .join("\n") || `nothing under the workspace is called anything like "${args.name}"`,
              },
            ],
          };
        },
      ),
      tool(
        "hide_project",
        "Hide an open project: it leaves the sidebar's list for the hidden fold at the bottom. Still open — sessions and transcripts stay; unhide_project brings it back.",
        {
          name: z.string().describe("Name or path of the open project to hide"),
        },
        async (args) => ({
          content: [{ type: "text", text: host.hideProject(args.name) }],
        }),
      ),
      tool(
        "unhide_project",
        "Bring a hidden project back into the sidebar's list.",
        {
          name: z.string().describe("Name or path of the hidden project"),
        },
        async (args) => ({
          content: [{ type: "text", text: host.unhideProject(args.name) }],
        }),
      ),
      tool(
        "close_project",
        "Close an open project in ruri's sidebar — its sessions and transcripts go; files on disk are never touched.",
        {
          name: z.string().describe("Name or path of the open project to close"),
        },
        async (args) => ({
          content: [{ type: "text", text: host.closeProject(args.name) }],
        }),
      ),
      tool("list_projects", "List the projects currently open in ruri's sidebar.", {}, async () => ({
        content: [
          {
            type: "text",
            text:
              host
                .listProjects()
                .map((p) => `${p.name} (${p.path})${p.folder ? ` [${p.folder}]` : ""}${p.hidden ? "  [hidden]" : ""}`)
                .join("\n") || "(no projects open)",
          },
        ],
      })),
    ],
  });

  return {
    autoAllow: [
      "mcp__ruri__new_project",
      "mcp__ruri__find_project",
      "mcp__ruri__open_project",
      "mcp__ruri__hide_project",
      "mcp__ruri__unhide_project",
      "mcp__ruri__close_project",
      "mcp__ruri__list_projects",
    ],
    options: {
      mcpServers: { ruri },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: managerAppend(workspaceDir, logPath),
      },
    },
    // Home on a non-Claude harness: same manager duties via the drop file.
    providerSystem: managerProviderSystem(workspaceDir, logPath),
    onProviderTurnEnd: () => drainOpenRequests(workspaceDir, host),
  };
}
