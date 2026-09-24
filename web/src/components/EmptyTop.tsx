import type { ModelChoice } from "../../../shared/protocol";
import { launchRoll, pickGreeting, useGreetings } from "../greetings";
import { markFor } from "../lib/marks";
import { MarkPair } from "./Marks";

/**
 * What sits over a chat with nothing in it yet: the marks of whoever made
 * the model it runs on (Marks.tsx — they follow a model picked before the
 * first prompt), and its title — a project chat's own, or on Home, one of
 * the greetings Settings keeps.
 */
export function EmptyTop({
  home,
  title,
  model,
  choice,
}: {
  home: boolean;
  title?: string;
  model: string;
  /** What the catalog says of the model, once it has arrived. */
  choice?: ModelChoice;
}) {
  const greetings = useGreetings();
  const words = home ? pickGreeting(greetings, launchRoll) : title;
  return (
    <>
      <MarkPair pick={markFor(model, choice)} />
      {words && <div className="hero-title">{words}</div>}
    </>
  );
}
