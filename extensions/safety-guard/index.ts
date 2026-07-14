import {
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolCallEventResult,
	type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { showSafetyConfirmation, type SafetyConfirmationResult } from "./dialog";
import { findCommandDecision, findToolPathDecision, type GuardDecision } from "./policy";

function blockedMessage(decision: GuardDecision): string {
	return `Safety Guard blocked this operation (${decision.ruleName}): ${decision.reason}`;
}

async function confirm(
	decision: GuardDecision,
	subject: string,
	ctx: ExtensionContext,
): Promise<SafetyConfirmationResult> {
	return showSafetyConfirmation(ctx, decision.reason, subject);
}

function rejectedReason(decision: GuardDecision, feedback?: string): string {
	const reason = `Safety Guard: operation rejected (${decision.ruleName}).`;
	return feedback ? `${reason} User feedback: ${feedback}` : reason;
}

async function guardTool(
	decision: GuardDecision,
	subject: string,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
	if (decision.action === "block") {
		const reason = blockedMessage(decision);
		if (ctx.hasUI) ctx.ui.notify(reason, "warning");
		return { block: true, reason };
	}
	const result = await confirm(decision, subject, ctx);
	if (result.allowed) return undefined;
	return { block: true, reason: rejectedReason(decision, result.feedback) };
}

async function guardUserBash(
	decision: GuardDecision,
	command: string,
	ctx: ExtensionContext,
): Promise<UserBashEventResult | undefined> {
	const confirmation = decision.action === "confirm"
		? await confirm(decision, `Command: ${command}`, ctx)
		: undefined;
	if (confirmation?.allowed) return undefined;
	const reason = decision.action === "block"
		? blockedMessage(decision)
		: rejectedReason(decision, confirmation?.feedback);
	if (ctx.hasUI && decision.action === "block") ctx.ui.notify(reason, "warning");
	return {
		result: {
			output: `${reason}\n`,
			exitCode: 1,
			cancelled: false,
			truncated: false,
		},
	};
}

export default function safetyGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("bash", event)) {
			const command = event.input.command.trim();
			const decision = findCommandDecision(command);
			return decision ? guardTool(decision, `Command: ${command}`, ctx) : undefined;
		}

		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			const decision = findToolPathDecision(event.input.path);
			return decision ? guardTool(decision, `Path: ${event.input.path}`, ctx) : undefined;
		}

		return undefined;
	});

	pi.on("user_bash", async (event, ctx) => {
		const command = event.command.trim();
		const decision = findCommandDecision(command);
		return decision ? guardUserBash(decision, command, ctx) : undefined;
	});
}
