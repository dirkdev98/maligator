import { builtinWorldAssumptions } from "../shared/builtin-assumptions.ts";
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
import { guardedIterationEntrySplittable } from "./core-guarded-iteration.ts";
import {
	CORE_PRIMORDIAL_BINDING_TWIN_ATTRIBUTE,
	coreUnscopedInstructionAttributes,
} from "./core-internal-attributes.ts";
import { buildCoreControlFlow, coreTerminatorInput } from "./core-ir-control-flow.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import { CORE_STRING_SPAN_RANGE_METHODS } from "./core-ir-regions.ts";
import {
	CORE_LOCAL_VALUE_KIND_ANALYSIS,
	CORE_PRIMITIVE_EFFECT_FACT,
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
 * call's builtin through the mutable graph when it runs, so a known call follows
 * nothing that could have replaced it either; only a Math call on Numbers, which the
 * copy runs as a numeric kernel that resolves nothing, may. Mid-run mutations
 * therefore take effect at the next evaluation, which the next run's guard sees.
 */

/**
 * Namespaces whose methods a run calls. Each is a watched built-in, so replacing or
 * deleting one of their methods advances the builtin-identity epoch, and with it
 * the primordial-bindings one.
 */
const NAMESPACES: ReadonlySet<CompilerIntrinsic> = new Set<CompilerIntrinsic>([
	"Math",
	"Number",
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
 * Operations with primitive results that no later region recognizes by its loaded
 * callee. Object-producing calls such as `Object.entries` or `Array.from` and
 * constructions keep their guarded form, which entry snapshots, record columns and
 * typed array regions consume.
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

const NUMBER_PREDICATES: ReadonlySet<string> = new Set([
	"Number.isNaN",
	"Number.isFinite",
	"Number.isInteger",
	"Number.isSafeInteger",
]);

const MATH_NUMBER_KERNELS: ReadonlySet<string> = new Set([
	...mathUnaryOperationKeys.map(([operation]) => operation),
	"Math.min",
	"Math.max",
]);

/** Instructions a twin copies, besides the loads and calls it replaces. */
const COPYABLE_OPCODES: ReadonlySet<string> = new Set([
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

const BUDGET: CorePassBudget = Object.freeze({
	maxWorkItems: 2_000_000,
	maxEdits: 1_000_000,
	exhaustion: "stop",
});

interface Site {
	/** The global name load: the namespace, or the callee of a direct call. */
	readonly name: CoreInstructionId;
	/** The method load of a namespace call. */
	readonly method?: CoreInstructionId;
	readonly call: CoreInstructionId;
	readonly intrinsic: CompilerIntrinsic;
	readonly operation: string;
	readonly kind: "method" | "function";
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
): Site | undefined {
	if (opcodeOf(fn, call) !== "call" || results(fn, call).length !== 1) return undefined;
	const inputs = operands(fn, call);
	const block = fn.instructionBlock(call);
	const callee = definition(fn, inputs[0]!);
	if (callee === undefined || fn.instructionBlock(callee) !== block) return undefined;
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
	const namespace = definition(fn, namespaceValue);
	if (
		namespace === undefined ||
		fn.instructionBlock(namespace) !== block ||
		inputs[1] !== namespaceValue ||
		fn.valueUseCount(inputs[0]!) !== 1 ||
		fn.kernel.valueHandlerUseCount(inputs[0]!) !== 0
	)
		return undefined;
	const intrinsic = primordialGlobal(program, fn, namespace);
	if (intrinsic === undefined || !NAMESPACES.has(intrinsic)) return undefined;
	const namespaceNode = ownDataPrimordial("globalThis", intrinsic, world);
	const key = fn.instructionAttributes(callee).stringIndex;
	if (namespaceNode === undefined || typeof key !== "number") return undefined;
	const operation = allowed(
		ownDataPrimordial(namespaceNode, program.stringConstantText(key), world),
	);
	if (operation === undefined) return undefined;
	return { name: namespace, method: callee, call, intrinsic, operation, kind: "method" };
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
	readonly #sitesByInstruction: ReadonlyMap<CoreInstructionId, Site>;
	/** Kinds of the values the copy computes, where its known calls narrow them. */
	readonly #copyKinds = new Map<CoreValueId, CompilerValueKindMask>();
	/**
	 * The value a join parameter of an earlier twin replaced. It holds either that
	 * value or its copy's narrower one, and the kind analysis predates it.
	 */
	readonly #joined = new Map<CoreValueId, CoreValueId>();

	constructor(
		fn: CoreFunctionStore,
		kinds: CoreValueKindAnalysis,
		sitesByInstruction: ReadonlyMap<CoreInstructionId, Site>,
	) {
		this.#fn = fn;
		this.#kinds = kinds;
		this.#sitesByInstruction = sitesByInstruction;
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

	/** Whether the known call can run JavaScript, which ends the run after it. */
	#callReenters(site: Site): boolean {
		return !NUMBER_PREDICATES.has(site.operation) && !this.#mathKernel(site);
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

	/** The run that starts with the global name load `first`, if any of its sites fits. */
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
				if (!loaded || (reentered && !kernel)) break;
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
		for (const site of sites) last = site.call;
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
): Record<string, CoreAttributeValue> {
	const sourceCall = fn.instructionAttributes(site.call).sourceCall;
	return {
		...(typeof sourceCall === "number" ? { sourceCall } : {}),
		operation: site.operation,
		...(forwarded ? { specialized: site.operation } : {}),
		worldAssumptions: {
			...builtinWorldAssumptions(site.operation, "exact-builtin-proof", true, "guarded"),
		},
		knownBuiltinCall: guardedKnownOperationCall(
			site.operation,
			fn.id,
		) as unknown as CoreAttributeValue,
	};
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
		if (fn.instructionOpcodeName(instruction) === "loadGlobalProperty")
			editor.replaceInstruction(instruction, "loadGlobalProperty", inputs, {
				attributes: {
					...fn.instructionAttributes(instruction),
					[CORE_PRIMORDIAL_BINDING_TWIN_ATTRIBUTE]: true,
				},
				sourcePosition: fn.instructionSourcePosition(instruction),
				effectRefinement: fn.instructionEffectRefinement(instruction),
			});
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
					attributes: { intrinsic: site.intrinsic },
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
									true,
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
					attributes: guardedCallAttributes(fn, site, forwarded),
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

/**
 * Twins runs of global primordial namespace and function calls behind one
 * primordial-bindings guard each.
 */
export const guardPrimordialBindingCalls: CoreFunctionPass = {
	name: "guard-primordial-binding-calls",
	stage: "canonicalize",
	requiredFunctionOpcodesAny: ["loadGlobalProperty"],
	admission: {
		predicate: "global primordial call in a mutable single realm",
		hasOpportunity({ compilationContext }) {
			const { world } = compilationContext.facts;
			return world.primordialPolicy === "mutable" && !world.realms;
		},
	},
	requiredAnalyses: [CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "cfg"],
	changes: { cfg: true, calls: true, facts: false, representations: false },
	budget: BUDGET,
	run(context) {
		const { program, compilationContext, item } = context;
		const { world } = compilationContext.facts;
		if (world.primordialPolicy !== "mutable" || world.realms) return undefined;
		const fn = program.function(item.function);
		const sitesByInstruction = new Map<CoreInstructionId, Site>();
		const blocks = new Set<CoreBlockId>();
		for (const instruction of fn.instructionIds()) {
			const opcode = opcodeOf(fn, instruction);
			if (opcode !== "call") continue;
			const site = siteFor(program, fn, world, instruction);
			if (site === undefined) continue;
			sitesByInstruction.set(site.name, site);
			if (site.method !== undefined) sitesByInstruction.set(site.method, site);
			sitesByInstruction.set(site.call, site);
			blocks.add(fn.instructionBlock(instruction));
		}
		if (blocks.size === 0) return undefined;
		const skipped = regionCandidateBlocks(program, fn, sitesByInstruction);
		const planner = new RunPlanner(
			fn,
			context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS),
			sitesByInstruction,
		);
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
				const { join, joined } = twinRun(fn, editor, run);
				planner.adoptJoin(joined);
				pending.push(join);
				break;
			}
		}
		return editor?.commit();
	},
};
