# Discogenius Custom Agents

This workspace includes a curated set of custom agents adapted from the
agency-agents library and tuned for Discogenius workflows.

Primary handoff flow:

1. `dg-orchestrator` -> `dg-routing` (internal triage, hidden from picker)
2. `dg-routing` -> `dg-architecture` or implementation owner
3. `dg-architecture` -> `dg-backend` or `dg-frontend`
4. `dg-backend` / `dg-frontend` -> `dg-qa`
5. `dg-qa` -> `dg-review`
6. `dg-review` -> `dg-docs`
7. `dg-docs` -> `dg-orchestrator`

Source personas from agency-agents:

- `specialized/agents-orchestrator.md`
- `engineering/engineering-software-architect.md`
- `engineering/engineering-backend-architect.md`
- `engineering/engineering-frontend-developer.md`
- `testing/testing-reality-checker.md`
- `engineering/engineering-code-reviewer.md`
- `engineering/engineering-technical-writer.md`
