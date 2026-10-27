import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	discoverAndLoadExtensions,
	ExtensionRunner,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const commandRefusal = "Blocked: The system prompt disallows sed, awk, rg, and grep. Use an allowed tool instead.";
const preludeRefusal =
	"Blocked: The system prompt requires Rust prelude imports to use `::prelude::*` to avoid import churn.";
const writeRefusal =
	"Blocked: The system prompt says to use write only for new files. Use edit for this existing file.";

test("enforces refusal rules", { timeout: 120_000 }, async (t) => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-refusals-test-"));
	t.after(() => rm(workspace, { recursive: true, force: true }));
	const agentDirectory = join(workspace, "agent");
	await mkdir(agentDirectory);

	const loaded = await discoverAndLoadExtensions([projectDirectory], workspace, agentDirectory);
	assert.deepEqual(loaded.errors, []);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDirectory, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		workspace,
		SessionManager.inMemory(workspace),
		new ModelRegistry(modelRuntime),
	);

	for (const [toolCallId, command] of [
		["sed", "sed -n 1p file"],
		["awk", "awk '{print $1}' file"],
		["rg", "rg -n pattern ."],
		["grep-bash", "grep pattern file"],
	]) {
		assert.deepEqual(
			await runner.emitToolCall({ type: "tool_call", toolCallId, toolName: "bash", input: { command } }),
			{ block: true, reason: commandRefusal },
		);
	}
	assert.deepEqual(
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "grep-tool",
			toolName: "grep",
			input: { pattern: "pattern", path: "." },
		}),
		{ block: true, reason: commandRefusal },
	);

	await writeFile(join(workspace, "existing.txt"), "old");
	assert.deepEqual(
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "existing-write",
			toolName: "write",
			input: { path: "existing.txt", content: "new" },
		}),
		{ block: true, reason: writeRefusal },
	);
	assert.equal(
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "new-write",
			toolName: "write",
			input: { path: "new.txt", content: "new" },
		}),
		undefined,
	);

	assert.deepEqual(
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "invalid-prelude-write",
			toolName: "write",
			input: { path: "invalid.rs", content: "use crate::prelude::Thing;\n" },
		}),
		{ block: true, reason: preludeRefusal },
	);
	assert.equal(
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "valid-prelude-write",
			toolName: "write",
			input: { path: "valid.rs", content: "use crate::prelude::*;\n" },
		}),
		undefined,
	);
	assert.equal(
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "markdown-write",
			toolName: "write",
			input: { path: "ARCH-02.md", content: preludeRefusal },
		}),
		undefined,
	);
	assert.equal(
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "prelude-module",
			toolName: "write",
			input: { path: "lib.rs", content: "pub mod prelude;\n" },
		}),
		undefined,
	);

	await writeFile(join(workspace, "to-named.rs"), "use crate::prelude::*;\n");
	assert.deepEqual(
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "to-named",
			toolName: "edit",
			input: { path: "to-named.rs", edits: [{ oldText: "*", newText: "Thing" }] },
		}),
		{ block: true, reason: preludeRefusal },
	);
	assert.equal(await readFile(join(workspace, "to-named.rs"), "utf8"), "use crate::prelude::*;\n");

	await writeFile(join(workspace, "to-glob.rs"), "use crate::prelude::Thing;\n");
	assert.equal(
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "to-glob",
			toolName: "edit",
			input: { path: "to-glob.rs", edits: [{ oldText: "Thing", newText: "*" }] },
		}),
		undefined,
	);
	assert.deepEqual(
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "unverifiable",
			toolName: "edit",
			input: { path: "to-glob.rs", edits: [{ oldText: "missing", newText: "value" }] },
		}),
		{ block: true, reason: preludeRefusal },
	);

	await writeFile(join(workspace, "ARCH-02.md"), "old");
	assert.equal(
		await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "markdown-edit",
			toolName: "edit",
			input: { path: "ARCH-02.md", edits: [{ oldText: "old", newText: preludeRefusal }] },
		}),
		undefined,
	);
});
