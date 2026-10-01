import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

export function handoffSessionName(goal: string): string {
	const normalized = goal.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
	const characters = [...normalized];
	return characters.length <= 60 ? normalized : `${characters.slice(0, 59).join("")}…`;
}

export default function handoffExtension(pi: ExtensionAPI): void {
	pi.registerCommand("handoff", {
		description: "Create a focused replacement session for the next goal",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/handoff requires interactive mode", "error");
				return;
			}
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal for the new session>", "error");
				return;
			}
			const { messages } = ctx.sessionManager.buildSessionProjection();
			const conversation = serializeConversation(convertToLlm(messages));
			if (!conversation.trim()) {
				ctx.ui.notify("No conversation to hand off", "warning");
				return;
			}

			const currentSessionFile = ctx.sessionManager.getSessionFile();
			let generationError: string | undefined;
			const generated = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
				const loader = new BorderedLoader(tui, theme, "Generating focused handoff...");
				let settled = false;
				const finish = (value: string | null) => {
					if (settled) return;
					settled = true;
					done(value);
				};
				loader.onAbort = () => finish(null);
				const run = async () => {
					const response = await ctx.modelRegistry.complete(
						model,
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
						{ signal: loader.signal, cacheRetention: "none", sessionId: uuidv7() },
					);
					if (loader.signal.aborted || response.stopReason === "aborted") return null;
					if (response.stopReason === "error") throw new Error(response.errorMessage || "Model generation failed.");
					const text = response.content
						.filter((item): item is { type: "text"; text: string } => item.type === "text")
						.map((item) => item.text)
						.join("\n")
						.trim();
					if (!text) throw new Error("Model returned an empty handoff prompt.");
					return text;
				};
				run().then(finish).catch((error) => {
					if (!settled && !loader.signal.aborted) {
						generationError = error instanceof Error ? error.message : String(error);
					}
					finish(null);
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
				setup: async (sessionManager) => {
					sessionManager.appendSessionInfo(handoffSessionName(goal));
				},
				withSession: async (replacementCtx) => {
					replacementCtx.ui.setEditorText(edited);
					replacementCtx.ui.notify("Handoff ready; review and submit the prompt.", "info");
				},
			});
			if (result.cancelled) ctx.ui.notify("Handoff session change cancelled", "info");
		},
	});
}
