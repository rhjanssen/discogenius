---
description: Workflow for keeping docs up to date
---

# Update Documentation Workflow

Use this workflow when making changes that affect the user experience, configuration, or deployment.

## 1. Identify Impact
Determine which documents need updating:
- **README.md**: Overview, setup, and configuration.
- **docs/README.md**: Documentation structure and ownership rules.
- **docs/TESTING_PLAN.md**: Validation steps and test coverage notes.
- **docs/ARCHITECTURE.md**: Current architecture, workflow boundaries, and runtime behavior.
- **docs/ARCHITECTURE_WORKPLAN.md**: Architecture backlog and consolidation/refactor planning.
- **docs/CURATION_DEDUPLICATION.md**: Curation/redundancy semantics and flow changes.
- **Other docs**: Any files in `docs/` that are relevant to the change.

Consolidation rules:
- Keep current-state architecture in `docs/ARCHITECTURE.md`.
- Keep architecture backlog/planning in `docs/ARCHITECTURE_WORKPLAN.md`.
- Keep curation/redundancy semantics in `docs/CURATION_DEDUPLICATION.md`.
- Keep `docs/ROADMAP.md` forward-looking and avoid implemented-feature history.
- Remove redundant planning docs instead of keeping overlapping versions.

## 2. Update Content
- **Consistency**: Ensure paths and terminology match the current codebase (e.g., `app/`, `api/`, `/library`).
- **Clarity**: Use clear, concise language.
- **Verification**: If providing commands, verify they work.

## 3. Review
- Check for broken links.
- Ensure formatting is correct (Markdown).
