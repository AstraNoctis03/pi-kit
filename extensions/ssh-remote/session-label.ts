import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const TARGET_PREFIX = /^\[(?:LOCAL|SSH [^\]\r\n]+)\](?:\s+|$)/u;
const DEFAULT_TOPIC_LENGTH = 80;

function normalizeDisplayText(value: string): string {
	return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

export function stableSessionHost(reportedHostname: string | undefined, sshHost: string): string {
	return normalizeDisplayText(reportedHostname ?? "").replace(/[\[\]]/g, "_") || sshHost;
}

export function sessionTargetLabel(host?: string, remoteCwd?: string): string {
	if (!host) return "[LOCAL]";
	const directory = remoteCwd ? path.posix.basename(remoteCwd) || "/" : undefined;
	const safeDirectory = directory ? normalizeDisplayText(directory).replace(/[\[\]]/g, "_") : undefined;
	return safeDirectory ? `[SSH ${host}:${safeDirectory}]` : `[SSH ${host}]`;
}

export function sessionNameTopic(name?: string): string {
	let topic = normalizeDisplayText(name ?? "");
	let previous: string;
	do {
		previous = topic;
		topic = topic.replace(TARGET_PREFIX, "").trim();
	} while (topic !== previous);
	return topic;
}

export function targetedSessionName(label: string, name?: string): string {
	const topic = sessionNameTopic(name);
	return topic ? `${label} ${topic}` : label;
}

export function compactSessionTopic(value: string, maxLength = DEFAULT_TOPIC_LENGTH): string {
	const normalized = normalizeDisplayText(value);
	const characters = [...normalized];
	if (characters.length <= maxLength) return normalized;
	return `${characters.slice(0, Math.max(0, maxLength - 1)).join("")}…`;
}

export function firstUserTopic(entries: readonly SessionEntry[]): string | undefined {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text = typeof content === "string"
			? content
			: content.map((block) => block.type === "text" ? block.text : "").join(" ");
		const topic = compactSessionTopic(text);
		if (topic) return topic;
	}
	return undefined;
}
