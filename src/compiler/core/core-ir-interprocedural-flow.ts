/**
 * Registry-driven value topology across the closed script call graph.
 *
 * Callee discovery, entry openness, receiver flow, positional argument flow,
 * and return ownership are deliberately assembled once. Lattice consumers may
 * attach different products (identity, heap brand, scalar class, shape) without
 * re-inventing which Core opcode enters which function frame.
 */

import { coreCalleeTargetsAreOpen } from "./core-ir-call-targets.ts";
import { coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import type {
	CoreFunction,
	CoreInstruction,
	CoreOpcodeCallTransfer,
	CoreOpcodeRegistry,
	CoreProgram,
	CoreValueId,
} from "./core-ir.ts";

export interface CoreInterproceduralCallSite {
	readonly caller: number;
	readonly instruction: CoreInstruction;
	/** Finite script targets retained by the callee lattice and present in Core. */
	readonly targets: ReadonlyArray<CoreFunction>;
	/** Some additional callee may run and contribute an unrelated result. */
	readonly open: boolean;
	readonly transfer: CoreOpcodeCallTransfer;
}

export interface CoreInterproceduralValueFlow {
	readonly calls: ReadonlyArray<CoreInterproceduralCallSite>;
	/** Whether some entry outside the positional graph may supply this parameter. */
	parameterOpen(functionIndex: number, parameterIndex: number): boolean;
	/** Host, eval, source-opening, or aggregate entry opens at least one parameter. */
	parametersOpen(functionIndex: number): boolean;
	/** Exact primitive supplied by a registry-known native callback protocol. */
	parameterSeed(
		functionIndex: number,
		parameterIndex: number,
	): "number" | "undefined" | undefined;
	/** A call outside the model or [[Construct]] may supply an unrelated receiver. */
	receiverOpen(functionIndex: number): boolean;
	readonly statistics: {
		readonly calls: number;
		readonly namedEdges: number;
		readonly openSites: number;
		readonly openParameterEntries: number;
		readonly openParameterPositions: number;
		readonly openReceiverEntries: number;
	};
}

/** The actual positional arguments one call hands to a source function. */
export function corePositionalCallArguments(
	call: CoreInterproceduralCallSite,
): ReadonlyArray<CoreValueId> | undefined {
	const layout = call.transfer.arguments;
	return layout.kind === "positional"
		? call.instruction.inputs.slice(layout.firstOperand)
		: undefined;
}

/** The [[Call]] receiver operand, absent for [[Construct]]. */
export function coreCallReceiver(
	call: CoreInterproceduralCallSite,
): CoreValueId | undefined {
	const operand = call.transfer.receiverOperand;
	return operand === undefined ? undefined : call.instruction.inputs[operand];
}

/**
 * Build the call topology after callee analysis has reached its closed-world
 * fixed point. `CoreProgramSummaries` owns both the target lattice and source
 * closure roots, so a value lattice cannot accidentally use a different notion
 * of "closed" from effects and reachability.
 */
export function analyzeCoreInterproceduralValueFlow(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	registry: CoreOpcodeRegistry = coreOpcodeRegistry,
): CoreInterproceduralValueFlow {
	const functionsByIndex = new Map(
		program.functions.map((fn) => [fn.functionIndex, fn] as const),
	);
	const openParameters = new Map<number, Set<number>>();
	const parameterSeeds = new Map<number, Map<number, "number" | "undefined">>();
	const openReceivers = new Set<number>();
	const openParameter = (fn: CoreFunction, index: number): void => {
		if (index >= fn.parameters.length) return;
		parameterSeeds.get(fn.functionIndex)?.delete(index);
		const positions = openParameters.get(fn.functionIndex);
		if (positions === undefined) openParameters.set(fn.functionIndex, new Set([index]));
		else positions.add(index);
	};
	const openAllParameters = (fn: CoreFunction): void => {
		for (const [index] of fn.parameters.entries()) openParameter(fn, index);
	};
	const seedParameter = (
		fn: CoreFunction,
		index: number,
		seed: "number" | "undefined",
	): void => {
		if (index >= fn.parameters.length) return;
		let seeds = parameterSeeds.get(fn.functionIndex);
		if (seeds === undefined) {
			seeds = new Map();
			parameterSeeds.set(fn.functionIndex, seeds);
		}
		const previous = seeds.get(index);
		if (previous !== undefined && previous !== seed) {
			openParameter(fn, index);
			seeds.delete(index);
			return;
		}
		if (!openParameters.get(fn.functionIndex)?.has(index)) seeds.set(index, seed);
	};
	if (!summaries.sourceClosed) {
		for (const fn of program.functions) {
			openAllParameters(fn);
			openReceivers.add(fn.functionIndex);
		}
	} else {
		for (const summary of summaries.functions) {
			if (!summary.externallyReachable) continue;
			const fn = functionsByIndex.get(summary.functionIndex);
			if (fn !== undefined) openAllParameters(fn);
			openReceivers.add(summary.functionIndex);
		}
	}

	const calls: Array<CoreInterproceduralCallSite> = [];
	let namedEdges = 0;
	let openSites = 0;
	let anyScriptSite = false;
	for (const caller of program.functions) {
		for (const block of caller.blocks) {
			for (const instruction of block.instructions) {
				const callback = instruction.attributes.directCallbackFunctionIndex;
				const callbackFunction =
					typeof callback === "number" ? functionsByIndex.get(callback) : undefined;
				if (callbackFunction !== undefined) {
					const known = instruction.attributes.knownBuiltinCall;
					const operation =
						known !== null && typeof known === "object" && !Array.isArray(known)
							? (known as Readonly<Record<string, unknown>>).operation
							: undefined;
					const reduce =
						operation === "Array.prototype.reduce" ||
						operation === "Array.prototype.reduceRight";
					const callbackArity = reduce ? 4 : 3;
					const numericIndex = reduce ? 2 : 1;
					for (const [index] of callbackFunction.parameters.entries()) {
						if (index >= callbackArity)
							seedParameter(callbackFunction, index, "undefined");
						else if (index === numericIndex)
							seedParameter(callbackFunction, index, "number");
						else openParameter(callbackFunction, index);
					}
					openReceivers.add(callbackFunction.functionIndex);
				}
				const transfer = registry.get(instruction.opcode)?.callTransfer;
				if (transfer === undefined) continue;
				const callee = instruction.inputs[transfer.calleeOperand];
				if (callee === undefined) continue;
				const reaching = summaries.targets.targets(caller.functionIndex, callee);
				const targets = reaching.functions
					.map((target) => functionsByIndex.get(target))
					.filter((target): target is CoreFunction => target !== undefined);
				const open = coreCalleeTargetsAreOpen(reaching);
				if (open) openSites++;
				if (reaching.anyScript) anyScriptSite = true;
				for (const target of targets) {
					if (transfer.arguments.kind === "aggregate") {
						openAllParameters(target);
					}
					if (transfer.invocation === "construct") {
						openReceivers.add(target.functionIndex);
					}
				}
				namedEdges += targets.length;
				calls.push({
					caller: caller.functionIndex,
					instruction,
					targets,
					open,
					transfer,
				});
			}
		}
	}
	if (anyScriptSite) {
		for (const fn of program.functions) {
			openAllParameters(fn);
			openReceivers.add(fn.functionIndex);
		}
	}

	return {
		calls,
		parameterOpen: (functionIndex, parameterIndex) =>
			openParameters.get(functionIndex)?.has(parameterIndex) === true,
		parametersOpen: (functionIndex) => (openParameters.get(functionIndex)?.size ?? 0) > 0,
		parameterSeed: (functionIndex, parameterIndex) =>
			parameterSeeds.get(functionIndex)?.get(parameterIndex),
		receiverOpen: (functionIndex) => openReceivers.has(functionIndex),
		statistics: {
			calls: calls.length,
			namedEdges,
			openSites,
			openParameterEntries: [...openParameters.values()].filter(
				(positions) => positions.size > 0,
			).length,
			openParameterPositions: [...openParameters.values()].reduce(
				(count, positions) => count + positions.size,
				0,
			),
			openReceiverEntries: openReceivers.size,
		},
	};
}
