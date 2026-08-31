#!/usr/bin/env node

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	createExtensionRuntime,
	loadExtensions,
} from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const runtime = createExtensionRuntime();
const queuedMessages = [];
runtime.sendMessage = (message) => queuedMessages.push(message);
const extensionResult = await loadExtensions(
	[resolve(extensionDirectory, "index.ts")],
	process.cwd(),
	undefined,
	runtime,
);

assert.equal(
	extensionResult.errors.length,
	0,
	`Context heads-up extension did not load: ${JSON.stringify(extensionResult.errors)}`,
);
assert.equal(extensionResult.extensions.length, 1, "Expected one context heads-up extension instance");

const extension = extensionResult.extensions[0];
const handler = (eventName) => {
	const registeredHandler = extension.handlers.get(eventName)?.[0];
	assert(registeredHandler, `Missing ${eventName} handler`);
	return registeredHandler;
};
const sessionStart = handler("session_start");
const sessionCompact = handler("session_compact");
const beforeAgentStart = handler("before_agent_start");
const turnEnd = handler("turn_end");
const context = handler("context");

let contextPercent = 49;
const notifications = [];
const extensionContext = {
	getContextUsage: () => ({ tokens: contextPercent, contextWindow: 100, percent: contextPercent }),
	ui: {
		notify(message) {
			notifications.push(message);
		},
	},
};

await sessionStart({ type: "session_start", reason: "startup" }, extensionContext);
contextPercent = 51;
await turnEnd({ type: "turn_end", toolResults: [{}] }, extensionContext);
assert.equal(queuedMessages.length, 0, "turn_end queued a heads-up before Pi could compact");

const baseMessages = [{ role: "user", content: "continue", timestamp: 1 }];
const injectedContext = await context({ type: "context", messages: baseMessages }, extensionContext);
assert.equal(injectedContext?.messages.length, 2, "The next model request did not get the 50% heads-up");
assert.equal(
	injectedContext.messages[1].customType,
	"context-auto-heads-up",
	"The injected context message used the wrong custom type",
);
assert.match(injectedContext.messages[1].content, /crossed 50%/, "The injected context message used the wrong threshold");
assert.equal(notifications.length, 1, "The delivered 50% heads-up did not show exactly one notification");
assert.equal(
	await context({ type: "context", messages: baseMessages }, extensionContext),
	undefined,
	"The same threshold fired twice without another crossing",
);

contextPercent = 89;
await sessionStart({ type: "session_start", reason: "reload" }, extensionContext);
contextPercent = 95;
await turnEnd({ type: "turn_end", toolResults: [{}] }, extensionContext);
await sessionCompact({ type: "session_compact", reason: "threshold" }, extensionContext);
contextPercent = 10;
assert.equal(
	await context({ type: "context", messages: baseMessages }, extensionContext),
	undefined,
	"A stale 90% heads-up survived compaction",
);
assert.equal(notifications.length, 1, "Compaction showed a notification for a stale heads-up");

contextPercent = 74;
await sessionStart({ type: "session_start", reason: "reload" }, extensionContext);
contextPercent = 76;
await turnEnd({ type: "turn_end", toolResults: [] }, extensionContext);
const nextPromptResult = await beforeAgentStart({ type: "before_agent_start" }, extensionContext);
assert.match(nextPromptResult?.message.content, /crossed 75%/, "The next prompt did not get its deferred 75% heads-up");

console.log("context-auto-heads-up regression ok");
