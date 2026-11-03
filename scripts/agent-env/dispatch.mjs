#!/usr/bin/env node
/**
 * Cross-agent dispatcher & auto-failover router for Discogenius.
 *
 * Priority policy:
 *   1. Claude (claude-cloud / claude-gh / label 'agent:claude' / '@claude')
 *   2. Gemini / Antigravity (gemini-gh / antigravity / label 'agent:gemini' / '@gemini-cli')
 *   3. Cursor Cloud (cursor-cloud / label 'agent:cursor' / '@cursor') — LAST RESORT
 *      because Cursor shares subscription usage with Grok Bot (Product Owner).
 *
 * Examples:
 *   node scripts/agent-env/dispatch.mjs status
 *   node scripts/agent-env/dispatch.mjs --to auto         --issue 42
 *   node scripts/agent-env/dispatch.mjs --to claude-cloud --issue 42
 *   node scripts/agent-env/dispatch.mjs --to gemini-gh    --issue 42
 *   node scripts/agent-env/dispatch.mjs --to antigravity  --issue 42
 *   node scripts/agent-env/dispatch.mjs --to cursor-cloud --issue 42
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  findClaudeExecutable,
  getAgentUsageStatus,
  recordAgentCooldown,
} from './usage-status.mjs';

const REPO = process.env.DISCOGENIUS_REPO || 'rhjanssen/discogenius';
const REPO_URL = `https://github.com/${REPO}`;

const QUOTA_ERROR_PATTERNS = [
  /5-hour limit/i,
  /usage limit/i,
  /rate[ _-]?limit/i,
  /RESOURCE_EXHAUSTED/i,
  /quota exceeded/i,
  /too many requests/i,
  /out of usage/i,
];

function isQuotaExhaustedOutput(text) {
  if (!text) return false;
  return QUOTA_ERROR_PATTERNS.some((re) => re.test(text));
}

function parseArgs(argv) {
  const out = {
    to: '',
    issue: '',
    pr: '',
    prompt: '',
    branch: '',
    dryRun: false,
    noFailover: false,
    json: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'status' || arg === '--status') out.to = 'status';
    else if (arg === '--json') out.json = true;
    else if (arg === '--to' || arg === '--agent') out.to = (argv[++i] || '').toLowerCase();
    else if (arg === '--issue') out.issue = String(argv[++i] || '').replace(/^#/, '');
    else if (arg === '--pr') out.pr = String(argv[++i] || '').replace(/^#/, '');
    else if (arg === '--prompt') out.prompt = argv[++i] || '';
    else if (arg === '--branch') out.branch = argv[++i] || '';
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--no-failover') out.noFailover = true;
  }
  return out;
}

function fetchIssueOrPrDetails(number, isPr = false) {
  const kind = isPr ? 'pr' : 'issue';
  const raw = execFileSync(
    'gh',
    [kind, 'view', String(number), '--repo', REPO, '--json', 'number,title,body,url,labels'],
    { encoding: 'utf8' },
  );
  return JSON.parse(raw);
}

function setAgentLabelOnGitHub(number, agentName, dryRun = false) {
  if (!number || dryRun) return;
  const targetLabel = `agent:${agentName}`;
  const removeLabels = ['agent:claude', 'agent:gemini', 'agent:cursor', 'agent:auto'].filter(
    (l) => l !== targetLabel,
  );
  try {
    for (const oldLabel of removeLabels) {
      try {
        execFileSync('gh', ['issue', 'edit', String(number), '--repo', REPO, '--remove-label', oldLabel], {
          stdio: 'ignore',
        });
      } catch {
        // ignore if label wasn't present
      }
    }
    execFileSync(
      'gh',
      ['issue', 'edit', String(number), '--repo', REPO, '--add-label', `${targetLabel},in-progress`],
      { stdio: 'ignore' },
    );
  } catch {
    // ignore if labels haven't been created yet
  }
}

function buildTaskPrompt(item, extraPrompt, branchHint) {
  const targetBranch = branchHint || (item ? `agent/issue-${item.number}` : '');
  const parts = [
    `Read AGENTS.md and HANDOFF.md first.`,
    item
      ? `Pick up GitHub #${item.number}: "${item.title}" (${item.url}).`
      : `Execute the requested task on rhjanssen/discogenius.`,
    targetBranch
      ? `Check if branch '${targetBranch}' already exists on origin (from a previous agent that ran out of usage); if so, check it out and continue where it left off. Otherwise create branch '${targetBranch}'.`
      : `Work on a dedicated branch.`,
    `Verify your changes with 'yarn ci', overwrite HANDOFF.md with current status before finishing (or if stopping early), and open/update a Pull Request.`,
  ];
  if (item?.body) parts.push(`\nDescription:\n${item.body}`);
  if (extraPrompt) parts.push(`\nAdditional handover instructions:\n${extraPrompt}`);
  return parts.join(' ');
}

async function dispatchToTarget(target, item, fullPrompt, args) {
  const number = item?.number;

  switch (target) {
    case 'claude':
    case 'claude-cloud': {
      setAgentLabelOnGitHub(number, 'claude', args.dryRun);
      const claudeExe = findClaudeExecutable();
      if (claudeExe) {
        console.log(`[dispatch] Launching Claude Code Cloud VM session via ${claudeExe} --cloud...`);
        if (args.dryRun) {
          console.log(`Would run: "${claudeExe}" --cloud <prompt>`);
          return { ok: true };
        }
        const res = spawnSync(claudeExe, ['--cloud', fullPrompt], {
          encoding: 'utf8',
          stdio: ['inherit', 'pipe', 'pipe'],
        });
        const combined = `${res.stdout || ''}\n${res.stderr || ''}`;
        if (res.stdout) process.stdout.write(res.stdout);
        if (res.stderr) process.stderr.write(res.stderr);

        if (isQuotaExhaustedOutput(combined)) {
          return { ok: false, quotaExhausted: true, agent: 'claude', reason: combined.trim() };
        }
        if (res.status === 0) return { ok: true };
        console.warn(`[dispatch] 'claude --cloud' exited ${res.status}; falling back to GitHub @claude trigger.`);
      }
      // Fallback to GitHub comment/label trigger
      return dispatchToTarget('claude-gh', item, fullPrompt, args);
    }

    case 'claude-gh': {
      if (!number) {
        console.error('[dispatch] --issue or --pr <num> is required for claude-gh.');
        return { ok: false };
      }
      setAgentLabelOnGitHub(number, 'claude', args.dryRun);
      console.log(`[dispatch] Triggering @claude on GitHub #${number}...`);
      if (!args.dryRun) {
        execFileSync(
          'gh',
          [
            'issue',
            'comment',
            String(number),
            '--repo',
            REPO,
            '--body',
            `@claude Please pick up this task following \`AGENTS.md\` and \`HANDOFF.md\`. If branch \`agent/issue-${number}\` already exists, continue from where the previous agent left off.\n\n${args.prompt || ''}`.trim(),
          ],
          { stdio: 'inherit' },
        );
      }
      return { ok: true };
    }

    case 'gemini':
    case 'gemini-gh': {
      if (!number) {
        // If no issue number is given, fall back to local Antigravity / Gemini CLI
        return dispatchToTarget('antigravity', item, fullPrompt, args);
      }
      setAgentLabelOnGitHub(number, 'gemini', args.dryRun);
      console.log(`[dispatch] Triggering @gemini-cli (and label 'agent:gemini') on GitHub #${number}...`);
      if (!args.dryRun) {
        execFileSync(
          'gh',
          [
            'issue',
            'comment',
            String(number),
            '--repo',
            REPO,
            '--body',
            `@gemini-cli Please pick up this task following \`AGENTS.md\` and \`HANDOFF.md\`. If branch \`agent/issue-${number}\` already exists, continue from where the previous agent left off.\n\n${args.prompt || ''}`.trim(),
          ],
          { stdio: 'inherit' },
        );
      }
      return { ok: true };
    }

    case 'antigravity': {
      setAgentLabelOnGitHub(number, 'gemini', args.dryRun);
      console.log(`[dispatch] Launching local Google Antigravity / Gemini CLI...`);
      if (args.dryRun) {
        console.log(`Would run: agy -p <prompt> (or gemini -p <prompt>)`);
        return { ok: true };
      }
      let res = spawnSync('agy', ['-p', fullPrompt], {
        encoding: 'utf8',
        stdio: ['inherit', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
      if (res.error) {
        res = spawnSync('gemini', ['-p', fullPrompt, '--yolo'], {
          encoding: 'utf8',
          stdio: ['inherit', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
        });
      }
      const combined = `${res.stdout || ''}\n${res.stderr || ''}`;
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      if (isQuotaExhaustedOutput(combined)) {
        return { ok: false, quotaExhausted: true, agent: 'gemini', reason: combined.trim() };
      }
      return { ok: res.status === 0 };
    }

    case 'cursor':
    case 'cursor-cloud': {
      setAgentLabelOnGitHub(number, 'cursor', args.dryRun);
      const apiKey = process.env.CURSOR_API_KEY;
      if (!apiKey) {
        if (number && !args.dryRun) {
          console.log(`[dispatch] CURSOR_API_KEY not set locally; posting @cursor + label 'agent:cursor' on #${number} for GitHub Action dispatch.`);
          execFileSync(
            'gh',
            [
              'issue',
              'comment',
              String(number),
              '--repo',
              REPO,
              '--body',
              `@cursor Please pick up this task following \`AGENTS.md\` and \`HANDOFF.md\`. If branch \`agent/issue-${number}\` exists, continue where the previous agent left off.\n\n${args.prompt || ''}`.trim(),
            ],
            { stdio: 'inherit' },
          );
          return { ok: true };
        }
        console.error('[dispatch] CURSOR_API_KEY is required for direct cursor-cloud API call.');
        return { ok: false };
      }
      console.log(`[dispatch] Triggering Cursor Cloud Agent VM on ${REPO_URL}...`);
      const payload = {
        repository: REPO_URL,
        prompt: { text: fullPrompt },
      };
      if (args.dryRun) {
        console.log('POST https://api.cursor.com/v1/agents', JSON.stringify(payload, null, 2));
        return { ok: true };
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
        if (resp.status === 429 || isQuotaExhaustedOutput(text)) {
          return { ok: false, quotaExhausted: true, agent: 'cursor', reason: text };
        }
        console.error(`[dispatch] Cursor API error (${resp.status}): ${text}`);
        return { ok: false };
      }
      console.log(`[dispatch] Cursor Cloud Agent started: ${text}`);
      return { ok: true };
    }

    default:
      console.error(
        `[dispatch] Unknown target '${target}'. Use: status | auto | claude | claude-cloud | claude-gh | gemini | gemini-gh | antigravity | cursor | cursor-cloud`,
      );
      return { ok: false };
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.to === 'status') {
    const status = getAgentUsageStatus();
    if (args.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(JSON.stringify(status, null, 2));
    }
    return;
  }

  if (!args.to || (!args.issue && !args.pr && !args.prompt)) {
    console.error(
      [
        'Usage:',
        '  node scripts/agent-env/dispatch.mjs status [--json]',
        '  node scripts/agent-env/dispatch.mjs --to <auto|claude|claude-cloud|claude-gh|gemini|gemini-gh|antigravity|cursor> [--issue <num>] [--pr <num>] [--prompt "<text>"] [--dry-run]',
      ].join('\n'),
    );
    process.exit(1);
  }

  const item = args.issue
    ? fetchIssueOrPrDetails(args.issue, false)
    : args.pr
      ? fetchIssueOrPrDetails(args.pr, true)
      : null;

  const fullPrompt = buildTaskPrompt(item, args.prompt, args.branch);

  // Resolve 'auto' using usage-status (Claude & Gemini first, Cursor last)
  let target = args.to;
  if (target === 'auto') {
    const status = getAgentUsageStatus();
    if (status.recommendedAgent === 'none') {
      console.error(`[dispatch] ${status.recommendationReason}`);
      process.exit(1);
    }
    target = status.recommendedAgent;
    console.log(`[dispatch] Auto-router selected '${target}': ${status.recommendationReason}`);
  }

  const result = await dispatchToTarget(target, item, fullPrompt, args);

  // Automatic failover if the chosen agent hit a usage / rate limit!
  if (!result.ok && result.quotaExhausted && !args.noFailover) {
    const exhaustedAgent = result.agent;
    console.warn(`[dispatch] Agent '${exhaustedAgent}' hit its usage limit! Recording 60m cooldown...`);
    recordAgentCooldown(exhaustedAgent, 60, result.reason || 'Quota exhausted during dispatch');

    const nextStatus = getAgentUsageStatus();
    const fallbackAgent = nextStatus.recommendedAgent;
    if (fallbackAgent && fallbackAgent !== 'none' && fallbackAgent !== exhaustedAgent) {
      console.log(
        `[dispatch] Failing over automatically from '${exhaustedAgent}' -> '${fallbackAgent}' to pick up where '${exhaustedAgent}' left off...`,
      );
      const failoverPrompt = `${fullPrompt}\n\nNOTE: Previous agent (${exhaustedAgent}) hit its usage limit. Check out branch 'agent/issue-${item?.number || 'wip'}' and read HANDOFF.md to continue right where it stopped.`;
      const fallbackRes = await dispatchToTarget(fallbackAgent, item, failoverPrompt, args);
      if (!fallbackRes.ok) process.exit(1);
      return;
    }
  }

  if (!result.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
