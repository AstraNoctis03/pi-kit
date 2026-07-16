#!/usr/bin/env node
import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import customFooter from "../extensions/custom-footer/index.ts";
import { DEFAULT_FOOTER_COLORS, mergeFooterColors, paint } from "../extensions/custom-footer/colors.ts";

process.env.PI_CODING_AGENT_DIR = path.join(process.cwd(), ".footer-test-config-does-not-exist");

const merged = mergeFooterColors({ path: "#112233", model: 141, thinking: { high: "invalid" } });
assert.equal(merged.path, "#112233");
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
const ctx = {
	cwd: path.join(homedir(), "pi-kit"),
	model: { id: "gpt-5.6-sol", provider: "openai-codex", reasoning: true, contextWindow: 372_000 },
	modelRegistry: { isUsingOAuth: () => true },
	isProjectTrusted: () => false,
	getContextUsage: () => ({ tokens: 165_540, contextWindow: 372_000, percent: 44.5 }),
	sessionManager: {
		getCwd: () => path.join(homedir(), "pi-kit"),
		getSessionName: () => undefined,
		getEntries: () => entries,
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

statuses.set("preset", "preset:review");
lines = component.render(80);
assert.match(stripAnsi(lines[0]), /preset:review/);
assert.equal(lines.length, 2);

statuses.set("ssh-remote", "SSH: s1d:/home/xjmao");
lines = component.render(80);
assert.match(stripAnsi(lines[0]), /SSH s1d:\/home\/xjmao.*gpt-5\.6-sol.*high/);
assert.doesNotMatch(stripAnsi(lines[0]), /\(main\)/);

component.dispose();
console.log("test:footer ok");
