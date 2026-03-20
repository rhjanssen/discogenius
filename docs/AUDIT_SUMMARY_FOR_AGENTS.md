# Discogenius Codebase Audit Summary & Recommendations

**Date**: March 21, 2026  
**Analysis Scope**: Post v1.0.6 code quality refactoring  
**Target**: Agent/Skill development guidance

---

## Executive Summary

A comprehensive audit of the Discogenius codebase (v1.0.6) identified **strong architectural patterns** that agents should understand and follow. The codebase shows maturity in:

1. **Component library architecture** (StatusBadges, QualityBadge, ContentState)
2. **Type safety at boundaries** (contract validation, request validation)
3. **Service-domain organization** (clear separation of concerns)
4. **Hook-based state management** (useLibrary, useInfiniteScroll)
5. **Event-driven cross-component communication** (appEvents system)

**Key Finding**: Patterns are highly consistent; agents can significantly improve code quality by detecting when these patterns are not applied.

---

## Patterns Currently Documented

### Frontend Patterns ✅ Mature
- **Component Library (ui/)**: Reusable badges, content states
- **Custom Hooks**: Complex stateful logic (useLibrary, useInfiniteScroll, useArtistPage)
- **Global Events**: Cross-component dispatch (LIBRARY_UPDATED_EVENT, MONITOR_STATE_CHANGED_EVENT)
- **Fluent Design Integration**: Consistent token usage, responsive layouts
- **Monitoring Utilities**: Centralized monitor lock checks

### Backend Patterns ✅ Mature
- **Repository Pattern**: BaseRepository with transaction support
- **Request Validation**: Type-safe input extraction (getRequiredString, etc.)
- **Contract Validation**: Runtime parsing of external data
- **Response Standardization**: sendError/sendSuccess helpers
- **Service Architecture**: Domain-focused services (download, import, organize)
- **Job Payloads**: Discriminated unions for type-safe routing

### Testing Patterns ✅ Established
- **Test Structure**: Node.js test module + assert
- **Contract Testing**: Valid/invalid payload coverage
- **Database Testing**: Temp directory isolation, manual cleanup
- **Test Organization**: Under `api/src/**/*.test.ts`

---

## Patterns Needing Documentation

### TypeScript Discipline (CRITICAL)
**Current State**: Type safety at boundaries is strong (#1 pattern asset)

**Documentation Gap**:
- When to add explicit validation (every boundary)
- Real-world examples of boundary violations
- "Avoid casual `any`" checklist
- Type narrowing patterns

**Recommendation**: Create `docs/TYPESCRIPT_DISCIPLINE.md` with:
- External boundary checklist (HTTP, CLI, DB, filesystem)
- Validation helper selection guide
- Common mistakes + examples

### Service Boundaries (IMPORTANT)
**Current State**: Services organized by domain (download, import, organize)

**Documentation Gap**:
- When to split responsibilities
- How to model data flow between services
- Transaction patterns across services
- Error propagation

**Recommendation**: Expand `docs/ARCHITECTURE.md` with:
- Service responsibility matrix
- Data ownership model
- Service interaction patterns

### Error Handling (IMPORTANT)
**Current State**: Mostly console.error + sendError pattern

**Documentation Gap**:
- Error classification (validation vs runtime vs external)
- Logging levels and content
- User-facing vs internal errors
- Retry logic and backoff

**Recommendation**: Create `docs/ERROR_HANDLING.md` with:
- Error classification guide
- Logging checklist
- Retry decision tree

### Frontend Component Extraction (HIGH VALUE)
**Current State**: Large pages have opportunities for extraction

**Documentation Gap**:
- When to extract components from pages
- Component composition patterns
- Props drilling vs context guidelines
- Library vs page-specific components

**Recommendation**: Create component extraction checklist:
- If a component block > 100 lines → extract with props
- If styling is reused 2+ times → move to ui/ library
- If state is complex → extract to custom hook

### React Query Patterns (IMPORTANT)
**Current State**: useQuery/useMutation used sparingly

**Documentation Gap**:
- Caching strategy for library data
- Invalidation patterns
- Optimistic updates vs pessimistic
- Error retry configuration

**Recommendation**: Document in skills file:
- When to use useQuery vs custom hook
- Query key strategy (by page, by feature, global)
- Invalidation triggers (monitor state changes, etc.)

### Database Schema Patterns (MODERATE)
**Current State**: better-sqlite3 + WAL mode, pragma setup

**Documentation Gap**:
- Schema versioning strategy (working, but underdocumented)
- Column naming conventions (snake_case working, but not explicit)
- Foreign key enforcement
- Migration testing

**Recommendation**: Update `docs/ARCHITECTURE.md`:
- Schema version numbering (integer baseline, 1.0.x)
- Field naming conventions (monitor_locked vs is_monitored rationale)

---

## Key Findings: Code Quality Principles

### 1. **No Duplicate Logic**
**Rule**: If a pattern/check appears 3+ times, extract to util/component/hook

**Current Examples**:
- `isMonitorLocked()` extracted to monitoringUtils.ts (was duplicated 8+ times)
- StatusBadges library (was duplicated across pages)
- useInfiniteScroll hook (was duplicated 4 times in Library.tsx)

**Action**: Agents should detect patterns in:
- UI state checks (e.g., `item.monitor_locked ?? item.monitor_lock`)
- String formatting (e.g., `formatBytes`, `formatDuration`)
- Conditional renders (e.g., `loading ? <Spinner /> : <Content />`)

### 2. **Fluent Design Consistency**
**Rule**: All UI components use Fluent v9 tokens + makeStyles; never inline styles

**Current Implementation**:
- badges use Fluent colors: `backgroundColor: tokens.colorNeutralBackground3`
- spacing via tokens: `gap: tokens.spacingVerticalM`
- responsive via media queries: `"@media (min-width: 768px)"`

**Common Mistakes** (to flag):
- `style={{ color: '#fff' }}` instead of `tokens.colorNeutralForeground1`
- Inline `fontSize: '12px'` instead of `tokens.fontSizeBase100`
- Hardcoded spacing instead of tokens

### 3. **Type Safety at External Boundaries**
**Rule**: Every HTTP request, CLI output, DB row, filesystem operation gets runtime validation

**Current Pattern**:
- HTTP request: `getRequiredString()`, `getOptionalInteger()`
- HTTP response: `expectString()`, `expectNumber()`
- DB rows: rows are `unknown`, parsed to domain type

**Dangerous Pattern** (to detect):
```typescript
const data = JSON.parse(apiResponse) as UserData;  // ❌ No validation
```

**Correct Pattern**:
```typescript
const data = parseUserDataContract(JSON.parse(apiResponse));  // ✅ Runtime validation
```

### 4. **Service Clarity**
**Rule**: Each service owns a specific domain (download, import, organize)

**Current Services**:
- download-processor.ts (execution), orpheus.ts (music), tidal-dl-ng.ts (video)
- import-service.ts (orchestration), import-matcher-service.ts (scoring)
- organizer.ts (file placement)

**Pattern to Detect**:
- Services with mixed responsibilities (e.g., download + import + organize)
- Large catch-all service files (should split by domain)

### 5. **Component Library Discipline**
**Rule**: Reusable UI goes in `/components/ui/`, page-specific in `/components/[Feature]/`

**Current Structure**:
```
components/
├── ui/                    # Reusable
│   ├── StatusBadges.tsx
│   ├── QualityBadge.tsx
│   └── ContentState.tsx
├── cards/                 # Reusable
│   ├── ArtistCard.tsx
│   └── AlbumCard.tsx
└── TrackList.tsx         # Page-specific
```

**Pattern to Detect**:
- Badge styling duplicated in pages (should move to ui/)
- Content state (loading/empty) inline in pages (should use ContentState)

---

## Actionable Next Steps for Skill Documentation

### Phase 1: Immediate (Critical) ⚡
Create these documentation files:

1. **`docs/TYPESCRIPT_DISCIPLINE.md`** (NEW)
   - Boundary validation checklist
   - Common mistakes + fixes
   - Type narrowing examples

2. **Update `.github/skills/discogenius-backend/SKILL.md`** (ENHANCE)
   - Add "Type Safety at Boundaries" section
   - Add error handling patterns
   - Add service boundary examples

3. **Update `.github/skills/discogenius-frontend/SKILL.md`** (ENHANCE)
   - Add component extraction checklist
   - Add Fluent token usage examples
   - Add hook composition patterns

### Phase 2: High Value (Important) 📊
Create these documentation files:

1. **`docs/ERROR_HANDLING.md`** (NEW)
   - Error classification guide
   - Logging levels and content
   - Retry decision tree

2. **`docs/SERVICE_BOUNDARIES.md`** (NEW)
   - When to split services
   - Data flow models
   - Transaction patterns

3. **Update `.github/skills/discogenius-architecture/SKILL.md`** (ENHANCE)
   - Service responsibility matrix
   - Data ownership model
   - Execution flow diagrams

### Phase 3: Valuable (Ongoing) 📈
Maintain these updates:

1. **Component Extraction Checklist** (ADD TO FRONTEND SKILL)
   - Size limits (>100 lines = extract)
   - Reuse patterns (2+ uses = extract)
   - State complexity (→ custom hook)

2. **React Query Strategy** (ADD TO FRONTEND SKILL)
   - Query key naming conventions
   - Invalidation triggers
   - Optimistic update patterns

3. **Schema & Migration Guide** (ENHANCE ARCHITECTURE.md)
   - Integer schema versioning
   - Column naming rationale
   - Migration testing patterns

---

## Specific Code Quality Opportunities

### Frontend Low-Hanging Fruit

1. **Library.tsx Reduction** (Currently ~2600 lines)
   - Extract ArtistCard component (reduces lines by ~200)
   - Extract AlbumCard component (reduces lines by ~200)
   - Extract TrackCard component (reduces lines by ~150)
   - Extract VideoCard component (reduces lines by ~150)
   - Follow useInfiniteScroll pattern for all 4 tabs

2. **Inline useStyles Consolidation**
   - Currently 50+ files with inline useStyles
   - Move to separate files if 30+ lines
   - Share token usage patterns

3. **Monitoring Utils Expansion**
   - Currently only in TrackList
   - Apply to AlbumPage, ArtistPage, VideoPage (3+ files using same checks)

4. **Global Event Optimization**
   - Monitor state changes already use optimistic updates
   - Library changes could benefit from same pattern

### Backend Low-Hanging Fruit

1. **Service Validation Consistency**
   - scanAlbum uses different validation than scanPlaylist
   - Create shared parsing helpers for metadata

2. **Job Payload Standardization**
   - Some payloads nested deeply
   - Flatten to consistent depth

3. **Error Message Consistency**
   - Some errors include stack traces in API response
   - Create error classification for user-facing vs internal

---

## Patterns to Watch For (Agent Quality Gates)

When implementing features, agents should **automatically flag**:

### ❌ Anti-Patterns
1. **Inline validation logic** → Use helpers from request-validation.ts
2. **No validation of external data** → Use contract parsers
3. **Hardcoded colors/spacing** → Use Fluent tokens
4. **Duplicated state checks** → Extract to util function
5. **Logic in route handlers** → Move to service layer
6. **Inline jobs in routes** → Use queue/scheduler
7. **No error handling** → Always catch, always respond
8. **Casual `any` types** → Use explicit types

### ✅ Good Patterns
1. **RequestValidationError on bad input** → Clear, specific error
2. **expectString/expectNumber at boundaries** → Runtime safety
3. **sendError/sendSuccess helpers** → Consistent API responses
4. **Service per domain** → Clear responsibility
5. **Discriminated union job payloads** → Type-safe routing
6. **useInfiniteScroll hook** → DRY pagination
7. **ContentState components** → Consistent loading/empty/error

---

## Metrics & Health Signals

### Current State (v1.0.6)
- ✅ 39/39 backend tests passing
- ✅ API TypeScript: zero errors
- ✅ App TypeScript: zero errors
- ✅ Consistent Fluent Design
- ✅ Clear service boundaries
- ⚠️ Frontend: 2600-line Library.tsx (extractable)
- ⚠️ Tests: No frontend unit tests (E2E only)

### Target State (v1.1.0+)
- ✅ 50+ backend tests (current test coverage)
- ✅ API TypeScript: zero errors (maintain)
- ✅ App TypeScript: zero errors (maintain)
- ✅ All UI components in library or page-specific folders
- ✅ DocumentationLive for 5 key patterns
- 🎯 Library.tsx reduced to <800 lines (via extraction)
- 🎯 Frontend unit tests for hooks (jest or vitest)

---

## How to Use This Report

### For Agents (Implementing Features)
1. Read `docs/AGENT_PATTERNS_GUIDE.md` for detailed pattern reference
2. Before writing code, check "Quick Reference: Common Implementation Patterns"
3. Follow examples in "Common Implementation Scenarios"
4. Use "Anti-Patterns" section to validate your approach

### For Reviewing Code
1. Check against "Patterns Currently Documented" section
2. Flag any anti-patterns from "Patterns to Watch For"
3. Suggest alignment with established patterns
4. Reference specific sections of guide in comments

### For Skill Writers
1. Use "Phase 1/2/3" roadmap for documentation priorities
2. Expand skills using "Actionable Next Steps" section
3. Add examples from "Code Quality Opportunities" section
4. Update as new patterns emerge (every 10+ uses)

---

## Key Insights for Agents

### Insight 1: Consistency Over Perfection
The codebase values **consistent patterns** over perfect implementations. If multiple files use the same check, extract it. If a component is styled consistently, move to library.

### Insight 2: Type Safety Saves Bugs
The most valuable patterns are at **external boundaries** (HTTP, CLI, DB). Runtime validation prevents entire classes of bugs.

### Insight 3: Service Boundaries Enable Refactoring
By organizing **services by domain** (not by layer), the codebase can safely refactor one concern without breaking others.

### Insight 4: Component Libraries Accelerate Development
A small library of **reusable components** (badges, states) prevents one-off implementations and keeps UI consistent.

### Insight 5: Hooks Encapsulate Complexity
Complex state logic moves to **custom hooks**, reducing page component size and making logic testable/reusable.

---

## Conclusion

The Discogenius codebase (v1.0.6) has **mature, consistent patterns** that agents can reliably follow. The architecture is clean, type-safe, and Lidarr-aligned. 

**Primary opportunities**:
1. Document patterns that exist but aren't written down
2. Expand component extraction (especially Library.tsx)
3. Enhance TypeScript discipline documentation
4. Add testing patterns for frontend hooks

With the patterns documented in `docs/AGENT_PATTERNS_GUIDE.md` and skills updated, agents can significantly improve code quality by:
- Detecting when patterns are not applied
- Suggesting consolidated patterns
- Flagging anti-patterns early
- Maintaining consistency across features

This analysis provides a foundation for **consistent, scalable feature development**.
