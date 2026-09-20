import type { CoreEditor } from "./core-editor.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "./core-internal-attributes.ts";
import { coreTerminatorInput } from "./core-ir-control-flow.ts";
import { coreInstructionId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export interface CoreVirtualCaptureResult {
	readonly instructionsIntroduced: number;
}

interface Operation {
	readonly id: CoreInstructionId;
	readonly block: CoreBlockId;
	readonly opcode: string;
}

function operations(fn: CoreFunctionStore): ReadonlyArray<Operation> {
	return [...fn.blockIds()].flatMap((block) =>
		[...fn.bodyInstructionIds(block)].map((id) => ({
			id,
			block,
			opcode: fn.instructionOpcodeName(id),
		})),
	);
}

function instructionOperand(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	index: number,
): CoreValueId | undefined {
	if (index < 0 || index >= fn.kernel.instructionOperandCount(instruction)) {
		return undefined;
	}
	return fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index);
}

function valueUseCount(fn: CoreFunctionStore, value: CoreValueId): number {
	let count = fn.kernel.valueHandlerUseCount(value);
	for (let use = fn.kernel.valueFirstUse(value); use >= 0; use = fn.kernel.useNext(use)) {
		if (fn.kernel.useLive(use) !== 0) count++;
	}
	return count;
}

function singleUseInstruction(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CoreInstructionId | undefined {
	if (fn.kernel.valueHandlerUseCount(value) !== 0) return undefined;
	let result: CoreInstructionId | undefined;
	for (let use = fn.kernel.valueFirstUse(value); use >= 0; use = fn.kernel.useNext(use)) {
		if (fn.kernel.useLive(use) === 0) continue;
		if (result !== undefined) return undefined;
		result = coreInstructionId(fn.kernel.useInstruction(use));
	}
	return result;
}

function capturedSlotMatches(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	scopeId: number,
): boolean {
	const attributes = fn.instructionAttributes(instruction);
	return attributes.functionIndex === scopeId && attributes.index === 0;
}

function createdFunctionIndex(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CoreFunctionId | undefined {
	const functionIndex = fn.instructionAttributes(instruction).functionIndex;
	return typeof functionIndex === "number"
		? (functionIndex as CoreFunctionId)
		: undefined;
}

function reachesThroughEmptyJumps(
	fn: CoreFunctionStore,
	source: CoreBlockId,
	target: CoreBlockId,
): boolean {
	let block = source;
	const visited = new Set<CoreBlockId>();
	while (visited.size < 8 && !visited.has(block)) {
		if (block === target) return true;
		visited.add(block);
		if ([...fn.bodyInstructionIds(block)].length !== 0) return false;
		const terminator = coreTerminatorInput(fn, fn.blockTerminator(block));
		if (terminator.kind !== "jump") return false;
		block = terminator.edge.block;
	}
	return false;
}

/** Virtualizes the one-slot per-iteration scope exposed by two-wave callback inlining. */
export function virtualizeGuardedCallbackEnvironment(
	program: CoreProgram,
	functionId: CoreFunctionId,
	editor: CoreEditor,
): CoreVirtualCaptureResult | undefined {
	const fn = program.function(functionId);
	if (fn.isAsync || fn.isGenerator) return undefined;
	const all = operations(fn);
	if (
		all.some(
			({ opcode }) =>
				opcode === "createArgumentsObject" ||
				opcode === "createPrivateNames" ||
				opcode.startsWith("with"),
		)
	) {
		return undefined;
	}
	const pushes = all.filter(({ opcode }) => opcode === "envPush");
	const copies = all.filter(({ opcode }) => opcode === "envCopy");
	const pops = all.filter(({ opcode }) => opcode === "envPop");
	if (pushes.length !== 1 || copies.length === 0 || pops.length !== 1) {
		return undefined;
	}
	const scope = fn.instructionAttributes(pushes[0]!.id);
	if (
		typeof scope.scopeId !== "number" ||
		scope.scopeId >= 0 ||
		scope.slotCount !== 1 ||
		!copies.every(({ id }) => {
			const attributes = fn.instructionAttributes(id);
			return attributes.scopeId === scope.scopeId && attributes.slotCount === 1;
		})
	) {
		return undefined;
	}
	for (const block of fn.blockIds()) {
		if (fn.kernel.blockHandlerBlock(block) !== undefined) return undefined;
	}

	const loads = all.filter(({ opcode }) => opcode === "loadCaptured");
	const stores = all.filter(({ opcode }) => opcode === "storeCaptured");
	if (
		loads.length !== 1 ||
		stores.length < 1 ||
		![...loads, ...stores].every(({ id }) =>
			capturedSlotMatches(fn, id, scope.scopeId as number),
		)
	) {
		return undefined;
	}

	const fallbackCalls = all.filter(
		({ id, opcode }) =>
			opcode === "call" &&
			fn.instructionAttributes(id)[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE] === true,
	);
	if (fallbackCalls.length !== 1) return undefined;
	const fallbackCall = fallbackCalls[0]!;
	const creations = all.filter(({ opcode }) => opcode === "createFunction");
	const liveCreations = creations.filter(({ id }) => {
		const result = fn.kernel.resultAt(fn.kernel.instructionResultStart(id));
		return valueUseCount(fn, result) !== 0;
	});
	if (liveCreations.length !== 1) return undefined;
	const creation = liveCreations[0]!;
	const closure = fn.kernel.resultAt(fn.kernel.instructionResultStart(creation.id));
	if (
		creation.block !== fallbackCall.block ||
		singleUseInstruction(fn, closure) !== fallbackCall.id ||
		![...Array(fn.kernel.instructionOperandCount(fallbackCall.id)).keys()].some(
			(index) => instructionOperand(fn, fallbackCall.id, index) === closure,
		)
	) {
		return undefined;
	}
	const targetId = createdFunctionIndex(fn, creation.id);
	if (targetId === undefined) return undefined;
	if (
		creations.some(({ id }) => createdFunctionIndex(fn, id) !== targetId) ||
		fn.instructionNext(fallbackCall.id) !== fn.blockTerminator(fallbackCall.block)
	) {
		return undefined;
	}
	const target = program.function(targetId);
	if (target.isAsync || target.isGenerator || target.metadata.capturedCount !== 0) {
		return undefined;
	}
	const targetCaptured = operations(target).filter(
		({ opcode }) => opcode === "loadCaptured" || opcode === "storeCaptured",
	);
	if (
		targetCaptured.length === 0 ||
		targetCaptured.some(
			({ id, opcode }) =>
				opcode !== "loadCaptured" ||
				!capturedSlotMatches(target, id, scope.scopeId as number),
		)
	) {
		return undefined;
	}

	let guardBlock: CoreBlockId | undefined;
	let fastBlock: CoreBlockId | undefined;
	for (const block of fn.blockIds()) {
		const terminator = coreTerminatorInput(fn, fn.blockTerminator(block));
		if (terminator.kind !== "branch") continue;
		if (terminator.consequent.block === fallbackCall.block) {
			if (guardBlock !== undefined) return undefined;
			guardBlock = block;
			fastBlock = terminator.alternate.block;
		} else if (terminator.alternate.block === fallbackCall.block) {
			if (guardBlock !== undefined) return undefined;
			guardBlock = block;
			fastBlock = terminator.consequent.block;
		}
	}
	if (
		guardBlock === undefined ||
		fastBlock === undefined ||
		!reachesThroughEmptyJumps(fn, fastBlock, loads[0]!.block) ||
		stores.some(({ block }) => block !== guardBlock)
	) {
		return undefined;
	}
	const orderedGuardStores = [...fn.bodyInstructionIds(guardBlock)].filter(
		(instruction) => fn.instructionOpcodeName(instruction) === "storeCaptured",
	);
	if (orderedGuardStores.length !== stores.length) return undefined;
	const capturedValue = instructionOperand(fn, orderedGuardStores.at(-1)!, 0);
	const loadedValue = fn.kernel.resultAt(fn.kernel.instructionResultStart(loads[0]!.id));
	if (
		capturedValue === undefined ||
		fn.valueRepresentation(capturedValue) !== fn.valueRepresentation(loadedValue)
	) {
		return undefined;
	}

	editor.replaceValueUses(loadedValue, capturedValue);
	editor.removeInstruction(loads[0]!.id);
	for (const store of stores) editor.removeInstruction(store.id);
	for (const operation of [...pushes, ...copies, ...pops]) {
		editor.removeInstruction(operation.id);
	}
	for (const candidate of creations) {
		if (candidate.id === creation.id) continue;
		const result = fn.kernel.resultAt(fn.kernel.instructionResultStart(candidate.id));
		if (valueUseCount(fn, result) !== 0) {
			throw new Error("Validated virtual capture creation became live");
		}
		editor.removeInstruction(candidate.id);
	}
	const sourcePosition = fn.instructionSourcePosition(creation.id);
	editor.insertInstruction(fallbackCall.block, creation.id, "envPush", [], {
		attributes: { scopeId: scope.scopeId, slotCount: 1 },
		sourcePosition,
	});
	editor.insertInstruction(
		fallbackCall.block,
		creation.id,
		"storeCaptured",
		[capturedValue],
		{
			attributes: { functionIndex: scope.scopeId, index: 0 },
			sourcePosition,
		},
	);
	editor.insertInstruction(
		fallbackCall.block,
		fn.blockTerminator(fallbackCall.block),
		"envPop",
		[],
		{ sourcePosition: fn.instructionSourcePosition(fallbackCall.id) },
	);
	return { instructionsIntroduced: 3 };
}
