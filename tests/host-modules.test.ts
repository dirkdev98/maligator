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
import { serializeVmDefinition, WIRE_OPCODES } from "../src/serialize-vm.ts";

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

	it("rejects a compiled host program from the portable wire format", () => {
		const def = compile(
			`import { join } from "node:path";\nglobalThis.sink = [join("a"), process.pid];\n`,
			{ node: true },
		);
		expect(def.hostInstalls.length).toBeGreaterThan(0);
		expect(() => serializeVmDefinition(def)).toThrow(
			/host installs are not supported in portable wire definitions/,
		);
	});
});
