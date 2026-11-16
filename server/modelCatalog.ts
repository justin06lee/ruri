import { newestInLine } from "../shared/modelLine.js";
import type { ModelChoice } from "../shared/protocol.js";

/**
 * The model catalog as the harnesses last reported it, for the corners of
 * the server that name a model without a store or a context to ask —
 * the small-tasks layer's stand-ins most of all. They name a line by one of
 * its models; `latestModel` answers with the newest the catalog lists in
 * that line, so a newer version is used the day its harness serves it and
 * no id here has to be kept up to date by hand.
 */
let catalog: readonly ModelChoice[] = [];

/** The catalog changed (server/models.ts, every list that lands). */
export function setModelCatalog(models: readonly ModelChoice[]): void {
  catalog = models;
}

/** The newest model listed in `id`'s line; `id` itself until a catalog is
 *  in, or when it stands alone (shared/modelLine.ts). */
export function latestModel(id: string): string {
  return newestInLine(catalog, id);
}
