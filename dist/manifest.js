#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools/index.js";
function classify(name, annotations) {
    if (annotations === undefined) {
        console.warn(`[manifest] Tool '${name}' has no annotations — defaulting to 'write'. Add READ_ONLY/WRITE/DESTRUCTIVE.`);
        return "write";
    }
    if (annotations.destructiveHint === true)
        return "destructive";
    if (annotations.readOnlyHint === true)
        return "read-only";
    return "write";
}
const OPT_IN_FLAGS = [
    "MCP_TELEGRAM_ENABLE_STARS",
    "MCP_TELEGRAM_ENABLE_GROUP_CALLS",
    "MCP_TELEGRAM_ENABLE_QUICK_REPLIES",
];
/** Cache: introspection is deterministic + cheap, but env save/restore is not reentrant. */
let cached = null;
/**
 * Build a manifest of every tool the package can register. Forces all opt-in
 * env flags ON during introspection so consumers see the full catalog, not
 * the runtime-filtered subset. Cached for the process lifetime — invocations
 * are cheap and idempotent.
 */
export function getToolManifest() {
    if (cached)
        return cached;
    cached = introspect();
    return cached;
}
/** Test-only: discard cache and force a fresh introspection. */
export function _resetManifestCache() {
    cached = null;
}
function introspect() {
    const restore = {};
    for (const key of OPT_IN_FLAGS) {
        restore[key] = process.env[key];
        process.env[key] = "1";
    }
    try {
        const server = new McpServer({ name: "manifest-introspect", version: "0.0.0" });
        registerTools(server, {});
        return buildManifest(server);
    }
    finally {
        for (const key of OPT_IN_FLAGS) {
            if (restore[key] === undefined)
                delete process.env[key];
            else
                process.env[key] = restore[key];
        }
    }
}
function buildManifest(server) {
    const registered = server._registeredTools;
    if (!registered || typeof registered !== "object") {
        throw new Error("Failed to introspect MCP server: _registeredTools is missing. " +
            "The @modelcontextprotocol/sdk shape may have changed — please file an issue at " +
            "https://github.com/mcp-telegram/mcp-telegram/issues");
    }
    const tools = Object.entries(registered)
        .map(([name, tool]) => ({
        name,
        tier: classify(name, tool.annotations),
        description: tool.description ?? "",
        hasInput: tool.inputSchema !== undefined,
    }))
        .sort((a, b) => a.name.localeCompare(b.name));
    const tiers = { "read-only": 0, write: 0, destructive: 0 };
    for (const t of tools)
        tiers[t.tier]++;
    return {
        generatedAt: new Date().toISOString(),
        toolCount: tools.length,
        tiers,
        tools,
    };
}
if (import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === process.argv[1]) {
    const manifest = getToolManifest();
    const output = process.argv[2] ?? "manifest.json";
    if (output === "-") {
        process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    }
    else {
        writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
        console.error(`[manifest] Wrote ${manifest.toolCount} tools to ${output}`);
    }
}
