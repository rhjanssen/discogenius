import type { FailureCategoryContract, FailureNoticeContract } from "../../contracts/status.js";
import { providerAuthCopy } from "../providers/provider-auth-state.js";

const PROVIDER_LABELS: Record<string, string> = {
  tidal: "TIDAL",
  "apple-music": "Apple Music",
  deezer: "Deezer",
  "youtube-music": "YouTube Music",
  youtube: "YouTube",
  spotify: "Spotify",
  "amazon-music": "Amazon Music",
  soundcloud: "SoundCloud",
};

const SUMMARY_MAX = 120;

function providerLabel(provider: string | null | undefined): string | null {
  const id = String(provider ?? "").trim().toLowerCase();
  if (!id) return null;
  return PROVIDER_LABELS[id] ?? id;
}

/** The exception a Python traceback ends with, e.g. `APIError: {...}`. */
function lastExceptionLine(text: string): string | null {
  const lines = text.split(/\r?\n|;\s/u).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^[A-Za-z_][\w.]*(?:Error|Exception)\b:?/u.test(lines[index])) return lines[index];
  }
  return null;
}

/** Tool and classifier prefixes say which program failed, not why. */
function strippedMessage(text: string): string {
  return text
    .replace(/^\[[A-Za-z]+\]\s*/u, "")
    .replace(/^(?:Streamrip|yt-dlp|tiddl|apple-music-downloader)[^:]*?(?:exited|produced)[^:]*:\s*/iu, "")
    .replace(/^(?:unknown|transient|unavailable|quality|configuration|entitlement|geography|authentication):\s*/iu, "")
    .replace(/[╭╰│─╮╯]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function shorten(text: string): string {
  if (text.length <= SUMMARY_MAX) return text;
  const cut = text.slice(0, SUMMARY_MAX - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 60 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

type Rule = {
  test: RegExp;
  category: FailureCategoryContract;
  summary: (context: RuleContext) => string;
  hint?: (context: RuleContext) => string | null;
  action?: (context: RuleContext) => FailureNoticeContract["action"];
};

type RuleContext = { provider: string | null; label: string; match: RegExpMatchArray };

const signInAction = ({ provider }: RuleContext): FailureNoticeContract["action"] => {
  if (!provider) return { label: "Open provider settings", href: "/auth" };
  const copy = providerAuthCopy(provider);
  return { label: copy.settingsLabel, href: copy.href };
};

const SOURCE_WILL_CHANGE = "Discogenius will look for another source on its next search, or keep the album wanted.";

// Ordered: the first matching rule wins, so specific causes come before the
// generic words (timeout, not found) that their messages also contain.
const RULES: Rule[] = [
  {
    test: /partially mutated library files/iu,
    category: "interrupted",
    summary: () => "Import was interrupted before it finished",
    hint: () => "Some files may already be in the library. Retry to download and import it again.",
  },
  {
    test: /progress stopped|no progress/iu,
    category: "interrupted",
    summary: () => "Stopped because it made no progress",
    hint: () => "Retry. If it stops again for this item, share the details below.",
  },
  {
    test: /process restarted|worker restarted|worker stopped|lease expired|stale execution/iu,
    category: "interrupted",
    summary: () => "Interrupted by an app restart",
    hint: () => "Retry to run it again.",
  },
  {
    test: /session is not available yet|waiting for a token refresh/iu,
    category: "account",
    summary: ({ label }) => `${label} was refreshing its sign-in`,
    hint: () => "Retry in a minute.",
  },
  {
    test: /sign in to confirm your age/iu,
    category: "account",
    summary: () => "YouTube asks for age verification for this video",
    hint: () => "Add YouTube cookies under Providers to download age-restricted videos.",
    action: () => ({ label: "Go to YouTube Music", href: "/auth?provider=youtube-music" }),
  },
  {
    test: /ARL is invalid or expired|media-user-token|login expired|token (?:has )?expired|re-?authenticate|not logged in|invalid credentials|\bunauthori[sz]ed\b|\b401\b/iu,
    category: "account",
    summary: ({ label }) => `${label} sign-in has expired`,
    hint: ({ label }) => `Sign in to ${label} again, then retry.`,
    action: signInAction,
  },
  {
    test: /with your subscription|WrongLicense|HiFi is required|subscription required/iu,
    category: "quality",
    summary: ({ label }) => `Your ${label} plan doesn't include this quality`,
    hint: ({ label }) => `Lower the ${label} quality in Settings, or retry after upgrading the plan.`,
  },
  {
    test: /not available in (?:your|this) country|not streamable in the configured region|due to your country\/location|geo(?:graphically)?[- ]?restricted/iu,
    category: "unavailable",
    summary: ({ label }) => `Not available in your region on ${label}`,
    hint: () => SOURCE_WILL_CHANGE,
  },
  {
    test: /Failed to get album response/iu,
    category: "unavailable",
    summary: ({ label }) => `${label} didn't return this album`,
    hint: () => "It may not be in your storefront. Retry later, or pick another edition.",
  },
  {
    test: /no downloadable data|error getting downloadable data|DataException|This video is not available|Video unavailable|no longer available|All tracks unavailable|\bnot (?:available )?for stream|\bnot found\b|\b404\b/iu,
    category: "unavailable",
    summary: ({ label }) => `Not available on ${label}`,
    hint: () => SOURCE_WILL_CHANGE,
  },
  {
    test: /requested quality (?:is )?(?:not available|unavailable)|quality not available|no media URL/iu,
    category: "quality",
    summary: ({ label }) => `${label} doesn't offer this in the requested quality`,
    hint: () => SOURCE_WILL_CHANGE,
  },
  {
    test: /\b429\b|too many requests|rate.?limit|request limit reached|quota/iu,
    category: "rate-limit",
    summary: ({ label }) => `${label} is limiting requests`,
    hint: () => "Retry later.",
  },
  {
    test: /\bENOSPC\b|no space left/iu,
    category: "storage",
    summary: () => "The library disk is full",
    hint: () => "Free up space, then retry.",
  },
  {
    test: /\bEACCES\b|\bEPERM\b|permission denied|read-only file system/iu,
    category: "storage",
    summary: () => "Discogenius can't write to the library folder",
    hint: () => "Check that the container user can write to the library folders, then retry.",
  },
  {
    test: /audio tags were not applied[^]*?(\d+) file\(s\) missing/iu,
    category: "import",
    summary: ({ match }) => `Import incomplete: ${match[1]} file(s) went missing before tagging`,
    hint: () => "Rescan this artist's folder, then retry.",
  },
  {
    test: /audio tags were not applied/iu,
    category: "import",
    summary: () => "Couldn't write tags to the imported files",
    hint: () => "Retry. If it fails again, share the details below.",
  },
  {
    test: /without (?:exact )?(?:provider offer )?identity|no exact provider offers/iu,
    category: "import",
    summary: () => "Couldn't match the downloaded files to the album's tracks",
    hint: () => "Refresh the artist, then retry.",
  },
  {
    test: /produced no .*media files|without producing|No tracks downloaded/iu,
    category: "unavailable",
    summary: ({ label }) => `${label} delivered no audio files`,
    hint: () => "Retry. If it keeps failing, pick another edition.",
  },
  {
    test: /\bAPIError\b/u,
    category: "unknown",
    summary: ({ label }) => `${label} returned an error for this item`,
    hint: () => "Retry later. If it keeps failing, share the details below.",
  },
  {
    test: /sqlite busy|database is locked/iu,
    category: "unknown",
    summary: () => "The database stayed busy, so this was stopped",
    hint: () => "Retry later. This happens during large curation or refresh passes.",
  },
  {
    test: /timed out|timeout|\bECONNRESET\b|\bECONNREFUSED\b|\bENOTFOUND\b|\bEAI_AGAIN\b|socket hang up|connection pool is full|max retries exceeded|network/iu,
    category: "network",
    summary: ({ label }) => `Network problem while talking to ${label}`,
    hint: () => "Retry. If it keeps failing, check the server's internet connection.",
  },
];

/**
 * Turn a stored command error into something a person can act on. The first
 * matching rule names the cause; anything unrecognised keeps its own words,
 * minus tool prefixes and traceback frames.
 */
export function presentFailure(
  error: string | null | undefined,
  context: { provider?: string | null } = {},
): FailureNoticeContract | null {
  const detail = String(error ?? "").trim();
  if (!detail) return null;
  const message = detail.replace(/^Command stopped after \d+ execution attempt\(s\):\s*/iu, "");
  const provider = context.provider ? String(context.provider).trim().toLowerCase() || null : null;
  const label = providerLabel(provider) ?? "the provider";

  for (const rule of RULES) {
    const match = message.match(rule.test);
    if (!match) continue;
    const ruleContext: RuleContext = { provider, label, match };
    return {
      category: rule.category,
      summary: capitalized(rule.summary(ruleContext)),
      hint: rule.hint?.(ruleContext) ?? null,
      action: rule.action?.(ruleContext) ?? null,
      detail,
    };
  }

  const exception = lastExceptionLine(message);
  const reason = strippedMessage(exception ?? message.split(/\r?\n/u)[0]);
  const saysNothing = !reason || /^ERROR:?$/iu.test(reason) || (!exception && /\bTraceback\b/u.test(message));
  return {
    category: "unknown",
    summary: saysNothing ? capitalized(`${label} failed without giving a reason`) : shorten(capitalized(reason)),
    hint: saysNothing ? "Retry. If it fails again, share the details below." : null,
    action: null,
    detail,
  };
}
