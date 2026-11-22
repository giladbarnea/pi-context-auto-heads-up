import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const extensionDirectory = resolve(import.meta.dir, "..");
const piBinary = process.env.PI_BINARY ?? join(extensionDirectory, "node_modules", ".bin", "pi");
const CONTEXT_WINDOW = 100_000;
/** The synthetic provider measures 1.3× Pi's chars/4 estimate, roughly like Claude, so an estimate reads well below the measurement. */
const MEASURED_PER_ESTIMATED = 1.3;

const piVersion = (await new Response(Bun.spawn([piBinary, "--version"], { stdout: "pipe" }).stdout).text()).trim();
if (!/^1\.5\.\d+$/.test(piVersion)) throw new Error(`these tests target Pi 1.5, got ${JSON.stringify(piVersion)} from ${piBinary}`);

type Reply = { text: string } | { tool: string } | { overloaded: true };
type SessionEntry = Record<string, unknown>;

function streamReply(reply: Reply, inputTokens: number): Response {
	if ("overloaded" in reply) return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529, headers: { "content-type": "application/json" } });
	const [start, delta] = "text" in reply
		? [{ type: "text", text: "" }, { type: "text_delta", text: reply.text }]
		: [{ type: "tool_use", id: `toolu_${inputTokens}`, name: reply.tool, input: {} }, { type: "input_json_delta", partial_json: "{}" }];
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

/** A prompt that, measured, fills about `percent` of the context window. */
function bigPrompt(percent: number): string {
	return `BIG_PROMPT${" pad".repeat(Math.round((CONTEXT_WINDOW * percent) / 100 / MEASURED_PER_ESTIMATED))}`;
}

/**
 * Run prompts through real Pi with this extension against scripted replies, sharing one session.
 * `rpc` runs all prompts in one `pi --mode rpc` process; `json` runs `pi -p --mode json` per prompt, resuming with `-c`.
 */
async function runPi(mode: "rpc" | "json", prompts: string[], replies: Reply[], options: { contextEditor?: boolean; maxRetries?: number } = {}) {
	const home = mkdtempSync(join(tmpdir(), "context-heads-up-estimate-"));
	const agentDirectory = join(home, "agent");
	const workDirectory = join(home, "work");
	const editorFile = join(home, "context-editor.js");
	mkdirSync(agentDirectory, { recursive: true });
	mkdirSync(workDirectory, { recursive: true });
	writeFileSync(editorFile, CONTEXT_EDITOR);
	const measuredPercents: number[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const body = await request.text();
			const inputTokens = Math.ceil((MEASURED_PER_ESTIMATED * body.length) / 4);
			measuredPercents.push((inputTokens / CONTEXT_WINDOW) * 100);
			const reply = replies[measuredPercents.length - 1];
			if (!reply) return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "unexpected extra model call" } }), { status: 400 });
			return streamReply(reply, inputTokens);
		},
	});
	writeFileSync(join(agentDirectory, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: `http://127.0.0.1:${server.port}`, api: "anthropic-messages", apiKey: "fixture-not-a-key",
		models: [{ id: "fixture-model", name: "Synthetic fixture", reasoning: false, input: ["text"], contextWindow: CONTEXT_WINDOW, maxTokens: 1000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	const retry = options.maxRetries ? { enabled: true, maxRetries: options.maxRetries, baseDelayMs: 10 } : { enabled: false };
	writeFileSync(join(agentDirectory, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry, quietStartup: true }));
	const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1", NO_UPDATE_NOTIFIER: "1" };
	const baseArguments = [piBinary, "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
		"-e", extensionDirectory, ...(options.contextEditor ? ["-e", editorFile] : []), "--model", "fixture/fixture-model"];
	try {
		if (mode === "rpc") await runRpc([...baseArguments, "--mode", "rpc"], prompts, workDirectory, environment);
		else for (const [index, prompt] of prompts.entries()) {
			// The prompt goes over stdin: Linux caps one argv entry at 128 KiB (MAX_ARG_STRLEN), and padded prompts exceed it.
			const child = Bun.spawn([...baseArguments, "-p", "--mode", "json", ...(index > 0 ? ["-c"] : [])], { cwd: workDirectory, env: environment, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" });
			await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		}
		const sessionsDirectory = join(agentDirectory, "sessions");
		const sessionFile = readdirSync(sessionsDirectory, { recursive: true }).map(String).find((name) => name.endsWith(".jsonl"))!;
		const entries = readFileSync(join(sessionsDirectory, sessionFile), "utf8").trim().split("\n").map((line) => JSON.parse(line) as SessionEntry);
		const headsUps = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "context-auto-heads-up").map((entry) => /crossed (\d+)%/.exec(String(entry.content))![1]);
		const contextEdits = entries.filter((entry) => entry.type === "context_edit").length;
		return { measuredPercents, headsUps, contextEdits };
	} finally {
		server.stop(true);
		rmSync(home, { recursive: true, force: true });
	}
}

/** Drive one `pi --mode rpc` process: each prompt waits for `agent_settled`. */
async function runRpc(command: string[], prompts: string[], cwd: string, env: Record<string, string>): Promise<void> {
	const child = Bun.spawn(command, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const stderrText = new Response(child.stderr).text();
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	async function waitFor(predicate: (record: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
		for (;;) {
			const newline = buffered.indexOf("\n");
			if (newline >= 0) {
				const record = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
				buffered = buffered.slice(newline + 1);
				if (predicate(record)) return record;
				continue;
			}
			const { value, done } = await reader.read();
			if (done) throw new Error(`pi rpc exited early: ${await stderrText}`);
			buffered += decoder.decode(value, { stream: true });
		}
	}
	for (const [index, prompt] of prompts.entries()) {
		const id = `prompt-${index}`;
		child.stdin.write(JSON.stringify({ id, type: "prompt", message: prompt }) + "\n");
		const response = await waitFor((record) => record.type === "response" && record.id === id);
		if (response.success !== true) throw new Error(`rpc ${id} failed: ${JSON.stringify(response)}`);
		await waitFor((record) => record.type === "agent_settled");
	}
	child.stdin.end();
	await child.exited;
}

/** A context edit, then a response that fails before any measures the edited context. Usage is measured at about 80% throughout. */
const EDIT_THEN_FAILURE = {
	prompts: ["tiny first prompt", bigPrompt(80), "third prompt"],
	replies: [{ text: "OK" }, { tool: "drop_first_prompt" }, { overloaded: true }, { text: "OK" }] satisfies Reply[],
};

/** No editing extension: a retryable error, retried once, fails again; Pi drops each failed attempt with a context edit before retrying. */
const EXHAUSTED_RETRIES = {
	prompts: ["tiny first prompt", bigPrompt(80), "third prompt", "fourth prompt"],
	replies: [{ text: "OK" }, { text: "DONE" }, { overloaded: true }, { overloaded: true }, { text: "OK" }] satisfies Reply[],
};

function expectAbove75FromBigPrompt(measuredPercents: number[], requests: number): void {
	expect(measuredPercents).toHaveLength(requests);
	expect(measuredPercents.slice(1).every((percent) => percent >= 75 && percent < 90), `measured ${JSON.stringify(measuredPercents)}`).toBe(true);
}

test("Pi's estimate after a context edit is not a measurement, so it does not rearm a crossed threshold", async () => {
	const result = await runPi("rpc", EDIT_THEN_FAILURE.prompts, EDIT_THEN_FAILURE.replies, { contextEditor: true });
	expectAbove75FromBigPrompt(result.measuredPercents, 4);
	expect(result.contextEdits).toBe(1);
	expect(result.headsUps).toEqual(["75"]);
});

test("resuming after a context edit starts from the last measured usage, so the warning is not repeated", async () => {
	const result = await runPi("json", EDIT_THEN_FAILURE.prompts, EDIT_THEN_FAILURE.replies, { contextEditor: true });
	expectAbove75FromBigPrompt(result.measuredPercents, 4);
	expect(result.contextEdits).toBe(1);
	expect(result.headsUps).toEqual(["75"]);
});

test("with no editing extension, exhausted retries do not repeat a warning", async () => {
	const result = await runPi("rpc", EXHAUSTED_RETRIES.prompts, EXHAUSTED_RETRIES.replies, { maxRetries: 1 });
	expectAbove75FromBigPrompt(result.measuredPercents, 5);
	expect(result.contextEdits).toBeGreaterThan(0);
	expect(result.headsUps).toEqual(["75"]);
});

test("with no editing extension, resuming after exhausted retries does not repeat a warning", async () => {
	const result = await runPi("json", EXHAUSTED_RETRIES.prompts, EXHAUSTED_RETRIES.replies, { maxRetries: 1 });
	expectAbove75FromBigPrompt(result.measuredPercents, 5);
	expect(result.contextEdits).toBeGreaterThan(0);
	expect(result.headsUps).toEqual(["75"]);
});
