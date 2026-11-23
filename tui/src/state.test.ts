import { describe, expect, test } from "bun:test";
import { HOME_ID, type ServerMessage } from "../../shared/protocol";
import { cardsOf, controlsOf, initial, markOf, reduce, sidebarRows } from "./state";
import { ALPHA, BETA, GAMMA, said, snapshot, user } from "./test/fixtures";

const ready = () => reduce(initial(), snapshot());

describe("the terminal's state", () => {
  test("a snapshot fills it, and the sidebar is the user's own order", () => {
    const s = ready();
    expect(s.ready).toBe(true);
    const rows = sidebarRows(s);
    expect(rows.map((r) => (r.kind === "home" ? "Home" : r.name))).toEqual([
      "Home",
      "beta 한국어",
      "work",
      "alpha",
      "gamma",
    ]);
    // a project is its lead; one in a folder says so; a hidden one is left out
    expect(rows[1]).toMatchObject({ kind: "project", chatId: BETA, starred: true, inFolder: false });
    expect(rows[3]).toMatchObject({ kind: "project", chatId: ALPHA, inFolder: true });
    expect(rows[2]).toMatchObject({ kind: "folder", count: 1, collapsed: false });
  });

  test("a folded folder keeps its projects out of the rows", () => {
    const s = reduce(ready(), {
      type: "sidebar",
      sidebar: {
        order: ["p-beta", "f-1", "p-gamma"],
        folders: [{ id: "f-1", name: "work", collapsed: true, projects: ["p-alpha", "p-hidden"] }],
      },
    });
    expect(sidebarRows(s).map((r) => (r.kind === "home" ? "Home" : r.name))).toEqual([
      "Home",
      "beta 한국어",
      "work",
      "gamma",
    ]);
  });

  test("a project the layout has not heard of joins the end", () => {
    const s = reduce(ready(), { type: "sidebar", sidebar: { order: ["p-beta"], folders: [] } });
    expect(sidebarRows(s).map((r) => (r.kind === "home" ? "Home" : r.name))).toEqual([
      "Home",
      "beta 한국어",
      "alpha",
      "gamma",
    ]);
  });

  test("a reply streams as deltas and gives way to its finished message", () => {
    let s = ready();
    s = reduce(s, { type: "delta", projectId: ALPHA, messageId: "a2", delta: "Hel" });
    s = reduce(s, { type: "delta", projectId: ALPHA, messageId: "a2", delta: "lo" });
    expect(s.replies[ALPHA]).toEqual({ messageId: "a2", text: "Hello" });
    s = reduce(s, { type: "event", projectId: ALPHA, event: said("a2", "Hello", 5) });
    expect(s.replies[ALPHA]).toBeUndefined();
    expect(s.transcripts[ALPHA]!.map((e) => e.id)).toEqual(["u1", "a1", "a2"]);
  });

  test("an event sent again replaces itself", () => {
    const s = reduce(ready(), { type: "event", projectId: ALPHA, event: said("a1", "changed") });
    expect(s.transcripts[ALPHA]).toHaveLength(2);
    expect(s.transcripts[ALPHA]![1]).toMatchObject({ text: "changed" });
  });

  test("a turn that ends off screen marks its chat unread; on screen it does not", () => {
    const end: ServerMessage = {
      type: "event",
      projectId: ALPHA,
      event: { kind: "result", id: "r1", ok: true, ts: 9 },
    };
    expect(markOf(reduce(ready(), end), ALPHA)).toBe("unread");
    expect(markOf(reduce({ ...ready(), activeId: ALPHA }, end), ALPHA)).toBe("idle");
  });

  test("a chat's mark: working, waiting on you, failed", () => {
    let s = ready();
    expect(markOf(s, BETA)).toBe("working");
    s = reduce(s, {
      type: "permission_request",
      request: { requestId: "q1", projectId: BETA, toolName: "Bash", input: {}, ts: 1 },
    });
    expect(markOf(s, BETA)).toBe("needs-you");
    expect(cardsOf(s, BETA)).toHaveLength(1);
    s = reduce(s, { type: "permission_resolved", requestId: "q1" });
    s = reduce(s, { type: "status", projectId: BETA, status: "error" });
    expect(markOf(s, BETA)).toBe("error");
  });

  test("a whole transcript arrives and is kept whole; a tail lays over its end", () => {
    let s = reduce(ready(), {
      type: "transcript",
      projectId: ALPHA,
      events: [user("u0", "older", 0), user("u1", "hello alpha"), said("a1", "hi **there**")],
      summaries: {},
    });
    expect(s.loaded[ALPHA]).toBe(true);
    s = reduce(s, {
      type: "tails",
      transcripts: { [ALPHA]: [said("a1", "hi again"), said("a9", "new", 9)] },
    });
    expect(s.transcripts[ALPHA]!.map((e) => e.id)).toEqual(["u0", "u1", "a1", "a9"]);
  });

  test("a project closed elsewhere sends the terminal Home", () => {
    const s = reduce({ ...ready(), activeId: GAMMA }, { type: "projects", projects: [] });
    expect(s.activeId).toBe(HOME_ID);
  });

  test("the pickers are the chat's own over its project's", () => {
    let s = ready();
    let c = controlsOf(s, ALPHA);
    expect(c).toMatchObject({
      model: "fable",
      modelLabel: "Fable 5.2",
      effort: "xhigh",
      mode: "bypassPermissions",
    });
    expect(c.account?.id).toBe("work");
    expect(c.models.map((m) => m.label)).toEqual(["Fable 5.2", "Haiku 5.5", "bonsai-2"]);
    s = reduce(s, {
      type: "projects",
      projects: s.projects.map((p) =>
        p.id === "p-alpha"
          ? {
              ...p,
              model: "haiku",
              sessions: [
                {
                  id: ALPHA,
                  lead: true,
                  model: "ollama/bonsai",
                  permissionMode: "plan",
                  accounts: { claude: "personal" },
                },
              ],
            }
          : p,
      ),
    });
    c = controlsOf(s, ALPHA);
    // a local model: no account, no effort to pick, and no approval flow
    expect(c).toMatchObject({ model: "ollama/bonsai", local: "Ollama", mode: "plan", canSetMode: false });
    expect(c.account).toBeUndefined();
    expect(c.efforts).toEqual([]);
  });

  test("a model the catalog does not list still has a name", () => {
    const s = reduce(ready(), { type: "default_model", model: "claude-opus-9-1" });
    expect(controlsOf(s, GAMMA).modelLabel).toBe("Opus 9.1");
  });
});
