/**
 * Persistent daemon mode: own the single Telegram connection and serve many concurrent
 * IPC clients, with no stdio and no stdin-exit, so closing any client never tears the
 * connection down. Intended to run under a supervisor (systemd, Docker) with Restart=always.
 */
export declare function runServe(apiId: number, apiHash: string, version: string): Promise<void>;
