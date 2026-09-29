import { CoreFunctionBuilder } from "./core-builder.ts";
import type { ConstructedCoreCompilation } from "./core-compilation.ts";
import { CoreEditor } from "./core-editor.ts";
import { buildCoreControlFlow, coreTerminatorInput } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
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

interface LocalCallPlan extends Creation {
	readonly calls: ReadonlyArray<CoreInstructionId>;
	readonly preserveIdentity: boolean;
}

interface LocalCaptureAccess {
	readonly singleStores: ReadonlyMap<string, Creation | null>;
	readonly initialized: (slot: Capture, call: CoreInstructionId) => boolean;
	readonly loads: ReadonlyMap<string, ReadonlyArray<CoreInstructionId>>;
	readonly implicitAliases: ReadonlySet<string>;
	readonly dominates: (
		caller: CoreFunctionId,
		store: CoreInstructionId,
		load: CoreInstructionId,
	) => boolean;
}

// Used only while planning, before any editors mutate the construction graph.
function capturedStoreDominance(program: CoreProgram): LocalCaptureAccess["dominates"] {
	const checks = new Map<
		CoreFunctionId,
		(store: CoreInstructionId, load: CoreInstructionId) => boolean
	>();
	return (caller, store, load) => {
		let check = checks.get(caller);
		if (check === undefined) {
			const fn = program.function(caller);
			const positions = new Int32Array(fn.instructionCapacity);
			for (const block of fn.blockIds()) {
				let position = 0;
				for (const instruction of fn.instructionIds(block))
					positions[instruction] = position++;
			}
			let flow: CoreControlFlow | undefined;
			check = (writer, reader) => {
				const from = fn.instructionBlock(writer);
				const to = fn.instructionBlock(reader);
				return from === to
					? positions[writer]! < positions[reader]!
					: (flow ??= buildCoreControlFlow(program, caller)).instructionDominatesBlock(
							from,
							to,
						);
			};
			checks.set(caller, check);
		}
		return check(store, load);
	};
}

// The ordinary argument ABI excludes the internal TDZ sentinel. A private
// capture may use it only after an initializer, not by moving its TDZ check.
function initializedCaptureQueries(
	program: CoreProgram,
	stores: ReadonlyMap<string, ReadonlyArray<Creation>>,
	dominates: LocalCaptureAccess["dominates"],
): LocalCaptureAccess["initialized"] {
	const nonempty = new Map<CoreFunctionId, Map<CoreValueId, boolean>>();
	const entryCanRepeat = new Map<CoreFunctionId, boolean>();
	const layouts = new Map<string, ReadonlyArray<CoreInstructionId>>();
	const initializedValue = (fn: CoreFunctionStore, value: CoreValueId): boolean => {
		const cache = nonempty.get(fn.id) ?? new Map<CoreValueId, boolean>();
		nonempty.set(fn.id, cache);
		const known = cache.get(value);
		if (known !== undefined) return known;
		cache.set(value, false);
		let result = false;
		if (fn.kernel.valueDefinitionKind(value) === 0) {
			for (let index = 0; index < fn.parameterCount; index++)
				if (fn.kernel.functionParameter(index) === value) result = true;
		} else {
			const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
			const opcode = fn.instructionOpcodeName(definition);
			result =
				opcode === "move"
					? initializedValue(fn, inputs(fn, definition)[0]!)
					: (opcode.startsWith("create") && opcode !== "createEmpty") ||
						opcode === "binary" ||
						opcode === "unary";
		}
		cache.set(value, result);
		return result;
	};
	return (slot, call) => {
		const id = key(slot);
		let initializers = layouts.get(id);
		if (initializers === undefined) {
			const fn = program.function(slot.owner as CoreFunctionId);
			const uncertain: Array<CoreInstructionId> = [];
			const definite: Array<CoreInstructionId> = [];
			for (const store of stores.get(id) ?? []) {
				if (store.caller !== fn.id) return false;
				(initializedValue(fn, inputs(fn, store.instruction)[0]!)
					? definite
					: uncertain
				).push(store.instruction);
			}
			// Only entry-prefix sentinel writes may precede initialization. Other
			// unknown writes (including loop/phi resets) need reaching-definition proof.
			let safePrefix = uncertain.every(
				(instruction) => fn.instructionBlock(instruction) === fn.entry,
			);
			if (safePrefix && uncertain.length > 0) {
				let repeats = entryCanRepeat.get(fn.id);
				if (repeats === undefined) {
					repeats =
						(buildCoreControlFlow(program, fn.id).predecessors[fn.entry]?.length ?? 0) >
						0;
					entryCanRepeat.set(fn.id, repeats);
				}
				safePrefix = !repeats;
			}
			initializers = safePrefix
				? definite.filter((write) =>
						uncertain.every((before) => dominates(fn.id, before, write)),
					)
				: [];
			layouts.set(id, initializers);
		}
		return initializers.some((write) =>
			dominates(slot.owner as CoreFunctionId, write, call),
		);
	};
}

function localCalls(
	program: CoreProgram,
	target: CoreFunctionStore,
	creations: ReadonlyArray<Creation>,
	owner: number,
	captures: ReadonlyArray<Capture>,
	access: LocalCaptureAccess,
): ReadonlyArray<LocalCallPlan> | undefined {
	const plans: Array<LocalCallPlan> = [];
	for (const creation of creations) {
		if (creation.caller !== owner) return undefined;
		const caller = program.function(creation.caller);
		if (caller.isAsync || caller.isGenerator) return undefined;
		const root = caller.kernel.resultAt(
			caller.kernel.instructionResultStart(creation.instruction),
		);
		const values = [root];
		const seen = new Set(values);
		const calls = new Set<CoreInstructionId>();
		let preserveIdentity = false;
		for (let cursor = 0; cursor < values.length; cursor++) {
			const value = values[cursor]!;
			preserveIdentity ||= caller.kernel.valueHandlerUseCount(value) !== 0;
			for (
				let use = caller.kernel.valueFirstUse(value);
				use >= 0;
				use = caller.kernel.useNext(use)
			) {
				if (caller.kernel.useLive(use) === 0) continue;
				const instruction = coreInstructionId(caller.kernel.useInstruction(use));
				if (caller.instructionKind(instruction) !== "operation") {
					preserveIdentity = true;
					continue;
				}
				const opcode = caller.instructionOpcodeName(instruction);
				if (opcode === "throwIfTdz") continue;
				if (opcode === "storeCaptured") {
					// Hoisted declarations often reach their local calls through an env
					// binding rather than a direct SSA use. Keep that observable binding,
					// and follow only same-activation reads dominated by its sole writer.
					preserveIdentity = true;
					const slot = capture(caller, instruction);
					if (slot?.owner !== creation.caller) continue;
					const address = key(slot);
					const writer = access.singleStores.get(address);
					if (
						writer?.caller !== creation.caller ||
						writer.instruction !== instruction ||
						access.implicitAliases.has(address)
					)
						continue;
					for (const load of access.loads.get(address) ?? []) {
						if (!access.dominates(creation.caller, instruction, load)) continue;
						const loaded = caller.kernel.resultAt(
							caller.kernel.instructionResultStart(load),
						);
						if (!seen.has(loaded)) {
							seen.add(loaded);
							values.push(loaded);
						}
					}
					continue;
				}
				const arguments_ = inputs(caller, instruction);
				if (
					opcode !== "call" ||
					arguments_[0] !== value ||
					arguments_.length !== target.parameterCount + 2 ||
					arguments_.slice(1).includes(value) ||
					!captures.every((slot) => access.initialized(slot, instruction))
				) {
					// Escape, reflection, construction and other arities keep the original
					// closure. Only exact local calls may use the private capture ABI.
					preserveIdentity = true;
					continue;
				}
				calls.add(instruction);
			}
		}
		plans.push({ ...creation, calls: [...calls], preserveIdentity });
	}
	return plans.some((plan) => plan.calls.length > 0) ? plans : undefined;
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
	const singleStores = new Map<string, Creation | null>();
	const stores = new Map<string, Array<Creation>>();
	const loads = new Map<string, Array<CoreInstructionId>>();
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
				const writes = stores.get(key(slot)) ?? [];
				writes.push({ caller: id, instruction });
				stores.set(key(slot), writes);
				const address = key(slot);
				singleStores.set(
					address,
					singleStores.has(address) ? null : { caller: id, instruction },
				);
				const owners = writers.get(key(slot)) ?? new Set();
				owners.add(id);
				writers.set(key(slot), owners);
			} else if (opcode === "loadCaptured") {
				const slot = capture(fn, instruction);
				if (slot?.owner === id) {
					const address = key(slot);
					const readers = loads.get(address) ?? [];
					readers.push(instruction);
					loads.set(address, readers);
				}
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
	const dominates = capturedStoreDominance(program);
	const access: LocalCaptureAccess = {
		singleStores,
		loads,
		implicitAliases: new Set([...mappedArguments, ...privateNames]),
		dominates,
		initialized: initializedCaptureQueries(program, stores, dominates),
	};
	const candidates: Array<{
		fn: CoreFunctionStore;
		blocks: ReadonlyArray<CoreBlockId>;
		slots: ReadonlyArray<Capture>;
		plans: ReadonlyArray<LocalCallPlan>;
	}> = [];
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
		const plans = localCalls(program, fn, sites, owner, slots, access);
		if (plans !== undefined) candidates.push({ fn, blocks, slots, plans });
	}
	for (const { fn, blocks, slots, plans } of candidates) {
		// The creator is synchronously suspended during every admitted call. No other
		// function or arguments alias can write these bindings until the call returns.
		const target = liftHelper(program, fn, blocks, slots);
		const caller = program.function(plans[0]!.caller);
		const editor = CoreEditor.open(program, caller.id);
		for (const { instruction, calls, preserveIdentity } of plans) {
			if (calls.length === 0) continue;
			const options = {
				attributes: {
					...caller.instructionAttributes(instruction),
					functionIndex: target,
				},
				sourcePosition: caller.instructionSourcePosition(instruction),
			};
			// Retain the observable closure and materialize a separate private target
			// once at the same lexical creation site, never once per loop call.
			const callee = preserveIdentity
				? editor.insertInstruction(
						caller.instructionBlock(instruction),
						instruction,
						"createFunction",
						[],
						options,
					).outputs[0]!
				: caller.kernel.resultAt(caller.kernel.instructionResultStart(instruction));
			if (!preserveIdentity)
				editor.replaceInstruction(instruction, "createFunction", [], options);
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
				editor.replaceOperands(call, [
					callee,
					...inputs(caller, call).slice(1),
					...captures,
				]);
			}
		}
		editor.commit();
	}
	return candidates.length;
}
