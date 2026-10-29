import type { CoreCompilationContext } from "./core-compilation.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreFunctionId, coreInstructionId } from "./core-ir.ts";
import type { CoreBlockId, CoreFunctionId, CoreInstructionId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

/**
 * Functions whose body runs at most once per program run. Every closure that
 * captures such a function's scope sees its one activation, so two functions that
 * both capture it share that environment.
 */
export function coreSingleActivationFunctions(
	program: CoreProgram,
	context: CoreCompilationContext,
): ReadonlySet<CoreFunctionId> {
	const once = new Set<CoreFunctionId>();
	if (context.facts.closure.sourceClosure.kind !== "known") return once;
	const [entry] = program.functionIds();
	if (entry !== undefined) once.add(entry);
	// The loader evaluates each CommonJS module function once and never re-runs it.
	for (const index of context.data.cjsModuleFunctionIndices)
		once.add(coreFunctionId(index));
	const creations = new Map<
		CoreFunctionId,
		Array<{ readonly creator: CoreFunctionId; readonly instruction: CoreInstructionId }>
	>();
	for (const id of program.functionIds()) {
		const fn = program.function(id);
		for (const instruction of fn.instructionIds()) {
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionOpcodeName(instruction) !== "createFunction"
			)
				continue;
			const target = fn.instructionAttributes(instruction).functionIndex;
			if (typeof target !== "number" || !program.hasFunction(target as CoreFunctionId))
				continue;
			const sites = creations.get(target as CoreFunctionId) ?? [];
			sites.push({ creator: id, instruction });
			creations.set(target as CoreFunctionId, sites);
		}
	}
	const flows = new Map<CoreFunctionId, CoreControlFlow>();
	const repeats = (fn: CoreFunctionStore, block: CoreBlockId): boolean => {
		let flow = flows.get(fn.id);
		if (flow === undefined) {
			flow = buildCoreControlFlow(program, fn.id, { exceptions: true });
			flows.set(fn.id, flow);
		}
		return (
			flow.loops.some((loop) => loop.blocks.has(block)) ||
			flow.irreducibleCycles.some((cycle) => cycle.blocks.has(block))
		);
	};
	// A closure created once and invoked once, as an immediately invoked wrapper is.
	const invokedOnce = (target: CoreFunctionId): boolean => {
		const sites = creations.get(target);
		if (sites?.length !== 1 || !once.has(sites[0]!.creator)) return false;
		const { creator, instruction } = sites[0]!;
		const fn = program.function(creator);
		const created = program.function(target);
		if (
			created.isGenerator ||
			created.isAsync ||
			[...created.instructionIds()].some(
				(id) =>
					created.instructionKind(id) === "operation" &&
					created.instructionOpcodeName(id) === "loadCallee",
			) ||
			fn.kernel.valueHandlerUseCount(
				fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)),
			) !== 0 ||
			repeats(fn, fn.instructionBlock(instruction))
		)
			return false;
		const value = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
		let call: CoreInstructionId | undefined;
		for (
			let use = fn.kernel.valueFirstUse(value);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			if (fn.kernel.useLive(use) === 0) continue;
			const user = coreInstructionId(fn.kernel.useInstruction(use));
			if (
				call !== undefined ||
				fn.kernel.useOperand(use) !== 0 ||
				fn.instructionKind(user) !== "operation" ||
				fn.instructionOpcodeName(user) !== "call"
			)
				return false;
			call = user;
		}
		return call !== undefined && !repeats(fn, fn.instructionBlock(call));
	};
	for (let changed = true; changed;) {
		changed = false;
		for (const target of creations.keys()) {
			if (once.has(target) || !invokedOnce(target)) continue;
			once.add(target);
			changed = true;
		}
	}
	return once;
}

interface CoreCaptureScan {
	readonly bodyVersion: number;
	readonly owners: ReadonlySet<number>;
	readonly createsFunctions: boolean;
}

// Inline candidates ask about the same callers and targets once per call site.
const captureScans = new WeakMap<CoreFunctionStore, CoreCaptureScan>();

function coreCaptureScan(fn: CoreFunctionStore): CoreCaptureScan {
	// An open editor's edits move no version until it commits.
	const bodyVersion = fn.hasActiveEditor ? undefined : fn.version("body");
	const cached = captureScans.get(fn);
	if (bodyVersion !== undefined && cached?.bodyVersion === bodyVersion) return cached;
	const owners = new Set<number>();
	let createsFunctions = false;
	for (const instruction of fn.instructionIds()) {
		const header = fn.instructionHeader(instruction);
		if (typeof header === "string") continue;
		const opcode = header.opcode;
		if (opcode === "createFunction") createsFunctions = true;
		if (opcode !== "loadCaptured" && opcode !== "storeCaptured") continue;
		const owner = fn.instructionAttributes(instruction).functionIndex;
		if (typeof owner === "number") owners.add(owner);
	}
	const scan = { bodyVersion: bodyVersion ?? -1, owners, createsFunctions };
	if (bodyVersion !== undefined) captureScans.set(fn, scan);
	return scan;
}

/**
 * The scopes whose environments a body reads or writes through captured slots,
 * by owner index; negative owners are scopes no Core function owns.
 */
export function coreCaptureOwners(fn: CoreFunctionStore): ReadonlySet<number> {
	return coreCaptureScan(fn).owners;
}

export function coreCreatesFunctions(fn: CoreFunctionStore): boolean {
	return coreCaptureScan(fn).createsFunctions;
}
