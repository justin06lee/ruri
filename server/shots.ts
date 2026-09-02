import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Pictures, taken without anybody opening anything.
 *
 * A component index without screenshots is half an index: the name is for
 * the user and the files are for the model, but the picture is the only
 * part that proves the two are talking about the same object. Naming a
 * hundred things by reading source leaves a hundred entries nobody can
 * check at a glance.
 *
 * So: the naming pass writes down a CSS selector it actually saw in the
 * source, and this starts the project the ordinary way — its own dev
 * script — waits for the URL it prints, and hands the page and the
 * selectors to the desktop shell, which loads it in a window nobody sees
 * and captures each element's rectangle. Mapping a name to pixels is the
 * one step that needs the app running; everything either side of it is
 * mechanical.
 *
 * What it cannot do is worth being plain about: anything behind a login,
 * anything that needs state the app doesn't boot with, and anything in a
 * project that isn't a web app gets no picture. Those entries are still
 * entries — the user drops a screenshot on the card, the way they always
 * could.
 */

/** One thing to photograph, and how to get it on screen first. */
export interface ShotTarget {
  /** The component id the picture belongs to. */
  id: string;
  /** What to find on the page. */
  selector: string;
  /** Path to load first ("/settings"); the app's own root when absent. */
  route?: string;
  /** Selectors to click on the way, in order. */
  clicks?: string[];
}

/**
 * The one thing the desktop shell can do and a bare server cannot: open a
 * page and photograph part of it. Passed into startServer the same way the
 * folder picker is (see desktop/main.ts); absent when ruri runs headless,
 * and then the sweep simply names without pictures.
 *
 * Answers a map of component id to base64 PNG, with nothing at all for the
 * targets it couldn't find.
 */
export type CaptureHost = (
  url: string,
  targets: ShotTarget[],
) => Promise<Record<string, string>>;

/** Frameworks whose presence means "this project is a page somewhere". */
const WEB_DEPS =
  /^(vite|next|nuxt|astro|@sveltejs\/kit|@remix-run\/dev|react-scripts|parcel|webpack-dev-server|@angular\/cli|expo|electron)$/;

/** Dev scripts worth trying, best first. */
const DEV_SCRIPTS = ["dev", "start", "dev:web", "serve", "preview"];

/** How long to wait for the dev server to print a URL. */
const START_TIMEOUT_MS = 90_000;
/** Once a URL is seen that isn't the framework's own "Local:" line, wait
 *  this much longer in case a better one is about to be printed. */
const BETTER_URL_GRACE_MS = 6_000;
/** How long a stopped dev server has to go quietly before it is made to. */
const KILL_GRACE_MS = 4_000;

interface DevCommand {
  runner: string;
  args: string[];
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** How this project starts, if it does. */
export function devCommand(dir: string): DevCommand | undefined {
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
  const script = DEV_SCRIPTS.find((name) => typeof pkg.scripts?.[name] === "string");
  if (!script) return undefined;
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const web =
    deps.some((dep) => WEB_DEPS.test(dep)) ||
    ["index.html", "web/index.html", "src/index.html", "public/index.html", "app/index.html"].some(
      (rel) => fs.existsSync(path.join(dir, rel)),
    );
  if (!web) return undefined;
  const bun = fs.existsSync(path.join(dir, "bun.lock")) || fs.existsSync(path.join(dir, "bun.lockb"));
  return bun ? { runner: "bun", args: ["run", script] } : { runner: "npm", args: ["run", script] };
}

/**
 * The environment the project starts in: the user's, minus ruri's own.
 *
 * ruri's settings ride the environment (which port to serve on, which
 * config directory to read), and a child process inherits all of it. That
 * is harmless for most projects and quietly wrong for one: a project that
 * is itself ruri would come up pointed at this app's port and this app's
 * config, and photograph a copy of the thing taking the photograph.
 *
 * The bridge starts apps for a session under the same rule (desktop/apps.ts).
 */
export function projectEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("RURI_")) delete env[key];
  }
  return { ...env, BROWSER: "none", NO_COLOR: "1", FORCE_COLOR: "0" };
}

const ANSI = new RegExp("\\u001b\\[[0-9;]*[A-Za-z]", "g");
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/?\S*/;
const LOCAL_RE = /Local:\s*(https?:\/\/\S+)/;

/**
 * Start the project, wait for the address it prints, run `use` against it,
 * and stop it again — whatever happens in between.
 *
 * The address is read out of the dev server's own output rather than
 * guessed, because every framework picks its own port and half of them move
 * when the port is taken. A "Local:" line wins outright; anything else waits
 * a moment in case the real one is still coming.
 */
export async function withProjectRunning<T>(
  dir: string,
  onNote: (note: string) => void,
  use: (url: string) => Promise<T>,
): Promise<T | undefined> {
  const command = devCommand(dir);
  if (!command) {
    onNote("nothing here to open — named without pictures");
    return undefined;
  }
  onNote(`starting ${command.runner} ${command.args.join(" ")}…`);
  let child: ChildProcess;
  try {
    child = spawn(command.runner, command.args, {
      cwd: dir,
      // its own process group, so stopping it stops everything it started
      detached: true,
      env: projectEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    onNote("couldn't start the project — named without pictures");
    return undefined;
  }

  const stop = (): void => {
    const signal = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // already gone
      }
    };
    signal("SIGTERM");
    // A dev script is usually several processes in a trenchcoat, and not all
    // of them take the hint. Nothing of the user's is left running because
    // ruri wanted a screenshot.
    const hard = setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
    hard.unref();
  };

  try {
    const url = await new Promise<string | undefined>((resolve) => {
      let settled = false;
      let fallback: string | undefined;
      let grace: NodeJS.Timeout | undefined;
      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (grace) clearTimeout(grace);
        resolve(value);
      };
      const timer = setTimeout(() => finish(fallback), START_TIMEOUT_MS);
      const read = (chunk: Buffer): void => {
        const text = chunk.toString().replace(ANSI, "");
        const local = LOCAL_RE.exec(text);
        if (local?.[1]) {
          finish(local[1].replace(/\/+$/, ""));
          return;
        }
        const any = URL_RE.exec(text);
        if (!any || fallback) return;
        fallback = any[0].replace(/\/+$/, "");
        // a plain URL might be a backend announcing itself while the page
        // server is still booting — give the better line a moment to land
        grace = setTimeout(() => finish(fallback), BETTER_URL_GRACE_MS);
      };
      child.stdout?.on("data", read);
      child.stderr?.on("data", read);
      child.once("error", () => finish(undefined));
      child.once("exit", () => finish(fallback));
    });
    if (!url) {
      onNote("the project never printed an address — named without pictures");
      return undefined;
    }
    onNote("taking pictures…");
    return await use(url);
  } finally {
    stop();
  }
}
