import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const extensionDirectory = resolve(import.meta.dir, "..");
const piBinary = process.env.PI_BINARY ?? join(extensionDirectory, "node_modules", ".bin", "pi");
const CONTEXT_WINDOW = 10_000;

type Reply = { text: string } | { tool: string; input: Record<string, unknown> };

/** Like Pi's faux provider, the synthetic endpoint reports input usage as request characters / 4. */
function streamReply(reply: Reply, inputTokens: number): Response {
	const [start, delta] = "text" in reply
		? [{ type: "text", text: "" }, { type: "text_delta", text: reply.text }]
		: [{ type: "tool_use", id: `toolu_${inputTokens}`, name: reply.tool, input: {} }, { type: "input_json_delta", partial_json: JSON.stringify(reply.input) }];
	const events: Array<[string, Record<string, unknown>]> = [
		["message_start", { message: { id: `msg_${inputTokens}`, type: "message", role: "assistant", model: "fixture-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } } }],
		["content_block_start", { index: 0, content_block: start }],
		["content_block_delta", { index: 0, delta }],
		["content_block_stop", { index: 0 }],
		["message_delta", { delta: { stop_reason: "text" in reply ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }],
		["message_stop", {}],
	];
	return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

/** A stand-in for a context-editing extension: its tool removes the first prompt from context through a context_edit entry. */
const CONTEXT_EDITOR = `export default function (pi) {
	let dropRequested = false;
	pi.registerTool({ name: "drop_first_prompt", label: "Drop first prompt", description: "Remove the first prompt from context.", parameters: { type: "object", properties: {} },
		async execute() { dropRequested = true; return { content: [{ type: "text", text: "dropped" }] }; } });
	pi.on("turn_end", (event, ctx) => {
		if (!dropRequested) return;
		dropRequested = false;
		const target = ctx.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
		return { entries: [...event.entries, { type: "context_edit", targetId: target.id, replacement: null }] };
	});
}
`;

/** Run one real `pi --mode json` prompt with this extension and the context editor against scripted replies. */
async function runPrompt(prompt: string, replies: Reply[]) {
	const home = mkdtempSync(join(tmpdir(), "context-heads-up-edit-"));
	const agentDirectory = join(home, "agent");
	const workDirectory = join(home, "work");
	const editorFile = join(home, "context-editor.js");
	mkdirSync(agentDirectory, { recursive: true });
	mkdirSync(workDirectory, { recursive: true });
	writeFileSync(editorFile, CONTEXT_EDITOR);
	const usagePercents: number[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const body = await request.json() as { messages: unknown[] };
			const inputTokens = Math.ceil(JSON.stringify(body.messages).length / 4);
			usagePercents.push(Math.round((inputTokens / CONTEXT_WINDOW) * 100));
			const reply = replies[usagePercents.length - 1];
			if (!reply) return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "unexpected extra model call" } }), { status: 500 });
			return streamReply(reply, inputTokens);
		},
	});
	writeFileSync(join(agentDirectory, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: `http://127.0.0.1:${server.port}`, api: "anthropic-messages", apiKey: "fixture-not-a-key",
		models: [{ id: "fixture-model", name: "Synthetic fixture", reasoning: false, input: ["text"], contextWindow: CONTEXT_WINDOW, maxTokens: 1000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	writeFileSync(join(agentDirectory, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, quietStartup: true }));
	const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1", NO_UPDATE_NOTIFIER: "1" };
	try {
		const child = Bun.spawn([piBinary, "-p", "--mode", "json", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
			"-e", extensionDirectory, "-e", editorFile, "--model", "fixture/fixture-model", prompt], { cwd: workDirectory, env: environment, stdout: "pipe", stderr: "pipe" });
		const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
		const sessionsDirectory = join(agentDirectory, "sessions");
		const sessionFile = readdirSync(sessionsDirectory, { recursive: true }).map(String).find((name) => name.endsWith(".jsonl"))!;
		const entries = readFileSync(join(sessionsDirectory, sessionFile), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		const headsUps = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "context-auto-heads-up").map((entry) => /crossed (\d+)%/.exec(String(entry.content))![1]);
		return { exitCode, stderr, usagePercents, headsUps };
	} finally {
		server.stop(true);
		rmSync(home, { recursive: true, force: true });
	}
}

test("a context edit that lowers usage below a crossed threshold rearms it, even when the next turn's tool result crosses again", async () => {
	const result = await runPrompt(`BIG_PROMPT${" pad".repeat(5_500)}`, [
		{ tool: "drop_first_prompt", input: {} },
		{ tool: "bash", input: { command: "printf ' pad%.0s' $(seq 5500)" } },
		{ text: "DONE" },
	]);
	expect(result).toMatchObject({ exitCode: 0, stderr: "" });
	const [beforeEdit, afterEdit, afterToolResult] = result.usagePercents.map((percent) => percent >= 50 && percent < 75);
	expect({ beforeEdit, afterEdit, afterToolResult }).toEqual({ beforeEdit: true, afterEdit: false, afterToolResult: true });
	expect(result.usagePercents[1]!).toBeLessThan(50);
	expect(result.headsUps).toEqual(["50", "50"]);
});
