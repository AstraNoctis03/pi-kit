#!/usr/bin/env node
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import path from "node:path";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { setKeybindings as setNativeKeybindings } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js";
import {
	ENVIRONMENT_ENTRY, isSessionEnvironment, readEnvironment, readEnvironmentFile,
	sameEnvironment, sameDirectory, matchesScope,
} from "../extensions/ssh-remote/environment.ts";
import { createEnvironmentSessions } from "../extensions/ssh-remote/environment-sessions.ts";
import { showEnvironmentPicker } from "../extensions/ssh-remote/resume-picker.ts";
import { SessionIndex } from "../extensions/ssh-remote/session-index.ts";
import { ResumeStateStore, sessionStateKey } from "../extensions/ssh-remote/resume-state.ts";
import sshRemote from "../extensions/ssh-remote/index.ts";
import { SshClient } from "../extensions/ssh-remote/transport.ts";

initTheme("dark", false);
const keybindings = KeybindingsManager.create();
setKeybindings(keybindings);
setNativeKeybindings(keybindings); // Match the host's shared bindings despite the test dependency tree's nested TUI copy.
async function waitFor(check) {
	for (let count = 0; count < 100; count++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for async picker load");
}

const local = { version: 1, kind: "local", host: hostname(), cwd: process.cwd() };
const ssh = { version: 1, kind: "ssh", host: "compute-01", cwd: "/work/one" };
const anotherDirectory = { ...ssh, cwd: "/work/two" };
const anotherHost = { ...ssh, host: "compute-02" };
const entry = (data) => ({ type: "custom", customType: ENVIRONMENT_ENTRY, data });
assert.equal(isSessionEnvironment({ ...ssh, version: 2 }), false);
assert.equal(isSessionEnvironment({ ...ssh, host: "" }), false);
assert.equal(readEnvironment([entry(ssh), entry(anotherHost)]), ssh, "Ownership cannot be overwritten by later entries");
assert.equal(readEnvironment([entry({ version: 9 }), entry(ssh)]), undefined, "Invalid original records fail closed");
assert.equal(sameEnvironment(ssh, anotherDirectory), true);
assert.equal(sameEnvironment(ssh, anotherHost), false);
assert.equal(sameEnvironment(local, { ...local, kind: "ssh" }), false);
assert.equal(sameDirectory(ssh, anotherDirectory), false);
assert.equal(sameDirectory({ ...local, cwd: "C:\\work\\project" }, { ...local, cwd: "c:/WORK/project" }), true);
assert.equal(matchesScope(anotherDirectory, ssh, "environment"), true);
assert.equal(matchesScope(anotherDirectory, ssh, "directory"), false);
assert.equal(matchesScope(undefined, ssh, "environment"), false);
assert.equal(matchesScope(undefined, ssh, "all"), true);

function harness(manager = SessionManager.inMemory(process.cwd()), flag) {
	const events = new Map();
	const commands = new Map();
	const notices = [];
	const switches = [];
	const pi = {
		on(name, handler) { events.set(name, [...events.get(name) ?? [], handler]); },
		registerCommand(name, command) { commands.set(name, command); },
		registerFlag() {}, registerTool() {}, getFlag: () => flag,
		getSessionName: () => manager.getSessionName(),
		setSessionName(name) { manager.appendSessionInfo(name); },
		appendEntry(type, data) { manager.appendCustomEntry(type, data); },
	};
	const ctx = {
		cwd: manager.getCwd(), sessionManager: manager, mode: "tui", hasUI: true,
		waitForIdle: async () => {},
		switchSession: async (file) => { switches.push(file); return { cancelled: false }; },
		ui: {
			theme: { fg: (_color, text) => text, bold: (text) => text }, setStatus() {},
			notify(text, level) { notices.push({ text, level }); },
			confirm: async () => true,
			async custom(factory) {
				const allowed = await ctx.ui.confirm(); // Existing test-controlled approval choice.
				return new Promise((done) => {
					const component = factory({ requestRender() {} }, ctx.ui.theme, keybindings, done);
					component.focused = true;
					assert.match(component.render(100).join("\n"), /认领当前会话/);
					component.handleInput(allowed ? "\r" : "\x1b");
				});
			},
		},
	};
	async function emit(name, event = {}) {
		let result;
		for (const handler of events.get(name) ?? []) {
			const value = await handler(event, ctx);
			if (value) result = value;
		}
		return result;
	}
	return { pi, ctx, commands, events, notices, switches, emit };
}

const fresh = harness();
const controller = createEnvironmentSessions(fresh.pi, () => {});
controller.activate(fresh.ctx, local);
assert.deepEqual(readEnvironment(fresh.ctx.sessionManager.getEntries()), local);
controller.activate(fresh.ctx, local);
assert.equal(fresh.ctx.sessionManager.getEntries().length, 1, "Reload must not append duplicate ownership records");
assert.equal(await fresh.emit("tool_call"), undefined);

const legacyManager = SessionManager.inMemory();
legacyManager.appendMessage({ role: "user", content: "Old work", timestamp: Date.now() });
legacyManager.appendSessionInfo("[SSH old:work] Untrusted mutable title");
const legacy = harness(legacyManager);
sshRemote(legacy.pi);
await legacy.emit("session_start");
assert.equal(legacyManager.getSessionName(), "[SSH old:work] Untrusted mutable title");
assert.equal(readEnvironment(legacyManager.getEntries()), undefined, "Never infer old ownership from the current connection or a name");
assert.equal((await legacy.emit("tool_call", { toolName: "read" })).block, true);
assert.equal((await legacy.emit("user_bash", { command: "pwd" })).result.exitCode, 1);
await assert.rejects(() => legacy.emit("before_agent_start", { prompt: "run", systemPromptOptions: { sections: {} } }), /Session environment/);
legacy.ctx.ui.confirm = async () => false;
await legacy.commands.get("session-env").handler("claim", legacy.ctx);
assert.equal(readEnvironment(legacyManager.getEntries()), undefined);
legacy.ctx.ui.confirm = async () => true;
await legacy.commands.get("claim").handler("", legacy.ctx);
assert.equal(readEnvironment(legacyManager.getEntries()).kind, "local");
assert.equal(legacyManager.getSessionName(), "[LOCAL] Untrusted mutable title");
assert.equal(await legacy.emit("tool_call", { toolName: "read" }), undefined);
const claimedCount = legacyManager.getEntries().length;
await legacy.commands.get("session-env").handler("claim", legacy.ctx);
assert.equal(legacyManager.getEntries().length, claimedCount, "Known ownership cannot be reassigned");

const wrongManager = SessionManager.inMemory();
wrongManager.appendCustomEntry(ENVIRONMENT_ENTRY, ssh);
wrongManager.appendMessage({ role: "user", content: "Remote work", timestamp: Date.now() });
wrongManager.appendSessionInfo("[SSH compute-01:one] Important work");
const wrong = harness(wrongManager);
sshRemote(wrong.pi);
const originalEntries = wrongManager.getEntries().length;
await wrong.emit("session_start");
assert.equal(wrongManager.getEntries().length, originalEntries, "Startup --session mismatch must not relabel or rewrite ownership");
assert.equal((await wrong.emit("tool_call", { toolName: "bash" })).block, true);
await assert.rejects(() => wrong.emit("before_agent_start", { prompt: "run" }), /matching environment/);

// Probe and restore remote sessions without an actual SSH/network connection.
const originalRun = SshClient.prototype.run;
try {
	const calls = [];
	SshClient.prototype.run = async function(command) {
		calls.push({ target: this.target, command });
		const stdout = command.includes("remote_hostname=") ? ["/work/one", "/home/test", "compute-01", "1", ""].join("\0")
			: "/work/two";
		return { stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), exitCode: 0 };
	};
	for (const alias of ["s1:/work/one", "s1d:/work/one"]) {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(ENVIRONMENT_ENTRY, anotherDirectory);
		manager.appendSessionInfo("[SSH compute-01:two] Saved directory");
		const remote = harness(manager, alias);
		sshRemote(remote.pi);
		await remote.emit("session_start");
		const event = { prompt: "inspect", systemPromptOptions: { sections: {} } };
		await remote.emit("before_agent_start", event);
		assert.equal(event.systemPromptOptions.cwd, "/work/two", "Resume must restore the saved remote directory rather than use CLI cwd");
		assert.equal(manager.getSessionName(), "[SSH compute-01:two] Saved directory");
		assert.equal(await remote.emit("tool_call", { toolName: "read" }), undefined);
	}
	assert.ok(calls.some(({ command }) => command === "cd '/work/two' && printf '%s' \"$PWD\""));
	SshClient.prototype.run = async function(command) {
		if (!command.includes("remote_hostname=")) throw new Error("Saved directory missing");
		return { stdout: Buffer.from(["/work/one", "/home/test", "compute-01", "1", ""].join("\0")), stderr: Buffer.alloc(0), exitCode: 0 };
	};
	const missingDirectory = SessionManager.inMemory();
	missingDirectory.appendCustomEntry(ENVIRONMENT_ENTRY, anotherDirectory);
	const failedRestore = harness(missingDirectory, "s1d:/work/one");
	sshRemote(failedRestore.pi);
	await assert.rejects(() => failedRestore.emit("session_start"), /Saved directory missing/);
	assert.equal((await failedRestore.emit("tool_call", { toolName: "bash" })).block, true,
		"A failed cwd restoration must not execute in the CLI directory instead");
} finally {
	SshClient.prototype.run = originalRun;
}

const root = mkdtempSync(path.join(tmpdir(), "pi-kit-environment-"));
try {
	function persisted(environment, title, parentSession) {
		const manager = SessionManager.create(process.cwd(), root);
		if (parentSession) manager.newSession({ parentSession });
		if (environment) manager.appendCustomEntry(ENVIRONMENT_ENTRY, environment);
		manager.appendSessionInfo(title);
		manager.appendMessage({ role: "user", content: title, timestamp: Date.now() });
		return manager;
	}
	const current = persisted(ssh, "One");
	const two = persisted(anotherDirectory, "Two", current.getSessionFile());
	const other = persisted(anotherHost, "Other host");
	const unknown = persisted(undefined, "Legacy 中文");
	const file = other.getSessionFile();
	const before = readFileSync(file, "utf8");
	assert.deepEqual(await readEnvironmentFile(file), anotherHost);
	assert.equal(readFileSync(file, "utf8"), before, "Classification must be read-only");
	assert.deepEqual(await fresh.emit("session_before_switch", { reason: "resume", targetSessionFile: file }), { cancel: true });
	assert.deepEqual(await fresh.emit("session_before_switch", { reason: "resume", targetSessionFile: path.join(root, "missing.jsonl") }), { cancel: true });
	assert.equal(await fresh.emit("session_before_switch", { reason: "resume", targetSessionFile: unknown.getSessionFile() }), undefined,
		"Unknown sessions may be inspected but cannot execute before explicit assignment");

	const pickerStore = new ResumeStateStore(path.join(root, "ui-state", "resume-env-state.jsonl"));
	const pickerHarness = harness(current);
	createEnvironmentSessions(pickerHarness.pi, () => {}, pickerStore).activate(pickerHarness.ctx, ssh);
	assert.equal(await pickerHarness.emit("session_before_switch", { reason: "resume", targetSessionFile: two.getSessionFile() }), undefined);
	assert.deepEqual(await pickerHarness.emit("session_before_switch", { reason: "resume", targetSessionFile: other.getSessionFile() }), { cancel: true });
	let component;
	pickerHarness.ctx.ui.custom = async (factory) => new Promise((resolve, reject) => {
		component = factory({ requestRender() {} }, { fg: (_color, text) => text }, keybindings, resolve);
		component.focused = true;
		assert.match(component.render(180).join("\n"), /正在加载/, "UI must open before file scanning finishes");
		void (async () => {
			await waitFor(() => component.render(180).join("\n").includes("4 个会话"));
			const initial = component.render(180).join("\n");
			assert.match(initial, /当前环境/);
			assert.match(initial, /One/);
			assert.match(initial, /Two/);
			assert.match(initial, /最近/);
			assert.doesNotMatch(initial, /└─|├─/, "The default must be recent/flat");
			assert.doesNotMatch(initial, /Other host|Legacy/);
			component.handleInput("\x13");
			await waitFor(() => component.render(180).join("\n").includes("排序偏好已保存"));
			assert.match(component.render(180).join("\n"), /层级/);
			assert.match(component.render(180).join("\n"), /└─|├─/, "Parent/child hierarchy remains available on demand");
			component.handleInput("\t");
			const directory = component.render(180).join("\n");
			assert.match(directory, /One/);
			assert.doesNotMatch(directory, /Two/);
			component.handleInput("\t");
			assert.match(component.render(180).join("\n"), /UNKNOWN/);
			assert.match(component.render(180).join("\n"), /Other host/);
			component.handleInput("\x13");
			await waitFor(() => component.render(180)[0].includes("· 最近 ·"));
			assert.equal((await new ResumeStateStore(pickerStore.file).load()).sort, "recent");
			for (const width of [1, 12, 40]) {
				for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
			}
			component.invalidate();
			component.handleInput("\t");
			component.handleInput('"'); component.handleInput("T"); component.handleInput("w"); component.handleInput("o"); component.handleInput('"');
			component.handleInput("\r");
		})().catch(reject);
	});
	await pickerHarness.commands.get("resume-env").handler("", pickerHarness.ctx);
	assert.deepEqual(pickerHarness.switches, [two.getSessionFile()], "Picker uses selected paths, not ambiguous names");
	assert.equal(component.focused, true);
	assert.equal(readFileSync(file, "utf8"), before);

	const cancelCtx = { ...pickerHarness.ctx, ui: { custom(factory) {
		return new Promise((resolve) => {
			const picker = factory({ requestRender() {} }, { fg: (_color, text) => text }, keybindings, resolve);
			picker.handleInput("\x1b");
		});
	} } };
	assert.equal(await showEnvironmentPicker(cancelCtx, ssh, async () => { throw new Error("Closed picker must not start loading"); }, { store: pickerStore }), undefined);

	let loadingPicker;
	let loadingSignal;
	let latePublish;
	let finishLoading;
	const loadingCtx = { ...pickerHarness.ctx, ui: { custom(factory) {
		return new Promise((resolve) => {
			loadingPicker = factory({ requestRender() {} }, { fg: (_color, text) => text }, keybindings, resolve);
		});
	} } };
	const loadingResult = showEnvironmentPicker(loadingCtx, ssh, (publish, signal) => {
		loadingSignal = signal;
		latePublish = publish;
		return new Promise((resolve) => { finishLoading = resolve; });
	}, { store: pickerStore });
	await waitFor(() => loadingSignal);
	loadingPicker.handleInput("\x1b");
	assert.equal(await loadingResult, undefined);
	assert.equal(loadingSignal.aborted, true, "Escape must cancel background file reads immediately");
	const closedOutput = loadingPicker.render(180).join("\n");
	latePublish([], 99, 100); finishLoading([]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(loadingPicker.render(180).join("\n"), closedOutput, "Late updates must not mutate a closed picker");

	const index = new SessionIndex();
	const signal = new AbortController().signal;
	const indexed = await index.list(root, false, () => {}, signal);
	assert.equal(indexed.length, 4);
	assert.equal(indexed.find((row) => row.info.path === two.getSessionFile()).info.parentSessionPath, current.getSessionFile());
	const initialBytes = index.bytesRead;
	await index.list(root, false, () => {}, signal);
	assert.equal(index.bytesRead, initialBytes, "Unchanged files must not be reread");
	const oldSize = statSync(file).size;
	other.appendSessionInfo("Renamed");
	const updated = await index.read(file);
	assert.equal(updated.info.name, "Renamed");
	assert.equal(index.bytesRead - initialBytes, statSync(file).size - oldSize, "Read only appended bytes, not the full history");
	unknown.appendCustomEntry(ENVIRONMENT_ENTRY, local);
	assert.deepEqual((await index.read(unknown.getSessionFile())).environment, local, "Late claims must invalidate UNKNOWN cache entries");
	unknown.appendCustomEntry(ENVIRONMENT_ENTRY, ssh);
	assert.deepEqual((await index.read(unknown.getSessionFile())).environment, local, "The original claim still wins after conflicting appends");

	const parentRow = { ...indexed.find((row) => row.info.path === current.getSessionFile()) };
	parentRow.info = { ...parentRow.info, name: "Parent fixed", modified: new Date(1000) };
	const childRow = { ...indexed.find((row) => row.info.path === two.getSessionFile()) };
	childRow.info = { ...childRow.info, name: "Child fixed", modified: new Date(2000) };
	const treeRows = [parentRow, childRow];
	const archiveStore = new ResumeStateStore(path.join(root, "ui-state", "archives.jsonl"));
	const parentBytes = readFileSync(current.getSessionFile(), "utf8");
	const childBytes = readFileSync(two.getSessionFile(), "utf8");
	async function openPicker(rows, store = archiveStore, archiveView) {
		let popup;
		const context = { ...pickerHarness.ctx, ui: { custom(factory) {
			return new Promise((resolve) => {
				popup = factory({ requestRender() {} }, { fg: (_color, text) => text }, keybindings, resolve);
				popup.focused = true;
			});
		} } };
		const result = showEnvironmentPicker(context, ssh, async () => rows, { store, archiveView });
		await waitFor(() => popup && popup.render(240).join("\n").includes(`${rows.length} 个会话`));
		return { popup, result, text: () => popup.render(240).join("\n") };
	}
	let view = await openPicker(treeRows);
	assert.match(view.text(), /最近/);
	assert.doesNotMatch(view.text(), /└─|├─/);
	assert.ok(view.text().indexOf("Child fixed") < view.text().indexOf("Parent fixed"));
	view.popup.handleInput("\x13");
	await waitFor(() => view.text().includes("排序偏好已保存"));
	assert.match(view.text(), /层级/);
	assert.match(view.text(), /└─|├─/);
	for (const char of '"Parent fixed"') view.popup.handleInput(char);
	view.popup.handleInput("\x1ba"); // Alt+A archives only the selected parent.
	await waitFor(() => view.text().includes("已归档（仅此会话）"));
	view.popup.handleInput("\x15"); // Clear search with Ctrl+U.
	assert.doesNotMatch(view.text(), /Parent fixed/);
	assert.match(view.text(), /Child fixed/);
	assert.doesNotMatch(view.text(), /└─|├─/, "A child whose parent is hidden stays visible as a root");
	let archiveState = await new ResumeStateStore(archiveStore.file).load();
	assert.equal(archiveState.archived.has(sessionStateKey(parentRow.info)), true);
	assert.equal(archiveState.archived.has(sessionStateKey(childRow.info)), false);
	view.popup.handleInput("\x1b"); await view.result;

	view = await openPicker(treeRows, new ResumeStateStore(archiveStore.file));
	assert.match(view.text(), /层级 · 未归档/, "Only sorting, not the last archive view, is remembered");
	assert.doesNotMatch(view.text(), /Parent fixed/);
	view.popup.handleInput("\x1bh"); // Alt+H switches to archived-only.
	assert.match(view.text(), /Parent fixed/);
	assert.doesNotMatch(view.text(), /Child fixed/);
	view.popup.handleInput("\x1ba");
	await waitFor(() => view.text().includes("已取消归档"));
	assert.doesNotMatch(view.text(), /Parent fixed/);
	view.popup.handleInput("\x1bh"); // All, including archived.
	assert.match(view.text(), /Parent fixed/);
	assert.match(view.text(), /Child fixed/);
	assert.match(view.text(), /└─|├─/, "Unarchiving restores the original hierarchy without editing either session");
	view.popup.handleInput("\x13");
	await waitFor(() => view.text().includes("排序偏好已保存"));
	assert.match(view.text(), /最近/);
	assert.doesNotMatch(view.text(), /relevance|threaded/);
	view.popup.handleInput("\x1b"); await view.result;
	assert.equal((await new ResumeStateStore(archiveStore.file).load()).sort, "recent");
	assert.equal(readFileSync(current.getSessionFile(), "utf8"), parentBytes);
	assert.equal(readFileSync(two.getSessionFile(), "utf8"), childBytes, "Archive operations must not modify child/parent transcripts");

	// Keep the query out of environment prefixes/UUIDs to isolate native fuzzy ranking.
	const searchRows = [
		{ ...parentRow, info: { ...parentRow.info, name: "xyzxyz", firstMessage: "Older exact match" } },
		{ ...childRow, info: { ...childRow.info, name: "x--y--z--x--y--z", firstMessage: "Newer fuzzy match" } },
	];
	view = await openPicker(searchRows);
	assert.ok(view.text().indexOf("x--y--z--x--y--z") < view.text().indexOf("] xyzxyz"));
	for (const char of "xyzxyz") view.popup.handleInput(char);
	assert.ok(view.text().indexOf("] xyzxyz") < view.text().indexOf("x--y--z--x--y--z"), "Search automatically uses native relevance rather than recency");
	view.popup.handleInput("\x15");
	assert.ok(view.text().indexOf("x--y--z--x--y--z") < view.text().indexOf("] xyzxyz"), "Clearing search restores recent ordering");
	assert.equal((await archiveStore.load()).sort, "recent", "Searching must not overwrite the persisted layout preference");
	view.popup.handleInput("\x1b"); await view.result;

	const deniedStore = new ResumeStateStore(path.join(root, "ui-state", "denied.jsonl"));
	deniedStore.setArchived = async () => { throw new Error("Permission denied"); };
	view = await openPicker(treeRows, deniedStore);
	view.popup.handleInput("\x1ba");
	await waitFor(() => view.text().includes("保存失败"));
	assert.match(view.text(), /Parent fixed/);
	assert.match(view.text(), /Child fixed/, "Failed archive writes must not hide a session optimistically");
	assert.equal((await deniedStore.load()).archived.size, 0);
	view.popup.handleInput("\x1b"); await view.result;

	const partial = path.join(root, "partial.jsonl");
	const header = { type: "session", id: "partial", cwd: "/work", timestamp: new Date().toISOString() };
	writeFileSync(partial, JSON.stringify(header) + '\r\n{"type":"session_info","name":"incomplete');
	assert.equal((await index.read(partial)).info.name, undefined);
	appendFileSync(partial, ' name"}\r\n');
	assert.equal((await index.read(partial)).info.name, "incomplete name", "Incremental scans must retain partial lines and CRLF byte offsets");
	appendFileSync(partial, JSON.stringify({ type: "session_info", name: "No newline" }));
	assert.equal((await index.read(partial)).info.name, "No newline", "Valid JSONL may omit its final newline");
	appendFileSync(partial, "\n");
	assert.equal((await index.read(partial)).info.name, "No newline");
	writeFileSync(partial, JSON.stringify(header) + '\n' + JSON.stringify({ type: "session_info", name: "Rewrite" }) + '\n');
	const later = new Date(Date.now() + 5000);
	utimesSync(partial, later, later);
	assert.equal((await index.read(partial)).info.name, "Rewrite", "Truncation/rewrite must rebuild the summary");
	const aborted = new AbortController(); aborted.abort();
	await assert.rejects(() => index.list(root, false, () => {}, aborted.signal), /abort/i);
} finally {
	rmSync(root, { recursive: true, force: true });
}
console.log("test:environment-sessions ok");
