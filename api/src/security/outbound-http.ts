import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && parts[2] === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && parts[2] === 100)
    || (a === 203 && b === 0 && parts[2] === 113)
    || a >= 224;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") return true;

  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4);
  const mappedHex = normalized.match(/::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isPrivateIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }

  const firstGroup = Number.parseInt(normalized.split(":")[0] || "0", 16);
  return (firstGroup & 0xfe00) === 0xfc00
    || (firstGroup & 0xffc0) === 0xfe80
    || (firstGroup & 0xff00) === 0xff00
    || normalized.startsWith("2001:db8:");
}

export function isPrivateNetworkAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

export type LookupAddress = { address: string; family: number };
export type LookupAll = (hostname: string) => Promise<LookupAddress[]>;

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

async function resolvePublicHttpUrl(rawUrl: string, lookup: LookupAll): Promise<{
  parsed: URL;
  addresses: LookupAddress[];
}> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid outbound URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Unsupported outbound URL scheme");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Outbound URL credentials are not allowed");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname
    || hostname === "localhost"
    || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new Error("Private outbound host is not allowed");
  }

  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname);

  if (!addresses.length || addresses.some(({ address }) => isPrivateNetworkAddress(address))) {
    throw new Error("Private outbound address is not allowed");
  }

  return { parsed, addresses };
}

export async function validatePublicHttpUrl(rawUrl: string, lookup: LookupAll = defaultLookup): Promise<URL> {
  return (await resolvePublicHttpUrl(rawUrl, lookup)).parsed;
}

function requestPinned(
  parsed: URL,
  resolved: LookupAddress,
  init: RequestInit,
  timeoutMs: number,
): Promise<globalThis.Response> {
  if (init.body) throw new Error("Pinned outbound requests do not accept a request body");
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const transport = parsed.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(parsed, {
      method: init.method || "GET",
      headers,
      lookup: ((_hostname: string, _options: unknown, callback: (...args: any[]) => void) => {
        callback(null, resolved.address, resolved.family);
      }) as any,
    }, (upstream) => {
      clearTimeout(timer);
      if (init.signal) init.signal.removeEventListener("abort", abortRequest);

      const responseHeaders = new Headers();
      for (const [name, rawValue] of Object.entries(upstream.headers)) {
        if (Array.isArray(rawValue)) {
          for (const value of rawValue) responseHeaders.append(name, value);
        } else if (rawValue !== undefined) {
          responseHeaders.set(name, String(rawValue));
        }
      }
      const status = upstream.statusCode || 502;
      const noBody = init.method === "HEAD" || status === 204 || status === 205 || status === 304;
      const body = noBody ? null : Readable.toWeb(upstream) as ReadableStream<Uint8Array>;
      resolve(new Response(body, {
        status,
        statusText: upstream.statusMessage,
        headers: responseHeaders,
      }));
    });

    const abortRequest = () => request.destroy(new Error("Outbound request aborted"));
    const timer = setTimeout(() => request.destroy(new Error("Outbound request timed out")), timeoutMs);
    timer.unref();
    request.once("error", (error) => {
      clearTimeout(timer);
      if (init.signal) init.signal.removeEventListener("abort", abortRequest);
      reject(error);
    });
    if (init.signal?.aborted) {
      abortRequest();
    } else {
      init.signal?.addEventListener("abort", abortRequest, { once: true });
    }
    request.end();
  });
}

export async function fetchPublicHttpUrl(
  rawUrl: string,
  init: RequestInit = {},
  options: { lookup?: LookupAll; maxRedirects?: number; timeoutMs?: number } = {},
): Promise<{ response: globalThis.Response; url: URL }> {
  const maxRedirects = options.maxRedirects ?? 3;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let current = rawUrl;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const { parsed, addresses } = await resolvePublicHttpUrl(current, options.lookup ?? defaultLookup);
    // Pin the connection to the address we validated. A hostile DNS server
    // cannot answer public during validation and loopback during the request.
    const response = await requestPinned(parsed, addresses[0], init, timeoutMs);
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, url: parsed };
    }

    const location = response.headers.get("location");
    if (!location || redirectCount === maxRedirects) {
      await response.body?.cancel();
      throw new Error("Outbound redirect limit exceeded");
    }

    await response.body?.cancel();
    current = new URL(location, parsed).toString();
  }

  throw new Error("Outbound redirect limit exceeded");
}
