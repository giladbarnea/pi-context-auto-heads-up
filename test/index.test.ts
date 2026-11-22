import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import contextAutoHeadsUp from "../index.ts";

type EventHandler = (
	event: Record<string, unknown>,
	context: ExtensionContext,
) => unknown | Promise<unknown>;

type HeadsUpMessage = {
	customType: string;
	content: string;
	display: boolean;
};

type BeforeAgentStartResult = { message: HeadsUpMessage };

type BranchEntry = { type: string; customType?: string; data?: unknown; content?: string; message?: unknown };

function measuredResponse(contextPercent: number | null): BranchEntry {
	return { type: "message", message: { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: contextPercent ?? 0 } } };
}

function createHarness(initialContextPercent: number | null, branch: BranchEntry[] = [], mode = "tui") {
	let contextPercent = initialContextPercent;
	let pendingMessages = false;
	const handlers = new Map<string, EventHandler[]>();
	const notifications: string[] = [];
	const queuedMessages: Array<{ message: HeadsUpMessage; options: { triggerTurn?: boolean } }> = [];
	const extensionContext = {
		getContextUsage: () => ({ tokens: contextPercent, contextWindow: 100, percent: contextPercent }),
		mode,
		hasPendingMessages: () => pendingMessages,
		// Pi measures a reading only from a response newer than every context edit and compaction; the harness's readings are such measurements.
		sessionManager: { getBranch: () => [...branch, measuredResponse(contextPercent)] },
		ui: { notify(message: string) { notifications.push(message); } },
	} as unknown as ExtensionContext;
	const pi = {
		on(eventName: string, handler: EventHandler) { handlers.set(eventName, [...handlers.get(eventName) ?? [], handler]); },
		sendMessage(message: HeadsUpMessage, options: { triggerTurn?: boolean }) {
			queuedMessages.push({ message, options });
			branch.push({ type: "custom_message", customType: message.customType, content: message.content });
		},
		appendEntry(customType: string, data: unknown) {
			branch.push({ type: "custom", customType, data });
		},
	} as unknown as ExtensionAPI;
	contextAutoHeadsUp(pi);

	return {
		branch,
		notifications,
		queuedMessages,
		setContextPercent(value: number | null) { contextPercent = value; },
		setPendingMessages(value: boolean) { pendingMessages = value; },
		async emit(eventName: string, event: Record<string, unknown> = eventName === "turn_end" ? { toolResults: [{}] } : {}) {
			const eventHandlers = handlers.get(eventName);
			if (!eventHandlers) throw new Error(`Missing ${eventName} handler`);
			const withMessage = eventName === "turn_end" ? { message: { role: "assistant", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }, ...event } : event;
			const results: Array<{ message?: HeadsUpMessage } | undefined> = [];
			for (const handler of eventHandlers) {
				const result = await handler(withMessage, extensionContext) as { message?: HeadsUpMessage } | undefined;
				// Pi persists each before_agent_start message as a custom message entry, in handler order.
				if (result?.message) branch.push({ type: "custom_message", customType: result.message.customType, content: result.message.content });
				results.push(result);
			}
			return results.find((result) => result !== undefined);
		},
	};
}

test("persists a hidden mid-run warning at crossing without requesting a continuation", async () => {
	const harness = createHarness(49);
	await harness.emit("session_start");
	harness.setContextPercent(51);
	await harness.emit("turn_end", { toolResults: [{}] });

	expect(harness.queuedMessages).toHaveLength(1);
	const queued = harness.queuedMessages[0]!;
	expect(queued.message.customType).toBe("context-auto-heads-up");
	expect(queued.message.content).toContain("crossed 50%");
	expect(queued.message.display).toBe(false);
	expect(queued.options).toEqual({ triggerTurn: false });
	expect(harness.notifications).toEqual(["Gave the agent a 50% context heads-up."]);
	expect(await harness.emit("before_agent_start")).toBeUndefined();
});

test("does not repeat above a threshold, but rearms after a real reduction", async () => {
	const harness = createHarness(49);
	await harness.emit("session_start");
	for (const percent of [51, 60, 48, 51]) {
		harness.setContextPercent(percent);
		await harness.emit("turn_end");
	}
	expect(harness.queuedMessages).toHaveLength(2);
	for (const { message } of harness.queuedMessages) expect(message.content).toContain("crossed 50%");
});

test("a jump emits only the highest newly crossed threshold", async () => {
	const harness = createHarness(49);
	await harness.emit("session_start");
	harness.setContextPercent(96);
	await harness.emit("turn_end");
	expect(harness.queuedMessages).toHaveLength(1);
	expect(harness.queuedMessages[0]?.message.content).toContain("crossed 90%");
});

test("compaction leaves a delivered warning historical and allows a later recrossing", async () => {
	const harness = createHarness(89);
	await harness.emit("session_start");
	harness.setContextPercent(96);
	await harness.emit("turn_end");
	await harness.emit("session_compact");
	harness.setContextPercent(null);
	expect(await harness.emit("before_agent_start")).toBeUndefined();
	harness.setContextPercent(35);
	await harness.emit("turn_end");
	harness.setContextPercent(51);
	await harness.emit("turn_end");

	expect(harness.queuedMessages.map(({ message }) => message.content.slice(0, 64))).toEqual([
		"Automatic heads up: you just crossed 90% context window usage. U",
		"Your context window was just compacted and is now at 35% usage. ",
		"Automatic heads-up: context usage just crossed 50%. If more than",
	]);
});

test("after compaction, the notice waits for a measured reading and is sent once, hidden, with the exact text", async () => {
	const harness = createHarness(60);
	await harness.emit("session_start");
	await harness.emit("session_compact");
	harness.setContextPercent(null);
	expect(await harness.emit("before_agent_start")).toBeUndefined();
	await harness.emit("turn_end");
	expect(harness.queuedMessages).toEqual([]);
	harness.setContextPercent(21.4);
	await harness.emit("turn_end");
	harness.setContextPercent(22);
	await harness.emit("turn_end");
	expect(await harness.emit("before_agent_start")).toBeUndefined();

	expect(harness.queuedMessages).toEqual([{
		message: {
			customType: "context-auto-heads-up-compaction-notice",
			content: "Your context window was just compacted and is now at 21% usage. Ignore context usage measurements from before this compaction. You will receive context usage notifications as usual for your current context window.",
			display: false,
		},
		options: { triggerTurn: false },
	}]);
});

test("each compaction gets its own notice", async () => {
	const harness = createHarness(60);
	await harness.emit("session_start");
	for (const percent of [30, 25]) {
		await harness.emit("session_compact");
		harness.setContextPercent(percent);
		await harness.emit("turn_end");
	}
	expect(harness.queuedMessages.map(({ message }) => /now at (\d+)%/.exec(message.content)![1])).toEqual(["30", "25"]);
});

test("in print mode, a final answer's notice waits for the next prompt, which delivers it once and drops the pre-compaction crossing", async () => {
	const harness = createHarness(70, [], "print");
	await harness.emit("session_start");
	harness.setContextPercent(80);
	await harness.emit("turn_end", { toolResults: [] });
	await harness.emit("session_compact");
	harness.setContextPercent(30);
	await harness.emit("turn_end", { toolResults: [] });
	expect(harness.queuedMessages).toEqual([]);

	harness.setContextPercent(31);
	await harness.emit("before_agent_start");
	await harness.emit("before_agent_start");
	const delivered = harness.branch.filter((entry) => entry.type === "custom_message").map((entry) => entry.content!.slice(0, 64));
	expect(delivered).toEqual(["Your context window was just compacted and is now at 31% usage. "]);
});

test("resuming a session compacted before this notice existed sends no retrospective notice", async () => {
	const harness = createHarness(30, [{ type: "compaction" }]);
	await harness.emit("session_start");
	expect(await harness.emit("before_agent_start")).toBeUndefined();
	await harness.emit("turn_end");
	expect(harness.queuedMessages).toEqual([]);
});

test("resuming above a threshold does not send a retrospective warning", async () => {
	const harness = createHarness(76);
	await harness.emit("session_start");
	expect(await harness.emit("before_agent_start")).toBeUndefined();
	await harness.emit("turn_end");
	expect(harness.queuedMessages).toEqual([]);
	expect(harness.notifications).toEqual([]);
});

test("retains persistent before-agent-start delivery when a user prompt crosses a threshold", async () => {
	const harness = createHarness(74);
	await harness.emit("session_start");
	harness.setContextPercent(76);
	const result = await harness.emit("before_agent_start") as BeforeAgentStartResult;
	expect(result.message.display).toBe(false);
	expect(result.message.content).toContain("crossed 75%");
	expect(harness.queuedMessages).toEqual([]);
	expect(await harness.emit("before_agent_start")).toBeUndefined();
});

test("outside print mode, a final answer's crossing is delivered immediately and persistently", async () => {
	for (const mode of ["tui", "rpc", "json"]) {
		const harness = createHarness(74, [], mode);
		await harness.emit("session_start");
		harness.setContextPercent(76);
		await harness.emit("turn_end", { toolResults: [] });
		expect(harness.queuedMessages).toHaveLength(1);
		expect(harness.queuedMessages[0]!.message.content).toContain("crossed 75%");
		expect(harness.queuedMessages[0]!.options).toEqual({ triggerTurn: false });
		expect(harness.notifications).toEqual(["Gave the agent a 75% context heads-up."]);
		expect(harness.branch.filter((entry) => entry.type === "custom")).toEqual([]);
	}
});

test("in print mode, a final answer's crossing is recorded durably without a context message, then delivered on the next prompt", async () => {
	const harness = createHarness(74, [], "print");
	await harness.emit("session_start");
	harness.setContextPercent(76);
	await harness.emit("turn_end", { toolResults: [] });
	expect(harness.queuedMessages).toEqual([]);
	expect(harness.notifications).toEqual([]);
	expect(harness.branch).toEqual([{ type: "custom", customType: "context-auto-heads-up-crossing", data: { threshold: 75 } }]);

	const result = await harness.emit("before_agent_start") as BeforeAgentStartResult;
	expect(result.message.content).toContain("crossed 75%");
	expect(harness.notifications).toEqual(["Gave the agent a 75% context heads-up."]);
});

test("in print mode, a final turn followed by queued messages keeps immediate in-run delivery", async () => {
	const harness = createHarness(74, [], "print");
	await harness.emit("session_start");
	harness.setContextPercent(76);
	harness.setPendingMessages(true);
	await harness.emit("turn_end", { toolResults: [] });
	expect(harness.queuedMessages).toHaveLength(1);
	expect(harness.queuedMessages[0]!.message.content).toContain("crossed 75%");
});

test("resuming delivers a recorded but undelivered crossing exactly once", async () => {
	const harness = createHarness(76, [{ type: "custom", customType: "context-auto-heads-up-crossing", data: { threshold: 75 } }]);
	await harness.emit("session_start");
	const result = await harness.emit("before_agent_start") as BeforeAgentStartResult;
	expect(result.message.content).toContain("crossed 75%");
	expect(await harness.emit("before_agent_start")).toBeUndefined();
});

test("resuming does not redeliver a recorded crossing that was already delivered", async () => {
	const harness = createHarness(40, [{ type: "custom", customType: "context-auto-heads-up-crossing", data: { threshold: 75 } }, { type: "custom_message", customType: "context-auto-heads-up" }]);
	await harness.emit("session_start");
	expect(await harness.emit("before_agent_start")).toBeUndefined();
});

test("a recorded print-mode crossing is discarded by an intervening compaction, so only the compaction notice is delivered", async () => {
	const harness = createHarness(89, [], "print");
	await harness.emit("session_start");
	harness.setContextPercent(95);
	await harness.emit("turn_end", { toolResults: [] });
	await harness.emit("session_compact");
	harness.branch.push({ type: "compaction" });
	harness.setContextPercent(30);
	const result = await harness.emit("before_agent_start") as BeforeAgentStartResult;
	expect(result.message.customType).toBe("context-auto-heads-up-compaction-notice");
	expect(harness.branch.filter((entry) => entry.type === "custom_message").map((entry) => entry.customType)).toEqual(["context-auto-heads-up-compaction-notice"]);
	expect(await harness.emit("before_agent_start")).toBeUndefined();
});

test("a recorded crossing resumed across a compaction this extension did not observe is dropped without a notice, and a new crossing still follows in the run", async () => {
	const harness = createHarness(30, [{ type: "custom", customType: "context-auto-heads-up-crossing", data: { threshold: 90 } }, { type: "compaction" }]);
	await harness.emit("session_start");
	harness.setContextPercent(51);
	await harness.emit("before_agent_start");
	await harness.emit("turn_end");
	const delivered = harness.branch.filter((entry) => entry.type === "custom_message").map((entry) => entry.content!.slice(0, 51));
	expect(delivered).toEqual(["Automatic heads-up: context usage just crossed 50%."]);
});
