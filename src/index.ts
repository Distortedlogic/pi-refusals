import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const DISALLOWED_BASH_TOOL = /\b(?:awk|grep|rg|sed)\b/u;
const PRELUDE_IMPORT = /(?:(?<=^)|(?<=[;\n]))[\t ]*(?:pub(?:\s*\([^)]*\))?\s+)?use\b[^;]*\bprelude\b[^;]*;/gmu;
const PRELUDE_GLOB = /::\s*prelude\s*::\s*\*/gu;
const PRELUDE_WORD = /\bprelude\b/u;
const USE_ROOT = /\buse\s+(?:::)?([A-Za-z_][A-Za-z0-9_]*)\s*::/u;
const COMMAND_REFUSAL = "Blocked: The system prompt disallows sed, awk, rg, and grep. Use an allowed tool instead.";
const PRELUDE_REFUSAL =
	"Blocked: The system prompt requires repository cross-crate prelude imports to use `::prelude::*` to avoid import churn.";
const WRITE_REFUSAL =
	"Blocked: The system prompt says to use write only for new files. Use edit for this existing file.";

interface CargoTarget {
	name: string;
	kind: string[];
}

interface CargoPackage {
	id: string;
	manifest_path: string;
	targets: CargoTarget[];
}

interface CargoMetadata {
	packages: CargoPackage[];
	workspace_members: string[];
}

const cargoMetadataCache = new Map<string, Promise<CargoMetadata | undefined>>();

function containsPath(root: string, path: string): boolean {
	const child = relative(root, path);
	return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function getCargoMetadata(cwd: string): Promise<CargoMetadata | undefined> {
	let cached = cargoMetadataCache.get(cwd);
	if (!cached) {
		cached = (async () => {
			try {
				const { stdout } = await execFileAsync("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
					cwd,
					encoding: "utf8",
					timeout: 10_000,
				});
				return JSON.parse(String(stdout)) as CargoMetadata;
			} catch {
				return undefined;
			}
		})();
		cargoMetadataCache.set(cwd, cached);
	}
	return cached;
}

async function getRepositoryCrates(cwd: string, path: string): Promise<Set<string>> {
	const metadata = await getCargoMetadata(cwd);
	if (!metadata) return new Set();

	const memberIds = new Set(metadata.workspace_members);
	const packages = metadata.packages.filter((pkg) => memberIds.has(pkg.id));
	const absolutePath = resolve(cwd, path);
	let currentPackage: CargoPackage | undefined;

	for (const pkg of packages) {
		const root = dirname(pkg.manifest_path);
		if (
			containsPath(root, absolutePath) &&
			(!currentPackage || root.length > dirname(currentPackage.manifest_path).length)
		) {
			currentPackage = pkg;
		}
	}

	const crates = new Set<string>();
	for (const pkg of packages) {
		if (pkg.id === currentPackage?.id) continue;
		for (const target of pkg.targets) {
			if (target.kind.includes("lib")) crates.add(target.name);
		}
	}
	return crates;
}

function containsInvalidPreludeImport(text: string, repositoryCrates: ReadonlySet<string>): boolean {
	return [...text.matchAll(PRELUDE_IMPORT)].some((match) => {
		const root = USE_ROOT.exec(match[0])?.[1];
		return Boolean(root && repositoryCrates.has(root) && PRELUDE_WORD.test(match[0].replace(PRELUDE_GLOB, "")));
	});
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
			if (candidate === undefined) return { block: true, reason: PRELUDE_REFUSAL };
			if (PRELUDE_WORD.test(candidate)) {
				const repositoryCrates = await getRepositoryCrates(ctx.cwd, event.input.path);
				if (containsInvalidPreludeImport(candidate, repositoryCrates)) {
					return { block: true, reason: PRELUDE_REFUSAL };
				}
			}
		}

		if (
			event.toolName === "write" &&
			typeof event.input.path === "string" &&
			event.input.path.endsWith(".rs") &&
			typeof event.input.content === "string" &&
			PRELUDE_WORD.test(event.input.content)
		) {
			const repositoryCrates = await getRepositoryCrates(ctx.cwd, event.input.path);
			if (containsInvalidPreludeImport(event.input.content, repositoryCrates)) {
				return { block: true, reason: PRELUDE_REFUSAL };
			}
		}

		if (event.toolName !== "write" || typeof event.input.path !== "string") return undefined;
		if (!(await pathExists(event.input.path, ctx.cwd))) return undefined;

		return { block: true, reason: WRITE_REFUSAL };
	});
}
