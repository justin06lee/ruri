import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { HOME_ID, type Project } from "../shared/protocol.js";
import type { SessionExtras } from "./sessions.js";

/**
 * The Home agent: a normal Claude Code session that lives at the workspace
 * root and manages the rest of the app through an in-process MCP server —
 * "open these projects, kick off that work". It is the default view when
 * nothing is selected, and always reachable via the Home row.
 */

export { HOME_ID };

export function homeProject(workspaceDir: string): Project {
  return { id: HOME_ID, name: "ruri", path: workspaceDir };
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

function managerAppend(workspaceDir: string): string {
  return `

You are also ruri's workspace manager — the Home agent of a desktop app whose sidebar holds one live Claude Code session per project.
The user's workspace root (where their projects live): ${workspaceDir}

When the user says what they want to work on today:
1. Find the matching project directories (list the workspace root if needed; fuzzy-match what they said — workspaces are often nested like github.com/<user>/<repo>).
2. Call mcp__ruri__open_project for each one. When the user described concrete work for a project, pass it as kickoff_prompt so that project's session starts working immediately.
3. Confirm briefly what you opened and what each session is doing.

mcp__ruri__list_projects shows what's already open. Prefer opening projects and delegating via kickoff_prompt over doing project work yourself — deep work belongs in each project's own session. Keep replies short.`;
}

export function managerExtras(host: ManagerHost, workspaceDir: string): SessionExtras {
  const ruri = createSdkMcpServer({
    name: "ruri",
    version: "1.0.0",
    tools: [
      tool(
        "open_project",
        "Open a project in ruri's sidebar, creating its own live Claude Code session. Optionally start it working right away with kickoff_prompt.",
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
  };
}
