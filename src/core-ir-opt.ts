import type { OptimizationAblation } from "./compiler-diagnostics.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import { verifyCoreFunction } from "./core-ir-verifier.ts";
import type {
	CoreBlock,
	CoreBlockId,
	CoreEdge,
	CoreFact,
	CoreFunction,
	CoreImmediate,
	CoreInstruction,
	CoreProgram,
	CoreTerminator,
	CoreValueId,
} from "./core-ir.ts";
import { coreBlockId } from "./core-ir.ts";

export interface CoreOptimizationOptions {
	readonly maxRounds?: number;
	readonly ablations?: ReadonlySet<OptimizationAblation>;
	/** Run Core's value simplifiers. Disable only while importing an already optimized graph. */
	readonly simplifyValues?: boolean;
}

function origin(
	value: CoreValueId,
	environment: ReadonlyMap<CoreValueId, CoreValueId>,
): CoreValueId {
	return environment.get(value) ?? value;
}

function enterEdge(
	fn: CoreFunction,
	edge: CoreEdge,
	environment: ReadonlyMap<CoreValueId, CoreValueId>,
): {
	readonly block: CoreBlock;
	readonly environment: ReadonlyMap<CoreValueId, CoreValueId>;
} {
	const block = fn.blocks[edge.block];
	if (block === undefined) throw new Error(`Unknown Core edge target ${edge.block}`);
	const next = new Map<CoreValueId, CoreValueId>();
	for (const [index, parameter] of block.parameters.entries()) {
		next.set(parameter.value, origin(edge.arguments[index]!, environment));
	}
	return { block, environment: next };
}

function exactNumberTest(
	block: CoreBlock,
	condition: CoreValueId,
	subject: CoreValueId,
	value: number,
	environment: ReadonlyMap<CoreValueId, CoreValueId>,
	instructions: ReadonlyArray<CoreInstruction>,
): boolean {
	if (instructions.length !== 2) return false;
	const [constant, compare] = instructions;
	return (
		constant?.opcode === "createNumber" &&
		instructionAttribute(constant, "value") === value &&
		constant.outputs.length === 1 &&
		compare?.opcode === "binary" &&
		instructionAttribute(compare, "operator") === "===" &&
		compare.outputs.length === 1 &&
		compare.outputs[0] === condition &&
		compare.inputs.length === 2 &&
		origin(compare.inputs[0]!, environment) === subject &&
		compare.inputs[1] === constant.outputs[0] &&
		block.terminator.kind === "branch"
	);
}

function edgeTerminatesWith(
	fn: CoreFunction,
	edge: CoreEdge,
	kind: "return" | "throw",
	value: CoreValueId,
	environment: ReadonlyMap<CoreValueId, CoreValueId>,
): boolean {
	const target = enterEdge(fn, edge, environment);
	return (
		target.block.instructions.length === 0 &&
		target.block.terminator.kind === kind &&
		origin(target.block.terminator.value, target.environment) === value
	);
}

function edgeReturnsUndefined(
	fn: CoreFunction,
	edge: CoreEdge,
	environment: ReadonlyMap<CoreValueId, CoreValueId>,
): boolean {
	let state = enterEdge(fn, edge, environment);
	const visited = new Set<CoreBlockId>();
	while (
		state.block.instructions.length === 0 &&
		state.block.terminator.kind === "jump"
	) {
		if (visited.has(state.block.id)) return false;
		visited.add(state.block.id);
		state = enterEdge(fn, state.block.terminator.edge, state.environment);
	}
	const [created] = state.block.instructions;
	return (
		state.block.instructions.length === 1 &&
		created?.opcode === "createUndefined" &&
		created.outputs.length === 1 &&
		state.block.terminator.kind === "return" &&
		state.block.terminator.value === created.outputs[0]
	);
}

/**
 * Prove the canonical synchronous-generator tail protocol in explicit CFG form.
 * The proof is intentionally exact: any cleanup, handler, additional use, or
 * observable continuation makes the yield resumable.
 */
const annotateTerminalYieldSites: CoreFunctionPass = {
	name: "annotate-terminal-yield-sites",
	run(fn) {
		if (
			!fn.isGenerator ||
			fn.isAsync ||
			fn.blocks.some(
				(block) =>
					block.handler !== undefined ||
					block.parameters.some(({ role }) => role === "exception"),
			)
		) {
			return fn;
		}
		const terminal = new Set<number>();
		for (const block of fn.blocks) {
			if (block.terminator.kind !== "branch") continue;
			for (const [index, instruction] of block.instructions.entries()) {
				if (
					instruction.opcode !== "yield" ||
					instruction.outputs.length !== 2 ||
					instruction.inputs.length !== 1
				) {
					continue;
				}
				const [yieldedValue, resumeMode] = instruction.outputs;
				const rootEnvironment = new Map<CoreValueId, CoreValueId>();
				if (
					!exactNumberTest(
						block,
						block.terminator.condition,
						resumeMode!,
						1,
						rootEnvironment,
						block.instructions.slice(index + 1),
					) ||
					!edgeTerminatesWith(
						fn,
						block.terminator.consequent,
						"throw",
						yieldedValue!,
						rootEnvironment,
					)
				) {
					continue;
				}
				const resumed = enterEdge(fn, block.terminator.alternate, rootEnvironment);
				if (resumed.block.terminator.kind !== "branch") continue;
				if (
					!exactNumberTest(
						resumed.block,
						resumed.block.terminator.condition,
						resumeMode!,
						2,
						resumed.environment,
						resumed.block.instructions,
					) ||
					!edgeTerminatesWith(
						fn,
						resumed.block.terminator.consequent,
						"return",
						yieldedValue!,
						resumed.environment,
					) ||
					!edgeReturnsUndefined(
						fn,
						resumed.block.terminator.alternate,
						resumed.environment,
					)
				) {
					continue;
				}
				if (instructionAttribute(instruction, "terminal") !== true) {
					terminal.add(instruction.id);
				}
			}
		}
		if (terminal.size === 0) return fn;
		return {
			...fn,
			blocks: fn.blocks.map((block) => ({
				...block,
				instructions: block.instructions.map((instruction) => {
					if (!terminal.has(instruction.id)) return instruction;
					return {
						...instruction,
						attributes: { ...instruction.attributes, terminal: true },
					};
				}),
			})),
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

/** Fold an exact string SSA value into the property operation's attributes. */
const foldStaticPropertyKeys: CoreFunctionPass = {
	name: "fold-static-property-keys",
	ablation: "static-properties",
	run(fn) {
		const strings = new Map<CoreValueId, number>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const stringIndex = instructionAttribute(instruction, "stringIndex");
				if (
					instruction.opcode === "createString" &&
					instruction.outputs.length === 1 &&
					typeof stringIndex === "number"
				) {
					strings.set(instruction.outputs[0]!, stringIndex);
				}
			}
		}
		let changed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					if (
						(instruction.opcode !== "loadProperty" &&
							instruction.opcode !== "storeProperty") ||
						instruction.inputs.length < 2
					) {
						return instruction;
					}
					const stringIndex = strings.get(instruction.inputs[1]!);
					if (stringIndex === undefined) return instruction;
					changed = true;
					return {
						...instruction,
						opcode:
							instruction.opcode === "loadProperty"
								? "loadPropertyStatic"
								: "storePropertyStatic",
						inputs: instruction.inputs.filter((_, index) => index !== 1),
						attributes: { ...instruction.attributes, stringIndex },
					};
				}),
			}),
		);
		return changed ? { ...fn, blocks, mutationEpoch: fn.mutationEpoch + 1 } : fn;
	},
};

export interface CoreOptimizationResult {
	readonly program: CoreProgram;
	readonly changed: boolean;
	readonly passes: ReadonlyArray<{
		readonly name: string;
		readonly round: number;
		readonly changed: boolean;
	}>;
}

interface CoreFunctionPass {
	readonly name: string;
	readonly ablation?: OptimizationAblation;
	/** Block identity is part of a region certificate until CFG regions migrate. */
	readonly changesControlFlow?: boolean;
	run(fn: CoreFunction, analyses: CoreAnalysisManager): CoreFunction;
}

function instructionAttribute(instruction: CoreInstruction, name: string): unknown {
	return instruction.attributes[name];
}

/** Per-function analysis cache keyed by the immutable function snapshot. */
export class CoreAnalysisManager {
	readonly #controlFlow = new WeakMap<CoreFunction, CoreControlFlow>();

	controlFlow(fn: CoreFunction): CoreControlFlow {
		let analysis = this.#controlFlow.get(fn);
		if (analysis === undefined) {
			analysis = buildCoreControlFlow(fn, coreOpcodeRegistry);
			this.#controlFlow.set(fn, analysis);
		}
		return analysis;
	}
}

function resolveValue(
	value: CoreValueId,
	replacements: ReadonlyMap<CoreValueId, CoreValueId>,
): CoreValueId {
	let current = value;
	const seen = new Set<CoreValueId>();
	while (replacements.has(current)) {
		if (seen.has(current)) throw new Error(`Cyclic Core value replacement at ${current}`);
		seen.add(current);
		current = replacements.get(current)!;
	}
	return current;
}

function rewriteEdge(
	edge: CoreEdge,
	replacements: ReadonlyMap<CoreValueId, CoreValueId>,
): CoreEdge {
	return {
		...edge,
		arguments: edge.arguments.map((value) => resolveValue(value, replacements)),
	};
}

function rewriteTerminator(
	terminator: CoreTerminator,
	replacements: ReadonlyMap<CoreValueId, CoreValueId>,
): CoreTerminator {
	switch (terminator.kind) {
		case "jump":
			return { ...terminator, edge: rewriteEdge(terminator.edge, replacements) };
		case "branch":
			return {
				...terminator,
				condition: resolveValue(terminator.condition, replacements),
				consequent: rewriteEdge(terminator.consequent, replacements),
				alternate: rewriteEdge(terminator.alternate, replacements),
			};
		case "guard":
			return {
				...terminator,
				condition: resolveValue(terminator.condition, replacements),
				success: rewriteEdge(terminator.success, replacements),
				fallback: rewriteEdge(terminator.fallback, replacements),
			};
		case "switch":
			return {
				...terminator,
				discriminant: resolveValue(terminator.discriminant, replacements),
				cases: terminator.cases.map((entry) => ({
					...entry,
					edge: rewriteEdge(entry.edge, replacements),
				})),
				default: rewriteEdge(terminator.default, replacements),
			};
		case "return":
		case "throw":
			return { ...terminator, value: resolveValue(terminator.value, replacements) };
		case "unreachable":
			return terminator;
	}
}

function rewriteFunction(
	fn: CoreFunction,
	blocks: ReadonlyArray<CoreBlock>,
	replacements: ReadonlyMap<CoreValueId, CoreValueId>,
	removedInstructions: ReadonlySet<number>,
): CoreFunction {
	const removedValues = new Set(replacements.keys());
	return {
		...fn,
		blocks: blocks.map((block) => ({
			...block,
			instructions: block.instructions
				.filter(({ id }) => !removedInstructions.has(id))
				.map((instruction) => ({
					...instruction,
					inputs: instruction.inputs.map((value) => resolveValue(value, replacements)),
				})),
			terminator: rewriteTerminator(block.terminator, replacements),
			...(block.handler === undefined
				? {}
				: {
						handler: {
							...block.handler,
							arguments: block.handler.arguments.map((value) =>
								resolveValue(value, replacements),
							),
						},
					}),
		})),
		values: fn.values.filter(({ id }) => !removedValues.has(id)),
		mutationEpoch: fn.mutationEpoch + 1,
	};
}

function stableAttributeValue(value: unknown): string {
	if (value === undefined) return "u";
	if (value === null) return "n";
	if (typeof value === "boolean") return value ? "b1" : "b0";
	if (typeof value === "number") {
		if (Number.isNaN(value)) return "dNaN";
		if (Object.is(value, -0)) return "d-0";
		if (value === Number.POSITIVE_INFINITY) return "d+Inf";
		if (value === Number.NEGATIVE_INFINITY) return "d-Inf";
		return `d${value}`;
	}
	if (typeof value === "string") return `s${JSON.stringify(value)}`;
	if (Array.isArray(value)) {
		const arrayValue: ReadonlyArray<unknown> = value;
		return `[${arrayValue.map(stableAttributeValue).join(",")}]`;
	}
	if (typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableAttributeValue(entry)}`)
			.join(",")}}`;
	}
	throw new Error(`Unsupported Core attribute key value ${typeof value}`);
}

function stableAttributes(instruction: CoreInstruction): string {
	return stableAttributeValue(instruction.attributes);
}

function constantImmediate(instruction: CoreInstruction): CoreImmediate | undefined {
	switch (instruction.opcode) {
		case "createUndefined":
			return { kind: "undefined" };
		case "createNull":
			return { kind: "null" };
		case "createBoolean":
			return typeof instructionAttribute(instruction, "value") === "boolean"
				? {
						kind: "boolean",
						value: instructionAttribute(instruction, "value") as boolean,
					}
				: undefined;
		case "createNumber":
		case "createF64":
			return typeof instructionAttribute(instruction, "value") === "number"
				? {
						kind: "number",
						value: instructionAttribute(instruction, "value") as number,
					}
				: undefined;
		case "createString":
			return typeof instructionAttribute(instruction, "stringIndex") === "number"
				? {
						kind: "string",
						index: instructionAttribute(instruction, "stringIndex") as number,
					}
				: undefined;
		default:
			return undefined;
	}
}

function primitiveTruthy(value: CoreImmediate): boolean | undefined {
	switch (value.kind) {
		case "undefined":
		case "null":
			return false;
		case "boolean":
			return value.value;
		case "number":
			return value.value !== 0 && !Number.isNaN(value.value);
		case "string":
			return undefined;
	}
}

function primitiveNumber(value: CoreImmediate): number | undefined {
	switch (value.kind) {
		case "undefined":
			return Number.NaN;
		case "null":
			return 0;
		case "boolean":
			return value.value ? 1 : 0;
		case "number":
			return value.value;
		case "string":
			return undefined;
	}
}

function foldUnaryPrimitive(
	operator: unknown,
	operand: CoreImmediate,
): CoreImmediate | undefined {
	switch (operator) {
		case "!": {
			const truthy = primitiveTruthy(operand);
			return truthy === undefined ? undefined : { kind: "boolean", value: !truthy };
		}
		case "+":
		case "-":
		case "~": {
			const numeric = primitiveNumber(operand);
			if (numeric === undefined) return undefined;
			return {
				kind: "number",
				value: operator === "+" ? numeric : operator === "-" ? -numeric : ~numeric,
			};
		}
		default:
			return undefined;
	}
}

function foldNumericBinary(
	operator: unknown,
	left: number,
	right: number,
): CoreImmediate | undefined {
	switch (operator) {
		case "+":
			return { kind: "number", value: left + right };
		case "-":
			return { kind: "number", value: left - right };
		case "*":
			return { kind: "number", value: left * right };
		case "/":
			return { kind: "number", value: left / right };
		case "%":
			return { kind: "number", value: left % right };
		case "&":
			return { kind: "number", value: left & right };
		case "|":
			return { kind: "number", value: left | right };
		case "^":
			return { kind: "number", value: left ^ right };
		case "<<":
			return { kind: "number", value: left << right };
		case ">>":
			return { kind: "number", value: left >> right };
		case ">>>":
			return { kind: "number", value: left >>> right };
		case "<":
			return { kind: "boolean", value: left < right };
		case "<=":
			return { kind: "boolean", value: left <= right };
		case ">":
			return { kind: "boolean", value: left > right };
		case ">=":
			return { kind: "boolean", value: left >= right };
		case "==":
		case "===":
			return { kind: "boolean", value: left === right };
		case "!=":
		case "!==":
			return { kind: "boolean", value: left !== right };
		default:
			// Exponentiation remains runtime-evaluated so host/self-host compilers
			// cannot disagree on serialized transcendental f64 bits.
			return undefined;
	}
}

function foldPrimitiveBinary(
	operator: unknown,
	left: CoreImmediate,
	right: CoreImmediate,
): CoreImmediate | undefined {
	if (left.kind === "number" && right.kind === "number") {
		return foldNumericBinary(operator, left.value, right.value);
	}
	if (operator !== "===" && operator !== "!==" && operator !== "==" && operator !== "!=") {
		return undefined;
	}
	const loose = operator === "==" || operator === "!=";
	let equal = false;
	if (left.kind === right.kind) {
		equal = immediateStrictEquals(left, right);
	} else if (loose) {
		if (
			(left.kind === "null" && right.kind === "undefined") ||
			(left.kind === "undefined" && right.kind === "null")
		) {
			equal = true;
		} else {
			const leftNumber = primitiveNumber(left);
			const rightNumber = primitiveNumber(right);
			equal =
				leftNumber !== undefined &&
				rightNumber !== undefined &&
				leftNumber === rightNumber;
		}
	}
	return {
		kind: "boolean",
		value: operator === "!==" || operator === "!=" ? !equal : equal,
	};
}

function foldedInstruction(
	instruction: CoreInstruction,
	value: CoreImmediate,
): { readonly instruction: CoreInstruction; readonly representation: "boxed" | "f64" | "boolean" } | undefined {
	const common = {
		...instruction,
		inputs: [],
	};
	switch (value.kind) {
		case "undefined":
			return {
				instruction: { ...common, opcode: "createUndefined", attributes: {} },
				representation: "boxed",
			};
		case "null":
			return {
				instruction: { ...common, opcode: "createNull", attributes: {} },
				representation: "boxed",
			};
		case "boolean":
			return {
				instruction: {
					...common,
					opcode: "createBoolean",
					attributes: { value: value.value },
				},
				representation: "boolean",
			};
		case "number":
			return {
				instruction: {
					...common,
					opcode: "createF64",
					attributes: { value: value.value },
				},
				representation: "f64",
			};
		case "string":
			return undefined;
	}
}

const foldPrimitiveConstants: CoreFunctionPass = {
	name: "fold-primitive-constants",
	ablation: "constant-folding",
	run(fn) {
		const constants = new Map<CoreValueId, CoreImmediate>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.outputs.length !== 1) continue;
				const value = constantImmediate(instruction);
				if (value !== undefined) constants.set(instruction.outputs[0]!, value);
			}
		}
		const representations = new Map<CoreValueId, "boxed" | "f64" | "boolean">();
		let changed = false;
		const blocks = fn.blocks.map((block): CoreBlock => ({
			...block,
			instructions: block.instructions.map((instruction) => {
				if (instruction.outputs.length !== 1) return instruction;
				let result: CoreImmediate | undefined;
				if (instruction.opcode === "unary" && instruction.inputs.length === 1) {
					const operand = constants.get(instruction.inputs[0]!);
					if (operand !== undefined) {
						result = foldUnaryPrimitive(
							instructionAttribute(instruction, "operator"),
							operand,
						);
					}
				} else if (instruction.opcode === "binary" && instruction.inputs.length === 2) {
					const left = constants.get(instruction.inputs[0]!);
					const right = constants.get(instruction.inputs[1]!);
					if (left !== undefined && right !== undefined) {
						result = foldPrimitiveBinary(
							instructionAttribute(instruction, "operator"),
							left,
							right,
						);
					}
				}
				if (result === undefined) return instruction;
				const replacement = foldedInstruction(instruction, result);
				if (replacement === undefined) return instruction;
				changed = true;
				constants.set(instruction.outputs[0]!, result);
				representations.set(instruction.outputs[0]!, replacement.representation);
				return replacement.instruction;
			}),
		}));
		if (!changed) return fn;
		return {
			...fn,
			blocks,
			values: fn.values.map((value) => {
				const representation = representations.get(value.id);
				return representation === undefined ? value : { ...value, representation };
			}),
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

function immediateTruthiness(value: CoreImmediate): boolean | undefined {
	switch (value.kind) {
		case "undefined":
		case "null":
			return false;
		case "boolean":
			return value.value;
		case "number":
			return value.value !== 0 && !Number.isNaN(value.value);
		case "string":
			// The canonical string table does not yet expose contents to Core.
			return undefined;
	}
}

function immediateStrictEquals(left: CoreImmediate, right: CoreImmediate): boolean {
	if (left.kind !== right.kind) return false;
	switch (left.kind) {
		case "undefined":
		case "null":
			return true;
		case "boolean":
			return left.value === (right as Extract<CoreImmediate, { kind: "boolean" }>).value;
		case "number":
			return left.value === (right as Extract<CoreImmediate, { kind: "number" }>).value;
		case "string":
			return left.index === (right as Extract<CoreImmediate, { kind: "string" }>).index;
	}
}

function remapEdge(
	edge: CoreEdge,
	blocks: ReadonlyMap<CoreBlockId, CoreBlockId>,
): CoreEdge {
	const block = blocks.get(edge.block);
	if (block === undefined) throw new Error(`Cannot retain edge to removed Core block ${edge.block}`);
	return { ...edge, block };
}

function remapBlockTerminator(
	terminator: CoreTerminator,
	blocks: ReadonlyMap<CoreBlockId, CoreBlockId>,
): CoreTerminator {
	switch (terminator.kind) {
		case "jump":
			return { ...terminator, edge: remapEdge(terminator.edge, blocks) };
		case "branch":
			return {
				...terminator,
				consequent: remapEdge(terminator.consequent, blocks),
				alternate: remapEdge(terminator.alternate, blocks),
			};
		case "guard":
			return {
				...terminator,
				success: remapEdge(terminator.success, blocks),
				fallback: remapEdge(terminator.fallback, blocks),
			};
		case "switch":
			return {
				...terminator,
				cases: terminator.cases.map((entry) => ({
					...entry,
					edge: remapEdge(entry.edge, blocks),
				})),
				default: remapEdge(terminator.default, blocks),
			};
		case "return":
		case "throw":
		case "unreachable":
			return terminator;
	}
}

function factSurvivesBlockRemoval(
	fact: CoreFact,
	liveInstructions: ReadonlySet<number>,
): boolean {
	if (
		fact.validity.kind === "guard" &&
		!liveInstructions.has(fact.validity.instruction)
	) {
		return false;
	}
	return fact.obligations.every(
		(obligation) =>
			obligation.kind !== "guard" || liveInstructions.has(obligation.instruction),
	);
}

function removeUnreachableBlocks(fn: CoreFunction): CoreFunction {
	const cfg = buildCoreControlFlow(fn, coreOpcodeRegistry);
	if (cfg.reachable.size === fn.blocks.length) return fn;
	const blockIds = new Map<CoreBlockId, CoreBlockId>();
	for (const block of fn.blocks) {
		if (cfg.reachable.has(block.id)) blockIds.set(block.id, coreBlockId(blockIds.size));
	}
	const liveInstructions = new Set<number>();
	for (const block of fn.blocks) {
		if (!cfg.reachable.has(block.id)) continue;
		for (const instruction of block.instructions) liveInstructions.add(instruction.id);
		liveInstructions.add(block.terminator.id);
	}
	const blocks = fn.blocks
		.filter((block) => cfg.reachable.has(block.id))
		.map((block): CoreBlock => {
			const id = blockIds.get(block.id)!;
			const handlerTarget =
				block.handler === undefined ? undefined : blockIds.get(block.handler.block);
			return {
				...block,
				id,
				terminator: remapBlockTerminator(block.terminator, blockIds),
				...(handlerTarget === undefined
					? { handler: undefined }
					: { handler: { ...block.handler!, block: handlerTarget } }),
			};
		});
	const values = fn.values
		.filter((value) =>
			value.definition.kind === "block-parameter"
				? blockIds.has(value.definition.block)
				: liveInstructions.has(value.definition.instruction),
		)
		.map((value) =>
			value.definition.kind !== "block-parameter"
				? value
				: {
						...value,
						definition: {
							...value.definition,
							block: blockIds.get(value.definition.block)!,
						},
					},
		);
	const entry = blockIds.get(fn.entry);
	if (entry === undefined) throw new Error("Core entry block became unreachable");
	const bodyEntry =
		fn.bodyEntry === undefined ? undefined : blockIds.get(fn.bodyEntry);
	return {
		...fn,
		entry,
		...(bodyEntry === undefined ? { bodyEntry: undefined } : { bodyEntry }),
		blocks,
		values,
		facts: fn.facts.filter((fact) => factSurvivesBlockRemoval(fact, liveInstructions)),
		mutationEpoch: fn.mutationEpoch + 1,
	};
}

/** Resolve primitive branches and switches, then restore Core's dense reachable CFG. */
const simplifyControlFlow: CoreFunctionPass = {
	name: "simplify-control-flow",
	changesControlFlow: true,
	run(fn) {
		const constants = new Map<CoreValueId, CoreImmediate>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.outputs.length !== 1) continue;
				const value = constantImmediate(instruction);
				if (value !== undefined) constants.set(instruction.outputs[0]!, value);
			}
		}
		let changed = false;
		const blocks = fn.blocks.map((block): CoreBlock => {
			const terminator = block.terminator;
			if (terminator.kind === "branch") {
				const condition = constants.get(terminator.condition);
				const truthy = condition === undefined ? undefined : immediateTruthiness(condition);
				if (truthy === undefined) return block;
				changed = true;
				return {
					...block,
					terminator: {
						kind: "jump",
						id: terminator.id,
						edge: truthy ? terminator.consequent : terminator.alternate,
						...(terminator.sourcePosition === undefined
							? {}
							: { sourcePosition: terminator.sourcePosition }),
					},
				};
			}
			if (terminator.kind === "switch") {
				const discriminant = constants.get(terminator.discriminant);
				if (discriminant === undefined) return block;
				const matched = terminator.cases.find(({ value }) =>
					immediateStrictEquals(discriminant, value),
				);
				changed = true;
				return {
					...block,
					terminator: {
						kind: "jump",
						id: terminator.id,
						edge: matched?.edge ?? terminator.default,
						...(terminator.sourcePosition === undefined
							? {}
							: { sourcePosition: terminator.sourcePosition }),
					},
				};
			}
			return block;
		});
		if (!changed) return fn;
		return removeUnreachableBlocks({
			...fn,
			blocks,
			mutationEpoch: fn.mutationEpoch + 1,
		});
	},
};

const VALUE_NUMBERED_OPCODES = new Set([
	"createBigint",
	"createBoolean",
	"createEmpty",
	"createF64",
	"createNull",
	"createNumber",
	"createString",
	"createUndefined",
	"mathBinaryNumber",
	"mathUnaryNumber",
]);

const copyAndValueNumber: CoreFunctionPass = {
	name: "copy-and-value-number",
	ablation: "constant-folding",
	run(fn) {
		const replacements = new Map<CoreValueId, CoreValueId>();
		const removedInstructions = new Set<number>();
		const blocks = fn.blocks.map((block): CoreBlock => {
			const available = new Map<string, ReadonlyArray<CoreValueId>>();
			const instructions: Array<CoreInstruction> = [];
			for (const original of block.instructions) {
				const instruction: CoreInstruction = {
					...original,
					inputs: original.inputs.map((value) => resolveValue(value, replacements)),
				};
				if (
					instruction.opcode === "move" &&
					instruction.inputs.length === 1 &&
					instruction.outputs.length === 1
				) {
					replacements.set(instruction.outputs[0]!, instruction.inputs[0]!);
					removedInstructions.add(instruction.id);
					continue;
				}
				if (VALUE_NUMBERED_OPCODES.has(instruction.opcode)) {
					const key = `${instruction.opcode}\0${instruction.inputs.join(",")}\0${stableAttributes(instruction)}`;
					const previous = available.get(key);
					if (previous !== undefined && previous.length === instruction.outputs.length) {
						for (const [index, output] of instruction.outputs.entries()) {
							replacements.set(output, previous[index]!);
						}
						removedInstructions.add(instruction.id);
						continue;
					}
					available.set(key, instruction.outputs);
				}
				instructions.push(instruction);
			}
			return { ...block, instructions };
		});
		if (removedInstructions.size === 0) return fn;
		return rewriteFunction(fn, blocks, replacements, removedInstructions);
	},
};

function collectUses(fn: CoreFunction): Set<CoreValueId> {
	const uses = new Set<CoreValueId>();
	const addEdge = (edge: CoreEdge) => {
		for (const value of edge.arguments) uses.add(value);
	};
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			for (const input of instruction.inputs) uses.add(input);
		}
		if (block.handler !== undefined) {
			for (const value of block.handler.arguments) uses.add(value);
		}
		switch (block.terminator.kind) {
			case "jump":
				addEdge(block.terminator.edge);
				break;
			case "branch":
				uses.add(block.terminator.condition);
				addEdge(block.terminator.consequent);
				addEdge(block.terminator.alternate);
				break;
			case "guard":
				uses.add(block.terminator.condition);
				addEdge(block.terminator.success);
				addEdge(block.terminator.fallback);
				break;
			case "switch":
				uses.add(block.terminator.discriminant);
				for (const { edge } of block.terminator.cases) addEdge(edge);
				addEdge(block.terminator.default);
				break;
			case "return":
			case "throw":
				uses.add(block.terminator.value);
				break;
			case "unreachable":
				break;
		}
	}
	return uses;
}

const deadInstructionElimination: CoreFunctionPass = {
	name: "dead-instruction-elimination",
	run(fn) {
		const uses = collectUses(fn);
		const removedInstructions = new Set<number>();
		const removedValues = new Map<CoreValueId, CoreValueId>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					instruction.outputs.length > 0 &&
					instruction.outputs.every((output) => !uses.has(output)) &&
					coreOpcodeRegistry.require(instruction.opcode).discardable
				) {
					removedInstructions.add(instruction.id);
					for (const output of instruction.outputs) removedValues.set(output, output);
				}
			}
		}
		if (removedInstructions.size === 0) return fn;
		const removed = new Set(removedValues.keys());
		return {
			...fn,
			blocks: fn.blocks.map((block) => ({
				...block,
				instructions: block.instructions.filter(({ id }) => !removedInstructions.has(id)),
			})),
			values: fn.values.filter(({ id }) => !removed.has(id)),
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

/** Merge one dominance-safe linear edge at a time, substituting block arguments. */
const combineLinearBlocks: CoreFunctionPass = {
	name: "combine-linear-blocks",
	changesControlFlow: true,
	run(fn, analyses) {
		const cfg = analyses.controlFlow(fn);
		for (const predecessor of fn.blocks) {
			if (predecessor.handler !== undefined || predecessor.terminator.kind !== "jump") {
				continue;
			}
			const targetId = predecessor.terminator.edge.block;
			if (
				targetId === predecessor.id ||
				targetId === fn.entry ||
				targetId === fn.bodyEntry
			) {
				continue;
			}
			const target = fn.blocks[targetId];
			if (target === undefined || target.handler !== undefined) continue;
			const incoming = cfg.predecessors[targetId]!;
			if (
				incoming.length !== 1 ||
				incoming[0]!.kind !== "ordinary" ||
				incoming[0]!.from !== predecessor.id
			) {
				continue;
			}
			const replacements = new Map<CoreValueId, CoreValueId>();
			for (const [index, parameter] of target.parameters.entries()) {
				replacements.set(
					parameter.value,
					predecessor.terminator.edge.arguments[index]!,
				);
			}
			const merged: CoreBlock = {
				...predecessor,
				instructions: [
					...predecessor.instructions,
					...target.instructions.map((instruction) => ({
						...instruction,
						inputs: instruction.inputs.map((value) =>
							resolveValue(value, replacements),
						),
					})),
				],
				terminator: rewriteTerminator(target.terminator, replacements),
			};
			const blocks = fn.blocks.map((block) =>
				block.id === predecessor.id ? merged : block,
			);
			return removeUnreachableBlocks({
				...fn,
				blocks,
				mutationEpoch: fn.mutationEpoch + 1,
			});
		}
		return fn;
	},
};

const CORE_PASSES: ReadonlyArray<CoreFunctionPass> = [
	annotateTerminalYieldSites,
	foldPrimitiveConstants,
	simplifyControlFlow,
	combineLinearBlocks,
	foldStaticPropertyKeys,
	copyAndValueNumber,
	deadInstructionElimination,
];

function claimedInstructionSnapshots(fn: CoreFunction): ReadonlyMap<number, string> {
	const claimed = new Set(
		fn.regions.flatMap(({ claimedInstructions }) => claimedInstructions),
	);
	if (claimed.size === 0) return new Map();
	const snapshots = new Map<number, string>();
	for (const block of fn.blocks) {
		for (const instruction of [...block.instructions, block.terminator]) {
			if (!claimed.has(instruction.id)) continue;
			snapshots.set(
				instruction.id,
				`${block.id}\0${stableAttributeValue(instruction)}`,
			);
		}
	}
	return snapshots;
}

function preservesClaimedInstructions(
	before: ReadonlyMap<number, string>,
	fn: CoreFunction,
): boolean {
	if (before.size === 0) return true;
	const after = claimedInstructionSnapshots(fn);
	if (after.size !== before.size) return false;
	for (const [instruction, snapshot] of before) {
		if (after.get(instruction) !== snapshot) return false;
	}
	return true;
}

export function executeCoreOptimizations(
	program: CoreProgram,
	options: CoreOptimizationOptions = {},
): CoreOptimizationResult {
	const maxRounds = options.maxRounds ?? 8;
	if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
		throw new Error(`Invalid Core optimization round limit ${maxRounds}`);
	}
	const analyses = new CoreAnalysisManager();
	const traces: Array<{ name: string; round: number; changed: boolean }> = [];
	let changed = false;
	let functions = [...program.functions];
	for (let round = 0; round < maxRounds; round++) {
		let roundChanged = false;
		for (const pass of CORE_PASSES) {
			if (
				options.simplifyValues === false &&
				(pass === copyAndValueNumber || pass === deadInstructionElimination)
			) {
				for (const _fn of functions) {
					traces.push({ name: pass.name, round, changed: false });
				}
				continue;
			}
			if (pass.ablation !== undefined && options.ablations?.has(pass.ablation) === true) {
				for (const _fn of functions) {
					traces.push({ name: pass.name, round, changed: false });
				}
				continue;
			}
			functions = functions.map((fn) => {
				if (fn.regions.length > 0 && pass.changesControlFlow === true) {
					traces.push({ name: pass.name, round, changed: false });
					return fn;
				}
				const claimed = claimedInstructionSnapshots(fn);
				const candidate = pass.run(fn, analyses);
				const next = preservesClaimedInstructions(claimed, candidate) ? candidate : fn;
				const passChanged = next !== fn;
				traces.push({ name: pass.name, round, changed: passChanged });
				if (passChanged) {
					verifyCoreFunction(next, coreOpcodeRegistry);
					roundChanged = true;
					changed = true;
				}
				return next;
			});
		}
		if (!roundChanged) break;
	}
	return {
		program: { ...program, functions },
		changed,
		passes: traces,
	};
}
