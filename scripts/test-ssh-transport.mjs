#!/usr/bin/env node
// No SSH process or network connection is started: every spawn is controlled here.
import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { mock } from "node:test";
import { SshClient } from "../extensions/ssh-remote/transport.ts";

const originalSpawn = cp.spawn;
const children = [];
const attempts = [];
let active = 0;
let peak = 0;
let now = 0;
const flush = () => new Promise((resolve) => setImmediate(resolve));
mock.method(performance, "now", () => now);
mock.timers.enable({ apis: ["setTimeout"] });
const tick = (ms) => { now += ms; mock.timers.tick(ms); };
cp.spawn = (binary, args, options) => {
	assert.equal(binary, "ssh", "No real subprocesses are allowed in transport tests");
	assert.deepEqual(args.slice(0, -2), ["-T", "-o", "BatchMode=yes", "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=10", "-o", "LogLevel=ERROR"]);
	assert.deepEqual(options, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	const command = args.at(-1);
	attempts.push(command);
	if (command === "spawn-throws") throw new Error("mock spawn failed");
	const child = new EventEmitter();
	Object.assign(child, { command, target: args.at(-2), closed: false, kills: 0, input: [] });
	child.stdout = new PassThrough(); child.stderr = new PassThrough();
	child.stdin = new Writable({ write(chunk, _encoding, callback) { child.input.push(Buffer.from(chunk)); callback(); } });
	child.kill = () => { child.kills++; return true; };
	child.close = (code = 0, stdout = "", stderr = "") => {
		assert.equal(child.closed, false, "A child closes only once");
		child.closed = true; active--;
		child.stdout.end(stdout); child.stderr.end(stderr); child.emit("close", code);
	};
	children.push(child); active++; peak = Math.max(peak, active);
	return child;
};
syncBuiltinESMExports();
const client = new SshClient("fixture");
const run = (command, options) => client.run(command, options);
const open = () => children.filter((child) => !child.closed);
const childFor = (command) => children.find((child) => child.command === command);
async function finishAll() {
	for (;;) {
		const count = children.length;
		for (const child of open()) child.close();
		await flush();
		if (children.length === count && active === 0) break;
	}
}
function blockers(prefix) {
	return Array.from({ length: 5 }, (_, i) => run(`${prefix}-${i}`));
}

try {
	// Two clients share one runtime budget, including differently named targets.
	const other = new SshClient("other-fixture");
	const jobs = Array.from({ length: 20 }, (_, i) => (i % 2 ? other : client).run(`batch-${i}`));
	const initiallyStarted = children.length;
	await finishAll();
	await Promise.all(jobs);
	assert.equal(initiallyStarted, 5, "20 requests must start only five SSH children");
	assert.equal(peak, 5, "The active SSH process count must never exceed five");
	assert.deepEqual(children.map((child) => child.command), Array.from({ length: 20 }, (_, i) => `batch-${i}`), "Queued requests start FIFO");
	assert.equal(attempts.length, 20, "No command is retried");

	const preAborted = new AbortController(); preAborted.abort();
	const beforeAbort = attempts.length;
	await assert.rejects(run("already-aborted", { signal: preAborted.signal }), /Operation aborted/);
	assert.equal(attempts.length, beforeAbort);

	// A cancelled waiter disappears without starting a process or blocking its successor.
	const held = blockers("queue-abort");
	const abort = new AbortController();
	const cancelled = assert.rejects(run("cancelled-waiter", { signal: abort.signal }), /Operation aborted/);
	const survivor = run("after-cancelled-waiter");
	abort.abort(); await cancelled;
	assert.equal(getEventListeners(abort.signal, "abort").length, 0);
	assert.equal(childFor("cancelled-waiter"), undefined);
	childFor("queue-abort-0").close(); await flush();
	assert.ok(childFor("after-cancelled-waiter"));
	await finishAll(); await Promise.all([...held, survivor]);

	// Queue wait consumes the timeout, and a timed-out request must never launch later.
	const timedHeld = blockers("queue-timeout");
	const waitingTimeout = assert.rejects(run("expired-waiter", { timeoutSeconds: 1 }), /SSH operation timed out after 1s/);
	tick(1000); await waitingTimeout;
	assert.equal(childFor("expired-waiter"), undefined);
	await finishAll(); await Promise.all(timedHeld);
	assert.equal(attempts.includes("expired-waiter"), false);

	// A partly spent queue deadline is not reset when the process finally starts.
	const budgetHeld = blockers("budget");
	const budgetTimeout = assert.rejects(run("shared-budget", { timeoutSeconds: 1 }), /SSH operation timed out after 1s/);
	const afterBudget = run("after-budget");
	tick(400); childFor("budget-0").close(); await flush();
	const budgetChild = childFor("shared-budget"); assert.ok(budgetChild);
	tick(599); assert.equal(budgetChild.kills, 0);
	tick(1); assert.equal(budgetChild.kills, 1);
	assert.equal(childFor("after-budget"), undefined, "Timeout must retain its slot until the child closes");
	budgetChild.close(255); await budgetTimeout; await flush();
	assert.ok(childFor("after-budget"));
	await finishAll(); await Promise.all([...budgetHeld, afterBudget]);

	// Event-loop delay cannot cause a request with an expired deadline to launch.
	const lateHeld = blockers("late-deadline");
	const lateTimeout = assert.rejects(run("late-expired", { timeoutSeconds: 1 }), /SSH operation timed out after 1s/);
	now += 1001; childFor("late-deadline-0").close(); await flush(); await lateTimeout;
	assert.equal(childFor("late-expired"), undefined);
	await finishAll(); await Promise.all(lateHeld);

	// Cancelling an active process does not release a sixth slot while SSH still lives.
	const activeAbort = new AbortController();
	const activeCancelled = assert.rejects(run("active-cancel", { signal: activeAbort.signal }), /Operation aborted/);
	const activePeers = Array.from({ length: 4 }, (_, i) => run(`active-peer-${i}`));
	const afterActive = run("after-active-cancel");
	activeAbort.abort();
	assert.equal(childFor("active-cancel").kills, 1);
	assert.equal(childFor("after-active-cancel"), undefined);
	childFor("active-cancel").close(null); await activeCancelled; await flush();
	assert.equal(getEventListeners(activeAbort.signal, "abort").length, 0);
	assert.ok(childFor("after-active-cancel"));
	await finishAll(); await Promise.all([...activePeers, afterActive]);

	// A synchronous spawn failure, emitted spawn error, or stdin failure cannot leak slots.
	await assert.rejects(run("spawn-throws"), /Failed to start SSH: mock spawn failed/);
	const failedStart = assert.rejects(run("spawn-error"), /Failed to start SSH: mock ENOENT/);
	const errorPeers = Array.from({ length: 4 }, (_, i) => run(`error-peer-${i}`));
	const afterError = run("after-spawn-error");
	childFor("spawn-error").emit("error", new Error("mock ENOENT")); await failedStart;
	assert.equal(childFor("after-spawn-error"), undefined, "Even emitted errors wait for close before releasing capacity");
	childFor("spawn-error").close(-2); await flush();
	await finishAll(); await Promise.all([...errorPeers, afterError]);
	const stdinFailed = assert.rejects(run("stdin-error"), /mock stdin failure/);
	childFor("stdin-error").stdin.emit("error", Object.assign(new Error("mock stdin failure"), { code: "ECONNRESET" }));
	await stdinFailed; assert.equal(childFor("stdin-error").kills, 1);
	childFor("stdin-error").close(255); await flush();

	// Original output, input, exit-code, streaming and failure semantics are retained.
	const input = Buffer.from("exact UTF-8 input: 中文\n");
	const payload = run("payload", { input });
	assert.deepEqual(Buffer.concat(childFor("payload").input), input);
	childFor("payload").close(0, "stdout\n", "stderr\n");
	assert.deepEqual(await payload, { exitCode: 0, stdout: Buffer.from("stdout\n"), stderr: Buffer.from("stderr\n") });
	const streamed = [];
	const stream = run("stream", { collectOutput: false, onData: (data) => streamed.push(data.toString()) });
	childFor("stream").close(0, "stream-out", "stream-err");
	assert.deepEqual(await stream, { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
	assert.deepEqual(streamed, ["stream-out", "stream-err"]);
	const allowed = run("allowed-exit", { allowedExitCodes: "any" }); childFor("allowed-exit").close(7);
	assert.equal((await allowed).exitCode, 7);
	const failed = assert.rejects(run("write-once"), /SSH fixture: connection reset fixture/);
	childFor("write-once").close(255, "", "connection reset fixture"); await failed;
	assert.equal(attempts.filter((command) => command === "write-once").length, 1);
	const pipe = assert.rejects(run("epipe"), /SSH fixture: original SSH failure/);
	childFor("epipe").stdin.emit("error", Object.assign(new Error("pipe closed"), { code: "EPIPE" }));
	childFor("epipe").close(255, "", "original SSH failure"); await pipe;
	const overflow = assert.rejects(run("overflow", { maxOutputBytes: 3 }), /SSH output exceeded/);
	childFor("overflow").stdout.write("four"); assert.equal(childFor("overflow").kills, 1);
	childFor("overflow").close(255); await overflow;
	const callback = assert.rejects(run("callback-error", { onData() { throw new Error("mock callback failure"); } }), /mock callback failure/);
	childFor("callback-error").stdout.write("data"); await callback;
	assert.equal(childFor("callback-error").kills, 1); childFor("callback-error").close(255);
	await flush();
	assert.equal(active, 0); assert.equal(peak, 5);
	console.log("test:ssh-transport ok: shared five-process FIFO limit, queue/active aborts, total deadlines, close-only release, failures, immutable I/O and no retries (no network)");
} finally {
	// Drain while the mock is still installed: cleanup must never launch real SSH.
	await finishAll();
	cp.spawn = originalSpawn; syncBuiltinESMExports(); mock.restoreAll(); mock.timers.reset();
}
