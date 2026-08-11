import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { emitVmDefinition } from "../src/emit-vm.ts";
import { executeIROptimizations } from "../src/ir-opt.ts";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import type { VmDefinition } from "../src/lower-vm.ts";
import { lowerIrProgramToVmDefinition } from "../src/lower-vm.ts";
import { allocateRegisters } from "../src/register-alloc.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../src/semantic-program.ts";
import {
	deserializeVmDefinition,
	serializeVmDefinition,
	WIRE_OPCODES,
} from "../src/serialize-vm.ts";

/**
 * End-to-end coverage of the `node:*` host-built-in / `process` install manifest:
 * from a module graph through IR, lowering, and C emission. The
 * central invariant is that host-module exports become ordinary VM global slots,
 * while process remains an ordinary global-object property installed by a
 * slot-free manifest entry.
 */

const nodeOn = resolveBuildConfig({ surface: { node: true } });
const roots: Array<string> = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

/** Run the full compile pipeline for one entry module and return its definition. */
function compile(source: string, options: { node?: boolean } = {}): VmDefinition {
	const root = mkdtempSync(path.join(tmpdir(), "maligator-host-"));
	roots.push(root);
	const entry = path.join(root, "main.mjs");
	writeFileSync(entry, source);
	const program = loadEntrypointAndRunSemanticAnalysis(
		entry,
		options.node ? { buildConfig: nodeOn } : {},
	);
	const ir = compileSemanticProgramToIr(program);
	executeIROptimizations(ir);
	allocateRegisters(ir);
	return lowerIrProgramToVmDefinition(ir);
}

/** Every LOAD_GLOBAL slot index read anywhere in the program. */
function loadGlobalSlots(def: VmDefinition): Set<number> {
	const slots = new Set<number>();
	for (const fn of def.functions) {
		for (const instruction of fn.instructions) {
			if (instruction.opcode === "LOAD_GLOBAL") {
				slots.add(instruction.index);
			}
		}
	}
	return slots;
}

describe("host-install manifest", () => {
	it("compiles a used host import to a LOAD_GLOBAL slot, no new opcode", () => {
		const def = compile(
			`import { join } from "node:path";\nglobalThis.sink = join("a", "b");\n`,
			{ node: true },
		);

		expect(def.hostInstalls).toHaveLength(1);
		const install = def.hostInstalls[0]!;
		expect(install.installer).toBe("mal_host_install_node_path");
		expect(install.exports.map((e) => e.name)).toEqual(["join"]);

		// The export slot is read through the ordinary LOAD_GLOBAL.
		expect(typeof install.exports[0]!.slot).toBe("number");
		expect(loadGlobalSlots(def).has(install.exports[0]!.slot)).toBe(true);

		// No host-specific opcode was introduced: every emitted opcode is a known
		// wire opcode.
		const known = new Set<string>(WIRE_OPCODES);
		for (const fn of def.functions) {
			for (const instruction of fn.instructions) {
				expect(known.has(instruction.opcode)).toBe(true);
			}
		}
	});

	it("drops an imported-but-unused host export from the manifest (DCE)", () => {
		const def = compile(
			`import { join, resolve } from "node:path";\nglobalThis.sink = join("a");\n`,
			{ node: true },
		);
		expect(def.hostInstalls).toHaveLength(1);
		expect(def.hostInstalls[0]!.exports.map((e) => e.name)).toEqual(["join"]);
	});

	it("drops a host export whose final LOAD_GLOBAL is optimized away", () => {
		const def = compile(`import { join } from "node:path";\njoin;\n`, { node: true });
		expect(def.hostInstalls).toEqual([]);
		expect(loadGlobalSlots(def)).toEqual(new Set());
	});

	it("drops a side-effect-only host import", () => {
		const def = compile(`import "node:path";\nglobalThis.sink = 1;\n`, { node: true });
		expect(def.hostInstalls).toEqual([]);
	});

	it("retains host exports read by a surviving namespace", () => {
		const def = compile(`import * as path from "node:path";\nglobalThis.sink = path;\n`, {
			node: true,
		});
		const namespace = def.functions
			.flatMap((fn) => fn.instructions)
			.find((instruction) => instruction.opcode === "CREATE_MODULE_NAMESPACE");
		expect(namespace).toBeDefined();
		if (namespace?.opcode !== "CREATE_MODULE_NAMESPACE") {
			throw new Error("Expected a module namespace instruction");
		}
		expect(def.hostInstalls).toHaveLength(1);
		expect(def.hostInstalls[0]!.exports.map((entry) => entry.name)).toEqual([
			"basename",
			"delimiter",
			"dirname",
			"extname",
			"isAbsolute",
			"join",
			"normalize",
			"relative",
			"resolve",
			"sep",
			"default",
		]);
		expect(new Set(def.hostInstalls[0]!.exports.map((entry) => entry.slot))).toEqual(
			new Set(namespace.slots),
		);
	});

	it("binds newly curated path and crypto exports", () => {
		const def = compile(
			`import { normalize } from "node:path";\nimport { randomUUID } from "node:crypto";\nglobalThis.sink = [normalize, randomUUID];\n`,
			{ node: true },
		);
		expect(def.hostInstalls).toEqual([
			expect.objectContaining({
				installer: "mal_host_install_node_path",
				exports: [expect.objectContaining({ name: "normalize" })],
			}),
			expect.objectContaining({
				installer: "mal_host_install_node_crypto",
				exports: [expect.objectContaining({ name: "randomUUID" })],
			}),
		]);
	});

	it("binds a host default import through the manifest", () => {
		const def = compile(`import p from "node:path";\nglobalThis.sink = p;\n`, {
			node: true,
		});
		expect(def.hostInstalls[0]!.exports.map((e) => e.name)).toEqual(["default"]);
	});

	it("binds promise-based filesystem exports through their submodule installer", () => {
		const def = compile(
			`import fsPromises, { readdir } from "node:fs/promises";\nglobalThis.sink = [fsPromises, readdir];\n`,
			{ node: true },
		);
		expect(def.hostInstalls).toEqual([
			expect.objectContaining({
				installer: "mal_host_install_node_fs_promises",
				exports: [
					expect.objectContaining({ name: "readdir" }),
					expect.objectContaining({ name: "default" }),
				],
			}),
		]);
	});

	it("binds V8 flags and VM context helpers through separate installers", () => {
		const def = compile(
			`import { setFlagsFromString } from "node:v8";\nimport { runInNewContext } from "node:vm";\nglobalThis.sink = [setFlagsFromString, runInNewContext];\n`,
			{ node: true },
		);
		expect(def.hostInstalls).toEqual([
			expect.objectContaining({ installer: "mal_host_install_node_v8" }),
			expect.objectContaining({ installer: "mal_host_install_node_vm" }),
		]);
	});

	it("binds diagnostics tracing through its host installer", () => {
		const def = compile(
			`import { tracingChannel } from "node:diagnostics_channel";\nglobalThis.sink = tracingChannel;\n`,
			{ node: true },
		);
		expect(def.hostInstalls).toEqual([
			expect.objectContaining({
				installer: "mal_host_install_node_diagnostics_channel",
			}),
		]);
	});

	it("binds the worker main-thread identity through its host installer", () => {
		const def = compile(
			`import { isMainThread } from "node:worker_threads";\nglobalThis.sink = isMainThread;\n`,
			{ node: true },
		);
		expect(def.hostInstalls).toEqual([
			expect.objectContaining({
				installer: "mal_host_install_node_worker_threads",
			}),
		]);
	});

	it("binds node:events default and named constructor exports through one installer", () => {
		const def = compile(
			`import Events, { EventEmitter } from "node:events";\nglobalThis.sink = [Events, EventEmitter];\n`,
			{ node: true },
		);
		expect(def.hostInstalls).toEqual([
			expect.objectContaining({
				installer: "mal_host_install_node_events",
				exports: [
					expect.objectContaining({ name: "EventEmitter" }),
					expect.objectContaining({ name: "default" }),
				],
			}),
		]);
	});

	it("binds callable node:assert default and named exports", () => {
		const def = compile(
			`import assert, { strictEqual } from "node:assert";\nglobalThis.sink = [assert, strictEqual];\n`,
			{ node: true },
		);
		expect(def.hostInstalls).toEqual([
			expect.objectContaining({
				installer: "mal_host_install_node_assert",
				exports: [
					expect.objectContaining({ name: "strictEqual" }),
					expect.objectContaining({ name: "default" }),
				],
			}),
		]);
	});

	it("binds node:tty default and named exports through one installer", () => {
		const def = compile(
			`import tty, { isatty } from "node:tty";\nglobalThis.sink = [tty, isatty];\n`,
			{ node: true },
		);
		expect(def.hostInstalls).toEqual([
			expect.objectContaining({
				installer: "mal_host_install_node_tty",
				exports: [
					expect.objectContaining({ name: "isatty" }),
					expect.objectContaining({ name: "default" }),
				],
			}),
		]);
	});

	it("drops the node:tty installer when its export read is optimized away", () => {
		const def = compile(`import { isatty } from "node:tty";\nisatty;\n`, {
			node: true,
		});
		expect(def.hostInstalls).toEqual([]);
	});

	it("binds node:util default and named exports through one installer", () => {
		const def = compile(
			`import util, { format } from "node:util";\nglobalThis.sink = [util, format];\n`,
			{ node: true },
		);
		expect(def.hostInstalls).toEqual([
			expect.objectContaining({
				installer: "mal_host_install_node_util",
				exports: [
					expect.objectContaining({ name: "format" }),
					expect.objectContaining({ name: "default" }),
				],
			}),
		]);
	});

	it("drops the node:events installer when its constructor read is optimized away", () => {
		const def = compile(`import { EventEmitter } from "node:events";\nEventEmitter;\n`, {
			node: true,
		});
		expect(def.hostInstalls).toEqual([]);
	});

	it("coalesces free Buffer and node:buffer exports into one installer", () => {
		const def = compile(
			`import buffer, { Buffer as ImportedBuffer } from "node:buffer";\nglobalThis.sink = [buffer, ImportedBuffer, Buffer];\n`,
			{ node: true },
		);
		expect(def.hostInstalls).toEqual([
			expect.objectContaining({
				installer: "mal_host_install_node_buffer",
				exports: [
					expect.objectContaining({ name: "Buffer" }),
					expect.objectContaining({ name: "default" }),
				],
			}),
		]);
	});

	it("installs free Buffer without a module import", () => {
		const def = compile(`globalThis.sink = Buffer.from("x");\n`, { node: true });
		expect(def.hostInstalls).toEqual([
			{ installer: "mal_host_install_node_buffer", exports: [] },
		]);
	});

	it("drops an unreachable free Buffer and an unused node:buffer import", () => {
		const def = compile(
			`import { Buffer as ImportedBuffer } from "node:buffer";\nfunction unused() { return [ImportedBuffer, Buffer]; }\nglobalThis.sink = 1;\n`,
			{ node: true },
		);
		expect(def.hostInstalls).toEqual([]);
	});

	it("detects and installs the free global `process`", () => {
		const def = compile(`globalThis.sink = process.argv;\n`, { node: true });
		const install = def.hostInstalls.find(
			(i) => i.installer === "mal_host_install_process",
		);
		expect(install?.exports).toEqual([]);
		expect(def.functions.flatMap((fn) => fn.instructions)).toContainEqual(
			expect.objectContaining({ opcode: "LOAD_GLOBAL_PROPERTY" }),
		);
	});

	it("stores assignment to process through the global object", () => {
		const def = compile(`process = globalThis.replacement;\n`, { node: true });
		expect(def.hostInstalls).toContainEqual({
			installer: "mal_host_install_process",
			exports: [],
		});
		expect(def.functions.flatMap((fn) => fn.instructions)).toContainEqual(
			expect.objectContaining({ opcode: "STORE_GLOBAL_PROPERTY" }),
		);
	});

	it("installs `process` when it is only read by typeof", () => {
		const def = compile(`globalThis.sink = typeof process;\n`, { node: true });
		expect(def.hostInstalls.map((i) => i.installer)).toContain(
			"mal_host_install_process",
		);
	});

	it("installs Node text encoding globals without the web surface", () => {
		const def = compile(`globalThis.sink = new TextDecoder();\n`, { node: true });
		expect(def.hostInstalls).toContainEqual({
			installer: "mal_host_install_process",
			exports: [],
		});
	});

	it("leaves an ordinary program's manifest empty", () => {
		const def = compile(`globalThis.sink = process;\n`, { node: false });
		expect(def.hostInstalls).toEqual([]);
	});

	it("drops process used only by an unreachable function", () => {
		const def = compile(`function unused() { return process; }\nglobalThis.sink = 1;\n`, {
			node: true,
		});
		expect(def.hostInstalls).toEqual([]);
	});

	it("emits a direct installer reference for a reached host module", () => {
		const def = compile(
			`import { join } from "node:path";\nglobalThis.sink = join("a");\n`,
			{ node: true },
		);
		const c = emitVmDefinition(def, { compiled: false });
		expect(c).toContain(
			"extern void mal_host_install_node_path(MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);",
		);
		expect(c).toContain(".installer = mal_host_install_node_path");
		expect(c).toContain('{ .name = "join", .slot =');
		expect(c).toContain(".host_install_count = 1,");
	});

	it("emits no host symbol for an ordinary program", () => {
		const def = compile(`globalThis.sink = 1 + 1;\n`, { node: false });
		const c = emitVmDefinition(def, { compiled: false });
		expect(c).not.toContain("mal_host_install_");
		expect(c).toContain(".host_install_count = 0,");
		expect(c).toContain(".host_installs = nullptr,");
	});

	it("round-trips a compiled host program through the portable wire format", () => {
		const def = compile(
			`import { join } from "node:path";\nglobalThis.sink = [join("a"), process.pid];\n`,
			{ node: true },
		);
		expect(def.hostInstalls.length).toBeGreaterThan(0);
		const restored = deserializeVmDefinition(serializeVmDefinition(def));
		expect(restored.hostInstalls).toEqual(def.hostInstalls);
	});
});
