#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import presetsExtension from "../extensions/presets/index.ts";
import { DEFAULT_PRESETS, parsePresets } from "../extensions/presets/config.ts";
import { reviewCommandDecision } from "../extensions/presets/review-policy.ts";
import sensitivePaths from "../extensions/sensitive-paths/index.ts";
import { SafetyDialog } from "../extensions/safety-guard/dialog.ts";
import {
	DEFAULT_CONFIRMATION_COLORS,
	mergeConfirmationColors,
	paintConfirmationColor,
} from "../extensions/safety-guard/dialog-colors.ts";
import {
	classifySensitivePath,
	DEFAULT_SENSITIVE_PATH_RULES,
	globToRegExp,
	sensitivePathCandidates,
} from "../extensions/sensitive-paths/config.ts";

process.env.PI_CODING_AGENT_DIR = path.join(process.cwd(), ".workflow-test-config-does-not-exist");

assert.equal(DEFAULT_PRESETS.review.thinkingLevel, "high");
assert.deepEqual(parsePresets({ custom: { thinkingLevel: "low", tools: ["read", "read"] } }), {
	custom: { thinkingLevel: "low", tools: ["read"] },
});
assert.deepEqual(parsePresets({ bad: { thinkingLevel: "turbo" } }), { bad: {} });
assert.deepEqual(parsePresets({ normal: { thinkingLevel: "max" } }), {});
assert.equal(reviewCommandDecision("git status --short").allowed, true);
assert.equal(reviewCommandDecision("git diff -- src/index.ts").allowed, true);
assert.equal(reviewCommandDecision("git diff -p").allowed, true);
assert.equal(reviewCommandDecision("npm run typecheck").allowed, true);
assert.equal(reviewCommandDecision("npm --prefix pi-kit run typecheck").allowed, true);
assert.equal(reviewCommandDecision("pnpm --dir pi-kit test").allowed, true);
assert.equal(reviewCommandDecision("npm --prefix pi-kit exec rm file").allowed, false);
assert.equal(reviewCommandDecision("pytest -q").allowed, true);
assert.equal(reviewCommandDecision("npm run lint -- --fix").allowed, false);
assert.equal(reviewCommandDecision("git commit -m test").allowed, false);
assert.equal(reviewCommandDecision("find . -delete").allowed, false);
assert.equal(reviewCommandDecision("find . -fprint0 report.txt").allowed, false);
assert.equal(reviewCommandDecision("find . -fls report.txt").allowed, false);
assert.equal(reviewCommandDecision("fd pattern --exec rm {} ").allowed, false);
assert.equal(reviewCommandDecision("rg pattern --pre 'rm file'").allowed, false);
assert.equal(reviewCommandDecision("eslint . --output-file report.txt").allowed, false);
assert.equal(reviewCommandDecision("eslint . --cache").allowed, false);
assert.equal(reviewCommandDecision("git diff --ext-diff").allowed, false);
assert.equal(reviewCommandDecision("git grep --open-files-in-pager='sh -c evil' pattern").allowed, false);
assert.equal(reviewCommandDecision("git --paginate status").allowed, false);
assert.equal(reviewCommandDecision("git -p status").allowed, false);
assert.equal(reviewCommandDecision("git status && rm file").allowed, false);
assert.equal(reviewCommandDecision("echo data > file").allowed, false);

assert.ok(globToRegExp("**/.git/**").test("C:/project/.git/config"));
assert.equal(classifySensitivePath("C:/project/.git/config")?.action, "block");
assert.equal(classifySensitivePath("/srv/project/server.pem")?.action, "block");
assert.equal(classifySensitivePath("/srv/project/.env.production")?.action, "confirm");
assert.equal(classifySensitivePath("/srv/project/.env.example"), undefined);
assert.equal(classifySensitivePath("src/index.ts"), undefined);
assert.equal(classifySensitivePath(".git/config", {
	...DEFAULT_SENSITIVE_PATH_RULES,
	allow: ["**/.git/config"],
}), undefined);

const symlinkRoot = mkdtempSync(path.join(tmpdir(), "pi-kit-sensitive-"));
try {
	const gitDirectory = path.join(symlinkRoot, "protected", ".git");
	mkdirSync(gitDirectory, { recursive: true });
	writeFileSync(path.join(gitDirectory, "config"), "[core]\n");
	const link = path.join(symlinkRoot, "config-link");
	symlinkSync(gitDirectory, link, "junction");
	const linkPath = path.join(link, "config");
	assert.equal(classifySensitivePath(linkPath), undefined, "the lexical alias should not reveal the target");
	assert.equal(
		sensitivePathCandidates(linkPath, symlinkRoot)
		.map((candidate) => classifySensitivePath(candidate))
		.find((candidate) => candidate !== undefined)?.action,
		"block",
	);
} finally {
	rmSync(symlinkRoot, { recursive: true, force: true });
}

assert.deepEqual(mergeConfirmationColors({ border: "#112233", title: 214, selected: "invalid" }), {
	border: "#112233",
	title: 214,
	selected: DEFAULT_CONFIRMATION_COLORS.selected,
});
assert.match(paintConfirmationColor({ fg: (_color, text) => text }, "#112233", "border"), /38;2;17;34;51m/);
assert.match(paintConfirmationColor({ fg: (_color, text) => text }, 214, "title"), /38;5;214m/);

let safetyDialogResult;
const safetyDialog = new SafetyDialog(
	{ requestRender() {} },
	{ fg: (color, text) => `[${color}]${text}[/]`, bold: (text) => `[bold]${text}[/]` },
	"Safety confirmation",
	"Confirm the guarded operation.",
	"Command: test",
	(result) => { safetyDialogResult = result; },
);
const safetyDialogOutput = safetyDialog.render(80).join("\n");
assert.match(safetyDialogOutput, /\[bold\]→ No\[\/\]/, "The default selection should have non-color emphasis");
assert.match(safetyDialogOutput, /\[muted\]↑↓ choose/, "Safety shortcuts should remain readable");
safetyDialog.handleInput("\r");
assert.deepEqual(safetyDialogResult, { allowed: false }, "The shared confirmation must default to No");

function createPiMock() {
	const handlers = new Map();
	const commands = new Map();
	const statuses = new Map();
	const entries = [];
	const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "exa_search"];
	let activeTools = [...allTools];
	let thinkingLevel = "medium";
	return {
		handlers,
		commands,
		statuses,
		entries,
		get activeTools() { return activeTools; },
		get thinkingLevel() { return thinkingLevel; },
		api: {
			registerFlag() {},
			getFlag: () => undefined,
			registerCommand(name, command) { commands.set(name, command); },
			on(name, handler) {
				const eventHandlers = handlers.get(name) ?? [];
				eventHandlers.push(handler);
				handlers.set(name, eventHandlers);
			},
			getThinkingLevel: () => thinkingLevel,
			setThinkingLevel(level) { thinkingLevel = level; },
			getActiveTools: () => [...activeTools],
			getAllTools: () => allTools.map((name) => ({ name })),
			setActiveTools(tools) { activeTools = [...tools]; },
			setModel: async () => true,
			appendEntry(customType, data) { entries.push({ customType, data }); },
		},
		ctx: {
			cwd: process.cwd(),
			model: undefined,
			modelRegistry: { find: () => undefined },
			isProjectTrusted: () => false,
			sessionManager: { getBranch: () => [] },
			ui: {
				theme: { fg: (_color, text) => text },
				setStatus(key, value) { value === undefined ? statuses.delete(key) : statuses.set(key, value); },
				notify() {},
				select: async () => undefined,
			},
		},
	};
}

const presetMock = createPiMock();
presetsExtension(presetMock.api);
for (const handler of presetMock.handlers.get("session_start") ?? []) await handler({ reason: "startup" }, presetMock.ctx);
await presetMock.commands.get("preset").handler("review", presetMock.ctx);
assert.deepEqual(presetMock.activeTools, ["read", "bash", "grep", "find", "ls", "exa_search"]);
assert.equal(presetMock.thinkingLevel, "high");
assert.equal(presetMock.statuses.get("preset"), "preset:review");
assert.deepEqual(presetMock.entries.at(-1), { customType: "preset-state", data: { name: "review" } });
const promptResult = await presetMock.handlers.get("before_agent_start")[0]({ systemPrompt: "base" }, presetMock.ctx);
assert.match(promptResult.systemPrompt, /review mode/);
const reviewGuard = presetMock.handlers.get("tool_call")[0];
assert.equal(await reviewGuard({ toolName: "bash", input: { command: "git diff --check" } }, { ...presetMock.ctx, hasUI: true }), undefined);
assert.equal((await reviewGuard({ toolName: "bash", input: { command: "rm file" } }, { ...presetMock.ctx, hasUI: true })).block, true);
assert.equal((await reviewGuard({ toolName: "write", input: { path: "file", content: "x" } }, { ...presetMock.ctx, hasUI: true })).block, true);
await presetMock.commands.get("preset").handler("none", presetMock.ctx);
assert.equal(presetMock.statuses.get("preset"), "preset:review");
await presetMock.commands.get("preset").handler("normal", presetMock.ctx);
assert.deepEqual(presetMock.activeTools, ["read", "bash", "edit", "write", "grep", "find", "ls", "exa_search"]);
assert.equal(presetMock.thinkingLevel, "medium");
assert.equal(presetMock.statuses.has("preset"), false);

const guardMock = createPiMock();
sensitivePaths(guardMock.api);
for (const handler of guardMock.handlers.get("session_start") ?? []) await handler({ reason: "startup" }, guardMock.ctx);
const guardHandler = guardMock.handlers.get("tool_call")[0];
const blocked = await guardHandler({ toolName: "write", input: { path: ".git/config" } }, { ...guardMock.ctx, hasUI: true });
assert.equal(blocked.block, true);
let confirmations = 0;
const confirmed = await guardHandler(
	{ toolName: "edit", input: { path: ".env", edits: [] } },
	{ ...guardMock.ctx, hasUI: true, ui: { ...guardMock.ctx.ui, confirm: async () => { confirmations += 1; return true; } } },
);
assert.equal(confirmed, undefined);
assert.equal(confirmations, 1);
const nonInteractive = await guardHandler(
	{ toolName: "write", input: { path: "credentials.json" } },
	{ ...guardMock.ctx, hasUI: false },
);
assert.equal(nonInteractive.block, true);

console.log("test:workflow ok");
