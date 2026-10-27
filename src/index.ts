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

type Replacement = { oldText: string; newText: string };

function getReplacements(input: Record<string, unknown>): Replacement[] {
	const replacements: Replacement[] = [];
	if (Array.isArray(input.edits)) {
		for (const edit of input.edits) {
			if (!edit || typeof edit !== "object" || Array.isArray(edit)) continue;
			const replacement = edit as Record<string, unknown>;
			if (typeof replacement.oldText === "string" && typeof replacement.newText === "string") {
				replacements.push({ oldText: replacement.oldText, newText: replacement.newText });
			}
		}
	}
	if (typeof input.oldText === "string" && typeof input.newText === "string") {
		replacements.push({ oldText: input.oldText, newText: input.newText });
	}
	return replacements;
}

async function editCreatesInvalidPreludeImport(input: Record<string, unknown>, cwd: string): Promise<boolean> {
	if (typeof input.path !== "string" || !input.path.endsWith(".rs")) return false;

	const replacements = getReplacements(input);
	if (replacements.length === 0) return false;
	const invalidAddition = replacements.some(({ newText }) => containsInvalidPreludeImport(newText));

	let content: string;
	try {
		content = await readFile(resolve(cwd, input.path), "utf8");
	} catch {
		return invalidAddition;
	}
	content = content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");

	const matches: Array<Replacement & { index: number }> = [];
	for (const replacement of replacements) {
		const oldText = replacement.oldText.replace(/\r\n?/gu, "\n");
		const newText = replacement.newText.replace(/\r\n?/gu, "\n");
		const index = content.indexOf(oldText);
		if (oldText.length === 0 || index < 0 || content.indexOf(oldText, index + oldText.length) >= 0) {
			return invalidAddition;
		}
		matches.push({ oldText, newText, index });
	}

	matches.sort((left, right) => left.index - right.index);
	for (let index = 1; index < matches.length; index += 1) {
		const previous = matches[index - 1];
		if (previous.index + previous.oldText.length > matches[index].index) return invalidAddition;
	}

	for (const match of matches.toReversed()) {
		content = `${content.slice(0, match.index)}${match.newText}${content.slice(match.index + match.oldText.length)}`;
	}
	return containsInvalidPreludeImport(content);
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

		if (
			(event.toolName === "write" &&
				typeof event.input.path === "string" &&
				event.input.path.endsWith(".rs") &&
				typeof event.input.content === "string" &&
				containsInvalidPreludeImport(event.input.content)) ||
			(event.toolName === "edit" && (await editCreatesInvalidPreludeImport(event.input, ctx.cwd)))
		) {
			return { block: true, reason: PRELUDE_REFUSAL };
		}

		if (event.toolName !== "write" || typeof event.input.path !== "string") return undefined;
		if (!(await pathExists(event.input.path, ctx.cwd))) return undefined;

		return { block: true, reason: WRITE_REFUSAL };
	});
}
