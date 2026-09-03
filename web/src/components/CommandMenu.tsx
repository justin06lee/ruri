import { useEffect, useMemo, useRef, useState } from "react";
import type { CommandInfo } from "../../../shared/protocol";
import { send, useRuri } from "../store";

/**
 * The commands, offered while you type one.
 *
 * A slash command in a prompt is lifted out and run before the prompt (see
 * server/commands.ts), and only names that exist count — so until now you
 * had to know what existed. Type "/" at the start of a word and this stands
 * over the composer with everything that would actually run: ruri's own,
 * the handful the harness answers, every installed skill, every custom
 * command file in .claude/commands. Arrows move, Enter or Tab takes one,
 * Escape puts it away.
 *
 * It offers nothing else about the prompt: the menu is a way to find a name,
 * and what happens to the name after that is the composer's business — a
 * taken command lands with a space after it, which is exactly what turns it
 * into a chip.
 */

/** What a command's kind is called where it shows. */
const KIND: Record<CommandInfo["kind"], string> = {
  ruri: "ruri",
  harness: "harness",
  skill: "skill",
  custom: "yours",
};

/** The slash word the caret is inside, if it is inside one. A command is a
 *  word starting at a line's start or after whitespace, with the caret at
 *  its end and no space typed yet — the moment a space arrives it is a
 *  finished command, and the menu's work is done. */
export function commandPrefix(text: string, caret: number): { at: number; word: string } | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)\/([a-z0-9][\w:.-]*)?$/i.exec(before);
  if (!match) return null;
  const word = match[1] ?? "";
  return { at: before.length - word.length - 1, word };
}

/** Commands whose name matches what has been typed, best first. */
function matching(commands: CommandInfo[], word: string): CommandInfo[] {
  const needle = word.toLowerCase();
  if (!needle) return commands;
  const starts: CommandInfo[] = [];
  const holds: CommandInfo[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(needle)) starts.push(command);
    else if (name.includes(needle)) holds.push(command);
  }
  return [...starts, ...holds];
}

export function CommandMenu({
  projectId,
  word,
  onPick,
  onClose,
  pickRef,
}: {
  /** Whose skills and command files to read — the owning project, or Home. */
  projectId: string | undefined;
  /** What has been typed after the slash. */
  word: string;
  onPick: (command: CommandInfo) => void;
  onClose: () => void;
  /** Filled with what the composer's keydown should call: the arrows, Enter
   *  and Tab belong to the menu while it is open, and the textarea keeps
   *  the focus the whole time. */
  pickRef: React.MutableRefObject<((key: string) => boolean) | null>;
}) {
  const commands = useRuri((s) => s.commands);
  const commandsFor = useRuri((s) => s.commandsFor);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // read once per project, when the menu first wants them
  useEffect(() => {
    if (commandsFor === (projectId ?? null) && commands.length > 0) return;
    send({ type: "commands_refresh", ...(projectId ? { projectId } : {}) });
  }, [projectId, commandsFor, commands.length]);

  const shown = useMemo(() => matching(commands, word).slice(0, 8), [commands, word]);

  // a narrowed list puts the highlight back on its first row rather than
  // leaving it past the end
  useEffect(() => setActive(0), [word]);

  useEffect(() => {
    pickRef.current = (key: string) => {
      if (shown.length === 0) return false;
      if (key === "ArrowDown") {
        setActive((n) => (n + 1) % shown.length);
        return true;
      }
      if (key === "ArrowUp") {
        setActive((n) => (n - 1 + shown.length) % shown.length);
        return true;
      }
      if (key === "Enter" || key === "Tab") {
        onPick(shown[active] ?? shown[0]!);
        return true;
      }
      if (key === "Escape") {
        onClose();
        return true;
      }
      return false;
    };
    return () => {
      pickRef.current = null;
    };
  }, [shown, active, onPick, onClose, pickRef]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".command-row.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (shown.length === 0) return null;

  return (
    <div className="command-menu" ref={listRef}>
      {shown.map((command, i) => (
        <button
          key={`${command.kind}-${command.name}`}
          type="button"
          className={`command-row ${i === active ? "active" : ""}`}
          // the textarea keeps the caret: a mousedown here must not take it
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => setActive(i)}
          onClick={() => onPick(command)}
        >
          <span className="command-name">/{command.name}</span>
          {command.description && <span className="command-what">{command.description}</span>}
          <span className={`command-kind ${command.kind}`}>{KIND[command.kind]}</span>
        </button>
      ))}
    </div>
  );
}
