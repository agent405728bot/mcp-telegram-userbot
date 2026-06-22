/** FIFO mutex — ensures only one critical section runs at a time.
 * Used in master to serialize tool calls with QR login flow:
 * login holds the lock for up to minutes; tool calls queue behind it. */
export class GlobalLock {
    locked = false;
    waiters = [];
    async acquire() {
        if (this.locked) {
            await new Promise((resolve) => this.waiters.push(resolve));
        }
        this.locked = true;
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.locked = false;
            const next = this.waiters.shift();
            if (next)
                next();
        };
    }
    isLocked() {
        return this.locked;
    }
    waitingCount() {
        return this.waiters.length;
    }
}
