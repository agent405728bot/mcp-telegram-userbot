import { existsSync, mkdirSync } from "node:fs";
import { chmod, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import bigInt from "big-integer";
import QRCode from "qrcode";
import { TelegramClient } from "telegram";
import { CustomFile } from "telegram/client/uploads.js";
import { computeCheck } from "telegram/Password.js";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/tl/index.js";
import { RateLimiter } from "./rate-limiter.js";
import { buildReplyTo, buildStoryPrivacyRules, describeAdminLogAction, describeAdminLogDetails, describeKeyboardButton, detectMediaType, extractDiceResult, extractMessageId, extractPeerId, extractPollMediaFromUpdates, extractStoryIdFromUpdates, generateRandomBigInt, mergeBannedRights, reactionToEmoji, summarizeAllStories, summarizeBoostsList, summarizeBoostsStatus, summarizeBroadcastStats, summarizeBusinessChatLink, summarizeBusinessChatLinks, summarizeChannelDifference, summarizeDiscussionMessage, summarizeEmojiStatus, summarizeGroupCall, summarizeGroupCallParticipants, summarizeGroupsForDiscussion, summarizeMegagroupStats, summarizeMyBoosts, summarizePeer, summarizePeerStories, summarizePoll, summarizeQuickReplies, summarizeQuickReplyMessages, summarizeReadParticipants, summarizeReportResult, summarizeStarsStatus, summarizeStoriesById, summarizeStoryViewsList, summarizeUpdatesDifference, } from "./telegram-helpers.js";
export { buildStoryPrivacyRules, describeAdminLogAction, describeAdminLogDetails, describeKeyboardButton, detectMediaType, extractPeerId, extractPollMediaFromUpdates, extractStoryIdFromUpdates, mergeBannedRights, peerToCompact, reactionToEmoji, summarizeAllStories, summarizeBoost, summarizeBoostsList, summarizeBoostsStatus, summarizeBroadcastStats, summarizeBusinessChatLink, summarizeBusinessChatLinks, summarizeChannelDifference, summarizeDiscussionMessage, summarizeEmojiStatus, summarizeGroupCall, summarizeGroupCallInfo, summarizeGroupCallParticipant, summarizeGroupCallParticipants, summarizeGroupsForDiscussion, summarizeMegagroupStats, summarizeMyBoost, summarizeMyBoosts, summarizePeer, summarizePeerStories, summarizePoll, summarizePrepaidGiveaway, summarizeQuickReplies, summarizeQuickReply, summarizeQuickReplyMessage, summarizeQuickReplyMessages, summarizeReadParticipants, summarizeReportResult, summarizeStarsAmount, summarizeStarsStatus, summarizeStarsSubscription, summarizeStarsTransaction, summarizeStarsTransactionPeer, summarizeStoriesById, summarizeStoryItem, summarizeStoryView, summarizeStoryViewsList, summarizeUpdatesDifference, } from "./telegram-helpers.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const LEGACY_SESSION_FILE = join(__dirname, "..", ".telegram-session");
const DEFAULT_SESSION_DIR = join(homedir(), ".mcp-telegram");
const DEFAULT_SESSION_FILE = join(DEFAULT_SESSION_DIR, "session");
const SESSION_STRING_RE = /^[A-Za-z0-9+/=]+$/;
const MIN_SESSION_LENGTH = 100;
const NOT_CONNECTED_ERROR = "Not connected. Run telegram-status to check or telegram-login to authenticate.";
function resolveSessionPath(sessionPath) {
    return sessionPath ?? process.env.TELEGRAM_SESSION_PATH ?? DEFAULT_SESSION_FILE;
}
// Cloud password (2FA) for accounts that have two-step verification enabled.
// QR login alone cannot complete such logins — Telegram answers the imported
// login token with SESSION_PASSWORD_NEEDED, after which an SRP password check
// is required. Supplied via env so it works across all login entry points
// (standalone CLI, daemon IPC, and the telegram-login MCP tool), none of which
// can reliably prompt interactively mid-flow.
function resolveTwoFactorPassword() {
    return process.env.TELEGRAM_2FA_PASSWORD || undefined;
}
/**
 * Complete a QR login that Telegram answered with SESSION_PASSWORD_NEEDED by
 * running the SRP cloud-password check: GetPassword → computeCheck → CheckPassword.
 *
 * Returns a discriminated outcome rather than throwing so the caller owns
 * connection teardown. The password is only used to answer the SRP challenge
 * and is never logged or persisted.
 *
 * `compute` is injectable for tests; production always uses GramJS `computeCheck`.
 */
export async function completeTwoFactorLogin(client, password, compute = computeCheck) {
    if (!password) {
        return {
            ok: false,
            message: "2FA is enabled on this account. Set TELEGRAM_2FA_PASSWORD to your cloud password and run login again.",
        };
    }
    try {
        const passwordInfo = (await client.invoke(new Api.account.GetPassword()));
        const check = await compute(passwordInfo, password);
        await client.invoke(new Api.auth.CheckPassword({ password: check }));
        return { ok: true };
    }
    catch (pwErr) {
        const reason = pwErr instanceof Error ? pwErr.message : String(pwErr);
        return {
            ok: false,
            message: `2FA password check failed: ${reason}. Verify TELEGRAM_2FA_PASSWORD is correct.`,
        };
    }
}
function resolveProxy() {
    const ip = process.env.TELEGRAM_PROXY_IP;
    const port = process.env.TELEGRAM_PROXY_PORT;
    if (!ip || !port)
        return undefined;
    const secret = process.env.TELEGRAM_PROXY_SECRET;
    if (secret) {
        return { ip, port: Number(port), secret, MTProxy: true };
    }
    const socksType = Number(process.env.TELEGRAM_PROXY_SOCKS_TYPE || "5");
    return {
        ip,
        port: Number(port),
        socksType: socksType,
        ...(process.env.TELEGRAM_PROXY_USERNAME && { username: process.env.TELEGRAM_PROXY_USERNAME }),
        ...(process.env.TELEGRAM_PROXY_PASSWORD && { password: process.env.TELEGRAM_PROXY_PASSWORD }),
    };
}
// When true, gramJS uses port 443 instead of the default 80 for the MTProto
// TCPFull transport. Useful on hosts where outbound port 80 to Telegram DC IP
// ranges is blocked. gramJS cannot combine useWSS with a proxy, so warn early
// rather than let it fail deep inside connect() with an opaque error.
function resolveUseWSS(proxy) {
    const useWSS = process.env.TELEGRAM_USE_WSS === "true";
    if (useWSS && proxy) {
        console.error("[mcp-telegram] TELEGRAM_USE_WSS=true cannot be combined with TELEGRAM_PROXY_* — gramJS does not support SSL transport over a proxy. Ignoring useWSS; the proxy takes precedence.");
        return false;
    }
    return useWSS;
}
function ensureSessionDir(filePath) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
}
export class TelegramService {
    client = null;
    apiId;
    apiHash;
    sessionString = "";
    connected = false;
    sessionPath;
    rateLimiter = new RateLimiter();
    lastTypingAt = new Map();
    entityCache = new Map();
    lastError = "";
    get sessionDir() {
        return dirname(this.sessionPath);
    }
    hasLocalSession() {
        return existsSync(this.sessionPath);
    }
    // ─── Session & Auth ────────────────────────────────────────────────────────
    getClient() {
        return this.client;
    }
    constructor(apiId, apiHash, options) {
        this.apiId = apiId;
        this.apiHash = apiHash;
        this.sessionPath = resolveSessionPath(options?.sessionPath);
    }
    async loadSession() {
        // Try current session path
        if (existsSync(this.sessionPath)) {
            const raw = (await readFile(this.sessionPath, "utf-8")).trim();
            if (this.isValidSessionString(raw)) {
                this.sessionString = raw;
                // Fix permissions on existing files
                try {
                    await chmod(this.sessionPath, 0o600);
                }
                catch { }
                return true;
            }
        }
        // Migrate from legacy path (inside node_modules / package root)
        if (this.sessionPath === DEFAULT_SESSION_FILE && existsSync(LEGACY_SESSION_FILE)) {
            const raw = (await readFile(LEGACY_SESSION_FILE, "utf-8")).trim();
            if (this.isValidSessionString(raw)) {
                this.sessionString = raw;
                ensureSessionDir(this.sessionPath);
                await writeFile(this.sessionPath, raw, { encoding: "utf-8", mode: 0o600 });
                try {
                    await unlink(LEGACY_SESSION_FILE);
                }
                catch { }
                return true;
            }
        }
        return false;
    }
    isValidSessionString(value) {
        return value.length >= MIN_SESSION_LENGTH && SESSION_STRING_RE.test(value);
    }
    /** Set session string in memory (for programmatic / hosted use) */
    setSessionString(session) {
        this.sessionString = session;
    }
    /** Get the current session string (for external persistence) */
    getSessionString() {
        return this.sessionString;
    }
    async saveSession(session) {
        this.sessionString = session;
        try {
            ensureSessionDir(this.sessionPath);
            await writeFile(this.sessionPath, session, { encoding: "utf-8", mode: 0o600 });
        }
        catch {
            // File write may fail in containerized environments — session string is still in memory
        }
    }
    async connect() {
        if (this.connected && this.client)
            return true;
        if (!this.sessionString) {
            const loaded = await this.loadSession();
            if (!loaded)
                return false;
        }
        const session = new StringSession(this.sessionString);
        const proxy = resolveProxy();
        this.client = new TelegramClient(session, this.apiId, this.apiHash, {
            connectionRetries: 5,
            useWSS: resolveUseWSS(proxy),
            ...(proxy && { proxy }),
        });
        try {
            await this.client.connect();
            // Verify session is still valid
            await this.client.getMe();
            this.connected = true;
            return true;
        }
        catch (err) {
            const error = err;
            const msg = error.errorMessage || error.message || "";
            // Auth revoked — delete invalid session
            if (msg === "AUTH_KEY_UNREGISTERED" || msg === "SESSION_REVOKED" || msg === "USER_DEACTIVATED") {
                await this.clearSession();
                this.lastError = "Session revoked. Run telegram-login to re-authenticate.";
            }
            // Network error — keep session, just report
            else if (msg.includes("TIMEOUT") ||
                msg.includes("ECONNREFUSED") ||
                msg.includes("ENETUNREACH") ||
                msg.includes("ENOTFOUND") ||
                msg.includes("network")) {
                this.lastError = `Network error: ${msg}. Run telegram-status to retry connection.`;
            }
            // Unknown error
            else {
                this.lastError = `Connection error: ${msg}`;
            }
            try {
                await this.client.disconnect();
            }
            catch { }
            this.client = null;
            return false;
        }
    }
    async clearSession() {
        this.connected = false;
        this.sessionString = "";
        this.client = null;
        this.entityCache.clear();
        if (existsSync(this.sessionPath)) {
            await unlink(this.sessionPath);
        }
    }
    /** Ensure connection is active, auto-reconnect if session exists */
    async ensureConnected() {
        if (this.connected && this.client) {
            return true;
        }
        // Try to reconnect with saved session
        return this.connect();
    }
    async disconnect() {
        if (this.client && this.connected) {
            await this.client.destroy();
            this.connected = false;
            this.client = null;
            this.entityCache.clear();
        }
    }
    /**
     * Terminates the session on Telegram servers, destroys the client, and clears
     * local session (in-memory + file). Returns true only when server-side revoke
     * confirmed. False means server revoke could not be confirmed — local wipe
     * was still attempted. Throws if local file removal failed so callers can
     * surface the partial state instead of silently misreporting success.
     */
    async logOut() {
        const wipeLocalOrThrow = async () => {
            await this.clearSession();
            if (existsSync(this.sessionPath)) {
                throw new Error(`Local session file still present after clearSession: ${this.sessionPath}`);
            }
        };
        if (!this.client || !this.connected) {
            if (existsSync(this.sessionPath))
                await wipeLocalOrThrow();
            return false;
        }
        const client = this.client;
        let revoked = false;
        try {
            await client.invoke(new Api.auth.LogOut());
            revoked = true;
        }
        catch (error) {
            console.error("[telegram] auth.LogOut failed:", error);
        }
        // destroy() failure must NOT mask a successful server revoke — log and continue.
        try {
            await client.destroy();
        }
        catch (err) {
            console.error("[telegram] client.destroy failed during logOut:", err);
        }
        await wipeLocalOrThrow();
        return revoked;
    }
    isConnected() {
        return this.connected;
    }
    async startQrLogin(onQrDataUrl, onQrUrl, signal) {
        // Early exit if already aborted — avoids creating a Telegram connection we'd immediately tear down.
        if (signal?.aborted)
            return { success: false, message: "QR login aborted" };
        const session = new StringSession("");
        const proxy = resolveProxy();
        const client = new TelegramClient(session, this.apiId, this.apiHash, {
            connectionRetries: 5,
            useWSS: resolveUseWSS(proxy),
            ...(proxy && { proxy }),
        });
        try {
            await client.connect();
            if (signal?.aborted) {
                try {
                    await client.destroy();
                }
                catch { }
                return { success: false, message: "QR login aborted" };
            }
            let loginAccepted = false;
            let resolved = false;
            let lastQrUrl = "";
            client.addEventHandler((update) => {
                if (update instanceof Api.UpdateLoginToken) {
                    loginAccepted = true;
                }
            });
            const maxAttempts = 30; // 5 minutes
            for (let i = 0; i < maxAttempts && !resolved; i++) {
                if (signal?.aborted)
                    break;
                try {
                    const result = await client.invoke(new Api.auth.ExportLoginToken({
                        apiId: this.apiId,
                        apiHash: this.apiHash,
                        exceptIds: [],
                    }));
                    if (result instanceof Api.auth.LoginToken) {
                        const base64url = Buffer.from(result.token).toString("base64url");
                        const url = `tg://login?token=${base64url}`;
                        if (url !== lastQrUrl) {
                            lastQrUrl = url;
                            const dataUrl = await QRCode.toDataURL(url, {
                                width: 256,
                                margin: 2,
                            });
                            onQrDataUrl(dataUrl);
                            onQrUrl?.(url);
                        }
                    }
                    else if (result instanceof Api.auth.LoginTokenMigrateTo) {
                        await client._switchDC(result.dcId);
                        const imported = await client.invoke(new Api.auth.ImportLoginToken({ token: result.token }));
                        if (imported instanceof Api.auth.LoginTokenSuccess) {
                            resolved = true;
                            break;
                        }
                    }
                    else if (result instanceof Api.auth.LoginTokenSuccess) {
                        resolved = true;
                        break;
                    }
                }
                catch (err) {
                    const error = err;
                    if (error.errorMessage === "SESSION_PASSWORD_NEEDED") {
                        // The QR was scanned, but the account has two-step verification.
                        // Complete the login with an SRP password check if we have the
                        // cloud password; otherwise tell the user how to provide it.
                        const outcome = await completeTwoFactorLogin(client, resolveTwoFactorPassword());
                        if (outcome.ok) {
                            resolved = true;
                            break;
                        }
                        // destroy() (not disconnect()) to free the auth_key/socket, matching
                        // every other failure exit in this method — important in daemon mode
                        // where the process lives on across logins.
                        try {
                            await client.destroy();
                        }
                        catch { }
                        return { success: false, message: outcome.message };
                    }
                }
                if (!resolved) {
                    // Abortable sleep — wakes immediately when caller cancels
                    const waitMs = loginAccepted ? 1500 : 10000;
                    await new Promise((resolve) => {
                        const timer = setTimeout(() => {
                            signal?.removeEventListener("abort", onAbort);
                            resolve();
                        }, waitMs);
                        const onAbort = () => {
                            clearTimeout(timer);
                            resolve();
                        };
                        if (signal?.aborted)
                            onAbort();
                        else
                            signal?.addEventListener("abort", onAbort, { once: true });
                    });
                }
            }
            if (signal?.aborted && !resolved) {
                try {
                    await client.destroy();
                }
                catch { }
                return { success: false, message: "QR login aborted" };
            }
            if (resolved) {
                const newSession = client.session.save();
                // Persist FIRST, adopt SECOND — so if file write fails, in-memory state still
                // matches whatever's on disk; saveSession is try/catch-safe for Docker etc.
                await this.saveSession(newSession);
                // Destroy the previous in-memory client to free its auth_key / socket.
                // Previously left dangling → accumulated orphan Telegram connections per relogin.
                const oldClient = this.client;
                this.client = client;
                this.connected = true;
                this.entityCache.clear();
                if (oldClient) {
                    oldClient.destroy().catch(() => { });
                }
                return { success: true, message: "Telegram login successful" };
            }
            await client.destroy();
            return { success: false, message: "QR login timeout" };
        }
        catch (err) {
            try {
                await client.destroy();
            }
            catch { }
            return { success: false, message: `Login failed: ${err.message}` };
        }
    }
    // ─── Messages ──────────────────────────────────────────────────────────────
    async getMe() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const me = await this.client.getMe();
        const user = me;
        return {
            id: user.id.toString(),
            username: user.username ?? undefined,
            firstName: user.firstName ?? undefined,
        };
    }
    async sendMessage(chatId, text, replyTo, parseMode, topicId, extra) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            // Raw path: high-level client.sendMessage does not support quoteText/effect.
            // Fall back to messages.SendMessage when either is requested.
            if (extra?.quoteText || extra?.effect) {
                if (extra.quoteText && !replyTo) {
                    throw new Error("quoteText requires replyTo — provide the message ID of the message you are quoting");
                }
                const replyToObj = extra.quoteText
                    ? new Api.InputReplyToMessage({
                        replyToMsgId: replyTo,
                        topMsgId: topicId,
                        quoteText: extra.quoteText,
                    })
                    : buildReplyTo(replyTo, topicId);
                // GramJS parses md/html via the internal `_parseMessageText` helper. We feature-detect
                // it so a future GramJS rename surfaces a clear error instead of silently sending plain.
                let parsedText = text;
                let entities;
                if (parseMode) {
                    // biome-ignore lint/suspicious/noExplicitAny: GramJS internal helper, no public typing
                    const parser = client._parseMessageText;
                    if (typeof parser !== "function") {
                        throw new Error("GramJS version incompatible: parseMode not supported in quoteText/effect code path. Omit parseMode or upgrade GramJS.");
                    }
                    [parsedText, entities] = await parser.call(client, text, parseMode === "html" ? "html" : "md");
                }
                const result = await client.invoke(new Api.messages.SendMessage({
                    peer: resolved,
                    message: parsedText,
                    randomId: generateRandomBigInt(),
                    ...(replyToObj ? { replyTo: replyToObj } : {}),
                    ...(entities?.length ? { entities } : {}),
                    ...(extra.effect ? { effect: bigInt(extra.effect) } : {}),
                }));
                const id = extractMessageId(result);
                if (id === undefined)
                    throw new Error("Telegram did not return a message ID for sendMessage");
                // Return a minimal UpdateShortSentMessage — it only carries `id`, avoiding fake peerId/date.
                return new Api.UpdateShortSentMessage({ id, pts: 0, ptsCount: 0, date: Math.floor(Date.now() / 1000) });
            }
            if (topicId) {
                return await client.sendMessage(resolved, {
                    message: text,
                    topMsgId: topicId,
                    ...(replyTo ? { replyTo } : {}),
                    ...(parseMode ? { parseMode: parseMode === "html" ? "html" : "md" } : {}),
                });
            }
            return await client.sendMessage(resolved, {
                message: text,
                ...(replyTo ? { replyTo } : {}),
                ...(parseMode ? { parseMode: parseMode === "html" ? "html" : "md" } : {}),
            });
        }, `sendMessage to ${chatId}`);
    }
    async sendFile(chatId, filePath, caption) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            await this.client?.sendFile(resolved, { file: filePath, caption });
        }, `sendFile to ${chatId}`);
    }
    async sendVoice(chatId, filePath, opts = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            // Duration is intentionally auto-detected by GramJS from the audio file —
            // letting the AI override it would mis-report playback length in the Telegram UI.
            const message = await client.sendFile(resolved, {
                file: filePath,
                voiceNote: true,
                caption: opts.caption,
                parseMode: opts.parseMode,
                ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
                ...(opts.topicId ? { topMsgId: opts.topicId } : {}),
            });
            return { id: message.id };
        }, `sendVoice to ${chatId}`);
    }
    async sendVideoNote(chatId, filePath, opts = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const attributes = opts.duration || opts.length
                ? [
                    new Api.DocumentAttributeVideo({
                        roundMessage: true,
                        duration: opts.duration ?? 0,
                        w: opts.length ?? 0,
                        h: opts.length ?? 0,
                    }),
                ]
                : undefined;
            const message = await client.sendFile(resolved, {
                file: filePath,
                videoNote: true,
                ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
                ...(opts.topicId ? { topMsgId: opts.topicId } : {}),
                ...(attributes ? { attributes } : {}),
            });
            return { id: message.id };
        }, `sendVideoNote to ${chatId}`);
    }
    async sendContact(chatId, phone, firstName, opts = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const media = new Api.InputMediaContact({
                phoneNumber: phone,
                firstName,
                lastName: opts.lastName ?? "",
                vcard: opts.vcard ?? "",
            });
            const result = await client.invoke(new Api.messages.SendMedia({
                peer: resolved,
                media,
                message: "",
                randomId: generateRandomBigInt(),
                replyTo: buildReplyTo(opts.replyTo, opts.topicId),
            }));
            const id = extractMessageId(result);
            if (id === undefined)
                throw new Error("Telegram did not return a message ID for sendContact");
            return { id };
        }, `sendContact to ${chatId}`);
    }
    async sendDice(chatId, emoji, opts = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const result = await client.invoke(new Api.messages.SendMedia({
                peer: resolved,
                media: new Api.InputMediaDice({ emoticon: emoji }),
                message: "",
                randomId: generateRandomBigInt(),
                replyTo: buildReplyTo(opts.replyTo, opts.topicId),
            }));
            const dice = extractDiceResult(result);
            if (!dice) {
                const id = extractMessageId(result);
                if (id === undefined)
                    throw new Error("Telegram did not return a message ID for sendDice");
                return { id };
            }
            return dice;
        }, `sendDice to ${chatId}`);
    }
    async sendLocation(chatId, latitude, longitude, opts = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const geoPoint = new Api.InputGeoPoint({
                lat: latitude,
                long: longitude,
                ...(opts.accuracyRadius !== undefined ? { accuracyRadius: opts.accuracyRadius } : {}),
            });
            const media = opts.livePeriod
                ? new Api.InputMediaGeoLive({
                    geoPoint,
                    period: opts.livePeriod,
                    ...(opts.heading !== undefined ? { heading: opts.heading } : {}),
                    ...(opts.proximityRadius !== undefined ? { proximityNotificationRadius: opts.proximityRadius } : {}),
                })
                : new Api.InputMediaGeoPoint({ geoPoint });
            const result = await client.invoke(new Api.messages.SendMedia({
                peer: resolved,
                media,
                message: "",
                randomId: generateRandomBigInt(),
                replyTo: buildReplyTo(opts.replyTo, opts.topicId),
            }));
            const id = extractMessageId(result);
            if (id === undefined)
                throw new Error("Telegram did not return a message ID for sendLocation");
            return { id };
        }, `sendLocation to ${chatId}`);
    }
    async sendVenue(chatId, latitude, longitude, title, address, opts = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const media = new Api.InputMediaVenue({
                geoPoint: new Api.InputGeoPoint({ lat: latitude, long: longitude }),
                title,
                address,
                provider: opts.provider ?? "foursquare",
                venueId: opts.venueId ?? "",
                venueType: opts.venueType ?? "",
            });
            const result = await client.invoke(new Api.messages.SendMedia({
                peer: resolved,
                media,
                message: "",
                randomId: generateRandomBigInt(),
                replyTo: buildReplyTo(opts.replyTo, opts.topicId),
            }));
            const id = extractMessageId(result);
            if (id === undefined)
                throw new Error("Telegram did not return a message ID for sendVenue");
            return { id };
        }, `sendVenue to ${chatId}`);
    }
    async sendAlbum(chatId, items, opts = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        if (items.length < 2 || items.length > 10) {
            throw new Error("Album requires 2-10 items");
        }
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            // Album-level caption lands on the first item; per-item captions stay as provided.
            const captions = items.map((it, i) => (i === 0 ? (opts.caption ?? it.caption ?? "") : (it.caption ?? "")));
            // GramJS sendFile auto-detects `file: string[]` and takes the _sendAlbum path,
            // which invokes messages.UploadMedia per item + messages.SendMultiMedia.
            const result = (await client.sendFile(resolved, {
                file: items.map((it) => it.filePath),
                caption: captions,
                parseMode: opts.parseMode,
                ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
                ...(opts.topicId ? { topMsgId: opts.topicId } : {}),
            }));
            const ids = Array.isArray(result)
                ? result.filter((m) => m instanceof Api.Message).map((m) => m.id)
                : result instanceof Api.Message
                    ? [result.id]
                    : [];
            if (ids.length === 0)
                throw new Error("Telegram did not return any message IDs for sendAlbum");
            return { ids };
        }, `sendAlbum to ${chatId}`);
    }
    async downloadMedia(chatId, messageId, downloadPath) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const messages = await this.client.getMessages(resolved, { ids: [messageId] });
        const message = messages[0];
        if (!message)
            throw new Error(`Message ${messageId} not found`);
        if (!message.media)
            throw new Error(`Message ${messageId} has no media`);
        const buffer = await this.client.downloadMedia(message);
        if (!buffer)
            throw new Error("Failed to download media");
        await writeFile(downloadPath, buffer);
        return downloadPath;
    }
    async downloadMediaAsBuffer(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const messages = await this.client.getMessages(resolved, { ids: [messageId] });
        const message = messages[0];
        if (!message)
            throw new Error(`Message ${messageId} not found`);
        if (!message.media)
            throw new Error(`Message ${messageId} has no media`);
        const buffer = (await this.client.downloadMedia(message));
        if (!buffer)
            throw new Error("Failed to download media");
        const mimeType = this.detectMimeType(buffer, message.media);
        return { buffer, mimeType };
    }
    /** Detect MIME type from buffer magic bytes, falling back to media metadata */
    detectMimeType(buffer, media) {
        // Check magic bytes first
        if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
            return "image/jpeg";
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)
            return "image/png";
        if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46)
            return "image/gif";
        if (buffer[0] === 0x52 &&
            buffer[1] === 0x49 &&
            buffer[2] === 0x46 &&
            buffer[3] === 0x46 &&
            buffer[8] === 0x57 &&
            buffer[9] === 0x45 &&
            buffer[10] === 0x42 &&
            buffer[11] === 0x50)
            return "image/webp";
        // Fall back to document mimeType
        const m = media;
        const doc = m.document;
        if (doc?.mimeType)
            return doc.mimeType;
        if (m.photo)
            return "image/jpeg";
        return "application/octet-stream";
    }
    async pinMessage(chatId, messageId, silent = false) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        await this.client.pinMessage(resolved, messageId, { notify: !silent });
    }
    async unpinMessage(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        await this.client.unpinMessage(resolved, messageId);
    }
    // ─── Dialogs ───────────────────────────────────────────────────────────────
    async getDialogs(limit = 20, offsetDate, filterType) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const fetchLimit = filterType ? limit * 3 : limit;
        const dialogs = await this.client.getDialogs({ limit: fetchLimit, ...(offsetDate ? { offsetDate } : {}) });
        const mapped = dialogs.map((d) => {
            const type = d.isGroup ? "group" : d.isChannel ? "channel" : "private";
            const isUser = d.entity instanceof Api.User;
            return {
                id: d.id?.toString() ?? "",
                name: d.title ?? d.name ?? "Unknown",
                type,
                unreadCount: d.unreadCount,
                ...(isUser
                    ? { isBot: Boolean(d.entity.bot), isContact: Boolean(d.entity.contact) }
                    : {}),
            };
        });
        if (filterType === "contact_requests") {
            return mapped.filter((d) => d.type === "private" && d.isContact === false).slice(0, limit);
        }
        return filterType ? mapped.filter((d) => d.type === filterType).slice(0, limit) : mapped;
    }
    async getUnreadDialogs(limit = 20) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const dialogs = await this.client.getDialogs({ limit: limit * 3 });
        const unread = dialogs.filter((d) => d.unreadCount > 0).slice(0, limit);
        const results = await Promise.all(unread.map(async (d) => {
            const isUser = d.entity instanceof Api.User;
            const isForum = d.entity instanceof Api.Channel && Boolean(d.entity.forum);
            const base = {
                id: d.id?.toString() ?? "",
                name: d.title ?? d.name ?? "Unknown",
                type: d.isGroup ? "group" : d.isChannel ? "channel" : "private",
                unreadCount: d.unreadCount,
                ...(isUser
                    ? { isBot: Boolean(d.entity.bot), isContact: Boolean(d.entity.contact) }
                    : {}),
            };
            if (isForum) {
                try {
                    const forumTopics = await this.getForumTopics(d.id?.toString() ?? "");
                    const unreadTopics = forumTopics
                        .filter((t) => t.unreadCount > 0)
                        .map((t) => ({ id: t.id, title: t.title, unreadCount: t.unreadCount }));
                    const realUnread = unreadTopics.reduce((sum, t) => sum + t.unreadCount, 0);
                    if (realUnread === 0)
                        return null;
                    return {
                        ...base,
                        unreadCount: realUnread,
                        forum: true,
                        topics: unreadTopics.length > 0 ? unreadTopics : undefined,
                    };
                }
                catch {
                    return { ...base, forum: true };
                }
            }
            return base;
        }));
        return results.filter((r) => r !== null);
    }
    async getContactRequests(limit = 20) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const dialogs = await this.client.getDialogs({ limit: limit * 5 });
        return dialogs
            .filter((d) => {
            if (d.isGroup || d.isChannel)
                return false;
            return d.entity instanceof Api.User && !d.entity.contact;
        })
            .slice(0, limit)
            .map((d) => {
            const user = d.entity;
            const msg = d.message;
            return {
                id: d.id?.toString() ?? "",
                name: [user.firstName, user.lastName].filter(Boolean).join(" ") || "Unknown",
                username: user.username ?? undefined,
                isBot: Boolean(user.bot),
                unreadCount: d.unreadCount,
                lastMessage: msg?.message ?? undefined,
                lastMessageDate: msg?.date ?? undefined,
            };
        });
    }
    // ─── Contacts ──────────────────────────────────────────────────────────────
    async addContact(userId, firstName, lastName, phone) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.client.getInputEntity(userId);
        await this.client.invoke(new Api.contacts.AddContact({
            id: entity,
            firstName,
            lastName: lastName ?? "",
            phone: phone ?? "",
        }));
    }
    async blockUser(userId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.client.getInputEntity(userId);
        await this.client.invoke(new Api.contacts.Block({ id: entity }));
    }
    async reportSpam(chatId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.client.getInputEntity(chatId);
        await this.client.invoke(new Api.messages.ReportSpam({ peer }));
    }
    // ─── Read state ────────────────────────────────────────────────────────────
    async markAsRead(chatId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.client.markAsRead(chatId);
    }
    async getMessageById(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const messages = await this.client.getMessages(resolved, { ids: [messageId] });
        const m = messages[0];
        if (!m || m.id !== messageId)
            return null;
        return {
            id: m.id,
            text: m.message ?? "",
            sender: await this.resolveSenderName(m.senderId),
            date: new Date((m.date ?? 0) * 1000).toISOString(),
            media: this.extractMediaInfo(m.media),
            reactions: this.extractReactions(m.reactions),
        };
    }
    async forwardMessage(fromChatId, toChatId, messageIds) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolvedFrom = await this.resolvePeer(fromChatId);
        const resolvedTo = await this.resolvePeer(toChatId);
        await this.client.forwardMessages(resolvedTo, { messages: messageIds, fromPeer: resolvedFrom });
    }
    async editMessage(chatId, messageId, newText) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            await this.client?.editMessage(resolved, { message: messageId, text: newText });
        }, `editMessage ${messageId} in ${chatId}`);
    }
    async deleteMessages(chatId, messageIds) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            await this.client?.deleteMessages(resolved, messageIds, { revoke: true });
        }, `deleteMessages in ${chatId}`);
    }
    async getScheduledMessages(chatId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const peer = await this.client?.getInputEntity(resolved);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            const result = await this.client?.invoke(new Api.messages.GetScheduledHistory({ peer, hash: bigInt(0) }));
            if (!result || result instanceof Api.messages.MessagesNotModified)
                return [];
            const messages = result
                .messages;
            return messages
                .filter((m) => m instanceof Api.Message)
                .map((m) => ({
                id: m.id,
                date: new Date((m.date ?? 0) * 1000).toISOString(),
                text: m.message ?? "",
                media: this.extractMediaInfo(m.media),
            }));
        }, `getScheduledMessages in ${chatId}`);
    }
    async deleteScheduledMessages(chatId, messageIds) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const peer = await this.client?.getInputEntity(resolved);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            await this.client?.invoke(new Api.messages.DeleteScheduledMessages({ peer, id: messageIds }));
        }, `deleteScheduledMessages in ${chatId}`);
    }
    async getReplies(chatId, messageId, limit = 20) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const peer = await this.client?.getInputEntity(resolved);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            const result = await this.client?.invoke(new Api.messages.GetReplies({ peer, msgId: messageId, limit, hash: bigInt(0) }));
            if (!result || result instanceof Api.messages.MessagesNotModified)
                return [];
            const messages = result
                .messages;
            return Promise.all(messages
                .filter((m) => m instanceof Api.Message)
                .map(async (m) => ({
                id: m.id,
                text: m.message ?? "",
                sender: await this.resolveSenderName(m.senderId),
                date: new Date((m.date ?? 0) * 1000).toISOString(),
                media: this.extractMediaInfo(m.media),
                reactions: this.extractReactions(m.reactions),
            })));
        }, `getReplies for ${messageId} in ${chatId}`);
    }
    async getMessageLink(chatId, messageId, thread = false) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Message links are only available for channels and supergroups");
            }
            const result = await this.client?.invoke(new Api.channels.ExportMessageLink({ channel: entity, id: messageId, thread }));
            if (!result)
                throw new Error("Failed to export message link");
            return result.link;
        }, `getMessageLink for ${messageId} in ${chatId}`);
    }
    async getUnreadMentions(chatId, limit = 20) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const peer = await this.client?.getInputEntity(resolved);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            const result = await this.client?.invoke(new Api.messages.GetUnreadMentions({
                peer,
                offsetId: 0,
                addOffset: 0,
                limit,
                maxId: 0,
                minId: 0,
            }));
            if (!result || result instanceof Api.messages.MessagesNotModified)
                return [];
            const typedResult = result;
            const messages = typedResult.messages;
            const items = await Promise.all(messages
                .filter((m) => m instanceof Api.Message)
                .map(async (m) => ({
                id: m.id,
                text: m.message ?? "",
                sender: await this.resolveSenderName(m.senderId),
                date: new Date((m.date ?? 0) * 1000).toISOString(),
                media: this.extractMediaInfo(m.media),
                reactions: this.extractReactions(m.reactions),
            })));
            // Only mark all as read when we received the complete set; if truncated, marking all
            // would silently clear mentions the caller hasn't seen yet.
            const totalCount = "count" in typedResult ? typedResult.count : items.length;
            if (items.length > 0 && items.length >= totalCount) {
                try {
                    await this.client?.invoke(new Api.messages.ReadMentions({ peer }));
                }
                catch {
                    // best-effort; don't discard fetched items on mark-read failure
                }
            }
            return items;
        }, `getUnreadMentions in ${chatId}`);
    }
    async getUnreadReactions(chatId, limit = 20) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const peer = await this.client?.getInputEntity(resolved);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            const result = await this.client?.invoke(new Api.messages.GetUnreadReactions({
                peer,
                offsetId: 0,
                addOffset: 0,
                limit,
                maxId: 0,
                minId: 0,
            }));
            if (!result || result instanceof Api.messages.MessagesNotModified)
                return [];
            const typedResult = result;
            const messages = typedResult.messages;
            const items = await Promise.all(messages
                .filter((m) => m instanceof Api.Message)
                .map(async (m) => ({
                id: m.id,
                text: m.message ?? "",
                sender: await this.resolveSenderName(m.senderId),
                date: new Date((m.date ?? 0) * 1000).toISOString(),
                media: this.extractMediaInfo(m.media),
                reactions: this.extractReactions(m.reactions),
            })));
            // Only mark all as read when we received the complete set; if truncated, marking all
            // would silently clear reactions the caller hasn't seen yet.
            const totalCount = "count" in typedResult ? typedResult.count : items.length;
            if (items.length > 0 && items.length >= totalCount) {
                try {
                    await this.client?.invoke(new Api.messages.ReadReactions({ peer }));
                }
                catch {
                    // best-effort; don't discard fetched items on mark-read failure
                }
            }
            return items;
        }, `getUnreadReactions in ${chatId}`);
    }
    async translateText(chatId, messageIds, toLang) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const peer = await this.client?.getInputEntity(resolved);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            const result = await this.client?.invoke(new Api.messages.TranslateText({ peer, id: messageIds, toLang }));
            if (!result)
                return [];
            return result.result.map((t) => (t instanceof Api.TextWithEntities ? t.text : ""));
        }, `translateText in ${chatId}`);
    }
    async sendTyping(chatId, action = "typing") {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            let stamped = false;
            if (action !== "cancel") {
                const now = Date.now();
                const last = this.lastTypingAt.get(chatId) ?? 0;
                if (now - last < 10_000)
                    return;
                this.lastTypingAt.set(chatId, now);
                stamped = true;
            }
            try {
                const resolved = await this.resolvePeer(chatId);
                const peer = await this.client?.getInputEntity(resolved);
                if (!peer)
                    throw new Error(`Cannot resolve peer for ${chatId}`);
                let sendAction;
                switch (action) {
                    case "cancel":
                        sendAction = new Api.SendMessageCancelAction();
                        break;
                    case "upload_photo":
                        sendAction = new Api.SendMessageUploadPhotoAction({ progress: 0 });
                        break;
                    case "upload_document":
                        sendAction = new Api.SendMessageUploadDocumentAction({ progress: 0 });
                        break;
                    default:
                        sendAction = new Api.SendMessageTypingAction();
                }
                await this.client?.invoke(new Api.messages.SetTyping({ peer, action: sendAction }));
                if (action === "cancel") {
                    this.lastTypingAt.delete(chatId);
                }
            }
            catch (err) {
                if (stamped)
                    this.lastTypingAt.delete(chatId);
                throw err;
            }
        }, `sendTyping in ${chatId}`);
    }
    // ─── Chat lookup & info ────────────────────────────────────────────────────
    /**
     * Resolve a chat by ID, username, or display name.
     * Falls back to searching user's dialogs if getEntity() fails.
     */
    async resolveChat(chatId) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const cached = this.entityCache.get(chatId);
        if (cached)
            return cached;
        // First try direct resolve (numeric ID, username, phone)
        try {
            const entity = await this.client.getEntity(chatId);
            this.entityCache.set(chatId, entity);
            return entity;
        }
        catch {
            // Fall through to dialog search
        }
        // Search dialogs by display name
        const dialogs = await this.client.getDialogs({ limit: 100 });
        const query = chatId.toLowerCase();
        // Exact match first
        const exact = dialogs.find((d) => d.title?.toLowerCase() === query);
        if (exact?.entity) {
            this.entityCache.set(chatId, exact.entity);
            return exact.entity;
        }
        // Partial match
        const partial = dialogs.filter((d) => d.title?.toLowerCase().includes(query));
        if (partial.length === 1 && partial[0].entity) {
            this.entityCache.set(chatId, partial[0].entity);
            return partial[0].entity;
        }
        if (partial.length > 1) {
            const matches = partial.map((d) => `  ${d.title} (${d.entity?.id?.toString() ?? "?"})`).join("\n");
            throw new Error(`Multiple chats match "${chatId}". Use the numeric ID instead:\n${matches}`);
        }
        throw new Error(`Cannot find chat "${chatId}". Use a numeric ID, @username, or run telegram-search-chats to find it.`);
    }
    /**
     * Resolve chatId to a peer string that GramJS methods accept.
     * Handles display names by searching dialogs.
     */
    async resolvePeer(chatId) {
        // Normalize '@me' — GramJS only intercepts the plain 'me' string as InputPeerSelf
        if (chatId === "@me")
            return "me";
        // @usernames resolve directly via contacts.ResolveUsername
        if (chatId.startsWith("@"))
            return chatId;
        // Bare numeric IDs need an entity with access_hash. GramJS can build an
        // InputPeer from a raw number only if it's already cached or the account
        // is a contact / has messaged us — otherwise getInputEntity throws
        // "Could not find the input entity". A bare positive number is also
        // ambiguous (GramJS assumes PeerUser, so channel IDs fail outright).
        // Recover by looking the ID up among dialogs, which yields a full entity
        // (with access_hash) for both users and channels.
        if (/^-?\d+$/.test(chatId))
            return this.resolveNumericPeer(chatId);
        // Everything else — resolve display name via dialogs
        return this.resolveChat(chatId);
    }
    /**
     * Resolve a bare numeric ID to a cached/dialog entity so GramJS can build a
     * valid InputPeer. Falls back to the raw ID string if no dialog matches —
     * GramJS may still resolve it (e.g. a contact or a peer it has messaged),
     * and we must not regress that path.
     */
    async resolveNumericPeer(chatId) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const cached = this.entityCache.get(chatId);
        if (cached)
            return cached;
        // Direct resolve first — succeeds when GramJS already knows the peer.
        try {
            const entity = await this.client.getEntity(chatId);
            this.entityCache.set(chatId, entity);
            return entity;
        }
        catch {
            // Fall through to dialog scan.
        }
        // Scan dialogs for a matching entity. IDs reach us in two shapes:
        //   • bare positive  (e.g. 1004294063929 for a channel, 8959122940 for a
        //     user) — this is what list-chats/search emit and what GramJS can't
        //     disambiguate; match it against any entity's bare id.
        //   • marked         (-100<id> for channels, -<id> for basic groups) — the
        //     sign/-100 prefix carries the type, so require the entity to match that
        //     exact marked form, otherwise a group "-123" could wrongly match a user
        //     with bare id 123.
        const isMarked = chatId.startsWith("-");
        try {
            const dialogs = await this.client.getDialogs({ limit: 100 });
            const match = dialogs.find((d) => {
                const entity = d.entity;
                if (!entity?.id)
                    return false;
                const bare = entity.id.toString();
                if (!isMarked)
                    return chatId === bare;
                // Marked input must match the entity's marked form.
                if (entity instanceof Api.Channel)
                    return chatId === `-100${bare}`;
                if (entity instanceof Api.Chat)
                    return chatId === `-${bare}`;
                return false;
            });
            if (match?.entity) {
                this.entityCache.set(chatId, match.entity);
                return match.entity;
            }
        }
        catch {
            // Dialog fetch failed — fall back to the raw ID below.
        }
        // Last resort: hand the raw ID to GramJS and let it try GetUsers/GetChannels.
        return chatId;
    }
    async getChatInfo(chatId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        if (entity instanceof Api.User) {
            const parts = [entity.firstName, entity.lastName].filter(Boolean);
            return {
                id: entity.id.toString(),
                name: parts.join(" ") || "Unknown",
                type: "private",
                username: entity.username ?? undefined,
                isBot: Boolean(entity.bot),
                isContact: Boolean(entity.contact),
            };
        }
        if (entity instanceof Api.Channel) {
            let membersCount = entity.participantsCount ?? undefined;
            let description;
            try {
                const full = await this.client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
                if (full.fullChat instanceof Api.ChannelFull) {
                    membersCount = membersCount ?? full.fullChat.participantsCount ?? undefined;
                    description = full.fullChat.about || undefined;
                }
            }
            catch {
                // May fail for some channels — fall back to basic info
            }
            return {
                id: entity.id.toString(),
                name: entity.title,
                type: entity.megagroup ? "group" : "channel",
                username: entity.username ?? undefined,
                description,
                membersCount,
                forum: Boolean(entity.forum) || undefined,
            };
        }
        if (entity instanceof Api.Chat) {
            let membersCount = entity.participantsCount ?? undefined;
            let description;
            try {
                const full = await this.client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
                if (full.fullChat instanceof Api.ChatFull) {
                    if (!membersCount && full.fullChat.participants instanceof Api.ChatParticipants) {
                        membersCount = full.fullChat.participants.participants.length;
                    }
                    description = full.fullChat.about || undefined;
                }
            }
            catch {
                // Fall back to basic info
            }
            return {
                id: entity.id.toString(),
                name: entity.title,
                type: "group",
                description,
                membersCount,
            };
        }
        return { id: chatId, name: "Unknown", type: "unknown" };
    }
    /** Extract media info from a message */
    extractMediaInfo(media) {
        if (!media)
            return undefined;
        if (media instanceof Api.MessageMediaPhoto) {
            return { type: "photo" };
        }
        if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
            const doc = media.document;
            let type = "document";
            let fileName;
            for (const attr of doc.attributes) {
                if (attr instanceof Api.DocumentAttributeVideo)
                    type = "video";
                else if (attr instanceof Api.DocumentAttributeAudio)
                    type = "audio";
                else if (attr instanceof Api.DocumentAttributeSticker)
                    type = "sticker";
                else if (attr instanceof Api.DocumentAttributeFilename)
                    fileName = attr.fileName;
            }
            return { type, fileName, size: doc.size?.toJSNumber?.() ?? Number(doc.size) };
        }
        return undefined;
    }
    /** Resolve sender ID to a display name */
    async resolveSenderName(senderId) {
        if (!senderId || !this.client)
            return "unknown";
        try {
            const entity = await this.client.getEntity(senderId);
            if (entity instanceof Api.User) {
                const parts = [entity.firstName, entity.lastName].filter(Boolean);
                const name = parts.join(" ") || "Unknown";
                return entity.username ? `${name} (@${entity.username})` : name;
            }
            if (entity instanceof Api.Channel || entity instanceof Api.Chat) {
                return entity.title ?? "Group";
            }
            return senderId.toString();
        }
        catch {
            return senderId.toString();
        }
    }
    async getMessages(chatId, limit = 10, offsetId, minDate, maxDate) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const opts = {
            limit,
            ...(offsetId ? { offsetId } : {}),
            ...(maxDate ? { offsetDate: maxDate } : {}),
        };
        const messages = await this.client.getMessages(resolved, opts);
        let filtered = messages;
        if (minDate) {
            filtered = filtered.filter((m) => (m.date ?? 0) >= minDate);
        }
        const results = await Promise.all(filtered.map(async (m) => ({
            id: m.id,
            text: m.message ?? "",
            sender: await this.resolveSenderName(m.senderId),
            date: new Date((m.date ?? 0) * 1000).toISOString(),
            media: this.extractMediaInfo(m.media),
            reactions: this.extractReactions(m.reactions),
        })));
        return results;
    }
    async searchChats(query, limit = 10) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.contacts.Search({ q: query, limit }));
        const chats = [];
        for (const user of result.users) {
            if (user instanceof Api.User) {
                const parts = [user.firstName, user.lastName].filter(Boolean);
                chats.push({
                    id: user.id.toString(),
                    name: parts.join(" ") || "Unknown",
                    type: "private",
                    username: user.username ?? undefined,
                });
            }
        }
        for (const chat of result.chats) {
            if (chat instanceof Api.Chat) {
                chats.push({
                    id: chat.id.toString(),
                    name: chat.title,
                    type: "group",
                    membersCount: chat.participantsCount ?? undefined,
                });
            }
            else if (chat instanceof Api.Channel) {
                chats.push({
                    id: chat.id.toString(),
                    name: chat.title,
                    type: chat.megagroup ? "group" : "channel",
                    username: chat.username ?? undefined,
                    membersCount: chat.participantsCount ?? undefined,
                });
            }
        }
        // Enrich channels/groups with description and accurate members count
        for (const chat of chats) {
            if (chat.type === "private")
                continue;
            try {
                const entity = await this.client.getEntity(chat.id);
                if (entity instanceof Api.Channel) {
                    const full = await this.client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
                    if (full.fullChat instanceof Api.ChannelFull) {
                        chat.description = full.fullChat.about || undefined;
                        chat.membersCount = full.fullChat.participantsCount ?? chat.membersCount;
                    }
                }
                else if (entity instanceof Api.Chat) {
                    const full = await this.client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
                    if (full.fullChat instanceof Api.ChatFull) {
                        chat.description = full.fullChat.about || undefined;
                    }
                }
            }
            catch {
                // Skip enrichment on error (private channels, etc.)
            }
        }
        return chats;
    }
    async searchGlobal(query, limit = 20, minDate, maxDate) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.messages.SearchGlobal({
            q: query,
            filter: new Api.InputMessagesFilterEmpty(),
            minDate: minDate || 0,
            maxDate: maxDate || 0,
            offsetRate: 0,
            offsetPeer: new Api.InputPeerEmpty(),
            offsetId: 0,
            limit,
        }));
        const chatsMap = new Map();
        if ("chats" in result) {
            for (const chat of result.chats) {
                if (chat instanceof Api.Channel) {
                    chatsMap.set(chat.id.toString(), {
                        id: chat.id.toString(),
                        name: chat.title,
                        type: chat.megagroup ? "group" : "channel",
                        username: chat.username ?? undefined,
                    });
                }
                else if (chat instanceof Api.Chat) {
                    chatsMap.set(chat.id.toString(), {
                        id: chat.id.toString(),
                        name: chat.title,
                        type: "group",
                    });
                }
            }
        }
        if ("users" in result) {
            for (const user of result.users) {
                if (user instanceof Api.User) {
                    const parts = [user.firstName, user.lastName].filter(Boolean);
                    chatsMap.set(user.id.toString(), {
                        id: user.id.toString(),
                        name: parts.join(" ") || "Unknown",
                        type: "private",
                        username: user.username ?? undefined,
                    });
                }
            }
        }
        const rawMessages = "messages" in result ? result.messages : [];
        const messages = rawMessages.filter((m) => m instanceof Api.Message);
        const results = await Promise.all(messages.map(async (m) => {
            const peerId = m.peerId;
            let chatId = "";
            if (peerId instanceof Api.PeerChannel)
                chatId = peerId.channelId.toString();
            else if (peerId instanceof Api.PeerChat)
                chatId = peerId.chatId.toString();
            else if (peerId instanceof Api.PeerUser)
                chatId = peerId.userId.toString();
            return {
                id: m.id,
                text: m.message ?? "",
                sender: await this.resolveSenderName(m.senderId),
                date: new Date((m.date ?? 0) * 1000).toISOString(),
                chat: chatsMap.get(chatId) || { id: chatId, name: "Unknown", type: "unknown" },
                media: this.extractMediaInfo(m.media),
                reactions: this.extractReactions(m.reactions),
            };
        }));
        return results;
    }
    async searchMessages(chatId, query, limit = 20, minDate, maxDate) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const messages = await this.client.getMessages(resolved, {
            search: query,
            limit,
            ...(maxDate ? { offsetDate: maxDate } : {}),
        });
        let filtered = messages;
        if (minDate) {
            filtered = filtered.filter((m) => (m.date ?? 0) >= minDate);
        }
        const results = await Promise.all(filtered.map(async (m) => ({
            id: m.id,
            text: m.message ?? "",
            sender: await this.resolveSenderName(m.senderId),
            date: new Date((m.date ?? 0) * 1000).toISOString(),
            media: this.extractMediaInfo(m.media),
            reactions: this.extractReactions(m.reactions),
        })));
        return results;
    }
    // ─── Search ────────────────────────────────────────────────────────────────
    async getContacts(limit = 50) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.contacts.GetContacts({ hash: bigInt(0) }));
        if (!(result instanceof Api.contacts.Contacts))
            return [];
        const contacts = [];
        for (const user of result.users) {
            if (user instanceof Api.User) {
                const parts = [user.firstName, user.lastName].filter(Boolean);
                contacts.push({
                    id: user.id.toString(),
                    name: parts.join(" ") || "Unknown",
                    username: user.username ?? undefined,
                    phone: user.phone ?? undefined,
                });
            }
        }
        return contacts.slice(0, limit);
    }
    async getChatMembers(chatId, limit = 50) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        if (entity instanceof Api.Channel) {
            const result = await this.client.invoke(new Api.channels.GetParticipants({
                channel: entity,
                filter: new Api.ChannelParticipantsRecent(),
                offset: 0,
                limit,
                hash: bigInt.zero,
            }));
            if (!(result instanceof Api.channels.ChannelParticipants))
                return [];
            const userMap = new Map();
            for (const u of result.users) {
                if (u instanceof Api.User)
                    userMap.set(u.id.toString(), u);
            }
            return result.participants.map((p) => {
                const userId = this.getParticipantUserId(p);
                const user = userMap.get(userId);
                const parts = user ? [user.firstName, user.lastName].filter(Boolean) : [];
                return {
                    id: userId,
                    name: parts.join(" ") || "Unknown",
                    username: user?.username ?? undefined,
                    role: this.getParticipantRole(p),
                };
            });
        }
        // Basic group — use getParticipants (no role info available)
        const participants = await this.client.getParticipants(entity, { limit });
        return participants
            .filter((p) => p instanceof Api.User)
            .map((p) => {
            const parts = [p.firstName, p.lastName].filter(Boolean);
            return {
                id: p.id.toString(),
                name: parts.join(" ") || "Unknown",
                username: p.username ?? undefined,
                role: "member",
            };
        });
    }
    async getMyRole(chatId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        const me = await this.getMe();
        if (entity instanceof Api.Channel) {
            const result = await this.client.invoke(new Api.channels.GetParticipant({ channel: entity, participant: new Api.InputUserSelf() }));
            return {
                role: this.getParticipantRole(result.participant),
                chatId: entity.id.toString(),
                chatName: entity.title ?? "Unknown",
            };
        }
        if (entity instanceof Api.Chat) {
            // Basic group — check if creator
            if (entity.creator) {
                return { role: "creator", chatId: entity.id.toString(), chatName: entity.title ?? "Unknown" };
            }
            if (entity.adminRights) {
                return { role: "admin", chatId: entity.id.toString(), chatName: entity.title ?? "Unknown" };
            }
            return { role: "member", chatId: entity.id.toString(), chatName: entity.title ?? "Unknown" };
        }
        if (entity instanceof Api.User) {
            return { role: "user", chatId: entity.id.toString(), chatName: me.username ?? "self" };
        }
        return { role: "unknown", chatId: chatId, chatName: "Unknown" };
    }
    getParticipantUserId(p) {
        if (p instanceof Api.ChannelParticipantCreator)
            return p.userId.toString();
        if (p instanceof Api.ChannelParticipantAdmin)
            return p.userId.toString();
        if (p instanceof Api.ChannelParticipantSelf)
            return p.userId.toString();
        if (p instanceof Api.ChannelParticipantBanned)
            return p.peer?.userId?.toString() ?? "0";
        if (p instanceof Api.ChannelParticipant)
            return p.userId.toString();
        return "0";
    }
    getParticipantRole(p) {
        if (p instanceof Api.ChannelParticipantCreator)
            return "creator";
        if (p instanceof Api.ChannelParticipantAdmin)
            return "admin";
        if (p instanceof Api.ChannelParticipantBanned)
            return "banned";
        if (p instanceof Api.ChannelParticipantLeft)
            return "left";
        return "member";
    }
    async getProfile(userId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.client.getEntity(userId);
        if (!(entity instanceof Api.User))
            throw new Error("Entity is not a user");
        const inputEntity = await this.client.getInputEntity(userId);
        const fullResult = await this.client.invoke(new Api.users.GetFullUser({ id: inputEntity }));
        const full = fullResult.fullUser;
        const bio = full.about ?? undefined;
        const parts = [entity.firstName, entity.lastName].filter(Boolean);
        let lastSeen;
        if (entity.status instanceof Api.UserStatusOnline) {
            lastSeen = "online";
        }
        else if (entity.status instanceof Api.UserStatusOffline) {
            lastSeen = new Date(entity.status.wasOnline * 1000).toISOString();
        }
        else if (entity.status instanceof Api.UserStatusRecently) {
            lastSeen = "recently";
        }
        else if (entity.status instanceof Api.UserStatusLastWeek) {
            lastSeen = "last week";
        }
        else if (entity.status instanceof Api.UserStatusLastMonth) {
            lastSeen = "last month";
        }
        let birthday;
        if (full.birthday) {
            const b = full.birthday;
            birthday = b.year
                ? `${b.year}-${String(b.month).padStart(2, "0")}-${String(b.day).padStart(2, "0")}`
                : `${String(b.month).padStart(2, "0")}-${String(b.day).padStart(2, "0")}`;
        }
        let businessWorkHours;
        if (full.businessWorkHours) {
            const wh = full.businessWorkHours;
            businessWorkHours = wh.timezoneId ?? "configured";
        }
        let businessLocation;
        if (full.businessLocation) {
            const loc = full.businessLocation;
            businessLocation = loc.address ?? "configured";
        }
        return {
            id: entity.id.toString(),
            name: parts.join(" ") || "Unknown",
            username: entity.username ?? undefined,
            phone: entity.phone ?? undefined,
            bio,
            photo: !!entity.photo,
            lastSeen,
            premium: entity.premium || undefined,
            birthday,
            commonChatsCount: full.commonChatsCount || undefined,
            personalChannelId: full.personalChannelId ? full.personalChannelId.toString() : undefined,
            businessWorkHours,
            businessLocation,
        };
    }
    // ─── Profiles & Media ──────────────────────────────────────────────────────
    async downloadProfilePhoto(entityId, options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.client.getEntity(entityId);
        const buffer = (await this.client.downloadProfilePhoto(entity, {
            isBig: options?.isBig !== false,
        }));
        if (!buffer || buffer.length === 0)
            return null;
        const mimeType = this.detectMimeFromBuffer(buffer);
        if (options?.savePath) {
            await writeFile(options.savePath, buffer);
            return { filePath: options.savePath };
        }
        return { buffer, mimeType };
    }
    /** Detect MIME type from buffer magic bytes */
    detectMimeFromBuffer(buffer) {
        if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
            return "image/jpeg";
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)
            return "image/png";
        if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46)
            return "image/gif";
        if (buffer[0] === 0x52 &&
            buffer[1] === 0x49 &&
            buffer[2] === 0x46 &&
            buffer[3] === 0x46 &&
            buffer[8] === 0x57 &&
            buffer[9] === 0x45 &&
            buffer[10] === 0x42 &&
            buffer[11] === 0x50)
            return "image/webp";
        return "image/jpeg"; // Telegram profile photos are almost always JPEG
    }
    /** Extract reactions from a message into a simple format */
    extractReactions(reactions) {
        if (!reactions?.results?.length)
            return undefined;
        const items = [];
        for (const r of reactions.results) {
            let emoji;
            if (r.reaction instanceof Api.ReactionEmoji) {
                emoji = r.reaction.emoticon;
            }
            else if (r.reaction instanceof Api.ReactionCustomEmoji) {
                emoji = `custom:${r.reaction.documentId}`;
            }
            else if (r.reaction instanceof Api.ReactionPaid) {
                emoji = "⭐";
            }
            else {
                continue;
            }
            items.push({ emoji, count: r.count, me: r.chosenOrder != null });
        }
        return items.length > 0 ? items : undefined;
    }
    // ─── Reactions ─────────────────────────────────────────────────────────────
    async sendReaction(chatId, messageId, emoji, addToExisting = false) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const peer = await this.client.getInputEntity(resolved);
        const reactionList = [];
        if (emoji) {
            const emojis = Array.isArray(emoji) ? emoji : [emoji];
            if (addToExisting) {
                // Fetch current reactions to preserve them
                const msgs = await this.client.getMessages(resolved, { ids: [messageId] });
                const msg = msgs[0];
                if (msg?.reactions?.results) {
                    for (const r of msg.reactions.results) {
                        if (r.chosenOrder != null) {
                            reactionList.push(r.reaction);
                        }
                    }
                }
            }
            for (const e of emojis) {
                reactionList.push(new Api.ReactionEmoji({ emoticon: e }));
            }
        }
        // empty array = remove all reactions
        const result = await this.client.invoke(new Api.messages.SendReaction({
            peer,
            msgId: messageId,
            reaction: reactionList,
        }));
        // Extract updated reactions from the response
        if ("updates" in result) {
            for (const upd of result.updates) {
                if (upd instanceof Api.UpdateMessageReactions) {
                    return this.extractReactions(upd.reactions);
                }
            }
        }
        return undefined;
    }
    async getMessageReactions(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const peer = await this.client.getInputEntity(resolved);
        // First get the message to know which reactions exist
        const msgs = await this.client.getMessages(resolved, { ids: [messageId] });
        const msg = msgs[0];
        if (!msg?.reactions?.results?.length) {
            return { reactions: [], total: 0 };
        }
        const reactionsOut = [];
        for (const rc of msg.reactions.results) {
            let emoji;
            if (rc.reaction instanceof Api.ReactionEmoji) {
                emoji = rc.reaction.emoticon;
            }
            else if (rc.reaction instanceof Api.ReactionCustomEmoji) {
                emoji = `custom:${rc.reaction.documentId}`;
            }
            else if (rc.reaction instanceof Api.ReactionPaid) {
                emoji = "⭐";
            }
            else {
                continue;
            }
            const users = [];
            // Try to get the list of users who reacted (may fail if canSeeList is false)
            if (msg.reactions.canSeeList) {
                try {
                    const list = await this.client.invoke(new Api.messages.GetMessageReactionsList({
                        peer,
                        id: messageId,
                        reaction: rc.reaction,
                        limit: 50,
                    }));
                    if (list instanceof Api.messages.MessageReactionsList) {
                        for (const r of list.reactions) {
                            const userId = r.peerId instanceof Api.PeerUser ? r.peerId.userId.toString() : "";
                            if (userId) {
                                const name = await this.resolveSenderName(bigInt(userId));
                                users.push({ id: userId, name });
                            }
                        }
                    }
                }
                catch {
                    // canSeeList may be false or request may fail for channels
                }
            }
            reactionsOut.push({ emoji, count: rc.count, users });
        }
        const total = reactionsOut.reduce((sum, r) => sum + r.count, 0);
        return { reactions: reactionsOut, total };
    }
    async setDefaultReaction(emoji) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.rateLimiter.execute(async () => {
            await this.client?.invoke(new Api.messages.SetDefaultReaction({
                reaction: new Api.ReactionEmoji({ emoticon: emoji }),
            }));
        }, `setDefaultReaction ${emoji}`);
    }
    async getTopReactions(limit) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const result = await this.client?.invoke(new Api.messages.GetTopReactions({ limit, hash: bigInt(0) }));
            if (!result || result instanceof Api.messages.ReactionsNotModified)
                return [];
            const out = [];
            for (const r of result.reactions) {
                const emoji = reactionToEmoji(r);
                if (emoji)
                    out.push({ emoji });
            }
            return out;
        }, "getTopReactions");
    }
    async getRecentReactions(limit) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const result = await this.client?.invoke(new Api.messages.GetRecentReactions({ limit, hash: bigInt(0) }));
            if (!result || result instanceof Api.messages.ReactionsNotModified)
                return [];
            const out = [];
            for (const r of result.reactions) {
                const emoji = reactionToEmoji(r);
                if (emoji)
                    out.push({ emoji });
            }
            return out;
        }, "getRecentReactions");
    }
    // ─── Scheduled & Polls ─────────────────────────────────────────────────────
    async sendScheduledMessage(chatId, text, scheduleDate, replyTo, parseMode) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        await this.client.sendMessage(resolved, {
            message: text,
            schedule: scheduleDate,
            ...(replyTo ? { replyTo } : {}),
            ...(parseMode ? { parseMode: parseMode === "html" ? "html" : "md" } : {}),
        });
    }
    async createPoll(chatId, question, answers, options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.client.getInputEntity(chatId);
        const pollAnswers = answers.map((text, i) => new Api.PollAnswer({
            text: new Api.TextWithEntities({ text, entities: [] }),
            option: Buffer.from([i]),
        }));
        const poll = new Api.Poll({
            id: bigInt(Date.now()),
            question: new Api.TextWithEntities({ text: question, entities: [] }),
            answers: pollAnswers,
            multipleChoice: options?.multipleChoice ?? false,
            quiz: options?.quiz ?? false,
        });
        const result = await this.client.invoke(new Api.messages.SendMedia({
            peer,
            media: new Api.InputMediaPoll({
                poll,
                ...(options?.quiz && options.correctAnswer != null
                    ? { correctAnswers: [Buffer.from([options.correctAnswer])] }
                    : {}),
            }),
            message: "",
            randomId: bigInt(Math.floor(Math.random() * 1e15)),
        }));
        // Extract message ID from result
        if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
            for (const update of result.updates) {
                if (update instanceof Api.UpdateMessageID) {
                    return update.id;
                }
            }
        }
        return 0;
    }
    // ─── Poll interaction ──────────────────────────────────────────────────────
    async sendPollVote(chatId, messageId, optionIndexes) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const options = optionIndexes.map((i) => Buffer.from([i]));
            const result = await client.invoke(new Api.messages.SendVote({ peer, msgId: messageId, options }));
            const pollMedia = extractPollMediaFromUpdates(result);
            const results = pollMedia?.results;
            const poll = pollMedia?.poll;
            return {
                totalVoters: results?.totalVoters ?? 0,
                chosenLabels: optionIndexes.map((i) => {
                    const answer = poll?.answers?.[i];
                    return answer ? answer.text.text : `#${i}`;
                }),
                isRetracted: optionIndexes.length === 0,
            };
        }, `sendPollVote ${chatId}/${messageId}`);
    }
    async getPollResults(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const msgs = await client.getMessages(peer, { ids: [messageId] });
            if (!(msgs[0]?.media instanceof Api.MessageMediaPoll)) {
                throw new Error("Message is not a poll");
            }
            const pollMedia = msgs[0].media;
            // Refresh results from server
            try {
                await client.invoke(new Api.messages.GetPollResults({ peer, msgId: messageId }));
            }
            catch {
                // ignore — use whatever is in the message
            }
            return summarizePoll(pollMedia.poll, pollMedia.results);
        }, `getPollResults ${chatId}/${messageId}`);
    }
    async getPollVoters(chatId, messageId, opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const optionIndex = opts?.optionIndex;
            const result = (await client.invoke(new Api.messages.GetPollVotes({
                peer,
                id: messageId,
                option: optionIndex !== undefined ? Buffer.from([optionIndex]) : undefined,
                offset: opts?.offset,
                limit: opts?.limit ?? 20,
            })));
            // Build user map
            const userMap = new Map();
            for (const u of result.users ?? []) {
                const user = u;
                const id = user.id?.toString() ?? "";
                userMap.set(id, {
                    name: [user.firstName, user.lastName].filter(Boolean).join(" ") || undefined,
                    username: user.username ?? undefined,
                });
            }
            const voters = (result.votes ?? []).map((v) => {
                const vote = v;
                const peerId = extractPeerId(vote.peer);
                const info = userMap.get(peerId) ?? {};
                let options = [];
                if ("option" in vote && vote.option) {
                    options = [Buffer.from(vote.option).toString("hex")];
                }
                else if ("options" in vote && vote.options) {
                    options = vote.options.map((o) => Buffer.from(o).toString("hex"));
                }
                return {
                    peerId,
                    name: info.name,
                    username: info.username,
                    options,
                    date: vote.date,
                };
            });
            return { total: result.count, nextOffset: result.nextOffset, voters };
        }, `getPollVoters ${chatId}/${messageId}`);
    }
    async closePoll(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            // Step 1: fetch existing poll
            const msgs = await client.getMessages(peer, { ids: [messageId] });
            if (!(msgs[0]?.media instanceof Api.MessageMediaPoll)) {
                throw new Error("Message is not a poll");
            }
            const pollMedia = msgs[0].media;
            const originalPoll = pollMedia.poll;
            // Step 2: build closed poll (preserve all flags)
            const closedPoll = new Api.Poll({
                id: originalPoll.id,
                question: originalPoll.question,
                answers: originalPoll.answers,
                closed: true,
                publicVoters: originalPoll.publicVoters,
                multipleChoice: originalPoll.multipleChoice,
                quiz: originalPoll.quiz,
                closePeriod: originalPoll.closePeriod,
                closeDate: originalPoll.closeDate,
            });
            // Step 3: edit message to close poll
            const result = await client.invoke(new Api.messages.EditMessage({
                peer,
                id: messageId,
                media: new Api.InputMediaPoll({ poll: closedPoll }),
            }));
            // Extract updated voter count from result updates
            const pollInfo = extractPollMediaFromUpdates(result);
            const totalVoters = pollInfo?.results?.totalVoters ?? pollMedia.results?.totalVoters ?? 0;
            return { totalVoters };
        }, `closePoll ${chatId}/${messageId}`);
    }
    // ─── Audio transcription ───────────────────────────────────────────────────
    async transcribeAudio(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const result = (await client.invoke(new Api.messages.TranscribeAudio({ peer, msgId: messageId })));
            return {
                transcriptionId: result.transcriptionId.toString(),
                text: result.text ?? "",
                pending: result.pending ?? false,
                trialRemainsNum: result.trialRemainsNum,
                trialRemainsUntilDate: result.trialRemainsUntilDate,
            };
        }, `transcribeAudio ${chatId}/${messageId}`);
    }
    async rateTranscription(chatId, messageId, transcriptionId, good) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        await this.rateLimiter.execute(async () => {
            await client.invoke(new Api.messages.RateTranscribedAudio({
                peer,
                msgId: messageId,
                transcriptionId: bigInt(transcriptionId),
                good,
            }));
        }, `rateTranscription ${chatId}/${messageId}`);
    }
    // ─── Fact-check ────────────────────────────────────────────────────────────
    async getFactCheck(chatId, messageIds) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const result = (await client.invoke(new Api.messages.GetFactCheck({ peer, msgId: messageIds })));
            return result.map((fc, i) => ({
                messageId: messageIds[i],
                needCheck: fc.needCheck ?? false,
                country: fc.country,
                text: fc.text?.text,
                hash: fc.hash.toString(),
            }));
        }, `getFactCheck ${chatId}`);
    }
    async editFactCheck(chatId, messageId, text, _opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        await this.rateLimiter.execute(async () => {
            // Build TextWithEntities — basic plain text (no entity parsing for fact-checks)
            const textObj = new Api.TextWithEntities({ text, entities: [] });
            await client.invoke(new Api.messages.EditFactCheck({ peer, msgId: messageId, text: textObj }));
        }, `editFactCheck ${chatId}/${messageId}`);
    }
    async deleteFactCheck(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        await this.rateLimiter.execute(async () => {
            await client.invoke(new Api.messages.DeleteFactCheck({ peer, msgId: messageId }));
        }, `deleteFactCheck ${chatId}/${messageId}`);
    }
    // ─── Paid reactions ────────────────────────────────────────────────────────
    async sendPaidReaction(chatId, messageId, count, opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const randomId = generateRandomBigInt();
            const params = { peer, msgId: messageId, count, randomId };
            if (opts?.private !== undefined)
                params.private = opts.private;
            // biome-ignore lint/suspicious/noExplicitAny: dynamic params for optional `private` field
            await client.invoke(new Api.messages.SendPaidReaction(params));
            return { count };
        }, `sendPaidReaction ${chatId}/${messageId}`);
    }
    async togglePaidReactionPrivacy(chatId, messageId, privateFlag) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        await this.rateLimiter.execute(async () => {
            await client.invoke(new Api.messages.TogglePaidReactionPrivacy({ peer, msgId: messageId, private: privateFlag }));
        }, `togglePaidReactionPrivacy ${chatId}/${messageId}`);
    }
    async getPaidReactionPrivacy() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const result = await client.invoke(new Api.messages.GetPaidReactionPrivacy());
            let list = [];
            if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
                list = result.updates;
            }
            else if (result instanceof Api.UpdateShort) {
                list = [result.update];
            }
            for (const u of list) {
                if (u instanceof Api.UpdatePaidReactionPrivacy) {
                    return { private: Boolean(u.private) };
                }
            }
            return { private: false };
        }, "getPaidReactionPrivacy");
    }
    async getForumTopics(chatId, limit = 100) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        if (!(entity instanceof Api.Channel))
            throw new Error("Forum topics are only available in supergroups");
        const result = await this.client.invoke(new Api.channels.GetForumTopics({
            channel: entity,
            limit,
            offsetTopic: 0,
            offsetDate: 0,
            offsetId: 0,
        }));
        const topics = [];
        for (const topic of result.topics) {
            if (topic instanceof Api.ForumTopic) {
                topics.push({
                    id: topic.id,
                    title: topic.title,
                    unreadCount: topic.unreadCount,
                    unreadMentions: topic.unreadMentionsCount,
                    iconColor: topic.iconColor,
                    closed: Boolean(topic.closed),
                    pinned: Boolean(topic.pinned),
                });
            }
        }
        return topics;
    }
    async getTopicMessages(chatId, topicId, limit = 20, offsetId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const peer = await this.client.getInputEntity(resolved);
        const result = await this.client.invoke(new Api.messages.GetReplies({
            peer,
            msgId: topicId,
            limit,
            ...(offsetId ? { offsetId } : {}),
            offsetDate: 0,
            addOffset: 0,
            maxId: 0,
            minId: 0,
            hash: bigInt(0),
        }));
        const messages = "messages" in result ? result.messages : [];
        const results = await Promise.all(messages
            .filter((m) => m instanceof Api.Message)
            .map(async (m) => ({
            id: m.id,
            text: m.message ?? "",
            sender: await this.resolveSenderName(m.senderId),
            date: new Date((m.date ?? 0) * 1000).toISOString(),
            media: this.extractMediaInfo(m.media),
            reactions: this.extractReactions(m.reactions),
        })));
        return results;
    }
    /** Check if a chat entity is a forum (has topics enabled) */
    async isForum(chatId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        try {
            const entity = await this.resolveChat(chatId);
            if (entity instanceof Api.Channel) {
                return Boolean(entity.forum);
            }
        }
        catch { }
        return false;
    }
    // ─── Chat membership & management ──────────────────────────────────────────
    async joinChat(target) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        // Extract invite hash from various link formats
        const inviteMatch = target.match(/(?:t\.me\/\+|t\.me\/joinchat\/|tg:\/\/join\?invite=)([a-zA-Z0-9_-]+)/);
        if (inviteMatch) {
            const result = await this.client.invoke(new Api.messages.ImportChatInvite({ hash: inviteMatch[1] }));
            const chat = result.chats?.[0];
            if (!chat)
                throw new Error("Failed to join via invite link");
            return {
                id: chat.id.toString(),
                title: chat.title ?? "Unknown",
                type: chat.className === "Channel" ? "channel" : "group",
            };
        }
        // Public channel/group by username
        const username = target.replace(/^@/, "").replace(/^https?:\/\/t\.me\//, "");
        const entity = await this.client.getEntity(username);
        if (entity instanceof Api.Chat) {
            throw new Error("Basic groups cannot be joined by username; use an invite link instead.");
        }
        if (entity instanceof Api.Channel) {
            await this.client.invoke(new Api.channels.JoinChannel({ channel: entity }));
            return {
                id: entity.id.toString(),
                title: entity.title ?? "Unknown",
                type: entity.className === "Channel" ? "channel" : "group",
            };
        }
        throw new Error("Target is not a group or channel. Use username, @username, or invite link.");
    }
    async createGroup(options) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const { title, users, supergroup = false, forum = false, description } = options;
        if (supergroup || forum) {
            // Create supergroup/channel via channels.CreateChannel
            const result = await this.client.invoke(new Api.channels.CreateChannel({
                title,
                about: description ?? "",
                megagroup: true,
                forum: forum || undefined,
            }));
            const chat = result.chats?.[0];
            if (!chat)
                throw new Error("Failed to create supergroup");
            const channelId = chat.id.toString();
            // Invite users
            if (users.length > 0) {
                const inputUsers = [];
                for (const u of users) {
                    try {
                        const entity = await this.client.getEntity(u);
                        if (entity instanceof Api.User) {
                            inputUsers.push(new Api.InputUser({ userId: entity.id, accessHash: entity.accessHash ?? bigInt.zero }));
                        }
                    }
                    catch {
                        // Skip unresolvable users
                    }
                }
                if (inputUsers.length > 0) {
                    await this.client.invoke(new Api.channels.InviteToChannel({
                        channel: chat,
                        users: inputUsers,
                    }));
                }
            }
            // Get invite link
            let inviteLink;
            try {
                const exported = await this.client.invoke(new Api.messages.ExportChatInvite({ peer: chat }));
                if (exported instanceof Api.ChatInviteExported) {
                    inviteLink = exported.link;
                }
            }
            catch { }
            return { id: channelId, title, type: forum ? "forum" : "supergroup", inviteLink };
        }
        // Create basic group via messages.CreateChat
        const inputUsers = [];
        for (const u of users) {
            try {
                const entity = await this.client.getEntity(u);
                if (entity instanceof Api.User) {
                    inputUsers.push(new Api.InputUser({ userId: entity.id, accessHash: entity.accessHash ?? bigInt.zero }));
                }
            }
            catch {
                // Skip unresolvable users
            }
        }
        if (inputUsers.length === 0) {
            throw new Error("At least one valid user is required to create a basic group");
        }
        const result = await this.client.invoke(new Api.messages.CreateChat({
            title,
            users: inputUsers,
        }));
        const updates = result;
        const chat = updates.chats?.[0];
        if (!chat)
            throw new Error("Failed to create group");
        return { id: chat.id.toString(), title, type: "group" };
    }
    async inviteToGroup(chatId, users) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        const invited = [];
        const failed = [];
        for (const u of users) {
            try {
                const user = await this.client.getEntity(u);
                if (!(user instanceof Api.User)) {
                    failed.push(u);
                    continue;
                }
                const inputUser = new Api.InputUser({ userId: user.id, accessHash: user.accessHash ?? bigInt.zero });
                if (entity instanceof Api.Channel) {
                    await this.client.invoke(new Api.channels.InviteToChannel({ channel: entity, users: [inputUser] }));
                }
                else if (entity instanceof Api.Chat) {
                    await this.client.invoke(new Api.messages.AddChatUser({ chatId: entity.id, userId: inputUser, fwdLimit: 50 }));
                }
                invited.push(u);
            }
            catch {
                failed.push(u);
            }
        }
        return { invited, failed };
    }
    async kickUser(chatId, userId) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        const user = await this.client.getEntity(userId);
        if (!(user instanceof Api.User))
            throw new Error("Target is not a user");
        const inputUser = new Api.InputUser({ userId: user.id, accessHash: user.accessHash ?? bigInt.zero });
        if (entity instanceof Api.Channel) {
            // Kick = ban + unban (removes without permanent ban)
            await this.client.invoke(new Api.channels.EditBanned({
                channel: entity,
                participant: inputUser,
                bannedRights: new Api.ChatBannedRights({ untilDate: 0, viewMessages: true }),
            }));
            await this.client.invoke(new Api.channels.EditBanned({
                channel: entity,
                participant: inputUser,
                bannedRights: new Api.ChatBannedRights({ untilDate: 0 }),
            }));
        }
        else if (entity instanceof Api.Chat) {
            await this.client.invoke(new Api.messages.DeleteChatUser({ chatId: entity.id, userId: inputUser }));
        }
    }
    async banUser(chatId, userId) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        const user = await this.client.getEntity(userId);
        if (!(user instanceof Api.User))
            throw new Error("Target is not a user");
        if (!(entity instanceof Api.Channel))
            throw new Error("Ban is only supported for supergroups and channels");
        const inputUser = new Api.InputUser({ userId: user.id, accessHash: user.accessHash ?? bigInt.zero });
        await this.client.invoke(new Api.channels.EditBanned({
            channel: entity,
            participant: inputUser,
            bannedRights: new Api.ChatBannedRights({ untilDate: 0, viewMessages: true }),
        }));
    }
    async unbanUser(chatId, userId) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        const user = await this.client.getEntity(userId);
        if (!(user instanceof Api.User))
            throw new Error("Target is not a user");
        if (!(entity instanceof Api.Channel))
            throw new Error("Unban is only supported for supergroups and channels");
        const inputUser = new Api.InputUser({ userId: user.id, accessHash: user.accessHash ?? bigInt.zero });
        await this.client.invoke(new Api.channels.EditBanned({
            channel: entity,
            participant: inputUser,
            bannedRights: new Api.ChatBannedRights({ untilDate: 0 }),
        }));
    }
    async editGroup(chatId, options) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        if (options.title) {
            if (entity instanceof Api.Channel) {
                await this.client.invoke(new Api.channels.EditTitle({ channel: entity, title: options.title }));
            }
            else if (entity instanceof Api.Chat) {
                await this.client.invoke(new Api.messages.EditChatTitle({ chatId: entity.id, title: options.title }));
            }
        }
        if (options.description != null) {
            await this.client.invoke(new Api.messages.EditChatAbout({ peer: entity, about: options.description }));
        }
        if (options.photoPath) {
            const fileData = await readFile(options.photoPath);
            const uploaded = await this.client.uploadFile({
                file: new CustomFile(options.photoPath, fileData.length, options.photoPath, fileData),
                workers: 1,
            });
            const inputPhoto = new Api.InputChatUploadedPhoto({ file: uploaded });
            if (entity instanceof Api.Channel) {
                await this.client.invoke(new Api.channels.EditPhoto({ channel: entity, photo: inputPhoto }));
            }
            else if (entity instanceof Api.Chat) {
                await this.client.invoke(new Api.messages.EditChatPhoto({ chatId: entity.id, photo: inputPhoto }));
            }
        }
    }
    async leaveGroup(chatId) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        if (entity instanceof Api.Channel) {
            await this.client.invoke(new Api.channels.LeaveChannel({ channel: entity }));
        }
        else if (entity instanceof Api.Chat) {
            await this.client.invoke(new Api.messages.DeleteChatUser({
                chatId: entity.id,
                userId: new Api.InputUserSelf(),
            }));
        }
        else {
            throw new Error("Target is not a group or channel");
        }
    }
    async setAdmin(chatId, userId, options) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        if (!(entity instanceof Api.Channel))
            throw new Error("Set admin is only supported for supergroups and channels");
        const user = await this.client.getEntity(userId);
        if (!(user instanceof Api.User))
            throw new Error("Target is not a user");
        const inputUser = new Api.InputUser({ userId: user.id, accessHash: user.accessHash ?? bigInt.zero });
        await this.client.invoke(new Api.channels.EditAdmin({
            channel: entity,
            userId: inputUser,
            adminRights: new Api.ChatAdminRights({
                changeInfo: true,
                postMessages: true,
                editMessages: true,
                deleteMessages: true,
                banUsers: true,
                inviteUsers: true,
                pinMessages: true,
                manageCall: true,
            }),
            rank: options?.title ?? "",
        }));
    }
    async removeAdmin(chatId, userId) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        if (!(entity instanceof Api.Channel))
            throw new Error("Remove admin is only supported for supergroups and channels");
        const user = await this.client.getEntity(userId);
        if (!(user instanceof Api.User))
            throw new Error("Target is not a user");
        const inputUser = new Api.InputUser({ userId: user.id, accessHash: user.accessHash ?? bigInt.zero });
        await this.client.invoke(new Api.channels.EditAdmin({
            channel: entity,
            userId: inputUser,
            adminRights: new Api.ChatAdminRights({}),
            rank: "",
        }));
    }
    // ─── Chat settings & moderation ────────────────────────────────────────────
    async unblockUser(userId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.client.getInputEntity(userId);
        await this.client.invoke(new Api.contacts.Unblock({ id: entity }));
    }
    async muteChat(chatId, muteUntil) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const peer = await this.client.getInputEntity(resolved);
        await this.client.invoke(new Api.account.UpdateNotifySettings({
            peer: new Api.InputNotifyPeer({ peer }),
            settings: new Api.InputPeerNotifySettings({ muteUntil }),
        }));
    }
    async archiveChat(chatId, archive) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const peer = await this.client?.getInputEntity(resolved);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            await this.client?.invoke(new Api.folders.EditPeerFolders({
                folderPeers: [new Api.InputFolderPeer({ peer, folderId: archive ? 1 : 0 })],
            }));
        }, `archiveChat ${chatId}`);
    }
    async pinDialog(chatId, pin) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const peer = await this.client?.getInputEntity(resolved);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            await this.client?.invoke(new Api.messages.ToggleDialogPin({
                peer: new Api.InputDialogPeer({ peer }),
                pinned: pin,
            }));
        }, `pinDialog ${chatId}`);
    }
    async markDialogUnread(chatId, unread) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const peer = await this.client?.getInputEntity(resolved);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            await this.client?.invoke(new Api.messages.MarkDialogUnread({
                peer: new Api.InputDialogPeer({ peer }),
                unread,
            }));
        }, `markDialogUnread ${chatId}`);
    }
    async getAdminLog(chatId, limit = 20, q) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Admin log is only available for supergroups and channels");
            }
            const result = await this.client?.invoke(new Api.channels.GetAdminLog({
                channel: entity,
                q: q ?? "",
                maxId: bigInt(0),
                minId: bigInt(0),
                limit,
            }));
            if (!result)
                return [];
            const userMap = new Map();
            for (const u of result.users) {
                if (u instanceof Api.User)
                    userMap.set(u.id.toString(), u);
            }
            const describeUser = (userId) => {
                const user = userMap.get(userId.toString());
                if (!user)
                    return userId.toString();
                const parts = [user.firstName, user.lastName].filter(Boolean);
                const name = parts.join(" ") || "Unknown";
                return user.username ? `${name} (@${user.username})` : name;
            };
            return result.events.map((event) => ({
                id: event.id.toString(),
                date: new Date((event.date ?? 0) * 1000).toISOString(),
                userId: event.userId.toString(),
                userName: describeUser(event.userId),
                action: describeAdminLogAction(event.action),
                details: describeAdminLogDetails(event.action, describeUser),
            }));
        }, `getAdminLog for ${chatId}`);
    }
    async setChatPermissions(chatId, permissions) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        if (Object.values(permissions).every((v) => v === undefined))
            return;
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            let currentRights;
            if (entity instanceof Api.Channel) {
                const full = await this.client?.invoke(new Api.channels.GetFullChannel({ channel: entity }));
                const fullChannel = full?.chats?.find((c) => c instanceof Api.Channel && c.id.equals(entity.id));
                currentRights = fullChannel?.defaultBannedRights ?? undefined;
            }
            else if (entity instanceof Api.Chat) {
                const full = await this.client?.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
                const fullChat = full?.chats?.find((c) => c instanceof Api.Chat && c.id.equals(entity.id));
                currentRights = fullChat?.defaultBannedRights ?? undefined;
            }
            const peer = await this.client?.getInputEntity(entity);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            await this.client?.invoke(new Api.messages.EditChatDefaultBannedRights({
                peer,
                bannedRights: new Api.ChatBannedRights({ untilDate: 0, ...mergeBannedRights(currentRights, permissions) }),
            }));
        }, `setChatPermissions ${chatId}`);
    }
    async setSlowMode(chatId, seconds) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const allowed = [0, 10, 30, 60, 300, 900, 3600];
        if (!allowed.includes(seconds)) {
            throw new Error(`Invalid slow mode interval. Allowed values: ${allowed.join(", ")} (seconds)`);
        }
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Slow mode is only available for supergroups");
            }
            await this.client?.invoke(new Api.channels.ToggleSlowMode({ channel: entity, seconds }));
        }, `setSlowMode ${chatId}`);
    }
    async toggleChannelSignatures(chatId, enabled) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Channel signatures are only available for broadcast channels (not groups or supergroups)");
            }
            if (entity.megagroup) {
                throw new Error("Channel signatures are only available for broadcast channels, not supergroups");
            }
            await this.client?.invoke(new Api.channels.ToggleSignatures({ channel: entity, signaturesEnabled: enabled }));
        }, `toggleChannelSignatures ${chatId}`);
    }
    async toggleAntiSpam(chatId, enabled) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Aggressive anti-spam is only available for supergroups");
            }
            if (!entity.megagroup) {
                throw new Error("Aggressive anti-spam is only available for supergroups, not broadcast channels");
            }
            await this.client?.invoke(new Api.channels.ToggleAntiSpam({ channel: entity, enabled }));
        }, `toggleAntiSpam ${chatId}`);
    }
    async toggleForumMode(chatId, enabled) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Forum mode is only available for supergroups");
            }
            if (!entity.megagroup) {
                throw new Error("Forum mode is only available for supergroups, not broadcast channels");
            }
            await this.client?.invoke(new Api.channels.ToggleForum({ channel: entity, enabled }));
        }, `toggleForumMode ${chatId}`);
    }
    async togglePrehistoryHidden(chatId, hidden) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Prehistory visibility is only available for supergroups");
            }
            if (!entity.megagroup) {
                throw new Error("Prehistory visibility is only available for supergroups, not broadcast channels");
            }
            await this.client?.invoke(new Api.channels.TogglePreHistoryHidden({ channel: entity, enabled: hidden }));
        }, `togglePrehistoryHidden ${chatId}`);
    }
    async setChatAvailableReactions(chatId, reactions) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel) && !(entity instanceof Api.Chat)) {
                throw new Error("Chat reactions can only be configured for groups, supergroups, and channels");
            }
            let availableReactions;
            if (reactions.type === "all") {
                availableReactions = new Api.ChatReactionsAll({ allowCustom: reactions.allowCustom });
            }
            else if (reactions.type === "none") {
                availableReactions = new Api.ChatReactionsNone();
            }
            else {
                if (reactions.emoji.length === 0) {
                    throw new Error('reactions.emoji must be non-empty when type is "some" (use type:"none" to disable)');
                }
                availableReactions = new Api.ChatReactionsSome({
                    reactions: reactions.emoji.map((emoticon) => new Api.ReactionEmoji({ emoticon })),
                });
            }
            await this.client?.invoke(new Api.messages.SetChatAvailableReactions({ peer: entity, availableReactions }));
        }, `setChatAvailableReactions ${chatId}`);
    }
    async approveChatJoinRequest(chatId, userId, approved) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Join request approval is only supported for supergroups and channels, not basic groups");
            }
            const user = await this.client?.getEntity(userId);
            if (!(user instanceof Api.User)) {
                throw new Error("Target is not a user");
            }
            const inputUser = new Api.InputUser({ userId: user.id, accessHash: user.accessHash ?? bigInt.zero });
            await this.client?.invoke(new Api.messages.HideChatJoinRequest({ peer: entity, userId: inputUser, approved }));
        }, `approveChatJoinRequest ${chatId}/${userId}`);
    }
    // ─── Inline bots & buttons ─────────────────────────────────────────────────
    async getInlineBotResults(bot, chatId, query, offset) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const peer = await this.resolveChat(chatId);
            const botEntity = await this.client?.getEntity(bot);
            if (!(botEntity instanceof Api.User)) {
                throw new Error(`'${bot}' is not a user/bot`);
            }
            if (!botEntity.bot) {
                throw new Error(`'${bot}' is not a bot (inline queries require a bot account)`);
            }
            const inputBot = new Api.InputUser({
                userId: botEntity.id,
                accessHash: botEntity.accessHash ?? bigInt.zero,
            });
            const result = await this.client?.invoke(new Api.messages.GetInlineBotResults({
                bot: inputBot,
                peer,
                query,
                offset: offset ?? "",
            }));
            if (!result)
                throw new Error("No inline bot results returned");
            return {
                queryId: result.queryId.toString(),
                nextOffset: result.nextOffset,
                cacheTime: result.cacheTime,
                gallery: result.gallery === true,
                results: result.results.map((r) => {
                    if (r instanceof Api.BotInlineResult) {
                        return { id: r.id, type: r.type, title: r.title, description: r.description, url: r.url };
                    }
                    const mr = r;
                    return { id: mr.id, type: mr.type, title: mr.title, description: mr.description };
                }),
            };
        }, `getInlineBotResults via ${bot}`);
    }
    async sendInlineBotResult(chatId, queryId, resultId, options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const peer = await this.resolveChat(chatId);
            const randomId = bigInt(Math.floor(Math.random() * 1e15));
            const replyTo = options?.replyTo ? new Api.InputReplyToMessage({ replyToMsgId: options.replyTo }) : undefined;
            const result = await this.client?.invoke(new Api.messages.SendInlineBotResult({
                peer,
                queryId: bigInt(queryId),
                id: resultId,
                randomId,
                ...(replyTo ? { replyTo } : {}),
                ...(options?.silent ? { silent: true } : {}),
                ...(options?.hideVia ? { hideVia: true } : {}),
                ...(options?.clearDraft ? { clearDraft: true } : {}),
            }));
            if (!result)
                throw new Error("No response from SendInlineBotResult");
            if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
                for (const update of result.updates) {
                    if (update instanceof Api.UpdateMessageID && update.randomId?.equals(randomId)) {
                        return { messageId: update.id };
                    }
                }
            }
            if (result instanceof Api.UpdateShortSentMessage) {
                return { messageId: result.id };
            }
            return { messageId: 0 };
        }, `sendInlineBotResult ${resultId} to ${chatId}`);
    }
    async pressButton(chatId, messageId, options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            let data;
            if (options.buttonIndex) {
                const { row, column } = options.buttonIndex;
                const messages = await this.client?.getMessages(entity, { ids: [messageId] });
                const msg = messages?.[0];
                if (!msg)
                    throw new Error(`Message ${messageId} not found in ${chatId}`);
                const markup = msg.replyMarkup;
                if (!markup)
                    throw new Error(`Message ${messageId} has no reply markup`);
                if (!(markup instanceof Api.ReplyInlineMarkup)) {
                    throw new Error(`Message ${messageId} reply markup is ${markup.className} (only ReplyInlineMarkup has callable buttons)`);
                }
                const rowEntry = markup.rows[row];
                if (!rowEntry)
                    throw new Error(`Row ${row} out of bounds (message has ${markup.rows.length} rows)`);
                const button = rowEntry.buttons[column];
                if (!button) {
                    throw new Error(`Column ${column} out of bounds in row ${row} (row has ${rowEntry.buttons.length} buttons)`);
                }
                if (!(button instanceof Api.KeyboardButtonCallback)) {
                    throw new Error(`Button at (${row},${column}) is ${button.className}, not callable — use the appropriate tool for URL/switch-inline/game buttons`);
                }
                if (button.requiresPassword) {
                    throw new Error(`Button at (${row},${column}) requires 2FA password confirmation — not supported by telegram-press-button`);
                }
                data = Buffer.from(button.data);
            }
            else if (options.data !== undefined) {
                data = Buffer.from(options.data, "base64");
            }
            else {
                throw new Error("Either buttonIndex or data must be provided");
            }
            const answer = await this.client?.invoke(new Api.messages.GetBotCallbackAnswer({
                peer: entity,
                msgId: messageId,
                data,
            }));
            if (!answer)
                throw new Error("No callback answer returned");
            return {
                alert: answer.alert,
                hasUrl: answer.hasUrl,
                nativeUi: answer.nativeUi,
                message: answer.message,
                url: answer.url,
                cacheTime: answer.cacheTime,
            };
        }, `pressButton ${chatId}/${messageId}`);
    }
    async getMessageButtons(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            const messages = await this.client?.getMessages(entity, { ids: [messageId] });
            const msg = messages?.[0];
            if (!msg)
                throw new Error(`Message ${messageId} not found in ${chatId}`);
            const markup = msg.replyMarkup;
            if (!markup) {
                return { markupType: "none", buttons: [] };
            }
            if (!(markup instanceof Api.ReplyInlineMarkup) && !(markup instanceof Api.ReplyKeyboardMarkup)) {
                return { markupType: markup.className, buttons: [] };
            }
            const buttons = [];
            markup.rows.forEach((rowEntry, row) => {
                rowEntry.buttons.forEach((button, col) => {
                    buttons.push(describeKeyboardButton(button, row, col));
                });
            });
            return { markupType: markup.className, buttons };
        }, `getMessageButtons ${chatId}/${messageId}`);
    }
    async getBroadcastStats(chatId, options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Broadcast stats are only available for channels");
            }
            if (entity.megagroup) {
                throw new Error("Broadcast stats are only available for broadcast channels, not supergroups (use telegram-get-megagroup-stats)");
            }
            let result;
            try {
                const response = await this.client?.invoke(new Api.stats.GetBroadcastStats({ channel: entity, dark: options?.dark }));
                if (!response) {
                    throw new Error("channel has no stats (may require Telegram Premium admin)");
                }
                result = response;
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (/CHAT_ADMIN_REQUIRED|ADMIN_RANK_INVALID/i.test(msg)) {
                    throw new Error("Access denied: channel stats require admin rights (and may require Telegram Premium)");
                }
                if (/STATS_UNAVAILABLE|BROADCAST_REQUIRED|PARTICIPANTS_TOO_FEW/i.test(msg)) {
                    throw new Error("channel has no stats (may require Telegram Premium admin)");
                }
                throw e;
            }
            return summarizeBroadcastStats(result, options?.includeGraphs === true);
        }, `getBroadcastStats ${chatId}`);
    }
    async getMegagroupStats(chatId, options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Megagroup stats are only available for supergroups");
            }
            if (!entity.megagroup) {
                throw new Error("Megagroup stats are only available for supergroups, not broadcast channels (use telegram-get-broadcast-stats)");
            }
            let result;
            try {
                const response = await this.client?.invoke(new Api.stats.GetMegagroupStats({ channel: entity, dark: options?.dark }));
                if (!response) {
                    throw new Error("supergroup has no stats yet (needs more activity/members)");
                }
                result = response;
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (/CHAT_ADMIN_REQUIRED|ADMIN_RANK_INVALID/i.test(msg)) {
                    throw new Error("Access denied: supergroup stats require admin rights");
                }
                if (/STATS_UNAVAILABLE|PARTICIPANTS_TOO_FEW|MEGAGROUP_REQUIRED/i.test(msg)) {
                    throw new Error("supergroup has no stats yet (needs more activity/members)");
                }
                throw e;
            }
            return summarizeMegagroupStats(result, options?.includeGraphs === true);
        }, `getMegagroupStats ${chatId}`, { throwOnFloodWait: true });
    }
    // ─── Stats & updates ───────────────────────────────────────────────────────
    async getUpdatesState() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const state = await this.client?.invoke(new Api.updates.GetState());
            if (!state)
                throw new Error("updates.GetState returned no state");
            return {
                pts: state.pts,
                qts: state.qts,
                date: state.date,
                seq: state.seq,
                unreadCount: state.unreadCount,
            };
        }, "getUpdatesState");
    }
    async getUpdates(cursor) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const ptsLimit = Math.min(cursor.ptsLimit ?? 100, 1000);
        const ptsTotalLimit = Math.min(cursor.ptsTotalLimit ?? 1000, 1000);
        return this.rateLimiter.execute(async () => {
            const diff = await this.client?.invoke(new Api.updates.GetDifference({
                pts: cursor.pts,
                date: cursor.date,
                qts: cursor.qts,
                ptsLimit,
                ptsTotalLimit,
            }));
            if (!diff)
                throw new Error("updates.GetDifference returned nothing");
            return summarizeUpdatesDifference(diff, cursor);
        }, "getUpdates");
    }
    async getChannelUpdates(chatId, cursor) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const limit = Math.min(cursor.limit ?? 100, 1_000);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Channel updates are only available for channels/supergroups");
            }
            const diff = await this.client?.invoke(new Api.updates.GetChannelDifference({
                channel: entity,
                filter: new Api.ChannelMessagesFilterEmpty(),
                pts: cursor.pts,
                limit,
                force: cursor.force,
            }));
            if (!diff)
                throw new Error("updates.GetChannelDifference returned nothing");
            return summarizeChannelDifference(diff, entity.id.toString(), cursor.pts);
        }, `getChannelUpdates ${chatId}`);
    }
    // ─── Forum topics ──────────────────────────────────────────────────────────
    async createForumTopic(chatId, title, iconColor, iconEmojiId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel) || !entity.forum) {
                throw new Error("Forum topics are only available in forum supergroups");
            }
            const randomId = bigInt(Math.floor(Math.random() * 1e15));
            const result = await this.client?.invoke(new Api.channels.CreateForumTopic({
                channel: entity,
                title,
                iconColor,
                iconEmojiId: iconEmojiId ? bigInt(iconEmojiId) : undefined,
                randomId,
            }));
            let topicId = 0;
            if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
                for (const update of result.updates) {
                    if (update instanceof Api.UpdateNewChannelMessage &&
                        update.message instanceof Api.MessageService &&
                        update.message.action instanceof Api.MessageActionTopicCreate) {
                        topicId = update.message.id;
                        break;
                    }
                }
                if (topicId === 0) {
                    for (const update of result.updates) {
                        if (update instanceof Api.UpdateMessageID && update.randomId?.equals(randomId)) {
                            topicId = update.id;
                            break;
                        }
                    }
                }
            }
            if (topicId === 0) {
                throw new Error("Failed to determine created topic ID");
            }
            return { id: topicId, title };
        }, `createForumTopic ${chatId}`);
    }
    async editForumTopic(chatId, topicId, options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel) || !entity.forum) {
                throw new Error("Forum topics are only available in forum supergroups");
            }
            await this.client?.invoke(new Api.channels.EditForumTopic({
                channel: entity,
                topicId,
                title: options.title,
                iconEmojiId: options.iconEmojiId ? bigInt(options.iconEmojiId) : undefined,
                closed: options.closed,
                hidden: options.hidden,
            }));
        }, `editForumTopic ${chatId}/${topicId}`);
    }
    async deleteForumTopic(chatId, topicId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel) || !entity.forum) {
                throw new Error("Forum topics are only available in forum supergroups");
            }
            await this.client?.invoke(new Api.channels.DeleteTopicHistory({
                channel: entity,
                topMsgId: topicId,
            }));
        }, `deleteForumTopic ${chatId}/${topicId}`);
    }
    // ─── Invite links & folders ────────────────────────────────────────────────
    async exportInviteLink(chatId, options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const peer = await this.client.getInputEntity(resolved);
        const result = await this.client.invoke(new Api.messages.ExportChatInvite({
            peer,
            expireDate: options?.expireDate,
            usageLimit: options?.usageLimit,
            requestNeeded: options?.requestNeeded,
            title: options?.title,
        }));
        if (result instanceof Api.ChatInviteExported) {
            return result.link;
        }
        throw new Error("Failed to export invite link");
    }
    async getInviteLinks(chatId, limit = 20, adminId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const peer = await this.client.getInputEntity(resolved);
        const admin = adminId ? await this.client.getInputEntity(await this.resolvePeer(adminId)) : new Api.InputUserSelf();
        const result = await this.client.invoke(new Api.messages.GetExportedChatInvites({
            peer,
            adminId: admin,
            limit,
        }));
        return result.invites
            .filter((inv) => inv instanceof Api.ChatInviteExported)
            .map((inv) => {
            const expiredByDate = inv.expireDate ? inv.expireDate < Math.floor(Date.now() / 1000) : false;
            const expiredByUsage = inv.usageLimit != null && inv.usageLimit > 0 && inv.usage != null ? inv.usage >= inv.usageLimit : false;
            return {
                link: inv.link,
                title: inv.title,
                expired: expiredByDate || expiredByUsage,
                revoked: inv.revoked ?? false,
                usageCount: inv.usage ?? 0,
            };
        });
    }
    async revokeInviteLink(chatId, link) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const peer = await this.client.getInputEntity(resolved);
        await this.client.invoke(new Api.messages.EditExportedChatInvite({
            peer,
            link,
            revoked: true,
        }));
    }
    async getChatFolders() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.messages.GetDialogFilters());
        const filters = "filters" in result ? result.filters : [];
        return filters
            .filter((f) => f instanceof Api.DialogFilter || f instanceof Api.DialogFilterChatlist)
            .map((f) => ({
            id: f.id,
            title: typeof f.title === "string" ? f.title : f.title.text,
            emoticon: f.emoticon,
            pinnedCount: f.pinnedPeers?.length ?? 0,
            includeCount: f.includePeers?.length ?? 0,
        }));
    }
    async setAutoDelete(chatId, period) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const peer = await this.client.getInputEntity(resolved);
        await this.client.invoke(new Api.messages.SetHistoryTTL({ peer, period }));
    }
    // ─── Folder management (v1.33.0) ───────────────────────────────────────────
    async createFolder(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        const filtersResult = await client.invoke(new Api.messages.GetDialogFilters());
        const existing = "filters" in filtersResult ? filtersResult.filters : [];
        const usedIds = existing
            .filter((f) => "id" in f)
            .map((f) => f.id);
        let newId = 2;
        while (usedIds.includes(newId))
            newId++;
        const toInput = async (ids) => {
            const peers = [];
            for (const id of ids) {
                const resolved = await this.resolvePeer(id);
                peers.push(await client.getInputEntity(resolved));
            }
            return peers;
        };
        const includePeers = await toInput(opts.includePeers ?? []);
        const excludePeers = await toInput(opts.excludePeers ?? []);
        const pinnedPeers = await toInput(opts.pinnedPeers ?? []);
        await client.invoke(new Api.messages.UpdateDialogFilter({
            id: newId,
            filter: new Api.DialogFilter({
                id: newId,
                title: new Api.TextWithEntities({ text: opts.title, entities: [] }),
                emoticon: opts.emoticon,
                contacts: opts.contacts,
                nonContacts: opts.nonContacts,
                groups: opts.groups,
                broadcasts: opts.broadcasts,
                bots: opts.bots,
                excludeMuted: opts.excludeMuted,
                excludeRead: opts.excludeRead,
                excludeArchived: opts.excludeArchived,
                pinnedPeers,
                includePeers,
                excludePeers,
            }),
        }));
        return newId;
    }
    async editFolder(id, opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        const filtersResult = await client.invoke(new Api.messages.GetDialogFilters());
        const existing = "filters" in filtersResult ? filtersResult.filters : [];
        const current = existing.find((f) => f instanceof Api.DialogFilter && f.id === id);
        if (!current)
            throw new Error(`Folder with id=${id} not found`);
        const toInput = async (ids) => {
            const peers = [];
            for (const id of ids) {
                const resolved = await this.resolvePeer(id);
                peers.push(await client.getInputEntity(resolved));
            }
            return peers;
        };
        const includePeers = opts.includePeers !== undefined ? await toInput(opts.includePeers) : current.includePeers;
        const excludePeers = opts.excludePeers !== undefined ? await toInput(opts.excludePeers) : current.excludePeers;
        const pinnedPeers = opts.pinnedPeers !== undefined ? await toInput(opts.pinnedPeers) : current.pinnedPeers;
        const titleText = opts.title !== undefined ? opts.title : typeof current.title === "string" ? current.title : current.title.text;
        await client.invoke(new Api.messages.UpdateDialogFilter({
            id,
            filter: new Api.DialogFilter({
                id,
                title: new Api.TextWithEntities({ text: titleText, entities: [] }),
                emoticon: opts.emoticon !== undefined ? opts.emoticon : current.emoticon,
                contacts: opts.contacts !== undefined ? opts.contacts : current.contacts,
                nonContacts: opts.nonContacts !== undefined ? opts.nonContacts : current.nonContacts,
                groups: opts.groups !== undefined ? opts.groups : current.groups,
                broadcasts: opts.broadcasts !== undefined ? opts.broadcasts : current.broadcasts,
                bots: opts.bots !== undefined ? opts.bots : current.bots,
                excludeMuted: opts.excludeMuted !== undefined ? opts.excludeMuted : current.excludeMuted,
                excludeRead: opts.excludeRead !== undefined ? opts.excludeRead : current.excludeRead,
                excludeArchived: opts.excludeArchived !== undefined ? opts.excludeArchived : current.excludeArchived,
                pinnedPeers,
                includePeers,
                excludePeers,
            }),
        }));
    }
    async deleteFolder(id) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.client.invoke(new Api.messages.UpdateDialogFilter({ id }));
    }
    async reorderFolders(ids) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.client.invoke(new Api.messages.UpdateDialogFiltersOrder({ order: ids }));
    }
    async getSuggestedFolders() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.messages.GetSuggestedDialogFilters());
        return result
            .filter((s) => s.filter instanceof Api.DialogFilter || s.filter instanceof Api.DialogFilterChatlist)
            .map((s) => ({
            title: typeof s.filter.title === "string" ? s.filter.title : s.filter.title.text,
            emoticon: s.filter.emoticon,
        }));
    }
    async toggleDialogFilterTags(enabled) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.client.invoke(new Api.messages.ToggleDialogFilterTags({ enabled }));
    }
    // ─── Global privacy (v1.33.0) ──────────────────────────────────────────────
    async getGlobalPrivacySettings() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const s = await this.client.invoke(new Api.account.GetGlobalPrivacySettings());
        return {
            archiveAndMuteNewNoncontactPeers: s.archiveAndMuteNewNoncontactPeers ?? false,
            keepArchivedUnmuted: s.keepArchivedUnmuted ?? false,
            keepArchivedFolders: s.keepArchivedFolders ?? false,
            hideReadMarks: s.hideReadMarks ?? false,
            newNoncontactPeersRequirePremium: s.newNoncontactPeersRequirePremium ?? false,
        };
    }
    async setGlobalPrivacySettings(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const current = await this.client.invoke(new Api.account.GetGlobalPrivacySettings());
        await this.client.invoke(new Api.account.SetGlobalPrivacySettings({
            settings: new Api.GlobalPrivacySettings({
                archiveAndMuteNewNoncontactPeers: opts.archiveAndMuteNewNoncontactPeers ?? current.archiveAndMuteNewNoncontactPeers,
                keepArchivedUnmuted: opts.keepArchivedUnmuted ?? current.keepArchivedUnmuted,
                keepArchivedFolders: opts.keepArchivedFolders ?? current.keepArchivedFolders,
                hideReadMarks: opts.hideReadMarks ?? current.hideReadMarks,
                newNoncontactPeersRequirePremium: opts.newNoncontactPeersRequirePremium ?? current.newNoncontactPeersRequirePremium,
            }),
        }));
    }
    // ─── Account & privacy ─────────────────────────────────────────────────────
    async getActiveSessions() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.account.GetAuthorizations());
        return result.authorizations.map((a) => ({
            hash: a.hash.toString(),
            device: a.deviceModel,
            platform: a.platform,
            appName: a.appName,
            appVersion: a.appVersion,
            ip: a.ip,
            country: a.country,
            dateActive: new Date(a.dateActive * 1000).toISOString(),
            current: a.current ?? false,
        }));
    }
    async terminateSession(hash) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.client.invoke(new Api.account.ResetAuthorization({ hash: bigInt(hash) }));
    }
    async terminateAllOtherSessions() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.client.invoke(new Api.auth.ResetAuthorizations());
    }
    static PRIVACY_KEYS = {
        phone_number: () => new Api.InputPrivacyKeyPhoneNumber(),
        last_seen: () => new Api.InputPrivacyKeyStatusTimestamp(),
        profile_photo: () => new Api.InputPrivacyKeyProfilePhoto(),
        forwards: () => new Api.InputPrivacyKeyForwards(),
        calls: () => new Api.InputPrivacyKeyPhoneCall(),
        groups: () => new Api.InputPrivacyKeyChatInvite(),
        bio: () => new Api.InputPrivacyKeyAbout(),
    };
    async setPrivacy(setting, rule, allowUsers, disallowUsers) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const keyFactory = TelegramService.PRIVACY_KEYS[setting];
        if (!keyFactory)
            throw new Error(`Unknown privacy setting: ${setting}. Valid: ${Object.keys(TelegramService.PRIVACY_KEYS).join(", ")}`);
        const rules = [];
        // Exceptions must come before the general rule so they are not shadowed
        if (disallowUsers?.length) {
            const users = [];
            const invalid = [];
            for (const u of disallowUsers) {
                const inputEntity = await this.client.getInputEntity(u);
                if (inputEntity instanceof Api.InputPeerUser) {
                    users.push(new Api.InputUser({ userId: inputEntity.userId, accessHash: inputEntity.accessHash }));
                }
                else {
                    invalid.push(u);
                }
            }
            if (invalid.length > 0) {
                throw new Error(`disallowUsers entries are not valid users: ${invalid.join(", ")}`);
            }
            if (users.length > 0) {
                rules.push(new Api.InputPrivacyValueDisallowUsers({ users }));
            }
        }
        if (allowUsers?.length) {
            const users = [];
            const invalid = [];
            for (const u of allowUsers) {
                const inputEntity = await this.client.getInputEntity(u);
                if (inputEntity instanceof Api.InputPeerUser) {
                    users.push(new Api.InputUser({ userId: inputEntity.userId, accessHash: inputEntity.accessHash }));
                }
                else {
                    invalid.push(u);
                }
            }
            if (invalid.length > 0) {
                throw new Error(`allowUsers entries are not valid users: ${invalid.join(", ")}`);
            }
            if (users.length > 0) {
                rules.push(new Api.InputPrivacyValueAllowUsers({ users }));
            }
        }
        if (rule === "everyone")
            rules.push(new Api.InputPrivacyValueAllowAll());
        else if (rule === "contacts")
            rules.push(new Api.InputPrivacyValueAllowContacts(), new Api.InputPrivacyValueDisallowAll());
        else
            rules.push(new Api.InputPrivacyValueDisallowAll());
        await this.client.invoke(new Api.account.SetPrivacy({ key: keyFactory(), rules }));
    }
    async updateProfile(options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.client.invoke(new Api.account.UpdateProfile({
            firstName: options.firstName,
            lastName: options.lastName,
            about: options.bio,
        }));
    }
    async updateUsername(username) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.client.invoke(new Api.account.UpdateUsername({ username }));
    }
    // ─── Stickers ──────────────────────────────────────────────────────────────
    async getStickerSet(shortName) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.messages.GetStickerSet({
            stickerset: new Api.InputStickerSetShortName({ shortName }),
            hash: 0,
        }));
        if (result instanceof Api.messages.StickerSetNotModified) {
            throw new Error("Sticker set was not modified");
        }
        const set = result.set;
        const packs = result.packs;
        // Build emoji map: document id -> emoji
        const emojiMap = new Map();
        for (const pack of packs) {
            for (const docId of pack.documents) {
                emojiMap.set(docId.toString(), pack.emoticon);
            }
        }
        return {
            title: set.title,
            shortName: set.shortName,
            count: set.count,
            stickers: result.documents.map((doc) => ({
                id: doc.id.toString(),
                accessHash: doc.accessHash.toString(),
                emoji: emojiMap.get(doc.id.toString()) || "",
            })),
        };
    }
    async searchStickerSets(query) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.messages.SearchStickerSets({
            q: query,
            hash: bigInt(0),
        }));
        if (result instanceof Api.messages.FoundStickerSetsNotModified) {
            return [];
        }
        return result.sets.map((covered) => {
            const set = covered.set;
            return {
                title: set.title,
                shortName: set.shortName,
                count: set.count,
            };
        });
    }
    async getInstalledStickerSets() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.messages.GetAllStickers({ hash: bigInt(0) }));
        if (result instanceof Api.messages.AllStickersNotModified) {
            return [];
        }
        return result.sets.map((set) => ({
            title: set.title,
            shortName: set.shortName,
            count: set.count,
        }));
    }
    async sendSticker(chatId, stickerSetShortName, stickerIndex, replyTo) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return await this.rateLimiter.execute(async () => {
            if (!Number.isInteger(stickerIndex)) {
                throw new Error(`Sticker index must be an integer, got ${stickerIndex}`);
            }
            // Fetch raw sticker set to get the actual Api.Document with valid fileReference
            const rawResult = await this.client?.invoke(new Api.messages.GetStickerSet({
                stickerset: new Api.InputStickerSetShortName({ shortName: stickerSetShortName }),
                hash: 0,
            }));
            if (!rawResult || rawResult instanceof Api.messages.StickerSetNotModified) {
                throw new Error("Sticker set not found");
            }
            const stickerSet = rawResult;
            if (stickerIndex < 0 || stickerIndex >= stickerSet.documents.length) {
                throw new Error(`Sticker index ${stickerIndex} out of range (0-${stickerSet.documents.length - 1})`);
            }
            const sticker = stickerSet.documents[stickerIndex];
            if (!(sticker instanceof Api.Document)) {
                throw new Error("Selected sticker is not a valid document");
            }
            const resolved = await this.resolvePeer(chatId);
            return await this.client?.sendFile(resolved, {
                file: sticker,
                ...(replyTo ? { replyTo } : {}),
            });
        }, `sendSticker to ${chatId}`);
    }
    // ─── Drafts & saved dialogs ────────────────────────────────────────────────
    async saveDraft(chatId, text, replyTo) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const peer = await this.client?.getInputEntity(resolved);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            const effectiveReplyTo = text === "" ? undefined : replyTo;
            await this.client?.invoke(new Api.messages.SaveDraft({
                peer,
                message: text,
                ...(effectiveReplyTo ? { replyTo: new Api.InputReplyToMessage({ replyToMsgId: effectiveReplyTo }) } : {}),
            }));
        }, `saveDraft in ${chatId}`);
    }
    async getAllDrafts() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const result = await this.client?.invoke(new Api.messages.GetAllDrafts());
            if (!result)
                return [];
            const updates = result instanceof Api.Updates || result instanceof Api.UpdatesCombined ? result.updates : [];
            const users = result instanceof Api.Updates || result instanceof Api.UpdatesCombined ? result.users : [];
            const chats = result instanceof Api.Updates || result instanceof Api.UpdatesCombined ? result.chats : [];
            const userMap = new Map();
            for (const u of users) {
                if (u instanceof Api.User)
                    userMap.set(u.id.toString(), u);
            }
            const chatMap = new Map();
            for (const c of chats) {
                if (c instanceof Api.Chat || c instanceof Api.Channel)
                    chatMap.set(c.id.toString(), c);
            }
            const resolvePeerTitle = (peer) => {
                if (peer instanceof Api.PeerUser) {
                    const user = userMap.get(peer.userId.toString());
                    if (user) {
                        const parts = [user.firstName, user.lastName].filter(Boolean);
                        const name = parts.join(" ") || "Unknown";
                        return {
                            id: peer.userId.toString(),
                            title: user.username ? `${name} (@${user.username})` : name,
                        };
                    }
                    return { id: peer.userId.toString(), title: peer.userId.toString() };
                }
                if (peer instanceof Api.PeerChat) {
                    const chat = chatMap.get(peer.chatId.toString());
                    return {
                        id: peer.chatId.toString(),
                        title: chat?.title ?? peer.chatId.toString(),
                    };
                }
                if (peer instanceof Api.PeerChannel) {
                    const channel = chatMap.get(peer.channelId.toString());
                    return {
                        id: peer.channelId.toString(),
                        title: channel?.title ?? peer.channelId.toString(),
                    };
                }
                return { id: "unknown", title: "unknown" };
            };
            const drafts = [];
            for (const update of updates) {
                if (update instanceof Api.UpdateDraftMessage && update.draft instanceof Api.DraftMessage) {
                    const { id, title } = resolvePeerTitle(update.peer);
                    drafts.push({
                        chatId: id,
                        chatTitle: title,
                        text: update.draft.message ?? "",
                        date: new Date((update.draft.date ?? 0) * 1000).toISOString(),
                    });
                }
            }
            return drafts;
        }, "getAllDrafts");
    }
    async clearAllDrafts() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.rateLimiter.execute(async () => {
            await this.client?.invoke(new Api.messages.ClearAllDrafts());
        }, "clearAllDrafts");
    }
    async getSavedDialogs(limit) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const result = await this.client?.invoke(new Api.messages.GetSavedDialogs({
                offsetDate: 0,
                offsetId: 0,
                offsetPeer: new Api.InputPeerEmpty(),
                limit,
                hash: bigInt(0),
            }));
            if (!result || result instanceof Api.messages.SavedDialogsNotModified)
                return [];
            const userMap = new Map();
            for (const u of result.users) {
                if (u instanceof Api.User)
                    userMap.set(u.id.toString(), u);
            }
            const chatMap = new Map();
            for (const c of result.chats) {
                if (c instanceof Api.Chat || c instanceof Api.Channel)
                    chatMap.set(c.id.toString(), c);
            }
            const resolvePeerTitle = (peer) => {
                if (peer instanceof Api.PeerUser) {
                    const user = userMap.get(peer.userId.toString());
                    if (user) {
                        const parts = [user.firstName, user.lastName].filter(Boolean);
                        const name = parts.join(" ") || "Unknown";
                        return {
                            id: peer.userId.toString(),
                            title: user.username ? `${name} (@${user.username})` : name,
                        };
                    }
                    return { id: peer.userId.toString(), title: peer.userId.toString() };
                }
                if (peer instanceof Api.PeerChat) {
                    const chat = chatMap.get(peer.chatId.toString());
                    return { id: peer.chatId.toString(), title: chat?.title ?? peer.chatId.toString() };
                }
                if (peer instanceof Api.PeerChannel) {
                    const channel = chatMap.get(peer.channelId.toString());
                    return { id: peer.channelId.toString(), title: channel?.title ?? peer.channelId.toString() };
                }
                return { id: "unknown", title: "unknown" };
            };
            const dialogs = [];
            for (const d of result.dialogs) {
                if (d instanceof Api.SavedDialog) {
                    const { id, title } = resolvePeerTitle(d.peer);
                    dialogs.push({
                        peerId: id,
                        peerTitle: title,
                        lastMsgId: d.topMessage,
                    });
                }
            }
            return dialogs;
        }, "getSavedDialogs");
    }
    async getWebPreview(url) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const result = await this.client?.invoke(new Api.messages.GetWebPagePreview({ message: url }));
            if (!result)
                return null;
            const media = result.media;
            if (!(media instanceof Api.MessageMediaWebPage))
                return null;
            const page = media.webpage;
            if (page instanceof Api.WebPageEmpty) {
                return { type: "empty", url: page.url };
            }
            if (page instanceof Api.WebPagePending) {
                return { type: "pending", url: page.url };
            }
            if (page instanceof Api.WebPage) {
                return {
                    type: page.type ?? "article",
                    url: page.url,
                    title: page.title,
                    description: page.description,
                    siteName: page.siteName,
                };
            }
            return null;
        }, "getWebPreview");
    }
    async getRecentStickers() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.messages.GetRecentStickers({ hash: bigInt(0) }));
        if (result instanceof Api.messages.RecentStickersNotModified) {
            return [];
        }
        const emojiMap = new Map();
        for (const pack of result.packs) {
            for (const docId of pack.documents) {
                emojiMap.set(docId.toString(), pack.emoticon);
            }
        }
        return result.stickers.map((doc) => ({
            id: doc.id.toString(),
            accessHash: doc.accessHash.toString(),
            emoji: emojiMap.get(doc.id.toString()) || "",
        }));
    }
    // ─── Stories ───────────────────────────────────────────────────────────────
    async getAllStories(options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.stories.GetAllStories({
                next: options?.next,
                hidden: options?.hidden,
                state: options?.state,
            }));
            if (!response)
                throw new Error("stories.GetAllStories returned nothing");
            return summarizeAllStories(response);
        }, "getAllStories");
    }
    async getPeerStories(chatId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.stories.GetPeerStories({ peer }));
            if (!response)
                throw new Error("stories.GetPeerStories returned nothing");
            return summarizePeerStories(response.stories);
        }, `getPeerStories ${chatId}`);
    }
    async getStoriesById(chatId, ids) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.stories.GetStoriesByID({ peer, id: ids }));
            if (!response)
                throw new Error("stories.GetStoriesByID returned nothing");
            return summarizeStoriesById(response);
        }, `getStoriesById ${chatId}`);
    }
    async getStoryViewsList(chatId, options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.stories.GetStoryViewsList({
                peer,
                id: options.id,
                q: options.q,
                justContacts: options.justContacts,
                reactionsFirst: options.reactionsFirst,
                forwardsFirst: options.forwardsFirst,
                offset: options.offset ?? "",
                limit: options.limit ?? 50,
            }));
            if (!response)
                throw new Error("stories.GetStoryViewsList returned nothing");
            return summarizeStoryViewsList(response);
        }, `getStoryViewsList ${chatId}/${options.id}`);
    }
    // ─── Boosts ────────────────────────────────────────────────────────────────
    async getMyBoosts() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.premium.GetMyBoosts());
            if (!response)
                throw new Error("premium.GetMyBoosts returned nothing");
            return summarizeMyBoosts(response);
        }, "getMyBoosts");
    }
    async getBoostsStatus(chatId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.premium.GetBoostsStatus({ peer }));
            if (!response)
                throw new Error("premium.GetBoostsStatus returned nothing");
            return summarizeBoostsStatus(response);
        }, `getBoostsStatus ${chatId}`);
    }
    async getBoostsList(chatId, options = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.premium.GetBoostsList({
                peer,
                gifts: options.gifts,
                offset: options.offset ?? "",
                limit: options.limit ?? 50,
            }));
            if (!response)
                throw new Error("premium.GetBoostsList returned nothing");
            return summarizeBoostsList(response);
        }, `getBoostsList ${chatId}`);
    }
    async getBusinessChatLinks() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.account.GetBusinessChatLinks());
            if (!response)
                throw new Error("account.GetBusinessChatLinks returned nothing");
            return summarizeBusinessChatLinks(response);
        }, "getBusinessChatLinks");
    }
    // ─── Profile write (v1.32.0) ───────────────────────────────────────────────
    async setEmojiStatus(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            let emojiStatus;
            if (opts.collectibleId) {
                emojiStatus = new Api.InputEmojiStatusCollectible({
                    collectibleId: bigInt(opts.collectibleId),
                    until: opts.untilUnix,
                });
            }
            else if (opts.documentId) {
                emojiStatus = new Api.EmojiStatus({
                    documentId: bigInt(opts.documentId),
                    until: opts.untilUnix,
                });
            }
            else {
                emojiStatus = new Api.EmojiStatusEmpty();
            }
            await client.invoke(new Api.account.UpdateEmojiStatus({ emojiStatus }));
        }, "setEmojiStatus");
    }
    async listEmojiStatuses(kind, limit) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const hash = bigInt(0);
            let resp;
            if (kind === "recent") {
                resp = await client.invoke(new Api.account.GetRecentEmojiStatuses({ hash }));
            }
            else if (kind === "channel_default") {
                resp = await client.invoke(new Api.account.GetChannelDefaultEmojiStatuses({ hash }));
            }
            else if (kind === "collectible") {
                resp = await client.invoke(new Api.account.GetCollectibleEmojiStatuses({ hash }));
            }
            else {
                resp = await client.invoke(new Api.account.GetDefaultEmojiStatuses({ hash }));
            }
            if (resp.className === "account.EmojiStatusesNotModified")
                return [];
            const statuses = resp.statuses ?? [];
            return statuses.slice(0, limit).map(summarizeEmojiStatus);
        }, `listEmojiStatuses ${kind}`);
    }
    async clearRecentEmojiStatuses() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            await client.invoke(new Api.account.ClearRecentEmojiStatuses());
        }, "clearRecentEmojiStatuses");
    }
    async setProfileColor(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            await client.invoke(new Api.account.UpdateColor({
                forProfile: opts.forProfile || undefined,
                color: opts.color,
                backgroundEmojiId: opts.backgroundEmojiId ? bigInt(opts.backgroundEmojiId) : undefined,
            }));
        }, "setProfileColor");
    }
    async setBirthday(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const birthday = opts.clear || !opts.day || !opts.month
                ? undefined
                : new Api.Birthday({ day: opts.day, month: opts.month, year: opts.year });
            await client.invoke(new Api.account.UpdateBirthday({ birthday }));
        }, "setBirthday");
    }
    async setPersonalChannel(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            if (opts.clear) {
                await client.invoke(new Api.account.UpdatePersonalChannel({ channel: new Api.InputChannelEmpty() }));
                return null;
            }
            const entity = await client.getInputEntity(opts.channelId ?? "");
            if (!(entity instanceof Api.InputPeerChannel)) {
                throw new Error(`Not a channel: ${opts.channelId}`);
            }
            const channel = new Api.InputChannel({
                channelId: entity.channelId,
                accessHash: entity.accessHash,
            });
            await client.invoke(new Api.account.UpdatePersonalChannel({ channel }));
            const info = await client.getEntity(entity);
            return "title" in info ? info.title : (opts.channelId ?? "");
        }, `setPersonalChannel ${opts.channelId ?? "clear"}`);
    }
    async setProfilePhoto(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const inputFile = await client.uploadFile({
                file: new CustomFile(opts.filePath.split("/").pop() ?? "upload", (await import("node:fs")).statSync(opts.filePath).size, opts.filePath),
                workers: 4,
            });
            const request = opts.isVideo
                ? new Api.photos.UploadProfilePhoto({
                    fallback: opts.fallback || undefined,
                    video: inputFile,
                    videoStartTs: opts.videoStartTs,
                })
                : new Api.photos.UploadProfilePhoto({
                    fallback: opts.fallback || undefined,
                    file: inputFile,
                });
            const result = await client.invoke(request);
            const photo = result.photo;
            return { id: photo.id.toString() };
        }, "setProfilePhoto");
    }
    async deleteProfilePhotos(photoIds) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const me = await client.getMe();
            const all = await client.invoke(new Api.photos.GetUserPhotos({
                userId: me.id,
                offset: 0,
                maxId: bigInt(0),
                limit: 100,
            }));
            const byId = new Map();
            for (const p of all.photos) {
                if (p instanceof Api.Photo)
                    byId.set(p.id.toString(), p);
            }
            const inputs = [];
            const missing = [];
            for (const pid of photoIds) {
                const photo = byId.get(pid);
                if (!photo) {
                    missing.push(pid);
                    continue;
                }
                inputs.push(new Api.InputPhoto({
                    id: photo.id,
                    accessHash: photo.accessHash,
                    fileReference: photo.fileReference,
                }));
            }
            if (inputs.length === 0) {
                throw new Error(`No matching photos found. Missing IDs: ${missing.join(", ")}`);
            }
            const deletedIds = await client.invoke(new Api.photos.DeletePhotos({ id: inputs }));
            return { deleted: deletedIds.map((x) => x.toString()), missing };
        }, "deleteProfilePhotos");
    }
    // ─── Business write (v1.32.0) ──────────────────────────────────────────────
    async buildBusinessRecipients(opts) {
        const flags = {};
        switch (opts.audience) {
            case "all_new":
                flags.contacts = true;
                flags.nonContacts = true;
                break;
            case "contacts_only":
                flags.contacts = true;
                break;
            case "non_contacts":
                flags.nonContacts = true;
                break;
            case "existing_only":
                flags.existingChats = true;
                break;
        }
        if (opts.includeUsers?.length) {
            flags.users = await this.resolveInputUsers(opts.includeUsers);
        }
        else if (opts.excludeUsers?.length) {
            flags.users = await this.resolveInputUsers(opts.excludeUsers);
            flags.excludeSelected = true;
        }
        return new Api.InputBusinessRecipients({ ...flags });
    }
    async resolveInputUsers(ids) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        const result = [];
        for (const id of ids) {
            const entity = await client.getInputEntity(id);
            if (entity instanceof Api.InputPeerUser) {
                result.push(new Api.InputUser({ userId: entity.userId, accessHash: entity.accessHash }));
            }
            else {
                throw new Error(`Not a user: ${id}`);
            }
        }
        return result;
    }
    async parseEntities(text, parseMode) {
        if (!this.client || !parseMode)
            return { text };
        // biome-ignore lint/suspicious/noExplicitAny: internal GramJS API
        const parser = this.client._parseMessageText?.bind(this.client);
        if (!parser)
            return { text };
        const [parsedText, entities] = await parser(text, parseMode === "md" ? "markdown" : "html");
        return { text: parsedText, entities: entities?.length ? entities : undefined };
    }
    async setBusinessWorkHours(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            if (opts.clear) {
                await client.invoke(new Api.account.UpdateBusinessWorkHours({}));
                return;
            }
            const dayOffsets = {
                mon: 0,
                tue: 1,
                wed: 2,
                thu: 3,
                fri: 4,
                sat: 5,
                sun: 6,
            };
            const weeklyOpen = (opts.schedule ?? []).map((s) => {
                const [fh, fm] = s.openFrom.split(":").map(Number);
                const [th, tm] = s.openTo.split(":").map(Number);
                const base = (dayOffsets[s.day] ?? 0) * 1440;
                return new Api.BusinessWeeklyOpen({
                    startMinute: base + fh * 60 + fm,
                    endMinute: base + th * 60 + tm,
                });
            });
            await client.invoke(new Api.account.UpdateBusinessWorkHours({
                businessWorkHours: new Api.BusinessWorkHours({
                    openNow: opts.openNow,
                    timezoneId: opts.timezone ?? "",
                    weeklyOpen,
                }),
            }));
        }, "setBusinessWorkHours");
    }
    async setBusinessLocation(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            if (opts.clear) {
                await client.invoke(new Api.account.UpdateBusinessLocation({}));
                return;
            }
            const geoPoint = opts.latitude !== undefined && opts.longitude !== undefined
                ? new Api.InputGeoPoint({ lat: opts.latitude, long: opts.longitude })
                : undefined;
            await client.invoke(new Api.account.UpdateBusinessLocation({ geoPoint, address: opts.address }));
        }, "setBusinessLocation");
    }
    async setBusinessGreeting(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            if (opts.clear) {
                await client.invoke(new Api.account.UpdateBusinessGreetingMessage({}));
                return;
            }
            const recipients = await this.buildBusinessRecipients({
                audience: opts.audience,
                includeUsers: opts.includeUsers,
                excludeUsers: opts.excludeUsers,
            });
            await client.invoke(new Api.account.UpdateBusinessGreetingMessage({
                message: new Api.InputBusinessGreetingMessage({
                    shortcutId: opts.shortcutId ?? 0,
                    recipients,
                    noActivityDays: opts.noActivityDays,
                }),
            }));
        }, "setBusinessGreeting");
    }
    async setBusinessAway(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            if (opts.clear) {
                await client.invoke(new Api.account.UpdateBusinessAwayMessage({}));
                return;
            }
            const scheduleObj = opts.schedule === "always"
                ? new Api.BusinessAwayMessageScheduleAlways()
                : opts.schedule === "outside_hours"
                    ? new Api.BusinessAwayMessageScheduleOutsideWorkHours()
                    : new Api.BusinessAwayMessageScheduleCustom({
                        startDate: opts.customFrom ?? 0,
                        endDate: opts.customTo ?? 0,
                    });
            const recipients = await this.buildBusinessRecipients({
                audience: opts.audience,
                includeUsers: opts.includeUsers,
                excludeUsers: opts.excludeUsers,
            });
            await client.invoke(new Api.account.UpdateBusinessAwayMessage({
                message: new Api.InputBusinessAwayMessage({
                    offlineOnly: opts.offlineOnly || undefined,
                    shortcutId: opts.shortcutId ?? 0,
                    schedule: scheduleObj,
                    recipients,
                }),
            }));
        }, "setBusinessAway");
    }
    async setBusinessIntro(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            if (opts.clear) {
                await client.invoke(new Api.account.UpdateBusinessIntro({}));
                return;
            }
            const sticker = opts.stickerId && opts.stickerAccessHash && opts.stickerFileReference
                ? new Api.InputDocument({
                    id: bigInt(opts.stickerId),
                    accessHash: bigInt(opts.stickerAccessHash),
                    fileReference: Buffer.from(opts.stickerFileReference, "hex"),
                })
                : undefined;
            await client.invoke(new Api.account.UpdateBusinessIntro({
                intro: new Api.InputBusinessIntro({
                    title: opts.title ?? "",
                    description: opts.description ?? "",
                    sticker,
                }),
            }));
        }, "setBusinessIntro");
    }
    async createBusinessChatLink(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const { text, entities } = await this.parseEntities(opts.message, opts.parseMode);
            const result = await client.invoke(new Api.account.CreateBusinessChatLink({
                link: new Api.InputBusinessChatLink({
                    message: text,
                    entities,
                    title: opts.title,
                }),
            }));
            const summary = summarizeBusinessChatLink(result);
            const slug = result.link.split("/").pop() ?? "";
            return { ...summary, slug };
        }, "createBusinessChatLink");
    }
    async editBusinessChatLink(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const { text, entities } = await this.parseEntities(opts.message, opts.parseMode);
            const result = await client.invoke(new Api.account.EditBusinessChatLink({
                slug: opts.slug,
                link: new Api.InputBusinessChatLink({
                    message: text,
                    entities,
                    title: opts.title,
                }),
            }));
            return summarizeBusinessChatLink(result);
        }, `editBusinessChatLink ${opts.slug}`);
    }
    async deleteBusinessChatLink(slug) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            await client.invoke(new Api.account.DeleteBusinessChatLink({ slug }));
        }, `deleteBusinessChatLink ${slug}`);
    }
    async resolveBusinessChatLink(slug) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const result = await client.invoke(new Api.account.ResolveBusinessChatLink({ slug }));
            const r = result;
            return {
                peer: summarizePeer(r.peer),
                message: r.message,
                entityCount: r.entities?.length ?? 0,
            };
        }, `resolveBusinessChatLink ${slug}`);
    }
    // ─── Group calls ───────────────────────────────────────────────────────────
    async getGroupCall(chatId, options = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const call = await this.resolveInputGroupCall(chatId);
            const response = await this.client?.invoke(new Api.phone.GetGroupCall({ call, limit: options.limit ?? 0 }));
            if (!response)
                throw new Error("phone.GetGroupCall returned nothing");
            return summarizeGroupCall(response);
        }, `getGroupCall ${chatId}`);
    }
    async getGroupCallParticipants(chatId, options = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const call = await this.resolveInputGroupCall(chatId);
            const ids = [];
            for (const id of options.ids ?? []) {
                ids.push(await this.resolvePeer(id));
            }
            const response = await this.client?.invoke(new Api.phone.GetGroupParticipants({
                call,
                ids,
                sources: options.sources ?? [],
                offset: options.offset ?? "",
                limit: options.limit ?? 100,
            }));
            if (!response)
                throw new Error("phone.GetGroupParticipants returned nothing");
            return summarizeGroupCallParticipants(response);
        }, `getGroupCallParticipants ${chatId}`);
    }
    // ─── Stars ─────────────────────────────────────────────────────────────────
    async getStarsStatus(chatId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.payments.GetStarsStatus({ peer }));
            if (!response)
                throw new Error("payments.GetStarsStatus returned nothing");
            return summarizeStarsStatus(response);
        }, `getStarsStatus ${chatId}`);
    }
    async getStarsTransactions(chatId, options = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.payments.GetStarsTransactions({
                peer,
                inbound: options.inbound,
                outbound: options.outbound,
                ascending: options.ascending,
                subscriptionId: options.subscriptionId,
                offset: options.offset ?? "",
                limit: options.limit ?? 50,
            }));
            if (!response)
                throw new Error("payments.GetStarsTransactions returned nothing");
            return summarizeStarsStatus(response);
        }, `getStarsTransactions ${chatId}`);
    }
    // ─── Star Gifts (v1.34.0) ──────────────────────────────────────────────────
    async getAvailableStarGifts() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.payments.GetStarGifts({ hash: 0 }));
        if (result.className === "payments.StarGiftsNotModified")
            return [];
        const gifts = result.className === "payments.StarGifts" ? result.gifts : [];
        return gifts
            .filter((g) => g instanceof Api.StarGift)
            .map((g) => ({
            id: g.id.toString(),
            stars: g.stars.toString(),
            convertStars: g.convertStars.toString(),
            limited: g.limited ?? false,
            availabilityRemains: g.availabilityRemains,
            availabilityTotal: g.availabilityTotal,
            upgradeStars: g.upgradeStars?.toString(),
        }));
    }
    async getSavedStarGifts(chatId, opts = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        const peer = await this.resolvePeer(chatId);
        const resolved = await client.getInputEntity(peer);
        const result = await client.invoke(new Api.payments.GetSavedStarGifts({
            peer: resolved,
            offset: opts.offset ?? "",
            limit: opts.limit ?? 20,
            excludeUnsaved: opts.excludeUnsaved,
            excludeSaved: opts.excludeSaved,
            excludeUnlimited: opts.excludeUnlimited,
            excludeLimited: opts.excludeLimited,
            excludeUnique: opts.excludeUnique,
            sortByValue: opts.sortByValue,
        }));
        const r = result;
        return {
            count: r.count,
            nextOffset: r.nextOffset,
            gifts: r.gifts.map((sg) => {
                const gift = sg.gift;
                if (gift instanceof Api.StarGift) {
                    return {
                        giftId: gift.id.toString(),
                        giftKind: "regular",
                        stars: gift.stars.toString(),
                        convertStars: gift.convertStars.toString(),
                        msgId: sg.msgId ?? undefined,
                        savedId: sg.savedId?.toString(),
                        fromPeerId: sg.fromId ? summarizePeer(sg.fromId).id : undefined,
                        date: sg.date,
                        unsaved: sg.unsaved ?? false,
                        canUpgrade: sg.canUpgrade ?? false,
                        upgradeStars: sg.upgradeStars?.toString(),
                    };
                }
                const u = gift;
                return {
                    giftId: u.id.toString(),
                    giftKind: "unique",
                    giftTitle: u.title,
                    msgId: sg.msgId ?? undefined,
                    savedId: sg.savedId?.toString(),
                    fromPeerId: sg.fromId ? summarizePeer(sg.fromId).id : undefined,
                    date: sg.date,
                    unsaved: sg.unsaved ?? false,
                    canUpgrade: false,
                };
            }),
        };
    }
    async saveStarGift(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        let stargift;
        if (opts.msgId !== undefined) {
            stargift = new Api.InputSavedStarGiftUser({ msgId: opts.msgId });
        }
        else if (opts.chatId && opts.savedId) {
            const peer = await this.resolvePeer(opts.chatId);
            const inputPeer = await client.getInputEntity(peer);
            stargift = new Api.InputSavedStarGiftChat({ peer: inputPeer, savedId: bigInt(opts.savedId) });
        }
        else {
            throw new Error("Provide msgId (user gift) or both chatId and savedId (chat gift)");
        }
        await client.invoke(new Api.payments.SaveStarGift({ stargift, unsave: opts.unsave }));
    }
    async convertStarGift(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        let stargift;
        if (opts.msgId !== undefined) {
            stargift = new Api.InputSavedStarGiftUser({ msgId: opts.msgId });
        }
        else if (opts.chatId && opts.savedId) {
            const peer = await this.resolvePeer(opts.chatId);
            const inputPeer = await client.getInputEntity(peer);
            stargift = new Api.InputSavedStarGiftChat({ peer: inputPeer, savedId: bigInt(opts.savedId) });
        }
        else {
            throw new Error("Provide msgId (user gift) or both chatId and savedId (chat gift)");
        }
        await client.invoke(new Api.payments.ConvertStarGift({ stargift }));
    }
    async getStarsTopupOptions() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.payments.GetStarsTopupOptions());
        return result.map((o) => ({
            stars: o.stars.toString(),
            currency: o.currency,
            amount: o.amount.toString(),
            extended: o.extended ?? false,
        }));
    }
    async getStarsSubscriptions(chatId, opts = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const result = await this.client.invoke(new Api.payments.GetStarsSubscriptions({ peer, offset: opts.offset ?? "", missingBalance: opts.missingBalance }));
        const r = result;
        const subs = r.subscriptions ?? [];
        return {
            subscriptions: subs.map((s) => ({
                id: s.id,
                peerId: summarizePeer(s.peer).id,
                untilDate: s.untilDate,
                periodSeconds: s.pricing.period,
                priceStars: s.pricing.amount.toString(),
                canceled: s.canceled ?? false,
                title: s.title,
            })),
            nextOffset: r.subscriptionsNextOffset,
        };
    }
    async changeStarsSubscription(chatId, subscriptionId, canceled) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        await this.client.invoke(new Api.payments.ChangeStarsSubscription({ peer, subscriptionId, canceled }));
    }
    // ─── Quick replies ─────────────────────────────────────────────────────────
    async getQuickReplies(hash) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.messages.GetQuickReplies({ hash: hash ? bigInt(hash) : bigInt(0) }));
            if (!response)
                throw new Error("messages.GetQuickReplies returned nothing");
            return summarizeQuickReplies(response);
        }, "getQuickReplies");
    }
    async getQuickReplyMessages(shortcutId, options = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.messages.GetQuickReplyMessages({
                shortcutId,
                id: options.ids,
                hash: options.hash ? bigInt(options.hash) : bigInt(0),
            }));
            if (!response)
                throw new Error("messages.GetQuickReplyMessages returned nothing");
            return summarizeQuickReplyMessages(response);
        }, `getQuickReplyMessages ${shortcutId}`);
    }
    // ─── Stories Write ─────────────────────────────────────────────────────────
    async sendStory(chatId, filePath, opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const inputPeer = await client.getInputEntity(peer);
            const fileData = await readFile(filePath);
            const uploaded = await client.uploadFile({
                file: new CustomFile(filePath, fileData.length, filePath, fileData),
                workers: 4,
            });
            const mediaType = opts.type ?? detectMediaType(filePath);
            const media = mediaType === "photo"
                ? new Api.InputMediaUploadedPhoto({ file: uploaded })
                : new Api.InputMediaUploadedDocument({
                    file: uploaded,
                    mimeType: "video/mp4",
                    attributes: [new Api.DocumentAttributeVideo({ duration: 0, w: 0, h: 0, supportsStreaming: true })],
                });
            const privacyRules = buildStoryPrivacyRules(opts.privacy, opts.allowUserIds, opts.disallowUserIds);
            let caption = opts.caption;
            let entities;
            if (opts.caption && opts.parseMode) {
                // biome-ignore lint/suspicious/noExplicitAny: GramJS internal helper, no public typing
                const parser = client._parseMessageText;
                if (typeof parser === "function") {
                    [caption, entities] = await parser.call(client, opts.caption, opts.parseMode === "html" ? "html" : "md");
                }
            }
            const result = await client.invoke(new Api.stories.SendStory({
                peer: inputPeer,
                media,
                privacyRules,
                caption,
                ...(entities?.length ? { entities } : {}),
                randomId: generateRandomBigInt(),
                period: opts.period ?? 86400,
                pinned: opts.pinned,
                noforwards: opts.noforwards,
            }));
            const id = extractStoryIdFromUpdates(result) || undefined;
            return { id, period: opts.period ?? 86400 };
        }, `sendStory ${chatId}`);
    }
    async editStory(chatId, storyId, opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const inputPeer = await client.getInputEntity(peer);
            const changed = [];
            let media;
            if (opts.filePath) {
                changed.push("media");
                const fileData = await readFile(opts.filePath);
                const uploaded = await client.uploadFile({
                    file: new CustomFile(opts.filePath, fileData.length, opts.filePath, fileData),
                    workers: 4,
                });
                const mediaType = opts.type ?? detectMediaType(opts.filePath);
                media =
                    mediaType === "photo"
                        ? new Api.InputMediaUploadedPhoto({ file: uploaded })
                        : new Api.InputMediaUploadedDocument({
                            file: uploaded,
                            mimeType: "video/mp4",
                            attributes: [new Api.DocumentAttributeVideo({ duration: 0, w: 0, h: 0, supportsStreaming: true })],
                        });
            }
            let caption = opts.caption;
            let entities;
            if (opts.caption !== undefined) {
                changed.push("caption");
                if (opts.caption && opts.parseMode) {
                    // biome-ignore lint/suspicious/noExplicitAny: GramJS internal helper, no public typing
                    const parser = client._parseMessageText;
                    if (typeof parser === "function") {
                        [caption, entities] = await parser.call(client, opts.caption, opts.parseMode === "html" ? "html" : "md");
                    }
                }
            }
            let privacyRules;
            if (opts.privacy) {
                changed.push("privacy");
                privacyRules = buildStoryPrivacyRules(opts.privacy, opts.allowUserIds, opts.disallowUserIds);
            }
            await client.invoke(new Api.stories.EditStory({
                peer: inputPeer,
                id: storyId,
                ...(media ? { media } : {}),
                ...(caption !== undefined ? { caption } : {}),
                ...(entities?.length ? { entities } : {}),
                ...(privacyRules ? { privacyRules } : {}),
            }));
            return { changed };
        }, `editStory ${chatId}/${storyId}`);
    }
    async deleteStories(chatId, ids) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const deleted = await this.client?.invoke(new Api.stories.DeleteStories({ peer, id: ids }));
            return { deleted: deleted ?? [] };
        }, `deleteStories ${chatId}`);
    }
    async sendStoryReaction(chatId, storyId, emoji, addToRecent) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const reaction = emoji === "" ? new Api.ReactionEmpty() : new Api.ReactionEmoji({ emoticon: emoji });
            await this.client?.invoke(new Api.stories.SendReaction({ peer, storyId, reaction, addToRecent }));
        }, `sendStoryReaction ${chatId}/${storyId}`);
    }
    async exportStoryLink(chatId, storyId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const result = await this.client?.invoke(new Api.stories.ExportStoryLink({ peer, id: storyId }));
            if (!result)
                throw new Error("stories.ExportStoryLink returned nothing");
            return { link: result.link };
        }, `exportStoryLink ${chatId}/${storyId}`);
    }
    async readStories(chatId, maxId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const ids = await this.client?.invoke(new Api.stories.ReadStories({ peer, maxId }));
            return { ids: ids ?? [] };
        }, `readStories ${chatId}/${maxId}`);
    }
    async toggleStoryPinned(chatId, ids, pinned) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const affected = await this.client?.invoke(new Api.stories.TogglePinned({ peer, id: ids, pinned }));
            return { affected: affected ?? [] };
        }, `toggleStoryPinned ${chatId}`);
    }
    async toggleStoryPinnedToTop(chatId, ids) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            await this.client?.invoke(new Api.stories.TogglePinnedToTop({ peer, id: ids }));
            return { ok: true };
        }, `toggleStoryPinnedToTop ${chatId}`);
    }
    async activateStealthMode(past, future) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            await this.client?.invoke(new Api.stories.ActivateStealthMode({ past: past ?? false, future: future ?? false }));
        }, "activateStealthMode");
    }
    async getStoriesArchive(chatId, offsetId, limit) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const result = await this.client?.invoke(new Api.stories.GetStoriesArchive({ peer, offsetId, limit }));
            if (!result)
                throw new Error("stories.GetStoriesArchive returned nothing");
            return summarizeStoriesById(result);
        }, `getStoriesArchive ${chatId}`);
    }
    async reportStory(chatId, ids, option, message) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const optionBytes = Buffer.from(option, "base64");
            const result = await this.client?.invoke(new Api.stories.Report({ peer, id: ids, option: optionBytes, message }));
            if (!result)
                throw new Error("stories.Report returned nothing");
            return summarizeReportResult(result);
        }, `reportStory ${chatId}`);
    }
    // ─── Discussion & Read Receipts ────────────────────────────────────────────
    async getDiscussionMessage(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const result = await this.client?.invoke(new Api.messages.GetDiscussionMessage({ peer, msgId: messageId }));
            if (!result)
                throw new Error("messages.GetDiscussionMessage returned nothing");
            return summarizeDiscussionMessage(result);
        }, `getDiscussionMessage ${chatId}/${messageId}`);
    }
    async getGroupsForDiscussion() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const result = await this.client?.invoke(new Api.channels.GetGroupsForDiscussion());
            if (!result)
                throw new Error("channels.GetGroupsForDiscussion returned nothing");
            return summarizeGroupsForDiscussion(result);
        }, "getGroupsForDiscussion");
    }
    async getMessageReadParticipants(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const result = await this.client?.invoke(new Api.messages.GetMessageReadParticipants({ peer, msgId: messageId }));
            if (!result)
                throw new Error("messages.GetMessageReadParticipants returned nothing");
            return summarizeReadParticipants(result, messageId);
        }, `getMessageReadParticipants ${chatId}/${messageId}`);
    }
    async getOutboxReadDate(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            try {
                const result = await this.client?.invoke(new Api.messages.GetOutboxReadDate({ peer, msgId: messageId }));
                if (!result)
                    return { readAt: null };
                const date = result.date;
                return { readAt: new Date(date * 1000).toISOString() };
            }
            catch (e) {
                if (/NOT_READ_YET/i.test(e.message ?? ""))
                    return { readAt: null };
                throw e;
            }
        }, `getOutboxReadDate ${chatId}/${messageId}`);
    }
    async resolveInputGroupCall(chatId) {
        const entity = await this.resolveChat(chatId);
        let call;
        if (entity instanceof Api.Channel) {
            const full = await this.client?.invoke(new Api.channels.GetFullChannel({ channel: entity }));
            if (full?.fullChat instanceof Api.ChannelFull) {
                call = full.fullChat.call;
            }
        }
        else if (entity instanceof Api.Chat) {
            const full = await this.client?.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
            if (full?.fullChat instanceof Api.ChatFull) {
                call = full.fullChat.call;
            }
        }
        else {
            throw new Error("Group calls are only available for groups/supergroups/channels");
        }
        if (!call) {
            throw new Error(`No active group call in chat ${chatId}`);
        }
        return call;
    }
}
