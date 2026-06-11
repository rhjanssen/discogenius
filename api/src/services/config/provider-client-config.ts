import type { AppConfig } from "./config.js";

const DEFAULT_TIDAL_AUTH_CLIENT_ID = "cgiF7TQuB97BUIu3";
const DEFAULT_TIDAL_AUTH_CLIENT_SECRET = "1nqpgx8uvBdZigrx4hUPDV2hOwgYAAAG5DYXOr6uNf8=";
const DEFAULT_TIDAL_AUTH_USER_AGENT = "TIDAL_ANDROID/1039 okhttp/3.14.9";
const DEFAULT_ORPHEUS_MOBILE_HIRES_TOKEN = "6BDSRdpK9hqEBTgU";
const DEFAULT_ORPHEUS_MOBILE_ATMOS_TOKEN = "km8T1xS355y7dd3H";
const DEFAULT_ACOUSTID_CLIENT_ID = "QANd68ji1L";

type EnvSource = NodeJS.ProcessEnv;

function normalizeOptionalValue(value: string | undefined | null): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : undefined;
}

export interface TidalAuthClientConfig {
  clientId: string;
  clientSecret: string;
  authUserAgent: string;
}

export interface OrpheusTidalModuleConfig {
  clientId: string;
  clientSecret: string;
  mobileHiresToken: string;
  mobileAtmosToken: string;
}

export function resolveTidalAuthClientConfig(env: EnvSource = process.env): TidalAuthClientConfig {
  return {
    clientId: normalizeOptionalValue(env.TIDAL_AUTH_CLIENT_ID) || DEFAULT_TIDAL_AUTH_CLIENT_ID,
    clientSecret: normalizeOptionalValue(env.TIDAL_AUTH_CLIENT_SECRET) || DEFAULT_TIDAL_AUTH_CLIENT_SECRET,
    authUserAgent: normalizeOptionalValue(env.TIDAL_AUTH_USER_AGENT) || DEFAULT_TIDAL_AUTH_USER_AGENT,
  };
}

export function resolveOrpheusTidalModuleConfig(env: EnvSource = process.env): OrpheusTidalModuleConfig {
  const tidalAuthClient = resolveTidalAuthClientConfig(env);
  return {
    clientId: normalizeOptionalValue(env.ORPHEUS_TIDAL_CLIENT_ID) || tidalAuthClient.clientId,
    clientSecret: normalizeOptionalValue(env.ORPHEUS_TIDAL_CLIENT_SECRET) || tidalAuthClient.clientSecret,
    mobileHiresToken: normalizeOptionalValue(env.ORPHEUS_MOBILE_HIRES_TOKEN) || DEFAULT_ORPHEUS_MOBILE_HIRES_TOKEN,
    mobileAtmosToken: normalizeOptionalValue(env.ORPHEUS_MOBILE_ATMOS_TOKEN) || DEFAULT_ORPHEUS_MOBILE_ATMOS_TOKEN,
  };
}

export function resolveAcoustIdClientId(options?: {
  env?: EnvSource;
  appConfig?: Partial<AppConfig> | null;
}): string {
  const env = options?.env ?? process.env;
  const configValue = normalizeOptionalValue(options?.appConfig?.acoustid_api_key);

  return normalizeOptionalValue(env.ACOUSTID_CLIENT_ID)
    || configValue
    || DEFAULT_ACOUSTID_CLIENT_ID;
}
