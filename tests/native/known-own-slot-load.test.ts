import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type {
	VmDefinition,
	VmFunction,
	VmInstruction,
} from "../../src/compiler/target/lower-vm.ts";
import { buildNativeDefinition, STRESS_ENV } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-known-own-slot-"));
const mainFile = "runtime/known_own_slot_test_main.c";

const instructions: Array<VmInstruction> = [
	{ opcode: "CREATE_NUMBER", dst: 0, value: 41 },
	{ opcode: "CREATE_NUMBER", dst: 1, value: 42 },
	{ opcode: "CREATE_NUMBER", dst: 2, value: 0 },
	// The guarded row 1 is referenced before its allocation executes. VM startup
	// pre-instantiates it, and shape interning makes this row-0 {x} object match.
	{
		opcode: "CREATE_OBJECT_SHAPED",
		dst: 3,
		count: 1,
		keyStringIndices: [0],
		valueRegisters: [1],
		shapeCacheIndex: 0,
	},
	{
		opcode: "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT",
		dst: 4,
		object: 3,
		stringIndex: 0,
		icIndex: 0,
		candidates: [{ shapeFunctionIndex: 0, shapeCacheIndex: 1, slot: 0 }],
	},
	{
		opcode: "CREATE_OBJECT_SHAPED",
		dst: 5,
		count: 1,
		keyStringIndices: [0],
		valueRegisters: [0],
		shapeCacheIndex: 1,
	},
	{
		opcode: "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT",
		dst: 6,
		object: 5,
		stringIndex: 0,
		icIndex: 1,
		candidates: [{ shapeFunctionIndex: 0, shapeCacheIndex: 1, slot: 0 }],
	},
	{
		opcode: "CREATE_OBJECT_SHAPED",
		dst: 7,
		count: 2,
		keyStringIndices: [1, 0],
		valueRegisters: [2, 1],
		shapeCacheIndex: 2,
	},
	{
		opcode: "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT",
		dst: 8,
		object: 7,
		stringIndex: 0,
		icIndex: 2,
		candidates: [
			{ shapeFunctionIndex: 0, shapeCacheIndex: 1, slot: 0 },
			{ shapeFunctionIndex: 0, shapeCacheIndex: 2, slot: 1 },
		],
	},
	// Adding y transitions the source object away from the certified {x} shape.
	{ opcode: "STORE_PROPERTY_STATIC", object: 5, value: 2, stringIndex: 1, icIndex: 3 },
	{
		opcode: "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT",
		dst: 9,
		object: 5,
		stringIndex: 0,
		icIndex: 4,
		candidates: [
			{ shapeFunctionIndex: 0, shapeCacheIndex: 1, slot: 0 },
			{ shapeFunctionIndex: 0, shapeCacheIndex: 2, slot: 1 },
		],
	},
	{ opcode: "CREATE_NUMBER", dst: 11, value: 50 },
	{
		opcode: "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT",
		object: 3,
		value: 11,
		stringIndex: 0,
		icIndex: 5,
		candidates: [{ shapeFunctionIndex: 0, shapeCacheIndex: 1, slot: 0 }],
	},
	{
		opcode: "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT",
		object: 5,
		value: 11,
		stringIndex: 0,
		icIndex: 6,
		candidates: [{ shapeFunctionIndex: 0, shapeCacheIndex: 1, slot: 0 }],
	},
	{
		opcode: "LOAD_PROPERTY_STATIC",
		dst: 12,
		object: 3,
		stringIndex: 0,
		icIndex: 7,
	},
	{
		opcode: "LOAD_PROPERTY_STATIC",
		dst: 13,
		object: 5,
		stringIndex: 0,
		icIndex: 8,
	},
	{ opcode: "BINARY", dst: 10, left: 4, right: 6, operator: "+" },
	{ opcode: "BINARY", dst: 10, left: 10, right: 8, operator: "+" },
	{ opcode: "BINARY", dst: 10, left: 10, right: 9, operator: "+" },
	{ opcode: "BINARY", dst: 10, left: 10, right: 12, operator: "+" },
	{ opcode: "BINARY", dst: 10, left: 10, right: 13, operator: "+" },
	{ opcode: "STORE_GLOBAL", src: 10, index: 0 },
	{ opcode: "RETURN", value: 10 },
];

const fn: VmFunction = {
	nameStringIndex: -1,
	isGenerator: false,
	isAsync: false,
	parameterCount: 0,
	mappedArguments: false,
	mappedArgumentSlots: [],
	length: 0,
	registerCount: 14,
	capturedCount: 0,
	strict: true,
	needsArguments: false,
	argumentSnapshotCount: 0,
	argumentSnapshotPlan: [],
	isDerivedConstructor: false,
	isClassConstructor: false,
	hasPrototype: false,
	instructions,
	handlers: [],
	fileIndex: 0,
	positions: [],
	registerRepresentations: Array.from({ length: 14 }, () => "boxed"),
};

const definition: VmDefinition = {
	entrypointPath: "/fixture/known-own-slot.mjs",
	functionCount: 1,
	functions: [fn],
	stringConstants: [["x".charCodeAt(0)], ["y".charCodeAt(0)]],
	bigintConstants: [],
	literalTemplateData: [],
	globalCount: 1,
	files: [],
	sourcePositions: [],
	cjsModuleFunctionIndices: [],
	hostInstalls: [],
};

function run(binary: string, environment: NodeJS.ProcessEnv = {}): string {
	const result = spawnSync(binary, [], {
		env: { ...process.env, ...environment },
		encoding: "utf8",
		timeout: 60_000,
	});
	if (result.error) throw result.error;
	expect(result.status, result.stderr || result.stdout).toBe(0);
	return result.stderr;
}

function perfField(stderr: string, field: string): number {
	const line = stderr.match(/^\[perf-known-own-slot-stats\].*$/m)?.[0] ?? "";
	return Number(line.match(new RegExp(`(?:^|\\s)${field}=([0-9]+)`))?.[1] ?? -1);
}

describe("guarded known-own-slot accesses", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		const environment = { ...process.env, MAL_PERF_STATS: "1" };
		compiled = buildNativeDefinition(definition, {
			name: "known-own-slot-compiled",
			compiled: true,
			mainFile,
			outDir,
			environment,
		});
		interpreted = buildNativeDefinition(definition, {
			name: "known-own-slot-interpreted",
			compiled: false,
			mainFile,
			outDir,
			environment,
		});
	}, 600_000);

	it("preserves polymorphic hits and mutation fallback semantics", () => {
		run(compiled);
		run(interpreted);
		run(compiled, STRESS_ENV);
		run(interpreted, STRESS_ENV);
	});

	it("reports the same guarded decision in both backends", () => {
		for (const binary of [compiled, interpreted]) {
			const stderr = run(binary, { MAL_PERF_STATS: "1" });
			expect(stderr).toContain("[perf-known-own-slot-stats]");
			expect(perfField(stderr, "probes")).toBe(4);
			expect(perfField(stderr, "hits")).toBe(3);
			expect(perfField(stderr, "fallbacks")).toBe(1);
			expect(perfField(stderr, "store_probes")).toBe(2);
			expect(perfField(stderr, "store_hits")).toBe(1);
			expect(perfField(stderr, "store_fallbacks")).toBe(1);
		}
	});
});
