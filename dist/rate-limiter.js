/**
 * Rate limiter and retry logic for Telegram API calls.
 * Handles FLOOD_WAIT errors and implements exponential backoff.
 *
 * Emits structured events on stderr so downstream log collectors (e.g. cloud
 * SigNoz) can aggregate by `event` and `context`. Format:
 *   [rate-limiter] event {"event":"flood_wait","context":"X","seconds":N,...}
 */
export class RateLimiter {
    minInterval;
    maxRetries;
    initialRetryDelay;
    maxRetryDelay;
    // Serializes concurrent calls so each waits for the previous slot to clear
    slotQueue = Promise.resolve();
    constructor(options = {}) {
        const maxRequestsPerSecond = options.maxRequestsPerSecond ?? 20;
        this.minInterval = 1000 / maxRequestsPerSecond;
        this.maxRetries = options.maxRetries ?? 3;
        this.initialRetryDelay = options.initialRetryDelay ?? 1000;
        this.maxRetryDelay = options.maxRetryDelay ?? 60000;
    }
    /**
     * Execute a function with rate limiting and automatic retry.
     * @param throwOnFloodWait If true, throw immediately on FLOOD_WAIT instead of sleeping (use for
     *   endpoints with very long rate-limit windows like stats APIs).
     */
    async execute(fn, context = "API call", options) {
        return this.executeWithRetry(fn, context, 0, options);
    }
    async executeWithRetry(fn, context, attempt, options) {
        await this.waitForSlot();
        try {
            return await fn();
        }
        catch (error) {
            const errorMessage = error.errorMessage || error.message || String(error);
            // FLOOD_WAIT — wait the exact time Telegram requires (or throw immediately if requested)
            const floodMatch = errorMessage.match(/FLOOD_WAIT[_]?(\d+)/i);
            if (floodMatch) {
                const waitSeconds = Number.parseInt(floodMatch[1], 10);
                if (options?.throwOnFloodWait) {
                    throw new Error(`Rate limit: Telegram requires a ${waitSeconds}s wait for ${context}. Try again in ${Math.ceil(waitSeconds / 60)} minute(s).`);
                }
                if (attempt >= this.maxRetries) {
                    throw new Error(`Rate limit exceeded after ${this.maxRetries} retries. Telegram requires ${waitSeconds}s wait. Try again later.`);
                }
                logEvent({
                    event: "flood_wait",
                    context,
                    seconds: waitSeconds,
                    attempt: attempt + 1,
                    maxRetries: this.maxRetries,
                });
                await sleep(waitSeconds * 1000);
                return this.executeWithRetry(fn, context, attempt + 1, options);
            }
            // Network/timeout errors — exponential backoff
            if (isNetworkError(errorMessage)) {
                if (attempt >= this.maxRetries) {
                    throw new Error(`Network error after ${this.maxRetries} retries: ${errorMessage}. Check your connection.`);
                }
                const delay = Math.min(this.initialRetryDelay * 2 ** attempt, this.maxRetryDelay);
                logEvent({
                    event: "network_retry",
                    context,
                    delayMs: delay,
                    attempt: attempt + 1,
                    maxRetries: this.maxRetries,
                    error: errorMessage,
                });
                await sleep(delay);
                return this.executeWithRetry(fn, context, attempt + 1, options);
            }
            // Temporary server errors (5xx) — exponential backoff
            if (isTemporaryError(errorMessage)) {
                if (attempt >= this.maxRetries) {
                    throw new Error(`Temporary error after ${this.maxRetries} retries: ${errorMessage}`);
                }
                const delay = Math.min(this.initialRetryDelay * 2 ** attempt, this.maxRetryDelay);
                logEvent({
                    event: "temporary_retry",
                    context,
                    delayMs: delay,
                    attempt: attempt + 1,
                    maxRetries: this.maxRetries,
                    error: errorMessage,
                });
                await sleep(delay);
                return this.executeWithRetry(fn, context, attempt + 1, options);
            }
            // Non-retryable — throw immediately
            throw error;
        }
    }
    waitForSlot() {
        // Chain onto the previous slot so concurrent callers queue up sequentially.
        // Each turn: wait minInterval from when the previous turn started, then resolve.
        const nextSlot = this.slotQueue.then(() => sleep(this.minInterval));
        this.slotQueue = nextSlot;
        return nextSlot;
    }
}
function isNetworkError(msg) {
    return /TIMEOUT|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|ENOTFOUND|EHOSTUNREACH|network|timed out/i.test(msg);
}
function isTemporaryError(msg) {
    return /INTERNAL|^50[023]$|Internal Server Error|Service Unavailable|Bad Gateway/i.test(msg);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function logEvent(payload) {
    console.error(`[rate-limiter] event ${JSON.stringify(payload)}`);
}
