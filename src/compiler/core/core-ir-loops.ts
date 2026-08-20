/**
 * Reusable induction and range facts over canonical Core loops.
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

export interface CoreInductionRange {
	readonly minimum: number;
	readonly maximum: number;
	readonly iterations: number;
	readonly exactSafeIntegers: true;
	readonly excludesNegativeZero: true;
}

export interface CoreInductionVariable {
	readonly loop: CoreNaturalLoop;
	readonly value: CoreValueId;
	readonly parameterIndex: number;
	readonly initial: CoreValueId;
	readonly update: CoreValueId;
	readonly updateInstruction: CoreInstructionId;
	readonly step: number;
	readonly representation: "f64";
	readonly comparison?: {
		readonly instruction: CoreInstructionId;
		readonly operator: CoreLoopComparison;
		readonly bound: CoreValueId;
		readonly body: CoreBlockId;
		readonly exit: CoreBlockId;
	};
	readonly range?: CoreInductionRange;
}

export interface CoreLoopInductionAnalysis {
	readonly inductions: ReadonlyArray<CoreInductionVariable>;
	induction(value: CoreValueId): CoreInductionVariable | undefined;
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
	const firstNumber = Number(start);
	const lastNumber = Number(last);
	return {
		minimum: Math.min(firstNumber, lastNumber),
		maximum: Math.max(firstNumber, lastNumber),
		iterations: Number(iterations),
		exactSafeIntegers: true,
		excludesNegativeZero: true,
	};
}

/** Analyze canonical f64 block-argument recurrences in O(values + loop headers). */
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
			representations.get(definition.inputs[0]!) === "f64"
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
			if (parameter.representation !== "f64") continue;
			const initial = initialEdge.arguments[parameterIndex];
			const update = updateEdge.arguments[parameterIndex];
			if (initial === undefined || update === undefined) continue;
			const updateDefinition = definitions.get(root(update));
			if (
				updateDefinition === undefined ||
				locations.get(updateDefinition.id) !== latch ||
				representations.get(update) !== "f64"
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
						!loop.blocks.has(boundBlock) &&
						consequentInside !== alternateInside
					) {
						if (!consequentInside) operator = negateComparison(operator);
						comparison = {
							instruction: test.id,
							operator,
							bound,
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
				comparison === undefined
					? undefined
					: concreteRange(
							exactNumber(initial, definitions, canonical),
							exactNumber(comparison.bound, definitions, canonical),
							step,
							comparison.operator,
						);
			inductions.push({
				loop,
				value: parameter.value,
				parameterIndex,
				initial,
				update,
				updateInstruction: updateDefinition.id,
				step,
				representation: "f64",
				...(comparison === undefined ? {} : { comparison }),
				...(range === undefined ? {} : { range }),
			});
		}
	}
	const byRoot = new Map<CoreValueId, CoreInductionVariable>();
	for (const induction of inductions) byRoot.set(root(induction.value), induction);
	return {
		inductions,
		induction(value) {
			return byRoot.get(root(value));
		},
	};
}
