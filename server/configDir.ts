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
