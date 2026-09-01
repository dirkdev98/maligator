import { effectSummariesEqual } from "../shared/effect-summary.ts";
import { CoreEditor } from "./core-editor.ts";
import { coreTerminatorEdges } from "./core-ir-control-flow.ts";
import {
	CORE_FACT_AVAILABILITY_ANALYSIS,
	coreFactImplies,
	normalizeCoreFact,
} from "./core-ir-fact-implication.ts";
import {
	CORE_CONTAINED_AGGREGATE_OWN_SLOT_FACT,
	CORE_OWN_DATA_CELL_FACT,
} from "./core-ir-provenance.ts";
import { CORE_EXACT_SHAPE_OWN_SLOT_EFFECT_FACT } from "./core-ir-shape-provenance.ts";
import { CORE_CALL_EFFECT_SUMMARY_FACT } from "./core-ir-summaries.ts";
import { CORE_EXACT_COLLECTION_BUILTIN_EFFECT_FACT } from "./core-ir-value-classes.ts";
import {
	CORE_LOCAL_VALUE_KIND_ANALYSIS,
	CORE_PRIMITIVE_OPERATOR_EFFECT_FACT,
	corePrimitiveOperatorEffectRefinement,
} from "./core-ir-value-kinds.ts";
import type { CoreExactScalarKind } from "./core-ir-value-kinds.ts";
import type {
	CoreBlockId,
	CoreEdge,
	CoreFact,
	CoreFactId,
	CoreInstructionId,
	CoreRepresentation,
	CoreValueId,
} from "./core-ir.ts";
import type { CorePass, CorePassBudget } from "./core-pass.ts";
import type { CoreFunctionStore } from "./core-store.ts";

const PROOF_BUDGET: CorePassBudget = Object.freeze({
	maxWorkItems: 2_000_000,
	maxEdits: 1_000_000,
	exhaustion: "stop",
});

const CORE_REPROVED_FACT_KINDS: ReadonlySet<string> = new Set([
	CORE_CONTAINED_AGGREGATE_OWN_SLOT_FACT,
	CORE_OWN_DATA_CELL_FACT,
	CORE_CALL_EFFECT_SUMMARY_FACT,
	CORE_PRIMITIVE_OPERATOR_EFFECT_FACT,
	CORE_EXACT_SHAPE_OWN_SLOT_EFFECT_FACT,
	CORE_EXACT_COLLECTION_BUILTIN_EFFECT_FACT,
]);

function factValidityRank(fact: CoreFact): number {
	switch (fact.validity.kind) {
		case "world":
			return 0;
		case "summary":
			return 1;
		case "guard":
			return 2;
		case "epoch":
			return 3;
		case "asserted":
			return 4;
	}
}

function preferFact(candidate: CoreFact, incumbent: CoreFact): boolean {
	const stronger = coreFactImplies(candidate, incumbent);
	const weaker = coreFactImplies(incumbent, candidate);
	if (stronger !== weaker) return stronger;
	const validity = factValidityRank(candidate) - factValidityRank(incumbent);
	if (validity !== 0) return validity < 0;
	const obligations = candidate.obligations.length - incumbent.obligations.length;
	return obligations !== 0 ? obligations < 0 : candidate.id < incumbent.id;
}

function factIsReferenced(fn: CoreFunctionStore, fact: CoreFactId): boolean {
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) === "guard") {
			const payload = fn.terminatorPayload(instruction);
			if (payload.kind === "guard" && payload.fact === fact) return true;
		} else if (fn.instructionEffectRefinement(instruction)?.proof === fact) {
			return true;
		}
	}
	return false;
}

const canonicalizeFacts: CorePass = {
	name: "canonicalize-fact-claims",
	stage: "proofs",
	scope: "function",
	requiredAnalyses: [],
	wakesOn: ["facts", "body"],
	preserves: ["control-flow", "exception-control-flow"],
	changes: { cfg: false, calls: false, facts: true, representations: false },
	budget: PROOF_BUDGET,
	run({ program, item }) {
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const replacements = [...fn.factIds()].flatMap((fact) => {
			const current = fn.fact(fact);
			const normalized = normalizeCoreFact(current);
			return normalized === current ? [] : [{ fact, normalized }];
		});
		if (replacements.length === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const { fact, normalized } of replacements) {
			const { id: _id, ...input } = normalized;
			editor.replaceFact(fact, input);
		}
		return editor.commit();
	},
};

const removeEmptyUnreferencedFacts: CorePass = {
	name: "empty-fact-elimination",
	stage: "proofs",
	scope: "function",
	requiredAnalyses: [],
	wakesOn: ["facts", "body"],
	preserves: ["control-flow", "exception-control-flow"],
	changes: { cfg: false, calls: false, facts: true, representations: false },
	budget: PROOF_BUDGET,
	run({ program, item }) {
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const removable = [...fn.factIds()].filter((fact) => {
			const value = fn.fact(fact);
			return (
				value.validity.kind === "summary" &&
				value.claims.length === 0 &&
				value.obligations.length === 0 &&
				!factIsReferenced(fn, fact)
			);
		});
		if (removable.length === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const fact of removable) editor.removeFact(fact);
		return editor.commit();
	},
};

const rewireSubsumedEffectProofs: CorePass = {
	name: "rewire-subsumed-effect-proofs",
	stage: "proofs",
	scope: "function",
	requiredAnalyses: [CORE_FACT_AVAILABILITY_ANALYSIS],
	wakesOn: ["facts", "body", "cfg", "memoryEffects"],
	preserves: ["control-flow", "exception-control-flow"],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: PROOF_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const availability = context.analysis(CORE_FACT_AVAILABILITY_ANALYSIS);
		const rewrites = new Map<CoreInstructionId, CoreFactId>();
		const replacements = new Map<CoreFactId, CoreFactId>();
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const refinement = fn.instructionEffectRefinement(instruction);
			if (refinement === undefined) continue;
			const weak = fn.fact(refinement.proof);
			if (CORE_REPROVED_FACT_KINDS.has(weak.kind)) continue;
			let best: CoreFact | undefined;
			for (const candidateId of availability.availableAtInstruction(instruction)) {
				if (candidateId === weak.id) continue;
				const candidate = fn.fact(candidateId);
				if (
					CORE_REPROVED_FACT_KINDS.has(candidate.kind) ||
					!coreFactImplies(candidate, weak) ||
					!preferFact(candidate, weak)
				)
					continue;
				if (best === undefined || preferFact(candidate, best)) best = candidate;
			}
			if (best === undefined) continue;
			rewrites.set(instruction, best.id);
			replacements.set(weak.id, best.id);
		}
		if (rewrites.size === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const [instruction, proof] of rewrites) {
			const refinement = fn.instructionEffectRefinement(instruction)!;
			editor.setInstructionEffectRefinement(instruction, {
				...refinement,
				proof,
			});
		}
		for (const [fact, replacement] of replacements) {
			const weak = fn.fact(fact);
			const strong = fn.fact(replacement);
			if (
				!factIsReferenced(fn, fact) &&
				(weak.validity.kind === "world" || weak.validity.kind === "summary") &&
				(strong.validity.kind === "world" || strong.validity.kind === "summary")
			) {
				editor.removeFact(fact);
			}
		}
		return editor.commit();
	},
};

const foldSubsumedGuards: CorePass = {
	name: "fold-subsumed-guards",
	stage: "proofs",
	scope: "function",
	requiredAnalyses: [CORE_FACT_AVAILABILITY_ANALYSIS],
	wakesOn: ["facts", "body", "cfg"],
	preserves: [],
	changes: { cfg: true, calls: false, facts: true, representations: false },
	budget: PROOF_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		if ([...fn.factIds()].length < 2) return undefined;
		const availability = context.analysis(CORE_FACT_AVAILABILITY_ANALYSIS);
		const refinementUses = new Set<CoreFactId>();
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const proof = fn.instructionEffectRefinement(instruction)?.proof;
			if (proof !== undefined) refinementUses.add(proof);
		}
		const guardFactCounts = new Map<CoreInstructionId, number>();
		for (const factId of fn.factIds()) {
			const fact = fn.fact(factId);
			for (const instruction of new Set([
				...(fact.validity.kind === "guard" ? [fact.validity.instruction] : []),
				...fact.obligations.flatMap((obligation) =>
					obligation.kind === "guard" ? [obligation.instruction] : [],
				),
			])) {
				guardFactCounts.set(instruction, (guardFactCounts.get(instruction) ?? 0) + 1);
			}
		}
		const removed = new Set<CoreFactId>();
		const folds: Array<{
			readonly block: CoreBlockId;
			readonly fact: CoreFactId;
			readonly success: CoreEdge;
		}> = [];
		for (const block of fn.blockIds()) {
			const instruction = fn.blockTerminator(block);
			const payload = fn.terminatorPayload(instruction);
			if (payload.kind !== "guard") continue;
			const weak = fn.fact(payload.fact);
			if (
				weak.obligations.some(({ kind }) => kind !== "guard") ||
				refinementUses.has(weak.id) ||
				(guardFactCounts.get(instruction) ?? 0) > 1
			)
				continue;
			let best: CoreFact | undefined;
			for (const candidateId of availability.availableAtInstruction(instruction)) {
				if (candidateId === weak.id || removed.has(candidateId)) continue;
				const candidate = fn.fact(candidateId);
				if (!coreFactImplies(candidate, weak)) continue;
				if (best === undefined || preferFact(candidate, best)) best = candidate;
			}
			if (best === undefined) continue;
			removed.add(weak.id);
			folds.push({ block, fact: weak.id, success: payload.success });
		}
		if (folds.length === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const fold of folds) {
			editor.replaceTerminator(fold.block, {
				kind: "jump",
				edge: fold.success,
			});
		}
		for (const { fact } of folds) editor.removeFact(fact);
		return editor.commit();
	},
};

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
		if (
			!fn.isInstructionLive(item.instruction) ||
			fn.instructionKind(item.instruction) !== "operation"
		)
			return undefined;
		const opcode = fn.instructionOpcodeName(item.instruction);
		if (opcode !== "unary" && opcode !== "binary") return undefined;
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const masks = fn
			.instructionOperands(item.instruction)
			.map((value) => kinds.kindMask(value));
		const effects = corePrimitiveOperatorEffectRefinement(fn, item.instruction, masks);
		const baseline = fn.registry.byId(fn.instructionOpcode(item.instruction)).effects;
		const existing = fn.instructionEffectRefinement(item.instruction);
		if (effects === undefined || effectSummariesEqual(effects, baseline)) {
			if (
				existing === undefined ||
				fn.fact(existing.proof).kind !== CORE_PRIMITIVE_OPERATOR_EFFECT_FACT
			)
				return undefined;
			const editor = CoreEditor.open(program, item.function);
			editor.replaceInstruction(
				item.instruction,
				opcode,
				fn.instructionOperands(item.instruction),
				{
					attributes: fn.instructionAttributes(item.instruction),
					sourcePosition: fn.instructionSourcePosition(item.instruction),
				},
			);
			editor.removeFact(existing.proof);
			return editor.commit();
		}
		if (existing !== undefined) {
			const fact = fn.fact(existing.proof);
			if (fact.kind !== CORE_PRIMITIVE_OPERATOR_EFFECT_FACT) return undefined;
			const digest = `primitive-operator:${opcode}:${masks.join(",")}`;
			if (
				fact.validity.kind === "summary" &&
				fact.validity.digest === digest &&
				effectSummariesEqual(existing.effects, effects)
			)
				return undefined;
			const editor = CoreEditor.open(program, item.function);
			editor.replaceFact(existing.proof, {
				kind: CORE_PRIMITIVE_OPERATOR_EFFECT_FACT,
				value: Object.freeze([...masks]),
				claims: [{ kind: "effect", instruction: item.instruction, effects }],
				validity: { kind: "summary", digest },
				obligations: [],
				origin: "local-value-kind-analysis",
			});
			editor.setInstructionEffectRefinement(item.instruction, {
				effects,
				proof: existing.proof,
			});
			return editor.commit();
		}
		const editor = CoreEditor.open(program, item.function);
		const proof = editor.addFact({
			kind: CORE_PRIMITIVE_OPERATOR_EFFECT_FACT,
			value: Object.freeze([...masks]),
			claims: [{ kind: "effect", instruction: item.instruction, effects }],
			validity: {
				kind: "summary",
				digest: `primitive-operator:${opcode}:${masks.join(",")}`,
			},
			obligations: [],
			origin: "local-value-kind-analysis",
		});
		editor.setInstructionEffectRefinement(item.instruction, { effects, proof });
		return editor.commit();
	},
};

function scalarRepresentation(kind: CoreExactScalarKind): CoreRepresentation {
	switch (kind) {
		case "int32":
			return "i32";
		case "number":
			return "f64";
		case "boolean":
			return "boolean";
		case "string":
			return "string";
	}
}

const SCALAR_PRODUCERS: ReadonlySet<string> = new Set([
	"createNumber",
	"createF64",
	"createBoolean",
	"createString",
	"move",
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
		for (const edge of coreTerminatorEdges(
			fn.terminatorPayload(fn.blockTerminator(block)),
		)) {
			if (edge.arguments.includes(value)) return true;
		}
	}
	return false;
}

function scalarConsumersOnly(fn: CoreFunctionStore, value: CoreValueId): boolean {
	for (const { instruction } of fn.uses(value)) {
		if (
			fn.instructionKind(instruction) === "operation" &&
			!SCALAR_CONSUMERS.has(fn.instructionOpcodeName(instruction))
		)
			return false;
	}
	return !appearsOnEdge(fn, value);
}

function scalarProducerInputsSupportRepresentation(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	representation: CoreRepresentation,
	componentValues?: ReadonlySet<CoreValueId>,
): boolean {
	const opcode = fn.instructionOpcodeName(instruction);
	const operands = fn.instructionOperands(instruction);
	const belongsToComponent = (value: CoreValueId): boolean =>
		componentValues?.has(value) === true;
	if (opcode === "move") {
		const source = operands[0];
		return (
			source !== undefined &&
			(fn.valueRepresentation(source) === representation || belongsToComponent(source))
		);
	}
	if (
		(opcode === "unary" || opcode === "binary") &&
		(representation === "i32" || representation === "f64")
	) {
		return operands.every((operand) => {
			const operandRepresentation = fn.valueRepresentation(operand);
			return (
				operandRepresentation === "i32" ||
				operandRepresentation === "f64" ||
				belongsToComponent(operand)
			);
		});
	}
	return true;
}

function scalarCandidate(
	fn: CoreFunctionStore,
	value: CoreValueId,
	kind: CoreExactScalarKind | undefined,
): CoreRepresentation | undefined {
	if (kind === undefined || fn.valueRepresentation(value) !== "boxed") return undefined;
	const representation = scalarRepresentation(kind);
	const definition = fn.valueDefinition(value);
	if (
		definition.kind !== "instruction" ||
		!SCALAR_PRODUCERS.has(fn.instructionOpcodeName(definition.instruction)) ||
		!scalarConsumersOnly(fn, value)
	)
		return undefined;
	if (
		!scalarProducerInputsSupportRepresentation(fn, definition.instruction, representation)
	)
		return undefined;
	return representation;
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
		const candidates: Array<{
			readonly value: CoreValueId;
			readonly representation: CoreRepresentation;
		}> = [];
		for (let index = 0; index < fn.valueCapacity; index++) {
			const value = index as CoreValueId;
			if (!fn.isValueLive(value)) continue;
			const representation = scalarCandidate(fn, value, kinds.exactScalar(value));
			if (representation !== undefined) candidates.push({ value, representation });
		}
		if (candidates.length === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const { value, representation } of candidates)
			editor.setValueRepresentation(value, representation);
		return editor.commit();
	},
};

function flowScalarRepresentation(
	kinds: ReadonlyArray<CoreExactScalarKind>,
): CoreRepresentation | undefined {
	if (kinds.every((kind) => kind === "int32")) return "i32";
	if (kinds.every((kind) => kind === "int32" || kind === "number")) return "f64";
	if (kinds.every((kind) => kind === "boolean")) return "boolean";
	if (kinds.every((kind) => kind === "string")) return "string";
	return undefined;
}

const materializeFlowScalars: CorePass = {
	name: "flow-scalar-representation-selection",
	stage: "proofs",
	scope: "function",
	requiredAnalyses: [CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "cfg", "facts", "representations"],
	preserves: ["control-flow", "exception-control-flow"],
	changes: { cfg: false, calls: false, facts: false, representations: true },
	budget: PROOF_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const neighbors = new Map<CoreValueId, Set<CoreValueId>>();
		const connect = (left: CoreValueId, right: CoreValueId): void => {
			const leftNeighbors = neighbors.get(left) ?? new Set<CoreValueId>();
			const rightNeighbors = neighbors.get(right) ?? new Set<CoreValueId>();
			leftNeighbors.add(right);
			rightNeighbors.add(left);
			neighbors.set(left, leftNeighbors);
			neighbors.set(right, rightNeighbors);
		};
		for (const block of fn.blockIds()) {
			for (const edge of coreTerminatorEdges(
				fn.terminatorPayload(fn.blockTerminator(block)),
			)) {
				for (const [index, argument] of edge.arguments.entries()) {
					const parameter = fn.blockParameters(edge.block)[index];
					if (parameter !== undefined) connect(argument, parameter.value);
				}
			}
			const handler = fn.blockHandler(block);
			if (handler !== undefined) {
				const parameters = fn.blockParameters(handler.block).slice(1);
				for (const [index, argument] of handler.arguments.entries()) {
					const parameter = parameters[index];
					if (parameter !== undefined) connect(argument, parameter.value);
				}
			}
			for (const instruction of fn.bodyInstructionIds(block)) {
				if (!SCALAR_CONSUMERS.has(fn.instructionOpcodeName(instruction))) continue;
				const byFamily = new Map<string, Array<CoreValueId>>();
				for (const value of [
					...fn.instructionOperands(instruction),
					...fn.instructionResults(instruction),
				]) {
					const scalar = kinds.exactScalar(value);
					if (scalar === undefined) continue;
					const family = scalar === "int32" || scalar === "number" ? "number" : scalar;
					const values = byFamily.get(family) ?? [];
					values.push(value);
					byFamily.set(family, values);
				}
				for (const values of byFamily.values()) {
					for (let index = 1; index < values.length; index++) {
						connect(values[0]!, values[index]!);
					}
				}
			}
		}
		const visited = new Set<CoreValueId>();
		for (const seed of neighbors.keys()) {
			if (visited.has(seed)) continue;
			const component: Array<CoreValueId> = [];
			const pending = [seed];
			while (pending.length > 0) {
				const value = pending.pop()!;
				if (visited.has(value)) continue;
				visited.add(value);
				component.push(value);
				pending.push(...(neighbors.get(value) ?? []));
			}
			const exact = component.map((value) => kinds.exactScalar(value));
			if (exact.some((kind) => kind === undefined)) continue;
			const representation = flowScalarRepresentation(
				exact as ReadonlyArray<CoreExactScalarKind>,
			);
			if (representation === undefined) continue;
			const componentValues = new Set(component);
			const rejected = component.some((value) => {
				const definition = fn.valueDefinition(value);
				if (
					definition.kind === "instruction" &&
					!SCALAR_PRODUCERS.has(fn.instructionOpcodeName(definition.instruction))
				)
					return true;
				if (
					definition.kind === "instruction" &&
					!scalarProducerInputsSupportRepresentation(
						fn,
						definition.instruction,
						representation,
						componentValues,
					)
				)
					return true;
				for (const { instruction } of fn.uses(value)) {
					if (
						fn.instructionKind(instruction) === "operation" &&
						!SCALAR_CONSUMERS.has(fn.instructionOpcodeName(instruction))
					)
						return true;
				}
				return false;
			});
			if (rejected) continue;
			const candidates = component.filter(
				(value) => fn.valueRepresentation(value) === "boxed",
			);
			if (candidates.length === 0) continue;
			const editor = CoreEditor.open(program, item.function);
			for (const value of candidates)
				editor.setValueRepresentation(value, representation);
			return editor.commit();
		}
		return undefined;
	},
};

export const CORE_PROOF_PASSES: ReadonlyArray<CorePass> = [
	canonicalizeFacts,
	removeEmptyUnreferencedFacts,
	refinePrimitiveEffects,
	rewireSubsumedEffectProofs,
	foldSubsumedGuards,
	materializeLocalScalars,
	materializeFlowScalars,
];
