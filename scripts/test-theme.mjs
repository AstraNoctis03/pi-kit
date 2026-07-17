#!/usr/bin/env node
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const themeModulePath = resolve(dirname(codingAgentEntry), "modes", "interactive", "theme", "theme.js");
const { loadThemeFromPath } = await import(pathToFileURL(themeModulePath));
const themePath = resolve("themes", "pi-kit-tokyo-night.json");
const theme = loadThemeFromPath(themePath, "truecolor");

assert.equal(theme.name, "pi-kit-tokyo-night");
assert.equal(theme.getColorMode(), "truecolor");
assert.match(theme.fg("accent", "accent"), /38;2;115;218;202m/);
assert.match(theme.fg("border", "border"), /38;2;122;162;247m/);
assert.match(theme.fg("warning", "warning"), /38;2;224;175;104m/);
assert.match(theme.bg("userMessageBg", "message"), /48;2;36;40;59m/);

console.log("test:theme ok");
