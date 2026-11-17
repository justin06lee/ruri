import * as fs from "node:fs";
import { configPath } from "./configDir.js";

/**
 * Signing in to another computer over SSH the way the user would: with
 * their key, or a password typed once and never kept. Setting up ruri on
 * another computer (desktop/sshSetup.ts) and setting up a ghostly vault on
 * one (server/vaultSetup.ts) both run a script there this way, on the
 * far side's stdin.
 */

export interface SshLogin {
  /** The account to sign in as. */
  user: string;
  address: string;
  /** A password, when a key won't do; never written anywhere. */
  password?: string;
}

/** A value as one single-quoted shell word. */
export const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

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

/** What to run: `ssh` from PATH, unless RURI_SSH names another program
 *  taking the same arguments (a test's, which runs the script locally). */
export const sshProgram = () => process.env["RURI_SSH"] ?? "ssh";

/** ssh's arguments for running `sh -s` there. Without a password it never
 *  asks for one (BatchMode), so a key that is turned away says so at once. */
export function sshArgs(login: SshLogin): string[] {
  return [
    "-T",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=15",
    ...(login.password
      ? [
          "-o",
          "NumberOfPasswordPrompts=1",
          "-o",
          "PreferredAuthentications=publickey,keyboard-interactive,password",
        ]
      : ["-o", "BatchMode=yes"]),
    `${login.user}@${login.address}`,
    "sh -s",
  ];
}

/** ssh's environment: the password, when there is one, goes to its askpass
 *  helper this way and nowhere else. */
export function sshEnv(login: SshLogin): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (login.password) {
    env["SSH_ASKPASS"] = askpass();
    env["SSH_ASKPASS_REQUIRE"] = "force";
    env["RURI_SSH_PASSWORD"] = login.password;
    env["DISPLAY"] ??= ":0";
  }
  return env;
}

/** Whether ssh's complaint means the sign-in itself was refused. */
export const refused = (stderr: string) =>
  /Permission denied|Authentication failed|Too many authentication/i.test(stderr);

/** ssh's own last word, without the line it says about a new host key. */
export const lastSaid = (stderr: string) =>
  stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Warning: Permanently added"))
    .pop();
