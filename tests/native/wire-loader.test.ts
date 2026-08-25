import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { stripCompactTypes } from "../../src/compiler/frontend/compact-type-strip.ts";
import {
	compileEntrypoint,
	compileEntrypointToBuffer,
} from "../../src/compiler/pipeline/compile-program.ts";
import type {
	RuntimeImage,
	BytecodeFunction,
} from "../../src/compiler/target/lower-vm.ts";
import {
	serializeRuntimeImage,
	WIRE_OPCODES,
} from "../../src/compiler/target/serialize-vm.ts";
import { buildLoadDriver } from "../../src/local-build.ts";

const fn: BytecodeFunction = {
	nameStringIndex: -1,
	isGenerator: false,
	isAsync: false,
	parameterCount: 0,
	mappedArguments: false,
	mappedArgumentSlots: [],
	length: 0,
	registerCount: 1,
	capturedCount: 0,
	strict: true,
	needsArguments: false,
	argumentSnapshotCount: 0,
	argumentSnapshotPlan: [],
	isDerivedConstructor: false,
	isClassConstructor: false,
	hasPrototype: false,
	literalShapeCount: 1,
	instructions: [
		{
			opcode: "CREATE_OBJECT_SHAPED",
			dst: 0,
			count: 1,
			keyStringIndices: [0],
			valueRegisters: [0],
			shapeCacheIndex: 0,
		},
	],
	handlers: [],
	fileIndex: 0,
	positions: [],
};

const definition: RuntimeImage = {
	entrypointPath: "/fixture/entry.mjs",
	functionCount: 1,
	functions: [fn],
	stringConstants: [],
	bigintConstants: [],
	literalTemplateData: [],
	precompiledLiteralShapes: [],
	globalCount: 0,
	files: [],
	sourcePositions: [],
	cjsModuleFunctionIndices: [],
	hostInstalls: [],
};

const sourceEntryFieldSize =
	1 + new TextEncoder().encode(definition.entrypointPath).length;
const afterSourceEntry = (offset: number): number => offset + sourceEntryFieldSize;

describe("wire loader side-data validation", () => {
	let driver: string;
	let directory: string;

	beforeAll(() => {
		driver = buildLoadDriver(false, {
			kind: "source",
			sourceDirectory: path.resolve("src"),
			entrypoint: path.resolve("src/compiler/pipeline/eval-compiler-entry.mts"),
			bake: () =>
				compileEntrypointToBuffer(
					path.resolve("src/compiler/pipeline/eval-compiler-entry.mts"),
					{
						stripTypes: stripCompactTypes,
					},
				),
		});
		directory = mkdtempSync(path.join(tmpdir(), "mal-wire-loader-"));
	});

	function rejectsMutation(name: string, offset: number, encodedValue: number): void {
		const wire = serializeRuntimeImage(definition, { debugInfo: false });
		wire[offset] = encodedValue;
		rejectsWire(name, wire);
	}

	function rejectsWire(name: string, wire: Uint8Array): void {
		const wirePath = path.join(directory, `${name}.malw`);
		writeFileSync(wirePath, wire);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("truncated or corrupt buffer");
	}

	function acceptsWire(name: string, wire: Uint8Array): void {
		const wirePath = path.join(directory, `${name}.malw`);
		writeFileSync(wirePath, wire);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr).toBe(0);
	}

	it("rejects an explicit count that disagrees with its arrays", () => {
		// Empty definition tables put the first instruction at byte 33 after the
		// fixed header, source-entry field, and explicit literal-shape count. Its
		// explicit operand count follows the opcode tag and dst operand.
		rejectsMutation("explicit-count", afterSourceEntry(33 + 1 + 1), 4); // ZigZag(2)
	});

	it("rejects mismatched paired-array lengths", () => {
		// Skip tag, dst, explicit count, then the first array's count and one value.
		rejectsMutation("paired-count", afterSourceEntry(33 + 1 + 1 + 1 + 1 + 1), 2);
	});

	it("rejects known-own-slot side data that disagrees with the source shape", () => {
		const knownSlotFunction: BytecodeFunction = {
			...fn,
			literalShapeCount: 2,
			registerCount: 2,
			instructions: [
				{ opcode: "CREATE_UNDEFINED", dst: 0 },
				{
					opcode: "CREATE_OBJECT_SHAPED",
					dst: 1,
					count: 1,
					keyStringIndices: [0],
					valueRegisters: [0],
					shapeCacheIndex: 0,
				},
				{
					opcode: "CREATE_OBJECT_SHAPED",
					dst: 1,
					count: 1,
					keyStringIndices: [0],
					valueRegisters: [0],
					shapeCacheIndex: 1,
				},
				{
					opcode: "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT",
					dst: 0,
					object: 1,
					stringIndex: 0,
					icIndex: 0,
					candidates: [
						{ shapeFunctionIndex: 0, shapeCacheIndex: 0, slot: 0 },
						{ shapeFunctionIndex: 0, shapeCacheIndex: 1, slot: 0 },
					],
				},
				{
					opcode: "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT",
					object: 1,
					value: 0,
					stringIndex: 0,
					icIndex: 1,
					candidates: [
						{ shapeFunctionIndex: 0, shapeCacheIndex: 0, slot: 0 },
						{ shapeFunctionIndex: 0, shapeCacheIndex: 1, slot: 0 },
					],
				},
				{ opcode: "RETURN", value: 0 },
			],
		};
		const knownSlotDefinition: RuntimeImage = {
			...definition,
			functions: [knownSlotFunction],
			stringConstants: [["x".charCodeAt(0)]],
			precompiledLiteralShapes: [
				{ functionIndex: 0, shapeCacheIndex: 0, keyStringIndices: [0] },
				{ functionIndex: 0, shapeCacheIndex: 1, keyStringIndices: [0] },
			],
		};
		const wire = serializeRuntimeImage(knownSlotDefinition, { debugInfo: false });
		const tag = WIRE_OPCODES.indexOf("LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT");
		const encodedInstruction = [tag, 0, 2, 0, 2, 0, 0, 0, 0, 2, 0];
		const offset = wire.findIndex((_, index) =>
			encodedInstruction.every((byte, operand) => wire[index + operand] === byte),
		);
		expect(offset).toBeGreaterThanOrEqual(0);
		// Change slot ZigZag(0) to ZigZag(1), outside the one-slot source shape.
		wire[offset + encodedInstruction.length - 1] = 2;
		rejectsWire("known-own-slot", wire);

		const duplicate = serializeRuntimeImage(knownSlotDefinition, { debugInfo: false });
		// Rebase the second candidate's shape-cache row 1 to row 0.
		duplicate[offset + encodedInstruction.length - 2] = 0;
		rejectsWire("known-own-slot-duplicate", duplicate);

		const storeWire = serializeRuntimeImage(knownSlotDefinition, { debugInfo: false });
		const storeTag = WIRE_OPCODES.indexOf("STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT");
		const encodedStore = [storeTag, 2, 0, 0, 2, 0, 0, 0, 0, 2, 0];
		const storeOffset = storeWire.findIndex((_, index) =>
			encodedStore.every((byte, operand) => storeWire[index + operand] === byte),
		);
		expect(storeOffset).toBeGreaterThanOrEqual(0);
		storeWire[storeOffset + encodedStore.length - 1] = 2;
		rejectsWire("known-own-slot-store", storeWire);
	});

	it("rejects malformed shared shape-case selectors and slot tables", () => {
		const shapeCaseFunction: BytecodeFunction = {
			...fn,
			literalShapeCount: 1,
			registerCount: 6,
			instructions: [
				{ opcode: "CREATE_UNDEFINED", dst: 0 },
				{
					opcode: "CREATE_OBJECT_SHAPED",
					dst: 2,
					count: 2,
					keyStringIndices: [0, 1],
					valueRegisters: [0, 0],
					shapeCacheIndex: 0,
				},
				{
					opcode: "SELECT_SHAPE_CASE",
					dst: 3,
					object: 2,
					candidates: [{ shapeFunctionIndex: 0, shapeCacheIndex: 0 }],
				},
				{
					opcode: "LOAD_PROPERTY_STATIC_SHAPE_CASE",
					dst: 4,
					object: 2,
					shapeCase: 3,
					stringIndex: 0,
					icIndex: 0,
					slots: [0],
				},
				{
					opcode: "LOAD_PROPERTY_STATIC_SHAPE_CASE",
					dst: 5,
					object: 2,
					shapeCase: 3,
					stringIndex: 1,
					icIndex: 1,
					slots: [1],
				},
				{ opcode: "RETURN", value: 5 },
			],
		};
		const shapeCaseDefinition: RuntimeImage = {
			...definition,
			functions: [shapeCaseFunction],
			stringConstants: [[120], [121]],
			precompiledLiteralShapes: [
				{ functionIndex: 0, shapeCacheIndex: 0, keyStringIndices: [0, 1] },
			],
		};
		const wire = serializeRuntimeImage(shapeCaseDefinition, { debugInfo: false });
		// Two loads are the minimum profitable shared case and must be accepted by
		// the native loader, not merely by the TypeScript serializer.
		acceptsWire("shape-case-two-loads", wire);
		const selectorTag = WIRE_OPCODES.indexOf("SELECT_SHAPE_CASE");
		const encodedSelector = [selectorTag, 6, 4, 1, 0, 0];
		const selectorOffset = wire.findIndex((_, index) =>
			encodedSelector.every((byte, operand) => wire[index + operand] === byte),
		);
		expect(selectorOffset).toBeGreaterThanOrEqual(0);
		const invalidSelector = wire.slice();
		// The only function owns one literal-shape row; row 1 is out of bounds.
		invalidSelector[selectorOffset + encodedSelector.length - 1] = 2;
		rejectsWire("shape-case-selector", invalidSelector);

		const loadTag = WIRE_OPCODES.indexOf("LOAD_PROPERTY_STATIC_SHAPE_CASE");
		const encodedLoad = [loadTag, 10, 4, 6, 2, 1, 2];
		const loadOffset = wire.findIndex((_, index) =>
			encodedLoad.every((byte, operand) => wire[index + operand] === byte),
		);
		expect(loadOffset).toBeGreaterThanOrEqual(0);
		const invalidSlot = wire.slice();
		// Key y must use slot 1; changing it to slot 0 would read x.
		invalidSlot[loadOffset + encodedLoad.length - 1] = 0;
		rejectsWire("shape-case-slot", invalidSlot);

		const encodedFirstLoad = [loadTag, 8, 4, 6, 0, 1, 0];
		const firstLoadOffset = wire.findIndex((_, index) =>
			encodedFirstLoad.every((byte, operand) => wire[index + operand] === byte),
		);
		expect(firstLoadOffset).toBeGreaterThanOrEqual(0);
		const receiverClobber = wire.slice();
		// The first load may not overwrite r2 while later loads still use the
		// selector result for that receiver.
		receiverClobber[firstLoadOffset + 1] = 4;
		rejectsWire("shape-case-receiver", receiverClobber);
	});

	it("pre-instantiates known literal shapes for initial and spliced wire definitions", () => {
		const shapedFunction: BytecodeFunction = {
			...fn,
			// Row 2 has no CREATE_OBJECT_SHAPED instruction: it is a portable
			// precompiled descriptor reserved for cross-function shape provenance.
			literalShapeCount: 3,
			registerCount: 3,
			instructions: [
				{ opcode: "CREATE_UNDEFINED", dst: 0 },
				{
					opcode: "CREATE_OBJECT_SHAPED",
					dst: 1,
					count: 1,
					keyStringIndices: [0],
					valueRegisters: [0],
					shapeCacheIndex: 0,
				},
				{
					opcode: "CREATE_OBJECT_SHAPED",
					dst: 2,
					count: 1,
					keyStringIndices: [0],
					valueRegisters: [0],
					shapeCacheIndex: 1,
				},
				{
					opcode: "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT",
					dst: 0,
					object: 1,
					stringIndex: 0,
					icIndex: 0,
					candidates: [{ shapeFunctionIndex: 0, shapeCacheIndex: 2, slot: 0 }],
				},
				{ opcode: "RETURN", value: 0 },
			],
		};
		const shapedDefinition: RuntimeImage = {
			...definition,
			functions: [shapedFunction],
			stringConstants: [["x".charCodeAt(0)]],
			precompiledLiteralShapes: [
				{ functionIndex: 0, shapeCacheIndex: 2, keyStringIndices: [0] },
			],
		};
		const baseDefinition: RuntimeImage = {
			...definition,
			functions: [
				{
					...fn,
					instructions: [
						{ opcode: "CREATE_UNDEFINED", dst: 0 },
						{ opcode: "RETURN", value: 0 },
					],
				},
			],
			stringConstants: [[..."padding"].map((unit) => unit.charCodeAt(0))],
		};
		const shapedPath = path.join(directory, "known-shape.malw");
		const basePath = path.join(directory, "known-shape-base.malw");
		writeFileSync(
			shapedPath,
			serializeRuntimeImage(shapedDefinition, { debugInfo: false }),
		);
		writeFileSync(basePath, serializeRuntimeImage(baseDefinition, { debugInfo: false }));
		const environment = {
			...process.env,
			MAL_EXPECT_PRECOMPILED_SHAPES: "1",
			MAL_GC_AT_EXIT: "1",
		};
		const initial = spawnSync(driver, [shapedPath], {
			encoding: "utf8",
			env: environment,
		});
		expect(initial.status, initial.stderr || initial.stdout).toBe(0);
		const spliced = spawnSync(driver, ["--splice", basePath, shapedPath], {
			encoding: "utf8",
			env: environment,
		});
		expect(spliced.status, spliced.stderr || spliced.stdout).toBe(0);
	});

	it("rejects snapshot metadata that disagrees with the opcode prefix", () => {
		// The first function starts at byte 15 after the source-entry field; its
		// snapshot count is eight bytes later.
		rejectsMutation("snapshot-prefix", afterSourceEntry(23), 1);
	});

	it("rejects a snapshot plan that clobbers an aliased source", () => {
		const cycleDefinition: RuntimeImage = {
			...definition,
			functions: [
				{
					...fn,
					argumentSnapshotCount: 2,
					argumentSnapshotPlan: [
						{ destination: -1, source: 1 },
						{ destination: 1, source: 0 },
						{ destination: 0, source: -2 },
					],
					registerCount: 2,
					instructions: [
						{ opcode: "LOAD_ARGUMENT", dst: 0, index: 1 },
						{ opcode: "LOAD_ARGUMENT", dst: 1, index: 0 },
						{ opcode: "RETURN", value: 0 },
					],
				},
			],
		};
		const wire = serializeRuntimeImage(cycleDefinition, { debugInfo: false });
		// Move the scratch restore before r1's read of raw argument slot 0.
		wire.set([0, 3, 2, 0], afterSourceEntry(26));
		rejectsWire("snapshot-clobber", wire);
	});

	it("loads and executes an exact direct builtin call", () => {
		const directDefinition: RuntimeImage = {
			...definition,
			stringConstants: [
				[..."alpha,beta"].map((unit) => unit.charCodeAt(0)),
				[",".charCodeAt(0)],
			],
			functions: [
				{
					...fn,
					registerCount: 3,
					instructions: [
						{ opcode: "CREATE_STRING", dst: 1, stringIndex: 0 },
						{ opcode: "CREATE_STRING", dst: 2, stringIndex: 1 },
						{
							opcode: "CALL_BUILTIN",
							dst: 0,
							thisValue: 1,
							argumentCount: 1,
							arguments: [2],
							operation: "String.prototype.split",
						},
						{ opcode: "RETURN", value: 0 },
					],
				},
			],
		};
		const wirePath = path.join(directory, "direct-builtin.malw");
		writeFileSync(
			wirePath,
			serializeRuntimeImage(directDefinition, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("rejects malformed varints and trailing data", () => {
		const wire = serializeRuntimeImage(definition, { debugInfo: false });
		const replaceFlags = (bytes: Array<number>): Uint8Array =>
			Uint8Array.from([...wire.subarray(0, 8), ...bytes, ...wire.subarray(9)]);

		rejectsWire("overlong-varint", replaceFlags([0x80, 0]));
		rejectsWire("overflowing-varint", replaceFlags([0x80, 0x80, 0x80, 0x80, 0x10]));
		rejectsWire("trailing-data", Uint8Array.from([...wire, 0]));
	});

	it("loads bulk private-name and private-field side data", () => {
		const bulkDefinition: RuntimeImage = {
			...definition,
			functions: [
				{
					...fn,
					registerCount: 3,
					capturedCount: 2,
					instructions: [
						{
							opcode: "CREATE_PRIVATE_NAMES",
							ownerFunctionIndex: 0,
							capturedIndices: [0, 1],
						},
						{ opcode: "INIT_PRIVATE_FIELDS", object: 0, keyRegisters: [1, 2] },
						{ opcode: "RETURN", value: 0 },
					],
				},
			],
		};
		const wirePath = path.join(directory, "bulk-private.malw");
		writeFileSync(wirePath, serializeRuntimeImage(bulkDefinition, { debugInfo: false }));
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status).toBe(0);
	});

	it("loads canonical typeof comparison operands", () => {
		const typeofDefinition: RuntimeImage = {
			...definition,
			functions: [
				{
					...fn,
					registerCount: 2,
					instructions: [
						{ opcode: "CREATE_UNDEFINED", dst: 1 },
						{
							opcode: "TYPEOF_COMPARE",
							dst: 0,
							src: 1,
							expected: "undefined",
							negated: false,
						},
						{ opcode: "RETURN", value: 0 },
					],
				},
			],
		};
		const wirePath = path.join(directory, "typeof-compare.malw");
		writeFileSync(
			wirePath,
			serializeRuntimeImage(typeofDefinition, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status).toBe(0);
	});

	it("loads an appended terminal-yield operand", () => {
		const terminalDefinition: RuntimeImage = {
			...definition,
			functions: [
				{
					...fn,
					instructions: [
						{ opcode: "CREATE_UNDEFINED", dst: 0 },
						{ opcode: "RETURN", value: 0 },
						{ opcode: "TERMINAL_YIELD", yieldedSrc: 0 },
					],
				},
			],
		};
		const wirePath = path.join(directory, "terminal-yield.malw");
		writeFileSync(
			wirePath,
			serializeRuntimeImage(terminalDefinition, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("loads a nonempty String.split cursor proof region payload", () => {
		const entrypoint = path.join(directory, "string-split-cursor-region.mjs");
		writeFileSync(
			entrypoint,
			`function run(value, separator) {
				const parts = value.split(separator);
				let total = 0;
				for (let index = 0; index < parts.length; index++) {
					total += parts[index].trim().length;
				}
				return total;
			}
			globalThis.result = run(" alpha, beta ", ",");\n`,
		);
		const cursorDefinition = compileEntrypoint(entrypoint, {
			stripTypes: stripCompactTypes,
		});
		expect(
			cursorDefinition.nativePlan.functions.flatMap((fn) =>
				fn.specializations.filter((region) => region.kind === "string-split-cursor"),
			),
		).toHaveLength(1);
		const wirePath = path.join(directory, "string-split-cursor-region.malw");
		writeFileSync(
			wirePath,
			serializeRuntimeImage(cursorDefinition, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("loads a nonempty String.split projection proof region payload", () => {
		const entrypoint = path.join(directory, "string-split-projection-region.mjs");
		writeFileSync(
			entrypoint,
			`function project() {
				const fields = "alpha;beta".split(";");
				return fields[1] + fields[0] + fields.length;
			}
			globalThis.result = project();\n`,
		);
		const projectionDefinition = compileEntrypoint(entrypoint, {
			stripTypes: stripCompactTypes,
			buildConfig: resolveBuildConfig({}),
		});
		const projectionSites = projectionDefinition.nativePlan.functions.flatMap((native) =>
			native.specializations
				.filter((region) => region.kind === "string-split-projection")
				.map((region) => ({
					fn: projectionDefinition.functions[native.functionIndex]!,
					region,
				})),
		);
		expect(projectionSites.length).toBeGreaterThan(0);
		expect(
			projectionSites.some(
				({ fn, region }) => fn.instructions[region.callIp]?.opcode === "CALL_BUILTIN",
			),
		).toBe(true);
		const wirePath = path.join(directory, "string-split-projection-region.malw");
		writeFileSync(
			wirePath,
			serializeRuntimeImage(projectionDefinition, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("loads a nonempty RegExp.exec projection proof region payload", () => {
		const entrypoint = path.join(directory, "regexp-exec-projection-region.mjs");
		writeFileSync(
			entrypoint,
			`function parse(regexp, value) {
				const match = regexp.exec(value);
				if (match === null) return -1;
				return Number(match[1]);
			}
			globalThis.result = parse(/([0-9]+)/, "42");\n`,
		);
		const projectionDefinition = compileEntrypoint(entrypoint, {
			stripTypes: stripCompactTypes,
			buildConfig: resolveBuildConfig({}),
		});
		expect(
			projectionDefinition.nativePlan.functions.flatMap((fn) =>
				fn.specializations.filter((region) => region.kind === "regexp-exec-projection"),
			),
		).not.toHaveLength(0);
		const wirePath = path.join(directory, "regexp-exec-projection-region.malw");
		writeFileSync(
			wirePath,
			serializeRuntimeImage(projectionDefinition, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("loads a nonempty RegExp iterator projection proof region payload", () => {
		const entrypoint = path.join(directory, "regexp-iterator-projection-region.mjs");
		writeFileSync(
			entrypoint,
			`function total(value, regexp) {
				let sum = 0;
				for (const match of value.matchAll(regexp)) sum += Number(match[1]);
				return sum;
			}
			globalThis.result = total("1 2 3", /([0-9]+)/g);\n`,
		);
		const projectionDefinition = compileEntrypoint(entrypoint, {
			stripTypes: stripCompactTypes,
			buildConfig: resolveBuildConfig({}),
		});
		expect(
			projectionDefinition.nativePlan.functions.flatMap((fn) =>
				fn.specializations.filter(
					(region) => region.kind === "regexp-iterator-projection",
				),
			),
		).not.toHaveLength(0);
		const wirePath = path.join(directory, "regexp-iterator-projection-region.malw");
		writeFileSync(
			wirePath,
			serializeRuntimeImage(projectionDefinition, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("loads a nonempty String.slice Number proof region payload", () => {
		const entrypoint = path.join(directory, "string-slice-number-region.mjs");
		writeFileSync(
			entrypoint,
			`function parse(value) {
				try {
					return Number(value.slice(1));
				} catch {
					return -1;
				}
			}
			globalThis.result = parse("x42");\n`,
		);
		const regionDefinition = compileEntrypoint(entrypoint, {
			stripTypes: stripCompactTypes,
			buildConfig: resolveBuildConfig({}),
		});
		expect(
			regionDefinition.nativePlan.functions.flatMap((fn) =>
				fn.specializations.filter((region) => region.kind === "string-slice-number"),
			),
		).not.toHaveLength(0);
		const wirePath = path.join(directory, "string-slice-number-region.malw");
		writeFileSync(
			wirePath,
			serializeRuntimeImage(regionDefinition, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("loads and executes persisted stack-object plan regions", () => {
		const entrypoint = path.join(directory, "stack-object-plan-region.mjs");
		writeFileSync(
			entrypoint,
			`function read(escape) {
				const value = { x: 41, tag: "stack" };
				if (escape) return value;
				return typeof value === "object" ? value.x + 1 : 0;
			}
			if (read(false) !== 42 || read(true).tag !== "stack") throw new Error("bad stack plan");\n`,
		);
		const stackDefinition = compileEntrypoint(entrypoint, {
			stripTypes: stripCompactTypes,
			buildConfig: resolveBuildConfig({}),
		});
		expect(
			stackDefinition.nativePlan.functions.flatMap((fn) =>
				fn.specializations.filter((region) => region.kind === "stack-object-plan"),
			),
		).not.toHaveLength(0);
		const wirePath = path.join(directory, "stack-object-plan-region.malw");
		writeFileSync(wirePath, serializeRuntimeImage(stackDefinition, { debugInfo: false }));
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("loads and executes persisted argument snapshot prefixes", () => {
		const snapshotDefinition: RuntimeImage = {
			...definition,
			functions: [
				{
					...fn,
					argumentSnapshotCount: 2,
					argumentSnapshotPlan: [
						{ destination: 0, source: -1 },
						{ destination: 1, source: 4 },
					],
					registerCount: 2,
					instructions: [
						{ opcode: "LOAD_ARGUMENT_COUNT", dst: 0 },
						{ opcode: "LOAD_ARGUMENT", dst: 1, index: 4 },
						{ opcode: "RETURN", value: 0 },
					],
				},
			],
		};
		const wirePath = path.join(directory, "argument-snapshots.malw");
		writeFileSync(
			wirePath,
			serializeRuntimeImage(snapshotDefinition, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("loads unaligned fixed-width little-endian scalar fields", () => {
		const scalarDefinition: RuntimeImage = {
			...definition,
			// A two-byte global-count varint places the following u16/u64/fixed-u32
			// payloads at deliberately unaligned offsets.
			globalCount: 128,
			stringConstants: [[0xd800, 0xabcd]],
			bigintConstants: [-0x0123456789abcdef0123456789abcdefn],
			literalTemplateData: [0x01234567, 0x89abcdef],
			functions: [
				{
					...fn,
					registerCount: 2,
					instructions: [
						{ opcode: "CREATE_F64", dst: 0, value: 6.25 },
						{ opcode: "CREATE_F64", dst: 1, value: -0 },
						{ opcode: "RETURN", value: 1 },
					],
				},
			],
		};
		const wirePath = path.join(directory, "unaligned-scalars.malw");
		writeFileSync(
			wirePath,
			serializeRuntimeImage(scalarDefinition, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], {
			encoding: "utf8",
			env: { ...process.env, MAL_DUMP_LOADED_SCALARS: "1" },
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(
			[
				"string[0] d800 abcd",
				"bigint[0] fedcba9876543210fedcba9876543211",
				"literal[0] 01234567",
				"literal[1] 89abcdef",
				"f64[0:0] 4019000000000000",
				"f64[0:1] 8000000000000000",
				"",
			].join("\n"),
		);
	});
});
