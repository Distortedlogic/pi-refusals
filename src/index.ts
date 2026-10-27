import { constants } from "node:fs";
import { access, writeFile as fsWriteFile, lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createEditToolDefinition, type EditOperations, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

const editOperations: EditOperations = {
	access: (path) => access(path, constants.R_OK | constants.W_OK),
	readFile,
	writeFile: async (path, content) => {
		if (path.endsWith(".rs") && containsInvalidPreludeImport(content)) {
			throw new Error(PRELUDE_REFUSAL);
		}
		await fsWriteFile(path, content, "utf8");
	},
};

async function pathExists(path: string, cwd: string): Promise<boolean> {
	try {
		await lstat(resolve(cwd, path));
		return true;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(createEditToolDefinition(process.cwd(), { operations: editOperations }));

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
