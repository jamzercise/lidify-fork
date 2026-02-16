import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";

const DEFAULT_TIMEOUT_MS = 90 * 1000;
const timeoutMs =
    typeof process.env.REQUEST_TIMEOUT_MS !== "undefined"
        ? parseInt(process.env.REQUEST_TIMEOUT_MS, 10)
        : DEFAULT_TIMEOUT_MS;
const effectiveTimeout = Number.isNaN(timeoutMs) || timeoutMs <= 0 ? DEFAULT_TIMEOUT_MS : Math.min(timeoutMs, 300000);

/**
 * Request timeout middleware.
 * If the handler doesn't respond within the timeout, respond with 503 and log.
 * Skips streaming, health, and docs endpoints.
 */
export function requestTimeout(overrideMs?: number) {
    const ms = overrideMs ?? effectiveTimeout;
    return (req: Request, res: Response, next: NextFunction) => {
        const path = req.path;

        if (
            path === "/health" ||
            path === "/api/health" ||
            path.includes("/stream") ||
            path.startsWith("/api/docs")
        ) {
            return next();
        }

        let timeoutId: NodeJS.Timeout | null = setTimeout(() => {
            timeoutId = null;
            if (res.headersSent) return;
            logger.warn(`[RequestTimeout] ${req.method} ${path} timed out after ${ms}ms`);
            res.status(503).json({
                error: "Request timeout",
                message: "The server took too long to respond. Please try again.",
            });
        }, ms);

        const onFinish = () => {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            res.off("finish", onFinish);
            res.off("close", onFinish);
        };

        res.once("finish", onFinish);
        res.once("close", onFinish);
        next();
    };
}
