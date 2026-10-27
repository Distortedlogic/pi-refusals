import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISALLOWED_BASH_TOOL = /\b(?:awk|grep|rg|sed)\b/u;
const PRELUDE_IMPORT = /(?:(?<=^)|(?<=[;\n]))[\t ]*(?:pub(?:\s*\([^)]*\))?\s+)?use\b[^;]*\bprelude\b[^;]*;/gmu;
const PRELUDE_GLOB = /::\s*prelude\s*::\s*\*/gu;
const COMMAND_REFUSAL = "Blocked: The system prompt disallows sed, awk, rg, and grep. Use an allowed tool instead.";
const PRELUDE_REFUSAL =
	"Blocked: The system prompt requires Rust prelude imports to use `::prelude::*` to avoid import churn.";
const WRITE_REFUSAL =
	"Blocked: The system prompt says to use write only for new files. Use edit for this existing file.";

function containsInvalidPreludeImport(text: string): boolean {
	return [...text.matchAll(PRELUDE_IMPORT)].some((match) => /\bprelude\b/u.test(match[0].replace(PRELUDE_GLOB, "")));
}

interface Replacement {
	oldText: string;
	newText: string;
	index: number;
}

async function buildEditCandidate(input: Record<string, unknown>, cwd: string): Promise<string | undefined> {
	if (typeof input.path !== "string" || !Array.isArray(input.edits) || input.edits.length === 0) return undefined;

	let content: string;
	try {
		content = await readFile(resolve(cwd, input.path), "utf8");
	} catch {
		return undefined;
	}
	content = content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");

	const replacements: Replacement[] = [];
	for (const value of input.edits) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const edit = value as Record<string, unknown>;
		if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") return undefined;

		const oldText = edit.oldText.replace(/\r\n?/gu, "\n");
		const newText = edit.newText.replace(/\r\n?/gu, "\n");
		const index = content.indexOf(oldText);
		if (oldText.length === 0 || index < 0 || content.indexOf(oldText, index + oldText.length) >= 0) return undefined;
		replacements.push({ oldText, newText, index });
	}

	replacements.sort((left, right) => left.index - right.index);
	for (let index = 1; index < replacements.length; index += 1) {
		const previous = replacements[index - 1];
		if (previous.index + previous.oldText.length > replacements[index].index) return undefined;
	}

	for (const replacement of replacements.toReversed()) {
		content = `${content.slice(0, replacement.index)}${replacement.newText}${content.slice(replacement.index + replacement.oldText.length)}`;
	}
	return content;
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
			event.toolName === "grep" ||
			(event.toolName === "bash" &&
				typeof event.input.command === "string" &&
				DISALLOWED_BASH_TOOL.test(event.input.command))
		) {
			return { block: true, reason: COMMAND_REFUSAL };
		}

		if (event.toolName === "edit" && typeof event.input.path === "string" && event.input.path.endsWith(".rs")) {
			const candidate = await buildEditCandidate(event.input, ctx.cwd);
			if (candidate === undefined || containsInvalidPreludeImport(candidate)) {
				return { block: true, reason: PRELUDE_REFUSAL };
			}
		}

		if (
			event.toolName === "write" &&
			typeof event.input.path === "string" &&
			event.input.path.endsWith(".rs") &&
			typeof event.input.content === "string" &&
			containsInvalidPreludeImport(event.input.content)
		) {
			return { block: true, reason: PRELUDE_REFUSAL };
		}

		if (event.toolName !== "write" || typeof event.input.path !== "string") return undefined;
		if (!(await pathExists(event.input.path, ctx.cwd))) return undefined;

		return { block: true, reason: WRITE_REFUSAL };
	});
}
