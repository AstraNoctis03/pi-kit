import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const requiredFiles = [
	"AGENTS.md",
	"CHANGELOG.md",
	"LICENSE",
	"README.md",
	"package.json",
	"tsconfig.json",
	"extensions/safety-guard/dialog.ts",
	"extensions/safety-guard/index.ts",
	"extensions/safety-guard/policy.ts",
	"skills/code-review/SKILL.md",
	"skills/debugging/SKILL.md",
];
const expectedSkills = ["code-review", "debugging"];
const expectedExtensionFiles = ["dialog.ts", "index.ts", "policy.ts"];

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
if (JSON.stringify(pkg.pi?.extensions) !== JSON.stringify(["./extensions/safety-guard/index.ts"])) {
	fail("无效的 pi.extensions manifest");
}
for (const dependency of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
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

const extensionFiles = readdirSync(join("extensions", "safety-guard")).sort();
if (JSON.stringify(extensionFiles) !== JSON.stringify(expectedExtensionFiles)) {
	fail(`非预期的 extension 文件: ${extensionFiles.join(", ")}`);
}

console.log("validate:resources ok");
