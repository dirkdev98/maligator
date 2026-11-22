import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildDerivationFromConfig, resolveBuildConfig } from "../../src/build-config.ts";
import { serializeRuntimeImage } from "../../src/compiler/target/program-image-codec.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
	RuntimeImage,
} from "../../src/compiler/target/runtime-image.ts";
import { buildDevelopmentRunner } from "../../src/local-build.ts";
import { resolveNativeBuildContext } from "../../src/native-build-context.ts";
import { STRESS_ENV } from "../../src/test-harness.ts";
import { testPropertyCacheCount } from "../helpers/program-image.ts";

const entrypointPath = "superinstructions.js";
let directory: string;
let runner: string;

beforeAll(() => {
	directory = mkdtempSync(path.join(tmpdir(), "mal-interpreter-superinstructions-"));
	const { features, cacheSuffix } = buildDerivationFromConfig(resolveBuildConfig({}));
	runner = buildDevelopmentRunner(
		resolveNativeBuildContext({ features }),
		false,
		cacheSuffix,
	).binaryPath;
});

afterAll(() => {
	if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
});

function writeWire(
	name: string,
	instructions: Array<BytecodeInstruction>,
	stringConstants: Array<Array<number>> = [],
) {
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
		constructorSlotReserve: 0,
		hasPrototype: false,
		propertyIcCount: testPropertyCacheCount(instructions),
		literalShapeCount: instructions.filter(
			(instruction) => instruction.opcode === "CREATE_OBJECT_SHAPED",
		).length,
		instructions,
		handlers: [],
		fileIndex: 0,
		positions: instructions.map((_, ip) => ip),
	};
	const image: RuntimeImage = {
		entrypointPath,
		functionCount: 1,
		functions: [fn],
		stringConstants,
		bigintConstants: [1n],
		literalTemplateData: [],
		precompiledLiteralShapes: [],
		globalCount: 0,
		files: [entrypointPath],
		sourcePositions: instructions.map((_, ip) => ({ line: ip + 1, column: 0 })),
		cjsModuleFunctionIndices: [],
		sourceBuiltinProviders: [],
		hostInstalls: [],
	};
	const filename = path.join(directory, `${name}.malw`);
	writeFileSync(filename, serializeRuntimeImage(image));
	return filename;
}

function runWire(...args: Array<string>) {
	const result = spawnSync(runner, args, {
		env: { ...process.env, ...STRESS_ENV },
		encoding: "utf8",
		timeout: 30_000,
	});
	if (result.error !== undefined) throw result.error;
	return result;
}

it("can jump directly to the second addition in a wire image", () => {
	const result = runWire(
		writeWire("jump-into-second", [
			{ opcode: "CREATE_NUMBER", dst: 0, value: 2 },
			{ opcode: "CREATE_NUMBER", dst: 1, value: 3 },
			{ opcode: "CREATE_BOOLEAN", dst: 4, value: true },
			{ opcode: "JUMP_IF", cond: 4, targetIp: 5 },
			{ opcode: "BINARY", operator: "+", dst: 0, left: 0, right: 1 },
			{ opcode: "BINARY", operator: "+", dst: 2, left: 0, right: 1 },
			{ opcode: "CREATE_NUMBER", dst: 3, value: 5 },
			{ opcode: "BINARY", operator: "===", dst: 4, left: 2, right: 3 },
			{ opcode: "JUMP_IF", cond: 4, targetIp: 10 },
			{ opcode: "THROW", value: 2 },
			{ opcode: "RETURN", value: 2 },
		]),
	);
	expect(result.status, result.stderr).toBe(0);
});

it("reports the second addition's source location when its coercion throws", () => {
	const result = runWire(
		writeWire("second-addition-stack", [
			{ opcode: "CREATE_NUMBER", dst: 0, value: 2 },
			{ opcode: "CREATE_NUMBER", dst: 1, value: 3 },
			{ opcode: "CREATE_BIGINT", dst: 4, bigintIndex: 0 },
			{ opcode: "BINARY", operator: "+", dst: 0, left: 0, right: 1 },
			{ opcode: "BINARY", operator: "+", dst: 2, left: 0, right: 4 },
			{ opcode: "RETURN", value: 2 },
		]),
	);
	expect(result.status).toBe(1);
	expect(result.stderr).toContain("TypeError");
	expect(result.stderr).toContain("superinstructions.js:5:1");
});

it("uses the right property names when a triplet of reads is loaded after another image", () => {
	const prefix = writeWire(
		"prefix",
		[
			{ opcode: "CREATE_UNDEFINED", dst: 0 },
			{ opcode: "RETURN", value: 0 },
		],
		[["x".charCodeAt(0)], ["y".charCodeAt(0)], ["z".charCodeAt(0)]],
	);
	const body = writeWire(
		"property-triplet",
		[
			{ opcode: "CREATE_NUMBER", dst: 0, value: 4 },
			{ opcode: "CREATE_NUMBER", dst: 1, value: 9 },
			{ opcode: "CREATE_NUMBER", dst: 2, value: 16 },
			{
				opcode: "CREATE_OBJECT_SHAPED",
				dst: 3,
				count: 3,
				keyStringIndices: [0, 1, 2],
				valueRegisters: [0, 1, 2],
				shapeCacheIndex: 0,
			},
			{ opcode: "LOAD_PROPERTY_STATIC", dst: 0, object: 3, stringIndex: 0, icIndex: 0 },
			{ opcode: "LOAD_PROPERTY_STATIC", dst: 1, object: 3, stringIndex: 1, icIndex: 1 },
			{ opcode: "LOAD_PROPERTY_STATIC", dst: 2, object: 3, stringIndex: 2, icIndex: 2 },
			{ opcode: "CREATE_NUMBER", dst: 4, value: 4 },
			{ opcode: "BINARY", operator: "===", dst: 4, left: 0, right: 4 },
			{ opcode: "JUMP_IF", cond: 4, targetIp: 11 },
			{ opcode: "THROW", value: 0 },
			{ opcode: "RETURN", value: 0 },
		],
		[["a".charCodeAt(0)], ["b".charCodeAt(0)], ["c".charCodeAt(0)]],
	);
	const result = runWire(
		"--maligator-internal-run-wires",
		"2",
		entrypointPath,
		prefix,
		body,
	);
	expect(result.status, result.stderr).toBe(0);
});
