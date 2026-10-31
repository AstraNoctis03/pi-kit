#!/usr/bin/env node
// Runs the actual host loader/tool definitions. No model calls or real SSH connections.
// PI_KIT_TEST_AGENT_ENTRY can point at another already-installed Pi SDK entry.
import assert from "node:assert/strict";
import cp from "node:child_process";
import { createHash } from "node:crypto";
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
let writeFault;

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
			else if (command.startsWith("bash -c ") && command.includes("SSH atomic write:")) {
				const args = command.match(/ -- ('(?:[^']|'"'"')*') '(\d+)' '([a-f0-9]{64})'$/);
				assert.ok(args, "Atomic writes must carry path, length and SHA-256");
				let payload = Buffer.concat(input);
				if (writeFault === "short") payload = payload.subarray(0, 3);
				if (writeFault === "corrupt") payload[0] ^= 1;
				assert.equal(payload.length, Number(args[2]), "Incomplete upload");
				assert.equal(createHash("sha256").update(payload).digest("hex"), args[3], "Input checksum mismatch");
				files.set(args[1].slice(1, -1).replaceAll("'\"'\"'", "'"), payload.toString("utf8"));
			}
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
	function checkCompactRenderer() {
		if (typeof runner.resolveToolRenderers !== "function") {
			for (const [name, factory] of [["bash", host.createBashToolDefinition], ["read", host.createReadToolDefinition], ["edit", host.createEditToolDefinition], ["write", host.createWriteToolDefinition]]) {
				const native = factory(root);
				const tool = runner.getToolDefinition(name);
				assert.equal(tool.renderShell, native.renderShell, "Old hosts retain native shells (native edit itself uses self)");
				if (name !== "bash") for (const slot of ["renderCall", "renderResult"]) assert.equal(tool[slot], native[slot]);
			}
			return;
		}
		const base = runner.getToolDefinition("bash");
		const originalExecute = base.execute;
		const renderers = runner.resolveToolRenderers("bash", () => base);
		assert.equal(renderers.renderShell, "self");
		assert.deepEqual(Object.keys(renderers).sort(), ["renderCall", "renderResult", "renderShell"]);
		const ls = runner.getToolDefinition("ls");
		assert.equal(runner.resolveToolRenderers("ls", () => ls), ls);
		const before = commands.length;
		const args = Object.freeze({ command: "printf 'FIRST_COMMAND'\nprintf 'LAST_COMMAND'" });
		const component = new host.ToolExecutionComponent("bash", "render-fixture", args, { outputPad: 1 }, renderers, { requestRender() {} }, root);
		component.markExecutionStarted(); component.setArgsComplete();
		const text = () => tui.stripTerminalSequences(component.render(90).join("\n"));
		assert.match(text(), /Bash.*运行中/);
		const data = Object.freeze({ content: Object.freeze([{ type: "text", text: "FIRST_OUTPUT\nrow-2\nrow-3\nLAST_OUTPUT" }]), details: undefined, isError: false, durationMs: 2400 });
		component.updateResult(data);
		assert.match(text(), /✓ Bash.*2\.4s/); assert.doesNotMatch(text(), /FIRST_OUTPUT/);
		assert.match(text(), /LAST_OUTPUT/);
		assert.equal(text().match(/ctrl\+o/g)?.length, 1, "One shared expansion hint for command and output");
		assert.ok(component.render(90).join("").includes(theme.getFgAnsi("success")));
		component.setExpanded(true);
		assert.match(text(), /FIRST_COMMAND/); assert.match(text(), /LAST_COMMAND/); assert.match(text(), /FIRST_OUTPUT/);
		component.setExpanded(false); component.render(90);
		assert.equal(component.handleMouse({ type: "click", button: "left", x: 2, y: 1, width: 90, height: component.render(90).length })?.handled, true);
		assert.match(text(), /FIRST_OUTPUT/, "Native fullscreen click-to-expand remains available");
		component.updateResult({ ...data, isError: true });
		assert.match(text(), /✗ Bash/);
		component.updateArgs({ command: 'node -e "' + "console.error('fixture');".repeat(10) + '"', timeout: 15 });
		component.setExpanded(false);
		component.updateResult({ ...data, isError: true, content: [{ type: "text", text: "REAL_ERROR_BODY\nERROR_CONTEXT\n\n\nCommand exited with code 1" }] });
		assert.match(tui.stripTerminalSequences(component.render(90)[1]), /node -e "console\.error/, "Inline scripts use the same original-command preview as other tools");
		assert.doesNotMatch(text(), /内联脚本/);
		assert.match(text(), /REAL_ERROR_BODY/); assert.match(text(), /ERROR_CONTEXT/);
		assert.match(text(), /Command exited with code 1/);
		assert.equal(text().match(/ctrl\+o/g)?.length, 1);
		assert.ok(tui.visibleWidth(component.render(200)[1]) <= 70, "Command preview is bounded even in wide terminals");
		assert.doesNotMatch(text(), /超时上限|限 15s/);
		component.setExpanded(true); assert.match(text(), /超时上限 15s/);
		assert.match(text(), /console\.error\('fixture'\)/);
		component.updateArgs({ command: 'node -e "CHAIN_DETAIL" && printf AFTER' });
		component.setExpanded(false);
		assert.match(tui.stripTerminalSequences(component.render(90)[1]), /node -e "CHAIN_DETAIL"/, "Command chains retain the original preview");
		assert.match(text(), /CHAIN_DETAIL/);
		for (const width of [1, 2, 8, 30, 90]) for (const line of component.render(width)) assert.ok(tui.visibleWidth(line) <= width);
		assert.doesNotMatch(component.render(90).join(""), /\x1b\[48[;:]/, "Compact shell must not restore the large background box");
		assert.equal(runner.getToolDefinition("bash").execute, originalExecute);
		assert.equal(commands.length, before, "Rendering must never run commands");
		checkFileRenderers();
	}
	function checkFileRenderers() {
		const before = commands.length;
		const fullPath = remoteCwd + "/目录".repeat(25) + "/sample.ts";
		for (const name of ["read", "edit", "write"]) {
			const base = runner.getToolDefinition(name);
			const originalExecute = base.execute;
			const renderers = runner.resolveToolRenderers(name, () => base);
			assert.equal(renderers.renderShell, "self");
			assert.deepEqual(Object.keys(renderers).sort(), ["renderCall", "renderResult", "renderShell"]);
			const args = Object.freeze(name === "read" ? { path: fullPath, offset: 7, limit: 20 }
				: name === "write" ? { path: fullPath, content: "const WRITE_FIRST = 1;\nconst second = 2;\nconst third = 3;\n\nconst WRITE_LAST = 4;\n" }
				: { path: fullPath, edits: Object.freeze([Object.freeze({ oldText: "PLANNED_OLD", newText: "PLANNED_NEW" })]) });
			const component = new host.ToolExecutionComponent(name, `render-${name}`, args, { outputPad: 1 }, renderers, { requestRender() {} }, root);
			component.markExecutionStarted(); component.setArgsComplete();
			const text = () => tui.stripTerminalSequences(component.render(90).join("\n"));
			assert.match(text(), name === "read" ? /◌ Read.*L7–26.*读取中/ : name === "write" ? /◌ Write.*写入中/ : /◌ Edit.*编辑中/);
			assert.doesNotMatch(text(), /PLANNED_|WRITE_FIRST/);
			const details = name === "edit" ? Object.freeze(host.generateDiffString("const ACTUAL_OLD = 1;\nkeep\n", "const ACTUAL_NEW = 2;\nkeep\n")) : undefined;
			const data = Object.freeze({ content: Object.freeze([Object.freeze({ type: "text", text: name === "read" ? "READ_FIRST\nrow-2\nrow-3\nREAD_LAST" : name === "write" ? "OPAQUE_WRITE_ACK" : "Successfully replaced text." })]), details, isError: false, durationMs: 45 });
			component.updateResult(data);
			assert.match(text(), name === "read" ? /✓ Read.*45ms/ : name === "write" ? /✓ Write.*45ms/ : /✓ Edit.*45ms/);
			if (name === "read") { assert.match(text(), /READ_FIRST/); assert.doesNotMatch(text(), /READ_LAST/); }
			else if (name === "write") { assert.match(text(), /WRITE_FIRST/); assert.doesNotMatch(text(), /WRITE_LAST|OPAQUE_WRITE_ACK|\+1 −1/); }
			else { assert.match(text(), /\+1 −1/); assert.match(text(), /ACTUAL_OLD/); assert.match(text(), /ACTUAL_NEW/); }
			assert.equal(text().match(/ctrl\+o/g)?.length, 1);
			component.setExpanded(true);
			assert.ok(text().replace(/\s/g, "").includes(fullPath.replace(/\s/g, "")), "Expanded paths retain the original remote path across soft wraps");
			if (name === "read") assert.match(text(), /READ_LAST/);
			if (name === "write") { assert.match(text(), /WRITE_LAST/); assert.match(text(), /OPAQUE_WRITE_ACK/); }
			component.setExpanded(false); component.render(90);
			assert.equal(component.handleMouse({ type: "click", button: "left", x: 2, y: 1, width: 90, height: component.render(90).length })?.handled, true);
			assert.ok(text().replace(/\s/g, "").includes(fullPath.replace(/\s/g, "")), "Native mouse expansion still works for file tools");
			component.setExpanded(false);
			component.updateResult({ ...data, isError: true, content: [{ type: "text", text: "ACTUAL_ERROR\nERROR_CONTEXT\n\n\nCommand failed" }] });
			assert.match(text(), /✗ (Read|Edit|Write)/); assert.match(text(), /ACTUAL_ERROR/); assert.match(text(), /ERROR_CONTEXT/);
			assert.doesNotMatch(text(), /ACTUAL_OLD|ACTUAL_NEW|WRITE_FIRST|WRITE_LAST|\+1 −1/);
			for (const expanded of [false, true]) {
				component.setExpanded(expanded);
				for (const width of [1, 2, 8, 30, 90]) for (const line of component.render(width)) assert.ok(tui.visibleWidth(line) <= width);
			}
			assert.doesNotMatch(component.render(90).join(""), /\x1b\[48[;:]/);
			if (name === "read") {
				const caps = tui.getCapabilities();
				try {
					tui.setCapabilities({ ...caps, images: "iterm2" });
					const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=";
					const image = Object.freeze({ type: "image", mimeType: "image/png", data: png });
					component.updateResult({ content: Object.freeze([image]), isError: false });
					assert.match(component.render(90).join(""), /\x1b\]1337;File=/, "Native inline image transport is preserved");
					assert.equal(image.data, png);
				} finally { tui.setCapabilities(caps); }
			}
			assert.equal(runner.getToolDefinition(name).execute, originalExecute);
		}
		assert.equal(commands.length, before, "Read/edit/write renderers must not call SSH or run commands");
	}
	checkCompactRenderer();
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
		const writeInput = Object.freeze({ path: input, content: "new content\n" });
		const writeResult = await execute("write", writeInput);
		assert.equal(files.get(expected), "new content\n");
		if (typeof runner.resolveToolRenderers === "function") {
			const before = commands.length;
			const original = JSON.stringify(writeResult);
			const renderers = runner.resolveToolRenderers("write", () => runner.getToolDefinition("write"));
			const component = new host.ToolExecutionComponent("write", "actual-write-result", writeInput, {}, renderers, { requestRender() {} }, root);
			component.setArgsComplete(); component.markExecutionStarted();
			component.updateResult({ ...writeResult, isError: false });
			assert.match(tui.stripTerminalSequences(component.render(90).join("\n")), /new content/);
			component.setExpanded(true);
			const text = tui.stripTerminalSequences(component.render(90).join("\n")).replace(/\s/g, "");
			assert.ok(text.includes(writeResult.content[0].text.replace(/\s/g, "")), "Preserve the actual SDK write result without parsing or rewriting it");
			assert.equal(JSON.stringify(writeResult), original);
			assert.equal(commands.length, before, "Rendering an actual write result must not repeat the write");
		}
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
	for (const fault of ["short", "corrupt"]) {
		writeFault = fault;
		assert.equal((await nested("write", { path: "evidence.txt", content: "not fully delivered" })).isError, true);
		assert.equal(files.get(`${remoteCwd}/evidence.txt`), "changed");
		assert.equal((await nested("edit", { path: "evidence.txt", edits: [{ oldText: "changed", newText: "not fully delivered" }] })).isError, true);
		assert.equal(files.get(`${remoteCwd}/evidence.txt`), "changed");
	}
	writeFault = undefined;
	assert.ok(evidence().runs[0].revision < evidence().revision);
	assert.equal((await nested("bash", { command: "pwd" })).isError, false);
	assert.equal(evidence().runs[0].revision, evidence().revision);
	await session.reload(); runner = session.extensionRunner;
	checkCompactRenderer();
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
	console.log(`test:pi-integration ok: Pi ${host.VERSION}; all extensions loaded, guards/cwd/skills/atomic-write/verification/archive/reload verified; Bash/read/edit/write UI: ${typeof runner.resolveToolRenderers === "function" ? "compact" : "native fallback"} (SSH simulated)`);
} finally {
	session?.dispose();
	cp.spawn = originalSpawn; syncBuiltinESMExports();
	if (savedEnv.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedEnv.agentDir;
	if (savedEnv.offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = savedEnv.offline;
	rmSync(root, { recursive: true, force: true });
}
