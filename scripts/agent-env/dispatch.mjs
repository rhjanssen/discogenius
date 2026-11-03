#!/usr/bin/env node
/**
 * Cross-agent dispatcher for Discogenius (Homelab Bot / Grok, Cursor, Claude, Antigravity).
 *
 * Allows any agent or operator to hand off a GitHub Issue or prompt to another
 * agent's cloud VM or local/CI runner:
 *
 * Examples:
 *   node scripts/agent-env/dispatch.mjs --to claude-cloud --issue 42
 *   node scripts/agent-env/dispatch.mjs --to cursor-cloud --issue 42
 *   node scripts/agent-env/dispatch.mjs --to antigravity  --issue 42
 *   node scripts/agent-env/dispatch.mjs --to claude-gh    --issue 42
 *   node scripts/agent-env/dispatch.mjs --to gemini-gh    --issue 42
 */

import { execFileSync, spawnSync } from 'node:child_process';

const REPO = process.env.DISCOGENIUS_REPO || 'rhjanssen/discogenius';
const REPO_URL = `https://github.com/${REPO}`;

function parseArgs(argv) {
  const out = { to: '', issue: '', prompt: '', dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--to' || arg === '--agent') out.to = argv[++i] || '';
    else if (arg === '--issue') out.issue = String(argv[++i] || '').replace(/^#/, '');
    else if (arg === '--prompt') out.prompt = argv[++i] || '';
    else if (arg === '--dry-run') out.dryRun = true;
  }
  return out;
}

function fetchIssueDetails(issueNumber) {
  const raw = execFileSync(
    'gh',
    ['issue', 'view', String(issueNumber), '--repo', REPO, '--json', 'number,title,body,url'],
    { encoding: 'utf8' },
  );
  return JSON.parse(raw);
}

function buildTaskPrompt(issue, extraPrompt) {
  if (!issue) return extraPrompt;
  const header = [
    `Read AGENTS.md and HANDOFF.md first.`,
    `Pick up GitHub Issue #${issue.number}: ${issue.title} (${issue.url}).`,
    `Work on a dedicated branch, verify with yarn ci, update HANDOFF.md, and open a PR.`,
  ].join(' ');
  const body = issue.body ? `\n\nIssue description:\n${issue.body}` : '';
  const extra = extraPrompt ? `\n\nAdditional notes:\n${extraPrompt}` : '';
  return `${header}${body}${extra}`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.to || (!args.issue && !args.prompt)) {
    console.error(
      'Usage: node scripts/agent-env/dispatch.mjs --to <claude-cloud|cursor-cloud|antigravity|claude-gh|gemini-gh> [--issue <num>] [--prompt "<text>"] [--dry-run]',
    );
    process.exit(1);
  }

  const issue = args.issue ? fetchIssueDetails(args.issue) : null;
  const fullPrompt = buildTaskPrompt(issue, args.prompt);

  switch (args.to) {
    case 'claude-cloud': {
      // Spawns a Claude Code Cloud VM session (claude.ai/code) using the repo's cloud setup script.
      console.log(`[dispatch] Launching Claude Code Cloud VM session...`);
      if (args.dryRun) {
        console.log(`Would run: claude --cloud <prompt>`);
        return;
      }
      const res = spawnSync('claude', ['--cloud', fullPrompt], { stdio: 'inherit', shell: process.platform === 'win32' });
      if (res.status !== 0) {
        console.warn(`[dispatch] 'claude --cloud' unavailable or exited ${res.status}; falling back to GitHub @claude trigger.`);
        if (issue) {
          execFileSync('gh', ['issue', 'comment', String(issue.number), '--repo', REPO, '--body', `@claude Please implement this issue following AGENTS.md and HANDOFF.md.`], { stdio: 'inherit' });
        } else {
          process.exit(res.status ?? 1);
        }
      }
      break;
    }

    case 'cursor-cloud': {
      // Triggers a Cursor Background/Cloud Agent VM via Cursor REST API v1.
      const apiKey = process.env.CURSOR_API_KEY;
      if (!apiKey) {
        console.error('[dispatch] CURSOR_API_KEY environment variable is required to dispatch to cursor-cloud via API.');
        process.exit(1);
      }
      console.log(`[dispatch] Triggering Cursor Cloud Agent VM on ${REPO_URL}...`);
      const payload = {
        repository: REPO_URL,
        prompt: { text: fullPrompt },
      };
      if (args.dryRun) {
        console.log('POST https://api.cursor.com/v1/agents', JSON.stringify(payload, null, 2));
        return;
      }
      const resp = await fetch('https://api.cursor.com/v1/agents', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const text = await resp.text();
      if (!resp.ok) {
        console.error(`[dispatch] Cursor API error (${resp.status}): ${text}`);
        process.exit(1);
      }
      console.log(`[dispatch] Cursor Cloud Agent started: ${text}`);
      break;
    }

    case 'antigravity': {
      // Runs Google Antigravity CLI headlessly (local PC / homelab with LAN access).
      console.log(`[dispatch] Launching Google Antigravity CLI (agy -p)...`);
      if (args.dryRun) {
        console.log(`Would run: agy -p <prompt>`);
        return;
      }
      const res = spawnSync('agy', ['-p', fullPrompt], { stdio: 'inherit', shell: process.platform === 'win32' });
      process.exit(res.status ?? 0);
      break;
    }

    case 'claude-gh': {
      if (!issue) {
        console.error('[dispatch] --issue <num> is required for claude-gh.');
        process.exit(1);
      }
      console.log(`[dispatch] Tagging @claude on Issue #${issue.number}...`);
      if (!args.dryRun) {
        execFileSync('gh', ['issue', 'comment', String(issue.number), '--repo', REPO, '--body', `@claude Please implement this issue following AGENTS.md and HANDOFF.md.\n\n${args.prompt || ''}`.trim()], { stdio: 'inherit' });
      }
      break;
    }

    case 'gemini-gh': {
      if (!issue) {
        console.error('[dispatch] --issue <num> is required for gemini-gh.');
        process.exit(1);
      }
      console.log(`[dispatch] Tagging @gemini-cli on Issue #${issue.number}...`);
      if (!args.dryRun) {
        execFileSync('gh', ['issue', 'comment', String(issue.number), '--repo', REPO, '--body', `@gemini-cli Please implement this issue following AGENTS.md and HANDOFF.md.\n\n${args.prompt || ''}`.trim()], { stdio: 'inherit' });
      }
      break;
    }

    default:
      console.error(`[dispatch] Unknown target '${args.to}'. Supported: claude-cloud, cursor-cloud, antigravity, claude-gh, gemini-gh`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
