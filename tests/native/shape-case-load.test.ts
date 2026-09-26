import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ProgramImage } from "../../src/compiler/target/program-image.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
} from "../../src/compiler/target/runtime-image.ts";
import { buildNativeProgramImage, STRESS_ENV } from "../../src/test-harness.ts";
import { testProgramImage, withNativeFunctionPlan } from "../helpers/program-image.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-shape-case-load-"));
const mainFile = "runtime/shape_case_load_test_main.c";

const instructions: Array<BytecodeInstruction> = [
	{ opcode: "CREATE_NUMBER", dst: 0, value: 1 },
	{ opcode: "CREATE_NUMBER", dst: 1, value: 2 },
	{ opcode: "CREATE_NUMBER", dst: 2, value: 3 },
	{ opcode: "CREATE_NUMBER", dst: 3, value: 4 },
	{ opcode: "CREATE_NUMBER", dst: 4, value: 5 },
	{ opcode: "CREATE_NUMBER", dst: 5, value: 6 },
	{
		opcode: "CREATE_OBJECT_SHAPED",
		dst: 6,
		count: 3,
		keyStringIndices: [0, 1, 2],
		valueRegisters: [0, 1, 2],
		shapeCacheIndex: 0,
	},
	{
		opcode: "SELECT_SHAPE_CASE",
		dst: 7,
		object: 6,
		candidates: [{ shapeFunctionIndex: 0, shapeCacheIndex: 0 }],
	},
	{
		opcode: "LOAD_PROPERTY_STATIC_SHAPE_CASE",
		dst: 8,
		object: 6,
		shapeCase: 7,
		stringIndex: 0,
		icIndex: 0,
		slots: [0],
	},
	{
		opcode: "LOAD_PROPERTY_STATIC_SHAPE_CASE",
		dst: 9,
		object: 6,
		shapeCase: 7,
		stringIndex: 1,
		icIndex: 1,
		slots: [1],
	},
	{
		opcode: "LOAD_PROPERTY_STATIC_SHAPE_CASE",
		dst: 10,
		object: 6,
		shapeCase: 7,
		stringIndex: 2,
		icIndex: 2,
		slots: [2],
	},
	{ opcode: "BINARY", dst: 11, left: 8, right: 9, operator: "+" },
	{ opcode: "BINARY", dst: 11, left: 11, right: 10, operator: "+" },
	{
		opcode: "CREATE_OBJECT_SHAPED",
		dst: 12,
		count: 4,
		keyStringIndices: [1, 0, 2, 3],
		valueRegisters: [4, 3, 5, 0],
		shapeCacheIndex: 1,
	},
	{
		opcode: "SELECT_SHAPE_CASE",
		dst: 13,
		object: 12,
		candidates: [{ shapeFunctionIndex: 0, shapeCacheIndex: 0 }],
	},
	{
		opcode: "LOAD_PROPERTY_STATIC_SHAPE_CASE",
		dst: 14,
		object: 12,
		shapeCase: 13,
		stringIndex: 0,
		icIndex: 3,
		slots: [0],
	},
	{
		opcode: "LOAD_PROPERTY_STATIC_SHAPE_CASE",
		dst: 15,
		object: 12,
		shapeCase: 13,
		stringIndex: 1,
		icIndex: 4,
		slots: [1],
	},
	{
		opcode: "LOAD_PROPERTY_STATIC_SHAPE_CASE",
		dst: 16,
		object: 12,
		shapeCase: 13,
		stringIndex: 2,
		icIndex: 5,
		slots: [2],
	},
	{ opcode: "BINARY", dst: 17, left: 14, right: 15, operator: "+" },
	{ opcode: "BINARY", dst: 17, left: 17, right: 16, operator: "+" },
	{ opcode: "BINARY", dst: 17, left: 11, right: 17, operator: "+" },
	{ opcode: "STORE_GLOBAL", src: 17, index: 0 },
	{ opcode: "RETURN", value: 17 },
];

const fn: BytecodeFunction = {
	nameStringIndex: -1,
	isGenerator: false,
	isAsync: false,
	parameterCount: 0,
	mappedArguments: false,
	mappedArgumentSlots: [],
	length: 0,
	registerCount: 18,
	capturedCount: 0,
	strict: true,
	needsArguments: false,
	argumentSnapshotCount: 0,
	argumentSnapshotPlan: [],
	isDerivedConstructor: false,
	isClassConstructor: false,
	constructorSlotReserve: 0,
	hasPrototype: false,
	literalShapeCount: 2,
	instructions,
	handlers: [],
	fileIndex: 0,
	positions: [],
};

const definition: ProgramImage = withNativeFunctionPlan(
	testProgramImage({
		entrypointPath: "/fixture/shape-case-load.mjs",
		functionCount: 1,
		functions: [fn],
		stringConstants: [[120], [121], [122], [119]],
		bigintConstants: [],
		literalTemplateData: [],
		precompiledLiteralShapes: [
			{ functionIndex: 0, shapeCacheIndex: 0, keyStringIndices: [0, 1, 2] },
		],
		globalCount: 1,
		files: [],
		sourcePositions: [],
		cjsModuleFunctionIndices: [],
		hostInstalls: [],
	}),
	0,
	(plan) => {
		const registerRepresentations = Array.from({ length: 18 }, (_, index) =>
			index === 7 || index === 13 ? "number" : "boxed",
		);
		return {
			...plan,
			registerRepresentations,
			gc: {
				safepoints: plan.gc.safepoints.map((safepoint) => ({
					...safepoint,
					rootRegisters: safepoint.rootRegisters.filter(
						(register) => registerRepresentations[register] === "boxed",
					),
					incomingRootRegisters: safepoint.incomingRootRegisters.filter(
						(register) => registerRepresentations[register] === "boxed",
					),
					outgoingRootRegisters: safepoint.outgoingRootRegisters.filter(
						(register) => registerRepresentations[register] === "boxed",
					),
				})),
			},
		};
	},
);

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
	const line = stderr.match(/^\[perf-shape-case-stats\].*$/m)?.[0] ?? "";
	return Number(line.match(new RegExp(`(?:^|\\s)${field}=([0-9]+)`))?.[1] ?? -1);
}

describe("shared shape-case property loads", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		const environment = { ...process.env, MAL_PERF_STATS: "1" };
		compiled = buildNativeProgramImage(definition, {
			name: "shape-case-load-compiled",
			compiled: true,
			mainFile,
			outDir,
			environment,
		});
		interpreted = buildNativeProgramImage(definition, {
			name: "shape-case-load-interpreted",
			compiled: false,
			mainFile,
			outDir,
			environment,
		});
	}, 600_000);

	it("shares one exact guard and preserves the generic miss path", () => {
		run(compiled);
		run(interpreted);
		run(compiled, STRESS_ENV);
		run(interpreted, STRESS_ENV);
	});

	it("reports identical selector and load behavior in both backends", () => {
		for (const binary of [compiled, interpreted]) {
			const stderr = run(binary, { MAL_PERF_STATS: "1" });
			expect(perfField(stderr, "probes")).toBe(2);
			expect(perfField(stderr, "hits")).toBe(1);
			expect(perfField(stderr, "fallbacks")).toBe(1);
			expect(perfField(stderr, "load_probes")).toBe(6);
			expect(perfField(stderr, "load_hits")).toBe(3);
			expect(perfField(stderr, "load_fallbacks")).toBe(3);
		}
	});
});
