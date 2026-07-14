#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const policyPath = path.join(root, "extensions", "safety-guard", "policy.ts");
const source = readFileSync(policyPath, "utf8");
const transpiled = ts.transpileModule(source, {
	fileName: policyPath,
	reportDiagnostics: true,
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true },
});
const errors = (transpiled.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error);
if (errors.length > 0) throw new Error(ts.formatDiagnostics(errors, { getCanonicalFileName: String, getCurrentDirectory: () => root, getNewLine: () => "\n" }));

const loadedModule = { exports: {} };
vm.runInNewContext(
	transpiled.outputText,
	{ exports: loadedModule.exports, module: loadedModule, process },
	{ filename: policyPath },
);
const { findCommandDecision, findToolPathDecision } = loadedModule.exports;

const commandCases = [
	["rm -rf /", "linux", "block", "rm-root"],
	["sudo rm -rf $HOME", "linux", "block", "rm-home"],
	["sudo -u root rm -rf /", "linux", "block", "rm-root"],
	["env LC_ALL=C rm -rf /", "linux", "block", "rm-root"],
	["rm /mnt/c/Users/example/file", "linux", "block", "windows-path-write"],
	["sudo rm /mnt/c/Users/example/file", "linux", "block", "windows-path-write"],
	["cp file /mnt/d/target", "linux", "block", "windows-path-write"],
	["echo data > /mnt/c/target", "linux", "block", "windows-path-write"],
	["cd /mnt/c/project && npm install", "linux", "block", "windows-path-write"],
	["sudo echo test", "linux", "confirm", "sudo"],
	["rm file.txt", "linux", "confirm", "delete"],
	["rmdir empty", "linux", "confirm", "delete"],
	["chmod -R 755 dir", "linux", "confirm", "chmod-recursive"],
	["chown user file", "linux", "confirm", "system-chown"],
	["mkfs.ext4 /dev/sdz", "linux", "confirm", "system-mkfs.ext4"],
	["dd if=input of=output", "linux", "confirm", "dd-output"],
	["shutdown now", "linux", "confirm", "system-shutdown"],
	["systemctl restart example", "linux", "confirm", "system-systemctl"],
	["service example restart", "linux", "confirm", "system-service"],
	["git branch feature", "linux", "confirm", "git-branch"],
	["git config user.name Example", "linux", "confirm", "git-config"],
	["git commit -m test", "linux", "confirm", "git-commit"],
	["git push", "linux", "confirm", "git-push"],
	["npm install", "linux", "confirm", "package-npm-install"],
	["npx example", "linux", "confirm", "package-npx"],
	["env npm install", "linux", "confirm", "package-npm-install"],
	["bash -c 'rm file'", "linux", "confirm", "nested-shell"],
	["pip install package", "linux", "confirm", "package-pip-install"],
	[String.raw`rm C:\Users\example\file`, "win32", "confirm", "delete"],
];

const allowedCommands = [
	"echo safe",
	"git status --short",
	"git diff --check",
	"git branch --show-current",
	"git remote -v",
	"git remote get-url origin",
	"git config --get user.name",
	"systemctl status example",
	"service example status",
	"npm run validate",
	"npm view typescript version",
	"node scripts/test.js",
	"python script.py",
	"pytest",
	"dd if=input",
	"echo hi | grep h | wc -l",
	"git diff --check && npm run validate",
];

const failures = [];
for (const [command, platform, action, ruleName] of commandCases) {
	const actual = findCommandDecision(command, platform);
	if (!actual || actual.action !== action || actual.ruleName !== ruleName) {
		failures.push(`${command}: expected ${action}/${ruleName}, got ${actual ? `${actual.action}/${actual.ruleName}` : "allow"}`);
	}
}
for (const command of allowedCommands) {
	const actual = findCommandDecision(command, "linux");
	if (actual) failures.push(`${command}: expected allow, got ${actual.action}/${actual.ruleName}`);
}

const toolCases = [
	["src/file.ts", "linux", undefined],
	["/mnt/c/Users/example/file.ts", "linux", "block"],
	[String.raw`C:\Users\example\file.ts`, "linux", "block"],
	[String.raw`C:\Users\example\file.ts`, "win32", undefined],
];
for (const [filePath, platform, action] of toolCases) {
	const actual = findToolPathDecision(filePath, platform);
	if (actual?.action !== action) failures.push(`${filePath} (${platform}): expected ${action ?? "allow"}, got ${actual?.action ?? "allow"}`);
}

if (failures.length > 0) {
	console.error("test:safety failed:");
	for (const failure of failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`test:safety ok: ${commandCases.length} guarded commands, ${allowedCommands.length} allowed commands, ${toolCases.length} path cases.`);
