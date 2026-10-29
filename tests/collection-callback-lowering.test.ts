import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { builtinCallbackInvocation } from "../src/compiler/shared/builtin-registry.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import type { CompilerInstruction } from "../src/compiler/shared/compiler-instruction.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import { verifyExecutionProgram } from "../src/compiler/target/verify-execution.ts";

function options(primordials: "mutable" | "locked") {
	return {
		facts: withProgramClosure(
			compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials, eval: false, realms: false } }),
			),
			programClosureCertificate(
				{ kind: "whole-program", entry: "/collection.js" },
				[],
				[],
			),
		),
		coreVerification: "per-pass" as const,
	};
}
function source(kind: string) {
	return `const output=[]; const values=new ${kind}(); values.forEach(function callback(value,key,owner){ output.push([value,key,owner,arguments.length]); }, "context", "extra"); globalThis.output=output;`;
}

describe("collection callback boundary contracts", () => {
	it.each(["Map", "Set"])(
		"retains boxed %s roles and guarded identity in both primordial modes",
		(kind) => {
			expect(builtinCallbackInvocation(`${kind}.prototype.forEach`)).toMatchObject({
				argumentIndex: 0,
				argumentKinds: ["any", "any", "object"],
			});
			for (const mode of ["mutable", "locked"] as const) {
				const image = compileSemanticProgramToProgramImage(
					analyzeSourceAndRunSemanticAnalysis(source(kind), "/collection.js"),
					options(mode),
				);
				const plans = image.native.functions.flatMap((fn) =>
					fn.instructions.filter(
						(plan) =>
							plan?.kind === "call" && plan.directCallbackFunctionIndex !== undefined,
					),
				);
				expect(plans).toHaveLength(1);
				const plan = plans[0]!;
				if (plan.kind !== "call") throw new Error("missing call");
				expect(plan.guardedBuiltinCall?.operation).toBe(
					mode === "locked"
						? `${kind}.prototype.forEach`
						: "Collection.prototype.forEach",
				);
				const encoded = serializeCompilerArtifact(image);
				expect(serializeCompilerArtifact(deserializeCompilerArtifact(encoded))).toEqual(
					encoded,
				);
			}
		},
	);
	it.each(["mutable", "locked"] as const)(
		"retains guarded families for forwarded and phi callbacks with %s primordials",
		(mode) => {
			const image = compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(
					`globalThis.invoke=function(receiver,callback,other,choose){
                    let selected=callback;if(choose)selected=other;
                    receiver.forEach(selected);return receiver.map(callback);
                };
                globalThis.reduce=function(receiver,callback,initial){return receiver.reduce(callback,initial);};`,
					"/collection.js",
				),
				options(mode),
			);
			const calls = image.native.functions.flatMap((fn) =>
				fn.instructions.filter(
					(plan) => plan?.kind === "call" && plan.guardedBuiltinCall !== undefined,
				),
			);
			expect(
				calls.map((plan) =>
					plan?.kind === "call" ? plan.guardedBuiltinCall?.operation : undefined,
				),
			).toEqual(
				expect.arrayContaining([
					"Collection.prototype.forEach",
					"ArrayOrTypedArray.prototype.map",
					"ArrayOrTypedArray.prototype.reduce",
				]),
			);
			for (const plan of calls) {
				if (plan?.kind !== "call") throw new Error("missing call");
				expect(plan.directCallbackFunctionIndex).toBeUndefined();
			}
			expect(
				image.native.functions.flatMap((fn) => fn.storage!.callbackTransports),
			).toEqual([]);
			const encoded = serializeCompilerArtifact(image);
			expect(serializeCompilerArtifact(deserializeCompilerArtifact(encoded))).toEqual(
				encoded,
			);
		},
	);
	it("does not invent builtin identity for an unknown replacement constructor", () => {
		const compilation = optimizeSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.Map = globalThis.Constructor;
				const values = new Map();
				globalThis.result = values.forEach(function callback(value, key) { globalThis.observe(value, key); });`,
				"/collection.js",
			),
			options("mutable"),
			(_phase, run) => run(),
		);
		const target = lowerCoreCompilationToExecution(compilation);
		const operations = target.functions.flatMap((fn) =>
			fn.blocks.flatMap((block) => block.instructions),
		);
		expect(
			operations.some(
				(op) => op.type === "callKnown" && op.operation === "Map.prototype.forEach",
			),
		).toBe(false);
	});
	it("roots the inserted primordial and rejects forged callback bridge mappings", () => {
		const compilation = optimizeSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(source("Map"), "/collection.js"),
			options("locked"),
			(_phase, run) => run(),
		);
		const target = lowerCoreCompilationToExecution(compilation);
		const fn = target.functions.find((fn) =>
			fn.blocks.some((block) =>
				block.instructions.some(
					(op) =>
						op.type === "call" &&
						op.knownBuiltinCall?.operation === "Map.prototype.forEach",
				),
			),
		)!;
		const blockIndex = fn.blocks.findIndex((block) =>
			block.instructions.some(
				(op) =>
					op.type === "call" &&
					op.knownBuiltinCall?.operation === "Map.prototype.forEach",
			),
		);
		const ops = fn.blocks[blockIndex]!.instructions;
		const callIndex = ops.findIndex(
			(op) =>
				op.type === "call" && op.knownBuiltinCall?.operation === "Map.prototype.forEach",
		);
		const call = ops[callIndex]!;
		if (call.type !== "call") throw new Error("missing callback bridge");
		const load = ops[callIndex - 1]!;
		if (load.type !== "loadPrimordial") throw new Error("missing primordial");
		const point = fn.gc.safepoints.find((point) => point.instruction === call)!;
		expect(point.incomingRootRegisters).toContain(call.registers[1]);
		expect(call.registers).toHaveLength(6);
		expect(
			call.immediateValues
				?.slice(4)
				.map((value) =>
					value?.kind === "string"
						? target.core.stringConstantText(value.index)
						: undefined,
				),
		).toEqual(["context", "extra"]);
		const forged = (
			changedCall: CompilerInstruction,
			changedLoad: CompilerInstruction = load,
		) => ({
			...target,
			functions: target.functions.map((candidate) =>
				candidate !== fn
					? candidate
					: {
							...fn,
							blocks: fn.blocks.map((block, index) =>
								index !== blockIndex
									? block
									: {
											...block,
											instructions: ops
												.with(callIndex - 1, changedLoad)
												.with(callIndex, changedCall),
										},
							),
							gc: {
								...fn.gc,
								safepoints: fn.gc.safepoints.map((point) =>
									point.instruction === call
										? { ...point, instruction: changedCall }
										: point,
								),
							},
						},
			),
		});
		expect(() =>
			verifyExecutionProgram(forged(call, { ...load, nodeIndex: load.nodeIndex + 1 })),
		).toThrow(/expected callKnown/);
		expect(() =>
			verifyExecutionProgram(
				forged({
					...call,
					registers: [
						call.registers[0],
						call.registers[2],
						call.registers[2],
						...call.registers.slice(3),
					],
				}),
			),
		).toThrow();
		expect(() =>
			verifyExecutionProgram(
				forged({
					...call,
					registers: call.registers.slice(0, -1),
					immediateValues: call.immediateValues?.slice(0, -1),
				} as CompilerInstruction),
			),
		).toThrow(/argument count/);
		expect(() =>
			verifyExecutionProgram(
				forged({
					...call,
					immediateValues: call.immediateValues?.with(3, call.immediateValues[4]),
				}),
			),
		).toThrow();
	});
});
