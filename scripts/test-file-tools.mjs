#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateDiffString, initTheme, renderDiff } from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import { readRenderers, editRenderers, writeRenderers } from "../extensions/compact-tools/file-renderers.ts";

const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", entry));
const nativeTui = await import(pathToFileURL(createRequire(entry).resolve("@earendil-works/pi-tui")));
const themeModule = await import(new URL("./modes/interactive/theme/theme.js", entry));
const keys = new KeybindingsManager();
tui.setKeybindings(keys); nativeTui.setKeybindings(keys); initTheme("dark", false);
themeModule.setThemeInstance(themeModule.loadThemeFromPath(resolve("themes/pi-kit-tokyo-night.json"), "truecolor"));
const ctx = (args, flags = {}) => ({ args, expanded: false, isPartial: false, isError: false, showImages: true,
	executionStarted: true, argsComplete: true, outputPad: 1, durationMs: 1234, lastComponent: undefined, ...flags });
const output = (text, details) => ({ content: [{ type: "text", text }], details });
const result = (renderer, data, context) => renderer.renderResult(data, { expanded: context.expanded, isPartial: context.isPartial }, themeModule.theme, context);
const frame = (renderer, args, data, flags = {}, width = 100) => {
	const context = ctx(args, flags);
	return [...renderer.renderCall(args, themeModule.theme, context).render(width), ...result(renderer, data, context).render(width)];
};
const plain = (lines) => tui.stripTerminalSequences(lines.join("\n"));
const freeze = (value) => {
	if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
	return value;
};
const readArgs = freeze({ path: "/srv/project/文件.ts", offset: 10, limit: 20 });
const readData = freeze(output("const first = 1;\nconst second = 2;\nconst third = 3;\nconst fourth = 4;\n\nconst last = 6;\n"));
assert.match(plain(frame(readRenderers, readArgs, readData)), /✓ Read.*文件.ts.*L10–29.*1\.2s/);
assert.match(plain(frame(readRenderers, readArgs, readData)), /first.*\n.*second.*\n.*third/);
assert.doesNotMatch(plain(frame(readRenderers, readArgs, readData)), /fourth|last/);
assert.equal(plain(frame(readRenderers, readArgs, readData)).match(/ctrl\+o/g)?.length, 1);
assert.match(plain(frame(readRenderers, readArgs, readData, { expanded: true })), /fourth.*\n\s*\n.*last/);
assert.doesNotMatch(plain(frame(readRenderers, readArgs, readData, { expanded: true })), /ctrl\+o/);
for (const [args, expected] of [[{ path: "a", limit: 2 }, /L1–2/], [{ file_path: "old.ts", offset: 7 }, /old.ts.*L7/], [{ path: "a", offset: 0, limit: 2 }, /Read · a · 1\.2s/]]) {
	assert.match(plain(frame(readRenderers, args, output("one"))), expected);
}
const longPath = "/srv/" + "目录/".repeat(40) + "文件.ts";
assert.match(plain(frame(readRenderers, { path: longPath }, output("ok"))), /….*文件.ts/);
assert.equal(plain(frame(readRenderers, { path: longPath }, output("ok"))).match(/ctrl\+o/g)?.length, 1);
assert.ok(plain(frame(readRenderers, { path: longPath }, output("ok"), { expanded: true }, 500)).includes(longPath));
assert.match(plain(frame(readRenderers, readArgs, output("line\n"), { isPartial: true })), /◌ Read.*读取中/);
assert.match(plain(frame(editRenderers, { path: "a" }, output(""), { isPartial: true, executionStarted: false })), /准备中/);
assert.doesNotMatch(plain(frame(readRenderers, { path: "a" }, output(""), { durationMs: undefined })), /ms|\ds/);

const editArgs = freeze({ path: "/srv/project/a.ts", edits: [{ oldText: "PLANNED_OLD", newText: "PLANNED_NEW" }] });
const { diff } = generateDiffString("const actual = 1;\nkeep\n", "const actual = 2;\nkeep\n");
const editData = freeze(output("Successfully replaced text.", { diff, firstChangedLine: 1, patch: "not used as display diff" }));
const edited = frame(editRenderers, editArgs, editData);
assert.match(plain(edited), /✓ Edit.*a.ts/); assert.match(plain(edited), /\+1 −1/);
assert.match(plain(edited), /-1 const actual = 1;/); assert.match(plain(edited), /\+1 const actual = 2;/);
assert.doesNotMatch(plain(edited), /PLANNED_|Successfully replaced/);
for (const color of ["toolDiffAdded", "toolDiffRemoved"]) assert.ok(edited.join("").includes(themeModule.theme.getFgAnsi(color)));
if (renderDiff(diff).includes("\x1b[7m")) assert.ok(edited.join("").includes("\x1b[7m"), "Preserve native word-level inverse highlighting");
const many = generateDiffString(Array.from({ length: 30 }, (_, i) => `old-${i}`).join("\n"), Array.from({ length: 30 }, (_, i) => `new-${i}`).join("\n"));
assert.match(plain(frame(editRenderers, editArgs, output("done", many))), /\+30 −30/);
assert.doesNotMatch(plain(frame(editRenderers, editArgs, output("done", many))), /new-29/);
assert.match(plain(frame(editRenderers, editArgs, output("done", many), { expanded: true })), /new-29/);
assert.equal(plain(frame(editRenderers, editArgs, output("done", many))).match(/ctrl\+o/g)?.length, 1);
assert.match(plain(frame(editRenderers, editArgs, output("real fallback without diff"))), /real fallback without diff/);
assert.doesNotMatch(plain(frame(editRenderers, editArgs, output("real fallback without diff"))), /\+0|−0|Applied/);
assert.doesNotMatch(plain(frame(editRenderers, editArgs, editData, { isPartial: true })), /actual|\+1 −1/);

// Write previews the submitted argument after final success. It never invents
// a diff, byte/line counts or a read-back, and retains opaque original results.
const writeArgs = freeze({ path: "/srv/project/新建.ts", content: readData.content[0].text });
const writeData = freeze(output("OPAQUE_WRITE_ACK", { diff }));
const written = frame(writeRenderers, writeArgs, writeData);
assert.match(plain(written), /✓ Write.*新建.ts.*1\.2s/);
assert.match(plain(written), /const first = 1;.*\n.*const second = 2;.*\n.*const third = 3;/);
assert.doesNotMatch(plain(written), /fourth|last|OPAQUE_WRITE_ACK|\+1 −1|actual|bytes/);
assert.equal(plain(written).match(/ctrl\+o/g)?.length, 1);
const fullWrite = plain(frame(writeRenderers, writeArgs, writeData, { expanded: true }));
assert.match(fullWrite, /fourth.*\n\s*\n.*last/);
assert.ok(fullWrite.indexOf("OPAQUE_WRITE_ACK") > fullWrite.indexOf("last"));
assert.match(plain(frame(writeRenderers, writeArgs, writeData, { isPartial: true })), /◌ Write.*写入中/);
assert.doesNotMatch(plain(frame(writeRenderers, writeArgs, writeData, { isPartial: true })), /const first/);
assert.match(plain(frame(writeRenderers, writeArgs, writeData, { isPartial: true, executionStarted: false })), /准备中/);
assert.doesNotMatch(plain(frame(writeRenderers, writeArgs, output("WRITE_ERROR"), { isError: true, expanded: true })), /const first/);
for (const content of ["", undefined, null, 12]) {
	const empty = frame(writeRenderers, { path: "a.ts", content }, output("ORIGINAL_RESULT"));
	assert.match(plain(empty), /ORIGINAL_RESULT/); assert.doesNotMatch(plain(empty), /ctrl\+o|\+0|−0|bytes/);
}
assert.equal(result(writeRenderers, output(""), ctx({ path: "a.ts", content: "one\ntwo\nthree" })).render(100).length, 3, "No invented blank result row or expansion hint");
const unsafeWriteArgs = freeze({ path: "a.ts", content: "const SAFE = 1;\x1b]52;c;BAD\x07\x1b[2J\x1b[41m" });
assert.doesNotMatch(frame(writeRenderers, unsafeWriteArgs, output("ACK"), { expanded: true }).join(""), /BAD|\x1b\[2J|\x1b\[41m|\x1b\]52/);
assert.ok(unsafeWriteArgs.content.includes("\x1b]52"), "Sanitization must not change submitted bytes");
const reusedWrite = result(writeRenderers, writeData, ctx(writeArgs));
reusedWrite.render(100);
assert.equal(result(writeRenderers, writeData, ctx({ ...writeArgs, content: "const WRITE_UPDATED = 1;" }, { lastComponent: reusedWrite })), reusedWrite);
assert.match(plain(reusedWrite.render(100)), /WRITE_UPDATED/); assert.doesNotMatch(plain(reusedWrite.render(100)), /const first/);
assert.equal(result(writeRenderers, writeData, ctx(writeArgs, { lastComponent: reusedWrite, isPartial: true })), reusedWrite);
assert.doesNotMatch(plain(reusedWrite.render(100)), /WRITE_UPDATED|const first/);

const error = output("REAL_ERROR\nerror context\n\n\nCommand failed", { diff });
for (const renderer of [readRenderers, editRenderers, writeRenderers]) {
	const failed = frame(renderer, editArgs, error, { isError: true });
	assert.match(plain(failed), /✗ (Read|Edit|Write)/); assert.match(plain(failed), /REAL_ERROR/); assert.match(plain(failed), /error context/);
	assert.doesNotMatch(plain(failed), /actual|\+1 −1/);
	const longError = frame(renderer, editArgs, output(["FIRST_ERROR", ...Array(25).fill("middle"), "LAST_ERROR"].join("\n")), { isError: true });
	assert.match(plain(longError), /FIRST_ERROR.*\n.*middle.*\n.*…/); assert.match(plain(longError), /LAST_ERROR/);
	assert.equal(plain(longError).match(/ctrl\+o/g)?.length, 1);
	assert.match(plain(frame(renderer, editArgs, output("line", { truncation: { truncated: true } }))), /工具结果已截断/);
	const unsafe = frame(renderer, { path: "a\x1b]52;c;BAD\x07.ts" }, output("\x1b[2J\x1b]52;c;BAD\x07\x1b[41mSAFE\x1b[0m"));
	assert.match(plain(unsafe), /SAFE/); assert.doesNotMatch(unsafe.join(""), /BAD|\x1b\[2J|\x1b\[41m|\x1b\]52/);
}

// No local-file preview, even when the host cwd or a path resembles a local file.
const methods = ["access", "readFile", "stat", "open", "writeFile", "mkdir"];
const saved = methods.map((name) => [name, fs.promises[name]]);
let accesses = 0;
try {
	for (const name of methods) fs.promises[name] = async () => { accesses++; throw new Error("Forbidden renderer I/O"); };
	syncBuiltinESMExports();
	for (const [renderer, args, data] of [[readRenderers, readArgs, readData], [editRenderers, editArgs, editData], [writeRenderers, writeArgs, writeData]]) {
		for (const flags of [{ isPartial: true }, {}, { expanded: true }]) frame(renderer, args, data, flags);
	}
	await new Promise((done) => setImmediate(done));
	assert.equal(accesses, 0, "Rendering must not inspect the local filesystem");
} finally { for (const [name, method] of saved) fs.promises[name] = method; syncBuiltinESMExports(); }

// Inline image transport belongs to ToolExecutionComponent. The renderer keeps
// image blocks untouched and supplies the native fallback only when needed.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=";
const image = freeze({ content: [{ type: "image", mimeType: "image/png", data: png }] });
const caps = tui.getCapabilities();
try {
	const fallback = tui.imageFallback("image/png", { widthPx: 1, heightPx: 1 });
	tui.setCapabilities({ ...caps, images: null });
	const imageView = result(readRenderers, image, ctx({ path: "a.png" }));
	assert.ok(plain(imageView.render(100)).includes(fallback));
	const unsafeImage = { content: [{ type: "image", mimeType: "image/bad\x1b]52;c;INJECT\x07", data: "" }] };
	assert.doesNotMatch(frame(readRenderers, { path: "a.png" }, unsafeImage).join(""), /INJECT|\x1b\]52/);
	tui.setCapabilities({ ...caps, images: "iterm2" });
	assert.equal(imageView.render(100).length, 0, "Capability changes invalidate the cached image fallback");
	assert.ok(plain(frame(readRenderers, { path: "a.png" }, image, { showImages: false })).includes(fallback));
	assert.equal(result(readRenderers, image, ctx({ path: "a.png" })).render(100).length, 0, "Host draws images, not an extra empty text row");
	assert.equal(image.content[0].data, png);
} finally { tui.setCapabilities(caps); }

// Reuse, theme invalidation and remapped hints.
const reused = result(readRenderers, readData, ctx(readArgs));
assert.equal(result(readRenderers, output("const UPDATED = 1;"), ctx(readArgs, { lastComponent: reused })), reused);
assert.match(plain(reused.render(100)), /UPDATED/); assert.doesNotMatch(plain(reused.render(100)), /first/);
const other = themeModule.loadThemeFromPath(resolve("themes/pi-kit-tokyo-night.json"), "256color");
const firstStyle = reused.render(100).join("");
themeModule.setThemeInstance(other); reused.invalidate();
assert.notEqual(reused.render(100).join(""), firstStyle);
themeModule.setThemeInstance(themeModule.loadThemeFromPath(resolve("themes/pi-kit-tokyo-night.json"), "truecolor"));
const remapped = new KeybindingsManager({ "app.tools.expand": "ctrl+e" });
tui.setKeybindings(remapped); nativeTui.setKeybindings(remapped);
assert.match(plain(frame(readRenderers, readArgs, readData)), /ctrl\+e/);
assert.match(plain(frame(writeRenderers, writeArgs, writeData)), /ctrl\+e/);
tui.setKeybindings(keys); nativeTui.setKeybindings(keys);
for (const renderer of [readRenderers, editRenderers, writeRenderers]) for (const expanded of [false, true]) for (const outputPad of [0, 1]) {
	const args = { path: longPath + "\n😀 e\u0301.ts", content: "const 文本 = '汉字👨‍👩‍👧‍👦 e\u0301 " + "字".repeat(200) + "';" };
	const component = result(renderer, renderer === editRenderers ? editData : renderer === writeRenderers ? writeData : output("汉字👨‍👩‍👧‍👦 e\u0301 " + "字".repeat(200)), ctx(args, { expanded, outputPad }));
	const call = renderer.renderCall(args, themeModule.theme, ctx(args, { expanded, outputPad }));
	for (let width = 0; width <= 128; width++) for (const line of [...call.render(width), ...component.render(width)]) {
		assert.ok(tui.visibleWidth(line) <= width, `File tool: ${tui.visibleWidth(line)} cells at ${width}`);
	}
}
if (process.argv.includes("--preview")) {
	for (const [renderer, args, data] of [[readRenderers, readArgs, readData], [editRenderers, editArgs, editData], [writeRenderers, writeArgs, writeData], [writeRenderers, writeArgs, error]]) {
		console.log(frame(renderer, args, data, { isError: data === error }, 90).join("\n") + "\n");
	}
}
console.log("test:file-tools ok: read/edit/write paths, ranges, submitted-content previews, native diff, errors, images, controls, widths, no I/O, immutable payloads");
