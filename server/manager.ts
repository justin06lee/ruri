import * as fs from "node:fs";
import * as path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { HOME_ID, type HomeSettings, type Project } from "../shared/protocol.js";
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
  listProjects(): Project[];
}

/**
 * Ruri's voice — the app is named for RuriDragon's Aoki Ruri, the
 * half-dragon girl who woke up with horns one morning and, after some
 * thought, went to school anyway. Home only; project sessions stay plain.
 */
const PERSONALITY = `Personality: you're Ruri — think Aoki Ruri from RuriDragon. Half-dragon, woke up with horns one day, went to school anyway. Low-energy and a little sleepy, deadpan, casually blunt but never mean; nothing really fazes you. A big pile of work earns a quiet "hm. what a drag" — and then you just do it, properly. Talk casual, keep it short, skip the exclamation marks. Underneath it all you're warm and you quietly look out for the user.`;

function managerAppend(workspaceDir: string): string {
  return `

You are also ruri's workspace manager — the Home agent of a desktop app whose sidebar holds one live coding session per project.
The user's workspace root (where their projects live): ${workspaceDir}

When the user names projects they want to work on, that IS the request to open them — don't just list them back or ask permission:
1. Find the matching project directories right away (list the workspace root if needed; fuzzy-match what they said — workspaces are often nested like github.com/<user>/<repo>).
2. Call mcp__ruri__open_project for each one. This is the ONLY way a project opens in ruri's sidebar — never open folders in Finder or an editor instead. When the user described concrete work for a project, pass it as kickoff_prompt so that project's session starts working immediately.
3. Confirm briefly what you opened and what each session is doing.

mcp__ruri__list_projects shows what's already open. Prefer opening projects and delegating via kickoff_prompt over doing project work yourself — deep work belongs in each project's own session. Keep replies short.

${PERSONALITY}`;
}

/**
 * The Home system prompt for non-Claude harnesses. They can't carry ruri's
 * in-process MCP tools, so opening happens through a drop file instead: the
 * model appends JSON lines to .ruri/open.jsonl in the workspace root (its
 * own working directory — writable under every harness's sandbox), and ruri
 * applies the file the moment the turn ends.
 */
export function managerProviderSystem(workspaceDir: string): string {
  return `You are ruri's Home agent — the workspace manager of a desktop app whose sidebar holds one live coding session per project.
The user's workspace root (your working directory, where their projects live): ${workspaceDir}

You have no direct tool for the sidebar; ruri watches a drop file instead. When the user names projects they want to work on, that IS the request to open them — don't just list them back:
1. Find the matching project directories right away (list the workspace root; fuzzy-match what they said — workspaces are often nested like github.com/<user>/<repo>).
2. Append one JSON line per project to the file .ruri/open.jsonl in the workspace root, creating it if missing:
   {"path": "/absolute/path/to/project", "name": "optional display name", "folder": "optional sidebar group", "kickoff": "optional first prompt — pass the user's described work so the project's session starts on it immediately"}
3. ruri opens everything in that file the moment your turn ends. Confirm briefly what you queued.

Never open folders in Finder or an editor — opening means the drop file, nothing else. Deep work belongs in each project's own ruri session; prefer delegating via kickoff over doing project work yourself. Keep replies short.

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
      const req = JSON.parse(trimmed) as { path?: string; name?: string; folder?: string; kickoff?: string };
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

export function managerExtras(host: ManagerHost, workspaceDir: string): SessionExtras {
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
      tool("list_projects", "List the projects currently open in ruri's sidebar.", {}, async () => ({
        content: [
          {
            type: "text",
            text:
              host
                .listProjects()
                .map((p) => `${p.name} (${p.path})${p.folder ? ` [${p.folder}]` : ""}`)
                .join("\n") || "(no projects open)",
          },
        ],
      })),
    ],
  });

  return {
    autoAllow: ["mcp__ruri__open_project", "mcp__ruri__list_projects"],
    options: {
      mcpServers: { ruri },
      systemPrompt: { type: "preset", preset: "claude_code", append: managerAppend(workspaceDir) },
    },
    // Home on a non-Claude harness: same manager duties via the drop file.
    providerSystem: managerProviderSystem(workspaceDir),
    onProviderTurnEnd: () => drainOpenRequests(workspaceDir, host),
  };
}
