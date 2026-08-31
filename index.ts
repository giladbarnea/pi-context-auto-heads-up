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
			"Automatic heads up: you just crossed 50% context window usage. If most of the expected work is still ahead of you: tell that to your human or your leader: “I have 50% context window left but less than half of the work has been completed (estimation.) Proceeding as usual.” Consider delegating high-noise read-only tasks to sub-agents/teams. You still have lots of headroom left.",
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

function getContextPercent(ctx: ExtensionContext): number | null {
	return ctx.getContextUsage()?.percent ?? null;
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
		if (pendingThreshold === null) return;

		const message = CONTEXT_AUTO_HEADS_UP_MESSAGE_BY_CONTEXT_PERCENT[pendingThreshold];
		ctx.ui.notify(`Gave the agent a ${pendingThreshold}% context heads-up.`);
		pendingThreshold = null;
		return { message };
	});

	pi.on("turn_end", (_event, ctx) => {
		observeContextUsage(ctx);
	});

	pi.on("context", (event, ctx) => {
		if (pendingThreshold === null) return;

		// Pi runs auto-compaction before context handlers, so this check cannot send a stale percentage.
		const currentContextPercent = getContextPercent(ctx);
		if (currentContextPercent === null || currentContextPercent < pendingThreshold) {
			pendingThreshold = null;
			return;
		}

		const message = CONTEXT_AUTO_HEADS_UP_MESSAGE_BY_CONTEXT_PERCENT[pendingThreshold];
		ctx.ui.notify(`Gave the agent a ${pendingThreshold}% context heads-up.`);
		pendingThreshold = null;
		return {
			messages: [
				...event.messages,
				{
					role: "custom",
					...message,
					timestamp: Date.now(),
				},
			],
		};
	});
}
