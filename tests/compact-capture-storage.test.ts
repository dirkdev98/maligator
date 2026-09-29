import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import { compactCaptureStorage } from "../src/compiler/target/compact-capture-storage.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import type { BytecodeInstruction } from "../src/compiler/target/runtime-image.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

function compile(source: string, closed = true): ProgramImage {
	const path = "/capture-layout.js";
	const base = compilerProgramFactsFromConfig(
		resolveBuildConfig({ engine: { eval: false, realms: false, primordials: "locked" } }),
	);
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(source, path),
		{
			facts: closed
				? withProgramClosure(
						base,
						programClosureCertificate(
							{ kind: "whole-program", entry: path },
							[{ kind: "entry-module", module: path }],
							[],
						),
					)
				: base,
		},
	);
}

// Explicit image-layout tests model optimizer leftovers independently of the
// optimizer's current inlining choices. The pass must preserve instruction IPs.
function layoutImage(
	instructions: Array<BytecodeInstruction>,
	mappedArgumentSlots: Array<number> = [],
): ProgramImage {
	const image = compile("globalThis.result = 1;", false);
	const fn = image.runtime.functions[0]!;
	return {
		...image,
		runtime: {
			...image.runtime,
			functions: [{ ...fn, capturedCount: 3, instructions, mappedArgumentSlots }],
		},
	};
}

describe("physical captured storage after function reachability", () => {
	it("removes the activation environment after its only child is inlined", () => {
		const image = compile(`globalThis.make = function make(seed) {
			const value = seed;
			const read = () => value + 1;
			return read();
		};`);
		const decoded = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(decoded.runtime.functions).toHaveLength(2);
		expect(decoded.runtime.functions.every((fn) => fn.capturedCount === 0)).toBe(true);
		for (const [index, fn] of decoded.runtime.functions.entries()) {
			const emitted = emitCompiledFunction(
				fn,
				decoded.native.functions[index]!,
				index,
				"",
				false,
			)!;
			expect(emitted.source).not.toContain("mal_env_new(");
			for (const entry of emitted.directEntries) {
				expect(entry.source).not.toContain("mal_env_new(");
			}
		}
	});

	it("compacts holes without separating sibling reads and writes", () => {
		const image = compile(`globalThis.make = function make(seed) {
			const dead = seed;
			const read = () => dead + 1;
			let value = seed;
			const inlined = read();
			return { inlined, get: () => value, set: next => value = next };
		};`);
		expect(image.runtime.functions.map((fn) => fn.capturedCount)).toEqual([0, 1, 0, 0]);
		const operations = image.runtime.functions
			.flatMap((fn) => fn.instructions)
			.filter((op) => op.opcode === "LOAD_CAPTURED" || op.opcode === "STORE_CAPTURED");
		expect(operations.length).toBeGreaterThan(2);
		for (const op of operations)
			expect(op).toMatchObject({ ownerFunctionIndex: 1, index: 0 });
	});

	it("preserves IPs and the computation producing an unread capture", () => {
		const image = layoutImage([
			{
				opcode: "CALL",
				dst: 2,
				callee: 0,
				thisValue: 1,
				argumentCount: 0,
				arguments: [],
			},
			{ opcode: "STORE_CAPTURED", src: 2, ownerFunctionIndex: 0, index: 0 },
			{ opcode: "RETURN", value: 2 },
		]);
		const compacted = compactCaptureStorage(image, programAnalysisContext());
		expect(compacted.runtime.functions[0]!.capturedCount).toBe(0);
		expect(compacted.runtime.functions[0]!.instructions).toEqual([
			image.runtime.functions[0]!.instructions[0],
			{ opcode: "MOVE", dst: 2, src: 2 },
			image.runtime.functions[0]!.instructions[2],
		]);
		expect(compacted.native).toBe(image.native);
	});

	it("pins arguments aliases even without an explicit capture read", () => {
		const image = layoutImage(
			[{ opcode: "STORE_CAPTURED", src: 0, ownerFunctionIndex: 0, index: 2 }],
			[-1, 2],
		);
		const fn = compactCaptureStorage(image, programAnalysisContext()).runtime
			.functions[0]!;
		expect(fn.capturedCount).toBe(1);
		expect(fn.mappedArgumentSlots).toEqual([-1, 0]);
		expect(fn.instructions).toEqual([
			{ opcode: "STORE_CAPTURED", src: 0, ownerFunctionIndex: 0, index: 0 },
		]);
	});

	it("relocates implicit private-name writes together with capture reads", () => {
		const image = layoutImage([
			{
				opcode: "CREATE_PRIVATE_NAMES",
				ownerFunctionIndex: 0,
				capturedIndices: [2],
			},
			{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 0, index: 2 },
		]);
		const fn = compactCaptureStorage(image, programAnalysisContext()).runtime
			.functions[0]!;
		expect(fn.capturedCount).toBe(1);
		expect(fn.instructions[0]).toMatchObject({ capturedIndices: [0] });
		expect(fn.instructions[1]).toMatchObject({ index: 0 });
	});

	it("does not relocate independent per-iteration scope identities", () => {
		const image = layoutImage([
			{ opcode: "ENV_PUSH", scopeId: -1, slotCount: 3 },
			{ opcode: "STORE_CAPTURED", src: 0, ownerFunctionIndex: -1, index: 2 },
			{ opcode: "LOAD_CAPTURED", dst: 1, ownerFunctionIndex: -1, index: 2 },
			{ opcode: "ENV_COPY", scopeId: -1, slotCount: 3 },
			{ opcode: "ENV_POP" },
		]);
		const fn = compactCaptureStorage(image, programAnalysisContext()).runtime
			.functions[0]!;
		expect(fn.capturedCount).toBe(0);
		expect(fn.instructions).toEqual(image.runtime.functions[0]!.instructions);
	});

	it("leaves eval-visible and relocatable images unchanged", () => {
		const image = layoutImage([
			{ opcode: "STORE_CAPTURED", src: 0, ownerFunctionIndex: 0, index: 2 },
		]);
		expect(compactCaptureStorage(image, programAnalysisContext(false))).toBe(image);
	});

	it("leaves dynamic-scope images unchanged", () => {
		const image = layoutImage([{ opcode: "WITH_ENTER", object: 0 }]);
		expect(compactCaptureStorage(image, programAnalysisContext())).toBe(image);
	});
});
