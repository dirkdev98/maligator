import type { KnownBuiltinCall, WorldFacts } from "../shared/compiler-facts.ts";
import {
	compilerFactIsWorldInvariant,
	knownBuiltinCallProves,
} from "../shared/compiler-facts.ts";
import { COMPILER_INT32_RANGE } from "../shared/integer-range.ts";
import { provePrimordialAccess } from "../shared/primordial-catalog.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreLocalFactBundle } from "./core-ir-provenance.ts";
import type {
	CoreDirectEntryPlan,
	CoreEntryFields,
	CoreEntryResultFields,
	CoreRecordFieldAccess,
	CoreRecordLayout,
	CoreRecordPass,
	CoreRecordUses,
	CorePlanRepresentation,
} from "./core-ir-regions.ts";
import { coreInstructionId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import { coreArgumentObservation } from "./core-native-entry-analysis.ts";
import {
	coreValueOnlyReturned,
	coreReturnedValueDefinition,
} from "./core-record-value-kinds.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";
import { coreFunctionVersionsAreCurrent } from "./core-store.ts";
import type { CoreFunctionVersions } from "./core-store.ts";

const argumentProofs = new WeakMap<
	ReadonlyArray<CorePlanRepresentation>,
	{
		readonly fn: CoreFunctionStore;
		readonly versions: CoreFunctionVersions;
		readonly call: CoreInstructionId;
		readonly allocation: CoreInstructionId;
		readonly keys: ReadonlyArray<number>;
	}
>();

// These read the parameter through the activation rather than as an operand.
const PARAMETER_ALIAS_OPCODES = new Set([
	"loadArgument",
	"loadStaticArgument",
	"createArgumentsObject",
	"createRestArguments",
	"callRestArguments",
]);

export function coreReadOnlyParameterFields(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
): CoreEntryFields | undefined {
	if (
		fn.parameterCount !== 1 ||
		fn.metadata.capturedCount > 0 ||
		cfg.loops.length > 0 ||
		cfg.irreducibleCycles.length > 0 ||
		[...fn.instructionIds()].length > 64
	)
		return undefined;
	const parameter = fn.kernel.functionParameter(0);
	const keys: Array<number> = [];
	const loads: Array<{ instruction: CoreInstructionId; field: number }> = [];
	const numericCalls: Array<CoreInstructionId> = [];
	const math = new Set<CoreValueId>();
	const mathLoads: Array<CoreValueId> = [];
	const callees = new Set<CoreValueId>();
	for (const instruction of fn.instructionIds()) {
		if (!cfg.reachable.has(fn.instructionBlock(instruction))) continue;
		const operands = Array.from(
			{ length: fn.kernel.instructionOperandCount(instruction) },
			(_, i) => fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + i),
		);
		if (fn.instructionKind(instruction) !== "operation") {
			if (
				operands.includes(parameter) ||
				!["jump", "branch", "return"].includes(fn.instructionKind(instruction))
			)
				return undefined;
			continue;
		}
		const opcode = fn.instructionOpcodeName(instruction);
		const attrs = fn.instructionAttributes(instruction);
		if (opcode === "loadPropertyStatic" && operands[0] === parameter) {
			const key = attrs.stringIndex;
			if (typeof key !== "number") return undefined;
			if (!keys.includes(key)) keys.push(key);
			if (keys.length > 4) return undefined;
			loads.push({ instruction, field: keys.indexOf(key) });
			continue;
		}
		if (operands.includes(parameter) || PARAMETER_ALIAS_OPCODES.has(opcode))
			return undefined;
		if (opcode === "loadIntrinsic" && attrs.intrinsic === "Math") {
			math.add(fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)));
			continue;
		}
		if (opcode === "loadPropertyStatic" && math.has(operands[0]!)) {
			mathLoads.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)));
			continue;
		}
		if (opcode === "call" || opcode === "callKnown") {
			if (attrs.construct || attrs.argumentMode !== undefined) return undefined;
			if (opcode === "call") callees.add(operands[0]!);
			const builtin = attrs.knownBuiltinCall as unknown as KnownBuiltinCall | undefined;
			if (
				builtin !== undefined &&
				builtin.operation.startsWith("Math.") &&
				builtin.semantics.kind === "known" &&
				builtin.semantics.value.result === "number" &&
				(opcode === "call"
					? knownBuiltinCallProves(builtin, builtin.operation)
					: builtin.identity.kind === "known" &&
						builtin.identity.value === builtin.operation) &&
				compilerFactIsWorldInvariant(builtin.identity)
			) {
				numericCalls.push(instruction);
				continue;
			}
		}
		// A strict callee exposes no `fn.arguments`, so code it calls cannot reach a record
		// that only its field loads read, or tell that the caller never allocated it.
		if (fn.metadata.strict) continue;
		if (
			![
				"createNumber",
				"createF64",
				"createBoolean",
				"createUndefined",
				"createNull",
				"createString",
				"binary",
				"unary",
				"mathUnaryNumber",
				"mathBinaryNumber",
				"move",
			].includes(opcode)
		)
			return undefined;
	}
	return keys.length === 0 ||
		(!fn.metadata.strict && mathLoads.some((value) => !callees.has(value)))
		? undefined
		: Object.freeze({
				keys: Object.freeze(keys),
				representations: Object.freeze(keys.map(() => "boxed" as const)),
				loads: Object.freeze(loads.map((load) => Object.freeze(load))),
				numericCalls: Object.freeze(numericCalls),
			});
}

export function coreFieldArgument(
	fn: CoreFunctionStore,
	facts: CoreLocalFactBundle,
	call: CoreInstructionId,
	argument: CoreValueId,
	fields: CoreEntryFields,
):
	| {
			readonly instruction: CoreInstructionId;
			readonly valueRepresentations: ReadonlyArray<CorePlanRepresentation>;
			readonly fields: CoreEntryFields;
	  }
	| undefined {
	const layout = facts.provenance.allocationOf(argument);
	if (
		layout?.kind !== "named-slots" ||
		layout.result !== argument ||
		fn.instructionOpcodeName(layout.instruction) !== "createObjectShaped" ||
		layout.keys.length > 4 ||
		layout.keys.length === 0 ||
		fields.keys.some((key) => !layout.keys.includes(key))
	)
		return undefined;
	// A single use keeps identity, aliases, and later mutation out of the deferred literal.
	if (fn.kernel.valueHandlerUseCount(argument) > 0) return undefined;
	const use = fn.kernel.valueFirstUse(argument);
	if (
		use < 0 ||
		fn.kernel.useNext(use) >= 0 ||
		fn.kernel.useInstruction(use) !== call ||
		fn.kernel.useOperand(use) !== 2
	)
		return undefined;
	if (fn.instructionBlock(layout.instruction) !== fn.instructionBlock(call))
		return undefined;
	for (
		let cursor = fn.kernel.instructionNext(layout.instruction);
		cursor >= 0 && cursor !== call;
		cursor = fn.kernel.instructionNext(coreInstructionId(cursor))
	) {
		const instruction = coreInstructionId(cursor);
		if (
			fn.instructionKind(instruction) === "operation" &&
			["yield", "await", "generatorStart"].includes(fn.instructionOpcodeName(instruction))
		)
			return undefined;
	}
	const valueRepresentations = Object.freeze(
		layout.initialValues.map((value): CorePlanRepresentation => {
			const kind = facts.valueKinds.scalarKind(value);
			return kind === "number" ? "f64" : (kind ?? "boxed");
		}),
	);
	argumentProofs.set(valueRepresentations, {
		fn,
		versions: fn.versions,
		call,
		allocation: layout.instruction,
		keys: layout.keys,
	});
	return {
		instruction: layout.instruction,
		valueRepresentations,
		fields: Object.freeze({
			...fields,
			representations: Object.freeze(
				fields.keys.map((key) => valueRepresentations[layout.keys.indexOf(key)]!),
			),
		}),
	};
}

const MAX_RESULT_FIELDS = 16;

/** A key no locked `Object.prototype` has, so reading it from a plain literal finds undefined. */
export function coreRecordKeyAbsent(
	world: WorldFacts,
	program: CoreProgram,
	key: number,
): boolean {
	return (
		provePrimordialAccess(
			world,
			{
				kind: "fresh-allocation",
				prototype: "Object.prototype",
				realm: "current",
				ownKeys: [],
				ownKeysComplete: true,
				stableUntilRead: true,
			},
			program.stringConstantText(key),
		)?.kind === "absent"
	);
}

/** Whether every return of `fn` returns an object literal: the cheap shape of a record producer. */
export function coreReturnsObjectLiterals(fn: CoreFunctionStore): boolean {
	let returns = 0;
	for (const block of fn.blockIds()) {
		const terminator = fn.blockTerminator(block);
		if (fn.instructionKind(terminator) !== "return") continue;
		if (fn.kernel.instructionOperandCount(terminator) !== 1) return false;
		const allocation = coreReturnedValueDefinition(
			fn,
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator)),
		);
		if (
			allocation === undefined ||
			fn.instructionOpcodeName(allocation) !== "createObjectShaped"
		)
			return false;
		returns++;
	}
	return returns > 0;
}

/**
 * The record every reachable return of `fn` creates, when no other code can observe it.
 * With `forwardTarget`, a return may also hand back the result of an exact call to a
 * function whose own returns are such literals, with the same keys. With `absentKey`,
 * literals may differ in keys when a read of each missing key provably finds nothing.
 * With `escapes`, other returns may hand back any value as long as one returns a record.
 */
export function coreRecordResultFields(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	forwardTarget?: (
		call: CoreInstructionId,
	) =>
		| { readonly target: CoreFunctionId; readonly keys: ReadonlyArray<number> }
		| undefined,
	absentKey?: (key: number) => boolean,
	escapes = false,
): CoreEntryResultFields | undefined {
	if (
		fn.isGenerator ||
		fn.isAsync ||
		fn.metadata.isClassConstructor ||
		fn.metadata.isDerivedConstructor
	)
		return undefined;
	let keys: ReadonlyArray<number> | undefined;
	const allocations = new Map<CoreInstructionId, ReadonlyArray<number>>();
	const forwards = new Map<CoreInstructionId, CoreFunctionId>();
	let union = false;
	let escaped = false;
	const sameKeys = (candidate: ReadonlyArray<number>) =>
		keys === undefined ||
		(keys.length === candidate.length &&
			keys.every((key, index) => key === candidate[index]));
	for (const block of cfg.reachable) {
		const terminator = fn.blockTerminator(block);
		if (fn.instructionKind(terminator) !== "return") continue;
		if (fn.kernel.instructionOperandCount(terminator) !== 1) return undefined;
		const allocation = coreReturnedValueDefinition(
			fn,
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator)),
		);
		const opcode =
			allocation === undefined ? undefined : fn.instructionOpcodeName(allocation);
		const forward =
			opcode === "call" && !union ? forwardTarget?.(allocation!) : undefined;
		if (
			allocation === undefined ||
			(opcode === "call" ? forward === undefined : opcode !== "createObjectShaped")
		) {
			if (!escapes) return undefined;
			escaped = true;
			continue;
		}
		if (allocations.has(allocation) || forwards.has(allocation)) continue;
		if (forward !== undefined) {
			if (
				!sameKeys(forward.keys) ||
				!coreValueOnlyReturned(
					fn,
					fn.kernel.resultAt(fn.kernel.instructionResultStart(allocation)),
				)
			)
				return undefined;
			keys ??= forward.keys;
			forwards.set(allocation, forward.target);
			continue;
		}
		const allocationKeys = fn.instructionAttributes(allocation).keyStringIndices;
		if (
			!Array.isArray(allocationKeys) ||
			allocationKeys.length === 0 ||
			allocationKeys.length > MAX_RESULT_FIELDS ||
			!coreValueOnlyReturned(
				fn,
				fn.kernel.resultAt(fn.kernel.instructionResultStart(allocation)),
			)
		)
			return undefined;
		const own = Object.freeze(allocationKeys.map(Number));
		if (!sameKeys(own)) {
			if (absentKey === undefined || forwards.size > 0) return undefined;
			union = true;
		}
		keys ??= own;
		allocations.set(allocation, own);
	}
	if (keys === undefined) return undefined;
	const ordered = [...allocations.keys()].sort((left, right) => left - right);
	let shapes: ReadonlyArray<ReadonlyArray<number>> | undefined;
	if (union) {
		if (ordered.length - 1 > COMPILER_INT32_RANGE.maximum) return undefined;
		const all: Array<number> = [];
		for (const allocation of ordered)
			for (const key of allocations.get(allocation)!)
				if (!all.includes(key)) all.push(key);
		if (
			all.length > MAX_RESULT_FIELDS ||
			all.some(
				(key) =>
					ordered.some((allocation) => !allocations.get(allocation)!.includes(key)) &&
					!absentKey!(key),
			)
		)
			return undefined;
		keys = Object.freeze(all);
		shapes = Object.freeze(
			ordered.map((allocation) =>
				Object.freeze(allocations.get(allocation)!.map((key) => all.indexOf(key))),
			),
		);
	}
	return Object.freeze({
		keys,
		allocations: Object.freeze(ordered),
		...(shapes === undefined ? {} : { shapes }),
		...(escaped ? { escapes: true as const } : {}),
		...(forwards.size === 0
			? {}
			: {
					forwards: Object.freeze(
						[...forwards]
							.sort(([left], [right]) => left - right)
							.map(([instruction, target]) => Object.freeze({ instruction, target })),
					),
				}),
	});
}

const MAX_RECORD_OBSERVERS = 8;

function alwaysObserved(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	start: CoreBlockId,
	observers: ReadonlySet<CoreInstructionId>,
): boolean {
	const observed = new Set(
		[...observers].map((observer) => fn.instructionBlock(observer)),
	);
	if (observed.has(start)) return true;
	const seen = new Set([start]);
	const pending = [start];
	while (pending.length > 0) {
		const successors = cfg.successors[pending.pop()!] ?? [];
		if (successors.length === 0) return false;
		for (const { to } of successors) {
			if (observed.has(to) || seen.has(to)) continue;
			seen.add(to);
			pending.push(to);
		}
	}
	return true;
}

/**
 * Names the function an exact call hands a record to as `argument`, when that function
 * can take the record as a record parameter.
 */
export type CoreRecordPassTarget = (
	call: CoreInstructionId,
	argument: number,
) => CoreFunctionId | undefined;

/**
 * Every use of a record held in storage from `root` on, when that storage can stand in
 * for the object. Reads and writes of its own fields stay accesses, and exact calls
 * that `passTarget` names take the storage itself; any other use observes the record
 * and must see the object, so it may not be a control-flow edge or handler argument
 * that this function cannot rewrite.
 */
function recordUses(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	root: CoreValueId,
	start: CoreBlockId,
	layout: CoreRecordLayout,
	passTarget?: CoreRecordPassTarget,
): CoreRecordUses | undefined {
	const keys = layout.keys;
	// Writing a key some literal lacks would change that record's shape.
	const storable = (field: number) =>
		layout.shapes?.every((shape) => shape.includes(field)) ?? true;
	const loads: Array<CoreRecordFieldAccess> = [];
	const stores: Array<CoreRecordFieldAccess> = [];
	const observers = new Set<CoreInstructionId>();
	const passes: Array<CoreRecordPass> = [];
	const aliases = new Set<CoreValueId>();
	const pending = [root];
	while (pending.length > 0) {
		const value = pending.pop()!;
		if (aliases.has(value)) continue;
		aliases.add(value);
		if (fn.kernel.valueHandlerUseCount(value) > 0) return undefined;
		for (
			let use = fn.kernel.valueFirstUse(value);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			if (fn.kernel.useLive(use) === 0) continue;
			const instruction = fn.kernel.useInstruction(use);
			const kind = fn.instructionKind(instruction);
			if (kind === "return" || kind === "throw") {
				observers.add(instruction);
				continue;
			}
			if (kind !== "operation") return undefined;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "rootUse") continue;
			if (opcode === "move") {
				pending.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)));
				continue;
			}
			const operand = fn.kernel.useOperand(use);
			const target =
				opcode === "call" && operand >= 2
					? passTarget?.(instruction, operand - 2)
					: undefined;
			if (target !== undefined) {
				passes.push({ instruction, argument: operand - 2, target });
				continue;
			}
			const field =
				operand === 0 &&
				(opcode === "loadPropertyStatic" || opcode === "storePropertyStatic")
					? keys.indexOf(fn.instructionAttributes(instruction).stringIndex as number)
					: -1;
			if (field < 0 || (opcode === "storePropertyStatic" && !storable(field)))
				observers.add(instruction);
			else
				(opcode === "loadPropertyStatic" ? loads : stores).push({ instruction, field });
		}
	}
	// A call that also observes the record, or takes it twice, needs the object.
	for (const pass of passes)
		if (
			observers.has(pass.instruction) ||
			passes.some((other) => other !== pass && other.instruction === pass.instruction)
		)
			observers.add(pass.instruction);
	const passed = passes.filter(({ instruction }) => !observers.has(instruction));
	// Storing the record into its own field also observes it.
	const ownStores = stores.filter(({ instruction }) => !observers.has(instruction));
	if (
		loads.length > 64 ||
		ownStores.length > 64 ||
		observers.size > MAX_RECORD_OBSERVERS ||
		passed.length > MAX_RECORD_OBSERVERS ||
		// An observer on every path would only add a copy of the record.
		(observers.size > 0 && alwaysObserved(fn, cfg, start, observers))
	)
		return undefined;
	const byInstruction = (left: CoreRecordFieldAccess, right: CoreRecordFieldAccess) =>
		left.instruction - right.instruction;
	return Object.freeze({
		loads: Object.freeze(loads.map((load) => Object.freeze(load)).sort(byInstruction)),
		stores: Object.freeze(
			ownStores.map((store) => Object.freeze(store)).sort(byInstruction),
		),
		observers: Object.freeze([...observers].sort((left, right) => left - right)),
		...(passed.length === 0
			? {}
			: {
					passes: Object.freeze(
						passed
							.map((pass) => Object.freeze(pass))
							.sort(
								(left, right) =>
									left.instruction - right.instruction || left.argument - right.argument,
							),
					),
				}),
	});
}

/** Names one record a call hands to one record parameter of `target`. */
export function coreRecordPassKey(
	site: { readonly caller: CoreFunctionId; readonly instruction: CoreInstructionId },
	argument: number,
	target: CoreFunctionId,
	layout: CoreRecordLayout,
): string {
	return `${site.caller}:${site.instruction}:${argument}:${target}:${layout.keys.join(",")}/${(layout.shapes ?? []).map((shape) => shape.join(",")).join(";")}`;
}

/**
 * The record passes that record calls of these entries hand over from caller storage.
 * A call that hands over an object literal carries that literal's storage itself.
 */
export function coreSuppliedRecordPasses(
	entries: ReadonlyArray<CoreDirectEntryPlan>,
): ReadonlySet<string> {
	const supplied = new Set<string>();
	for (const entry of entries)
		for (const site of entry.callSites) {
			if (entry.resultFields !== undefined)
				for (const pass of site.recordUses?.passes ?? [])
					supplied.add(
						coreRecordPassKey(
							{ caller: site.caller, instruction: pass.instruction },
							pass.argument,
							pass.target,
							entry.resultFields,
						),
					);
			for (const object of site.recordObjects ?? []) {
				const layout = entry.recordParameters?.find(
					(parameter) => parameter.index === object.argument,
				);
				if (layout !== undefined)
					supplied.add(coreRecordPassKey(site, object.argument, entry.function, layout));
			}
		}
	return supplied;
}

/** Every use of a call's record result, when caller storage can stand in for it. */
export function coreRecordResultUses(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	call: CoreInstructionId,
	fields: CoreEntryResultFields,
	passTarget?: CoreRecordPassTarget,
): CoreRecordUses | undefined {
	if (
		fn.isGenerator ||
		fn.isAsync ||
		fn.instructionKind(call) !== "operation" ||
		fn.instructionOpcodeName(call) !== "call" ||
		fn.kernel.instructionResultCount(call) !== 1
	)
		return undefined;
	const attributes = fn.instructionAttributes(call);
	if (attributes.construct || attributes.argumentMode !== undefined) return undefined;
	return recordUses(
		fn,
		cfg,
		fn.kernel.resultAt(fn.kernel.instructionResultStart(call)),
		fn.instructionBlock(call),
		fields,
		passTarget,
	);
}

/** The fields of an object literal that caller storage can hold. */
export function coreRecordObjectLayout(
	fn: CoreFunctionStore,
	allocation: CoreInstructionId,
): CoreRecordLayout | undefined {
	if (
		fn.isGenerator ||
		fn.isAsync ||
		fn.instructionKind(allocation) !== "operation" ||
		fn.instructionOpcodeName(allocation) !== "createObjectShaped" ||
		fn.kernel.instructionResultCount(allocation) !== 1
	)
		return undefined;
	const keys = fn.instructionAttributes(allocation).keyStringIndices;
	if (
		!Array.isArray(keys) ||
		keys.length === 0 ||
		keys.length > MAX_RESULT_FIELDS ||
		new Set(keys).size !== keys.length
	)
		return undefined;
	return Object.freeze({ keys: Object.freeze(keys.map(Number)) });
}

/** Every use of an object literal, when caller storage can stand in for it. */
export function coreRecordObjectUses(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	allocation: CoreInstructionId,
	passTarget: CoreRecordPassTarget,
): CoreRecordUses | undefined {
	const layout = coreRecordObjectLayout(fn, allocation);
	return layout === undefined
		? undefined
		: recordUses(
				fn,
				cfg,
				fn.kernel.resultAt(fn.kernel.instructionResultStart(allocation)),
				fn.instructionBlock(allocation),
				layout,
				passTarget,
			);
}

/**
 * The uses of parameter `index` when callers hand it over as storage holding a record
 * of `layout`. The storage lives in the caller's frame, so the parameter may not
 * outlive the call or be reachable through `arguments`. Its own passes observe it.
 */
export function coreRecordParameterUses(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	index: number,
	layout: CoreRecordLayout,
): CoreRecordUses | undefined {
	if (
		fn.isGenerator ||
		fn.isAsync ||
		fn.metadata.isClassConstructor ||
		fn.metadata.isDerivedConstructor ||
		index >= fn.parameterCount
	)
		return undefined;
	const observation = coreArgumentObservation(fn);
	if (
		observation.kind === "general" ||
		observation.indices.includes(index) ||
		observation.restStarts.some((start) => start <= index)
	)
		return undefined;
	return recordUses(fn, cfg, fn.kernel.functionParameter(index), fn.entry, layout);
}

export function coreFieldArgumentProofIsCurrent(
	fn: CoreFunctionStore,
	site: CoreDirectEntryPlan["callSites"][number],
	fields: CoreEntryFields,
): boolean {
	const proof =
		site.fieldValueRepresentations === undefined
			? undefined
			: argumentProofs.get(site.fieldValueRepresentations);
	return (
		proof?.fn === fn &&
		coreFunctionVersionsAreCurrent(fn, proof.versions) &&
		proof.call === site.instruction &&
		proof.allocation === site.fieldObject &&
		fields.representations.length === fields.keys.length &&
		fields.keys.every((key, index) => {
			const slot = proof.keys.indexOf(key);
			const target = fields.representations[index];
			return (
				slot >= 0 &&
				(target === "boxed" || target === site.fieldValueRepresentations![slot])
			);
		})
	);
}
