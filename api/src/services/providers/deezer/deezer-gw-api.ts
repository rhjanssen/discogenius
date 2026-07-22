import { loadDeezerCredentials } from "./deezer-auth.js";

const GW_LIGHT_URL = "https://www.deezer.com/ajax/gw-light.php";

export type DeezerGwFetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export class DeezerGwApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "DeezerGwApiError";
  }
}

function resolveFetch(fetchImpl?: DeezerGwFetchLike): DeezerGwFetchLike {
  if (fetchImpl) return fetchImpl;
  if (typeof fetch === "function") return fetch as unknown as DeezerGwFetchLike;
  throw new Error("No fetch implementation is available for Deezer gw-light.");
}

export interface DeezerGwSession {
  arl: string;
  sid: string;
  apiToken: string;
  userId: number;
  language: string;
}

/**
 * Deezer gw-light returns `error: []` (or `{}`) on success. Both are truthy in
 * JS, so treat only non-empty error payloads as failures.
 */
export function deezerGwErrorMessage(error: unknown): string | null {
  if (error == null) return null;
  if (Array.isArray(error)) {
    if (error.length === 0) return null;
    const parts = error.map((entry) => String(entry || "").trim()).filter(Boolean);
    return parts.length > 0 ? parts.join(": ") : "Deezer gw-light request failed";
  }
  if (typeof error === "object") {
    const values = Object.values(error as Record<string, unknown>)
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
    if (values.length === 0) return null;
    return values.join(": ");
  }
  const text = String(error).trim();
  return text || null;
}

async function gwRequest(
  method: string,
  payload: Record<string, unknown>,
  session: Pick<DeezerGwSession, "arl" | "sid" | "apiToken">,
  fetchImpl?: DeezerGwFetchLike,
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({
    method,
    input: "3",
    api_version: "1.0",
    api_token: method === "deezer.getUserData" ? "" : session.apiToken,
    cid: String(Math.floor(Math.random() * 1_000_000_000)),
  });
  const response = await resolveFetch(fetchImpl)(`${GW_LIGHT_URL}?${params.toString()}`, {
    method: "POST",
    headers: {
      Accept: "*/*",
      "Content-Type": "text/plain;charset=UTF-8",
      Cookie: `sid=${session.sid}; arl=${session.arl}`,
      Origin: "https://www.deezer.com",
      Referer: "https://www.deezer.com/",
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json() as {
    error?: unknown;
    results?: Record<string, unknown>;
  };
  const errorMessage = deezerGwErrorMessage(body.error);
  if (!response.ok || errorMessage) {
    throw new DeezerGwApiError(
      response.status || 500,
      errorMessage || `Deezer gw-light failed (${response.status})`,
    );
  }
  return body.results ?? {};
}

export async function createDeezerGwSession(
  arl = loadDeezerCredentials()?.arl,
  fetchImpl?: DeezerGwFetchLike,
): Promise<DeezerGwSession> {
  const trimmed = String(arl || "").trim();
  if (!trimmed) {
    throw new DeezerGwApiError(401, "Connect Deezer with an ARL cookie before importing library data.");
  }

  const ping = await resolveFetch(fetchImpl)(`${GW_LIGHT_URL}?method=deezer.ping&api_version=1.0&api_token`, {
    headers: { Accept: "application/json" },
  });
  const pingBody = await ping.json() as { results?: { SESSION?: string } };
  const sid = String(pingBody.results?.SESSION || "").trim();
  if (!sid) {
    throw new DeezerGwApiError(502, "Deezer session bootstrap failed.");
  }

  const userData = await gwRequest("deezer.getUserData", {}, { arl: trimmed, sid, apiToken: "" }, fetchImpl);
  const user = userData.USER as Record<string, unknown> | undefined;
  const settings = user?.SETTING as Record<string, unknown> | undefined;
  const globalSettings = settings?.global as Record<string, unknown> | undefined;
  const userId = Number(user?.USER_ID || 0);
  if (!userId) {
    throw new DeezerGwApiError(401, "Deezer ARL is invalid or expired.");
  }

  return {
    arl: trimmed,
    sid,
    apiToken: String(userData.checkForm || ""),
    userId,
    language: String(globalSettings?.language || "en"),
  };
}

export async function deezerGwCall(
  session: DeezerGwSession,
  method: string,
  payload: Record<string, unknown> = {},
  fetchImpl?: DeezerGwFetchLike,
): Promise<Record<string, unknown>> {
  return gwRequest(method, payload, session, fetchImpl);
}
