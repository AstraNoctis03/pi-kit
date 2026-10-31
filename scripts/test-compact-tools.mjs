#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { setKeybindings, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import compactTools from "../extensions/compact-tools/index.ts";
import { displayText } from "../extensions/compact-tools/ansi.ts";
import { bashRenderers } from "../extensions/compact-tools/renderers.ts";
import { editRenderers, readRenderers, writeRenderers } from "../extensions/compact-tools/file-renderers.ts";
import { exaRenderers } from "../extensions/compact-tools/exa-renderers.ts";

const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", entry));
const nativeTui = await import(pathToFileURL(createRequire(entry).resolve("@earendil-works/pi-tui")));
const keys = new KeybindingsManager();
setKeybindings(keys); nativeTui.setKeybindings(keys); initTheme("dark", false);
const themeModule = await import(pathToFileURL(resolve(dirname(fileURLToPath(entry)), "modes/interactive/theme/theme.js")));
const theme = themeModule.loadThemeFromPath(resolve("themes/pi-kit-tokyo-night.json"), "truecolor");
themeModule.setThemeInstance(theme);
const plain = (lines) => stripTerminalSequences(lines.join("\n"));
const context = (overrides = {}) => ({ args: {}, toolCallId: "ui-fixture", invalidate() {}, state: {}, cwd: process.cwd(),
	lastComponent: undefined, executionStarted: true, argsComplete: true, isPartial: false, expanded: false,
	showImages: true, isError: false, outputPad: 1, durationMs: 1234, ...overrides });
const output = (text, details) => ({ content: [{ type: "text", text }], details });
const call = (args, ctx = context()) => bashRenderers.renderCall(args, themeModule.theme, ctx);
const result = (data, ctx = context()) => bashRenderers.renderResult(data, { expanded: ctx.expanded, isPartial: ctx.isPartial }, themeModule.theme, ctx);
const frame = (args, data, flags = {}, width = 100) => {
	const ctx = context({ ...flags, args });
	return [...call(args, ctx).render(width), ...result(data, ctx).render(width)];
};

// Reproduce the reported screenshot: native Bash appends blank lines and an
// exit message, which must not displace the actual error from the preview.
const screenshotError = Object.freeze(output("UI 演示：人为模拟失败。\n预期：保留真实错误正文。\n\n\nCommand exited with code 1"));
const screenshotArgs = Object.freeze({ command: 'node -e "' + "console.error('failure');".repeat(10) + '"', timeout: 15 });
const previewCases = [
	"node -e \"console.log('INLINE_DETAIL')\"",
	"node --eval 'console.log(\"INLINE_DETAIL\")'",
	"node.exe --eval='console.log(\"INLINE_DETAIL\")'",
	String.raw`node -e "console.log(\"INLINE_DETAIL\")"`,
	String.raw`node -e "console.log('\$HOME INLINE_DETAIL')"`,
	"node -e 'console.log(`INLINE_DETAIL ${value}`)'",
	'node -e "console.log(\\`INLINE_DETAIL\\`)"',
	String.raw`node -e "console.log('\\\$HOME INLINE_DETAIL')"`,
	"node -e \"\nconsole.log('INLINE_DETAIL')\n\"",
	"\tnode\t-e\t'INLINE_DETAIL'\t\n",
	'node -e ""',
];
function checkOriginalPreview(source) {
	const args = Object.freeze({ command: source });
	const collapsed = frame(args, output(""), {}, 200);
	const first = displayText(source).split("\n")[0];
	const expected = stripTerminalSequences(truncateToWidth(first, 48, "…"));
	assert.ok(plain([collapsed[0]]).includes(expected), `Original command preview missing: ${source}`);
	assert.doesNotMatch(plain(collapsed), /内联脚本|实际输出/);
	const expanded = frame(args, output(""), { expanded: true }, 200);
	const marker = source.match(/(?:INLINE|RAW)_DETAIL/)?.[0];
	if (marker) assert.ok(plain(expanded).includes(marker));
	assert.equal(args.command, source, "Rendering must not rewrite executable arguments");
}
for (const source of previewCases) checkOriginalPreview(source);
const minimalFrame = frame({ command: "node -e \"console.log('hello')\"" }, output("hello"));
assert.deepEqual(plain(minimalFrame).split("\n").map((line) => line.trim()), ["✓ Bash · node -e \"console.log('hello')\" · 1.2s", "hello"]);
// Literal log text is data, not a UI label to insert or remove.
assert.match(plain(frame({ command: "node -e \"console.log('hello')\"" }, output("内联脚本\n实际输出"))), /内联脚本\n\s*实际输出/);
const complexPreviewCases = [
	'node -e "RAW_DETAIL" && printf AFTER', 'node -e "RAW_DETAIL"; printf AFTER',
	'node -e "RAW_DETAIL" || printf AFTER', 'node -e "RAW_DETAIL" | cat',
	'node -e "RAW_DETAIL" > fixture', 'node -e "RAW_DETAIL" 2>&1', 'node -e "RAW_DETAIL" &',
	'node -e "RAW_DETAIL"\nprintf AFTER', 'node\n-e "RAW_DETAIL"',
	'node -e "$(printf RAW_DETAIL)"', 'node -e "`printf RAW_DETAIL`"',
	String.raw`node -e "\\$(printf RAW_DETAIL)"`, 'node -e "console.log(\'$HOME\')"',
	'node -e "RAW_DETAIL" extra', 'node -e "RAW_DETAIL" # comment',
	'node --input-type=module -e "RAW_DETAIL"', '/usr/bin/node -e "RAW_DETAIL"',
	'node -p "RAW_DETAIL"', 'node -e "unterminated', "node -e 'a'\"b\"",
	'node -e "RAW_DETAIL"\x07',
];
// Rendering only: none of these Shell strings is ever executed.
for (const source of complexPreviewCases) checkOriginalPreview(source);
const cachedArgs = { command: 'node -e "RAW_DETAIL"' };
const cachedResult = result(output("same output"), context({ args: cachedArgs }));
assert.doesNotMatch(plain(cachedResult.render(100)), /ctrl\+o/);
const longerArgs = { command: cachedArgs.command + " && printf " + "x".repeat(80) };
const refreshedResult = result(output("same output"), context({ args: longerArgs, lastComponent: cachedResult }));
assert.equal(refreshedResult, cachedResult);
assert.match(plain(refreshedResult.render(100)), /长命令.*ctrl\+o/, "Command changes invalidate the output footer cache");

const screenshot = frame(screenshotArgs, screenshotError, { isError: true }, 200);
assert.match(plain(screenshot), /UI 演示：人为模拟失败/);
assert.match(plain(screenshot), /预期：保留真实错误正文/);
assert.match(plain(screenshot), /Command exited with code 1/);
assert.equal(plain(screenshot).match(/ctrl\+o/g)?.length, 1, "Command and output must share one expansion hint");
assert.ok(visibleWidth(screenshot[0]) <= 70, "Wide terminals must not turn the command into a full-width banner");
assert.doesNotMatch(plain(screenshot), /限 15s/);
assert.match(stripTerminalSequences(screenshot[0]), / · 1\.2s$/);
assert.ok(stripTerminalSequences(screenshot[0]).indexOf("1.2s") < 70, "Duration stays next to the command");
const fullError = result(screenshotError, context({ expanded: true, isError: true }));
assert.equal(plain(fullError.render(100)).split("\n").filter((line) => !line.trim()).length, 2, "Expansion preserves original blank lines");
const longFailure = result(output("FIRST_ERROR\nERROR_CONTEXT\n" + Array.from({ length: 15 }, (_, index) => `stack-${index}`).join("\n") + "\nCommand exited with code 1"), context({ isError: true }));
assert.match(plain(longFailure.render(100)), /FIRST_ERROR/);
assert.match(plain(longFailure.render(100)), /stack-14/);
assert.match(plain(longFailure.render(100)), /Command exited with code 1/);
assert.ok(longFailure.render(100).length <= 7, "Error preview remains bounded");

let resolver;
compactTools({ registerToolRenderer(callback) { resolver = callback; }, registerTool() { assert.fail("Rendering must not register an executor"); }, on() { assert.fail("No execution hooks needed"); } });
assert.equal(resolver("bash", () => { assert.fail("Bash renderer should be independent of execution"); }), bashRenderers);
const native = Object.freeze({ renderShell: "default" });
assert.equal(resolver("read", () => native), readRenderers);
assert.equal(resolver("edit", () => native), editRenderers);
assert.equal(resolver("write", () => native), writeRenderers);
assert.equal(resolver("exa_search", () => native), exaRenderers);
for (const tool of ["grep", "powershell", "mcp__fixture"]) assert.equal(resolver(tool, () => native), native);
assert.deepEqual(Object.keys(bashRenderers).sort(), ["renderCall", "renderResult", "renderShell"]);
assert.doesNotThrow(() => compactTools({ registerTool() { assert.fail("Old hosts must retain native tools"); } }));

for (const color of ["\x1b[32m", "\x1b[38;5;42m", "\x1b[38;2;12;34;56m", "\x1b[1;31m"]) {
	assert.equal(displayText(`${color}styled\x1b[0m`, true), `${color}styled\x1b[0m`);
	assert.equal(displayText(`${color}styled\x1b[0m`), "styled");
}
for (const sequence of ["\x1b[2J", "\x1b[5A", "\x1b[8m", "\x1b[41m", "\x1b[48;2;1;2;3m", "\x1b[38;5;999m", "\x1b]52;c;clipboard\x07", "\x1b_Gimage\x1b\\"]) {
	assert.equal(displayText(`${sequence}visible`, true), "visible");
}
assert.equal(displayText("\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\", true), "link");
assert.equal(displayText("before\x1b]52;c;\x1b[32mmalformed\x07after", true), "beforeafter");
assert.equal(displayText("a\r\nb\rc\td\0\x08\x07"), "a\nb\nc   d");
assert.equal(displayText("\x9b32mgreen\x9b0m", true), "\x1b[32mgreen\x1b[0m");

const args = Object.freeze({ command: 'npm test --silent "完整 字符串" && echo "$HOME"' });
const success = call(args);
assert.match(plain(success.render(100)), /✓ Bash.*npm test.*1\.2s/);
assert.match(success.render(100).join(""), /38;2;74;222;128m/, "Success uses the active Tokyo Night green");
assert.match(success.render(100).join(""), /38;2;122;162;247m/, "Tool label uses theme blue");
assert.equal(success.render(100).join("").match(/38;2;74;222;128m/g)?.length, 1, "Collapsed header uses color for status, not the whole quoted script");
assert.match(call(args, context({ expanded: true })).render(100).join(""), /38;2;115;218;202m/, "Expansion retains themed Shell syntax");
const waiting = call({}, context({ isPartial: true, executionStarted: false }));
assert.match(plain(waiting.render(80)), /准备中/); assert.doesNotMatch(plain(waiting.render(80)), /✓/);
const running = call({ command: "npm test" }, context({ isPartial: true }));
assert.match(plain(running.render(80)), /运行中/); assert.doesNotMatch(plain(running.render(80)), /1\.2s/);
assert.doesNotMatch(plain(call({ command: "npm test", timeout: 30 }).render(80)), /限 30s/);
assert.match(plain(call({ command: "npm test", timeout: 30 }, context({ expanded: true })).render(80)), /超时上限 30s/);
const failure = call({ command: "npm test" }, context({ isError: true }));
assert.match(plain(failure.render(80)), /✗ Bash/);
assert.match(failure.render(80).join(""), /38;2;247;118;142m/);
assert.doesNotMatch(plain(call({ command: "pwd" }, context({ durationMs: undefined })).render(80)), /ms|\ds/);

const script = "printf '第一行'\n" + "echo '细节👩‍💻e\u0301'\n".repeat(15) + "printf 'LAST_COMMAND'";
const foldedCall = call({ command: script });
assert.equal(foldedCall.render(80).length, 1); assert.doesNotMatch(plain(foldedCall.render(80)), /LAST_COMMAND/);
assert.match(plain(frame({ command: script }, output(""))), /17 行命令.*ctrl\+o/);
const remapped = new KeybindingsManager({ "app.tools.expand": "ctrl+e" });
setKeybindings(remapped); nativeTui.setKeybindings(remapped);
assert.match(plain(frame({ command: script }, output(""))), /ctrl\+e/);
setKeybindings(keys); nativeTui.setKeybindings(keys);
const expandedCall = call({ command: script }, context({ expanded: true, lastComponent: foldedCall }));
assert.equal(expandedCall, foldedCall); assert.match(plain(expandedCall.render(80)), /LAST_COMMAND/);

const data = Object.freeze(output(Array.from({ length: 30 }, (_, index) => `row-${index}`).join("\n")));
Object.freeze(data.content); Object.freeze(data.content[0]);
const foldedResult = result(data);
assert.equal(foldedResult.render(80).length, 4);
assert.match(plain(foldedResult.render(80)), /row-29/); assert.doesNotMatch(plain(foldedResult.render(80)), /row-0/);
assert.match(plain(foldedResult.render(80)), /30 行输出/);
assert.equal(plain(frame({ command: script }, data)).match(/ctrl\+o/g)?.length, 1);
const expandedResult = result(data, context({ expanded: true, lastComponent: foldedResult }));
assert.equal(expandedResult, foldedResult); assert.match(plain(expandedResult.render(80)), /row-0/);
assert.match(plain(expandedResult.render(80)), /row-29/);
assert.equal(plain(result(output("same"), context()).render(80)).trim(), "same");
assert.equal(result(output("")).render(80).length, 0);
const partial = result(output("partial-output"), context({ isPartial: true }));
const updated = result(output("final-output"), context({ lastComponent: partial }));
assert.equal(updated, partial); assert.match(plain(updated.render(80)), /final-output/); assert.doesNotMatch(plain(updated.render(80)), /partial-output/);
assert.match(plain(call({ command: "echo " + "x".repeat(17000) + " LARGE_END" }, context({ expanded: true })).render(80)), /LARGE_END/);
const errorOutput = result(output("tests passed, but this tool actually failed"), context({ isError: true }));
assert.match(errorOutput.render(80).join(""), /38;2;247;118;142m/);
const ansiOutput = result(output("\x1b[32mGREEN\x1b[0m\x1b[2J\x1b]52;c;secret\x07"));
assert.match(ansiOutput.render(80).join(""), /\x1b\[32m/);
assert.doesNotMatch(ansiOutput.render(80).join(""), /\x1b\[2J|\x1b\]52|secret/);
const truncation = result(output("useful output\n\n[Full output: /tmp/fixture.log]", { fullOutputPath: "/tmp/fixture.log", truncation: { truncated: true } }));
assert.match(plain(truncation.render(80)), /useful output/); assert.match(plain(truncation.render(80)), /工具结果已截断.*fixture.log/);

const components = [success, waiting, running, failure, expandedCall, expandedResult, errorOutput, ansiOutput, truncation, fullError, longFailure,
	call(screenshotArgs), result(output("inline output"), context({ args: screenshotArgs })),
	call({ command: "界".repeat(100) }), result(output("👩‍💻e\u0301中文".repeat(300)))];
for (const component of components) {
	for (let width = 0; width <= 128; width++) {
		for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `Rendered ${visibleWidth(line)} cells at width ${width}`);
	}
	component.invalidate(); component.render(80);
}
const detailsView = call(args, context({ expanded: true }));
const beforeTheme = success.render(100).join("");
const beforeSyntax = detailsView.render(100).join("");
themeModule.setTheme("light", false); success.invalidate(); detailsView.invalidate();
assert.notEqual(success.render(100).join(""), beforeTheme, "Theme changes update the header");
assert.notEqual(detailsView.render(100).join(""), beforeSyntax, "Theme changes invalidate expanded command highlighting");
const palette256 = themeModule.loadThemeFromPath(resolve("themes/pi-kit-tokyo-night.json"), "256color");
themeModule.setThemeInstance(palette256); success.invalidate(); detailsView.invalidate();
assert.match(success.render(100).join(""), /38;5;/, "Theme colors support 256-color terminals");
assert.doesNotMatch(success.render(100).join(""), /38;2;/);
assert.doesNotMatch(detailsView.render(100).join(""), /38;2;/);
themeModule.setThemeInstance(theme);
assert.equal(args.command, 'npm test --silent "完整 字符串" && echo "$HOME"');
assert.equal(data.content[0].text.split("\n").length, 30);

if (process.argv.includes("--preview")) {
	for (const [sampleArgs, sampleResult, options] of [
		[{ command: 'npm test --silent "preview"' }, output("test:ssh ok\ntest:verification ok\nAll checks passed"), {}],
		[screenshotArgs, screenshotError, { isError: true }],
		[{ command: script }, data, {}],
	]) {
		console.log("");
		console.log(frame(sampleArgs, sampleResult, options, 90).join("\n"));
	}
}
console.log("test:compact-tools ok (display-only, safe ANSI, streaming states, expansion, widths and themes)");
await import("./test-file-tools.mjs");
await import("./test-exa-ui.mjs");
await import("./test-confirmation-ui.mjs");
