import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bashRenderers, type BashRenderers } from "./renderers.ts";
import { editRenderers, readRenderers, writeRenderers } from "./file-renderers.ts";
import { exaRenderers } from "./exa-renderers.ts";
import type { ToolRenderers } from "./layout.ts";

// Pi 0.99.2 remains a supported execution/test baseline, but has no independent
// renderer API. Leave its tools alone rather than replacing an SSH executor.
type Renderers = BashRenderers | ToolRenderers;
type RendererResolver = (name: string, next: () => Renderers | undefined) => Renderers | undefined;
type RenderingAPI = ExtensionAPI & { registerToolRenderer?: (resolver: RendererResolver) => void };

export default function compactTools(pi: RenderingAPI): void {
	pi.registerToolRenderer?.((name, next) => {
		if (name === "bash") return bashRenderers;
		if (name === "read") return readRenderers;
		if (name === "edit") return editRenderers;
		if (name === "write") return writeRenderers;
		if (name === "exa_search") return exaRenderers;
		return next();
	});
}
