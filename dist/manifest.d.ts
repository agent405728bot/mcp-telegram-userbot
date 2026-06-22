#!/usr/bin/env node
export type ToolTier = "read-only" | "write" | "destructive";
export interface ToolManifestEntry {
    name: string;
    tier: ToolTier;
    description: string;
    hasInput: boolean;
}
export interface ToolManifest {
    generatedAt: string;
    toolCount: number;
    tiers: {
        "read-only": number;
        write: number;
        destructive: number;
    };
    tools: ToolManifestEntry[];
}
/**
 * Build a manifest of every tool the package can register. Forces all opt-in
 * env flags ON during introspection so consumers see the full catalog, not
 * the runtime-filtered subset. Cached for the process lifetime — invocations
 * are cheap and idempotent.
 */
export declare function getToolManifest(): ToolManifest;
/** Test-only: discard cache and force a fresh introspection. */
export declare function _resetManifestCache(): void;
