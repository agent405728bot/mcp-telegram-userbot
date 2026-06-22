import bigInt from "big-integer";
import { Api } from "telegram/tl/index.js";
/**
 * Build an InputReplyToMessage from optional replyTo / topicId, matching the shape used by
 * raw messages.SendMedia. Returns undefined when neither is set so the caller can spread-omit it.
 */
export declare function buildReplyTo(replyTo?: number, topicId?: number): Api.InputReplyToMessage | undefined;
/** Cryptographically random 64-bit bigInt for TL randomId (SendMedia/SendMultiMedia require it). */
export declare function generateRandomBigInt(): bigInt.BigInteger;
/**
 * Extract the server-assigned message ID from an Updates envelope returned by SendMedia/SendMessage.
 * Prefers UpdateMessageID (authoritative for SendMedia), falls back to UpdateNewMessage /
 * UpdateNewChannelMessage for safety. Returns undefined when no ID is found.
 */
export declare function extractMessageId(result: Api.TypeUpdates | Api.Message | Api.UpdateShortSentMessage | undefined): number | undefined;
/**
 * Extract the MessageMediaDice value and captured message ID from a SendMedia dice envelope.
 * Value is only present in UpdateNewMessage/UpdateNewChannelMessage; UpdateMessageID carries the ID only.
 */
export declare function extractDiceResult(result: Api.TypeUpdates | undefined): {
    id: number;
    value?: number;
} | undefined;
export declare function describeAdminLogAction(action: Api.TypeChannelAdminLogEventAction): string;
export declare function describeAdminLogDetails(action: Api.TypeChannelAdminLogEventAction, describeUser: (userId: bigInt.BigInteger) => string): string;
export declare function reactionToEmoji(reaction: Api.TypeReaction): string | null;
export type CompactStatsGraph = {
    type: "async";
    token: string;
} | {
    type: "error";
    error: string;
} | {
    type: "data";
    data: unknown;
    zoomToken?: string;
};
export type StatsValue = {
    current: number;
    previous: number;
};
export type BroadcastStatsSummary = {
    period: {
        minDate: number;
        maxDate: number;
    };
    followers: StatsValue;
    viewsPerPost: StatsValue;
    sharesPerPost: StatsValue;
    reactionsPerPost: StatsValue;
    viewsPerStory: StatsValue;
    sharesPerStory: StatsValue;
    reactionsPerStory: StatsValue;
    enabledNotifications: {
        part: number;
        total: number;
        percent: number;
    };
    recentPostsInteractions: Array<{
        kind: "message";
        msgId: number;
        views: number;
        forwards: number;
        reactions: number;
    } | {
        kind: "story";
        storyId: number;
        views: number;
        forwards: number;
        reactions: number;
    }>;
    graphs?: Record<string, CompactStatsGraph>;
};
export type MegagroupStatsSummary = {
    period: {
        minDate: number;
        maxDate: number;
    };
    members: StatsValue;
    messages: StatsValue;
    viewers: StatsValue;
    posters: StatsValue;
    topPosters: Array<{
        userId: string;
        messages: number;
        avgChars: number;
    }>;
    topAdmins: Array<{
        userId: string;
        deleted: number;
        kicked: number;
        banned: number;
    }>;
    topInviters: Array<{
        userId: string;
        invitations: number;
    }>;
    graphs?: Record<string, CompactStatsGraph>;
};
export declare function summarizeMegagroupStats(stats: Api.stats.MegagroupStats, includeGraphs: boolean): MegagroupStatsSummary;
export declare function summarizeBroadcastStats(stats: Api.stats.BroadcastStats, includeGraphs: boolean): BroadcastStatsSummary;
export type ChatPermissions = {
    sendMessages?: boolean;
    sendMedia?: boolean;
    sendStickers?: boolean;
    sendGifs?: boolean;
    sendPolls?: boolean;
    sendInline?: boolean;
    embedLinks?: boolean;
    changeInfo?: boolean;
    inviteUsers?: boolean;
    pinMessages?: boolean;
};
export declare function mergeBannedRights(current: Record<string, unknown> | undefined | null, permissions: ChatPermissions): Record<string, boolean>;
export type MessageButtonDescriptor = {
    row: number;
    col: number;
    type: string;
    label: string;
    data?: string;
    url?: string;
    switchQuery?: string;
    samePeer?: boolean;
    userId?: string;
    buttonId?: number;
    copyText?: string;
    requiresPassword?: boolean;
    quiz?: boolean;
};
export declare function describeKeyboardButton(button: Api.TypeKeyboardButton, row: number, col: number): MessageButtonDescriptor;
export type CompactPeer = {
    kind: "user";
    id: string;
} | {
    kind: "chat";
    id: string;
} | {
    kind: "channel";
    id: string;
};
export type UpdatesMessageSummary = {
    id: number;
    peer: CompactPeer;
    fromId?: CompactPeer;
    date: number;
    text: string;
    isService: boolean;
};
export type UpdatesDifferenceSummary = {
    state: {
        pts: number;
        qts: number;
        date: number;
        seq: number;
        unreadCount?: number;
    };
    isFinal: boolean;
    newMessages: UpdatesMessageSummary[];
    deletedMessageIds: Array<{
        peer?: CompactPeer;
        messageIds: number[];
    }>;
    otherUpdates: Array<{
        type: string;
    }>;
    fallback?: {
        kind: "tooLong";
        suggestedAction: string;
    };
};
export type ChannelDifferenceSummary = {
    channelId: string;
    pts: number;
    isFinal: boolean;
    timeout?: number;
    newMessages: UpdatesMessageSummary[];
    otherUpdates: Array<{
        type: string;
    }>;
    fallback?: {
        kind: "tooLong";
        suggestedAction: string;
    };
};
export declare function peerToCompact(peer: Api.TypePeer | undefined): CompactPeer | undefined;
export declare function summarizeUpdatesDifference(diff: Api.updates.TypeDifference, cursor: {
    pts: number;
    qts: number;
    date: number;
}): UpdatesDifferenceSummary;
export declare function summarizeChannelDifference(diff: Api.updates.TypeChannelDifference, channelId: string, fallbackPts: number): ChannelDifferenceSummary;
export type StoryItemSummary = {
    id: number;
    kind: "active" | "deleted" | "skipped";
    date?: number;
    expireDate?: number;
    caption?: string;
    mediaType?: string;
    pinned?: boolean;
    public?: boolean;
    closeFriends?: boolean;
    edited?: boolean;
    noforwards?: boolean;
    fromId?: CompactPeer;
    viewsCount?: number;
    reactionsCount?: number;
};
export type PeerStoriesSummary = {
    peer: CompactPeer;
    maxReadId?: number;
    stories: StoryItemSummary[];
};
export type AllStoriesSummary = {
    modified: boolean;
    state: string;
    hasMore?: boolean;
    count?: number;
    peerStories: PeerStoriesSummary[];
    stealthMode?: {
        activeUntilDate?: number;
        cooldownUntilDate?: number;
    };
};
export type StoriesByIdSummary = {
    count: number;
    stories: StoryItemSummary[];
    pinnedToTop?: number[];
};
export type StoryViewSummary = {
    kind: "user";
    userId: string;
    date: number;
    reaction?: string | null;
    blocked?: boolean;
    blockedMyStoriesFrom?: boolean;
} | {
    kind: "publicForward";
    messageId?: number;
    peer?: CompactPeer;
    blocked?: boolean;
    blockedMyStoriesFrom?: boolean;
} | {
    kind: "publicRepost";
    peer?: CompactPeer;
    storyId?: number;
    blocked?: boolean;
    blockedMyStoriesFrom?: boolean;
};
export type StoryViewsListSummary = {
    count: number;
    viewsCount: number;
    forwardsCount: number;
    reactionsCount: number;
    views: StoryViewSummary[];
    nextOffset?: string;
};
export type MyBoostSummary = {
    slot: number;
    peer?: CompactPeer;
    date: number;
    expires: number;
    cooldownUntilDate?: number;
};
export type MyBoostsSummary = {
    count: number;
    myBoosts: MyBoostSummary[];
};
export declare function summarizeMyBoost(boost: Api.TypeMyBoost): MyBoostSummary;
export declare function summarizeMyBoosts(result: Api.premium.TypeMyBoosts): MyBoostsSummary;
export type PrepaidGiveawaySummary = {
    kind: "premium" | "stars";
    id: string;
    quantity: number;
    date: number;
    months?: number;
    stars?: string;
    boosts?: number;
};
export type BoostsStatusSummary = {
    level: number;
    boosts: number;
    currentLevelBoosts: number;
    nextLevelBoosts?: number;
    giftBoosts?: number;
    premiumAudience?: {
        part: number;
        total: number;
    };
    boostUrl: string;
    myBoost?: boolean;
    myBoostSlots?: number[];
    prepaidGiveaways?: PrepaidGiveawaySummary[];
};
export declare function summarizePrepaidGiveaway(g: Api.TypePrepaidGiveaway): PrepaidGiveawaySummary;
export declare function summarizeBoostsStatus(result: Api.premium.TypeBoostsStatus): BoostsStatusSummary;
export type BoostSummary = {
    id: string;
    userId?: string;
    date: number;
    expires: number;
    gift?: boolean;
    giveaway?: boolean;
    unclaimed?: boolean;
    giveawayMsgId?: number;
    usedGiftSlug?: string;
    multiplier?: number;
    stars?: string;
};
export type BoostsListSummary = {
    count: number;
    boosts: BoostSummary[];
    nextOffset?: string;
};
export declare function summarizeBoost(boost: Api.TypeBoost): BoostSummary;
export declare function summarizeBoostsList(result: Api.premium.TypeBoostsList): BoostsListSummary;
export type BusinessChatLinkSummary = {
    link: string;
    message: string;
    title?: string;
    views: number;
    entityCount: number;
};
export type BusinessChatLinksSummary = {
    count: number;
    links: BusinessChatLinkSummary[];
};
export declare function summarizeBusinessChatLink(link: Api.TypeBusinessChatLink): BusinessChatLinkSummary;
export declare function summarizeBusinessChatLinks(result: Api.account.TypeBusinessChatLinks): BusinessChatLinksSummary;
export type GroupCallInfoSummary = {
    kind: "active";
    id: string;
    accessHash: string;
    participantsCount: number;
    title?: string;
    scheduleDate?: number;
    recordStartDate?: number;
    streamDcId?: number;
    unmutedVideoCount?: number;
    unmutedVideoLimit: number;
    version: number;
    joinMuted?: boolean;
    canChangeJoinMuted?: boolean;
    joinDateAsc?: boolean;
    scheduleStartSubscribed?: boolean;
    canStartVideo?: boolean;
    recordVideoActive?: boolean;
    rtmpStream?: boolean;
    listenersHidden?: boolean;
} | {
    kind: "discarded";
    id: string;
    accessHash: string;
    duration: number;
};
export type GroupCallParticipantSummary = {
    peer: CompactPeer | undefined;
    date: number;
    activeDate?: number;
    source: number;
    volume?: number;
    muted?: boolean;
    left?: boolean;
    canSelfUnmute?: boolean;
    justJoined?: boolean;
    self?: boolean;
    mutedByYou?: boolean;
    volumeByAdmin?: boolean;
    videoJoined?: boolean;
    about?: string;
    raiseHandRating?: string;
    hasVideo?: boolean;
    hasPresentation?: boolean;
};
export type GroupCallSummary = {
    call: GroupCallInfoSummary;
    participants: GroupCallParticipantSummary[];
    participantsNextOffset?: string;
};
export type GroupCallParticipantsSummary = {
    count: number;
    participants: GroupCallParticipantSummary[];
    nextOffset?: string;
    version: number;
};
export declare function summarizeGroupCallInfo(call: Api.TypeGroupCall): GroupCallInfoSummary;
export declare function summarizeGroupCallParticipant(p: Api.TypeGroupCallParticipant): GroupCallParticipantSummary;
export declare function summarizeGroupCall(result: Api.phone.TypeGroupCall): GroupCallSummary;
export declare function summarizeGroupCallParticipants(result: Api.phone.TypeGroupParticipants): GroupCallParticipantsSummary;
export type StarsAmountSummary = {
    amount: string;
    nanos: number;
};
export type StarsTransactionPeerSummary = {
    kind: "appStore";
} | {
    kind: "playMarket";
} | {
    kind: "premiumBot";
} | {
    kind: "fragment";
} | {
    kind: "ads";
} | {
    kind: "api";
} | {
    kind: "unsupported";
} | {
    kind: "peer";
    peer: CompactPeer | undefined;
};
export type StarsTransactionSummary = {
    id: string;
    stars: StarsAmountSummary;
    date: number;
    peer: StarsTransactionPeerSummary;
    refund?: boolean;
    pending?: boolean;
    failed?: boolean;
    gift?: boolean;
    reaction?: boolean;
    title?: string;
    description?: string;
    msgId?: number;
    subscriptionPeriod?: number;
    giveawayPostId?: number;
    transactionDate?: number;
    transactionUrl?: string;
};
export type StarsSubscriptionPricingSummary = {
    period: number;
    amount: string;
};
export type StarsSubscriptionSummary = {
    id: string;
    peer: CompactPeer | undefined;
    untilDate: number;
    pricing: StarsSubscriptionPricingSummary;
    canceled?: boolean;
    canRefulfill?: boolean;
    missingBalance?: boolean;
    botCanceled?: boolean;
    chatInviteHash?: string;
    title?: string;
    invoiceSlug?: string;
};
export type StarsStatusSummary = {
    balance: StarsAmountSummary;
    subscriptions?: StarsSubscriptionSummary[];
    subscriptionsNextOffset?: string;
    subscriptionsMissingBalance?: string;
    history?: StarsTransactionSummary[];
    nextOffset?: string;
};
export declare function summarizeStarsAmount(amount: Api.TypeStarsAmount): StarsAmountSummary;
export declare function summarizeStarsTransactionPeer(peer: Api.TypeStarsTransactionPeer): StarsTransactionPeerSummary;
export declare function summarizeStarsTransaction(tx: Api.TypeStarsTransaction): StarsTransactionSummary;
export declare function summarizeStarsSubscription(sub: Api.TypeStarsSubscription): StarsSubscriptionSummary;
export type QuickReplySummary = {
    shortcutId: number;
    shortcut: string;
    topMessage: number;
    count: number;
};
export type QuickRepliesSummary = {
    notModified?: boolean;
    quickReplies?: QuickReplySummary[];
};
export declare function summarizeQuickReply(reply: Api.TypeQuickReply): QuickReplySummary;
export declare function summarizeQuickReplies(result: Api.messages.TypeQuickReplies): QuickRepliesSummary;
export type QuickReplyMessageSummary = {
    id: number;
    date: number;
    text: string;
    isService: boolean;
    fromId?: CompactPeer;
    replyToMsgId?: number;
};
export type QuickReplyMessagesSummary = {
    notModified?: boolean;
    count?: number;
    messages?: QuickReplyMessageSummary[];
};
export declare function summarizeQuickReplyMessage(msg: Api.TypeMessage): QuickReplyMessageSummary | null;
export declare function summarizeQuickReplyMessages(result: Api.messages.TypeMessages): QuickReplyMessagesSummary;
export declare function summarizeStarsStatus(result: Api.payments.TypeStarsStatus): StarsStatusSummary;
export declare function summarizeStoryItem(item: Api.TypeStoryItem): StoryItemSummary;
export declare function summarizePeerStories(ps: Api.TypePeerStories): PeerStoriesSummary | null;
export declare function summarizeStoriesById(result: Api.stories.TypeStories): StoriesByIdSummary;
export declare function summarizeStoryView(view: Api.TypeStoryView): StoryViewSummary;
export declare function summarizeStoryViewsList(result: Api.stories.TypeStoryViewsList): StoryViewsListSummary;
export type StoryPrivacy = "everyone" | "contacts" | "close_friends" | "selected";
export declare function detectMediaType(filePath: string): "photo" | "video";
export declare function buildStoryPrivacyRules(privacy: StoryPrivacy, allowUserIds?: string[], disallowUserIds?: string[]): Api.TypeInputPrivacyRule[];
export declare function extractStoryIdFromUpdates(result: Api.TypeUpdates | undefined): number;
export type DiscussionMessageSummary = {
    discussionGroupId: string;
    discussionMsgId: number;
    unreadCount: number;
    readInboxMaxId?: number;
    readOutboxMaxId?: number;
    topMessage?: {
        id: number;
        text?: string;
        date: number;
    };
};
export declare function summarizeDiscussionMessage(result: Api.messages.DiscussionMessage): DiscussionMessageSummary;
export type GroupsForDiscussionSummary = {
    groups: Array<{
        id: string;
        title: string;
        username?: string;
        participantsCount?: number;
    }>;
};
export declare function summarizeGroupsForDiscussion(result: Api.messages.TypeChats): GroupsForDiscussionSummary;
export type ReadParticipantsSummary = {
    messageId: number;
    readers: Array<{
        userId: string;
        readAt: string;
    }>;
    count: number;
};
export declare function summarizeReadParticipants(list: Api.TypeReadParticipantDate[], messageId: number): ReadParticipantsSummary;
export type ReportResultSummary = {
    kind: "reported";
} | {
    kind: "chooseOption";
    title?: string;
    options: Array<{
        text: string;
        option: string;
    }>;
} | {
    kind: "addComment";
    optional?: boolean;
};
export declare function summarizeReportResult(result: Api.TypeReportResult): ReportResultSummary;
export type PollSummary = {
    question: string;
    isClosed: boolean;
    isQuiz: boolean;
    isMulti: boolean;
    totalVoters: number;
    options: Array<{
        index: number;
        text: string;
        votes: number;
        percent: number;
        chosen: boolean;
        correct?: boolean;
    }>;
};
export declare function summarizePoll(poll: Api.Poll, results?: Api.PollResults): PollSummary;
export declare function extractPollMediaFromUpdates(updates: Api.TypeUpdates): {
    poll: Api.Poll;
    results?: Api.PollResults;
} | null;
export declare function extractPeerId(peer: Api.TypePeer): string;
export type EmojiStatusSummary = {
    kind: "default" | "collectible" | "empty";
    documentId?: string;
    collectibleId?: string;
    until?: number;
    title?: string;
    slug?: string;
};
export declare function summarizeEmojiStatus(s: Api.TypeEmojiStatus): EmojiStatusSummary;
export type PeerSummary = {
    id: string;
    type: "user" | "chat" | "channel";
};
export declare function summarizePeer(peer: Api.TypePeer): PeerSummary;
export type ResolvedBusinessChatLinkSummary = {
    peer: PeerSummary;
    message: string;
    entityCount: number;
};
export declare function summarizeAllStories(result: Api.stories.TypeAllStories): AllStoriesSummary;
