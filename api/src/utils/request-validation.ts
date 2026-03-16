export type JsonObject = Record<string, unknown>;

export class RequestValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RequestValidationError";
    }
}

function isPlainObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getObjectBody(body: unknown, message = "Request body must be a JSON object"): JsonObject {
    if (!isPlainObject(body)) {
        throw new RequestValidationError(message);
    }

    return body;
}

export function getOptionalBoolean(body: JsonObject, key: string): boolean | undefined {
    const value = body[key];
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== "boolean") {
        throw new RequestValidationError(`${key} must be a boolean`);
    }

    return value;
}

export function getRequiredBoolean(body: JsonObject, key: string): boolean {
    const value = getOptionalBoolean(body, key);
    if (value === undefined) {
        throw new RequestValidationError(`${key} is required`);
    }

    return value;
}

export function getOptionalNumber(body: JsonObject, key: string): number | undefined {
    const value = body[key];
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new RequestValidationError(`${key} must be a number`);
    }

    return value;
}

export function getOptionalInteger(body: JsonObject, key: string): number | undefined {
    const value = getOptionalNumber(body, key);
    if (value === undefined) {
        return undefined;
    }

    if (!Number.isInteger(value)) {
        throw new RequestValidationError(`${key} must be an integer`);
    }

    return value;
}

export function getRequiredInteger(body: JsonObject, key: string): number {
    const value = getOptionalInteger(body, key);
    if (value === undefined) {
        throw new RequestValidationError(`${key} is required`);
    }

    return value;
}

export function getOptionalString(body: JsonObject, key: string): string | undefined {
    const value = body[key];
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== "string") {
        throw new RequestValidationError(`${key} must be a string`);
    }

    const trimmed = value.trim();
    if (!trimmed) {
        throw new RequestValidationError(`${key} must not be empty`);
    }

    return trimmed;
}

export function getRequiredString(body: JsonObject, key: string): string {
    const value = getOptionalString(body, key);
    if (value === undefined) {
        throw new RequestValidationError(`${key} is required`);
    }

    return value;
}

export function getOptionalIdentifier(body: JsonObject, key: string): string | undefined {
    const value = body[key];
    if (value === undefined) {
        return undefined;
    }

    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
            throw new RequestValidationError(`${key} must not be empty`);
        }

        return trimmed;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }

    throw new RequestValidationError(`${key} must be a string or number`);
}

export function getRequiredIdentifier(body: JsonObject, key: string): string {
    const value = getOptionalIdentifier(body, key);
    if (value === undefined) {
        throw new RequestValidationError(`${key} is required`);
    }

    return value;
}

export function getEnumValue<T extends string>(body: JsonObject, key: string, allowedValues: readonly T[]): T {
    const value = getRequiredString(body, key);
    if (!allowedValues.includes(value as T)) {
        throw new RequestValidationError(`${key} must be one of: ${allowedValues.join(", ")}`);
    }

    return value as T;
}

export function getRequiredIntegerArray(body: JsonObject, key: string): number[] {
    const value = body[key];
    if (!Array.isArray(value) || value.length === 0) {
        throw new RequestValidationError(`${key} must be a non-empty array`);
    }

    return value.map((entry) => {
        if (typeof entry !== "number" || !Number.isInteger(entry)) {
            throw new RequestValidationError(`${key} must contain only integers`);
        }

        return entry;
    });
}

export function isRequestValidationError(error: unknown): error is RequestValidationError {
    return error instanceof RequestValidationError;
}