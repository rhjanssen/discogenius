export type ContractRecord = Record<string, unknown>;

export function expectRecord(value: unknown, label: string): ContractRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value as ContractRecord;
}

export function expectArray<T>(
  value: unknown,
  label: string,
  parseItem: (item: unknown, index: number) => T,
): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  return value.map((item, index) => parseItem(item, index));
}

export function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  return value;
}

export function expectIdentifierString(value: unknown, label: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  throw new Error(`${label} must be a string or number identifier`);
}

export function expectOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return expectString(value, label);
}

export function expectOptionalIdentifierString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return expectIdentifierString(value, label);
}

export function expectNullableString(value: unknown, label: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }

  return expectString(value, label);
}

export function expectNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }

  return value;
}

export function expectOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return expectNumber(value, label);
}

export function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }

  return value;
}

export function expectOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return expectBoolean(value, label);
}

export function expectOneOf<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  label: string,
): T {
  const parsed = expectString(value, label);
  if (!allowedValues.includes(parsed as T)) {
    throw new Error(`${label} must be one of: ${allowedValues.join(", ")}`);
  }

  return parsed as T;
}

export function expectOptionalOneOf<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  label: string,
): T | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return expectOneOf(value, allowedValues, label);
}
