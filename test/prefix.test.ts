import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import contextAutoHeadsUp from "../index.ts";

type WireBlock = { type: string; text?: string; [field: string]: unknown };
type WireRequest = {
	system: WireBlock[];
	tools: Array<{ name: string; [field: string]: unknown }>;
	messages: Array<{ role: string; content: WireBlock[] }>;
};

/** @example withoutCacheControl({ text: "hi", cache_control: {} }) → { text: "hi" } */
function withoutCacheControl(value: object): unknown {
	return JSON.parse(JSON.stringify(value, (key, field: unknown) => key === "cache_control" ? undefined : field));
}

function responseStream(requestNumber: number, toolCallCount: number): Response {
	const toolCall = requestNumber <= toolCallCount;
	const block = toolCall
		? { type: "tool_use", id: `fixture-call-${requestNumber}`, name: "fixture_step", input: {} }
		: { type: "text", text: "Fixture complete." };
	const events = [
		["message_start", { type: "message_start", message: {
			id: `fixture-response-${requestNumber}`, role: "assistant", model: "fixture-model",
			content: [], usage: { input_tokens: 760_000, output_tokens: 0 },
		} }],
		["content_block_start", { type: "content_block_start", index: 0, content_block: block }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["message_delta", { type: "message_delta", delta: { stop_reason: toolCall ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }],
		["message_stop", { type: "message_stop" }],
	];
	return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

async function runFixture(toolCallCount: number) {
	const directory = mkdtempSync(join(tmpdir(), "context-heads-up-test-"));
	const previousFetch = globalThis.fetch;
	const requests: WireRequest[] = [];
	const requestUrls: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		requestUrls.push(url);
		expect(requests.length).toBeLessThan(toolCallCount + 2);
		requests.push(JSON.parse(String(init?.body)) as WireRequest);
		return responseStream(requests.length, toolCallCount);
	}) as typeof fetch;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const modelRuntime = await ModelRuntime.create({
			authPath: join(directory, "auth.json"), modelsPath: null,
			modelsStorePath: join(directory, "models.json"),
			allowModelNetwork: false, refreshOnCreate: false,
		});
		const baseModel = modelRuntime.getModel("anthropic", "claude-opus-5-5");
		expect(baseModel).toBeDefined();
		modelRuntime.registerProvider("fixture", {
			api: "anthropic-messages", apiKey: "not-a-real-key", baseUrl: "https://fixture.invalid",
			models: [{ ...baseModel!, id: "fixture-model", name: "Synthetic fixture", baseUrl: "https://fixture.invalid", contextWindow: 1_000_000 }],
		});
		const model = modelRuntime.getModel("fixture", "fixture-model");
		expect(model).toBeDefined();
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
		const resourceLoader = new DefaultResourceLoader({
			cwd: directory, agentDir: directory, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [contextAutoHeadsUp],
			systemPromptOverride: () => "Current synthetic fixture instructions.",
			appendSystemPromptOverride: () => [],
		});
		await resourceLoader.reload();
		const sessionManager = SessionManager.inMemory(directory);
		sessionManager.appendMessage({
			role: "system", content: "Original synthetic fixture instructions.", timestamp: 1,
			toolsAdded: [{ name: "legacy_lookup", description: "Historical declaration, never executed.", parameters: { type: "object", properties: {} } }],
		});
		sessionManager.appendMessage({ role: "user", content: "Historical synthetic user turn.", timestamp: 2 });
		sessionManager.appendMessage({
			role: "assistant", api: "anthropic-messages", provider: "fixture", model: "fixture-model",
			content: [{ type: "text", text: "Historical synthetic answer." }], stopReason: "stop", timestamp: 3,
			usage: { input: 490_000, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 490_004, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		} satisfies AssistantMessage);
		({ session } = await createAgentSession({
			cwd: directory, agentDir: directory, modelRuntime, model, thinkingLevel: "off",
			resourceLoader, sessionManager, settingsManager, tools: ["fixture_step"],
			customTools: [{
				name: "fixture_step", label: "Fixture step", description: "Advance the synthetic fixture.", parameters: Type.Object({}),
				async execute() { return { content: [{ type: "text" as const, text: "Synthetic result." }], details: undefined }; },
			}],
		}));
		await session.bindExtensions({ mode: "print" });
		await session.prompt("Continue the synthetic fixture.");
		expect(new URL(requestUrls[0]!).origin).toBe("https://fixture.invalid");
		const lastAssistant = session.messages.filter(message => message.role === "assistant").at(-1);
		expect(lastAssistant?.errorMessage ?? lastAssistant?.stopReason).toBe("stop");
		return { requests, messages: session.messages };
	} finally {
		session?.dispose();
		globalThis.fetch = previousFetch;
		rmSync(directory, { recursive: true, force: true });
	}
}

test("mid-run heads-ups persist without rewriting earlier system and tool prefixes", async () => {
	const { requests, messages } = await runFixture(2);
	expect(requests).toHaveLength(3);
	for (const request of requests.slice(1)) {
		expect(request.system).toEqual(requests[0]!.system);
		expect(request.tools).toEqual(requests[0]!.tools);
		expect(withoutCacheControl(request.messages.slice(0, requests[0]!.messages.length))).toEqual(withoutCacheControl(requests[0]!.messages));
		expect(JSON.stringify(request.messages)).toContain("crossed 75%");
	}
	const reminders = messages.filter(message => message.role === "custom").filter(message => message.customType === "context-auto-heads-up");
	expect(reminders).toHaveLength(1);
	expect(reminders[0]!.display).toBe(false);
	expect(reminders[0]!.content).toContain("crossed 75%");
});

test("a heads-up after a final response persists without forcing another model call", async () => {
	const { requests, messages } = await runFixture(0);
	expect(requests).toHaveLength(1);
	const reminders = messages.filter(message => message.role === "custom").filter(message => message.customType === "context-auto-heads-up");
	expect(reminders).toHaveLength(1);
	expect(reminders[0]!.display).toBe(false);
	expect(reminders[0]!.content).toContain("crossed 75%");
});
