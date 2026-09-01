import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import type { CoreProgram } from "../src/compiler/core/core-store.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";

describe("Core allocation helper chains", () => {
	it("keeps an exact allocation-helper chain within the generated code budget", () => {
		const sourcePath = "core-inline-allocation-chain.js";
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`const vector = (x, y, z) => ({ x, y, z });
			const scale = (value, factor) =>
				vector(value.x * factor, value.y * factor, value.z * factor);
			const add = (left, right) =>
				vector(left.x + right.x, left.y + right.y, left.z + right.z);
			const dot = (left, right) =>
				left.x * right.x + left.y * right.y + left.z * right.z;
			function hot(limit) {
				let checksum = 0;
				for (let index = 0; index < limit; index++) {
					const first = vector(index, index + 1, index + 2);
					const second = scale(first, 0.5);
					const result = add(first, second);
					checksum += dot(result, second);
				}
				return checksum;
			}
			hot(10);`,
			sourcePath,
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(semantic, {
			facts: withProgramClosure(
				compilerProgramFactsFromConfig(resolveBuildConfig({})),
				programClosureCertificate(
					{ kind: "whole-program", entry: sourcePath },
					[{ kind: "entry-module", module: sourcePath }],
					[],
				),
			),
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const hot = coreFunctionNamed(optimized!, "hot")!;
		const instructions = coreOperations(hot);
		expect(instructions.some(({ opcode }) => opcode === "call")).toBe(false);
		expect(
			instructions.some(
				({ opcode }) => opcode === "createObject" || opcode === "createObjectShaped",
			),
		).toBe(false);
	});
});
