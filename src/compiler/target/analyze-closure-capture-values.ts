import { buildCoreControlFlow } from "../core/core-ir-control-flow.ts";
import type { CoreControlFlow } from "../core/core-ir-control-flow.ts";
import { coreInstructionId } from "../core/core-ir.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
	CoreValueId,
} from "../core/core-ir.ts";
import type { CoreFunctionStore } from "../core/core-store.ts";
import type { ExecutionProgram } from "./execution-ir.ts";
import type { ProgramImage } from "./program-image.ts";
import type { ClosureCaptureValue } from "./runtime-image.ts";
import { withClosureCaptureValues } from "./runtime-image.ts";

interface Capture {
	readonly owner: number;
	readonly index: number;
}

interface Site {
	readonly caller: CoreFunctionId;
	readonly instruction: CoreInstructionId;
}

function captureKey(slot: Capture): string {
	return `${slot.owner}:${slot.index}`;
}

function capture(fn: CoreFunctionStore, instruction: CoreInstructionId): Capture {
	const attributes = fn.instructionAttributes(instruction);
	return { owner: attributes.functionIndex as number, index: attributes.index as number };
}

function firstInput(fn: CoreFunctionStore, instruction: CoreInstructionId): CoreValueId {
	return fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
}

/**
 * Prove immutable snapshots on sealed Core, before physical capture-slot removal.
 * A source const fact alone is insufficient: initialization must precede every
 * creation of this particular closure, and no later execution can reset its cell.
 * The bytecode retains its original loads and owner layout as the generic fallback.
 */
export function analyzeClosureCaptureValues(
	image: ProgramImage,
	program: Pick<ExecutionProgram, "core" | "context" | "functionMap">,
): ProgramImage {
	const { core, context, functionMap } = program;
	if (
		context.facts.closure.sourceClosure.kind !== "known" ||
		context.data.singleAssignmentCapturedSlots.length === 0
	)
		return image;
	const live = functionMap.executionToCore;
	const immutable = new Set(context.data.singleAssignmentCapturedSlots.map(captureKey));
	const creations = new Map<number, Array<Site>>();
	const stores = new Map<string, Array<Site>>();
	const aliases = new Set<string>();
	for (const functionId of live) {
		const fn = core.function(functionId);
		for (const index of fn.metadata.mappedArgumentSlots)
			if (index >= 0) aliases.add(captureKey({ owner: functionId, index }));
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode.startsWith("with")) return image;
			const attributes = fn.instructionAttributes(instruction);
			if (opcode === "createFunction") {
				const target = attributes.functionIndex as number;
				const sites = creations.get(target) ?? [];
				sites.push({ caller: functionId, instruction });
				creations.set(target, sites);
			} else if (opcode === "storeCaptured") {
				const key = captureKey(capture(fn, instruction));
				const sites = stores.get(key) ?? [];
				sites.push({ caller: functionId, instruction });
				stores.set(key, sites);
			} else if (opcode === "createPrivateNames") {
				for (const index of attributes.capturedIndices as ReadonlyArray<number>)
					aliases.add(captureKey({ owner: attributes.functionIndex as number, index }));
			}
		}
	}
	if (
		image.runtime.functions.some((fn) =>
			fn.instructions.some((instruction) => instruction.opcode.startsWith("WITH_")),
		)
	)
		return image;
	const flows = new Map<CoreFunctionId, CoreControlFlow>();
	const flow = (functionId: CoreFunctionId) => {
		let cfg = flows.get(functionId);
		if (cfg === undefined) {
			cfg = buildCoreControlFlow(core, functionId);
			flows.set(functionId, cfg);
		}
		return cfg;
	};
	const positions = new Map<CoreFunctionId, Int32Array>();
	const repeatable = new Map<CoreFunctionId, ReadonlySet<CoreBlockId>>();
	const mayRepeat = (functionId: CoreFunctionId, block: CoreBlockId): boolean => {
		let remaining = repeatable.get(functionId);
		if (remaining === undefined) {
			const cfg = flow(functionId);
			const alive = new Set(cfg.reachable);
			const incoming = new Int32Array(cfg.successors.length);
			const outgoing = new Int32Array(cfg.successors.length);
			for (const from of alive)
				for (const edge of cfg.successors[from] ?? []) {
					if (!alive.has(edge.to)) continue;
					outgoing[from] = outgoing[from]! + 1;
					incoming[edge.to] = incoming[edge.to]! + 1;
				}
			const pending = [...alive].filter((id) => incoming[id] === 0 || outgoing[id] === 0);
			for (let cursor = 0; cursor < pending.length; cursor++) {
				const id = pending[cursor]!;
				if (!alive.delete(id)) continue;
				for (const edge of cfg.successors[id] ?? [])
					if (alive.has(edge.to) && --incoming[edge.to]! === 0) pending.push(edge.to);
				for (const edge of cfg.predecessors[id] ?? [])
					if (alive.has(edge.from) && --outgoing[edge.from]! === 0)
						pending.push(edge.from);
			}
			// Every cycle survives source/sink pruning, including exceptional
			// edges omitted from ordinary loop analysis. Paths between cycles may
			// also survive; rejecting those is conservative and keeps work linear.
			remaining = alive;
			repeatable.set(functionId, remaining);
		}
		return remaining.has(block);
	};
	const dominates = (
		fn: CoreFunctionStore,
		before: CoreInstructionId,
		after: CoreInstructionId,
	): boolean => {
		const from = fn.instructionBlock(before);
		const to = fn.instructionBlock(after);
		if (from !== to) return flow(fn.id).instructionDominatesBlock(from, to);
		let order = positions.get(fn.id);
		if (order === undefined) {
			order = new Int32Array(fn.instructionCapacity);
			for (const block of fn.blockIds()) {
				let index = 0;
				for (const instruction of fn.instructionIds(block)) order[instruction] = index++;
			}
			positions.set(fn.id, order);
		}
		return order[before]! < order[after]!;
	};
	const valueKinds = new Map<
		CoreFunctionId,
		Map<CoreValueId, "empty" | "value" | "unknown">
	>();
	const valueKind = (
		fn: CoreFunctionStore,
		value: CoreValueId,
	): "empty" | "value" | "unknown" => {
		const memo =
			valueKinds.get(fn.id) ?? new Map<CoreValueId, "empty" | "value" | "unknown">();
		valueKinds.set(fn.id, memo);
		const known = memo.get(value);
		if (known !== undefined) return known;
		memo.set(value, "unknown");
		let result: "empty" | "value" | "unknown" = "unknown";
		if (fn.kernel.valueDefinitionKind(value) === 0) {
			for (let index = 0; index < fn.parameterCount; index++)
				if (fn.kernel.functionParameter(index) === value) result = "value";
		} else {
			const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
			const opcode = fn.instructionOpcodeName(definition);
			if (opcode === "move") result = valueKind(fn, firstInput(fn, definition));
			else if (opcode === "createEmpty") result = "empty";
			else if (opcode.startsWith("create") || opcode === "binary" || opcode === "unary")
				result = "value";
		}
		memo.set(value, result);
		return result;
	};
	const initializers = new Map<string, CoreInstructionId | null>();
	const initializer = (slot: Capture): CoreInstructionId | undefined => {
		const key = captureKey(slot);
		const known = initializers.get(key);
		if (known !== undefined) return known ?? undefined;
		initializers.set(key, null);
		if (!immutable.has(key) || aliases.has(key)) return undefined;
		const owner = core.function(slot.owner as CoreFunctionId);
		if (owner.isAsync || owner.isGenerator) return undefined;
		let initialized: CoreInstructionId | undefined;
		const sentinels: Array<CoreInstructionId> = [];
		for (const site of stores.get(key) ?? []) {
			if (site.caller !== slot.owner) return undefined;
			const kind = valueKind(owner, firstInput(owner, site.instruction));
			if (kind === "unknown") return undefined;
			if (kind === "empty") sentinels.push(site.instruction);
			else if (initialized === undefined) initialized = site.instruction;
			else return undefined;
		}
		if (initialized === undefined) return undefined;
		const cfg = flow(owner.id);
		const block = owner.instructionBlock(initialized);
		if (
			!cfg.reachable.has(block) ||
			mayRepeat(owner.id, block) ||
			sentinels.some(
				(store) =>
					owner.instructionBlock(store) !== owner.entry ||
					!dominates(owner, store, initialized),
			) ||
			(sentinels.length > 0 && (cfg.predecessors[owner.entry]?.length ?? 0) > 0)
		)
			return undefined;
		initializers.set(key, initialized);
		return initialized;
	};
	let changed = false;
	const functions = image.runtime.functions.map((runtime, executionIndex) => {
		const id = functionMap.executionToCore[executionIndex]!;
		const fn = core.function(id);
		const sites = creations.get(id);
		if (
			sites === undefined ||
			!fn.metadata.strict ||
			fn.isAsync ||
			fn.isGenerator ||
			fn.metadata.isClassConstructor ||
			fn.metadata.isDerivedConstructor ||
			fn.metadata.capturedCount !== 0 ||
			fn.metadata.mappedArguments
		)
			return runtime;
		const captured = new Map<string, Capture>();
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			if (
				opcode === "storeCaptured" ||
				opcode === "createFunction" ||
				opcode === "createPrivateNames" ||
				opcode.startsWith("env") ||
				opcode.startsWith("with")
			)
				return runtime;
			if (opcode === "loadCaptured") {
				const slot = capture(fn, instruction);
				captured.set(captureKey(slot), slot);
			}
		}
		if (captured.size === 0 || captured.size > 16) return runtime;
		const ownerId = captured.values().next().value!.owner;
		if (
			ownerId < 0 ||
			ownerId === id ||
			[...captured.values()].some((slot) => slot.owner !== ownerId) ||
			sites.some((site) => site.caller !== ownerId)
		)
			return runtime;
		const owner = core.function(ownerId as CoreFunctionId);
		if (
			[...captured.values()].some((slot) => {
				const store = initializer(slot);
				return (
					store === undefined ||
					sites.some((site) => !dominates(owner, store, site.instruction))
				);
			})
		)
			return runtime;
		const ownerFunctionIndex = functionMap.coreToExecution[ownerId];
		if (ownerFunctionIndex === undefined || ownerFunctionIndex < 0) return runtime;
		// Lowering must preserve the complete read-only leaf contract. Keep only
		// slots actually read by emitted instructions after unreachable blocks vanish.
		const values = new Map<number, ClosureCaptureValue>();
		for (const instruction of runtime.instructions) {
			if (
				instruction.opcode === "STORE_CAPTURED" ||
				instruction.opcode === "CREATE_FUNCTION" ||
				instruction.opcode === "CREATE_PRIVATE_NAMES" ||
				instruction.opcode.startsWith("ENV_") ||
				instruction.opcode.startsWith("WITH_")
			)
				return runtime;
			if (instruction.opcode !== "LOAD_CAPTURED") continue;
			if (
				instruction.ownerFunctionIndex !== ownerFunctionIndex ||
				!captured.has(captureKey({ owner: ownerId, index: instruction.index }))
			)
				return runtime;
			values.set(instruction.index, {
				ownerFunctionIndex,
				capturedIndex: instruction.index,
			});
		}
		if (
			values.size === 0 ||
			runtime.capturedCount !== 0 ||
			!runtime.strict ||
			runtime.isAsync ||
			runtime.isGenerator ||
			runtime.isClassConstructor ||
			runtime.isDerivedConstructor ||
			runtime.mappedArguments ||
			runtime.mappedArgumentSlots.length > 0
		)
			return runtime;
		changed = true;
		return withClosureCaptureValues(
			runtime,
			[...values.values()].sort(
				(left, right) => left.capturedIndex - right.capturedIndex,
			),
		);
	});
	return changed ? { ...image, runtime: { ...image.runtime, functions } } : image;
}
