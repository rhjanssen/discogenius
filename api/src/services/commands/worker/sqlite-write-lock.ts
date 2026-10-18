import {
  withSqliteWriteMutexAsync,
  sqliteWriteMutexDiagnostics,
} from "../../../database/sqlite-write-mutex.js";

export interface WriteLockWaitStats {
  waitedMs: number;
  heldMs: number;
  queueDepth: number;
}

/** Report the same shared queue that every production writer uses. */
export function writeLockDiagnostics() {
  const { ownerToken, ...active } = sqliteWriteMutexDiagnostics();
  return { ...active, heldByOwner: ownerToken ? `mutex-owner-${ownerToken}` : null };
}

/** Test hook. Production leaves capture off, so the hot path is one null check. */
let capturedWriteLockLabels: string[] | null = null;

export function captureSqliteWriteLockLabels(enabled: boolean): void {
  capturedWriteLockLabels = enabled ? [] : null;
}

export function takeSqliteWriteLockLabels(): string[] {
  if (!capturedWriteLockLabels) return [];
  const labels = capturedWriteLockLabels;
  capturedWriteLockLabels = [];
  return labels;
}

/** Network calls and file operations belong outside this short write section. */
export async function withGlobalSqliteWriteLock<T>(
  work: () => T | Promise<T>,
  onStats?: (stats: WriteLockWaitStats) => void,
  label = "unlabelled",
): Promise<T> {
  capturedWriteLockLabels?.push(label);
  const queuedAt = Date.now();
  return withSqliteWriteMutexAsync(() => {
    const grantedAt = Date.now();
    const queueDepth = sqliteWriteMutexDiagnostics().queueDepth;
    const report = () => onStats?.({ waitedMs: grantedAt - queuedAt, heldMs: Date.now() - grantedAt, queueDepth });
    try {
      const result = work();
      if (result instanceof Promise) return result.finally(report);
      report();
      return result;
    } catch (error) {
      report();
      throw error;
    }
  }, label);
}
