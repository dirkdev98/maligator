import { CoreFunctionBuilder } from "./core-builder.ts";
import type { ConstructedCoreCompilation } from "./core-compilation.ts";
import { CoreEditor } from "./core-editor.ts";
import { coreTerminatorInput } from "./core-ir-control-flow.ts";
import { coreInstructionId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

interface Capture {
	readonly owner: number;
	readonly index: number;
}

interface Creation {
	readonly caller: CoreFunctionId;
	readonly instruction: CoreInstructionId;
}

function inputs(fn: CoreFunctionStore, instruction: CoreInstructionId) {
	const start = fn.kernel.instructionOperandStart(instruction);
	return Array.from(
		{ length: fn.kernel.instructionOperandCount(instruction) },
		(_, index) => fn.kernel.operandAt(start + index),
	);
}

function capture(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): Capture | undefined {
	const { functionIndex, index } = fn.instructionAttributes(instruction);
	return typeof functionIndex === "number" && typeof index === "number"
		? { owner: functionIndex, index }
		: undefined;
}

function key(slot: Capture): string {
	return `${slot.owner}:${slot.index}`;
}

// Linear helpers can be cloned without relocating guard facts or exception edges.
function linearBody(fn: CoreFunctionStore): ReadonlyArray<CoreBlockId> | undefined {
	if (
		fn.isAsync ||
		fn.isGenerator ||
		!fn.metadata.strict ||
		fn.metadata.capturedCount !== 0 ||
		fn.kernel.blockParameterCount(fn.entry) !== fn.parameterCount ||
		fn.metadata.mappedArguments ||
		[...fn.factIds()].length !== 0
	)
		return undefined;
	const blocks: Array<CoreBlockId> = [];
	let block = fn.entry;
	while (!blocks.includes(block)) {
		if (fn.kernel.blockHandlerBlock(block) !== undefined) return undefined;
		blocks.push(block);
		for (const instruction of fn.bodyInstructionIds(block)) {
			const opcode = fn.instructionOpcodeName(instruction);
			if (
				fn.instructionEffectRefinement(instruction) !== undefined ||
				opcode === "loadCallee" ||
				opcode === "loadArgumentCount" ||
				opcode === "loadArgument" ||
				opcode === "loadStaticArgument" ||
				opcode === "createFunction" ||
				opcode === "createArgumentsObject" ||
				opcode === "createRestArguments" ||
				opcode === "callRestArguments" ||
				opcode === "storeCaptured" ||
				opcode === "createPrivateNames" ||
				opcode.startsWith("env") ||
				opcode.startsWith("with")
			)
				return undefined;
		}
		const terminator = coreTerminatorInput(fn, fn.blockTerminator(block));
		if (terminator.kind === "return" || terminator.kind === "throw") {
			return blocks.length === [...fn.blockIds()].length ? blocks : undefined;
		}
		if (terminator.kind !== "jump") return undefined;
		block = terminator.edge.block;
	}
	return undefined;
}

function localCalls(
	program: CoreProgram,
	target: CoreFunctionStore,
	creations: ReadonlyArray<Creation>,
	owner: number,
): ReadonlyArray<CoreInstructionId> | undefined {
	const calls = new Set<CoreInstructionId>();
	for (const creation of creations) {
		if (creation.caller !== owner) return undefined;
		const caller = program.function(creation.caller);
		if (caller.isAsync || caller.isGenerator) return undefined;
		const value = caller.kernel.resultAt(
			caller.kernel.instructionResultStart(creation.instruction),
		);
		if (caller.kernel.valueHandlerUseCount(value) !== 0) return undefined;
		for (
			let use = caller.kernel.valueFirstUse(value);
			use >= 0;
			use = caller.kernel.useNext(use)
		) {
			if (caller.kernel.useLive(use) === 0) continue;
			const instruction = coreInstructionId(caller.kernel.useInstruction(use));
			if (caller.instructionKind(instruction) !== "operation") return undefined;
			const opcode = caller.instructionOpcodeName(instruction);
			if (opcode === "throwIfTdz") continue;
			const arguments_ = inputs(caller, instruction);
			if (
				opcode !== "call" ||
				arguments_[0] !== value ||
				arguments_.length !== target.parameterCount + 2 ||
				arguments_.slice(1).includes(value)
			)
				return undefined;
			calls.add(instruction);
		}
	}
	return calls.size > 0 ? [...calls] : undefined;
}

function localStoredCapture(
	fn: CoreFunctionStore,
	call: CoreInstructionId,
	slot: Capture,
): CoreValueId | undefined {
	let previous = fn.instructionPrevious(call);
	// A bounded local search avoids rescanning a large creator for every call.
	for (let inspected = 0; previous !== undefined && inspected < 64; inspected++) {
		if (fn.instructionOpcodeName(previous) === "storeCaptured") {
			const stored = capture(fn, previous);
			if (stored?.owner === slot.owner && stored.index === slot.index)
				return inputs(fn, previous)[0];
		}
		previous = fn.instructionPrevious(previous);
	}
	return undefined;
}

function liftHelper(
	program: CoreProgram,
	fn: CoreFunctionStore,
	blocks: ReadonlyArray<CoreBlockId>,
	captures: ReadonlyArray<Capture>,
): CoreFunctionId {
	const builder = new CoreFunctionBuilder(program, {
		parameterCount: fn.parameterCount + captures.length,
		metadata: fn.metadata,
	});
	const entry = builder.createBlock([
		...Array.from({ length: fn.parameterCount }, (_, index) => ({
			representation: fn.valueRepresentation(fn.kernel.functionParameter(index)),
		})),
		...captures.map(() => ({})),
	]);
	const values = new Map<CoreValueId, CoreValueId>();
	for (let index = 0; index < fn.parameterCount; index++) {
		values.set(
			fn.kernel.functionParameter(index),
			builder.blockParameterValue(entry, index),
		);
	}
	const captureValues = new Map(
		captures.map((slot, index) => [
			key(slot),
			builder.blockParameterValue(entry, fn.parameterCount + index),
		]),
	);
	const mapped = (value: CoreValueId): CoreValueId => {
		const result = values.get(value);
		if (result === undefined) throw new Error(`Unmapped local-helper value ${value}`);
		return result;
	};
	for (const block of blocks) {
		for (const instruction of fn.bodyInstructionIds(block)) {
			const opcode = fn.instructionOpcodeName(instruction);
			const start = fn.kernel.instructionResultStart(instruction);
			const count = fn.kernel.instructionResultCount(instruction);
			if (opcode === "loadCaptured") {
				values.set(
					fn.kernel.resultAt(start),
					captureValues.get(key(capture(fn, instruction)!))!,
				);
				continue;
			}
			const outputs = builder.appendInstruction(
				entry,
				opcode,
				inputs(fn, instruction).map(mapped),
				{
					attributes: fn.instructionAttributes(instruction),
					sourcePosition: fn.instructionSourcePosition(instruction),
					outputCount: count,
					outputRepresentations: Array.from({ length: count }, (_, index) =>
						fn.valueRepresentation(fn.kernel.resultAt(start + index)),
					),
				},
			);
			for (let index = 0; index < count; index++)
				values.set(fn.kernel.resultAt(start + index), outputs[index]!);
		}
		const terminator = coreTerminatorInput(fn, fn.blockTerminator(block));
		if (terminator.kind === "jump") {
			const arguments_ = terminator.edge.arguments.map(mapped);
			const start = fn.kernel.blockParameterStart(terminator.edge.block);
			for (const [index, value] of arguments_.entries()) {
				values.set(fn.kernel.blockParameterValue(start + index), value);
			}
		} else if (terminator.kind === "return" || terminator.kind === "throw") {
			builder.setTerminator(entry, { ...terminator, value: mapped(terminator.value) });
		}
	}
	return builder.finish(entry).function;
}

/** Supply stable-for-the-call captures as ordinary SSA inputs to private helper entries. */
export function liftLocalCaptureArguments(
	compilation: ConstructedCoreCompilation,
): number {
	const { program, context } = compilation;
	if (context.facts.closure.sourceClosure.kind !== "known") return 0;
	const functions = [...program.functionIds()];
	const creations = new Map<number, Array<Creation>>();
	const writers = new Map<string, Set<CoreFunctionId>>();
	const mappedArguments = new Set<string>();
	const privateNames = new Set<string>();
	for (const id of functions) {
		const fn = program.function(id);
		for (const index of fn.metadata.mappedArgumentSlots)
			mappedArguments.add(key({ owner: id, index }));
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode.startsWith("with")) return 0;
			if (opcode === "createFunction") {
				const target = fn.instructionAttributes(instruction).functionIndex;
				if (typeof target !== "number") continue;
				const sites = creations.get(target) ?? [];
				sites.push({ caller: id, instruction });
				creations.set(target, sites);
			} else if (opcode === "storeCaptured") {
				const slot = capture(fn, instruction);
				if (slot === undefined) return 0;
				const owners = writers.get(key(slot)) ?? new Set();
				owners.add(id);
				writers.set(key(slot), owners);
			} else if (opcode === "createPrivateNames") {
				const attributes = fn.instructionAttributes(instruction);
				if (
					typeof attributes.functionIndex !== "number" ||
					!Array.isArray(attributes.capturedIndices)
				)
					return 0;
				for (const index of attributes.capturedIndices) {
					if (typeof index !== "number") return 0;
					privateNames.add(key({ owner: attributes.functionIndex, index }));
				}
			}
		}
	}
	let lifted = 0;
	for (const id of functions) {
		const sites = creations.get(id);
		if (sites === undefined || sites.length === 0) continue;
		const fn = program.function(id);
		const blocks = linearBody(fn);
		if (blocks === undefined) continue;
		const captures = new Map<string, Capture>();
		for (const block of blocks)
			for (const instruction of fn.bodyInstructionIds(block)) {
				if (fn.instructionOpcodeName(instruction) !== "loadCaptured") continue;
				const slot = capture(fn, instruction);
				if (slot !== undefined) captures.set(key(slot), slot);
			}
		if (captures.size === 0 || fn.parameterCount + captures.size > 16) continue;
		const slots = [...captures.values()].sort(
			(a, b) => a.owner - b.owner || a.index - b.index,
		);
		const owner = slots[0]!.owner;
		if (
			owner < 0 ||
			slots.some(
				(slot) =>
					slot.owner !== owner ||
					mappedArguments.has(key(slot)) ||
					privateNames.has(key(slot)) ||
					[...(writers.get(key(slot)) ?? [])].some((writer) => writer !== owner),
			)
		)
			continue;
		const calls = localCalls(program, fn, sites, owner);
		if (calls === undefined) continue;
		// The creator is synchronously suspended during every admitted call. No other
		// function or arguments alias can write these bindings until the call returns.
		const target = liftHelper(program, fn, blocks, slots);
		const caller = program.function(sites[0]!.caller);
		const editor = CoreEditor.open(program, caller.id);
		for (const { instruction } of sites) {
			editor.replaceInstruction(instruction, "createFunction", [], {
				attributes: {
					...caller.instructionAttributes(instruction),
					functionIndex: target,
				},
				sourcePosition: caller.instructionSourcePosition(instruction),
			});
		}
		for (const call of calls) {
			const captures = slots.map(
				(slot) =>
					localStoredCapture(caller, call, slot) ??
					editor.insertInstruction(
						caller.instructionBlock(call),
						call,
						"loadCaptured",
						[],
						{
							attributes: { functionIndex: slot.owner, index: slot.index },
							sourcePosition: caller.instructionSourcePosition(call),
						},
					).outputs[0]!,
			);
			editor.replaceOperands(call, [...inputs(caller, call), ...captures]);
		}
		editor.commit();
		lifted++;
	}
	return lifted;
}
