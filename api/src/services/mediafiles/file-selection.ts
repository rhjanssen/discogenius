import { RequestValidationError } from "../../utils/request-validation.js";

export function parseFileSelectionIds(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 5000
    || value.some(id => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) {
    throw new RequestValidationError("ids must contain 1 to 5000 positive integer file identifiers");
  }
  return [...new Set(value)];
}
