/**
 * Closed primitive-kind flow for native ABI selection.
 *
 * This lattice deliberately describes JavaScript kinds, not physical registers.
 * A value may remain boxed in canonical Core while a closed call edge proves that
 * one direct native entry always receives an Int32, wider Number, Boolean, or
 * String. Native lowering
 * can then emit a typed variant without changing the generic ECMAScript call ABI.
 */

import {
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
	compilerValueKindMaskIsSubset,
	compilerValueKindMaskIsValid,
} from "../shared/compiler-value-kinds.ts";
import type { CompilerValueKindMask } from "../shared/compiler-value-kinds.ts";
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
	CoreBlock,
	CoreBlockId,
	CoreEdge,
	CoreFunction,
	CoreInstruction,
	CoreProgram,
	CoreTerminator,
	CoreValueId,
} from "./core-ir.ts";
import { coreInstructionId, coreValueId } from "./core-ir.ts";

export const CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE =
	"exactCallArgumentRepresentations";
export const CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE = "exactBinaryInputKindMasks";
export const CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE = "exactScalarAfterTdz";

export type CoreExactScalarKind = "int32" | "number" | "boolean" | "string";
export type CoreExactCallArgumentRepresentation = "boxed" | CoreExactScalarKind;

interface KindTransfer {
	readonly inputs: ReadonlyArray<number>;
	readonly output: number;
	readonly evaluate: (
		inputs: ReadonlyArray<number>,
		int32Inputs: ReadonlyArray<number>,
	) => { readonly kind: number; readonly int32: number };
}

export interface CoreValueKindAnalysis {
	exactScalar(functionIndex: number, value: CoreValueId): CoreExactScalarKind | undefined;
	kindMask(functionIndex: number, value: CoreValueId): CompilerValueKindMask;
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

const INT32_RESULT_BINARY_OPERATORS: ReadonlySet<string> = new Set([
	"&",
	"|",
	"^",
	"<<",
	">>",
]);

function numberIsExactInt32(value: unknown): boolean {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= -0x8000_0000 &&
		value <= 0x7fff_ffff &&
		!Object.is(value, -0)
	);
}

function staticOutputIsInt32(
	instruction: CoreInstruction,
	representation: CoreFunction["values"][number]["representation"] | undefined,
): boolean {
	if (representation === "i32") return true;
	if (instruction.opcode !== "createF64" && instruction.opcode !== "createNumber") {
		return false;
	}
	return numberIsExactInt32(instruction.attributes.value);
}

function staticOutputKind(
	instruction: CoreInstruction,
	representation: CoreFunction["values"][number]["representation"] | undefined,
): number | undefined {
	if (representation === "f64" || representation === "i32")
		return COMPILER_VALUE_KIND_NUMBER;
	if (representation === "boolean") return COMPILER_VALUE_KIND_BOOLEAN;
	switch (instruction.opcode) {
		case "createEmpty":
			// The sentinel has no ordinary ECMAScript kind. A path that observes it
			// throws at its TDZ check before entering a script call.
			return 0;
		case "createUndefined":
			return COMPILER_VALUE_KIND_UNDEFINED;
		case "createNull":
			return COMPILER_VALUE_KIND_NULL;
		case "createBoolean":
			return COMPILER_VALUE_KIND_BOOLEAN;
		case "createF64":
		case "createNumber":
			return COMPILER_VALUE_KIND_NUMBER;
		case "createString":
			return COMPILER_VALUE_KIND_STRING;
		case "createBigint":
			return COMPILER_VALUE_KIND_BIGINT;
		case "createFunction":
		case "createArray":
		case "createObject":
		case "createObjectShaped":
		case "createModuleNamespace":
		case "createTemplateObject":
		case "instantiateLiteralTemplate":
			return COMPILER_VALUE_KIND_OBJECT;
		case "createPrivateName":
		case "createPrivateNames":
			return COMPILER_VALUE_KIND_SYMBOL;
		case "loadProperty":
			return coreNumericTypedArrayKind(
				instruction.attributes[CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE],
			) === undefined
				? undefined
				: COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED;
		default:
			return undefined;
	}
}

/** Solve exact primitive kinds through SSA, stable cells, calls, and returns. */
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
	const int32Seeds = new Map<number, number>();
	const addEdge = (source: number, destination: number): void => {
		const existing = edges.get(source);
		if (existing === undefined) edges.set(source, [destination]);
		else existing.push(destination);
	};
	const addSeed = (node: number, kind: number, exactInt32 = false): void => {
		seeds.set(node, (seeds.get(node) ?? 0) | kind);
		if (kind !== 0) {
			int32Seeds.set(node, (int32Seeds.get(node) ?? 0) | (exactInt32 ? 1 : 2));
		}
	};
	const addTransfer = (transfer: KindTransfer): void => {
		for (const input of transfer.inputs) {
			const existing = transfers.get(input);
			if (existing === undefined) transfers.set(input, [transfer]);
			else existing.push(transfer);
		}
	};

	for (const fn of program.functions) {
		const functionParameters = new Set(fn.parameters);
		const representations = new Map(
			fn.values.map(({ id, representation }) => [id, representation] as const),
		);
		for (const [index, parameter] of fn.parameters.entries()) {
			const seed = flow.parameterSeed(fn.functionIndex, index);
			if (flow.parameterOpen(fn.functionIndex, index)) {
				addSeed(valueNode(fn.functionIndex, parameter), COMPILER_VALUE_KIND_TOP);
			} else if (seed === "number") {
				addSeed(valueNode(fn.functionIndex, parameter), COMPILER_VALUE_KIND_NUMBER);
			} else if (seed === "undefined") {
				addSeed(valueNode(fn.functionIndex, parameter), COMPILER_VALUE_KIND_UNDEFINED);
			}
		}
		const cfg = buildCoreControlFlow(fn, coreOpcodeRegistry);
		for (const block of fn.blocks) {
			const incoming = cfg.predecessors[block.id] ?? [];
			for (const [index, parameter] of block.parameters.entries()) {
				const destination = valueNode(fn.functionIndex, parameter.value);
				if (block.id === fn.entry && functionParameters.has(parameter.value)) {
					// Function formals were seeded from the complete call topology above.
					// Re-seeding them as open entry values would erase that proof.
					continue;
				}
				if (block.id === fn.entry || parameter.role === "exception") {
					addSeed(destination, COMPILER_VALUE_KIND_TOP);
					continue;
				}
				for (const edge of incoming) {
					const argument =
						edge.kind === "exceptional"
							? edge.arguments[index - 1]
							: edge.arguments[index];
					if (argument === undefined) addSeed(destination, COMPILER_VALUE_KIND_TOP);
					else addEdge(valueNode(fn.functionIndex, argument), destination);
				}
			}
			for (const instruction of block.instructions) {
				const output = instruction.outputs[0];
				if (instruction.opcode === "move" && output !== undefined) {
					const source = instruction.inputs[0];
					if (source === undefined)
						addSeed(valueNode(fn.functionIndex, output), COMPILER_VALUE_KIND_TOP);
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
					} else addSeed(valueNode(fn.functionIndex, output), COMPILER_VALUE_KIND_TOP);
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
					} else addSeed(valueNode(fn.functionIndex, output), COMPILER_VALUE_KIND_TOP);
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
						addSeed(valueNode(fn.functionIndex, extra), COMPILER_VALUE_KIND_TOP);
					}
					continue;
				}
				for (const value of instruction.outputs) {
					const node = valueNode(fn.functionIndex, value);
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
							evaluate: ([input]) => {
								if (input === 0) return { kind: 0, int32: 0 };
								if (input !== COMPILER_VALUE_KIND_NUMBER) {
									return { kind: COMPILER_VALUE_KIND_TOP, int32: 2 };
								}
								return {
									kind: COMPILER_VALUE_KIND_NUMBER,
									int32: operator === "~" ? 1 : 2,
								};
							},
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
							evaluate: ([left, right]) => {
								if (left === 0 || right === 0) return { kind: 0, int32: 0 };
								if (
									operator === "+" &&
									(left === COMPILER_VALUE_KIND_STRING ||
										right === COMPILER_VALUE_KIND_STRING)
								) {
									return { kind: COMPILER_VALUE_KIND_STRING, int32: 2 };
								}
								if (
									left === COMPILER_VALUE_KIND_NUMBER &&
									right === COMPILER_VALUE_KIND_NUMBER
								) {
									return {
										kind: COMPILER_VALUE_KIND_NUMBER,
										int32: INT32_RESULT_BINARY_OPERATORS.has(operator) ? 1 : 2,
									};
								}
								return { kind: COMPILER_VALUE_KIND_TOP, int32: 2 };
							},
						});
						continue;
					}
					const kind = staticOutputKind(instruction, representations.get(value));
					if (kind !== undefined) {
						addSeed(
							node,
							kind,
							staticOutputIsInt32(instruction, representations.get(value)),
						);
						continue;
					}
					addSeed(node, COMPILER_VALUE_KIND_TOP);
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
						addSeed(
							valueNode(target.functionIndex, parameter),
							COMPILER_VALUE_KIND_UNDEFINED,
						);
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
		if (call.open) addSeed(result, COMPILER_VALUE_KIND_TOP);
		for (const target of call.targets) {
			if (target.isAsync || target.isGenerator)
				addSeed(result, COMPILER_VALUE_KIND_OBJECT);
			else addEdge(returnNodes.get(target.functionIndex)!, result);
		}
	}

	const state = new Uint16Array(nodeCount);
	const int32State = new Uint8Array(nodeCount);
	const queued = new Uint8Array(nodeCount);
	const queue: Array<number> = [];
	let index = 0;
	const raise = (node: number, kind: number, int32: number): void => {
		const next = state[node]! | kind;
		const nextInt32 = int32State[node]! | int32;
		if (next === state[node] && nextInt32 === int32State[node]) return;
		state[node] = next;
		int32State[node] = nextInt32;
		if (queued[node] === 0) {
			queued[node] = 1;
			queue.push(node);
		}
	};
	for (const [node, kind] of seeds) raise(node, kind, int32Seeds.get(node) ?? 0);
	while (index < queue.length) {
		const source = queue[index++]!;
		queued[source] = 0;
		for (const destination of edges.get(source) ?? []) {
			raise(destination, state[source]!, int32State[source]!);
		}
		for (const transfer of transfers.get(source) ?? []) {
			const result = transfer.evaluate(
				transfer.inputs.map((input) => state[input]!),
				transfer.inputs.map((input) => int32State[input]!),
			);
			raise(transfer.output, result.kind, result.int32);
		}
	}

	return {
		exactScalar(functionIndex, value) {
			const base = valueBases.get(functionIndex);
			const limit = valueLimits.get(functionIndex);
			if (base === undefined || limit === undefined || value >= limit) return undefined;
			const kind = state[base + value];
			return kind === COMPILER_VALUE_KIND_NUMBER
				? int32State[base + value] === 1
					? "int32"
					: "number"
				: kind === COMPILER_VALUE_KIND_BOOLEAN
					? "boolean"
					: kind === COMPILER_VALUE_KIND_STRING
						? "string"
						: undefined;
		},
		kindMask(functionIndex, value) {
			const base = valueBases.get(functionIndex);
			const limit = valueLimits.get(functionIndex);
			if (base === undefined || limit === undefined || value >= limit) {
				return COMPILER_VALUE_KIND_TOP;
			}
			return state[base + value] || COMPILER_VALUE_KIND_TOP;
		},
	};
}

export function coreExactBinaryInputKindMasks(
	value: unknown,
): readonly [CompilerValueKindMask, CompilerValueKindMask] | undefined {
	if (
		!Array.isArray(value) ||
		value.length !== 2 ||
		!compilerValueKindMaskIsValid(value[0]) ||
		!compilerValueKindMaskIsValid(value[1])
	) {
		return undefined;
	}
	return value as unknown as readonly [CompilerValueKindMask, CompilerValueKindMask];
}

export function coreBinaryInputKindMasksHaveExactNativeSemantics(
	operator: unknown,
	masks: readonly [CompilerValueKindMask, CompilerValueKindMask],
): boolean {
	const [left, right] = masks;
	return (
		typeof operator === "string" &&
		["<", "<=", ">", ">=", "==", "!=", "===", "!=="].includes(operator) &&
		compilerValueKindMaskIsSubset(left, COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED) &&
		compilerValueKindMaskIsSubset(right, COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED)
	);
}

export function coreExactCallArgumentRepresentations(
	value: unknown,
	parameterCount?: number,
): ReadonlyArray<CoreExactCallArgumentRepresentation> | undefined {
	if (
		!Array.isArray(value) ||
		(parameterCount !== undefined && value.length !== parameterCount) ||
		value.some(
			(entry) =>
				entry !== "boxed" &&
				entry !== "int32" &&
				entry !== "number" &&
				entry !== "boolean" &&
				entry !== "string",
		)
	) {
		return undefined;
	}
	return value as ReadonlyArray<CoreExactCallArgumentRepresentation>;
}

export interface CoreExactValueFactSelection {
	readonly program: CoreProgram;
	readonly changed: boolean;
}

function scalarCoreRepresentation(
	kind: CoreExactScalarKind | undefined,
): "i32" | "f64" | "boolean" | "string" | undefined {
	return kind === "int32"
		? "i32"
		: kind === "number"
			? "f64"
			: kind === "boolean"
				? "boolean"
				: kind === "string"
					? "string"
					: undefined;
}

const NUMERIC_RESULT_OPERATORS: ReadonlySet<string> = new Set([
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

function terminatorUsesValue(terminator: CoreTerminator, value: CoreValueId): boolean {
	const edgeUses = (edge: { readonly arguments: ReadonlyArray<CoreValueId> }): boolean =>
		edge.arguments.includes(value);
	switch (terminator.kind) {
		case "jump":
			return edgeUses(terminator.edge);
		case "branch":
			return (
				terminator.condition === value ||
				edgeUses(terminator.consequent) ||
				edgeUses(terminator.alternate)
			);
		case "guard":
			return (
				terminator.condition === value ||
				edgeUses(terminator.success) ||
				edgeUses(terminator.fallback)
			);
		case "switch":
			return (
				terminator.discriminant === value ||
				terminator.cases.some(({ edge }) => edgeUses(edge)) ||
				edgeUses(terminator.default)
			);
		case "return":
		case "throw":
			return terminator.value === value;
		case "unreachable":
			return false;
	}
}

function rewriteTerminatorValue(
	terminator: CoreTerminator,
	from: CoreValueId,
	to: CoreValueId,
): CoreTerminator {
	const value = (candidate: CoreValueId): CoreValueId =>
		candidate === from ? to : candidate;
	const edge = (candidate: CoreEdge): CoreEdge => ({
		...candidate,
		arguments: candidate.arguments.map(value),
	});
	switch (terminator.kind) {
		case "jump":
			return { ...terminator, edge: edge(terminator.edge) };
		case "branch":
			return {
				...terminator,
				condition: value(terminator.condition),
				consequent: edge(terminator.consequent),
				alternate: edge(terminator.alternate),
			};
		case "guard":
			return {
				...terminator,
				condition: value(terminator.condition),
				success: edge(terminator.success),
				fallback: edge(terminator.fallback),
			};
		case "switch":
			return {
				...terminator,
				discriminant: value(terminator.discriminant),
				cases: terminator.cases.map((candidate) => ({
					...candidate,
					edge: edge(candidate.edge),
				})),
				default: edge(terminator.default),
			};
		case "return":
		case "throw":
			return { ...terminator, value: value(terminator.value) };
		case "unreachable":
			return terminator;
	}
}

/** Materialize scalar values only after the path-local check has rejected Empty. */
export function materializeCoreExactScalarRepresentations(
	program: CoreProgram,
	context: CoreCompilationContext | undefined,
	summaries?: CoreProgramSummaries,
): CoreExactValueFactSelection {
	const analysis = analyzeCoreValueKinds(program, context, summaries);
	let programChanged = false;
	const functions = program.functions.map((fn): CoreFunction => {
		let blocks: ReadonlyArray<CoreBlock> = fn.blocks;
		const values = [...fn.values];
		const representations = new Map(
			values.map(({ id, representation }) => [id, representation]),
		);
		const boxedEntryParameters = new Set(
			fn.parameters.filter((value) => representations.get(value) === "boxed"),
		);
		const cfg = buildCoreControlFlow(fn, coreOpcodeRegistry);
		let nextInstruction =
			Math.max(
				-1,
				...fn.blocks.flatMap((block) => [
					block.terminator.id,
					...block.instructions.map(({ id }) => id),
				]),
			) + 1;
		let changed = false;
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					(instruction.opcode !== "loadGlobal" &&
						instruction.opcode !== "loadCaptured") ||
					instruction.outputs.length !== 1
				) {
					continue;
				}
				const output = instruction.outputs[0]!;
				const kind = analysis.exactScalar(fn.functionIndex, output);
				const representation = scalarCoreRepresentation(kind);
				if (representation === undefined) continue;
				const checks = blocks.flatMap((candidate) =>
					candidate.instructions
						.flatMap((candidateInstruction, index) =>
							candidateInstruction.opcode === "throwIfTdz" &&
							candidateInstruction.inputs[0] === output
								? [{ block: candidate.id, index, instruction: candidateInstruction }]
								: [],
						)
						.toReversed(),
				);
				for (const check of checks) {
					const dominatesUse = (useBlock: CoreBlockId, useIndex: number): boolean =>
						useBlock === check.block
							? useIndex > check.index
							: cfg.instructionDominatesBlock(check.block, useBlock);
					let hasDominatedUse = false;
					for (const candidate of blocks) {
						for (const [
							index,
							candidateInstruction,
						] of candidate.instructions.entries()) {
							if (
								candidateInstruction.inputs.includes(output) &&
								candidateInstruction.opcode !== "throwIfTdz" &&
								candidateInstruction.attributes[CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE] ===
									undefined &&
								dominatesUse(candidate.id, index)
							) {
								hasDominatedUse = true;
							}
						}
						if (
							terminatorUsesValue(candidate.terminator, output) &&
							dominatesUse(candidate.id, candidate.instructions.length)
						) {
							hasDominatedUse = true;
						}
					}
					if (!hasDominatedUse) continue;

					const moveId = coreInstructionId(nextInstruction++);
					const moved = coreValueId((values.at(-1)?.id ?? -1) + 1);
					const move: CoreInstruction = {
						id: moveId,
						opcode: "move",
						inputs: [output],
						outputs: [moved],
						attributes: { [CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE]: kind! },
						...(check.instruction.sourcePosition === undefined
							? {}
							: { sourcePosition: check.instruction.sourcePosition }),
					};
					values.push({
						id: moved,
						representation,
						definition: { kind: "instruction", instruction: moveId, index: 0 },
					});
					representations.set(moved, representation);
					blocks = blocks.map((candidate): CoreBlock => {
						const instructions: Array<CoreInstruction> = [];
						for (const [
							index,
							candidateInstruction,
						] of candidate.instructions.entries()) {
							const rewrite =
								candidateInstruction.opcode !== "throwIfTdz" &&
								candidateInstruction.attributes[CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE] ===
									undefined &&
								dominatesUse(candidate.id, index);
							instructions.push(
								rewrite
									? {
											...candidateInstruction,
											inputs: candidateInstruction.inputs.map((input) =>
												input === output ? moved : input,
											),
										}
									: candidateInstruction,
							);
							if (candidate.id === check.block && index === check.index) {
								instructions.push(move);
							}
						}
						const rewriteTerminator = dominatesUse(
							candidate.id,
							candidate.instructions.length,
						);
						return {
							...candidate,
							instructions,
							terminator: rewriteTerminator
								? rewriteTerminatorValue(candidate.terminator, output, moved)
								: candidate.terminator,
						};
					});
					changed = true;
				}
			}
		}

		const representationCfg = buildCoreControlFlow(
			{ ...fn, blocks, values },
			coreOpcodeRegistry,
		);
		let progress = true;
		const narrow = (
			value: CoreValueId,
			representation: "i32" | "f64" | "boolean" | "string" | undefined,
		): void => {
			const current = representations.get(value);
			if (
				representation === undefined ||
				current === representation ||
				(current !== "boxed" && !(current === "f64" && representation === "i32"))
			) {
				return;
			}
			representations.set(value, representation);
			changed = true;
			progress = true;
		};
		while (progress) {
			progress = false;
			for (const block of blocks) {
				if (
					block.id !== fn.entry &&
					!block.parameters.some(({ role }) => role === "exception")
				) {
					for (const [index, parameter] of block.parameters.entries()) {
						const crossesBoxedEntry = representationCfg.predecessors[block.id]!.some(
							(edge) =>
								edge.kind === "ordinary" &&
								boxedEntryParameters.has(edge.arguments[index]!),
						);
						if (crossesBoxedEntry) continue;
						narrow(
							parameter.value,
							scalarCoreRepresentation(
								analysis.exactScalar(fn.functionIndex, parameter.value),
							),
						);
					}
				}
				if (
					block.id !== fn.entry &&
					!block.parameters.some(({ role }) => role === "exception")
				) {
					const incoming = representationCfg.predecessors[block.id]!.filter(
						({ kind }) => kind === "ordinary",
					);
					if (incoming.length === representationCfg.predecessors[block.id]!.length) {
						for (const [index, parameter] of block.parameters.entries()) {
							const candidates = new Set(
								incoming.map(({ arguments: arguments_ }) =>
									representations.get(arguments_[index]!),
								),
							);
							if (candidates.size !== 1) continue;
							const candidate = [...candidates][0];
							narrow(
								parameter.value,
								candidate === "i32" ||
									candidate === "f64" ||
									candidate === "boolean" ||
									candidate === "string"
									? candidate
									: undefined,
							);
						}
					}
				}
				for (const instruction of block.instructions) {
					const output = instruction.outputs[0];
					if (output === undefined || instruction.outputs.length !== 1) continue;
					if (instruction.opcode === "move" && instruction.inputs.length === 1) {
						const input = representations.get(instruction.inputs[0]!);
						narrow(
							output,
							input === "i32" ||
								input === "f64" ||
								input === "boolean" ||
								input === "string"
								? input
								: undefined,
						);
						continue;
					}
					if (
						instruction.opcode === "createF64" ||
						instruction.opcode === "createNumber" ||
						instruction.opcode === "createBoolean" ||
						instruction.opcode === "createString"
					) {
						narrow(
							output,
							scalarCoreRepresentation(analysis.exactScalar(fn.functionIndex, output)),
						);
						continue;
					}
					const operator = instruction.attributes.operator;
					if (
						instruction.opcode === "unary" &&
						instruction.inputs.length === 1 &&
						typeof operator === "string" &&
						NUMERIC_UNARY_OPERATORS.has(operator) &&
						["i32", "f64"].includes(representations.get(instruction.inputs[0]!) ?? "")
					) {
						narrow(output, operator === "~" ? "i32" : "f64");
						continue;
					}
					if (
						instruction.opcode === "binary" &&
						instruction.inputs.length === 2 &&
						typeof operator === "string" &&
						NUMERIC_RESULT_OPERATORS.has(operator) &&
						instruction.inputs.every((input) =>
							["i32", "f64"].includes(representations.get(input) ?? ""),
						)
					) {
						narrow(output, INT32_RESULT_BINARY_OPERATORS.has(operator) ? "i32" : "f64");
						continue;
					}
					if (
						instruction.opcode === "binary" &&
						instruction.attributes.operator === "+" &&
						analysis.exactScalar(fn.functionIndex, output) === "string"
					) {
						narrow(output, "string");
					}
				}
			}
		}
		if (!changed) return fn;
		blocks = blocks.map((block) => ({
			...block,
			parameters: block.parameters.map((parameter) => ({
				...parameter,
				representation: representations.get(parameter.value)!,
			})),
		}));
		programChanged = true;
		return {
			...fn,
			blocks,
			values: values.map((value) => ({
				...value,
				representation: representations.get(value.id)!,
			})),
			mutationEpoch: fn.mutationEpoch + 1,
		};
	});
	const materialized = programChanged ? { ...program, functions } : program;
	return { program: materialized, changed: materialized !== program };
}

/** Attach exact scalar argument facts to closed direct script calls. */
export function selectCoreExactValueFacts(
	program: CoreProgram,
	context: CoreCompilationContext | undefined,
	summaries?: CoreProgramSummaries,
): CoreExactValueFactSelection {
	const analysis = analyzeCoreValueKinds(program, context, summaries);
	let changed = false;
	const functions = program.functions.map((fn): CoreFunction => {
		let functionChanged = false;
		const blocks = fn.blocks.map((block) => ({
			...block,
			instructions: block.instructions.map((instruction): CoreInstruction => {
				const targetIndex = instruction.attributes.directFunctionIndex;
				const target =
					typeof targetIndex === "number" ? program.functions[targetIndex] : undefined;
				const attributes = { ...instruction.attributes };
				delete attributes[CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE];
				delete attributes[CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE];
				if (instruction.opcode === "call" && target !== undefined) {
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
				if (instruction.opcode === "binary" && instruction.inputs.length === 2) {
					const masks = instruction.inputs.map((input) =>
						analysis.kindMask(fn.functionIndex, input),
					) as [CompilerValueKindMask, CompilerValueKindMask];
					if (
						coreBinaryInputKindMasksHaveExactNativeSemantics(
							instruction.attributes.operator,
							masks,
						)
					) {
						attributes[CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE] = masks;
					}
				}
				const before =
					JSON.stringify(
						instruction.attributes[CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE],
					) +
					JSON.stringify(
						instruction.attributes[CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE],
					);
				const after =
					JSON.stringify(attributes[CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE]) +
					JSON.stringify(attributes[CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE]);
				if (before === after) return instruction;
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
