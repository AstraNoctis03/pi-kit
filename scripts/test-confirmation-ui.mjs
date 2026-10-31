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
const frameWidth = 160;
const frame = dialog.render(frameWidth);
assert.match(plain([frame[0]]), /^─ ⚠ 安全确认 ─/);
assert.doesNotMatch(plain([frame.at(-1)]), /^─+$/);
assert.match(plain(frame), /↑↓ 选择 · Enter 确认 · Esc 取消/);
assert.doesNotMatch(plain(frame), /up\/down|escape\/ctrl\+c/);
assert.match(plain(frame), /命令.*\n.*printf/);
assert.match(plain(frame), /^\s*→ 确认\s*$/m); assert.match(plain(frame), /^\s*取消\s*$/m);
assert.match(plain(frame), /选择.*确认.*取消/);
assert.ok(frame.length <= 9, "Title shares the rule, without an extra bottom border");
assert.equal(tui.visibleWidth(frame[0]), frameWidth, "The heading must fill the available terminal width");
assert.ok(frame.every((line) => tui.visibleWidth(line) <= frameWidth));
assert.match(frame.join(""), /38;2;184;117;75m/); assert.match(frame.join(""), /38;2;224;175;104m/);
const selectedRow = frame.find((line) => /^→ 确认$/.test(tui.stripTerminalSequences(line).trim()));
assert.ok(selectedRow); assert.match(selectedRow, /38;2;213;183;120m/);
assert.doesNotMatch(selectedRow, /\x1b\[1m/, "Selection uses color and arrow, not bold text");
assert.doesNotMatch(frame.join(""), /\x1b\[48[;:]/);
const command = "git -C '/srv/project with spaces' commit -m 'UI preview only'";
const colored = make({}, "Command: " + command).dialog.render(100);
assert.ok(colored.join("").includes(themes.theme.getFgAnsi("syntaxString")), "Use native Shell string colors");
assert.ok(plain(colored).replace(/\s/g, "").includes(command.replace(/\s/g, "")), "Highlighting must not alter arguments");
const filePath = "/srv/项目 with spaces/.env.local";
const pathFrame = make({}, "Path: " + filePath).dialog.render(100);
assert.ok(plain(pathFrame).includes(filePath));
assert.ok(pathFrame.find((line) => tui.stripTerminalSequences(line).includes(filePath)).includes(themes.theme.getFgAnsi("accent")), "Keep paths in the distinct theme accent color");
dialog.handleInput("\r");
assert.deepEqual(results, [{ allowed: true }], "Default Yes/Enter approval must remain unchanged");
const cancelled = make(); cancelled.dialog.handleInput("\x1b");
assert.deepEqual(cancelled.results, [{ allowed: false }]);
const alternateCancel = make(); alternateCancel.dialog.handleInput("\x03");
assert.deepEqual(alternateCancel.results, [{ allowed: false }], "Hidden secondary bindings remain active");
const rejected = make(); rejected.dialog.handleInput("\x1b[B"); rejected.dialog.handleInput("\r");
assert.deepEqual(rejected.results, [{ allowed: false }]);
const feedback = make(); feedback.dialog.handleInput("\x1b[B");
assert.match(plain(feedback.dialog.render(100)), /Tab 补充原因/);
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
for (const width of [20, 40, 80, 88, 89, 120, 160, 240, 320]) {
	const lines = long.render(width);
	assert.equal(tui.visibleWidth(lines[0]), width, `Heading fills resized width ${width}`);
	const compact = plain(lines).replace(/\s/g, "");
	assert.ok(compact.includes(longCommand.replace(/\s/g, "")), `Never hide operation arguments at width ${width}`);
}
assert.ok(long.render(160).length < long.render(88).length, "The command body must also use wider terminals");
for (let width = 0; width <= 320; width++) for (const instance of [long, feedback.dialog, simple.dialog]) {
	for (const line of instance.render(width)) assert.ok(tui.visibleWidth(line) <= width, `Confirmation overflow at width ${width}`);
}
const unsafe = make({}, "Command: SAFE\x1b]52;c;CLIPBOARD\x07\x1b[2J\x1b[41m END").dialog;
assert.match(plain(unsafe.render(100)), /SAFE.*END/);
assert.match(plain(unsafe.render(100)), /CLIPBOARD/, "Approval must not conceal text inside a terminal-control payload");
assert.doesNotMatch(unsafe.render(100).join(""), /\x1b\]52|\x1b\[2J|\x1b\[41m/);
const directional = make({}, "Command: BEFORE\u061c\u202eVISIBLE\u2069AFTER").dialog;
assert.match(plain(directional.render(100)), /BEFORE\\u061c\\u202eVISIBLE\\u2069AFTER/);
const largeCommand = "printf '" + "大段内容👩‍💻e\u0301".repeat(2000) + "'";
assert.ok(plain(make({}, "Command: " + largeCommand).dialog.render(100)).replace(/\s/g, "").includes(largeCommand.replace(/\s/g, "")), "Skip expensive highlighting, never the approval text");
const literal = new SafetyDialog({ requestRender() {} }, themes.theme, "constructor", "Reason", "constructor: FULL_VALUE", () => {});
assert.match(plain(literal.render(100)), /constructor/); assert.match(plain(literal.render(100)), /FULL_VALUE/);
const remapped = new KeybindingsManager({ "tui.select.up": ["ctrl+p", "up"], "tui.select.down": ["ctrl+n", "down"],
	"tui.select.confirm": ["ctrl+y", "enter"], "tui.select.cancel": ["ctrl+x", "escape", "ctrl+c"], "tui.input.submit": "ctrl+s" });
bind(remapped);
const remap = make(); assert.match(plain(remap.dialog.render(100)), /Ctrl\+P\/Ctrl\+N 选择 · Ctrl\+Y 确认 · Ctrl\+X 取消/);
remap.dialog.handleInput("\x19"); assert.deepEqual(remap.results, [{ allowed: true }]);
const remapCancel = make(); remapCancel.dialog.handleInput("\x18"); assert.deepEqual(remapCancel.results, [{ allowed: false }]);
const secondaryConfirm = make(); secondaryConfirm.dialog.handleInput("\r"); assert.deepEqual(secondaryConfirm.results, [{ allowed: true }]);
const secondaryCancel = make(); secondaryCancel.dialog.handleInput("\x1b"); assert.deepEqual(secondaryCancel.results, [{ allowed: false }]);
const remapFeedback = make(); remapFeedback.dialog.handleInput("\x0e"); remapFeedback.dialog.handleInput("\t");
assert.match(plain(remapFeedback.dialog.render(100)), /Ctrl\+S 拒绝并提交 · Ctrl\+X 返回/);
remapFeedback.dialog.handleInput("\x13"); assert.deepEqual(remapFeedback.results, [{ allowed: false, feedback: undefined }]);
const disabled = new KeybindingsManager({ "tui.select.up": [], "tui.select.down": [], "tui.select.confirm": [], "tui.select.cancel": [] });
bind(disabled);
assert.match(plain(make().dialog.render(100)), /未绑定\/未绑定 选择 · 未绑定 确认 · 未绑定 取消/);
bind(keys);
const before = dialog.render(100).join("");
themes.setThemeInstance(themes.loadThemeFromPath(resolve("themes/pi-kit-tokyo-night.json"), "256color")); dialog.invalidate();
assert.notEqual(dialog.render(100).join(""), before);
assert.ok(dialog.render(100).join("").includes(themes.theme.getFgAnsi("syntaxString")), "Recolor cached Shell tokens after a theme change");
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
	const staged = "git add -- " + Array.from({ length: 12 }, (_, index) => `src/feature-${index}/index.ts`).join(" ") + " && git commit -m 'UI preview only'";
	console.log(make({}, "Command: " + staged).dialog.render(100).join("\n") + "\n");
	console.log(make({}, "Path: /srv/project/.env.local").dialog.render(100).join("\n"));
}
console.log("test:confirmation-ui ok: inline title, native Shell colors, full operation, Yes default, rejection/feedback, primary/secondary keys, widths and RPC fallback");
