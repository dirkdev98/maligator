import type { CompilerValueKindMask } from "../shared/compiler-value-kinds.ts";
import { COMPILER_INT32_RANGE } from "../shared/integer-range.ts";
import type { CompilerIntegerRange } from "../shared/integer-range.ts";
import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import {
	CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
} from "./core-ir-control-flow.ts";
import type {
	CoreControlEdge,
	CoreControlFlow,
	CoreControlPoint,
	CoreNaturalLoop,
} from "./core-ir-control-flow.ts";
import {
	CORE_LOCAL_VALUE_KIND_ANALYSIS,
	coreInstructionResultIntegerRange,
	coreInstructionLengthIntegerRange,
	coreIntegerPreservedResultInput,
} from "./core-ir-value-kinds.ts";
import type { CoreExactScalarKind } from "./core-ir-value-kinds.ts";
import { coreBlockId, coreInstructionId } from "./core-ir.ts";
import type { CoreBlockId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export type CoreLoopComparison = "<" | "<=" | ">" | ">=";

export interface CoreInductionRange extends CompilerIntegerRange {
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
	range(value: CoreValueId, point?: CoreControlPoint): CompilerIntegerRange | undefined;
	rangeQuery(
		resultRange: (instruction: CoreInstructionId) => CoreIntegerRangeState,
	): CoreIntegerRangeQuery;
}

// Null is the empty normal-result set; undefined includes non-integers and -0.
export type CoreIntegerRangeState = CompilerIntegerRange | null | undefined;
export type CoreIntegerRangeQuery = (
	value: CoreValueId,
	point?: CoreControlPoint,
) => CoreIntegerRangeState;

const SAFE_MINIMUM = -Number.MAX_SAFE_INTEGER;
const SAFE_MAXIMUM = Number.MAX_SAFE_INTEGER;

function definitionInstruction(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CoreInstructionId | undefined {
	return fn.kernel.valueDefinitionKind(value) === 1
		? coreInstructionId(fn.kernel.valueDefinitionOwner(value))
		: undefined;
}

function operand(fn: CoreFunctionStore, instruction: CoreInstructionId, index: number) {
	return index < fn.kernel.instructionOperandCount(instruction)
		? fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index)
		: undefined;
}

function numericRange(
	minimum: number,
	maximum = minimum,
): CompilerIntegerRange | undefined {
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
	const instruction = definitionInstruction(fn, root(value));
	if (instruction === undefined || fn.instructionKind(instruction) !== "operation")
		return undefined;
	const opcode = fn.instructionOpcodeName(instruction);
	if (opcode !== "createNumber" && opcode !== "createF64") return undefined;
	const valueAttribute = fn.instructionAttributes(instruction).value;
	return typeof valueAttribute === "number" ? valueAttribute : undefined;
}

function definitionBlock(fn: CoreFunctionStore, value: CoreValueId): CoreBlockId {
	const owner = fn.kernel.valueDefinitionOwner(value);
	return fn.kernel.valueDefinitionKind(value) === 1
		? coreBlockId(fn.kernel.instructionBlock(coreInstructionId(owner)))
		: coreBlockId(owner);
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
	const instruction = definitionInstruction(fn, resolved);
	if (
		instruction === undefined ||
		fn.instructionKind(instruction) !== "operation" ||
		fn.instructionOpcodeName(instruction) !== "unary"
	)
		return resolved;
	const operator = fn.instructionAttributes(instruction).operator;
	const input = operand(fn, instruction, 0);
	if (
		fn.kernel.instructionOperandCount(instruction) !== 1 ||
		input === undefined ||
		(operator !== "tonumeric" && operator !== "+")
	) {
		return resolved;
	}
	const scalar = exactScalar?.(input);
	return scalar === "number" || scalar === "int32"
		? numericIdentityRoot(fn, input, root, exactScalar)
		: resolved;
}

function recurrenceStep(
	fn: CoreFunctionStore,
	update: CoreValueId,
	parameter: CoreValueId,
	root: (value: CoreValueId) => CoreValueId,
	exactScalar?: (value: CoreValueId) => CoreExactScalarKind | undefined,
): { readonly instruction: CoreInstructionId; readonly step: number } | undefined {
	const instruction = definitionInstruction(fn, root(update));
	if (instruction === undefined || fn.instructionKind(instruction) !== "operation")
		return undefined;
	const opcode = fn.instructionOpcodeName(instruction);
	const inputCount = fn.kernel.instructionOperandCount(instruction);
	const first = operand(fn, instruction, 0);
	const second = operand(fn, instruction, 1);
	const attributes = fn.instructionAttributes(instruction);
	if (
		opcode === "unary" &&
		inputCount === 1 &&
		first !== undefined &&
		numericIdentityRoot(fn, first, root, exactScalar) === root(parameter)
	) {
		if (attributes.operator === "increment") return { instruction, step: 1 };
		if (attributes.operator === "decrement") return { instruction, step: -1 };
	}
	if (
		opcode !== "binary" ||
		inputCount !== 2 ||
		first === undefined ||
		second === undefined ||
		(attributes.operator !== "+" && attributes.operator !== "-")
	)
		return undefined;
	if (root(first) === root(parameter)) {
		const amount = exactNumber(fn, second, root);
		if (amount !== undefined)
			return {
				instruction,
				step: attributes.operator === "+" ? amount : -amount,
			};
	}
	if (attributes.operator === "+" && root(second) === root(parameter)) {
		const amount = exactNumber(fn, first, root);
		if (amount !== undefined) return { instruction, step: amount };
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
	const terminator = fn.blockTerminator(loop.header);
	if (fn.instructionKind(terminator) !== "branch") return undefined;
	const terminatorOperandStart = fn.kernel.instructionOperandStart(terminator);
	const conditionValue = fn.kernel.operandAt(terminatorOperandStart);
	const condition = definitionInstruction(fn, root(conditionValue));
	if (
		condition === undefined ||
		fn.instructionKind(condition) !== "operation" ||
		fn.instructionOpcodeName(condition) !== "binary"
	)
		return undefined;
	const inputCount = fn.kernel.instructionOperandCount(condition);
	const first = operand(fn, condition, 0);
	const second = operand(fn, condition, 1);
	let operator = comparison(fn.instructionAttributes(condition).operator);
	if (
		operator === undefined ||
		inputCount !== 2 ||
		first === undefined ||
		second === undefined
	)
		return undefined;
	let bound: CoreValueId;
	if (numericIdentityRoot(fn, first, root, exactScalar) === root(parameter))
		bound = second;
	else if (numericIdentityRoot(fn, second, root, exactScalar) === root(parameter)) {
		bound = first;
		operator = flip(operator);
	} else return undefined;
	const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
	const consequent = fn.kernel.terminatorEdgeBlock(edgeStart);
	const alternate = fn.kernel.terminatorEdgeBlock(edgeStart + 1);
	const consequentInside = loop.blocks.has(consequent);
	const alternateInside = loop.blocks.has(alternate);
	if (consequentInside === alternateInside) return undefined;
	if (!consequentInside) operator = negate(operator);
	return {
		instruction: condition,
		operator,
		bound,
		boundLoopInvariant:
			exactNumber(fn, bound, root) !== undefined ||
			!loop.blocks.has(definitionBlock(fn, root(bound))),
		body: consequentInside ? consequent : alternate,
		exit: consequentInside ? alternate : consequent,
	};
}

interface PathRefinement {
	readonly block: CoreBlockId;
	readonly range: CompilerIntegerRange;
}

interface RelationalRefinement {
	readonly block: CoreBlockId;
	readonly comparison: CoreBlockId;
	readonly bound: CoreValueId;
	readonly operator: CoreLoopComparison;
}

function branchRange(
	operator: CoreLoopComparison,
	bound: number,
): CompilerIntegerRange | undefined {
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
	program: CoreProgram,
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	canonical: ReadonlyMap<CoreValueId, CoreValueId>,
	exactScalar?: (value: CoreValueId) => CoreExactScalarKind | undefined,
	kindMask?: (value: CoreValueId) => CompilerValueKindMask,
): CoreLoopInductionAnalysis {
	const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
	const lengthKinds = kindMask === undefined ? undefined : { kindMask };
	const numericRepresentation = (value: CoreValueId): "f64" | "i32" | undefined => {
		const representation = fn.valueRepresentation(value);
		if (representation === "i32") return representation;
		const scalar = exactScalar?.(value);
		return scalar === "int32"
			? "i32"
			: representation === "f64" || scalar === "number"
				? "f64"
				: undefined;
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
		const parameterStart = fn.kernel.blockParameterStart(loop.header);
		const parameterCount = fn.kernel.blockParameterCount(loop.header);
		for (let parameterIndex = 0; parameterIndex < parameterCount; parameterIndex++) {
			const parameter = fn.kernel.blockParameterValue(parameterStart + parameterIndex);
			const initial = initialEdge.arguments[parameterIndex];
			const update = updateEdge.arguments[parameterIndex];
			if (initial === undefined || update === undefined) continue;
			const initialScalar = exactScalar?.(initial);
			let representation = numericRepresentation(parameter);
			const bootstrap =
				representation === undefined &&
				(initialScalar === "number" || initialScalar === "int32");
			const recurrenceScalar = bootstrap
				? (value: CoreValueId): CoreExactScalarKind | undefined =>
						root(value) === root(parameter) ? initialScalar : exactScalar?.(value)
				: exactScalar;
			const recurrence = recurrenceStep(fn, update, parameter, root, recurrenceScalar);
			if (
				recurrence === undefined ||
				coreBlockId(fn.kernel.instructionBlock(recurrence.instruction)) !== latch ||
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
			const controlling = loopComparison(fn, loop, parameter, root, recurrenceScalar);
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
				value: parameter,
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
	const refinements = new Map<CoreValueId, Array<PathRefinement>>();
	const relations = new Map<CoreValueId, Array<RelationalRefinement>>();
	for (const block of fn.blockIds()) {
		const terminator = fn.blockTerminator(block);
		const kind = fn.instructionKind(terminator);
		if (kind !== "branch" && kind !== "guard") continue;
		const conditionValue = fn.kernel.operandAt(
			fn.kernel.instructionOperandStart(terminator),
		);
		const definition = definitionInstruction(fn, root(conditionValue));
		if (
			definition === undefined ||
			fn.instructionKind(definition) !== "operation" ||
			fn.instructionOpcodeName(definition) !== "binary"
		)
			continue;
		const inputCount = fn.kernel.instructionOperandCount(definition);
		const first = operand(fn, definition, 0);
		const second = operand(fn, definition, 1);
		const operator = comparison(fn.instructionAttributes(definition).operator);
		if (
			operator === undefined ||
			inputCount !== 2 ||
			first === undefined ||
			second === undefined
		)
			continue;
		const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
		for (const [subject, bound, relation] of [
			[root(first), root(second), operator],
			[root(second), root(first), flip(operator)],
		] as const) {
			if (subject === bound || exactNumber(fn, subject, root) !== undefined) continue;
			const constant = exactNumber(fn, bound, root);
			for (const [target, operator] of [
				[fn.kernel.terminatorEdgeBlock(edgeStart), relation],
				[fn.kernel.terminatorEdgeBlock(edgeStart + 1), negate(relation)],
			] as const) {
				if (!cfg.dominatesEdge(block, target, target)) continue;
				const range =
					constant === undefined ? undefined : branchRange(operator, constant);
				if (constant !== undefined && range === undefined) continue;
				if (range === undefined) {
					const list = relations.get(subject) ?? [];
					list.push({ block: target, comparison: block, bound, operator });
					relations.set(subject, list);
				} else {
					const list = refinements.get(subject) ?? [];
					list.push({ block: target, range });
					refinements.set(subject, list);
				}
			}
		}
	}
	const intersect = (
		left: CompilerIntegerRange,
		right: CompilerIntegerRange,
	): CompilerIntegerRange | undefined =>
		numericRange(
			Math.max(left.minimum, right.minimum),
			Math.min(left.maximum, right.maximum),
		);
	const constantBounds = (
		value: CoreValueId,
		block: CoreBlockId,
		initial: CompilerIntegerRange,
	): CompilerIntegerRange | undefined => {
		let range = initial;
		for (const refinement of refinements.get(value) ?? []) {
			if (!cfg.dominates(refinement.block, block)) continue;
			const next = intersect(range, refinement.range);
			if (next === undefined) return undefined;
			range = next;
		}
		return range;
	};
	let hasI32 = false;
	for (const value of fn.valueIds()) {
		if (numericRepresentation(value) === "i32") {
			hasI32 = true;
			break;
		}
	}
	const rangeQuery = (
		resultRange?: (instruction: CoreInstructionId) => CoreIntegerRangeState,
	): CoreIntegerRangeQuery => {
		const memo = new Map<
			CoreBlockId | undefined,
			Map<CoreValueId, CoreIntegerRangeState>
		>();
		const baseRange = (
			value: CoreValueId,
			block: CoreBlockId | undefined,
			budget: { remaining: number },
		): CoreIntegerRangeState => {
			const resolved = root(value);
			let cache = memo.get(block);
			if (cache === undefined) {
				cache = new Map();
				memo.set(block, cache);
			}
			if (cache.has(resolved)) return cache.get(resolved);
			if (budget.remaining-- <= 0) return undefined;
			cache.set(resolved, undefined);
			const induction = byRoot.get(resolved);
			const update = byUpdate.get(resolved);
			const exact = exactNumber(fn, resolved, root);
			let range: CoreIntegerRangeState;
			if (induction?.range !== undefined) {
				const body =
					block !== undefined &&
					induction.comparison !== undefined &&
					induction.loop.blocks.has(block) &&
					cfg.dominates(induction.comparison.body, block);
				range = body
					? numericRange(induction.range.minimum, induction.range.maximum)
					: numericRange(
							Math.min(induction.range.minimum, induction.range.finalUpdate),
							Math.max(induction.range.maximum, induction.range.finalUpdate),
						);
			} else if (update?.range !== undefined) {
				range = numericRange(
					update.range.minimum + update.step,
					update.range.maximum + update.step,
				);
			} else if (exact !== undefined) range = numericRange(exact);
			else {
				const definition = definitionInstruction(fn, resolved);
				if (definition !== undefined)
					range =
						resultRange === undefined
							? coreInstructionResultIntegerRange(fn, definition)
							: resultRange(definition);
				if (range === undefined && definition !== undefined)
					range = coreInstructionLengthIntegerRange(program, fn, definition, lengthKinds);
				if (range === undefined && definition !== undefined) {
					const input = coreIntegerPreservedResultInput(fn, definition);
					if (input !== undefined) range = query(input, block, budget);
				}
				if (
					range === undefined &&
					definition !== undefined &&
					fn.instructionOpcodeName(definition) === "unary"
				) {
					const input = operand(fn, definition, 0)!;
					const operator = fn.instructionAttributes(definition).operator;
					if (
						(operator === "+" || operator === "tonumeric") &&
						numericRepresentation(input) !== undefined
					)
						range = query(input, block, budget);
				}
				if (
					range === undefined &&
					definition !== undefined &&
					fn.instructionOpcodeName(definition) === "binary"
				) {
					const left = operand(fn, definition, 0)!;
					const right = operand(fn, definition, 1)!;
					const constant = exactNumber(fn, right, root);
					const operator = fn.instructionAttributes(definition).operator;
					if (resultRange !== undefined && query(left, block, budget) === null) {
						range = null;
					} else if (operator === ">>>") {
						range = numericRange(
							0,
							constant === undefined ? 0xffff_ffff : 0xffff_ffff >>> (constant & 31),
						);
					} else if (
						operator === "&" &&
						constant !== undefined &&
						Number.isInteger(constant) &&
						constant >= 0 &&
						constant <= 0x7fff_ffff
					) {
						range = numericRange(0, constant);
					} else if (
						constant !== undefined &&
						Number.isSafeInteger(constant) &&
						!Object.is(constant, -0)
					) {
						const input = query(left, block, budget);
						if (input !== undefined && input !== null) {
							if (operator === "+")
								range = numericRange(input.minimum + constant, input.maximum + constant);
							else if (operator === "-")
								range = numericRange(input.minimum - constant, input.maximum - constant);
							else if (
								operator === "*" &&
								!(constant < 0 && input.minimum <= 0 && input.maximum >= 0) &&
								!(constant === 0 && input.minimum < 0)
							) {
								range = numericRange(
									Math.min(input.minimum * constant, input.maximum * constant),
									Math.max(input.minimum * constant, input.maximum * constant),
								);
							} else if (operator === "%" && constant > 0 && input.minimum >= 0)
								range = numericRange(0, Math.min(input.maximum, constant - 1));
						}
					}
				}
				if (range === undefined && fn.kernel.valueDefinitionKind(resolved) === 0) {
					const owner = fn.kernel.valueDefinitionOwner(resolved) as CoreBlockId;
					const index = fn.kernel.valueDefinitionIndex(resolved);
					const row = fn.kernel.blockParameterStart(owner) + index;
					const incoming = cfg.predecessors[owner] ?? [];
					if (fn.kernel.blockParameterRole(row) !== 1 && incoming.length > 0) {
						let joined: CoreIntegerRangeState = null;
						for (const edge of incoming) {
							const input =
								edge.arguments[edge.kind === "exceptional" ? index - 1 : index];
							const bound =
								input === undefined ? undefined : query(input, edge.from, budget);
							if (bound === undefined) {
								joined = undefined;
								break;
							}
							if (bound === null) continue;
							joined =
								joined === null
									? bound
									: {
											minimum: Math.min(joined.minimum, bound.minimum),
											maximum: Math.max(joined.maximum, bound.maximum),
											exactSafeIntegers: true,
											excludesNegativeZero: true,
										};
						}
						range = joined;
					}
				}
				if (range === undefined && numericRepresentation(resolved) === "i32")
					range = COMPILER_INT32_RANGE;
			}
			if (range !== undefined && range !== null && block !== undefined)
				range = constantBounds(resolved, block, range);
			cache.set(resolved, range);
			return range;
		};
		const pointRange = (
			value: CoreValueId,
			block: CoreBlockId,
			premise: CompilerIntegerRange,
			budget: { remaining: number },
		): CoreIntegerRangeState => {
			const base = baseRange(value, block, budget);
			return base === null
				? null
				: base === undefined
					? constantBounds(value, block, premise)
					: intersect(base, premise);
		};
		const needsClosure = (value: CoreValueId, block: CoreBlockId): boolean => {
			let remaining = 32;
			for (const relation of relations.get(value) ?? []) {
				if (!cfg.dominates(relation.block, block)) continue;
				for (const next of relations.get(relation.bound) ?? []) {
					if (remaining-- <= 0) return true;
					if (
						next.bound !== value &&
						next.operator[0] === relation.operator[0] &&
						cfg.dominates(next.block, block)
					)
						return true;
				}
			}
			return false;
		};
		const directRange = (
			value: CoreValueId,
			block: CoreBlockId,
			initial: CompilerIntegerRange,
			budget: { remaining: number },
		): CoreIntegerRangeState => {
			let range = initial;
			for (const refinement of relations.get(value) ?? []) {
				if (!cfg.dominates(refinement.block, block)) continue;
				if (budget.remaining-- <= 0) break;
				const premise = baseRange(refinement.bound, refinement.comparison, budget);
				if (premise === null) return null;
				if (premise === undefined) continue;
				const bound = pointRange(refinement.bound, block, premise, budget);
				if (bound === undefined || bound === null) return bound;
				const constraint = branchRange(
					refinement.operator,
					refinement.operator === "<" || refinement.operator === "<="
						? bound.maximum
						: bound.minimum,
				);
				if (constraint === undefined) continue;
				const next = intersect(range, constraint);
				if (next === undefined) return undefined;
				range = next;
			}
			return range;
		};
		const relationalRange = (
			value: CoreValueId,
			block: CoreBlockId,
			initial: CompilerIntegerRange,
			budget: { remaining: number },
		): CoreIntegerRangeState => {
			interface Node {
				readonly value: CoreValueId;
				range: CompilerIntegerRange;
				readonly dependents: Set<Node>;
				readonly edges: Array<{ bound: Node; operator: CoreLoopComparison }>;
				queued: boolean;
				scanned: boolean;
			}
			const nodes = new Map<CoreValueId, Node>();
			const pending: Array<Node> = [];
			const enqueue = (node: Node) => {
				if (node.queued) return;
				node.queued = true;
				pending.push(node);
			};
			const narrow = (node: Node, range: CompilerIntegerRange) => {
				if (node.range.minimum === range.minimum && node.range.maximum === range.maximum)
					return;
				node.range = range;
				for (const dependent of node.dependents) enqueue(dependent);
			};
			const nodeAt = (
				value: CoreValueId,
				premise: CompilerIntegerRange,
			): Node | null | undefined => {
				const existing = nodes.get(value);
				const range =
					existing === undefined
						? pointRange(value, block, premise, budget)
						: intersect(existing.range, premise);
				if (range === undefined || range === null) return range;
				if (existing !== undefined) {
					narrow(existing, range);
					return existing;
				}
				const node: Node = {
					value,
					range,
					dependents: new Set(),
					edges: [],
					queued: false,
					scanned: false,
				};
				nodes.set(value, node);
				enqueue(node);
				return node;
			};
			const root = nodeAt(value, initial);
			if (root === undefined || root === null) return root;
			while (pending.length > 0 && budget.remaining-- > 0) {
				const node = pending.pop()!;
				node.queued = false;
				if (!node.scanned) {
					node.scanned = true;
					for (const refinement of relations.get(node.value) ?? []) {
						if (!cfg.dominates(refinement.block, block)) continue;
						if (budget.remaining-- <= 0) break;
						// Consumer bounds tighten an integer premise established before this edge.
						const premise = baseRange(refinement.bound, refinement.comparison, budget);
						if (premise === null) return null;
						if (premise === undefined) continue;
						const bound = nodeAt(refinement.bound, premise);
						if (bound === undefined || bound === null) return bound;
						node.edges.push({ bound, operator: refinement.operator });
						bound.dependents.add(node);
					}
				}
				for (const { bound, operator } of node.edges) {
					const constraint = branchRange(
						operator,
						operator === "<" || operator === "<="
							? bound.range.maximum
							: bound.range.minimum,
					);
					if (constraint === undefined) continue;
					const range = intersect(node.range, constraint);
					if (range === undefined) return undefined;
					narrow(node, range);
				}
			}
			return root.range;
		};
		let relationalMemo:
			| Map<CoreBlockId, Map<CoreValueId, CoreIntegerRangeState>>
			| undefined;
		const query = (
			value: CoreValueId,
			block: CoreBlockId | undefined,
			budget: { remaining: number },
		): CoreIntegerRangeState => {
			const resolved = root(value);
			const refinements = relations.get(resolved);
			if (block === undefined || refinements === undefined)
				return baseRange(resolved, block, budget);
			let cache = relationalMemo?.get(block);
			if (cache?.has(resolved)) return cache.get(resolved);
			const base = baseRange(resolved, block, budget);
			if (
				base === undefined ||
				base === null ||
				!refinements.some((refinement) => cfg.dominates(refinement.block, block))
			)
				return base;
			if (cache === undefined) {
				cache = new Map();
				(relationalMemo ??= new Map()).set(block, cache);
			}
			cache.set(resolved, undefined);
			const range = needsClosure(resolved, block)
				? relationalRange(resolved, block, base, budget)
				: directRange(resolved, block, base, budget);
			cache.set(resolved, range);
			return range;
		};
		const onEdge = (
			value: CoreValueId,
			edge: CoreControlEdge,
			budget: { remaining: number },
		): CoreIntegerRangeState => {
			if (edge.kind !== "ordinary") return undefined;
			const initial = query(value, edge.from, budget);
			if (initial === undefined || initial === null || budget.remaining-- <= 0)
				return initial;
			const terminator = fn.blockTerminator(edge.from);
			const kind = fn.instructionKind(terminator);
			if (kind !== "branch" && kind !== "guard") return initial;
			const edges = cfg.successors[edge.from]!.filter((edge) => edge.kind === "ordinary");
			const yes = edges[0]!;
			const no = edges[1]!;
			const exclusive = yes.to !== no.to;
			const yesTaken = edge === yes || (exclusive && edge.to === yes.to);
			const noTaken = edge === no || (exclusive && edge.to === no.to);
			if (yesTaken === noTaken) return initial;
			const condition = operand(fn, terminator, 0)!;
			const definition = definitionInstruction(fn, root(condition));
			if (definition === undefined || fn.instructionOpcodeName(definition) !== "binary")
				return initial;
			let operator = comparison(fn.instructionAttributes(definition).operator);
			const left = operand(fn, definition, 0);
			const right = operand(fn, definition, 1);
			if (operator === undefined || left === undefined || right === undefined)
				return initial;
			const subject = root(value);
			let boundValue: CoreValueId;
			if (root(left) === subject) boundValue = right;
			else if (root(right) === subject) {
				boundValue = left;
				operator = flip(operator);
			} else return initial;
			if (noTaken) operator = negate(operator);
			const constant = exactNumber(fn, boundValue, root);
			let bound = constant;
			if (bound === undefined) {
				const range = query(boundValue, edge.from, budget);
				if (range === null) return null;
				if (range === undefined) return initial;
				bound = operator === "<" || operator === "<=" ? range.maximum : range.minimum;
			}
			const constraint = branchRange(operator, bound);
			return constraint === undefined ? initial : intersect(initial, constraint);
		};
		return (value, point) => {
			const budget = { remaining: 32 };
			return point !== undefined && typeof point !== "number"
				? onEdge(value, point, budget)
				: query(value, point, budget);
		};
	};
	const query = rangeQuery();
	const hasBoundedProducer = [...fn.instructionIds()].some(
		(instruction) =>
			fn.instructionKind(instruction) === "operation" &&
			((fn.instructionOpcodeName(instruction) === "binary" &&
				["&", ">>>"].includes(
					fn.instructionAttributes(instruction).operator as string,
				)) ||
				(coreInstructionResultIntegerRange(fn, instruction) ??
					coreInstructionLengthIntegerRange(program, fn, instruction, lengthKinds)) !==
					undefined),
	);
	const result: CoreLoopInductionAnalysis = {
		inductions: Object.freeze(inductions),
		hasNumericRanges:
			inductions.length > 0 || refinements.size > 0 || hasI32 || hasBoundedProducer,
		induction(value) {
			return byRoot.get(root(value));
		},
		range(value, point) {
			return query(value, point) ?? undefined;
		},
		rangeQuery,
	};
	return Object.freeze(result);
}

export const CORE_LOOP_INDUCTION_ANALYSIS: CoreAnalysisDefinition<CoreLoopInductionAnalysis> =
	{
		key: "loop-induction-and-path-ranges",
		scope: "function",
		functionDependencies: [
			"body",
			"cfg",
			"exceptionFlow",
			"memoryEffects",
			"normalResults",
			"representations",
		],
		compute({ program, request, get }) {
			if (request.scope !== "function") throw new Error("Expected function analysis");
			const fn = program.function(request.function);
			const kinds = get(CORE_LOCAL_VALUE_KIND_ANALYSIS, request);
			return analyzeCoreLoopInductions(
				program,
				fn,
				get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request).exceptional(),
				get(CORE_CANONICAL_VALUE_ROOTS_ANALYSIS, request),
				(value) => kinds.exactScalar(value),
				(value) => kinds.kindMask(value),
			);
		},
	};
