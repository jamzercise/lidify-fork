import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";

/** Default request timeout in ms (90s). Stuck handlers are aborted so connections don't pile up. */
const DEFAULT_TIMEOUT_MS = 90 * 1000;

/**
 * Request timeout middleware.
 * If the handler doesn't respond within the timeout, respond with 503 and log.
 * Skips streaming, health, and docs endpoints.
 */
export function requestTimeout(timeoutMs: number = DEFAULT_TIMEOUT_MS) {
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
            logger.warn(`[RequestTimeout] ${req.method} ${path} timed out after ${timeoutMs}ms`);
            res.status(503).json({
                error: "Request timeout",
                message: "The server took too long to respond. Please try again.",
            });
        }, timeoutMs);

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
