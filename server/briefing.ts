import * as fs from "node:fs";
import * as path from "node:path";
import type { SecretStore } from "./secrets.js";
import { localSkillsBriefing } from "./skills.js";

/**
 * What every project session is told about ruri itself, before it starts.
 *
 * Three things live here, and they have one shape in common: each one points
 * at a file rather than pasting its contents in. The catch-up brief, the
 * component index and the vault are all things a session might never need —
 * so none of them costs a token until the model decides it does.
 *
 * It rides the Claude system prompt as an append, and the provider system
 * prompt on every other harness, so the words are the same wherever a
 * session runs.
 */

/** A file only mentioned if it's actually there. */
function exists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function sessionBriefing(input: {
  projectDir: string;
  projectName: string;
  secrets: SecretStore;
  /** Claude loads a project's own skills itself; nothing else does. */
  claude: boolean;
  /** "tool" when the harness holds ruri's naming tool; otherwise the drop
   *  file's instructions, which say the same thing a longer way. */
  naming: string;
}): string {
  const blocks: string[] = [];

  const catchup = path.join(input.projectDir, ".ruri", "catchup.md");
  if (exists(catchup)) {
    blocks.push(
      [
        "<ruri:catchup>",
        `If you don't already know what ${input.projectName} is — a fresh session, a harness that has just taken over, work you have no memory of — read ${catchup} first.`,
        "It is one paragraph and a list of one-liners: what this project is and what is in it, kept current by ruri as turns finish. It is much cheaper than reading the code to find out, and much more reliable than guessing.",
        "Don't read it if you already have the context. Don't edit it.",
        "</ruri:catchup>",
      ].join("\n"),
    );
  }

  const components = path.join(input.projectDir, ".ruri", "components.md");
  if (exists(components)) {
    blocks.push(
      [
        "<ruri:components>",
        `The user has names for parts of this project that the code does not use. They are indexed at ${components} — each name, the files behind it, and screenshots.`,
        "When the user names something you can't place, read that file before searching the codebase for their words.",
        "</ruri:components>",
      ].join("\n"),
    );
  }

  if (input.naming === "tool") {
    blocks.push(
      [
        "<ruri:naming>",
        "When you build or substantially change a piece of this project's interface, call mcp__ruri__name_component right after you finish it: your suggested name, the files it lives in, one line on what it is, and a screenshot of it.",
        "Take the screenshot if you don't already have one — the card shows it, and without it you are asking the user to name something they cannot see. ruri keeps its own copy with the entry, so later sessions can read it back to know what the name refers to.",
        "The user gets a card, edits the name to whatever they will actually call it, and confirms — and from then on that name is how they will refer to it. Suggest the name a person would use: \"the dragon gauges\", not \"DragonGauge\". One call per component, not per file.",
        "mcp__ruri__list_components answers \"what is what\" when they use a name you don't recognise, or ask what exists.",
        "</ruri:naming>",
      ].join("\n"),
    );
  } else if (input.naming) {
    blocks.push(input.naming);
  }

  const vault = input.secrets.briefing();
  if (vault) blocks.push(vault);

  if (!input.claude) {
    const skills = localSkillsBriefing(input.projectDir);
    if (skills) blocks.push(skills);
  }

  return blocks.join("\n\n");
}
