/** Give the agent one hidden heads-up when context usage crosses 50%, 75%, or 90%. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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

function getContextPercent(ctx: ExtensionContext): number | null {
	return ctx.getContextUsage()?.percent ?? null;
}

/** The latest crossing recorded on the branch and not yet delivered. Compaction does not settle it. */
function findUndeliveredCrossing(ctx: ExtensionContext): number | null {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type === "custom" && entry.customType === CROSSING_ENTRY_TYPE) return (entry.data as { threshold: number }).threshold;
		if (entry.type === "custom_message" && entry.customType === "context-auto-heads-up") return null;
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	let previousContextPercent = 0;
	let pendingThreshold: number | null = null;

	function observeContextUsage(ctx: ExtensionContext): void {
		const currentContextPercent = getContextPercent(ctx);
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

	pi.on("turn_end", (event, ctx) => {
		observeContextUsage(ctx);
		if (pendingThreshold === null) return;

		// Print mode outputs only a trailing assistant message, so a final answer there must stay last.
		// Record the crossing durably instead; the next prompt delivers it, even after compaction or resume.
		if (ctx.mode === "print" && event.toolResults.length === 0 && !ctx.hasPendingMessages()) {
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
