import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const REFUSAL = "Blocked: The system prompt says to use write only for new files. Use edit for this existing file.";

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
		if (event.toolName !== "write" || typeof event.input.path !== "string") return undefined;
		if (!(await pathExists(resolveWritePath(event.input.path, ctx.cwd)))) return undefined;

		return { block: true, reason: REFUSAL };
	});
}
