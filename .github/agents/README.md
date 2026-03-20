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

Agent criteria:

1. Agent files must stay aligned with GitHub's official custom agents documentation, including frontmatter shape, handoff structure, and tool declarations.
2. Agent guidance must remain Discogenius-specific and consistent with `.github/copilot-instructions.md` and `.github/skills`.
3. Handoff chains must stay explicit, minimal, and verifiable.
4. A repository-level `AGENTS.md` must stay present and in sync with this folder so GitHub-supported agent instruction discovery works consistently across tools.

Reference:

- https://docs.github.com/en/copilot/reference/custom-instructions-support
- https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions
- https://github.com/agentsmd/agents.md

Notes:

- GitHub supports agent instructions via `AGENTS.md` (and optionally `CLAUDE.md`/`GEMINI.md`) for coding-agent flows.
- Keep repository-wide guidance in `.github/copilot-instructions.md`, path-specific guidance in `.github/instructions/**/*.instructions.md`, and agent-operational guidance in `AGENTS.md`.
