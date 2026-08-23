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
import type { VmDefinition, VmFunction } from "../../src/compiler/target/lower-vm.ts";
import {
	serializeVmDefinition,
	WIRE_OPCODES,
} from "../../src/compiler/target/serialize-vm.ts";
import { buildLoadDriver } from "../../src/local-build.ts";

const fn: VmFunction = {
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
	registerRepresentations: ["boxed"],
};

const definition: VmDefinition = {
	entrypointPath: "/fixture/entry.mjs",
	functionCount: 1,
	functions: [fn],
	stringConstants: [],
	bigintConstants: [],
	literalTemplateData: [],
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
		const wire = serializeVmDefinition(definition, { debugInfo: false });
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

	it("rejects an explicit count that disagrees with its arrays", () => {
		// Empty definition tables put the first instruction at byte 32 after the
		// fixed header and source-entry field. Its explicit count follows the opcode
		// tag and dst operand.
		rejectsMutation("explicit-count", afterSourceEntry(32 + 1 + 1), 4); // ZigZag(2)
	});

	it("rejects mismatched paired-array lengths", () => {
		// Skip tag, dst, explicit count, then the first array's count and one value.
		rejectsMutation("paired-count", afterSourceEntry(32 + 1 + 1 + 1 + 1 + 1), 2);
	});

	it("rejects known-own-slot side data that disagrees with the source shape", () => {
		const knownSlotFunction: VmFunction = {
			...fn,
			registerCount: 2,
			registerRepresentations: ["boxed", "boxed"],
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
					opcode: "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT",
					dst: 0,
					object: 1,
					stringIndex: 0,
					icIndex: 0,
					shapeFunctionIndex: 0,
					shapeCacheIndex: 0,
					slot: 0,
				},
				{ opcode: "RETURN", value: 0 },
			],
		};
		const knownSlotDefinition: VmDefinition = {
			...definition,
			functions: [knownSlotFunction],
			stringConstants: [["x".charCodeAt(0)]],
		};
		const wire = serializeVmDefinition(knownSlotDefinition, { debugInfo: false });
		const tag = WIRE_OPCODES.indexOf("LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT");
		const encodedInstruction = [tag, 0, 2, 0, 0, 0, 0];
		const offset = wire.findIndex((_, index) =>
			encodedInstruction.every((byte, operand) => wire[index + operand] === byte),
		);
		expect(offset).toBeGreaterThanOrEqual(0);
		// Change slot ZigZag(0) to ZigZag(1), outside the one-slot source shape.
		wire[offset + encodedInstruction.length - 1] = 2;
		rejectsWire("known-own-slot", wire);
	});

	it("pre-instantiates known literal shapes for initial and spliced wire definitions", () => {
		const shapedFunction: VmFunction = {
			...fn,
			registerCount: 3,
			registerRepresentations: ["boxed", "boxed", "boxed"],
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
					shapeFunctionIndex: 0,
					shapeCacheIndex: 1,
					slot: 0,
				},
				{ opcode: "RETURN", value: 0 },
			],
		};
		const shapedDefinition: VmDefinition = {
			...definition,
			functions: [shapedFunction],
			stringConstants: [["x".charCodeAt(0)]],
		};
		const baseDefinition: VmDefinition = {
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
			serializeVmDefinition(shapedDefinition, { debugInfo: false }),
		);
		writeFileSync(basePath, serializeVmDefinition(baseDefinition, { debugInfo: false }));
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
		const cycleDefinition: VmDefinition = {
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
					registerRepresentations: ["boxed", "boxed"],
					instructions: [
						{ opcode: "LOAD_ARGUMENT", dst: 0, index: 1 },
						{ opcode: "LOAD_ARGUMENT", dst: 1, index: 0 },
						{ opcode: "RETURN", value: 0 },
					],
				},
			],
		};
		const wire = serializeVmDefinition(cycleDefinition, { debugInfo: false });
		// Move the scratch restore before r1's read of raw argument slot 0.
		wire.set([0, 3, 2, 0], afterSourceEntry(26));
		rejectsWire("snapshot-clobber", wire);
	});

	it("accepts canonical String method identity metadata", () => {
		for (const operation of [
			"String.prototype.trim",
			"String.prototype.slice",
		] as const) {
			const methodDefinition: VmDefinition = {
				...definition,
				functions: [
					{
						...fn,
						instructions: [
							{ opcode: "CREATE_UNDEFINED", dst: 0 },
							{ opcode: "RETURN", value: 0 },
							{
								opcode: "CALL",
								dst: 0,
								callee: 0,
								thisValue: 0,
								argumentCount: 0,
								arguments: [],
								guardedBuiltinCall: {
									operation,
									guard: {
										dependencies: [{ kind: "world", fact: "primordials.locked" }],
										obligations: ["fallback"],
									},
								},
							},
						],
					},
				],
			};
			const wirePath = path.join(directory, `guarded-${operation}.malw`);
			writeFileSync(
				wirePath,
				serializeVmDefinition(methodDefinition, { debugInfo: false }),
			);
			const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
			expect(result.status, result.stderr || result.stdout).toBe(0);
		}
	});

	it("loads and executes an exact direct builtin call", () => {
		const directDefinition: VmDefinition = {
			...definition,
			stringConstants: [
				[..."alpha,beta"].map((unit) => unit.charCodeAt(0)),
				[",".charCodeAt(0)],
			],
			functions: [
				{
					...fn,
					registerCount: 3,
					registerRepresentations: ["boxed", "boxed", "boxed"],
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
			serializeVmDefinition(directDefinition, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("rejects malformed varints and trailing data", () => {
		const wire = serializeVmDefinition(definition, { debugInfo: false });
		const replaceFlags = (bytes: Array<number>): Uint8Array =>
			Uint8Array.from([...wire.subarray(0, 8), ...bytes, ...wire.subarray(9)]);

		rejectsWire("overlong-varint", replaceFlags([0x80, 0]));
		rejectsWire("overflowing-varint", replaceFlags([0x80, 0x80, 0x80, 0x80, 0x10]));
		rejectsWire("trailing-data", Uint8Array.from([...wire, 0]));
	});

	it("loads bulk private-name and private-field side data", () => {
		const bulkDefinition: VmDefinition = {
			...definition,
			functions: [
				{
					...fn,
					registerCount: 3,
					registerRepresentations: ["boxed", "boxed", "boxed"],
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
		writeFileSync(wirePath, serializeVmDefinition(bulkDefinition, { debugInfo: false }));
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status).toBe(0);
	});

	it("loads canonical typeof comparison operands", () => {
		const typeofDefinition: VmDefinition = {
			...definition,
			functions: [
				{
					...fn,
					registerCount: 2,
					registerRepresentations: ["boxed", "boxed"],
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
			serializeVmDefinition(typeofDefinition, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status).toBe(0);
	});

	it("loads an appended terminal-yield operand", () => {
		const terminalDefinition: VmDefinition = {
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
			serializeVmDefinition(terminalDefinition, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("loads and validates fresh dense indexed-fill reserve metadata", () => {
		const reserveDefinition: VmDefinition = {
			...definition,
			functions: [
				{
					...fn,
					instructions: [
						{
							opcode: "CREATE_ARRAY",
							dst: 0,
							length: 0,
							freshDenseReserveLength: 1,
						},
						{ opcode: "RETURN", value: 0 },
					],
				},
			],
		};
		const wire = serializeVmDefinition(reserveDefinition, { debugInfo: false });
		const wirePath = path.join(directory, "indexed-fill-reserve.malw");
		writeFileSync(wirePath, wire);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);

		expect(wire.at(-3)).toBe(12);
		expect(wire.at(-1)).toBe(0); // empty tagged function-region table
		wire[wire.length - 2] = 0;
		rejectsWire("indexed-fill-reserve-zero", wire);
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
			cursorDefinition.functions.flatMap(
				(fn) =>
					fn.regions?.filter((region) => region.kind === "string-split-cursor") ?? [],
			),
		).toHaveLength(1);
		const wirePath = path.join(directory, "string-split-cursor-region.malw");
		writeFileSync(
			wirePath,
			serializeVmDefinition(cursorDefinition, { debugInfo: false }),
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
		const projectionSites = projectionDefinition.functions.flatMap((fn) =>
			(fn.regions ?? [])
				.filter((region) => region.kind === "string-split-projection")
				.map((region) => ({ fn, region })),
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
			serializeVmDefinition(projectionDefinition, { debugInfo: false }),
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
			projectionDefinition.functions.flatMap(
				(fn) =>
					fn.regions?.filter((region) => region.kind === "regexp-exec-projection") ?? [],
			),
		).not.toHaveLength(0);
		const wirePath = path.join(directory, "regexp-exec-projection-region.malw");
		writeFileSync(
			wirePath,
			serializeVmDefinition(projectionDefinition, { debugInfo: false }),
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
			projectionDefinition.functions.flatMap(
				(fn) =>
					fn.regions?.filter((region) => region.kind === "regexp-iterator-projection") ??
					[],
			),
		).not.toHaveLength(0);
		const wirePath = path.join(directory, "regexp-iterator-projection-region.malw");
		writeFileSync(
			wirePath,
			serializeVmDefinition(projectionDefinition, { debugInfo: false }),
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
			regionDefinition.functions.flatMap(
				(fn) =>
					fn.regions?.filter((region) => region.kind === "string-slice-number") ?? [],
			),
		).not.toHaveLength(0);
		const wirePath = path.join(directory, "string-slice-number-region.malw");
		writeFileSync(
			wirePath,
			serializeVmDefinition(regionDefinition, { debugInfo: false }),
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
			stackDefinition.functions.flatMap(
				(fn) => fn.regions?.filter((region) => region.kind === "stack-object-plan") ?? [],
			),
		).not.toHaveLength(0);
		const wirePath = path.join(directory, "stack-object-plan-region.malw");
		writeFileSync(wirePath, serializeVmDefinition(stackDefinition, { debugInfo: false }));
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("rejects a stack-object access slot for a different allocation key", () => {
		const stackFn: VmFunction = {
			...fn,
			registerCount: 4,
			instructions: [
				{ opcode: "CREATE_NUMBER", dst: 0, value: 41 },
				{ opcode: "CREATE_NUMBER", dst: 1, value: 42 },
				{
					opcode: "CREATE_OBJECT_SHAPED",
					dst: 2,
					count: 2,
					keyStringIndices: [0, 1],
					valueRegisters: [0, 1],
					shapeCacheIndex: 0,
				},
				{
					opcode: "LOAD_PROPERTY_STATIC",
					dst: 3,
					object: 2,
					stringIndex: 1,
					icIndex: 0,
				},
				{
					opcode: "STORE_PROPERTY_STATIC",
					object: 2,
					value: 0,
					stringIndex: 1,
					icIndex: 1,
				},
				{ opcode: "RETURN", value: 3 },
			],
			positions: [],
			registerRepresentations: ["boxed", "boxed", "boxed", "boxed"],
			regions: [
				{
					kind: "stack-object-plan",
					license: {
						guard: { dependencies: [], obligations: ["fallback"] },
						genericTwin: "retained",
						materialization: "none",
						admission: { anchorIp: 2, validity: "once" },
					},
					representation: "activation-local-fixed-shape-objects",
					anchors: [2],
					claimedIps: [2, 3, 4],
					controlFlow: { ordinaryBlockIps: [2, 3, 4], exceptionalHandlerIps: [] },
					cost: { score: 2, metadataOperations: 3 },
					sites: [
						{
							allocationIp: 2,
							slotCount: 2,
							accesses: [
								{ ip: 3, slot: 1 },
								{ ip: 4, slot: 1 },
							],
							materializations: [],
						},
					],
				},
			],
		};
		const stackDefinition: VmDefinition = {
			...definition,
			functions: [stackFn],
			stringConstants: [["first".charCodeAt(0)], ["second".charCodeAt(0)]],
		};
		const wire = serializeVmDefinition(stackDefinition, { debugInfo: false });
		// The access-slot byte is followed by inheritedIp=-1 and an empty
		// materialization table. Preserve the wire layout while naming slot zero.
		expect(wire.at(-3)).toBe(2);
		wire[wire.length - 3] = 0;
		rejectsWire("stack-object-slot-key", wire);
	});

	it("loads and executes persisted argument snapshot prefixes", () => {
		const snapshotDefinition: VmDefinition = {
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
					registerRepresentations: ["boxed", "boxed"],
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
			serializeVmDefinition(snapshotDefinition, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("loads unaligned fixed-width little-endian scalar fields", () => {
		const scalarDefinition: VmDefinition = {
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
					registerRepresentations: ["boxed", "boxed"],
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
			serializeVmDefinition(scalarDefinition, { debugInfo: false }),
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
