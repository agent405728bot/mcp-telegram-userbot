import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TelegramService } from "../telegram-client.js";
export declare function isGroupCallsEnabled(): boolean;
export declare function registerGroupCallTools(server: McpServer, telegram: TelegramService): void;
