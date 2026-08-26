import type { DirectBuiltinOperationId } from "./builtin-registry.ts";
import type { KnownBuiltinCall } from "./compiler-facts.ts";
import type { CompilerValueKindMask } from "./compiler-value-kinds.ts";

/** Numeric TypedArray brands whose element access produces a Number. */
export type CompilerNumericTypedArrayKind =
	| "Int8Array"
	| "Uint8Array"
	| "Uint8ClampedArray"
	| "Int16Array"
	| "Uint16Array"
	| "Int32Array"
	| "Uint32Array"
	| "Float32Array"
	| "Float64Array";

export type CompilerExactCollectionBrand = "Map" | "Set";

export type CompilerImmediateValue =
	| { kind: "undefined" }
	| { kind: "null" }
	| { kind: "boolean"; value: boolean }
	| { kind: "number"; value: number }
	| { kind: "string"; index: number };

export type CompilerTypeofResult =
	| "undefined"
	| "object"
	| "boolean"
	| "number"
	| "string"
	| "symbol"
	| "bigint"
	| "function";

/** One guarded initial shaped-object slot candidate retained by target lowering. */
export interface CompilerKnownOwnSlotCandidate {
	readonly shapeFunctionIndex: number;
	readonly shapeInstruction: number;
	readonly slot: number;
}

/** Bounded polymorphic own-slot certificate; every candidate retains fallback. */
export interface CompilerKnownOwnSlot {
	readonly candidates: ReadonlyArray<CompilerKnownOwnSlotCandidate>;
}

/** One layout admitted by a shared exact-shape case selector. */
export interface CompilerShapeCaseCandidate {
	readonly shapeFunctionIndex: number;
	readonly shapeInstruction: number;
}

export type CompilerInstruction =
	| {
			/**
			 * Source-position marker — carries no runtime opcode. Records the
			 * interned source position (an index into program.sourcePositions) of
			 * the statement that follows. lowerFunctionToBytecodeFunction consumes these
			 * into the per-function position table (which drives VM stack traces and
			 * the native backend's `pos` writes) and strips them from the bytecode,
			 * so the VM never dispatches one. Core construction strips it into source
			 * metadata before optimization and allocation.
			 */
			type: "sourcePos";
			pos: number;
	  }
	| {
			type: "move";

			// [dest, source]
			registers: [number, number];
	  }
	| {
			type: "return";

			// [return value]
			registers: [number];
	  }
	| {
			type: "jumpIf";

			// [ifTrueRegister]
			registers: [number];

			// [jumpTarget];
			blocks: [number];
	  }
	| {
			type: "jump";

			// [jumpTarget]
			blocks: [number];
	  }
	| {
			type: "createNumber";

			// [destination]
			registers: [number];

			value: number;
	  }
	| {
			type: "createF64";

			// [destination]
			registers: [number];

			value: number;
	  }
	| {
			type: "createBoolean";

			// [destination]
			registers: [number];

			value: boolean;
	  }
	| {
			type: "createString";

			// [destination]
			registers: [number];

			stringIndex: number;
	  }
	| {
			type: "createBigint";

			// [destination]
			registers: [number];

			// Index into the program's immortal bigint constant pool.
			bigintIndex: number;
	  }
	| {
			type: "createObject";

			// [destination, ...finite-region Number guards]
			registers: [number, ...Array<number>];
	  }
	| {
			// A fully static data-property object literal: all keys are known
			// non-index strings, so the final shape is built once and the slots are
			// filled directly, skipping per-property defineProperty transitions.
			type: "createObjectShaped";

			// [destination, ...valueRegisters] — one value register per key, in order
			registers: [number, ...Array<number>];

			// String-constant index of each key, parallel to the value registers.
			keyStringIndices: Array<number>;
	  }
	| {
			type: "createArray";
			/** COMPILE-ONLY: a pristine empty Array is immediately followed by an
			 * exact canonical `[0, length)` indexed fill. Native code may reserve the
			 * final dense capacity before executing the otherwise-unchanged loop. */
			freshDenseReserveLength?: number;
			// [destination]
			registers: [number];

			length: number;
	  }
	| {
			type: "instantiateLiteralTemplate";

			// [destination]
			registers: [number];

			// Offset into the program's literal-template pool.
			templateOffset: number;
	  }
	| {
			// Build an `import * as ns` module namespace exotic object. Each export
			// names a string constant and the global slot holding its live value.
			type: "createModuleNamespace";

			// [destination]
			registers: [number];

			exports: Array<{ nameStringIndex: number; slot: number }>;
	  }
	| {
			// Build (and cache, per call site) a tagged-template strings object: a
			// frozen array of the cooked strings with a frozen `.raw` array of the
			// raw strings. `cacheSlot` is a dedicated global slot the runtime fills
			// on first evaluation so the object identity is stable across calls. A
			// cooked index of -1 means the cooked value is `undefined` (an invalid
			// escape sequence, legal only in a tagged template).
			type: "createTemplateObject";

			// [destination]
			registers: [number];

			cacheSlot: number;
			cookedIndices: Array<number>;
			rawIndices: Array<number>;
	  }
	| {
			type: "createUndefined";

			// [destination]
			registers: [number];
	  }
	| {
			// The uninitialized ("empty") sentinel for a binding in its temporal
			// dead zone. Stored into let/const/class binding slots before the
			// declaration runs; reading one (via throwIfTdz) throws ReferenceError.
			type: "createEmpty";

			// [destination]
			registers: [number];
	  }
	| {
			type: "createNull";

			// [destination]
			registers: [number];
	  }
	| {
			type: "createFunction";

			// [destination]
			registers: [number];

			functionIndex: number;
	  }
	| {
			type: "createArgumentsObject";

			// [destination]
			registers: [number];
	  }
	| {
			// Direct non-escaping `arguments.length` from frame metadata.
			type: "loadArgumentCount";
			registers: [number];
	  }
	| {
			// Direct non-escaping `arguments[index]` from the retained argument slice.
			type: "loadArgument";
			registers: [number];
			index: number;
	  }
	| {
			// Direct static index read. Supplied indexes use the optional live mapped
			// value; missing indexes lazily materialize and cache the arguments object.
			type: "loadStaticArgument";
			// [destination, updated fallback cache, mapped value or -1,
			// previous fallback cache]. The duplicated cache operand makes its
			// read/write contract explicit to Core dataflow and allocation.
			registers: [number, number, number, number];
			index: number;
	  }
	| {
			type: "loadThis";

			// [destination]
			registers: [number];
	  }
	| {
			// Speculative-call-inlining guard (produced by the inliner, not the front end):
			// dst := callee is a function object with `functionIndex`. Feeds a jumpIf that
			// picks the inlined body vs the deopt call.
			type: "guardFunctionIndex";
			// [destination (boolean), callee]
			registers: [number, number];
			functionIndex: number;
	  }
	| {
			// Pure exact-shape selector shared by a bounded cluster of static loads.
			// Returns the matching candidate index or -1 for the generic path.
			type: "selectShapeCase";
			// [destination (i32), object]
			registers: [number, number];
			shapeCaseCandidates: ReadonlyArray<CompilerShapeCaseCandidate>;
	  }
	| {
			// Per-iteration loop environment (CreatePerIterationEnvironment). envPush
			// enters a loop scope (fresh env, parent = current); envCopy replaces the
			// current scope env with a sibling that copies the bindings forward; envPop
			// restores the enclosing env. scopeId is a synthetic negative capture-scope
			// id; slotCount = number of captured loop-head bindings.
			type: "envPush" | "envCopy";
			scopeId: number;
			slotCount: number;
	  }
	| {
			type: "envPop";
	  }
	| {
			type: "call";

			// [destination, callee, this, ...arguments]
			registers: [number, number, number, ...Array<number>];
			/**
			 * Canonical fact-system call target. Consumers must validate the identity
			 * proof and preserve its fallback obligation before specializing the call.
			 */
			knownBuiltinCall?: KnownBuiltinCall;
			/**
			 * COMPILE-ONLY: the receiver has this immutable collection brand on every
			 * reaching path. Native lowering may omit receiver/weak-kind guards while
			 * retaining the loaded-callee identity fallback.
			 */
			exactCollectionReceiver?: CompilerExactCollectionBrand;
			/**
			 * COMPILE-ONLY: the exact ordinary script-function index held by the callee.
			 * Closed callee-target analysis has ruled out every mismatch, so native
			 * lowering enters this target without an identity guard or dispatch fallback.
			 */
			directFunctionIndex?: number;
			/** Native-only ABI sibling selected for this exact direct target. */
			directEntryId?: number;
			/**
			 * COMPILE-ONLY: this is an exact `target.call(thisArg, ...args)` property-call
			 * shape. Native lowering guards the loaded method against the retained
			 * %Function.prototype.call% before calling `target` with shifted arguments.
			 */
			directFunctionCall?: true;
			/** Exact ordinary script target used by directFunctionCall, when known. */
			directCallTargetFunctionIndex?: number;
			/**
			 * COMPILE-ONLY: exact ordinary script target of the callback argument for a
			 * statically identified callback-driving builtin. Native lowering may carry
			 * this proof into the builtin's repeated callback seam without a guard.
			 */
			directCallbackFunctionIndex?: number;
			/**
			 * COMPILE-ONLY: the Number position is statically known to be an exact
			 * non-negative integer and, for `inBounds`, below this primitive String
			 * receiver's length on every path reaching the call.
			 */
			directStringCharCodeAtPosition?: "inBounds";
			/** COMPILE-ONLY: values embedded in place of the parallel register operands. */
			immediateValues?: Array<CompilerImmediateValue | undefined>;
	  }
	| {
			/**
			 * A locked canonical unary Math call after its identity, exact arity, and
			 * Number representation obligations have all been discharged. The ordinary
			 * namespace/property/call twin has been removed; this operation cannot invoke
			 * user code or coerce its operand.
			 */
			type: "mathUnaryNumber";
			// [destination, operand]
			registers: [number, number];
			operation: string;
	  }
	| {
			/** Locked two-Number Math.min/Math.max with no remaining fallback edge. */
			type: "mathBinaryNumber";
			// [destination, left, right]
			registers: [number, number, number];
			operation: string;
	  }
	| {
			/**
			 * Exact locked builtin invocation after property resolution and callback
			 * identity have both been proved. Argument evaluation remains explicit;
			 * this operation may still allocate, call user code, or throw according to its
			 * registry effects, but it has no dynamic property/call fallback edge.
			 */
			type: "callBuiltin";
			// [destination, this, ...arguments]
			registers: [number, number, ...Array<number>];
			operation: DirectBuiltinOperationId;
			/** Canonical facts remain attached after dynamic dispatch is erased. */
			knownBuiltinCall: KnownBuiltinCall;
	  }
	| {
			type: "construct";

			// [destination, callee, ...arguments]
			registers: [number, number, ...Array<number>];
			/**
			 * COMPILE-ONLY: the exact ordinary script-constructor index held by the
			 * callee. Native lowering guards the live callee before direct construction
			 * and falls back to generic [[Construct]] dispatch on a mismatch.
			 */
			directFunctionIndex?: number;
			/** COMPILE-ONLY: values embedded in place of the parallel register operands. */
			immediateValues?: Array<CompilerImmediateValue | undefined>;
	  }
	| {
			type: "throw";

			// [value]
			registers: [number];
	  }
	| {
			type: "catch";

			// [destination]
			registers: [number];
	  }
	| {
			// Marks the start of a protected instruction range. Lowering turns the
			// marker positions into the static exception handler table.
			type: "tryBegin";

			// [handlerBlock, tryEndBlock]
			// The tryEnd block is referenced here so the optimizer cannot drop
			// it when the try body terminates early (return / throw).
			blocks: [number, number];
	  }
	| {
			// Marks the end of a protected instruction range.
			type: "tryEnd";
	  }
	| {
			type: "loadIntrinsic";

			// [destination]
			registers: [number];

			intrinsic: CompilerIntrinsic;
	  }
	| {
			type: `load${"Local" | "Captured" | "Global"}`;

			// [destination]
			registers: [number];

			functionIndex?: number;
			index: number;
	  }
	| {
			// [destination]; the active frame's new.target (undefined for a
			// plain call, the constructor for a `new`/construct activation).
			type: "loadNewTarget";

			registers: [number];
	  }
	| {
			// [destination]; the function object that pushed the active frame. Used
			// to initialize a named function expression's own-name binding to the
			// closure at entry (the interpreter reads frame->callee, compiled reads
			// its callee parameter).
			type: "loadCallee";

			registers: [number];
	  }
	| {
			type: `store${"Local" | "Captured" | "Global"}`;

			// [source]
			registers: [number];

			functionIndex?: number;
			index: number;
	  }
	| {
			type: "loadProperty";

			// [destination, object, key]
			registers: [number, number, number];
			/** COMPILE-ONLY: the receiver is an exact private dense Array and the key
			 * is already a primitive Number. Native code may return its element or
			 * undefined directly, with no brand, prototype, IC, or fallback edge. */
			exactContainedArrayElement?: true;
			/** COMPILE-ONLY: closed ownership proves this exact fixed-buffer numeric
			 * TypedArray brand. Native code may skip receiver branding, the property
			 * cache, prototype lookup, and the generic element-kind dispatch. */
			exactTypedArrayKind?: CompilerNumericTypedArrayKind;
	  }
	| {
			type: "loadPropertyStatic";

			// [destination, object]
			registers: [number, number];
			stringIndex: number;
			knownOwnSlot?: CompilerKnownOwnSlot;
			/** COMPILE-ONLY: Core proved this receiver remains a contained ordinary
			 * shaped allocation and this key is its writable data slot. Native code
			 * may address the slot exactly, without a shape guard, IC, or fallback. */
			exactOwnSlot?: number;
			/** COMPILE-ONLY: Core proved this is the non-configurable Number length
			 * cell of a fresh ordinary Array. Native code may read it unboxed. */
			exactArrayLength?: true;
			/** COMPILE-ONLY: this loop-bound `length` load has a matched guarded
			 * primitive-String consumer, so native code may try the String brand first. */
			primitiveStringLength?: true;
	  }
	| {
			// A preceding selectShapeCase licenses slots[case] on the exact live
			// receiver shape. Case -1 executes the ordinary static-property IC.
			type: "loadPropertyStaticShapeCase";
			// [destination, object, shape case]
			registers: [number, number, number];
			stringIndex: number;
			shapeCaseSlots: ReadonlyArray<number>;
	  }
	| {
			type: "loadSuperProperty";

			// [destination, base, key, receiver] — lookup starts at base while
			// accessors are invoked with receiver (the super reference's thisValue).
			registers: [number, number, number, number];
	  }
	| {
			type: "storeProperty";

			// [object, key, value]
			registers: [number, number, number];
	  }
	| {
			type: "storePropertyStatic";

			// [object, value]
			registers: [number, number];
			stringIndex: number;
			knownOwnSlot?: CompilerKnownOwnSlot;
			/** COMPILE-ONLY counterpart of the exact contained-slot load fact. */
			exactOwnSlot?: number;
	  }
	| {
			type: "toPropertyKey";

			// [destination, object, key] — object-coercibility-check the base (a nil
			// base throws first) then ToPropertyKey(key) once, so a read-modify-write
			// member access converts a computed key a single time in the right order.
			registers: [number, number, number];
	  }
	| {
			type: "storeSuperProperty";

			// [object, key, value, receiver] — the lookup walks object (the
			// super base) while the write applies to receiver (this).
			registers: [number, number, number, number];
	  }
	| {
			type: "loadPrototype";

			// [destination, object] — the object's [[Prototype]], null for
			// non-objects and end-of-chain.
			registers: [number, number];
	  }
	| {
			type: "getIterator";

			// [iterator_dst, next_dst, source] — spec GetIterator; the
			// iterator object and its cached next method (the IteratorRecord).
			registers: [number, number, number];
	  }
	| {
			type: "getAsyncIterator";

			// [iterator_dst, next_dst, source] — GetIterator(source, async):
			// @@asyncIterator, or the sync iterator wrapped. For for-await-of.
			registers: [number, number, number];
	  }
	| {
			type: "iteratorNext";

			// [result_dst, iterator, next] — call next() and leave the raw
			// result (a promise for async iteration) to be awaited.
			registers: [number, number, number];
	  }
	| {
			type: "iteratorStep";

			// [value_dst, done_dst, iterator, next] — spec IteratorStep; the
			// step value and a done boolean.
			registers: [number, number, number, number];
	  }
	| {
			type: "iteratorClose";

			// [iterator] — spec IteratorClose. `normal` selects the
			// normal-completion variant (propagates return()'s throw, TypeError on a
			// non-object result), used after a destructuring pattern finishes without
			// exhausting the iterator. The default (omitted/false) is the
			// abrupt-completion variant for break/return/throw loop exits.
			registers: [number];
			normal?: boolean;
	  }
	| {
			type: "forInKeys";

			// [destination, source] — collect the enumerable string keys of
			// source into a fresh array the for-in loop then iterates.
			registers: [number, number];
	  }
	| {
			// Generator prologue: suspend the activation and return a generator
			// object to the caller. No operands; uses the frame's return target.
			type: "generatorStart";
	  }
	| {
			// Async-function prologue: create the result promise + hidden state,
			// hand the promise to the caller, then keep running the body. No
			// operands.
			type: "asyncStart";
	  }
	| {
			type: "yield";
			/**
			 * COMPILE-ONLY: resumption can only perform the standard completed-generator
			 * next/return/throw behavior, so the runtime may release the activation now.
			 */
			terminal?: true;

			// [valueDst, modeDst, yieldedSrc] — yieldedSrc is handed out; on
			// resume the sent value lands in valueDst and the resume mode code in
			// modeDst.
			registers: [number, number, number];
	  }
	| {
			type: "await";

			// [valueDst, modeDst, awaitedSrc] — awaitedSrc is awaited; on resume
			// the settled value lands in valueDst and the resume mode code in
			// modeDst (same layout as yield, so the resume dispatch is shared).
			registers: [number, number, number];
	  }
	| {
			type: "callSpread";

			// [destination, callee, this, arguments_array]
			registers: [number, number, number, number];
	  }
	| {
			type: "callSpreadIterable";

			// [destination, callee, this, iterable] — used when the entire
			// argument list is one spread element.
			registers: [number, number, number, number];
	  }
	| {
			type: "constructSpread";

			// [destination, callee, arguments_array]
			registers: [number, number, number];
	  }
	| {
			type: "constructSuper";

			// [destination, parent, arguments_array]
			registers: [number, number, number];
	  }
	| {
			type: "constructSuperExplicit";

			// [destination, parent, arguments_array, new_target, current_this]. The
			// final operand aliases destination: the packed VM op is two-address, while
			// the duplicate keeps its read-before-write dependency explicit.
			registers: [number, number, number, number, number];
	  }
	| {
			type: "setThis";

			// [value] — synchronize the current activation's this binding.
			registers: [number];
	  }
	| {
			type: "mergeDataProperties";

			// [target, source] — object spread {...source} into target.
			registers: [number, number];
	  }
	| {
			type: "deleteProperty";

			// [destination, object, key]
			registers: [number, number, number];
	  }
	| {
			type: "defineAccessor";

			// [object, key, accessor]
			registers: [number, number, number];

			kind: "get" | "set";

			// Object literal accessors are enumerable, class accessors not.
			enumerable: boolean;
	  }
	| {
			type: "defineProperty";

			// [object, key, value]; defines an own data property. Ordinary
			// object/class members use the writable/configurable defaults; class
			// constructor prototype wiring overrides both to false.
			registers: [number, number, number];

			enumerable: boolean;
			writable?: boolean;
			configurable?: boolean;
	  }
	| {
			// SetFunctionName([func], [key]): set an anonymous function/class value's
			// `name` own property from a *computed* property key (spec
			// NamedEvaluation / PropertyDefinitionEvaluation) — a string key names it
			// directly, a symbol key names it `[description]` (or "" if the symbol has
			// none). Emitted for a computed-key literal member whose value is an
			// anonymous function definition (static keys use the compile-time nameHint).
			type: "setFunctionName";

			// A getter/setter prefixes the computed name with "get "/"set "
			// (SetFunctionName's prefix argument). Undefined for plain members.
			namePrefix?: "get" | "set";

			// [func, key] — both uses (no destination).
			registers: [number, number];
	  }
	| {
			// [destination]; mints a fresh hidden symbol that keys a private
			// class member for this class evaluation.
			type: "createPrivateName";

			registers: [number];
	  }
	| {
			// Mint fresh hidden symbols directly into captured slots. The slots are
			// parallel to capturedIndices and all belong to functionIndex.
			type: "createPrivateNames";
			functionIndex: number;
			capturedIndices: Array<number>;
	  }
	| {
			// [object, key, value]; installs a private member (field or brand
			// marker) keyed by the private symbol in key. Throws if already
			// present.
			type: "definePrivate";

			registers: [number, number, number];
	  }
	| {
			// [object, ...keys]; install undefined-valued private instance fields
			// in source order, stopping on the first duplicate stamp.
			type: "initPrivateFields";

			registers: [number, ...Array<number>];
	  }
	| {
			// [destination, object, key]; own-only read keyed by a private
			// symbol. Throws TypeError when the receiver lacks the member.
			type: "loadPrivate";

			registers: [number, number, number];
	  }
	| {
			// [object, key, value]; own-only write keyed by a private symbol.
			// Throws TypeError when the receiver lacks the member.
			type: "storePrivate";

			registers: [number, number, number];
	  }
	| {
			// [destination, object, key]; the `#x in o` brand check. Yields a
			// boolean; throws TypeError when the receiver is not an object.
			type: "hasPrivate";

			registers: [number, number, number];
	  }
	| {
			type: "setPrototype";

			// [object, prototype]
			registers: [number, number];

			// Object literal `__proto__:` definitions ignore values that are
			// neither object nor null; class extends wiring always applies.
			literal: boolean;
	  }
	| {
			type: "loadUndeclared";

			// [destination]; never written, the instruction always throws a
			// ReferenceError naming the unresolvable identifier.
			registers: [number];

			nameStringIndex: number;
	  }
	| {
			// Runtime resolution of a statically undeclared name: the global object
			// property, or ReferenceError if absent. This applies in both modes.
			type: "loadGlobalProperty";
			registers: [number];
			nameStringIndex: number;
	  }
	| {
			// Write [src] to a global object property (created if absent): a
			// script top-level `var`/`function` binding store. A declaration-only
			// write creates a missing non-configurable var property but preserves an
			// existing property's value and descriptor.
			type: "storeGlobalProperty";
			registers: [number];
			nameStringIndex: number;
			declaration?: boolean;
			declarationConfigurable?: boolean;
	  }
	| {
			// Declaration-initialize a contiguous run of script `var` global
			// properties to undefined. Global declaration checks and Annex B's
			// EMPTY-valued stores remain scalar storeGlobalProperty instructions.
			type: "initGlobalVars";
			nameStringIndices: Array<number>;
			declarationConfigurable: boolean;
	  }
	| {
			// Throw ReferenceError if [source] holds the uninitialized sentinel:
			// the named let/const/class binding is still in its temporal dead zone.
			type: "throwIfTdz";

			// [source]
			registers: [number];

			nameStringIndex: number;
	  }
	| {
			// `with (obj)` entry: ToObject([object]) and push it onto the frame's
			// with-object stack (throws if [object] is null/undefined).
			type: "withEnter";

			// [object]
			registers: [number];
	  }
	| {
			// Pop the innermost with-object off the frame's stack. Emitted on every
			// edge that leaves the with body (normal, break, continue, return).
			type: "withExit";
			registers: [];
	  }
	| {
			// Dynamic `with`-scope read: [destination] gets the value if the named
			// binding is provided by some active with-object (HasProperty honoring
			// `Symbol.unscopables`, innermost first), else the EMPTY sentinel so the
			// compiler can fall back to the static binding.
			type: "withGet";

			// [destination]
			registers: [number];

			nameStringIndex: number;
	  }
	| {
			// Dynamic `with`-scope reference base: [destination] gets the with-object
			// that provides the named binding (HasProperty honoring `Symbol.unscopables`,
			// innermost first), else the EMPTY sentinel. Unlike withGet this returns the
			// *object* (not its value) so an assignment can capture the reference base
			// BEFORE evaluating the right-hand side — PutValue uses the initially-created
			// Reference (spec 11.13.1 / with S12.10). The compiler then reads/stores the
			// property on that captured base, or falls back to the static binding on EMPTY.
			type: "withResolveBase";

			// [destination]
			registers: [number];

			nameStringIndex: number;
	  }
	| {
			// Dynamic `with`-scope write: if some active with-object provides the
			// named binding, set it there and write `true` to [found]; otherwise
			// write `false` so the compiler falls back to the static store. [value]
			// holds the value to assign.
			type: "withSet";

			// [found, value]
			registers: [number, number];

			nameStringIndex: number;
	  }
	| {
			// [destination] = ([source] is the EMPTY sentinel). Lets the compiler
			// branch on a withGet miss.
			type: "isEmpty";

			// [destination, source]
			registers: [number, number];
	  }
	| {
			// RequireObjectCoercible: throws a TypeError when the value is null
			// or undefined. Emitted at the start of destructuring patterns so
			// nil sources throw even when the pattern reads no properties.
			type: "requireCoercible";

			// [value]
			registers: [number];
	  }
	| {
			// ClassDefinitionEvaluation heritage check: throws a TypeError unless
			// the superclass is a constructor whose `prototype` is an object or
			// null. Emitted before a class uses its (non-null) superclass.
			type: "checkSuperClass";

			// [parent]
			registers: [number];
	  }
	| {
			// Collect the frame arguments from startIndex onward into a fresh
			// array, for rest parameters.
			type: "createRestArguments";

			// [destination]
			registers: [number];

			startIndex: number;
	  }
	| {
			// Collect the elements of an array-like source from startIndex
			// onward into a fresh array, for array pattern rest elements.
			// Approximates the spec's iterator protocol with index reads.
			type: "arrayRest";

			// [destination, source]
			registers: [number, number];

			startIndex: number;
	  }
	| {
			// CopyDataProperties: copy the source's own enumerable properties
			// into a fresh object, skipping the excluded keys. Used for object
			// pattern rest elements.
			type: "copyDataProperties";

			// [destination, source, ...excludedKeys]
			registers: [number, number, ...Array<number>];
	  }
	| {
			type: "binary";

			// [destination, left, right]
			registers: [number, number, number];

			/** Verified semantic kind sets for exact native lowering. */
			exactInputKindMasks?: readonly [CompilerValueKindMask, CompilerValueKindMask];

			operator:
				| "+"
				| "-"
				| "*"
				| "/"
				| "%"
				| "**"
				| "&"
				| "|"
				| "^"
				| "<<"
				| ">>"
				| ">>>"
				| "<"
				| "<="
				| ">"
				| ">="
				| "=="
				| "!="
				| "==="
				| "!=="
				| "in"
				| "instanceof";
	  }
	| {
			type: "unary";

			// [destination, operand]
			registers: [number, number];

			operator:
				| "!"
				| "-"
				| "+"
				| "~"
				| "typeof"
				| "tonumeric"
				| "increment"
				| "decrement";
	  }
	| {
			// Non-allocating comparison against one of the canonical typeof results.
			type: "typeofCompare";

			// [destination, operand]
			registers: [number, number];

			expected: CompilerTypeofResult;
			negated: boolean;
	  };

/**
 * Packed VM operations that read and write one register. The operation reads only
 * the `result` position at run time, so target lowering must make `operand` name
 * the same register and the target verifier proves that it did; the duplicated
 * operand exists to keep the read-before-write dependency explicit to Core.
 */
export const COMPILER_TWO_ADDRESS_OPERANDS: Readonly<
	Partial<
		Record<
			CompilerInstruction["type"],
			{
				readonly result: number;
				readonly operand: number;
				readonly requirement: string;
			}
		>
	>
> = {
	constructSuperExplicit: {
		result: 0,
		operand: 4,
		requirement: "one register for its current-this operand and its result",
	},
	loadStaticArgument: {
		result: 1,
		operand: 3,
		requirement: "one register for both of its fallback-cache operands",
	},
};

export type CompilerBinaryOperator = Extract<
	CompilerInstruction,
	{ type: "binary" }
>["operator"];
export type CompilerIntrinsic =
	| "Object"
	| "Array"
	| "Function"
	| "Error"
	| "TypeError"
	| "RangeError"
	| "ReferenceError"
	| "SyntaxError"
	| "URIError"
	| "EvalError"
	| "AggregateError"
	| "String"
	| "Number"
	| "Boolean"
	| "Symbol"
	| "BigInt"
	| "ArrayBuffer"
	| "SharedArrayBuffer"
	| "Int8Array"
	| "Uint8Array"
	| "Uint8ClampedArray"
	| "Int16Array"
	| "Uint16Array"
	| "Int32Array"
	| "Uint32Array"
	| "Float32Array"
	| "Float64Array"
	| "BigInt64Array"
	| "BigUint64Array"
	| "DataView"
	| "Map"
	| "Set"
	| "WeakMap"
	| "WeakSet"
	| "WeakRef"
	| "FinalizationRegistry"
	| "Promise"
	| "Date"
	| "RegExp"
	| "Intl"
	| "Iterator"
	| "AsyncIterator"
	| "parseInt"
	| "parseFloat"
	| "isNaN"
	| "isFinite"
	| "decodeURI"
	| "decodeURIComponent"
	| "encodeURI"
	| "encodeURIComponent"
	| "Math"
	| "JSON"
	| "Atomics"
	| "Reflect"
	| "Proxy"
	| "console"
	| "globalThis"
	| "eval"
	| "NaN"
	| "Infinity"
	// The CommonJS require native. Not a user-visible global: the compiler emits
	// it for the synthetic CJS entry and for resolved `require("specifier")` calls.
	| "__cjs_require"
	// Internal helper for guarded array-iteration inlining (the inliner emits
	// LOAD_INTRINSIC + call to test a receiver before the inlined loop). Not a
	// user-visible global.
	| "__arrayIterationEligible"
	// Internal flatMap append helper for guarded inlining: flattens a mapped value
	// one level into the result array being built. Not a user-visible global.
	| "__arrayFlatMapAppend"
	// The direct-eval intrinsic (builtin_eval.c). Emitted as the callee of a
	// direct `eval(...)` call; receives the source + a marshaled scope object.
	// Not a user-visible global.
	| "__directEval"
	// HostImportModuleDynamically entry point. Not a user-visible global; emitted
	// for the syntactic ImportCall form `import(specifier)`.
	| "__dynamicImport";
