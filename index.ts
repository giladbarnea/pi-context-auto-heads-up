/** Give the agent one hidden heads-up when context usage crosses 50%, 75%, or 90%, and one after every compaction. */
import { calculateContextTokens, type ExtensionAPI, type ExtensionContext, type TurnEndEvent } from "@earendil-works/pi-coding-agent";

type ContextAutoHeadsUpMessage = {
	readonly customType: "context-auto-heads-up";
	readonly content: string;
	readonly display: false;
};

const CONTEXT_AUTO_HEADS_UP_MESSAGE_BY_CONTEXT_PERCENT: Readonly<Record<number, ContextAutoHeadsUpMessage>> = {
	50: {
		customType: "context-auto-heads-up",
		content:
			"Automatic heads-up: context usage just crossed 50%. If more than half the expected work remains, tell your human or leader: “About half my context window remains, but more than half the work is still ahead.” Consider delegating high-noise read-only tasks to sub-agents/teams. You still have lots of headroom left.",
		display: false,
	},
	75: {
		customType: "context-auto-heads-up",
		content:
			"Automatic heads up: you just crossed 75% context window usage. Unless less than a quarter of the work is left, inform your human or your leader, and lower the threshold for what you delegate to dispatched sub-agents/teams: besides read-only scouting, delegate file writing and editing to context-inheriting clones of yourself.",
		display: false,
	},
	90: {
		customType: "context-auto-heads-up",
		content:
			"Automatic heads up: you just crossed 90% context window usage. Unless you have completed all work, inform your human or leader of this. If you are managing other AIs, inform them too. They need to know before your session caps out. If you are running unattended, write a handoff doc. Switch gears to hands-off, my-fingers-are-other-AIs mode. Don’t CRUD files and Bash yourself. Dispatch non context-inheriting sub-agents and teams to get you the stuff you need done. Use terse and dense communication style (you to them and them to you) for token eco.",
		display: false,
	},
};
const CONTEXT_THRESHOLDS = Object.keys(CONTEXT_AUTO_HEADS_UP_MESSAGE_BY_CONTEXT_PERCENT)
	.map(Number)
	.sort((first, second) => first - second);

const CROSSING_ENTRY_TYPE = "context-auto-heads-up-crossing";
const COMPACTION_ENTRY_TYPE = "context-auto-heads-up-compaction";
const COMPACTION_NOTICE_TYPE = "context-auto-heads-up-compaction-notice";

type CompactionNotice = {
	readonly customType: typeof COMPACTION_NOTICE_TYPE;
	readonly content: string;
	readonly display: false;
};

/** @example compactionNotice(21.4).content.startsWith("Your context window was just compacted and is now at 21% usage.") → true */
function compactionNotice(contextPercent: number): CompactionNotice {
	return {
		customType: COMPACTION_NOTICE_TYPE,
		content: `Your context window was just compacted and is now at ${Math.round(contextPercent)}% usage. Ignore context usage measurements from before this compaction. You will receive context usage notifications as usual for your current context window.`,
		display: false,
	};
}

function getContextPercent(ctx: ExtensionContext): number | null {
	return ctx.getContextUsage()?.percent ?? null;
}

/** Context usage when the turn's response was requested: after context edits committed at the previous turn end, before this turn's tool results. */
function getRequestContextPercent(message: TurnEndEvent["message"], ctx: ExtensionContext): number | null {
	const requestTokens = message.role === "assistant" ? calculateContextTokens(message.usage) : 0;
	const contextWindow = ctx.getContextUsage()?.contextWindow;
	return requestTokens > 0 && contextWindow ? (requestTokens / contextWindow) * 100 : null;
}

/** The latest crossing recorded on the branch and not yet delivered. Any later compaction, observed by this extension or not, discards it: it measured the pre-compaction context. */
function findUndeliveredCrossing(ctx: ExtensionContext): number | null {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type === "custom" && entry.customType === CROSSING_ENTRY_TYPE) return (entry.data as { threshold: number }).threshold;
		if (entry.type === "custom_message" && entry.customType === "context-auto-heads-up") return null;
		if (entry.type === "compaction" || (entry.type === "custom" && entry.customType === COMPACTION_ENTRY_TYPE)) return null;
	}
	return null;
}

/** Whether a compaction recorded on the branch still awaits its notice. */
function hasUndeliveredCompaction(ctx: ExtensionContext): boolean {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type === "custom" && entry.customType === COMPACTION_ENTRY_TYPE) return true;
		if (entry.type === "custom_message" && entry.customType === COMPACTION_NOTICE_TYPE) return false;
	}
	return false;
}

/** Pi reports usage as unknown after compaction until a post-compaction response measures it; the notice waits for that reading. */
function takeCompactionNotice(ctx: ExtensionContext): CompactionNotice | undefined {
	const contextPercent = getContextPercent(ctx);
	return contextPercent !== null && hasUndeliveredCompaction(ctx) ? compactionNotice(contextPercent) : undefined;
}

/** Print mode outputs only a trailing assistant message, so nothing may be appended after its final answer. */
function mustKeepAnswerLast(event: TurnEndEvent, ctx: ExtensionContext): boolean {
	return ctx.mode === "print" && event.toolResults.length === 0 && !ctx.hasPendingMessages();
}

export default function (pi: ExtensionAPI) {
	let previousContextPercent = 0;
	let pendingThreshold: number | null = null;

	function observeContextUsage(ctx: ExtensionContext, currentContextPercent = getContextPercent(ctx)): void {
		if (currentContextPercent === null) return;

		const crossedThresholds = CONTEXT_THRESHOLDS.filter((threshold) => previousContextPercent < threshold && currentContextPercent >= threshold);
		const crossedThreshold = crossedThresholds[crossedThresholds.length - 1];
		previousContextPercent = currentContextPercent;
		if (pendingThreshold !== null && currentContextPercent < pendingThreshold) pendingThreshold = null;
		if (crossedThreshold !== undefined) pendingThreshold = crossedThreshold;
	}

	pi.on("session_start", (_event, ctx) => {
		previousContextPercent = getContextPercent(ctx) ?? 0;
		pendingThreshold = null;
	});

	pi.on("session_compact", () => {
		pendingThreshold = null;
		pi.appendEntry(COMPACTION_ENTRY_TYPE, {});
	});

	pi.on("before_agent_start", (_event, ctx) => {
		observeContextUsage(ctx);
		const recordedThreshold = findUndeliveredCrossing(ctx);
		const threshold = recordedThreshold ?? pendingThreshold;
		if (threshold === null) return;

		const message = CONTEXT_AUTO_HEADS_UP_MESSAGE_BY_CONTEXT_PERCENT[threshold];
		ctx.ui.notify(`Gave the agent a ${threshold}% context heads-up.`);
		if (recordedThreshold === null) pendingThreshold = null;
		return { message };
	});

	// Registered after the crossing handler, so a notice delivered at the same prompt follows any earlier warning.
	pi.on("before_agent_start", (_event, ctx) => {
		const notice = takeCompactionNotice(ctx);
		return notice && { message: notice };
	});

	pi.on("turn_end", (event, ctx) => {
		observeContextUsage(ctx, getRequestContextPercent(event.message, ctx));
		observeContextUsage(ctx);
		const keepAnswerLast = mustKeepAnswerLast(event, ctx);
		const notice = keepAnswerLast ? undefined : takeCompactionNotice(ctx);
		if (notice) pi.sendMessage(notice, { triggerTurn: false });
		if (pendingThreshold === null) return;

		// Record the crossing durably instead; the next prompt delivers it, even after resume.
		if (keepAnswerLast) {
			pi.appendEntry(CROSSING_ENTRY_TYPE, { threshold: pendingThreshold });
			pendingThreshold = null;
			return;
		}

		const message = CONTEXT_AUTO_HEADS_UP_MESSAGE_BY_CONTEXT_PERCENT[pendingThreshold];
		ctx.ui.notify(`Gave the agent a ${pendingThreshold}% context heads-up.`);
		pendingThreshold = null;
		pi.sendMessage(message, { triggerTurn: false });
	});
}
