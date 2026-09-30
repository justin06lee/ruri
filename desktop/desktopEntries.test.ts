import { describe, expect, test } from "bun:test";
import { execArgv, parseEntry, resolveApp, type DesktopEntry } from "./desktopEntries.js";

const entry = (id: string, text: string): DesktopEntry =>
  parseEntry(`/usr/share/applications/${id}.desktop`, text)!;

const editor = entry(
  "org.gnome.TextEditor",
  [
    "[Desktop Entry]",
    "Name=Text Editor",
    "Exec=gnome-text-editor %U",
    "Type=Application",
    "StartupWMClass=gnome-text-editor",
    "",
    "[Desktop Action new-window]",
    "Name=New Window",
    "Exec=gnome-text-editor --new-window",
  ].join("\n"),
);
const calculator = entry(
  "org.gnome.Calculator",
  ["[Desktop Entry]", "Name=Calculator", "Exec=gnome-calculator", "Type=Application"].join("\n"),
);
const hidden = entry(
  "calc-helper",
  ["[Desktop Entry]", "Name=Calculator", "Exec=calc-helper", "NoDisplay=true"].join("\n"),
);

describe("parseEntry", () => {
  test("reads the main section only, first value wins", () => {
    expect(editor).toEqual({
      id: "org.gnome.TextEditor",
      file: "/usr/share/applications/org.gnome.TextEditor.desktop",
      name: "Text Editor",
      exec: "gnome-text-editor %U",
      wmClass: "gnome-text-editor",
      hidden: false,
    });
    expect(hidden.hidden).toBe(true);
  });

  test("skips links and entries with nothing to run", () => {
    expect(parseEntry("/x/a.desktop", "[Desktop Entry]\nType=Link\nName=A\nURL=https://a")).toBeUndefined();
    expect(parseEntry("/x/b.desktop", "[Desktop Entry]\nName=B")).toBeUndefined();
  });
});

describe("execArgv", () => {
  test("fills file codes and drops the rest", () => {
    expect(execArgv("gnome-text-editor %U", ["/a", "/b"])).toEqual(["gnome-text-editor", "/a", "/b"]);
    expect(execArgv("app %f --icon %i %c", ["/a", "/b"])).toEqual(["app", "/a", "--icon"]);
    expect(execArgv("app %F", [])).toEqual(["app"]);
  });

  test("honours quoting and escapes", () => {
    expect(execArgv('"/opt/My App/app" --name "a \\"b\\"" 100%%', [])).toEqual([
      "/opt/My App/app",
      "--name",
      'a "b"',
      "100%",
    ]);
  });
});

describe("resolveApp", () => {
  const entries = [hidden, editor, calculator];

  test("by id, by name, by the id's last part, by command", () => {
    expect(resolveApp("org.gnome.TextEditor", [], entries).argv).toEqual(["gnome-text-editor"]);
    expect(resolveApp("text editor", ["/f"], entries).argv).toEqual(["gnome-text-editor", "/f"]);
    expect(resolveApp("calculator", [], entries).name).toBe("Calculator");
    expect(resolveApp("gnome-calculator", [], entries).address).toBe(
      "/usr/share/applications/org.gnome.Calculator.desktop",
    );
  });

  test("a shown entry beats a hidden one of the same name", () => {
    expect(resolveApp("Calculator", [], entries).argv).toEqual(["gnome-calculator"]);
  });

  test("window classes to look for", () => {
    expect(resolveApp("Text Editor", [], entries).classes).toEqual([
      "gnome-text-editor",
      "org.gnome.texteditor",
      "texteditor",
    ]);
  });

  test("a command on PATH, then nothing", () => {
    expect(resolveApp("sh", [], []).argv[0]).toMatch(/\/sh$/);
    expect(() => resolveApp("no-such-app-anywhere", [], [])).toThrow(/no app called/);
  });
});
