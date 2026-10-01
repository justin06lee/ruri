import * as os from "node:os";
import * as path from "node:path";

/**
 * Where ruri keeps everything of its own: ~/.config/ruri, or wherever
 * RURI_CONFIG_DIR points. Read on every call rather than once, so a test
 * that sets the variable after import still lands in its own directory.
 */
export function configDir(): string {
  return process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri");
}

/** A path under the config dir. */
export function configPath(...parts: string[]): string {
  return path.join(configDir(), ...parts);
}

/** Where a bridge channel's pictures land: ~/.config/ruri/bridge/<channelId>/.
 *  Here rather than with the bridge's tools (server/bridge.ts) because the
 *  desktop shell writes them too, and importing the tools would bundle the
 *  Agent SDK into its process for one path. */
export function bridgeDir(channelId: string): string {
  return configPath("bridge", path.basename(channelId));
}
