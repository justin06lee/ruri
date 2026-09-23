import { useEffect, useState } from "react";
import type { Project, TalkLetter, TalkPolicy, TalkRule, TalkStatus } from "../../../shared/protocol";
import { useNow } from "../lib/beat";
import { send, useRuri } from "../store";
import { Capped } from "./Capped";

/**
 * The talk page: who your agents may message.
 *
 * Any chat's model can message another chat's — in its own project or any
 * other open one (server/talk.ts). Here the user says who may message
 * whom: one rule for every agent, which a project's rule overrides for the
 * chats in it, which a chat's own overrides for it. Each is "anyone",
 * "only these" (projects — every chat in one, new ones too — and single
 * chats), or "no one"; a project or a chat with no rule of its own goes
 * by the one above it. Opened from a chat's header, it starts on that
 * chat. Under the rules, the latest messages between agents and where
 * each has got to.
 */

type Mode = TalkRule["to"] | "inherit";

/** Who a rule is for: every agent, a project's chats, or one chat. */
type Who =
  | { kind: "everyone" }
  | { kind: "project"; project: Project }
  | { kind: "chat"; project: Project; chat: string };

const OPEN: TalkRule = { to: "anyone", projects: [], chats: [] };

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

function chatTitle(project: Project, chat: string): string {
  return project.sessions.find((s) => s.id === chat)?.title || "untitled chat";
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
  const names = [
    ...rule.projects.flatMap((id) => {
      const p = projects.find((x) => x.id === id);
      return p ? [`all of ${p.name}`] : [];
    }),
    ...rule.chats.flatMap((id) => {
      const p = projects.find((x) => x.sessions.some((s) => s.id === id));
      return p ? [`${p.name} · ${chatTitle(p, id)}`] : [];
    }),
  ];
  if (names.length === 0) return "no one yet";
  return names.length <= 2 ? `only ${names.join(", ")}` : `only ${names.length} picked`;
}

function keyOf(who: Who): string {
  return who.kind === "everyone"
    ? "everyone"
    : who.kind === "project"
      ? `p:${who.project.id}`
      : `c:${who.chat}`;
}

/** The rule a who has of its own, if any — and the one it goes by. */
function rules(policy: TalkPolicy, who: Who): { own?: TalkRule; parent?: { rule: TalkRule; label: string } } {
  if (who.kind === "everyone") return { own: policy.everyone };
  const everyone = { rule: policy.everyone, label: "every agent" };
  if (who.kind === "project") return { own: policy.projects[who.project.id], parent: everyone };
  const shared = policy.projects[who.project.id];
  return {
    own: policy.chats[who.chat],
    parent: shared ? { rule: shared, label: `all of ${who.project.name}` } : everyone,
  };
}

/** A copy of the policy with one who's rule set — or taken away. */
function withRule(policy: TalkPolicy, who: Who, rule: TalkRule | undefined): TalkPolicy {
  const next: TalkPolicy = {
    everyone: policy.everyone,
    projects: { ...policy.projects },
    chats: { ...policy.chats },
  };
  if (who.kind === "everyone") next.everyone = rule ?? OPEN;
  else if (who.kind === "project") {
    if (rule) next.projects[who.project.id] = rule;
    else delete next.projects[who.project.id];
  } else if (rule) next.chats[who.chat] = rule;
  else delete next.chats[who.chat];
  return next;
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
  const [picked, setPicked] = useState(`c:${channelId}`);
  const now = useNow(30_000);
  useEffect(() => {
    send({ type: "talk_get" });
  }, []);

  const whos: Who[] = [
    { kind: "everyone" },
    ...projects.flatMap((project) => [
      { kind: "project" as const, project },
      ...project.sessions.map((s) => ({ kind: "chat" as const, project, chat: s.id })),
    ]),
  ];
  const who = whos.find((w) => keyOf(w) === picked) ?? whos[0]!;

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
          chats: next === "listed" && shown.to === "listed" ? shown.chats : [],
        }),
      );
  };
  const toggle = (field: "projects" | "chats", id: string) => {
    if (!own || own.to !== "listed") return;
    const list = own[field].includes(id) ? own[field].filter((x) => x !== id) : [...own[field], id];
    save(withRule(policy, who, { ...own, [field]: list }));
  };

  const label =
    who.kind === "everyone"
      ? "Every agent"
      : who.kind === "project"
        ? `Every chat in ${who.project.name}`
        : `${who.project.name} · ${chatTitle(who.project, who.chat)}`;
  const self = who.kind === "chat" ? who.chat : undefined;
  const nameOf = (chat: string) => {
    const p = projects.find((x) => x.sessions.some((s) => s.id === chat));
    return p ? `${p.name} · ${chatTitle(p, chat)}` : "a closed chat";
  };

  return (
    <section className="board-page talk-page">
      <div className="board-inner">
        <div className="board-head">
          <span className="board-title">Talk</span>
          <span className="board-sub">who your agents may message</span>
        </div>
        <p className="talk-note">
          Any chat&rsquo;s agent can message another chat&rsquo;s — in its own project or any other open one —
          and hear back. In Bypass it sends on its own; in any other mode each message waits for you on a card
          in the chat sending it. A project or a chat with no rule of its own goes by the one above it.
        </p>

        <div className="talk-grid">
          <div className="talk-whos" role="listbox" aria-label="Whose rule">
            {whos.map((w) => {
              const key = keyOf(w);
              const r = rules(policy, w);
              const mine = w.kind === "chat" && w.chat === channelId;
              return (
                <button
                  key={key}
                  role="option"
                  aria-selected={key === keyOf(who)}
                  className={`talk-who kind-${w.kind} ${key === keyOf(who) ? "active" : ""} ${r.own ? "own" : ""}`}
                  onClick={() => setPicked(key)}
                >
                  <span className="talk-who-name">
                    {w.kind === "everyone"
                      ? "Every agent"
                      : w.kind === "project"
                        ? w.project.name
                        : chatTitle(w.project, w.chat)}
                    {mine && <span className="talk-this"> · this chat</span>}
                  </span>
                  <span className="talk-who-rule">{r.own ? summary(r.own, projects) : "as above"}</span>
                </button>
              );
            })}
          </div>

          <div className="talk-rule">
            <div className="talk-rule-head">
              <span className="talk-rule-who">{label}</span> may message
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
                {projects.map((project) => {
                  const whole = own.projects.includes(project.id);
                  return (
                    <div key={project.id} className="talk-project">
                      <label className="talk-check">
                        <input
                          type="checkbox"
                          checked={whole}
                          onChange={() => toggle("projects", project.id)}
                        />
                        <span>
                          {project.name}
                          <small> — every chat, new ones too</small>
                        </span>
                      </label>
                      {project.sessions.map((s) => (
                        <label key={s.id} className={`talk-check one ${s.id === self ? "self" : ""}`}>
                          <input
                            type="checkbox"
                            disabled={whole || s.id === self}
                            checked={s.id !== self && (whole || own.chats.includes(s.id))}
                            onChange={() => toggle("chats", s.id)}
                          />
                          <span>
                            {s.title || "untitled chat"}
                            {s.id === self && <small> — itself</small>}
                          </span>
                        </label>
                      ))}
                    </div>
                  );
                })}
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
                    {nameOf(letter.from)} <span className="talk-arrow">→</span> {nameOf(letter.to)}
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
