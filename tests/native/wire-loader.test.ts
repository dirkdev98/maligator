import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { compileEntrypointToBuffer } from "../../src/compile-program.ts";
import { buildLoadDriver } from "../../src/local-build.ts";
import type { VmDefinition, VmFunction } from "../../src/lower-vm.ts";
import { serializeVmDefinition } from "../../src/serialize-vm.ts";
import { stripTypesWithTypeScript } from "../../src/typescript-strip.ts";

const fn: VmFunction = {
	nameStringIndex: -1,
	isGenerator: false,
	isAsync: false,
	parameterCount: 0,
	length: 0,
	registerCount: 1,
	capturedCount: 0,
	strict: true,
	needsArguments: false,
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
		},
	],
	handlers: [],
	fileIndex: 0,
	positions: [],
};

const definition: VmDefinition = {
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

describe("wire loader side-data validation", () => {
	let driver: string;
	let directory: string;

	beforeAll(() => {
		driver = buildLoadDriver(false, {
			kind: "source",
			sourceDirectory: path.resolve("src"),
			entrypoint: path.resolve("src/eval-compiler-entry.mts"),
			bake: () =>
				compileEntrypointToBuffer(path.resolve("src/eval-compiler-entry.mts"), {
					stripTypes: stripTypesWithTypeScript,
				}),
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
		// Empty definition tables put the first instruction at byte 28. Its explicit
		// count follows the opcode tag and dst operand.
		rejectsMutation("explicit-count", 28 + 1 + 1, 4); // ZigZag(2)
	});

	it("rejects mismatched paired-array lengths", () => {
		// Skip tag, dst, explicit count, then the first array's count and one value.
		rejectsMutation("paired-count", 28 + 1 + 1 + 1 + 1 + 1, 2);
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
});
