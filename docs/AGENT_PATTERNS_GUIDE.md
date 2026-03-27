# Discogenius Agent Patterns & Implementation Guide

**Last Updated**: March 26, 2026  
**Status**: Post v1.0.6 code quality refactoring analysis  
**Purpose**: Comprehensive reference for agents building features that align with established patterns

## Quick Reference: Common Implementation Patterns

### When You Need To... (Pattern Reference)

| Task | Primary Pattern | Key Files | Example |
|------|-----------------|-----------|---------|
| Add status display (loading/empty/error) | ContentState + LoadingSkeletons | `app/src/components/ui/{ContentState,LoadingSkeletons}.tsx` | LoadingState/EmptyState/ErrorState + CardGridSkeleton/DataGridSkeleton |
| Add a badge (quality, downloaded, explicit) | Badge library in ui/ | `app/src/components/ui/{QualityBadge,StatusBadges,ExplicitBadge}.tsx` | Always use Fluent props + tokens |
| Extract duplicated UI check | Utility function | `app/src/utils/monitoringUtils.ts` | `isMonitorLocked()`, `isMonitored()` |
| Paginate/scroll through lists | useInfiniteScroll hook | `app/src/hooks/useInfiniteScroll.ts` | Set up containerRef, sentinelRef, onLoadMore |
| Manage complex stateful logic | Custom hook | `app/src/hooks/use*.ts` | Export types alongside hook |
| Validate HTTP request input | Request validation | `api/src/utils/request-validation.ts` | `getRequiredString()`, `rejectUnknownKeys()` |
| Validate external data (HTTP/CLI) | Contract parsers | `api/src/contracts/runtime.ts` | `expectString()`, `expectNumber()` at boundary |
| Return API errors | Response helpers | `api/src/utils/response.ts` | `sendError(res, 400, "message")` |
| Queue long-running work | Task Queue Service | `api/src/services/queue.ts` | Don't inline jobs in routes |
| Coordinate multiple linked jobs | Scheduler | `api/src/services/scheduler.ts` | DownloadMissing, RefreshMetadata, CurateArtist |
| Listen for library changes | Global event system | `app/src/utils/appEvents.ts` | `dispatchLibraryUpdated()`, `useGlobalEvents()` |
| Optimize monitor state feedback | Optimistic updates | `app/src/utils/appEvents.ts` | `setOptimisticMonitorState()` |
| Theme colors and spacing | Fluent tokens | `@fluentui/react-components` + `app/src/theme/theme.ts` | Never inline colors; use `tokens.*` |
| Database operations | BaseRepository + transaction | `api/src/repositories/` | `this.transaction(() => { ... })` |

---

## Frontend Patterns

### 1. Component Library (ui/ Directory)

**Location**: `app/src/components/ui/`

**Purpose**: Centralized, reusable Fluent Design components

**Current Components**:
- **QualityBadge.tsx**: LOSSLESS, HIRES_LOSSLESS, DOLBY_ATMOS
- **StatusBadges.tsx**: DownloadedBadge, MissingBadge
- **ExplicitBadge.tsx**: Explicit label badge
- **ContentState.tsx**: LoadingState, EmptyState, ErrorState
- **LoadingSkeletons.tsx**: CardGridSkeleton, DataGridSkeleton, TrackTableSkeleton, MediaDetailSkeleton
- **ExplicitBadge.tsx, MediaTypeBadge.tsx, WarningBadge.tsx**

**Pattern Rules**:
1. All badges use `size="small"` (24px height) for table cells
2. Color = Fluent token OR predefined custom (e.g., `tidalBadgeColor.YellowBackground`)
3. appearance = "filled" for status, "outline" for metadata
4. No inline styles; all styling via makeStyles + tokens

**Example** (adding a new badge):
```typescript
import { Badge, tokens, makeStyles } from "@fluentui/react-components";

export const NewStatusBadge = () => (
  <Badge size="small" appearance="filled" color="success">
    New Status
  </Badge>
);
```

**When to Use**:
- Any repeated visual element (badges, status indicators, form states)
- Shared styling across multiple pages
- Brand-consistent colors/typography

**When Not to Use**:
- One-off UI that won't repeat
- Complex interactive components (those go in `/components` with behaviors)

---

### 2. Content States and Skeleton Loading

**Location**: `app/src/components/ui/ContentState.tsx`

**Purpose**: Standardized fallback states for pages/sections

**Components**:
- `LoadingState`: spinner + label
- `EmptyState`: icon + title + description + actions
- `ErrorState`: error icon + error message (extractable to text)
- `LoadingSkeletons`: shape-preserving loading placeholders for list/detail surfaces

**When to Use Which**:
- Use `LoadingState` for simple blocking states where preserving list/detail layout is not important.
- Use `LoadingSkeletons` (`CardGridSkeleton`, `DataGridSkeleton`, `TrackTableSkeleton`, `MediaDetailSkeleton`) for library grids/tables, detail pages, and suspense fallbacks where layout continuity matters.

**Required Props**:
- To all: `minHeight` (default 240px), `className`, `panelClassName`, `align` ("center"|"left")
- To EmptyState: `icon`, `title`, `description`, optional `actions`
- To ErrorState: `error` (Error | string | null)

**Example Usage**:
```typescript
{loading ? (
  <LoadingState label="Loading tracks..." />
) : tracks.length === 0 ? (
  <EmptyState 
    icon={<EmptySvg />}
    title="No tracks found"
    description="Add tracks to get started"
  />
) : (
  <TrackList tracks={tracks} />
)}
```

**Pattern**: Replace inline conditionals with ContentState components for consistency

---

### 3. Custom Hooks (useInfiniteScroll, useLibrary, etc.)

**Location**: `app/src/hooks/use*.ts`

**Purpose**: Encapsulate complex stateful logic, manage pagination, API polling

**Key Hooks**:

#### useInfiniteScroll
**Purpose**: Automatic pagination via IntersectionObserver  
**Required Options**: `containerRef`, `sentinelRef`, `hasMore`, `isLoading`, `onLoadMore()`  
**Optional**: `rootMargin` (default "0px 0px 400px 0px"), `enabled` (default true)

**Example**:
```typescript
const containerRef = useRef(null);
const sentinelRef = useRef(null);
const [page, setPage] = useState(0);
const [items, setItems] = useState([]);

useInfiniteScroll({
  containerRef,
  sentinelRef,
  hasMore: items.length < total,
  isLoading: loading,
  onLoadMore: async () => {
    setLoading(true);
    const newItems = await api.getItems(page + 1);
    setItems([...items, ...newItems]);
    setPage(page + 1);
    setLoading(false);
  }
});

return (
  <div ref={containerRef} style={{ maxHeight: "600px", overflow: "auto" }}>
    {items.map(item => <ItemCard key={item.id} item={item} />)}
    <div ref={sentinelRef} style={{ height: "1px" }} />
  </div>
);
```

**Pattern**: Container must have `overflow: auto` or max-height; sentinel element triggers load

#### useLibrary
**Purpose**: Manage multi-tab library state (artists/albums/tracks/videos) with filters, sorting, pagination  
**Returns**: Artists, albums, stats, filter state, sort state, load functions  
**Key Features**: Persists sort preference to localStorage; propagates monitored/downloaded/locked list filters to tab-specific fetches

**Example**:
```typescript
const {
  artists, setArtists, loadMoreArtists, hasMoreArtists,
  albums, setAlbums, loadMoreAlbums, hasMoreAlbums,
  stats, artistMonitoredFilter, setArtistMonitoredFilter,
  listSort, setListSort
} = useLibrary({ activeTab: 'artists' });
```

**Pattern**: Export types alongside hook definition for page component reuse

**Helper Pattern**: Persisted settings via localStorage
```typescript
const loadPersistedLibrarySettings = (): { sort, dir } | null => {
  try {
    const saved = localStorage.getItem('key');
    return JSON.parse(saved);
  } catch (e) {
    console.warn('[Hook] Failed to load:', e);
    return null;
  }
};

const [state, setState] = useState(() => 
  loadPersistedLibrarySettings() ?? DEFAULT
);
```

**Pattern**: Always wrap localStorage access in try/catch

---

### 4. Global Event System (Dispatch-Based Communication)

**Location**: `app/src/utils/appEvents.ts`, `app/src/hooks/useGlobalEvents.ts`

**Purpose**: Cross-component communication without prop drilling

**Available Events**:
- `LIBRARY_UPDATED_EVENT`: Library content changed (artist/album/track added/removed)
- `MONITOR_STATE_CHANGED_EVENT`: Item monitor/lock state changed (with detail: type, tidalId, monitored)
- `ACTIVITY_REFRESH_EVENT`: Activity queue needs refresh
- `OPEN_ACTIVITY_QUEUE_EVENT`: Request open activity queue UI
- `OPEN_SEARCH_EVENT`: Request open search UI

**Pattern** (Dispatch):
```typescript
import { dispatchLibraryUpdated, setOptimisticMonitorState } from '@/utils/appEvents';

// When monitor state changes:
setOptimisticMonitorState({ type: 'track', tidalId: '123', monitored: true });
api.updateMonitor(...); // async
dispatchMonitorStateChanged({ type: 'track', tidalId: '123', monitored: true });
```

**Pattern** (Listen):
```typescript
const { events } = useGlobalEvents();

useEffect(() => {
  const handleLibraryUpdate = () => {
    console.log('Library changed, refetch...');
  };
  window.addEventListener(LIBRARY_UPDATED_EVENT, handleLibraryUpdate);
  return () => window.removeEventListener(LIBRARY_UPDATED_EVENT, handleLibraryUpdate);
}, []);
```

**Optimization**: Optimistic update pattern
1. Call `setOptimisticMonitorState()` immediately (instant UI feedback)
2. Make API request in background
3. On success: dispatch event (confirms optimistic state)
4. On error: call `clearOptimisticMonitorState()` (reverts UI)

---

### 5. Fluent UI Integration Patterns

**Core Pattern**: makeStyles + tokens + mergeClasses

```typescript
import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  desktop: {
    display: "none",
    "@media (min-width: 768px)": {
      display: "table",
    },
  },
  expandableCell: {
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusSmall,
  },
  label: {
    fontWeight: tokens.fontWeightBold,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
  },
});

export const MyComponent = () => {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <h1 className={styles.label}>Title</h1>
      <table className={mergeClasses(styles.desktop, styles.expandableCell)}>
        {/* ... */}
      </table>
    </div>
  );
};
```

**Key Rules**:
1. Never use inline `style={{ color: '#fff' }}`; use tokens
2. Responsive layouts via `"@media (min-width: Xpx)"`
3. Hover/focus states via `":hover"` and `":focus"` selectors
4. Use `mergeClasses()` for conditional class application
5. Import icons from `@fluentui/react-icons` (pattern: `Icon24Regular` or `Icon24Filled`)

**Tokens to Know**:
- **Colors**: `colorNeutralBackground1`, `colorNeutralForeground1`, `colorPaletteRedForeground1`, etc.
- **Spacing**: `spacingHorizontalS`, `spacingVerticalM`, `spacingHorizontalXXS`
- **Typography**: `fontSizeBase100`, `fontWeightBold`, `fontFamilyBase`
- **Duration**: `durationNormal`, `durationUX` (for animations)
- **Shadows**: `shadow2`, `shadow4`, `shadow8`, `shadow16`
- **Border Radius**: `borderRadiusSmall`, `borderRadiusMedium`, `borderRadiusLarge`

---

### 6. Monitoring State Utilities

**Location**: `app/src/utils/monitoringUtils.ts`

**Purpose**: Centralize monitor/lock state checks

**Available Functions**:
```typescript
export const isMonitorLocked = (item: Monitorable): boolean;
export const isMonitored = (item: Monitorable & { is_monitored? }): boolean;
```

**Interface**:
```typescript
interface Monitorable {
  monitor_locked?: boolean;  // new
  monitor_lock?: boolean;    // legacy fallback
  is_monitored?: boolean;
}
```

**Usage**:
```typescript
import { isMonitorLocked, isMonitored } from '@/utils/monitoringUtils';

// Instead of: Boolean(item.monitor_locked ?? item.monitor_lock)
if (isMonitorLocked(item)) {
  // Item is intentionally excluded from monitoring
}

if (isMonitored(item)) {
  // Item is actively monitored and not locked
}
```

**Pattern**: Custom function if same check appears 3+ times

---

## Backend Patterns

### 1. Request Input Validation

**Location**: `api/src/utils/request-validation.ts`

**Error Class**: 
```typescript
export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}
```

**Helper Functions**:
- `getObjectBody(body, message?)`: Ensure request is JSON object
- `getRequiredString(body, key)`: Extract and validate required string
- `getOptionalString(body, key)`: Extract optional string (undefined if missing)
- `getRequiredInteger(body, key)`: Extract and validate required integer
- `getOptionalInteger(body, key)`: Extract optional integer
- `getOptionalBoolean(body, key)`: Extract optional boolean
- `rejectUnknownKeys(body, allowedKeys, label?)`: Whitelist validation

**Pattern** (Route Handler):
```typescript
router.post('/endpoint', (req, res) => {
  try {
    const body = getObjectBody(req.body);
    const artistId = getRequiredString(body, 'artistId');
    const monitored = getOptionalBoolean(body, 'monitored');
    
    rejectUnknownKeys(body, ['artistId', 'monitored']);
    
    // Process request
    res.json({ success: true });
  } catch (error: any) {
    if (error instanceof RequestValidationError) {
      return sendError(res, 400, error.message);
    }
    console.error('[Route] Unexpected error:', error);
    sendError(res, 500, 'Internal server error');
  }
});
```

**Pattern**: Validate at route entry; throw RequestValidationError

---

### 2. Contract/External Data Validation

**Location**: `api/src/contracts/runtime.ts` (and contracts/ subdirectory)

**Purpose**: Validate HTTP responses, CLI output, database rows at system boundaries

**Helper Functions**:
- `expectString(value, label)`: Throw if not string
- `expectNumber(value, label)`: Throw if not finite number
- `expectBoolean(value, label)`: Throw if not boolean
- `expectIdentifierString(value, label)`: Accept string or number identifier
- `expectOptionalString(value, label)`: Return undefined if null/undefined, else expectString
- `expectNullableString(value, label)`: Accept null | undefined | string
- `expectArray<T>(value, label, parser)`: Parse array with per-item parser
- `expectRecord(value, label)`: Ensure value is object

**Pattern** (Parsing External Data):
```typescript
import {
  expectString,
  expectNumber,
  expectOptionalString,
  expectArray,
} from "@contracts/runtime.js";

export function parseDownloadJobPayload(payload: unknown) {
  const obj = expectRecord(payload, "JobPayload");
  return {
    tidalId: expectString(obj.tidalId, "tidalId"),
    mediaType: expectString(obj.mediaType, "mediaType"),
    quality: expectOptionalString(obj.quality, "quality"),
    tags: expectArray(obj.tags, "tags", (tag, index) =>
      expectString(tag, `tags[${index}]`)
    ),
  };
}
```

**Error Format**: Throws `Error("label must be X")` for consistency

**Pattern**: Every external boundary gets parsed

---

### 3. API Response Pattern

**Location**: `api/src/utils/response.ts`

**Standardized Format**:
- **Error**: `{ error: string, detail?: string }`
- **Success**: Raw data (no wrapper)

**Helpers**:
```typescript
export function sendError(
  res: Response, 
  status: number, 
  error: string, 
  detail?: string
): void

export function sendSuccess<T>(
  res: Response, 
  data: T, 
  status = 200
): void
```

**Usage**:
```typescript
router.post('/update', (req, res) => {
  try {
    // validation...
    const result = await service.update(...)
    sendSuccess(res, result, 201);
  } catch (error: any) {
    if (error instanceof ValidationError) {
      sendError(res, 400, error.message);
    } else {
      sendError(res, 500, 'Internal error', error.message);
    }
  }
});
```

**Pattern**: Always use helpers for consistency

---

### 4. Database Repository Pattern

**Location**: `api/src/repositories/`

**Base Class**:
```typescript
export abstract class BaseRepository<T, TId extends EntityId = number> {
  constructor(protected db: Database.Database) { }
  
  protected prepare(sql: string) { /* ... */ }
  protected exec(sql: string) { /* ... */ }
  protected transaction<R>(fn: () => R): R { /* ... */ }
  
  abstract findById(id: TId): T | undefined;
  abstract findAll(limit?: number, offset?: number): T[];
  abstract count(): number;
  abstract delete(id: TId): void;
}
```

**Pattern** (Extending Base):
```typescript
export class ArtistRepository extends BaseRepository<Artist, number> {
  findById(id: number): Artist | undefined {
    return this.prepare('SELECT * FROM artists WHERE id = ?').get(id) as Artist | undefined;
  }

  findAll(limit?: number, offset?: number): Artist[] {
    const sql = 'SELECT * FROM artists LIMIT ? OFFSET ?';
    return this.prepare(sql).all(limit ?? -1, offset ?? 0) as Artist[];
  }

  findByName(name: string): Artist[] {
    return this.prepare(
      'SELECT * FROM artists WHERE name LIKE ?'
    ).all(`%${name}%`) as Artist[];
  }

  insert(artist: Omit<Artist, 'id'>): number {
    return this.transaction(() => {
      const result = this.prepare(
        'INSERT INTO artists (name, ...) VALUES (?, ...)'
      ).run(artist.name, ...);
      return result.lastInsertRowid as number;
    });
  }

  delete(id: number): void {
    this.prepare('DELETE FROM artists WHERE id = ?').run(id);
  }
}
```

**Transaction Pattern**:
```typescript
this.transaction(() => {
  // Multiple statements, atomic
  this.prepare('INSERT INTO ...').run(...);
  this.prepare('UPDATE ...').run(...);
  // Auto-rollback on error
});
```

**Key Insight**: `better-sqlite3` is synchronous; no async/await needed

---

### 5. Service Architecture

**Location**: `api/src/services/`

**Principle**: Service per domain concern (not per layer)

**Key Service Categories**:

#### Download Backend Services
- **orpheus.ts**: Music downloads (album, track, playlist)
  - Exports: `ensureOrpheusRuntime()`, `spawnOrpheusDownload()`, `parseOrpheusProgress()`
  - Pattern: Bootstrap runtime, spawn child process, parse progress JSON
- **tidal-dl-ng.ts**: Video downloads
  - Exports: `getTidalDlNgCommand()`, `buildTidalDlNgEnv()`, `parseProgress()`, `initializeSettings()`
  - Pattern: CLI wrapper around external tool

#### Queue & Job Management
- **queue.ts**: SQLite job queue
  - Exports: `TaskQueueService`, job type definitions
  - Pattern: `queue(type, payload)`, `listJobs()`, `getById()`, `updateJob()`
- **command.ts**: Command exclusivity (Lidarr-style)
  - Pattern: Type-exclusive vs disk-intensive vs globally exclusive
- **scheduler.ts**: Non-download orchestration
  - Jobs: DownloadMissing, RefreshMetadata, CurateArtist, RescanFolders, ApplyRenames, ApplyRetags

#### Scanning & Import
- **scanner.ts**: TIDAL metadata fetching
  - Exports: `scanAlbumShallow()`, `seedTrack()`, `seedVideo()`
  - Tiers: BASIC (IDs only) → SHALLOW (metadata) → DEEP (full scan)
- **import-discovery.ts**: Local file scanning
  - Exports: Group unmapped files into import candidates
- **import-matcher-service.ts**: TIDAL candidate scoring
  - Exports: Score candidates via fuzzy matching, fingerprinting, or direct ID
- **import-service.ts**: Orchestrate discovery → match → apply → finalize
- **manual-import-apply-service.ts**: Apply strict manual mappings
- **import-finalize-service.ts**: Move staged files, update library metadata

#### File Organization
- **organizer.ts**: Stage → library placement
  - Exports: `organize()` returns OrganizeResult (success/failure per file)
- **library-files.ts**: Canonical inventory
  - Exports: Insert/update library_files with sidecar tracking
- **library-scan-*.ts**: Root folder scanning and repair

#### Monitoring & Curation
- **task-state.ts**: Runtime progress tracking
- **schedule-policy.ts**: Time-window/staleness policies, include-decision logic
- **curation.listener.ts**: Listen to curation events, queue downloads
- **artist-monitoring.ts**: Artist-specific monitoring decisions

**Pattern**: Service exports concrete functions, not a class constructor

**Example Service**:
```typescript
// organizer.ts
export interface OrganizeResult {
  success: boolean;
  sourcePath: string;
  destinationPath?: string;
  error?: string;
}

export async function organize(filePath: string): Promise<OrganizeResult> {
  try {
    const metadata = await readMetadata(filePath);
    const destination = buildLibraryPath(metadata);
    await moveFile(filePath, destination);
    await updateLibraryFiles(destination);
    return { success: true, sourcePath: filePath, destinationPath: destination };
  } catch (error) {
    return { success: false, sourcePath: filePath, error: error.message };
  }
}
```

---

### 6. Job Payload Typing

**Location**: `api/src/services/job-payloads.ts`

**Pattern**: Discriminated unions for type-safe routing

```typescript
export interface DownloadTrackJobPayload extends BaseJobPayload {
  type: 'DownloadTrack';
  tidalId: string;
  quality: AudioQualityValue;
  albumId: string;
}

export interface DownloadVideoJobPayload extends BaseJobPayload {
  type: 'DownloadVideo';
  tidalId: string;
  quality: VideoQualityValue;
}

export type DownloadJobPayload = 
  | DownloadTrackJobPayload 
  | DownloadVideoJobPayload 
  | DownloadAlbumJobPayload 
  | DownloadPlaylistJobPayload;
```

**Usage in Route**:
```typescript
const payload: DownloadJobPayload = job.payload;

// Type-safe switch
if (payload.type === 'DownloadTrack') {
  // payload is narrowed to DownloadTrackJobPayload
  const { tidalId, quality, albumId } = payload;
}
```

---

### 7. Error Handling Pattern

**Backend Rules**:
1. Validate input at route entry (throw RequestValidationError)
2. Validate external data at service boundary (throw Error with descriptive message)
3. Catch all errors in route handlers
4. Log full error to console (for debugging)
5. Send sanitized error to client (use sendError helper)

**Pattern**:
```typescript
router.post('/update', (req, res) => {
  try {
    // 1. Validate request input
    const body = getObjectBody(req.body);
    const id = getRequiredInteger(body, 'id');
    rejectUnknownKeys(body, ['id']);

    // 2. Call service (may throw)
    const result = service.update(id);

    // 3. Send success
    sendSuccess(res, result);
  } catch (error: any) {
    // 4. Log internally
    console.error('[Route] Error:', error);

    // 5. Send sanitized error
    if (error instanceof RequestValidationError) {
      sendError(res, 400, error.message);
    } else if (error instanceof NotFoundError) {
      sendError(res, 404, error.message);
    } else {
      sendError(res, 500, 'Internal server error');
    }
  }
});
```

---

## Testing Patterns

### Test File Structure

**Location**: `api/src/**/*.test.ts`  
**Framework**: Node.js `test` module (node:test) + `assert`

**Pattern**:
```typescript
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Setup: Temp directory for DB tests
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-"));
process.env.DB_PATH = path.join(tempDir, "test.db");

let module: typeof import("./module.js");

before(async () => {
  module = await import("./module.js");
  module.init();
});

after(() => {
  module.cleanup();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("feature: expected behavior", () => {
  const result = module.doSomething();
  assert.equal(result, expectedValue);
});

test("feature: error case", () => {
  assert.throws(
    () => module.doInvalid(),
    /expected error message/
  );
});
```

**Assertion Helpers**:
- `assert.equal(actual, expected)`: Strict equality
- `assert.deepEqual(obj1, obj2)`: Deep object comparison
- `assert.match(str, /regex/)`: Regex match
- `assert.throws(() => fn(), /error/)`: Error thrown with message match
- `assert.ok(value)`: Truthy check
- `assert.strictEqual(a, b)`: Same as equal

---

### Testing Patterns by Type

#### Contract Parsers
**Test valid payloads through parser, invalid payloads throw**:
```typescript
test("parseConfig contracts normalize expected shapes", () => {
  const appConfig = parsePublicAppConfigContract({ acoustid_api_key: "abc123" });
  assert.deepEqual(appConfig, { acoustid_api_key: "abc123" });

  assert.throws(
    () => parsePublicAppConfigContract({ acoustid_api_key: 123 }),
    /must be a string/
  );
});
```

#### Database Schema Migrations
**Test schema version progression**:
```typescript
test("initDatabase migrates schema correctly", () => {
  db.pragma("user_version = 1");
  module.initDatabase();

  const newVersion = db.pragma("user_version", { simple: true }) as number;
  assert.equal(newVersion, 2);
});
```

#### Service Logic
**Test isolated service function**:
```typescript
test("calculateQual returns expected quality for bitrate", () => {
  assert.equal(module.calculateQuality(320), "high");
  assert.equal(module.calculateQuality(1411), "lossless");
});
```

---

## Type Safety at Boundaries

### The Boundary Pattern

**Rule**: TypeScript types don't validate runtime data. You must validate explicitly.

**Boundaries** (Data comes from outside):
1. HTTP request body → use `request-validation.ts` helpers
2. HTTP response body → use `contracts/*.ts` parsers
3. CLI stdout → use `expectString()`, `expectNumber()`, etc.
4. Database rows → rows are `unknown`; parse to domain type
5. External API responses → parse with contract validator

**Non-Boundaries** (Within your code):
- Function return types
- Internal service calls
- React component props (within app tree)

**Example** (Bad):
```typescript
// ❌ NO: Type assertion without validation
const data = JSON.parse(apiResponse) as UserData;
```

**Example** (Good):
```typescript
// ✅ YES: Parse with validators
const data = parseUserDataContract(JSON.parse(apiResponse));
```

---

## Naming & Organization Conventions

### Backend File Structure

```
api/src/
├── routes/
│   ├── artists.ts       # GET/POST /api/artists
│   ├── albums.ts        # GET/POST /api/albums
│   └── [feature].ts     # One route per file
├── services/
│   ├── [domain]-[feature].ts
│   ├── download-processor.ts
│   ├── import-service.ts
│   └── queue.ts
├── repositories/
│   ├── BaseRepository.ts
│   ├── ArtistRepository.ts
│   └── AlbumRepository.ts
├── contracts/
│   ├── runtime.ts       # Parser helpers
│   ├── config.ts        # Config contracts
│   └── [domain].ts      # Domain-specific contracts
├── middleware/
│   └── auth.ts
└── utils/
    ├── request-validation.ts
    ├── response.ts
    └── [domain].ts
```

### Frontend File Structure

```
app/src/
├── pages/
│   ├── [section]/
│   │   └── [Feature].tsx
│   └── dashboard/
│       └── DashboardPage.tsx
├── components/
│   ├── ui/
│   │   ├── StatusBadges.tsx
│   │   ├── QualityBadge.tsx
│   │   ├── ContentState.tsx
│   │   └── [Element].tsx
│   ├── cards/
│   │   ├── ArtistCard.tsx
│   │   └── [Card].tsx
│   ├── [Feature].tsx
│   └── Layout.tsx
├── hooks/
│   ├── use[Domain].ts
│   ├── useLibrary.ts
│   ├── useInfiniteScroll.ts
│   └── use[Custom].ts
├── services/
│   └── api.ts
├── utils/
│   ├── appEvents.ts
│   ├── monitoringUtils.ts
│   ├── format.ts
│   └── [domain].ts
├── types/
│   └── [domain].ts
└── theme/
    └── theme.ts
```

### Naming Rules

| What | Pattern | Example |
|------|---------|---------|
| Backend route handler | `(req, res) =>` | `router.get('/:id', (req, res) => { ... })` |
| Backend service function | `verb + Noun` | `downloadTrack()`, `scanAlbum()`, `parseProgress()` |
| Backend type | `PascalCase` | `Artist`, `DownloadJobPayload`, `ScanResult` |
| Backend utility | `camelCase + description` | `isMonitorLocked()`, `formatBytes()` |
| frontend component | `PascalCase` | `TrackList`, `AlbumCard`, `DownloadedBadge` |
| Frontend hook | `use + PascalCase` | `useLibrary`, `useInfiniteScroll`, `useGlobalEvents` |
| Frontend utility | `camelCase` | `getTidalImage()`, `formatDuration()`, `isMonitored()` |
| Frontend event | `SCREAMING_SNAKE_CASE` | `LIBRARY_UPDATED_EVENT`, `MONITOR_STATE_CHANGED_EVENT` |
| Database table | `snake_case` | `library_files`, `unmapped_files` |
| Database column | `snake_case` | `monitor_locked`, `is_monitored` |

---

## Common Implementation Scenarios

### Scenario 1: Add New Status to Display

**Goal**: Show "Pending" status on track list

**Steps**:
1. Add `PendingBadge` to `app/src/components/ui/StatusBadges.tsx`
2. Import it in `TrackList.tsx`
3. Render conditionally: `{track.pending && <PendingBadge />}`

**Code**:
```typescript
// StatusBadges.tsx - add to existing file
export const PendingBadge = () => (
  <Badge size="small" appearance="filled" color="warning">
    Pending
  </Badge>
);

// TrackList.tsx
import { DownloadedBadge, MissingBadge, PendingBadge } from '@/components/ui/StatusBadges';

<div className={styles.badges}>
  {track.downloaded && <DownloadedBadge />}
  {!track.downloaded && !track.pending && <MissingBadge />}
  {track.pending && <PendingBadge />}
</div>
```

---

### Scenario 2: Add API Endpoint

**Goal**: Add `POST /api/artists/:id/refresh` to refresh artist metadata

**Steps**:
1. Add route handler to `api/src/routes/artists.ts`
2. Validate input (`getRequiredInteger`)
3. Call service (e.g., `await scanner.refreshArtist(id)`)
4. Queue job if async work
5. Return result via `sendSuccess(res, result)`

**Code**:
```typescript
// routes/artists.ts
router.post('/:id/refresh', (req, res) => {
  try {
    const artistId = parseInt(req.params.id, 10);
    if (Number.isNaN(artistId)) {
      return sendError(res, 400, 'Invalid artist ID');
    }

    // Queue refresh job (don't run inline)
    const jobId = TaskQueueService.queue('RefreshArtist', { artistId });

    sendSuccess(res, { jobId }, 202); // 202 Accepted
  } catch (error: any) {
    console.error('[artists/refresh] Error:', error);
    sendError(res, 500, 'Internal server error');
  }
});
```

---

### Scenario 3: Add Pagination Hook

**Goal**: List albums with infinite scroll

**Steps**:
1. Create hook: `useAlbums()` in `app/src/hooks/useAlbums.ts`
2. Manage albums array + page state + hasMore flag
3. Implement `loadMore()` that fetches next page
4. Export useAlbums + Album type
5. In component: use hook, render via useInfiniteScroll

**Code**:
```typescript
// hooks/useAlbums.ts
import { useState, useCallback } from 'react';
import { api } from '@/services/api';

export interface Album { /* ... */ }

export const useAlbums = () => {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const newAlbums = await api.getAlbums(page + 1);
      setAlbums([...albums, ...newAlbums]);
      setPage(page + 1);
      setHasMore(newAlbums.length > 0);
    } finally {
      setLoading(false);
    }
  }, [page, hasMore, loading]);

  return { albums, loading, hasMore, loadMore };
};

// pages/Library.tsx
import { useAlbums } from '@/hooks/useAlbums';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';

const Library = () => {
  const containerRef = useRef(null);
  const sentinelRef = useRef(null);
  const { albums, loading, hasMore, loadMore } = useAlbums();

  useInfiniteScroll({
    containerRef,
    sentinelRef,
    hasMore,
    isLoading: loading,
    onLoadMore: loadMore,
  });

  return (
    <div ref={containerRef} style={{ maxHeight: '600px', overflow: 'auto' }}>
      {albums.map(album => <AlbumCard key={album.id} album={album} />)}
      <div ref={sentinelRef} />
    </div>
  );
};
```

---

## Architecture Decision Log

### Why Service-Per-Domain (Not Layer-Per-Feature)

**Decision**: Organize services by domain concern (download, import, organize) not by layer (model, repository, service)

**Rationale**:
- Lidarr-aligned modularity
- Clear service contracts (download service owns all download logic)
- Easy to test service in isolation
- Easier to refactor within domain

**Example**:
```typescript
// Right: domain services
download-processor.ts   // All download execution
import-service.ts       // All import orchestration
organizer.ts            // All file organization

// Wrong: layer services
model.ts                // All models
repository.ts           // All DB access
service.ts              // All business logic (too large)
```

### Why Explicit Job Payloads (Not Dynamic)

**Decision**: Use strongly-typed job payloads with discriminated unions

**Rationale**:
- Type-safe job routing
- Clear what data is passed to each job
- Easier to refactor jobs safely
- IDE autocomplete for job handlers

---

## Updating This Guide

**When to Update**:
- New pattern emerges (3+ uses)
- Architecture decision changes approach
- Refactoring centralizes repeated code

**How to Update**:
1. Update this file with new pattern + example
2. Update corresponding `.github/skills/` SKILL.md if major
3. Document in architecture decision log
4. Reference in next code review/refactoring

**Sync with Session Memory**: Update `/memories/session/discogenius-audit-patterns.md` when major patterns change
