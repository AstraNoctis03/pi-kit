#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sshRemote from "../extensions/ssh-remote/index.ts";
import { SshClient } from "../extensions/ssh-remote/transport.ts";
import presetsExtension from "../extensions/presets/index.ts";
import { DEFAULT_PRESETS, parsePresets } from "../extensions/presets/config.ts";
import { reviewCommandDecision } from "../extensions/presets/review-policy.ts";
import sensitivePaths from "../extensions/sensitive-paths/index.ts";
import safetyGuard from "../extensions/safety-guard/index.ts";
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

// Exercise Pi's real prompt renderer/diff without creating a live agent or network request.
const agentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { normalizeBuildSystemPromptOptions, buildSystemPromptSections, diffSystemPromptSections } = await import(
	pathToFileURL(path.join(path.dirname(agentEntry), "core", "system-prompt.js"))
);
function promptEvent() {
	return {
		prompt: "Inspect project",
		get systemPrompt() { throw new Error("Handlers must not read or rewrite the rendered prompt"); },
		systemPromptOptions: normalizeBuildSystemPromptOptions({
			cwd: process.cwd(),
			selectedTools: ["read", "bash", "exa_search"],
			toolSnippets: { read: "Read files", bash: "Run commands" },
			promptGuidelines: ["Preserve this user rule"],
			appendSystemPrompt: "Preserve the addendum",
			contextFiles: [{ path: "AGENTS.md", content: "Preserve project rules" }],
			sections: { another_extension: "Preserve another extension" },
		}),
	};
}

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
assert.match(safetyDialogOutput, /\[bold\]→ Yes\[\/\]/, "The default selection should have non-color emphasis");
assert.match(safetyDialogOutput, /\[muted\]↑↓ choose/, "Safety shortcuts should remain readable");
safetyDialog.handleInput("\r");
assert.deepEqual(safetyDialogResult, { allowed: true }, "The shared confirmation must default to Yes");

function createPiMock(flags = {}) {
	const handlers = new Map();
	const commands = new Map();
	const statuses = new Map();
	const entries = [];
	const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "exa_search", "powershell"];
	let activeTools = [...allTools];
	let thinkingLevel = "medium";
	let sessionName;
	return {
		handlers,
		commands,
		statuses,
		entries,
		get activeTools() { return activeTools; },
		get thinkingLevel() { return thinkingLevel; },
		api: {
			registerFlag() {},
			getFlag: (name) => flags[name],
			registerTool() {},
			getSessionName: () => sessionName,
			setSessionName(name) { sessionName = name; },
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
			sessionManager: { getBranch: () => [], getEntries: () => [] },
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
const presetPromptHandler = presetMock.handlers.get("before_agent_start")[0];
const presetEvent = promptEvent();
const baseOptions = structuredClone(presetEvent.systemPromptOptions);
assert.equal(await presetPromptHandler(presetEvent, presetMock.ctx), undefined);
assert.match(presetEvent.systemPromptOptions.sections.pi_kit_preset, /review mode/);
const reviewSections = buildSystemPromptSections(presetEvent.systemPromptOptions);
await presetPromptHandler(presetEvent, presetMock.ctx);
assert.deepEqual(buildSystemPromptSections(presetEvent.systemPromptOptions), reviewSections,
	"Repeated turns must replace a section, not append duplicate instructions");
assert.deepEqual(presetEvent.systemPromptOptions, {
	...baseOptions, sections: { ...baseOptions.sections, pi_kit_preset: DEFAULT_PRESETS.review.instructions },
});
const reviewGuard = presetMock.handlers.get("tool_call")[0];
assert.equal(await reviewGuard({ toolName: "bash", input: { command: "git diff --check" } }, { ...presetMock.ctx, hasUI: true }), undefined);
assert.equal((await reviewGuard({ toolName: "bash", input: { command: "rm file" } }, { ...presetMock.ctx, hasUI: true })).block, true);
assert.equal((await reviewGuard({ toolName: "write", input: { path: "file", content: "x" } }, { ...presetMock.ctx, hasUI: true })).block, true);
// Even if another extension re-enables PowerShell, Review must block its calls.
for (const parentToolCallId of [undefined, "codemode-parent"]) {
	const decision = await reviewGuard({
		toolName: "powershell", input: { command: "Remove-Item ./fixture -Recurse" }, parentToolCallId,
	}, { ...presetMock.ctx, hasUI: false });
	assert.equal(decision.block, true);
	assert.match(decision.reason, /PowerShell/);
}
await presetMock.commands.get("preset").handler("none", presetMock.ctx);
assert.equal(presetMock.statuses.get("preset"), "preset:review");
await presetMock.commands.get("preset").handler("normal", presetMock.ctx);
assert.deepEqual(presetMock.activeTools, ["read", "bash", "edit", "write", "grep", "find", "ls", "exa_search", "powershell"]);
assert.equal(await reviewGuard({ toolName: "powershell", input: { command: "Get-Location" } }, presetMock.ctx), undefined,
	"Normal preset leaves PowerShell policy to Safety Guard");
assert.equal(presetMock.thinkingLevel, "medium");
assert.equal(presetMock.statuses.has("preset"), false);
await presetPromptHandler(presetEvent, presetMock.ctx);
assert.deepEqual(presetEvent.systemPromptOptions, baseOptions, "Normal mode removes only the preset's own section");
const normalSections = buildSystemPromptSections(presetEvent.systemPromptOptions);
assert.equal(diffSystemPromptSections(reviewSections, normalSections).pi_kit_preset, null,
	"Pi must emit a section removal rather than keep stale Review instructions");

const safetyMock = createPiMock();
safetyGuard(safetyMock.api);
const safetyHandler = safetyMock.handlers.get("tool_call")[0];
for (const command of ["Get-Location", "Remove-Item ./fixture -Recurse", "git push"]) {
	for (const hasUI of [true, false]) {
		const decision = await safetyHandler({
			toolName: "powershell", input: { command }, parentToolCallId: "codemode-parent",
		}, { ...safetyMock.ctx, hasUI });
		assert.equal(decision.block, true, "Unsupported PowerShell must fail closed without trying a Bash parser");
		assert.match(decision.reason, /guarded bash/);
	}
}
assert.equal(await safetyHandler({ toolName: "bash", input: { command: "git status" } }, safetyMock.ctx), undefined);
assert.equal(await safetyHandler({ toolName: "read", input: { path: "README.md" } }, safetyMock.ctx), undefined);

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

// Both extension orders must preserve tools, project rules and unrelated sections.
const originalSshRun = SshClient.prototype.run;
let probeCalls = 0;
try {
	SshClient.prototype.run = async function (command) {
		probeCalls += 1;
		assert.match(command, /remote_hostname=/, "Only the startup probe should run");
		return {
			exitCode: 0, stderr: Buffer.alloc(0),
			stdout: Buffer.from(["/srv/project with spaces", "/home/fixture", "fixture-host", "1", ""].join("\0")),
		};
	};
	for (const extensions of [[presetsExtension, sshRemote], [sshRemote, presetsExtension]]) {
		const combined = createPiMock({ ssh: "fixture:/srv/project with spaces" });
		for (const extension of extensions) extension(combined.api);
		for (const handler of combined.handlers.get("session_start")) await handler({}, combined.ctx);
		await combined.commands.get("preset").handler("review", combined.ctx);
		const event = promptEvent();
		const originalOptions = structuredClone(event.systemPromptOptions);
		const emitPrompt = async () => {
			for (const handler of combined.handlers.get("before_agent_start")) {
				assert.equal(await handler(event, combined.ctx), undefined);
			}
			return buildSystemPromptSections(event.systemPromptOptions);
		};
		const sections = await emitPrompt();
		assert.equal(combined.ctx.cwd, process.cwd(), "Changing prompt cwd must not change the local extension context");
		assert.equal(sections.cwd, "<cwd>\n/srv/project with spaces\n</cwd>");
		assert.match(sections.pi_kit_ssh, /SSH target: fixture/);
		assert.match(sections.pi_kit_ssh, /exa_search still runs locally/);
		assert.match(sections.pi_kit_preset, /review mode/);
		assert.deepEqual(event.systemPromptOptions, {
			...originalOptions, cwd: "/srv/project with spaces",
			sections: {
				...originalOptions.sections,
				pi_kit_preset: DEFAULT_PRESETS.review.instructions,
				pi_kit_ssh: event.systemPromptOptions.sections.pi_kit_ssh,
			},
		});
		assert.deepEqual(await emitPrompt(), sections, "Composed prompts must be stable across repeated turns");
		await combined.commands.get("preset").handler("normal", combined.ctx);
		const normal = await emitPrompt();
		assert.equal(normal.pi_kit_preset, undefined);
		assert.equal(normal.pi_kit_ssh, sections.pi_kit_ssh);
		assert.equal(normal.cwd, sections.cwd);
		assert.deepEqual(diffSystemPromptSections(sections, normal), { pi_kit_preset: null });
	}
} finally {
	SshClient.prototype.run = originalSshRun;
}
assert.equal(probeCalls, 2, "Tests use simulated probes, not real SSH connections");

console.log("test:workflow ok");
