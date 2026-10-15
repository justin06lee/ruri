import { useEffect, useState, type MouseEvent } from "react";
import type {
  MemberState,
  Project,
  RecentSession,
  TeamAction,
  TeamLetter,
  TeamLiaison,
  TeamMember,
} from "../../../shared/protocol";
import { useNow } from "../lib/beat";
import { roughName } from "../lib/models";
import { askTeam, send, teamAction, useRuri } from "../store";
import { Icon } from "./chat/Icon";
import { useConfirm } from "./Confirm";

/**
 * The team page: who works behind a project's lead (server/team.ts).
 *
 * The user mostly talks to the lead — the sidebar has one row a project,
 * and it opens the lead — and the lead hands every job to its team: chats
 * of their own, one a layer of the stack, made as the work calls for them
 * and asleep between jobs. Other projects' agents never reach the lead:
 * they write to its liaison, a second lead that hands their jobs to the
 * same team. This is where the user sees them: what each teammate is for,
 * whether it is working, asleep or waiting on an answer, how full its
 * context is and what it last said; what the liaison is doing, answering
 * and waiting on; the layers no teammate holds yet; and how many are at
 * work across ruri. Every card opens that chat in the pane, to read it
 * and talk to its agent directly; its header leads back to the lead. And
 * the user can do to a teammate what the lead can: stop its turn, compact
 * it, restart it, refresh it, retire it.
 */

const STATE_WORD: Record<MemberState, string> = {
  asleep: "asleep",
  idle: "just finished",
  working: "working",
  waiting: "waiting on an answer",
  // only ever with RURI_TEAM_MAX set
  queued: "waiting for a slot",
  permission: "waiting on you",
};

/** Its turn is running: at work, holding on an answer, or at a card. */
function busy(state: MemberState): boolean {
  return state === "working" || state === "waiting" || state === "permission";
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
    action: "stop",
    label: "Stop",
    title:
      "End the turn it is on and send it nothing new. Its conversation is kept, and it waits for the next message",
  },
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
    action: "refresh",
    label: "Refresh",
    title:
      "Start it on a fresh session with only its name, duty and layers — its conversation is thrown away",
    ask: "Its conversation is thrown away, and it starts fresh with only its name, duty and layers. What it learned that mattered is in the project's memory.",
  },
  {
    action: "retire",
    label: "Retire",
    title: "Take it off the team for good",
    ask: "It leaves the team, and its conversation is deleted. The lead can add a new one whenever it needs to.",
  },
];

/** A click on a card opens its chat — anywhere on it but its buttons, and
 *  not while text in it is being selected. A confirm card brought up from
 *  one of its buttons sits elsewhere in the page (a portal) but its clicks
 *  still bubble here through React, so only the card's own DOM counts. */
function openOnClick(id: string) {
  return (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (!e.currentTarget.contains(target) || target.closest("button")) return;
    if (window.getSelection()?.toString()) return;
    useRuri.getState().setActive(id);
  };
}

/** The card's name: a button that opens its chat, and a note when that
 *  chat is the one the page was opened from. */
function SeatName({ id, name }: { id: string; name: string }) {
  const here = useRuri((s) => s.activeId === id);
  return (
    <>
      <button
        className="team-member-name"
        title={here ? "This chat" : "Open its chat — read it, and talk to it"}
        onClick={() => useRuri.getState().setActive(id)}
      >
        {name}
      </button>
      {here && <span className="team-here">this chat</span>}
    </>
  );
}

/** A model by its name, as the composer's picker says it. */
function useModelName(model: string): string {
  return useRuri((s) => s.models.find((m) => m.value === model)?.displayName) ?? roughName(model);
}

/** How full its context is, how much it has done, and when it last did. */
function SeatMeta({
  seat,
  now,
}: {
  seat: Pick<TeamMember, "context" | "exchanges" | "lastActive">;
  now: number;
}) {
  const usage = seat.context
    ? Math.round((seat.context.tokens / Math.max(1, seat.context.window)) * 100)
    : undefined;
  return (
    <span className="team-member-meta">
      {usage !== undefined && (
        <span
          title={`${seat.context!.tokens.toLocaleString()} of ${seat.context!.window.toLocaleString()} tokens`}
        >
          context {usage}%
        </span>
      )}
      <span>
        {seat.exchanges} exchange{seat.exchanges === 1 ? "" : "s"}
      </span>
      {seat.lastActive ? (
        <span>worked {ago(seat.lastActive, now)}</span>
      ) : (
        seat.exchanges === 0 && <span>not worked yet</span>
      )}
    </span>
  );
}

function MemberCard({ member, now }: { member: TeamMember; now: number }) {
  const { confirm: ask, card } = useConfirm();
  const model = useModelName(member.model);
  const atWork = busy(member.state);
  return (
    <div className={`team-member state-${member.state}`} onClick={openOnClick(member.id)}>
      <div className="team-member-head">
        <SeatName id={member.id} name={member.name || "untitled"} />
        <span
          className={`team-state ${member.state}`}
          title={
            member.state === "queued"
              ? "As many teammates as RURI_TEAM_MAX allows are at work across ruri: it starts when one finishes"
              : undefined
          }
        >
          {STATE_WORD[member.state]}
        </span>
        <SeatMeta seat={member} now={now} />
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
            // only a running turn can be stopped
            disabled={action === "stop" && !atWork}
            onClick={() => {
              if (!why) {
                teamAction(member.id, action);
                return;
              }
              void ask({
                title: `${label} ${member.name || "this teammate"}?`,
                body: atWork ? `It is at work — that stops. ${why}` : why,
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

/** Messages the liaison has in flight one way: whose, since when, and how
 *  each starts. */
function Letters({ label, letters, now }: { label: string; letters: TeamLetter[]; now: number }) {
  if (letters.length === 0) return null;
  return (
    <div className="team-letters">
      <span className="team-letters-label">{label}</span>
      <div className="team-letters-list">
        {letters.map((letter) => (
          <div key={`${letter.who}-${letter.ts}`} className="team-letter" title={letter.text}>
            <b>{letter.who}</b>
            <span className="team-letter-when">{ago(letter.ts, now)}</span>
            {letter.text && <span className="team-letter-text">“{letter.text}”</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The liaison, set apart from the team it hands other projects' jobs to:
 *  a lead, not a teammate, so nothing here acts on it — but its chat opens
 *  like a teammate's. */
function LiaisonCard({ liaison, now }: { liaison: TeamLiaison; now: number }) {
  const model = useModelName(liaison.model);
  return (
    <div className={`team-member team-liaison state-${liaison.state}`} onClick={openOnClick(liaison.id)}>
      <div className="team-member-head">
        <SeatName id={liaison.id} name="Liaison" />
        <span className={`team-state ${liaison.state}`}>{STATE_WORD[liaison.state]}</span>
        <SeatMeta seat={liaison} now={now} />
      </div>
      <div className="team-member-duty">
        Other projects’ agents reach it, never the lead, and it hands their jobs to this team.
      </div>
      {busy(liaison.state) ? (
        <div className="team-liaison-doing">{liaison.doing}</div>
      ) : (
        liaison.lastWords && <div className="team-member-words">“{liaison.lastWords}”</div>
      )}
      <Letters label="answering" letters={liaison.answering} now={now} />
      <Letters label="waiting on" letters={liaison.waitingOn} now={now} />
      <div className="team-member-actions">
        <span className="team-member-model">{model}</span>
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
  const asleep = members.every((m) => m.state === "asleep");
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
                : `${members.length} behind the lead${atWork > 0 ? ` · ${atWork} at work` : asleep ? " · all asleep" : ""}`}
          </span>
          <button className="icon-button" title="Back to the chat" onClick={onClose}>
            <Icon d="M18 6L6 18M6 6l12 12" />
          </button>
        </div>
        {budget && (
          <div className="team-budget">
            <span>
              {budget.atWork === 0 ? "no" : budget.atWork} teammate{budget.atWork === 1 ? "" : "s"} at work
              across ruri
            </span>
            {budget.cap !== undefined && (
              <span>
                at most <b>{budget.cap}</b> at once (RURI_TEAM_MAX)
                {budget.waiting.length > 0 ? ` · ${budget.waiting.length} waiting for a slot` : ""}
              </span>
            )}
          </div>
        )}
        {team?.liaison ? (
          <LiaisonCard liaison={team.liaison} now={now} />
        ) : (
          team !== undefined && (
            <div className="team-liaison-none">
              no liaison yet — the first agent from another project to write here makes one
            </div>
          )
        )}
        {members.map((member) => (
          <MemberCard key={member.id} member={member} now={now} />
        ))}
        {team !== undefined && members.length === 0 && (
          <div className="board-empty">
            You talk to the lead; the lead hands every job to its team — chats of their own, each looking
            after a layer or a part of {project.name}, asleep between jobs. It makes them as the work calls
            for them: just give it work.
          </div>
        )}
        {team !== undefined && team.freeLayers.length > 0 && (
          <div className="team-free">
            <span>no teammate yet</span>
            {team.freeLayers.map((layer) => (
              <span
                key={layer.slug}
                className="team-layer"
                title={`${layer.name} — the lead makes a teammate for it the first time a job there comes up`}
              >
                {layer.slug}
              </span>
            ))}
          </div>
        )}
        <OutsideChats project={project} />
      </div>
    </section>
  );
}
