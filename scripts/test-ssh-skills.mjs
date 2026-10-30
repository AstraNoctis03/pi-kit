#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import sshRemote from "../extensions/ssh-remote/index.ts";
import { SshClient } from "../extensions/ssh-remote/transport.ts";

const root = mkdtempSync(path.join(tmpdir(), "pi-kit-ssh-skills-"));
const originalRun = SshClient.prototype.run;
try {
	const skillFiles = ["code-review", "debugging"].map((name) => ({
		name, filePath: path.resolve("skills", name, "SKILL.md"),
		baseDir: path.resolve("skills", name), description: name,
	}));
	const missing = path.join(root, "missing.md");
	writeFileSync(missing, "Local temporary instruction");
	const targetA = path.join(root, "target-a");
	const targetB = path.join(root, "target-b");
	mkdirSync(targetA); mkdirSync(targetB);
	writeFileSync(path.join(targetA, "SKILL.md"), "Original local skill");
	writeFileSync(path.join(targetB, "SKILL.md"), "Replaced local skill");
	const link = path.join(root, "linked-skill");
	symlinkSync(targetA, link, "junction");
	const linked = path.join(link, "SKILL.md");
	const availableSkills = [...skillFiles, { filePath: missing }, { filePath: linked }];
	const calls = [];
	SshClient.prototype.run = async function(command) {
		calls.push(command);
		if (command.includes("remote_hostname=")) return {
			exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(["/srv/project", "/home/remote", "test-host", "1", ""].join("\0")),
		};
		if (/SKILL\.md/.test(command)) throw new Error("Local skill instruction was incorrectly routed to SSH");
		return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(command.startsWith("cat --") ? "REMOTE CONTENT\n" : "") };
	};
	const handlers = new Map();
	const tools = new Map();
	const manager = SessionManager.inMemory(root);
	const pi = {
		registerFlag() {}, registerCommand() {}, getFlag: () => "test-host:/srv/project",
		on(name, handler) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
		registerTool(tool) { tools.set(tool.name, tool); },
		appendEntry(type, data) { manager.appendCustomEntry(type, data); },
		getSessionName: () => manager.getSessionName(),
		setSessionName(name) { manager.appendSessionInfo(name); },
	};
	const ctx = { cwd: root, sessionManager: manager, ui: {
		theme: { fg: (_color, text) => text }, notify() {}, setStatus() {},
	} };
	sshRemote(pi);
	for (const handler of handlers.get("session_start")) await handler({ reason: "startup" }, ctx);
	const event = { prompt: "Review the code", systemPromptOptions: { skills: availableSkills, sections: {}, cwd: root } };
	for (const handler of handlers.get("before_agent_start")) await handler(event, ctx);
	const read = tools.get("read");
	for (const skill of skillFiles) {
		const before = calls.length;
		const result = await read.execute("skill", { path: skill.filePath }, undefined, undefined, ctx);
		assert.equal(result.content[0].text, readFileSync(skill.filePath, "utf8"));
		assert.equal(calls.length, before, "Loading a registered local skill must not make SSH calls");
	}
	const limited = await read.execute("limited", { path: skillFiles[0].filePath, offset: 2, limit: 2 }, undefined, undefined, ctx);
	assert.match(limited.content[0].text, /name: code-review/);
	assert.doesNotMatch(limited.content[0].text, /# Code Review/, "Preserve native read offset/limit semantics");
	const unrelated = path.join(root, "local-notes.md");
	writeFileSync(unrelated, "LOCAL PRIVATE MARKER");
	const remoteRead = await read.execute("remote", { path: unrelated }, undefined, undefined, ctx);
	assert.equal(remoteRead.content[0].text, "REMOTE CONTENT\n", "An existing local file is not a reason to fall back from SSH");
	assert.doesNotMatch(remoteRead.content[0].text, /LOCAL PRIVATE/);
	assert.match(event.systemPromptOptions.sections.pi_kit_ssh, /exact local skill instruction entry files/);
	assert.match(event.systemPromptOptions.sections.pi_kit_ssh, /not remote bash/);

	const beforeNegativeReads = calls.length;
	unlinkSync(missing);
	await assert.rejects(() => read.execute("missing", { path: missing }, undefined, undefined, ctx), /ENOENT|unavailable/);
	const initialLinkedRead = await read.execute("linked", { path: linked }, undefined, undefined, ctx);
	assert.equal(initialLinkedRead.content[0].text, "Original local skill");
	unlinkSync(link); symlinkSync(targetB, link, "junction");
	await assert.rejects(() => read.execute("retargeted", { path: linked }, undefined, undefined, ctx), /path changed/);
	assert.equal(calls.length, beforeNegativeReads, "Missing or retargeted local instructions must fail locally, not fall through to SSH");

	const beforeEdit = readFileSync(skillFiles[0].filePath, "utf8");
	await assert.rejects(() => tools.get("edit").execute("edit", {
		path: skillFiles[0].filePath, edits: [{ oldText: "# Code Review", newText: "Changed" }],
	}, undefined, undefined, ctx), /incorrectly routed to SSH/);
	assert.equal(readFileSync(skillFiles[0].filePath, "utf8"), beforeEdit, "The local exception must not apply to edits");

	const emptyEvent = { prompt: "No skills", systemPromptOptions: { skills: [], sections: {}, cwd: root } };
	for (const handler of handlers.get("before_agent_start")) await handler(emptyEvent, ctx);
	const beforeUnregistered = calls.length;
	await assert.rejects(() => read.execute("unregistered", { path: skillFiles[0].filePath }, undefined, undefined, ctx), /incorrectly routed to SSH/);
	assert.ok(calls.length > beforeUnregistered, "A previously loaded path loses its local exception when removed from the skill list");
} finally {
	SshClient.prototype.run = originalRun;
	rmSync(root, { recursive: true, force: true });
}
console.log("test:ssh-skills ok");
