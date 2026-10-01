#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { homedir } from "node:os";
import { findPathPatterns, parseSshTarget } from "../extensions/ssh-remote/config.ts";
import { RemotePathMapper } from "../extensions/ssh-remote/paths.ts";
import {
	compactSessionTopic,
	firstUserTopic,
	sessionNameTopic,
	sessionTargetLabel,
	stableSessionHost,
	targetedSessionName,
} from "../extensions/ssh-remote/session-label.ts";
import { quoteShell } from "../extensions/ssh-remote/transport.ts";
import sshRemote from "../extensions/ssh-remote/index.ts";

assert.deepEqual(parseSshTarget("mgt01d:/public/home/xjmao/project"), {
	host: "mgt01d",
	remoteCwd: "/public/home/xjmao/project",
});
assert.deepEqual(parseSshTarget("s1d"), { host: "s1d", remoteCwd: undefined });
assert.throws(() => parseSshTarget("-oProxyCommand=bad"));
assert.throws(() => parseSshTarget("host with spaces"));

assert.equal(sessionTargetLabel(), "[LOCAL]");
assert.equal(sessionTargetLabel("s1d", "/home/xjmao/project"), "[SSH s1d:project]");
assert.equal(sessionTargetLabel("s1d", "/tmp/weird]\nname"), "[SSH s1d:weird_ name]");
assert.equal(stableSessionHost("compute-01", "s1"), "compute-01");
assert.equal(stableSessionHost("compute-01", "s1d"), "compute-01");
assert.equal(stableSessionHost("", "s1d"), "s1d");
assert.equal(
	sessionTargetLabel(stableSessionHost("compute-01", "s1"), "/home/xjmao/project"),
	sessionTargetLabel(stableSessionHost("compute-01", "s1d"), "/home/xjmao/project"),
);
assert.equal(sessionNameTopic("[LOCAL] [SSH old:project] Fix tests"), "Fix tests");
assert.equal(targetedSessionName("[SSH s1d:project]", "[LOCAL] Fix tests"), "[SSH s1d:project] Fix tests");
assert.equal(compactSessionTopic("  first\n task  "), "first task");
assert.equal(firstUserTopic([
	{ id: "system", parentId: null, timestamp: new Date().toISOString(), type: "message", message: { role: "system", content: "", timestamp: Date.now() } },
	{ id: "user", parentId: "system", timestamp: new Date().toISOString(), type: "message", message: { role: "user", content: "Inspect the project", timestamp: Date.now() } },
]), "Inspect the project");

assert.deepEqual(findPathPatterns("/srv/project", "*.ts"), ["*.ts"]);
assert.deepEqual(findPathPatterns("/srv/project", "**/*.json"), [
	"/srv/project/**/*.json",
	"/srv/project/*.json",
]);
assert.deepEqual(findPathPatterns("/srv/project", "src/**/*.spec.ts"), [
	"/srv/project/src/**/*.spec.ts",
	"/srv/project/src/*.spec.ts",
]);

const mapper = new RemotePathMapper(process.cwd(), "/srv/project", "/home/tester");
assert.equal(mapper.resolveRemoteInput("src/index.ts"), "/srv/project/src/index.ts");
assert.equal(mapper.resolveRemoteInput("~/notes.txt"), "/home/tester/notes.txt");
assert.equal(mapper.toRemotePath(path.join(mapper.syntheticCwd, "src", "index.ts")), "/srv/project/src/index.ts");
assert.equal(mapper.toRemotePath(path.join(homedir(), "notes.txt")), "/home/tester/notes.txt");
assert.equal(mapper.toToolPath("/srv/project/src/index.ts"), path.join(mapper.syntheticCwd, "src", "index.ts"));

assert.equal(quoteShell("plain"), "'plain'");
assert.equal(quoteShell("it's safe"), "'it'\"'\"'s safe'");
assert.throws(() => quoteShell("bad\0value"));

const localHandlers = new Map();
let localSessionName;
const localPi = {
	registerFlag() {},
	getFlag: () => undefined,
	getSessionName: () => localSessionName,
	setSessionName(name) { localSessionName = name; },
	on(name, handler) {
		const eventHandlers = localHandlers.get(name) ?? [];
		eventHandlers.push(handler);
		localHandlers.set(name, eventHandlers);
	},
	registerTool() {},
	registerCommand() {},
};
sshRemote(localPi);
const localContext = {
	cwd: process.cwd(),
	sessionManager: { getEntries: () => [] },
	ui: {
		theme: { fg: (_color, text) => text },
		setStatus() {},
		notify() {},
	},
};
await localHandlers.get("session_start")[0]({ reason: "startup" }, localContext);
assert.equal(localSessionName, "[LOCAL]");
const localPromptEvent = {
	prompt: "Fix the failing tests",
	get systemPrompt() { throw new Error("Do not read the rendered prompt"); },
	systemPromptOptions: {
		cwd: process.cwd(), sections: { pi_kit_ssh: "stale SSH section", other: "Keep this section" },
	},
};
assert.equal(await localHandlers.get("before_agent_start")[0](localPromptEvent, localContext), undefined);
assert.deepEqual(localPromptEvent.systemPromptOptions, {
	cwd: process.cwd(), sections: { other: "Keep this section" },
}, "Local mode removes only its own stale SSH section");
assert.equal(localSessionName, "[LOCAL] Fix the failing tests");
await localHandlers.get("session_info_changed")[0]({ name: "Release prep" }, localContext);
assert.equal(localSessionName, "[LOCAL] Release prep");
assert.equal(await localHandlers.get("tool_call")[0]({ toolName: "powershell" }, localContext), undefined,
	"SSH extension alone must not restrict local sessions");

const handlers = new Map();
const tools = new Map();
const mockPi = {
	registerFlag() {},
	getFlag: () => "invalid target",
	getSessionName: () => undefined,
	on(name, handler) {
		const eventHandlers = handlers.get(name) ?? [];
		eventHandlers.push(handler);
		handlers.set(name, eventHandlers);
	},
	registerTool(tool) {
		tools.set(tool.name, tool);
	},
	registerCommand() {},
};
const mockContext = {
	cwd: process.cwd(),
	ui: {
		theme: { fg: (_color, text) => text },
		setStatus() {},
		notify() {},
	},
};
sshRemote(mockPi);
const sshToolGuard = handlers.get("tool_call")[0];
assert.equal((await sshToolGuard({ toolName: "powershell" }, mockContext)).block, true,
	"Block local PowerShell even before SSH initialization");
await assert.rejects(
	() => handlers.get("session_start")[0]({ reason: "startup" }, mockContext),
	/SSH target must be an SSH config alias/,
);
assert.ok(tools.has("read"), "SSH tools must be registered before connection setup");
await assert.rejects(
	() => tools.get("read").execute("test", { path: "README.md" }, undefined, undefined, mockContext),
	/SSH mode unavailable/,
);

const failedPromptEvent = {
	prompt: "Inspect project",
	get systemPrompt() { throw new Error("Do not read the rendered prompt"); },
	systemPromptOptions: {
		cwd: process.cwd(),
		sections: { pi_kit_preset: "Review instructions", other: "Keep this section" },
	},
};
assert.equal(await handlers.get("before_agent_start")[0](failedPromptEvent, mockContext), undefined);
assert.deepEqual(failedPromptEvent.systemPromptOptions, {
	cwd: process.cwd(), sections: {
		pi_kit_preset: "Review instructions", other: "Keep this section",
		pi_kit_ssh: "SSH remote mode is unavailable. Do not use file or shell tools.",
	},
});

for (const parentToolCallId of [undefined, "codemode-parent"]) {
	const decision = await sshToolGuard({ toolName: "powershell", parentToolCallId }, mockContext);
	assert.equal(decision.block, true, "SSH failure must never fall back to local PowerShell");
}
assert.equal(await sshToolGuard({ toolName: "bash" }, mockContext), undefined,
	"Bash remains handled by the fail-closed remote transport");
mockPi.getFlag = () => "test-host:/srv/project";
assert.equal((await sshToolGuard({ toolName: "powershell" }, mockContext)).block, true,
	"Valid SSH targets must also block local PowerShell without a live connection");

console.log("test:ssh ok");
