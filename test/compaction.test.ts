import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const extensionDirectory = resolve(import.meta.dir, "..");
const piBinary = process.env.PI_BINARY ?? join(extensionDirectory, "node_modules", ".bin", "pi");
const CONTEXT_WINDOW = 100_000;
/** A fixed share of every request, like a large system prompt, so post-compaction usage is a distinctive number rather than about 0%. */
const FIXED_TOKENS = 20_000;
const NOTICE = /Your context window was just compacted and is now at (\d+)% usage\. Ignore context usage measurements from before this compaction\. You will receive context usage notifications as usual for your current context window\./g;

type Reply = { text: string } | { tool: string };
type WireRequest = { system: unknown; messages: unknown[] };
type SessionEntry = Record<string, unknown>;

/** Like Pi's faux provider, the synthetic endpoint reports input usage as request characters / 4, plus FIXED_TOKENS. */
function streamReply(reply: Reply, inputTokens: number): Response {
	const [start, delta] = "text" in reply
		? [{ type: "text", text: "" }, { type: "text_delta", text: reply.text }]
		: [{ type: "tool_use", id: `toolu_${inputTokens}`, name: reply.tool, input: {} }, { type: "input_json_delta", partial_json: "{}" }];
	const events: Array<[string, Record<string, unknown>]> = [
		["message_start", { message: { id: `msg_${inputTokens}`, type: "message", role: "assistant", model: "fixture-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } }],
		["content_block_start", { index: 0, content_block: start }],
		["content_block_delta", { index: 0, delta }],
		["content_block_stop", { index: 0 }],
		["message_delta", { delta: { stop_reason: "text" in reply ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 0 } }],
		["message_stop", {}],
	];
	return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

/** A tool whose result fills about 70% of the context window, which with FIXED_TOKENS is, past Pi's default automatic-compaction threshold. */
const LARGE_OUTPUT_TOOL = `export default function (pi) {
	pi.registerTool({ name: "large_output", label: "Large output", description: "Return a large output.", parameters: { type: "object", properties: {} },
		async execute() { return { content: [{ type: "text", text: " pad".repeat(${0.7 * CONTEXT_WINDOW}) }] }; } });
}
`;

type Invocation = { prompt: string } | { compact: true };

/**
 * Run real Pi invocations with this extension against scripted replies, sharing one session.
 * `print` runs `pi -p` per prompt; `json` runs `pi -p --mode json` per prompt; `rpc` runs one `pi --mode rpc` process for all steps, where `{ compact: true }` is a manual compaction.
 */
async function runPi(mode: "print" | "json" | "rpc", invocations: Invocation[], replies: Reply[], settings: Record<string, unknown> = {}) {
	const home = mkdtempSync(join(tmpdir(), "context-heads-up-compaction-"));
	const agentDirectory = join(home, "agent");
	const workDirectory = join(home, "work");
	const toolFile = join(home, "large-output.js");
	mkdirSync(agentDirectory, { recursive: true });
	mkdirSync(workDirectory, { recursive: true });
	writeFileSync(toolFile, LARGE_OUTPUT_TOOL);
	const requests: Array<{ text: string; usagePercent: number }> = [];
	let summaries = 0;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const body = await request.json() as WireRequest;
			const inputTokens = FIXED_TOKENS + Math.ceil(JSON.stringify(body.messages).length / 4);
			if (JSON.stringify(body.system).includes("summarization")) return streamReply({ text: `SUMMARY_${++summaries}` }, inputTokens);
			requests.push({ text: JSON.stringify(body.messages), usagePercent: (inputTokens / CONTEXT_WINDOW) * 100 });
			const reply = replies[requests.length - 1];
			if (!reply) return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "unexpected extra model call" } }), { status: 500 });
			return streamReply(reply, inputTokens);
		},
	});
	writeFileSync(join(agentDirectory, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: `http://127.0.0.1:${server.port}`, api: "anthropic-messages", apiKey: "fixture-not-a-key",
		models: [{ id: "fixture-model", name: "Synthetic fixture", reasoning: false, input: ["text"], contextWindow: CONTEXT_WINDOW, maxTokens: 1000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	writeFileSync(join(agentDirectory, "settings.json"), JSON.stringify({ retry: { enabled: false }, quietStartup: true, ...settings }));
	const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1", NO_UPDATE_NOTIFIER: "1" };
	const baseArguments = [piBinary, "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
		"-e", extensionDirectory, "-e", toolFile, "--model", "fixture/fixture-model"];
	const outputs: Array<{ exitCode: number; stdout: string; stderr: string }> = [];
	try {
		if (mode === "rpc") outputs.push(await runRpc([...baseArguments, "--mode", "rpc"], invocations, workDirectory, environment));
		else for (const [index, invocation] of invocations.entries()) {
			if (!("prompt" in invocation)) throw new Error("manual compaction needs rpc mode");
			const child = Bun.spawn([...baseArguments, "-p", ...(mode === "json" ? ["--mode", "json"] : []), ...(index > 0 ? ["-c"] : []), invocation.prompt],
				{ cwd: workDirectory, env: environment, stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			outputs.push({ exitCode, stdout, stderr });
		}
		const sessionsDirectory = join(agentDirectory, "sessions");
		const sessionFile = readdirSync(sessionsDirectory, { recursive: true }).map(String).find((name) => name.endsWith(".jsonl"))!;
		const entries = readFileSync(join(sessionsDirectory, sessionFile), "utf8").trim().split("\n").map((line) => JSON.parse(line) as SessionEntry);
		return { outputs, requests, summaries, entries };
	} finally {
		server.stop(true);
		rmSync(home, { recursive: true, force: true });
	}
}

/** Drive one `pi --mode rpc` process: each prompt waits for `agent_settled`, each compaction for its response. */
async function runRpc(command: string[], invocations: Invocation[], cwd: string, env: Record<string, string>) {
	const child = Bun.spawn(command, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const stderrText = new Response(child.stderr).text();
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	let stdout = "";
	async function waitFor(predicate: (record: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
		for (;;) {
			const newline = buffered.indexOf("\n");
			if (newline >= 0) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				const record = JSON.parse(line) as Record<string, unknown>;
				if (predicate(record)) return record;
				continue;
			}
			const { value, done } = await reader.read();
			if (done) throw new Error(`pi rpc exited early: ${await stderrText}`);
			const chunk = decoder.decode(value, { stream: true });
			stdout += chunk;
			buffered += chunk;
		}
	}
	for (const [index, invocation] of invocations.entries()) {
		const id = `step-${index}`;
		child.stdin.write(JSON.stringify("prompt" in invocation ? { id, type: "prompt", message: invocation.prompt } : { id, type: "compact" }) + "\n");
		const response = await waitFor((record) => record.type === "response" && record.id === id);
		if (response.success !== true) throw new Error(`rpc ${id} failed: ${JSON.stringify(response)}`);
		if ("prompt" in invocation) await waitFor((record) => record.type === "agent_settled");
	}
	child.stdin.end();
	const exitCode = await child.exited;
	return { exitCode, stdout, stderr: await stderrText };
}

function notices(text: string): number[] {
	return [...text.matchAll(NOTICE)].map((match) => Number(match[1]));
}

function sessionNotices(entries: SessionEntry[]): number[] {
	return entries.filter((entry) => entry.type === "custom_message").flatMap((entry) => notices(String(entry.content)));
}

test("after automatic mid-run compaction, the notice carries the first post-compaction reading and reaches the next request exactly once", async () => {
	const { outputs, requests, summaries, entries } = await runPi("json", [{ prompt: "Synthetic prompt 1." }, { prompt: "Synthetic prompt 2." }],
		[{ tool: "large_output" }, { text: "AFTER_COMPACTION" }, { text: "NEXT_PROMPT" }]);
	expect(outputs.map(({ exitCode, stderr }) => ({ exitCode, stderr }))).toEqual([{ exitCode: 0, stderr: "" }, { exitCode: 0, stderr: "" }]);
	expect(summaries).toBe(1);
	expect(entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
	const [, afterCompaction, nextPrompt] = requests;
	expect(afterCompaction!.text).toContain("SUMMARY_1");
	expect(afterCompaction!.usagePercent).toBeLessThan(50);

	expect(sessionNotices(entries)).toEqual([Math.round(afterCompaction!.usagePercent)]);
	expect(notices(nextPrompt!.text)).toEqual([Math.round(afterCompaction!.usagePercent)]);
});

function sessionHeadsUps(entries: SessionEntry[]): string[] {
	return entries.filter((entry) => entry.type === "custom_message" && entry.customType === "context-auto-heads-up").map((entry) => /crossed (\d+)%/.exec(String(entry.content))![1]!);
}

const PADDING = " synthetic padding".repeat(9_000);
/** Enough for compaction to keep this prompt and summarize the padded one before it. */
const KEPT_PADDING = " kept padding".repeat(400);

test("after manual /compact, the notice carries the first post-compaction reading exactly once, and threshold warnings rearm for the new context", async () => {
	const { outputs, requests, summaries, entries } = await runPi("rpc",
		[{ prompt: `Padded prompt 1.${PADDING}` }, { prompt: `Prompt 2.${KEPT_PADDING}` }, { compact: true }, { prompt: "Prompt 3." }, { prompt: `Padded prompt 4.${PADDING}` }, { prompt: "Prompt 5." }],
		["ANSWER_1", "ANSWER_2", "ANSWER_3", "ANSWER_4", "ANSWER_5"].map((text) => ({ text })),
		{ compaction: { enabled: false, keepRecentTokens: 1000 } });
	expect(outputs.map(({ exitCode, stderr }) => ({ exitCode, stderr }))).toEqual([{ exitCode: 0, stderr: "" }]);
	expect(summaries).toBe(1);
	expect(entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
	const [, beforeCompaction, afterCompaction, recrossing] = requests.map(({ usagePercent }) => usagePercent);
	expect({ beforeCompaction: beforeCompaction! >= 50, afterCompaction: afterCompaction! < 50, recrossing: recrossing! >= 50 && recrossing! < 75 })
		.toEqual({ beforeCompaction: true, afterCompaction: true, recrossing: true });
	expect(requests[2]!.text).toContain("SUMMARY_1");

	expect(sessionNotices(entries)).toEqual([Math.round(afterCompaction!)]);
	for (const request of requests.slice(3)) expect(notices(request.text)).toEqual([Math.round(afterCompaction!)]);
	expect(sessionHeadsUps(entries)).toEqual(["50", "50"]);
});

test("in print mode, after a crossing answer triggers compaction, the stale crossing is dropped and the notice arrives exactly once with a post-compaction reading", async () => {
	const { outputs, requests, summaries, entries } = await runPi("print",
		[{ prompt: `Padded prompt 1.${PADDING}` }, { prompt: `Crossing prompt 2.${" synthetic padding".repeat(5_000)}` }, { prompt: "Prompt 3." }, { prompt: "Prompt 4." }],
		["ANSWER_1", "CROSSING_ANSWER", "AFTER_COMPACTION", "ANSWER_4"].map((text) => ({ text })),
		{ compaction: { enabled: true, reserveTokens: 20_000, keepRecentTokens: 1000 } });
	expect(outputs).toEqual(["ANSWER_1", "CROSSING_ANSWER", "AFTER_COMPACTION", "ANSWER_4"].map((answer) => ({ exitCode: 0, stdout: `${answer}\n`, stderr: "" })));
	expect(summaries).toBe(1);
	const [, crossing, afterCompaction, nextPrompt] = requests;
	expect(crossing!.usagePercent >= 75 && crossing!.usagePercent < 90).toBe(true);
	expect(afterCompaction!.text).toContain("SUMMARY_1");
	expect(afterCompaction!.usagePercent).toBeLessThan(50);
	expect(afterCompaction!.text).not.toContain("crossed 75%");
	expect(nextPrompt!.text).not.toContain("crossed 75%");
	expect(entries.filter((entry) => entry.type === "custom" && entry.customType === "context-auto-heads-up-crossing").map((entry) => entry.data)).toEqual([{ threshold: 50 }, { threshold: 75 }]);

	// The first post-compaction reading comes with the final answer, which must stay last, so the next prompt carries the notice.
	expect(notices(afterCompaction!.text)).toEqual([]);
	const [notice] = notices(nextPrompt!.text);
	expect(notices(nextPrompt!.text)).toHaveLength(1);
	expect(notice).toBeGreaterThanOrEqual(Math.round(afterCompaction!.usagePercent));
	expect(notice).toBeLessThanOrEqual(Math.round(nextPrompt!.usagePercent));
	expect(sessionNotices(entries)).toEqual([notice!]);
});
