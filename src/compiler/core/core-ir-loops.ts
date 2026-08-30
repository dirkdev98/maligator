/**
 * Reusable exact-integer ranges and induction facts over canonical Core.
 *
 * The analysis recognizes only additive recurrences whose numeric representation
 * is explicit. It records wider relational facts, but derives concrete ranges
 * only when every executed value — including the final update that exits the
 * loop — stays an exact safe integer and the seed is not negative zero.
 */

import type { CoreControlFlow, CoreNaturalLoop } from "./core-ir-control-flow.ts";
import type {
	CoreBlockId,
	CoreFunction,
	CoreInstruction,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";

export type CoreLoopComparison = "<" | "<=" | ">" | ">=";

export interface CoreNumericRange {
	readonly minimum: number;
	readonly maximum: number;
	readonly exactSafeIntegers: true;
	readonly excludesNegativeZero: true;
}

export interface CoreInductionRange extends CoreNumericRange {
	/** First value for which the controlling comparison succeeds. */
	readonly first: number;
	/** Last value for which the controlling comparison succeeds. */
	readonly last: number;
	/** Value produced by the final recurrence update before the bound rejects it. */
	readonly finalUpdate: number;
	/** Upper bound when another exit can leave the loop earlier. */
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
	/**
	 * Header relation normalized with the induction on the left. When the bound is
	 * not loop-invariant, consumers may use it only within the same iteration on
	 * blocks dominated by `body`; it proves no trip count or cross-iteration fact.
	 */
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

const INT32_MINIMUM = -0x8000_0000;
const INT32_MAXIMUM = 0x7fff_ffff;

function numericRange(minimum: number, maximum = minimum): CoreNumericRange | undefined {
	return Number.isSafeInteger(minimum) &&
		Number.isSafeInteger(maximum) &&
		minimum <= maximum &&
		!Object.is(minimum, -0) &&
		!Object.is(maximum, -0)
		? {
				minimum,
				maximum,
				exactSafeIntegers: true,
				excludesNegativeZero: true,
			}
		: undefined;
}

function flipComparison(operator: CoreLoopComparison): CoreLoopComparison {
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

function negateComparison(operator: CoreLoopComparison): CoreLoopComparison {
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

function comparisonOperator(value: unknown): CoreLoopComparison | undefined {
	return value === "<" || value === "<=" || value === ">" || value === ">="
		? value
		: undefined;
}

function exactNumber(
	value: CoreValueId,
	definitions: ReadonlyMap<CoreValueId, CoreInstruction>,
	canonical: ReadonlyMap<CoreValueId, CoreValueId>,
): number | undefined {
	const root = canonical.get(value) ?? value;
	const definition = definitions.get(root);
	if (definition?.opcode !== "createNumber" && definition?.opcode !== "createF64") {
		return undefined;
	}
	const number = definition.attributes.value;
	return typeof number === "number" ? number : undefined;
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
	) {
		return undefined;
	}
	const start = BigInt(initial);
	const limit = BigInt(bound);
	const delta = BigInt(step);
	let iterations: bigint;
	let last: bigint;
	if (step > 0 && (operator === "<" || operator === "<=")) {
		const inclusiveLimit = operator === "<" ? limit - 1n : limit;
		if (start > inclusiveLimit) return undefined;
		iterations = (inclusiveLimit - start) / delta + 1n;
		last = start + (iterations - 1n) * delta;
	} else if (step < 0 && (operator === ">" || operator === ">=")) {
		const inclusiveLimit = operator === ">" ? limit + 1n : limit;
		if (start < inclusiveLimit) return undefined;
		const magnitude = -delta;
		iterations = (start - inclusiveLimit) / magnitude + 1n;
		last = start + (iterations - 1n) * delta;
	} else {
		return undefined;
	}
	const maximumSafe = BigInt(Number.MAX_SAFE_INTEGER);
	const minimumSafe = -maximumSafe;
	const finalUpdate = last + delta;
	if (
		start < minimumSafe ||
		start > maximumSafe ||
		last < minimumSafe ||
		last > maximumSafe ||
		finalUpdate < minimumSafe ||
		finalUpdate > maximumSafe ||
		iterations > maximumSafe
	) {
		return undefined;
	}
	if (representation === "i32") {
		const minimumInt32 = BigInt(INT32_MINIMUM);
		const maximumInt32 = BigInt(INT32_MAXIMUM);
		if (
			start < minimumInt32 ||
			start > maximumInt32 ||
			last < minimumInt32 ||
			last > maximumInt32 ||
			finalUpdate < minimumInt32 ||
			finalUpdate > maximumInt32
		) {
			return undefined;
		}
	}
	const firstNumber = Number(start);
	const lastNumber = Number(last);
	return {
		minimum: Math.min(firstNumber, lastNumber),
		maximum: Math.max(firstNumber, lastNumber),
		first: firstNumber,
		last: lastNumber,
		finalUpdate: Number(finalUpdate),
		maximumIterations: Number(iterations),
		exactSafeIntegers: true,
		excludesNegativeZero: true,
	};
}

/** Analyze canonical numeric block-argument recurrences and reusable integer ranges. */
export function analyzeCoreLoopInductions(
	fn: CoreFunction,
	cfg: CoreControlFlow,
	canonical: ReadonlyMap<CoreValueId, CoreValueId>,
): CoreLoopInductionAnalysis {
	const definitions = new Map<CoreValueId, CoreInstruction>();
	const locations = new Map<CoreInstructionId, CoreBlockId>();
	const valueBlocks = new Map<CoreValueId, CoreBlockId>();
	const representations = new Map(
		fn.values.map(({ id, representation }) => [id, representation] as const),
	);
	for (const block of fn.blocks) {
		for (const parameter of block.parameters) valueBlocks.set(parameter.value, block.id);
		for (const instruction of block.instructions) {
			locations.set(instruction.id, block.id);
			for (const output of instruction.outputs) {
				definitions.set(output, instruction);
				valueBlocks.set(output, block.id);
			}
		}
	}
	const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
	const stripNumeric = (value: CoreValueId): CoreValueId => {
		const definition = definitions.get(root(value));
		return definition?.opcode === "unary" &&
			definition.attributes.operator === "tonumeric" &&
			definition.inputs.length === 1 &&
			(representations.get(definition.inputs[0]!) === "f64" ||
				representations.get(definition.inputs[0]!) === "i32")
			? root(definition.inputs[0]!)
			: root(value);
	};
	const inductions: Array<CoreInductionVariable> = [];
	for (const loop of cfg.loops) {
		if (!loop.canonical || loop.preheader === undefined || loop.latches.size !== 1) {
			continue;
		}
		const latch = [...loop.latches][0]!;
		const incoming = cfg.predecessors[loop.header]!.filter(
			({ kind }) => kind === "ordinary",
		);
		const initialEdge = incoming.find(({ from }) => from === loop.preheader);
		const updateEdge = incoming.find(({ from }) => from === latch);
		if (initialEdge === undefined || updateEdge === undefined) continue;
		const header = fn.blocks[loop.header]!;
		for (const [parameterIndex, parameter] of header.parameters.entries()) {
			if (parameter.representation !== "f64" && parameter.representation !== "i32") {
				continue;
			}
			const initial = initialEdge.arguments[parameterIndex];
			const update = updateEdge.arguments[parameterIndex];
			if (initial === undefined || update === undefined) continue;
			const updateDefinition = definitions.get(root(update));
			if (
				updateDefinition === undefined ||
				locations.get(updateDefinition.id) !== latch ||
				representations.get(update) !== parameter.representation
			) {
				continue;
			}
			let step: number | undefined;
			if (
				updateDefinition.opcode === "unary" &&
				updateDefinition.inputs.length === 1 &&
				stripNumeric(updateDefinition.inputs[0]!) === root(parameter.value)
			) {
				if (updateDefinition.attributes.operator === "increment") step = 1;
				if (updateDefinition.attributes.operator === "decrement") step = -1;
			} else if (
				updateDefinition.opcode === "binary" &&
				updateDefinition.inputs.length === 2
			) {
				const operator = updateDefinition.attributes.operator;
				const [left, right] = updateDefinition.inputs;
				const leftRoot = stripNumeric(left!);
				const rightRoot = stripNumeric(right!);
				const leftConstant = exactNumber(left!, definitions, canonical);
				const rightConstant = exactNumber(right!, definitions, canonical);
				if (operator === "+" && leftRoot === root(parameter.value)) {
					step = rightConstant;
				} else if (operator === "+" && rightRoot === root(parameter.value)) {
					step = leftConstant;
				} else if (operator === "-" && leftRoot === root(parameter.value)) {
					step = rightConstant === undefined ? undefined : -rightConstant;
				}
			}
			if (step === undefined || !Number.isSafeInteger(step) || step === 0) continue;

			let comparison: CoreInductionVariable["comparison"];
			const terminator = header.terminator;
			if (terminator.kind === "branch") {
				const test = definitions.get(root(terminator.condition));
				let operator = comparisonOperator(test?.attributes.operator);
				if (
					test?.opcode === "binary" &&
					test.inputs.length === 2 &&
					operator !== undefined &&
					locations.get(test.id) === header.id
				) {
					let inductionOnLeft = root(test.inputs[0]!) === root(parameter.value);
					let bound = test.inputs[1]!;
					if (!inductionOnLeft && root(test.inputs[1]!) === root(parameter.value)) {
						inductionOnLeft = true;
						bound = test.inputs[0]!;
						operator = flipComparison(operator);
					}
					const consequentInside = loop.blocks.has(terminator.consequent.block);
					const alternateInside = loop.blocks.has(terminator.alternate.block);
					const boundBlock = valueBlocks.get(root(bound));
					if (
						inductionOnLeft &&
						boundBlock !== undefined &&
						consequentInside !== alternateInside
					) {
						if (!consequentInside) operator = negateComparison(operator);
						comparison = {
							instruction: test.id,
							operator,
							bound,
							boundLoopInvariant: !loop.blocks.has(boundBlock),
							body: consequentInside
								? terminator.consequent.block
								: terminator.alternate.block,
							exit: consequentInside
								? terminator.alternate.block
								: terminator.consequent.block,
						};
					}
				}
			}
			const range =
				comparison === undefined || !comparison.boundLoopInvariant
					? undefined
					: concreteRange(
							exactNumber(initial, definitions, canonical),
							exactNumber(comparison.bound, definitions, canonical),
							step,
							comparison.operator,
							parameter.representation,
						);
			inductions.push({
				loop,
				value: parameter.value,
				parameterIndex,
				initial,
				update,
				updateInstruction: updateDefinition.id,
				step,
				representation: parameter.representation,
				...(comparison === undefined ? {} : { comparison }),
				...(range === undefined ? {} : { range }),
			});
		}
	}
	const byRoot = new Map<CoreValueId, CoreInductionVariable>();
	const byUpdate = new Map<CoreValueId, CoreInductionVariable>();
	for (const induction of inductions) {
		byRoot.set(root(induction.value), induction);
		byUpdate.set(root(induction.update), induction);
	}
	const constantRanges = new Map<CoreValueId, CoreNumericRange>();
	let hasI32 = false;
	for (const value of fn.values) {
		if (value.representation === "i32") hasI32 = true;
		const exact = exactNumber(value.id, definitions, canonical);
		const range = exact === undefined ? undefined : numericRange(exact);
		if (range !== undefined) constantRanges.set(root(value.id), range);
	}
	const i32Range = numericRange(INT32_MINIMUM, INT32_MAXIMUM)!;
	const fullInductionRange = (
		induction: CoreInductionVariable,
	): CoreNumericRange | undefined =>
		induction.range === undefined
			? undefined
			: numericRange(
					Math.min(induction.range.minimum, induction.range.finalUpdate),
					Math.max(induction.range.maximum, induction.range.finalUpdate),
				);
	return {
		inductions,
		hasNumericRanges: hasI32 || inductions.length > 0,
		induction(value) {
			return byRoot.get(root(value));
		},
		range(value, block) {
			const resolved = root(value);
			const constant = constantRanges.get(resolved);
			if (constant !== undefined) return constant;
			const induction = byRoot.get(resolved);
			if (induction?.range !== undefined) {
				if (
					block !== undefined &&
					induction.comparison !== undefined &&
					cfg.dominates(induction.comparison.body, block)
				) {
					return induction.range;
				}
				return fullInductionRange(induction);
			}
			const update = byUpdate.get(resolved);
			if (update !== undefined) return fullInductionRange(update);
			return representations.get(value) === "i32" ? i32Range : undefined;
		},
	};
}
