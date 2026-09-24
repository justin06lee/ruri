import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Project, SubagentState, TranscriptEvent } from "../../../shared/protocol";
import { markFor } from "../lib/marks";
import { roughName } from "../lib/models";
import { Markdown } from "../markdown";
import {
  agentLogKey,
  backAgent,
  closeAgent,
  composeInto,
  refreshAgentLog,
  sendAgent,
  startAgent,
  stopAgent,
  useRuri,
} from "../store";
import { AgentCard, AgentHead, AgentHost, AgentMeta } from "./chat/AgentCard";

/** How often a running script's page reads its output again. */
const SCRIPT_REFRESH_MS = 2000;

/** "3 agents · 1 script" — what the chat has, in words. */
function tally(agents: SubagentState[]): string {
  const scripts = agents.filter((a) => a.script).length;
  const others = agents.length - scripts;
  return [
    others > 0 ? `${others} agent${others === 1 ? "" : "s"}` : undefined,
    scripts > 0 ? `${scripts} script${scripts === 1 ? "" : "s"}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}
import { Icon, TOOL_ICONS } from "./chat/Icon";
import { Dropdown } from "./Dropdown";
import { EventView } from "./EventView";
import { ModelIcon } from "./Marks";
import { AskCard } from "./PermissionBanner";
import { Thinking } from "./Thinking";

type Ruri = ReturnType<typeof useRuri.getState>;

/** An agent's card as it stands: in the chat, among the ones you started,
 *  or — an agent's own agent — in the log of the one that started it. */
function findAgent(s: Ruri, channelId: string, key: string): SubagentState | undefined {
  const hit = (events: TranscriptEvent[] | undefined) =>
    events?.find(
      (e): e is Extract<TranscriptEvent, { kind: "tool" }> => e.kind === "tool" && e.agent?.key === key,
    )?.agent;
  const found = hit(s.transcripts[channelId]) ?? s.crew[channelId]?.find((a) => a.key === key);
  if (found) return found;
  for (const [id, events] of Object.entries(s.agentLogs)) {
    if (!id.startsWith(`${channelId}\u0000`)) continue;
    const nested = hit(events);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * The agents page, in place of the chat as the project's other pages are:
 * every agent the chat has — the ones the model started and the ones you
 * did — and every script the model left running in the background; or,
 * with one picked, that agent's own conversation: the brief it was handed,
 * what it said, every tool it ran, live while it works (a script's page is
 * its command and what it has printed). It is also where you start agents
 * of your own: a brief and a model, and it goes off to work in the project
 * by itself, reporting back here. Esc steps out — from an agent to the
 * list, from the list to the chat.
 */
export function AgentsPage({
  channelId,
  project,
  agents,
}: {
  channelId: string;
  project: Project;
  agents: SubagentState[];
}) {
  const key = useRuri((s) => (s.agentPanel?.projectId === channelId ? s.agentPanel.keys.at(-1) : undefined));
  const depth = useRuri((s) => (s.agentPanel?.projectId === channelId ? s.agentPanel.keys.length : 0));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // typing, or a menu that Esc closes first
      if ((e.target as HTMLElement | null)?.closest("textarea, input, [contenteditable], .dropdown")) return;
      if (useRuri.getState().agentPanel?.keys.length) backAgent();
      else closeAgent();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return key ? (
    <AgentView key={key} channelId={channelId} project={project} agentKey={key} depth={depth} />
  ) : (
    <AgentList channelId={channelId} project={project} agents={agents} />
  );
}

/** Every agent in the chat, the working ones first — under the box that
 *  starts one of your own. */
function AgentList({
  channelId,
  project,
  agents,
}: {
  channelId: string;
  project: Project;
  agents: SubagentState[];
}) {
  // what your own agents are waiting on you for
  const asks = useRuri((s) => s.permissions).filter((p) => p.projectId === channelId && p.agent);
  const working = agents.filter((a) => a.status === "running");
  const finished = agents.filter((a) => a.status !== "running");
  return (
    <section className="board-page agents-page">
      <div className="board-inner">
        <div className="board-head">
          <span className="board-title">Agents</span>
          <span className="board-sub">
            {agents.length === 0
              ? "none in this chat yet"
              : `${tally(agents)} in this chat${working.length > 0 ? ` · ${working.length} at work` : ""}`}
          </span>
          <button className="icon-button" title="Back to the chat (Esc)" onClick={closeAgent}>
            <Icon d="M18 6L6 18M6 6l12 12" />
          </button>
        </div>
        <AgentBrief channelId={channelId} project={project} />
        {asks.length > 0 && (
          <div className="agents-asks">
            {asks.map((request) => (
              <AskCard key={request.requestId} request={request} />
            ))}
          </div>
        )}
        <AgentHost.Provider value="page">
          {working.length > 0 && <div className="agents-group">working</div>}
          {working.map((a) => (
            <AgentCard key={a.key} agent={a} channelId={channelId} />
          ))}
          {finished.length > 0 && <div className="agents-group">finished</div>}
          {finished.map((a) => (
            <AgentCard key={a.key} agent={a} channelId={channelId} />
          ))}
        </AgentHost.Provider>
        {agents.length === 0 && (
          <div className="board-empty">
            The agents the model starts show up here as it starts them, and so do the scripts it leaves
            running in the background. Brief one of your own above and it goes off to work in {project.name}{" "}
            by itself — you can watch it here, tell it more, or stop it.
          </div>
        )}
      </div>
    </section>
  );
}

/** Where an agent of your own starts: its brief, and the model it runs on
 *  — the chat's, unless you pick another from the composer's list. */
function AgentBrief({ channelId, project }: { channelId: string; project: Project }) {
  const allModels = useRuri((s) => s.models);
  const starredIds = useRuri((s) => s.starredModels);
  const defaultModel = useRuri((s) => s.defaultModel);
  const [text, setText] = useState("");
  const [model, setModel] = useState(() => project.model || defaultModel);
  const starred = allModels.filter((m) => starredIds.includes(m.value));
  const options = (starred.length > 0 ? starred : allModels).map((m) => ({
    value: m.value,
    label: m.displayName,
    icon: <ModelIcon pick={markFor(m.value, m)} />,
  }));
  if (!options.some((o) => o.value === model)) {
    const choice = allModels.find((m) => m.value === model);
    options.push({
      value: model,
      label: choice?.displayName ?? roughName(model),
      icon: <ModelIcon pick={markFor(model, choice)} />,
    });
  }
  const start = () => {
    const brief = text.trim();
    if (!brief) return;
    startAgent(channelId, brief, model);
    setText("");
  };
  return (
    <div className="agent-brief">
      <textarea
        rows={3}
        value={text}
        placeholder={`Brief an agent of your own — it works in ${project.name} by itself and reports back here`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            start();
          }
        }}
      />
      <div className="agent-brief-bar">
        <Dropdown
          value={model}
          options={options}
          onSelect={setModel}
          title="The model it runs on — this chat's, unless you pick another"
        />
        <span className="agent-brief-hint">Enter to start · Shift+Enter for a new line</span>
        <button className="primary" disabled={!text.trim()} onClick={start}>
          Start
        </button>
      </div>
    </div>
  );
}

/** One agent's own conversation, the whole page: the brief it was handed,
 *  everything it said and ran, live while it works — and, for one of your
 *  own, a line to tell it more or stop it. */
function AgentView({
  channelId,
  project,
  agentKey,
  depth,
}: {
  channelId: string;
  project: Project;
  agentKey: string;
  depth: number;
}) {
  const log = useRuri((s) => s.agentLogs[agentLogKey(channelId, agentKey)]);
  const agent = useRuri((s) => findAgent(s, channelId, agentKey));
  const asks = useRuri((s) => s.permissions).filter((p) => p.projectId === channelId && p.agent === agentKey);
  const bodyRef = useRef<HTMLDivElement>(null);
  // at the newest thing the agent did, for as long as you stay down there
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body && pinned.current) body.scrollTop = body.scrollHeight;
  }, [log, agent?.status, asks.length]);
  // a script's output is a file, read when asked: asked again while it
  // runs, and once more as it ends, for the last of it
  const script = agent?.script === true;
  const running = agent?.status === "running";
  useEffect(() => {
    if (!script) return;
    if (!running) {
      refreshAgentLog(channelId, agentKey);
      return;
    }
    const timer = setInterval(() => refreshAgentLog(channelId, agentKey), SCRIPT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [script, running, channelId, agentKey]);
  // its report, when it said more than its last message did
  const said = log && [...log].reverse().find((e) => e.kind === "assistant");
  const report =
    agent?.result &&
    agent.status !== "running" &&
    (said?.kind !== "assistant" || said.text.trim() !== agent.result.trim())
      ? agent.result
      : undefined;
  const handed = agent?.status !== "running" && !agent?.script ? agent?.result : undefined;
  return (
    <section className="agents-page agent-view">
      <div className="agent-view-top">
        <div className="board-head agent-view-head">
          <button
            className="icon-button"
            title={depth > 1 ? "Back to the agent under this one (Esc)" : "Every agent in this chat (Esc)"}
            onClick={backAgent}
          >
            <Icon d="M15 18l-6-6 6-6" />
          </button>
          <div className="agent-view-title">
            {agent ? (
              <>
                <AgentHead agent={agent} />
                <AgentMeta agent={agent} />
              </>
            ) : (
              <span className="agent-head">
                <Icon d={TOOL_ICONS["agent"]!} />
                <span className="agent-type">Agent</span>
              </span>
            )}
          </div>
          {handed && (
            <button
              className="ghost agent-hand"
              title="Put what it came back with in this chat's composer"
              onClick={() => {
                composeInto(channelId, handed);
                closeAgent();
              }}
            >
              Put in the composer
            </button>
          )}
          <button className="icon-button" title="Back to the chat" onClick={closeAgent}>
            <Icon d="M18 6L6 18M6 6l12 12" />
          </button>
        </div>
      </div>
      <div
        className="agent-view-body"
        ref={bodyRef}
        onScroll={(e) => {
          const body = e.currentTarget;
          pinned.current = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
        }}
      >
        <div className="agent-view-inner">
          <AgentHost.Provider value="page">
            {log && log.length > 0 ? (
              log.map((event) => (
                <EventView key={event.id} event={event} project={project} channelId={channelId} />
              ))
            ) : (
              <div className="board-empty">{log ? "nothing was kept of what this one did" : "opening…"}</div>
            )}
            {report && (
              <div className="agent-report">
                <div className="agent-report-label">
                  {agent?.script ? "how it ended" : "what it came back with"}
                </div>
                <Markdown text={report} />
              </div>
            )}
            {asks.map((request) => (
              <AskCard key={request.requestId} request={request} />
            ))}
            {agent?.status === "running" && (
              <div className="agent-live">
                <Thinking />
                <span className="agent-live-line">
                  {agent.script ? "running…" : agent.activity ? `${agent.activity}…` : "working…"}
                </span>
              </div>
            )}
          </AgentHost.Provider>
        </div>
      </div>
      {agent?.mine && <AgentReply channelId={channelId} agent={agent} />}
    </section>
  );
}

/** The line under one of your own agents: more to do once it is done, or
 *  a stop while it works. */
function AgentReply({ channelId, agent }: { channelId: string; agent: SubagentState }) {
  const [text, setText] = useState("");
  const running = agent.status === "running";
  const go = () => {
    const more = text.trim();
    if (!more || running) return;
    sendAgent(channelId, agent.key, more);
    setText("");
  };
  return (
    <div className="agent-reply">
      <div className="agent-reply-box">
        <textarea
          rows={2}
          value={text}
          placeholder={
            running
              ? "It's working — tell it more once it's done"
              : "Tell it more — it picks up where it left off"
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              go();
            }
          }}
        />
        {running ? (
          <button className="stop" title="Stop this agent" onClick={() => stopAgent(channelId, agent.key)}>
            <svg className="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        ) : (
          <button className="send" title="Send (Enter)" onClick={go} disabled={!text.trim()}>
            <Icon d="M12 19V5M5 12l7-7 7 7" />
          </button>
        )}
      </div>
    </div>
  );
}
