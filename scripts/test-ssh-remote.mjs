#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { homedir } from "node:os";
import { findPathPatterns, parseSshTarget } from "../extensions/ssh-remote/config.ts";
import { RemotePathMapper } from "../extensions/ssh-remote/paths.ts";
import { quoteShell } from "../extensions/ssh-remote/transport.ts";
import sshRemote from "../extensions/ssh-remote/index.ts";

assert.deepEqual(parseSshTarget("mgt01d:/public/home/xjmao/project"), {
	host: "mgt01d",
	remoteCwd: "/public/home/xjmao/project",
});
assert.deepEqual(parseSshTarget("s1d"), { host: "s1d", remoteCwd: undefined });
assert.throws(() => parseSshTarget("-oProxyCommand=bad"));
assert.throws(() => parseSshTarget("host with spaces"));

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

const handlers = new Map();
const tools = new Map();
const mockPi = {
	registerFlag() {},
	getFlag: () => "invalid target",
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
await assert.rejects(
	() => handlers.get("session_start")[0]({ reason: "startup" }, mockContext),
	/SSH target must be an SSH config alias/,
);
assert.ok(tools.has("read"), "SSH tools must be registered before connection setup");
await assert.rejects(
	() => tools.get("read").execute("test", { path: "README.md" }, undefined, undefined, mockContext),
	/SSH mode unavailable/,
);

console.log("test:ssh ok");
