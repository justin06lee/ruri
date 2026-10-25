import { launchRoll, pickGreeting, useGreetings } from "../greetings";

/**
 * What sits over a chat with nothing in it yet: its title — a project
 * chat's own, or on Home, one of the greetings Settings keeps.
 */
export function EmptyTop({ home, title }: { home: boolean; title?: string }) {
  const greetings = useGreetings();
  const words = home ? pickGreeting(greetings, launchRoll) : title;
  return words ? <div className="hero-title">{words}</div> : null;
}
