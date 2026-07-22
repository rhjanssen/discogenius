/**
 * Compatibility re-export for the historical `services/providers` import path.
 *
 * New core code should prefer `api/src/providers` (registry + types only).
 * Concrete adapters remain in this folder tree until per-provider moves land.
 */
export { streamingProviderManager } from "../../providers/index.js";
export type * from "../../providers/types.js";
