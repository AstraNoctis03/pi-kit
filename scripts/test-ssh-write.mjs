#!/usr/bin/env node
// Exercise actual Bash/coreutils against disposable local fixtures, never an SSH server.
// Windows needs an existing WSL distro for real Unix metadata/link semantics.
// Other Windows hosts still run the mocked SSH cwd and actual-host SDK suites.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import sshRemote from "../extensions/ssh-remote/index.ts";
import { quoteShell, SshClient } from "../extensions/ssh-remote/transport.ts";

let binary = "bash"; let prefix = [];
if (process.platform === "win32") {
	const probe = spawnSync("wsl.exe", ["--exec", "sh", "-c", "test -x /usr/bin/bash && test -x /usr/bin/sha256sum"], { timeout: 20000, windowsHide: true });
	if (probe.status !== 0) {
		console.log("test:ssh-write skipped: no Linux/WSL filesystem; Unix cases run in Ubuntu CI (Windows mocked SSH suites remain enabled)");
		process.exit(0);
	}
	binary = "wsl.exe"; prefix = ["--exec", "bash"];
}
function local(command, { input = Buffer.alloc(0), signal, half } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, [...prefix, "-c", command], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		const out = []; const err = []; let injectionError;
		child.stdout.on("data", (chunk) => out.push(chunk)); child.stderr.on("data", (chunk) => err.push(chunk));
		const stop = () => { child.stdin.destroy(); child.kill(); };
		const timer = setTimeout(stop, 20000);
		signal?.addEventListener("abort", stop, { once: true });
		child.on("error", (error) => { clearTimeout(timer); signal?.removeEventListener("abort", stop); reject(error); });
		child.on("close", (code) => {
			clearTimeout(timer); signal?.removeEventListener("abort", stop);
			const result = { exitCode: code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
			if (injectionError) reject(injectionError);
			else if (signal?.aborted) reject(new Error("Operation aborted"));
			else if (code !== 0) reject(new Error(result.stderr.toString() || `Local fixture exited ${code}`));
			else resolve(result);
		});
		child.stdin.on("error", (error) => { if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") injectionError = error; });
		const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
		if (!half) child.stdin.end(data);
		else {
			const split = Math.floor(data.length / 2);
			child.stdin.write(data.subarray(0, split));
			Promise.resolve().then(half).then(() => {
				if (!signal?.aborted) child.stdin.end(data.subarray(split));
			}).catch((error) => { injectionError = error; stop(); });
		}
	});
}
const root = (await local("mktemp -d /tmp/pi-kit-write-XXXXXXXX")).stdout.toString().trim();
assert.match(root, /^\/tmp\/pi-kit-write-[A-Za-z0-9]+$/);
const originalRun = SshClient.prototype.run;
let transform = (buffer) => buffer; let half; let commandPrefix = ""; let loseReceipt = false;
let uploads = 0;
const inFlight = new Set(); const signals = [];
SshClient.prototype.run = async function(command, options = {}) {
	if (command.includes("remote_hostname=")) return { exitCode: 0, stdout: Buffer.from([root, "/home/fixture", "fixture", "1", ""].join("\0")), stderr: Buffer.alloc(0) };
	const data = options.input === undefined ? undefined : transform(Buffer.from(options.input));
	if (data !== undefined) { signals.push(options.signal); uploads++; }
	const operation = local(`${data === undefined ? "" : commandPrefix}${command}`, { input: data, signal: options.signal, half: data === undefined ? undefined : half });
	inFlight.add(operation);
	try {
		const result = await operation;
		if (data !== undefined && loseReceipt) throw new Error("Simulated SSH connection lost after commit");
		return result;
	} finally { inFlight.delete(operation); }
};
const tools = new Map(); const handlers = new Map();
const manager = SessionManager.inMemory(process.cwd());
const ctx = { cwd: process.cwd(), sessionManager: manager, ui: { theme: { fg: (_color, text) => text }, setStatus() {}, notify() {} } };
sshRemote({
	registerFlag() {}, getFlag: () => `fixture:${root}`, registerCommand() {},
	on(name, handler) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
	registerTool(tool) { tools.set(tool.name, tool); },
	appendEntry(type, data) { manager.appendCustomEntry(type, data); },
	getSessionName: () => manager.getSessionName(), setSessionName(name) { manager.appendSessionInfo(name); },
});
const q = quoteShell; const file = (name) => `${root}/${name}`;
const seed = (name, content) => local(`cat > ${q(file(name))}`, { input: Buffer.from(content) });
const read = async (name) => (await local(`cat -- ${q(file(name))}`)).stdout;
const write = (name, content, signal) => tools.get("write").execute("write-fixture", { path: file(name), content }, signal, undefined, ctx);
const clean = async () => assert.equal((await local(`find ${q(root)} -maxdepth 1 -name '.pi-write-*' -print`)).stdout.toString(), "", "Staging directories must be removed after handled failures");
async function staged() {
	for (let attempt = 0; attempt < 40; attempt++) {
		if ((await local(`find ${q(root)} -maxdepth 2 -path '*/.pi-write-*/data' -print`)).stdout.length) {
			assert.equal((await local(`find ${q(root)} -maxdepth 1 -name '.pi-write-*' -printf '%m\\n'`)).stdout.toString(), "700\n", "Partial uploads must remain private");
			return;
		}
		await delay(25);
	}
	throw new Error("Writer never staged its input");
}
try {
	for (const handler of handlers.get("session_start")) await handler({}, ctx);
	await seed("target", "ORIGINAL_COMPLETE\n");
	const originalStat = (await local(`stat -c '%i:%a:%u:%g:%y:%z' -- ${q(file("target"))}`)).stdout;
	transform = (buffer) => buffer.subarray(0, Math.floor(buffer.length / 2));
	await assert.rejects(() => write("target", "REPLACEMENT_MUST_BE_COMPLETE\n"), /incomplete|integrity|checksum|size/i);
	assert.equal((await read("target")).toString(), "ORIGINAL_COMPLETE\n");
	assert.deepEqual((await local(`stat -c '%i:%a:%u:%g:%y:%z' -- ${q(file("target"))}`)).stdout, originalStat);
	await assert.rejects(() => write("never-created", "INCOMPLETE_NEW_FILE"), /incomplete|size/i);
	await local(`test ! -e ${q(file("never-created"))}`); await clean();
	transform = (buffer) => { const copy = Buffer.from(buffer); copy[0] ^= 1; return copy; };
	await assert.rejects(() => write("target", "SAME_LENGTH_CORRUPTED\n"), /checksum/i);
	assert.equal((await read("target")).toString(), "ORIGINAL_COMPLETE\n"); await clean();
	transform = (buffer) => buffer;

	const content = "完整 UTF-8\0 with CRLF\r\nlast line\n";
	await local(`chmod 751 -- ${q(file("target"))}; touch -t 200001010000 -- ${q(file("target"))}`);
	const attrs = (await local(`stat -c '%a:%u:%g' -- ${q(file("target"))}`)).stdout;
	const controller = new AbortController();
	await write("target", content, controller.signal);
	assert.equal(signals.at(-1), controller.signal, "Write must pass its own cancellation signal to SSH");
	assert.equal((await read("target")).toString(), content);
	assert.deepEqual((await local(`stat -c '%a:%u:%g' -- ${q(file("target"))}`)).stdout, attrs);
	assert.ok(Number((await local(`stat -c '%Y' -- ${q(file("target"))}`)).stdout.toString()) > 946684800, "Do not preserve obsolete modification times");
	await write("target", ""); assert.equal((await read("target")).length, 0);
	commandPrefix = "umask 027; ";
	await write("new-file", content);
	assert.equal((await read("new-file")).toString(), content);
	assert.equal((await local(`stat -c '%a' -- ${q(file("new-file"))}`)).stdout.toString().trim(), "640");
	commandPrefix = "";

	for (const utility of ["cat", "cp", "mv"]) {
		const bin = file(`fail-${utility}`);
		await local(`mkdir -- ${q(bin)}; printf '%s\\n' '#!/usr/bin/env bash' 'printf "injected ${utility} failure\\n" >&2' 'exit 1' > ${q(`${bin}/${utility}`)}; chmod 700 -- ${q(`${bin}/${utility}`)}`);
		commandPrefix = `PATH=${q(bin)}:$PATH `;
		await seed("target", "STILL_COMPLETE\n");
		await assert.rejects(() => write("target", content), new RegExp(`injected ${utility} failure`));
		assert.equal((await read("target")).toString(), "STILL_COMPLETE\n"); await clean();
	}
	commandPrefix = "";
	const limited = file("missing-utility");
	await local(`mkdir -- ${q(limited)}; for utility in bash realpath stat mktemp cat wc cp mv rm rmdir; do ln -s "$(command -v "$utility")" ${q(limited)}/"$utility"; done`);
	commandPrefix = `PATH=${q(limited)} `;
	await assert.rejects(() => write("target", content), /Required remote utility missing: sha256sum/i);
	assert.equal((await read("target")).toString(), "STILL_COMPLETE\n"); await clean();
	commandPrefix = "";

	{
		const uid = (await local("id -u")).stdout.toString().trim();
		await seed("write-only", "OLD"); await local(`chmod 200 -- ${q(file("write-only"))}`);
		// GNU cp opens the source even with --attributes-only. Never chmod the
		// original or discard its ACL/xattrs just to accommodate a write-only file.
		if (uid !== "0") await assert.rejects(() => write("write-only", content), /must be readable/i);
		assert.equal((await local(`stat -c '%a' -- ${q(file("write-only"))}`)).stdout.toString().trim(), "200");
		await local(`chmod 600 -- ${q(file("write-only"))}`);
		assert.equal((await read("write-only")).toString(), "OLD");
		await write("quote'名.txt", content); assert.equal((await read("quote'名.txt")).toString(), content);
		await local(`ln -s target -- ${q(file("link"))}; ln -s link -- ${q(file("chain"))}`);
		const linkInode = (await local(`stat -c '%i' -- ${q(file("link"))}`)).stdout;
		await write("chain", content);
		assert.equal((await read("target")).toString(), content);
		assert.deepEqual((await local(`stat -c '%i' -- ${q(file("link"))}`)).stdout, linkInode);
		assert.equal((await local(`readlink -- ${q(file("link"))}`)).stdout.toString(), "target\n");
		await local(`ln -s missing-target -- ${q(file("dangling"))}`);
		await write("dangling", content); assert.equal((await read("missing-target")).toString(), content);
		assert.equal((await local(`readlink -- ${q(file("dangling"))}`)).stdout.toString(), "missing-target\n");

		const odd = "dir'\n层 /last\n";
		await local(`mkdir -- ${q(file("dir'\n层 "))}`); await seed(odd, "OLD");
		await local(`ln -s ${q(odd)} -- ${q(file("odd-link"))}`);
		await write("odd-link", content); assert.equal((await read(odd)).toString(), content);

		await local(`ln -- ${q(file("target"))} ${q(file("hardlink"))}`);
		await assert.rejects(() => write("target", "NEW"), /hard.link/i);
		assert.equal((await read("hardlink")).toString(), content);
		await local(`rm -- ${q(file("hardlink"))}; chmod 444 -- ${q(file("target"))}`);
		if (uid !== "0") {
			await assert.rejects(() => write("target", "NEW"), /not writable/i);
			assert.equal((await read("target")).toString(), content);
		}
		await local(`mkdir -- ${q(file("no-replace-permission"))}`);
		await seed("no-replace-permission/child", "OLD");
		await local(`chmod 500 -- ${q(file("no-replace-permission"))}`);
		if (uid !== "0") await assert.rejects(() => write("no-replace-permission/child", content), /Permission denied/i);
		assert.equal((await read("no-replace-permission/child")).toString(), "OLD");
		await local(`chmod 700 -- ${q(file("no-replace-permission"))}`);
		await local(`chmod 751 -- ${q(file("target"))}; mkdir -- ${q(file("directory"))}; mkfifo -- ${q(file("fifo"))}`);
		for (const name of ["directory", "fifo"]) await assert.rejects(() => write(name, "NEW"), /non.regular/i);

		// Release EOF only after another process changes the original file/path.
		half = async () => { await staged(); await seed("target", "EXTERNAL_CHANGE"); };
		await assert.rejects(() => write("target", content), /changed/i);
		assert.equal((await read("target")).toString(), "EXTERNAL_CHANGE"); await clean();
		await seed("second-target", "SECOND");
		half = async () => { await staged(); await local(`ln -sfn second-target -- ${q(file("link"))}`); };
		await assert.rejects(() => write("link", content), /changed/i);
		assert.equal((await read("second-target")).toString(), "SECOND");
		assert.equal((await read("target")).toString(), "EXTERNAL_CHANGE"); await clean();
		half = async () => { await staged(); await seed("concurrent-new", "CREATED_ELSEWHERE"); };
		await assert.rejects(() => write("concurrent-new", content), /appeared/i);
		assert.equal((await read("concurrent-new")).toString(), "CREATED_ELSEWHERE"); await clean();

		half = undefined;
	}

	await seed("edit-target", "\ufeffold line\r\nkeep line\r\n");
	transform = (buffer) => buffer.subarray(0, 3);
	const edit = (signal) => tools.get("edit").execute("edit-fixture", { path: file("edit-target"), edits: [{ oldText: "old line", newText: "new line" }] }, signal, undefined, ctx);
	await assert.rejects(() => edit(), /incomplete|size/i);
	assert.equal((await read("edit-target")).toString(), "\ufeffold line\r\nkeep line\r\n"); await clean();
	transform = (buffer) => buffer;
	const editController = new AbortController();
	await edit(editController.signal);
	assert.equal(signals.at(-1), editController.signal);
	assert.equal((await read("edit-target")).toString(), "\ufeffnew line\r\nkeep line\r\n"); await clean();
	await seed("lost-receipt", "OLD");
	loseReceipt = true;
	const beforeReceipt = uploads;
	await assert.rejects(() => write("lost-receipt", content), /connection lost after commit/i);
	assert.equal(uploads, beforeReceipt + 1, "Never automatically retry an ambiguous commit");
	assert.equal((await read("lost-receipt")).toString(), content, "A lost receipt may leave a complete new version, never a partial one");
	loseReceipt = false; await clean();

	const abort = new AbortController();
	half = async () => { await staged(); abort.abort(); };
	await assert.rejects(() => write("target", content, abort.signal), /aborted/i);
	await Promise.allSettled([...inFlight]);
	assert.equal(signals.at(-1), abort.signal);
	assert.equal((await read("target")).toString(), "EXTERNAL_CHANGE");
	// Killing the local transport does not prove the remote EXIT trap ran.
	// Unlike handled failures above, a hard disconnect may leave private residue.
	const remnants = (await local(`find ${q(root)} -ignore_readdir_race -maxdepth 1 -name '.pi-write-*' -printf '%m\\n'`)).stdout.toString().trim();
	for (const mode of remnants.split("\n").filter(Boolean)) assert.equal(mode, "700", "Interrupted staging must remain private");
	console.log("test:ssh-write ok (Linux/WSL real filesystem; no SSH connection)");
} finally {
	SshClient.prototype.run = originalRun;
	await Promise.allSettled([...inFlight]);
	await local(`rm -rf -- ${q(root)}`);
}
