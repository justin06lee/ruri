import { createContext, useContext } from "react";
import { excerpt, unmarked, type SubagentState } from "../../../../shared/protocol";
import { beat, useNow } from "../../lib/beat";
import { openAgent, useRuri } from "../../store";
import { Icon, TOOL_ICONS } from "./Icon";

/** Where an agent card sits: in the chat it opens as the agents page's
 *  only agent; on the page it opens on top of the one showing. */
export const AgentHost = createContext<"chat" | "page">("chat");

const AGENT_STATUS: Record<SubagentState["status"], string> = {
  running: "working",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

/** A script's, which runs rather than works. */
const SCRIPT_STATUS: Record<SubagentState["status"], string> = { ...AGENT_STATUS, running: "running" };

/** How a script ended, from the harness's sentence about it: the exit
 *  code is the part worth reading ("… completed (exit code 0)"). */
function scriptEnd(result: string): string {
  const code = /exit code (-?\d+)/.exec(result)?.[1];
  return code === undefined ? result : `exit code ${code}`;
}

function tokenCount(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n);
}

function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The numbers under an agent: tools run, tokens spent, for how long, and
 *  whether it was left working in the background. Its clock ticks only
 *  while it runs and ruri is in front. */
export function AgentMeta({ agent }: { agent: SubagentState }) {
  const now = useNow(1000, agent.status === "running");
  // the model by its own name, when the catalog knows it
  const model = useRuri((s) =>
    agent.model ? (s.models.find((m) => m.value === agent.model)?.displayName ?? agent.model) : undefined,
  );
  const line = [
    agent.tools ? `${agent.tools} tool${agent.tools === 1 ? "" : "s"}` : undefined,
    agent.tokens ? `${tokenCount(agent.tokens)} tokens` : undefined,
    span((agent.endedAt ?? now) - agent.startedAt),
    agent.background ? "in the background" : undefined,
    agent.resumed ? (agent.resumed === 1 ? "picked back up" : `picked back up ${agent.resumed}×`) : undefined,
    model,
  ]
    .filter(Boolean)
    .join(" · ");
  return <span className="agent-card-meta">{line}</span>;
}

export function AgentHead({ agent }: { agent: SubagentState }) {
  return (
    <span className="agent-head">
      <Icon d={TOOL_ICONS[agent.script ? "terminal" : "agent"]!} />
      <span className="agent-type">
        {agent.script ? "script" : (agent.type ?? (agent.mine ? "yours" : "Agent"))}
      </span>
      <span className="agent-desc">{agent.description}</span>
      <span
        className={`agent-status ${agent.status}`}
        ref={agent.status === "running" ? beat("spin") : undefined}
      >
        {(agent.script ? SCRIPT_STATUS : AGENT_STATUS)[agent.status]}
      </span>
    </span>
  );
}

/**
 * A subagent in the chat: what it was sent to do, what it is doing right
 * now (or what it came back with), and how far it has got. It opens onto
 * its own conversation — the brief, everything it read, ran and said.
 *
 * A script the model left running in the background is one of these too:
 * its command where an agent's doings go, how it exited where an agent's
 * report goes, and it opens onto what it has printed.
 */
export function AgentCard({ agent, channelId }: { agent: SubagentState; channelId?: string }) {
  const host = useContext(AgentHost);
  const line = agent.script
    ? agent.status !== "running" && agent.result
      ? scriptEnd(agent.result)
      : // the command, unless the head already is it (no description given)
        agent.prompt && agent.prompt.trim() !== agent.description.trim()
        ? `$ ${excerpt(agent.prompt, 220)}`
        : undefined
    : agent.status === "running"
      ? agent.activity
      : agent.result
        ? excerpt(unmarked(agent.result), 220)
        : undefined;
  return (
    <button
      className={`agent-card ${agent.status}${agent.script ? " script" : ""}`}
      title={
        agent.script
          ? "Open this script — its command, and everything it has printed"
          : "Open this agent — its brief, everything it did, and what it came back with"
      }
      onClick={() => channelId && openAgent(channelId, agent.key, host === "page")}
    >
      <AgentHead agent={agent} />
      {line && <span className="agent-card-line">{line}</span>}
      <AgentMeta agent={agent} />
    </button>
  );
}
