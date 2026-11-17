import {
	builtinWorldAssumptions,
	guardedCurrentRealmOperation,
	GUARDED_NUMBER_PREDICATES as NUMBER_PREDICATES,
} from "../shared/builtin-assumptions.ts";
import {
	builtinNormalResultKinds,
	builtinOperationDescriptor,
	exactBuiltinCallDescriptor,
	mathUnaryOperationKeys,
	primordialGlobalBindings,
} from "../shared/builtin-registry.ts";
import type { WorldFacts } from "../shared/compiler-facts.ts";
import type { CompilerIntrinsic } from "../shared/compiler-instruction.ts";
import {
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_TOP,
} from "../shared/compiler-value-kinds.ts";
import type { CompilerValueKindMask } from "../shared/compiler-value-kinds.ts";
import {
	guardedKnownOperationCall,
	knownOperationIndex,
} from "../shared/known-operations.ts";
import {
	primordialNodeAvailable,
	resolvePrimordialProperty,
} from "../shared/primordial-catalog.ts";
import { CoreEditor } from "./core-editor.ts";
import { splitGuardedCall } from "./core-function-prototype-call.ts";
import { guardedIterationEntrySplittable } from "./core-guarded-iteration.ts";
import {
	CORE_PRIMORDIAL_BINDING_TWIN_ATTRIBUTE,
	CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE,
	CORE_REPLAYABLE_TYPEOF_ATTRIBUTE,
	coreUnscopedInstructionAttributes,
} from "./core-internal-attributes.ts";
import {
	buildCoreControlFlow,
	coreTerminatorInput,
	coreValueControlFlowUseMask,
} from "./core-ir-control-flow.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import { CORE_STRING_SPAN_RANGE_METHODS } from "./core-ir-regions.ts";
import {
	CORE_LOCAL_VALUE_KIND_ANALYSIS,
	CORE_PRIMITIVE_EFFECT_FACT,
	analyzeCoreValueKinds,
} from "./core-ir-value-kinds.ts";
import type { CoreValueKindAnalysis } from "./core-ir-value-kinds.ts";
import { coreInstructionId } from "./core-ir.ts";
import type {
	CoreAttributeValue,
	CoreBlockId,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreFunctionPass, CorePassBudget } from "./core-pass.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

/*
 * With mutable primordials a call such as `Math.max(a, b)` loads the global binding,
 * loads the method and compares the callee before it can run the builtin. The
 * primordial-bindings protector holds while every global primordial binding is the
 * global object's own data property with the realm's value, no global lexical
 * declaration shadows one, and every builtin identity holds. A run of such calls in
 * one block becomes a twin: the guard selects a copy whose loads are the realm's
 * intrinsics and whose calls are the known operations the locked lowering uses, and
 * the original run stays as the generic twin.
 *
 * The copy may only skip what the protector proves when it is checked. Nothing that
 * can run JavaScript or store a property precedes a skipped load in the copy, so
 * each load would still have answered the intrinsic. Both backends resolve a known
 * call's builtin through the mutable graph when it runs. A consumer with fixed
 * execution semantics may follow argument reentry only when its admitted inputs
 * neither run JavaScript nor resolve that graph again. Primitive conversions
 * and numeric formatting also cannot reenter JavaScript when all inputs are primitive.
 * Mid-run mutations take effect at the next evaluation, which the next guard sees.
 */

/**
 * Namespaces whose methods a run calls. Each is a watched built-in, so replacing or
 * deleting one of their methods advances the builtin-identity epoch, and with it
 * the primordial-bindings one.
 */
const NAMESPACES: ReadonlySet<CompilerIntrinsic> = new Set<CompilerIntrinsic>([
	"Math",
	"Number",
	"Object",
	"Date",
	"Array",
]);

/** Global functions a run calls directly. */
const FUNCTIONS: ReadonlySet<CompilerIntrinsic> = new Set<CompilerIntrinsic>([
	"parseInt",
	"parseFloat",
	"isNaN",
	"isFinite",
	"Number",
	"String",
	"Boolean",
]);

/*
 * Known-call transport must preserve the generic twin's observable result. Private
 * consumers can additionally specialize each producer when their proofs survive
 * the join; construction retains its loaded callee for its own protocol.
 */
const OPERATIONS: ReadonlySet<string> = new Set([
	"parseInt",
	"parseFloat",
	"isNaN",
	"isFinite",
	"Number",
	"String",
	"Boolean",
	"Number.isNaN",
	"Number.isFinite",
	"Number.isInteger",
	"Number.isSafeInteger",
	"Object.hasOwn",
	"Object.assign",
	"Object.create",
	"Object.entries",
	"Array.from",
	"Date.parse",
	"Date.now",
	"Date.UTC",
]);

/** Global functions a string span region consumes as numeric parsers of a span. */
const SPAN_PARSERS: ReadonlySet<string> = new Set([
	"parseInt",
	"parseFloat",
	"isNaN",
	"isFinite",
	"Number",
]);

/** The runtime marks exactly these global object entries as primordial bindings. */
const REGISTERED_BINDINGS: ReadonlySet<string> = new Set(
	primordialGlobalBindings.map((binding) => binding.name),
);

const MATH_NUMBER_KERNELS: ReadonlySet<string> = new Set([
	...mathUnaryOperationKeys.map(([operation]) => operation),
	"Math.min",
	"Math.max",
]);

/** Instructions a twin copies, besides the loads and calls it replaces. */
const COPYABLE_OPCODES: ReadonlySet<string> = new Set([
	"createObject",
	"createObjectShaped",
	"createFunction",
	"createNumber",
	"createF64",
	"createString",
	"createBoolean",
	"createUndefined",
	"createNull",
	"binary",
	"unary",
	"move",
	"typeofCompare",
	"throwIfTdz",
	"mathUnaryNumber",
	"mathBinaryNumber",
	"loadGlobal",
	"loadCaptured",
	"loadLocal",
]);

const NUMBER_RESULT_OPERATORS: ReadonlySet<string> = new Set([
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
	"increment",
	"decrement",
	"~",
]);

const BOOLEAN_RESULT_OPERATORS: ReadonlySet<string> = new Set([
	"<",
	"<=",
	">",
	">=",
	"==",
	"!=",
	"===",
	"!==",
	"!",
]);

/** A run copies at most this many instructions, so a guard never doubles a long block. */
const MAX_RUN_INSTRUCTIONS = 64;
const MAX_ENTRY_PAIR_PARAMETERS = 256;

const BUDGET: CorePassBudget = Object.freeze({
	maxWorkItems: 2_000_000,
	maxEdits: 1_000_000,
	exhaustion: "stop",
});

interface Site {
	/** The first lookup: a global binding, or a primitive method. */
	readonly name: CoreInstructionId;
	/** The method lookup, which is also the first lookup for a primitive receiver. */
	readonly method?: CoreInstructionId;
	readonly call: CoreInstructionId;
	readonly consumer?: CoreInstructionId;
	readonly intrinsic?: CompilerIntrinsic;
	readonly operation: string;
	readonly kind: "method" | "function" | "primitive";
}

function operands(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): Array<CoreValueId> {
	const start = fn.kernel.instructionOperandStart(instruction);
	return Array.from(
		{ length: fn.kernel.instructionOperandCount(instruction) },
		(_, index) => fn.kernel.operandAt(start + index),
	);
}

function results(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): Array<CoreValueId> {
	const start = fn.kernel.instructionResultStart(instruction);
	return Array.from(
		{ length: fn.kernel.instructionResultCount(instruction) },
		(_, index) => fn.kernel.resultAt(start + index),
	);
}

function definition(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CoreInstructionId | undefined {
	return fn.kernel.valueDefinitionKind(value) === 1
		? coreInstructionId(fn.kernel.valueDefinitionOwner(value))
		: undefined;
}

function opcodeOf(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): string | undefined {
	return fn.instructionKind(instruction) === "operation"
		? fn.instructionOpcodeName(instruction)
		: undefined;
}

/** The registered primordial a global name holds, when a guarded load may skip it. */
function primordialGlobal(
	program: CoreProgram,
	fn: CoreFunctionStore,
	load: CoreInstructionId,
): CompilerIntrinsic | undefined {
	if (opcodeOf(fn, load) !== "loadGlobalProperty") return undefined;
	const attributes = fn.instructionAttributes(load);
	if (attributes[CORE_PRIMORDIAL_BINDING_TWIN_ATTRIBUTE] === true) return undefined;
	const index = attributes.nameStringIndex;
	if (typeof index !== "number") return undefined;
	const name = program.stringConstantText(index);
	return REGISTERED_BINDINGS.has(name) &&
		(NAMESPACES.has(name as CompilerIntrinsic) ||
			FUNCTIONS.has(name as CompilerIntrinsic))
		? (name as CompilerIntrinsic)
		: undefined;
}

function firstInstruction(
	fn: CoreFunctionStore,
	block: CoreBlockId,
): CoreInstructionId | undefined {
	for (const instruction of fn.bodyInstructionIds(block)) return instruction;
	return undefined;
}

/** A copy drops effect refinements, so it admits only those later passes prove again. */
function copyable(fn: CoreFunctionStore, instruction: CoreInstructionId): boolean {
	const opcode = opcodeOf(fn, instruction);
	if (opcode === undefined || !COPYABLE_OPCODES.has(opcode)) return false;
	const refinement = fn.instructionEffectRefinement(instruction);
	if (refinement === undefined) return true;
	const fact = fn.fact(refinement.proof);
	return (
		(opcode === "binary" || opcode === "unary") &&
		fact.kind === CORE_PRIMITIVE_EFFECT_FACT &&
		fact.obligations.length === 0
	);
}

function entryPairConsumer(
	program: CoreProgram,
	fn: CoreFunctionStore,
	pair: CoreValueId,
	block: CoreBlockId,
	first: CoreInstructionId | undefined,
	controlUse: (value: CoreValueId) => boolean,
): CoreInstructionId | undefined {
	if (fn.kernel.valueHandlerUseCount(pair) !== 0 || controlUse(pair)) return undefined;
	const fields = new Map<CoreInstructionId, 0 | 1>();
	for (let use = fn.kernel.valueFirstUse(pair); use >= 0; use = fn.kernel.useNext(use)) {
		const instruction = coreInstructionId(fn.kernel.useInstruction(use));
		if (
			fields.size === 8 ||
			fn.kernel.useOperand(use) !== 0 ||
			fn.instructionBlock(instruction) !== block ||
			fn.instructionEffectRefinement(instruction) !== undefined
		)
			return undefined;
		const opcode = opcodeOf(fn, instruction);
		let field: 0 | 1 | undefined;
		if (opcode === "loadPropertyStatic") {
			const key = fn.instructionAttributes(instruction).stringIndex;
			if (typeof key === "number") {
				const text = program.stringConstantText(key);
				if (text === "0" || text === "1") field = text === "0" ? 0 : 1;
			}
		} else if (opcode === "loadProperty") {
			const key = definition(fn, operands(fn, instruction)[1]!);
			if (
				key !== undefined &&
				["createNumber", "createI32", "createF64"].includes(opcodeOf(fn, key) ?? "")
			) {
				const value = fn.instructionAttributes(key).value;
				if (value === 0 || value === 1) field = value;
			}
		}
		if (field === undefined) return undefined;
		fields.set(instruction, field);
	}
	if (fields.size === 0) return undefined;
	const keys = new Set<CoreValueId>();
	const derived = new Set<CoreValueId>();
	let remaining = fields.size;
	let next = first;
	for (let count = 0; next !== undefined && count < MAX_RUN_INSTRUCTIONS; count++) {
		const field = fields.get(next);
		if (field !== undefined) {
			const value = results(fn, next)[0]!;
			if (field === 0) keys.add(value);
			derived.add(value);
			if (--remaining === 0) return next;
		} else {
			const opcode = opcodeOf(fn, next);
			if (
				opcode !== "createNumber" &&
				opcode !== "createI32" &&
				opcode !== "createF64" &&
				opcode !== "createString"
			) {
				if (
					(opcode === "binary" || opcode === "unary") &&
					operands(fn, next).some((value) => derived.has(value)) &&
					copyable(fn, next)
				) {
					derived.add(results(fn, next)[0]!);
					next = fn.instructionNext(next);
					continue;
				}
				if (opcode !== "loadPropertyStatic") return undefined;
				const key = fn.instructionAttributes(next).stringIndex;
				if (
					!keys.has(operands(fn, next)[0]!) ||
					typeof key !== "number" ||
					program.stringConstantText(key) !== "length" ||
					fn.instructionEffectRefinement(next) !== undefined
				)
					return undefined;
				derived.add(results(fn, next)[0]!);
			}
		}
		next = fn.instructionNext(next);
	}
	return undefined;
}

function projectJoinedEntryPair(
	program: CoreProgram,
	fn: CoreFunctionStore,
	controlUse: (value: CoreValueId) => boolean,
	remainingEdits: number,
): CoreEditor | undefined {
	if (fn.isAsync || fn.isGenerator || fn.liveStorageCounts().instructions > 4000)
		return undefined;
	let control: ReturnType<typeof buildCoreControlFlow> | undefined;
	let examinedParameters = 0;
	for (const block of fn.blockIds()) {
		if (fn.kernel.blockHandlerBlock(block) !== undefined) continue;
		const count = fn.kernel.blockParameterCount(block);
		if (count > MAX_ENTRY_PAIR_PARAMETERS - examinedParameters) return undefined;
		examinedParameters += count;
		const start = fn.kernel.blockParameterStart(block);
		const parameters = Array.from({ length: count }, (_, index) =>
			fn.kernel.blockParameterValue(start + index),
		);
		for (const [index, parameter] of parameters.entries()) {
			const first = firstInstruction(fn, block);
			const last = entryPairConsumer(program, fn, parameter, block, first, controlUse);
			if (last === undefined) continue;
			control ??= buildCoreControlFlow(program, fn.id);
			const incoming = control.predecessors[block] ?? [];
			if (
				incoming.length !== 2 ||
				incoming.some(
					(edge) =>
						edge.kind !== "ordinary" ||
						edge.from === block ||
						control!.dominates(block, edge.from) ||
						fn.kernel.blockHandlerBlock(edge.from) !== undefined,
				)
			)
				continue;
			let entries = false;
			const rows = incoming.map((edge) => ({
				block: edge.from,
				arguments: edge.arguments,
				terminator: coreTerminatorInput(fn, fn.blockTerminator(edge.from)),
			}));
			if (
				rows.some((row) => {
					if (row.terminator.kind !== "jump" || row.terminator.edge.block !== block)
						return true;
					const element = definition(fn, row.arguments[index]!);
					if (
						element === undefined ||
						opcodeOf(fn, element) !== "loadProperty" ||
						fn.instructionBlock(element) !== row.block
					)
						return true;
					const producer = definition(fn, operands(fn, element)[0]!);
					if (
						producer !== undefined &&
						opcodeOf(fn, producer) === "callKnown" &&
						fn.instructionAttributes(producer).operation === "Object.entries"
					)
						entries = true;
					return false;
				}) ||
				!entries
			)
				continue;
			const prefix: Array<CoreInstructionId> = [];
			for (let next = first; next !== undefined; next = fn.instructionNext(next)) {
				prefix.push(next);
				if (next === last || prefix.length === 16) break;
			}
			if (prefix.at(-1) !== last) continue;
			const members = new Set(prefix);
			const live = prefix
				.flatMap((instruction) => results(fn, instruction))
				.filter((value) => {
					if (controlUse(value) || fn.kernel.valueHandlerUseCount(value) !== 0)
						return true;
					for (
						let use = fn.kernel.valueFirstUse(value);
						use >= 0;
						use = fn.kernel.useNext(use)
					)
						if (!members.has(coreInstructionId(fn.kernel.useInstruction(use))))
							return true;
					return false;
				});
			if (
				live.length > 16 ||
				3 * prefix.length +
					16 +
					live.reduce(
						(n, value) =>
							n + fn.valueUseCount(value) + fn.kernel.valueHandlerUseCount(value),
						0,
					) >
					remainingEdits
			)
				continue;
			// Each predecessor transfers only here, so moving this first closed prefix
			// preserves all prior effects and executes its getters exactly once.
			const editor = CoreEditor.open(program, fn.id);
			const joined = editor.appendBlockParameters(
				block,
				live.map((value) => ({
					representation: fn.valueRepresentation(value),
				})),
			);
			for (const row of rows) {
				const copied = new Map(
					parameters.map((value, index) => [value, row.arguments[index]!]),
				);
				const map = (value: CoreValueId) => copied.get(value) ?? value;
				for (const instruction of prefix) {
					const outputs = results(fn, instruction);
					const clone = editor.appendInstruction(
						row.block,
						fn.instructionOpcodeName(instruction),
						operands(fn, instruction).map(map),
						{
							attributes: coreUnscopedInstructionAttributes(
								fn.instructionAttributes(instruction),
							),
							sourcePosition: fn.instructionSourcePosition(instruction),
							outputRepresentations: outputs.map((value) =>
								fn.valueRepresentation(value),
							),
						},
					);
					outputs.forEach((value, index) => copied.set(value, clone.outputs[index]!));
				}
				editor.replaceTerminator(row.block, {
					kind: "jump",
					edge: {
						block,
						arguments: [...row.arguments, ...live.map(map)],
					},
					sourcePosition: fn.instructionSourcePosition(fn.blockTerminator(row.block)),
				});
			}
			editor.replaceValueUsesMany(
				new Map(live.map((value, index) => [value, joined[index]!])),
			);
			for (let index = prefix.length - 1; index >= 0; index--)
				editor.removeInstruction(prefix[index]!);
			return editor;
		}
	}
	return undefined;
}

/** The canonical builtin an own data property of a primordial holds. */
function ownDataPrimordial(
	owner: string,
	key: string,
	world: WorldFacts,
): string | undefined {
	const resolution = resolvePrimordialProperty(owner, key);
	if (
		resolution === undefined ||
		resolution.owner[0] !== owner ||
		resolution.value === undefined ||
		resolution.getter !== undefined ||
		resolution.setter !== undefined
	)
		return undefined;
	const id = resolution.value[0];
	return primordialNodeAvailable(world, id) ? id : undefined;
}

/** Whether `value` is a String method's span, which a span region parses in place. */
function stringSpan(
	program: CoreProgram,
	fn: CoreFunctionStore,
	value: CoreValueId,
): boolean {
	const producer = definition(fn, value);
	if (producer === undefined || opcodeOf(fn, producer) !== "call") return false;
	const callee = definition(fn, operands(fn, producer)[0]!);
	const key =
		callee === undefined ? undefined : fn.instructionAttributes(callee).stringIndex;
	return (
		callee !== undefined &&
		opcodeOf(fn, callee) === "loadPropertyStatic" &&
		typeof key === "number" &&
		(CORE_STRING_SPAN_RANGE_METHODS as ReadonlyArray<string>).includes(
			program.stringConstantText(key),
		)
	);
}

function siteFor(
	program: CoreProgram,
	fn: CoreFunctionStore,
	world: WorldFacts,
	call: CoreInstructionId,
	kinds: CoreValueKindAnalysis,
	controlUse: (value: CoreValueId) => boolean,
): Site | undefined {
	if (opcodeOf(fn, call) !== "call" || results(fn, call).length !== 1) return undefined;
	const inputs = operands(fn, call);
	const block = fn.instructionBlock(call);
	const callee = definition(fn, inputs[0]!);
	if (callee === undefined || fn.instructionBlock(callee) !== block) return undefined;
	if (fn.instructionAttributes(callee)[CORE_PRIMORDIAL_BINDING_TWIN_ATTRIBUTE] === true)
		return undefined;
	// Math.sumPrecise spends its time iterating its argument rather than in the call.
	const allowed = (operation: string | undefined) =>
		operation !== undefined &&
		((operation.startsWith("Math.") && operation !== "Math.sumPrecise") ||
			OPERATIONS.has(operation)) &&
		knownOperationIndex(operation) !== undefined
			? operation
			: undefined;
	const direct = primordialGlobal(program, fn, callee);
	if (direct !== undefined) {
		const operation = allowed(ownDataPrimordial("globalThis", direct, world));
		const receiver = definition(fn, inputs[1]!);
		if (
			!FUNCTIONS.has(direct) ||
			operation === undefined ||
			receiver === undefined ||
			opcodeOf(fn, receiver) !== "createUndefined" ||
			(SPAN_PARSERS.has(operation) &&
				inputs[2] !== undefined &&
				stringSpan(program, fn, inputs[2]))
		)
			return undefined;
		return { name: callee, call, intrinsic: direct, operation, kind: "function" };
	}
	if (opcodeOf(fn, callee) !== "loadPropertyStatic") return undefined;
	const namespaceValue = operands(fn, callee)[0]!;
	if (
		inputs[1] !== namespaceValue ||
		fn.valueUseCount(inputs[0]!) !== 1 ||
		fn.kernel.valueHandlerUseCount(inputs[0]!) !== 0
	)
		return undefined;
	const key = fn.instructionAttributes(callee).stringIndex;
	if (
		typeof key === "number" &&
		program.stringConstantText(key) === "toFixed" &&
		kinds.scalarKind(namespaceValue) === "number" &&
		ownDataPrimordial("Number.prototype", "toFixed", world) === "Number.prototype.toFixed"
	)
		return {
			name: callee,
			method: callee,
			call,
			operation: "Number.prototype.toFixed",
			kind: "primitive",
		};
	const namespace = definition(fn, namespaceValue);
	if (namespace === undefined || fn.instructionBlock(namespace) !== block)
		return undefined;
	const intrinsic = primordialGlobal(program, fn, namespace);
	if (intrinsic === undefined || !NAMESPACES.has(intrinsic)) return undefined;
	const namespaceNode = ownDataPrimordial("globalThis", intrinsic, world);
	if (namespaceNode === undefined || typeof key !== "number") return undefined;
	const operation = allowed(
		ownDataPrimordial(namespaceNode, program.stringConstantText(key), world),
	);
	if (operation === undefined) return undefined;
	let consumer: CoreInstructionId | undefined;
	if (operation === "Object.entries") {
		const result = results(fn, call)[0]!;
		const use = fn.kernel.valueFirstUse(result);
		if (
			fn.kernel.valueHandlerUseCount(result) !== 0 ||
			controlUse(result) ||
			use < 0 ||
			fn.kernel.useNext(use) >= 0 ||
			fn.kernel.useOperand(use) !== 0
		)
			return undefined;
		const useInstruction = coreInstructionId(fn.kernel.useInstruction(use));
		if (opcodeOf(fn, useInstruction) !== "getIterator") {
			const opcode = opcodeOf(fn, useInstruction);
			if (opcode !== "loadProperty" && opcode !== "loadPropertyStatic") return undefined;
			const key = fn.instructionAttributes(useInstruction).stringIndex;
			if (
				(opcode === "loadPropertyStatic" &&
					(typeof key !== "number" || program.stringConstantText(key) !== "length")) ||
				fn.instructionBlock(useInstruction) !== block ||
				fn.instructionEffectRefinement(useInstruction) !== undefined
			)
				return undefined;
			let next = fn.instructionNext(call),
				constants = 0;
			while (next !== useInstruction) {
				const opcode = next === undefined ? undefined : opcodeOf(fn, next);
				if (
					next === undefined ||
					++constants > MAX_RUN_INSTRUCTIONS ||
					(opcode !== "createNumber" &&
						opcode !== "createF64" &&
						opcode !== "createString")
				)
					return undefined;
				next = fn.instructionNext(next);
			}
			// Project inside each twin so its pair keeps a definite snapshot producer.
			consumer =
				(opcode === "loadProperty"
					? entryPairConsumer(
							program,
							fn,
							results(fn, useInstruction)[0]!,
							block,
							fn.instructionNext(useInstruction),
							controlUse,
						)
					: undefined) ?? useInstruction;
		}
	}
	return {
		name: namespace,
		method: callee,
		call,
		...(consumer === undefined ? {} : { consumer }),
		intrinsic,
		operation,
		kind: "method",
	};
}

/**
 * Whether a loop's body could still become a numeric loop region on its own, whose
 * entry already loads each Math callee once and compares it with the builtin.
 */
function regionCandidateLoop(
	fn: CoreFunctionStore,
	blocks: ReadonlySet<CoreBlockId>,
	sites: ReadonlyMap<CoreInstructionId, Site>,
): boolean {
	for (const block of blocks) {
		for (const instruction of fn.bodyInstructionIds(block)) {
			const opcode = opcodeOf(fn, instruction);
			if (
				opcode === "construct" ||
				opcode === "constructSpread" ||
				opcode === "callSpread" ||
				opcode === "callSpreadIterable" ||
				opcode === "callKnown" ||
				opcode === "createObject" ||
				opcode === "createObjectShaped" ||
				opcode === "createArray" ||
				opcode === "createClosure" ||
				opcode === "concatStrings"
			)
				return false;
			if (opcode !== "call") continue;
			const operation =
				sites.get(instruction)?.operation ??
				(
					fn.instructionAttributes(instruction).knownBuiltinCall as
						| { readonly operation?: unknown }
						| undefined
				)?.operation;
			if (
				typeof operation !== "string" ||
				!(
					operation.startsWith("Math.") ||
					operation.startsWith("DataView.prototype.") ||
					operation === "String.prototype.charCodeAt" ||
					operation === "String.prototype.codePointAt"
				)
			)
				return false;
		}
	}
	return true;
}

/** Blocks whose sites stay for a numeric loop region's entry speculation. */
function regionCandidateBlocks(
	program: CoreProgram,
	fn: CoreFunctionStore,
	sites: ReadonlyMap<CoreInstructionId, Site>,
): Set<CoreBlockId> {
	const skipped = new Set<CoreBlockId>();
	for (const loop of buildCoreControlFlow(program, fn.id).loops) {
		// An enclosing loop contains every block of its inner loops.
		if (!regionCandidateLoop(fn, loop.blocks, sites)) continue;
		for (const block of loop.blocks) skipped.add(block);
	}
	return skipped;
}

interface Run {
	readonly instructions: ReadonlyArray<CoreInstructionId>;
	readonly sites: ReadonlyArray<Site>;
	/** Math calls on Numbers, which the copy runs as numeric kernels. */
	readonly kernels: ReadonlySet<Site>;
}

class RunPlanner {
	readonly #fn: CoreFunctionStore;
	readonly #kinds: CoreValueKindAnalysis;
	readonly #realms: boolean;
	readonly #sitesByInstruction: ReadonlyMap<CoreInstructionId, Site>;
	/** Kinds of the values the copy computes, where its known calls narrow them. */
	readonly #copyKinds = new Map<CoreValueId, CompilerValueKindMask>();
	/**
	 * The value a join parameter of an earlier twin replaced. It holds either that
	 * value or its copy's narrower one, and the kind analysis predates it.
	 */
	readonly #joined = new Map<CoreValueId, CoreValueId>();
	readonly #utcKinds: CoreValueKindAnalysis | undefined;

	constructor(
		program: CoreProgram,
		fn: CoreFunctionStore,
		kinds: CoreValueKindAnalysis,
		sitesByInstruction: ReadonlyMap<CoreInstructionId, Site>,
		realms: boolean,
	) {
		this.#fn = fn;
		this.#kinds = kinds;
		this.#realms = realms;
		this.#sitesByInstruction = sitesByInstruction;
		if (
			realms &&
			[...sitesByInstruction.values()].some((site) => site.operation === "Date.UTC")
		)
			this.#utcKinds = analyzeCoreValueKinds(
				program,
				fn,
				buildCoreControlFlow(program, fn.id),
			);
	}

	adoptJoin(joined: ReadonlyMap<CoreValueId, CoreValueId>): void {
		for (const [parameter, original] of joined) this.#joined.set(parameter, original);
	}

	#kind(value: CoreValueId): CompilerValueKindMask {
		const representation = this.#fn.valueRepresentation(value);
		if (representation === "f64" || representation === "i32")
			return COMPILER_VALUE_KIND_NUMBER;
		return (
			this.#copyKinds.get(value) ?? this.#kinds.kindMask(this.#joined.get(value) ?? value)
		);
	}

	#number(value: CoreValueId): boolean {
		const kind = this.#kind(value);
		return kind !== 0 && (kind & ~COMPILER_VALUE_KIND_NUMBER) === 0;
	}

	#primitive(value: CoreValueId): boolean {
		const kind = this.#kind(value);
		return kind !== 0 && (kind & COMPILER_VALUE_KIND_OBJECT) === 0;
	}

	/**
	 * A Math call on Numbers, which the copy runs as a numeric kernel that neither
	 * runs JavaScript nor resolves its builtin, so it may follow code that could
	 * have replaced it after its loads.
	 */
	#mathKernel(site: Site): boolean {
		if (site.kind !== "method" || !MATH_NUMBER_KERNELS.has(site.operation)) return false;
		const arguments_ = operands(this.#fn, site.call).slice(2);
		return (
			builtinOperationDescriptor(site.operation)?.nativeNumberArity ===
				arguments_.length && arguments_.every((argument) => this.#number(argument))
		);
	}

	// ToString has already completed, so parsing cannot replace the selected callee.
	#capturedDateParser(site: Site): boolean {
		if (this.#realms || site.operation !== "Date.parse") return false;
		const argument = operands(this.#fn, site.call)[2];
		return argument !== undefined && this.#kind(argument) === COMPILER_VALUE_KIND_STRING;
	}

	#currentRealmOperation(site: Site): boolean {
		if (site.operation !== "Date.UTC")
			return guardedCurrentRealmOperation(site.operation);
		// Verification replays local SSA facts without contextual field/global claims.
		const limit = exactBuiltinCallDescriptor(site.operation)!.forwardedArgumentLimit!;
		return guardedCurrentRealmOperation(
			site.operation,
			operands(this.#fn, site.call)
				.slice(2, 2 + limit)
				.map((value) => this.#utcKinds!.kindMask(this.#joined.get(value) ?? value)),
		);
	}

	/** Whether the known call can run JavaScript, which ends the run after it. */
	#callReenters(site: Site): boolean {
		if (NUMBER_PREDICATES.has(site.operation) || this.#mathKernel(site)) return false;
		if (
			site.kind === "primitive" ||
			FUNCTIONS.has(site.operation as CompilerIntrinsic) ||
			site.operation.startsWith("Date.")
		)
			return !operands(this.#fn, site.call)
				.slice(2)
				.every((argument) => this.#primitive(argument));
		return true;
	}

	#copyReenters(instruction: CoreInstructionId): boolean {
		const fn = this.#fn;
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode === "binary" || opcode === "unary")
			return !operands(fn, instruction).every((value) => this.#primitive(value));
		const effects = coreInstructionEffects(fn, instruction);
		return (
			effects.callsUserCode ||
			effects.maySuspend ||
			effects.writes.some(
				(domain) =>
					domain === "global-property" ||
					domain === "object-property" ||
					domain === "host",
			)
		);
	}

	#recordCopyKind(instruction: CoreInstructionId, site: Site | undefined): void {
		const fn = this.#fn;
		const [result] = results(fn, instruction);
		if (result === undefined) return;
		if (site !== undefined) {
			if (instruction === site.call)
				this.#copyKinds.set(
					result,
					builtinNormalResultKinds(site.operation) ?? COMPILER_VALUE_KIND_TOP,
				);
			else if (instruction === site.name)
				this.#copyKinds.set(result, COMPILER_VALUE_KIND_OBJECT);
			return;
		}
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode !== "binary" && opcode !== "unary" && opcode !== "move") return;
		const inputs = operands(fn, instruction);
		if (opcode === "move") {
			this.#copyKinds.set(result, this.#kind(inputs[0]!));
			return;
		}
		const operator = fn.instructionAttributes(instruction).operator;
		if (typeof operator !== "string") return;
		if (
			BOOLEAN_RESULT_OPERATORS.has(operator) &&
			inputs.every((value) => this.#primitive(value))
		)
			this.#copyKinds.set(result, COMPILER_VALUE_KIND_BOOLEAN);
		else if (
			NUMBER_RESULT_OPERATORS.has(operator) &&
			inputs.every((value) => this.#number(value))
		)
			this.#copyKinds.set(result, COMPILER_VALUE_KIND_NUMBER);
	}

	/** The bounded run starting with this lookup, if any of its sites fits. */
	plan(first: CoreInstructionId, terminator: CoreInstructionId): Run | undefined {
		const fn = this.#fn;
		this.#copyKinds.clear();
		const seen = new Set<CoreInstructionId>();
		const included: Array<Site> = [];
		const kernels = new Set<Site>();
		let reentered = false;
		for (
			let instruction: CoreInstructionId | undefined = first;
			instruction !== undefined && instruction !== terminator;
			instruction = fn.instructionNext(instruction)
		) {
			const site = this.#sitesByInstruction.get(instruction);
			if (site !== undefined && instruction !== site.call) {
				// A load after anything that could rebind its name stays a load.
				if (reentered) break;
				seen.add(instruction);
				this.#recordCopyKind(instruction, site);
				continue;
			}
			if (site !== undefined) {
				const loaded =
					seen.has(site.name) && (site.method === undefined || seen.has(site.method));
				const kernel = this.#mathKernel(site);
				if (this.#realms && !this.#currentRealmOperation(site)) break;
				if (
					!loaded ||
					(reentered &&
						!kernel &&
						!NUMBER_PREDICATES.has(site.operation) &&
						!this.#capturedDateParser(site))
				)
					break;
				seen.add(instruction);
				included.push(site);
				if (kernel) kernels.add(site);
				this.#recordCopyKind(instruction, site);
				if (this.#callReenters(site)) reentered = true;
				continue;
			}
			if (!copyable(fn, instruction)) break;
			seen.add(instruction);
			this.#recordCopyKind(instruction, undefined);
			if (this.#copyReenters(instruction)) reentered = true;
		}
		// Trailing sites are dropped until the copied span fits.
		while (included.length > 0) {
			const run = this.#span(included);
			if (run.length <= MAX_RUN_INSTRUCTIONS)
				return { instructions: run, sites: included, kernels };
			included.pop();
		}
		return undefined;
	}

	#span(sites: ReadonlyArray<Site>): Array<CoreInstructionId> {
		const fn = this.#fn;
		const members = new Set<CoreInstructionId>();
		for (const site of sites) {
			members.add(site.name);
			if (site.method !== undefined) members.add(site.method);
			members.add(site.call);
		}
		const span: Array<CoreInstructionId> = [];
		let open = false;
		let last: CoreInstructionId | undefined;
		for (const site of sites) last = site.consumer ?? site.call;
		for (const instruction of fn.bodyInstructionIds(fn.instructionBlock(last!))) {
			if (!open && members.has(instruction)) open = true;
			if (open) span.push(instruction);
			if (instruction === last) break;
		}
		return span;
	}
}

function guardedCallAttributes(
	fn: CoreFunctionStore,
	site: Site,
	forwarded: boolean,
	singleRealm: boolean,
): Record<string, CoreAttributeValue> {
	const sourceCall = fn.instructionAttributes(site.call).sourceCall;
	return {
		...(typeof sourceCall === "number" ? { sourceCall } : {}),
		operation: site.operation,
		...(forwarded ? { specialized: site.operation } : {}),
		worldAssumptions: {
			...builtinWorldAssumptions(
				site.operation,
				"exact-builtin-proof",
				singleRealm,
				"guarded",
			),
		},
		knownBuiltinCall: guardedKnownOperationCall(
			site.operation,
			fn.id,
			singleRealm,
		) as unknown as CoreAttributeValue,
	};
}

function guardRealmDateParser(
	fn: CoreFunctionStore,
	editor: CoreEditor,
	site: Site,
): void {
	const block = fn.instructionBlock(site.call);
	const split = splitGuardedCall(fn, editor, site.call);
	// Argument evaluation may have replaced the namespace after selecting the callee.
	const protectedCall = split.test(
		split.append(block, "guardSemanticEpoch", [], { family: "primordial-bindings" }),
	);
	const stringCall = split.test(
		split.append(protectedCall, "typeofCompare", [split.operands[2]!], {
			expected: "string",
			negated: false,
			[CORE_REPLAYABLE_TYPEOF_ATTRIBUTE]: true,
		}),
	);
	const result = split.append(
		stringCall,
		"callKnown",
		split.operands.slice(1),
		guardedCallAttributes(fn, site, true, false),
	);
	split.finish(stringCall, result);
}

/*
 * Splits the block in front of the run: the guard enters a copy with the known
 * operations, the original run stays as the generic twin, and both meet in a block
 * that holds the rest of the original one.
 */
function twinRun(
	fn: CoreFunctionStore,
	editor: CoreEditor,
	run: Run,
	singleRealm: boolean,
): {
	readonly join: CoreBlockId;
	readonly joined: ReadonlyMap<CoreValueId, CoreValueId>;
} {
	const block = fn.instructionBlock(run.instructions[0]!);
	const terminator = fn.blockTerminator(block);
	const sourcePosition = fn.instructionSourcePosition(run.instructions[0]!);
	const members = new Set(run.instructions);
	const sites = new Map<CoreInstructionId, Site>();
	for (const site of run.sites) {
		sites.set(site.name, site);
		if (site.method !== undefined) sites.set(site.method, site);
		sites.set(site.call, site);
	}
	const liveOut: Array<CoreValueId> = [];
	for (const instruction of run.instructions) {
		for (const value of results(fn, instruction)) {
			let escapes = fn.kernel.valueHandlerUseCount(value) !== 0;
			for (
				let use = fn.kernel.valueFirstUse(value);
				!escapes && use >= 0;
				use = fn.kernel.useNext(use)
			)
				escapes = !members.has(coreInstructionId(fn.kernel.useInstruction(use)));
			if (escapes) liveOut.push(value);
		}
	}
	const originalOperands = new Map(
		run.instructions.map((instruction) => [instruction, operands(fn, instruction)]),
	);
	const tail: Array<CoreInstructionId> = [];
	for (
		let next = fn.instructionNext(run.instructions.at(-1)!);
		next !== undefined && next !== terminator;
		next = fn.instructionNext(next)
	)
		tail.push(next);
	const copy = editor.createBlock();
	const twin = editor.createBlock();
	const join = editor.createBlock(
		liveOut.map((value) => ({ representation: fn.valueRepresentation(value) })),
	);
	const handler = fn.kernel.blockHandlerBlock(block);
	if (handler !== undefined) {
		const start = fn.kernel.blockHandlerArgumentStart(block);
		const handlerArguments = Array.from(
			{ length: fn.kernel.blockHandlerArgumentCount(block) },
			(_, index) => fn.kernel.handlerArgumentAt(start + index),
		);
		for (const created of [copy, twin, join])
			editor.setHandler(created, handler, handlerArguments);
	}
	for (const instruction of tail) editor.moveInstruction(instruction, join);
	editor.setTerminator(join, {
		...coreTerminatorInput(fn, terminator),
		sourcePosition: fn.instructionSourcePosition(terminator),
	});
	editor.removeInstruction(terminator);
	for (const instruction of run.instructions) editor.moveInstruction(instruction, twin);
	const joinStart = fn.kernel.blockParameterStart(join);
	const joined = new Map<CoreValueId, CoreValueId>();
	liveOut.forEach((value, index) => {
		const parameter = fn.kernel.blockParameterValue(joinStart + index);
		joined.set(parameter, value);
		editor.replaceValueUses(value, parameter);
	});
	for (const instruction of run.instructions) {
		const inputs = originalOperands.get(instruction)!;
		const current = operands(fn, instruction);
		if (current.some((value, index) => value !== inputs[index]))
			editor.replaceOperands(instruction, inputs);
		// The twin keeps its loads, which a later run of this pass must not twin again.
		if (
			fn.instructionOpcodeName(instruction) === "loadGlobalProperty" ||
			(sites.get(instruction)?.kind === "primitive" &&
				fn.instructionOpcodeName(instruction) === "loadPropertyStatic")
		)
			editor.replaceInstruction(
				instruction,
				fn.instructionOpcodeName(instruction),
				inputs,
				{
					attributes: {
						...fn.instructionAttributes(instruction),
						[CORE_PRIMORDIAL_BINDING_TWIN_ATTRIBUTE]: true,
					},
					sourcePosition: fn.instructionSourcePosition(instruction),
					effectRefinement: fn.instructionEffectRefinement(instruction),
				},
			);
	}

	const copied = new Map<CoreValueId, CoreValueId>();
	const map = (value: CoreValueId) => copied.get(value) ?? value;
	for (const instruction of run.instructions) {
		const site = sites.get(instruction);
		const inputs = originalOperands.get(instruction)!;
		const [result] = results(fn, instruction);
		const representations = results(fn, instruction).map((value) =>
			fn.valueRepresentation(value),
		);
		const position = fn.instructionSourcePosition(instruction);
		if (site !== undefined && instruction === site.method) continue;
		if (site !== undefined && instruction === site.name) {
			copied.set(
				result!,
				editor.appendInstruction(copy, "loadIntrinsic", [], {
					attributes: { intrinsic: site.intrinsic! },
					sourcePosition: position,
					outputRepresentations: representations,
				}).outputs[0]!,
			);
			continue;
		}
		if (site !== undefined && run.kernels.has(site)) {
			const arguments_ = inputs.slice(2).map(map);
			copied.set(
				result!,
				editor.appendInstruction(
					copy,
					arguments_.length === 1 ? "mathUnaryNumber" : "mathBinaryNumber",
					arguments_,
					{
						attributes: {
							operation: site.operation,
							worldAssumptions: {
								...builtinWorldAssumptions(
									site.operation,
									"exact-builtin-proof",
									singleRealm,
									"guarded",
								),
							},
						},
						sourcePosition: position,
						outputRepresentations: representations,
					},
				).outputs[0]!,
			);
			continue;
		}
		if (site !== undefined) {
			const receiver = inputs[1]!;
			let arguments_ = inputs.slice(2);
			const exact =
				site.kind === "method" ? exactBuiltinCallDescriptor(site.operation) : undefined;
			const forwarded = exact?.receiverProof === "intrinsic-object";
			if (forwarded && exact.forwardedArgumentLimit !== undefined)
				arguments_ = arguments_.slice(0, exact.forwardedArgumentLimit);
			copied.set(
				result!,
				editor.appendInstruction(copy, "callKnown", [receiver, ...arguments_].map(map), {
					attributes: guardedCallAttributes(fn, site, forwarded, singleRealm),
					sourcePosition: position,
					outputRepresentations: representations,
				}).outputs[0]!,
			);
			continue;
		}
		const attributes = {
			...coreUnscopedInstructionAttributes(fn.instructionAttributes(instruction)),
		};
		if (fn.instructionOpcodeName(instruction) === "loadGlobalProperty")
			attributes[CORE_PRIMORDIAL_BINDING_TWIN_ATTRIBUTE] = true;
		const created = editor.appendInstruction(
			copy,
			fn.instructionOpcodeName(instruction),
			inputs.map(map),
			{
				attributes,
				sourcePosition: position,
				outputCount: representations.length,
				outputRepresentations: representations,
			},
		);
		results(fn, instruction).forEach((value, index) =>
			copied.set(value, created.outputs[index]!),
		);
	}
	editor.setTerminator(copy, {
		kind: "jump",
		edge: { block: join, arguments: liveOut.map(map) },
		sourcePosition,
	});
	editor.setTerminator(twin, {
		kind: "jump",
		edge: { block: join, arguments: liveOut },
		sourcePosition,
	});
	const holds = editor.appendInstruction(block, "guardSemanticEpoch", [], {
		attributes: { family: "primordial-bindings" },
		sourcePosition,
		outputRepresentations: ["boolean"],
	}).outputs[0]!;
	editor.setTerminator(block, {
		kind: "branch",
		condition: holds,
		consequent: { block: copy, arguments: [] },
		alternate: { block: twin, arguments: [] },
		sourcePosition,
	});
	return { join, joined };
}

/** Guards primordial calls while preserving their loaded fallback and argument effects. */
export const guardPrimordialBindingCalls: CoreFunctionPass = {
	name: "guard-primordial-binding-calls",
	stage: "canonicalize",
	requiredFunctionOpcodesAny: ["loadGlobalProperty"],
	admission: {
		predicate: "global primordial call in a mutable world",
		hasOpportunity({ compilationContext }) {
			const { world } = compilationContext.facts;
			return world.primordialPolicy === "mutable";
		},
	},
	requiredAnalyses: [CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "cfg"],
	// The twin copies instructions, whose new values need fresh fact analyses.
	changes: { cfg: true, calls: true, facts: true, representations: false },
	budget: BUDGET,
	run(context) {
		const { program, compilationContext, item } = context;
		const { world } = compilationContext.facts;
		if (world.primordialPolicy !== "mutable") return undefined;
		const fn = program.function(item.function);
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		let controls: Uint8Array | undefined;
		const controlUse = (value: CoreValueId) =>
			(controls ??= coreValueControlFlowUseMask(fn))[value] !== 0;
		const sitesByInstruction = new Map<CoreInstructionId, Site>();
		const lateParsers: Array<Site> = [];
		const blocks = new Set<CoreBlockId>();
		let hasKnownEntries = false;
		for (const instruction of fn.instructionIds()) {
			const opcode = opcodeOf(fn, instruction);
			if (
				opcode === "callKnown" &&
				fn.instructionAttributes(instruction).operation === "Object.entries"
			)
				hasKnownEntries = true;
			if (opcode !== "call") continue;
			const site = siteFor(program, fn, world, instruction, kinds, controlUse);
			if (site === undefined) continue;
			if (
				world.realms &&
				site.operation === "Date.parse" &&
				operands(fn, instruction).length > 2 &&
				fn.instructionAttributes(instruction)[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE] !==
					true
			) {
				lateParsers.push(site);
				continue;
			}
			sitesByInstruction.set(site.name, site);
			if (site.method !== undefined) sitesByInstruction.set(site.method, site);
			sitesByInstruction.set(site.call, site);
			blocks.add(fn.instructionBlock(instruction));
		}
		if (hasKnownEntries) {
			const projected = projectJoinedEntryPair(
				program,
				fn,
				controlUse,
				context.remainingEdits,
			);
			if (projected !== undefined) return projected.commit();
		}
		if (lateParsers.length > 0) {
			let editor: CoreEditor | undefined;
			let remaining = context.remainingEdits;
			for (const site of lateParsers) {
				// A split moves the remaining block, so charge its whole function as an upper bound.
				const cost = 2 * fn.liveStorageCounts().instructions + 32;
				if (cost > remaining) break;
				remaining -= cost;
				editor ??= CoreEditor.open(program, item.function);
				guardRealmDateParser(fn, editor, site);
			}
			if (editor !== undefined) return editor.commit();
		}
		if (blocks.size === 0) return undefined;
		const skipped = regionCandidateBlocks(program, fn, sitesByInstruction);
		const planner = new RunPlanner(program, fn, kinds, sitesByInstruction, world.realms);
		let editor: CoreEditor | undefined;
		const pending = [...blocks].filter((block) => !skipped.has(block));
		while (pending.length > 0) {
			const block = pending.pop()!;
			const terminator = fn.blockTerminator(block);
			let next = firstInstruction(fn, block);
			while (next !== undefined && next !== terminator) {
				const site = sitesByInstruction.get(next);
				const run = site?.name === next ? planner.plan(next, terminator) : undefined;
				if (
					run === undefined ||
					3 * run.instructions.length + 16 > context.remainingEdits ||
					!guardedIterationEntrySplittable(fn, run.instructions[0]!)
				) {
					next = fn.instructionNext(next);
					continue;
				}
				editor ??= CoreEditor.open(program, item.function);
				// The rest of the block moved to the join, which may hold further runs.
				const { join, joined } = twinRun(fn, editor, run, !world.realms);
				planner.adoptJoin(joined);
				pending.push(join);
				break;
			}
		}
		return editor?.commit();
	},
};
