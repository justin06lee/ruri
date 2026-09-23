import type { NamedComponent } from "../shared/protocol.js";

/**
 * The library's pictures, taken by an agent.
 *
 * The sweep's own picture pass (server/shots.ts) is mechanical: start the
 * project, load one URL, find a selector, capture its rectangle. That is
 * cheap, and it reaches almost nothing — whatever sits behind a click, a
 * chat with something in it, a dialog, a state the app doesn't boot into,
 * an app that isn't a web page. Those entries went without a picture for
 * good, and one without a picture is an entry nobody can check at a glance.
 *
 * An agent can reach all of it: run the app, drive it to each thing with
 * the bridge, photograph it, and file the picture with `ruri edit`. So
 * whatever the refresh still has no current picture for is handed to one
 * chat in the project, named for the job, where the user can watch it work
 * and stop it. This is its prompt.
 */

/** One entry the chat is asked to photograph, and why. */
export interface PhotoTarget {
  item: NamedComponent;
  /** "none" — it has never had a picture; "changed" — its look changed
   *  since the one it has, by these commits. */
  why: "none" | "changed";
  commits?: string[];
}

function targetLines(target: PhotoTarget): string[] {
  const { item } = target;
  const where = item.selector
    ? [item.route, ...(item.clicks ?? []), item.selector].filter(Boolean).join(" >> ")
    : "";
  return [
    `- ${item.slug} — "${item.name}"${target.why === "none" ? " (no picture yet)" : " (its look changed since its picture)"}`,
    ...(item.note ? [`  ${item.note}`] : []),
    ...(item.files.length ? [`  files: ${item.files.join(", ")}`] : []),
    ...(where ? [`  on screen: ${where}`] : []),
    ...(target.commits?.length ? [`  changed by: ${target.commits.slice(0, 4).join("; ")}`] : []),
  ];
}

export function photoPrompt(targets: PhotoTarget[]): string {
  return [
    `Take the pictures this project's component library is missing — ${targets.length} of them. Each is a piece of the interface with a name the user refers to it by; the picture is how they and later sessions check which thing a name means, so it has to show the thing as it is now.`,
    "",
    ...targets.flatMap(targetLines),
    "",
    "How:",
    "1. Run the app the way this project runs (`.ruri/architecture.md`, “How to run it”), in a way that leaves the user's own running copy and their data alone — your own instance on a spare port, and a copy of any data it keeps rather than the real thing.",
    "2. Get each one on screen, showing what it is: real-looking content, not an empty shell. Open whatever it sits behind; for one that needs data, make it through the app itself or its fixtures.",
    "3. Photograph just it with a little room around it — `web_screenshot` with its selector (it saves a PNG and prints the path), or `app_screenshot` for a native app — look at the picture, and file it:",
    "   ruri edit <slug> --shot <png>",
    '   If its note is wrong about what you see, fix that too: --note "<one line>".',
    "4. One you cannot get on screen: skip it, and say why at the end.",
    "",
    "Don't change the project's code and don't commit anything — this is only pictures. Stop everything you started when you're done, and end with one line per entry: filed, or why not.",
  ].join("\n");
}
