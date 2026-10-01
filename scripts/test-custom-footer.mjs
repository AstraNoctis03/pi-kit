#!/usr/bin/env node
import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import customFooter from "../extensions/custom-footer/index.ts";
import { DEFAULT_FOOTER_COLORS, mergeFooterColors, paint } from "../extensions/custom-footer/colors.ts";

process.env.PI_CODING_AGENT_DIR = path.join(process.cwd(), ".footer-test-config-does-not-exist");

const merged = mergeFooterColors({
	local: "#223344",
	path: "#112233",
	session: 110,
	model: 141,
	thinking: { high: "invalid" },
});
assert.equal(merged.local, "#223344");
assert.equal(merged.path, "#112233");
assert.equal(merged.session, 110);
assert.equal(merged.model, 141);
assert.equal(merged.thinking.high, DEFAULT_FOOTER_COLORS.thinking.high);
assert.equal(mergeFooterColors({ path: 999 }).path, DEFAULT_FOOTER_COLORS.path);

const plainTheme = { fg: (_color, text) => text };
assert.match(paint(plainTheme, "#112233", "path"), /38;2;17;34;51m/);
assert.match(paint(plainTheme, 141, "model"), /38;5;141m/);

const handlers = new Map();
let footerFactory;
const pi = {
	getThinkingLevel: () => "high",
	on(name, handler) {
		const eventHandlers = handlers.get(name) ?? [];
		eventHandlers.push(handler);
		handlers.set(name, eventHandlers);
	},
	registerCommand() {},
};
const entries = [
	{
		type: "message",
		message: {
			role: "assistant",
			usage: {
				input: 233_000,
				output: 48_000,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 8.059 },
			},
		},
	},
	{
		type: "message",
		message: {
			role: "assistant",
			usage: {
				input: 48_000,
				output: 10_000,
				cacheRead: 12_000_000,
				cacheWrite: 0,
				cost: { total: 1 },
			},
		},
	},
];
let sessionName;
let sessionId = "session-1";
let leafId = "leaf-1";
let entryReads = 0;
let contextReads = 0;
let contextUsage = { tokens: 165_540, contextWindow: 372_000, percent: 44.5 };
const ctx = {
	cwd: path.join(homedir(), "pi-kit"),
	model: { id: "gpt-5.6-sol", provider: "openai-codex", reasoning: true, contextWindow: 372_000 },
	modelRegistry: { isUsingOAuth: () => true },
	isProjectTrusted: () => false,
	getContextUsage: () => { contextReads += 1; return contextUsage; },
	sessionManager: {
		getCwd: () => path.join(homedir(), "pi-kit"),
		getSessionName: () => sessionName,
		getSessionId: () => sessionId,
		getLeafId: () => leafId,
		getEntries: () => { entryReads += 1; return entries; },
	},
	ui: {
		setFooter(factory) { footerFactory = factory; },
		notify() {},
	},
};
customFooter(pi);
await handlers.get("session_start")[0]({ reason: "startup" }, ctx);
assert.equal(typeof footerFactory, "function");

const statuses = new Map();
const footerData = {
	getGitBranch: () => "main",
	getExtensionStatuses: () => statuses,
	getAvailableProviderCount: () => 1,
	onBranchChange: () => () => {},
};
const component = footerFactory({ requestRender() {} }, plainTheme, footerData);
const stripAnsi = (value) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
let lines = component.render(80);
assert.equal(lines.length, 2);
assert.ok(lines.every((line) => visibleWidth(line) <= 80));
assert.match(stripAnsi(lines[0]), /LOCAL .*pi-kit \(main\).*gpt-5\.6-sol.*high/);
assert.match(stripAnsi(lines[1]), /↑281k ↓58k R12M CH99\.6% \$9\.059\(sub\).*ctx 44\.5%\/372k auto/);

for (let index = 0; index < 100; index += 1) component.render(80);
assert.equal(entryReads, 1, "Unchanged frames must not rescan the session");
assert.equal(contextReads, 1, "Unchanged frames must not recompute context usage");

sessionName = "release validation";
statuses.set("preset", "preset:review");
lines = component.render(80);
assert.match(stripAnsi(lines[0]), /preset:review.*release validation/);
assert.equal(lines.length, 2);

sessionName = "long session name ".repeat(8);
lines = component.render(64);
assert.match(stripAnsi(lines[0]), /preset:review/, "Workflow mode should stay visible before a long session name");
lines = component.render(16);
assert.match(stripAnsi(lines[0]), /^LOCAL/, "Narrow footers should preserve the local target indicator");
assert.ok(lines.every((line) => visibleWidth(line) <= 16));

statuses.set("ssh-remote", "SSH: s1d:/home/xjmao");
lines = component.render(80);
assert.match(stripAnsi(lines[0]), /SSH s1d:\/home\/xjmao.*gpt-5\.6-sol.*high/);
assert.doesNotMatch(stripAnsi(lines[0]), /\(main\)/);
lines = component.render(16);
assert.match(stripAnsi(lines[0]), /^SSH /, "Narrow footers should preserve the remote target indicator");

const auxiliaryUsage = (cost) => ({
	input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: { total: cost },
});
entries.push(
	{ type: "usage", kind: "cache_warm", usage: auxiliaryUsage(1) },
	{ type: "compaction", usage: auxiliaryUsage(2) },
	{ type: "branch_summary", usage: auxiliaryUsage(3) },
	{ type: "message", message: { role: "toolResult", usage: auxiliaryUsage(4) } },
	{ type: "message", message: { role: "toolResult" } },
	{ type: "compaction" },
	{ type: "custom", data: { usage: auxiliaryUsage(999) } },
);
leafId = "leaf-2";
lines = component.render(120);
assert.equal(entryReads, 2, "Appending entries must invalidate statistics");
assert.match(stripAnsi(lines[1]), /↑281k ↓58k R12M W160 CH99\.6% \$19\.059/,
	"Include auxiliary usage exactly once without changing the assistant cache hit rate");

contextUsage = { tokens: undefined, contextWindow: 372_000, percent: null };
leafId = "branch-leaf";
lines = component.render(120);
assert.equal(entryReads, 3, "Branch navigation must invalidate statistics");
assert.match(stripAnsi(lines[1]), /ctx \?\/372k/);
assert.match(stripAnsi(lines[1]), /\$19\.059/, "Totals include all branches, like the native footer");

ctx.model = { ...ctx.model, id: "other-model", contextWindow: 1_000_000 };
contextUsage = { tokens: 100_000, contextWindow: 1_000_000, percent: 10 };
lines = component.render(120);
assert.equal(entryReads, 4, "Model changes must invalidate cached context limits");
assert.match(stripAnsi(lines[1]), /ctx 10\.0%\/1\.0M/);

// The same leaf ID in another session must not reuse old totals.
entries.splice(0);
sessionId = "session-2";
lines = component.render(120);
assert.equal(entryReads, 5);
assert.match(stripAnsi(lines[1]), /↑0 ↓0 \$0\.000/);
assert.doesNotMatch(stripAnsi(lines[1]), /CH/);
// A branch can gain usage and return to the same leaf between two frames.
entries.push({ type: "usage", usage: auxiliaryUsage(1) });
await handlers.get("session_tree")[0]({}, ctx);
lines = component.render(120);
assert.equal(entryReads, 6);
assert.match(stripAnsi(lines[1]), /\$1\.000/, "Tree events must invalidate even when the leaf ID is unchanged");
component.invalidate();
component.render(120);
assert.equal(entryReads, 7, "Explicit invalidation must clear cached statistics");
component.render(40);
assert.equal(entryReads, 7, "Width-only rendering must reuse raw statistics");

component.dispose();
console.log("test:footer ok");
