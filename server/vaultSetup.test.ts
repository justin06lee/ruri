/**
 * Getting a ghostly vault from the Passwords page: the tailnet read from a
 * stand-in for `tailscale`, vaults found through a stand-in for fetch, the
 * setup scripts run for real by `sh` against stand-ins for curl, docker
 * and ghostly-server in a home of the test's making, SSH by a stand-in
 * that runs the script here — and the Vault's jobs over all of it, with a
 * stand-in `ghostly` whose enrollment waits on the owner one step at a time.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { VaultState } from "../shared/protocol.js";
import { Ghostly } from "./ghostly.js";
import { SecretStore } from "./secrets.js";
import { readTailnet, type Tailnet } from "./tailnet.js";
import { Vault, type VaultHelpers } from "./vault.js";
import { findVaults, type Fetch } from "./vaultFinder.js";
import { runScript, serverScript, signupsScript, type Outcome, type Where } from "./vaultSetup.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-vault-setup-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const saved = Object.fromEntries(
  ["RURI_TAILSCALE", "RURI_GHOSTLY", "RURI_SSH", "RURI_CONFIG_DIR", "GHOSTLY_HOME"].map((k) => [
    k,
    process.env[k],
  ]),
);
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A file of the test's, made runnable. */
function script(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o755 });
  return file;
}

/** What `tailscale status --json` says on a tailnet with a few devices. */
const STATUS = {
  BackendState: "Running",
  MagicDNSSuffix: "tail1234.ts.net",
  CurrentTailnet: { MagicDNSSuffix: "tail1234.ts.net" },
  Self: {
    HostName: "Mac mini",
    DNSName: "mac-mini.tail1234.ts.net.",
    OS: "macOS",
    TailscaleIPs: ["100.1.1.1", "fd7a::1"],
  },
  Peer: {
    a: {
      HostName: "midna",
      DNSName: "midna.tail1234.ts.net.",
      OS: "linux",
      Online: true,
      TailscaleIPs: ["100.1.1.2"],
      sshHostKeys: ["ssh-ed25519 AAAA"],
    },
    b: {
      HostName: "tenet",
      DNSName: "tenet.tail1234.ts.net.",
      OS: "linux",
      Online: false,
      TailscaleIPs: ["100.1.1.3"],
    },
    c: {
      HostName: "localhost",
      DNSName: "iphone-15.tail1234.ts.net.",
      OS: "iOS",
      Online: true,
      TailscaleIPs: ["100.1.1.4"],
    },
    d: {
      HostName: "friend",
      DNSName: "friend.other.ts.net.",
      OS: "linux",
      Online: true,
      TailscaleIPs: ["100.1.1.5"],
    },
    e: {
      HostName: "box",
      DNSName: "box.tail1234.ts.net.",
      OS: "linux",
      Online: true,
      TailscaleIPs: ["100.1.1.6"],
    },
  },
};

describe("the tailnet, as Tailscale says it", () => {
  test("no tailscale command is no Tailscale", async () => {
    process.env["RURI_TAILSCALE"] = "";
    expect(await readTailnet()).toEqual({ state: "none", devices: [] });
  });

  test("its devices, this one first, read through a warning on stderr", async () => {
    const json = path.join(root, "status.json");
    fs.writeFileSync(json, JSON.stringify(STATUS));
    process.env["RURI_TAILSCALE"] = script(
      path.join(root, "ts", "tailscale"),
      `#!/bin/sh\necho 'Warning: client version "1.2" != tailscaled server version "1.1"' >&2\ncat ${JSON.stringify(json)}\n`,
    );
    const tailnet = await readTailnet();
    expect(tailnet.state).toBe("connected");
    expect(tailnet.name).toBe("tail1234.ts.net");
    expect(tailnet.devices.map((d) => d.name)).toEqual([
      "Mac mini",
      "box",
      "friend",
      "iphone-15",
      "midna",
      "tenet",
    ]);
    const [me] = tailnet.devices;
    expect(me).toMatchObject({
      self: true,
      online: true,
      host: "mac-mini.tail1234.ts.net",
      addresses: ["100.1.1.1"],
    });
    const midna = tailnet.devices.find((d) => d.name === "midna")!;
    expect(midna).toMatchObject({ ssh: true, shared: false, online: true });
    expect(tailnet.devices.find((d) => d.name === "friend")!.shared).toBe(true);
    expect(tailnet.devices.find((d) => d.name === "tenet")!.online).toBe(false);
  });

  test("installed but not connected is off", async () => {
    process.env["RURI_TAILSCALE"] = script(
      path.join(root, "ts-off", "tailscale"),
      `#!/bin/sh\necho '{"BackendState":"Stopped"}'\n`,
    );
    expect(await readTailnet()).toEqual({ state: "off", devices: [] });
  });
});

/** A fetch that answers as a vault at these addresses, and as something else at the rest. */
function vaultsAt(servers: Record<string, string | null>, asked: string[] = []): Fetch {
  return async (url) => {
    asked.push(url);
    const base = url.replace(/\/api\/config$/, "");
    if (!(base in servers)) throw new Error("connection refused");
    const name = servers[base];
    if (name === undefined) throw new Error("no");
    return new Response(
      JSON.stringify(
        name === "nginx"
          ? { hello: "world" }
          : { object: "config", version: "2025.1.0", server: name ? { name } : null },
      ),
      { headers: { "content-type": "application/json" } },
    );
  };
}

async function tailnetOf(): Promise<Tailnet> {
  const json = path.join(root, "status.json");
  fs.writeFileSync(json, JSON.stringify(STATUS));
  process.env["RURI_TAILSCALE"] = script(
    path.join(root, "ts", "tailscale"),
    `#!/bin/sh\ncat ${JSON.stringify(json)}\n`,
  );
  return readTailnet();
}

describe("finding a vault on the tailnet", () => {
  test("each device that is on is asked, at 443 then 8443; phones and other tailnets are left out", async () => {
    const asked: string[] = [];
    const found = await findVaults({
      tailnet: await tailnetOf(),
      fetch: vaultsAt(
        {
          "https://midna.tail1234.ts.net": "Vaultwarden",
          "https://box.tail1234.ts.net": "nginx",
          "https://box.tail1234.ts.net:8443": null,
        },
        asked,
      ),
    });
    expect(found.state).toBe("connected");
    expect(found.devices.map((d) => d.name)).toEqual(["Mac mini", "box", "midna", "tenet"]);
    const by = Object.fromEntries(found.devices.map((d) => [d.name, d]));
    expect(by["midna"]!.vault).toEqual({ server: "https://midna.tail1234.ts.net", software: "Vaultwarden" });
    // Bitwarden's own server gives no name
    expect(by["box"]!.vault).toEqual({ server: "https://box.tail1234.ts.net:8443", software: "Bitwarden" });
    expect(by["Mac mini"]!.vault).toBeUndefined();
    // an offline device, a phone and someone else's are never asked
    expect(asked.some((url) => /tenet|iphone|friend/.test(url))).toBe(false);
    // one found at 443 is not asked again at 8443
    expect(asked).not.toContain("https://midna.tail1234.ts.net:8443/api/config");
  });

  test("Tailscale off is said, with nothing asked", async () => {
    const asked: string[] = [];
    const found = await findVaults({ tailnet: { state: "off", devices: [] }, fetch: vaultsAt({}, asked) });
    expect(found).toMatchObject({ state: "off", devices: [] });
    expect(asked).toEqual([]);
  });
});

/**
 * A home for a script run here, with stand-ins for what it calls, and a
 * PATH of the test's own: the user's own ghostly-server and tailscale must
 * never be what a script finds. So `tailscale` is always a stand-in that
 * refuses — whatever ran it could not change how this machine serves.
 */
function homeWith(tools: Record<string, string>): { home: string; env: NodeJS.ProcessEnv } {
  const home = fs.mkdtempSync(path.join(root, "home-"));
  const bin = path.join(home, ".local", "bin");
  script(
    path.join(bin, "tailscale"),
    `#!/bin/sh
echo "$*" >> "$HOME/tailscale-calls"
exit 1
`,
  );
  for (const [name, body] of Object.entries(tools)) script(path.join(bin, name), body);
  return { home, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } };
}

/** What a stand-in for ghostly-server does: says its address, notes every run. */
const SERVER_STAND_IN = `#!/bin/sh
echo "$*" >> "$HOME/server-calls"
case "$1" in
  url) echo "https://box.tail1234.ts.net" ;;
  install) echo "✓ Vaultwarden is running (1.37.5)" ;;
  signups) echo "✓ Signups are closed." ;;
esac
`;

describe("the setup scripts, run by sh", () => {
  test("a fresh device: ghostly's installer is fetched and run for a tailnet vault, and its address comes back", async () => {
    const { home, env } = homeWith({
      docker: "#!/bin/sh\nexit 0\n",
      // the installer it downloads puts ghostly-server in place and runs it
      curl: `#!/bin/sh
echo "$*" >> "$HOME/curl-calls"
cat <<'INSTALLER'
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/ghostly-server" <<'SERVER'
${SERVER_STAND_IN}SERVER
chmod +x "$HOME/.local/bin/ghostly-server"
echo "Installed ghostly-server"
"$HOME/.local/bin/ghostly-server" install "$@"
INSTALLER
`,
    });
    const lines: string[] = [];
    const out = await runScript({ local: true }, serverScript(), (line) => lines.push(line), { env });
    expect(out).toEqual({ done: true, url: "https://box.tail1234.ts.net" });
    expect(fs.readFileSync(path.join(home, "curl-calls"), "utf8")).toContain(
      "https://raw.githubusercontent.com/justin06lee/ghostly/master/install.sh",
    );
    expect(fs.readFileSync(path.join(home, "server-calls"), "utf8")).toContain("install server --tailscale");
    expect(lines[0]).toMatch(/^Getting ghostly's installer on /);
    expect(lines).toContain("Installed ghostly-server");
    expect(lines).toContain("✓ Vaultwarden is running (1.37.5)");
    expect(fs.existsSync(path.join(home, "tailscale-calls"))).toBe(false);
  });

  test("a device that has ghostly-server already is served on the tailnet again", async () => {
    const { home, env } = homeWith({ docker: "#!/bin/sh\nexit 0\n", "ghostly-server": SERVER_STAND_IN });
    const lines: string[] = [];
    const out = await runScript({ local: true }, serverScript(), (line) => lines.push(line), { env });
    expect(out.url).toBe("https://box.tail1234.ts.net");
    expect(fs.readFileSync(path.join(home, "server-calls"), "utf8").split("\n")[0]).toBe(
      "install --tailscale",
    );
    expect(lines[0]).toMatch(/already: serving it on your tailnet/);
  });

  test("an installer that can't be fetched is said, and nothing more runs", async () => {
    const { home, env } = homeWith({ docker: "#!/bin/sh\nexit 0\n", curl: "#!/bin/sh\nexit 22\n" });
    const out = await runScript({ local: true }, serverScript(), () => undefined, { env });
    expect(out.done).toBe(false);
    expect(out.error).toMatch(/^Couldn't download ghostly's installer on /);
    expect(fs.existsSync(path.join(home, "tailscale-calls"))).toBe(false);
  });

  test("closing signups runs ghostly-server signups off", async () => {
    const { home, env } = homeWith({ "ghostly-server": SERVER_STAND_IN });
    const out = await runScript({ local: true }, signupsScript(), () => undefined, { env });
    expect(out).toEqual({ done: true });
    expect(fs.readFileSync(path.join(home, "server-calls"), "utf8").trim()).toBe("signups off");
  });

  test("over SSH: the script goes on ssh's stdin, and a key turned away asks for a password", async () => {
    const seen = path.join(root, "ssh-args");
    process.env["RURI_SSH"] = script(
      path.join(root, "ssh", "ssh"),
      `#!/bin/sh\necho "$@" > ${JSON.stringify(seen)}\nexec sh -s\n`,
    );
    const login: Where = { local: false, login: { user: "justin", address: "100.1.1.2" } };
    const out = await runScript(
      login,
      "echo 'GHOSTLY-STEP hello from the far side'\necho GHOSTLY-DONE\n",
      () => undefined,
    );
    expect(out).toEqual({ done: true });
    expect(fs.readFileSync(seen, "utf8")).toContain("BatchMode=yes justin@100.1.1.2 sh -s");

    process.env["RURI_SSH"] = script(
      path.join(root, "ssh-no", "ssh"),
      "#!/bin/sh\necho 'justin@100.1.1.2: Permission denied (publickey).' >&2\nexit 255\n",
    );
    const refused = await runScript(login, "echo GHOSTLY-DONE\n", () => undefined);
    expect(refused).toEqual({
      done: false,
      needsPassword: true,
      error: "100.1.1.2 wants a password for justin.",
    });
  });
});

/** A stand-in `ghostly` whose enrollment stops at whichever step its state names. */
const GHOSTLY_STAND_IN = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(__dirname, "state.json");
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const [command, ...rest] = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "calls"), [command, ...rest].join(" ") + "\\n");
const fail = (message, code) => { process.stderr.write("ghostly: " + message + "\\n"); process.exit(code); };
if (command === "init") {
  state.enrolled = true;
  fs.writeFileSync(file, JSON.stringify(state));
  if (state.stage === "account") fail("waiting for the account ruri@ghostly.local to be created", 3);
  if (state.stage === "confirm") {
    process.stderr.write("Step 3 of 3 · Confirm the agent\\n  The fingerprint phrase shown there must read  alpha-bravo-charlie-delta-echo\\n");
    fail("waiting for the owner to confirm the agent", 3);
  }
  if (state.stage === "collection") fail("waiting for a collection to be shared", 3);
  process.exit(0);
}
if (!state.enrolled) fail("this machine has no agent enrolled yet", 1);
if (command === "status") process.stdout.write(JSON.stringify({ server: "https://midna.tail1234.ts.net", email: "ruri@ghostly.local", ok: state.stage === "done", collections: ["agent"] }));
else if (command === "list") process.stdout.write("[]");
else fail("unknown command", 2);
`;

describe("the Vault's jobs", () => {
  let dir: string;
  let states: VaultState[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(root, "ghostly-"));
    script(path.join(dir, "ghostly"), GHOSTLY_STAND_IN);
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ enrolled: false, stage: "account" }));
    process.env["RURI_GHOSTLY"] = path.join(dir, "ghostly");
    process.env["RURI_CONFIG_DIR"] = dir;
    process.env["GHOSTLY_HOME"] = path.join(dir, "home");
    states = [];
  });

  const stage = (next: string) =>
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ enrolled: true, stage: next }));

  function make(helpers: Partial<VaultHelpers> = {}): Vault {
    const vault: Vault = new Vault(
      new SecretStore(),
      new Ghostly({ timeoutMs: 10_000, statusTimeoutMs: 10_000 }),
      () => states.push(vault.view()),
      helpers,
    );
    return vault;
  }

  test("looking lists the devices and the vault each serves", async () => {
    const tailnet = await tailnetOf();
    const vault = make({
      readTailnet: async () => tailnet,
      fetch: vaultsAt({ "https://midna.tail1234.ts.net": "Vaultwarden" }),
    });
    await vault.look();
    const seen = vault.view().tailnet!;
    expect(seen.looking).toBe(false);
    expect(seen.user).toBe(os.userInfo().username);
    expect(seen.devices.find((d) => d.name === "midna")!.vault?.software).toBe("Vaultwarden");
    // the page saw it looking first
    expect(states.some((s) => s.tailnet?.looking)).toBe(true);
  });

  test("enrolling stops at each step the owner does, and finishes enrolled", async () => {
    const tailnet = await tailnetOf();
    const vault = make({
      readTailnet: async () => tailnet,
      fetch: vaultsAt({ "https://midna.tail1234.ts.net": "Vaultwarden" }),
    });
    await vault.look();
    const server = "https://midna.tail1234.ts.net";

    await vault.enroll(server);
    expect(vault.view().job).toMatchObject({
      kind: "enroll",
      server,
      device: "midna",
      email: "ruri@ghostly.local",
      stage: "account",
      running: false,
    });
    expect(fs.readFileSync(path.join(dir, "calls"), "utf8")).toContain(`init --server=${server} --name=ruri`);

    stage("confirm");
    await vault.enroll(server);
    expect(vault.view().job).toMatchObject({
      stage: "confirm",
      fingerprint: "alpha-bravo-charlie-delta-echo",
    });

    stage("collection");
    await vault.enroll(server);
    expect(vault.view().job?.stage).toBe("collection");

    stage("done");
    await vault.enroll(server);
    const after = vault.view();
    expect(after.job?.stage).toBe("done");
    expect(after.job?.lines).toContain("Checking again");
    expect(after).toMatchObject({ enrolled: true, ok: true, server, account: "ruri@ghostly.local" });
  });

  test("the agent's password goes to the clipboard helper, never the page", async () => {
    let copied: string | undefined;
    const vault = make({ copy: async (value) => void (copied = value) });
    await vault.enroll("https://midna.tail1234.ts.net");
    fs.mkdirSync(path.join(dir, "home", "agent"), { recursive: true });
    fs.writeFileSync(path.join(dir, "home", "agent", "master-password"), "correct horse battery staple\n");
    await vault.copyPassword();
    expect(copied).toBe("correct horse battery staple");
    expect(vault.view().job?.copied).toBeNumber();
    expect(JSON.stringify(states)).not.toContain("correct horse");
  });

  test("a vault set up on a device: over SSH as the user, its address, then signups closed", async () => {
    const tailnet = await tailnetOf();
    const runs: Array<{ where: Where; script: string }> = [];
    const answers: Outcome[] = [
      { done: false, needsPassword: true, error: "100.1.1.6 wants a password for justin." },
      { done: true, url: "https://box.tail1234.ts.net" },
      { done: true },
    ];
    const vault = make({
      readTailnet: async () => tailnet,
      fetch: vaultsAt({}),
      run: async (where, text, onLine) => {
        runs.push({ where, script: text });
        onLine("working");
        return answers.shift()!;
      },
    });
    await vault.look();

    await vault.setUp("box.tail1234.ts.net", "justin");
    expect(vault.view().job).toMatchObject({
      kind: "server",
      device: "box",
      user: "justin",
      needsPassword: true,
    });
    expect(runs[0]!.where).toEqual({ local: false, login: { user: "justin", address: "100.1.1.6" } });

    await vault.setUp("box.tail1234.ts.net", "justin", "pw");
    expect(runs[1]!.where).toEqual({
      local: false,
      login: { user: "justin", address: "100.1.1.6", password: "pw" },
    });
    const up = vault.view().job!;
    expect(up).toMatchObject({ stage: "signups", server: "https://box.tail1234.ts.net", running: false });
    expect(up.needsPassword).toBeUndefined();
    expect(up.error).toBeUndefined();
    expect(JSON.stringify(states)).not.toContain('"pw"');

    await vault.signupsOff();
    expect(runs[2]!.script).toContain("ghostly-server signups off");
    expect(vault.view().job?.stage).toBe("done");

    vault.closeJob();
    expect(vault.view().job).toBeUndefined();
  });

  test("this machine is set up without SSH", async () => {
    const tailnet = await tailnetOf();
    const runs: Where[] = [];
    const vault = make({
      readTailnet: async () => tailnet,
      fetch: vaultsAt({}),
      run: async (where) => {
        runs.push(where);
        return { done: false, error: "ghostly's vault runs in Docker, which isn't installed on mac-mini." };
      },
    });
    await vault.look();
    await vault.setUp("mac-mini.tail1234.ts.net");
    expect(runs).toEqual([{ local: true }]);
    expect(vault.view().job?.error).toMatch(/Docker/);
  });
});
