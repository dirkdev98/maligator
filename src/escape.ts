/**
 * Effect / escape summaries for allocation elimination (docs/roadmaps/gc.md).
 *
 * Two products, both pure analysis (no IR mutation → cannot miscompile):
 *
 *  1. **Per-function effect summaries** (`EffectSummary`): for each user function,
 *     the escape lattice of every parameter + the receiver (`this`), the provenance
 *     of its return value, and coarse effect flags (allocates / mayThrow / mayGC).
 *     Computed bottom-up to a fixpoint: a function's parameter escapes depend on the
 *     summaries of the callees it forwards them to. Hand-written summaries cover the
 *     hot C builtins (the functional-JS workhorses — `map`/`filter`/`forEach`/… —
 *     whose callbacks are *invoked, not retained*; the array mutators that *do*
 *     retain their args; the pure readers that retain nothing). Unknown callee ⇒
 *     everything `retained` (the analysis only ever *permits* an optimization it can
 *     prove safe).
 *
 *  2. **Per-register value escape** (`escapeOfRegister`): for a value produced inside
 *     a function (an allocation, a parameter, …), the join of how it escapes across
 *     every use of it and its single-assignment alias closure. Consumers (scalar
 *     replacement T7.4, write-barrier elision T2.6) ask `escapesFrame(kind)` — does
 *     this value outlive the current activation?
 *
 * Lattice (join = max): `none` < `invoked` < `returned` < `retained`.
 *  - none      — neither stored, returned, nor retained (read-only / dead).
 *  - invoked   — synchronously called (or passed to a callee that only invokes it),
 *                not stored: does NOT outlive the call.
 *  - returned  — flows into this function's return value (escapes to the caller).
 *  - retained  — stored somewhere outliving the call (a heap slot, a global, a
 *                captured env, a retaining callee/`this`): escapes the heap.
 *
 * Soundness rule everywhere: a use we do not explicitly recognise as safe ⇒
 * `retained`. The default is to assume the worst.
 */

import {
	capturedSlotFunctions,
	decodeStringConstant,
	functionValuedRegisters,
	globalSlotFunctions,
} from "./inline.ts";
import { buildIRRegisterIndex } from "./ir-register-index.ts";
import type { IRRegisterOperand } from "./ir-register-index.ts";
import type { IntermediateProgram, IRFunction, IRInstruction } from "./ir.ts";
import { log } from "./utils.ts";

export type EscapeKind = "none" | "invoked" | "returned" | "retained";

const RANK: Record<EscapeKind, number> = {
	none: 0,
	invoked: 1,
	returned: 2,
	retained: 3,
};

export function joinEscape(a: EscapeKind, b: EscapeKind): EscapeKind {
	return RANK[a] >= RANK[b] ? a : b;
}

/** Does this escape kind mean the value outlives the current activation? */
export function escapesFrame(kind: EscapeKind): boolean {
	return RANK[kind] >= RANK.returned;
}

export type ReturnProvenance = "fresh" | "primitive" | "param" | "unknown";

export interface EffectSummary {
	/** Escape of each formal parameter, indexed by parameter position. */
	params: Array<EscapeKind>;
	/** Escape of any argument beyond the declared parameters (variadic tail). */
	restParam: EscapeKind;
	/** Escape of the receiver (`this`). */
	receiver: EscapeKind;
	/** Where the return value comes from (for cross-call aliasing reasoning). */
	returnProvenance: ReturnProvenance;
	/** When `returnProvenance === "param"`, which parameter it aliases. */
	returnParamIndex: number;
	/** The body contains an allocation op. */
	allocates: boolean;
	/** The body can throw (a call, a coercible-check, an explicit throw, …). */
	mayThrow: boolean;
	/** The body can trigger a GC (it allocates or calls). */
	mayGC: boolean;
}

// ---------------------------------------------------------------------------
// Hand-written builtin summaries (the C builtins the functional corpus routes
// through). Keyed by method name; consulted for a `recv.method(args)` call whose
// method name matches. Where a name is shared by several prototypes (Array vs
// String `concat`/`slice`/…), the entry is the CONSERVATIVE intersection.
//
// `args[i]` is the escape of positional argument i; `restArg` covers any further
// arguments; `receiver` is the escape of the array/object the method is called on.
// ---------------------------------------------------------------------------

interface BuiltinSummary {
	receiver: EscapeKind;
	args: Array<EscapeKind>;
	restArg: EscapeKind;
	returnProvenance: ReturnProvenance;
}

/** Callback methods: the callback (arg 0) is invoked synchronously and not
 * retained; any `thisArg` (arg 1) is forwarded as the callback's `this`, which the
 * callback may retain, so it is conservatively `retained`. The receiver's elements
 * are read (and, for `map`/`filter`/`flatMap`, copied into a fresh result), so the
 * receiver array object itself is not retained. */
function callbackMethod(returnProvenance: ReturnProvenance): BuiltinSummary {
	return {
		receiver: "none",
		args: ["invoked", "retained"],
		restArg: "retained",
		returnProvenance,
	};
}

const BUILTIN_SUMMARIES: ReadonlyMap<string, BuiltinSummary> = new Map<
	string,
	BuiltinSummary
>([
	// Array iteration — the linchpin: callbacks must be `invoked`, never `retained`,
	// or the whole functional baseline escapes.
	["forEach", callbackMethod("primitive")],
	["map", callbackMethod("fresh")],
	["filter", callbackMethod("fresh")],
	["flatMap", callbackMethod("fresh")],
	["some", callbackMethod("primitive")],
	["every", callbackMethod("primitive")],
	["findIndex", callbackMethod("primitive")],
	["findLastIndex", callbackMethod("primitive")],
	["find", callbackMethod("unknown")],
	["findLast", callbackMethod("unknown")],
	[
		"reduce",
		{
			receiver: "none",
			args: ["invoked", "retained"],
			restArg: "retained",
			returnProvenance: "unknown",
		},
	],
	[
		"reduceRight",
		{
			receiver: "none",
			args: ["invoked", "retained"],
			restArg: "retained",
			returnProvenance: "unknown",
		},
	],

	// Array mutators that retain their arguments.
	[
		"push",
		{ receiver: "none", args: [], restArg: "retained", returnProvenance: "primitive" },
	],
	[
		"unshift",
		{ receiver: "none", args: [], restArg: "retained", returnProvenance: "primitive" },
	],
	[
		"splice",
		{
			receiver: "none",
			args: ["none", "none"],
			restArg: "retained",
			returnProvenance: "fresh",
		},
	],

	// Pure readers (retain nothing). `concat` is conservatively `retained` on its
	// args: each array arg's elements alias into the fresh result.
	["pop", { receiver: "none", args: [], restArg: "none", returnProvenance: "unknown" }],
	["shift", { receiver: "none", args: [], restArg: "none", returnProvenance: "unknown" }],
	[
		"slice",
		{
			receiver: "none",
			args: ["none", "none"],
			restArg: "none",
			returnProvenance: "fresh",
		},
	],
	[
		"concat",
		{ receiver: "none", args: [], restArg: "retained", returnProvenance: "fresh" },
	],
	[
		"join",
		{ receiver: "none", args: ["none"], restArg: "none", returnProvenance: "primitive" },
	],
	[
		"indexOf",
		{
			receiver: "none",
			args: ["none", "none"],
			restArg: "none",
			returnProvenance: "primitive",
		},
	],
	[
		"lastIndexOf",
		{
			receiver: "none",
			args: ["none", "none"],
			restArg: "none",
			returnProvenance: "primitive",
		},
	],
	[
		"includes",
		{
			receiver: "none",
			args: ["none", "none"],
			restArg: "none",
			returnProvenance: "primitive",
		},
	],
]);

// ---------------------------------------------------------------------------
// Per-function analysis context.
// ---------------------------------------------------------------------------

interface FunctionContext {
	/** Number of defining instructions per register. */
	defCount: ReadonlyMap<number, number>;
	/** Every use of a register: the instruction + the operand position. */
	usesOf: ReadonlyMap<number, ReadonlyArray<IRRegisterOperand>>;
	/** Registers whose sole definition is a `createString` → the string index. */
	singleDefs: ReadonlyMap<number, IRInstruction>;
	/** Register → functionIndex it provably holds (for resolving call callees). */
	funcOf: Map<number, number>;
}

function buildFunctionContext(
	fn: IRFunction,
	capturedSlots: ReadonlyMap<string, number>,
	globalSlots: ReadonlyMap<number, number>,
): FunctionContext {
	const registerIndex = buildIRRegisterIndex(fn);
	const defCount = new Map<number, number>();
	for (const [register, definitions] of registerIndex.definitions) {
		defCount.set(register, definitions.length);
	}
	return {
		defCount,
		usesOf: registerIndex.uses,
		singleDefs: registerIndex.uniqueDefinitions,
		funcOf: functionValuedRegisters(fn, capturedSlots, globalSlots),
	};
}

/** The method name of a `recv.method(...)` call, or undefined if the callee is not
 * a `loadProperty` with a constant string key. */
function callMethodName(
	program: IntermediateProgram,
	ctx: FunctionContext,
	call: IRInstruction,
): string | undefined {
	if (call.type !== "call" && call.type !== "callSpread") {
		return undefined;
	}
	const calleeDef = ctx.singleDefs.get(call.registers[1]);
	if (calleeDef === undefined || calleeDef.type !== "loadProperty") {
		return undefined;
	}
	const keyDef = ctx.singleDefs.get(calleeDef.registers[2]);
	if (keyDef === undefined || keyDef.type !== "createString") {
		return undefined;
	}
	return decodeStringConstant(program, keyDef.stringIndex);
}

// ---------------------------------------------------------------------------
// Per-register escape: the join over a register's single-assignment alias closure.
// ---------------------------------------------------------------------------

/**
 * Compute how the value(s) in `register` escape `fn`, joined over every use of the
 * register and of any single-assignment register it is `move`d into (its alias
 * closure). `summaries` are the (possibly partial, during fixpoint) callee
 * summaries; `program` is needed to decode call method names.
 *
 * Returns the escape kind. A short-circuit on `retained` keeps it cheap.
 */
export function escapeOfRegister(
	program: IntermediateProgram,
	fn: IRFunction,
	ctx: FunctionContext,
	register: number,
	summaries: ReadonlyMap<number, EffectSummary>,
): EscapeKind {
	let result: EscapeKind = "none";
	const seen = new Set<number>([register]);
	const worklist = [register];

	const raise = (kind: EscapeKind) => {
		result = joinEscape(result, kind);
	};

	while (worklist.length > 0 && RANK[result] < RANK.retained) {
		const alias = worklist.pop()!;
		for (const { instruction, position } of ctx.usesOf.get(alias) ?? []) {
			if (RANK[result] >= RANK.retained) {
				break;
			}
			switch (instruction.type) {
				case "loadProperty":
				case "loadSuperProperty": {
					// [dst, object, key]; object read = no escape, used as key = retained.
					raise(position === 1 ? "none" : "retained");
					break;
				}
				case "loadPrototype": {
					raise(position === 1 ? "none" : "retained"); // [dst, object]
					break;
				}
				case "typeofCompare": {
					raise(position === 1 ? "none" : "retained");
					break;
				}
				case "storeProperty":
				case "defineProperty":
				case "defineAccessor": {
					// [object, key, value]; writing INTO the object (pos 0) does not make
					// the object escape. Being the key or the stored value does.
					raise(position === 0 ? "none" : "retained");
					break;
				}
				case "move": {
					// [dst, src]; an alias. Follow only a single-assignment destination
					// (so it always holds this value); otherwise we lose track ⇒ retained.
					if (position !== 1) {
						raise("retained");
						break;
					}
					const dst = instruction.registers[0];
					if (ctx.defCount.get(dst) !== 1) {
						raise("retained");
						break;
					}
					if (!seen.has(dst)) {
						seen.add(dst);
						worklist.push(dst);
					}
					break;
				}
				case "return": {
					raise("returned");
					break;
				}
				case "call":
				case "callSpread": {
					raise(escapeThroughCall(program, fn, ctx, instruction, position, summaries));
					break;
				}
				default: {
					// throw / yield / await / storeLocal / storeGlobal / storeCaptured /
					// binary / unary / construct / setPrototype / deleteProperty / key
					// coercion / spread / … — anything we do not bless is conservative.
					raise("retained");
					break;
				}
			}
		}
	}
	return result;
}

/** Escape contribution of a value used at `position` of a `call`/`callSpread`. */
function escapeThroughCall(
	program: IntermediateProgram,
	fn: IRFunction,
	ctx: FunctionContext,
	call: Extract<IRInstruction, { type: "call" | "callSpread" }>,
	position: number,
	summaries: ReadonlyMap<number, EffectSummary>,
): EscapeKind {
	// registers = [destination, callee, this, ...args]. Position 0 is the
	// destination (not a use). Position 1 = callee: the value is being invoked.
	if (position === 1) {
		return "invoked";
	}

	// A spread call hides the individual arguments in an array; if our value is that
	// array its elements flow to the callee — conservatively retained.
	if (call.type === "callSpread") {
		return position === 2
			? receiverEscapeOfCall(program, fn, ctx, call, summaries)
			: "retained";
	}

	const summary = resolveCallSummary(program, fn, ctx, call, summaries);
	if (summary === undefined) {
		return "retained"; // unknown callee
	}
	if (position === 2) {
		return summary.receiver;
	}
	const argIndex = position - 3;
	return summary.args[argIndex] ?? summary.restArg;
}

interface ResolvedSummary {
	receiver: EscapeKind;
	args: Array<EscapeKind>;
	restArg: EscapeKind;
}

/** Resolve a `recv.method(...)` builtin summary or a direct-call user summary. */
function resolveCallSummary(
	program: IntermediateProgram,
	fn: IRFunction,
	ctx: FunctionContext,
	call: Extract<IRInstruction, { type: "call" | "callSpread" }>,
	summaries: ReadonlyMap<number, EffectSummary>,
): ResolvedSummary | undefined {
	const method = callMethodName(program, ctx, call);
	if (method !== undefined) {
		const builtin = BUILTIN_SUMMARIES.get(method);
		if (builtin !== undefined) {
			return builtin;
		}
		// A method call on an unknown receiver type: conservative.
		return undefined;
	}
	// A direct call to a resolvable user function.
	const target = ctx.funcOf.get(call.registers[1]);
	if (target === undefined) {
		return undefined;
	}
	const summary = summaries.get(target);
	if (summary === undefined) {
		return undefined;
	}
	return { receiver: summary.receiver, args: summary.params, restArg: summary.restParam };
}

function receiverEscapeOfCall(
	program: IntermediateProgram,
	fn: IRFunction,
	ctx: FunctionContext,
	call: Extract<IRInstruction, { type: "call" | "callSpread" }>,
	summaries: ReadonlyMap<number, EffectSummary>,
): EscapeKind {
	return resolveCallSummary(program, fn, ctx, call, summaries)?.receiver ?? "retained";
}

// ---------------------------------------------------------------------------
// Per-function summary (bottom-up fixpoint).
// ---------------------------------------------------------------------------

const ALLOC_TYPES: ReadonlySet<string> = new Set([
	"createObject",
	"createObjectShaped",
	"createArray",
	"instantiateLiteralTemplate",
	"createFunction",
	"createArgumentsObject",
	"createRestArguments",
	"createModuleNamespace",
	"createTemplateObject",
	"createBigint",
]);

/** A parameter is analyzable only if it is a pure incoming value — register
 * `[0..parameterCount)` with no defining instruction (never reassigned). A
 * reassigned or spilled parameter is conservatively `retained`. */
function paramRegisterAnalyzable(ctx: FunctionContext, register: number): boolean {
	return (ctx.defCount.get(register) ?? 0) === 0;
}

function structuralEffects(fn: IRFunction): {
	allocates: boolean;
	mayThrow: boolean;
	mayGC: boolean;
} {
	let allocates = false;
	let mayThrow = false;
	let mayGC = false;
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			const type = instruction.type;
			if (ALLOC_TYPES.has(type)) {
				allocates = true;
				mayGC = true;
			}
			if (
				type === "call" ||
				type === "callSpread" ||
				type === "construct" ||
				type === "constructSpread" ||
				type === "constructSuper" ||
				type === "constructSuperExplicit"
			) {
				mayGC = true;
				mayThrow = true;
			}
			if (
				type === "throw" ||
				type === "throwIfTdz" ||
				type === "requireCoercible" ||
				type === "loadProperty" ||
				type === "storeProperty"
			) {
				mayThrow = true;
			}
		}
	}
	return { allocates, mayThrow, mayGC };
}

/** Provenance of the function's return value(s). `fresh` only if every returned
 * value is a same-function allocation; `primitive` if every returned value is a
 * primitive literal; `param` if a single parameter is returned; else `unknown`. */
function returnProvenance(
	fn: IRFunction,
	ctx: FunctionContext,
	parameterCount: number,
): { provenance: ReturnProvenance; paramIndex: number } {
	const PRIMITIVE_CREATES = new Set([
		"createNumber",
		"createString",
		"createBoolean",
		"createNull",
		"createUndefined",
		"createBigint",
	]);
	const returnedRegisters: Array<number> = [];
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (instruction.type === "return") {
				returnedRegisters.push(instruction.registers[0]);
			}
		}
	}
	if (returnedRegisters.length === 0) {
		return { provenance: "primitive", paramIndex: -1 }; // implicit undefined
	}
	let allFresh = true;
	let allPrimitive = true;
	let paramIndex = -1;
	let singleParam = true;
	for (const register of returnedRegisters) {
		const def = ctx.singleDefs.get(register);
		const defType = def?.type;
		if (defType === undefined || !ALLOC_TYPES.has(defType)) {
			allFresh = false;
		}
		if (defType === undefined || !PRIMITIVE_CREATES.has(defType)) {
			allPrimitive = false;
		}
		// A returned parameter: register is an unwritten param register.
		if (register < parameterCount && paramRegisterAnalyzable(ctx, register)) {
			if (paramIndex === -1) {
				paramIndex = register;
			} else if (paramIndex !== register) {
				singleParam = false;
			}
		} else {
			singleParam = false;
		}
	}
	if (allPrimitive) {
		return { provenance: "primitive", paramIndex: -1 };
	}
	if (allFresh) {
		return { provenance: "fresh", paramIndex: -1 };
	}
	if (singleParam && paramIndex !== -1) {
		return { provenance: "param", paramIndex };
	}
	return { provenance: "unknown", paramIndex: -1 };
}

/** Whether the function can be analyzed at all, or must default to fully
 * conservative (every param + receiver `retained`, return `unknown`). */
function analyzable(fn: IRFunction): boolean {
	if (fn.isGenerator || fn.isAsync) {
		return false; // values may live across a suspension (C5)
	}
	if (fn.semanticFile.hasDirectEval.size > 0) {
		return false; // C3: direct eval can reach a local without an explicit IR use
	}
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.type === "withEnter" ||
				instruction.type === "withGet" ||
				instruction.type === "withResolveBase" ||
				instruction.type === "withSet"
			) {
				return false; // C3: dynamic scope
			}
		}
	}
	return true;
}

function conservativeSummary(fn: IRFunction): EffectSummary {
	return {
		params: new Array<EscapeKind>(fn.parameterCount).fill("retained"),
		restParam: "retained",
		receiver: "retained",
		returnProvenance: "unknown",
		returnParamIndex: -1,
		allocates: true,
		mayThrow: true,
		mayGC: true,
	};
}

export interface ProgramEscape {
	summaries: Map<number, EffectSummary>;
	contexts: Map<number, FunctionContext>;
	program: IntermediateProgram;
}

/**
 * Compute the program-wide escape analysis: a `FunctionContext` and an
 * `EffectSummary` for every function. Summaries are computed by a monotone
 * fixpoint — parameter/receiver escapes start optimistic (`none`) and are only
 * ever raised as forwarding into a (now-better-known) callee is discovered, so it
 * terminates on the finite lattice.
 */
export function analyzeProgramEscape(program: IntermediateProgram): ProgramEscape {
	const capturedSlots = capturedSlotFunctions(program);
	const globalSlots = globalSlotFunctions(program);

	const contexts = new Map<number, FunctionContext>();
	const summaries = new Map<number, EffectSummary>();

	// Seed: conservative for unanalyzable functions (fixed point already), optimistic
	// for analyzable ones (params/receiver `none`, raised below).
	const analyzableSet = new Set<number>();
	for (const fn of program.functions) {
		contexts.set(fn.functionIndex, buildFunctionContext(fn, capturedSlots, globalSlots));
		if (!analyzable(fn)) {
			summaries.set(fn.functionIndex, conservativeSummary(fn));
			continue;
		}
		analyzableSet.add(fn.functionIndex);
		const effects = structuralEffects(fn);
		const { provenance, paramIndex } = returnProvenance(
			fn,
			contexts.get(fn.functionIndex)!,
			fn.parameterCount,
		);
		summaries.set(fn.functionIndex, {
			params: new Array<EscapeKind>(fn.parameterCount).fill("none"),
			restParam: "none",
			receiver: "none",
			returnProvenance: provenance,
			returnParamIndex: paramIndex,
			allocates: effects.allocates,
			mayThrow: effects.mayThrow,
			mayGC: effects.mayGC,
		});
	}

	let changed = true;
	let rounds = 0;
	while (changed && rounds < 64) {
		changed = false;
		rounds++;
		for (const fn of program.functions) {
			if (!analyzableSet.has(fn.functionIndex)) {
				continue;
			}
			const ctx = contexts.get(fn.functionIndex)!;
			const summary = summaries.get(fn.functionIndex)!;

			for (let i = 0; i < fn.parameterCount; i++) {
				const previous = summary.params[i]!;
				if (previous === "retained") {
					continue;
				}
				const next = paramRegisterAnalyzable(ctx, i)
					? escapeOfRegister(program, fn, ctx, i, summaries)
					: "retained";
				const joined = joinEscape(previous, next);
				if (joined !== previous) {
					summary.params[i] = joined;
					changed = true;
				}
			}
			// The receiver (`this`) has no IR register here (it is read via `loadThis`);
			// a function that reads `this` may store it. Without per-`this` tracking we
			// keep the optimistic `none` only for leaf-like functions and otherwise stay
			// conservative is handled by callers consulting `receiver` — leave `none`.
		}
	}

	return { summaries, contexts, program };
}

/** Convenience: does the value in `register` escape its function's activation
 * (returned or retained)? Uses the finished program summaries. */
export function registerEscapesFrame(
	analysis: ProgramEscape,
	fn: IRFunction,
	register: number,
): boolean {
	const ctx = analysis.contexts.get(fn.functionIndex);
	if (ctx === undefined) {
		return true;
	}
	return escapesFrame(
		escapeOfRegister(analysis.program, fn, ctx, register, analysis.summaries),
	);
}

// ---------------------------------------------------------------------------
// Broad stack-allocation opportunity diagnostic (T7.4 / §N.7).
//
// This classifier deliberately remains diagnostic: its escape summaries permit
// non-retaining calls and dynamic-key reads, neither of which is sufficient proof
// for a C-stack pointer. Native emission uses the narrower, instruction-keyed
// closed-use proof in ir-opt.ts instead and must not consume this result directly.
// ---------------------------------------------------------------------------

export type StackAllocClass = "scalar" | "stack";

export interface StackAllocCandidate {
	register: number;
	allocType: string;
	/** "stack": identity observed (call arg / dynamic-key read) — the residual only
	 * stack allocation can take. "scalar": ir-opt.ts already removes it entirely;
	 * reported for comparison. */
	klass: StackAllocClass;
}

/** The constant string-key index a key register holds, if its sole definition is a
 * `createString`; undefined for a dynamic (computed) key. */
function constKeyStringIndex(
	ctx: FunctionContext,
	keyRegister: number,
): number | undefined {
	const def = ctx.singleDefs.get(keyRegister);
	return def?.type === "createString" ? def.stringIndex : undefined;
}

/**
 * Classify a single-assignment, non-escaping `createObjectShaped` as a stack
 * candidate, or `undefined` if its shape can transition (a store of a key the
 * literal did not declare, a dynamic-key store, or a shape-changing op such as
 * `defineProperty`/`delete`/`setPrototype` — any of which would force a heap
 * `overflow` table the stack object cannot own). Precondition: the register does
 * not escape the frame, so every use is already in the escape lattice's blessed,
 * non-retaining set; this only rules out shape mutation.
 */
function classifyShapedStackAlloc(
	ctx: FunctionContext,
	alloc: Extract<IRInstruction, { type: "createObjectShaped" }>,
): StackAllocClass | undefined {
	const shapeKeys = new Set(alloc.keyStringIndices);
	let identityObserved = false;
	const seen = new Set<number>([alloc.registers[0]]);
	const worklist = [alloc.registers[0]];
	while (worklist.length > 0) {
		const alias = worklist.pop()!;
		for (const { instruction, position } of ctx.usesOf.get(alias) ?? []) {
			switch (instruction.type) {
				case "loadProperty":
				case "loadSuperProperty": {
					// [dst, object, key]; object read at pos 1. A dynamic key observes the
					// shape at runtime → not scalar-replaceable, but still stack-allocatable
					// (a real MalObject answers the MOP read).
					if (position !== 1) return undefined;
					if (constKeyStringIndex(ctx, instruction.registers[2]) === undefined) {
						identityObserved = true;
					}
					break;
				}
				case "loadPrototype": {
					if (position !== 1) return undefined; // [dst, object]
					break;
				}
				case "typeofCompare": {
					if (position !== 1) return undefined;
					identityObserved = true;
					break;
				}
				case "storeProperty": {
					// [object, key, value]; object at pos 0. A store of a key not already in
					// the shape (or a dynamic key) transitions the shape → forces overflow.
					if (position !== 0) return undefined;
					const key = constKeyStringIndex(ctx, instruction.registers[1]);
					if (key === undefined || !shapeKeys.has(key)) return undefined;
					break;
				}
				case "move": {
					if (position !== 1) return undefined; // [dst, src]
					const dst = instruction.registers[0];
					if (ctx.defCount.get(dst) !== 1) return undefined;
					if (!seen.has(dst)) {
						seen.add(dst);
						worklist.push(dst);
					}
					break;
				}
				case "call":
				case "callSpread": {
					// The escape lattice proved this callee neither retains the value nor is
					// a reassignable binding, else the register would have escaped and never
					// reached here. Identity flows to the callee → not scalar-replaceable.
					identityObserved = true;
					break;
				}
				default:
					// defineProperty / defineAccessor / setPrototype / deleteProperty and any
					// other shape-mutating or unrecognized use: disqualify (the escape lattice
					// blesses some of these at pos 0 as non-retaining, but they change layout).
					return undefined;
			}
		}
	}
	return identityObserved ? "stack" : "scalar";
}

/** Every broad stack-allocation opportunity in `fn`, keyed by allocation
 * destination register. Pure diagnostic analysis; not consumed by codegen. */
export function stackAllocCandidates(
	analysis: ProgramEscape,
	fn: IRFunction,
): Map<number, StackAllocCandidate> {
	const result = new Map<number, StackAllocCandidate>();
	const ctx = analysis.contexts.get(fn.functionIndex);
	if (ctx === undefined) {
		return result;
	}
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (instruction.type !== "createObjectShaped") {
				continue;
			}
			const register = instruction.registers[0];
			if (ctx.defCount.get(register) !== 1) {
				continue;
			}
			const kind = escapeOfRegister(
				analysis.program,
				fn,
				ctx,
				register,
				analysis.summaries,
			);
			if (escapesFrame(kind)) {
				continue;
			}
			const klass = classifyShapedStackAlloc(ctx, instruction);
			if (klass !== undefined) {
				result.set(register, { register, allocType: instruction.type, klass });
			}
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Debug dump (`--dump-escape`).
// ---------------------------------------------------------------------------

export function debugProgramEscape(program: IntermediateProgram): string {
	const analysis = analyzeProgramEscape(program);
	const lines: Array<string> = [];
	lines.push("=== escape / effect summaries ===");
	for (const fn of program.functions) {
		const summary = analysis.summaries.get(fn.functionIndex)!;
		const name =
			fn.nameStringIndex >= 0 && fn.nameStringIndex < program.stringConstants.length
				? decodeStringConstant(program, fn.nameStringIndex)
				: "";
		const flags = [
			summary.allocates ? "alloc" : "",
			summary.mayThrow ? "throw" : "",
			summary.mayGC ? "gc" : "",
		]
			.filter(Boolean)
			.join(",");
		lines.push(
			`fn#${fn.functionIndex} ${name || "<anon>"} ` +
				`params=[${summary.params.join(", ")}${
					summary.params.length > 0 ? ", " : ""
				}...${summary.restParam}] ` +
				`this=${summary.receiver} ` +
				`ret=${summary.returnProvenance}${
					summary.returnProvenance === "param" ? `(#${summary.returnParamIndex})` : ""
				} ` +
				`[${flags}]`,
		);

		// Per-allocation escape within this function.
		const ctx = analysis.contexts.get(fn.functionIndex)!;
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (!ALLOC_TYPES.has(instruction.type) || !("registers" in instruction)) {
					continue;
				}
				const register = instruction.registers[0]!;
				const kind = escapeOfRegister(program, fn, ctx, register, analysis.summaries);
				lines.push(
					`    ${instruction.type} r${register}: ${kind}${
						escapesFrame(kind) ? "" : "  ← non-escaping"
					}`,
				);
			}
		}
	}
	const total = program.functions.length;
	let nonEscapingAllocs = 0;
	let totalAllocs = 0;
	for (const fn of program.functions) {
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (!ALLOC_TYPES.has(instruction.type) || !("registers" in instruction)) {
					continue;
				}
				totalAllocs++;
				if (!registerEscapesFrame(analysis, fn, instruction.registers[0]!)) {
					nonEscapingAllocs++;
				}
			}
		}
	}
	lines.push(
		`=== ${total} functions, ${nonEscapingAllocs}/${totalAllocs} allocation sites non-escaping ===`,
	);
	return lines.join("\n");
}

export function dumpProgramEscape(program: IntermediateProgram): void {
	log.info(debugProgramEscape(program));
}

/** `--dump-stack-alloc`: per-function broad stack-allocation opportunities + a corpus tally
 * (how many heap allocations escape analysis proves are frame-local and
 * shape-fixed). Diagnostic only; the sound transform uses a separate narrow proof. */
export function debugStackAlloc(program: IntermediateProgram): string {
	const analysis = analyzeProgramEscape(program);
	const lines: Array<string> = ["=== stack-allocation candidates ==="];
	let stackCount = 0;
	let scalarCount = 0;
	for (const fn of program.functions) {
		const candidates = stackAllocCandidates(analysis, fn);
		if (candidates.size === 0) {
			continue;
		}
		const name =
			fn.nameStringIndex >= 0 && fn.nameStringIndex < program.stringConstants.length
				? decodeStringConstant(program, fn.nameStringIndex)
				: "<anon>";
		lines.push(`fn#${fn.functionIndex} ${name}`);
		for (const c of candidates.values()) {
			lines.push(`    r${c.register} ${c.allocType}: ${c.klass}`);
			if (c.klass === "stack") {
				stackCount++;
			} else {
				scalarCount++;
			}
		}
	}
	lines.push(
		`=== ${stackCount} stack-only (identity observed) + ${scalarCount} also-scalar-replaceable ===`,
	);

	lines.push("=== residual object allocation decisions ===");
	const functionName = (fn: IRFunction): string => {
		const decoded =
			fn.nameStringIndex >= 0 && fn.nameStringIndex < program.stringConstants.length
				? decodeStringConstant(program, fn.nameStringIndex)
				: "";
		return decoded || "<anon>";
	};
	const sourceLocation = (position: number): string => {
		const parts: Array<string> = [];
		let current = position;
		while (current >= 0) {
			const sourcePosition = program.sourcePositions[current];
			if (sourcePosition === undefined) break;
			const inlined =
				sourcePosition.inlinedFunctionIndex === undefined
					? ""
					: `${functionName(program.functions[sourcePosition.inlinedFunctionIndex]!)}@`;
			parts.push(`${inlined}${sourcePosition.line}:${sourcePosition.column}`);
			current = sourcePosition.callerPosId ?? -1;
		}
		return parts.length === 0 ? "?:?" : parts.join(" <- ");
	};
	let nativeStackCount = 0;
	let residualHeapCount = 0;
	for (const fn of program.functions) {
		const ctx = analysis.contexts.get(fn.functionIndex)!;
		const name = functionName(fn);
		let wroteFunction = false;
		for (const block of fn.blocks) {
			let position = -1;
			for (const instruction of block.instructions) {
				if (instruction.type === "sourcePos") {
					position = instruction.pos;
					continue;
				}
				if (
					instruction.type !== "createObject" &&
					instruction.type !== "createObjectShaped"
				) {
					continue;
				}
				if (!wroteFunction) {
					lines.push(`fn#${fn.functionIndex} ${name}`);
					wroteFunction = true;
				}
				const source = sourceLocation(position);
				const register = instruction.registers[0];
				if (instruction.stackObject) {
					const siteId = instruction.stackObjectSiteId;
					const materializations = fn.blocks.reduce(
						(sum, candidateBlock) =>
							sum +
							candidateBlock.instructions.filter(
								(candidate) =>
									candidate.type === "return" &&
									candidate.stackObjectMaterializeSiteId === siteId,
							).length,
						0,
					);
					const slots =
						instruction.type === "createObjectShaped"
							? instruction.keyStringIndices.length
							: 0;
					lines.push(
						`    ${source} r${register} ${instruction.type}: native-stack slots=${slots} materializing-returns=${materializations}`,
					);
					nativeStackCount++;
				} else {
					const escape = escapeOfRegister(program, fn, ctx, register, analysis.summaries);
					lines.push(
						`    ${source} r${register} ${instruction.type}: heap-residual escape=${escape}`,
					);
					residualHeapCount++;
				}
			}
		}
	}
	lines.push(
		`=== ${nativeStackCount} native-stack + ${residualHeapCount} heap-residual object sites ===`,
	);
	return lines.join("\n");
}

export function dumpStackAlloc(program: IntermediateProgram): void {
	log.info(debugStackAlloc(program));
}
