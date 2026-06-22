export declare function lockPath(): string;
export declare function socketPath(): string;
/**
 * Try to acquire the master lock.
 * Returns true if this process is now the master.
 * Returns false if another live master process holds the lock.
 *
 * Uses PID file + kill -0 to detect stale locks after crashes.
 */
export declare function tryAcquireLock(): boolean;
export declare function releaseLock(): void;
export declare function releaseSocket(): void;
