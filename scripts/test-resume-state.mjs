#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResumeStateStore, matchesArchiveView, sessionStateKey } from "../extensions/ssh-remote/resume-state.ts";

const root = mkdtempSync(path.join(tmpdir(), "pi-kit-resume-state-"));
try {
	const file = path.join(root, "resume-env-state.jsonl");
	const store = new ResumeStateStore(file);
	assert.deepEqual(await store.load(), { sort: "recent", archived: new Set() });
	const parent = { id: "parent", path: path.join(root, "parent.jsonl") };
	const child = { id: "child", path: path.join(root, "child.jsonl") };
	assert.equal(matchesArchiveView(false, "active"), true);
	assert.equal(matchesArchiveView(true, "active"), false);
	assert.equal(matchesArchiveView(true, "archived"), true);
	assert.equal(matchesArchiveView(false, "archived"), false);
	assert.equal(matchesArchiveView(true, "all"), true);
	assert.equal(matchesArchiveView(false, "all"), true);
	await store.setSort("threaded");
	assert.equal((await new ResumeStateStore(file).load()).sort, "threaded", "Sorting survives new instances/reloads");
	await store.setArchived(parent, true);
	let state = await new ResumeStateStore(file).load();
	assert.equal(state.archived.has(sessionStateKey(parent)), true);
	assert.equal(state.archived.has(sessionStateKey(child)), false, "Archiving a parent must not cascade");
	assert.equal(state.sort, "threaded", "Archiving must preserve the sort preference");
	await store.setSort("recent");
	state = await store.load();
	assert.equal(state.archived.has(sessionStateKey(parent)), true, "Sorting must preserve archives");
	await store.setArchived(parent, false);
	assert.equal((await store.load()).archived.has(sessionStateKey(parent)), false);
	assert.notEqual(sessionStateKey(parent), sessionStateKey({ ...parent, path: path.join(root, "copy.jsonl") }),
		"Copied/imported files sharing an id can be archived independently");

	const sessions = Array.from({ length: 12 }, (_, index) => ({ id: `session-${index}`, path: path.join(root, `session-${index}.jsonl`) }));
	await Promise.all(sessions.map((session) => new ResumeStateStore(file).setArchived(session, true)));
	state = await store.load();
	for (const session of sessions) assert.equal(state.archived.has(sessionStateKey(session)), true, "Concurrent independent updates must not overwrite each other");
	await Promise.all(sessions.filter((_, index) => index % 2 === 0).map((session) => new ResumeStateStore(file).setArchived(session, false)));
	state = await store.load();
	for (const [index, session] of sessions.entries()) assert.equal(state.archived.has(sessionStateKey(session)), index % 2 !== 0);

	const brokenFile = path.join(root, "broken.jsonl");
	writeFileSync(brokenFile, '{"version":1,"type":"archive"');
	const original = readFileSync(brokenFile, "utf8");
	const broken = new ResumeStateStore(brokenFile);
	await assert.rejects(() => broken.load(), /Invalid resume state/);
	await assert.rejects(() => broken.setSort("recent"), /refusing to reset archives/);
	assert.equal(readFileSync(brokenFile, "utf8"), original, "Corrupt state must not be silently discarded");
	writeFileSync(brokenFile, JSON.stringify({ version: 2, type: "sort", sort: "recent" }) + "\n");
	await assert.rejects(() => broken.load(), /Unsupported resume state/);

	const noNewline = path.join(root, "no-newline.jsonl");
	writeFileSync(noNewline, JSON.stringify({ version: 1, type: "sort", sort: "threaded" }));
	const repaired = await new ResumeStateStore(noNewline).setArchived(parent, true);
	assert.equal(repaired.sort, "threaded");
	assert.equal(repaired.archived.has(sessionStateKey(parent)), true, "Appending must preserve a valid record without its final newline");
} finally {
	rmSync(root, { recursive: true, force: true });
}
console.log("test:resume-state ok");
