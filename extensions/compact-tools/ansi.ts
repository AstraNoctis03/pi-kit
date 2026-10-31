// Preserve ordinary foreground styling, never cursor movement, clipboard OSC,
// concealed text or background fills. This sanitizes display only, not tool data.
const SEQUENCES = /\x1b(?:\][\s\S]*?(?:\x07|\x1b\\|$)|[PX^_][\s\S]*?(?:\x1b\\|$)|\[[0-?]*[ -/]*[@-~]|[ -/]*[@-~])|[\x90\x98\x9d\x9e\x9f][\s\S]*?(?:\x9c|\x1b\\|\x07|$)|\x9b[0-?]*[ -/]*[@-~]/g;
const SIMPLE_SGR = new Set([0, 1, 2, 3, 4, 9, 22, 23, 24, 29, 39]);

function foregroundStyle(sequence: string): string {
	const sgr = sequence.replace(/^\x9b/, "\x1b[");
	if (!/^\x1b\[[\d;]*m$/.test(sgr)) return "";
	const codes = sgr.slice(2, -1).split(";").map((part) => part === "" ? 0 : Number(part));
	for (let index = 0; index < codes.length; index++) {
		const code = codes[index];
		if (SIMPLE_SGR.has(code) || (code >= 30 && code <= 37) || (code >= 90 && code <= 97)) continue;
		if (code !== 38) return "";
		const mode = codes[++index];
		const count = mode === 5 ? 1 : mode === 2 ? 3 : 0;
		if (!count || index + count >= codes.length) return "";
		for (let part = 0; part < count; part++) {
			const channel = codes[++index];
			if (!Number.isInteger(channel) || channel < 0 || channel > 255) return "";
		}
	}
	return sgr;
}

export function displayText(text: string, preserveColor = false): string {
	const plain = (part: string) => part.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
	const parts: string[] = [];
	let end = 0;
	for (const match of text.matchAll(SEQUENCES)) {
		parts.push(plain(text.slice(end, match.index)));
		if (preserveColor) parts.push(foregroundStyle(match[0]));
		end = match.index + match[0].length;
	}
	parts.push(plain(text.slice(end)));
	return parts.join("").replace(/\r\n?/g, "\n").replace(/\t/g, "   ");
}
