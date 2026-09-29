import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import { analyzeClosureCaptures } from "../src/compiler/target/analyze-closure-captures.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	emitBatch,
	emitProgramImage,
} from "../src/compiler/target/emit-program-image.ts";
import {
	deserializeRuntimeImage,
	serializeRuntimeImage,
} from "../src/compiler/target/program-image-codec.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";
import type { BytecodeInstruction } from "../src/compiler/target/runtime-image.ts";
import { vmSafepointRootMapsAreTrusted } from "../src/compiler/target/runtime-image.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

function compile(source: string, closed = true): ProgramImage {
	const path = "/closure-captures.js";
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

function layoutImage(functions: Array<Array<BytecodeInstruction>>): ProgramImage {
	const image = compile("globalThis.result = 1;", false);
	return {
		...image,
		runtime: {
			...image.runtime,
			functions: functions.map((instructions) => ({
				...image.runtime.functions[0]!,
				instructions,
			})),
		},
	};
}

function captures(image: ProgramImage): Array<Array<number> | undefined> {
	return image.runtime.functions.map((fn) => fn.closureCaptureOwners);
}

describe("external closure scope requirements", () => {
	it("forwards ancestor state through closures that only create another closure", () => {
		const image = layoutImage([
			[{ opcode: "CREATE_FUNCTION", dst: 0, functionIndex: 1 }],
			[{ opcode: "CREATE_FUNCTION", dst: 0, functionIndex: 2 }],
			[
				{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 0, index: 0 },
				{ opcode: "STORE_CAPTURED", src: 0, ownerFunctionIndex: 1, index: 1 },
			],
		]);
		expect(captures(analyzeClosureCaptures(image, programAnalysisContext()))).toEqual([
			[],
			[0],
			[0, 1],
		]);
	});

	it("keeps loop scopes in their children's captures while excluding locally created scopes", () => {
		const image = layoutImage([
			[
				{ opcode: "ENV_PUSH", scopeId: -2, slotCount: 1 },
				{ opcode: "CREATE_FUNCTION", dst: 0, functionIndex: 1 },
				{ opcode: "ENV_COPY", scopeId: -2, slotCount: 1 },
			],
			[
				{ opcode: "CREATE_FUNCTION", dst: 0, functionIndex: 2 },
				{ opcode: "ENV_PUSH", scopeId: -3, slotCount: 1 },
				{ opcode: "LOAD_CAPTURED", dst: 1, ownerFunctionIndex: -3, index: 0 },
			],
			[{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: -2, index: 0 }],
		]);
		expect(captures(analyzeClosureCaptures(image, programAnalysisContext()))).toEqual([
			[],
			[-2],
			[-2],
		]);
	});

	it("accounts for private-name writes and terminates on recursive creation graphs", () => {
		const image = layoutImage([
			[{ opcode: "CREATE_FUNCTION", dst: 0, functionIndex: 1 }],
			[
				{ opcode: "CREATE_FUNCTION", dst: 0, functionIndex: 2 },
				{ opcode: "CREATE_PRIVATE_NAMES", ownerFunctionIndex: 0, capturedIndices: [1] },
			],
			[{ opcode: "CREATE_FUNCTION", dst: 0, functionIndex: 1 }],
		]);
		expect(captures(analyzeClosureCaptures(image, programAnalysisContext()))).toEqual([
			[],
			[0],
			[0],
		]);
	});

	it("requires source closure and preserves chains for dynamic scope", () => {
		const ordinary = layoutImage([[]]);
		expect(analyzeClosureCaptures(ordinary, programAnalysisContext(false))).toBe(
			ordinary,
		);
		const dynamic = layoutImage([[{ opcode: "WITH_ENTER", object: 0 }], []]);
		expect(analyzeClosureCaptures(dynamic, programAnalysisContext())).toBe(dynamic);
	});

	it("preserves trusted safepoint metadata when adding lexical requirements", () => {
		const image = compile("globalThis.result = 1;", false);
		expect(image.runtime.functions.every(vmSafepointRootMapsAreTrusted)).toBe(true);
		const analyzed = analyzeClosureCaptures(image, programAnalysisContext());
		expect(analyzed.runtime.functions.every(vmSafepointRootMapsAreTrusted)).toBe(true);
	});

	it.each([
		[0],
		[1],
		[-1, -1],
		[-1, -2],
		[1.5],
		[-0x80000000],
		[-0x7fffffff],
		[-0x7ffffffe],
	])("rejects invalid cached closure owners %j", (...owners) => {
		const image = compile("globalThis.result = 1;");
		image.runtime.functions[0]!.closureCaptureOwners = owners;
		expect(() => serializeCompilerArtifact(image)).toThrow(
			"invalid closure capture owners",
		);
	});

	it("retains exact scope requirements through compiler caching and both C table formats", () => {
		const image = compile(`globalThis.make = function make(seed) {
			let value = seed;
			return { get: () => value, set: next => value = next };
		};`);
		expect(captures(image)).toEqual([[], [], [1], [1]]);
		const decoded = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(captures(decoded)).toEqual(captures(image));
		const portable = deserializeRuntimeImage(serializeRuntimeImage(image.runtime));
		expect(portable.functions.every((fn) => fn.closureCaptureOwners === undefined)).toBe(
			true,
		);
		const emitted = emitProgramImage(decoded);
		expect(emitted).toContain(".closure_captures = closure_captures_value");
		expect(emitted).toContain(
			".closure_capture_owner_count = closure_capture_owner_count_value",
		);
		for (const source of [emitted, emitBatch([decoded])]) {
			expect(source).toMatch(
				/static const i32 mal_\w*closure_capture_owners\w*\[\] = \{/,
			);
			expect(source).toMatch(
				/MAL_FUNCTION_ROW\(nullptr, nullptr, mal_\w*closure_captures\w*, 0,/,
			);
			expect(source).toMatch(
				/MAL_FUNCTION_ROW\(nullptr, nullptr, mal_\w*closure_captures\w*, 1,/,
			);
		}
	});
});
