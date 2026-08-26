/**
 * Closed primitive-kind flow for native ABI selection.
 *
 * This lattice deliberately describes JavaScript kinds, not physical registers.
 * A value may remain boxed in canonical Core while a closed call edge proves that
 * one direct native entry always receives a Number or Boolean. Native lowering
 * can then emit a typed variant without changing the generic ECMAScript call ABI.
 */

import type { CoreCompilationContext } from "./core-compilation.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import {
	analyzeCoreInterproceduralValueFlow,
	corePositionalCallArguments,
} from "./core-ir-interprocedural-flow.ts";
import { coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import { analyzeCoreProgramSummaries } from "./core-ir-summaries.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import {
	CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE,
	coreNumericTypedArrayKind,
} from "./core-ir-value-classes.ts";
import type {
	CoreFunction,
	CoreInstruction,
	CoreProgram,
	CoreValueId,
} from "./core-ir.ts";

export const CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE =
	"exactCallArgumentRepresentations";

export type CoreExactScalarKind = "number" | "boolean";
export type CoreExactCallArgumentRepresentation = "boxed" | CoreExactScalarKind;

const KIND_UNDEFINED = 1 << 0;
const KIND_NULL = 1 << 1;
const KIND_BOOLEAN = 1 << 2;
const KIND_NUMBER = 1 << 3;
const KIND_STRING = 1 << 4;
const KIND_BIGINT = 1 << 5;
const KIND_SYMBOL = 1 << 6;
const KIND_OBJECT = 1 << 7;
const KIND_TOP =
	KIND_UNDEFINED |
	KIND_NULL |
	KIND_BOOLEAN |
	KIND_NUMBER |
	KIND_STRING |
	KIND_BIGINT |
	KIND_SYMBOL |
	KIND_OBJECT;

interface KindTransfer {
	readonly inputs: ReadonlyArray<number>;
	readonly output: number;
	readonly evaluate: (inputs: ReadonlyArray<number>) => number;
}

export interface CoreValueKindAnalysis {
	exactScalar(functionIndex: number, value: CoreValueId): CoreExactScalarKind | undefined;
}

function valueLimit(fn: CoreFunction): number {
	let limit = 0;
	for (const { id } of fn.values) limit = Math.max(limit, id + 1);
	return limit;
}

function capturedKey(owner: number, index: number): string {
	return `${owner}:${index}`;
}

const NUMERIC_UNARY_OPERATORS: ReadonlySet<string> = new Set([
	"-",
	"+",
	"~",
	"increment",
	"decrement",
]);

const NUMERIC_BINARY_OPERATORS: ReadonlySet<string> = new Set([
	"+",
	"-",
	"*",
	"/",
	"%",
	"**",
	"&",
	"|",
	"^",
	"<<",
	">>",
	">>>",
]);

function staticOutputKind(
	instruction: CoreInstruction,
	representation: CoreFunction["values"][number]["representation"] | undefined,
): number | undefined {
	if (representation === "f64" || representation === "i32") return KIND_NUMBER;
	if (representation === "boolean") return KIND_BOOLEAN;
	switch (instruction.opcode) {
		case "createEmpty":
			// The sentinel has no ordinary ECMAScript kind. A path that observes it
			// throws at its TDZ check before entering a script call.
			return 0;
		case "createUndefined":
			return KIND_UNDEFINED;
		case "createNull":
			return KIND_NULL;
		case "createBoolean":
			return KIND_BOOLEAN;
		case "createF64":
		case "createNumber":
			return KIND_NUMBER;
		case "createString":
			return KIND_STRING;
		case "createBigint":
			return KIND_BIGINT;
		case "createFunction":
		case "createArray":
		case "createObject":
		case "createObjectShaped":
		case "createModuleNamespace":
		case "createTemplateObject":
		case "instantiateLiteralTemplate":
			return KIND_OBJECT;
		case "createPrivateName":
		case "createPrivateNames":
			return KIND_SYMBOL;
		case "loadProperty":
			return coreNumericTypedArrayKind(
				instruction.attributes[CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE],
			) === undefined
				? undefined
				: KIND_NUMBER | KIND_UNDEFINED;
		default:
			return undefined;
	}
}

/** Solve exact Number/Boolean kinds through SSA, stable cells, calls, and returns. */
export function analyzeCoreValueKinds(
	program: CoreProgram,
	context: CoreCompilationContext | undefined,
	summaries?: CoreProgramSummaries,
): CoreValueKindAnalysis {
	const wholeProgram =
		summaries ?? analyzeCoreProgramSummaries(program, coreOpcodeRegistry, context);
	const flow = analyzeCoreInterproceduralValueFlow(
		program,
		wholeProgram,
		coreOpcodeRegistry,
	);
	const valueBases = new Map<number, number>();
	const valueLimits = new Map<number, number>();
	const returnNodes = new Map<number, number>();
	let nodeCount = 0;
	for (const fn of program.functions) {
		const limit = valueLimit(fn);
		valueBases.set(fn.functionIndex, nodeCount);
		valueLimits.set(fn.functionIndex, limit);
		nodeCount += limit;
		returnNodes.set(fn.functionIndex, nodeCount++);
	}
	const valueNode = (functionIndex: number, value: CoreValueId): number =>
		valueBases.get(functionIndex)! + value;
	const stableGlobals = new Set(context?.data.singleAssignmentGlobalSlots ?? []);
	const stableCaptured = new Set(
		(context?.data.singleAssignmentCapturedSlots ?? []).map(({ owner, index }) =>
			capturedKey(owner, index),
		),
	);
	const globalNodes = new Map<number, number>();
	const capturedNodes = new Map<string, number>();
	const globalNode = (slot: number): number => {
		let node = globalNodes.get(slot);
		if (node === undefined) {
			node = nodeCount++;
			globalNodes.set(slot, node);
		}
		return node;
	};
	const capturedNode = (owner: number, index: number): number => {
		const key = capturedKey(owner, index);
		let node = capturedNodes.get(key);
		if (node === undefined) {
			node = nodeCount++;
			capturedNodes.set(key, node);
		}
		return node;
	};

	const edges = new Map<number, Array<number>>();
	const transfers = new Map<number, Array<KindTransfer>>();
	const seeds = new Map<number, number>();
	const addEdge = (source: number, destination: number): void => {
		const existing = edges.get(source);
		if (existing === undefined) edges.set(source, [destination]);
		else existing.push(destination);
	};
	const addSeed = (node: number, kind: number): void => {
		seeds.set(node, (seeds.get(node) ?? 0) | kind);
	};
	const addTransfer = (transfer: KindTransfer): void => {
		for (const input of transfer.inputs) {
			const existing = transfers.get(input);
			if (existing === undefined) transfers.set(input, [transfer]);
			else existing.push(transfer);
		}
	};

	for (const fn of program.functions) {
		const representations = new Map(
			fn.values.map(({ id, representation }) => [id, representation] as const),
		);
		for (const [index, parameter] of fn.parameters.entries()) {
			const seed = flow.parameterSeed(fn.functionIndex, index);
			if (flow.parameterOpen(fn.functionIndex, index)) {
				addSeed(valueNode(fn.functionIndex, parameter), KIND_TOP);
			} else if (seed === "number") {
				addSeed(valueNode(fn.functionIndex, parameter), KIND_NUMBER);
			} else if (seed === "undefined") {
				addSeed(valueNode(fn.functionIndex, parameter), KIND_UNDEFINED);
			}
		}
		const cfg = buildCoreControlFlow(fn, coreOpcodeRegistry);
		for (const block of fn.blocks) {
			const incoming = cfg.predecessors[block.id] ?? [];
			for (const [index, parameter] of block.parameters.entries()) {
				const destination = valueNode(fn.functionIndex, parameter.value);
				if (block.id === fn.entry || parameter.role === "exception") {
					addSeed(destination, KIND_TOP);
					continue;
				}
				for (const edge of incoming) {
					const argument =
						edge.kind === "exceptional"
							? edge.arguments[index - 1]
							: edge.arguments[index];
					if (argument === undefined) addSeed(destination, KIND_TOP);
					else addEdge(valueNode(fn.functionIndex, argument), destination);
				}
			}
			for (const instruction of block.instructions) {
				const output = instruction.outputs[0];
				if (instruction.opcode === "move" && output !== undefined) {
					const source = instruction.inputs[0];
					if (source === undefined)
						addSeed(valueNode(fn.functionIndex, output), KIND_TOP);
					else
						addEdge(
							valueNode(fn.functionIndex, source),
							valueNode(fn.functionIndex, output),
						);
					continue;
				}
				if (instruction.opcode === "loadGlobal" && output !== undefined) {
					const slot = instruction.attributes.index;
					if (typeof slot === "number" && stableGlobals.has(slot)) {
						addEdge(globalNode(slot), valueNode(fn.functionIndex, output));
					} else addSeed(valueNode(fn.functionIndex, output), KIND_TOP);
					continue;
				}
				if (instruction.opcode === "storeGlobal") {
					const slot = instruction.attributes.index;
					const source = instruction.inputs[0];
					if (
						typeof slot === "number" &&
						source !== undefined &&
						stableGlobals.has(slot)
					) {
						addEdge(valueNode(fn.functionIndex, source), globalNode(slot));
					}
					continue;
				}
				if (instruction.opcode === "loadCaptured" && output !== undefined) {
					const owner = instruction.attributes.functionIndex;
					const index = instruction.attributes.index;
					if (
						typeof owner === "number" &&
						typeof index === "number" &&
						stableCaptured.has(capturedKey(owner, index))
					) {
						addEdge(capturedNode(owner, index), valueNode(fn.functionIndex, output));
					} else addSeed(valueNode(fn.functionIndex, output), KIND_TOP);
					continue;
				}
				if (instruction.opcode === "storeCaptured") {
					const owner = instruction.attributes.functionIndex;
					const index = instruction.attributes.index;
					const source = instruction.inputs[0];
					if (
						typeof owner === "number" &&
						typeof index === "number" &&
						source !== undefined &&
						stableCaptured.has(capturedKey(owner, index))
					) {
						addEdge(valueNode(fn.functionIndex, source), capturedNode(owner, index));
					}
					continue;
				}
				const callTransfer = coreOpcodeRegistry.get(instruction.opcode)?.callTransfer;
				if (callTransfer?.result === "call-completion" && output !== undefined) {
					for (const extra of instruction.outputs.slice(1)) {
						addSeed(valueNode(fn.functionIndex, extra), KIND_TOP);
					}
					continue;
				}
				for (const value of instruction.outputs) {
					const node = valueNode(fn.functionIndex, value);
					const kind = staticOutputKind(instruction, representations.get(value));
					if (kind !== undefined) {
						addSeed(node, kind);
						continue;
					}
					const operator = instruction.attributes.operator;
					if (
						instruction.opcode === "unary" &&
						instruction.inputs.length === 1 &&
						typeof operator === "string" &&
						NUMERIC_UNARY_OPERATORS.has(operator)
					) {
						addTransfer({
							inputs: [valueNode(fn.functionIndex, instruction.inputs[0]!)],
							output: node,
							evaluate: ([input]) =>
								input === 0 ? 0 : input === KIND_NUMBER ? KIND_NUMBER : KIND_TOP,
						});
						continue;
					}
					if (
						instruction.opcode === "binary" &&
						instruction.inputs.length === 2 &&
						typeof operator === "string" &&
						NUMERIC_BINARY_OPERATORS.has(operator)
					) {
						addTransfer({
							inputs: instruction.inputs.map((input) =>
								valueNode(fn.functionIndex, input),
							),
							output: node,
							evaluate: ([left, right]) =>
								left === 0 || right === 0
									? 0
									: left === KIND_NUMBER && right === KIND_NUMBER
										? KIND_NUMBER
										: KIND_TOP,
						});
						continue;
					}
					addSeed(node, KIND_TOP);
				}
			}
			if (block.terminator.kind === "return") {
				addEdge(
					valueNode(fn.functionIndex, block.terminator.value),
					returnNodes.get(fn.functionIndex)!,
				);
			}
		}
	}

	for (const call of flow.calls) {
		const arguments_ = corePositionalCallArguments(call);
		for (const target of call.targets) {
			if (arguments_ !== undefined) {
				for (const [index, parameter] of target.parameters.entries()) {
					const argument = arguments_[index];
					if (argument === undefined)
						addSeed(valueNode(target.functionIndex, parameter), KIND_UNDEFINED);
					else
						addEdge(
							valueNode(call.caller, argument),
							valueNode(target.functionIndex, parameter),
						);
				}
			}
		}
		const output = call.instruction.outputs[0];
		if (call.transfer.result !== "call-completion" || output === undefined) continue;
		const result = valueNode(call.caller, output);
		if (call.open) addSeed(result, KIND_TOP);
		for (const target of call.targets) {
			if (target.isAsync || target.isGenerator) addSeed(result, KIND_OBJECT);
			else addEdge(returnNodes.get(target.functionIndex)!, result);
		}
	}

	const state = new Uint16Array(nodeCount);
	const queued = new Uint8Array(nodeCount);
	const queue: Array<number> = [];
	let index = 0;
	const raise = (node: number, kind: number): void => {
		const next = state[node]! | kind;
		if (next === state[node]) return;
		state[node] = next;
		if (queued[node] === 0) {
			queued[node] = 1;
			queue.push(node);
		}
	};
	for (const [node, kind] of seeds) raise(node, kind);
	while (index < queue.length) {
		const source = queue[index++]!;
		queued[source] = 0;
		for (const destination of edges.get(source) ?? []) raise(destination, state[source]!);
		for (const transfer of transfers.get(source) ?? []) {
			raise(
				transfer.output,
				transfer.evaluate(transfer.inputs.map((input) => state[input]!)),
			);
		}
	}

	return {
		exactScalar(functionIndex, value) {
			const base = valueBases.get(functionIndex);
			const limit = valueLimits.get(functionIndex);
			if (base === undefined || limit === undefined || value >= limit) return undefined;
			const kind = state[base + value];
			return kind === KIND_NUMBER
				? "number"
				: kind === KIND_BOOLEAN
					? "boolean"
					: undefined;
		},
	};
}

export function coreExactCallArgumentRepresentations(
	value: unknown,
	parameterCount?: number,
): ReadonlyArray<CoreExactCallArgumentRepresentation> | undefined {
	if (
		!Array.isArray(value) ||
		(parameterCount !== undefined && value.length !== parameterCount) ||
		value.some((entry) => entry !== "boxed" && entry !== "number" && entry !== "boolean")
	) {
		return undefined;
	}
	return value as ReadonlyArray<CoreExactCallArgumentRepresentation>;
}

export interface CoreExactCallArgumentSelection {
	readonly program: CoreProgram;
	readonly changed: boolean;
}

/** Attach exact scalar argument facts to closed direct script calls. */
export function selectCoreExactCallArguments(
	program: CoreProgram,
	context: CoreCompilationContext | undefined,
	summaries?: CoreProgramSummaries,
): CoreExactCallArgumentSelection {
	const analysis = analyzeCoreValueKinds(program, context, summaries);
	let changed = false;
	const functions = program.functions.map((fn): CoreFunction => {
		let functionChanged = false;
		const blocks = fn.blocks.map((block) => ({
			...block,
			instructions: block.instructions.map((instruction): CoreInstruction => {
				if (instruction.opcode !== "call") return instruction;
				const targetIndex = instruction.attributes.directFunctionIndex;
				const target =
					typeof targetIndex === "number" ? program.functions[targetIndex] : undefined;
				const attributes = { ...instruction.attributes };
				delete attributes[CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE];
				if (target !== undefined) {
					const representations = target.parameters.map((_, index) => {
						const argument = instruction.inputs[index + 2];
						return argument === undefined
							? "boxed"
							: (analysis.exactScalar(fn.functionIndex, argument) ?? "boxed");
					});
					if (representations.some((entry) => entry !== "boxed")) {
						attributes[CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE] =
							representations;
					}
				}
				const before =
					instruction.attributes[CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE];
				const after = attributes[CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE];
				if (JSON.stringify(before) === JSON.stringify(after)) return instruction;
				functionChanged = true;
				return { ...instruction, attributes };
			}),
		}));
		if (!functionChanged) return fn;
		changed = true;
		return { ...fn, blocks, mutationEpoch: fn.mutationEpoch + 1 };
	});
	return { program: changed ? { ...program, functions } : program, changed };
}
