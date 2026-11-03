#!/usr/bin/env node
/**
 * Agent Usage & Quota Inspector for Discogenius (Grok Bot / PO helper).
 *
 * Inspects real-time usage limits and cooldown states across:
 *   1. Claude Code (reads ~/.claude & %APPDATA%/Claude/plan-usage-history.json + GitHub cooldowns)
 *   2. Gemini CLI / Antigravity (checks local/GitHub quota state & rate-limit cooldowns)
 *   3. Cursor Cloud (marked as shared-with-grokbot -> reserve quota, lowest priority)
 *
 * Usage:
 *   node scripts/agent-env/usage-status.mjs            # Human/bot-readable summary table
 *   node scripts/agent-env/usage-status.mjs --json     # Structured JSON for Grok Bot automation
 *   node scripts/agent-env/usage-status.mjs --record-exhausted <claude|gemini|cursor> [--minutes 60]
 *   node scripts/agent-env/usage-status.mjs --clear <claude|gemini|cursor>
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const STATE_FILE = path.join(REPO_ROOT, 'config', '.agent-usage-state.json');
const REPO = process.env.DISCOGENIUS_REPO || 'rhjanssen/discogenius';

function loadLocalCooldownState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {
    // ignore corrupt state file
  }
  return { cooldowns: {} };
}

function saveLocalCooldownState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn(`warn: could not write ${STATE_FILE}: ${err.message}`);
  }
}

export function recordAgentCooldown(agent, minutes = 60, reason = 'Usage limit reached') {
  const state = loadLocalCooldownState();
  const expiresAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  state.cooldowns[agent] = {
    exhaustedAt: new Date().toISOString(),
    expiresAt,
    reason,
  };
  saveLocalCooldownState(state);
  return state.cooldowns[agent];
}

export function clearAgentCooldown(agent) {
  const state = loadLocalCooldownState();
  delete state.cooldowns[agent];
  saveLocalCooldownState(state);
}

function isCooldownActive(cooldown) {
  if (!cooldown || !cooldown.expiresAt) return false;
  return new Date(cooldown.expiresAt).getTime() > Date.now();
}

/**
 * Reads Claude Desktop / Claude Code's local plan-usage-history.json if present on this machine.
 * Fields in Claude's telemetry:
 *   fh = 5-hour rolling window usage % (0-100)
 *   sd = 7-day rolling window usage % (0-100)
 *   xu = extra usage %
 */
function readClaudePlanUsage() {
  const candidates = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Claude', 'plan-usage-history.json') : null,
    path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'plan-usage-history.json'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'plan-usage-history.json'),
    path.join(os.homedir(), '.config', 'Claude', 'plan-usage-history.json'),
  ].filter(Boolean);

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const samples = Array.isArray(data?.samples) ? data.samples : [];
      for (let i = samples.length - 1; i >= 0; i--) {
        const s = samples[i];
        if (s && s.u && (typeof s.u.fh === 'number' || typeof s.u.sd === 'number')) {
          return {
            source: file,
            sampledAt: s.t ? new Date(s.t).toISOString() : null,
            fiveHourPercent: s.u.fh ?? 0,
            sevenDayPercent: s.u.sd ?? 0,
            extraUsagePercent: s.u.xu ?? 0,
          };
        }
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Finds the installed Claude Code CLI executable on Windows/macOS/Linux.
 */
export function findClaudeExecutable() {
  try {
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['claude'], { stdio: 'ignore' });
    return 'claude';
  } catch {
    // Search %APPDATA%/Claude/claude-code/<version>/<hash>/claude.exe on Windows
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const claudeCodeDir = path.join(appData, 'Claude', 'claude-code');
    try {
      if (fs.existsSync(claudeCodeDir)) {
        const versions = fs.readdirSync(claudeCodeDir).sort().reverse();
        for (const ver of versions) {
          const verPath = path.join(claudeCodeDir, ver);
          if (!fs.statSync(verPath).isDirectory()) continue;
          for (const sub of fs.readdirSync(verPath)) {
            const exe = path.join(verPath, sub, process.platform === 'win32' ? 'claude.exe' : 'claude');
            if (fs.existsSync(exe)) return exe;
          }
        }
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Checks GitHub Issues for any active `quota-exhausted:<agent>` labels set by CI workflows
 * within the last 2 hours.
 */
function checkGitHubExhaustedLabels() {
  const exhausted = { claude: false, gemini: false, cursor: false };
  try {
    const out = execFileSync(
      'gh',
      ['issue', 'list', '--repo', REPO, '--state', 'open', '--json', 'number,labels,updatedAt', '--limit', '30'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const issues = JSON.parse(out);
    const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2 hours
    for (const issue of issues) {
      if (new Date(issue.updatedAt).getTime() < cutoff) continue;
      for (const lbl of issue.labels || []) {
        if (lbl.name === 'quota-exhausted:claude') exhausted.claude = true;
        if (lbl.name === 'quota-exhausted:gemini') exhausted.gemini = true;
        if (lbl.name === 'quota-exhausted:cursor') exhausted.cursor = true;
      }
    }
  } catch {
    // ignore if offline or gh unavailable
  }
  return exhausted;
}

export function getAgentUsageStatus() {
  const state = loadLocalCooldownState();
  const ghExhausted = checkGitHubExhaustedLabels();
  const claudeTelemetry = readClaudePlanUsage();
  const claudeExe = findClaudeExecutable();

  // 1. Evaluate Claude status
  const claudeCooldown = isCooldownActive(state.cooldowns?.claude) ? state.cooldowns.claude : null;
  const claude5h = claudeTelemetry?.fiveHourPercent ?? null;
  const claude7d = claudeTelemetry?.sevenDayPercent ?? null;
  const claudeOutByTelemetry = (claude5h !== null && claude5h >= 98) || (claude7d !== null && claude7d >= 99);
  const claudeAvailable = !claudeCooldown && !ghExhausted.claude && !claudeOutByTelemetry;

  // 2. Evaluate Gemini / Antigravity status
  const geminiCooldown = isCooldownActive(state.cooldowns?.gemini) ? state.cooldowns.gemini : null;
  const geminiAvailable = !geminiCooldown && !ghExhausted.gemini;

  // 3. Evaluate Cursor status (shared quota with Grok Bot -> always deprioritized)
  const cursorCooldown = isCooldownActive(state.cooldowns?.cursor) ? state.cooldowns.cursor : null;
  const cursorAvailable = !cursorCooldown && !ghExhausted.cursor;

  // Compute recommended next agent:
  // Rule: Prefer Claude & Gemini first (never pick Cursor unless both Claude and Gemini are out of usage).
  // Between Claude and Gemini, if Claude's 5-hour usage is > 75%, prefer Gemini to balance load; otherwise prefer Claude or Gemini.
  let recommended = null;
  let recommendationReason = '';

  if (claudeAvailable && geminiAvailable) {
    if (claude5h !== null && claude5h >= 75) {
      recommended = 'gemini';
      recommendationReason = `Both available; Claude 5h window is at ${claude5h}%, routing to Gemini to preserve Claude headroom (Cursor reserved for Grok Bot).`;
    } else {
      recommended = 'claude';
      recommendationReason = `Claude has plenty of quota (5h: ${claude5h ?? 'OK'}%, 7d: ${claude7d ?? 'OK'}%) and Gemini is ready as failover (Cursor reserved for Grok Bot).`;
    }
  } else if (claudeAvailable) {
    recommended = 'claude';
    recommendationReason = 'Gemini is in cooldown; Claude has available quota (Cursor reserved for Grok Bot).';
  } else if (geminiAvailable) {
    recommended = 'gemini';
    recommendationReason = 'Claude reached its usage limit; failing over to Gemini (Cursor reserved for Grok Bot).';
  } else if (cursorAvailable) {
    recommended = 'cursor';
    recommendationReason = 'WARNING: Both Claude and Gemini are out of usage; falling back to Cursor (shares usage with Grok Bot).';
  } else {
    recommended = 'none';
    recommendationReason = 'All agents (Claude, Gemini, Cursor) are currently in quota cooldown.';
  }

  return {
    checkedAt: new Date().toISOString(),
    recommendedAgent: recommended,
    recommendationReason,
    priorityOrder: ['claude', 'gemini', 'cursor (last resort - shares quota with Grok Bot)'],
    agents: {
      claude: {
        available: claudeAvailable,
        priority: 1,
        sharesQuotaWithGrokBot: false,
        fiveHourUsagePercent: claude5h,
        sevenDayUsagePercent: claude7d,
        telemetrySampledAt: claudeTelemetry?.sampledAt ?? null,
        localCliInstalled: Boolean(claudeExe),
        localCliPath: claudeExe,
        cooldown: claudeCooldown,
        githubExhaustedFlag: ghExhausted.claude,
        triggers: {
          label: 'agent:claude',
          mention: '@claude',
          cliCloud: 'node scripts/agent-env/dispatch.mjs --to claude-cloud --issue <N>',
          cliGitHub: 'node scripts/agent-env/dispatch.mjs --to claude-gh --issue <N>',
        },
      },
      gemini: {
        available: geminiAvailable,
        priority: 1,
        sharesQuotaWithGrokBot: false,
        cooldown: geminiCooldown,
        githubExhaustedFlag: ghExhausted.gemini,
        triggers: {
          label: 'agent:gemini',
          mention: '@gemini-cli',
          cliGitHub: 'node scripts/agent-env/dispatch.mjs --to gemini-gh --issue <N>',
          cliLocalAntigravity: 'node scripts/agent-env/dispatch.mjs --to antigravity --issue <N>',
        },
      },
      cursor: {
        available: cursorAvailable,
        priority: 3,
        sharesQuotaWithGrokBot: true,
        note: 'Shares subscription usage with Grok Bot. Only use when both Claude and Gemini are exhausted.',
        cooldown: cursorCooldown,
        githubExhaustedFlag: ghExhausted.cursor,
        triggers: {
          label: 'agent:cursor',
          mention: '@cursor',
          cliCloud: 'node scripts/agent-env/dispatch.mjs --to cursor-cloud --issue <N>',
        },
      },
    },
  };
}

// CLI entrypoint
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  if (args[0] === '--record-exhausted' && args[1]) {
    const agent = args[1].toLowerCase();
    const minIdx = args.indexOf('--minutes');
    const minutes = minIdx !== -1 ? Number(args[minIdx + 1]) || 60 : 60;
    const entry = recordAgentCooldown(agent, minutes, 'Recorded via usage-status CLI');
    console.log(`Recorded quota cooldown for '${agent}' until ${entry.expiresAt}`);
    process.exit(0);
  }
  if (args[0] === '--clear' && args[1]) {
    const agent = args[1].toLowerCase();
    clearAgentCooldown(agent);
    console.log(`Cleared quota cooldown for '${agent}'`);
    process.exit(0);
  }

  const status = getAgentUsageStatus();
  if (args.includes('--json')) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log('=== Discogenius Multi-Agent Usage & Quota Status ===');
    console.log(`Checked at:        ${status.checkedAt}`);
    console.log(`Recommended Agent: ${status.recommendedAgent.toUpperCase()}`);
    console.log(`Reason:            ${status.recommendationReason}\n`);

    const c = status.agents.claude;
    console.log(
      `[1] CLAUDE       | Available: ${c.available ? 'YES' : 'NO '} | 5h Usage: ${c.fiveHourUsagePercent !== null ? `${c.fiveHourUsagePercent}%` : 'n/a'} | 7d Usage: ${c.sevenDayUsagePercent !== null ? `${c.sevenDayUsagePercent}%` : 'n/a'} | Trigger: label 'agent:claude' or '@claude'`,
    );
    const g = status.agents.gemini;
    console.log(
      `[2] GEMINI       | Available: ${g.available ? 'YES' : 'NO '} | Quota: ${g.available ? 'OK' : 'COOLDOWN'}                            | Trigger: label 'agent:gemini' or '@gemini-cli'`,
    );
    const cu = status.agents.cursor;
    console.log(
      `[3] CURSOR (LOW) | Available: ${cu.available ? 'YES' : 'NO '} | Note: Shares usage with Grok Bot (fallback only) | Trigger: label 'agent:cursor' or '@cursor'`,
    );
  }
}
