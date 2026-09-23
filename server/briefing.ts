import * as fs from "node:fs";
import * as path from "node:path";
import type { SecretStore } from "./secrets.js";
import { localSkillsBriefing } from "./skills.js";
import { isMissing, warn } from "./log.js";

/**
 * What every project session is told about ruri itself, before it starts.
 *
 * The things that live here have one shape in common: each one points at a
 * file, a command or a tool rather than pasting its contents in. The
 * catch-up brief, the component library and the vault are all things a
 * session might never need — so none of them costs a token until the model
 * decides it does, and none of them changes the prompt when it changes.
 *
 * It rides the Claude system prompt as an append, and the provider system
 * prompt on every other harness, so the words are the same wherever a
 * session runs.
 */

/** A file only mentioned if it's actually there. */
function exists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch (err) {
    if (!isMissing(err)) warn("briefing", err, "exists");
    return false;
  }
}

export function sessionBriefing(input: {
  projectDir: string;
  projectName: string;
  secrets: SecretStore;
  /** Claude loads a project's own skills itself; nothing else does. */
  claude: boolean;
  /** "tool" when the harness holds ruri's naming tool; otherwise "", and
   *  the session puts what it builds in the library with `ruri register`. */
  naming: string;
  /** What the session is told about the bridge (see server/bridge.ts):
   *  the tools block for Claude, the endpoint block for everything else,
   *  or nothing when this run has no windows to offer. */
  bridge?: string;
  /** What the session is told about talking to the other agents open in
   *  ruri (server/talk.ts): tools for Claude, an endpoint for the rest. */
  talk?: string;
}): string {
  const blocks: string[] = [];

  const catchup = path.join(input.projectDir, ".ruri", "catchup.md");
  const architecture = path.join(input.projectDir, ".ruri", "architecture.md");
  // The words are the same in every session, whatever the files hold, so
  // the prompt stays cached; what changes is in the files.
  blocks.push(
    [
      "<ruri:catchup>",
      ...(exists(catchup)
        ? [
            `If you don't already know ${input.projectName} — a fresh session, a harness that has just taken over, work you have no memory of — read ${catchup} first: what git says right now, what was decided and why, what worked, what was tried and failed and why, the traps, and what is still open, gathered from every chat in this project. Don't redo a settled decision or retry a failed approach without a new reason.`,
            `The project's shape — where to change what, the stack from top to bottom, how the parts connect, where things are, how to run it, the rules it lives by — is in ${architecture}.`,
            "Both are one screen, kept current by ruri as turns finish: much cheaper than reading the code to find out, and much more reliable than guessing. Each memory line ends with the exchange it came from; check one with `ruri recall show <ref>` before you lean on it. Don't read them if you already have the context. Don't edit them.",
          ]
        : []),
      'When your work settles something a later session will need — a decision and its reason, an approach that failed and why, a trap, something left open — write it down from your shell: `ruri note decision "<what>" --why "<why>"` (or failed, worked, trap, open). One line each, only what the code won\'t tell the next session; not a log of what you built.',
      "`ruri recall <words>` searches every earlier exchange in this project, across its chats, and `ruri recall show <ref>` prints one whole; `ruri state` is git and this chat's changes, live.",
      "</ruri:catchup>",
    ].join("\n"),
  );

  // The library's words never change with what is in it — the list lives
  // in the file, the skill and the command — so this block is the same on
  // every session and the prompt stays cached.
  const components = path.join(input.projectDir, ".ruri", "components.md");
  blocks.push(
    [
      "<ruri:library>",
      `This project has a component library: every piece of its interface on file — what the user calls it, its handle, its files, a screenshot. It is listed in ${components}${input.claude ? " and in the ruri:components skill" : ""}, and it is behind the \`ruri\` command in your shell:`,
      "  ruri search <words>               find what exists",
      "  ruri show <slug>                  one in full, with its code",
      "  ruri add <slug> --dir <folder>    copy one into the project (the folder is remembered; `ruri add <project>/<slug>` takes one from another open project)",
      '  ruri register <slug> --files <paths> --note "<one line>" --shot <screenshot>    put interface you built into the library',
      "  ruri edit <slug> …  ·  ruri remove <slug>  ·  ruri help",
      "Before building interface here, look in the library and reuse or extend what is there; after building a piece worth reusing, put it in. Interface only — screens, panels, cards, controls, dialogs, their styles — never backend code.",
      "When the user names a part of the interface you can't place, look it up there before searching the code for their words.",
      "</ruri:library>",
    ].join("\n"),
  );

  if (input.naming === "tool") {
    blocks.push(
      [
        "<ruri:naming>",
        "When you build or substantially change a piece of this project's interface, put it in the component library: call mcp__ruri__name_component right after you finish it, with your suggested name, its files, one line on what it is, and a screenshot of it.",
        "Take the screenshot if you don't already have one — the card shows it, and without it you are asking the user to name something they cannot see. ruri keeps its own copy with the entry, so later sessions can read it back to know what the name refers to.",
        'The user gets a card, edits the name to whatever they will actually call it, and confirms — and from then on that name is how they will refer to it. Suggest the name a person would use: "the dragon gauges", not "DragonGauge". One call per component, not per file.',
        'mcp__ruri__list_components answers "what is what" when they use a name you don\'t recognise, or ask what exists.',
        "</ruri:naming>",
      ].join("\n"),
    );
  } else if (input.naming) {
    blocks.push(input.naming);
  }

  if (input.bridge) blocks.push(input.bridge);

  if (input.talk) blocks.push(input.talk);

  const vault = input.secrets.briefing(input.claude);
  if (vault) blocks.push(vault);

  if (!input.claude) {
    const skills = localSkillsBriefing(input.projectDir);
    if (skills) blocks.push(skills);
  }

  return blocks.join("\n\n");
}
