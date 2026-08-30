import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ProfileSite } from "../../src/compiler/target/profile-metadata.ts";
import type { ProgramImage } from "../../src/compiler/target/program-image.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
} from "../../src/compiler/target/runtime-image.ts";
import { parseCompilerCapture } from "../../src/profile-artifact.ts";
import { buildNativeProgramImage, STRESS_ENV } from "../../src/test-harness.ts";
import { testProgramImage } from "../helpers/program-image.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-shaped-jump-fusion-"));
const captureIdentity = "c".repeat(64);
const instructions: Array<BytecodeInstruction> = [
	{ opcode: "CREATE_NUMBER", dst: 0, value: 42 },
	{
		opcode: "CREATE_OBJECT_SHAPED",
		dst: 1,
		count: 1,
		keyStringIndices: [0],
		valueRegisters: [0],
		shapeCacheIndex: 0,
	},
	{ opcode: "JUMP", targetIp: 4 },
	{ opcode: "LOAD_UNDECLARED", dst: 2, nameStringIndex: 1 },
	{ opcode: "CREATE_ARRAY", dst: 2, length: 0 },
	{ opcode: "LOAD_PROPERTY_STATIC", dst: 3, object: 1, stringIndex: 0, icIndex: 0 },
	{ opcode: "BINARY", dst: 4, left: 3, right: 0, operator: "===" },
	{ opcode: "JUMP_IF", cond: 4, targetIp: 9 },
	{ opcode: "LOAD_UNDECLARED", dst: 2, nameStringIndex: 1 },
	{ opcode: "RETURN", value: 1 },
];
const profileSites: Array<ProfileSite> = instructions.map((instruction, index) => ({
	id: index,
	logicalId: `logical-${index}`,
	originId: `origin-${index}`,
	instanceId: `instance-${index}`,
	regionId: `region-${index}`,
	functionIndex: 0,
	instructionIndex: index,
	positionId: index,
	file: "shaped-jump-fusion.js",
	line: index + 1,
	column: 0,
	operation: instruction.opcode,
	inlineChain: [],
}));
const fn: BytecodeFunction = {
	nameStringIndex: -1,
	isGenerator: false,
	isAsync: false,
	parameterCount: 0,
	mappedArguments: false,
	mappedArgumentSlots: [],
	length: 0,
	registerCount: 5,
	capturedCount: 0,
	strict: true,
	needsArguments: false,
	argumentSnapshotCount: 0,
	argumentSnapshotPlan: [],
	isDerivedConstructor: false,
	isClassConstructor: false,
	hasPrototype: false,
	literalShapeCount: 1,
	instructions,
	handlers: [],
	fileIndex: 0,
	positions: instructions.map((_, index) => index),
	profileSiteIds: instructions.map((_, index) => index),
};
const base = testProgramImage({
	entrypointPath: "/fixture/shaped-jump-fusion.js",
	functionCount: 1,
	functions: [fn],
	stringConstants: [
		["x".charCodeAt(0)],
		[..."missing"].map((char) => char.charCodeAt(0)),
	],
	bigintConstants: [],
	literalTemplateData: [],
	precompiledLiteralShapes: [],
	globalCount: 0,
	files: ["shaped-jump-fusion.js"],
	sourcePositions: instructions.map((_, index) => ({ line: index + 1, column: 0 })),
	cjsModuleFunctionIndices: [],
	hostInstalls: [],
});
const definition: ProgramImage = {
	...base,
	diagnostics: { profileSites },
};

function run(environment: NodeJS.ProcessEnv = {}) {
	const result = spawnSync(binary, [], {
		env: { ...process.env, ...environment },
		encoding: "utf8",
		timeout: 60_000,
	});
	if (result.error) throw result.error;
	expect(result.status, result.stderr || result.stdout).toBe(0);
	return result;
}

function perfField(stderr: string, name: string): number {
	const stats = stderr
		.split("\n")
		.find((line) => line.startsWith("[perf-interpreter-stats]"));
	expect(stats).toBeDefined();
	return Number(stats?.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? -1);
}

let binary: string;

describe("interpreter shaped-object forward-jump fusion", () => {
	beforeAll(() => {
		binary = buildNativeProgramImage(definition, {
			name: "interpreter-shaped-jump-fusion",
			compiled: false,
			mainFile: "runtime/shape_case_flow_test_main.c",
			outDir,
			profileEnabled: true,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	}, 600_000);

	it("transfers to the target and attributes the fused logical instruction", () => {
		const result = run({ MAL_PERF_STATS: "1" });
		const fusions = perfField(result.stderr, "create_object_shaped_jump_fusions");
		expect(fusions).toBe(1);
		expect(perfField(result.stderr, "direct_leaf_executions")).toBeGreaterThanOrEqual(
			fusions * 2,
		);
		const capture = path.join(outDir, "capture.bin");
		run({
			MAL_PROFILE_CAPTURE: capture,
			MAL_PROFILE_COMPILER: "1",
			MAL_PROFILE_IDENTITY: captureIdentity,
		});
		const profile = parseCompilerCapture(readFileSync(`${capture}.compiler`));
		expect(profile.bySite[1]?.executions).toBe(1);
		expect(profile.bySite[2]?.executions).toBe(1);
		expect(profile.bySite[3]?.executions).toBe(0);
		expect(profile.bySite[4]?.executions).toBe(1);
	});

	it("defers stress collection until the target's real safepoint", () => {
		const result = run({ ...STRESS_ENV, MAL_PERF_STATS: "1" });
		expect(perfField(result.stderr, "create_object_shaped_jump_fusions")).toBe(1);
	});
});
