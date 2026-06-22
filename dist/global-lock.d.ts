/** FIFO mutex — ensures only one critical section runs at a time.
 * Used in master to serialize tool calls with QR login flow:
 * login holds the lock for up to minutes; tool calls queue behind it. */
export declare class GlobalLock {
    private locked;
    private waiters;
    acquire(): Promise<() => void>;
    isLocked(): boolean;
    waitingCount(): number;
}
