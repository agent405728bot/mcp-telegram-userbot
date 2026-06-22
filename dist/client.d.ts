import { type Socket } from "node:net";
import { type IpcLoginDone } from "./ipc-protocol.js";
export interface IpcClientOptions {
    connectTimeoutMs?: number;
    callTimeoutMs?: number;
    loginTimeoutMs?: number;
    connectFn?: (path: string) => Socket;
}
/** Thin IPC proxy: forwards tool calls to the master process over Unix socket */
export declare class IpcClient {
    private socket;
    private pending;
    private pendingLogins;
    private buf;
    private connected;
    private destroyed;
    private onDisconnect?;
    private readonly connectTimeoutMs;
    private readonly callTimeoutMs;
    private readonly loginTimeoutMs;
    private readonly connectFn;
    constructor(opts?: IpcClientOptions);
    /** Register a callback fired when the peer socket closes unexpectedly.
     * Call this AFTER a successful connect() so aborted connection attempts don't fire it. */
    setOnDisconnect(cb: () => void): void;
    connect(): Promise<boolean>;
    private routeMessage;
    isConnected(): boolean;
    call(tool: string, args: Record<string, unknown>): Promise<unknown>;
    /** Request QR login flow from master. `onQr` fires for each QR URL frame (refreshes ~every 10s).
     * Only one login can run on the master side at a time — a concurrent call gets an immediate
     * `login_done {success:false}` with "Another QR login is already in progress". */
    loginFlow(onQr: (url: string) => void): Promise<IpcLoginDone>;
    destroy(): void;
}
export declare function runClient(apiId: number, apiHash: string, version: string): Promise<void>;
