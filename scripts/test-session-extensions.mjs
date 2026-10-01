#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import dirtyRepoGuard from "../extensions/dirty-repo-guard/index.ts";
import handoffExtension, { handoffSessionName } from "../extensions/handoff/index.ts";
import { titleTarget } from "../extensions/titlebar-spinner/index.ts";

assert.equal(handoffSessionName("  继续实现下一阶段\n并运行测试  "), "继续实现下一阶段 并运行测试");
const longHandoffName = handoffSessionName("a".repeat(80));
assert.equal([...longHandoffName].length, 60);
assert.equal(longHandoffName.endsWith("…"), true);

const handoffCommands = new Map();
handoffExtension({
	registerCommand(name, command) { handoffCommands.set(name, command); },
});
const handoffNotifications = [];
let handoffSessionNameWritten;
let handoffEditorText;
let newSessionCalls = 0;
const handoffSession = SessionManager.inMemory(process.cwd());
handoffSession.appendMessage({ role: "user", content: "Existing context", timestamp: Date.now() });
const handoffCtx = {
	mode: "tui",
	model: { provider: "test", id: "test-model" },
	sessionManager: {
		buildSessionProjection: () => handoffSession.buildSessionProjection(),
		getSessionFile: () => "parent-session.jsonl",
	},
	ui: {
		custom: async () => "## Context\nGenerated handoff",
		editor: async (title, draft) => {
			assert.equal(title, "Review handoff prompt");
			assert.match(draft, /Generated handoff/);
			return `${draft}\n\n## Task\nEdited task`;
		},
		notify(message, level) { handoffNotifications.push({ message, level }); },
	},
	async newSession(options) {
		newSessionCalls += 1;
		assert.equal(options.parentSession, "parent-session.jsonl");
		await options.setup({ appendSessionInfo(name) { handoffSessionNameWritten = name; } });
		await options.withSession({
			ui: {
				setEditorText(text) { handoffEditorText = text; },
				notify(message, level) { handoffNotifications.push({ message, level }); },
			},
		});
		return { cancelled: false };
	},
};
await handoffCommands.get("handoff").handler("  Continue release validation  ", handoffCtx);
assert.equal(newSessionCalls, 1);
assert.equal(handoffSessionNameWritten, "Continue release validation");
assert.match(handoffEditorText, /Edited task/);
assert.ok(handoffNotifications.some(({ message }) => message.startsWith("Handoff ready")));

handoffCtx.ui.editor = async () => undefined;
await handoffCommands.get("handoff").handler("cancelled handoff", handoffCtx);
assert.equal(newSessionCalls, 1, "Cancelling the handoff editor must not create a session");
assert.ok(handoffNotifications.some(({ message }) => message === "Handoff cancelled"));

// Exercise the actual generation callback and official loader, not just a canned UI result.
initTheme("dark", false);
function generationHarness(complete, { cancel = false, switchCancelled = false, sessionManager = handoffCtx.sessionManager } = {}) {
	const state = { requests: [], notifications: [], doneCalls: 0, editorCalls: 0, sessionCalls: 0 };
	const ctx = {
		...handoffCtx,
		sessionManager,
		// No API key or getApiKeyAndHeaders: authentication belongs to ModelRegistry.
		modelRegistry: {
			async complete(model, context, options) {
				state.requests.push({ model, context, options });
				return complete(model, context, options);
			},
		},
		ui: {
			async custom(factory) {
				let component;
				try {
					return await new Promise((resolve) => {
						component = factory(
							{ requestRender() {} },
							{ fg: (_color, text) => text },
							{},
							(value) => { state.doneCalls += 1; resolve(value); },
						);
						if (cancel) queueMicrotask(() => component.handleInput("\x1b"));
					});
				} finally {
					component?.dispose();
				}
			},
			editor: async (_title, draft) => { state.editorCalls += 1; state.draft = draft; return draft; },
			notify(message, level) { state.notifications.push({ message, level }); },
		},
		async newSession(options) {
			state.sessionCalls += 1;
			if (switchCancelled) return { cancelled: true };
			await options.setup({ appendSessionInfo() {} });
			await options.withSession({ ui: { setEditorText() {}, notify() {} } });
			return { cancelled: false };
		},
	};
	return { state, run: () => handoffCommands.get("handoff").handler("Next goal", ctx) };
}

const successResponse = {
	stopReason: "stop",
	content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "  Generated prompt  " }],
};
const success = generationHarness(async () => successResponse);
await success.run();
assert.equal(success.state.draft, "Generated prompt");
assert.equal(success.state.sessionCalls, 1);
assert.equal(success.state.doneCalls, 1);
const request = success.state.requests[0];
assert.equal(request.model, handoffCtx.model);
assert.match(request.context.systemPrompt, /transfer a coding session/);
assert.match(request.context.messages[0].content[0].text, /Existing context/);
assert.match(request.context.messages[0].content[0].text, /Next goal/);
assert.equal(request.options.cacheRetention, "none");
assert.ok(request.options.signal instanceof AbortSignal);
assert.equal(request.options.signal.aborted, false);
assert.equal(typeof request.options.sessionId, "string");
assert.equal("apiKey" in request.options, false);
await success.run();
assert.notEqual(success.state.requests[1].options.sessionId, request.options.sessionId);

// Use real, in-memory session trees and inspect the text sent to the model.
const appendUser = (manager, content) => manager.appendMessage({ role: "user", content, timestamp: Date.now() });
async function handoffTranscript(sessionManager) {
	const harness = generationHarness(async () => successResponse, { sessionManager });
	await harness.run();
	assert.equal(harness.state.requests.length, 1);
	return harness.state.requests[0].context.messages[0].content[0].text;
}
const projected = SessionManager.inMemory(process.cwd());
const omittedId = appendUser(projected, "OMITTED_RAW_CONTENT");
const replacedId = appendUser(projected, "REPLACED_RAW_CONTENT");
const assistantId = projected.appendMessage({
	role: "assistant", content: [{ type: "text", text: "OLD_ASSISTANT_CONTENT" }], timestamp: Date.now(),
});
const toolId = projected.appendMessage({
	role: "toolResult", toolName: "read", toolCallId: "fixture", isError: false,
	content: [{ type: "text", text: "OLD_TOOL_CONTENT" }], timestamp: Date.now(),
});
const beforeEdits = projected.getLeafId();
projected.appendContextEdit(omittedId, null);
projected.appendContextEdit(replacedId, { content: "Intermediate replacement" });
projected.appendContextEdit(replacedId, { content: "Latest replacement" });
projected.appendContextEdit(assistantId, { content: "Projected assistant" });
projected.appendContextEdit(toolId, { content: "Projected tool result" });
const editedLeaf = projected.getLeafId();
const rawEntries = JSON.stringify(projected.getEntries());
let transcript = await handoffTranscript(projected);
assert.doesNotMatch(transcript, /OMITTED_RAW_CONTENT|REPLACED_RAW_CONTENT|OLD_ASSISTANT_CONTENT|OLD_TOOL_CONTENT|Intermediate replacement/);
assert.match(transcript, /Latest replacement/);
assert.match(transcript, /\[Assistant\]: Projected assistant/);
assert.match(transcript, /\[Tool result\]: Projected tool result/);
assert.equal(JSON.stringify(projected.getEntries()), rawEntries, "Handoff must not mutate raw history");

projected.branch(beforeEdits);
appendUser(projected, "SIBLING_BRANCH_ONLY");
transcript = await handoffTranscript(projected);
assert.match(transcript, /OMITTED_RAW_CONTENT/);
assert.match(transcript, /REPLACED_RAW_CONTENT/);
assert.doesNotMatch(transcript, /Latest replacement/, "Context edits must remain branch-relative");
projected.branch(editedLeaf);
transcript = await handoffTranscript(projected);
assert.doesNotMatch(transcript, /SIBLING_BRANCH_ONLY|OMITTED_RAW_CONTENT/);

const compacted = SessionManager.inMemory(process.cwd());
appendUser(compacted, "SUMMARIZED_OLD_CONTENT");
const keptId = appendUser(compacted, "KEPT_RAW_CONTENT");
compacted.appendCompaction("Relevant compacted summary", keptId, 1000);
compacted.appendContextEdit(keptId, { content: "Kept projected content" });
appendUser(compacted, "Recent task");
transcript = await handoffTranscript(compacted);
assert.match(transcript, /Relevant compacted summary/);
assert.match(transcript, /Kept projected content/);
assert.match(transcript, /Recent task/);
assert.doesNotMatch(transcript, /SUMMARIZED_OLD_CONTENT|KEPT_RAW_CONTENT/);
compacted.appendCompaction("Retain-none summary", null, 2000);
transcript = await handoffTranscript(compacted);
assert.match(transcript, /Retain-none summary/);
assert.doesNotMatch(transcript, /Relevant compacted summary|Kept projected content|Recent task/);

const branchSummarySession = SessionManager.inMemory(process.cwd());
const rootId = appendUser(branchSummarySession, "Shared task");
appendUser(branchSummarySession, "ABANDONED_RAW_CONTENT");
branchSummarySession.branchWithSummary(rootId, "Useful branch summary");
const customId = branchSummarySession.appendCustomMessageEntry("fixture", "OLD_CUSTOM_CONTENT", false);
branchSummarySession.appendContextEdit(customId, { content: "Projected custom context" });
transcript = await handoffTranscript(branchSummarySession);
assert.match(transcript, /Useful branch summary/);
assert.match(transcript, /Projected custom context/);
assert.doesNotMatch(transcript, /ABANDONED_RAW_CONTENT|OLD_CUSTOM_CONTENT/);

const emptySession = SessionManager.inMemory(process.cwd());
emptySession.appendMessage({ role: "system", content: "System-only prompt", timestamp: Date.now() });
const removedId = appendUser(emptySession, "REMOVED_ALL_CONVERSATION");
emptySession.appendContextEdit(removedId, null);
const emptyHandoff = generationHarness(async () => { throw new Error("Must not call a model"); }, { sessionManager: emptySession });
await emptyHandoff.run();
assert.equal(emptyHandoff.state.requests.length, 0);
assert.equal(emptyHandoff.state.editorCalls, 0);
assert.equal(emptyHandoff.state.sessionCalls, 0);
assert.ok(emptyHandoff.state.notifications.some(({ message }) => message === "No conversation to hand off"));

for (const [response, expected] of [
	[{ stopReason: "error", errorMessage: "Provider unavailable", content: [] }, /Provider unavailable/],
	[{ stopReason: "error", content: [{ type: "text", text: "Partial output" }] }, /Model generation failed/],
	[{ stopReason: "stop", content: [{ type: "text", text: "  " }] }, /empty handoff prompt/],
]) {
	const failed = generationHarness(async () => response);
	await failed.run();
	assert.equal(failed.state.editorCalls, 0);
	assert.equal(failed.state.sessionCalls, 0);
	assert.ok(failed.state.notifications.some(({ message, level }) => level === "error" && expected.test(message)));
}
const rejected = generationHarness(async () => { throw new Error("Authentication failed"); });
await rejected.run();
assert.equal(rejected.state.sessionCalls, 0);
assert.ok(rejected.state.notifications.some(({ message }) => /Authentication failed/.test(message)));

const aborted = generationHarness(async () => ({ stopReason: "aborted", content: [] }));
await aborted.run();
assert.equal(aborted.state.editorCalls, 0);
assert.ok(aborted.state.notifications.some(({ message, level }) => message === "Handoff cancelled" && level === "info"));

const cancelledGeneration = generationHarness((_model, _context, { signal }) => new Promise((_resolve, reject) => {
	signal.addEventListener("abort", () => reject(new Error("Request aborted")), { once: true });
}), { cancel: true });
await cancelledGeneration.run();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(cancelledGeneration.state.requests[0].options.signal.aborted, true);
assert.equal(cancelledGeneration.state.doneCalls, 1, "Abort and request rejection must not complete the UI twice");
assert.equal(cancelledGeneration.state.sessionCalls, 0);
assert.equal(cancelledGeneration.state.editorCalls, 0);
assert.ok(cancelledGeneration.state.notifications.every(({ level }) => level !== "error"));

let resolveLate;
const lateGeneration = generationHarness(() => new Promise((resolve) => { resolveLate = resolve; }), { cancel: true });
await lateGeneration.run();
resolveLate(successResponse);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(lateGeneration.state.doneCalls, 1, "Late completion after cancellation must be ignored");
assert.equal(lateGeneration.state.sessionCalls, 0);

const switchCancelled = generationHarness(async () => successResponse, { switchCancelled: true });
await switchCancelled.run();
assert.ok(switchCancelled.state.notifications.some(({ message }) => message === "Handoff session change cancelled"));

assert.equal(
	titleTarget({ getFlag: () => "s1d:/home/xjmao/project" }, { cwd: "C:/local" }),
	"s1d:project",
);
assert.equal(
	titleTarget({ getFlag: () => undefined }, { cwd: path.join("C:/", "work", "project") }),
	"project",
);

const sshHandlers = new Map();
let sshExecCalls = 0;
const sshPi = {
	getFlag: () => "s1d:/home/xjmao/project",
	on(name, handler) {
		const items = sshHandlers.get(name) ?? [];
		items.push(handler);
		sshHandlers.set(name, items);
	},
	exec: async () => {
		sshExecCalls += 1;
		return { code: 0, stdout: " M local-only.ts\n", stderr: "", killed: false };
	},
};
let confirmations = 0;
const ctx = {
	cwd: process.cwd(),
	hasUI: true,
	ui: {
		confirm: async () => { confirmations += 1; return false; },
		notify() {},
	},
};
dirtyRepoGuard(sshPi);
assert.equal(await sshHandlers.get("session_before_switch")[0]({ reason: "new" }, ctx), undefined);
assert.equal(sshExecCalls, 0, "SSH mode must skip Dirty Repo Guard entirely");
assert.equal(confirmations, 0);

const localHandlers = new Map();
let localResult = { code: 0, stdout: " M src/index.ts\n?? test.ts\n", stderr: "", killed: false };
const localPi = {
	getFlag: () => undefined,
	on(name, handler) {
		const items = localHandlers.get(name) ?? [];
		items.push(handler);
		localHandlers.set(name, items);
	},
	exec: async () => localResult,
};
dirtyRepoGuard(localPi);
assert.deepEqual(
	await localHandlers.get("session_before_switch")[0]({ reason: "new" }, ctx),
	{ cancel: true },
	"Dirty local repositories must still require confirmation",
);
assert.equal(confirmations, 1);
localResult = { code: 0, stdout: "", stderr: "", killed: false };
assert.equal(await localHandlers.get("session_before_fork")[0]({ position: "at" }, ctx), undefined);

localResult = { code: 128, stdout: "", stderr: "fatal: repository inspection failed", killed: false };
assert.deepEqual(
	await localHandlers.get("session_before_switch")[0]({ reason: "new" }, ctx),
	{ cancel: true },
	"Git failures inside a repository must fail closed",
);
localResult = { code: 128, stdout: "", stderr: "fatal: not a git repository", killed: false };
const nonRepoRoot = path.join(path.parse(process.cwd()).root, "pi-kit-definitely-not-a-repository");
assert.equal(
	await localHandlers.get("session_before_switch")[0]({ reason: "new" }, { ...ctx, cwd: nonRepoRoot }),
	undefined,
	"Directories with no Git marker in their ancestry should remain allowed",
);
const emptyMarkerRoot = mkdtempSync(path.join(tmpdir(), "pi-kit-empty-git-"));
try {
	mkdirSync(path.join(emptyMarkerRoot, ".git"));
	assert.equal(
		await localHandlers.get("session_before_switch")[0]({ reason: "new" }, { ...ctx, cwd: emptyMarkerRoot }),
		undefined,
		"Empty .git directories must not be treated as damaged repositories",
	);
} finally {
	rmSync(emptyMarkerRoot, { recursive: true, force: true });
}
localResult = { code: 1, stdout: "", stderr: "", killed: true };
assert.deepEqual(
	await localHandlers.get("session_before_switch")[0]({ reason: "new" }, { ...ctx, cwd: nonRepoRoot }),
	{ cancel: true },
	"Timed out or cancelled inspections must fail closed even without a visible Git marker",
);

console.log("test:session-extensions ok");
