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
			"Automatic heads up: you just crossed 50% context window usage. If most of the expected work is still ahead of you, tell that to your human or your leader: “I have 50% context window left but less than 50% of the work has been completed (estimation.) Proceeding as usual.” If you are running unattended, write a handoff doc, then proceed as usual. You still have lots of headroom left.",
		display: false,
	},
	90: {
		customType: "context-auto-heads-up",
		content:
			"Automatic heads up: you just crossed 90% context window usage. Unless you have completed all work, inform your human or leader of this. They will want to know before the window caps. If you are running unattended, write a handoff doc, then proceed as usual until further notice.",
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

	pi.on("turn_end", (event, ctx) => {
		observeContextUsage(ctx);
		if (pendingThreshold === null || event.toolResults.length === 0) return;

		const message = CONTEXT_AUTO_HEADS_UP_MESSAGE_BY_CONTEXT_PERCENT[pendingThreshold];
		ctx.ui.notify(`Gave the agent a ${pendingThreshold}% context heads-up.`);
		pendingThreshold = null;
		pi.sendMessage(message);
	});
}
