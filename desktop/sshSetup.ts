/**
 * Setting another computer up over SSH, with no invite: this device signs
 * in there the way the user would (their key, or a password typed once and
 * never kept), and a short script does the rest on the far side — finds
 * ruri, builds and installs it from source if it is not there and the user
 * said to, starts it in the background for good (a systemd user service, a
 * launchd agent), and asks it on its own local port, with its own token,
 * for a key for this device. The login is the proof, so the answer — the
 * key, and the fingerprint of the certificate to pin — is trusted as it
 * comes back over the signed-in channel (desktop/remote.ts adopt).
 *
 * The script says how it is getting on in lines the user is shown:
 * RURI-STEP <what>, then RURI-RESULT <pairing JSON> or RURI-ERROR <code>
 * <why>.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { configPath } from "../server/configDir.js";
import type { Pairing } from "../server/sharing.js";

/** Where ruri's source is cloned from to install it on a computer that
 *  has none. */
const SOURCE = "https://github.com/justin06lee/ruri";

export interface SetupTarget {
  /** The account to sign in as. */
  user: string;
  address: string;
  /** What this device is called there. */
  device: string;
  /** Build and install ruri there if it is missing. */
  install?: boolean;
  /** A password, when a key won't do; never written anywhere. */
  password?: string;
}

/** How a setup came out. */
export type SetupOutcome =
  | { ok: true; pairing: Pairing; harnesses: string[] }
  | {
      ok: false;
      /** What the user can do about it: give a password, or let ruri
       *  install itself there. */
      needs?: "password" | "install";
      error: string;
    };

/** A value as one single-quoted shell word. */
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The script that runs on the other computer, its values filled in. */
export function hostScript(target: Pick<SetupTarget, "device" | "install">): string {
  return `
DEVICE=${quote(target.device)}
INSTALL=${target.install ? 1 : 0}
SOURCE=${quote(SOURCE)}
PORT="\${RURI_PORT:-7776}"
CONF="\${RURI_CONFIG_DIR:-$HOME/.config/ruri}"
PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
HOST=$(hostname 2>/dev/null || uname -n)
step() { printf 'RURI-STEP %s\\n' "$*"; }
fail() { printf 'RURI-ERROR %s %s\\n' "$1" "$2"; exit 0; }
alive() { curl -s -m 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null | grep -q '"service":"ruri"'; }

command -v curl >/dev/null 2>&1 || fail no-curl "curl isn't installed on $HOST."
OS=$(uname -s)
BIN=""
if [ "$OS" = Darwin ]; then
  for b in /Applications/ruri.app/Contents/MacOS/ruri "$HOME/Applications/ruri.app/Contents/MacOS/ruri"; do
    [ -x "$b" ] && BIN=$b && break
  done
else
  [ -x "$HOME/.local/opt/ruri/ruri" ] && BIN="$HOME/.local/opt/ruri/ruri"
fi

if [ -z "$BIN" ] && ! alive; then
  [ "$INSTALL" = 1 ] || fail not-installed "ruri isn't installed on $HOST."
  [ "$OS" = Linux ] || fail no-install "Install ruri on $HOST first — ruri builds itself over SSH only on Linux."
  for t in git bun make; do
    command -v $t >/dev/null 2>&1 || fail no-tools "Building ruri on $HOST needs $t, which isn't installed there."
  done
  SRC="$HOME/.local/share/ruri/src"
  LOG="$HOME/.local/share/ruri/build.log"
  mkdir -p "$HOME/.local/share/ruri"
  step "Getting ruri's source on $HOST"
  if [ -d "$SRC/.git" ]; then
    git -C "$SRC" pull -q --ff-only >"$LOG" 2>&1 || fail build-failed "Updating ruri's source on $HOST failed — see $LOG there."
  else
    git clone -q --depth 1 "$SOURCE" "$SRC" >"$LOG" 2>&1 || fail build-failed "Getting ruri's source on $HOST failed — see $LOG there."
  fi
  step "Building ruri on $HOST — this takes a few minutes"
  (cd "$SRC" && make build install </dev/null >>"$LOG" 2>&1) || fail build-failed "Building ruri on $HOST failed — see $LOG there."
  BIN="$HOME/.local/opt/ruri/ruri"
fi

# Not running: started, and kept running for good — at boot, with or
# without anyone logged in at its screen. A ruri already running there is
# left as it was started.
if ! alive; then
  if [ "$OS" = Darwin ]; then
    PLIST="$HOME/Library/LaunchAgents/com.justin06lee.ruri.serve.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.justin06lee.ruri.serve</string>
<key>ProgramArguments</key><array><string>$BIN</string><string>--serve</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict></plist>
PLIST
  elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    UNIT="$HOME/.config/systemd/user/ruri.service"
    mkdir -p "$HOME/.config/systemd/user"
    cat >"$UNIT" <<UNIT
[Unit]
Description=ruri, for your other devices
After=network-online.target

[Service]
ExecStart="$BIN" --serve
Restart=on-failure
RestartSec=5
# a ruri opened on this screen takes over from this one (desktop/main.ts)
KillMode=process

[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload >/dev/null 2>&1
    systemctl --user enable ruri.service >/dev/null 2>&1
    loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
  fi
  step "Starting ruri on $HOST"
  if [ "$OS" = Darwin ]; then
    launchctl load -w "$PLIST" >/dev/null 2>&1 || (nohup "$BIN" --serve >/dev/null 2>&1 &)
  elif [ -f "$HOME/.config/systemd/user/ruri.service" ]; then
    systemctl --user start ruri.service >/dev/null 2>&1 || (setsid -f "$BIN" --serve >/dev/null 2>&1 </dev/null)
  else
    setsid -f "$BIN" --serve >/dev/null 2>&1 </dev/null
  fi
  i=0
  until alive && [ -s "$CONF/token" ]; do
    i=$((i + 1))
    [ $i -gt 90 ] && fail no-start "ruri didn't start on $HOST."
    sleep 1
  done
fi

step "Pairing with $HOST"
TOKEN=$(cat "$CONF/token" 2>/dev/null)
OUT=$(curl -s -m 60 -X POST -H "x-ruri-token: $TOKEN" -H 'content-type: application/json' \\
  --data "{\\"name\\":\\"$DEVICE\\"}" -w '\\n%{http_code}' "http://127.0.0.1:$PORT/sharing/pair-local")
CODE=$(printf '%s\\n' "$OUT" | tail -n 1)
BODY=$(printf '%s\\n' "$OUT" | sed '$d')
[ "$CODE" = 404 ] && fail too-old "The ruri on $HOST is older than this one — update it there."
[ "$CODE" = 200 ] || fail pair-failed "$HOST would not pair ($CODE): $BODY"
HARNESSES=""
for h in claude codex opencode gemini; do command -v $h >/dev/null 2>&1 && HARNESSES="$HARNESSES $h"; done
printf 'RURI-HARNESSES%s\\n' "$HARNESSES"
printf 'RURI-RESULT %s\\n' "$BODY"
`;
}

/** The helper ssh asks for a password: it says the one in its
 *  environment, which only that ssh is given. */
function askpass(): string {
  const file = configPath("ssh-askpass");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(configPath(), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$RURI_SSH_PASSWORD"\n`, { mode: 0o700 });
  }
  return file;
}

/** Whether ssh's complaint means the sign-in itself was refused. */
const refused = (stderr: string) =>
  /Permission denied|Authentication failed|Too many authentication/i.test(stderr);

/**
 * Set a computer up and pair with it, over SSH. `onStep` hears each line
 * the far side says it is on. Runs `ssh` from PATH unless RURI_SSH names
 * another program taking the same arguments (the scenario test runs the
 * script locally that way).
 */
export function setUpOverSsh(target: SetupTarget, onStep: (step: string) => void): Promise<SetupOutcome> {
  return new Promise((resolve) => {
    const args = [
      "-T",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ServerAliveInterval=15",
      ...(target.password
        ? [
            "-o",
            "NumberOfPasswordPrompts=1",
            "-o",
            "PreferredAuthentications=publickey,keyboard-interactive,password",
          ]
        : ["-o", "BatchMode=yes"]),
      `${target.user}@${target.address}`,
      "sh -s",
    ];
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (target.password) {
      env["SSH_ASKPASS"] = askpass();
      env["SSH_ASKPASS_REQUIRE"] = "force";
      env["RURI_SSH_PASSWORD"] = target.password;
      env["DISPLAY"] ??= ":0";
    }
    const child = spawn(process.env["RURI_SSH"] ?? "ssh", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let outcome: SetupOutcome | undefined;
    let harnesses: string[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("RURI-STEP ")) onStep(line.slice(10));
        else if (line.startsWith("RURI-HARNESSES"))
          harnesses = line.slice(14).trim().split(/\s+/).filter(Boolean);
        else if (line.startsWith("RURI-ERROR ")) {
          const [code = "", ...why] = line.slice(11).split(" ");
          outcome = {
            ok: false,
            error: why.join(" "),
            ...(code === "not-installed" ? { needs: "install" as const } : {}),
          };
        } else if (line.startsWith("RURI-RESULT ")) {
          try {
            const pairing = JSON.parse(line.slice(12)) as Pairing;
            outcome = pairing.ok
              ? { ok: true, pairing, harnesses }
              : { ok: false, error: "It answered, but not with a pairing." };
          } catch {
            outcome = { ok: false, error: "It answered with something that wasn't a pairing." };
          }
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) =>
      resolve({ ok: false, error: `Couldn't run ssh here: ${err.message}. Is OpenSSH installed?` }),
    );
    child.on("close", (code) => {
      if (outcome) {
        resolve(outcome);
        return;
      }
      if (refused(stderr)) {
        resolve({
          ok: false,
          needs: "password",
          error: target.password
            ? `${target.user}@${target.address} didn't take that password.`
            : `${target.address} wants a password for ${target.user}.`,
        });
        return;
      }
      const said = stderr
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("Warning: Permanently added"))
        .pop();
      resolve({
        ok: false,
        error: said
          ? `ssh: ${said}`
          : `The setup on ${target.address} stopped (exit ${code ?? "?"})${stdout ? "" : " before it said anything"}.`,
      });
    });
    child.stdin.end(hostScript(target));
  });
}
