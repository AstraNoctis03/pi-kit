#!/usr/bin/env node
// Runs the actual host loader/tool definitions. No model calls or real SSH connections.
// PI_KIT_TEST_AGENT_ENTRY can point at another already-installed Pi SDK entry.
import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = process.env.PI_KIT_TEST_AGENT_ENTRY
	? pathToFileURL(path.resolve(process.env.PI_KIT_TEST_AGENT_ENTRY)).href
	: import.meta.resolve("@earendil-works/pi-coding-agent");
const root = mkdtempSync(path.join(tmpdir(), "pi-kit-integration-"));
const savedEnv = { agentDir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_OFFLINE = "1";
const originalSpawn = cp.spawn;
const files = new Map();
const commands = [];
const remoteCwd = "/srv/project with spaces";
const remoteHome = "/home/fixture";
let session;

cp.spawn = function(binary, args, options) {
	if (binary !== "ssh") return originalSpawn(binary, args, options);
	const command = args.at(-1);
	commands.push(command);
	const input = [];
	const child = new EventEmitter();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.stdin = new Writable({ write(chunk, _encoding, callback) { input.push(Buffer.from(chunk)); callback(); } });
	let killed = false;
	child.kill = () => { killed = true; return true; };
	setImmediate(() => {
		let text = "";
		let error;
		try {
			const quoted = [...command.matchAll(/'([^']*)'/g)].map((match) => match[1]);
			if (killed) throw new Error("Mock SSH cancelled");
			if (command.includes("remote_hostname=")) text = [remoteCwd, remoteHome, "fixture-host", "1", ""].join("\0");
			else if (command.startsWith("test -r ")) {
				if (!files.has(quoted[0])) throw new Error(`Wrong remote path: ${quoted[0]}`);
			} else if (command.startsWith("file --mime-type")) text = "text/plain";
			else if (command.startsWith("cat -- ")) text = files.get(quoted[0]) ?? "";
			else if (command.startsWith("mkdir -p -- ")) { /* In-memory remote directory. */ }
			else if (command.startsWith("cat > ")) files.set(quoted[0], Buffer.concat(input).toString("utf8"));
			else if (command.startsWith("cd ") && command.endsWith(" && pwd")) text = quoted[0];
			else throw new Error(`Unexpected simulated SSH command: ${command}`);
		} catch (caught) { error = caught; }
		child.stdout.end(text);
		child.stderr.end(error ? String(error) : "");
		child.emit("close", error ? 1 : 0);
	});
	return child;
};
syncBuiltinESMExports();

try {
	const host = await import(entry);
	const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, initTheme } = host;
	const hostRequire = createRequire(entry);
	const tui = await import(pathToFileURL(hostRequire.resolve("@earendil-works/pi-tui")).href);
	const { KeybindingsManager } = await import(new URL("./core/keybindings.js", entry).href);
	initTheme("dark", false);
	const { theme } = await import(new URL("./modes/interactive/theme/theme.js", entry).href);
	const keybindings = KeybindingsManager.create();
	tui.setKeybindings(keybindings);
	const manifest = JSON.parse(readFileSync(path.join(project, "package.json"), "utf8"));
	const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" });
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir: root, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		additionalExtensionPaths: manifest.pi.extensions.map((file) => path.resolve(project, file)),
		additionalSkillPaths: [path.join(project, "skills")],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	assert.equal(loader.getExtensions().extensions.length, manifest.pi.extensions.length);

	const store = path.join(root, "sessions-custom");
	const owner = { version: 1, kind: "ssh", host: "fixture-host", cwd: remoteCwd };
	const parent = SessionManager.create(root, store);
	parent.appendCustomEntry("pi-kit.session-environment", owner);
	parent.appendSessionInfo("Parent"); parent.appendMessage({ role: "user", content: "Parent", timestamp: Date.now() });
	const child = SessionManager.create(root, store); child.newSession({ parentSession: parent.getSessionFile() });
	child.appendCustomEntry("pi-kit.session-environment", owner);
	child.appendSessionInfo("Child"); child.appendMessage({ role: "user", content: "Child", timestamp: Date.now() });
	({ session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager, resourceLoader: loader, sessionManager: parent }));
	loader.getExtensions().runtime.flagValues.set("ssh", `fixture:${remoteCwd}`);
	const errors = [];
	await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
	assert.deepEqual(errors, []);

	async function emitStart() {
		const runner = session.extensionRunner;
		const options = runner.createCommandContext().getSystemPromptOptions();
		// Pi 1.x identifies the trigger; the 0.99 compatibility baseline takes prompt/images.
		if (runner.emitBeforeAgentStart.length >= 3) await runner.emitBeforeAgentStart("Integration test", undefined, options);
		else await runner.emitBeforeAgentStart({ messageType: "user", prompt: "Integration test" }, options);
		assert.equal(runner.createContext().cwd, root, "Remote prompts/tools must not change another extension's local cwd");
		return options;
	}
	const prompt = await emitStart();
	assert.equal(prompt.skills.length, 2);
	let runner = session.extensionRunner;
	async function execute(name, input) {
		assert.equal(await runner.emitToolCall({ type: "tool_call", toolName: name, toolCallId: `integration-${name}`, input }), undefined);
		return runner.getToolDefinition(name).execute(`integration-${name}`, input, undefined, undefined, runner.createContext());
	}
	for (const [input, expected] of [
		["notes.txt", `${remoteCwd}/notes.txt`], ["../outside.txt", "/srv/outside.txt"],
		["~/home.txt", `${remoteHome}/home.txt`], ["/var/fixtures/file.txt", "/var/fixtures/file.txt"],
		["/a/fixtures/file.txt", "/a/fixtures/file.txt"], ["/tmp/a:b%2Fc.txt", "/tmp/a:b%2Fc.txt"],
	]) {
		files.set(expected, "old content\n");
		assert.equal((await execute("read", { path: input })).content[0].text, "old content\n");
		await execute("write", { path: input, content: "new content\n" });
		assert.equal(files.get(expected), "new content\n");
		await execute("edit", { path: input, edits: [{ oldText: "new content", newText: "edited content" }] });
		assert.equal(files.get(expected), "edited content\n");
	}
	assert.equal((await execute("bash", { command: "pwd" })).content[0].text, remoteCwd);
	const userBash = await runner.emitUserBash({ type: "user_bash", command: "pwd", excludeFromContext: false, cwd: root });
	let output = "";
	await userBash.operations.exec("pwd", root, { onData(data) { output += data; } });
	assert.equal(output, remoteCwd);
	const beforeSkills = commands.length;
	for (const skill of prompt.skills) assert.equal((await execute("read", { path: skill.filePath })).content[0].text, readFileSync(skill.filePath, "utf8"));
	assert.equal(commands.length, beforeSkills, "Skill loading stays local even through host tool registration");
	if (process.platform === "win32") {
		const skill = prompt.skills[0].filePath;
		const remoteLookalike = `/${skill.slice(path.win32.parse(skill).root.length).replace(/\\/g, "/")}`;
		files.set(remoteLookalike, "REMOTE ROOTED PATH");
		assert.equal((await execute("read", { path: remoteLookalike })).content[0].text, "REMOTE ROOTED PATH");
	}

	// Seed an assistant caller, without calling a model, so nested tools use the
	// actual host execution/guard/result pipeline rather than manually emitted hooks.
	const seedCaller = () => session.agent.state.messages.push({ role: "assistant", content: [
		{ type: "toolCall", id: "verification-fixture", name: "bash", arguments: { command: "pwd" } },
	], api: "openai-responses", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: Date.now(),
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
	const evidence = () => parent.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "pi-kit.verification").at(-1).data;
	const nested = (name, args) => runner.createToolContext("verification-fixture").executeTool(name, args);
	const beforePlan = commands.length;
	await session.prompt("/verify add pwd");
	assert.equal(commands.length, beforePlan); assert.equal(evidence().runs.length, 0);
	seedCaller();
	assert.equal((await nested("bash", { command: "pwd" })).isError, false);
	assert.equal(evidence().runs[0].exitCode, 0); assert.equal(evidence().runs[0].revision, evidence().revision);
	assert.equal(evidence().runs[0].target, `SSH fixture-host:${remoteCwd}`);
	const checkedUserBash = await runner.emitUserBash({ type: "user_bash", command: "pwd", excludeFromContext: false, cwd: root });
	assert.ok(evidence().runs[0].revision < evidence().revision, "Verification must observe ! before SSH stops handler dispatch");
	await checkedUserBash.operations.exec("pwd", root, { onData() {} });
	assert.equal((await nested("bash", { command: "pwd" })).isError, false);
	assert.equal((await nested("write", { path: "evidence.txt", content: "changed" })).isError, false);
	assert.ok(evidence().runs[0].revision < evidence().revision);
	assert.equal((await nested("bash", { command: "pwd" })).isError, false);
	assert.equal(evidence().runs[0].revision, evidence().revision);
	await session.reload(); runner = session.extensionRunner;
	assert.ok(evidence().runs[0].revision < evidence().revision, "Reload retains evidence, but cannot restore the verified files");
	await session.prompt("/verify add npm install"); seedCaller();
	const beforeBlocked = commands.length;
	assert.equal((await nested("bash", { command: "npm install" })).isError, true);
	assert.equal(commands.length, beforeBlocked, "Checklist registration never grants permission to execute");
	assert.equal(evidence().runs.find((run) => run.command === "npm install").isError, true);
	await session.prompt("/verify reset");

	const rootBlock = await runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "blocked-root", input: { command: "npm install && rm -rf /" } });
	assert.equal(rootBlock.block, true); assert.match(rootBlock.reason, /rm-root/);
	await session.prompt("/preset review");
	const reviewBlock = await runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "blocked-review", input: { command: 'cat "`touch REVIEW_MARKER`"' } });
	assert.equal(reviewBlock.block, true); assert.match(reviewBlock.reason, /substitution/);
	await session.prompt("/preset normal");
	assert.equal(commands.some((command) => command.includes("rm -rf") || command.includes("REVIEW_MARKER")), false,
		"Dangerous test strings must never reach even the simulated SSH transport");

	let stage = 0;
	const bindings = { mode: "tui", onError: (error) => errors.push(error), commandContextActions: { waitForIdle: async () => {} }, uiContext: {
		theme, notify() {}, setStatus() {}, setFooter() {}, setTitle() {},
		custom(factory) {
			return new Promise((resolve, reject) => {
				const component = factory({ requestRender() {} }, { fg: (_color, text) => text }, keybindings, resolve);
				component.focused = true;
				const text = () => component.render(220).join("\n");
				const until = async (check) => {
					for (let attempt = 0; attempt < 150; attempt++) {
						if (check()) return;
						await new Promise((next) => setTimeout(next, 10));
					}
					throw new Error(`Picker did not settle: ${text()}`);
				};
				void (async () => {
					await until(() => text().includes("2 个会话"));
					if (stage === 0) {
						assert.match(text().split("\n")[0], /最近 · 未归档/);
						component.handleInput("\x13"); await until(() => text().includes("排序偏好已保存"));
						assert.match(text(), /└─|├─/);
						for (const character of '"Parent"') component.handleInput(character);
						component.handleInput("\x1ba"); await until(() => text().includes("已归档（仅此会话）"));
						component.handleInput("\x15"); assert.doesNotMatch(text(), /Parent/); assert.match(text(), /Child/);
					} else {
						assert.match(text().split("\n")[0], /层级 · 已归档/);
						assert.match(text(), /Parent/); assert.doesNotMatch(text(), /Child/);
						component.handleInput("\x1ba"); await until(() => text().includes("已取消归档"));
						component.handleInput("\x1bh"); assert.match(text(), /Parent/); assert.match(text(), /Child/);
						assert.match(text(), /└─|├─/);
					}
					component.handleInput("\x1b");
				})().catch(reject);
			});
		},
	} };
	await session.bindExtensions(bindings);
	const beforeParent = readFileSync(parent.getSessionFile(), "utf8");
	const beforeChild = readFileSync(child.getSessionFile(), "utf8");
	await session.prompt("/resume-env");
	stage = 1;
	await session.reload();
	await session.prompt("/resume-env archived");
	assert.deepEqual(errors, []);
	assert.equal(readFileSync(parent.getSessionFile(), "utf8"), beforeParent);
	assert.equal(readFileSync(child.getSessionFile(), "utf8"), beforeChild);
	console.log(`test:pi-integration ok: Pi ${host.VERSION}; all extensions loaded, guards/cwd/skills/verification/archive/reload verified (SSH simulated)`);
} finally {
	session?.dispose();
	cp.spawn = originalSpawn; syncBuiltinESMExports();
	if (savedEnv.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedEnv.agentDir;
	if (savedEnv.offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = savedEnv.offline;
	rmSync(root, { recursive: true, force: true });
}
