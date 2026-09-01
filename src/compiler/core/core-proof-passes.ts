import { effectSummariesEqual } from "../shared/effect-summary.ts";
import { CoreEditor } from "./core-editor.ts";
import { coreTerminatorEdges } from "./core-ir-control-flow.ts";
import type {  CoreRepresentation, CoreValueId } from "./core-ir.ts";
import {
	CORE_LOCAL_VALUE_KIND_ANALYSIS,
	CORE_PRIMITIVE_OPERATOR_EFFECT_FACT,
	corePrimitiveOperatorEffectRefinement,
} from "./core-ir-value-kinds.ts";
import type { CoreExactScalarKind } from "./core-ir-value-kinds.ts";
import type { CorePass, CorePassBudget } from "./core-pass.ts";
import type { CoreFunctionStore } from "./core-store.ts";

const PROOF_BUDGET: CorePassBudget = Object.freeze({
	maxWorkItems: 2_000_000,
	maxEdits: 1_000_000,
	exhaustion: "stop",
});

const refinePrimitiveEffects: CorePass = {
	name: "primitive-effect-refinement",
	stage: "proofs",
	scope: "instruction",
	requiredAnalyses: [CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "facts", "representations"],
	preserves: [],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: PROOF_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "instruction") return undefined;
		const fn = program.function(item.function);
		if (!fn.isInstructionLive(item.instruction) ||
			fn.instructionKind(item.instruction) !== "operation" ||
			fn.instructionEffectRefinement(item.instruction) !== undefined) return undefined;
		const opcode = fn.instructionOpcodeName(item.instruction);
		if (opcode !== "unary" && opcode !== "binary") return undefined;
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const masks = fn.instructionOperands(item.instruction).map((value) => kinds.kindMask(value));
		const effects = corePrimitiveOperatorEffectRefinement(fn, item.instruction, masks);
		if (effects === undefined) return undefined;
		const baseline = fn.registry.byId(fn.instructionOpcode(item.instruction)).effects;
		if (effectSummariesEqual(effects, baseline)) return undefined;
		const editor = CoreEditor.open(program, item.function);
		const proof = editor.addFact({
			kind: CORE_PRIMITIVE_OPERATOR_EFFECT_FACT,
			value: Object.freeze([...masks]),
			claims: [{ kind: "effect", instruction: item.instruction, effects }],
			validity: { kind: "asserted", source: "local-value-kind-analysis" },
			obligations: [],
			origin: "local-value-kind-analysis",
		});
		editor.setInstructionEffectRefinement(item.instruction, { effects, proof });
		return editor.commit();
	},
};

function scalarRepresentation(kind: CoreExactScalarKind): CoreRepresentation {
	switch (kind) {
		case "int32": return "i32";
		case "number": return "f64";
		case "boolean": return "boolean";
		case "string": return "string";
	}
}

const SCALAR_PRODUCERS: ReadonlySet<string> = new Set([
	"createNumber",
	"createF64",
	"createBoolean",
	"createString",
	"unary",
	"binary",
	"typeofCompare",
]);

const SCALAR_CONSUMERS: ReadonlySet<string> = new Set([
	"move",
	"unary",
	"binary",
	"typeofCompare",
	"rootUse",
]);

function appearsOnEdge(fn: CoreFunctionStore, value: CoreValueId): boolean {
	for (const block of fn.blockIds()) {
		if (fn.blockHandler(block)?.arguments.includes(value) === true) return true;
		for (const edge of coreTerminatorEdges(fn.terminatorPayload(fn.blockTerminator(block)))) {
			if (edge.arguments.includes(value)) return true;
		}
	}
	return false;
}

function scalarConsumersOnly(fn: CoreFunctionStore, value: CoreValueId): boolean {
	for (const { instruction } of fn.uses(value)) {
		if (fn.instructionKind(instruction) === "operation" &&
			!SCALAR_CONSUMERS.has(fn.instructionOpcodeName(instruction))) return false;
	}
	return !appearsOnEdge(fn, value);
}

function scalarCandidate(
	fn: CoreFunctionStore,
	value: CoreValueId,
	kind: CoreExactScalarKind | undefined,
): CoreRepresentation | undefined {
	if (kind === undefined || fn.valueRepresentation(value) !== "boxed") return undefined;
	const definition = fn.valueDefinition(value);
	if (definition.kind !== "instruction" ||
		!SCALAR_PRODUCERS.has(fn.instructionOpcodeName(definition.instruction)) ||
		!scalarConsumersOnly(fn, value)) return undefined;
	return scalarRepresentation(kind);
}

const materializeLocalScalars: CorePass = {
	name: "local-scalar-representation-selection",
	stage: "proofs",
	scope: "function",
	requiredAnalyses: [CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "facts", "representations"],
	preserves: ["control-flow", "exception-control-flow"],
	changes: { cfg: false, calls: false, facts: false, representations: true },
	budget: PROOF_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const candidates: Array<{ readonly value: CoreValueId; readonly representation: CoreRepresentation }> = [];
		for (let index = 0; index < fn.valueCapacity; index++) {
			const value = index as CoreValueId;
			if (!fn.isValueLive(value)) continue;
			const representation = scalarCandidate(fn, value, kinds.exactScalar(value));
			if (representation !== undefined) candidates.push({ value, representation });
		}
		if (candidates.length === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const { value, representation } of candidates) editor.setValueRepresentation(value, representation);
		return editor.commit();
	},
};

export const CORE_PROOF_PASSES: ReadonlyArray<CorePass> = [
	refinePrimitiveEffects,
	materializeLocalScalars,
];
