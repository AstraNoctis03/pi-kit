#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import dirtyRepoGuard from "../extensions/dirty-repo-guard/index.ts";
import { handoffMessages } from "../extensions/handoff/index.ts";
import { titleTarget } from "../extensions/titlebar-spinner/index.ts";

const compacted = handoffMessages([
	{ id: "old", type: "message", message: { role: "user", content: "old" } },
	{ id: "kept", type: "message", message: { role: "assistant", content: [] } },
	{ id: "compact", type: "compaction", summary: "summary", tokensBefore: 1000, timestamp: Date.now(), firstKeptEntryId: "kept" },
	{ id: "recent", type: "message", message: { role: "user", content: "recent" } },
]);
assert.deepEqual(compacted.map((message) => message.role), ["compactionSummary", "assistant", "user"]);

assert.equal(
	titleTarget({ getFlag: () => "s1d:/home/xjmao/project" }, { cwd: "C:/local" }),
	"s1d:project",
);
assert.equal(
	titleTarget({ getFlag: () => undefined }, { cwd: path.join("C:/", "work", "project") }),
	"project",
);

const sshHandlers = new Map();
let sshExecCalls = 0;
const sshPi = {
	getFlag: () => "s1d:/home/xjmao/project",
	on(name, handler) {
		const items = sshHandlers.get(name) ?? [];
		items.push(handler);
		sshHandlers.set(name, items);
	},
	exec: async () => {
		sshExecCalls += 1;
		return { code: 0, stdout: " M local-only.ts\n", stderr: "", killed: false };
	},
};
let confirmations = 0;
const ctx = {
	cwd: process.cwd(),
	hasUI: true,
	ui: {
		confirm: async () => { confirmations += 1; return false; },
		notify() {},
	},
};
dirtyRepoGuard(sshPi);
assert.equal(await sshHandlers.get("session_before_switch")[0]({ reason: "new" }, ctx), undefined);
assert.equal(sshExecCalls, 0, "SSH mode must skip Dirty Repo Guard entirely");
assert.equal(confirmations, 0);

const localHandlers = new Map();
let localResult = { code: 0, stdout: " M src/index.ts\n?? test.ts\n", stderr: "", killed: false };
const localPi = {
	getFlag: () => undefined,
	on(name, handler) {
		const items = localHandlers.get(name) ?? [];
		items.push(handler);
		localHandlers.set(name, items);
	},
	exec: async () => localResult,
};
dirtyRepoGuard(localPi);
assert.deepEqual(
	await localHandlers.get("session_before_switch")[0]({ reason: "new" }, ctx),
	{ cancel: true },
	"Dirty local repositories must still require confirmation",
);
assert.equal(confirmations, 1);
localResult = { code: 0, stdout: "", stderr: "", killed: false };
assert.equal(await localHandlers.get("session_before_fork")[0]({ position: "at" }, ctx), undefined);

localResult = { code: 128, stdout: "", stderr: "fatal: repository inspection failed", killed: false };
assert.deepEqual(
	await localHandlers.get("session_before_switch")[0]({ reason: "new" }, ctx),
	{ cancel: true },
	"Git failures inside a repository must fail closed",
);
localResult = { code: 128, stdout: "", stderr: "fatal: not a git repository", killed: false };
const nonRepoRoot = path.join(path.parse(process.cwd()).root, "pi-kit-definitely-not-a-repository");
assert.equal(
	await localHandlers.get("session_before_switch")[0]({ reason: "new" }, { ...ctx, cwd: nonRepoRoot }),
	undefined,
	"Directories with no Git marker in their ancestry should remain allowed",
);
localResult = { code: 1, stdout: "", stderr: "", killed: true };
assert.deepEqual(
	await localHandlers.get("session_before_switch")[0]({ reason: "new" }, { ...ctx, cwd: nonRepoRoot }),
	{ cancel: true },
	"Timed out or cancelled inspections must fail closed even without a visible Git marker",
);

console.log("test:session-extensions ok");
