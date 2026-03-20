# Discogenius Agent Quick Reference Card

**Use this card as a checklist when implementing features**

---

## Before Writing Code: Pattern Decision Tree

### Am I adding a UI component?
```
Is it a visual status/badge/alert?
  YES → Check `app/src/components/ui/` for library components
    Found existing pattern? USE IT
    New pattern (3+ uses planned)? ADD TO LIBRARY
    One-off? Keep in page/component
    
  NO → Is it reusable across pages?
    YES → Extract to `app/src/components/[Feature]/`
    NO → Keep in page component
```

### Am I handling loading/empty/error states?
```
YES → Use ContentState components:
  - LoadingState: spinner + label
  - EmptyState: icon + title + description + actions
  - ErrorState: error icon + message
  
  Import from @/components/ui/ContentState
```

### Am I fetching or paginating data?
```
Need pagination?
  YES → Use useInfiniteScroll hook:
    1. Create containerRef + sentinelRef
    2. Implement onLoadMore() callback
    3. Track hasMore + isLoading
    4. Call hook with these props
    
Need complex state mgmt?
  YES → Create custom hook in `app/src/hooks/use*.ts`
    - Manage state + effects
    - Export hook + type definitions
    - Import and use in component
```

### Am I styling something?
```
NO INLINE STYLES, EVER.

Use Fluent tokens:
  - colors: tokens.colorNeutralBackground1, tokens.colorPaletteRedForeground1
  - spacing: tokens.spacingVerticalM, tokens.spacingHorizontalS
  - fonts: tokens.fontSizeBase100, tokens.fontWeightBold
  - shadows: tokens.shadow4, tokens.shadow16
  
Use makeStyles + mergeClasses:
  const useStyles = makeStyles({ root: { ... }, hover: { ":hover": { ... } } })
  <div className={mergeClasses(styles.root, styles.hover)} />
```

### Am I checking monitor state?
```
Need to check if monitored/locked?
  Use monitoringUtils:
    import { isMonitorLocked, isMonitored } from '@/utils/monitoringUtils'
    isMonitorLocked(item)  // Returns boolean
    isMonitored(item)      // Returns boolean (monitored AND not locked)
```

---

## Backend: Pattern Decision Tree

### Am I accepting HTTP input?
```
Validate in this order:
  1. getObjectBody(req.body)           → ensure it's an object
  2. getRequired*/getOptional*()        → extract fields with type checking
  3. rejectUnknownKeys()                → whitelist validation
  
  throw RequestValidationError on violation (not Error)
```

### Am I calling external data (API response, CLI output)?
```
Parse immediately at boundary:
  const data = parseUserDataContract(rawData)
  OR
  expectString(obj.field, "field")
  expectNumber(obj.count, "count")
  
  Never: const result = rawData as UserType
```

### Am I accessing the database?
```
Use repository pattern:
  class MyRepository extends BaseRepository<T, TId> {
    findById(id) { /* prepared statement */ }
  }
  
For multi-statement operations:
  this.transaction(() => {
    db.prepare("INSERT...").run(...);
    db.prepare("UPDATE...").run(...);
  })
  
Rows from DB are `unknown` → parse before use
```

### Am I doing long-running work?
```
NEVER RUN INLINE IN ROUTE.

Queue job in TaskQueueService:
  const jobId = TaskQueueService.queue('JobType', payload);
  res.json({ jobId }, 202);  // Return 202 Accepted
  
Job will be processed by scheduler/download-processor in background
```

### Am I returning an error?
```
Always use sendError helper:
  sendError(res, 400, "Validation failed");
  sendError(res, 404, "Not found");
  sendError(res, 500, "Internal error", detail);
  
Format: { error: string, detail?: string }
Never: res.json({ message: ... })
```

### Am I returning success?
```
Use sendSuccess helper:
  sendSuccess(res, data);        // 200
  sendSuccess(res, data, 201);   // Custom status
  
Format: Raw data (no wrapper)
```

---

## Common Imports (Copy-Paste Friendly)

### Frontend: UI Components
```typescript
import { Badge, Text, Button, Card, tokens, makeStyles, mergeClasses } from "@fluentui/react-components";
import { Icon24Filled, Icon24Regular } from "@fluentui/react-icons";
import { LoadingState, EmptyState, ErrorState } from "@/components/ui/ContentState";
import { DownloadedBadge, MissingBadge } from "@/components/ui/StatusBadges";
import { QualityBadge } from "@/components/ui/QualityBadge";
```

### Frontend: Utilities & Hooks
```typescript
import { isMonitorLocked, isMonitored } from "@/utils/monitoringUtils";
import { dispatchLibraryUpdated, LIBRARY_UPDATED_EVENT } from "@/utils/appEvents";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { useGlobalEvents } from "@/hooks/useGlobalEvents";
import { api } from "@/services/api";
```

### Backend: Validation
```typescript
import { RequestValidationError, getObjectBody, getRequiredString, rejectUnknownKeys } from "@/utils/request-validation";
import { expectString, expectNumber, expectRecord } from "@/contracts/runtime";
import { sendError, sendSuccess } from "@/utils/response";
```

### Backend: Database
```typescript
import { db } from "@/database";
import { BaseRepository } from "@/repositories";
import { TaskQueueService } from "@/services/queue";
```

---

## Red Flags: Catch These Patterns

### Frontend 🚩
- ❌ `style={{ color: "blue" }}` → use `tokens.colorBlueBackground2`
- ❌ `content === "loading" ? <Spinner /> : content` → use `<LoadingState />`
- ❌ Third-party UI library import → use Fluent UI only
- ❌ `const lock = item.monitor_lock ?? item.monitor_locked` → use `isMonitorLocked(item)`
- ❌ Same intersectionObserver code 2+ times → extract to hook
- ❌ Duplicated badge styling → move to ui/ library

### Backend 🚩
- ❌ `const user = data as User;` → use `parseUserContract(data)`
- ❌ `res.json({ message: "error" })` → use `sendError(res, 400, "error")`
- ❌ Long-running code in route handler → queue job
- ❌ No validation of req.body → use getRequired*/getOptional*
- ❌ Accessing db without transaction for multi-statement → use `this.transaction()`
- ❌ Inline if/throw for validation → extract to validator

---

## Checklist: Before Committing Code

### Frontend
- [ ] All colors use `tokens.*` or `tidalBadgeColor.*`
- [ ] All spacing uses `tokens.spacing*`
- [ ] No inline `style` prop (only `className` with makeStyles)
- [ ] Responsive layouts use `"@media"` in makeStyles
- [ ] Reusable UI components in `ui/` folder
- [ ] Page-specific components in `/components/[Feature]/`
- [ ] Loading/empty/error states use ContentState components
- [ ] Monitor checks use monitoringUtils helpers
- [ ] Pagination uses useInfiniteScroll hook
- [ ] Types exported alongside hooks
- [ ] Event dispatches for cross-component communication

### Backend
- [ ] All HTTP input validated with request-validation helpers
- [ ] All external data (API/CLI) parsed with contract validators
- [ ] Request errors throw RequestValidationError
- [ ] API responses use sendError/sendSuccess helpers
- [ ] Database operations use repository pattern
- [ ] Multi-statement DB work wrapped in transaction
- [ ] Long-running work queued (not inline in routes)
- [ ] Job payloads are discriminated unions
- [ ] Service separation by domain (not layer)
- [ ] No `any` types without explicit reason
- [ ] Errors logged with full context

### Both
- [ ] TypeScript compiles with zero errors
- [ ] ESLint passes (`yarn lint`)
- [ ] No duplicated logic (extract if 3+ uses)
- [ ] New pattern documented if it's the first of its kind
- [ ] Architecture boundaries preserved
- [ ] Code follows established naming conventions

---

## Key File Locations

| Need | File(s) |
|------|---------|
| Badge components | `app/src/components/ui/StatusBadges.tsx`, `QualityBadge.tsx`, `ExplicitBadge.tsx` |
| Content states | `app/src/components/ui/ContentState.tsx` |
| Monitoring utils | `app/src/utils/monitoringUtils.ts` |
| Infinite scroll hook | `app/src/hooks/useInfiniteScroll.ts` |
| Global events | `app/src/utils/appEvents.ts`, `useGlobalEvents.ts` |
| Fluent theme | `app/src/theme/theme.ts` |
| Request validation | `api/src/utils/request-validation.ts` |
| Contract validation | `api/src/contracts/runtime.ts` |
| Response helpers | `api/src/utils/response.ts` |
| Base repository | `api/src/repositories/BaseRepository.ts` |
| Task queue | `api/src/services/queue.ts` |
| Download processor | `api/src/services/download-processor.ts` |
| Scanner | `api/src/services/scanner.ts` |
| Organizer | `api/src/services/organizer.ts` |

---

## One-Liners for Common Tasks

### Add a badge to a page
```typescript
import { DownloadedBadge } from "@/components/ui/StatusBadges";
// In JSX:
{track.downloaded && <DownloadedBadge />}
```

### Check if monitored/locked
```typescript
import { isMonitorLocked, isMonitored } from "@/utils/monitoringUtils";
if (isMonitorLocked(item)) { /* intentionally excluded */ }
```

### Show loading/empty/error state
```typescript
import { LoadingState, EmptyState } from "@/components/ui/ContentState";
{loading ? <LoadingState /> : items.length === 0 ? <EmptyState /> : <ItemList />}
```

### Validate HTTP request input
```typescript
const { id } = getObjectBody(req.body);
const artistId = getRequiredInteger(body, "artistId");
```

### Validate external data response
```typescript
const artist = parseArtistContract(apiResponse);
const count = expectNumber(obj.count, "count");
```

### Return API error
```typescript
if (!item) return sendError(res, 404, "Item not found");
```

### Queue background job
```typescript
const jobId = TaskQueueService.queue("RefreshArtist", { artistId });
sendSuccess(res, { jobId }, 202);
```

### Search for pattern in code
```bash
# Find all `async function` in services
grep -r "async function" api/src/services/

# Find all inline styles
grep -r "style={{" app/src/

# Find all hardcoded colors
grep -r "#[0-9a-f]\{6\}" app/src/
```

---

## When in Doubt

1. **Check existing code** for similar feature → copy patterns
2. **Read AGENT_PATTERNS_GUIDE.md** for detailed explanation
3. **Run `yarn lint`** to catch style issues
4. **Run `yarn build`** to catch TypeScript errors
5. **Type errors?** → Use contract validators at boundaries
6. **Styling looks wrong?** → Use _tokens_ not colors
7. **UI duplicated?** → Extract to component library
8. **Large component?** → Extract helpers to hooks/utils
9. **Long route?** → Move logic to service layer

---

**Last Updated**: March 21, 2026  
**Version**: v1.0.6 patterns reference  
**Full Guide**: See `docs/AGENT_PATTERNS_GUIDE.md` and `docs/AUDIT_SUMMARY_FOR_AGENTS.md`
