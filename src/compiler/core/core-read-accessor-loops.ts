import { buildCoreControlFlow, coreCanonicalValueRoots } from "./core-ir-control-flow.ts";
import type { CoreControlFlow, CoreNaturalLoop } from "./core-ir-control-flow.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import { coreBlockId, coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { ReadRegion } from "./core-read-accessor-expansion.ts";
import { coreAccessorTerminalReadIndex } from "./core-read-accessors.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export interface CoreReadAccessorLoopPlan {
	readonly loop: CoreNaturalLoop;
	readonly paths: ReadonlyMap<CoreValueId, string>;
	readonly prefixes: ReadonlyArray<string>;
	readonly retainedPrefixes: ReadonlyArray<string>;
	readonly numericGuards: ReadonlyArray<CoreValueId>;
	readonly numericReads: ReadonlySet<CoreInstructionId>;
	readonly invalidators: ReadonlySet<CoreInstructionId>;
	readonly arrayWrites: ReadonlyArray<{
		readonly instruction: CoreInstructionId;
		readonly receiver: CoreValueId;
		readonly allocation: CoreInstructionId;
	}>;
}

const loopAnalyses = new WeakMap<
	CoreFunctionStore,
	{
		body: number;
		cfg: number;
		exceptionFlow: number;
		memoryEffects: number;
		flow: CoreControlFlow;
		roots: ReadonlyMap<CoreValueId, CoreValueId>;
	}
>();

export function invalidateCoreReadAccessorLoopAnalysis(fn: CoreFunctionStore): void {
	loopAnalyses.delete(fn);
}

export function accessorPrefixKey(
	parent: string,
	kind: "private" | "named",
	key: number,
): string {
	return `${parent}/${kind}:${key}`;
}

function inputs(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): Array<CoreValueId> {
	return Array.from(
		{ length: fn.kernel.instructionOperandCount(instruction) },
		(_, index) =>
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index),
	);
}

export function coreReadAccessorLoopPlan(
	program: CoreProgram,
	fn: CoreFunctionStore,
	region: ReadRegion,
	charge: (work: number) => void,
): CoreReadAccessorLoopPlan | undefined {
	if (
		![...region.calls.values()].some(
			({ reads }) => coreAccessorTerminalReadIndex(reads) > 0,
		)
	)
		return undefined;
	let analysis = loopAnalyses.get(fn);
	if (
		analysis?.body !== fn.version("body") ||
		analysis.cfg !== fn.version("cfg") ||
		analysis.exceptionFlow !== fn.version("exceptionFlow") ||
		analysis.memoryEffects !== fn.version("memoryEffects")
	) {
		charge(fn.instructionCapacity + fn.blockCapacity);
		const flow = buildCoreControlFlow(program, fn.id);
		analysis = {
			body: fn.version("body"),
			cfg: fn.version("cfg"),
			exceptionFlow: fn.version("exceptionFlow"),
			memoryEffects: fn.version("memoryEffects"),
			flow,
			roots: coreCanonicalValueRoots(fn, flow),
		};
		loopAnalyses.set(fn, analysis);
	}
	const { flow, roots } = analysis;
	// The innermost loop carries the prefix; an enclosing loop re-admits it on each entry.
	const loop = flow.loops
		.filter((candidate) => candidate.blocks.has(region.block))
		.reduce<(typeof flow.loops)[number] | undefined>(
			(innermost, candidate) =>
				innermost === undefined || candidate.depth > innermost.depth
					? candidate
					: innermost,
			undefined,
		);
	if (
		loop === undefined ||
		!loop.canonical ||
		loop.preheader === undefined ||
		loop.latches.size !== 1 ||
		loop.blocks.size > 8 ||
		flow.loops.some((other) => other.parentHeader === loop.header)
	)
		return undefined;
	if (
		flow.irreducibleCycles.some((cycle) =>
			[...cycle.blocks].some((block) => loop.blocks.has(block)),
		)
	)
		return undefined;
	if (
		[...loop.blocks].some((block) => {
			const handler = fn.kernel.blockHandlerBlock(block);
			return handler !== undefined && loop.blocks.has(handler);
		})
	)
		return undefined;
	const root = (value: CoreValueId) => roots.get(value) ?? value;
	const outside = (value: CoreValueId) => {
		const resolved = root(value);
		const owner = fn.kernel.valueDefinitionOwner(resolved);
		const block =
			fn.kernel.valueDefinitionKind(resolved) === 1
				? fn.instructionBlock(coreInstructionId(owner))
				: coreBlockId(owner);
		return !loop.blocks.has(block) && flow.dominates(block, loop.header);
	};
	const paths = new Map<CoreValueId, string>();
	const prefixes = new Set<string>();
	const retainedPrefixes = new Set<string>();
	const path = (value: CoreValueId): string | undefined => {
		const resolved = root(value);
		const known = paths.get(value) ?? paths.get(resolved);
		if (known !== undefined) return known;
		if (!outside(resolved)) return undefined;
		const identity = `value:${resolved}`;
		paths.set(value, identity);
		paths.set(resolved, identity);
		return identity;
	};
	for (const instruction of region.instructions) {
		const args = inputs(fn, instruction),
			opcode = fn.instructionOpcodeName(instruction);
		const output =
			fn.kernel.instructionResultCount(instruction) === 0
				? undefined
				: fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
		if (opcode === "loadPropertyStatic") {
			const receiver = root(args[0]!);
			if (
				fn.kernel.valueDefinitionKind(receiver) === 1 &&
				fn.instructionOpcodeName(
					coreInstructionId(fn.kernel.valueDefinitionOwner(receiver)),
				) === "createArray"
			)
				return undefined;
			const parent = path(args[0]!);
			if (parent === undefined) return undefined;
			const identity = accessorPrefixKey(
				parent,
				"named",
				fn.instructionAttributes(instruction).stringIndex as number,
			);
			paths.set(output!, identity);
			prefixes.add(identity);
		} else if (opcode === "call") {
			const call = region.calls.get(instruction);
			if (call === undefined || path(args[0]!) === undefined) return undefined;
			let parent = path(args[1]!);
			if (parent === undefined) return undefined;
			const terminal = coreAccessorTerminalReadIndex(call.reads);
			if (terminal < 1) return undefined;
			for (const read of call.reads.slice(0, terminal)) {
				if (read.kind === "indexed")
					throw new Error("Unexpected indexed accessor prefix");
				parent = accessorPrefixKey(
					parent,
					read.kind,
					read.kind === "private" ? read.slot : read.stringIndex,
				);
				prefixes.add(parent);
			}
			retainedPrefixes.add(parent);
		} else if (opcode === "loadPrivate") return undefined;
	}
	if (prefixes.size < 2 || prefixes.size > 8) return undefined;
	const regionInstructions = new Set(region.instructions);
	for (const instruction of region.instructions) {
		if (fn.instructionOpcodeName(instruction) !== "loadPropertyStatic") continue;
		const value = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
		let needed = fn.kernel.valueHandlerUseCount(value) > 0;
		for (
			let use = fn.kernel.valueFirstUse(value);
			!needed && use >= 0;
			use = fn.kernel.useNext(use)
		) {
			charge(1);
			const consumer = fn.kernel.useInstruction(use);
			if (
				!regionInstructions.has(consumer) ||
				(region.calls.has(consumer)
					? inputs(fn, consumer).slice(2).includes(value)
					: fn.instructionOpcodeName(consumer) !== "loadPropertyStatic")
			)
				needed = true;
		}
		if (needed) retainedPrefixes.add(paths.get(value)!);
	}
	const numericGuards = new Set<CoreValueId>();
	const numericReads = new Set<CoreInstructionId>();
	const checked = new Map<CoreValueId, boolean>();
	const numeric = (value: CoreValueId, remaining = 32): boolean => {
		charge(1);
		const resolved = root(value);
		if (remaining <= 0) return false;
		if (["f64", "i32"].includes(fn.valueRepresentation(resolved))) return true;
		if (outside(resolved)) {
			numericGuards.add(resolved);
			return true;
		}
		if (checked.has(resolved)) return checked.get(resolved)!;
		checked.set(resolved, false);
		if (fn.kernel.valueDefinitionKind(resolved) === 1) {
			const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(resolved));
			const opcode = fn.instructionOpcodeName(definition);
			if (opcode === "call" && region.calls.has(definition)) {
				// A read can change type while its admitted owner stays the same.
				numericReads.add(definition);
				checked.set(resolved, true);
				return true;
			}
			const okay =
				(opcode === "binary" ||
					(opcode === "unary" &&
						["+", "-", "~", "increment", "decrement"].includes(
							fn.instructionAttributes(definition).operator as string,
						))) &&
				inputs(fn, definition).every((value) => numeric(value, remaining - 1));
			checked.set(resolved, okay);
			return okay;
		}
		const owner = coreBlockId(fn.kernel.valueDefinitionOwner(resolved));
		const parameterStart = fn.kernel.blockParameterStart(owner);
		const parameterIndex = Array.from(
			{ length: fn.kernel.blockParameterCount(owner) },
			(_, index) => index,
		).find((index) => fn.kernel.blockParameterValue(parameterStart + index) === resolved);
		const incoming =
			flow.predecessors[owner]?.filter(({ kind }) => kind === "ordinary") ?? [];
		const okay =
			parameterIndex !== undefined &&
			incoming.length > 0 &&
			incoming.every(
				(edge) =>
					edge.arguments[parameterIndex] !== undefined &&
					numeric(edge.arguments[parameterIndex], remaining - 1),
			);
		checked.set(resolved, okay);
		return okay;
	};
	const included = new Set(region.instructions),
		invalidators = new Set<CoreInstructionId>();
	const arrayWrites: Array<{
		instruction: CoreInstructionId;
		receiver: CoreValueId;
		allocation: CoreInstructionId;
	}> = [];
	let visits = 0;
	for (const block of loop.blocks) {
		for (const instruction of fn.bodyInstructionIds(block)) {
			charge(1);
			if (++visits > 96) return undefined;
			if (included.has(instruction) && fn.instructionOpcodeName(instruction) !== "binary")
				continue;
			const opcode = fn.instructionOpcodeName(instruction),
				effects = coreInstructionEffects(fn, instruction);
			if (
				opcode === "callKnown" &&
				fn.instructionAttributes(instruction).specialized === "Array.prototype.push"
			) {
				const receiver = root(inputs(fn, instruction)[0]!);
				if (fn.kernel.valueDefinitionKind(receiver) === 1) {
					const allocation = coreInstructionId(fn.kernel.valueDefinitionOwner(receiver));
					if (
						fn.instructionOpcodeName(allocation) === "createArray" &&
						outside(receiver)
					) {
						arrayWrites.push({ instruction, receiver, allocation });
						continue;
					}
				}
			}
			if (
				opcode === "binary" &&
				["===", "!=="].includes(fn.instructionAttributes(instruction).operator as string)
			)
				continue;
			if (
				(opcode === "binary" ||
					(opcode === "unary" &&
						["+", "-", "~", "increment", "decrement"].includes(
							fn.instructionAttributes(instruction).operator as string,
						))) &&
				inputs(fn, instruction).every((value) => numeric(value))
			)
				continue;
			if (included.has(instruction)) return undefined;
			if (effects.callsUserCode || effects.maySuspend || effects.writes.length > 0)
				invalidators.add(instruction);
		}
	}
	if (numericGuards.size + numericReads.size > 8) return undefined;
	return {
		loop,
		paths,
		prefixes: [...prefixes],
		retainedPrefixes: [...retainedPrefixes],
		numericGuards: [...numericGuards],
		numericReads,
		invalidators,
		arrayWrites,
	};
}
