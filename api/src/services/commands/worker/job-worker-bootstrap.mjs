// Dev/test worker bootstrap (plain ESM JavaScript — always loadable by node).
//
// When the app runs from TypeScript source under tsx (`tsx watch index.ts`),
// tsx's loader is NOT propagated into spawned worker threads: the worker can
// transform its own entry file, but cannot resolve that entry's `.js`-suffixed
// TypeScript imports (NodeNext style). So a `.ts` worker entry that imports the
// handler graph fails with ERR_MODULE_NOT_FOUND inside the worker.
//
// The fix: spawn THIS plain-JS file as the worker entry, register tsx's ESM
// resolver inside the worker, then dynamically import the real `.ts` entry —
// whose path is passed via workerData.__entry. In production the compiled `.js`
// entry is spawned directly and this bootstrap is unused.
import { workerData } from "node:worker_threads";

import { register } from "tsx/esm/api";

register();

await import(workerData.__entry);
