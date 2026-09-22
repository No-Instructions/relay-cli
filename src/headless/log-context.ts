/**
 * Per-runtime log routing for multi-folder daemons.
 *
 * The vendored logger batches entries and flushes them on a timer, so sink
 * attribution must happen at log time. Each HeadlessRelay runs its public
 * entry points inside an AsyncLocalStorage context carrying its sink id;
 * the resolver installed here reads that context from within the vendored
 * curryLog. Lines emitted outside any runtime context (process-level) fall
 * through to the vendored logger's default sink — the last-initialized one.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { setLogSinkResolver } from "../../vendor/relay/src/debug";

const logSinkContext = new AsyncLocalStorage<string>();
let installed = false;

export function installLogRouting(): void {
  if (installed) return;
  installed = true;
  setLogSinkResolver(() => logSinkContext.getStore() ?? null);
}

export function runWithLogSink<T>(sinkId: string, fn: () => T): T {
  return logSinkContext.run(sinkId, fn);
}
