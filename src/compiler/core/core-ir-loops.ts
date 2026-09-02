import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import {
	CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow, CoreNaturalLoop } from "./core-ir-control-flow.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import type { CoreExactScalarKind } from "./core-ir-value-kinds.ts";
import type { CoreBlockId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

export type CoreLoopComparison = "<" | "<=" | ">" | ">=";

export interface CoreNumericRange {
	readonly minimum: number;
	readonly maximum: number;
	readonly exactSafeIntegers: true;
	readonly excludesNegativeZero: true;
}

export interface CoreInductionRange extends CoreNumericRange {
	readonly first: number;
	readonly last: number;
	readonly finalUpdate: number;
	readonly maximumIterations: number;
}

export interface CoreInductionVariable {
	readonly loop: CoreNaturalLoop;
	readonly value: CoreValueId;
	readonly parameterIndex: number;
	readonly initial: CoreValueId;
	readonly update: CoreValueId;
	readonly updateInstruction: CoreInstructionId;
	readonly step: number;
	readonly representation: "f64" | "i32";
	readonly comparison?: {
		readonly instruction: CoreInstructionId;
		readonly operator: CoreLoopComparison;
		readonly bound: CoreValueId;
		readonly boundLoopInvariant: boolean;
		readonly body: CoreBlockId;
		readonly exit: CoreBlockId;
	};
	readonly range?: CoreInductionRange;
}

export interface CoreLoopInductionAnalysis {
	readonly inductions: ReadonlyArray<CoreInductionVariable>;
	readonly hasNumericRanges: boolean;
	induction(value: CoreValueId): CoreInductionVariable | undefined;
	range(value: CoreValueId, block?: CoreBlockId): CoreNumericRange | undefined;
}

const SAFE_MINIMUM = -Number.MAX_SAFE_INTEGER;
const SAFE_MAXIMUM = Number.MAX_SAFE_INTEGER;
const I32_RANGE: CoreNumericRange = Object.freeze({
	minimum: -0x8000_0000,
	maximum: 0x7fff_ffff,
	exactSafeIntegers: true,
	excludesNegativeZero: true,
});

function numericRange(minimum: number, maximum = minimum): CoreNumericRange | undefined {
	return Number.isSafeInteger(minimum) &&
		Number.isSafeInteger(maximum) &&
		minimum <= maximum &&
		!Object.is(minimum, -0) &&
		!Object.is(maximum, -0)
		? { minimum, maximum, exactSafeIntegers: true, excludesNegativeZero: true }
		: undefined;
}

function comparison(value: unknown): CoreLoopComparison | undefined {
	return value === "<" || value === "<=" || value === ">" || value === ">="
		? value
		: undefined;
}

function flip(operator: CoreLoopComparison): CoreLoopComparison {
	switch (operator) {
		case "<":
			return ">";
		case "<=":
			return ">=";
		case ">":
			return "<";
		case ">=":
			return "<=";
	}
}

function negate(operator: CoreLoopComparison): CoreLoopComparison {
	switch (operator) {
		case "<":
			return ">=";
		case "<=":
			return ">";
		case ">":
			return "<=";
		case ">=":
			return "<";
	}
}

function exactNumber(
	fn: CoreFunctionStore,
	value: CoreValueId,
	root: (value: CoreValueId) => CoreValueId,
): number | undefined {
	const definition = fn.valueDefinition(root(value));
	if (
		definition.kind !== "instruction" ||
		fn.instructionKind(definition.instruction) !== "operation"
	)
		return undefined;
	const opcode = fn.instructionOpcodeName(definition.instruction);
	if (opcode !== "createNumber" && opcode !== "createF64") return undefined;
	const valueAttribute = fn.instructionAttributes(definition.instruction).value;
	return typeof valueAttribute === "number" ? valueAttribute : undefined;
}

function definitionBlock(fn: CoreFunctionStore, value: CoreValueId): CoreBlockId {
	const definition = fn.valueDefinition(value);
	return definition.kind === "instruction"
		? fn.instructionBlock(definition.instruction)
		: definition.block;
}

function concreteRange(
	initial: number | undefined,
	bound: number | undefined,
	step: number,
	operator: CoreLoopComparison,
	representation: "f64" | "i32",
): CoreInductionRange | undefined {
	if (
		initial === undefined ||
		bound === undefined ||
		!Number.isSafeInteger(initial) ||
		!Number.isSafeInteger(bound) ||
		!Number.isSafeInteger(step) ||
		step === 0 ||
		Object.is(initial, -0)
	)
		return undefined;
	const start = BigInt(initial);
	const limit = BigInt(bound);
	const delta = BigInt(step);
	let iterations: bigint;
	let last: bigint;
	if (step > 0 && (operator === "<" || operator === "<=")) {
		const inclusive = operator === "<" ? limit - 1n : limit;
		if (start > inclusive) return undefined;
		iterations = (inclusive - start) / delta + 1n;
		last = start + (iterations - 1n) * delta;
	} else if (step < 0 && (operator === ">" || operator === ">=")) {
		const inclusive = operator === ">" ? limit + 1n : limit;
		if (start < inclusive) return undefined;
		iterations = (start - inclusive) / -delta + 1n;
		last = start + (iterations - 1n) * delta;
	} else return undefined;
	const finalUpdate = last + delta;
	const safe = BigInt(Number.MAX_SAFE_INTEGER);
	if (
		[start, last, finalUpdate].some((value) => value < -safe || value > safe) ||
		iterations > safe
	)
		return undefined;
	if (
		representation === "i32" &&
		[start, last, finalUpdate].some(
			(value) => value < -0x8000_0000n || value > 0x7fff_ffffn,
		)
	)
		return undefined;
	return {
		minimum: Number(start < last ? start : last),
		maximum: Number(start > last ? start : last),
		first: Number(start),
		last: Number(last),
		finalUpdate: Number(finalUpdate),
		maximumIterations: Number(iterations),
		exactSafeIntegers: true,
		excludesNegativeZero: true,
	};
}

function numericIdentityRoot(
	fn: CoreFunctionStore,
	value: CoreValueId,
	root: (value: CoreValueId) => CoreValueId,
	exactScalar?: (value: CoreValueId) => CoreExactScalarKind | undefined,
): CoreValueId {
	const resolved = root(value);
	const definition = fn.valueDefinition(resolved);
	if (
		definition.kind !== "instruction" ||
		fn.instructionKind(definition.instruction) !== "operation" ||
		fn.instructionOpcodeName(definition.instruction) !== "unary"
	)
		return resolved;
	const inputs = fn.instructionOperands(definition.instruction);
	const operator = fn.instructionAttributes(definition.instruction).operator;
	if (inputs.length !== 1 || (operator !== "tonumeric" && operator !== "+")) {
		return resolved;
	}
	const scalar = exactScalar?.(inputs[0]!);
	return scalar === "number" || scalar === "int32"
		? numericIdentityRoot(fn, inputs[0]!, root, exactScalar)
		: resolved;
}

function recurrenceStep(
	fn: CoreFunctionStore,
	update: CoreValueId,
	parameter: CoreValueId,
	root: (value: CoreValueId) => CoreValueId,
	exactScalar?: (value: CoreValueId) => CoreExactScalarKind | undefined,
): { readonly instruction: CoreInstructionId; readonly step: number } | undefined {
	const definition = fn.valueDefinition(root(update));
	if (
		definition.kind !== "instruction" ||
		fn.instructionKind(definition.instruction) !== "operation"
	)
		return undefined;
	const opcode = fn.instructionOpcodeName(definition.instruction);
	const inputs = fn.instructionOperands(definition.instruction);
	const attributes = fn.instructionAttributes(definition.instruction);
	if (
		opcode === "unary" &&
		inputs.length === 1 &&
		numericIdentityRoot(fn, inputs[0]!, root, exactScalar) === root(parameter)
	) {
		if (attributes.operator === "increment")
			return { instruction: definition.instruction, step: 1 };
		if (attributes.operator === "decrement")
			return { instruction: definition.instruction, step: -1 };
	}
	if (
		opcode !== "binary" ||
		inputs.length !== 2 ||
		(attributes.operator !== "+" && attributes.operator !== "-")
	)
		return undefined;
	if (root(inputs[0]!) === root(parameter)) {
		const amount = exactNumber(fn, inputs[1]!, root);
		if (amount !== undefined)
			return {
				instruction: definition.instruction,
				step: attributes.operator === "+" ? amount : -amount,
			};
	}
	if (attributes.operator === "+" && root(inputs[1]!) === root(parameter)) {
		const amount = exactNumber(fn, inputs[0]!, root);
		if (amount !== undefined)
			return { instruction: definition.instruction, step: amount };
	}
	return undefined;
}

function loopComparison(
	fn: CoreFunctionStore,
	loop: CoreNaturalLoop,
	parameter: CoreValueId,
	root: (value: CoreValueId) => CoreValueId,
	exactScalar?: (value: CoreValueId) => CoreExactScalarKind | undefined,
): CoreInductionVariable["comparison"] | undefined {
	const terminator = fn.terminatorPayload(fn.blockTerminator(loop.header));
	if (terminator.kind !== "branch") return undefined;
	const condition = fn.valueDefinition(root(terminator.condition));
	if (
		condition.kind !== "instruction" ||
		fn.instructionKind(condition.instruction) !== "operation" ||
		fn.instructionOpcodeName(condition.instruction) !== "binary"
	)
		return undefined;
	const inputs = fn.instructionOperands(condition.instruction);
	let operator = comparison(fn.instructionAttributes(condition.instruction).operator);
	if (operator === undefined || inputs.length !== 2) return undefined;
	let bound: CoreValueId;
	if (numericIdentityRoot(fn, inputs[0]!, root, exactScalar) === root(parameter))
		bound = inputs[1]!;
	else if (numericIdentityRoot(fn, inputs[1]!, root, exactScalar) === root(parameter)) {
		bound = inputs[0]!;
		operator = flip(operator);
	} else return undefined;
	const consequentInside = loop.blocks.has(terminator.consequent.block);
	const alternateInside = loop.blocks.has(terminator.alternate.block);
	if (consequentInside === alternateInside) return undefined;
	if (!consequentInside) operator = negate(operator);
	return {
		instruction: condition.instruction,
		operator,
		bound,
		boundLoopInvariant:
			exactNumber(fn, bound, root) !== undefined ||
			!loop.blocks.has(definitionBlock(fn, root(bound))),
		body: consequentInside ? terminator.consequent.block : terminator.alternate.block,
		exit: consequentInside ? terminator.alternate.block : terminator.consequent.block,
	};
}

interface PathRefinement {
	readonly block: CoreBlockId;
	readonly subject: CoreValueId;
	readonly range: CoreNumericRange;
}

function branchRange(
	operator: CoreLoopComparison,
	bound: number,
): CoreNumericRange | undefined {
	switch (operator) {
		case "<":
			return numericRange(SAFE_MINIMUM, bound - 1);
		case "<=":
			return numericRange(SAFE_MINIMUM, bound);
		case ">":
			return numericRange(bound + 1, SAFE_MAXIMUM);
		case ">=":
			return numericRange(bound, SAFE_MAXIMUM);
	}
}

export function analyzeCoreLoopInductions(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	canonical: ReadonlyMap<CoreValueId, CoreValueId>,
	exactScalar?: (value: CoreValueId) => CoreExactScalarKind | undefined,
): CoreLoopInductionAnalysis {
	const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
	const numericRepresentation = (value: CoreValueId): "f64" | "i32" | undefined => {
		const representation = fn.valueRepresentation(value);
		if (representation === "f64" || representation === "i32") return representation;
		const scalar = exactScalar?.(value);
		return scalar === "int32" ? "i32" : scalar === "number" ? "f64" : undefined;
	};
	const inductions: Array<CoreInductionVariable> = [];
	for (const loop of cfg.loops) {
		if (!loop.canonical || loop.preheader === undefined || loop.latches.size !== 1)
			continue;
		const latch = [...loop.latches][0]!;
		const incoming = (cfg.predecessors[loop.header] ?? []).filter(
			({ kind }) => kind === "ordinary",
		);
		const initialEdge = incoming.find(({ from }) => from === loop.preheader);
		const updateEdge = incoming.find(({ from }) => from === latch);
		if (initialEdge === undefined || updateEdge === undefined) continue;
		for (const [parameterIndex, parameter] of fn.blockParameters(loop.header).entries()) {
			const initial = initialEdge.arguments[parameterIndex];
			const update = updateEdge.arguments[parameterIndex];
			if (initial === undefined || update === undefined) continue;
			const initialScalar = exactScalar?.(initial);
			let representation = numericRepresentation(parameter.value);
			const bootstrap =
				representation === undefined &&
				(initialScalar === "number" || initialScalar === "int32");
			const recurrenceScalar = bootstrap
				? (value: CoreValueId): CoreExactScalarKind | undefined =>
						root(value) === root(parameter.value) ? initialScalar : exactScalar?.(value)
				: exactScalar;
			const recurrence = recurrenceStep(
				fn,
				update,
				parameter.value,
				root,
				recurrenceScalar,
			);
			if (
				recurrence === undefined ||
				fn.instructionBlock(recurrence.instruction) !== latch ||
				!Number.isSafeInteger(recurrence.step) ||
				recurrence.step === 0
			)
				continue;
			if (bootstrap) representation = "f64";
			if (
				representation === undefined ||
				(!bootstrap && numericRepresentation(update) !== representation)
			)
				continue;
			const controlling = loopComparison(
				fn,
				loop,
				parameter.value,
				root,
				recurrenceScalar,
			);
			const range =
				controlling?.boundLoopInvariant === true
					? concreteRange(
							exactNumber(fn, initial, root),
							exactNumber(fn, controlling.bound, root),
							recurrence.step,
							controlling.operator,
							representation,
						)
					: undefined;
			inductions.push({
				loop,
				value: parameter.value,
				parameterIndex,
				initial,
				update,
				updateInstruction: recurrence.instruction,
				step: recurrence.step,
				representation,
				...(controlling === undefined ? {} : { comparison: controlling }),
				...(range === undefined ? {} : { range }),
			});
		}
	}
	const byRoot = new Map(
		inductions.map((induction) => [root(induction.value), induction]),
	);
	const byUpdate = new Map(
		inductions.map((induction) => [root(induction.update), induction]),
	);
	const refinements: Array<PathRefinement> = [];
	for (const block of fn.blockIds()) {
		const terminator = fn.terminatorPayload(fn.blockTerminator(block));
		if (terminator.kind !== "branch") continue;
		const definition = fn.valueDefinition(root(terminator.condition));
		if (
			definition.kind !== "instruction" ||
			fn.instructionKind(definition.instruction) !== "operation" ||
			fn.instructionOpcodeName(definition.instruction) !== "binary"
		)
			continue;
		const inputs = fn.instructionOperands(definition.instruction);
		let operator = comparison(fn.instructionAttributes(definition.instruction).operator);
		if (operator === undefined || inputs.length !== 2) continue;
		let subject = inputs[0]!;
		let bound = exactNumber(fn, inputs[1]!, root);
		if (bound === undefined) {
			bound = exactNumber(fn, inputs[0]!, root);
			subject = inputs[1]!;
			operator = flip(operator);
		}
		if (bound === undefined || exactNumber(fn, subject, root) !== undefined) continue;
		for (const [edge, relation] of [
			[terminator.consequent, operator],
			[terminator.alternate, negate(operator)],
		] as const) {
			const range = branchRange(relation, bound);
			if (range !== undefined && cfg.dominatesEdge(block, edge.block, edge.block))
				refinements.push({ block: edge.block, subject: root(subject), range });
		}
	}
	const intersect = (
		left: CoreNumericRange,
		right: CoreNumericRange,
	): CoreNumericRange | undefined =>
		numericRange(
			Math.max(left.minimum, right.minimum),
			Math.min(left.maximum, right.maximum),
		);
	let hasI32 = false;
	for (const value of fn.valueIds()) {
		if (numericRepresentation(value) === "i32") {
			hasI32 = true;
			break;
		}
	}
	const result: CoreLoopInductionAnalysis = {
		inductions: Object.freeze(inductions),
		hasNumericRanges: inductions.length > 0 || refinements.length > 0 || hasI32,
		induction(value) {
			return byRoot.get(root(value));
		},
		range(value, block) {
			const resolved = root(value);
			const induction = byRoot.get(resolved) ?? byUpdate.get(resolved);
			const exact = exactNumber(fn, value, root);
			let range: CoreNumericRange | undefined =
				induction?.range ??
				(exact === undefined
					? numericRepresentation(value) === "i32"
						? I32_RANGE
						: undefined
					: numericRange(exact));
			if (range === undefined || block === undefined) return range;
			let current: CoreBlockId | null = block;
			while (current !== null) {
				for (const refinement of refinements) {
					if (refinement.block !== current || refinement.subject !== resolved) continue;
					const narrowed = intersect(range, refinement.range);
					if (narrowed === undefined) return undefined;
					range = narrowed;
				}
				current = cfg.immediateDominators[current] ?? null;
			}
			return range;
		},
	};
	return Object.freeze(result);
}

export const CORE_LOOP_INDUCTION_ANALYSIS: CoreAnalysisDefinition<CoreLoopInductionAnalysis> =
	{
		key: "loop-induction-and-path-ranges",
		scope: "function",
		functionDependencies: ["body", "cfg", "exceptionFlow", "representations"],
		compute({ program, request, get }) {
			if (request.scope !== "function") throw new Error("Expected function analysis");
			const fn = program.function(request.function);
			const kinds = get(CORE_LOCAL_VALUE_KIND_ANALYSIS, request);
			return analyzeCoreLoopInductions(
				fn,
				get(CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS, request),
				get(CORE_CANONICAL_VALUE_ROOTS_ANALYSIS, request),
				(value) => kinds.exactScalar(value),
			);
		},
	};
