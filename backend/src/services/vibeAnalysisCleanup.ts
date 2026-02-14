import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { enrichmentFailureService } from "./enrichmentFailureService";

const STALE_THRESHOLD_MINUTES = 30; // Longer than audio analysis due to CLAP processing time
const MAX_RETRIES = 3;
const CIRCUIT_BREAKER_THRESHOLD = 20;
const CIRCUIT_BREAKER_WINDOW_MS = 5 * 60 * 1000;

type CircuitState = "closed" | "open" | "half-open";

class VibeAnalysisCleanupService {
    private state: CircuitState = "closed";
    private failureCount = 0;
    private lastFailureTime: Date | null = null;

    private shouldAttemptReset(): boolean {
        if (!this.lastFailureTime) return false;
        return Date.now() - this.lastFailureTime.getTime() >= CIRCUIT_BREAKER_WINDOW_MS;
    }

    private onSuccess(): void {
        if (this.state === "half-open") {
            logger.info(
                `[VibeAnalysisCleanup] Circuit breaker CLOSED - recovery successful after ${this.failureCount} failures`
            );
            this.state = "closed";
            this.failureCount = 0;
            this.lastFailureTime = null;
        } else if (this.state === "closed" && this.failureCount > 0) {
            this.failureCount = 0;
            this.lastFailureTime = null;
        }
    }

    private onFailure(resetCount: number, permanentlyFailedCount: number): void {
        this.failureCount += 1;
        this.lastFailureTime = new Date();
        if (this.state === "half-open") {
            this.state = "open";
            logger.warn(
                `[VibeAnalysisCleanup] Circuit breaker REOPENED - recovery attempt failed (${this.failureCount} total failures)`
            );
        } else if (this.failureCount >= CIRCUIT_BREAKER_THRESHOLD) {
            this.state = "open";
            logger.warn(
                `[VibeAnalysisCleanup] Circuit breaker OPEN - ${this.failureCount} failures in window. ` +
                    `Pausing vibe embedding queue until CLAP workers show signs of life.`
            );
        }
    }

    isCircuitOpen(): boolean {
        if (this.state === "open" && this.shouldAttemptReset()) {
            this.state = "half-open";
            logger.info(
                `[VibeAnalysisCleanup] Circuit breaker HALF-OPEN - attempting recovery after ${CIRCUIT_BREAKER_WINDOW_MS / 60000} minute cooldown`
            );
        }
        return this.state === "open";
    }

    recordSuccess(): void {
        this.onSuccess();
    }

    /**
     * Clean up tracks stuck in "processing" state for vibe embeddings.
     * Resets for retry up to MAX_RETRIES, then marks permanent failure and records in enrichment failures.
     */
    async cleanupStaleProcessing(): Promise<{
        reset: number;
        permanentlyFailed: number;
    }> {
        const cutoff = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000);

        const staleTracks = await prisma.track.findMany({
            where: {
                vibeAnalysisStatus: "processing",
                OR: [
                    { vibeAnalysisStatusUpdatedAt: { lt: cutoff } },
                    {
                        vibeAnalysisStatusUpdatedAt: null,
                        updatedAt: { lt: cutoff },
                    },
                ],
            },
            include: {
                album: {
                    include: {
                        artist: { select: { name: true } },
                    },
                },
            },
        });

        if (staleTracks.length === 0) {
            return { reset: 0, permanentlyFailed: 0 };
        }

        logger.debug(
            `[VibeAnalysisCleanup] Found ${staleTracks.length} stale vibe tracks (processing > ${STALE_THRESHOLD_MINUTES} min)`
        );

        let resetCount = 0;
        let permanentlyFailedCount = 0;
        const now = new Date();

        for (const track of staleTracks) {
            const trackName = `${track.album.artist.name} - ${track.title}`;
            const newRetryCount = (track.vibeAnalysisRetryCount ?? 0) + 1;

            if (newRetryCount >= MAX_RETRIES) {
                await prisma.track.update({
                    where: { id: track.id },
                    data: {
                        vibeAnalysisStatus: "failed",
                        vibeAnalysisError: `Exceeded ${MAX_RETRIES} retry attempts (stale processing)`,
                        vibeAnalysisRetryCount: newRetryCount,
                        vibeAnalysisStatusUpdatedAt: now,
                    },
                });
                await enrichmentFailureService.recordFailure({
                    entityType: "vibe",
                    entityId: track.id,
                    entityName: trackName,
                    errorMessage: `Vibe embedding timed out ${MAX_RETRIES} times - track may be unsupported`,
                    errorCode: "VIBE_MAX_RETRIES_EXCEEDED",
                    metadata: {
                        filePath: track.filePath,
                        retryCount: newRetryCount,
                    },
                });
                logger.warn(`[VibeAnalysisCleanup] Permanently failed: ${trackName}`);
                permanentlyFailedCount++;
            } else {
                await prisma.track.update({
                    where: { id: track.id },
                    data: {
                        vibeAnalysisStatus: "pending",
                        vibeAnalysisStatusUpdatedAt: now,
                        vibeAnalysisRetryCount: newRetryCount,
                        vibeAnalysisError: `Reset after stale processing (attempt ${newRetryCount}/${MAX_RETRIES})`,
                    },
                });
                logger.debug(
                    `[VibeAnalysisCleanup] Reset for retry (${newRetryCount}/${MAX_RETRIES}): ${trackName}`
                );
                resetCount++;
            }
        }

        if (resetCount > 0 || permanentlyFailedCount > 0) {
            this.onFailure(resetCount, permanentlyFailedCount);
        }

        logger.debug(
            `[VibeAnalysisCleanup] Cleanup complete: ${resetCount} reset, ${permanentlyFailedCount} permanently failed`
        );
        return { reset: resetCount, permanentlyFailed: permanentlyFailedCount };
    }
}

export const vibeAnalysisCleanupService = new VibeAnalysisCleanupService();
