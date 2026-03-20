# Discogenius Agent Guide

This file defines coding-agent expectations for Discogenius.

## Project Scope
- Discogenius is a self-hosted TIDAL library manager inspired by Lidarr.
- Monorepo layout: `api/` (Express + TypeScript), `app/` (React + Vite), `e2e/` (Playwright TypeScript).
- Keep architecture aligned with Lidarr workflow boundaries and Tidarr-style pragmatic downloader integration.

## Instruction Sources
- Repository-wide guidance: `.github/copilot-instructions.md`.
- Specialized guidance: `.github/skills/*` and `.github/agents/*`.
- Keep this file synchronized with `.github` guidance to avoid conflicting behavior.

## Development Rules
- Use TypeScript in `api/src` and `app/src`.
- Use Yarn only.
- Backend DB access must use synchronous `better-sqlite3`.
- Music downloads must use Orpheus; video downloads must use tidal-dl-ng.
- Keep routes thin; put durable workflow logic in services/repositories.
- Queue long-running work; do not run maintenance-heavy work inline in routes.

## Frontend Rules
- Use Fluent UI React v9, `makeStyles`, and Fluent tokens.
- Use `@tanstack/react-query` for data fetching.
- Reuse shared UI/state utilities before creating one-off patterns.
- Keep theme state sourced from `FluentThemeProvider` and `useTheme`.

## Backend Rules
- Preserve queue separation: `download-processor.ts` for exact downloads, `scheduler.ts` for non-download jobs.
- Preserve command exclusivity behavior in `command.ts` and queue lifecycle in `queue.ts`.
- Validate external boundaries explicitly (HTTP payloads, CLI output, DB rows, filesystem metadata).

## Validation Checklist
- Run `yarn --cwd api build` after backend changes.
- Run `yarn --cwd app build` after frontend changes.
- Run focused tests for changed behavior (at minimum backend tests when backend logic changes).
- If runtime packaging behavior changes, validate with `docker compose up --build -d`.

## Reference Standards
- GitHub custom instruction support matrix:
  - https://docs.github.com/en/copilot/reference/custom-instructions-support
- GitHub repository instruction guidance:
  - https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions
- AGENTS.md format reference:
  - https://github.com/agentsmd/agents.md
