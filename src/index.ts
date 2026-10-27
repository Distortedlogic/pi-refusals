import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISALLOWED_BASH_TOOL = /\b(?:awk|sed)\b/u;
const PRELUDE_GLOB = "::prelude::*";
const BASH_REFUSAL = "Blocked: The system prompt disallows sed and awk. Use the provided tools instead.";
const PRELUDE_REFUSAL =
	"Blocked: The system prompt requires prelude imports to use `::prelude::*` to avoid import churn.";
const WRITE_REFUSAL =
	"Blocked: The system prompt says to use write only for new files. Use edit for this existing file.";

function containsInvalidPrelude(text: string): boolean {
	return text.replaceAll(PRELUDE_GLOB, "").includes("prelude");
}

function editAddsInvalidPrelude(input: Record<string, unknown>): boolean {
	if (typeof input.newText === "string" && containsInvalidPrelude(input.newText)) return true;
	if (!Array.isArray(input.edits)) return false;

	return input.edits.some((edit) => {
		if (!edit || typeof edit !== "object" || Array.isArray(edit)) return false;
		const newText = (edit as Record<string, unknown>).newText;
		return typeof newText === "string" && containsInvalidPrelude(newText);
	});
}

async function pathExists(path: string, cwd: string): Promise<boolean> {
	try {
		await lstat(resolve(cwd, path));
		return true;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (
			event.toolName === "bash" &&
			typeof event.input.command === "string" &&
			DISALLOWED_BASH_TOOL.test(event.input.command)
		) {
			return { block: true, reason: BASH_REFUSAL };
		}

		if (
			(event.toolName === "write" &&
				typeof event.input.content === "string" &&
				containsInvalidPrelude(event.input.content)) ||
			(event.toolName === "edit" && editAddsInvalidPrelude(event.input))
		) {
			return { block: true, reason: PRELUDE_REFUSAL };
		}

		if (event.toolName !== "write" || typeof event.input.path !== "string") return undefined;
		if (!(await pathExists(event.input.path, ctx.cwd))) return undefined;

		return { block: true, reason: WRITE_REFUSAL };
	});
}
