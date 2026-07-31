import { db } from "../../database.js";
import { getCurrentLibraryRootPath } from "./library-paths.js";
import { normalizeComparablePath } from "./path-utils.js";

/**
 * A deletion always targets exactly one configured Library, or is an explicitly
 * requested all-Library operation. An omitted `libraryId` is never "every
 * Library": that ambiguity is what let Manage → Delete files wipe a shared root.
 */
export type DeletionScope =
  | { kind: "library"; libraryId: number }
  | { kind: "all-libraries" };

export type DeletionScopeInput = {
  libraryId?: number | string | null;
  allLibraries?: boolean;
};

function badRequest(message: string): Error & { status?: number } {
  const error = new Error(message) as Error & { status?: number };
  error.status = 400;
  return error;
}

function parseLibraryId(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (text.length === 0) return null;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw badRequest(`libraryId must be a positive integer, received ${text}`);
  }
  return parsed;
}

/**
 * Strict scope resolution used by the deletion services themselves. The caller
 * must have already decided which Library it is acting on.
 */
export function resolveDeletionScope(input: DeletionScopeInput): DeletionScope {
  const wantsAllLibraries = input.allLibraries === true;
  const libraryId = parseLibraryId(input.libraryId);

  if (wantsAllLibraries && libraryId != null) {
    throw badRequest("Deletion accepts either libraryId or allLibraries, not both");
  }
  if (wantsAllLibraries) {
    return { kind: "all-libraries" };
  }
  if (libraryId != null) {
    const library = db.prepare("SELECT id FROM Libraries WHERE id = ?").get(libraryId) as
      | { id?: number }
      | undefined;
    if (!library?.id) {
      throw badRequest(`Library ${libraryId} does not exist`);
    }
    return { kind: "library", libraryId: library.id };
  }

  throw badRequest(
    "Deletion requires an explicit target Library (libraryId) or allLibraries=true",
  );
}

/**
 * Boundary resolution for HTTP requests that carry no explicit scope.
 *
 * Only unambiguous installations resolve implicitly: a single configured
 * Library, or none at all (no Library boundary exists yet, so there is nothing
 * a scoped deletion could preserve). Anything else fails closed and names the
 * missing parameter rather than guessing which Library the user meant.
 */
export function resolveDeletionScopeAtBoundary(input: DeletionScopeInput): DeletionScope {
  const hasExplicitScope = input.allLibraries === true
    || parseLibraryId(input.libraryId) != null;
  if (hasExplicitScope) {
    return resolveDeletionScope(input);
  }

  const libraries = db.prepare(`
    SELECT id FROM Libraries WHERE enabled = 1 ORDER BY id
  `).all() as Array<{ id: number }>;

  if (libraries.length === 0) {
    return { kind: "all-libraries" };
  }
  if (libraries.length === 1) {
    return { kind: "library", libraryId: libraries[0].id };
  }
  throw badRequest(
    `Deletion requires an explicit libraryId (or allLibraries=true); `
    + `${libraries.length} libraries are configured`,
  );
}

/** Round-trip a resolved scope back into the options a deletion service takes. */
export function scopeToOptions(scope: DeletionScope): DeletionScopeInput {
  return scope.kind === "all-libraries"
    ? { allLibraries: true }
    : { libraryId: scope.libraryId };
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function firstValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Normalize raw query-string / JSON-body values into a deletion scope. HTTP is
 * the one place where the scope may be implied, so this is the only entry point
 * that consults the configured Libraries.
 */
export function deletionScopeFromRequest(input: {
  libraryId?: unknown;
  allLibraries?: unknown;
}): DeletionScope {
  const rawLibraryId = firstValue(input.libraryId);
  const rawAllLibraries = firstValue(input.allLibraries);
  const allLibraries = rawAllLibraries === true
    || (typeof rawAllLibraries === "string" && TRUE_VALUES.has(rawAllLibraries.trim().toLowerCase()));

  return resolveDeletionScopeAtBoundary({
    libraryId: typeof rawLibraryId === "number" || typeof rawLibraryId === "string"
      ? rawLibraryId
      : null,
    allLibraries,
  });
}

/**
 * Every enabled Library whose configured root contains `filePath`. Root
 * containment alone is not ownership when several Libraries share a root, so
 * callers must treat anything other than a single match as unresolved.
 */
export function librariesOwningPath(filePath: string): number[] {
  const normalizedPath = normalizeComparablePath(filePath);
  if (!normalizedPath) return [];

  const libraries = db.prepare(`
    SELECT id, root_path FROM Libraries WHERE enabled = 1 ORDER BY id
  `).all() as Array<{ id: number; root_path: string }>;

  return libraries
    .filter((library) => {
      const root = normalizeComparablePath(library.root_path);
      if (!root) return false;
      return normalizedPath === root || normalizedPath.startsWith(`${root}/`);
    })
    .map((library) => library.id);
}

export type ScopedFileRow = {
  library_id?: number | null;
  file_path: string;
};

/**
 * Whether a playable-file row falls inside the deletion scope.
 *
 * Rows that predate Library assignment (`library_id IS NULL`) are adopted only
 * when exactly one enabled Library root contains them. Zero or several matches
 * means the owner is unknown, and an unknown owner is never deleted by a
 * Library-scoped operation.
 */
export function scopeIncludesFile(scope: DeletionScope, row: ScopedFileRow): boolean {
  if (scope.kind === "all-libraries") return true;
  if (row.library_id != null) {
    return Number(row.library_id) === scope.libraryId;
  }
  const owners = librariesOwningPath(row.file_path);
  return owners.length === 1 && owners[0] === scope.libraryId;
}


/**
 * Prove a resolved filesystem path sits inside the configured root of the exact
 * Library being deleted from.
 *
 * `library_id` alone is not proof. A row can be stale (the Library root moved),
 * corrupt, or point outside every managed root entirely, and a scoped deletion
 * must never remove a file it cannot place inside the target root. Fails closed:
 * an unknown or ambiguous root yields false.
 */
export function pathIsInsideScopeRoot(scope: DeletionScope, resolvedPath: string): boolean {
  const normalizedPath = normalizeComparablePath(resolvedPath);
  if (!normalizedPath) return false;

  const roots = scope.kind === "all-libraries"
    ? (db.prepare("SELECT root_path FROM Libraries WHERE enabled = 1")
        .all() as Array<{ root_path: string }>).map((row) => row.root_path)
    : (db.prepare("SELECT root_path FROM Libraries WHERE id = ?")
        .all(scope.libraryId) as Array<{ root_path: string }>).map((row) => row.root_path);

  const configuredRoots = roots
    .map((root) => normalizeComparablePath(root))
    .filter((root) => root.length > 0);

  // No Library rows at all: the installation has no Library boundary yet, so
  // fall back to the configured media roots the paths were resolved against.
  const candidateRoots = configuredRoots.length > 0
    ? configuredRoots
    : (["music", "spatial", "videos"] as const)
      .map((key) => normalizeComparablePath(getCurrentLibraryRootPath(key)))
      .filter((root) => root.length > 0);

  return candidateRoots.some((root) =>
    normalizedPath === root || normalizedPath.startsWith(`${root}/`));
}

export function describeScope(scope: DeletionScope): string {
  return scope.kind === "all-libraries" ? "all libraries" : `library ${scope.libraryId}`;
}
