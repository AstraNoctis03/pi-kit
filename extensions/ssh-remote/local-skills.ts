import path from "node:path";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";

function key(file: string): string {
	const resolved = path.resolve(file);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

interface LocalInstruction {
	file: string;
	canonical?: string;
	failure?: string;
}

// Only exact entry files supplied by Pi's loaded skill list are local-readable.
// No directory allowlist, script execution, or "local file exists" fallback.
export class LocalSkillInstructions {
	private files = new Map<string, LocalInstruction>();

	async configure(skills: readonly { filePath: string }[]): Promise<void> {
		const entries = await Promise.all(skills.map(async ({ filePath }): Promise<[string, LocalInstruction]> => {
			try { return [key(filePath), { file: filePath, canonical: await realpath(filePath) }]; }
			catch (error) { return [key(filePath), { file: filePath, failure: String(error) }]; }
		}));
		this.files = new Map(entries);
	}

	has(file: string): boolean { return this.files.has(key(file)); }

	private async verifiedPath(file: string): Promise<string> {
		const entry = this.files.get(key(file));
		if (!entry) throw new Error(`Not a registered local skill instruction: ${file}`);
		if (!entry.canonical) throw new Error(`Local skill unavailable: ${entry.file}: ${entry.failure}`);
		if (key(await realpath(entry.file)) !== key(entry.canonical)) {
			throw new Error(`Local skill path changed after loading: ${entry.file}. Reload skills before reading it.`);
		}
		return entry.canonical;
	}

	async access(file: string): Promise<void> { await access(await this.verifiedPath(file), constants.R_OK); }
	async readFile(file: string): Promise<Buffer> { return readFile(await this.verifiedPath(file)); }
}
