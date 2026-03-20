# Agent Documentation Index

**Comprehensive Patterns & Guidance for Discogenius Feature Development**

This index organizes all agent-facing documentation created during the v1.0.6 code audit.

---

## 🚀 Start Here

### For New Teams/Agents
1. **Read**: [AGENT_QUICK_REFERENCE.md](AGENT_QUICK_REFERENCE.md) (5 min)
2. **Review**: [AGENT_PATTERNS_GUIDE.md](AGENT_PATTERNS_GUIDE.md) - Pattern of Interest (15 min)
3. **Deep Dive**: [AUDIT_SUMMARY_FOR_AGENTS.md](AUDIT_SUMMARY_FOR_AGENTS.md) - Full Context (30 min)

### For Code Review
1. Use [AGENT_QUICK_REFERENCE.md](AGENT_QUICK_REFERENCE.md) **Red Flags** section
2. Check **Checklist: Before Committing Code**
3. Reference specific patterns from [AGENT_PATTERNS_GUIDE.md](AGENT_PATTERNS_GUIDE.md)

### For Architecture Decisions
1. Read [AUDIT_SUMMARY_FOR_AGENTS.md](AUDIT_SUMMARY_FOR_AGENTS.md) - Executive Summary
2. Reference [ARCHITECTURE.md](ARCHITECTURE.md) - Current Boundaries
3. Check [ARCHITECTURE_WORKPLAN.md](ARCHITECTURE_WORKPLAN.md) - Consolidation Backlog

---

## 📚 Documentation Files

### Primary Guides

#### [AGENT_QUICK_REFERENCE.md](AGENT_QUICK_REFERENCE.md)
**Purpose**: Fast lookup card for common implementation tasks  
**When to Use**: While coding, before committing  
**Contents**:
- Pattern decision trees (UI → validation → styling)
- Copy-paste-friendly imports
- Red flags (anti-patterns to catch)
- Checklist before committing
- Key file locations
- One-liners for common tasks

**Read Time**: 10 min (reference)

---

#### [AGENT_PATTERNS_GUIDE.md](AGENT_PATTERNS_GUIDE.md)
**Purpose**: Comprehensive reference with examples for all established patterns  
**When to Use**: Learning new patterns, implementing features, code reviews  
**Contents**:
- Quick reference table (When you need to... → Pattern → Files → Example)
- Frontend patterns: component library, hooks, theming, Fluent integration
- Backend patterns: validation, contracts, responses, repositories
- Testing patterns: test structure, contract testing, database testing
- Type safety at boundaries (critical guide)
- Naming & organization conventions
- Common implementation scenarios with full code examples
- Architecture decision rationale

**Read Time**: 30-45 min (comprehensive reference)

---

#### [AUDIT_SUMMARY_FOR_AGENTS.md](AUDIT_SUMMARY_FOR_AGENTS.md)
**Purpose**: Executive summary + actionable recommendations + context  
**When to Use**: Understanding codebase maturity, planning improvements, strategic decisions  
**Contents**:
- Executive summary (what patterns exist, what's strong)
- Patterns currently documented (✅ mature, ⚠️ gaps)
- Code quality principles (5 key rules)
- Specific code quality opportunities (frontend & backend)
- Patterns to watch for (good patterns, anti-patterns)
- Metrics & health signals
- Phase 1/2/3 roadmap for documentation improvements
- How to use this report (for agents, reviewers, skill writers)

**Read Time**: 20 min (strategic overview)

---

### Supporting Architecture Docs

#### [ARCHITECTURE.md](ARCHITECTURE.md)
**Current state of Discogenius architecture, stable boundaries, runtime components**

#### [ARCHITECTURE_WORKPLAN.md](ARCHITECTURE_WORKPLAN.md)
**Planned consolidation and Lidarr-alignment work**

#### [CURATION_DEDUPLICATION.md](CURATION_DEDUPLICATION.md)
**Curation and redundancy flow details**

---

## 🎯 Patterns by Category

### Frontend Component Patterns  
📄 **Reference**: [AGENT_PATTERNS_GUIDE.md](AGENT_PATTERNS_GUIDE.md) - Frontend Patterns section

- **Component Library**: StatusBadges, QualityBadge, ExplicitBadge → `app/src/components/ui/`
- **Content States**: LoadingState, EmptyState, ErrorState → `app/src/components/ui/ContentState.tsx`
- **Custom Hooks**: useInfiniteScroll, useLibrary, useArtistPage → `app/src/hooks/`
- **Global Events**: Dispatch-based communication → `app/src/utils/appEvents.ts`
- **Theme**: Fluent v9 integration, token usage → `app/src/theme/theme.ts`
- **Utilities**: isMonitorLocked(), formatDuration() → `app/src/utils/`

**When to Apply**:
- Adding new status displays → Use badge library
- Adding loading/empty/error states → Use ContentState
- Building paginated list → Use useInfiniteScroll hook
- Managing complex page state → Use custom hook
- Cross-component communication → Use global events
- Using colors/spacing → Use Fluent tokens

---

### Backend Service Patterns  
📄 **Reference**: [AGENT_PATTERNS_GUIDE.md](AGENT_PATTERNS_GUIDE.md) - Backend Patterns section

- **Request Validation**: getRequired*, getOptional* → `api/src/utils/request-validation.ts`
- **Contract Validation**: expectString(), expectNumber() → `api/src/contracts/runtime.ts`
- **Response Formatting**: sendError(), sendSuccess() → `api/src/utils/response.ts`
- **Repository Pattern**: BaseRepository with transactions → `api/src/repositories/`
- **Service Architecture**: Domain-focused services → `api/src/services/`
- **Job Payloads**: Discriminated unions → `api/src/services/job-payloads.ts`

**When to Apply**:
- Accepting HTTP input → Validate with request-validation helpers
- Processing external data → Parse with contract validators
- Returning errors → Use sendError() helper
- Database operations → Use repository + transaction
- Long-running work → Queue job, don't run inline
- Creating new job type → Use discriminated union payload

---

### Type Safety Patterns  
📄 **Reference**: [AUDIT_SUMMARY_FOR_AGENTS.md](AUDIT_SUMMARY_FOR_AGENTS.md) - Type Safety at Boundaries

- **HTTP Requests**: Use request-validation helpers
- **HTTP Responses**: Use contract parsers
- **CLI Output**: Use expect* validators
- **Database Rows**: Rows are `unknown`, parse before use
- **External APIs**: Parse with contract validators

**Rule**: Every external boundary = runtime validation

---

### Testing Patterns  
📄 **Reference**: [AGENT_PATTERNS_GUIDE.md](AGENT_PATTERNS_GUIDE.md) - Testing Patterns section

- **Test Structure**: Node.js `test` module + `assert`
- **Contract Testing**: Valid/invalid payloads
- **Database Testing**: Temp directory isolation
- **Test Organization**: `api/src/**/*.test.ts`

**Current State**:
- ✅ 39/39 backend tests passing
- ✅ No frontend unit tests (E2E only via Playwright)
- 🎯 Add frontend hook tests in v1.1.0

---

## ✅ Code Quality Checklist

### Before Writing
- [ ] Read [AGENT_QUICK_REFERENCE.md](AGENT_QUICK_REFERENCE.md) - Pattern Decision Tree
- [ ] Check if pattern already exists in codebase
- [ ] Reference example from [AGENT_PATTERNS_GUIDE.md](AGENT_PATTERNS_GUIDE.md)

### While Coding
- [ ] No inline styles (use `tokens.*` from Fluent)
- [ ] No casual `any` types (use explicit validation)
- [ ] All external boundaries validated
- [ ] Request validation → Contract parsing → Response formatting
- [ ] Reusable logic → Extract to util/hook/component

### Before Committing
- [ ] Run `yarn lint`
- [ ] Run `yarn build`
- [ ] Check against [AGENT_QUICK_REFERENCE.md](AGENT_QUICK_REFERENCE.md) - Checklist section
- [ ] Review red flags from [AGENT_QUICK_REFERENCE.md](AGENT_QUICK_REFERENCE.md)
- [ ] Code follows established patterns or documents new pattern

---

## 📊 Metrics & Health Signals

### Current State (v1.0.6)
✅ Strong architectural alignment, consistent patterns, type-safe boundaries

**Strengths**:
- 39/39 backend tests passing
- Zero TypeScript errors (API + App)
- Fluent Design consistency
- Clear service boundaries
- Type safety at external boundaries

**Opportunities**:
- Library.tsx at 2600 lines (extractable via component library)
- Frontend lacks unit tests (E2E only)
- Some patterns documented informally (now in this guide)
- Minor anti-patterns in isolated areas

### Target State (v1.1.0+)
🎯 Maintain strengths, document patterns, reduce component sizes

**Goals**:
- Library.tsx → 800 lines (via component extraction)
- 50+ backend unit tests
- Frontend hook unit tests (jest/vitest)
- All patterns documented in skills
- Zero anti-patterns

---

## 🔧 How to Use This Index

### For Implementing a Feature
1. Check [AGENT_QUICK_REFERENCE.md](AGENT_QUICK_REFERENCE.md) - **Pattern Decision Tree**
2. Look up specific pattern in [AGENT_PATTERNS_GUIDE.md](AGENT_PATTERNS_GUIDE.md)
3. Copy code example
4. Before commit: Use **Code Quality Checklist**

### For Code Review
1. Check [AGENT_QUICK_REFERENCE.md](AGENT_QUICK_REFERENCE.md) - **Red Flags** section
2. Compare against established pattern
3. Reference in review comment: `"Path: AGENT_PATTERNS_GUIDE.md - Backend Patterns > Request Validation"`

### For Debugging Pattern Issues
1. Read relevant section in [AGENT_PATTERNS_GUIDE.md](AGENT_PATTERNS_GUIDE.md)
2. Check [AGENT_QUICK_REFERENCE.md](AGENT_QUICK_REFERENCE.md) - **Red Flags** for anti-patterns
3. Run `yarn lint` to catch style issues
4. Run `yarn build` to catch TypeScript issues

### For Learning Rationale
1. Read [AUDIT_SUMMARY_FOR_AGENTS.md](AUDIT_SUMMARY_FOR_AGENTS.md) - **Key Findings: Code Quality Principles**
2. Check [AGENT_PATTERNS_GUIDE.md](AGENT_PATTERNS_GUIDE.md) - **Architecture Decision Log**
3. Review [ARCHITECTURE.md](ARCHITECTURE.md) for current boundaries

### For Strategic Planning
1. Read [AUDIT_SUMMARY_FOR_AGENTS.md](AUDIT_SUMMARY_FOR_AGENTS.md) - **Executive Summary**
2. Check **Phase 1/2/3 Roadmap** for documentation priorities
3. Review **Specific Code Quality Opportunities**
4. Check **Metrics & Health Signals** for targets

---

## 🔗 Quick Links by Task

| Task | Primary | Secondary | Time |
|------|---------|-----------|------|
| Add UI component | QUICK_REF | PATTERNS_GUIDE → Frontend | 5 min |
| Add API endpoint | QUICK_REF → BACKEND | PATTERNS_GUIDE → Backend | 10 min |
| Validate request | PATTERNS_GUIDE → Request Validation | contracts/runtime.ts | 5 min |
| Extract reusable logic | AUDIT_SUMMARY → Opportunities | PATTERNS_GUIDE → Patterns Watch | 10 min |
| Understand pattern | PATTERNS_GUIDE → Topic | AUDIT_SUMMARY → Key Findings | 15 min |
| Review anti-patterns | QUICK_REF → Red Flags | AUDIT_SUMMARY → Patterns Watch | 5 min |
| Plan architecture | AUDIT_SUMMARY → Phase 1/2/3 | ARCHITECTURE.md | 20 min |
| Debug TypeScript errors | PATTERNS_GUIDE → Type Safety | QUICK_REF → Imports | 10 min |

---

## 📞 Getting Help

### Pattern Not Found?
1. Search [AGENT_PATTERNS_GUIDE.md](AGENT_PATTERNS_GUIDE.md) for keyword
2. Check [AGENT_QUICK_REFERENCE.md](AGENT_QUICK_REFERENCE.md) - Key File Locations
3. Look for similar pattern in codebase (grep or semantic search)
4. Document new pattern when discovered (3+ uses)

### Anti-Pattern Encountered?
1. Check [AGENT_QUICK_REFERENCE.md](AGENT_QUICK_REFERENCE.md) - **Red Flags**
2. Reference specific pattern from [AGENT_PATTERNS_GUIDE.md](AGENT_PATTERNS_GUIDE.md)
3. Suggest consolidation or extraction
4. Link to code example in pattern guide

### Understanding Architecture?
1. Start with [AUDIT_SUMMARY_FOR_AGENTS.md](AUDIT_SUMMARY_FOR_AGENTS.md) - **Key Insights**
2. Read [ARCHITECTURE.md](ARCHITECTURE.md) for boundaries
3. Check [AGENT_PATTERNS_GUIDE.md](AGENT_PATTERNS_GUIDE.md) - **Architecture Decision Log**

---

## 📝 Maintenance & Updates

**When to Update Documentation**:
- New pattern emerges (3+ uses)
- Architecture decision changes approach
- Codebase refactoring centralizes repeated code
- Anti-pattern discovered and eliminated

**Update Process**:
1. Update [AUDIT_SUMMARY_FOR_AGENTS.md](AUDIT_SUMMARY_FOR_AGENTS.md) - Architecture Decision Log
2. Update [AGENT_PATTERNS_GUIDE.md](AGENT_PATTERNS_GUIDE.md) with detailed example
3. Update [AGENT_QUICK_REFERENCE.md](AGENT_QUICK_REFERENCE.md) if commonly used
4. Update `.github/skills/` if impacts new skills

**Sync Points**:
- Session memory: `/memories/session/discogenius-audit-patterns.md`
- Skills: `.github/skills/discogenius-{backend,frontend,architecture}/SKILL.md`
- Copilot instructions: `.github/copilot-instructions.md`

---

## Version & History

**Current Version**: v1.0.6 patterns reference  
**Last Updated**: March 21, 2026  
**Created During**: Post v1.0.6 code quality audit  
**Status**: Complete, ready for agent use

**Previous Updates**:
- v1.0.6: Initial pattern documentation (this audit)
- v1.0.5+: Patterns informally applied in code reviews

---

## Credits & Attribution

This documentation synthesizes patterns observed and developed across the Discogenius project:

- **Frontend patterns**: StatusBadges library, useInfiniteScroll hook, ContentState components
- **Backend patterns**: Repository architecture, service boundaries, type validation
- **Testing patterns**: Contract parsing, database isolation
- **Type safety**: Request validation, contract parsers at boundaries

Reference implementations throughout codebase at files mentioned in each section.

---

**Questions? Check the index above for the right file. Happy coding! 🚀**
