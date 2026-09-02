import * as os from "node:os";
import * as path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { BridgeState } from "../shared/protocol.js";

/**
 * The bridge: a session that can see and drive what it built.
 *
 * A model that changes an interface and reports "done" has, at best,
 * reasoned about it; the bridge lets it look. A web page opens in a window
 * ruri owns and never shows, driven with real pointer and key events over
 * the DevTools protocol; a desktop app is launched in the background and
 * driven the same way if it is Electron, or through the Accessibility tree
 * if it is not. Nothing appears in front of the user, nothing takes their
 * focus, and nothing they are doing can land in the thing under test. What
 * they get instead is a small live picture of it beside the composer, and
 * a button to take the window over when they want to see for themselves.
 *
 * The tools reach a session two ways, so every harness gets the same
 * thing. Claude holds them in-process as the `bridge` MCP server
 * (`mcp__bridge__web_open`, …), auto-allowed like the naming tools. Every
 * other harness gets one HTTP endpoint on ruri's own server — the channel
 * id in the path is the capability, and only that session is told it.
 *
 * This file is the harness-neutral half: what the tools are, how their
 * arguments are checked, how a result is shaped for each transport, and
 * what a session is told. Doing any of it takes a window, and windows are
 * the desktop shell's — see desktop/bridge.ts, passed in as the host.
 */

/** Where a channel's pictures land: ~/.config/ruri/bridge/<channelId>/. */
export function bridgeDir(channelId: string): string {
  return path.join(
    process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"),
    "bridge",
    path.basename(channelId),
  );
}

/* ── the tools ──────────────────────────────────────────────────── */

const selectorArg = z.string().optional().describe("A CSS selector for the element");
const textArg = z.string().optional().describe("Words on the thing to click — a button, link or label; case-insensitive substring");
const handleArg = z.string().describe("The handle app_launch answered with");
const waitArgs = {
  selector: z.string().optional().describe("Wait until this selector is on the page and visible"),
  text: z.string().optional().describe("Wait until the page's text contains this (case-insensitive)"),
  url: z.string().optional().describe("Wait until the URL contains this substring, or matches this /regex/"),
  idle: z.boolean().optional().describe("Wait until the network has been quiet for half a second"),
  timeoutMs: z.number().optional().describe("How long to wait (default 15000)"),
};
const logArgs = {
  kind: z.enum(["console", "network", "all"]).optional().describe("Which log (default all)"),
  clear: z.boolean().optional().describe("Empty the log after reading it"),
};

/** Every tool's arguments, as zod shapes — the MCP server and the HTTP
 *  endpoint both check against these. */
export const BRIDGE_SHAPES = {
  web_open: {
    url: z.string().describe("http(s) URL, or a path to a local HTML file"),
  },
  web_click: {
    selector: selectorArg,
    text: textArg,
    x: z.number().optional().describe("Page x, with y, to click a point"),
    y: z.number().optional(),
  },
  web_type: {
    text: z.string().describe("What to type; a newline presses Enter"),
    selector: z.string().optional().describe("Click this first, so the text lands in it"),
  },
  web_press: {
    key: z.string().describe('A key or chord: "Enter", "Escape", "Tab", "Meta+A", "Shift+ArrowDown"'),
    modifiers: z.array(z.string()).optional().describe("Extra modifiers to hold (Meta, Ctrl, Alt, Shift)"),
  },
  web_scroll: {
    selector: z.string().optional().describe("Scroll over this element (the page when absent)"),
    dx: z.number().optional(),
    dy: z.number().optional().describe("Pixels down (default 500 when neither is given)"),
  },
  web_screenshot: {
    selector: z.string().optional().describe("Photograph just this element, with a little room around it"),
    full: z.boolean().optional().describe("The whole document, not just the viewport"),
  },
  web_eval: {
    js: z.string().describe("JavaScript to run in the page; the value (or awaited promise) comes back as text"),
  },
  web_logs: logArgs,
  web_wait_for: waitArgs,
  web_where: {},
  web_close: {},
  app_launch: {
    app: z.string().optional().describe('A macOS app by name or path ("TextEdit", "/Applications/Foo.app") — opened in the background'),
    command: z.string().optional().describe("A command to run instead — a dev-built Electron app; started with a debugging port and driven over it"),
    args: z.array(z.string()).optional().describe("Arguments for the command"),
    cwd: z.string().optional().describe("Directory to run the command in"),
    electron: z.boolean().optional().describe("Treat the command as Electron (the default for a command)"),
  },
  app_click: {
    handle: handleArg,
    selector: selectorArg,
    text: textArg,
    x: z.number().optional(),
    y: z.number().optional(),
  },
  app_type: {
    handle: handleArg,
    text: z.string().describe("What to type; a newline presses Enter"),
    selector: z.string().optional().describe("Click this first, so the text lands in it"),
  },
  app_press: {
    handle: handleArg,
    key: z.string().describe('A key or chord: "Enter", "Meta+A"'),
    modifiers: z.array(z.string()).optional(),
  },
  app_scroll: {
    handle: handleArg,
    selector: z.string().optional(),
    dx: z.number().optional(),
    dy: z.number().optional(),
  },
  app_eval: {
    handle: handleArg,
    js: z.string().describe("JavaScript to run in the app's page"),
  },
  app_wait_for: { handle: handleArg, ...waitArgs },
  app_logs: { handle: handleArg, ...logArgs },
  app_screenshot: {
    handle: handleArg,
    selector: z.string().optional().describe("Electron apps only: just this element"),
    full: z.boolean().optional().describe("Electron apps only: the whole document"),
  },
  app_ui_tree: {
    handle: handleArg,
    depth: z.number().optional().describe("How deep to walk each window's elements (default 4)"),
  },
  app_ui: {
    handle: handleArg,
    script: z
      .string()
      .describe(
        'AppleScript run inside `tell application "System Events" to tell process "<app>"` — e.g. `click button "OK" of window 1`, `set value of text area 1 of scroll area 1 of window 1 to "hello"`, `click menu item "Save" of menu "File" of menu bar 1`. These go through the Accessibility API, so the app need not be in front.',
      ),
  },
  app_list: {},
  app_quit: { handle: handleArg },
} as const;

export type BridgeTool = keyof typeof BRIDGE_SHAPES;

/** Every tool's checked arguments. */
export type BridgeArgs = {
  [K in BridgeTool]: z.infer<z.ZodObject<(typeof BRIDGE_SHAPES)[K]>>;
};

/** One call, with its arguments already checked. */
export type BridgeCall = { [K in BridgeTool]: { tool: K; args: BridgeArgs[K] } }[BridgeTool];

/** The tool names in the order a reader wants them. */
export const BRIDGE_TOOL_NAMES = Object.keys(BRIDGE_SHAPES) as BridgeTool[];

/** The names as Claude sees them, for auto-allow. */
export const BRIDGE_TOOLS = BRIDGE_TOOL_NAMES.map((name) => `mcp__bridge__${name}`);

const DESCRIPTIONS: Record<BridgeTool, string> = {
  web_open:
    "Load a URL (or a local HTML file) in ruri's hidden browser window for this session. Waits for the load; answers with the title, the final URL and a screenshot. The window persists logins per project and is never shown to the user unless they take it over.",
  web_click:
    "Click something in the open page: by CSS selector, by the words on it, or at page coordinates. A real pointer event, scrolled into view first. Answers with a screenshot of the result.",
  web_type:
    "Type text into the open page as key events (so controlled inputs update), optionally clicking a selector first. A newline presses Enter. Answers with a screenshot.",
  web_press: 'Press a key or chord in the open page: "Enter", "Escape", "Tab", "Meta+A", "Shift+Tab". Answers with a screenshot.',
  web_scroll: "Scroll the open page, or one scrollable element in it, by dx/dy pixels.",
  web_screenshot:
    "Photograph the open page at full resolution: the viewport, one element's rectangle, or the whole document. Saves a PNG and returns its path and the image.",
  web_eval: "Run JavaScript in the open page and get the value back as text (promises are awaited).",
  web_logs: "What the open page logged to the console and fetched over the network since it was opened (the last 500 of each).",
  web_wait_for:
    "Wait until the open page shows a selector, says some text, reaches a URL, or goes quiet on the network. Answers with a screenshot once it does; fails with what it was still waiting for.",
  web_where: "The open page's URL, title and viewport size, and whether the user has taken the window over.",
  web_close: "Close this session's hidden browser window.",
  app_launch:
    "Launch a macOS app in the background (by name or path), or run a command that starts a dev-built Electron app and attach to it over the DevTools protocol. The user's focus stays where it is. Answers with a handle and its kind: 'electron' handles take app_click/app_type/app_press/app_scroll/app_eval/app_wait_for/app_logs/app_screenshot; 'native' handles take app_ui_tree, app_ui and app_screenshot.",
  app_click: "Click in a launched Electron app's page: by selector, by the words on it, or at coordinates. Answers with a screenshot.",
  app_type: "Type into a launched Electron app's page, optionally clicking a selector first. Answers with a screenshot.",
  app_press: "Press a key or chord in a launched Electron app's page. Answers with a screenshot.",
  app_scroll: "Scroll a launched Electron app's page, or an element in it.",
  app_eval: "Run JavaScript in a launched Electron app's page.",
  app_wait_for: "Wait for a selector, text, URL or network idle in a launched Electron app's page.",
  app_logs: "Console and network logs from a launched Electron app's page.",
  app_screenshot:
    "Photograph a launched app's window — even behind other windows. Electron apps: the page (optionally one element or the whole document). Native apps: the front window, through Screen Recording.",
  app_ui_tree:
    "A native app's front window as the Accessibility API sees it: every control with its role, name, value, position and size, to a depth. Read this before writing an app_ui script.",
  app_ui:
    'Run an AppleScript fragment inside `tell process "<app>"` (System Events) against a native app: click buttons, set text fields, pick menu items — all through Accessibility, without bringing the app forward. Answers with the script\'s result.',
  app_list: "The apps this session has launched and still holds.",
  app_quit: "Quit a launched app (gracefully, then by force after a grace period).",
};

/* ── what running a tool answers ────────────────────────────────── */

export interface BridgeResult {
  /** A short account of what happened, for the model. */
  text: string;
  /** A picture to look at: the PNG, and where it was saved. */
  image?: { png: Buffer; path: string };
}

/** Who is asking: the session, and the project it belongs to (the hidden
 *  window's cookies are kept per project). */
export interface BridgeContext {
  channelId: string;
  projectId: string;
}

/**
 * What the desktop shell provides: it holds the windows, the launched
 * apps and the previews, and answers every tool. Absent when ruri runs
 * headless, and then every tool says so.
 */
export interface BridgeHost {
  run(ctx: BridgeContext, call: BridgeCall): Promise<BridgeResult>;
  /** Tear down everything a channel holds — the window and any apps. */
  close(channelId: string): Promise<void>;
  /** Put what the channel is driving on screen, in front, for the user. */
  takeover(channelId: string): Promise<void>;
  /** Hide it again. */
  release(channelId: string): Promise<void>;
  /** Everything live, for a connecting client's snapshot. */
  states(): Record<string, BridgeState>;
  /** Told whenever a channel's state changes, or it closes (null). */
  onState(listener: (channelId: string, state: BridgeState | null) => void): void;
  /** Everything, everywhere — ruri is quitting. */
  closeAll(): Promise<void>;
}

const NOT_AVAILABLE =
  "The bridge is not available in this run: ruri is running headless, without the desktop shell that owns its windows.";

/**
 * Run one call end to end for whichever transport is asking: check the
 * arguments against the tool's shape, hand it to the host, and turn
 * whatever went wrong into words rather than a stack.
 */
export async function runBridge(
  host: BridgeHost | undefined,
  ctx: BridgeContext,
  tool: string,
  rawArgs: unknown,
): Promise<{ ok: true; result: BridgeResult } | { ok: false; error: string }> {
  if (!Object.hasOwn(BRIDGE_SHAPES, tool)) {
    return { ok: false, error: `unknown tool "${tool}" — one of: ${BRIDGE_TOOL_NAMES.join(", ")}` };
  }
  const name = tool as BridgeTool;
  if (!host) return { ok: false, error: NOT_AVAILABLE };
  const parsed = z.object(BRIDGE_SHAPES[name]).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ");
    return { ok: false, error: `bad arguments for ${name}: ${issues}` };
  }
  try {
    const result = await host.run(ctx, { tool: name, args: parsed.data } as BridgeCall);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The in-process MCP server a Claude session holds. Each tool answers with
 * a line of text and, when there is something to look at, the picture
 * itself as an image block — the model sees the result of what it did
 * without a second call.
 */
export function bridgeTools(host: BridgeHost | undefined, ctx: BridgeContext) {
  const define = <K extends BridgeTool>(name: K) =>
    tool(name, DESCRIPTIONS[name], BRIDGE_SHAPES[name], async (args) => {
      const outcome = await runBridge(host, ctx, name, args);
      if (!outcome.ok) return { content: [{ type: "text" as const, text: outcome.error }], isError: true };
      const { text, image } = outcome.result;
      return {
        content: [
          { type: "text" as const, text },
          ...(image
            ? [{ type: "image" as const, data: image.png.toString("base64"), mimeType: "image/png" }]
            : []),
        ],
      };
    });
  return createSdkMcpServer({
    name: "bridge",
    version: "1.0.0",
    tools: BRIDGE_TOOL_NAMES.map((name) => define(name)),
  });
}

/* ── what a session is told ─────────────────────────────────────── */

/** For a Claude session, which holds the tools. Short: this rides every
 *  system prompt. */
export function bridgeToolBriefing(): string {
  return [
    "<ruri:bridge>",
    "You can see and drive what you build without interrupting the user: the mcp__bridge__* tools. web_open loads a page (a dev server, a file) in a window ruri keeps hidden; web_click, web_type, web_press and web_scroll drive it with real input; web_wait_for, web_eval and web_logs read it; web_screenshot photographs it, and every driving tool returns a picture of the result. app_launch starts a macOS app or a dev-built Electron app in the background: Electron ones take app_click/app_type/app_press/app_eval/app_screenshot, native ones take app_ui_tree, app_ui (AppleScript UI scripting) and app_screenshot; app_quit and web_close when done.",
    "After building or changing anything visible: open it, drive it, look at the screenshot, fix what is wrong, and only then report. The user sees a small live preview and can take the window over; it never appears in front of them otherwise.",
    "</ruri:bridge>",
  ].join("\n");
}

/** For every other harness: the same thing over HTTP. */
export function bridgeHttpBriefing(endpoint: string): string {
  return [
    "<ruri:bridge>",
    `You can see and drive what you build without interrupting the user. POST JSON to ${endpoint} as {"tool": "<name>", "args": {...}}; it answers {"ok": true, "text": "...", "image": "<png path>"} or {"ok": false, "error": "..."}. Read the image path to look at it. For example:`,
    `  curl -s -X POST ${endpoint} -H 'content-type: application/json' -d '{"tool":"web_open","args":{"url":"http://localhost:5173"}}'`,
    "Web (a page in a window ruri keeps hidden): web_open {url} · web_click {selector | text | x,y} · web_type {text, selector?} · web_press {key} · web_scroll {selector?, dx?, dy?} · web_wait_for {selector | text | url | idle} · web_eval {js} · web_logs {kind} · web_screenshot {selector?, full?} · web_where · web_close.",
    "Apps (launched in the background): app_launch {app | command, args?, cwd?} → {handle, kind} · Electron: app_click / app_type / app_press / app_scroll / app_eval / app_wait_for / app_logs / app_screenshot {handle, …} · native: app_ui_tree {handle}, app_ui {handle, script} (AppleScript inside `tell process`), app_screenshot {handle} · app_list · app_quit {handle}.",
    "After building or changing anything visible: open it, drive it, look at the picture, fix what is wrong, and only then report. Keep the endpoint to yourself.",
    "</ruri:bridge>",
  ].join("\n");
}
