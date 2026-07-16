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

	function rejectsMutation(name: string, offset: number): void {
		const wire = serializeVmDefinition(definition, { debugInfo: false });
		new DataView(wire.buffer, wire.byteOffset, wire.byteLength).setUint32(
			offset,
			2,
			true,
		);
		const wirePath = path.join(directory, `${name}.malw`);
		writeFileSync(wirePath, wire);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("truncated or corrupt buffer");
	}

	it("rejects an explicit count that disagrees with its arrays", () => {
		// Empty definition tables put the first instruction at byte 70. Its explicit
		// count follows the opcode tag and dst operand.
		rejectsMutation("explicit-count", 70 + 1 + 4);
	});

	it("rejects mismatched paired-array lengths", () => {
		// Skip tag, dst, explicit count, then the first array's count and one value.
		rejectsMutation("paired-count", 70 + 1 + 4 + 4 + 4 + 4);
	});
});
