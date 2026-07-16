import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPresets, type Preset, type Presets, type ThinkingLevel } from "./config.ts";
import { reviewCommandDecision } from "./review-policy.ts";

interface OriginalState {
	model: ExtensionContext["model"];
	thinkingLevel: ThinkingLevel;
	tools: string[];
}

interface PresetState {
	name?: string;
}

function latestPresetName(ctx: ExtensionContext): string | undefined {
	let name: string | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== "preset-state") continue;
		const state = entry.data as PresetState | undefined;
		name = typeof state?.name === "string" ? state.name : undefined;
	}
	return name;
}

export default function presetsExtension(pi: ExtensionAPI): void {
	let presets: Presets = {};
	let activeName: string | undefined;
	let activePreset: Preset | undefined;
	let originalState: OriginalState | undefined;

	pi.registerFlag("preset", { description: "Apply a named workflow mode", type: "string" });

	function snapshotOriginal(ctx: ExtensionContext): void {
		if (originalState) return;
		originalState = {
			model: ctx.model,
			thinkingLevel: pi.getThinkingLevel(),
			tools: pi.getActiveTools(),
		};
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("preset", activeName ? ctx.ui.theme.fg("accent", `preset:${activeName}`) : undefined);
	}

	async function applyPreset(
		name: string,
		preset: Preset,
		ctx: ExtensionContext,
		options: { persist: boolean; notify: boolean },
	): Promise<void> {
		snapshotOriginal(ctx);
		if (preset.provider && preset.model) {
			const model = ctx.modelRegistry.find(preset.provider, preset.model);
			if (!model) {
				ctx.ui.notify(`Preset ${name}: model not found: ${preset.provider}/${preset.model}`, "warning");
			} else if (!(await pi.setModel(model))) {
				ctx.ui.notify(`Preset ${name}: no credentials for ${preset.provider}/${preset.model}`, "warning");
			}
		}
		if (preset.thinkingLevel) pi.setThinkingLevel(preset.thinkingLevel);
		if (preset.tools) {
			const available = new Set(pi.getAllTools().map((tool) => tool.name));
			const valid = preset.tools.filter((tool) => available.has(tool));
			const invalid = preset.tools.filter((tool) => !available.has(tool));
			if (invalid.length > 0) ctx.ui.notify(`Preset ${name}: unknown tools: ${invalid.join(", ")}`, "warning");
			pi.setActiveTools(valid);
		}
		activeName = name;
		activePreset = preset;
		if (options.persist) pi.appendEntry("preset-state", { name });
		updateStatus(ctx);
		if (options.notify) ctx.ui.notify(`Preset activated: ${name}`, "info");
	}

	async function clearPreset(ctx: ExtensionContext, persist: boolean, notify = true): Promise<void> {
		activeName = undefined;
		activePreset = undefined;
		if (originalState) {
			if (originalState.model) await pi.setModel(originalState.model);
			pi.setThinkingLevel(originalState.thinkingLevel);
			pi.setActiveTools(originalState.tools);
		}
		originalState = undefined;
		if (persist) pi.appendEntry("preset-state", {});
		updateStatus(ctx);
		if (notify) ctx.ui.notify("Normal mode restored", "info");
	}

	async function selectPreset(ctx: ExtensionContext): Promise<void> {
		const names = Object.keys(presets).sort();
		const selected = await ctx.ui.select("Select workflow mode", ["normal", ...names]);
		if (!selected) return;
		if (selected === "normal") {
			await clearPreset(ctx, true);
			return;
		}
		await applyPreset(selected, presets[selected], ctx, { persist: true, notify: true });
	}

	function loadConfig(ctx: ExtensionContext): void {
		const loaded = loadPresets(ctx.cwd, ctx.isProjectTrusted());
		presets = loaded.presets;
		for (const error of loaded.errors) ctx.ui.notify(`Preset config error: ${error}`, "warning");
	}

	pi.registerCommand("preset", {
		description: "Select or apply a workflow mode",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				await selectPreset(ctx);
				return;
			}
			if (name === "normal") {
				await clearPreset(ctx, true);
				return;
			}
			const preset = presets[name];
			if (!preset) {
				ctx.ui.notify(`Unknown mode: ${name}. Available: normal, ${Object.keys(presets).sort().join(", ")}`, "error");
				return;
			}
			await applyPreset(name, preset, ctx, { persist: true, notify: true });
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (activeName !== "review") return undefined;
		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			return { block: true, reason: "Review preset is read-only; file mutation tools are disabled." };
		}
		if (!isToolCallEventType("bash", event)) return undefined;
		const decision = reviewCommandDecision(event.input.command);
		if (decision.allowed) return undefined;
		const reason = `Review preset blocked this command: ${decision.reason}`;
		if (ctx.hasUI) ctx.ui.notify(reason, "warning");
		return { block: true, reason };
	});

	pi.on("before_agent_start", async (event) => {
		if (!activePreset?.instructions) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${activePreset.instructions}` };
	});

	pi.on("session_start", async (_event, ctx) => {
		loadConfig(ctx);
		const flag = pi.getFlag("preset");
		if (flag === "normal") {
			updateStatus(ctx);
			return;
		}
		const restoredName = typeof flag === "string" && flag ? flag : latestPresetName(ctx);
		if (!restoredName) {
			updateStatus(ctx);
			return;
		}
		const preset = presets[restoredName];
		if (!preset) {
			ctx.ui.notify(`Unknown restored preset: ${restoredName}`, "warning");
			return;
		}
		await applyPreset(restoredName, preset, ctx, { persist: false, notify: typeof flag === "string" });
	});

	pi.on("session_tree", async (_event, ctx) => {
		const name = latestPresetName(ctx);
		if (!name) {
			if (activeName) await clearPreset(ctx, false, false);
			return;
		}
		if (name !== activeName && presets[name]) {
			await applyPreset(name, presets[name], ctx, { persist: false, notify: false });
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => ctx.ui.setStatus("preset", undefined));
}
