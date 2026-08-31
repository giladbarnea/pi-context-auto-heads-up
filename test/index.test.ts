import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import contextAutoHeadsUp from "../index.ts";

type EventHandler = (
	event: Record<string, unknown>,
	context: ExtensionContext,
) => unknown | Promise<unknown>;

type ContextResult = {
	messages: Array<Record<string, unknown>>;
};

type BeforeAgentStartResult = {
	message: {
		content: string;
	};
};

function createHarness(initialContextPercent: number) {
	let contextPercent = initialContextPercent;
	const handlers = new Map<string, EventHandler>();
	const notifications: string[] = [];
	const queuedMessages: unknown[] = [];
	const extensionContext = {
		getContextUsage: () => ({ tokens: contextPercent, contextWindow: 100, percent: contextPercent }),
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionContext;
	const pi = {
		on(eventName: string, handler: EventHandler) {
			handlers.set(eventName, handler);
		},
		sendMessage(message: unknown) {
			queuedMessages.push(message);
		},
	} as unknown as ExtensionAPI;

	contextAutoHeadsUp(pi);

	return {
		registeredEvents: [...handlers.keys()],
		notifications,
		queuedMessages,
		setContextPercent(value: number) {
			contextPercent = value;
		},
		async emit(eventName: string, event: Record<string, unknown> = {}) {
			const handler = handlers.get(eventName);
			if (!handler) throw new Error(`Missing ${eventName} handler`);
			return handler(event, extensionContext);
		},
	};
}

test("registers the required Pi lifecycle hooks", () => {
	const harness = createHarness(0);
	expect(harness.registeredEvents).toEqual([
		"session_start",
		"session_compact",
		"before_agent_start",
		"turn_end",
		"context",
	]);
});

test("injects a crossed threshold after Pi's compaction check", async () => {
	const harness = createHarness(49);
	await harness.emit("session_start", { type: "session_start", reason: "startup" });
	harness.setContextPercent(51);
	await harness.emit("turn_end", { type: "turn_end", toolResults: [{}] });

	expect(harness.queuedMessages).toEqual([]);
	const result = (await harness.emit("context", {
		type: "context",
		messages: [{ role: "user", content: "continue", timestamp: 1 }],
	})) as ContextResult;

	expect(result.messages).toHaveLength(2);
	expect(result.messages[1]?.customType).toBe("context-auto-heads-up");
	expect(result.messages[1]?.content).toBe(
		"Automatic heads-up: context usage just crossed 50%. If more than half the expected work remains, tell your human or leader: “About half my context window remains, but more than half the work is still ahead.” Consider delegating high-noise read-only tasks to sub-agents/teams. You still have lots of headroom left.",
	);
	expect(harness.notifications).toEqual(["Gave the agent a 50% context heads-up."]);
	expect(await harness.emit("context", { type: "context", messages: [] })).toBeUndefined();
});

test("drops a stale threshold after compaction", async () => {
	const harness = createHarness(89);
	await harness.emit("session_start", { type: "session_start", reason: "startup" });
	harness.setContextPercent(95);
	await harness.emit("turn_end", { type: "turn_end", toolResults: [{}] });
	await harness.emit("session_compact", { type: "session_compact", reason: "threshold" });
	harness.setContextPercent(10);

	expect(await harness.emit("context", { type: "context", messages: [] })).toBeUndefined();
	expect(harness.notifications).toEqual([]);
});

test("delivers a deferred threshold on the next user prompt", async () => {
	const harness = createHarness(74);
	await harness.emit("session_start", { type: "session_start", reason: "startup" });
	harness.setContextPercent(76);
	await harness.emit("turn_end", { type: "turn_end", toolResults: [] });

	const result = (await harness.emit("before_agent_start", {
		type: "before_agent_start",
	})) as BeforeAgentStartResult;
	expect(result.message.content).toContain("crossed 75%");
});
