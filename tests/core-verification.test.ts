import { describe, expect, it } from "vitest";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { executeCoreOptimizations } from "../src/compiler/core/core-ir-opt.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import { CoreFunctionBuilder, coreValueId } from "../src/compiler/core/core-ir.ts";
import type { CoreFunction, CoreProgram } from "../src/compiler/core/core-ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-execution.ts";
import { coreCompilationForTest } from "./helpers/core-compilation.ts";

/** Source that reaches region selection, so certificates take part in every contract. */
const REGION_SOURCE = `
	function project(value) {
		const fields = value.split(";");
		const total = fields.length + fields.length * 2;
		return fields[1] + total;
	}
	function shape(flag) {
		const point = { x: 1, y: flag ? 2 : 3 };
		return point.x + point.y;
	}
	project("a;b") + shape(true);
`;

function coreProgram(functions: ReadonlyArray<CoreFunction>): CoreProgram {
	return {
		functions,
		stringConstants: [[]],
		bigintConstants: [],
		literalTemplateData: [],
		sourcePositions: [],
		globalCount: 0,
	};
}

function optimizedRegionProgram(): CoreProgram {
	const semantic = analyzeSourceAndRunSemanticAnalysis(REGION_SOURCE, "core-regions.js");
	const lowered = lowerSemanticProgramToCore(semantic);
	return executeCoreOptimizations(lowered.program, { context: lowered.context }).program;
}

/** Program with a return of a value that was never defined. */
function programWithUndefinedUse(): CoreProgram {
	const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
	const entry = builder.createBlock();
	const [defined] = builder.appendInstruction(entry, "createUndefined", []);
	builder.setTerminator(entry, { kind: "return", value: defined! });
	const complete = builder.finish(entry);
	const block = complete.blocks[0]!;
	return coreProgram([
		{
			...complete,
			blocks: [
				{
					...block,
					terminator: { ...block.terminator, kind: "return", value: coreValueId(97) },
				},
			],
		},
	]);
}

/** Program whose certificate claims an instruction that dead-code elimination wants. */
function programWithClaimedDeadInstruction(): CoreProgram {
	const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
	const entry = builder.createBlock();
	const [dead] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 1 },
	});
	const [result] = builder.appendInstruction(entry, "createUndefined", []);
	builder.setTerminator(entry, { kind: "return", value: result! });
	const complete = builder.finish(entry);
	const claimed = complete.blocks[0]!.instructions.find(
		(instruction) => instruction.outputs[0] === dead,
	)!;
	return coreProgram([
		{
			...complete,
			regions: [
				{
					kind: "test-certificate",
					anchors: [claimed.id],
					claimedInstructions: [claimed.id],
					ordinaryBlocks: [entry],
					exceptionalBlocks: [],
					data: {
						producer: { $coreInstruction: claimed.id },
						license: {
							guard: "structural",
							genericTwin: "retained",
							materialization: "none",
							admission: {
								anchor: { $coreInstruction: claimed.id },
								validity: "once",
							},
						},
					},
				},
			],
		},
	]);
}

/** Identity-preserving structural projection of the contracts Core owns. */
function structuralProgram(program: CoreProgram) {
	return {
		stringConstants: program.stringConstants.map((units) => [...units]),
		globalCount: program.globalCount,
		functions: program.functions.map((fn) => ({
			functionIndex: fn.functionIndex,
			entry: fn.entry,
			bodyEntry: fn.bodyEntry,
			parameters: [...fn.parameters],
			values: fn.values.map(({ id, representation }) => ({ id, representation })),
			facts: fn.facts.map(({ id, kind, validity }) => ({ id, kind, validity })),
			regions: fn.regions.map((region) => ({
				kind: region.kind,
				anchors: [...region.anchors],
				claimedInstructions: [...region.claimedInstructions],
				ordinaryBlocks: [...region.ordinaryBlocks],
				exceptionalBlocks: [...region.exceptionalBlocks],
				data: region.data,
			})),
			blocks: fn.blocks.map((block) => ({
				id: block.id,
				parameters: block.parameters,
				handler: block.handler,
				instructions: block.instructions.map(
					({ id, opcode, inputs, outputs, attributes }) => ({
						id,
						opcode,
						inputs,
						outputs,
						attributes,
					}),
				),
				terminator: block.terminator,
			})),
		})),
	};
}

describe("Core verification boundaries", () => {
	it("rejects an invalid program before optimization runs", () => {
		expect(() => executeCoreOptimizations(programWithUndefinedUse())).toThrow(
			/Core IR verification failed \[stage=pre-optimization function=0\]: terminator @\d+ uses unknown value 97/,
		);
	});

	it("verifies the whole program before target lowering", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(REGION_SOURCE, "pre-target.js");
		const lowered = lowerSemanticProgramToCore(semantic);
		const optimized = executeCoreOptimizations(lowered.program, {
			context: lowered.context,
		}).program;
		const broken: CoreProgram = {
			...optimized,
			functions: optimized.functions.with(0, {
				...optimized.functions[0]!,
				metadata: {
					...optimized.functions[0]!.metadata,
					nameStringIndex: optimized.stringConstants.length,
				},
			}),
		};

		expect(() => compileSemanticProgramToProgramImage(semantic)).not.toThrow();
		expect(() => lowerCoreCompilationToExecution(coreCompilationForTest(broken))).toThrow(
			/Core IR verification failed \[stage=pre-target\]: function 0 has unknown name string/,
		);
	});

	it("names the responsible pass when development verification sees a claimed-instruction mutation", () => {
		const claimed = programWithClaimedDeadInstruction();
		const claimedInstruction = claimed.functions[0]!.regions[0]!.claimedInstructions[0]!;

		expect(() => executeCoreOptimizations(claimed, { verification: "per-pass" })).toThrow(
			/Core IR verification failed \[stage=fixpoint pass=dead-instruction-elimination round=0 function=0\]: pass deleted instruction @\d+ claimed by region test-certificate/,
		);

		const released = executeCoreOptimizations(claimed).program.functions[0]!;
		expect(released.blocks[0]!.instructions.map(({ id }) => id)).toContain(
			claimedInstruction,
		);
	});

	it("optimizes real source under per-pass verification through the product pipeline", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			REGION_SOURCE,
			"per-pass-pipeline.js",
		);

		expect(() =>
			compileSemanticProgramToProgramImage(semantic, {
				optimization: "development",
				coreVerification: "per-pass",
			}),
		).not.toThrow();
	});

	it("keeps per-pass verification satisfied across composed control flow and passes", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`
				class Counter {
					#count = 0;
					step(by) { this.#count += by; return this.#count; }
				}
				function* walk(items) { for (const item of items) yield item.length; }
				async function collect(items) {
					let total = 0;
					for (const size of walk(items)) total += size;
					try {
						const [head, ...rest] = items;
						total += head.slice(0, 1).charCodeAt(0) + rest.length;
					} catch (error) {
						total += String(error).length;
					}
					return await Promise.resolve(total);
				}
				const counter = new Counter();
				const parts = "a;bb;ccc".split(";");
				let sum = 0;
				for (let index = 0; index < parts.length; index++) {
					sum += counter.step(parts[index].length);
				}
				collect(parts).then((total) => sum + total);
			`,
			"per-pass-composition.js",
		);

		expect(() =>
			compileSemanticProgramToProgramImage(semantic, { coreVerification: "per-pass" }),
		).not.toThrow();
	});

	it("produces a valid program with selected regions after final region selection", () => {
		const optimized = optimizedRegionProgram();
		const regions = optimized.functions.flatMap(({ regions: selected }) => selected);

		expect(regions.length).toBeGreaterThan(0);
		expect(() =>
			verifyCoreProgram(optimized, coreOpcodeRegistry, {
				stage: "final-region-selection",
			}),
		).not.toThrow();
	});

	it("optimizes equivalent fresh inputs into structurally identical Core with stable ids", () => {
		const first = optimizedRegionProgram();
		const second = optimizedRegionProgram();

		expect(structuralProgram(second)).toEqual(structuralProgram(first));
	});

	it("reaches a structural fixpoint without duplicating or mutating finalized regions", () => {
		const first = optimizedRegionProgram();
		const second = executeCoreOptimizations(first).program;

		expect(first.functions.flatMap(({ regions }) => regions).length).toBeGreaterThan(0);
		expect(structuralProgram(second)).toEqual(structuralProgram(first));
		expect(
			second.functions.map(({ regions }) => regions.map(({ kind }) => kind)),
		).toEqual(first.functions.map(({ regions }) => regions.map(({ kind }) => kind)));
		expect(() => verifyCoreProgram(second, coreOpcodeRegistry)).not.toThrow();
	});
});
