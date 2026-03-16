/**
 * Read an integer from an environment variable with safe parsing.
 *
 * Returns `fallback` when:
 *  - the variable is not set
 *  - the value is not a finite number
 *  - the value is below `min`
 *
 * @param name - Environment variable name
 * @param fallback - Default value when the variable is missing or invalid
 * @param min - Minimum allowed value (defaults to 1)
 */
export function readIntEnv(name: string, fallback: number, min: number = 1): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;

    const value = Math.floor(parsed);
    if (value < min) return fallback;
    return value;
}
