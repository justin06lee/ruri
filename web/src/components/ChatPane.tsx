import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  DEFAULT_EFFORT,
  HOME_ID,
  type Project,
  type SessionInfo,
  type TranscriptEvent,
} from "../../../shared/protocol";
import { heroFor, heroUrl, launchHero } from "../hero";
import { beat } from "../lib/beat";
import { spinStar } from "../lib/spin";
import { StreamingMarkdown } from "../markdown";
import { heroFrame } from "../peek";
import { getPref, setPref } from "../prefs";
import {
  closeAgent,
  ensureTranscript,
  openAgent,
  requestHistory,
  send,
  useRuri,
  watchChannel,
} from "../store";
import { AgentsPage } from "./AgentsPage";
import { BridgeStrip } from "./Bridge";
import { Icon, TOOL_ICONS } from "./chat/Icon";
import { NO_EARLIER, NO_EVENTS, NO_QUEUED, NO_SUMMARIES } from "./chat/empty";
import { Components } from "./Components";
import { Composer } from "./Composer";
import { CompactionMark, EventView } from "./EventView";
import { Exchange, groupTurns, NO_EXCERPTS, turnExcerpts, type Half } from "./Exchange";
import { HomeTabs, ProjectsPage, type HomeTab } from "./HomeBoard";
import { Ideas } from "./Ideas";
import { AskCard } from "./PermissionBanner";
import { QueuedList } from "./Queue";
import { RapidBar, type RapidFire } from "./RapidFire";
import { SelectionFlags } from "./Selection";
import { Sketch, type SketchBackground } from "./Sketch";
import { Skills } from "./Skills";
import { Thinking, WorkingLine } from "./Thinking";
import { Tracker } from "./Tracker";

/** Turns rendered before the first paint — more than fills a screen; the
 *  rest arrive behind it. */
const FIRST_TURNS = 6;
/** How many more each pass adds. */
const TURN_STEP = 30;
/** How long the pane gets to itself before the filling in starts. */
const SETTLE_MS = 120;
/** How long after a gesture a scroll still counts as the user's doing. */
const GESTURE_MS = 700;
/** Frames a freshly opened session is held at its bottom while it settles. */
const SETTLE_FRAMES = 8;
/** Turns at the tail that are always laid out for real: a session opens at
 *  its bottom, and the bottom cannot be an estimate. */
const LIVE_TURNS = 4;
/** How far below the view's top an opened exchange is brought to rest. */
const REVEAL_GAP = 16;
/** Where the quiet filling stops. Past this, turns arrive because you
 *  scrolled back for them — a pane that has quietly materialised its whole
 *  history is a pane that costs that much to take down again on the way
 *  out, and leaving a session is as common as entering one. */
const IDLE_CAP = 14;

/** A hero face in its circle, framed the way the tuner left it. */
function HeroFace({ n }: { n: number }) {
  const frame = heroFrame(n);
  return (
    <div className="hero-frame">
      <img
        className="hero-face"
        src={heroUrl(n)}
        alt=""
        style={{
          left: `calc(50% + ${frame.x}%)`,
          top: `calc(50% + ${frame.y}%)`,
          transform: `translate(-50%, -50%) scale(${frame.zoom})`,
        }}
      />
    </div>
  );
}

/** Rapid fire's card fades in as it takes over and out as it hands on —
 *  the pane is the same one either way, so the classes ride on it. */
function paneClass(base: string, rapid: RapidFire | undefined): string {
  return rapid?.on ? `${base} rapid-page${rapid.leaving ? " rapid-leaving" : ""}` : base;
}

/* ── chat pane ───────────────────────────────────────────────────── */

/**
 * The pane: which chat is open, and whether it is ready to show. Everything
 * per chat lives in ChatView below, keyed by the chat — so switching chats
 * starts its state (the page showing, the folds, how much is rendered)
 * over by construction rather than by a reset effect each.
 */
export function ChatPane({
  channelId,
  rapid,
}: {
  /** The channel to show, when it isn't the app's active one — rapid fire
   *  hands it the session it has picked, leaving the sidebar where it is. */
  channelId?: string;
  rapid?: RapidFire;
} = {}) {
  const storeActive = useRuri((s) => s.activeId);
  const activeId = channelId ?? storeActive;
  const storeProject = useRuri((s) =>
    activeId ? s.projects.find((p) => p.sessions.some((x) => x.id === activeId)) : undefined,
  );
  const { workspaceDir, home } = useRuri(useShallow((s) => ({ workspaceDir: s.workspaceDir, home: s.home })));
  const isHome = activeId === HOME_ID;
  const session = storeProject?.sessions.find((x) => x.id === activeId);
  // What this chat runs on: its own model, effort and mode over the
  // project's defaults — the same merge the server makes, so the pickers,
  // the gauges and the working line all describe this chat, not its folder.
  // Kept as one object while its inputs stand still: every message on
  // screen takes it as a prop, and a fresh copy per render (several a
  // second while a reply streams) re-rendered all of them each time.
  const project = useMemo<Project | undefined>(
    () =>
      isHome
        ? { id: HOME_ID, name: "ruri", path: workspaceDir, sessions: [], ...home }
        : storeProject && {
            ...storeProject,
            ...(session?.model ? { model: session.model } : {}),
            ...(session?.permissionMode ? { permissionMode: session.permissionMode } : {}),
            ...(session?.effort ? { effort: session.effort } : {}),
          },
    [isHome, workspaceDir, home, storeProject, session],
  );
  // The snapshot only carries a chat's last few events; the whole history
  // is asked for when the chat opens, and until it arrives the pane stays
  // blank rather than showing the tail and then jumping.
  const { loaded, connected } = useRuri(
    useShallow((s) => ({ loaded: activeId ? s.loaded[activeId] === true : true, connected: s.connected })),
  );
  // On screen: this chat, and no other, is sent its conversation as it
  // happens, and keeps its agent process warm between turns. Before the
  // effect below, so the server knows before the history is asked for.
  useEffect(() => (activeId ? watchChannel(activeId) : undefined), [activeId]);
  useEffect(() => {
    if (activeId && connected && !loaded) ensureTranscript(activeId);
  }, [activeId, connected, loaded]);
  // the agents page belongs to its chat: going to another one puts it away
  useEffect(() => {
    const panel = useRuri.getState().agentPanel;
    if (panel && panel.projectId !== activeId) closeAgent();
  }, [activeId]);

  // Native-picker results land here (always mounted) and route by target.
  const { picked, clearPicked } = useRuri(
    useShallow((s) => ({ picked: s.picked, clearPicked: s.clearPicked })),
  );
  useEffect(() => {
    if (!picked) return;
    send(
      picked.target === "music"
        ? { type: "set_music_dir", path: picked.path }
        : { type: "set_workspace", path: picked.path },
    );
    clearPicked();
  }, [picked, clearPicked]);

  if (!project || !activeId || !loaded) {
    return <main className={paneClass("chat empty", rapid)} />;
  }
  return (
    <ChatView
      key={activeId}
      activeId={activeId}
      project={project}
      isHome={isHome}
      {...(session ? { session } : {})}
      {...(storeProject ? { boardId: storeProject.id } : {})}
      {...(rapid ? { rapid } : {})}
    />
  );
}

/** One chat, from its opening to its composer. Mounted afresh per chat. */
function ChatView({
  activeId,
  project,
  session,
  boardId,
  isHome,
  rapid,
}: {
  activeId: string;
  project: Project;
  session?: SessionInfo;
  /** The project the boards (ideas, components) belong to; Home has none. */
  boardId?: string;
  isHome: boolean;
  rapid?: RapidFire;
}) {
  const pane = (base: string) => paneClass(base, rapid);
  // everything the store keeps per chat, in one read
  const {
    transcript,
    draft,
    status,
    summaries,
    queuedItems,
    queueHeld,
    turn,
    crewAgents,
    trackerItems,
    earlier,
    history,
  } = useRuri(
    useShallow((s) => ({
      transcript: s.transcripts[activeId] ?? NO_EVENTS,
      draft: s.drafts[activeId],
      status: s.statuses[activeId] ?? "idle",
      summaries: s.summaries[activeId] ?? NO_SUMMARIES,
      queuedItems: s.queued[activeId] ?? NO_QUEUED,
      queueHeld: s.queueHeld[activeId] === true,
      turn: s.turns[activeId],
      crewAgents: s.crew[activeId],
      trackerItems: s.tracker[activeId],
      // What a compaction left behind it: the live transcript opens on
      // the newest mark, and the exchanges before it come with it as an
      // outline (`earlier`) — shown above the mark, each folded to its
      // notes and opening on a click. Opening one (or an older mark's
      // brief) is what fetches the history's bodies.
      earlier: s.earlier[activeId] ?? NO_EARLIER,
      history: s.history[activeId],
    })),
  );
  const allPermissions = useRuri((s) => s.permissions);
  const permissions = allPermissions.filter((p) => p.projectId === activeId);
  const { lastError, dismissError } = useRuri(
    useShallow((s) => ({ lastError: s.lastError, dismissError: s.dismissError })),
  );
  // Every agent this chat has — the model's, from its transcript, and the
  // ones you started yourself — for the header's count and the agents
  // page: the ones still working first, then the newest.
  const agents = useMemo(
    () =>
      [
        ...transcript.flatMap((e) => (e.kind === "tool" && e.agent ? [e.agent] : [])),
        ...(crewAgents ?? []),
      ].sort(
        (a, b) =>
          Number(b.status === "running") - Number(a.status === "running") || b.startedAt - a.startedAt,
      ),
    [transcript, crewAgents],
  );
  const agentsWorking = agents.filter((a) => a.status === "running").length;
  // The header's badges: numbers, not lists — a selector that mints a
  // fresh array every read spins useSyncExternalStore forever (React
  // error #185). Components named since the user last looked wear a star,
  // which is how you find out a turn named something without being taken
  // anywhere: the cards themselves are one click away.
  const { agentsOpen, ideaCount, freshComponents } = useRuri(
    useShallow((s) => ({
      agentsOpen: s.agentPanel !== null && s.agentPanel.projectId === activeId,
      ideaCount: boardId ? (s.ideas[boardId] ?? []).filter((i) => !i.done).length : 0,
      freshComponents: boardId ? (s.components[boardId] ?? []).filter((i) => i.star).length : 0,
    })),
  );

  /**
   * The pane shows one thing at a time: the chat, or one of the project's
   * pages. No navigation and no overlay — the header's buttons swap this,
   * and pressing the lit one swaps it back. Sending a prompt extracts
   * tracker items, but it does not yank you onto the tracker page to look
   * at them — the toggle's badge is the whole notification.
   */
  const [page, setPage] = useState<"chat" | "tracker" | "ideas" | "components" | "skills">("chat");
  /**
   * Home is two pages under one strip — the agent's chat and the projects
   * board — and the strip remembers which one you were on across launches.
   */
  const [homeTab, setHomeTabState] = useState<HomeTab>(() =>
    getPref("ruri-home-tab") === "projects" ? "projects" : "chat",
  );
  const setHomeTab = useCallback((tab: HomeTab) => {
    setHomeTabState(tab);
    setPref("ruri-home-tab", tab);
  }, []);
  const homeTabs = isHome && !rapid?.on && <HomeTabs tab={homeTab} onTab={setHomeTab} />;
  const openCount = (trackerItems ?? []).filter((i) => i.status === "open").length;

  // another of the project's pages takes the agents page's place, as it
  // would the chat's
  useEffect(() => {
    if (page !== "chat") closeAgent();
  }, [page]);

  // Rewind: pencil on a past prompt → a plain confirmation → the
  // conversation and the project's files go back to just before it ran and
  // the prompt lands in the composer, exactly as it was written. Editing it
  // is then just typing; nothing sends until you press send. Claude sessions
  // only (file checkpoints), and only while nothing is running.
  const { models, defaultModel } = useRuri(
    useShallow((s) => ({ models: s.models, defaultModel: s.defaultModel })),
  );
  const [rewindTarget, setRewindTarget] = useState<{ id: string; text: string } | null>(null);

  // The sketch pad takes the pane, like a page — blank, or on a picture
  // from the composer's strip. Leaving the channel leaves the pad.
  const [sketch, setSketch] = useState<{ background?: SketchBackground } | null>(null);
  const openSketch = useCallback(
    (background?: SketchBackground) => setSketch(background ? { background } : {}),
    [],
  );

  /**
   * How much of the transcript is on screen. A long session is hundreds of
   * messages of markdown, code and patches, and rendering all of it before
   * the first paint is what made switching sessions feel slow. The tail
   * paints immediately — that's what you're looking at — and the rest fills
   * in on idle frames behind it, so scrolling up finds it already there.
   */
  const [renderedTurns, setRenderedTurns] = useState(FIRST_TURNS);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  // The rest of the transcript, a chunk at a time, on frames the app has
  // nothing better to do with. It lands above what you're reading, which the
  // browser's scroll anchoring holds in place. The wait before each pass is
  // what keeps it out of the way: the switch paints first, and a switch that
  // happens mid-fill cancels the fill rather than competing with it.
  useEffect(() => {
    if (renderedTurns >= transcript.length || renderedTurns >= IDLE_CAP) return;
    let idle = 0;
    const grow = () => setRenderedTurns((shown) => shown + TURN_STEP);
    const settle = setTimeout(() => {
      idle =
        typeof requestIdleCallback === "function"
          ? requestIdleCallback(grow, { timeout: 3000 })
          : window.setTimeout(grow, 0);
    }, SETTLE_MS);
    return () => {
      clearTimeout(settle);
      if (!idle) return;
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
      else clearTimeout(idle);
    };
  }, [renderedTurns, transcript.length]);

  /**
   * Put the view back on the newest message.
   *
   * Always now, never on the next frame, and never skipped because something
   * else already did it this frame. Both of those are tempting — reading
   * scrollHeight forces a layout of the whole transcript, and four things
   * ask for this — and both cost a frame painted at the wrong offset, which
   * is the flash on every session switch. The callers that matter run after
   * layout and before paint precisely so the correction lands invisibly; the
   * cheap part is the early return below, when the view is already there.
   * Stable: it reads the scroller through its ref, so the observers below
   * can hold it for the pane's whole life.
   */
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 1) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  /**
   * When the view was last moved by a human.
   *
   * Half the scroll events in a session are nobody's doing: turns land above
   * what's rendered, markdown reflows, images decode, the composer changes
   * height. Reading "am I at the bottom?" off those and believing it is what
   * left a freshly opened session parked in the middle of itself — one racy
   * measurement during the switch set pinned to false, and from then on
   * nothing would re-bottom it.
   *
   * So only a gesture may unpin the view. Everything else may re-pin it, and
   * may never do the opposite.
   */
  const gestureRef = useRef(0);
  const noteGesture = () => {
    gestureRef.current = Date.now();
  };
  /** Where the view was last time, so a move upward can be recognised. */
  const lastTopRef = useRef(0);
  /** Whether this visit to the top has already asked for more turns. */
  const grewAtTop = useRef(false);

  // Scroll events arrive faster than the answer can change, and each one
  // reads three layout properties — measuring once a frame is enough.
  const scrollRead = useRef(false);
  const onScroll = () => {
    if (scrollRead.current) return;
    scrollRead.current = true;
    requestAnimationFrame(() => {
      scrollRead.current = false;
      const el = scrollRef.current;
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      // A view that moved *up* was moved by someone: content landing above
      // pushes scrollTop down the page, never up, and content going away
      // only ever clamps it to the bottom (where nearBottom catches it).
      // This is what makes page-up work without the transcript having focus.
      const wentUp = el.scrollTop < lastTopRef.current - 2;
      lastTopRef.current = el.scrollTop;
      if (nearBottom) pinnedRef.current = true;
      else if (wentUp || Date.now() - gestureRef.current < GESTURE_MS) pinnedRef.current = false;
      setShowJump(!nearBottom && !pinnedRef.current);
      // Reading back through the session pulls the older turns in as you go
      // — one batch per approach to the top, not one per frame spent near
      // it. Resting at the top used to add thirty turns every frame, which
      // on a long session is the whole history rendered in a second.
      if (el.scrollTop >= 600) grewAtTop.current = false;
      else if (!grewAtTop.current) {
        grewAtTop.current = true;
        setRenderedTurns((shown) => shown + TURN_STEP);
      }
    });
  };

  // Follow the conversation only while the user is at the bottom.
  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [scrollToBottom, transcript.length, draft?.text, permissions.length, status, queuedItems.length]);

  // Opening a session means opening it at the last thing said. The one
  // scroll at render time is not enough on its own: the tail is still
  // settling behind it — the window fills back in, markdown lays out, the
  // composer measures itself — so the bottom keeps moving for a few frames.
  // This holds it there until it stops moving, and stands down the moment
  // the user scrolls.
  useLayoutEffect(() => {
    scrollToBottom();
    let frames = 0;
    let steady = 0;
    let was = -1;
    let raf = requestAnimationFrame(function settle() {
      if (!pinnedRef.current || frames++ > SETTLE_FRAMES) return;
      const el = scrollRef.current;
      // Two frames where the bottom hasn't moved means it has stopped
      // moving. Each of these frames costs a layout of the transcript, so
      // running the full count when the tail settled immediately is work
      // for nothing.
      if (el) {
        const height = el.scrollHeight;
        steady = height === was ? steady + 1 : 0;
        was = height;
        if (steady >= 2) return;
      }
      scrollToBottom();
      raf = requestAnimationFrame(settle);
    });
    return () => cancelAnimationFrame(raf);
  }, [scrollToBottom]);

  // Content keeps growing after the render-time scroll (images decode,
  // markdown settles) — while pinned, any growth re-bottoms the view, so a
  // relaunch opens at the latest message instead of partway up.
  const innerObserver = useRef<ResizeObserver | null>(null);
  const observeInner = useCallback(
    (node: HTMLDivElement | null) => {
      innerObserver.current?.disconnect();
      innerObserver.current = null;
      if (!node) return;
      const observer = new ResizeObserver(() => {
        if (pinnedRef.current) scrollToBottom();
      });
      observer.observe(node);
      innerObserver.current = observer;
    },
    [scrollToBottom],
  );

  // The composer floats over the transcript on no background of its own, so
  // the conversation runs behind it instead of stopping at a dead band. Two
  // measurements come off it: --composer-h, the whole dock (the tail's
  // padding and the fade), and --composer-box-h, the textbox alone (the jump
  // pill). The dragons stand taller than the box, so the pill rides the box
  // — it belongs a hair above what you type in, not above the dragons.
  const chatRef = useRef<HTMLElement>(null);
  const dockObserver = useRef<ResizeObserver | null>(null);
  const observeDock = useCallback(
    (node: HTMLDivElement | null) => {
      dockObserver.current?.disconnect();
      dockObserver.current = null;
      if (!node) return;
      const box = node.querySelector<HTMLElement>(".composer-box");
      // What was last written. A custom property set on the pane root
      // invalidates style for every node under it — the whole transcript — so
      // rewriting the same value on every observation is not free, and the
      // observer fires for every frame of a growing composer.
      let wrote = { dock: -1, boxTop: -1 };
      const measure = () => {
        const chat = chatRef.current;
        if (!chat) return;
        const dock = node.offsetHeight;
        // the dock's bottom is the pane's bottom, so this is exactly how far
        // up from the pane's floor the textbox starts
        const boxTop = Math.round(
          box ? node.getBoundingClientRect().bottom - box.getBoundingClientRect().top : dock,
        );
        if (dock === wrote.dock && boxTop === wrote.boxTop) return;
        wrote = { dock, boxTop };
        chat.style.setProperty("--composer-h", `${dock}px`);
        chat.style.setProperty("--composer-box-h", `${boxTop}px`);
      };
      const observer = new ResizeObserver(() => {
        measure();
        // a taller composer eats into the view — re-bottom so the newest
        // message stays put rather than sliding under it
        if (pinnedRef.current) scrollToBottom();
      });
      observer.observe(node);
      // the box grows on its own (a long prompt, an attachment strip) without
      // the dock following, whenever the dragons are still the taller pair
      if (box) observer.observe(box);
      dockObserver.current = observer;
      measure();
    },
    [scrollToBottom],
  );

  // Grouping walks the whole event stream, and the stream is long. It only
  // changes when the events do — not on every keystroke into the composer,
  // every token of a streaming reply, or every scroll that re-measures.
  const allTurns = useMemo(() => groupTurns(transcript), [transcript]);
  const shownTurns = useMemo(
    () => (renderedTurns >= allTurns.length ? allTurns : allTurns.slice(allTurns.length - renderedTurns)),
    [allTurns, renderedTurns],
  );
  // Which halves of which exchanges are open, where that differs from how
  // each starts — open below the newest compaction, folded above it.
  const [opens, setOpens] = useState<Record<string, { prompt?: boolean; reply?: boolean }>>({});
  const [wantHistory, setWantHistory] = useState(false);
  const earlierIds = useMemo(
    () => new Set(earlier.flatMap((item) => (item.kind === "turn" ? [item.turnId] : []))),
    [earlier],
  );
  const needHistory =
    wantHistory ||
    Object.entries(opens).some(([id, open]) => (open.prompt || open.reply) && earlierIds.has(id));
  useEffect(() => {
    if (!history && needHistory) requestHistory(activeId);
  }, [activeId, history, needHistory]);
  // the history's turns by id — a mark's under `compaction-<id>`
  const historyTurns = useMemo(
    () => new Map((history ? groupTurns(history) : []).map((turn) => [turn.turnId, turn])),
    [history],
  );
  /** What was just opened, for the view to go to the top of once it's on screen. */
  const revealRef = useRef<{ turnId: string; half: Half } | null>(null);
  const openHalf = useCallback((turnId: string, half: Half) => {
    // reading back, not following: nothing may re-bottom the view now
    pinnedRef.current = false;
    revealRef.current = { turnId, half };
    setOpens((prev) => ({
      ...prev,
      [turnId]: half === "both" ? { prompt: true, reply: true } : { ...prev[turnId], [half]: true },
    }));
  }, []);
  const foldExchange = useCallback(
    (turnId: string) => setOpens((prev) => ({ ...prev, [turnId]: { prompt: false, reply: false } })),
    [],
  );
  // one half back to its note; the other stays as it is (unset still means
  // how it starts, so a live reply stays open under a folded prompt)
  const foldHalf = useCallback(
    (turnId: string, half: "prompt" | "reply") =>
      setOpens((prev) => ({ ...prev, [turnId]: { ...prev[turnId], [half]: false } })),
    [],
  );
  const loadHistory = useCallback(() => setWantHistory(true), []);

  // Something just opened: the view goes to its top, to read it from the
  // start. Left alone, the view stayed put while the exchange grew — pinned
  // to the bottom it followed the growth to the end, and scrolled up the
  // browser's scroll anchoring held whatever was below in place, which comes
  // to the same thing. An earlier exchange waits here for its events.
  useLayoutEffect(() => {
    const want = revealRef.current;
    const scroller = scrollRef.current;
    if (!want || !scroller) return;
    const turn = scroller.querySelector<HTMLElement>(`[data-turn="${CSS.escape(want.turnId)}"]`);
    if (!turn) {
      revealRef.current = null;
      return;
    }
    const half = turn.querySelector<HTMLElement>(
      `[data-half="${want.half === "reply" ? "reply" : "prompt"}"]`,
    );
    if (!half) return;
    revealRef.current = null;
    // a reply with nothing in it (a stopped turn) has no top of its own
    const target = want.half === "both" || half.childElementCount === 0 ? turn : half;
    scroller.scrollTop +=
      target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - REVEAL_GAP;
  });

  const startRewind = useCallback(
    (event: Extract<TranscriptEvent, { kind: "user" }>) =>
      setRewindTarget({ id: event.id, text: event.text }),
    [],
  );
  const startFork = useCallback(
    (event: Extract<TranscriptEvent, { kind: "user" }>) => {
      send({ type: "fork", projectId: activeId, eventId: event.id });
    },
    [activeId],
  );

  const busy = status === "working" || status === "permission";

  // Rewind works on every harness; what it can undo differs. Claude rides
  // the CLI's file checkpoints and forks the conversation at the prompt;
  // Codex keeps its native conversation but no file checkpoints; other
  // harnesses come back on a brief of what is kept, files untouched.
  const providerRoute = models.find((m) => m.value === (project.model || defaultModel))?.provider;
  const claudeRoute = !providerRoute;
  const canRewind = !isHome && !busy;
  const askRewind = canRewind ? startRewind : undefined;
  // Fork: the branch under the pencil — a new session from this exchange
  // on, no confirmation, since nothing is lost by it. Same footing as
  // rewind: a project's session, while nothing is running.
  const askFork = canRewind ? startFork : undefined;

  // Home keeps no header bar — the transcript starts at the top; the
  // tracker page still auto-opens there and closes from its own X.
  const header = !isHome && (
    <header className="chat-header">
      <div className="chat-id">
        <div className="chat-title">
          {project.name}
          {session?.title && <span className="chat-session-title"> · {session.title}</span>}
        </div>
      </div>
      <div className="header-controls">
        <button
          className={`icon-button ${agentsOpen ? "active" : ""}`}
          title={
            agentsOpen
              ? "Back to the chat"
              : agentsWorking > 0
                ? `Agents — ${agentsWorking} still working; watch one, or start one of your own`
                : "Agents — start one of your own, and see every one this chat has started"
          }
          onClick={() => {
            if (agentsOpen) closeAgent();
            else {
              setPage("chat");
              openAgent(activeId);
            }
          }}
        >
          <Icon d={TOOL_ICONS["agent"]!} />
          {agentsWorking > 0 && <span className="tracker-badge">{agentsWorking}</span>}
        </button>
        <button
          className={`icon-button ${page === "skills" ? "active" : ""}`}
          title="Skills — what this project and this machine load before working"
          onClick={() => setPage(page === "skills" ? "chat" : "skills")}
        >
          {/* a puzzle piece: what a skill is — a part that fits onto the
              model, installed and taken out as one piece */}
          <Icon d="M4 7.5A1.5 1.5 0 0 1 5.5 6H9a2.2 2.2 0 1 1 4 0h3.5A1.5 1.5 0 0 1 18 7.5V11a2.2 2.2 0 1 1 0 4v3.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5z" />
        </button>
        <button
          className={`icon-button comp-toggle ${page === "components" ? "active" : ""}`}
          title="Components — your names for the parts of this project"
          onClick={() => setPage(page === "components" ? "chat" : "components")}
        >
          <Icon d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z" />
          {freshComponents > 0 && (
            <span className="comp-star just header" aria-label="new components" ref={spinStar}>
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M12 2.5l2.7 6.1 6.6.7-4.9 4.5 1.4 6.5L12 17l-5.8 3.3 1.4-6.5L2.7 9.3l6.6-.7z" />
              </svg>
            </span>
          )}
        </button>
        <button
          className={`icon-button ${page === "ideas" ? "active" : ""}`}
          title="Ideas — the board of things you want out of this project"
          onClick={() => setPage(page === "ideas" ? "chat" : "ideas")}
        >
          <Icon d="M9 18h6M10 21h4M12 3a6 6 0 0 1 4 10.5c-.6.6-1 1.4-1 2.2v.3H9v-.3c0-.8-.4-1.6-1-2.2A6 6 0 0 1 12 3z" />
          {ideaCount > 0 && <span className="tracker-badge">{ideaCount}</span>}
        </button>
        <button
          className={`icon-button tracker-toggle ${page === "tracker" ? "active" : ""}`}
          title={page === "tracker" ? "Back to the chat" : "Feature tracker — things to test by hand"}
          onClick={() => setPage(page === "tracker" ? "chat" : "tracker")}
        >
          <Icon d="M9 11l3 3 8-8M21 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11" />
          {openCount > 0 && <span className="tracker-badge">{openCount}</span>}
        </button>
      </div>
    </header>
  );

  // The pad, wherever it was opened from — over a fresh session's hero as
  // much as over a conversation.
  if (sketch) {
    return (
      <main className={pane("chat")}>
        {header}
        <Sketch
          channelId={activeId}
          {...(sketch.background ? { background: sketch.background } : {})}
          onClose={() => setSketch(null)}
        />
      </main>
    );
  }

  // Home's other page: every open project, the agent's chat put away.
  if (homeTabs && homeTab === "projects") {
    return (
      <main className={pane("chat home-projects")}>
        {homeTabs}
        <ProjectsPage />
      </main>
    );
  }

  // The agents page takes the whole pane, the way the project's other pages do.
  if (agentsOpen) {
    return (
      <main className={pane("chat")}>
        {header}
        <AgentsPage channelId={activeId} project={project} agents={agents} />
      </main>
    );
  }

  // No conversation yet (Home or a fresh project): the hero — face, a big
  // title, and the composer front and center.
  if (transcript.length === 0 && !draft && permissions.length === 0) {
    return (
      <main className={pane("chat home-hero")}>
        {lastError && (
          <div className="error-bar" onClick={dismissError}>
            {lastError} <span className="dismiss">dismiss</span>
          </div>
        )}
        {/* a project chat's header — the agents, skills and boards — is
            there before its first prompt too; Home has none */}
        {header}
        {/* the strip that swaps Home's two pages floats over the top, so
            the face stays centred in the pane */}
        {homeTabs}
        <div className="hero">
          <HeroFace n={isHome ? launchHero : heroFor(boardId ?? activeId)} />
          <div className="hero-title">{isHome ? "sup." : (session?.title ?? project.name)}</div>
          <div className="hero-composer">
            {rapid?.on && <RapidBar rapid={rapid} />}
            <Composer
              channelId={activeId}
              project={project}
              busy={busy}
              onSketch={openSketch}
              {...(rapid?.on ? { onSent: () => rapid.advance("sent") } : {})}
            />
          </div>
        </div>
      </main>
    );
  }

  // A header button swaps the whole pane for that page — no navigation,
  // just this branch; the lit button swaps it back.
  if (page !== "chat") {
    return (
      <main className={pane("chat")}>
        {header}
        {page === "tracker" && <Tracker projectId={activeId} onClose={() => setPage("chat")} />}
        {page === "ideas" && boardId && <Ideas projectId={boardId} channelId={activeId} />}
        {page === "components" && boardId && <Components projectId={boardId} />}
        {page === "skills" && <Skills {...(boardId ? { projectId: boardId } : {})} />}
      </main>
    );
  }

  return (
    <main className={pane("chat")} ref={chatRef}>
      {header}

      {lastError && (
        <div className="error-bar" onClick={dismissError}>
          {lastError} <span className="dismiss">dismiss</span>
        </div>
      )}

      {homeTabs}

      {/* the holder ends where the composer begins, so the jump pill always
          floats just above the composer no matter how tall it grows */}
      <div className="transcript-holder">
        <div
          className="transcript"
          ref={scrollRef}
          onScroll={onScroll}
          onWheel={noteGesture}
          onTouchMove={noteGesture}
          onPointerDown={noteGesture}
          onKeyDown={noteGesture}
        >
          <div className="transcript-inner" ref={observeInner}>
            {/* the earlier exchanges wait for every live turn below them to
              be laid out — until then the tail is what's on screen */}
            {shownTurns.length === allTurns.length &&
              earlier.map((item) => {
                if (item.kind === "compaction") {
                  const full = historyTurns.get(`compaction-${item.id}`)?.events[0];
                  return (
                    <div className="turn" key={`earlier-${item.id}`}>
                      <CompactionMark
                        event={
                          full?.kind === "compaction"
                            ? full
                            : { kind: "compaction", id: item.id, text: "", ts: item.ts }
                        }
                        load={loadHistory}
                      />
                    </div>
                  );
                }
                const open = opens[item.turnId];
                const promptOpen = open?.prompt ?? false;
                const replyOpen = open?.reply ?? false;
                return (
                  <Exchange
                    key={`earlier-${item.turnId}`}
                    turnId={item.turnId}
                    events={promptOpen || replyOpen ? historyTurns.get(item.turnId)?.events : undefined}
                    note={summaries[item.turnId]}
                    prompt={item.prompt}
                    reply={item.reply}
                    count={item.count}
                    promptOpen={promptOpen}
                    replyOpen={replyOpen}
                    replyFolds={replyOpen}
                    loading={(promptOpen || replyOpen) && !history}
                    project={project}
                    channelId={activeId}
                    onRewind={askRewind}
                    onFork={askFork}
                    onOpen={openHalf}
                    onFold={foldExchange}
                    onFoldHalf={foldHalf}
                  />
                );
              })}
            {shownTurns.map((turn, index) => {
              const head = turn.events[0];
              // far enough up that the browser may skip laying it out until
              // it comes near the viewport — see .turn.far
              const far = index < shownTurns.length - LIVE_TURNS;
              // a compaction mark, or what came before the first prompt
              if (turn.solo || head?.kind !== "user") {
                return (
                  <div className={far ? "turn far" : "turn"} key={turn.turnId}>
                    {turn.events.map((event) => (
                      <EventView
                        key={event.id}
                        event={event}
                        project={project}
                        channelId={activeId}
                        onRewind={askRewind}
                        onFork={askFork}
                      />
                    ))}
                  </div>
                );
              }
              const open = opens[turn.turnId];
              const promptOpen = open?.prompt ?? true;
              const replyOpen = open?.reply ?? true;
              const cut = promptOpen && replyOpen ? NO_EXCERPTS : turnExcerpts(turn);
              return (
                <Exchange
                  key={turn.turnId}
                  turnId={turn.turnId}
                  events={turn.events}
                  note={summaries[turn.turnId]}
                  prompt={cut.prompt}
                  reply={cut.reply}
                  count={turn.events.length}
                  promptOpen={promptOpen}
                  replyOpen={replyOpen}
                  replyFolds={open?.reply === true}
                  far={far}
                  project={project}
                  channelId={activeId}
                  onRewind={askRewind}
                  onFork={askFork}
                  onOpen={openHalf}
                  onFold={foldExchange}
                  onFoldHalf={foldHalf}
                />
              );
            })}
            {draft && (
              <div className="msg assistant streaming">
                <StreamingMarkdown text={draft.text} />
                <span className="cursor" ref={beat("blink")} />
              </div>
            )}
            {status === "working" && (
              <div className="working">
                {!draft && <Thinking />}
                {turn && <WorkingLine turn={turn} effort={project.effort || DEFAULT_EFFORT} />}
              </div>
            )}
            {/* neither a question nor a naming is an allow/deny — each gets
              its own card, and only a real tool call gets allow/deny */}
            {permissions.map((request) => (
              <AskCard key={request.requestId} request={request} />
            ))}
            {queuedItems.length > 0 && (
              <QueuedList projectId={activeId} items={queuedItems} held={queueHeld} />
            )}
            {queueHeld && queuedItems.length > 0 && (
              <div className="queue-standby">
                <span>
                  {queuedItems.length === 1 ? "1 prompt" : `${queuedItems.length} prompts`} held by the stop —
                  they go out after your next one
                </span>
                <button
                  className="ghost"
                  title="Send what is waiting, now, in the order it was written"
                  onClick={() => send({ type: "queue_send", projectId: activeId })}
                >
                  Send now
                </button>
              </div>
            )}
          </div>
        </div>

        <SelectionFlags scrollerRef={scrollRef} />

        {showJump && (
          <button className="jump-latest" onClick={() => scrollToBottom("smooth")}>
            <Icon d="M12 5v14M5 12l7 7 7-7" /> Latest
          </button>
        )}
        {rapid?.on && <RapidBar rapid={rapid} floating />}
        <BridgeStrip channelId={activeId} stacked={rapid?.on} />
      </div>

      {rewindTarget && (
        <div className="confirm-overlay" onClick={() => setRewindTarget(null)}>
          <div
            className="confirm-card"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setRewindTarget(null);
            }}
          >
            <div className="confirm-title">Rewind to this prompt</div>
            <div className="confirm-quote">
              {rewindTarget.text.length > 240
                ? `${rewindTarget.text.slice(0, 240).trimEnd()}…`
                : rewindTarget.text}
            </div>
            <div className="confirm-body">
              {claudeRoute
                ? "The conversation and the project's files go back to the moment before this prompt ran — everything after it is discarded. The prompt itself lands in the composer, so you can edit it there and send when you're ready."
                : providerRoute === "codex"
                  ? "The native Codex conversation goes back to the moment before this prompt ran — everything after it is discarded. The project's files return from ruri's checkpoint when available; if none was captured, the reply says so. The prompt itself lands in the composer, so you can edit it there and send when you're ready."
                  : "The conversation goes back to the moment before this prompt ran — everything after it is discarded, and the harness starts again from a brief of what's kept. The project's files return from ruri's checkpoint when available; if none was captured, the reply says so. The prompt itself lands in the composer, so you can edit it there and send when you're ready."}
            </div>
            <div className="confirm-actions">
              <button className="ghost" onClick={() => setRewindTarget(null)}>
                Cancel
              </button>
              <button
                className="primary"
                autoFocus
                onClick={() => {
                  send({ type: "rewind", projectId: activeId, eventId: rewindTarget.id });
                  setRewindTarget(null);
                }}
              >
                Rewind
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="composer-dock" ref={observeDock}>
        <Composer
          channelId={activeId}
          project={project}
          busy={busy}
          onSketch={openSketch}
          {...(rapid?.on ? { onSent: () => rapid.advance("sent") } : {})}
        />
      </div>
    </main>
  );
}
