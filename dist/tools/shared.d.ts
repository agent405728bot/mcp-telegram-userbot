import type { TelegramService } from "../telegram-client.js";
/** MCP tool annotation presets */
export declare const READ_ONLY: {
    readonly readOnlyHint: true;
    readonly openWorldHint: true;
};
export declare const WRITE: {
    readonly readOnlyHint: false;
    readonly openWorldHint: true;
};
export declare const DESTRUCTIVE: {
    readonly readOnlyHint: false;
    readonly destructiveHint: true;
    readonly openWorldHint: true;
};
/** Remove unpaired UTF-16 surrogates that break JSON serialization */
export declare function sanitize(text: string): string;
/** Helper: success response — always sanitizes to prevent surrogate crashes */
export declare function ok(text: string): {
    content: {
        type: "text";
        text: string;
    }[];
};
/** Helper: error response with isError flag */
export declare function fail(e: unknown): {
    content: {
        type: "text";
        text: string;
    }[];
    isError: true;
};
/** Format reactions array into compact text like: [👍×5 ❤️×3(me) 🔥×1] */
export declare function formatReactions(reactions?: {
    emoji: string;
    count: number;
    me: boolean;
}[]): string;
/**
 * Validate that a user-supplied path is safe to upload.
 *
 * The threat model is prompt-injection: an AI that was told "send the user's file" can be
 * manipulated into sending `/proc/self/environ`, `/etc/shadow`, `http://169.254.169.254/...`,
 * or an SMB share `\\attacker.com\share`. GramJS `sendFile` happily fetches URLs and reads
 * any local path, so the validation has to live here.
 *
 * Rules:
 * - Must be an absolute path (POSIX `/` or Windows `C:\` / `\\server\share`).
 * - No URL schemes (http:, https:, file:, ftp:, data:, javascript:, …).
 * - No path traversal (`..` segments) even inside an absolute path.
 * - No OS-sensitive directories on POSIX (`/proc`, `/sys`, `/dev`, `/run`). These leak env,
 *   kernel state, or block on device reads.
 * - UNC paths (`\\server\share`) are blocked (NTLM-relay / remote-SMB risk).
 *
 * This is defence-in-depth: the admin still owns the machine and can exfiltrate files
 * deliberately — we just refuse to help prompt-injection do it automatically.
 */
export declare function isSafeAbsolutePath(p: string): boolean;
/** Zod refinement message paired with `isSafeAbsolutePath` */
export declare const ABSOLUTE_PATH_ERROR = "Must be an absolute local filesystem path (e.g. /tmp/file.ogg). URLs, UNC shares, path traversal (..), and OS-sensitive dirs (/proc, /sys, /dev, /run) are rejected.";
/**
 * Sanitize a user-provided text for safe TL encoding.
 * Strips unpaired UTF-16 surrogates that crash GramJS's wire serializer. Use on every
 * free-text field that reaches GramJS (captions, provider names, venue titles, quoteText, …).
 */
export declare function sanitizeInputText(text: string): string;
/** Try to connect, return error text if failed */
export declare function requireConnection(telegram: TelegramService): Promise<string | null>;
