#!/usr/bin/env node
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import verification from "../extensions/verification/index.ts";

function fixture(manager = SessionManager.inMemory(process.cwd())) {
	const handlers = new Map(); const commands = new Map(); const messages = []; const statuses = new Map();
	let idle = true; let failWrites = false;
	const ctx = { cwd: process.cwd(), sessionManager: manager, isIdle: () => idle,
		ui: { notify(message, type) { messages.push({ message, type }); }, setStatus(name, value) { statuses.set(name, value); } } };
	verification({
		on(name, handler) { handlers.set(name, handler); }, registerCommand(name, value) { commands.set(name, value); },
		appendEntry(type, data) { if (failWrites) throw new Error("fixture save failure"); manager.appendCustomEntry(type, data); },
		exec() { throw new Error("Verification must never execute commands"); },
	});
	const emit = async (name, event = {}) => handlers.get(name)?.(event, ctx);
	const command = async (input = "") => commands.get("verify").handler(input, ctx);
	const report = async () => { await command(); return messages.at(-1).message; };
	const start = (id, name, input) => emit("tool_execution_start", { toolCallId: id, toolName: name, args: input });
	const end = async (id, name, result = {}, isError = false) => emit("tool_execution_end", { toolCallId: id, toolName: name, result, isError });
	const run = async (cmd = "npm test", code = 0, isError = false, id = "check") => {
		await start(id, "bash", { command: cmd });
		await emit("tool_result", { toolCallId: id, toolName: "bash", input: { command: cmd } });
		await end(id, "bash", { content: [{ type: "text", text: "PRIVATE_STDOUT: all tests passed" }], structuredContent: { exit_code: code } }, isError);
	};
	const data = () => manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "pi-kit.verification").at(-1)?.data;
	return { manager, messages, statuses, emit, command, report, start, end, run, data, setIdle(value) { idle = value; }, setWriteFailure(value) { failWrites = value; } };
}

const f = fixture();
await f.emit("session_start"); assert.equal(f.data(), undefined);
const options = { sections: { other: "keep" } };
await f.emit("before_agent_start", { systemPromptOptions: options });
assert.deepEqual(options.sections, { other: "keep" });
await f.emit("agent_settled"); assert.equal(f.messages.length, 0);
await f.command("add npm test");
assert.deepEqual(f.data().commands, ["npm test"]); assert.equal(f.data().runs.length, 0);
const initial = f.data(); const initialJson = JSON.stringify(initial);
await f.command("add npm test"); assert.equal(f.data(), initial);
assert.match(await f.report(), /未运行/);
await f.emit("before_agent_start", { systemPromptOptions: options });
assert.match(options.sections.pi_kit_verification, /not execution authorization/); assert.equal(options.sections.other, "keep");

f.manager.appendCustomEntry("pi-kit.session-environment", { version: 1, kind: "ssh", host: "fixture-host", cwd: "/srv/project" });
await f.run();
assert.match(await f.report(), /通过\(退出码0\)/); assert.equal(f.statuses.get("verification"), "verify 1/1");
assert.equal(f.data().runs[0].target, "SSH fixture-host:/srv/project");
assert.equal(JSON.stringify(initial), initialJson, "Never mutate previously persisted branch state");
assert.doesNotMatch(JSON.stringify(f.data()), /PRIVATE_STDOUT/, "Do not duplicate tool output into evidence");
await f.run("npm test", 1, false); assert.match(await f.report(), /失败/);
await f.run("npm test", 0, true); assert.match(await f.report(), /失败/);
await f.run("npm test", "0", false); assert.match(await f.report(), /结果未知/);
await f.start("no-structure", "bash", { command: "npm test" });
await f.end("no-structure", "bash", { content: [{ type: "text", text: "all tests passed" }] });
assert.match(await f.report(), /结果未知/);
await f.start("blocked", "bash", { command: "npm test" }); await f.end("blocked", "bash", {}, true);
assert.match(await f.report(), /失败/);

await f.run();
const beforeInspection = f.data().revision;
await f.start("inspect", "bash", { command: "git diff --check" }); await f.end("inspect", "bash");
await f.start("read", "read", { path: "file.txt" }); await f.end("read", "read");
assert.equal(f.data().revision, beforeInspection);
assert.match(await f.report(), /通过\(退出码0\)/);
await f.start("write", "write", { path: "file.txt", content: "new" });
assert.match(await f.report(), /已过期/);
await f.end("write", "write", {}, true); assert.match(await f.report(), /已过期/, "Failed writes can have partial effects");
const staleEntries = f.manager.getEntries().length;
for (let n = 0; n < 10; n++) { await f.start(`edit-${n}`, "edit", {}); await f.end(`edit-${n}`, "edit"); }
assert.equal(f.manager.getEntries().length, staleEntries, "Do not duplicate full stale snapshots for each file edit");

// Check starting before, during, or ending before a mutation is never fresh.
await f.start("parent/1", "bash", { command: "npm test" });
await f.start("edit", "edit", {}); await f.end("edit", "edit");
await f.end("parent/1", "bash", { structuredContent: { exit_code: 0 } });
assert.match(await f.report(), /已过期/);
await f.start("edit", "edit", {}); await f.start("parent/2", "bash", { command: "npm test" });
await f.end("parent/2", "bash", { structuredContent: { exit_code: 0 } });
await f.end("edit", "edit"); assert.match(await f.report(), /已过期/);
await f.run();
await f.start("other-shell", "bash", { command: "npm run format" }); await f.end("other-shell", "bash");
assert.match(await f.report(), /已过期/);
await f.run();
await f.start("unknown", "mcp__server__update", {}); await f.end("unknown", "mcp__server__update");
assert.match(await f.report(), /已过期/);
await f.run(); await f.emit("user_bash", { command: "pwd" }); assert.match(await f.report(), /已过期/);
await f.run(); await f.emit("message_end", { message: { role: "bashExecution" } }); assert.match(await f.report(), /已过期/);

await f.command("add npm run lint");
await f.start("one", "bash", { command: "npm test" }); await f.start("two", "bash", { command: "npm run lint" });
assert.match(await f.report(), /运行中/);
await f.end("two", "bash", { structuredContent: { exit_code: 0 } }); await f.end("one", "bash", { structuredContent: { exit_code: 0 } });
assert.equal(f.statuses.get("verification"), "verify 2/2");
const noticeCount = f.messages.length; await f.emit("agent_settled"); assert.equal(f.messages.length, noticeCount);

// Command mutation in another extension cannot credit the original request.
await f.start("rewritten", "bash", { command: "npm test" });
await f.emit("tool_result", { toolCallId: "rewritten", input: { command: "npm run format" } });
await f.start("concurrent", "bash", { command: "npm run lint" });
await f.end("concurrent", "bash", { structuredContent: { exit_code: 0 } });
await f.end("rewritten", "bash", { structuredContent: { exit_code: 0 } });
assert.match(await f.report(), /已过期/);

f.setIdle(false); const beforeBusy = f.data(); await f.command("reset"); assert.equal(f.data(), beforeBusy); f.setIdle(true);
await f.run();
const restored = fixture(f.manager); await restored.emit("session_start");
assert.deepEqual(restored.data().commands, ["npm test", "npm run lint"]);
assert.match(await restored.report(), /已过期/, "A restored session does not restore workspace files");
await restored.run(); await restored.emit("agent_settled"); assert.match(restored.messages.at(-1).message, /验收尚未全部通过/);
await restored.command("reset");
assert.deepEqual(restored.data().commands, []);
await restored.emit("before_agent_start", { systemPromptOptions: options }); assert.equal(options.sections.pi_kit_verification, undefined);

const branch = fixture(); await branch.emit("session_start"); await branch.command("add npm test");
const forkPoint = branch.manager.getLeafId();
await branch.command("add npm run lint"); await branch.run();
await branch.start("late", "bash", { command: "npm test" });
branch.manager.branch(forkPoint); await branch.emit("session_tree");
await branch.end("late", "bash", { structuredContent: { exit_code: 0 } });
assert.deepEqual(branch.data().commands, ["npm test"]); assert.deepEqual(branch.data().runs, []);

for (const invalid of [
	{ version: 2 }, { version: 1, commands: ["npm test"], revision: 0, runs: [{ command: "npm test", exitCode: 0 }] },
	{ version: 1, commands: ["npm test"], revision: 0, runs: [{ command: "npm test", toolCallId: "future", target: "LOCAL fixture",
		startedAt: 0, finishedAt: 1, revision: 1, overlapped: false, exitCode: 0, isError: false }] },
]) {
	const bad = fixture(); bad.manager.appendCustomEntry("pi-kit.verification", invalid);
	await bad.emit("session_start"); assert.match(await bad.report(), /损坏或版本不支持/);
	await bad.emit("before_agent_start", { systemPromptOptions: options }); assert.match(options.sections.pi_kit_verification, /unavailable/);
	await bad.command("add npm test"); assert.equal(bad.data(), invalid);
	await bad.command("reset"); await bad.command("add npm test"); assert.deepEqual(bad.data().commands, ["npm test"]);
}
const bounded = fixture(); await bounded.emit("session_start");
await bounded.command(`add ${"x".repeat(1001)}`); assert.equal(bounded.data(), undefined);
for (let n = 0; n < 13; n++) await bounded.command(`add check-${n}`);
assert.equal(bounded.data().commands.length, 12);
const failedSave = fixture(); await failedSave.emit("session_start"); await failedSave.command("add npm test");
failedSave.setWriteFailure(true);
await assert.rejects(() => failedSave.run(), /fixture save failure/);
assert.match(await failedSave.report(), /保存失败/);
assert.equal(failedSave.statuses.get("verification"), "verify: 状态错误");
await failedSave.emit("before_agent_start", { systemPromptOptions: options }); assert.match(options.sections.pi_kit_verification, /unavailable/);
console.log("test:verification ok (no commands executed, no model calls)");
