import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const requiredFiles = [
	"AGENTS.md",
	"CHANGELOG.md",
	"LICENSE",
	"README.md",
	"package.json",
	"tsconfig.json",
	"extensions/custom-footer/colors.ts",
	"extensions/custom-footer/index.ts",
	"extensions/dirty-repo-guard/index.ts",
	"extensions/exa-search/index.ts",
	"extensions/handoff/index.ts",
	"extensions/presets/config.ts",
	"extensions/presets/index.ts",
	"extensions/presets/review-policy.ts",
	"extensions/safety-guard/dialog-colors.ts",
	"extensions/safety-guard/dialog.ts",
	"extensions/safety-guard/index.ts",
	"extensions/safety-guard/policy.ts",
	"extensions/sensitive-paths/config.ts",
	"extensions/sensitive-paths/index.ts",
	"extensions/ssh-remote/config.ts",
	"extensions/ssh-remote/index.ts",
	"extensions/ssh-remote/paths.ts",
	"extensions/ssh-remote/transport.ts",
	"extensions/titlebar-spinner/index.ts",
	"skills/code-review/SKILL.md",
	"skills/debugging/SKILL.md",
];
const expectedSkills = ["code-review", "debugging"];
const expectedFooterExtensionFiles = ["colors.ts", "index.ts"];
const expectedDirtyExtensionFiles = ["index.ts"];
const expectedExaExtensionFiles = ["index.ts"];
const expectedHandoffExtensionFiles = ["index.ts"];
const expectedPresetExtensionFiles = ["config.ts", "index.ts", "review-policy.ts"];
const expectedSafetyExtensionFiles = ["dialog-colors.ts", "dialog.ts", "index.ts", "policy.ts"];
const expectedSensitiveExtensionFiles = ["config.ts", "index.ts"];
const expectedSshExtensionFiles = ["config.ts", "index.ts", "paths.ts", "transport.ts"];
const expectedTitleExtensionFiles = ["index.ts"];

function fail(message) {
	throw new Error(message);
}

function readText(path) {
	return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

function parseFrontmatter(path) {
	const text = readText(path);
	const match = text.match(/^---\n([\s\S]*?)\n---\n/);
	if (!match) fail(`无效的 skill frontmatter: ${path}`);
	return Object.fromEntries(
		match[1].split("\n").flatMap((line) => {
			const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
			return field ? [[field[1], field[2].replace(/^["']|["']$/g, "").trim()]] : [];
		}),
	);
}

for (const path of requiredFiles) {
	if (!existsSync(path) || !statSync(path).isFile() || !readText(path).trim()) fail(`缺少或为空: ${path}`);
}

const pkg = JSON.parse(readText("package.json"));
if (pkg.name !== "pi-kit" || pkg.private !== true) fail("无效的 package identity");
if (!pkg.keywords?.includes("pi-package")) fail("keywords 必须包含 pi-package");
if (JSON.stringify(pkg.pi?.skills) !== JSON.stringify(["./skills"])) fail("无效的 pi.skills manifest");
if (JSON.stringify(pkg.pi?.extensions) !== JSON.stringify([
	"./extensions/exa-search/index.ts",
	"./extensions/presets/index.ts",
	"./extensions/safety-guard/index.ts",
	"./extensions/sensitive-paths/index.ts",
	"./extensions/ssh-remote/index.ts",
	"./extensions/dirty-repo-guard/index.ts",
	"./extensions/custom-footer/index.ts",
	"./extensions/handoff/index.ts",
	"./extensions/titlebar-spinner/index.ts",
])) {
	fail("无效的 pi.extensions manifest");
}
for (const dependency of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
	if (pkg.peerDependencies?.[dependency] !== "*") fail(`缺少 peer dependency: ${dependency}`);
}

const skillDirs = readdirSync("skills").filter((entry) => statSync(join("skills", entry)).isDirectory()).sort();
if (JSON.stringify(skillDirs) !== JSON.stringify(expectedSkills)) fail(`非预期的 skills: ${skillDirs.join(", ")}`);
for (const skill of expectedSkills) {
	const path = join("skills", skill, "SKILL.md");
	const { name = "", description = "" } = parseFrontmatter(path);
	if (name !== skill || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) fail(`无效的 skill name: ${path}`);
	if (!description || description.length > 1024) fail(`无效的 skill description: ${path}`);
}

const dirtyExtensionFiles = readdirSync(join("extensions", "dirty-repo-guard")).sort();
if (JSON.stringify(dirtyExtensionFiles) !== JSON.stringify(expectedDirtyExtensionFiles)) {
	fail(`非预期的 dirty guard extension 文件: ${dirtyExtensionFiles.join(", ")}`);
}
const exaExtensionFiles = readdirSync(join("extensions", "exa-search")).sort();
if (JSON.stringify(exaExtensionFiles) !== JSON.stringify(expectedExaExtensionFiles)) {
	fail(`非预期的 Exa extension 文件: ${exaExtensionFiles.join(", ")}`);
}
const footerExtensionFiles = readdirSync(join("extensions", "custom-footer")).sort();
if (JSON.stringify(footerExtensionFiles) !== JSON.stringify(expectedFooterExtensionFiles)) {
	fail(`非预期的 footer extension 文件: ${footerExtensionFiles.join(", ")}`);
}
const handoffExtensionFiles = readdirSync(join("extensions", "handoff")).sort();
if (JSON.stringify(handoffExtensionFiles) !== JSON.stringify(expectedHandoffExtensionFiles)) {
	fail(`非预期的 handoff extension 文件: ${handoffExtensionFiles.join(", ")}`);
}
const presetExtensionFiles = readdirSync(join("extensions", "presets")).sort();
if (JSON.stringify(presetExtensionFiles) !== JSON.stringify(expectedPresetExtensionFiles)) {
	fail(`非预期的 preset extension 文件: ${presetExtensionFiles.join(", ")}`);
}
const safetyExtensionFiles = readdirSync(join("extensions", "safety-guard")).sort();
if (JSON.stringify(safetyExtensionFiles) !== JSON.stringify(expectedSafetyExtensionFiles)) {
	fail(`非预期的 safety extension 文件: ${safetyExtensionFiles.join(", ")}`);
}
const sensitiveExtensionFiles = readdirSync(join("extensions", "sensitive-paths")).sort();
if (JSON.stringify(sensitiveExtensionFiles) !== JSON.stringify(expectedSensitiveExtensionFiles)) {
	fail(`非预期的 sensitive extension 文件: ${sensitiveExtensionFiles.join(", ")}`);
}
const sshExtensionFiles = readdirSync(join("extensions", "ssh-remote")).sort();
if (JSON.stringify(sshExtensionFiles) !== JSON.stringify(expectedSshExtensionFiles)) {
	fail(`非预期的 ssh extension 文件: ${sshExtensionFiles.join(", ")}`);
}
const titleExtensionFiles = readdirSync(join("extensions", "titlebar-spinner")).sort();
if (JSON.stringify(titleExtensionFiles) !== JSON.stringify(expectedTitleExtensionFiles)) {
	fail(`非预期的 title extension 文件: ${titleExtensionFiles.join(", ")}`);
}

console.log("validate:resources ok");
