import { useEffect, useState } from "react";
import type { MemberState, Project, RecentSession, TeamAction, TeamMember } from "../../../shared/protocol";
import { useNow } from "../lib/beat";
import { roughName } from "../lib/models";
import { askTeam, send, teamAction, useRuri } from "../store";
import { Icon } from "./chat/Icon";
import { useConfirm } from "./Confirm";

/**
 * The team page: who works behind a project's lead (server/team.ts).
 *
 * The user talks to the lead and nothing else — the sidebar has one row a
 * project — and the lead hands work to its team: chats of their own, each
 * with a duty, asleep between jobs. This is where the user can see them
 * anyway: what each one is for, whether it is working, asleep or waiting
 * for a slot, how full its context is and what it last said — and the
 * machine's budget, how many may work at once. And do to one what the
 * lead can: compact it, restart it, clear it, retire it. Opened from the
 * lead's header; nothing here is a chat to open.
 */

const STATE_WORD: Record<MemberState, string> = {
  asleep: "asleep",
  idle: "just finished",
  working: "working",
  waiting: "waiting on an answer",
  queued: "waiting for a slot",
  permission: "waiting on you",
};

/** "1.2 GB", "350 MB". */
function bytes(n: number): string {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}

/** "3m ago", "just now". */
function ago(ts: number, now: number): string {
  const mins = Math.round((now - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

const ACTIONS: Array<{ action: TeamAction; label: string; title: string; ask?: string }> = [
  {
    action: "compact",
    label: "Compact",
    title: "Condense its conversation into a brief and go on from that in a fresh session",
  },
  {
    action: "restart",
    label: "Restart",
    title: "Close its process — stopping a turn it is stuck in. Its conversation is kept",
  },
  {
    action: "clear",
    label: "Clear",
    title: "Throw its conversation away and start it fresh, keeping its name, duty and layers",
    ask: "Its conversation is thrown away, and it starts fresh with only its name, duty and layers. What it learned that mattered is in the project's memory.",
  },
  {
    action: "retire",
    label: "Retire",
    title: "Take it off the team for good",
    ask: "It leaves the team, and its conversation is deleted. The lead can add a new one whenever it needs to.",
  },
];

function MemberCard({ member, now }: { member: TeamMember; now: number }) {
  const { confirm: ask, card } = useConfirm();
  // the model by its name, as the composer's picker says it
  const model =
    useRuri((s) => s.models.find((m) => m.value === member.model)?.displayName) ?? roughName(member.model);
  const usage = member.context
    ? Math.round((member.context.tokens / Math.max(1, member.context.window)) * 100)
    : undefined;
  const busy = member.state === "working" || member.state === "waiting" || member.state === "permission";
  return (
    <div className={`team-member state-${member.state}`}>
      <div className="team-member-head">
        <span className="team-member-name">{member.name || "untitled"}</span>
        <span className={`team-state ${member.state}`}>{STATE_WORD[member.state]}</span>
        <span className="team-member-meta">
          {usage !== undefined && (
            <span
              title={`${member.context!.tokens.toLocaleString()} of ${member.context!.window.toLocaleString()} tokens`}
            >
              context {usage}%
            </span>
          )}
          <span>
            {member.exchanges} exchange{member.exchanges === 1 ? "" : "s"}
          </span>
          {member.lastActive ? (
            <span>worked {ago(member.lastActive, now)}</span>
          ) : (
            member.exchanges === 0 && <span>not worked yet</span>
          )}
        </span>
      </div>
      <div className="team-member-duty">{member.duty || "no duty given"}</div>
      {member.layers.length > 0 && (
        <div className="team-member-layers">
          {member.layers.map((layer) => (
            <span key={layer} className="team-layer">
              {layer}
            </span>
          ))}
        </div>
      )}
      {member.lastWords && <div className="team-member-words">“{member.lastWords}”</div>}
      <div className="team-member-actions">
        <span className="team-member-model">{model}</span>
        {card}
        {ACTIONS.map(({ action, label, title, ask: why }) => (
          <button
            key={action}
            className="ghost"
            title={title}
            onClick={() => {
              if (!why) {
                teamAction(member.id, action);
                return;
              }
              void ask({
                title: `${label} ${member.name || "this teammate"}?`,
                body: busy ? `It is at work — that stops. ${why}` : why,
                ok: label,
              }).then((yes) => {
                if (yes) teamAction(member.id, action);
              });
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The chats run outside ruri in this project's folder, brought in as
 *  teammates — the lead hands them the rest of that work. */
function OutsideChats({ project }: { project: Project }) {
  const items = useRuri((s) => s.recent[project.id]);
  const [open, setOpen] = useState(false);
  const toggle = () => {
    if (!open) send({ type: "recent_list", projectId: project.id });
    setOpen(!open);
  };
  return (
    <div className="team-outside">
      <button className={`ghost team-outside-toggle ${open ? "open" : ""}`} onClick={toggle}>
        <Icon d="M9 6l6 6-6 6" />
        chats from outside ruri
      </button>
      {open &&
        (items === undefined ? (
          <div className="recent-note">looking…</div>
        ) : items.length === 0 ? (
          <div className="recent-note">nothing from outside ruri in this folder</div>
        ) : (
          items.map((item: RecentSession) => (
            <div
              key={item.id}
              className="project-row recent-item"
              title={`${item.title}\nBring it in as a teammate — its conversation comes with it`}
              onClick={() => {
                send({ type: "recent_import", projectId: project.id, id: item.id });
                setOpen(false);
              }}
            >
              <span className={`recent-tag ${item.provider}`}>
                {item.provider === "claude" ? "cc" : "cx"}
              </span>
              <span className="project-name">{item.title}</span>
            </div>
          ))
        ))}
    </div>
  );
}

export function TeamPage({ project, onClose }: { project: Project; onClose(): void }) {
  const team = useRuri((s) => s.team[project.id]);
  const now = useNow(30_000);
  useEffect(() => askTeam(project.id), [project.id]);
  const members = team?.members ?? [];
  const budget = team?.budget;
  const atWork = members.filter((m) => m.state === "working" || m.state === "permission").length;
  return (
    <section className="board-page team-page">
      <div className="board-inner">
        <div className="board-head">
          <span className="board-title">Team</span>
          <span className="board-sub">
            {team === undefined
              ? "…"
              : members.length === 0
                ? "the lead has no teammates yet"
                : `${members.length} behind the lead${atWork > 0 ? ` · ${atWork} at work` : " · all asleep"}`}
          </span>
          <button className="icon-button" title="Back to the chat" onClick={onClose}>
            <Icon d="M18 6L6 18M6 6l12 12" />
          </button>
        </div>
        {budget && (
          <div
            className="team-budget"
            title="Each teammate at work holds a harness process of a few hundred MB"
          >
            <span>
              room for <b>{budget.slots}</b> at work at once{budget.slots >= budget.cap ? " (the most)" : ""}
            </span>
            <span>
              {budget.atWork} at work across ruri
              {budget.waiting.length > 0 ? ` · ${budget.waiting.length} waiting` : ""}
            </span>
            <span>
              {bytes(budget.availableBytes)} of {bytes(budget.totalBytes)} free · ~
              {bytes(budget.perAgentBytes)} each
            </span>
          </div>
        )}
        {members.map((member) => (
          <MemberCard key={member.id} member={member} now={now} />
        ))}
        {team !== undefined && members.length === 0 && (
          <div className="board-empty">
            You talk to the lead; the lead hands work to its team — chats of their own, each looking after a
            part of {project.name}, asleep between jobs. It adds them as the work calls for it. Ask it to set
            one up (“make a teammate for the UI”), or just give it work.
          </div>
        )}
        <OutsideChats project={project} />
      </div>
    </section>
  );
}
