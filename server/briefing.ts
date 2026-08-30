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

  const vault = input.secrets.briefing();
  if (vault) blocks.push(vault);

  if (!input.claude) {
    const skills = localSkillsBriefing(input.projectDir);
    if (skills) blocks.push(skills);
  }

  return blocks.join("\n\n");
}
