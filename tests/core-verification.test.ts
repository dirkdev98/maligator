import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { formatCoreFunction } from "../src/compiler/core/core-format.ts";
import {
	CORE_CONTROL_FLOW_ANALYSIS,
	buildCoreControlFlow,
} from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import {
	verifyCoreChangeSet,
	verifyCoreFunction,
	verifyCoreProgram,
} from "../src/compiler/core/core-ir-verifier.ts";
import { CORE_NO_EFFECTS, coreFactId } from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

function validBranchProgram() {
	const program = new CoreProgram(coreOpcodeRegistry);
	const builder = new CoreFunctionBuilder(program);
	const entry = builder.createBlock();
	const consequent = builder.createBlock();
	const alternate = builder.createBlock();
	const [condition] = builder.appendInstruction(entry, "createBoolean", [], {
		attributes: { value: true },
	});
	builder.setTerminator(entry, {
		kind: "branch",
		condition: condition!,
		consequent: { block: consequent, arguments: [] },
		alternate: { block: alternate, arguments: [] },
	});
	builder.setTerminator(consequent, { kind: "return", value: condition! });
	builder.setTerminator(alternate, { kind: "return", value: condition! });
	const finished = builder.finish(entry);
	return {
		program,
		fn: program.function(finished.function),
		entry,
		consequent,
		alternate,
	};
}

describe("Core verification", () => {
	it("verifies store rows, definitions, uses, CFG indexes, and metadata", () => {
		const { program, fn, entry, consequent, alternate } = validBranchProgram();
		expect(() => verifyCoreProgram(program, { stage: "construction" })).not.toThrow();
		const cfg = buildCoreControlFlow(program, fn.id);
		expect(cfg.successors[entry]).toMatchObject([
			{ from: entry, to: consequent, kind: "ordinary" },
			{ from: entry, to: alternate, kind: "ordinary" },
		]);
		expect(cfg.predecessors[consequent]).toHaveLength(1);
		expect(cfg.dominates(entry, consequent)).toBe(true);
		program.seal();
		expect(() => verifyCoreProgram(program, { stage: "pre-target" })).not.toThrow();
	});

	it("rejects an edge whose arguments do not match its block parameters", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const target = builder.createBlock([{ representation: "boxed" }]);
		const parameter = builder.blockParameters(target)[0]!.value;
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: target, arguments: [] },
		});
		builder.setTerminator(target, { kind: "return", value: parameter });
		builder.finish(entry);
		expect(() =>
			verifyCoreProgram(program, { stage: "control-flow", pass: "test-pass" }),
		).toThrow(
			/Core IR verification failed \[stage=control-flow pass=test-pass function=0\]:.*passes 0 values to 1 parameters/,
		);
	});

	it("rejects exceptional flow without an exception entry parameter", () => {
		const { program, fn, entry, consequent } = validBranchProgram();
		const editor = CoreEditor.open(program, fn.id);
		editor.setHandler(entry, consequent);
		editor.commit();
		expect(() => verifyCoreProgram(program)).toThrow(/lacks an exception parameter/);
	});

	it("rejects source positions and proof references outside their program tables", () => {
		const badPosition = new CoreProgram(coreOpcodeRegistry);
		const positionBuilder = new CoreFunctionBuilder(badPosition);
		const positionEntry = positionBuilder.createBlock();
		const [positionValue] = positionBuilder.appendInstruction(
			positionEntry,
			"createUndefined",
			[],
			{ sourcePosition: 4 },
		);
		positionBuilder.setTerminator(positionEntry, {
			kind: "return",
			value: positionValue!,
		});
		positionBuilder.finish(positionEntry);
		expect(() => verifyCoreProgram(badPosition)).toThrow(/invalid source position 4/);

		const badProof = new CoreProgram(coreOpcodeRegistry);
		const proofBuilder = new CoreFunctionBuilder(badProof);
		const proofEntry = proofBuilder.createBlock();
		const [proofValue] = proofBuilder.appendInstruction(
			proofEntry,
			"createUndefined",
			[],
			{
				effectRefinement: { effects: CORE_NO_EFFECTS, proof: coreFactId(99) },
			},
		);
		proofBuilder.setTerminator(proofEntry, { kind: "return", value: proofValue! });
		proofBuilder.finish(proofEntry);
		expect(() => verifyCoreProgram(badProof)).toThrow(/references deleted fact !99/);
	});

	it("separates local verification from cross-function contracts", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [created] = builder.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 99 },
		});
		builder.setTerminator(entry, { kind: "return", value: created! });
		const finished = builder.finish(entry);
		expect(() => verifyCoreFunction(program, finished.function)).not.toThrow();
		expect(() => verifyCoreProgram(program)).toThrow(/references function 99/);
	});

	it("incrementally verifies one change set and keys CFG indexes by relevant versions", () => {
		const { program, fn, entry, consequent, alternate } = validBranchProgram();
		const analyses = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const request = { scope: "function", function: fn.id } as const;
		const first = analyses.get(CORE_CONTROL_FLOW_ANALYSIS, request);
		const representationEditor = CoreEditor.open(program, fn.id);
		const condition = fn.instructionResults([...fn.bodyInstructionIds(entry)][0]!)[0]!;
		representationEditor.setValueRepresentation(condition, "boolean");
		const representationChanges = representationEditor.commit();
		verifyCoreChangeSet(program, representationChanges, { stage: "canonicalize" });
		expect(analyses.get(CORE_CONTROL_FLOW_ANALYSIS, request)).toBe(first);

		const cfgEditor = CoreEditor.open(program, fn.id);
		cfgEditor.removeInstruction(fn.blockTerminator(entry));
		cfgEditor.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: alternate, arguments: [] },
			alternate: { block: consequent, arguments: [] },
		});
		const cfgChanges = cfgEditor.commit();
		verifyCoreChangeSet(program, cfgChanges, { stage: "control-flow" });
		expect(analyses.get(CORE_CONTROL_FLOW_ANALYSIS, request)).not.toBe(first);
	});

	it("formats the store through read-only lookup and iteration", () => {
		const { program, fn } = validBranchProgram();
		const formatted = formatCoreFunction(program, fn.id);
		expect(formatted).toContain("core function 0()");
		expect(formatted).toContain("createBoolean()");
		expect(formatted).toContain("branch %0, b1(), b2()");
	});
});
