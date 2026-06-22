import { type Server, type Socket } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpServerInternal } from "./ipc-protocol.js";
import { TelegramService } from "./telegram-client.js";
export declare function handleClient(socket: Socket, mcpServer: McpServerInternal, telegram: TelegramService): void;
export interface OwnerHandle {
    server: McpServer;
    srv: Server;
    gracefulExit: () => Promise<void>;
}
/**
 * Bootstrap the connection owner shared by master (stdio) and serve (daemon) modes:
 * build the tool registry, listen on the IPC socket, install a graceful shutdown that
 * disconnects Telegram, and auto-connect the single client. No stdio is attached here —
 * the caller decides whether to also serve a stdio MCP session (master) or not (serve).
 */
export declare function startOwner(telegram: TelegramService, version: string, opts?: {
    label?: string;
}): Promise<OwnerHandle>;
export declare function runMaster(apiId: number, apiHash: string, version: string): Promise<void>;
