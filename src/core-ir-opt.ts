import type { OptimizationAblation } from "./compiler-diagnostics.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import { verifyCoreFunction } from "./core-ir-verifier.ts";
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

export interface CoreOptimizationOptions {
	readonly maxRounds?: number;
	readonly ablations?: ReadonlySet<OptimizationAblation>;
	/** Run Core's value simplifiers. Disable only while importing an already optimized graph. */
	readonly simplifyValues?: boolean;
}

type LegacyRegisterOperand =
	| { readonly kind: "output"; readonly index: number }
	| { readonly kind: "input"; readonly index: number }
	| { readonly kind: "literal"; readonly value: number };

interface LegacyInstructionPayload {
	readonly registerLayout?: ReadonlyArray<LegacyRegisterOperand>;
	readonly fields: Readonly<Record<string, unknown>>;
}

function legacyFields(instruction: CoreInstruction): Readonly<Record<string, unknown>> {
	const payload = instruction.payload as LegacyInstructionPayload | undefined;
	return payload?.fields ?? {};
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
		legacyFields(constant).value === value &&
		constant.outputs.length === 1 &&
		compare?.opcode === "binary" &&
		legacyFields(compare).operator === "===" &&
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
				if (legacyFields(instruction).terminal !== true) {
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
					const payload = instruction.payload as LegacyInstructionPayload;
					return {
						...instruction,
						payload: {
							...payload,
							fields: { ...payload.fields, terminal: true },
						},
					};
				}),
			})),
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

function removeLegacyInput(
	payload: LegacyInstructionPayload,
	removedInput: number,
): LegacyInstructionPayload["registerLayout"] {
	if (payload.registerLayout === undefined) return undefined;
	const result: Array<LegacyRegisterOperand> = [];
	for (const operand of payload.registerLayout) {
		if (operand.kind !== "input") {
			result.push(operand);
		} else if (operand.index !== removedInput) {
			result.push(
				operand.index > removedInput ? { ...operand, index: operand.index - 1 } : operand,
			);
		}
	}
	return result;
}

/** Fold an exact string SSA value into the property operation's attributes. */
const foldStaticPropertyKeys: CoreFunctionPass = {
	name: "fold-static-property-keys",
	ablation: "static-properties",
	run(fn) {
		const strings = new Map<CoreValueId, number>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const stringIndex = legacyFields(instruction).stringIndex;
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
					const payload = instruction.payload as LegacyInstructionPayload;
					changed = true;
					return {
						...instruction,
						opcode:
							instruction.opcode === "loadProperty"
								? "loadPropertyStatic"
								: "storePropertyStatic",
						inputs: instruction.inputs.filter((_, index) => index !== 1),
						payload: {
							...payload,
							registerLayout: removeLegacyInput(payload, 1),
							fields: { ...payload.fields, stringIndex },
						},
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
	run(fn: CoreFunction, analyses: CoreAnalysisManager): CoreFunction;
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

function stablePayload(payload: unknown): string {
	return payload === undefined ? "" : JSON.stringify(payload);
}

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
					const key = `${instruction.opcode}\0${instruction.inputs.join(",")}\0${stablePayload(instruction.payload)}`;
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

const CORE_PASSES: ReadonlyArray<CoreFunctionPass> = [
	annotateTerminalYieldSites,
	foldStaticPropertyKeys,
	copyAndValueNumber,
	deadInstructionElimination,
];

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
				const next = pass.run(fn, analyses);
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
