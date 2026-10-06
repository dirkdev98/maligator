import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import type {
	CoreDirectEntryPlan,
	CorePlanRepresentation,
} from "../src/compiler/core/core-ir-regions.ts";
import { analyzeCoreNativeEntry } from "../src/compiler/core/core-native-entry-analysis.ts";
import { connectCoreNativeEntries } from "../src/compiler/core/core-native-entry-graph.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_SUMMARIES_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	directCompiledEntryKey,
	emitCompiledFunction,
} from "../src/compiler/target/render-native-c.ts";
import {
	analysisProgram,
	programAnalysisContext,
} from "./helpers/core-program-analysis.ts";

const arithmetic = Array.from({ length: 24 }, (_, index) => `(x + bias + ${index})`).join(
	" + ",
);

function compile(source: string) {
	const path = "/native-entry-graph.js";
	const facts = withProgramClosure(
		compilerProgramFactsFromConfig(
			resolveBuildConfig({
				engine: { eval: false, realms: false, primordials: "locked" },
			}),
		),
		programClosureCertificate({ kind: "whole-program", entry: path }, [], []),
	);
	return deserializeCompilerArtifact(
		serializeCompilerArtifact(
			compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(source, path),
				{ facts, coreVerification: "per-pass" },
			),
		),
	);
}

function graph(
	targets: ReadonlyArray<number | undefined>,
	seeds: ReadonlyArray<{
		readonly function: number;
		readonly parameters: ReadonlyArray<CorePlanRepresentation>;
	}>,
	entryBudget = Infinity,
) {
	const program = analysisProgram();
	const builders = targets.map(
		() =>
			new CoreFunctionBuilder(program, {
				parameterCount: 2,
				metadata: { strict: true },
			}),
	);
	for (const [index, builder] of builders.entries()) {
		const body = builder.createBlock([{}, {}]);
		const left = builder.blockParameterValue(body, 0);
		const right = builder.blockParameterValue(body, 1);
		const target = targets[index];
		let result;
		if (target === undefined) {
			[result] = builder.appendInstruction(body, "binary", [left, right], {
				attributes: { operator: "+" },
			});
		} else {
			const [callee] = builder.appendInstruction(body, "createFunction", [], {
				attributes: { functionIndex: builders[target]!.functionId },
			});
			const [receiver] = builder.appendInstruction(body, "createUndefined", []);
			[result] = builder.appendInstruction(body, "call", [
				callee!,
				receiver!,
				left,
				right,
			]);
		}
		if (result === undefined) throw new Error("Missing graph result");
		builder.setTerminator(body, { kind: "return", value: result });
		builder.finish(body);
	}
	const context = programAnalysisContext();
	const analyses = new CoreAnalysisManager(
		program,
		context,
		new CoreOptimizationReportBuilder(program),
	);
	const summaries = analyses.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
		scope: "program",
	});
	const initial: Array<CoreDirectEntryPlan> = seeds.map((seed) => {
		const functionId = builders[seed.function]!.functionId;
		const fn = program.function(functionId);
		return {
			id: 0,
			function: functionId,
			parameterRepresentations: seed.parameters,
			callSites: [],
			...analyzeCoreNativeEntry(
				fn,
				buildCoreControlFlow(program, functionId),
				seed.parameters,
				undefined,
				[],
			),
			target: "native",
			fallback: "canonical-core",
			cost: { generatedCode: 8, compilerWork: 8, runtimeBenefit: 8 },
		};
	});
	let admitted = 0;
	let analysesRun = 0;
	const entries = connectCoreNativeEntries(
		program,
		summaries,
		analyses,
		new Set(program.functionIds()),
		initial,
		() => admitted++ < entryBudget,
		() => {
			analysesRun++;
			return true;
		},
	);
	return { entries, builders, analysesRun };
}

describe("connected native entry contracts", () => {
	it("does not import a later scalar callee result through a guarded edge", () => {
		const image = compile(`
			function guardedHelper(x, bias) {
				const exactLeaf = function exactLeaf(x, bias) { return ${arithmetic}; };
				let sum = 0;
				for (let i = 0; i < 3; i++) sum += exactLeaf(x + i, bias);
				return sum;
			}
			function guardedVisitor(x, bias) {
				let sum = 0;
				for (let i = 0; i < 3; i++) sum += guardedHelper(x + i, bias);
				return sum;
			}
			globalThis.guardedVisitor = guardedVisitor;
			for (let i = 0; i < 100; i++) globalThis.result = guardedVisitor(i, 4);
		`);
		const names = image.runtime.functions.map((fn) =>
			String.fromCharCode(...(image.runtime.stringConstants[fn.nameStringIndex] ?? [])),
		);
		const helper = names.indexOf("guardedHelper");
		const helperEntry = image.native.functions[helper]!.directEntries[0]!;
		const visitorEntry =
			image.native.functions[names.indexOf("guardedVisitor")]!.directEntries[0]!;
		expect(helperEntry.resultRepresentation).toBe("number");
		expect(helperEntry.callOverrides).toContainEqual(
			expect.not.objectContaining({ guarded: true }),
		);
		expect(visitorEntry.resultRepresentation).toBe("boxed");
		expect(visitorEntry.callOverrides).toContainEqual(
			expect.objectContaining({ functionIndex: helper, guarded: true }),
		);
	});

	it("connects the declaration benchmark through guarded numeric leaf entries", () => {
		const image = deserializeCompilerArtifact(
			serializeCompilerArtifact(
				compileEntrypoint(
					resolve("bench/runtime-gap/cases/connected-numeric-helpers.mjs"),
					{
						buildConfig: resolveBuildConfig({
							surface: { node: true },
							engine: { eval: false, realms: false, primordials: "locked" },
						}),
						coreVerification: "per-pass",
					},
				),
			),
		);
		const names = image.runtime.functions.map((fn) =>
			String.fromCharCode(...(image.runtime.stringConstants[fn.nameStringIndex] ?? [])),
		);
		const leaf = names.indexOf("leaf");
		const visitor = names.indexOf("visitor");
		const entry = image.native.functions[visitor]!.directEntries[0]!;
		expect(image.native.functions[leaf]!.directEntries).toContainEqual(
			expect.objectContaining({
				parameterRepresentations: ["number", "number"],
				resultRepresentation: "number",
			}),
		);
		// The branching helper is inlined in visitor. Its two leaf calls still
		// load a mutable declaration, so only the guarded branch has a typed ABI.
		expect(entry).toMatchObject({
			parameterRepresentations: ["number", "number"],
			resultRepresentation: "boxed",
		});
		expect(entry.callOverrides).toHaveLength(2);
		for (const call of entry.callOverrides!) {
			expect(call).toMatchObject({ functionIndex: leaf, guarded: true });
			expect(
				image.native.functions[visitor]!.instructions[call.instructionIp],
			).not.toHaveProperty("directEntryId");
			const instruction =
				image.native.functions[visitor]!.body.instructions[call.instructionIp]!;
			expect(instruction.opcode).toBe("CALL");
			if (instruction.opcode === "CALL")
				expect(entry.registerRepresentations[instruction.dst]).toBe("boxed");
		}
	});

	it("preserves scalar arguments and results across an escaped visitor and two helpers", () => {
		const image = compile(`
			globalThis.run = function run(seed) {
				const leaf = function leaf(x, bias) { return ${arithmetic}; };
				const helper = function helper(x, bias) {
					if (x < 0) return leaf(-x, bias) - bias;
					return leaf(x, bias) + bias;
				};
				const visitor = function visitor(x, bias) {
					let sum = 0;
					for (let j = 0; j < 3; j++) sum += helper(x + j, bias);
					return sum;
				};
				globalThis.visitor = visitor;
				let bias = seed | 0;
				let result = 0;
				for (let i = 0; i < 100; i++) {
					bias = (bias + 1) | 0;
					result += visitor(i, bias);
				}
				return result;
			};
		`);
		const names = image.runtime.functions.map((fn) =>
			String.fromCharCode(...(image.runtime.stringConstants[fn.nameStringIndex] ?? [])),
		);
		const indices = ["leaf", "helper", "visitor"].map((name) => names.indexOf(name));
		const contracts = new Map(
			image.native.functions.flatMap((fn, index) =>
				fn.directEntries.map((entry) => [directCompiledEntryKey(index, entry.id), entry]),
			),
		);
		for (const index of indices) {
			const native = image.native.functions[index]!;
			expect(native.specializedOnly).toBeUndefined();
			expect(native.directEntries).toHaveLength(1);
			expect(native.directEntries[0]).toMatchObject({
				parameterRepresentations: ["number", "number"],
				resultRepresentation: "number",
			});
			const emitted = emitCompiledFunction(
				image.runtime.functions[index]!,
				native,
				index,
				"",
				false,
				"static",
				new Set(indices),
				image.native.semanticProtectors,
				contracts,
			)!;
			for (const call of native.directEntries[0]!.callOverrides ?? []) {
				expect(native.instructions[call.instructionIp]).not.toHaveProperty(
					"directEntryId",
				);
				expect(emitted.source).not.toContain(
					`mal_direct_${call.functionIndex}_${call.entryId}(`,
				);
				expect(emitted.directEntries[0]!.source).toContain(
					`mal_direct_${call.functionIndex}_${call.entryId}(`,
				);
				const instruction = native.body.instructions[call.instructionIp]!;
				expect(instruction.opcode).toBe("CALL");
				if (instruction.opcode === "CALL")
					expect(native.directEntries[0]!.registerRepresentations[instruction.dst]).toBe(
						"number",
					);
			}
		}
		expect(
			image.native.functions[indices[1]!]!.directEntries[0]!.callOverrides,
		).toHaveLength(2);
		expect(
			image.native.functions[indices[2]!]!.directEntries[0]!.callOverrides,
		).toHaveLength(1);
	});

	it("does not snapshot mutable captured state into a scalar result proof", () => {
		const image = compile(`
			globalThis.run = function run(seed) {
				let bias = seed;
				const leaf = function leaf(x) { return ${arithmetic}; };
				const helper = function helper(x) { if (x < 0) return leaf(-x); return leaf(x); };
				const visitor = function visitor(x) { let sum = 0; for (let i = 0; i < 3; i++) sum += helper(x + i); return sum; };
				globalThis.visitor = visitor;
				globalThis.setBias = value => { bias = value; };
				let sum = 0; for (let i = 0; i < 100; i++) sum += visitor(i); return sum;
			};
		`);
		const entries = image.native.functions.flatMap((fn) => fn.directEntries);
		expect(entries).toHaveLength(3);
		expect(entries.every((entry) => entry.resultRepresentation === "boxed")).toBe(true);
		expect(entries.flatMap((entry) => entry.callOverrides ?? []).length).toBeGreaterThan(
			0,
		);
	});

	it.each(["exact-cell-value-kinds", "captured-callback-inlining"])(
		"charges boxed-input scalar result proofs as discovery for %s",
		(fixture) => {
			let resultOnlyEntries = 0;
			compileEntrypoint(resolve(`tests/local/${fixture}.js`), {
				buildConfig: resolveBuildConfig({
					engine: { eval: false, realms: false, primordials: "locked" },
				}),
				coreVerification: "per-pass",
				afterCoreOptimization(_program, _context, _report, plan) {
					for (const entry of plan.directEntries) {
						if (
							entry.parameterRepresentations.every((value) => value === "boxed") &&
							entry.resultRepresentation !== "boxed"
						) {
							expect(entry.cost.compilerWork).toBe(0);
							resultOnlyEntries++;
						}
					}
				},
			});
			expect(resultOnlyEntries).toBeGreaterThan(0);
		},
	);

	it("converges through a long call chain and keeps denied targets generic", () => {
		const targets = Array.from({ length: 80 }, (_, index) =>
			index === 79 ? undefined : index + 1,
		);
		const seeds = [{ function: 0, parameters: ["f64", "f64"] as const }];
		const full = graph(targets, seeds);
		expect(full.entries).toHaveLength(80);
		expect(full.entries.every((entry) => entry.resultRepresentation === "f64")).toBe(
			true,
		);
		expect(full.analysesRun).toBeLessThan(240);
		const limited = graph(targets, seeds, 3);
		expect(limited.entries).toHaveLength(4);
		for (const entry of limited.entries)
			for (const call of entry.callOverrides ?? [])
				expect(
					limited.entries.some(
						(target) => target.function === call.target && target.id === call.entryId,
					),
				).toBe(true);
	});

	it("keeps recursive result cycles boxed without an independent proof", () => {
		const result = graph([1, 0], [{ function: 0, parameters: ["f64", "f64"] }]);
		expect(result.entries).toHaveLength(2);
		expect(result.entries.every((entry) => entry.resultRepresentation === "boxed")).toBe(
			true,
		);
		expect(result.entries.every((entry) => entry.callOverrides?.length === 1)).toBe(true);
		expect(result.analysesRun).toBeLessThan(5);
	});

	it("caps a callee at four signatures across distinct typed callers", () => {
		const parameters: Array<ReadonlyArray<CorePlanRepresentation>> = [
			["f64", "f64"],
			["f64", "string"],
			["string", "f64"],
			["boolean", "f64"],
			["f64", "boolean"],
		];
		const result = graph(
			[undefined, 0, 0, 0, 0, 0],
			parameters.map((parameters, index) => ({ function: index + 1, parameters })),
		);
		expect(
			result.entries.filter((entry) => entry.function === result.builders[0]!.functionId),
		).toHaveLength(4);
		expect(
			result.entries.filter(
				(entry) =>
					entry.function !== result.builders[0]!.functionId &&
					entry.callOverrides === undefined,
			),
		).toHaveLength(1);
	});
});
