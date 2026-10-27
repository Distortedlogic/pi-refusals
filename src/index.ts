import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ParseEntry, parse } from "shell-quote";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const DISALLOWED_BASH_TOOLS = new Set(["awk", "sed"]);
const SHELLS = new Set(["bash", "dash", "ksh", "sh", "zsh"]);
const DISALLOWED_BASH_TOOL_FALLBACK = /(?:^|[^A-Za-z0-9_-])(?:awk|sed)(?=$|[^A-Za-z0-9_-])/u;
const BASH_REFUSAL = "Blocked: The system prompt disallows sed and awk. Use the provided tools instead.";
const WRITE_REFUSAL =
	"Blocked: The system prompt says to use write only for new files. Use edit for this existing file.";

function containsDisallowedBashTool(command: string, depth = 0): boolean {
	let tokens: ParseEntry[];
	try {
		tokens = parse(command);
	} catch {
		return DISALLOWED_BASH_TOOL_FALLBACK.test(command);
	}

	if (tokens.some((token) => typeof token === "string" && DISALLOWED_BASH_TOOLS.has(basename(token)))) {
		return true;
	}
	if (depth >= 2) return false;

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (typeof token !== "string" || !SHELLS.has(basename(token))) continue;

		for (let optionIndex = index + 1; optionIndex < tokens.length; optionIndex += 1) {
			const option = tokens[optionIndex];
			if (typeof option !== "string") break;
			if (!/^-[^-]*c/u.test(option)) continue;

			const nestedCommand = tokens[optionIndex + 1];
			if (typeof nestedCommand === "string" && containsDisallowedBashTool(nestedCommand, depth + 1)) return true;
			break;
		}
	}

	return false;
}

function resolveWritePath(input: string, cwd: string): string {
	let path = input.replace(UNICODE_SPACES, " ");
	if (path.startsWith("@")) path = path.slice(1);

	if (path === "~") {
		path = homedir();
	} else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
		path = join(homedir(), path.slice(2));
	}

	if (path.startsWith("file://")) path = fileURLToPath(path);
	return resolve(cwd, path);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"));
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (
			event.toolName === "bash" &&
			typeof event.input.command === "string" &&
			containsDisallowedBashTool(event.input.command)
		) {
			return { block: true, reason: BASH_REFUSAL };
		}

		if (event.toolName !== "write" || typeof event.input.path !== "string") return undefined;
		if (!(await pathExists(resolveWritePath(event.input.path, ctx.cwd)))) return undefined;

		return { block: true, reason: WRITE_REFUSAL };
	});
}
