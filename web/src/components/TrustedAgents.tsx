import { useEffect, useState } from "react";
import { send, useRuri } from "../store";
import { Dropdown } from "./Dropdown";
import { FoldList, FoldRow } from "./FoldList";

/**
 * Settings → Trusted agents: the projects whose chats decide in the user's
 * place (server/trusted.ts). A trusted chat is handed the cards of the
 * turns it prompts, is who ask_trusted asks, and may see and drive every
 * other chat. Only this page registers one — no agent's tool can — and
 * both adding and removing take a second click, since one hands over the
 * user's own yes and the other takes it back mid-job.
 */
export function TrustedAgents({ shown }: { shown: boolean }) {
  const trusted = useRuri((s) => s.trusted);
  const projects = useRuri((s) => s.projects);
  const [pick, setPick] = useState("");
  /** What is waiting on a second click: a project to add, or one to remove. */
  const [sure, setSure] = useState<string | null>(null);

  useEffect(() => {
    if (shown) send({ type: "trusted_get" });
  }, [shown]);
  // a second click is wanted soon, or not at all
  useEffect(() => {
    if (!sure) return;
    const timer = setTimeout(() => setSure(null), 4_000);
    return () => clearTimeout(timer);
  }, [sure]);

  const ids = trusted.map((agent) => agent.project);
  const set = (next: string[]) => {
    setSure(null);
    send({ type: "trusted_set", projects: next });
  };
  const open = projects.filter((p) => !p.hidden && !ids.includes(p.id));
  const picked = open.some((p) => p.id === pick) ? pick : "";
  const name = (id: string) => projects.find((p) => p.id === id)?.name;

  return (
    <>
      <p className="settings-note">
        A trusted agent answers in your place. Cards that come up in a turn it started go to it first, other
        chats can ask it for a decision, and it can read, message and stop any chat. A card it leaves for
        three minutes comes back to you, you can always answer first, and everything it answers is written
        into that chat.
      </p>
      <FoldList
        id="trusted-agents"
        title="Trusted agents"
        count={trusted.length}
        info="Each is a project; its own chat, the one on your sidebar, is the agent. The first one open is who other chats ask. Only this page can add one."
      >
        {trusted.map((agent) => {
          const known = name(agent.project);
          return (
            <FoldRow
              key={agent.project}
              name={known ?? "a project that is closed"}
              tag={agent.since ? `since ${new Date(agent.since).toLocaleDateString()}` : undefined}
              faded={known === undefined}
            >
              <button
                className="ghost"
                title={
                  sure === `-${agent.project}`
                    ? undefined
                    : "Stop trusting it: cards it holds come back to you"
                }
                onClick={() => {
                  if (sure !== `-${agent.project}`) return setSure(`-${agent.project}`);
                  set(ids.filter((id) => id !== agent.project));
                }}
              >
                {sure === `-${agent.project}` ? "Remove?" : "Remove"}
              </button>
            </FoldRow>
          );
        })}
        <div className="vault-form account-add trusted-add">
          <Dropdown
            value={picked}
            title="The project whose chat to trust"
            options={[
              { value: "", label: open.length ? "Choose a project…" : "No other project is open" },
              ...open.map((p) => ({ value: p.id, label: p.name })),
            ]}
            onSelect={(value) => {
              setPick(value);
              setSure(null);
            }}
          />
          <button
            className="ghost"
            disabled={!picked}
            onClick={() => {
              if (sure !== `+${picked}`) return setSure(`+${picked}`);
              set([...ids, picked]);
              setPick("");
            }}
          >
            {sure === `+${picked}` ? `Trust ${name(picked) ?? "it"}?` : "Trust"}
          </button>
        </div>
      </FoldList>
    </>
  );
}
