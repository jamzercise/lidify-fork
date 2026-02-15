import { PrismaClient, Prisma } from "@prisma/client";
import { logger } from "./logger";

// Configure connection pool for production use
// Default: connection_limit = num_cpus * 2 + 1
// We explicitly set it for predictable behavior under load
const parsedLimit = parseInt(process.env.DATABASE_POOL_SIZE || "20", 10);
const parsedTimeout = parseInt(process.env.DATABASE_POOL_TIMEOUT || "30", 10);
const statementTimeoutSec = parseInt(process.env.DATABASE_STATEMENT_TIMEOUT_SEC || "60", 10);
const connectionLimit = Number.isNaN(parsedLimit) ? 20 : parsedLimit;
const poolTimeout = Number.isNaN(parsedTimeout) ? 30 : parsedTimeout;

const urlParams = [
    `connection_limit=${connectionLimit}`,
    `pool_timeout=${poolTimeout}`,
    `statement_timeout=${statementTimeoutSec * 1000}`, // PostgreSQL ms
].join("&");

export const prisma = new PrismaClient({
    log:
        (
            process.env.NODE_ENV === "development" &&
            process.env.LOG_QUERIES === "true"
        ) ?
            ["query", "error", "warn"]
        :   ["error", "warn"],
    datasources: {
        db: {
            url:
                process.env.DATABASE_URL ?
                    `${process.env.DATABASE_URL}${process.env.DATABASE_URL.includes("?") ? "&" : "?"}${urlParams}`
                :   undefined,
        },
    },
});

// Log pool configuration on startup
logger.info(
    `Database connection pool configured: limit=${connectionLimit}, timeout=${poolTimeout}s, statement_timeout=${statementTimeoutSec}s`,
);

export { Prisma };
