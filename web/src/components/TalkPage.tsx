import { useEffect, useState } from "react";
import {
  leadOf,
  type Project,
  type TalkLetter,
  type TalkPolicy,
  type TalkRule,
  type TalkStatus,
} from "../../../shared/protocol";
import { useNow } from "../lib/beat";
import { send, useRuri } from "../store";
import { Capped } from "./Capped";

/**
 * The talk page: which projects your agents may reach.
 *
 * A project's agents — its lead and its team — can message another
 * project's lead, in any open project, and hear back (server/talk.ts);
 * within a project the team talks freely. Here the user says which
 * projects may reach which: one rule for every project, which a
 * project's own rule overrides. Each is "anyone", "only these" projects,
 * or "no one"; a project with no rule of its own goes by everyone's.
 * Opened from a chat's header, it starts on that chat's project. Under
 * the rules, the latest messages between agents and where each has got
 * to.
 */

type Mode = TalkRule["to"] | "inherit";

/** Who a rule is for: every project, or one. */
type Who = { kind: "everyone" } | { kind: "project"; project: Project };

const OPEN: TalkRule = { to: "anyone", projects: [] };

const MODE_WORD: Record<Mode, string> = {
  inherit: "Same as",
  anyone: "Anyone",
  listed: "Only these",
  nobody: "No one",
};

const STATUS_WORD: Record<TalkStatus, string> = {
  asking: "waiting on you",
  denied: "you said no",
  refused: "not allowed",
  queued: "queued",
  working: "being read",
  answered: "answered",
  failed: "failed",
  dropped: "taken out",
};

/** A chat as the talk page names it: its project for a lead, the project
 *  and its name for a member of the team. */
function chatName(projects: Project[], chat: string): string {
  const project = projects.find((p) => p.sessions.some((s) => s.id === chat));
  if (!project) return "a closed chat";
  if (leadOf(project)?.id === chat) return project.name;
  return `${project.name} · ${project.sessions.find((s) => s.id === chat)?.title || "a teammate"}`;
}

/** "3m ago", "just now". */
function ago(ts: number, now: number): string {
  const mins = Math.round((now - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** A rule in a few words. */
function summary(rule: TalkRule, projects: Project[]): string {
  if (rule.to === "anyone") return "anyone";
  if (rule.to === "nobody") return "no one";
  const names = rule.projects.flatMap((id) => projects.find((x) => x.id === id)?.name ?? []);
  if (names.length === 0) return "no one yet";
  return names.length <= 2 ? `only ${names.join(", ")}` : `only ${names.length} picked`;
}

function keyOf(who: Who): string {
  return who.kind === "everyone" ? "everyone" : who.project.id;
}

/** The rule a who has of its own, if any — and the one it goes by. */
function rules(policy: TalkPolicy, who: Who): { own?: TalkRule; parent?: { rule: TalkRule; label: string } } {
  if (who.kind === "everyone") return { own: policy.everyone };
  return { own: policy.projects[who.project.id], parent: { rule: policy.everyone, label: "every project" } };
}

/** A copy of the policy with one who's rule set — or taken away. */
function withRule(policy: TalkPolicy, who: Who, rule: TalkRule | undefined): TalkPolicy {
  if (who.kind === "everyone") return { ...policy, everyone: rule ?? OPEN };
  const projects = { ...policy.projects };
  if (rule) projects[who.project.id] = rule;
  else delete projects[who.project.id];
  return { ...policy, projects };
}

/** Set the limits: here at once, then on the server, which says so back. */
function save(policy: TalkPolicy): void {
  const talk = useRuri.getState().talk;
  if (talk) useRuri.setState({ talk: { ...talk, policy } });
  send({ type: "talk_set", policy });
}

export function TalkPage({ channelId }: { channelId: string }) {
  const talk = useRuri((s) => s.talk);
  const projects = useRuri((s) => s.projects);
  const [picked, setPicked] = useState(
    () => projects.find((p) => p.sessions.some((x) => x.id === channelId))?.id ?? "everyone",
  );
  const now = useNow(30_000);
  useEffect(() => {
    send({ type: "talk_get" });
  }, []);

  const whos: Who[] = [
    { kind: "everyone" },
    ...projects.map((project) => ({ kind: "project" as const, project })),
  ];
  const who = whos.find((w) => keyOf(w) === picked) ?? whos[0]!;
  const here = projects.find((p) => p.sessions.some((x) => x.id === channelId))?.id;

  if (!talk) {
    return (
      <section className="board-page">
        <div className="board-inner">
          <p className="board-empty">reading…</p>
        </div>
      </section>
    );
  }
  const { policy, letters } = talk;
  const { own, parent } = rules(policy, who);
  const mode: Mode = own?.to ?? "inherit";
  const shown = own ?? parent?.rule ?? OPEN;
  const setMode = (next: Mode) => {
    if (next === mode) return;
    if (next === "inherit") save(withRule(policy, who, undefined));
    else
      save(
        withRule(policy, who, {
          to: next,
          // "only these" starts from whatever list it was going by
          projects: next === "listed" && shown.to === "listed" ? shown.projects : [],
        }),
      );
  };
  const toggle = (id: string) => {
    if (!own || own.to !== "listed") return;
    const list = own.projects.includes(id) ? own.projects.filter((x) => x !== id) : [...own.projects, id];
    save(withRule(policy, who, { ...own, projects: list }));
  };

  const label = who.kind === "everyone" ? "Every project" : who.project.name;
  const self = who.kind === "project" ? who.project.id : undefined;

  return (
    <section className="board-page talk-page">
      <div className="board-inner">
        <div className="board-head">
          <span className="board-title">Talk</span>
          <span className="board-sub">which projects your agents may reach</span>
        </div>
        <p className="talk-note">
          A project&rsquo;s agents — its lead and its team — can message another project&rsquo;s lead, in any
          open project, and hear back; a team always talks among itself. In Bypass a message goes on its own;
          in any other mode each waits for you on a card in its project&rsquo;s chat. A project with no rule
          of its own goes by every project&rsquo;s.
        </p>

        <div className="talk-grid">
          <div className="talk-whos" role="listbox" aria-label="Whose rule">
            {whos.map((w) => {
              const key = keyOf(w);
              const r = rules(policy, w);
              return (
                <button
                  key={key}
                  role="option"
                  aria-selected={key === keyOf(who)}
                  className={`talk-who kind-${w.kind} ${key === keyOf(who) ? "active" : ""} ${r.own ? "own" : ""}`}
                  onClick={() => setPicked(key)}
                >
                  <span className="talk-who-name">
                    {w.kind === "everyone" ? "Every project" : w.project.name}
                    {w.kind === "project" && w.project.id === here && (
                      <span className="talk-this"> · this project</span>
                    )}
                  </span>
                  <span className="talk-who-rule">{r.own ? summary(r.own, projects) : "as above"}</span>
                </button>
              );
            })}
          </div>

          <div className="talk-rule">
            <div className="talk-rule-head">
              <span className="talk-rule-who">{label}</span> may reach
            </div>
            <div className="seg talk-modes">
              {(who.kind === "everyone"
                ? (["anyone", "listed", "nobody"] as const)
                : (["inherit", "anyone", "listed", "nobody"] as const)
              ).map((m) => (
                <button
                  key={m}
                  className={`seg-option ${mode === m ? "active" : ""}`}
                  onClick={() => setMode(m)}
                  title={m === "inherit" && parent ? `Go by ${parent.label}'s rule` : undefined}
                >
                  {m === "inherit" && parent ? `Same as ${parent.label}` : MODE_WORD[m]}
                </button>
              ))}
            </div>
            {mode === "inherit" && parent && (
              <p className="talk-going">
                Going by {parent.label}: {summary(parent.rule, projects)}.
              </p>
            )}
            {mode === "listed" && own && (
              <Capped max={10} className="talk-list">
                {projects
                  .filter((project) => project.id !== self)
                  .map((project) => (
                    <label key={project.id} className="talk-check">
                      <input
                        type="checkbox"
                        checked={own.projects.includes(project.id)}
                        onChange={() => toggle(project.id)}
                      />
                      <span>{project.name}</span>
                    </label>
                  ))}
              </Capped>
            )}
          </div>
        </div>

        <h3 className="talk-lately">Lately</h3>
        {letters.length === 0 ? (
          <p className="board-empty">Nothing yet: no agent has messaged another since ruri started.</p>
        ) : (
          <Capped max={8} className="talk-letters">
            {letters.map((letter: TalkLetter) => (
              <div key={letter.id} className={`talk-letter st-${letter.status}`}>
                <div className="talk-letter-head">
                  <span className="talk-letter-who">
                    {chatName(projects, letter.from)} <span className="talk-arrow">→</span>{" "}
                    {chatName(projects, letter.to)}
                  </span>
                  <span className="talk-status">{STATUS_WORD[letter.status]}</span>
                  <span className="talk-when">{ago(letter.ts, now)}</span>
                </div>
                <div className="talk-letter-text">{letter.text}</div>
                {letter.note && <div className="talk-letter-note">{letter.note}</div>}
              </div>
            ))}
          </Capped>
        )}
      </div>
    </section>
  );
}
