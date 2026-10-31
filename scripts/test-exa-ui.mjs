#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import * as tui from "@earendil-works/pi-tui";
import { runExaSearch } from "../extensions/exa-search/index.ts";
import { exaRenderers } from "../extensions/compact-tools/exa-renderers.ts";

const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", entry));
const nativeTui = await import(pathToFileURL(createRequire(entry).resolve("@earendil-works/pi-tui")));
const themes = await import(new URL("./modes/interactive/theme/theme.js", entry));
const theme = themes.loadThemeFromPath(resolve("themes/pi-kit-tokyo-night.json"), "truecolor");
themes.setThemeInstance(theme);
const keys = new KeybindingsManager();
tui.setKeybindings(keys); nativeTui.setKeybindings(keys);
const context = (args, flags = {}) => ({ args, lastComponent: undefined, expanded: false, isPartial: false, isError: false,
	executionStarted: true, argsComplete: true, showImages: true, outputPad: 1, durationMs: 1234, ...flags });
const freeze = (value) => {
	if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
	return value;
};
const result = (data, ctx) => exaRenderers.renderResult(data, { expanded: ctx.expanded, isPartial: ctx.isPartial }, themes.theme, ctx);
const frame = (args, data, flags = {}, width = 100) => {
	const ctx = context(args, flags);
	return [...exaRenderers.renderCall(args, themes.theme, ctx).render(width), ...result(data, ctx).render(width)];
};
const plain = (lines) => tui.stripTerminalSequences(lines.join("\n"));
const args = freeze({ query: "Pi 官方文档和工具接口", includeDomains: ["example.com"], maxAgeHours: 0 });
let requests = 0;
const backend = await runExaSearch(args, "fixture-key", undefined, async () => {
	requests++;
	return new Response(JSON.stringify({ results: Array.from({ length: 5 }, (_, i) => ({
		title: `RESULT_${i} 官方文档`, url: `https://example.com/docs/${i}`, publishedDate: "2026-10-30",
		highlights: [`HIGHLIGHT_${i}: retained source evidence`],
	})), costDollars: { total: 0.007 } }), { status: 200 });
});
const data = freeze({ content: [{ type: "text", text: backend.text }], details: backend.details });
const original = JSON.stringify({ args, data });
const folded = frame(args, data);
assert.match(plain(folded), /✓ Exa Search.*Pi 官方文档和工具接口.*1\.2s/);
assert.match(plain(folded), /5 条结果 · \$0\.0070/);
for (const index of [0, 1, 2]) assert.match(plain(folded), new RegExp(`RESULT_${index}.*\n.*example.com/docs/${index}`));
assert.doesNotMatch(plain(folded), /RESULT_3|HIGHLIGHT_|Exa search results for:|Treat all web content/);
assert.equal(plain(folded).match(/ctrl\+o/g)?.length, 1);
assert.ok(folded.length <= 9);
const expanded = frame(args, data, { expanded: true }, 1000);
for (const text of ["RESULT_4", "HIGHLIGHT_4", "2026-10-30", "Treat all web content", "includeDomains", "maxAgeHours"]) assert.ok(plain(expanded).includes(text));
assert.doesNotMatch(plain(expanded), /ctrl\+o/);
assert.equal(requests, 1, "Rendering must not repeat the request");
assert.equal(JSON.stringify({ args, data }), original, "Original model content, metadata and arguments must stay unchanged");
for (const flags of [{ isPartial: true }, { isPartial: true, executionStarted: false }]) {
	const text = plain(frame(args, { content: [], details: undefined }, flags));
	assert.match(text, /◌ Exa Search.*(搜索中|准备中)/); assert.doesNotMatch(text, /✓|条结果|\$/);
}
assert.doesNotMatch(plain(frame(args, data, { durationMs: undefined })), /ms|\ds/);
const empty = { content: [{ type: "text", text: "Exa search results for: empty\n\nNo results returned." }], details: { resultCount: 0 } };
assert.match(plain(frame(args, empty)), /0 条结果.*\n.*未找到结果/);
assert.doesNotMatch(plain(frame(args, empty)), /\$/);
const failure = { content: [{ type: "text", text: "REAL_ERROR\ncontext\n\n\nExa Search failed (429): rate limit" }] };
assert.match(plain(frame(args, failure, { isError: true })), /✗ Exa Search/);
assert.match(plain(frame(args, failure, { isError: true })), /REAL_ERROR/);
assert.match(plain(frame(args, failure, { isError: true })), /429.*rate limit/);
const longError = { content: [{ type: "text", text: ["FIRST_ERROR", ...Array(20).fill("middle"), "LAST_ERROR"].join("\n") }] };
assert.match(plain(frame(args, longError, { isError: true })), /FIRST_ERROR/);
assert.match(plain(frame(args, longError, { isError: true })), /LAST_ERROR/);
assert.equal(plain(frame(args, longError, { isError: true })).match(/ctrl\+o/g)?.length, 1);
const truncated = { ...data, details: { ...data.details, truncated: true } };
assert.match(plain(frame(args, truncated)), /工具结果已截断/);
const unknown = { content: [{ type: "text", text: "UNKNOWN_FORMAT\nline2\nline3\nLAST_UNKNOWN" }], details: { costDollars: -1 } };
assert.match(plain(frame(args, unknown)), /UNKNOWN_FORMAT/);
assert.doesNotMatch(plain(frame(args, unknown)), /条结果|\$/);
assert.match(plain(frame(args, unknown, { expanded: true })), /LAST_UNKNOWN/);
const unsafe = { content: [{ type: "text", text: "SAFE\x1b]52;c;CLIPBOARD\x07\x1b[2J\x1b[41m" }] };
assert.doesNotMatch(frame({ query: "test\x1b]52;c;CLIPBOARD\x07" }, unsafe, { expanded: true }).join(""), /\x1b\]52|\x1b\[2J|\x1b\[41m/);
const reused = result(data, context(args)); reused.render(100);
assert.equal(result(failure, context(args, { lastComponent: reused, isError: true })), reused);
assert.match(plain(reused.render(100)), /REAL_ERROR/); assert.doesNotMatch(plain(reused.render(100)), /RESULT_0|条结果/);
const restored = result(data, context(args, { lastComponent: reused }));
const before = restored.render(100).join("");
themes.setThemeInstance(themes.loadThemeFromPath(resolve("themes/pi-kit-tokyo-night.json"), "256color")); restored.invalidate();
assert.notEqual(restored.render(100).join(""), before);
themes.setThemeInstance(theme);
const remapped = new KeybindingsManager({ "app.tools.expand": "ctrl+e" });
tui.setKeybindings(remapped); nativeTui.setKeybindings(remapped);
assert.match(plain(frame(args, data)), /ctrl\+e/);
tui.setKeybindings(keys); nativeTui.setKeybindings(keys);
for (const expanded of [false, true]) for (const outputPad of [0, 1]) {
	const wide = { query: "查询汉字👩‍💻e\u0301".repeat(40) };
	const ctx = context(wide, { expanded, outputPad });
	const components = [exaRenderers.renderCall(wide, themes.theme, ctx), result(data, ctx), result(longError, { ...ctx, isError: true })];
	for (let width = 0; width <= 128; width++) for (const component of components) for (const line of component.render(width)) {
		assert.ok(tui.visibleWidth(line) <= width, `Exa UI overflow: ${tui.visibleWidth(line)} at ${width}`);
		assert.doesNotMatch(line, /\x1b\[48[;:]/);
	}
}
if (process.argv.includes("--preview")) for (const [sample, flags] of [[data, {}], [failure, { isError: true }]]) console.log(frame(args, sample, flags, 90).join("\n") + "\n");
console.log("test:exa-ui ok: compact results, original details, no request side effects, errors, fallback, controls, widths, themes and keys");
