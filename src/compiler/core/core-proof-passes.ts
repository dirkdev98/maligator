import { effectSummariesEqual } from "../shared/effect-summary.ts";
import { CoreEditor } from "./core-editor.ts";
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
import { coreBlockId, coreInstructionId, coreValueId } from "./core-ir.ts";
import type { CoreFunctionPass, CorePassBudget } from "./core-pass.ts";
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

function materializeInstructionOperands(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): Array<CoreValueId> {
	const start = fn.kernel.instructionOperandStart(instruction);
	const count = fn.kernel.instructionOperandCount(instruction);
	const operands: Array<CoreValueId> = [];
	for (let index = 0; index < count; index++)
		operands.push(fn.kernel.operandAt(start + index));
	return operands;
}

function materializeTerminatorEdge(fn: CoreFunctionStore, edge: number): CoreEdge {
	const start = fn.kernel.terminatorEdgeArgumentStart(edge);
	const count = fn.kernel.terminatorEdgeArgumentCount(edge);
	const arguments_: Array<CoreValueId> = [];
	for (let index = 0; index < count; index++)
		arguments_.push(fn.kernel.operandAt(start + index));
	return { block: fn.kernel.terminatorEdgeBlock(edge), arguments: arguments_ };
}

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
			if (fn.kernel.terminatorFact(instruction) === fact) return true;
		} else if (fn.instructionEffectRefinement(instruction)?.proof === fact) {
			return true;
		}
	}
	return false;
}

function hasEffectProofRewiringOpportunity(fn: CoreFunctionStore): boolean {
	let facts = 0;
	for (const _fact of fn.factIds()) {
		facts++;
		if (facts === 2) break;
	}
	if (facts < 2) return false;
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const proof = fn.instructionEffectRefinement(instruction)?.proof;
		if (proof !== undefined && !CORE_REPROVED_FACT_KINDS.has(fn.fact(proof).kind)) {
			return true;
		}
	}
	return false;
}

function hasGuardSubsumptionOpportunity(fn: CoreFunctionStore): boolean {
	let facts = 0;
	for (const _fact of fn.factIds()) {
		facts++;
		if (facts === 2) break;
	}
	if (facts < 2) return false;
	for (const block of fn.blockIds()) {
		if (fn.instructionKind(fn.blockTerminator(block)) === "guard") return true;
	}
	return false;
}

const canonicalizeFacts: CoreFunctionPass = {
	name: "canonicalize-fact-claims",
	stage: "proofs",
	requiredAnalyses: [],
	wakesOn: ["facts", "body"],
	changes: { cfg: false, calls: false, facts: true, representations: false },
	budget: PROOF_BUDGET,
	run({ program, item }) {
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

const removeEmptyUnreferencedFacts: CoreFunctionPass = {
	name: "empty-fact-elimination",
	stage: "proofs",
	requiredAnalyses: [],
	wakesOn: ["facts", "body"],
	changes: { cfg: false, calls: false, facts: true, representations: false },
	budget: PROOF_BUDGET,
	run({ program, item }) {
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

const rewireSubsumedEffectProofs: CoreFunctionPass = {
	name: "rewire-subsumed-effect-proofs",
	stage: "proofs",
	admission: {
		predicate: "non-reproved effect refinement with another available fact candidate",
		hasOpportunity({ program, function: functionId }) {
			return hasEffectProofRewiringOpportunity(program.function(functionId));
		},
	},
	requiredAnalyses: [CORE_FACT_AVAILABILITY_ANALYSIS],
	wakesOn: ["facts", "body", "cfg", "memoryEffects"],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: PROOF_BUDGET,
	run(context) {
		const { program, item } = context;
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

const foldSubsumedGuards: CoreFunctionPass = {
	name: "fold-subsumed-guards",
	stage: "proofs",
	admission: {
		predicate: "guard with at least one alternative fact candidate",
		hasOpportunity({ program, function: functionId }) {
			return hasGuardSubsumptionOpportunity(program.function(functionId));
		},
	},
	requiredAnalyses: [CORE_FACT_AVAILABILITY_ANALYSIS],
	wakesOn: ["facts", "body", "cfg"],
	changes: { cfg: true, calls: false, facts: true, representations: false },
	budget: PROOF_BUDGET,
	run(context) {
		const { program, item } = context;
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
			if (fn.instructionKind(instruction) !== "guard") continue;
			const guardFact = fn.kernel.terminatorFact(instruction);
			if (guardFact === undefined) continue;
			const weak = fn.fact(guardFact);
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
			folds.push({
				block,
				fact: weak.id,
				success: materializeTerminatorEdge(
					fn,
					fn.kernel.terminatorEdgeStart(instruction),
				),
			});
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

const refinePrimitiveEffects: CoreFunctionPass = {
	name: "primitive-effect-refinement",
	stage: "proofs",
	requiredAnalyses: [CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "facts", "representations"],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: PROOF_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		let editor: CoreEditor | undefined;
		const instructionCapacity = fn.instructionCapacity;
		for (let id = 0; id < instructionCapacity; id++) {
			const instruction = coreInstructionId(id);
			if (
				!fn.isInstructionLive(instruction) ||
				fn.instructionKind(instruction) !== "operation"
			)
				continue;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode !== "unary" && opcode !== "binary") continue;
			const operandStart = fn.kernel.instructionOperandStart(instruction);
			const operandCount = fn.kernel.instructionOperandCount(instruction);
			const masks: Array<number> = [];
			for (let index = 0; index < operandCount; index++)
				masks.push(kinds.kindMask(fn.kernel.operandAt(operandStart + index)));
			const effects = corePrimitiveOperatorEffectRefinement(fn, instruction, masks);
			const baseline = fn.registry.byId(fn.instructionOpcode(instruction)).effects;
			const existing = fn.instructionEffectRefinement(instruction);
			if (effects === undefined || effectSummariesEqual(effects, baseline)) {
				if (
					existing === undefined ||
					fn.fact(existing.proof).kind !== CORE_PRIMITIVE_OPERATOR_EFFECT_FACT
				)
					continue;
				editor ??= CoreEditor.open(program, item.function);
				editor.replaceInstruction(
					instruction,
					opcode,
					materializeInstructionOperands(fn, instruction),
					{
						attributes: fn.instructionAttributes(instruction),
						sourcePosition: fn.instructionSourcePosition(instruction),
					},
				);
				editor.removeFact(existing.proof);
				continue;
			}
			const digest = `primitive-operator:${opcode}:${masks.join(",")}`;
			if (existing !== undefined) {
				const fact = fn.fact(existing.proof);
				if (fact.kind !== CORE_PRIMITIVE_OPERATOR_EFFECT_FACT) continue;
				if (
					fact.validity.kind === "summary" &&
					fact.validity.digest === digest &&
					effectSummariesEqual(existing.effects, effects)
				)
					continue;
				editor ??= CoreEditor.open(program, item.function);
				editor.replaceFact(existing.proof, {
					kind: CORE_PRIMITIVE_OPERATOR_EFFECT_FACT,
					value: Object.freeze([...masks]),
					claims: [{ kind: "effect", instruction, effects }],
					validity: { kind: "summary", digest },
					obligations: [],
					origin: "local-value-kind-analysis",
				});
				editor.setInstructionEffectRefinement(instruction, {
					effects,
					proof: existing.proof,
				});
				continue;
			}
			editor ??= CoreEditor.open(program, item.function);
			const proof = editor.addFact({
				kind: CORE_PRIMITIVE_OPERATOR_EFFECT_FACT,
				value: Object.freeze([...masks]),
				claims: [{ kind: "effect", instruction, effects }],
				validity: { kind: "summary", digest },
				obligations: [],
				origin: "local-value-kind-analysis",
			});
			editor.setInstructionEffectRefinement(instruction, { effects, proof });
		}
		return editor?.commit();
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

function buildEdgeUseMask(fn: CoreFunctionStore): Uint8Array {
	const appearsOnEdge = new Uint8Array(fn.valueCapacity);
	for (let blockIndex = 0; blockIndex < fn.blockCapacity; blockIndex++) {
		const block = coreBlockId(blockIndex);
		if (!fn.isBlockLive(block)) continue;
		const handlerStart = fn.kernel.blockHandlerArgumentStart(block);
		const handlerCount = fn.kernel.blockHandlerArgumentCount(block);
		for (let index = 0; index < handlerCount; index++)
			appearsOnEdge[fn.kernel.handlerArgumentAt(handlerStart + index)] = 1;
		const terminator = fn.blockTerminator(block);
		const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
		const edgeCount = fn.kernel.terminatorEdgeCount(terminator);
		for (let edgeOffset = 0; edgeOffset < edgeCount; edgeOffset++) {
			const argumentStart = fn.kernel.terminatorEdgeArgumentStart(edgeStart + edgeOffset);
			const argumentCount = fn.kernel.terminatorEdgeArgumentCount(edgeStart + edgeOffset);
			for (let index = 0; index < argumentCount; index++)
				appearsOnEdge[fn.kernel.operandAt(argumentStart + index)] = 1;
		}
	}
	return appearsOnEdge;
}

function scalarConsumersOnly(
	fn: CoreFunctionStore,
	value: CoreValueId,
	edgeUses: Uint8Array,
): boolean {
	let use = fn.kernel.valueFirstUse(value);
	while (use >= 0) {
		const instruction = fn.kernel.useInstruction(use);
		if (
			fn.instructionKind(instruction) === "operation" &&
			!SCALAR_CONSUMERS.has(fn.instructionOpcodeName(instruction))
		)
			return false;
		use = fn.kernel.useNext(use);
	}
	return edgeUses[value] === 0;
}

function scalarProducerInputsSupportRepresentation(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	representation: CoreRepresentation,
	componentValues?: ReadonlySet<CoreValueId>,
): boolean {
	const opcode = fn.instructionOpcodeName(instruction);
	const operandStart = fn.kernel.instructionOperandStart(instruction);
	const operandCount = fn.kernel.instructionOperandCount(instruction);
	const belongsToComponent = (value: CoreValueId): boolean =>
		componentValues?.has(value) === true;
	if (opcode === "move") {
		const source = operandCount === 0 ? undefined : fn.kernel.operandAt(operandStart);
		return (
			source !== undefined &&
			(fn.valueRepresentation(source) === representation || belongsToComponent(source))
		);
	}
	if (
		(opcode === "unary" || opcode === "binary") &&
		(representation === "i32" || representation === "f64")
	) {
		for (let index = 0; index < operandCount; index++) {
			const operand = fn.kernel.operandAt(operandStart + index);
			const operandRepresentation = fn.valueRepresentation(operand);
			if (
				!(
					operandRepresentation === "i32" ||
					operandRepresentation === "f64" ||
					belongsToComponent(operand)
				)
			)
				return false;
		}
		return true;
	}
	return true;
}

function scalarCandidate(
	fn: CoreFunctionStore,
	value: CoreValueId,
	kind: CoreExactScalarKind | undefined,
	edgeUses: Uint8Array,
): CoreRepresentation | undefined {
	if (kind === undefined || fn.valueRepresentation(value) !== "boxed") return undefined;
	const representation = scalarRepresentation(kind);
	if (
		fn.kernel.valueDefinitionKind(value) !== 1 ||
		!SCALAR_PRODUCERS.has(
			fn.instructionOpcodeName(coreInstructionId(fn.kernel.valueDefinitionOwner(value))),
		) ||
		!scalarConsumersOnly(fn, value, edgeUses)
	)
		return undefined;
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	if (!scalarProducerInputsSupportRepresentation(fn, definition, representation))
		return undefined;
	return representation;
}

const materializeLocalScalars: CoreFunctionPass = {
	name: "local-scalar-representation-selection",
	stage: "proofs",
	requiredAnalyses: [CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "facts", "representations"],
	changes: { cfg: false, calls: false, facts: false, representations: true },
	budget: PROOF_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const edgeUses = buildEdgeUseMask(fn);
		const candidates: Array<{
			readonly value: CoreValueId;
			readonly representation: CoreRepresentation;
		}> = [];
		for (let valueIndex = 0; valueIndex < fn.valueCapacity; valueIndex++) {
			const value = coreValueId(valueIndex);
			if (!fn.isValueLive(value)) continue;
			const representation = scalarCandidate(
				fn,
				value,
				kinds.exactScalar(value),
				edgeUses,
			);
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

const materializeFlowScalars: CoreFunctionPass = {
	name: "flow-scalar-representation-selection",
	stage: "proofs",
	requiredAnalyses: [CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "cfg", "facts", "representations"],
	changes: { cfg: false, calls: false, facts: false, representations: true },
	budget: PROOF_BUDGET,
	run(context) {
		const { program, item } = context;
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
			const terminator = fn.blockTerminator(block);
			const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
			const edgeCount = fn.kernel.terminatorEdgeCount(terminator);
			for (let edgeOffset = 0; edgeOffset < edgeCount; edgeOffset++) {
				const edge = edgeStart + edgeOffset;
				const target = fn.kernel.terminatorEdgeBlock(edge);
				const argumentStart = fn.kernel.terminatorEdgeArgumentStart(edge);
				const argumentCount = fn.kernel.terminatorEdgeArgumentCount(edge);
				const parameterStart = fn.kernel.blockParameterStart(target);
				const parameterCount = fn.kernel.blockParameterCount(target);
				const count = Math.min(argumentCount, parameterCount);
				for (let index = 0; index < count; index++) {
					connect(
						fn.kernel.operandAt(argumentStart + index),
						fn.kernel.blockParameterValue(parameterStart + index),
					);
				}
			}
			const handlerBlock = fn.kernel.blockHandlerBlock(block);
			if (handlerBlock !== undefined) {
				const argumentStart = fn.kernel.blockHandlerArgumentStart(block);
				const argumentCount = fn.kernel.blockHandlerArgumentCount(block);
				const parameterStart = fn.kernel.blockParameterStart(handlerBlock);
				const parameterCount = Math.max(
					0,
					fn.kernel.blockParameterCount(handlerBlock) - 1,
				);
				const count = Math.min(argumentCount, parameterCount);
				for (let index = 0; index < count; index++) {
					connect(
						fn.kernel.handlerArgumentAt(argumentStart + index),
						fn.kernel.blockParameterValue(parameterStart + 1 + index),
					);
				}
			}
			for (const instruction of fn.bodyInstructionIds(block)) {
				if (!SCALAR_CONSUMERS.has(fn.instructionOpcodeName(instruction))) continue;
				const byFamily: Array<Array<CoreValueId> | undefined> = [];
				const includeValue = (value: CoreValueId): void => {
					const scalar = kinds.exactScalar(value);
					if (scalar === undefined) return;
					const family =
						scalar === "int32" || scalar === "number" ? 0 : scalar === "boolean" ? 1 : 2;
					const values = byFamily[family] ?? [];
					values.push(value);
					byFamily[family] = values;
				};
				const operandStart = fn.kernel.instructionOperandStart(instruction);
				const operandCount = fn.kernel.instructionOperandCount(instruction);
				for (let index = 0; index < operandCount; index++)
					includeValue(fn.kernel.operandAt(operandStart + index));
				const resultStart = fn.kernel.instructionResultStart(instruction);
				const resultCount = fn.kernel.instructionResultCount(instruction);
				for (let index = 0; index < resultCount; index++)
					includeValue(fn.kernel.resultAt(resultStart + index));
				for (const values of byFamily) {
					if (values === undefined) continue;
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
				const definitionKind = fn.kernel.valueDefinitionKind(value);
				const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
				if (
					definitionKind === 1 &&
					!SCALAR_PRODUCERS.has(fn.instructionOpcodeName(definition))
				)
					return true;
				if (
					definitionKind === 1 &&
					!scalarProducerInputsSupportRepresentation(
						fn,
						definition,
						representation,
						componentValues,
					)
				)
					return true;
				let use = fn.kernel.valueFirstUse(value);
				while (use >= 0) {
					const instruction = fn.kernel.useInstruction(use);
					if (
						fn.instructionKind(instruction) === "operation" &&
						!SCALAR_CONSUMERS.has(fn.instructionOpcodeName(instruction))
					)
						return true;
					use = fn.kernel.useNext(use);
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

export const CORE_PROOF_PASSES: ReadonlyArray<CoreFunctionPass> = [
	canonicalizeFacts,
	removeEmptyUnreferencedFacts,
	refinePrimitiveEffects,
	rewireSubsumedEffectProofs,
	foldSubsumedGuards,
	materializeLocalScalars,
	materializeFlowScalars,
];
