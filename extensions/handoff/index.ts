import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	BorderedLoader,
	convertToLlm,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";

const HANDOFF_SYSTEM_PROMPT = `You transfer a coding session into a focused new session. Given the relevant conversation and the user's next goal, produce a self-contained prompt that:

1. Summarizes decisions, implementation state, evidence, and unresolved issues relevant to the goal.
2. Lists files changed or discussed when relevant.
3. States the next task and verification expectations clearly.
4. Omits unrelated history and conversational filler.

Use this format:
## Context
...

## Relevant files
- ...

## Task
...

Return only the prompt, without a preamble.`;

function entryToMessage(entry: SessionEntry) {
	if (entry.type === "message") return entry.message;
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary" as const,
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

export function handoffMessages(branch: SessionEntry[]) {
	let compactionIndex = -1;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		if (branch[index].type === "compaction") {
			compactionIndex = index;
			break;
		}
	}
	if (compactionIndex < 0) return branch.map(entryToMessage).filter((message) => message !== undefined);
	const compaction = branch[compactionIndex];
	const firstKeptIndex = compaction.type === "compaction"
		? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
		: -1;
	const relevant = [
		compaction,
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
	return relevant.map(entryToMessage).filter((message) => message !== undefined);
}

export default function handoffExtension(pi: ExtensionAPI): void {
	pi.registerCommand("handoff", {
		description: "Create a focused replacement session for the next goal",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/handoff requires interactive mode", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal for the new session>", "error");
				return;
			}
			const messages = handoffMessages(ctx.sessionManager.getBranch());
			if (messages.length === 0) {
				ctx.ui.notify("No conversation to hand off", "warning");
				return;
			}

			const conversation = serializeConversation(convertToLlm(messages));
			const currentSessionFile = ctx.sessionManager.getSessionFile();
			let generationError: string | undefined;
			const generated = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
				const loader = new BorderedLoader(tui, theme, "Generating focused handoff...");
				loader.onAbort = () => done(null);
				const run = async () => {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
					if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error);
					const response = await complete(
						ctx.model!,
						{
							systemPrompt: HANDOFF_SYSTEM_PROMPT,
							messages: [{
								role: "user" as const,
								content: [{
									type: "text" as const,
									text: `## Conversation\n\n${conversation}\n\n## Next goal\n\n${goal}`,
								}],
								timestamp: Date.now(),
							}],
						},
						{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: loader.signal },
					);
					if (response.stopReason === "aborted") return null;
					return response.content
						.filter((item): item is { type: "text"; text: string } => item.type === "text")
						.map((item) => item.text)
						.join("\n");
				};
				run().then(done).catch((error) => {
					generationError = error instanceof Error ? error.message : String(error);
					done(null);
				});
				return loader;
			});
			if (generated === null) {
				ctx.ui.notify(generationError ? `Handoff failed: ${generationError}` : "Handoff cancelled", generationError ? "error" : "info");
				return;
			}
			const edited = await ctx.ui.editor("Review handoff prompt", generated);
			if (edited === undefined) {
				ctx.ui.notify("Handoff cancelled", "info");
				return;
			}
			const result = await ctx.newSession({
				parentSession: currentSessionFile,
				withSession: async (replacementCtx) => {
					replacementCtx.ui.setEditorText(edited);
					replacementCtx.ui.notify("Handoff ready; review and submit the prompt.", "info");
				},
			});
			if (result.cancelled) ctx.ui.notify("Handoff session change cancelled", "info");
		},
	});
}
