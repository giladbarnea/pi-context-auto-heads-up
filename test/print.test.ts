import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const extensionDirectory = resolve(import.meta.dir, "..");
const piBinary = process.env.PI_BINARY ?? join(extensionDirectory, "node_modules", ".bin", "pi");

type WireRequest = { system: unknown; tools: unknown; messages: unknown[] };

function textResponse(text: string, inputTokens: number): Response {
	const events: Array<[string, Record<string, unknown>]> = [
		["message_start", { message: {
			id: `msg_${text}`, type: "message", role: "assistant", model: "fixture-model", content: [],
			stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 },
		} }],
		["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { index: 0, delta: { type: "text_delta", text } }],
		["content_block_stop", { index: 0 }],
		["message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }],
		["message_stop", {}],
	];
	const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`).join("");
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** Run the real `pi -p` CLI with this extension against a synthetic Anthropic endpoint. */
async function runPrint(answers: Array<{ text: string; inputTokens: number }>) {
	const home = mkdtempSync(join(tmpdir(), "context-heads-up-print-"));
	const agentDirectory = join(home, "agent");
	const workDirectory = join(home, "work");
	mkdirSync(agentDirectory, { recursive: true });
	mkdirSync(workDirectory, { recursive: true });
	const requests: WireRequest[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const answer = answers[requests.length];
			requests.push(await request.json() as WireRequest);
			if (!answer) return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "unexpected extra model call" } }), { status: 500 });
			return textResponse(answer.text, answer.inputTokens);
		},
	});
	writeFileSync(join(agentDirectory, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: `http://127.0.0.1:${server.port}`, api: "anthropic-messages", apiKey: "fixture-not-a-key",
		models: [{ id: "fixture-model", name: "Synthetic fixture", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 8000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	writeFileSync(join(agentDirectory, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, quietStartup: true }));
	const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1", NO_UPDATE_NOTIFIER: "1" };
	const invocations: Array<{ exitCode: number; stdout: string; stderr: string }> = [];
	try {
		for (const [index] of answers.entries()) {
			const process = Bun.spawn([piBinary, "-p", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
				"-e", extensionDirectory, "--model", "fixture/fixture-model", ...(index > 0 ? ["-c"] : []), `Synthetic prompt ${index + 1}.`],
				{ cwd: workDirectory, env: environment, stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, exitCode] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
			invocations.push({ exitCode, stdout, stderr });
		}
		const sessionsDirectory = join(agentDirectory, "sessions");
		const sessionFile = readdirSync(sessionsDirectory, { recursive: true }).map(String).find((name) => name.endsWith(".jsonl"));
		const entries = readFileSync(join(sessionsDirectory, sessionFile!), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		return { invocations, requests, entries };
	} finally {
		server.stop(true);
		rmSync(home, { recursive: true, force: true });
	}
}

test("pi -p prints a final answer whose response crosses a threshold, without another model call", async () => {
	const { invocations, requests, entries } = await runPrint([{ text: "FINAL_ANSWER", inputTokens: 76_000 }]);
	expect(invocations[0]!.stderr).toBe("");
	expect(invocations[0]!.exitCode).toBe(0);
	expect(invocations[0]!.stdout).toBe("FINAL_ANSWER\n");
	expect(requests).toHaveLength(1);
	const crossings = entries.filter((entry) => entry.type === "custom" && entry.customType === "context-auto-heads-up-crossing");
	expect(crossings.map((entry) => entry.data)).toEqual([{ threshold: 75 }]);
});

test("a crossing recorded on a final answer reaches the next prompt's model call and survives process exit", async () => {
	const { invocations, requests } = await runPrint([
		{ text: "FIRST_ANSWER", inputTokens: 76_000 },
		{ text: "SECOND_ANSWER", inputTokens: 77_000 },
	]);
	expect(invocations.map(({ stdout }) => stdout)).toEqual(["FIRST_ANSWER\n", "SECOND_ANSWER\n"]);
	expect(requests).toHaveLength(2);
	expect(JSON.stringify(requests[0]!.messages)).not.toContain("crossed 75%");
	expect(JSON.stringify(requests[1]!.messages)).toContain("crossed 75%");
	expect(requests[1]!.system).toEqual(requests[0]!.system);
	expect(requests[1]!.tools).toEqual(requests[0]!.tools);
	const withoutCacheControl = (messages: unknown[]) => JSON.parse(JSON.stringify(messages, (key, value: unknown) => key === "cache_control" ? undefined : value)) as unknown[];
	expect(withoutCacheControl(requests[1]!.messages).slice(0, requests[0]!.messages.length)).toEqual(withoutCacheControl(requests[0]!.messages));
});
