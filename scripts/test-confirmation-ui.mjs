#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as tui from "@earendil-works/pi-tui";
import { SafetyDialog, showThemedConfirmation } from "../extensions/safety-guard/dialog.ts";

const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", entry));
const nativeTui = await import(pathToFileURL(createRequire(entry).resolve("@earendil-works/pi-tui")));
const themes = await import(new URL("./modes/interactive/theme/theme.js", entry));
themes.setThemeInstance(themes.loadThemeFromPath(resolve("themes/pi-kit-tokyo-night.json"), "truecolor"));
const keys = new KeybindingsManager();
const bind = (value) => { tui.setKeybindings(value); nativeTui.setKeybindings(value); };
bind(keys);
const plain = (lines) => tui.stripTerminalSequences(lines.join("\n"));
function make(options = {}, subject = "Command: printf '仅为界面演示，不会执行'") {
	const results = [];
	const dialog = new SafetyDialog({ requestRender() {} }, themes.theme, "Safety confirmation", "仅演示确认界面，不会执行任何命令。", subject, (value) => results.push(value), undefined, options);
	dialog.focused = true;
	return { dialog, results };
}
const { dialog, results } = make();
const frame = dialog.render(160);
assert.match(plain(frame), /⚠ 安全确认/);
assert.match(plain(frame), /命令.*\n.*printf/);
assert.match(plain(frame), /^\s*→ 确认\s*$/m); assert.match(plain(frame), /^\s*取消\s*$/m);
assert.match(plain(frame), /选择.*确认.*取消/);
assert.ok(frame.length <= 11, "Small confirmations should not retain the old padding-heavy layout");
assert.ok(frame.every((line) => tui.visibleWidth(line) <= 88));
assert.match(frame.join(""), /38;2;255;158;100m/); assert.match(frame.join(""), /38;2;224;175;104m/);
assert.doesNotMatch(frame.join(""), /\x1b\[48[;:]/);
dialog.handleInput("\r");
assert.deepEqual(results, [{ allowed: true }], "Default Yes/Enter approval must remain unchanged");
const cancelled = make(); cancelled.dialog.handleInput("\x1b");
assert.deepEqual(cancelled.results, [{ allowed: false }]);
const rejected = make(); rejected.dialog.handleInput("\x1b[B"); rejected.dialog.handleInput("\r");
assert.deepEqual(rejected.results, [{ allowed: false }]);
const feedback = make(); feedback.dialog.handleInput("\x1b[B");
assert.match(plain(feedback.dialog.render(100)), /tab 补充原因/);
feedback.dialog.handleInput("\t");
assert.match(plain(feedback.dialog.render(100)), /补充拒绝原因/);
for (const character of "请缩小操作范围") feedback.dialog.handleInput(character);
feedback.dialog.handleInput("\r");
assert.deepEqual(feedback.results, [{ allowed: false, feedback: "请缩小操作范围" }]);
const empty = make(); empty.dialog.handleInput("\x1b[B"); empty.dialog.handleInput("\t"); empty.dialog.handleInput("\r");
assert.deepEqual(empty.results, [{ allowed: false, feedback: undefined }]);
const back = make(); back.dialog.handleInput("\x1b[B"); back.dialog.handleInput("\t"); back.dialog.handleInput("\x1b");
assert.match(plain(back.dialog.render(100)), /^\s*→ 取消\s*$/m); assert.deepEqual(back.results, []);
back.dialog.handleInput("\r"); assert.deepEqual(back.results, [{ allowed: false }]);
const simple = make({ allowFeedback: false }); simple.dialog.handleInput("\x1b[B"); simple.dialog.handleInput("\t");
assert.doesNotMatch(plain(simple.dialog.render(100)), /补充原因|补充拒绝原因/);
simple.dialog.handleInput("\r"); assert.deepEqual(simple.results, [{ allowed: false }]);
const longCommand = "BEGIN " + "参数😀e\u0301 --file='/path with spaces/a.txt' ".repeat(20) + "END";
const long = make({}, "Command: " + longCommand).dialog;
for (const width of [20, 40, 80, 160]) {
	const compact = plain(long.render(width)).replace(/\s/g, "");
	assert.ok(compact.includes(longCommand.replace(/\s/g, "")), `Never hide operation arguments at width ${width}`);
}
for (let width = 0; width <= 128; width++) for (const instance of [long, feedback.dialog, simple.dialog]) {
	for (const line of instance.render(width)) assert.ok(tui.visibleWidth(line) <= width, `Confirmation overflow at width ${width}`);
}
const unsafe = make({}, "Command: SAFE\x1b]52;c;CLIPBOARD\x07\x1b[2J\x1b[41m END").dialog;
assert.match(plain(unsafe.render(100)), /SAFE.*END/);
assert.match(plain(unsafe.render(100)), /CLIPBOARD/, "Approval must not conceal text inside a terminal-control payload");
assert.doesNotMatch(unsafe.render(100).join(""), /\x1b\]52|\x1b\[2J|\x1b\[41m/);
const directional = make({}, "Command: BEFORE\u061c\u202eVISIBLE\u2069AFTER").dialog;
assert.match(plain(directional.render(100)), /BEFORE\\u061c\\u202eVISIBLE\\u2069AFTER/);
const literal = new SafetyDialog({ requestRender() {} }, themes.theme, "constructor", "Reason", "constructor: FULL_VALUE", () => {});
assert.match(plain(literal.render(100)), /constructor/); assert.match(plain(literal.render(100)), /FULL_VALUE/);
const remapped = new KeybindingsManager({ "tui.select.confirm": "ctrl+y", "tui.select.cancel": "ctrl+x" });
bind(remapped);
const remap = make(); assert.match(plain(remap.dialog.render(100)), /ctrl\+y 确认.*ctrl\+x 取消/);
remap.dialog.handleInput("\x19"); assert.deepEqual(remap.results, [{ allowed: true }]);
const remapCancel = make(); remapCancel.dialog.handleInput("\x18"); assert.deepEqual(remapCancel.results, [{ allowed: false }]);
bind(keys);
const before = dialog.render(100).join("");
themes.setThemeInstance(themes.loadThemeFromPath(resolve("themes/pi-kit-tokyo-night.json"), "256color")); dialog.invalidate();
assert.notEqual(dialog.render(100).join(""), before);
themes.setThemeInstance(themes.loadThemeFromPath(resolve("themes/pi-kit-tokyo-night.json"), "truecolor"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = resolve(".confirmation-ui-test-config-does-not-exist");
try {
	let rpc;
	const rpcCtx = { hasUI: true, mode: "rpc", ui: { confirm: async (...args) => { rpc = args; return false; } } };
	assert.deepEqual(await showThemedConfirmation(rpcCtx, "TITLE", "REASON", "Command: EXACT"), { allowed: false });
	assert.deepEqual(rpc, ["TITLE", "REASON\n\nCommand: EXACT"]);
	await showThemedConfirmation(rpcCtx, "认领当前会话？", "ORIGINAL_MESSAGE", "", { allowFeedback: false });
	assert.deepEqual(rpc, ["认领当前会话？", "ORIGINAL_MESSAGE"]);
	assert.deepEqual(await showThemedConfirmation({ hasUI: false }, "T", "R", "S"), { allowed: false });
} finally {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
}
if (process.argv.includes("--preview")) {
	console.log(make().dialog.render(100).join("\n") + "\n");
	console.log(make({}, "Path: /srv/project/.env.local").dialog.render(100).join("\n"));
}
console.log("test:confirmation-ui ok: compact layout, full operation, Yes default, rejection/feedback, simple confirmations, keys, widths and RPC fallback");
