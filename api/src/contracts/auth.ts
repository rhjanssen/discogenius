import {
  expectBoolean,
  expectNumber,
  expectOneOf,
  expectOptionalBoolean,
  expectOptionalString,
  expectRecord,
} from "./runtime.js";

export const PROVIDER_AUTH_MODE_VALUES = ["live", "mock", "disconnected"] as const;
export type ProviderAuthMode = (typeof PROVIDER_AUTH_MODE_VALUES)[number];

export interface ProviderAuthUserContract {
  username?: string;
}

export interface AuthStatusContract {
  connected: boolean;
  tokenExpired: boolean;
  refreshTokenExpired: boolean;
  hoursUntilExpiry: number;
  mode: ProviderAuthMode;
  canAccessShell: boolean;
  canAccessLocalLibrary: boolean;
  remoteCatalogAvailable: boolean;
  authBypassed: boolean;
  canAuthenticate: boolean;
  refreshing?: boolean;
  user?: ProviderAuthUserContract | null;
  message?: string;
}

export function parseAuthStatusContract(value: unknown): AuthStatusContract {
  const record = expectRecord(value, "Auth status");
  const userValue = record.user;

  let user: ProviderAuthUserContract | null | undefined;
  if (userValue === undefined) {
    user = undefined;
  } else if (userValue === null) {
    user = null;
  } else {
    const userRecord = expectRecord(userValue, "authStatus.user");
    user = {
      username: expectOptionalString(userRecord.username, "authStatus.user.username"),
    };
  }

  return {
    connected: expectBoolean(record.connected, "authStatus.connected"),
    tokenExpired: expectBoolean(record.tokenExpired, "authStatus.tokenExpired"),
    refreshTokenExpired: expectBoolean(record.refreshTokenExpired, "authStatus.refreshTokenExpired"),
    hoursUntilExpiry: expectNumber(record.hoursUntilExpiry, "authStatus.hoursUntilExpiry"),
    mode: expectOneOf(record.mode, PROVIDER_AUTH_MODE_VALUES, "authStatus.mode"),
    canAccessShell: expectBoolean(record.canAccessShell, "authStatus.canAccessShell"),
    canAccessLocalLibrary: expectBoolean(record.canAccessLocalLibrary, "authStatus.canAccessLocalLibrary"),
    remoteCatalogAvailable: expectBoolean(record.remoteCatalogAvailable, "authStatus.remoteCatalogAvailable"),
    authBypassed: expectBoolean(record.authBypassed, "authStatus.authBypassed"),
    canAuthenticate: expectBoolean(record.canAuthenticate, "authStatus.canAuthenticate"),
    refreshing: expectOptionalBoolean(record.refreshing, "authStatus.refreshing"),
    user,
    message: expectOptionalString(record.message, "authStatus.message"),
  };
}
