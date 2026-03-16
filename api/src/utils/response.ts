import { Response } from "express";

/**
 * Standardized API error response.
 * Always returns: { error: string, detail?: string }
 */
export function sendError(res: Response, status: number, error: string, detail?: string): void {
    const body: { error: string; detail?: string } = { error };
    if (detail) body.detail = detail;
    res.status(status).json(body);
}

/**
 * Standardized success wrapper for JSON responses.
 */
export function sendSuccess<T>(res: Response, data: T, status = 200): void {
    res.status(status).json(data);
}
