#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import sshRemote from "../extensions/ssh-remote/index.ts";
import { RemotePathMapper } from "../extensions/ssh-remote/paths.ts";
import { SshClient } from "../extensions/ssh-remote/transport.ts";

const temp = mkdtempSync(path.join(tmpdir(), "pi-kit-cwd-"));
const originalRun = SshClient.prototype.run;
const remoteCwd = "/srv/project with spaces";
const remoteHome = "/home/fixture";
try {
	for (const localCwd of [temp, homedir()]) {
		const files = new Map();
		const commands = [];
		SshClient.prototype.run = async function(command, options = {}) {
			commands.push(command);
			let text = "";
			const quoted = [...command.matchAll(/'([^']*)'/g)].map((match) => match[1]);
			if (command.includes("remote_hostname=")) text = [remoteCwd, remoteHome, "fixture-host", "1", ""].join("\0");
			else if (command.startsWith("test -r ")) {
				if (!files.has(quoted[0])) throw new Error(`Wrong remote path: ${quoted[0]}`);
			} else if (command.startsWith("file --mime-type")) text = "text/plain";
			else if (command.startsWith("cat -- ")) text = files.get(quoted[0]) ?? "";
			else if (command.startsWith("mkdir -p -- ")) { /* Remote directory creation is simulated. */ }
			else if (command.startsWith("bash -c ") && command.includes("SSH atomic write:")) {
				const args = command.match(/ -- ('(?:[^']|'"'"')*') '(\d+)' '([a-f0-9]{64})'$/);
				assert.ok(args, "Atomic write carries a safely quoted path, byte count and digest");
				const payload = Buffer.from(options.input);
				assert.equal(payload.length, Number(args[2]));
				assert.equal(createHash("sha256").update(payload).digest("hex"), args[3]);
				files.set(args[1].slice(1, -1).replaceAll("'\"'\"'", "'"), payload.toString("utf8"));
			}
			else if (command.startsWith("cd ") && command.endsWith(" && pwd")) text = quoted[0];
			else throw new Error(`Unexpected mock SSH command: ${command}`);
			const stdout = Buffer.from(text);
			options.onData?.(stdout);
			return { exitCode: 0, stderr: Buffer.alloc(0), stdout };
		};
		const handlers = new Map();
		const tools = new Map();
		const manager = SessionManager.inMemory(localCwd);
		const pi = {
			registerFlag() {}, registerCommand() {}, getFlag: () => `fixture:${remoteCwd}`,
			on(name, handler) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
			registerTool(tool) { tools.set(tool.name, tool); },
			appendEntry(type, data) { manager.appendCustomEntry(type, data); },
			getSessionName: () => manager.getSessionName(),
			setSessionName(name) { manager.appendSessionInfo(name); },
		};
		const ctx = { cwd: localCwd, sessionManager: manager, ui: {
			theme: { fg: (_color, text) => text }, notify() {}, setStatus() {},
		} };
		sshRemote(pi);
		for (const handler of handlers.get("session_start")) await handler({}, ctx);
		const cases = [
			["notes.txt", `${remoteCwd}/notes.txt`],
			["nested/../notes.txt", `${remoteCwd}/notes.txt`],
			["../outside.txt", "/srv/outside.txt"],
			["/var/fixtures/absolute.txt", "/var/fixtures/absolute.txt"],
			["~/home.txt", `${remoteHome}/home.txt`],
			["/a/pi-kit/skills/SKILL.md", "/a/pi-kit/skills/SKILL.md"],
			["/tmp/a:b%2Fc.txt", "/tmp/a:b%2Fc.txt"],
			["/tmp/空　格.txt", "/tmp/空　格.txt"],
		];
		for (const [input, expected] of cases) {
			files.set(expected, "old content\n");
			assert.equal((await tools.get("read").execute("read", { path: input }, undefined, undefined, ctx)).content[0].text, "old content\n");
			await tools.get("write").execute("write", { path: input, content: "new content\n" }, undefined, undefined, ctx);
			assert.equal(files.get(expected), "new content\n", `Write should use remote input semantics: ${input}`);
			await tools.get("edit").execute("edit", { path: input, edits: [{ oldText: "new content", newText: "edited content" }] }, undefined, undefined, ctx);
			assert.equal(files.get(expected), "edited content\n", `Edit should use remote input semantics: ${input}`);
		}
		assert.equal((await tools.get("bash").execute("bash", { command: "pwd" }, undefined, undefined, ctx)).content[0].text, remoteCwd);
		const userBash = await handlers.get("user_bash").at(-1)({ command: "pwd", cwd: localCwd }, ctx);
		let output = "";
		await userBash.operations.exec("pwd", localCwd, { onData(data) { output += data; } });
		assert.equal(output, remoteCwd, "! commands use the remote workspace, not the launch directory or home");
		assert.equal(ctx.cwd, localCwd, "Do not mutate other extensions' local context");

		const skillPath = path.resolve("skills", "code-review", "SKILL.md");
		const prompt = { prompt: "Review", systemPromptOptions: { skills: [{ filePath: skillPath }], sections: {}, cwd: localCwd } };
		for (const handler of handlers.get("before_agent_start")) await handler(prompt, ctx);
		const beforeSkill = commands.length;
		assert.equal((await tools.get("read").execute("skill", { path: skillPath }, undefined, undefined, ctx)).content[0].text, readFileSync(skillPath, "utf8"));
		assert.equal(commands.length, beforeSkill);
		if (process.platform === "win32") {
			// Rooted POSIX paths can resolve to the same local filename on the
			// launch drive, but must stay remote (including CI's /a/... paths).
			const root = path.win32.parse(skillPath).root;
			const remoteLookalike = `/${skillPath.slice(root.length).replace(/\\/g, "/")}`;
			files.set(remoteLookalike, "REMOTE DRIVE-ROOT CONTENT");
			assert.equal((await tools.get("read").execute("remote-lookalike", { path: remoteLookalike }, undefined, undefined, ctx)).content[0].text,
				"REMOTE DRIVE-ROOT CONTENT", "A POSIX remote path must never select a local skill through Windows drive resolution");
		}
		const mapper = new RemotePathMapper(localCwd, remoteCwd, remoteHome);
		const remoteSkillPath = mapper.toRemotePath(skillPath);
		files.set(remoteSkillPath, "REMOTE SKILL CONTENT");
		assert.equal((await tools.get("read").execute("remote-skill", { path: remoteSkillPath }, undefined, undefined, ctx)).content[0].text,
			"REMOTE SKILL CONTENT", "Encoding a remote-home path must not accidentally grant the local skill exception");
	}
} finally {
	SshClient.prototype.run = originalRun;
	rmSync(temp, { recursive: true, force: true });
}
console.log("test:ssh-cwd ok (all remote reads/writes are simulated)");
