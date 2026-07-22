/**
 * Public streaming-provider surface (2.6 modularity phase 1).
 *
 * Core modules should import registry + types from here. Provider-private
 * helpers (tiddl, streamrip bridges, auth file IO) stay under
 * `services/providers/<id>/` until incremental per-provider moves.
 *
 * See `docs/STRUCTURE_AUDIT_2.6.md` and `docs/STREAMING_PROVIDER_PLUGIN_CONTRACT.md`.
 */
export { streamingProviderManager } from "./registry.js";
export type * from "./types.js";
