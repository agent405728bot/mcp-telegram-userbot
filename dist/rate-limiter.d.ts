/**
 * Rate limiter and retry logic for Telegram API calls.
 * Handles FLOOD_WAIT errors and implements exponential backoff.
 *
 * Emits structured events on stderr so downstream log collectors (e.g. cloud
 * SigNoz) can aggregate by `event` and `context`. Format:
 *   [rate-limiter] event {"event":"flood_wait","context":"X","seconds":N,...}
 */
export interface RateLimiterOptions {
    /** Maximum number of requests per second (default: 20) */
    maxRequestsPerSecond?: number;
    /** Maximum number of retry attempts (default: 3) */
    maxRetries?: number;
    /** Initial retry delay in milliseconds (default: 1000) */
    initialRetryDelay?: number;
    /** Maximum retry delay in milliseconds (default: 60000) */
    maxRetryDelay?: number;
}
export declare class RateLimiter {
    private minInterval;
    private maxRetries;
    private initialRetryDelay;
    private maxRetryDelay;
    private slotQueue;
    constructor(options?: RateLimiterOptions);
    /**
     * Execute a function with rate limiting and automatic retry.
     * @param throwOnFloodWait If true, throw immediately on FLOOD_WAIT instead of sleeping (use for
     *   endpoints with very long rate-limit windows like stats APIs).
     */
    execute<T>(fn: () => Promise<T>, context?: string, options?: {
        throwOnFloodWait?: boolean;
    }): Promise<T>;
    private executeWithRetry;
    private waitForSlot;
}
