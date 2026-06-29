import type { ESTree } from "meriyah";
import { isPureDataCjsModule } from "./cjs-exports.ts";
import { linkModules } from "./linker.ts";
import { COMMONJS_BINDINGS } from "./semantic-analysis.ts";
import type { Binding, SemanticFile, SemanticProgram } from "./semantic-analysis.ts";
import { log } from "./utils.ts";

export interface IntermediateProgram {
	/**
	 * The semantic program that we are compiling.
	 */
	semantic: SemanticProgram;

	/**
	 * The functions that we have compiled.
	 *
	 * The first function in this list is the initial entrypoint.
	 */
	functions: Array<IRFunction>;
	stringConstants: Array<Array<number>>;
	stringConstantToIndex: Map<string, number>;

	/**
	 * Interned source positions for debug info / stack traces. Each entry is a
	 * (line, column) pair (1-based line, 0-based column, as Meriyah reports). The
	 * index is the `pos` carried by `sourcePos` markers. The file is resolved
	 * per-function (a function body lives in one file), so only line/column are
	 * interned here and shared across every function.
	 */
	/**
	 * A leaf entry has just line/column. An *inline* entry (added by the inliner)
	 * additionally carries `inlinedFunctionIndex` (the function whose body this
	 * position is in) and `callerPosId` (the position one level out, where it was
	 * inlined) — a chain the trace formatter expands into one frame per inline
	 * level, so inlined code still shows its own frame.
	 */
	sourcePositions: Array<{
		line: number;
		column: number;
		inlinedFunctionIndex?: number;
		callerPosId?: number;
	}>;
	sourcePositionToIndex: Map<string, number>;

	/**
	 * Immortal bigint constant pool, deduplicated by value. Each entry is baked
	 * into the program image as a static MalBigInt with its value emitted at
	 * compile time, so CREATE_BIGINT never parses or allocates at runtime.
	 */
	bigintConstants: Array<bigint>;
	bigintConstantToIndex: Map<bigint, number>;

	/**
	 * For a `const f = <function/arrow>` declaration, maps f's binding to the
	 * function node it is initialized with. Used to recognize a self-recursive
	 * tail call reached through that binding — the binding's declarationNode is
	 * the Identifier, not the function, so it carries no such link itself.
	 * Populated before the initializer compiles, so the link is visible while
	 * compiling the function's own body.
	 */
	bindingFunctionNode: Map<Binding, ESTree.Node>;

	//////
	// Various caches to prevent duplicate compilation or to look things up.
	//
	// We do things lazily, so only compile things that we has been deemed reachable by static
	// analysis.
	//
	//////

	/**
	 * Compile each module init file only once.
	 */
	compiledModuleInitForPaths: Set<string>;

	/**
	 * Keep track of where the binding is stored.
	 *
	 * A binding can be:
	 *
	 * - local: non-captured variables. We can optimize this out later to keep them in the
	 *   registers, I think.
	 * - captured: captured variables.
	 * - global: top-level declared variables.
	 */
	bindingToStorage: Map<Binding, BindingLocation>;

	/**
	 * Keep track of which functions we compiled already.
	 */
	bindingToFunctionCache: Map<
		Binding,
		{
			fnIndex: number;
		}
	>;
	nodeToFunctionCache: Map<ESTree.Node, { fnIndex: number }>;

	/**
	 * Next available global variable index
	 */
	nextGlobalIndex: number;

	/**
	 * Next synthetic per-iteration loop-scope env id. Negative so it never collides
	 * with a function index (env capture resolution matches on this id); decremented
	 * per capturing loop. See compileForStatement / setupPerIterationScope.
	 */
	nextLoopScopeId: number;

	/**
	 * ES module linkage. Synthetic bindings holding each module's anonymous
	 * `export default` value, keyed by module path (see src/linker.ts).
	 */
	moduleDefaultBinding: Map<string, Binding>;

	/**
	 * `import * as ns` namespace objects to build per importing module path (see
	 * src/linker.ts): the local binding plus the exported names and the exporter
	 * binding each property reads live.
	 */
	namespaceImports: Map<
		string,
		Array<{ binding: Binding; exports: Array<{ name: string; exporter: Binding }> }>
	>;

	/**
	 * CommonJS modules, keyed by path to their integer module id. The id indexes
	 * the runtime registry; `require("specifier")` is lowered to `__cjs_require(id)`
	 * of the resolved module. Empty for programs with no CommonJS.
	 */
	cjsModuleId: Map<string, number>;

	/**
	 * id -> wrapper function index, filled as each CommonJS module's wrapper
	 * compiles. Emitted as the definition's CJS module table.
	 */
	cjsWrapperFunctionIndex: Array<number>;

	/**
	 * ESM → CJS interop: per importing module path, the local bindings to
	 * initialize from `require(cjsPath)` (see src/linker.ts).
	 */
	cjsImports: Map<
		string,
		Array<{
			binding: Binding;
			cjsPath: string;
			kind: "default" | "named" | "namespace";
			name?: string;
			names?: Array<string>;
		}>
	>;

	/**
	 * Pure-data CommonJS modules (no observable side effects): cjs path -> a
	 * global slot holding their `module.exports`, built once at program start.
	 * `require()` of these resolves to a direct slot read instead of a runtime
	 * call. See isPureDataCjsModule.
	 */
	cjsEagerSlot: Map<string, number>;
}

type BindingLocation =
	| {
			type: "local" | "global";
			index: number;
	  }
	| {
			type: "captured";
			functionIndex: number;
			index: number;
	  }
	| {
			// A sloppy-script top-level `var`/`function`: a property of the global
			// object (read/written by name), so it is observable as `globalThis.x`.
			// Strict scripts and modules keep the fast flat-slot `global` storage.
			type: "globalProperty";
			nameStringIndex: number;
	  };

/**
 * Class body context carried by constructor and method functions so super
 * references can reach the parent class through its captured binding.
 */
/**
 * A single private member's resolution, shared by every function of the class
 * through the class context. Exactly one of field/method/get/set is populated:
 * a field carries its own-property key symbol, a method carries the shared
 * function value, an accessor carries its get/set functions. brandBinding is
 * the brand marker of the *declaring* class, so access from a nested class
 * brand-checks against the right class.
 */
interface IRPrivateName {
	static: boolean;
	brandBinding: Binding;
	fieldBinding?: Binding;
	methodBinding?: Binding;
	getBinding?: Binding;
	setBinding?: Binding;
}

/**
 * One entry of a constructor's InitializeInstanceElements sequence, in source
 * order. Private fields install through their hidden symbol; public fields
 * install as ordinary own data properties. Computed public keys are evaluated
 * once at class definition and captured.
 */
type IRInstanceFieldKey =
	// Non-computed public key, the own-property name.
	| { kind: "name"; name: string }
	// Instance computed key, evaluated once at class definition and captured.
	| { kind: "captured"; binding: Binding }
	// Static computed key, evaluated inline in the once-run static initializer.
	| { kind: "node"; node: ESTree.Expression };

type IRInstanceFieldPlanEntry =
	| {
			private: true;
			fieldBinding: Binding;
			valueNode: ESTree.Expression | null;
			nameHint: string;
	  }
	| { private: false; key: IRInstanceFieldKey; valueNode: ESTree.Expression | null };

/**
 * A static class element in source order, run once by the static initializer
 * with this = the constructor: a static field install or a static block body.
 */
type IRStaticElement =
	| { kind: "field"; entry: IRInstanceFieldPlanEntry }
	| { kind: "block"; body: Array<ESTree.Statement> };

interface IRClassContext {
	superBinding?: Binding;

	/**
	 * The class constructor itself, for heritage-less classes: super
	 * references resolve dynamically through the home object's prototype
	 * chain so setPrototypeOf mutations are observed.
	 */
	classBinding?: Binding;

	isStatic: boolean;

	/**
	 * The private environment, shared by the constructor and every method:
	 * the per-class-evaluation symbols and brand markers are captured so any
	 * `#x` reference resolves lexically with no dynamic lookup.
	 */
	privateNames?: Map<string, IRPrivateName>;
	instanceBrandBinding?: Binding;
	staticBrandBinding?: Binding;

	/**
	 * Constructor-only: drives where InitializeInstanceElements is woven in.
	 * Base constructors install at the body prologue; derived constructors
	 * install right after super() returns.
	 */
	isConstructor?: boolean;
	isDerivedConstructor?: boolean;
	instanceFieldPlan?: Array<IRInstanceFieldPlanEntry>;
}

export interface IRFunction {
	semanticFile: SemanticFile;
	functionIndex: number;

	/**
	 * String constant index of the function name, empty string for anonymous
	 * functions.
	 */
	nameStringIndex: number;

	blocks: Array<IRBlock>;
	argumentsObjectRegister?: number;
	classContext?: IRClassContext;

	/**
	 * Whether this function runs in strict mode — its own body scope's strictness
	 * (a `"use strict"` directive, or inheritance from strict surrounding code),
	 * NOT the whole file's. A sloppy file can still contain strict functions and
	 * vice versa. Undefined falls back to the file's strictness (correct for the
	 * top-level entry, whose scope strictness equals the file's).
	 */
	strict?: boolean;

	/**
	 * Self-recursive tail-call elimination. When the function is eligible (see
	 * prepareTailCallLoop), `return f(args)` to itself is rewritten into "assign
	 * params, JUMP to bodyEntryBlock" — turning tail recursion into a loop with
	 * constant stack. tailCallNode is the source function (for its parameter
	 * list); bodyEntryBlock is the loop header (the first body block).
	 */
	tcoEligible?: boolean;
	bodyEntryBlock?: number;
	tailCallNode?:
		| ESTree.FunctionDeclaration
		| ESTree.FunctionExpression
		| ESTree.ArrowFunctionExpression;

	/**
	 * Generator functions get a GENERATOR_START prologue instruction (after the
	 * parameter prologue) and may contain yield expressions.
	 */
	isGenerator?: boolean;

	/**
	 * Async functions get an ASYNC_START prologue instruction (after the
	 * parameter prologue) and may contain await expressions, which suspend the
	 * activation on a promise and resume via the same machinery as yield.
	 */
	isAsync?: boolean;

	/**
	 * Expected number of initial register values. Before evaluating the arguments and assigning
	 * them to (destructured) arguments.
	 */
	parameterCount: number;

	/**
	 * The Function.prototype.length value: formal parameters before the first
	 * default or rest parameter. Differs from parameterCount, which keeps the
	 * full formal count for the calling convention.
	 */
	length: number;

	/**
	 * The next available register index (unoptimized).
	 */
	nextRegisterDestination: number;

	/**
	 * Next available local variable index
	 */
	nextLocalIndex: number;

	/**
	 * Next available captured variable index
	 */
	nextCapturedIndex: number;

	/**
	 * Stack of enclosing loops, used to patch break and continue jumps once
	 * the loop exit and continue targets exist.
	 */
	loops?: Array<IRLoopContext>;

	/**
	 * Labels collected by a LabeledStatement, consumed by the immediately
	 * following loop/switch when it creates its context so labeled break and
	 * continue can target it.
	 */
	pendingLabels?: Array<string>;
}

interface IRLoopContext {
	/**
	 * break targets the innermost breakable (loop/switch) or, when labeled, the
	 * matching labeled scope; continue the innermost / matching loop. "label"
	 * marks a labeled non-loop statement, a break-only target. "finally" entries
	 * carry no target but sit on the same stack so abrupt completions route
	 * through enclosing finalizers in lexical order. "with" entries likewise carry
	 * no target; they pop the active with-object as control leaves the body.
	 */
	kind: "loop" | "switch" | "finally" | "label" | "with";
	breakJumps: Array<Extract<IRInstruction, { type: "jump" }>>;
	continueJumps: Array<Extract<IRInstruction, { type: "jump" }>>;

	/**
	 * Labels attached to this scope (a single statement may carry several).
	 */
	labels?: Set<string>;

	/**
	 * for-of loops carry their iterator register so break and return can
	 * emit the spec IteratorClose before leaving the loop.
	 */
	iteratorRegister?: number;

	/**
	 * For a loop whose lexical head bindings are captured by a closure: the
	 * synthetic per-iteration env scope id and slot count (CreatePerIterationEnv).
	 * The loop's own exit block emits ENV_POP for its normal exit + direct breaks;
	 * a break/continue that CROSSES this loop to an outer target emits ENV_POP here.
	 * undefined when the loop needs no per-iteration env.
	 */
	perIterationScopeId?: number;
	perIterationSlotCount?: number;

	/**
	 * For kind === "finally": jumps from each exit edge into the finalizer
	 * entry block (patched once it exists), plus the registers carrying the
	 * pending completion kind and value across the finalizer.
	 */
	finallyEntryJumps?: Array<Extract<IRInstruction, { type: "jump" }>>;
	completionKindReg?: number;
	completionValueReg?: number;

	/**
	 * For kind === "finally": the abrupt-completion dispatch arms that actually
	 * route through this finalizer. Keyed by routing identity (e.g. "return",
	 * "break", "continue:outer") so each distinct target gets one arm; each
	 * carries a unique kind code and the epilogue re-dispatch for it. NORMAL
	 * needs no arm (it falls through).
	 */
	finalizerArms?: Map<string, { kind: number; fill: (block: IRBlock) => void }>;
}

export interface IRBlock {
	instructions: Array<IRInstruction>;
}

/**
 * Mutable handle to the block currently being emitted into.
 *
 * Short-circuit expressions create blocks mid-expression and advance the
 * cursor, so instructions following a sub-expression land in the right block.
 */
interface IRCursor {
	block: IRBlock;
}

export type IRInstruction =
	| {
			/**
			 * Source-position marker — carries no runtime opcode. Records the
			 * interned source position (an index into program.sourcePositions) of
			 * the statement that follows. lowerFunctionToVmFunction consumes these
			 * into the per-function position table (which drives VM stack traces and
			 * the native backend's `pos` writes) and strips them from the bytecode,
			 * so the VM never dispatches one. Modeled on the tryBegin/tryEnd markers;
			 * register-allocation and the optimizer skip it since it has no
			 * `registers` and is not a jump/return type.
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
			// TODO(opt): strip any jump or jumpIf instruction after a previous jump instruction.
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

			// [destination]
			registers: [number];
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

			// [destination]
			registers: [number];

			length: number;
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
			type: "loadThis";

			// [destination]
			registers: [number];
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
	  }
	| {
			type: "construct";

			// [destination, callee, ...arguments]
			registers: [number, number, ...Array<number>];
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

			intrinsic: IRIntrinsic;
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
			// TODO(opt): there is an optimization opportunity when a store is 'immediately'
			// followed by a load.
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
	  }
	| {
			type: "storeProperty";

			// [object, key, value]
			registers: [number, number, number];
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

			// [object, key, value]; defines an own writable + configurable
			// data property, used for class members.
			registers: [number, number, number];

			enumerable: boolean;
	  }
	| {
			// [destination]; mints a fresh hidden symbol that keys a private
			// class member for this class evaluation.
			type: "createPrivateName";

			registers: [number];
	  }
	| {
			// [object, key, value]; installs a private member (field or brand
			// marker) keyed by the private symbol in key. Throws if already
			// present.
			type: "definePrivate";

			registers: [number, number, number];
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
			// Sloppy-mode read of an unresolved name: the global object property, or
			// ReferenceError if absent. (Strict reads use loadUndeclared.)
			type: "loadGlobalProperty";
			registers: [number];
			nameStringIndex: number;
	  }
	| {
			// Write [src] to a global object property (created if absent): a
			// sloppy-script top-level `var`/`function` binding store.
			type: "storeGlobalProperty";
			registers: [number];
			nameStringIndex: number;
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

			operator: "!" | "-" | "+" | "~" | "typeof";
	  };

type IRBinaryOperator = Extract<IRInstruction, { type: "binary" }>["operator"];
type IRIntrinsic =
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
	| "Reflect"
	| "Proxy"
	| "console"
	| "globalThis"
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
	| "__arrayFlatMapAppend";

const irIntrinsics = new Set<string>([
	"Object",
	"Array",
	"Function",
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"URIError",
	"EvalError",
	"AggregateError",
	"String",
	"Number",
	"Boolean",
	"Symbol",
	"BigInt",
	"ArrayBuffer",
	"SharedArrayBuffer",
	"Int8Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"Int16Array",
	"Uint16Array",
	"Int32Array",
	"Uint32Array",
	"Float32Array",
	"Float64Array",
	"BigInt64Array",
	"BigUint64Array",
	"DataView",
	"Map",
	"Set",
	"WeakMap",
	"WeakSet",
	"WeakRef",
	"FinalizationRegistry",
	"Promise",
	"Date",
	"RegExp",
	"Intl",
	"Iterator",
	"AsyncIterator",
	"parseInt",
	"parseFloat",
	"isNaN",
	"isFinite",
	"decodeURI",
	"decodeURIComponent",
	"encodeURI",
	"encodeURIComponent",
	"Math",
	"JSON",
	"Reflect",
	"Proxy",
	"console",
	"globalThis",
	"NaN",
	"Infinity",
	"__cjs_require",
]);

function isIRIntrinsic(name: string): name is IRIntrinsic {
	return irIntrinsics.has(name);
}

const irBinaryOperators = new Set<string>([
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
	"<",
	"<=",
	">",
	">=",
	"==",
	"!=",
	"===",
	"!==",
	"in",
	"instanceof",
]);

function isIRBinaryOperator(operator: string): operator is IRBinaryOperator {
	return irBinaryOperators.has(operator);
}

export function debugIntermediateProgram(program: IntermediateProgram) {
	let output = "";
	const indent = "  ";

	for (const fn of program.functions) {
		output += `FN (params: ${fn.parameterCount}, regCount: ${fn.nextRegisterDestination})\n`;
		for (const block of fn.blocks) {
			output += `${indent}BLOCK\n`;

			for (const instruction of block.instructions) {
				output += `${indent}${indent}${instruction.type} : ${JSON.stringify({ ...instruction, type: undefined })}\n`;
			}
		}
	}

	log.debug(output);
}

/**
 * Tracing compiler from a SemanticProgram to our intermediate representation (IR).
 *
 * Choosing a tracing compiler might bite us in the back later, as we might drop things like
 * functions that are used in dynamic `eval`. But for now it has some advantages:
 *
 * - We can easily skip behavior that we don't support yet.
 * - We do some dead code elimination as well.
 *
 * We might never support dynamic eval tho, so in that case we are all setup ;)
 */
export function compileSemanticProgramToIr(semantic: SemanticProgram) {
	const program: IntermediateProgram = {
		semantic,

		functions: [],
		stringConstants: [],
		stringConstantToIndex: new Map(),

		sourcePositions: [],
		sourcePositionToIndex: new Map(),

		bigintConstants: [],
		bigintConstantToIndex: new Map(),

		bindingFunctionNode: new Map(),

		compiledModuleInitForPaths: new Set(),
		bindingToStorage: new Map(),
		nextLoopScopeId: -1,
		bindingToFunctionCache: new Map(),
		nodeToFunctionCache: new Map(),

		nextGlobalIndex: 0,

		moduleDefaultBinding: new Map(),
		namespaceImports: new Map(),

		cjsModuleId: new Map(),
		cjsWrapperFunctionIndex: [],
		cjsImports: new Map(),
		cjsEagerSlot: new Map(),
	};

	// Cross-module linking: aliases imported names to their exporter bindings (a
	// no-op for a single-module program). Must run before any IR compilation so
	// identifier resolution sees the aliased bindings.
	const linkage = linkModules(semantic);
	for (const [path, binding] of linkage.moduleDefaultBinding) {
		program.moduleDefaultBinding.set(path, binding);
	}
	for (const [path, imports] of linkage.namespaceImports) {
		program.namespaceImports.set(path, imports);
	}
	for (const [path, imports] of linkage.cjsImports) {
		program.cjsImports.set(path, imports);
	}

	const initFile = program.semantic.files.find(
		(it) => it.path === program.semantic.entrypointPath,
	);

	if (!initFile) {
		throw new Error(`Could not find entrypoint file ${program.semantic.entrypointPath}`);
	}

	const evaluationOrder = semantic.graph?.evaluationOrder ?? [initFile.path];

	if (initFile.commonjs) {
		// A CommonJS program: each module is a wrapper run lazily through require.
		compileCjsProgram(program, initFile);
	} else if (evaluationOrder.length <= 1) {
		// Single module: the init is the entrypoint (function 0), exactly as a
		// plain script compiles.
		compileFileInit(program, initFile);
	} else {
		// An ES module graph, possibly importing CommonJS modules. Assign CJS ids
		// + pure-data slots first so the merged init can lower `import … from "cjs"`;
		// compile the CJS wrappers after.
		assignCjsModuleIds(program);
		classifyPureDataCjsModules(program);
		compileMergedModuleInit(program, evaluationOrder);
		compileCjsWrappers(program);
	}

	debugIntermediateProgram(program);

	return program;
}

/**
 * Build the program entry for a multi-module ES program: a single merged init
 * function (index 0) whose body is every module's top-level code, concatenated
 * in evaluation order (dependencies first, entry last). This is scope hoisting
 * — module bindings are already shared global slots and imports are aliased to
 * their exporters, so the merged top-levels realize the cross-module data flow
 * with live bindings, and there is no per-module init function or orchestrator.
 */
function compileMergedModuleInit(
	program: IntermediateProgram,
	evaluationOrder: Array<string>,
) {
	const fileByPath = new Map(program.semantic.files.map((file) => [file.path, file]));

	// Nested functions are traced lazily and would otherwise try to compile a
	// separate per-file init; mark every module compiled up front since the
	// merged init already covers every module's top-level.
	for (const modulePath of evaluationOrder) {
		program.compiledModuleInitForPaths.add(modulePath);
	}

	const fn: IRFunction = {
		// Switched to each module in turn so identifier resolution uses the right
		// file's bindings while compiling that module's segment.
		semanticFile: program.semantic.files[0]!,
		functionIndex: program.functions.length,
		nameStringIndex: getOrCreateStringConstant(program, ""),
		blocks: [],

		parameterCount: 0,
		length: 0,
		nextRegisterDestination: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};
	program.functions.push(fn);

	let tail: IRBlock | null = null;

	// Pure-data CommonJS modules are built once up front, before any module body.
	if (program.cjsEagerSlot.size > 0) {
		const eagerBlock: IRBlock = { instructions: [] };
		fn.blocks.push(eagerBlock);
		emitCjsEagerInits(program, fn, { block: eagerBlock });
		tail = eagerBlock;
	}

	for (const modulePath of evaluationOrder) {
		const file = fileByPath.get(modulePath);
		if (!file) {
			continue;
		}
		// CommonJS modules are wrappers run lazily through require, not inlined
		// into the eager ESM init.
		if (file.commonjs) {
			continue;
		}
		fn.semanticFile = file;

		const prologue: IRBlock = { instructions: [] };
		const prologueIndex = fn.blocks.push(prologue) - 1;
		// Chain the previous module's tail into this module's segment.
		if (tail) {
			tail.instructions.push({ type: "jump", blocks: [prologueIndex] });
		}

		emitModulePrologue(program, fn, prologue, file);
		// Initialize CommonJS imports (require + property reads) before the body.
		emitCjsImportInits(program, fn, { block: prologue }, file);
		const bodyEntry = compileStatementsToBlock(program, fn, file.ast.body, true);
		prologue.instructions.push({ type: "jump", blocks: [bodyEntry] });

		tail = fn.blocks[fn.blocks.length - 1]!;
	}

	const modules = evaluationOrder
		.map((modulePath) => fileByPath.get(modulePath))
		.filter((file): file is SemanticFile => file !== undefined && !file.commonjs);
	makeInitAsyncIfTopLevelAwait(fn, modules);

	endFunction(fn);
}

/**
 * Compile the top-level statements of a single-module program (or the
 * entrypoint when there is only one module) into its own init function.
 */
function compileFileInit(program: IntermediateProgram, initFile: SemanticFile) {
	if (program.compiledModuleInitForPaths.has(initFile.path)) {
		// We already compiled the entrypoint for this file, so we can skip it, so we don't
		// initialize a module twice.
		return -1;
	}
	program.compiledModuleInitForPaths.add(initFile.path);

	const fn: IRFunction = {
		semanticFile: initFile,
		functionIndex: program.functions.length,
		nameStringIndex: getOrCreateStringConstant(program, ""),
		blocks: [],

		parameterCount: 0,
		length: 0,
		nextRegisterDestination: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};

	program.functions.push(fn);

	// A prologue block (TDZ inits + namespace objects) only when needed, so a
	// module with only var/function top-levels compiles exactly as before.
	if (moduleNeedsPrologue(program, initFile)) {
		const prologue: IRBlock = { instructions: [] };
		fn.blocks.push(prologue);
		emitModulePrologue(program, fn, prologue, initFile);
		const bodyEntry = compileStatementsToBlock(program, fn, initFile.ast.body, true);
		prologue.instructions.push({ type: "jump", blocks: [bodyEntry] });
	} else {
		compileStatementsToBlock(program, fn, initFile.ast.body, true);
	}

	makeInitAsyncIfTopLevelAwait(fn, [initFile]);
	endFunction(fn);

	return fn.functionIndex;
}

/**
 * Compile a CommonJS program: every reachable module becomes a wrapper function
 * run lazily through `require`, and a synthetic entry (function 0) kicks the
 * graph off by requiring the entrypoint. CJS requiring an ES module is not
 * supported yet (rejected loudly).
 */
function compileCjsProgram(program: IntermediateProgram, initFile: SemanticFile) {
	assignCjsModuleIds(program);
	classifyPureDataCjsModules(program);

	const nonCjs = program.semantic.files.find((file) => !file.commonjs);
	if (nonCjs) {
		throw new Error(
			`CommonJS requiring an ES module (${nonCjs.path}) is not supported yet`,
		);
	}

	// Function 0 is the program entry: build pure-data modules, then require() the
	// entrypoint module.
	compileCjsEntryDriver(program, program.cjsModuleId.get(initFile.path)!);
	compileCjsWrappers(program);
}

/** Assign a registry id to every CommonJS module in the graph. */
function assignCjsModuleIds(program: IntermediateProgram) {
	for (const file of program.semantic.files) {
		if (file.commonjs && !program.cjsModuleId.has(file.path)) {
			program.cjsModuleId.set(file.path, program.cjsModuleId.size);
		}
	}
}

/** Give each side-effect-free pure-data CommonJS module an eager exports slot. */
function classifyPureDataCjsModules(program: IntermediateProgram) {
	for (const file of program.semantic.files) {
		if (
			file.commonjs &&
			!program.cjsEagerSlot.has(file.path) &&
			isPureDataCjsModule(file.ast)
		) {
			program.cjsEagerSlot.set(file.path, program.nextGlobalIndex++);
		}
	}
}

/**
 * A register holding a CommonJS module's `module.exports`: a direct slot read for
 * a pure-data module (built once at init), else a lazy `require()` call.
 */
function emitCjsModuleExports(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	cjsPath: string,
): number {
	const slot = program.cjsEagerSlot.get(cjsPath);
	if (slot !== undefined) {
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "loadGlobal",
			registers: [destination],
			index: slot,
		});
		return destination;
	}
	return emitCjsRequire(program, fn, cursor, program.cjsModuleId.get(cjsPath)!);
}

/**
 * Build every pure-data module's exports once into its slot (via the registry,
 * so identity is shared with any lazy require). Emitted at program start, before
 * any module body runs; safe because these modules have no observable side
 * effects.
 */
function emitCjsEagerInits(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
) {
	for (const [cjsPath, slot] of program.cjsEagerSlot) {
		const value = emitCjsRequire(program, fn, cursor, program.cjsModuleId.get(cjsPath)!);
		cursor.block.instructions.push({
			type: "storeGlobal",
			registers: [value],
			index: slot,
		});
	}
}

/** Compile every CommonJS module's wrapper, recording its index by id. */
function compileCjsWrappers(program: IntermediateProgram) {
	for (const file of program.semantic.files) {
		if (file.commonjs) {
			const id = program.cjsModuleId.get(file.path)!;
			program.cjsWrapperFunctionIndex[id] = compileCjsModuleWrapper(program, file);
		}
	}
}

/**
 * Initialize an ES module's CommonJS imports: each local binding is set from
 * `require(cjsId)` — default/namespace = module.exports, named = a property of
 * it. Emitted into the module's init prologue, before its body runs.
 */
function emitCjsImportInits(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	file: SemanticFile,
) {
	for (const cjsImport of program.cjsImports.get(file.path) ?? []) {
		if (!program.cjsModuleId.has(cjsImport.cjsPath)) {
			continue;
		}
		const exportsRegister = emitCjsModuleExports(program, fn, cursor, cjsImport.cjsPath);
		let valueRegister = exportsRegister;
		if (cjsImport.kind === "named" && cjsImport.name !== undefined) {
			valueRegister = emitLoadProperty(
				program,
				fn,
				cursor,
				exportsRegister,
				cjsImport.name,
			);
		} else if (cjsImport.kind === "namespace") {
			// Build a namespace object: default = module.exports + a snapshot of each
			// statically-detected named export (module.exports[name]).
			valueRegister = nextRegisterDestination(fn);
			cursor.block.instructions.push({
				type: "createObject",
				registers: [valueRegister],
			});
			emitStoreProperty(program, fn, cursor, valueRegister, "default", exportsRegister);
			for (const name of cjsImport.names ?? []) {
				const member = emitLoadProperty(program, fn, cursor, exportsRegister, name);
				emitStoreProperty(program, fn, cursor, valueRegister, name, member);
			}
		}
		const location = getOrCreateBindingLocation(program, fn, cjsImport.binding);
		storeRegisterAtLocation(cursor.block, location, valueRegister);
	}
}

/** `object.name` → a fresh register holding the loaded value. */
function emitLoadProperty(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	objectRegister: number,
	name: string,
): number {
	const keyRegister = compileStaticString(program, fn, cursor, name);
	const destination = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "loadProperty",
		registers: [destination, objectRegister, keyRegister],
	});
	return destination;
}

/** `object.name = value` (data store). */
function emitStoreProperty(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	objectRegister: number,
	name: string,
	valueRegister: number,
) {
	const keyRegister = compileStaticString(program, fn, cursor, name);
	cursor.block.instructions.push({
		type: "storeProperty",
		registers: [objectRegister, keyRegister, valueRegister],
	});
}

/** The synthetic CJS program entry (function 0): `require(entryId)`. */
function compileCjsEntryDriver(program: IntermediateProgram, entryId: number) {
	const fn: IRFunction = {
		semanticFile: program.semantic.files[0]!,
		functionIndex: program.functions.length,
		nameStringIndex: getOrCreateStringConstant(program, ""),
		blocks: [],

		parameterCount: 0,
		length: 0,
		nextRegisterDestination: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};
	program.functions.push(fn);

	const block: IRBlock = { instructions: [] };
	fn.blocks.push(block);
	const cursor: IRCursor = { block };
	emitCjsEagerInits(program, fn, cursor);
	emitCjsRequire(program, fn, cursor, entryId);

	endFunction(fn);
}

/**
 * Compile one CommonJS module as its wrapper function
 * `(module, exports, require, __filename, __dirname) { …module body… }`. The
 * wrapper's `this` is `exports` (set by mal_vm_cjs_require), so module top-level
 * `this` resolves correctly with no special handling.
 */
function compileCjsModuleWrapper(
	program: IntermediateProgram,
	file: SemanticFile,
): number {
	program.compiledModuleInitForPaths.add(file.path);

	const fn: IRFunction = {
		semanticFile: file,
		functionIndex: program.functions.length,
		nameStringIndex: getOrCreateStringConstant(program, ""),
		blocks: [],

		parameterCount: COMMONJS_BINDINGS.length,
		length: COMMONJS_BINDINGS.length,
		nextRegisterDestination: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};
	program.functions.push(fn);

	const paramsBlock: IRBlock = { instructions: [] };
	fn.blocks.push(paramsBlock);

	// Bind the wrapper parameters to the incoming argument registers [0..5), in
	// the order mal_vm_cjs_require passes them.
	const programScope = file.scopes[0];
	for (const name of COMMONJS_BINDINGS) {
		const register = nextRegisterDestination(fn);
		const binding = programScope?.bindings.find(
			(candidate) => candidate.name === name && !candidate.undeclared,
		);
		if (binding) {
			const location = getOrCreateBindingLocation(program, fn, binding);
			storeRegisterAtLocation(paramsBlock, location, register);
		}
	}

	// Top-level let/const start in their TDZ, then run the module body.
	if (programScope) {
		emitTdzHoleInits(program, fn, paramsBlock, programScope.bindings);
	}
	const bodyEntry = compileStatementsToBlock(program, fn, file.ast.body, true);
	paramsBlock.instructions.push({ type: "jump", blocks: [bodyEntry] });

	endFunction(fn);
	return fn.functionIndex;
}

/** Emit a call to the CJS `require` intrinsic with a numeric module id. */
function emitCjsRequire(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	moduleId: number,
): number {
	const callee = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "loadIntrinsic",
		registers: [callee],
		intrinsic: "__cjs_require",
	});
	const thisRegister = compileUndefined(fn, cursor);
	const idRegister = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createNumber",
		registers: [idRegister],
		value: moduleId,
	});
	const destination = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "call",
		registers: [destination, callee, thisRegister, idRegister],
	});
	return destination;
}

/**
 * If this call is a static `require("specifier")` against the injected CommonJS
 * `require`, lower it to `__cjs_require(id)` of the resolved module and return
 * its result register; otherwise undefined (a normal call, e.g. a dynamic or
 * shadowed require, which throws at runtime).
 */
function tryCompileCjsRequireCall(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	callExpression: ESTree.CallExpression,
): number | undefined {
	const callee = callExpression.callee as unknown as ESTree.Node;
	if (callee.type !== "Identifier" || callee.name !== "require") {
		return undefined;
	}
	// Only the injected wrapper `require` (declarationNode is the Program) — not a
	// user binding that shadows the name.
	const binding = fn.semanticFile.nodeToBinding.get(callee);
	if (!binding || binding.declarationNode !== fn.semanticFile.ast) {
		return undefined;
	}
	const args = callExpression.arguments;
	const specifier = args[0];
	if (
		args.length !== 1 ||
		!specifier ||
		specifier.type !== "Literal" ||
		typeof specifier.value !== "string"
	) {
		return undefined;
	}
	const cjsPath = resolveCjsModulePath(program, fn.semanticFile, specifier.value);
	if (cjsPath === undefined || !program.cjsModuleId.has(cjsPath)) {
		return undefined;
	}
	return emitCjsModuleExports(program, fn, cursor, cjsPath);
}

/** Resolve a `require` specifier to the target module's resolved path via the graph. */
function resolveCjsModulePath(
	program: IntermediateProgram,
	file: SemanticFile,
	specifier: string,
): string | undefined {
	const dependency = program.semantic.graph?.modules
		.get(file.path)
		?.dependencies.find(
			(candidate) =>
				candidate.kind === "require" &&
				candidate.specifier === specifier &&
				candidate.resolvedPath !== null,
		);
	return dependency?.resolvedPath ?? undefined;
}

/**
 * Store the uninitialized ("empty") sentinel into a scope's let/const/class
 * binding slots (their temporal dead zone), so a read before the declaration
 * runs throws ReferenceError. Skips functions (hoisted) and imports (aliased).
 */
function emitTdzHoleInits(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	bindings: Array<Binding>,
) {
	for (const binding of bindings) {
		if (!isTdzBinding(binding)) {
			continue;
		}
		const location = getOrCreateBindingLocation(program, fn, binding);
		const register = nextRegisterDestination(fn);
		block.instructions.push({ type: "createEmpty", registers: [register] });
		storeRegisterAtLocation(block, location, register);
	}
}

/**
 * Emit the TDZ hole-inits for a block-bodied function's own scope into `block`
 * (the params block, before the jump to the body), so its let/const/class
 * bindings start uninitialized at function entry. The empty value persists in
 * the frame across a generator/async suspend, so this placement is correct for
 * all function kinds.
 */
function emitFunctionBodyTdz(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	functionNode:
		| ESTree.FunctionDeclaration
		| ESTree.FunctionExpression
		| ESTree.ArrowFunctionExpression,
) {
	if (functionNode.body?.type !== "BlockStatement") {
		return;
	}
	const scope = fn.semanticFile.nodeToScope.get(functionNode.body);
	if (scope) {
		emitTdzHoleInits(program, fn, block, scope.bindings);
	}
}

/**
 * Whether a module needs an init prologue: it has top-level TDZ bindings
 * (let/const/class) or `import * as ns` namespace objects to build.
 */
function moduleNeedsPrologue(program: IntermediateProgram, file: SemanticFile): boolean {
	return (
		(file.scopes[0]?.bindings ?? []).some(isTdzBinding) ||
		(program.namespaceImports.get(file.path)?.length ?? 0) > 0
	);
}

/**
 * Emit a module's init prologue into `block`: store the uninitialized sentinel
 * into top-level let/const/class slots (their temporal dead zone), then build
 * any `import * as ns` namespace objects.
 */
function emitModulePrologue(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	file: SemanticFile,
) {
	emitTdzHoleInits(program, fn, block, file.scopes[0]?.bindings ?? []);
	for (const namespaceImport of program.namespaceImports.get(file.path) ?? []) {
		emitNamespaceObject(
			program,
			fn,
			block,
			namespaceImport.binding,
			namespaceImport.exports,
		);
	}
}

/**
 * If any of the given modules has top-level await, make the init an async
 * function: it returns a promise and suspends on each top-level await,
 * resuming via the microtask queue. Because the merged init runs modules'
 * top-levels sequentially in evaluation order, a suspended await holds up the
 * dependents that follow it — the spec ordering falls out for free.
 */
function makeInitAsyncIfTopLevelAwait(fn: IRFunction, modules: Array<SemanticFile>) {
	if (modules.some((file) => hasTopLevelAwait(file.ast))) {
		fn.isAsync = true;
		fn.blocks[0]!.instructions.unshift({ type: "asyncStart" });
	}
}

/**
 * Whether a module has top-level await: an AwaitExpression that is not nested
 * inside a function (so it runs as part of module evaluation).
 */
function hasTopLevelAwait(ast: ESTree.Program): boolean {
	let found = false;
	const visit = (node: unknown, inFunction: boolean) => {
		if (found || !node || typeof node !== "object") {
			return;
		}
		if (Array.isArray(node)) {
			for (const item of node) {
				visit(item, inFunction);
			}
			return;
		}
		if (!("type" in node)) {
			return;
		}
		const typed = node as ESTree.Node;
		if (typed.type === "AwaitExpression" && !inFunction) {
			found = true;
			return;
		}
		const entersFunction =
			typed.type === "FunctionDeclaration" ||
			typed.type === "FunctionExpression" ||
			typed.type === "ArrowFunctionExpression";
		for (const key of Object.keys(typed)) {
			visit(
				(typed as unknown as Record<string, unknown>)[key],
				inFunction || entersFunction,
			);
		}
	};
	visit(ast.body, false);
	return found;
}

function compileNewFunction(
	program: IntermediateProgram,
	binding: Binding,
	functionNode: ESTree.Node,
) {
	if (
		functionNode.type !== "FunctionDeclaration" &&
		functionNode.type !== "FunctionExpression" &&
		functionNode.type !== "ArrowFunctionExpression"
	) {
		return -1;
	}

	if (program.bindingToFunctionCache.has(binding)) {
		return program.bindingToFunctionCache.get(binding)!.fnIndex;
	}

	// Brute-force find the file. We should do the linkup earlier, so we have / know which file
	// it is.
	let foundFile: SemanticFile | undefined = undefined;
	for (const file of program.semantic.files) {
		if (file.nodeToBinding.get(functionNode)) {
			foundFile = file;
			compileFileInit(program, foundFile);
			break;
		}
	}

	const fnFile = foundFile ?? program.semantic.files[0]!;
	const fn: IRFunction = {
		semanticFile: fnFile,
		functionIndex: program.functions.length,
		nameStringIndex: getOrCreateStringConstant(
			program,
			("id" in functionNode ? functionNode.id?.name : undefined) ?? binding.name,
		),
		blocks: [],
		strict: functionStrict(fnFile, functionNode),
		isGenerator:
			functionNode.type !== "ArrowFunctionExpression" && functionNode.generator,
		isAsync: functionNode.async === true,

		parameterCount: functionNode.params.length,
		length: computeFunctionLength(functionNode),
		nextRegisterDestination: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};

	program.functions.push(fn);
	program.bindingToFunctionCache.set(binding, { fnIndex: fn.functionIndex });

	const paramsCursor = compileFunctionParams(program, fn, functionNode);
	prepareTailCallLoop(fn, functionNode);
	const bodyBlock = compileStatementsToBlock(
		program,
		fn,
		functionNode.body?.type === "BlockStatement"
			? normalizeStatementOrBlock(functionNode.body)
			: functionNode.body // Handle auto-returning from single-line arrow functions.
				? normalizeStatementOrBlock({
						type: "ReturnStatement",
						argument: functionNode.body,
					})
				: [],
		true,
	);
	emitFunctionBodyTdz(program, fn, paramsCursor.block, functionNode);
	paramsCursor.block.instructions.push({
		type: "jump",
		blocks: [bodyBlock],
	});

	// The prologue runs after parameter setup (so defaults eval eagerly at call
	// time) and suspends, returning the generator object.
	if (fn.isGenerator) {
		fn.blocks[bodyBlock]!.instructions.unshift({ type: "generatorStart" });
	} else if (fn.isAsync) {
		// Same placement: create the result promise after params evaluate, then
		// run the body until the first await.
		fn.blocks[bodyBlock]!.instructions.unshift({ type: "asyncStart" });
	}

	endFunction(fn);

	return fn.functionIndex;
}

function compileNewFunctionExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	functionNode: ESTree.FunctionExpression | ESTree.ArrowFunctionExpression,
	classContext?: IRClassContext,
	nameOverride?: string,
) {
	const cached = program.nodeToFunctionCache.get(functionNode);
	if (cached) {
		return cached.fnIndex;
	}

	const compiledFn: IRFunction = {
		semanticFile: fn.semanticFile,
		functionIndex: program.functions.length,
		nameStringIndex: getOrCreateStringConstant(
			program,
			nameOverride ??
				(functionNode.type === "FunctionExpression" ? (functionNode.id?.name ?? "") : ""),
		),
		blocks: [],
		classContext,
		strict: functionStrict(fn.semanticFile, functionNode),
		isGenerator:
			functionNode.type !== "ArrowFunctionExpression" && functionNode.generator,
		isAsync: functionNode.async === true,

		parameterCount: functionNode.params.length,
		length: computeFunctionLength(functionNode),
		nextRegisterDestination: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};

	program.functions.push(compiledFn);
	program.nodeToFunctionCache.set(functionNode, { fnIndex: compiledFn.functionIndex });

	const paramsCursor = compileFunctionParams(program, compiledFn, functionNode);

	// Base constructors run InitializeInstanceElements before the body; derived
	// constructors run it after super() returns (woven in by compileSuperCall).
	if (classContext?.isConstructor && !classContext.isDerivedConstructor) {
		emitInstanceElementInit(program, compiledFn, paramsCursor, classContext);
	}

	prepareTailCallLoop(compiledFn, functionNode);
	const bodyBlock = compileStatementsToBlock(
		program,
		compiledFn,
		functionNode.body?.type === "BlockStatement"
			? normalizeStatementOrBlock(functionNode.body)
			: functionNode.body
				? normalizeStatementOrBlock({
						type: "ReturnStatement",
						argument: functionNode.body,
					})
				: [],
		true,
	);
	emitFunctionBodyTdz(program, compiledFn, paramsCursor.block, functionNode);
	paramsCursor.block.instructions.push({
		type: "jump",
		blocks: [bodyBlock],
	});

	if (compiledFn.isGenerator) {
		compiledFn.blocks[bodyBlock]!.instructions.unshift({ type: "generatorStart" });
	} else if (compiledFn.isAsync) {
		compiledFn.blocks[bodyBlock]!.instructions.unshift({ type: "asyncStart" });
	}

	endFunction(compiledFn);

	return compiledFn.functionIndex;
}

/**
 * Create a synthetic captured binding owned by the enclosing function, used
 * for the class machinery (super, class self-reference, private symbols and
 * shared private functions). Ownership is claimed here so inner functions
 * resolve the slot through the enclosing frame's environment.
 */
function createCapturedBinding(
	program: IntermediateProgram,
	fn: IRFunction,
	name: string,
): Binding {
	const binding: Binding = { kind: "const", name, usageNodes: [], scopedTo: "captured" };
	getOrCreateBindingLocation(program, fn, binding);
	return binding;
}

/**
 * The own-property name of a non-computed public class field key.
 */
function classFieldKeyName(key: ESTree.Expression | ESTree.PrivateIdentifier): string {
	if (key.type === "Identifier") {
		return key.name;
	}

	if (key.type === "Literal") {
		return String(key.value);
	}

	return "";
}

/**
 * Mint a fresh hidden private symbol into a captured slot at class definition
 * time. Each class evaluation produces distinct identities, so instances of
 * two evaluations of the same class source are not brand compatible.
 */
function mintPrivateName(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	binding: Binding | undefined,
) {
	if (!binding) {
		return;
	}

	const symbol = nextRegisterDestination(fn);
	cursor.block.instructions.push({ type: "createPrivateName", registers: [symbol] });
	storeRegisterAtLocation(
		cursor.block,
		getOrCreateBindingLocation(program, fn, binding),
		symbol,
	);
}

/**
 * Emit one field installation: a private field through its hidden symbol
 * (definePrivate) or a public field as an own enumerable data property
 * (CreateDataProperty). `this` is the receiver being initialized.
 */
function emitFieldInstall(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	entry: IRInstanceFieldPlanEntry,
) {
	const nameHint = entry.private
		? entry.nameHint
		: entry.key.kind === "name"
			? entry.key.name
			: undefined;

	let value: number;
	if (entry.valueNode) {
		value = compileExpression(program, fn, cursor, entry.valueNode, nameHint);
		if (value === -1) {
			value = compileUndefined(fn, cursor);
		}
	} else {
		value = compileUndefined(fn, cursor);
	}

	const thisRegister = nextRegisterDestination(fn);
	cursor.block.instructions.push({ type: "loadThis", registers: [thisRegister] });

	if (entry.private) {
		const symbol = loadRegisterFromLocation(
			fn,
			cursor.block,
			getOrCreateBindingLocation(program, fn, entry.fieldBinding),
		);
		cursor.block.instructions.push({
			type: "definePrivate",
			registers: [thisRegister, symbol, value],
		});
		return;
	}

	let key: number;
	if (entry.key.kind === "name") {
		key = compileStaticString(program, fn, cursor, entry.key.name);
	} else if (entry.key.kind === "captured") {
		key = loadRegisterFromLocation(
			fn,
			cursor.block,
			getOrCreateBindingLocation(program, fn, entry.key.binding),
		);
	} else {
		key = compileExpression(program, fn, cursor, entry.key.node);
		if (key === -1) {
			key = compileUndefined(fn, cursor);
		}
	}

	cursor.block.instructions.push({
		type: "defineProperty",
		registers: [thisRegister, key, value],
		enumerable: true,
	});
}

/**
 * Emit the InitializeInstanceElements sequence on `this`: install the brand
 * marker (covering private methods/accessors) and then run public and private
 * field initializers in source order. No-op when the class has none.
 */
function emitInstanceElementInit(
	program: IntermediateProgram,
	ctorFn: IRFunction,
	cursor: IRCursor,
	classContext: IRClassContext,
) {
	const brand = classContext.instanceBrandBinding;
	const plan = classContext.instanceFieldPlan ?? [];
	if (!brand && plan.length === 0) {
		return;
	}

	if (brand) {
		const thisRegister = nextRegisterDestination(ctorFn);
		cursor.block.instructions.push({ type: "loadThis", registers: [thisRegister] });
		const symbol = loadRegisterFromLocation(
			ctorFn,
			cursor.block,
			getOrCreateBindingLocation(program, ctorFn, brand),
		);
		const marker = nextRegisterDestination(ctorFn);
		cursor.block.instructions.push({
			type: "createBoolean",
			registers: [marker],
			value: true,
		});
		cursor.block.instructions.push({
			type: "definePrivate",
			registers: [thisRegister, symbol, marker],
		});
	}

	for (const entry of plan) {
		emitFieldInstall(program, ctorFn, cursor, entry);
	}
}

/**
 * Build the static initializer: a synthetic function run once with
 * this = constructor. It installs the static brand and runs static field
 * initializers in source order.
 */
function buildStaticInitializer(
	program: IntermediateProgram,
	fn: IRFunction,
	staticContext: IRClassContext,
	staticElements: Array<IRStaticElement>,
	staticBrandBinding: Binding | undefined,
): number {
	const initFn: IRFunction = {
		semanticFile: fn.semanticFile,
		functionIndex: program.functions.length,
		nameStringIndex: getOrCreateStringConstant(program, ""),
		blocks: [],
		classContext: staticContext,
		// Class code is always strict.
		strict: true,
		parameterCount: 0,
		length: 0,
		nextRegisterDestination: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};
	program.functions.push(initFn);

	const block: IRBlock = { instructions: [] };
	initFn.blocks.push(block);
	const cursor: IRCursor = { block };

	if (staticBrandBinding) {
		const thisRegister = nextRegisterDestination(initFn);
		cursor.block.instructions.push({ type: "loadThis", registers: [thisRegister] });
		const symbol = loadRegisterFromLocation(
			initFn,
			cursor.block,
			getOrCreateBindingLocation(program, initFn, staticBrandBinding),
		);
		const marker = nextRegisterDestination(initFn);
		cursor.block.instructions.push({
			type: "createBoolean",
			registers: [marker],
			value: true,
		});
		cursor.block.instructions.push({
			type: "definePrivate",
			registers: [thisRegister, symbol, marker],
		});
	}

	// Static fields and static blocks run in source order. A block's statements
	// are compiled into their own chain and the cursor resumes at its tail.
	for (const element of staticElements) {
		if (element.kind === "field") {
			emitFieldInstall(program, initFn, cursor, element.entry);
			continue;
		}

		const entryBlock = compileStatementsToBlock(program, initFn, element.body, true);
		cursor.block.instructions.push({ type: "jump", blocks: [entryBlock] });
		cursor.block = initFn.blocks.at(-1)!;
	}

	endFunction(initFn);
	return initFn.functionIndex;
}

/**
 * Compile a class body to its constructor function value.
 *
 * Besides the constructor and prototype/static methods, this wires up the
 * private environment: per-class-evaluation hidden symbols (one brand marker
 * for instances, one for statics, plus one key per private field) and the
 * shared functions backing private methods/accessors, all stashed in captured
 * bindings so every method resolves `#x` lexically. Public and private fields
 * install through the constructor's InitializeInstanceElements sequence.
 */
function compileClass(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	classNode: ESTree.ClassDeclaration | ESTree.ClassExpression,
	nameHint?: string,
): number {
	const classId = program.functions.length;

	let superBinding: Binding | undefined;
	let classBinding: Binding | undefined;
	let parent = -1;
	if (classNode.superClass) {
		parent = compileExpression(program, fn, cursor, classNode.superClass);
		if (parent === -1) {
			return -1;
		}

		superBinding = createCapturedBinding(program, fn, `__super_${classId}`);
		storeRegisterAtLocation(
			cursor.block,
			getOrCreateBindingLocation(program, fn, superBinding),
			parent,
		);
	} else {
		// Heritage-less classes stash themselves so super references can walk
		// the home object's live prototype chain.
		classBinding = createCapturedBinding(program, fn, `__class_${classId}`);
	}

	// Scan the body once to build the private environment and field plans. The
	// symbols are minted at class definition (below); here we only allocate the
	// captured bindings that will hold them. ownNames holds this class's own
	// declarations; they are layered over the enclosing class's private
	// environment so a nested class can still reach an outer class's privates.
	const ownNames = new Map<string, IRPrivateName>();
	let instanceBrandBinding: Binding | undefined;
	let staticBrandBinding: Binding | undefined;
	const instanceFieldPlan: Array<IRInstanceFieldPlanEntry> = [];
	const staticElements: Array<IRStaticElement> = [];
	const computedInstanceKeys: Array<{ binding: Binding; node: ESTree.Expression }> = [];

	const ensurePrivateEntry = (name: string, isStatic: boolean): IRPrivateName => {
		const brandBinding = isStatic
			? (staticBrandBinding ??= createCapturedBinding(program, fn, `__sbrand_${classId}`))
			: (instanceBrandBinding ??= createCapturedBinding(
					program,
					fn,
					`__brand_${classId}`,
				));

		let entry = ownNames.get(name);
		if (!entry) {
			entry = { static: isStatic, brandBinding };
			ownNames.set(name, entry);
		}

		return entry;
	};

	for (const member of classNode.body.body) {
		if (member.type === "StaticBlock") {
			staticElements.push({ kind: "block", body: member.body });
			continue;
		}

		if (member.type === "PropertyDefinition") {
			const valueNode = (member.value ?? null) as ESTree.Expression | null;
			let entry: IRInstanceFieldPlanEntry;
			if (member.key.type === "PrivateIdentifier") {
				const name = `#${member.key.name}`;
				const privateEntry = ensurePrivateEntry(name, member.static);
				privateEntry.fieldBinding ??= createCapturedBinding(
					program,
					fn,
					`__pf_${name}_${classId}`,
				);
				entry = {
					private: true,
					fieldBinding: privateEntry.fieldBinding,
					valueNode,
					nameHint: name,
				};
			} else if (member.computed && !member.static) {
				// Instance computed keys are evaluated once, at class definition.
				const keyBinding = createCapturedBinding(
					program,
					fn,
					`__fk_${classId}_${computedInstanceKeys.length}`,
				);
				computedInstanceKeys.push({ binding: keyBinding, node: member.key });
				entry = {
					private: false,
					key: { kind: "captured", binding: keyBinding },
					valueNode,
				};
			} else if (member.computed) {
				// Static computed keys evaluate inline in the once-run static init.
				entry = { private: false, key: { kind: "node", node: member.key }, valueNode };
			} else {
				entry = {
					private: false,
					key: { kind: "name", name: classFieldKeyName(member.key) },
					valueNode,
				};
			}

			if (member.static) {
				staticElements.push({ kind: "field", entry });
			} else {
				instanceFieldPlan.push(entry);
			}
			continue;
		}

		if (
			member.type !== "MethodDefinition" ||
			member.kind === "constructor" ||
			!member.key
		) {
			continue;
		}

		if (member.key.type === "PrivateIdentifier") {
			const name = `#${member.key.name}`;
			const entry = ensurePrivateEntry(name, member.static);
			if (member.kind === "get") {
				entry.getBinding ??= createCapturedBinding(
					program,
					fn,
					`__pg_${name}_${classId}`,
				);
			} else if (member.kind === "set") {
				entry.setBinding ??= createCapturedBinding(
					program,
					fn,
					`__ps_${name}_${classId}`,
				);
			} else {
				entry.methodBinding ??= createCapturedBinding(
					program,
					fn,
					`__pm_${name}_${classId}`,
				);
			}
		}
	}

	// Layer this class's own private names over the enclosing private
	// environment so nested classes resolve outer privates (with shadowing).
	const privateNames = new Map<string, IRPrivateName>([
		...(fn.classContext?.privateNames ?? []),
		...ownNames,
	]);

	const sharedContext = {
		superBinding,
		classBinding,
		privateNames: privateNames.size > 0 ? privateNames : undefined,
		instanceBrandBinding,
		staticBrandBinding,
	};

	const constructorNode = classNode.body.body.find(
		(member): member is ESTree.MethodDefinition =>
			member.type === "MethodDefinition" && member.kind === "constructor",
	);
	// NamedEvaluation: anonymous class expressions take the binding name.
	const className = classNode.id?.name ?? nameHint ?? "";
	const constructorContext: IRClassContext = {
		...sharedContext,
		isStatic: false,
		isConstructor: true,
		isDerivedConstructor: parent !== -1,
		instanceFieldPlan,
	};
	const constructorIndex =
		constructorNode && constructorNode.value.type === "FunctionExpression"
			? compileNewFunctionExpression(
					program,
					fn,
					constructorNode.value,
					constructorContext,
					className,
				)
			: compileDefaultConstructor(
					program,
					fn,
					superBinding,
					className,
					constructorContext,
				);

	const ctor = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createFunction",
		registers: [ctor],
		functionIndex: constructorIndex,
	});

	if (classBinding) {
		storeRegisterAtLocation(
			cursor.block,
			getOrCreateBindingLocation(program, fn, classBinding),
			ctor,
		);
	}

	// Bind the class's own name to the constructor now, before static elements
	// run, so the class body can reference itself by name (e.g. `static x = C`
	// or `static { C.foo() }`). This is the class's inner name binding; the
	// outer declaration store (if any) happens after compileClass and is
	// redundant. The sema field-init/static-block scope boundary marks such
	// references as captures, so the static initializer reaches this slot.
	const selfBinding = fn.semanticFile.nodeToBinding.get(classNode);
	if (selfBinding && !selfBinding.undeclared) {
		storeRegisterAtLocation(
			cursor.block,
			getOrCreateBindingLocation(program, fn, selfBinding),
			ctor,
		);
	}

	// Mint the per-evaluation private symbols (brand markers and field keys).
	// Only this class's own names are minted here; inherited names were minted
	// by their declaring class.
	mintPrivateName(program, fn, cursor, instanceBrandBinding);
	mintPrivateName(program, fn, cursor, staticBrandBinding);
	for (const entry of ownNames.values()) {
		mintPrivateName(program, fn, cursor, entry.fieldBinding);
	}

	// Evaluate computed instance field keys once, here at class definition.
	for (const { binding, node } of computedInstanceKeys) {
		const key = compileExpression(program, fn, cursor, node);
		storeRegisterAtLocation(
			cursor.block,
			getOrCreateBindingLocation(program, fn, binding),
			key === -1 ? compileUndefined(fn, cursor) : key,
		);
	}

	// Wire the prototype chains.
	const prototypeKey = compileStaticString(program, fn, cursor, "prototype");
	let prototype: number;
	if (parent !== -1) {
		const parentPrototype = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "loadProperty",
			registers: [parentPrototype, parent, prototypeKey],
		});

		prototype = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "createObject",
			registers: [prototype],
		});
		cursor.block.instructions.push({
			type: "setPrototype",
			registers: [prototype, parentPrototype],
			literal: false,
		});

		const constructorKey = compileStaticString(program, fn, cursor, "constructor");
		cursor.block.instructions.push({
			type: "defineProperty",
			registers: [prototype, constructorKey, ctor],
			enumerable: false,
		});
		cursor.block.instructions.push({
			type: "storeProperty",
			registers: [ctor, prototypeKey, prototype],
		});
		cursor.block.instructions.push({
			type: "setPrototype",
			registers: [ctor, parent],
			literal: false,
		});
	} else {
		// Materializes the default prototype with its constructor backref.
		prototype = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "loadProperty",
			registers: [prototype, ctor, prototypeKey],
		});
	}

	for (const member of classNode.body.body) {
		if (
			member.type !== "MethodDefinition" ||
			member.kind === "constructor" ||
			member.value.type !== "FunctionExpression" ||
			!member.key
		) {
			continue;
		}

		const isPrivate = member.key.type === "PrivateIdentifier";
		const privateName = isPrivate
			? `#${(member.key as ESTree.PrivateIdentifier).name}`
			: "";
		const methodIndex = compileNewFunctionExpression(
			program,
			fn,
			member.value,
			{ ...sharedContext, isStatic: member.static },
			isPrivate
				? privateName
				: !member.computed && member.key.type === "Identifier"
					? member.key.name
					: "",
		);
		const method = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "createFunction",
			registers: [method],
			functionIndex: methodIndex,
		});

		if (isPrivate) {
			// Private methods/accessors are shared values, not own properties;
			// the per-instance brand marker gates access to them.
			const entry = ownNames.get(privateName)!;
			const targetBinding =
				member.kind === "get"
					? entry.getBinding
					: member.kind === "set"
						? entry.setBinding
						: entry.methodBinding;
			storeRegisterAtLocation(
				cursor.block,
				getOrCreateBindingLocation(program, fn, targetBinding!),
				method,
			);
			continue;
		}

		const target = member.static ? ctor : prototype;
		const key = compileClassMemberKey(program, fn, cursor, member);
		if (member.kind === "get" || member.kind === "set") {
			cursor.block.instructions.push({
				type: "defineAccessor",
				registers: [target, key, method],
				kind: member.kind,
				enumerable: false,
			});
		} else {
			cursor.block.instructions.push({
				type: "defineProperty",
				registers: [target, key, method],
				enumerable: false,
			});
		}
	}

	// Run static field initializers and static blocks (and install the static
	// brand) in source order with this = constructor.
	if (staticElements.length > 0 || staticBrandBinding) {
		const staticInitIndex = buildStaticInitializer(
			program,
			fn,
			{ ...sharedContext, isStatic: true },
			staticElements,
			staticBrandBinding,
		);
		const initFunction = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "createFunction",
			registers: [initFunction],
			functionIndex: staticInitIndex,
		});
		const result = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "call",
			registers: [result, initFunction, ctor],
		});
	}

	return ctor;
}

function compileClassMemberKey(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	member: ESTree.MethodDefinition,
): number {
	if (!member.key) {
		return -1;
	}

	if (member.computed) {
		return compileExpression(program, fn, cursor, member.key);
	}

	if (member.key.type === "Identifier") {
		return compileStaticString(program, fn, cursor, member.key.name);
	}

	if (member.key.type === "Literal") {
		return compileLiteral(program, fn, cursor, member.key);
	}

	return -1;
}

function loadCapturedBinding(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	binding: Binding,
): number {
	return loadRegisterFromLocation(
		fn,
		cursor.block,
		getOrCreateBindingLocation(program, fn, binding),
	);
}

/**
 * The brand marker binding gating a private member: the declaring class's
 * brand, carried on the entry so access from a nested class brand-checks
 * against the class that declared the member rather than the current one.
 */
function privateBrandBinding(_fn: IRFunction, entry: IRPrivateName): Binding | undefined {
	return entry.brandBinding;
}

/**
 * Brand-check a receiver against a private member's class. Reads the brand
 * marker through loadPrivate, which throws a TypeError when the receiver was
 * not branded by the declaring class. The loaded value is discarded.
 */
function emitPrivateBrandCheck(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	objectReg: number,
	entry: IRPrivateName,
) {
	const brand = privateBrandBinding(fn, entry);
	if (!brand) {
		return;
	}

	const brandSymbol = loadCapturedBinding(program, fn, cursor, brand);
	const discard = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "loadPrivate",
		registers: [discard, objectReg, brandSymbol],
	});
}

/**
 * Emit `throw new TypeError(message)`. Control transfers at the throw, so any
 * instructions the caller emits afterward are dead; the returned register is a
 * placeholder for expression-position callers.
 */
function emitThrowTypeError(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	message: string,
): number {
	const constructor = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "loadIntrinsic",
		registers: [constructor],
		intrinsic: "TypeError",
	});
	const messageRegister = compileStaticString(program, fn, cursor, message);
	const error = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "construct",
		registers: [error, constructor, messageRegister],
	});
	cursor.block.instructions.push({ type: "throw", registers: [error] });
	return error;
}

/**
 * Compile a private member read `obj.#x`: a direct slot read for fields, the
 * shared function for methods, or a brand-checked getter call for accessors.
 */
function compilePrivateMemberLoad(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	objectReg: number,
	name: string,
): number {
	const entry = fn.classContext?.privateNames?.get(name);
	if (!entry || objectReg === -1) {
		return -1;
	}

	if (entry.fieldBinding) {
		const symbol = loadCapturedBinding(program, fn, cursor, entry.fieldBinding);
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "loadPrivate",
			registers: [destination, objectReg, symbol],
		});
		return destination;
	}

	if (entry.methodBinding) {
		emitPrivateBrandCheck(program, fn, cursor, objectReg, entry);
		return loadCapturedBinding(program, fn, cursor, entry.methodBinding);
	}

	// Accessor: the brand marker gates access; a getter call yields the value.
	emitPrivateBrandCheck(program, fn, cursor, objectReg, entry);
	if (entry.getBinding) {
		const getter = loadCapturedBinding(program, fn, cursor, entry.getBinding);
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "call",
			registers: [destination, getter, objectReg],
		});
		return destination;
	}

	// Reading a set-only private accessor: PrivateGet throws after the brand
	// check confirms the receiver is in the class.
	return emitThrowTypeError(
		program,
		fn,
		cursor,
		`'${name}' was defined without a getter`,
	);
}

/**
 * Compile a private member write `obj.#x = v`: a slot write for fields or a
 * brand-checked setter call for accessors.
 */
function compilePrivateMemberStore(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	objectReg: number,
	name: string,
	valueReg: number,
) {
	const entry = fn.classContext?.privateNames?.get(name);
	if (!entry || objectReg === -1) {
		return;
	}

	if (entry.fieldBinding) {
		const symbol = loadCapturedBinding(program, fn, cursor, entry.fieldBinding);
		cursor.block.instructions.push({
			type: "storePrivate",
			registers: [objectReg, symbol, valueReg],
		});
		return;
	}

	emitPrivateBrandCheck(program, fn, cursor, objectReg, entry);
	if (entry.setBinding) {
		const setter = loadCapturedBinding(program, fn, cursor, entry.setBinding);
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "call",
			registers: [destination, setter, objectReg, valueReg],
		});
		return;
	}

	// Writing a private method or a get-only accessor: PrivateSet throws after
	// the brand check confirms the receiver is in the class.
	const reason = entry.methodBinding
		? "is not writable: it is a private method"
		: "was defined without a setter";
	emitThrowTypeError(program, fn, cursor, `'${name}' ${reason}`);
}

/**
 * Synthesize the default constructor: empty for base classes, forwarding all
 * arguments to the parent constructor on the same this for derived ones.
 */
function compileDefaultConstructor(
	program: IntermediateProgram,
	fn: IRFunction,
	superBinding: Binding | undefined,
	name: string,
	classContext: IRClassContext,
): number {
	const ctorFn: IRFunction = {
		semanticFile: fn.semanticFile,
		functionIndex: program.functions.length,
		nameStringIndex: getOrCreateStringConstant(program, name),
		blocks: [],
		classContext,
		// Class code is always strict.
		strict: true,

		parameterCount: 0,
		length: 0,
		nextRegisterDestination: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};
	program.functions.push(ctorFn);

	const block: IRBlock = { instructions: [] };
	ctorFn.blocks.push(block);
	const cursor: IRCursor = { block };

	if (superBinding) {
		const location = getOrCreateBindingLocation(program, ctorFn, superBinding);
		const parent = loadRegisterFromLocation(ctorFn, cursor.block, location);

		// `constructor(...args) { super(...args); }`: forward every argument to
		// the parent's [[Construct]] (with the active new.target) and bind the
		// result as `this`.
		const argumentsArray = nextRegisterDestination(ctorFn);
		cursor.block.instructions.push({
			type: "createRestArguments",
			registers: [argumentsArray],
			startIndex: 0,
		});

		const result = nextRegisterDestination(ctorFn);
		cursor.block.instructions.push({
			type: "constructSuper",
			registers: [result, parent, argumentsArray],
		});
	}

	// InitializeInstanceElements: a base default constructor installs at entry;
	// a derived one installs right after the synthesized super() returns.
	emitInstanceElementInit(program, ctorFn, cursor, classContext);

	endFunction(ctorFn);
	return ctorFn.functionIndex;
}

/**
 * Return 'undefined' from all blocks that don't unconditionally jump yet.
 */
function endFunction(fn: IRFunction) {
	for (const block of fn.blocks) {
		// TODO(opt): once optimized we can probably do with scanning the whole block, since there
		//  might be earlier returns happening.
		const lastInstruction = block.instructions.at(-1);
		if (
			lastInstruction?.type === "return" ||
			lastInstruction?.type === "jump" ||
			lastInstruction?.type === "throw"
		) {
			continue;
		}

		const destinationRegister = nextRegisterDestination(fn);
		block.instructions.push(
			{
				type: "createUndefined",
				registers: [destinationRegister],
			},
			{
				type: "return",
				registers: [destinationRegister],
			},
		);
	}
}

/**
 * A function's own strictness: its body scope's, which sema marks strict for a
 * `"use strict"` directive or by inheritance from strict surrounding code. A
 * block body carries that scope; an expression-bodied arrow (no directive
 * possible) inherits the enclosing strictness.
 */
function functionStrict(
	file: SemanticFile,
	node:
		| ESTree.FunctionDeclaration
		| ESTree.FunctionExpression
		| ESTree.ArrowFunctionExpression,
): boolean {
	if (node.body?.type === "BlockStatement") {
		const bodyScope = file.nodeToScope.get(node.body);
		if (bodyScope) {
			return bodyScope.strict;
		}
	}
	const bodyScope = node.body ? file.nodeToScope.get(node.body) : undefined;
	return bodyScope?.strict ?? file.strict;
}

/** Whether code in this function runs sloppy (non-strict). */
function isSloppyFunction(fn: IRFunction): boolean {
	return !(fn.strict ?? fn.semanticFile.strict);
}

/**
 * A global *script* top-level `var`/`function` binds a property of the global
 * object (spec: CreateGlobalVarBinding/CreateGlobalFunctionBinding) — observable
 * as `globalThis.x` — in BOTH strict and sloppy mode (GlobalDeclarationInstantiation
 * does not consult strictness here). `let`/`const`/`class` go to the global
 * declarative record (our flat slots), and a module's top-level bindings are
 * module-scoped (also flat slots), so both are excluded.
 */
function isScriptGlobalProperty(file: SemanticFile, binding: Binding): boolean {
	return (
		file.type === "script" &&
		(binding.kind === "var" || binding.declarationNode?.type === "FunctionDeclaration")
	);
}

/** `globalThis[name] = value` — a sloppy assignment to an unresolved name. */
function emitGlobalPropertyStore(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	name: string,
	value: number,
) {
	const global = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "loadIntrinsic",
		registers: [global],
		intrinsic: "globalThis",
	});
	const key = compileStaticString(program, fn, cursor, name);
	cursor.block.instructions.push({
		type: "storeProperty",
		registers: [global, key, value],
	});
}

/**
 * The Function.prototype.length value: formal parameters before the first
 * default or rest parameter.
 */
function computeFunctionLength(
	node:
		| ESTree.FunctionDeclaration
		| ESTree.FunctionExpression
		| ESTree.ArrowFunctionExpression,
) {
	let length = 0;
	for (const param of node.params) {
		if (param.type === "AssignmentPattern" || param.type === "RestElement") {
			break;
		}
		length++;
	}

	return length;
}

/**
 * Compile the parameter prelude block(s): the VM places arguments in the first
 * parameterCount registers, the prelude moves them into their binding
 * locations, running destructuring and default value logic on the way.
 *
 * Defaults branch, so the prelude can span multiple blocks. The caller patches
 * the returned cursor with the jump into the function body once that block
 * index is known.
 */
function compileFunctionParams(
	program: IntermediateProgram,
	fn: IRFunction,
	node:
		| ESTree.FunctionDeclaration
		| ESTree.FunctionExpression
		| ESTree.ArrowFunctionExpression,
): IRCursor {
	const block: IRBlock = {
		instructions: [],
	};
	fn.blocks.push(block);
	const cursor: IRCursor = { block };

	// Claim the pinned parameter registers up front: destructuring and default
	// expressions allocate registers of their own, so allocating per-parameter
	// inside the loop would break the [0..parameterCount) calling convention.
	const parameterRegisters = node.params.map(() => nextRegisterDestination(fn));

	// The arguments object snapshots the frame arguments, which parameter
	// initialization never mutates; creating it before the parameter logic
	// keeps it available to default value expressions.
	const argumentsBinding = getArgumentsBinding(fn, node);
	if (argumentsBinding && argumentsBinding.usageNodes.length > 0) {
		const destination = nextRegisterDestination(fn);
		fn.argumentsObjectRegister = destination;
		block.instructions.push({
			type: "createArgumentsObject",
			registers: [destination],
		});
	}

	// When a nested arrow captures this function's `this` lexically, semantic
	// analysis put an implicit `this` binding on this (non-arrow) function's scope.
	// Snapshot `this` into its captured slot at entry — before the body (and any
	// nested arrow) is compiled — so the slot's owner is this function and the
	// arrow's `loadCaptured` walks to it. (Arrows never own such a binding.)
	const thisBinding = getLexicalThisBinding(fn, node);
	if (thisBinding && thisBinding.scopedTo === "captured") {
		const thisRegister = nextRegisterDestination(fn);
		block.instructions.push({ type: "loadThis", registers: [thisRegister] });
		const location = getOrCreateBindingLocation(program, fn, thisBinding);
		storeRegisterAtLocation(block, location, thisRegister);
	}

	for (let i = 0; i < node.params.length; i++) {
		const param = node.params[i]!;

		if (param.type === "RestElement") {
			// The pinned register holds a stray positional argument; replace it
			// with the collected rest array.
			const rest = nextRegisterDestination(fn);
			cursor.block.instructions.push({
				type: "createRestArguments",
				registers: [rest],
				startIndex: i,
			});
			compilePatternTarget(program, fn, cursor, param.argument, rest);
			continue;
		}

		compilePatternTarget(program, fn, cursor, param, parameterRegisters[i]!);
	}

	return cursor;
}

/**
 * Initialize a destructuring target with the given value register. Handles
 * both binding patterns (parameters, declarations, catch) and assignment
 * patterns, where targets may also be member expressions.
 */
function compilePatternTarget(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	target: ESTree.Node,
	value: number,
	// Forwarded to the leaf: true for a destructuring *assignment* target (so a
	// const leaf throws), false for a binding initializer. See
	// compileStaticIdentifierTarget.
	isAssign = false,
) {
	switch (target.type) {
		case "Identifier": {
			compileIdentifierTarget(program, fn, cursor, target, value, isAssign);
			break;
		}
		case "MemberExpression": {
			const { object, key } = compileMemberObjectAndKey(program, fn, cursor, target);
			if (object === -1 || key === -1) {
				break;
			}
			cursor.block.instructions.push({
				type: "storeProperty",
				registers: [object, key, value],
			});
			break;
		}
		case "AssignmentPattern": {
			const resolved = target.right
				? compileDefaultedValue(
						program,
						fn,
						cursor,
						value,
						target.right,
						// NamedEvaluation: anonymous defaults take the target name.
						target.left.type === "Identifier" ? target.left.name : undefined,
					)
				: value;
			compilePatternTarget(program, fn, cursor, target.left, resolved, isAssign);
			break;
		}
		case "ObjectPattern": {
			compileObjectPatternTarget(program, fn, cursor, target, value, isAssign);
			break;
		}
		case "ArrayPattern": {
			compileArrayPatternTarget(program, fn, cursor, target, value, isAssign);
			break;
		}
		default:
			break;
	}
}

/**
 * Store a value register at an identifier target, with the same unresolvable
 * reference semantics as identifier assignment.
 */
function compileIdentifierTarget(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	identifier: ESTree.Identifier,
	value: number,
	isAssign = false,
) {
	if (fn.semanticFile.withDynamicNodes.has(identifier)) {
		compileWithDynamicWrite(program, fn, cursor, identifier, value, isAssign);
		return;
	}
	compileStaticIdentifierTarget(program, fn, cursor, identifier, value, isAssign);
}

/**
 * A `with`-intercepted write: if some active with-object provides the name, set
 * it there (withSet writes `true` to the found flag); otherwise fall back to the
 * static store.
 */
function compileWithDynamicWrite(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	identifier: ESTree.Identifier,
	value: number,
	isAssign = false,
) {
	const found = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "withSet",
		registers: [found, value],
		nameStringIndex: getOrCreateStringConstant(program, identifier.name),
	});

	const skipJump: Extract<IRInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [found],
		blocks: [-1],
	};
	const fallbackJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(skipJump, fallbackJump);

	const fallbackIdx = fn.blocks.push({ instructions: [] }) - 1;
	cursor.block = fn.blocks[fallbackIdx]!;
	compileStaticIdentifierTarget(program, fn, cursor, identifier, value, isAssign);
	const fallbackJoin: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(fallbackJoin);

	const joinIdx = fn.blocks.push({ instructions: [] }) - 1;
	skipJump.blocks[0] = joinIdx;
	fallbackJump.blocks[0] = fallbackIdx;
	fallbackJoin.blocks[0] = joinIdx;
	cursor.block = fn.blocks[joinIdx]!;
}

function compileStaticIdentifierTarget(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	identifier: ESTree.Identifier,
	value: number,
	// True when this identifier is an assignment target (a destructuring
	// *assignment*), false when it is a binding initializer (a declaration or
	// parameter pattern). Only an assignment to a const is a TypeError; the
	// initializer store that sets a const's value is legal.
	isAssign = false,
) {
	const binding = fn.semanticFile.nodeToBinding.get(identifier);
	if (!binding) {
		throw new Error(`No binding found for pattern target ${identifier.name}`);
	}

	if (isAssign && binding.kind === "const" && !binding.undeclared) {
		// Destructuring assignment to a const binding is a TypeError, matching the
		// plain-assignment path (PutValue → SetMutableBinding on an immutable
		// binding). The right-hand side / iterator steps have already run.
		emitThrowTypeError(program, fn, cursor, "Assignment to constant variable.");
		return;
	}

	if (binding.undeclared && !isIRIntrinsic(binding.name)) {
		if (isSloppyFunction(fn)) {
			// Sloppy assignment to an unresolved name creates/sets a global property.
			emitGlobalPropertyStore(program, fn, cursor, binding.name, value);
			return;
		}
		// Strict: PutValue on an unresolvable reference throws ReferenceError.
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "loadUndeclared",
			registers: [destination],
			nameStringIndex: getOrCreateStringConstant(program, binding.name),
		});
		return;
	}

	const location = getOrCreateBindingLocation(program, fn, binding);
	storeRegisterAtLocation(cursor.block, location, value);
}

/**
 * Resolve a default value: `target = expr` initializes from expr only when the
 * value is undefined. Same branch-and-join structure as ternaries.
 */
function compileDefaultedValue(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	value: number,
	defaultExpression: ESTree.Expression,
	nameHint?: string,
): number {
	const result = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "move",
		registers: [result, value],
	});

	const undefinedRegister = compileUndefined(fn, cursor);
	const condition = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "binary",
		registers: [condition, value, undefinedRegister],
		operator: "===",
	});

	const defaultJump: Extract<IRInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [condition],
		blocks: [-1],
	};
	const skipJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(defaultJump, skipJump);

	const defaultIdx = fn.blocks.push({ instructions: [] }) - 1;
	cursor.block = fn.blocks[defaultIdx]!;
	const defaultValue = compileExpression(
		program,
		fn,
		cursor,
		defaultExpression,
		nameHint,
	);
	cursor.block.instructions.push({
		type: "move",
		registers: [result, defaultValue],
	});
	const joinJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(joinJump);

	const joinIdx = fn.blocks.push({ instructions: [] }) - 1;
	defaultJump.blocks[0] = defaultIdx;
	skipJump.blocks[0] = joinIdx;
	joinJump.blocks[0] = joinIdx;
	cursor.block = fn.blocks[joinIdx]!;

	return result;
}

function compileObjectPatternTarget(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	pattern: ESTree.ObjectPattern,
	value: number,
	isAssign = false,
) {
	// Nil sources throw even when the pattern reads no properties.
	cursor.block.instructions.push({
		type: "requireCoercible",
		registers: [value],
	});

	// Keys consumed by earlier properties are excluded from the rest copy.
	const consumedKeys: Array<number> = [];

	for (const property of pattern.properties) {
		if (property.type === "RestElement" || property.type === "SpreadElement") {
			// Rest is last by grammar. The typings allow SpreadElement here,
			// both shapes carry the target in argument.
			const rest = nextRegisterDestination(fn);
			cursor.block.instructions.push({
				type: "copyDataProperties",
				registers: [rest, value, ...consumedKeys],
			});
			compilePatternTarget(program, fn, cursor, property.argument, rest, isAssign);
			continue;
		}

		if (property.type !== "Property") {
			continue;
		}

		const key = compilePropertyKey(program, fn, cursor, property);
		if (key === -1) {
			continue;
		}
		consumedKeys.push(key);

		const propertyValue = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "loadProperty",
			registers: [propertyValue, value, key],
		});
		compilePatternTarget(program, fn, cursor, property.value, propertyValue, isAssign);
	}
}

/**
 * Drain an iterator into array[index++] with a step loop. The loop-carried
 * registers survive the back edge because multi-block registers are never
 * freed by the allocator.
 */
function compileIteratorDrainInto(
	fn: IRFunction,
	cursor: IRCursor,
	array: number,
	index: number,
	one: number,
	iteratorRegister: number,
	nextRegister: number,
) {
	const headerIdx = fn.blocks.push({ instructions: [] }) - 1;
	cursor.block.instructions.push({
		type: "jump",
		blocks: [headerIdx],
	});

	const header = fn.blocks[headerIdx]!;
	const valueRegister = nextRegisterDestination(fn);
	const doneRegister = nextRegisterDestination(fn);
	header.instructions.push({
		type: "iteratorStep",
		registers: [valueRegister, doneRegister, iteratorRegister, nextRegister],
	});
	const exitJump: Extract<IRInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [doneRegister],
		blocks: [-1],
	};
	header.instructions.push(exitJump);

	const bodyIdx = fn.blocks.push({ instructions: [] }) - 1;
	header.instructions.push({
		type: "jump",
		blocks: [bodyIdx],
	});
	const body = fn.blocks[bodyIdx]!;
	body.instructions.push({
		type: "storeProperty",
		registers: [array, index, valueRegister],
	});
	// Increment in place: index is loop-carried.
	body.instructions.push({
		type: "binary",
		registers: [index, index, one],
		operator: "+",
	});
	body.instructions.push({
		type: "jump",
		blocks: [headerIdx],
	});

	const afterIdx = fn.blocks.push({ instructions: [] }) - 1;
	exitJump.blocks[0] = afterIdx;
	cursor.block = fn.blocks[afterIdx]!;
}

/**
 * Drain the rest of an iterator into a fresh array.
 */
function compileIteratorRest(
	fn: IRFunction,
	cursor: IRCursor,
	iteratorRegister: number,
	nextRegister: number,
): number {
	const rest = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createArray",
		registers: [rest],
		length: 0,
	});
	const index = compileNumberLiteral(fn, cursor, 0);
	const one = compileNumberLiteral(fn, cursor, 1);
	compileIteratorDrainInto(fn, cursor, rest, index, one, iteratorRegister, nextRegister);

	return rest;
}

function compileArrayPatternTarget(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	pattern: ESTree.ArrayPattern,
	value: number,
	isAssign = false,
) {
	// Spec-shaped: the source goes through GetIterator (nil and non-iterable
	// values throw TypeError), elements consume steps in order.
	const iteratorRegister = nextRegisterDestination(fn);
	const nextRegister = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "getIterator",
		registers: [iteratorRegister, nextRegister, value],
	});

	let lastDoneRegister = -1;
	for (const element of pattern.elements) {
		if (element?.type === "RestElement") {
			// Rest is last by grammar and exhausts the iterator: no close.
			const rest = compileIteratorRest(fn, cursor, iteratorRegister, nextRegister);
			compilePatternTarget(program, fn, cursor, element.argument, rest, isAssign);
			return;
		}

		// Holes consume a step without binding. An exhausted iterator steps
		// to undefined; the extra next() calls past done are a known
		// deviation from the spec's [[Done]] tracking (TODO(iterators)).
		const elementValue = nextRegisterDestination(fn);
		const doneRegister = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "iteratorStep",
			registers: [elementValue, doneRegister, iteratorRegister, nextRegister],
		});
		lastDoneRegister = doneRegister;

		if (element) {
			compilePatternTarget(program, fn, cursor, element, elementValue, isAssign);
		}
	}

	// IteratorClose when the pattern did not exhaust the iterator. With no
	// elements the iterator is trivially unexhausted; otherwise the last
	// step's done flag decides. Throws during element binding skip the close
	// (TODO(iterators): spec closes on abrupt completions too).
	if (lastDoneRegister === -1) {
		cursor.block.instructions.push({
			type: "iteratorClose",
			registers: [iteratorRegister],
			normal: true,
		});
		return;
	}

	const skipJump: Extract<IRInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [lastDoneRegister],
		blocks: [-1],
	};
	cursor.block.instructions.push(skipJump);

	const closeIdx = fn.blocks.push({ instructions: [] }) - 1;
	cursor.block.instructions.push({
		type: "jump",
		blocks: [closeIdx],
	});
	const joinJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	fn.blocks[closeIdx]!.instructions.push(
		{
			type: "iteratorClose",
			registers: [iteratorRegister],
			normal: true,
		},
		joinJump,
	);

	const joinIdx = fn.blocks.push({ instructions: [] }) - 1;
	skipJump.blocks[0] = joinIdx;
	joinJump.blocks[0] = joinIdx;
	cursor.block = fn.blocks[joinIdx]!;
}

/**
 * Compile any list of statements in to an IR block.
 *
 * It adds the block to the function and returns the block index.
 */
function compileStatementsToBlock(
	program: IntermediateProgram,
	fn: IRFunction,
	statements: Array<ESTree.Statement>,
	/**
	 * Hoist top-level function declarations in this list to the start of the
	 * block, matching FunctionDeclarationInstantiation / GlobalDeclarationInstantiation:
	 * the function object is created and bound before any other statement runs, so
	 * code may call (or otherwise reference) the function before its textual position.
	 *
	 * Only set for function bodies, program/module bodies and class static blocks -
	 * the lists where a function declaration is function/global-scoped in both strict
	 * and sloppy mode. Nested blocks keep textual-position emission: there a sloppy
	 * declaration's binding is hoisted to the enclosing function scope (Annex B) and
	 * must not be assigned at block entry.
	 */
	hoistFunctions = false,
): number {
	let block: IRBlock = {
		instructions: [],
	};
	// Store the first block index so we can return that to allow jumping to that block.
	const blockIdx = fn.blocks.push(block) - 1;

	// Hoisting pre-pass: bind every top-level function declaration up front so the
	// loop below can skip re-emitting them at their textual position.
	const hoistedDeclarations = new Set<ESTree.Node>();
	if (hoistFunctions) {
		// Reserve this function's own captured-binding slots before compiling any
		// hoisted function body. getOrCreateBindingLocation charges a captured slot
		// to whichever IR function first *requests* it; hoisting lets a nested
		// closure's body run before the owning declaration, so without this the
		// closure would wrongly claim ownership (wrong owner functionIndex + slot)
		// of a binding that actually lives in this activation. Touching them here
		// makes `fn` the owner, and the nested closure then resolves to that slot.
		for (const statement of statements) {
			const scope = fn.semanticFile.nodeToScope.get(statement);
			if (!scope) {
				continue;
			}
			// A FunctionDeclaration/ClassDeclaration node maps to its *own* scope,
			// so step up to the containing scope to reach this function's bindings.
			const ownerScope = scope.node === statement ? scope.parent : scope;
			for (const binding of ownerScope?.bindings ?? []) {
				if (binding.scopedTo === "captured") {
					getOrCreateBindingLocation(program, fn, binding);
				}
			}
			break;
		}

		for (const statement of statements) {
			const declaration =
				statement.type === "FunctionDeclaration"
					? statement
					: statement.type === "ExportNamedDeclaration" &&
						  statement.declaration?.type === "FunctionDeclaration"
						? statement.declaration
						: undefined;
			if (declaration) {
				compileFunctionDeclaration(program, fn, block, declaration);
				hoistedDeclarations.add(declaration);
			}
		}
	}

	for (const statement of statements) {
		const lastBlock = fn.blocks.at(-1);
		if (lastBlock !== block) {
			// Any statement may create new blocks. The following logic detects this and starts a new
			// block. It patches up all intermediate blocks to resume control after the statement.
			//
			// For example, with an if-statement:
			//
			// ```
			// BLOCK:
			//   createNumber 1 in reg1
			//   jumpIf reg1 BLOCK2
			// BLOCK2:
			//   call somefn
			//   jump BLOCK3  <-- This is added.
			// BLOCK3:
			//   ...
			// ```
			//
			// Blocks may add other nested blocks that are jumped between. So we may add unnecessary jump
			// instructions to them. We optimize these out later.
			const lastBlockIdx = fn.blocks.indexOf(block);

			block = {
				instructions: [],
			};

			const jumpTarget = fn.blocks.push(block) - 1;
			// Unconditionally add the jump. In a later pass we can optimize these jumps out.
			for (let i = lastBlockIdx + 1; i < jumpTarget; i++) {
				fn.blocks[i]!.instructions.push({
					type: "jump",
					blocks: [jumpTarget],
				});
			}
		}

		// Statement-granularity debug position: every following instruction (until
		// the next statement's marker) is attributed to this statement's line for
		// stack traces. Lowering strips these markers from the bytecode.
		emitSourcePos(program, block, statement);

		switch (statement.type) {
			case "ExpressionStatement": {
				compileExpressionStatement(program, fn, block, statement);
				break;
			}
			case "FunctionDeclaration": {
				if (!hoistedDeclarations.has(statement)) {
					compileFunctionDeclaration(program, fn, block, statement);
				}
				break;
			}
			case "IfStatement": {
				compileIfStatement(program, fn, block, statement);
				break;
			}
			case "ReturnStatement": {
				compileReturnStatement(program, fn, block, statement);
				break;
			}
			case "ThrowStatement": {
				compileThrowStatement(program, fn, block, statement);
				break;
			}
			case "TryStatement": {
				compileTryStatement(program, fn, block, statement);
				break;
			}
			case "SwitchStatement": {
				compileSwitchStatement(program, fn, block, statement);
				break;
			}
			case "WhileStatement": {
				compileWhileStatement(program, fn, block, statement);
				break;
			}
			case "DoWhileStatement": {
				compileDoWhileStatement(program, fn, block, statement);
				break;
			}
			case "ForStatement": {
				compileForStatement(program, fn, block, statement);
				break;
			}
			case "ForOfStatement": {
				compileForOfStatement(program, fn, block, statement);
				break;
			}
			case "ForInStatement": {
				compileForInStatement(program, fn, block, statement);
				break;
			}
			case "BreakStatement": {
				compileBreakStatement(fn, block, statement);
				break;
			}
			case "ContinueStatement": {
				compileContinueStatement(fn, block, statement);
				break;
			}
			case "VariableDeclaration": {
				compileVariableDeclaration(program, fn, block, statement);
				break;
			}
			case "ClassDeclaration": {
				compileClassDeclaration(program, fn, block, statement);
				break;
			}
			case "BlockStatement": {
				compileBlockStatement(program, fn, block, statement);
				break;
			}
			case "WithStatement": {
				compileWithStatement(program, fn, block, statement);
				break;
			}
			case "LabeledStatement": {
				compileLabeledStatement(program, fn, block, statement);
				break;
			}
			case "ImportDeclaration": {
				// No value-level code: import bindings are aliased to their exporters
				// during linking, and the imported module's init runs via the
				// multi-module orchestrator.
				break;
			}
			case "ExportNamedDeclaration": {
				// `export const/function/class` compiles its inner declaration; the
				// export name itself is link-time metadata. `export { ... }` and
				// `export { ... } from "m"` emit no value-level code.
				const declaration = statement.declaration;
				if (declaration?.type === "VariableDeclaration") {
					compileVariableDeclaration(program, fn, block, declaration);
				} else if (declaration?.type === "FunctionDeclaration") {
					if (!hoistedDeclarations.has(declaration)) {
						compileFunctionDeclaration(program, fn, block, declaration);
					}
				} else if (declaration?.type === "ClassDeclaration") {
					compileClassDeclaration(program, fn, block, declaration);
				}
				break;
			}
			case "ExportDefaultDeclaration": {
				compileExportDefault(program, fn, block, statement);
				break;
			}
			case "ExportAllDeclaration": {
				// `export * from "m"` is link-time only; m's init runs via the orchestrator.
				break;
			}
		}
	}

	// Join any dangling blocks left by the final statement into a single tail
	// block, so callers (loops, if/try, the function epilogue) see one exit.
	// The per-statement patch above only joins when a *following* statement is
	// compiled; a statement list ending in an if/loop/try would otherwise leave
	// several un-terminated blocks. In a loop body that meant the if-consequent
	// fell through to the after-loop block instead of the update.
	if (fn.blocks.at(-1) !== block) {
		const lastBlockIdx = fn.blocks.indexOf(block);
		block = { instructions: [] };
		const jumpTarget = fn.blocks.push(block) - 1;
		for (let i = lastBlockIdx + 1; i < jumpTarget; i++) {
			fn.blocks[i]!.instructions.push({
				type: "jump",
				blocks: [jumpTarget],
			});
		}
	}

	return blockIdx;
}

function compileClassDeclaration(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.ClassDeclaration,
) {
	const binding = fn.semanticFile.nodeToBinding.get(statement);
	if (!binding) {
		return;
	}

	const cursor: IRCursor = { block };
	const ctor = compileClass(program, fn, cursor, statement);
	if (ctor === -1) {
		return;
	}

	const location = getOrCreateBindingLocation(program, fn, binding);
	storeRegisterAtLocation(cursor.block, location, ctor);
}

/**
 * Compile an `export default`. A *named* default function/class binds its name
 * normally and the default export resolves to that binding (handled by the
 * linker), so it compiles as an ordinary declaration. An anonymous function or
 * class, or an arbitrary expression, has its value stored into the module's
 * synthetic default binding (created by the linker).
 */
function compileExportDefault(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.ExportDefaultDeclaration,
) {
	const declaration = statement.declaration;

	if (declaration.type === "FunctionDeclaration" && declaration.id) {
		compileFunctionDeclaration(program, fn, block, declaration);
		return;
	}
	if (declaration.type === "ClassDeclaration" && declaration.id) {
		compileClassDeclaration(program, fn, block, declaration);
		return;
	}

	const cursor: IRCursor = { block };
	let value: number;
	if (declaration.type === "FunctionDeclaration") {
		const functionIndex = compileNewFunctionExpression(
			program,
			fn,
			declaration as unknown as ESTree.FunctionExpression,
			undefined,
			"default",
		);
		value = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "createFunction",
			registers: [value],
			functionIndex,
		});
	} else if (declaration.type === "ClassDeclaration") {
		value = compileClass(program, fn, cursor, declaration, "default");
	} else {
		value = compileExpression(
			program,
			fn,
			cursor,
			declaration as ESTree.Expression,
			"default",
		);
	}

	const binding = program.moduleDefaultBinding.get(fn.semanticFile.path);
	if (binding) {
		const location = getOrCreateBindingLocation(program, fn, binding);
		storeRegisterAtLocation(cursor.block, location, value);
	}
}

function compileExpressionStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.ExpressionStatement,
) {
	compileExpression(program, fn, { block }, statement.expression);
}

function compileFunctionDeclaration(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.FunctionDeclaration,
) {
	const binding = fn.semanticFile.nodeToBinding.get(statement);
	if (!binding) {
		return;
	}

	if (
		binding.usageNodes.length === 0 ||
		(binding.usageNodes.length === 1 &&
			(binding.usageNodes[0] === statement || binding.usageNodes[0] === statement.id))
	) {
		// Function is only used in its declaration, so we can skip it.
		return;
	}

	const fnIndex = compileNewFunction(program, binding, statement);
	const location = getOrCreateBindingLocation(program, fn, binding);

	const destination = nextRegisterDestination(fn);
	block.instructions.push({
		type: "createFunction",
		registers: [destination],

		functionIndex: fnIndex,
	});

	storeRegisterAtLocation(block, location, destination);
}

/**
 * Compile a switch statement: the discriminant and case tests stay in the
 * entry block chain, the case bodies are compiled in source order as
 * fall-through blocks, and break jumps are patched to the exit.
 */
function compileSwitchStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.SwitchStatement,
) {
	const switchContext: IRLoopContext = {
		kind: "switch",
		breakJumps: [],
		continueJumps: [],
		labels: takePendingLabels(fn),
	};
	(fn.loops ??= []).push(switchContext);

	const cursor: IRCursor = { block };
	const discriminant = compileExpression(program, fn, cursor, statement.discriminant);

	// Case bodies first, chained for fall-through, so the dispatch tests can
	// reference their block indexes.
	const bodyStarts: Array<number> = [];
	let previousTail: IRBlock | undefined;
	for (const switchCase of statement.cases) {
		const start = compileStatementsToBlock(program, fn, switchCase.consequent);
		if (previousTail) {
			previousTail.instructions.push({
				type: "jump",
				blocks: [start],
			});
		}

		bodyStarts.push(start);
		previousTail = fn.blocks.at(-1)!;
	}

	// The last body and the all-misses path both continue at the exit.
	const lastBodyExitJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	previousTail?.instructions.push(lastBodyExitJump);

	let defaultCase = -1;
	for (let i = 0; i < statement.cases.length; i++) {
		const switchCase = statement.cases[i]!;
		if (!switchCase.test) {
			defaultCase = i;
			continue;
		}

		const test = compileExpression(program, fn, cursor, switchCase.test);
		const matches = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "binary",
			registers: [matches, discriminant, test],
			operator: "===",
		});
		cursor.block.instructions.push({
			type: "jumpIf",
			registers: [matches],
			blocks: [bodyStarts[i]!],
		});
	}

	const missJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [defaultCase >= 0 ? bodyStarts[defaultCase]! : -1],
	};
	cursor.block.instructions.push(missJump);

	const exitIdx = fn.blocks.push({ instructions: [] }) - 1;
	lastBodyExitJump.blocks[0] = exitIdx;
	if (defaultCase < 0) {
		missJump.blocks[0] = exitIdx;
	}
	for (const jump of switchContext.breakJumps) {
		jump.blocks[0] = exitIdx;
	}
	fn.loops.pop();
}

/**
 * Compile a while loop: jump into a header block that evaluates the
 * condition, conditionally enters the body, and falls through to the exit.
 */
function compileWhileStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.WhileStatement,
) {
	const headerIdx = fn.blocks.push({ instructions: [] }) - 1;
	block.instructions.push({
		type: "jump",
		blocks: [headerIdx],
	});

	const loop: IRLoopContext = {
		kind: "loop",
		breakJumps: [],
		continueJumps: [],
		labels: takePendingLabels(fn),
	};
	(fn.loops ??= []).push(loop);

	const headerCursor: IRCursor = { block: fn.blocks[headerIdx]! };
	const condition = compileExpression(program, fn, headerCursor, statement.test);

	const bodyIdx = compileStatementsToBlock(
		program,
		fn,
		normalizeStatementOrBlock(statement.body),
	);
	headerCursor.block.instructions.push({
		type: "jumpIf",
		registers: [condition],
		blocks: [bodyIdx],
	});
	const exitJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		// Patched below, once the exit block exists.
		blocks: [-1],
	};
	headerCursor.block.instructions.push(exitJump);

	// Back edge from the body tail to the condition.
	fn.blocks.at(-1)!.instructions.push({
		type: "jump",
		blocks: [headerIdx],
	});

	const exitIdx = fn.blocks.push({ instructions: [] }) - 1;
	exitJump.blocks[0] = exitIdx;
	for (const jump of loop.breakJumps) {
		jump.blocks[0] = exitIdx;
	}
	for (const jump of loop.continueJumps) {
		jump.blocks[0] = headerIdx;
	}
	fn.loops.pop();
}

/**
 * Compile a do-while loop: the body runs first, the condition block at the
 * bottom decides on re-entry.
 */
function compileDoWhileStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.DoWhileStatement,
) {
	const loop: IRLoopContext = {
		kind: "loop",
		breakJumps: [],
		continueJumps: [],
		labels: takePendingLabels(fn),
	};
	(fn.loops ??= []).push(loop);

	const bodyIdx = compileStatementsToBlock(
		program,
		fn,
		normalizeStatementOrBlock(statement.body),
	);
	block.instructions.push({
		type: "jump",
		blocks: [bodyIdx],
	});

	const bodyLastBlock = fn.blocks.at(-1)!;
	const conditionIdx = fn.blocks.push({ instructions: [] }) - 1;
	bodyLastBlock.instructions.push({
		type: "jump",
		blocks: [conditionIdx],
	});

	const conditionCursor: IRCursor = { block: fn.blocks[conditionIdx]! };
	const condition = compileExpression(program, fn, conditionCursor, statement.test);
	conditionCursor.block.instructions.push({
		type: "jumpIf",
		registers: [condition],
		blocks: [bodyIdx],
	});
	const exitJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	conditionCursor.block.instructions.push(exitJump);

	const exitIdx = fn.blocks.push({ instructions: [] }) - 1;
	exitJump.blocks[0] = exitIdx;
	for (const jump of loop.breakJumps) {
		jump.blocks[0] = exitIdx;
	}
	for (const jump of loop.continueJumps) {
		jump.blocks[0] = conditionIdx;
	}
	fn.loops.pop();
}

/**
 * If a loop's lexical head bindings (its for-head `let`/`const`) are captured by a
 * closure, they need a fresh per-iteration environment (CreatePerIterationEnvironment)
 * so each closure observes its own binding. Move those bindings into a synthetic
 * capture scope (a negative env id that never collides with a function index) and
 * return its id + slot count; the loop lowering emits the ENV_PUSH/COPY/POP ops.
 * Returns null when no head binding is captured (the common case — zero overhead).
 */
function setupPerIterationScope(
	program: IntermediateProgram,
	fn: IRFunction,
	loopNode: ESTree.Node,
): { scopeId: number; slotCount: number } | null {
	const scope = fn.semanticFile.nodeToScope.get(loopNode);
	if (!scope) {
		return null;
	}
	const captured = scope.bindings.filter((binding) => binding.scopedTo === "captured");
	if (captured.length === 0) {
		return null;
	}
	const scopeId = program.nextLoopScopeId--;
	captured.forEach((binding, index) => {
		program.bindingToStorage.set(binding, {
			type: "captured",
			functionIndex: scopeId,
			index,
		});
	});
	return { scopeId, slotCount: captured.length };
}

/**
 * Compile a classic for loop: init runs once, then it behaves like a while
 * loop with the update block as the continue target.
 */
function compileForStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.ForStatement,
) {
	// Per-iteration env, if the head bindings are captured. ENV_PUSH enters scope
	// L0 (so the init stores into it), ENV_COPY before the first test copies L0→L1,
	// each update copies Li→Li+1 (the increment runs in the new env), and ENV_POP
	// restores the enclosing env on exit. Set up before the init compiles so the
	// head bindings resolve to the scope env.
	const perIter = setupPerIterationScope(program, fn, statement);
	if (perIter) {
		block.instructions.push({
			type: "envPush",
			scopeId: perIter.scopeId,
			slotCount: perIter.slotCount,
		});
	}

	const initCursor: IRCursor = { block };
	if (statement.init?.type === "VariableDeclaration") {
		compileVariableDeclaration(program, fn, block, statement.init);
		// The declaration manages its own cursor; re-resolve the tail block.
		initCursor.block = fn.blocks.at(-1) === block ? block : fn.blocks.at(-1)!;
	} else if (statement.init) {
		compileExpression(program, fn, initCursor, statement.init);
	}

	if (perIter) {
		initCursor.block.instructions.push({
			type: "envCopy",
			scopeId: perIter.scopeId,
			slotCount: perIter.slotCount,
		});
	}

	const headerIdx = fn.blocks.push({ instructions: [] }) - 1;
	initCursor.block.instructions.push({
		type: "jump",
		blocks: [headerIdx],
	});

	const loop: IRLoopContext = {
		kind: "loop",
		breakJumps: [],
		continueJumps: [],
		labels: takePendingLabels(fn),
		perIterationScopeId: perIter?.scopeId,
		perIterationSlotCount: perIter?.slotCount,
	};
	(fn.loops ??= []).push(loop);

	const headerCursor: IRCursor = { block: fn.blocks[headerIdx]! };
	let condition: number;
	if (statement.test) {
		condition = compileExpression(program, fn, headerCursor, statement.test);
	} else {
		condition = nextRegisterDestination(fn);
		headerCursor.block.instructions.push({
			type: "createBoolean",
			registers: [condition],
			value: true,
		});
	}

	const bodyIdx = compileStatementsToBlock(
		program,
		fn,
		normalizeStatementOrBlock(statement.body),
	);
	headerCursor.block.instructions.push({
		type: "jumpIf",
		registers: [condition],
		blocks: [bodyIdx],
	});
	const exitJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	headerCursor.block.instructions.push(exitJump);

	// The update block is the continue target and closes the back edge.
	const bodyLastBlock = fn.blocks.at(-1)!;
	const updateIdx = fn.blocks.push({ instructions: [] }) - 1;
	bodyLastBlock.instructions.push({
		type: "jump",
		blocks: [updateIdx],
	});

	const updateCursor: IRCursor = { block: fn.blocks[updateIdx]! };
	// CreatePerIterationEnvironment: copy the bindings forward (Li→Li+1) before the
	// increment, so the increment and next test/body run in the fresh env.
	if (perIter) {
		updateCursor.block.instructions.push({
			type: "envCopy",
			scopeId: perIter.scopeId,
			slotCount: perIter.slotCount,
		});
	}
	if (statement.update) {
		compileExpression(program, fn, updateCursor, statement.update);
	}
	updateCursor.block.instructions.push({
		type: "jump",
		blocks: [headerIdx],
	});

	const exitIdx = fn.blocks.push({ instructions: [] }) - 1;
	// The exit block runs ENV_POP for the normal (test-false) exit and for any break
	// targeting this loop (both jump here). A break/continue crossing this loop to an
	// outer target instead pops via emitBreak/emitContinue.
	if (perIter) {
		fn.blocks[exitIdx]!.instructions.push({ type: "envPop" });
	}
	exitJump.blocks[0] = exitIdx;
	for (const jump of loop.breakJumps) {
		jump.blocks[0] = exitIdx;
	}
	for (const jump of loop.continueJumps) {
		jump.blocks[0] = updateIdx;
	}
	fn.loops.pop();
}

/**
 * Compile for-of: GetIterator over the right side, a step header, and a
 * protected binding+body region whose handler closes the iterator before
 * rethrowing. break/return close through the loop context; continue jumps
 * straight back to the step header (no close, per spec).
 */
function compileForOfStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.ForOfStatement,
) {
	const entryCursor: IRCursor = { block };
	const iterable = compileExpression(program, fn, entryCursor, statement.right);
	if (iterable === -1) {
		return;
	}

	const perIter = setupPerIterationScope(program, fn, statement);
	if (statement.await) {
		compileForAwaitOfLoop(
			program,
			fn,
			entryCursor,
			iterable,
			statement.left,
			statement.body,
			perIter,
		);
	} else {
		compileForInOfLoop(
			program,
			fn,
			entryCursor,
			iterable,
			statement.left,
			statement.body,
			perIter,
		);
	}
}

/**
 * for-in reuses the iterator-driven loop: a runtime op collects the source's
 * enumerable property keys into an array, which is then iterated like any other
 * iterable. for-in over null/undefined yields an empty key list (no iteration)
 * rather than throwing, which the key-collection op handles.
 */
function compileForInStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.ForInStatement,
) {
	const entryCursor: IRCursor = { block };
	const source = compileExpression(program, fn, entryCursor, statement.right);
	if (source === -1) {
		return;
	}

	const keys = nextRegisterDestination(fn);
	entryCursor.block.instructions.push({
		type: "forInKeys",
		registers: [keys, source],
	});

	const perIter = setupPerIterationScope(program, fn, statement);
	compileForInOfLoop(
		program,
		fn,
		entryCursor,
		keys,
		statement.left,
		statement.body,
		perIter,
	);
}

/**
 * The shared body of for-of and for-in: drive an iterable through the iterator
 * protocol, binding each value to the loop target and running the body inside a
 * protected range that closes the iterator on a throw.
 */
function compileForInOfLoop(
	program: IntermediateProgram,
	fn: IRFunction,
	entryCursor: IRCursor,
	iterable: number,
	left: ESTree.ForOfStatement["left"],
	body: ESTree.Statement,
	perIter: { scopeId: number; slotCount: number } | null,
) {
	const labels = takePendingLabels(fn);
	const iteratorRegister = nextRegisterDestination(fn);
	const nextRegister = nextRegisterDestination(fn);
	entryCursor.block.instructions.push({
		type: "getIterator",
		registers: [iteratorRegister, nextRegister, iterable],
	});

	// Enter the per-iteration scope (each iteration rebinds the loop variable into
	// a fresh env via the ENV_COPY in the bind block below).
	if (perIter) {
		entryCursor.block.instructions.push({
			type: "envPush",
			scopeId: perIter.scopeId,
			slotCount: perIter.slotCount,
		});
	}

	const headerIdx = fn.blocks.push({ instructions: [] }) - 1;
	entryCursor.block.instructions.push({
		type: "jump",
		blocks: [headerIdx],
	});

	const loop: IRLoopContext = {
		kind: "loop",
		breakJumps: [],
		continueJumps: [],
		iteratorRegister,
		labels,
		perIterationScopeId: perIter?.scopeId,
		perIterationSlotCount: perIter?.slotCount,
	};
	(fn.loops ??= []).push(loop);

	const header = fn.blocks[headerIdx]!;
	const valueRegister = nextRegisterDestination(fn);
	const doneRegister = nextRegisterDestination(fn);
	header.instructions.push({
		type: "iteratorStep",
		registers: [valueRegister, doneRegister, iteratorRegister, nextRegister],
	});
	const exitJump: Extract<IRInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [doneRegister],
		// Patched below, once the exit block exists.
		blocks: [-1],
	};
	header.instructions.push(exitJump);

	// Binding and body run inside a protected range; a throw closes the
	// iterator and propagates. The step itself stays unprotected, as specced.
	const bindBlock: IRBlock = { instructions: [] };
	const bindIdx = fn.blocks.push(bindBlock) - 1;
	header.instructions.push({
		type: "jump",
		blocks: [bindIdx],
	});

	// A fresh per-iteration env (each iteration rebinds the loop variable into it);
	// continue re-enters via the header, so this re-runs each iteration. The copy
	// carries nothing meaningful forward — the pattern bind below overwrites it.
	if (perIter) {
		bindBlock.instructions.push({
			type: "envCopy",
			scopeId: perIter.scopeId,
			slotCount: perIter.slotCount,
		});
	}

	const tryBegin: Extract<IRInstruction, { type: "tryBegin" }> = {
		type: "tryBegin",
		// Patched below: [handler, end].
		blocks: [-1, -1],
	};
	bindBlock.instructions.push(tryBegin);

	const bindCursor: IRCursor = { block: bindBlock };
	if (left.type === "VariableDeclaration") {
		const declaration = left.declarations[0];
		if (declaration) {
			compilePatternTarget(program, fn, bindCursor, declaration.id, valueRegister);
		}
	} else {
		compilePatternTarget(program, fn, bindCursor, left, valueRegister, true);
	}

	const bodyIdx = compileStatementsToBlock(program, fn, normalizeStatementOrBlock(body));
	bindCursor.block.instructions.push({
		type: "jump",
		blocks: [bodyIdx],
	});

	// The protected range ends before the back edge.
	const bodyLastBlock = fn.blocks.at(-1)!;
	const backIdx =
		fn.blocks.push({
			instructions: [{ type: "tryEnd" }, { type: "jump", blocks: [headerIdx] }],
		}) - 1;
	bodyLastBlock.instructions.push({
		type: "jump",
		blocks: [backIdx],
	});
	tryBegin.blocks[1] = backIdx;

	// Handler: close the iterator, rethrow the original completion.
	const handlerBlock: IRBlock = { instructions: [] };
	tryBegin.blocks[0] = fn.blocks.push(handlerBlock) - 1;
	const caughtRegister = nextRegisterDestination(fn);
	handlerBlock.instructions.push({
		type: "catch",
		registers: [caughtRegister],
	});
	handlerBlock.instructions.push({
		type: "iteratorClose",
		registers: [iteratorRegister],
	});
	handlerBlock.instructions.push({
		type: "throw",
		registers: [caughtRegister],
	});

	const exitIdx = fn.blocks.push({ instructions: [] }) - 1;
	// Restore the enclosing env on the normal (done) exit and on any break targeting
	// this loop (both jump here). The throw handler above does not pop: a rethrow
	// unwinds the frame (or is caught in an outer scope, where the per-iteration
	// env's parent chain still resolves correctly).
	if (perIter) {
		fn.blocks[exitIdx]!.instructions.push({ type: "envPop" });
	}
	exitJump.blocks[0] = exitIdx;
	for (const jump of loop.breakJumps) {
		jump.blocks[0] = exitIdx;
	}
	for (const jump of loop.continueJumps) {
		jump.blocks[0] = headerIdx;
	}
	fn.loops.pop();
}

/**
 * for-await-of: like for-of, but the source is obtained as an async iterator
 * (@@asyncIterator, or the sync iterator wrapped) and each step's next() result
 * is awaited before unpacking { value, done }. Only valid inside an async
 * function/generator. Structurally mirrors compileForInOfLoop; the difference
 * is the async-iterator get and the await-driven header step.
 */
function compileForAwaitOfLoop(
	program: IntermediateProgram,
	fn: IRFunction,
	entryCursor: IRCursor,
	iterable: number,
	left: ESTree.ForOfStatement["left"],
	body: ESTree.Statement,
	perIter: { scopeId: number; slotCount: number } | null,
) {
	const labels = takePendingLabels(fn);
	const iteratorRegister = nextRegisterDestination(fn);
	const nextRegister = nextRegisterDestination(fn);
	entryCursor.block.instructions.push({
		type: "getAsyncIterator",
		registers: [iteratorRegister, nextRegister, iterable],
	});

	if (perIter) {
		entryCursor.block.instructions.push({
			type: "envPush",
			scopeId: perIter.scopeId,
			slotCount: perIter.slotCount,
		});
	}

	const headerIdx = fn.blocks.push({ instructions: [] }) - 1;
	entryCursor.block.instructions.push({ type: "jump", blocks: [headerIdx] });

	const loop: IRLoopContext = {
		kind: "loop",
		breakJumps: [],
		continueJumps: [],
		iteratorRegister,
		labels,
		perIterationScopeId: perIter?.scopeId,
		perIterationSlotCount: perIter?.slotCount,
	};
	(fn.loops ??= []).push(loop);

	// Header: raw = next.call(iterator); result = await raw; unpack done/value.
	// The await splits the header — emitResumeDispatch moves the cursor onto a
	// continuation block, where the unpack and exit test live.
	const headerCursor: IRCursor = { block: fn.blocks[headerIdx]! };
	const rawRegister = nextRegisterDestination(fn);
	headerCursor.block.instructions.push({
		type: "iteratorNext",
		registers: [rawRegister, iteratorRegister, nextRegister],
	});
	const resultRegister = compileAwaitRegister(fn, headerCursor, rawRegister);

	const doneRegister = nextRegisterDestination(fn);
	const doneKey = nextRegisterDestination(fn);
	headerCursor.block.instructions.push({
		type: "createString",
		registers: [doneKey],
		stringIndex: getOrCreateStringConstant(program, "done"),
	});
	headerCursor.block.instructions.push({
		type: "loadProperty",
		registers: [doneRegister, resultRegister, doneKey],
	});
	const exitJump: Extract<IRInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [doneRegister],
		blocks: [-1],
	};
	headerCursor.block.instructions.push(exitJump);

	const valueRegister = nextRegisterDestination(fn);
	const valueKey = nextRegisterDestination(fn);
	headerCursor.block.instructions.push({
		type: "createString",
		registers: [valueKey],
		stringIndex: getOrCreateStringConstant(program, "value"),
	});
	headerCursor.block.instructions.push({
		type: "loadProperty",
		registers: [valueRegister, resultRegister, valueKey],
	});

	// Binding and body run inside a protected range; a throw closes the iterator.
	const bindBlock: IRBlock = { instructions: [] };
	const bindIdx = fn.blocks.push(bindBlock) - 1;
	headerCursor.block.instructions.push({ type: "jump", blocks: [bindIdx] });

	if (perIter) {
		bindBlock.instructions.push({
			type: "envCopy",
			scopeId: perIter.scopeId,
			slotCount: perIter.slotCount,
		});
	}

	const tryBegin: Extract<IRInstruction, { type: "tryBegin" }> = {
		type: "tryBegin",
		blocks: [-1, -1],
	};
	bindBlock.instructions.push(tryBegin);

	const bindCursor: IRCursor = { block: bindBlock };
	if (left.type === "VariableDeclaration") {
		const declaration = left.declarations[0];
		if (declaration) {
			compilePatternTarget(program, fn, bindCursor, declaration.id, valueRegister);
		}
	} else {
		compilePatternTarget(program, fn, bindCursor, left, valueRegister, true);
	}

	const bodyIdx = compileStatementsToBlock(program, fn, normalizeStatementOrBlock(body));
	bindCursor.block.instructions.push({ type: "jump", blocks: [bodyIdx] });

	const bodyLastBlock = fn.blocks.at(-1)!;
	const backIdx =
		fn.blocks.push({
			instructions: [{ type: "tryEnd" }, { type: "jump", blocks: [headerIdx] }],
		}) - 1;
	bodyLastBlock.instructions.push({ type: "jump", blocks: [backIdx] });
	tryBegin.blocks[1] = backIdx;

	// Handler: close the iterator (sync return; an async return-await is a known
	// deviation), rethrow the original completion.
	const handlerBlock: IRBlock = { instructions: [] };
	tryBegin.blocks[0] = fn.blocks.push(handlerBlock) - 1;
	const caughtRegister = nextRegisterDestination(fn);
	handlerBlock.instructions.push({ type: "catch", registers: [caughtRegister] });
	handlerBlock.instructions.push({
		type: "iteratorClose",
		registers: [iteratorRegister],
	});
	handlerBlock.instructions.push({ type: "throw", registers: [caughtRegister] });

	const exitIdx = fn.blocks.push({ instructions: [] }) - 1;
	if (perIter) {
		fn.blocks[exitIdx]!.instructions.push({ type: "envPop" });
	}
	exitJump.blocks[0] = exitIdx;
	for (const jump of loop.breakJumps) {
		jump.blocks[0] = exitIdx;
	}
	for (const jump of loop.continueJumps) {
		jump.blocks[0] = headerIdx;
	}
	fn.loops.pop();
}

/**
 * Consume the labels a LabeledStatement stashed for the loop/switch it
 * immediately precedes, clearing them so nested statements don't inherit them.
 */
function takePendingLabels(fn: IRFunction): Set<string> | undefined {
	const labels = fn.pendingLabels;
	fn.pendingLabels = undefined;
	return labels && labels.length > 0 ? new Set(labels) : undefined;
}

const LOOP_STATEMENT_TYPES = new Set<string>([
	"ForStatement",
	"ForInStatement",
	"ForOfStatement",
	"WhileStatement",
	"DoWhileStatement",
]);

/**
 * Compile a labeled statement. Labels on a loop/switch attach to that scope's
 * context (so labeled break/continue can target it); a label on any other
 * statement makes a break-only target whose break jumps to the join after it.
 */
function compileLabeledStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.LabeledStatement,
) {
	// Peel stacked labels (`a: b: for ...`) down to the labeled statement.
	const labels: Array<string> = [];
	let inner: ESTree.Statement = statement;
	while (inner.type === "LabeledStatement") {
		labels.push(inner.label.name);
		inner = inner.body;
	}

	if (LOOP_STATEMENT_TYPES.has(inner.type)) {
		// The following loop/switch claims these labels for its own context.
		fn.pendingLabels = labels;
		const entry = compileStatementsToBlock(program, fn, [inner]);
		block.instructions.push({ type: "jump", blocks: [entry] });
		return;
	}

	// Labeled non-loop statement: a break-only target.
	const labelContext: IRLoopContext = {
		kind: "label",
		breakJumps: [],
		continueJumps: [],
		labels: new Set(labels),
	};
	(fn.loops ??= []).push(labelContext);
	const bodyEntry = compileStatementsToBlock(
		program,
		fn,
		normalizeStatementOrBlock(inner),
	);
	block.instructions.push({ type: "jump", blocks: [bodyEntry] });
	const bodyTail = fn.blocks.at(-1)!;
	fn.loops.pop();

	const joinIdx = fn.blocks.push({ instructions: [] }) - 1;
	bodyTail.instructions.push({ type: "jump", blocks: [joinIdx] });
	for (const jump of labelContext.breakJumps) {
		jump.blocks[0] = joinIdx;
	}
}

function compileBreakStatement(
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.BreakStatement,
) {
	const label = statement.label?.name;
	const target =
		label === undefined
			? fn.loops?.findLast((c) => c.kind === "loop" || c.kind === "switch")
			: fn.loops?.findLast((c) => c.labels?.has(label));
	if (!target) {
		return;
	}

	// Routes through any enclosing finalizers before reaching the target.
	emitBreak(fn, block, label);
}

function compileContinueStatement(
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.ContinueStatement,
) {
	const label = statement.label?.name;
	const target =
		label === undefined
			? fn.loops?.findLast((c) => c.kind === "loop")
			: fn.loops?.findLast((c) => c.kind === "loop" && c.labels?.has(label));
	if (!target) {
		return;
	}

	emitContinue(fn, block, label);
}

/**
 * Compile a throw statement. The unwinding to the nearest handler happens in
 * the VM based on the statically known handler ranges.
 */
function compileThrowStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.ThrowStatement,
) {
	const cursor: IRCursor = { block };
	const value = compileExpression(program, fn, cursor, statement.argument);
	cursor.block.instructions.push({
		type: "throw",
		registers: [value],
	});
}

/**
 * Compile a try statement. try/catch without a finalizer keeps the simple
 * marker-delimited handler shape; a finalizer switches to the completion-record
 * model in compileTryFinally.
 */
function compileTryStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.TryStatement,
) {
	if (statement.finalizer) {
		compileTryFinally(program, fn, block, statement);
	} else {
		compileTryCatch(program, fn, block, statement);
	}
}

/**
 * Compile try/catch with no finalizer into a marker-delimited protected range
 * with the handler compiled out-of-line.
 *
 * Invariant: no bare temporary register may be kept live across the tryEnd
 * marker, since the exception edge is invisible to the register allocator.
 * Values that cross the try/catch boundary go through bindings.
 */
function compileTryCatch(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.TryStatement,
) {
	const tryBegin: Extract<IRInstruction, { type: "tryBegin" }> = {
		type: "tryBegin",
		// Patched below, once the handler and exit blocks exist.
		blocks: [-1, -1],
	};
	block.instructions.push(tryBegin);

	const tryBlock = compileStatementsToBlock(
		program,
		fn,
		normalizeStatementOrBlock(statement.block),
	);
	block.instructions.push({
		type: "jump",
		blocks: [tryBlock],
	});

	// The end marker lives directly after the try body, so the protected range
	// ends before the handler.
	const tryBodyLastBlock = fn.blocks.at(-1)!;
	const tryExit: IRBlock = { instructions: [{ type: "tryEnd" }] };
	const tryExitIdx = fn.blocks.push(tryExit) - 1;
	tryBegin.blocks[1] = tryExitIdx;
	tryBodyLastBlock.instructions.push({
		type: "jump",
		blocks: [tryExitIdx],
	});

	// The handler block must start with the catch instruction, which consumes
	// the throw completion the unwinder left in place.
	const handlerBlock: IRBlock = { instructions: [] };
	tryBegin.blocks[0] = fn.blocks.push(handlerBlock) - 1;

	const caughtRegister = nextRegisterDestination(fn);
	handlerBlock.instructions.push({
		type: "catch",
		registers: [caughtRegister],
	});

	if (statement.handler) {
		// Catch parameter destructuring can branch; throws inside it happen
		// past the protected range and so propagate outward, as specced.
		const handlerCursor: IRCursor = { block: handlerBlock };
		if (statement.handler.param) {
			compilePatternTarget(
				program,
				fn,
				handlerCursor,
				statement.handler.param,
				caughtRegister,
			);
		}

		const catchBlock = compileStatementsToBlock(
			program,
			fn,
			normalizeStatementOrBlock(statement.handler.body),
		);
		handlerCursor.block.instructions.push({
			type: "jump",
			blocks: [catchBlock],
		});
	} else {
		// try with neither catch nor finally is invalid; rethrow to be safe.
		handlerBlock.instructions.push({
			type: "throw",
			registers: [caughtRegister],
		});
	}
}

/**
 * Compile try { B } [catch (e) { C }] finally { F } with the finalizer
 * compiled *once* and shared across every exit (normal, throw, return). Each
 * exit edge sets a frame-local pending completion (kind + value registers) and
 * jumps into the finalizer; the finalizer epilogue re-dispatches it. A throw
 * out of the try body or the catch body both run the finalizer, and a return
 * routes through it via emitReturn.
 *
 * The completion registers are written only on normal edges (the throw path
 * rewrites them in the handler after `catch`), so nothing live crosses the
 * exception edge; being live across multiple blocks keeps them off the
 * register allocator's free list. return/break/continue out of the try/catch
 * route through the finalizer via emitReturn/emitBreak/emitContinue.
 */
function compileTryFinally(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.TryStatement,
) {
	const kindReg = nextRegisterDestination(fn);
	const valueReg = nextRegisterDestination(fn);
	const finallyCtx: IRLoopContext = {
		kind: "finally",
		breakJumps: [],
		continueJumps: [],
		finallyEntryJumps: [],
		completionKindReg: kindReg,
		completionValueReg: valueReg,
		finalizerArms: new Map(),
	};
	const entryJumps = finallyCtx.finallyEntryJumps!;

	// Route a normal completion into the finalizer (falls through afterward).
	const routeNormal = (target: IRBlock) =>
		routeThroughFinalizer(target, finallyCtx, "normal", null);
	// Route a thrown completion in: the epilogue re-throws the stashed value.
	const routeThrow = (target: IRBlock, value: number) =>
		routeThroughFinalizer(
			target,
			finallyCtx,
			"throw",
			(b) => b.instructions.push({ type: "throw", registers: [valueReg] }),
			value,
		);

	// --- protected try body ---
	const tryBegin: Extract<IRInstruction, { type: "tryBegin" }> = {
		type: "tryBegin",
		blocks: [-1, -1],
	};
	block.instructions.push(tryBegin);

	fn.loops ??= [];
	fn.loops.push(finallyCtx);
	const tryBlock = compileStatementsToBlock(
		program,
		fn,
		normalizeStatementOrBlock(statement.block),
	);
	block.instructions.push({ type: "jump", blocks: [tryBlock] });
	const tryBodyLastBlock = fn.blocks.at(-1)!;
	fn.loops.pop();

	// Normal completion of the try body ends the protected range and enters the
	// finalizer with a NORMAL completion.
	const tryNormalExit: IRBlock = { instructions: [{ type: "tryEnd" }] };
	const tryNormalExitIdx = fn.blocks.push(tryNormalExit) - 1;
	tryBegin.blocks[1] = tryNormalExitIdx;
	tryBodyLastBlock.instructions.push({ type: "jump", blocks: [tryNormalExitIdx] });
	routeNormal(tryNormalExit);

	// --- handler for the try body ---
	const handlerBlock: IRBlock = { instructions: [] };
	tryBegin.blocks[0] = fn.blocks.push(handlerBlock) - 1;
	const caughtRegister = nextRegisterDestination(fn);
	handlerBlock.instructions.push({ type: "catch", registers: [caughtRegister] });

	if (statement.handler) {
		// Bind the catch parameter, then run the catch body in its own protected
		// range so a throw out of it still runs the finalizer.
		const handlerCursor: IRCursor = { block: handlerBlock };
		if (statement.handler.param) {
			compilePatternTarget(
				program,
				fn,
				handlerCursor,
				statement.handler.param,
				caughtRegister,
			);
		}

		const catchTryBegin: Extract<IRInstruction, { type: "tryBegin" }> = {
			type: "tryBegin",
			blocks: [-1, -1],
		};
		handlerCursor.block.instructions.push(catchTryBegin);

		fn.loops.push(finallyCtx);
		const catchBlock = compileStatementsToBlock(
			program,
			fn,
			normalizeStatementOrBlock(statement.handler.body),
		);
		handlerCursor.block.instructions.push({ type: "jump", blocks: [catchBlock] });
		const catchBodyLastBlock = fn.blocks.at(-1)!;
		fn.loops.pop();

		const catchNormalExit: IRBlock = { instructions: [{ type: "tryEnd" }] };
		const catchNormalExitIdx = fn.blocks.push(catchNormalExit) - 1;
		catchTryBegin.blocks[1] = catchNormalExitIdx;
		catchBodyLastBlock.instructions.push({ type: "jump", blocks: [catchNormalExitIdx] });
		routeNormal(catchNormalExit);

		const catchHandler: IRBlock = { instructions: [] };
		catchTryBegin.blocks[0] = fn.blocks.push(catchHandler) - 1;
		const caught2 = nextRegisterDestination(fn);
		catchHandler.instructions.push({ type: "catch", registers: [caught2] });
		routeThrow(catchHandler, caught2);
	} else {
		// No catch clause: an exception in the body runs the finalizer then
		// re-propagates.
		routeThrow(handlerBlock, caughtRegister);
	}

	// --- finalizer body, compiled once with the finally context popped so its
	// own abrupt completions route to *enclosing* finalizers and override the
	// pending one. ---
	const finalizerEntryIdx = compileStatementsToBlock(
		program,
		fn,
		normalizeStatementOrBlock(statement.finalizer!),
	);
	const finalizerLastBlock = fn.blocks.at(-1)!;
	for (const jump of entryJumps) {
		jump.blocks[0] = finalizerEntryIdx;
	}

	// --- epilogue: re-dispatch the pending completion. One out-of-line block
	// per abrupt kind that can actually reach this finalizer; the epilogue
	// block itself is created last so its NORMAL fall-through reaches the code
	// after the try (patched by compileStatementsToBlock, or returned by
	// endFunction for a trailing try). ---
	// Each abrupt arm resumes its completion from the finalizer's position,
	// which routes through any *enclosing* finalizers (finallyCtx is popped).
	const dispatchBlocks: Array<{ kind: number; idx: number }> = [];
	for (const { kind, fill } of finallyCtx.finalizerArms!.values()) {
		const armBlock: IRBlock = { instructions: [] };
		const idx = fn.blocks.push(armBlock) - 1;
		fill(armBlock);
		dispatchBlocks.push({ kind, idx });
	}

	const epilogue: IRBlock = { instructions: [] };
	const epilogueIdx = fn.blocks.push(epilogue) - 1;
	finalizerLastBlock.instructions.push({ type: "jump", blocks: [epilogueIdx] });

	for (const { kind, idx } of dispatchBlocks) {
		const constReg = nextRegisterDestination(fn);
		const matchReg = nextRegisterDestination(fn);
		epilogue.instructions.push({
			type: "createNumber",
			registers: [constReg],
			value: kind,
		});
		epilogue.instructions.push({
			type: "binary",
			registers: [matchReg, kindReg, constReg],
			operator: "===",
		});
		epilogue.instructions.push({ type: "jumpIf", registers: [matchReg], blocks: [idx] });
	}
	// Fall through: NORMAL completion continues after the try.
}

/**
 * A bare block statement `{ ... }`: compile its body inline (block-scoped
 * declarations are resolved by sema). Without this, block bodies were silently
 * skipped, since the statement switch had no BlockStatement case.
 */
function compileBlockStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.BlockStatement,
) {
	// Block-scoped let/const/class start uninitialized (TDZ) at block entry.
	const scope = fn.semanticFile.nodeToScope.get(statement);
	if (scope) {
		emitTdzHoleInits(program, fn, block, scope.bindings);
	}
	const bodyEntry = compileStatementsToBlock(program, fn, statement.body);
	block.instructions.push({ type: "jump", blocks: [bodyEntry] });
}

/**
 * Compile `with (object) body`. The object is coerced to an object and pushed
 * onto the frame's with-object stack (withEnter); the body runs under a `with`
 * loop-context so break/continue/return out of it pop the object, and normal
 * completion pops via the withExit appended to the body tail. Identifiers in the
 * body that the analyzer flagged as dynamic (`withDynamicNodes`) compile to a
 * runtime with-object probe with a static fallback — see compileIdentifier.
 *
 * `with` is a strict-mode SyntaxError, so this only runs for sloppy code.
 */
function compileWithStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.WithStatement,
) {
	const cursor: IRCursor = { block };
	const object = compileExpression(program, fn, cursor, statement.object);
	cursor.block.instructions.push({ type: "withEnter", registers: [object] });

	const withContext: IRLoopContext = {
		kind: "with",
		breakJumps: [],
		continueJumps: [],
	};
	(fn.loops ??= []).push(withContext);
	const bodyEntry = compileStatementsToBlock(
		program,
		fn,
		normalizeStatementOrBlock(statement.body),
	);
	fn.loops.pop();

	cursor.block.instructions.push({ type: "jump", blocks: [bodyEntry] });

	// Normal completion of the body pops the with-object, then falls through to
	// a fresh exit block (the back edge / continuation the dispatch loop resumes
	// from). Abrupt exits (break/continue/return) emit their own withExit.
	const bodyTail = fn.blocks.at(-1)!;
	bodyTail.instructions.push({ type: "withExit", registers: [] });
	const exitIdx = fn.blocks.push({ instructions: [] }) - 1;
	bodyTail.instructions.push({ type: "jump", blocks: [exitIdx] });
}

/**
 * Compile an if statement, reading the condition and jumping to the consequent or alternate
 * block.
 */
function compileIfStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.IfStatement,
) {
	const cursor: IRCursor = { block };
	const condition = compileExpression(program, fn, cursor, statement.test);
	const consequentBlock = compileStatementsToBlock(
		program,
		fn,
		normalizeStatementOrBlock(statement.consequent),
	);
	cursor.block.instructions.push({
		type: "jumpIf",
		registers: [condition],
		blocks: [consequentBlock],
	});

	// We always create an alternate block so we have something to resume.
	const alternate = statement.alternate ?? {
		type: "BlockStatement",
		body: [],
	};
	const alternateBlock = compileStatementsToBlock(
		program,
		fn,
		normalizeStatementOrBlock(alternate),
	);
	cursor.block.instructions.push({
		type: "jump",
		blocks: [alternateBlock],
	});
}

/**
 * NORMAL completion code carried through a finalizer: it falls through to the
 * code after the try. Abrupt completions get their own dynamically-allocated
 * kind codes and re-dispatch arms (see routeThroughFinalizer).
 */
const COMPLETION_NORMAL = 0;

/**
 * Set a finalizer's pending completion and jump into it. Each distinct routing
 * `key` (e.g. "return", "break", "continue:outer") gets a unique kind code and
 * an epilogue arm carrying its re-dispatch; NORMAL (key "normal") needs no arm
 * and falls through. Kind codes are local to one finalizer's kind register.
 */
function routeThroughFinalizer(
	block: IRBlock,
	scope: IRLoopContext,
	key: string,
	fill: ((block: IRBlock) => void) | null,
	valueRegister?: number,
) {
	const arms = scope.finalizerArms!;
	let kind: number;
	if (key === "normal") {
		kind = COMPLETION_NORMAL;
	} else {
		const existing = arms.get(key);
		if (existing) {
			kind = existing.kind;
		} else {
			kind = arms.size + 1;
			arms.set(key, { kind, fill: fill! });
		}
	}

	block.instructions.push({
		type: "createNumber",
		registers: [scope.completionKindReg!],
		value: kind,
	});
	if (valueRegister !== undefined) {
		block.instructions.push({
			type: "move",
			registers: [scope.completionValueReg!, valueRegister],
		});
	}
	const jump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	block.instructions.push(jump);
	scope.finallyEntryJumps!.push(jump);
}

/**
 * Emit a return, routing it through any enclosing finalizers and closing
 * for-of iterators on the way out, innermost first. The innermost finalizer
 * takes over the return: its epilogue resumes the walk from its own position
 * once the finally body has run.
 */
function emitReturn(fn: IRFunction, block: IRBlock, valueRegister: number) {
	const scopes = fn.loops ?? [];
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i]!;

		if (scope.kind === "finally") {
			routeThroughFinalizer(
				block,
				scope,
				"return",
				(b) => emitReturn(fn, b, scope.completionValueReg!),
				valueRegister,
			);
			return;
		}

		if (scope.kind === "with") {
			block.instructions.push({ type: "withExit", registers: [] });
		}

		if (scope.iteratorRegister !== undefined) {
			block.instructions.push({
				type: "iteratorClose",
				registers: [scope.iteratorRegister],
			});
		}
	}

	block.instructions.push({
		type: "return",
		registers: [valueRegister],
	});
}

/**
 * Emit a break, routing through any enclosing finalizers first (innermost
 * first). The target is the innermost loop/switch, or the matching labeled
 * scope when a label is given; for-of iterators of every loop left on the way
 * out (including the target) are closed.
 */
function emitBreak(fn: IRFunction, block: IRBlock, label?: string) {
	const scopes = fn.loops ?? [];
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i]!;

		if (scope.kind === "finally") {
			routeThroughFinalizer(
				block,
				scope,
				label === undefined ? "break" : `break:${label}`,
				(b) => emitBreak(fn, b, label),
			);
			return;
		}

		// Leaving a with body pops its object.
		if (scope.kind === "with") {
			block.instructions.push({ type: "withExit", registers: [] });
		}

		// Leaving this loop closes its for-of iterator.
		if (scope.iteratorRegister !== undefined) {
			block.instructions.push({
				type: "iteratorClose",
				registers: [scope.iteratorRegister],
			});
		}

		const isTarget =
			label === undefined
				? scope.kind === "loop" || scope.kind === "switch"
				: scope.labels?.has(label) === true;

		// Restore the enclosing env when crossing a per-iteration loop to an outer
		// target; the target loop's own exit block pops for a direct break.
		if (scope.perIterationScopeId !== undefined && !isTarget) {
			block.instructions.push({ type: "envPop" });
		}

		if (isTarget) {
			const jump: Extract<IRInstruction, { type: "jump" }> = {
				type: "jump",
				blocks: [-1],
			};
			block.instructions.push(jump);
			scope.breakJumps.push(jump);
			return;
		}
	}
}

/**
 * Emit a continue, routing through any enclosing finalizers first; the target
 * is the innermost loop, or the matching labeled loop when a label is given.
 * Inner loops left on the way to a labeled outer loop close their for-of
 * iterators; the target loop's iterator stays open (it re-steps from the header).
 */
function emitContinue(fn: IRFunction, block: IRBlock, label?: string) {
	const scopes = fn.loops ?? [];
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i]!;

		if (scope.kind === "finally") {
			routeThroughFinalizer(
				block,
				scope,
				label === undefined ? "continue" : `continue:${label}`,
				(b) => emitContinue(fn, b, label),
			);
			return;
		}

		// Continuing out of a with body pops its object (a with is never a
		// continue target).
		if (scope.kind === "with") {
			block.instructions.push({ type: "withExit", registers: [] });
			continue;
		}

		if (scope.kind === "switch" || scope.kind === "label") {
			continue;
		}

		const isTarget = label === undefined ? true : scope.labels?.has(label) === true;
		if (!isTarget) {
			// An inner loop being left to reach a labeled outer loop closes its
			// for-of iterator and restores the enclosing env (per-iteration scope).
			if (scope.iteratorRegister !== undefined) {
				block.instructions.push({
					type: "iteratorClose",
					registers: [scope.iteratorRegister],
				});
			}
			if (scope.perIterationScopeId !== undefined) {
				block.instructions.push({ type: "envPop" });
			}
			continue;
		}

		const jump: Extract<IRInstruction, { type: "jump" }> = {
			type: "jump",
			blocks: [-1],
		};
		block.instructions.push(jump);
		scope.continueJumps.push(jump);
		return;
	}
}

/**
 * Node types whose presence anywhere in a function body makes self-recursive
 * tail-call → loop rewriting unsound, because frame reuse would change observed
 * behavior:
 *   - nested functions/classes capture this frame's variables (each recursive
 *     activation must give fresh bindings; a reused frame shares them);
 *   - `this`/`new.target` differ between the original call and a plain `f()`
 *     recursive call;
 *   - a `try` makes the call's result/exception observable, so it isn't a tail
 *     position.
 * (Generators, `arguments`, and non-Identifier params are excluded separately.)
 */
const TAIL_CALL_BLOCKERS = new Set([
	"FunctionDeclaration",
	"FunctionExpression",
	"ArrowFunctionExpression",
	"ClassDeclaration",
	"ClassExpression",
	"ThisExpression",
	"Super",
	"MetaProperty",
	"TryStatement",
]);

function containsTailCallBlocker(node: unknown): boolean {
	if (node === null || typeof node !== "object") {
		return false;
	}
	if (Array.isArray(node)) {
		return node.some(containsTailCallBlocker);
	}
	const type = (node as { type?: string }).type;
	if (type !== undefined && TAIL_CALL_BLOCKERS.has(type)) {
		return true;
	}
	for (const key of Object.keys(node)) {
		if (key === "type") {
			continue;
		}
		if (containsTailCallBlocker((node as Record<string, unknown>)[key])) {
			return true;
		}
	}
	return false;
}

/**
 * Decide whether the function admits self-recursive tail-call elimination, and
 * record the loop header. Called after parameter compilation (so
 * argumentsObjectRegister is known) and immediately before the body is
 * compiled, so the body block this records matches the one compileStatementsToBlock
 * is about to push, and compileReturnStatement can see the eligibility.
 */
function prepareTailCallLoop(
	fn: IRFunction,
	functionNode:
		| ESTree.FunctionDeclaration
		| ESTree.FunctionExpression
		| ESTree.ArrowFunctionExpression,
) {
	fn.tailCallNode = functionNode;
	// compileStatementsToBlock pushes the body block first thing, so its index is
	// the current block count.
	fn.bodyEntryBlock = fn.blocks.length;
	fn.tcoEligible =
		!fn.isGenerator &&
		fn.argumentsObjectRegister === undefined &&
		functionNode.params.every((param) => param.type === "Identifier") &&
		!containsTailCallBlocker(functionNode.body);
}

/**
 * Try to rewrite `return f(args)` (where f is the current function, reached
 * through an immutable binding) into a loop: evaluate the arguments, reassign
 * the parameter registers, and jump to the body entry. Returns false (emitting
 * nothing) when the call is not such a self-tail-call, so the caller falls back
 * to an ordinary return.
 */
function tryEmitSelfTailCall(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	call: ESTree.CallExpression,
): boolean {
	if (fn.bodyEntryBlock === undefined || fn.tailCallNode === undefined) {
		return false;
	}
	const callee = call.callee as unknown as ESTree.Node;
	if (callee.type !== "Identifier") {
		return false;
	}
	if (call.arguments.some((arg) => arg.type === "SpreadElement")) {
		return false;
	}

	const binding = fn.semanticFile.nodeToBinding.get(callee);
	if (!binding) {
		return false;
	}
	// The callee must resolve to *this* function: either through a binding whose
	// declaration is this function node (a function declaration, or a named
	// function expression's internal name) or through a `const f = <function>`
	// link recorded at declaration time.
	const isSelf =
		binding.declarationNode === fn.tailCallNode ||
		program.bindingFunctionNode.get(binding) === fn.tailCallNode;
	if (!isSelf) {
		return false;
	}
	// ...and through a binding that can't be reassigned to point elsewhere: a
	// const, or a named function expression's (immutable) internal name.
	if (
		binding.kind !== "const" &&
		binding.declarationNode?.type !== "FunctionExpression"
	) {
		return false;
	}

	// Leaving the frame here must not skip cleanup: a for-of iterator close or a
	// finally would otherwise be lost. (try/this/etc. are excluded function-wide.)
	for (const scope of fn.loops ?? []) {
		if (scope.iteratorRegister !== undefined || scope.kind === "finally") {
			return false;
		}
	}

	// Resolve parameter storage before emitting anything, so a defensive bail
	// can't leave half-emitted instructions.
	const locations = [];
	for (const param of fn.tailCallNode.params) {
		const paramBinding = fn.semanticFile.nodeToBinding.get(param);
		if (!paramBinding) {
			return false;
		}
		locations.push(getOrCreateBindingLocation(program, fn, paramBinding));
	}

	// Evaluate every argument first — an argument may read a parameter we are
	// about to overwrite (e.g. `return f(b, a)`).
	const argTemps = call.arguments.map((arg) =>
		// SpreadElement is excluded above; the ternary only narrows the type.
		arg.type === "SpreadElement" ? -1 : compileExpression(program, fn, cursor, arg),
	);

	for (let i = 0; i < locations.length; i++) {
		const value = i < argTemps.length ? argTemps[i]! : compileUndefined(fn, cursor);
		storeRegisterAtLocation(cursor.block, locations[i]!, value);
	}

	cursor.block.instructions.push({ type: "jump", blocks: [fn.bodyEntryBlock] });
	return true;
}

/**
 * Naively compile a return statement.
 */
function compileReturnStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.ReturnStatement,
) {
	const cursor: IRCursor = { block };

	if (
		fn.tcoEligible &&
		statement.argument?.type === "CallExpression" &&
		tryEmitSelfTailCall(program, fn, cursor, statement.argument)
	) {
		return;
	}

	const returnRegister = compileExpression(
		program,
		fn,
		cursor,
		statement.argument ?? { type: "Identifier", name: "undefined" },
	);

	emitReturn(fn, cursor.block, returnRegister);
}

/**
 * Naively compile variable declarations.
 */
function compileVariableDeclaration(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.VariableDeclaration,
) {
	const cursor: IRCursor = { block };
	for (const decl of statement.declarations) {
		// Link `const f = <function>` so a self-recursive tail call reached through
		// f is recognizable. Recorded before the initializer compiles, since that
		// is when the function's own body (with the recursive call) is compiled.
		if (
			decl.id.type === "Identifier" &&
			(decl.init?.type === "ArrowFunctionExpression" ||
				decl.init?.type === "FunctionExpression")
		) {
			const binding = fn.semanticFile.nodeToBinding.get(decl.id);
			if (binding) {
				program.bindingFunctionNode.set(binding, decl.init);
			}
		}

		const source = compileExpression(
			program,
			fn,
			cursor,

			// Initialize variables to undefined if they don't have an initializer.
			decl.init ?? { type: "Identifier", name: "undefined" },

			// NamedEvaluation: anonymous initializers take the binding name.
			decl.id.type === "Identifier" ? decl.id.name : undefined,
		);

		if (decl.id.type === "ObjectPattern" || decl.id.type === "ArrayPattern") {
			compilePatternTarget(program, fn, cursor, decl.id, source);
			continue;
		}

		const binding = fn.semanticFile.nodeToBinding.get(decl.id);
		if (!binding) {
			continue;
		}

		const location = getOrCreateBindingLocation(program, fn, binding);
		storeRegisterAtLocation(cursor.block, location, source);
	}
}

/**
 * Expression compilation dispatch.
 *
 * Expressions always return the virtual register index they used.
 *
 * nameHint carries the NamedEvaluation name for anonymous function and class
 * expressions: the binding or property name the value is assigned to.
 */
/**
 * Resume mode codes written by the runtime into a yield's mode register and
 * matched by the dispatch below. Must stay in sync with MalGeneratorResumeMode
 * (NEXT = 0 is the fall-through and needs no comparison).
 */
const RESUME_MODE_THROW = 1;
const RESUME_MODE_RETURN = 2;

/**
 * Compile yield* delegation. Desugars to the spec delegation loop: get the
 * operand's iterator, then repeatedly advance it according to how the *outer*
 * generator was resumed — next() forwards to the cached next, throw()/return()
 * forward to the inner iterator's throw/return (looked up per use). Each inner
 * value is yielded back out; the inner's final value becomes the yield*
 * expression value. A return() resumption that finishes the inner returns from
 * the outer generator; a throw() with no inner throw method closes the inner
 * and throws a TypeError.
 */
function compileYieldStarExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.YieldExpression,
) {
	const operand = compileExpression(program, fn, cursor, expression.argument!);

	// In an async generator, yield* delegates to an ASYNC iterator and awaits
	// each inner next/throw/return result and each yielded value (the spec's
	// Await steps in yield* + AsyncGeneratorYield).
	const isAsync = fn.isAsync === true;

	// Loop-carried registers (kept alive across the back edge by the
	// >1-block freeing guard in the allocator).
	const iterator = nextRegisterDestination(fn);
	const nextMethod = nextRegisterDestination(fn);
	const sentValue = nextRegisterDestination(fn);
	const mode = nextRegisterDestination(fn);
	const result = nextRegisterDestination(fn);
	const exprResult = nextRegisterDestination(fn);

	cursor.block.instructions.push({
		type: isAsync ? "getAsyncIterator" : "getIterator",
		registers: [iterator, nextMethod, operand],
	});
	cursor.block.instructions.push({ type: "createUndefined", registers: [sentValue] });
	cursor.block.instructions.push({ type: "createNumber", registers: [mode], value: 0 });

	const header: IRBlock = { instructions: [] };
	const headerIdx = fn.blocks.push(header) - 1;
	const nextMode: IRBlock = { instructions: [] };
	const nextModeIdx = fn.blocks.push(nextMode) - 1;
	const throwMode: IRBlock = { instructions: [] };
	const throwModeIdx = fn.blocks.push(throwMode) - 1;
	const noThrow: IRBlock = { instructions: [] };
	const noThrowIdx = fn.blocks.push(noThrow) - 1;
	const returnMode: IRBlock = { instructions: [] };
	const returnModeIdx = fn.blocks.push(returnMode) - 1;
	const noReturn: IRBlock = { instructions: [] };
	const noReturnIdx = fn.blocks.push(noReturn) - 1;
	const check: IRBlock = { instructions: [] };
	const checkIdx = fn.blocks.push(check) - 1;
	const doneBlock: IRBlock = { instructions: [] };
	const doneIdx = fn.blocks.push(doneBlock) - 1;
	const doneReturn: IRBlock = { instructions: [] };
	const doneReturnIdx = fn.blocks.push(doneReturn) - 1;
	const continuation: IRBlock = { instructions: [] };
	const continuationIdx = fn.blocks.push(continuation) - 1;

	cursor.block.instructions.push({ type: "jump", blocks: [headerIdx] });

	const stringRegister = (block: IRBlock, value: string) => {
		const reg = nextRegisterDestination(fn);
		block.instructions.push({
			type: "createString",
			registers: [reg],
			stringIndex: getOrCreateStringConstant(program, value),
		});
		return reg;
	};
	const nullishGuard = (block: IRBlock, valueReg: number, target: number) => {
		const undef = nextRegisterDestination(fn);
		const isNullish = nextRegisterDestination(fn);
		block.instructions.push({ type: "createUndefined", registers: [undef] });
		block.instructions.push({
			type: "binary",
			registers: [isNullish, valueReg, undef],
			operator: "==",
		});
		block.instructions.push({ type: "jumpIf", registers: [isNullish], blocks: [target] });
	};
	const modeEquals = (block: IRBlock, modeValue: number, target: number) => {
		const constReg = nextRegisterDestination(fn);
		const matchReg = nextRegisterDestination(fn);
		block.instructions.push({
			type: "createNumber",
			registers: [constReg],
			value: modeValue,
		});
		block.instructions.push({
			type: "binary",
			registers: [matchReg, mode, constReg],
			operator: "===",
		});
		block.instructions.push({ type: "jumpIf", registers: [matchReg], blocks: [target] });
	};
	// After an inner next/throw/return call leaves its result in `result`, await
	// it (async delegation) and continue to the done/value check.
	const stepAndContinue = (block: IRBlock) => {
		if (isAsync) {
			const stepCursor: IRCursor = { block };
			const awaited = compileAwaitRegister(fn, stepCursor, result);
			stepCursor.block.instructions.push({ type: "move", registers: [result, awaited] });
			stepCursor.block.instructions.push({ type: "jump", blocks: [checkIdx] });
		} else {
			block.instructions.push({ type: "jump", blocks: [checkIdx] });
		}
	};

	// header: dispatch on the resume mode.
	modeEquals(header, RESUME_MODE_THROW, throwModeIdx);
	modeEquals(header, RESUME_MODE_RETURN, returnModeIdx);
	header.instructions.push({ type: "jump", blocks: [nextModeIdx] });

	// next(): advance via the cached next method.
	nextMode.instructions.push({
		type: "call",
		registers: [result, nextMethod, iterator, sentValue],
	});
	stepAndContinue(nextMode);

	// throw(): forward to the inner throw, or close + TypeError if absent.
	{
		const throwM = nextRegisterDestination(fn);
		throwMode.instructions.push({
			type: "loadProperty",
			registers: [throwM, iterator, stringRegister(throwMode, "throw")],
		});
		nullishGuard(throwMode, throwM, noThrowIdx);
		throwMode.instructions.push({
			type: "call",
			registers: [result, throwM, iterator, sentValue],
		});
		stepAndContinue(throwMode);
	}
	noThrow.instructions.push({ type: "iteratorClose", registers: [iterator] });
	{
		const te = nextRegisterDestination(fn);
		noThrow.instructions.push({
			type: "loadIntrinsic",
			registers: [te],
			intrinsic: "TypeError",
		});
		const err = nextRegisterDestination(fn);
		noThrow.instructions.push({
			type: "construct",
			registers: [
				err,
				te,
				stringRegister(noThrow, "The iterator does not provide a 'throw' method"),
			],
		});
		noThrow.instructions.push({ type: "throw", registers: [err] });
	}

	// return(): forward to the inner return, or return the received value.
	{
		const returnM = nextRegisterDestination(fn);
		returnMode.instructions.push({
			type: "loadProperty",
			registers: [returnM, iterator, stringRegister(returnMode, "return")],
		});
		nullishGuard(returnMode, returnM, noReturnIdx);
		returnMode.instructions.push({
			type: "call",
			registers: [result, returnM, iterator, sentValue],
		});
		stepAndContinue(returnMode);
	}
	emitReturn(fn, noReturn, sentValue);

	// check: a done result ends the delegation; otherwise yield the value out
	// and loop back to advance the inner iterator on the next resume.
	{
		const doneReg = nextRegisterDestination(fn);
		check.instructions.push({
			type: "loadProperty",
			registers: [doneReg, result, stringRegister(check, "done")],
		});
		check.instructions.push({ type: "jumpIf", registers: [doneReg], blocks: [doneIdx] });
		const valueReg = nextRegisterDestination(fn);
		check.instructions.push({
			type: "loadProperty",
			registers: [valueReg, result, stringRegister(check, "value")],
		});
		// The inner yield: suspend the outer generator. On resume the sent value
		// and resume mode drive the next loop iteration (no throw/return dispatch
		// here — the mode is forwarded into the delegation above). Async
		// delegation awaits the value first (AsyncGeneratorYield).
		const checkCursor: IRCursor = { block: check };
		const yieldedReg = isAsync
			? compileAwaitRegister(fn, checkCursor, valueReg)
			: valueReg;
		checkCursor.block.instructions.push({
			type: "yield",
			registers: [sentValue, mode, yieldedReg],
		});
		checkCursor.block.instructions.push({ type: "jump", blocks: [headerIdx] });
	}

	// doneBlock: extract the final value. A return() resumption that finishes
	// the inner returns from the outer generator; otherwise it is the yield*
	// expression value.
	{
		const doneValue = nextRegisterDestination(fn);
		doneBlock.instructions.push({
			type: "loadProperty",
			registers: [doneValue, result, stringRegister(doneBlock, "value")],
		});
		modeEquals(doneBlock, RESUME_MODE_RETURN, doneReturnIdx);
		doneBlock.instructions.push({ type: "move", registers: [exprResult, doneValue] });
		doneBlock.instructions.push({ type: "jump", blocks: [continuationIdx] });
		emitReturn(fn, doneReturn, doneValue);
	}

	cursor.block = continuation;
	return exprResult;
}

/**
 * Compile a yield expression: hand the operand out (suspending the generator),
 * then on resume dispatch on the resume mode. A next() resumption falls through
 * with the sent value; a throw() throws it at the yield point (reaching any
 * enclosing catch/finally, since these blocks compile inside the protected
 * range); a return() returns it, routed through enclosing finalizers.
 */
function compileYieldExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.YieldExpression,
) {
	if (expression.delegate) {
		return compileYieldStarExpression(program, fn, cursor, expression);
	}

	let yieldedSrc = expression.argument
		? compileExpression(program, fn, cursor, expression.argument)
		: compileUndefined(fn, cursor);

	// AsyncGeneratorYield: an async generator awaits the operand before handing
	// it out (so `yield somePromise` yields the resolved value).
	if (fn.isAsync && fn.isGenerator) {
		yieldedSrc = compileAwaitRegister(fn, cursor, yieldedSrc);
	}

	const valueDst = nextRegisterDestination(fn);
	const modeDst = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "yield",
		registers: [valueDst, modeDst, yieldedSrc],
	});

	return emitResumeDispatch(fn, cursor, valueDst, modeDst);
}

/**
 * The resume-mode dispatch the compiler emits immediately after a suspend
 * (yield or await): `if mode === THROW: throw value; if mode === RETURN:
 * return value (through enclosing finalizers); else continue with value as the
 * expression result`. Shared by yield and await because the resume protocol
 * is identical — fulfilled/next deliver a value, rejected/throw raise it,
 * return() unwinds.
 */
function emitResumeDispatch(
	fn: IRFunction,
	cursor: IRCursor,
	valueDst: number,
	modeDst: number,
): number {
	// throw() resumption: throw the sent value at the suspend point.
	const throwBlock: IRBlock = { instructions: [] };
	const throwIdx = fn.blocks.push(throwBlock) - 1;
	throwBlock.instructions.push({ type: "throw", registers: [valueDst] });

	// return() resumption: return the sent value, through enclosing finalizers.
	const returnBlock: IRBlock = { instructions: [] };
	const returnIdx = fn.blocks.push(returnBlock) - 1;
	emitReturn(fn, returnBlock, valueDst);

	const continuation: IRBlock = { instructions: [] };
	const continuationIdx = fn.blocks.push(continuation) - 1;

	const throwConst = nextRegisterDestination(fn);
	const isThrow = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createNumber",
		registers: [throwConst],
		value: RESUME_MODE_THROW,
	});
	cursor.block.instructions.push({
		type: "binary",
		registers: [isThrow, modeDst, throwConst],
		operator: "===",
	});
	cursor.block.instructions.push({
		type: "jumpIf",
		registers: [isThrow],
		blocks: [throwIdx],
	});

	const returnConst = nextRegisterDestination(fn);
	const isReturn = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createNumber",
		registers: [returnConst],
		value: RESUME_MODE_RETURN,
	});
	cursor.block.instructions.push({
		type: "binary",
		registers: [isReturn, modeDst, returnConst],
		operator: "===",
	});
	cursor.block.instructions.push({
		type: "jumpIf",
		registers: [isReturn],
		blocks: [returnIdx],
	});

	cursor.block.instructions.push({ type: "jump", blocks: [continuationIdx] });

	// next()/fulfilled resumption continues here with the sent/resolved value.
	cursor.block = continuation;
	return valueDst;
}

function compileAwaitExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.AwaitExpression,
): number {
	const awaitedSrc = compileExpression(program, fn, cursor, expression.argument);
	return compileAwaitRegister(fn, cursor, awaitedSrc);
}

/** Suspend on the value in awaitedSrc and continue with the settled value. */
function compileAwaitRegister(
	fn: IRFunction,
	cursor: IRCursor,
	awaitedSrc: number,
): number {
	const valueDst = nextRegisterDestination(fn);
	const modeDst = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "await",
		registers: [valueDst, modeDst, awaitedSrc],
	});

	return emitResumeDispatch(fn, cursor, valueDst, modeDst);
}

function compileExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.Expression | ESTree.PrivateIdentifier,
	nameHint?: string,
) {
	switch (expression.type) {
		case "ArrayExpression": {
			return compileArrayExpression(program, fn, cursor, expression);
		}
		case "AssignmentExpression": {
			return compileAssignment(program, fn, cursor, expression);
		}
		case "BinaryExpression": {
			return compileBinary(program, fn, cursor, expression);
		}
		case "CallExpression": {
			return compileCall(program, fn, cursor, expression);
		}
		case "NewExpression": {
			return compileNewExpression(program, fn, cursor, expression);
		}
		case "ArrowFunctionExpression":
		case "FunctionExpression": {
			return compileFunctionExpression(program, fn, cursor, expression, nameHint);
		}
		case "ClassExpression": {
			return compileClass(program, fn, cursor, expression, nameHint);
		}
		case "Identifier": {
			return compileIdentifier(program, fn, cursor, expression);
		}
		case "ThisExpression": {
			// An arrow inherits `this` lexically: semantic analysis bound this node to
			// an implicit `this` binding on the enclosing non-arrow function, captured
			// through the closure env. Read it like any captured binding. (Unbound
			// `this` — directly in a non-arrow function, or top-level — falls through.)
			const thisBinding = fn.semanticFile.nodeToBinding.get(expression);
			if (thisBinding?.implicit === "this") {
				const location = getOrCreateBindingLocation(program, fn, thisBinding);
				return loadRegisterFromLocation(fn, cursor.block, location);
			}
			const destination = nextRegisterDestination(fn);
			// Top-level `this` in a global *script* is globalThis in BOTH strict
			// and sloppy mode (ScriptEvaluation binds globalThis regardless of
			// strictness); only a module's top-level `this` is undefined.
			const scope = fn.semanticFile.nodeToScope.get(expression);
			if (scope?.node.type === "Program" && fn.semanticFile.type === "script") {
				cursor.block.instructions.push({
					type: "loadIntrinsic",
					registers: [destination],
					intrinsic: "globalThis",
				});
				return destination;
			}
			cursor.block.instructions.push({
				type: "loadThis",
				registers: [destination],
			});
			return destination;
		}
		case "MetaProperty": {
			// new.target: the active frame's new.target. import.meta is gated by
			// the syntax scan and never reaches here.
			const destination = nextRegisterDestination(fn);
			cursor.block.instructions.push({
				type: "loadNewTarget",
				registers: [destination],
			});
			return destination;
		}
		case "LogicalExpression": {
			return compileLogicalExpression(program, fn, cursor, expression);
		}
		case "UnaryExpression": {
			return compileUnaryExpression(program, fn, cursor, expression);
		}
		case "UpdateExpression": {
			return compileUpdateExpression(program, fn, cursor, expression);
		}
		case "ConditionalExpression": {
			return compileConditionalExpression(program, fn, cursor, expression);
		}
		case "YieldExpression": {
			return compileYieldExpression(program, fn, cursor, expression);
		}
		case "AwaitExpression": {
			return compileAwaitExpression(program, fn, cursor, expression);
		}
		case "TemplateLiteral": {
			return compileTemplateLiteral(program, fn, cursor, expression);
		}
		case "TaggedTemplateExpression": {
			return compileTaggedTemplate(program, fn, cursor, expression);
		}
		case "Literal": {
			return compileLiteral(program, fn, cursor, expression);
		}
		case "MemberExpression": {
			return compileMemberExpression(program, fn, cursor, expression);
		}
		case "ObjectExpression": {
			return compileObjectExpression(program, fn, cursor, expression);
		}
		case "SequenceExpression": {
			// The comma operator evaluates each operand left to right and takes
			// the value of the last one.
			let value = -1;
			for (const inner of expression.expressions) {
				value = compileExpression(program, fn, cursor, inner);
			}
			return value;
		}
		case "ChainExpression": {
			return compileOptionalChain(program, fn, cursor, expression.expression);
		}
		default:
			return -1;
	}
}

/**
 * Compile an optional chain (the inside of a ChainExpression). Any optional
 * link whose base is null or undefined short-circuits the whole chain to
 * undefined; otherwise the chain evaluates normally. Short-circuit jumps from
 * every optional link are collected and patched to a shared block that yields
 * undefined.
 */
function compileOptionalChain(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	node: ESTree.Expression,
): number {
	const result = nextRegisterDestination(fn);
	const shortCircuits: Array<Extract<IRInstruction, { type: "jumpIf" }>> = [];
	const value = compileChainElement(program, fn, cursor, node, shortCircuits);
	if (value === -1) {
		return -1;
	}

	cursor.block.instructions.push({ type: "move", registers: [result, value] });
	if (shortCircuits.length === 0) {
		return result;
	}

	const successJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(successJump);

	// Short-circuit landing block: the chain result is undefined.
	const shortIdx = fn.blocks.push({ instructions: [] }) - 1;
	const shortBlock = fn.blocks[shortIdx]!;
	const shortCursor: IRCursor = { block: shortBlock };
	const undefinedRegister = compileUndefined(fn, shortCursor);
	shortBlock.instructions.push({ type: "move", registers: [result, undefinedRegister] });
	const shortJoinJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	shortBlock.instructions.push(shortJoinJump);

	const joinIdx = fn.blocks.push({ instructions: [] }) - 1;
	successJump.blocks[0] = joinIdx;
	shortJoinJump.blocks[0] = joinIdx;
	for (const jump of shortCircuits) {
		jump.blocks[0] = shortIdx;
	}
	cursor.block = fn.blocks[joinIdx]!;
	return result;
}

/**
 * Insert a short-circuit guard for an optional link: if the base register is
 * null or undefined, jump to the chain's short-circuit block; otherwise
 * continue in a fresh block. The recorded jump is patched by
 * compileOptionalChain.
 */
function emitOptionalGuard(
	fn: IRFunction,
	cursor: IRCursor,
	base: number,
	shortCircuits: Array<Extract<IRInstruction, { type: "jumpIf" }>>,
) {
	const undefinedRegister = compileUndefined(fn, cursor);
	const isNil = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "binary",
		registers: [isNil, base, undefinedRegister],
		operator: "==",
	});

	const shortJump: Extract<IRInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [isNil],
		blocks: [-1],
	};
	const continueJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(shortJump, continueJump);
	shortCircuits.push(shortJump);

	const continueIdx = fn.blocks.push({ instructions: [] }) - 1;
	continueJump.blocks[0] = continueIdx;
	cursor.block = fn.blocks[continueIdx]!;
}

/**
 * Recursively compile one node of an optional chain, threading the short-
 * circuit jump list through nested member accesses and calls.
 */
function compileChainElement(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	node: ESTree.Expression,
	shortCircuits: Array<Extract<IRInstruction, { type: "jumpIf" }>>,
): number {
	if (node.type === "MemberExpression") {
		const object = compileChainElement(program, fn, cursor, node.object, shortCircuits);
		if (object === -1) {
			return -1;
		}

		if (node.optional) {
			emitOptionalGuard(fn, cursor, object, shortCircuits);
		}

		const key = node.computed
			? compileExpression(program, fn, cursor, node.property)
			: node.property.type === "Identifier"
				? compileStaticString(program, fn, cursor, node.property.name)
				: -1;
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "loadProperty",
			registers: [destination, object, key],
		});
		return destination;
	}

	if (node.type === "CallExpression") {
		const calleeNode = node.callee as unknown as ESTree.Node;
		let callee: number;
		let thisRegister: number;
		if (calleeNode.type === "MemberExpression") {
			const object = compileChainElement(
				program,
				fn,
				cursor,
				calleeNode.object,
				shortCircuits,
			);
			if (object === -1) {
				return -1;
			}

			if (calleeNode.optional) {
				emitOptionalGuard(fn, cursor, object, shortCircuits);
			}

			const key = calleeNode.computed
				? compileExpression(program, fn, cursor, calleeNode.property)
				: calleeNode.property.type === "Identifier"
					? compileStaticString(program, fn, cursor, calleeNode.property.name)
					: -1;
			thisRegister = object;
			callee = nextRegisterDestination(fn);
			cursor.block.instructions.push({
				type: "loadProperty",
				registers: [callee, object, key],
			});
		} else {
			callee = compileChainElement(
				program,
				fn,
				cursor,
				calleeNode as ESTree.Expression,
				shortCircuits,
			);
			if (callee === -1) {
				return -1;
			}
			thisRegister = compileUndefined(fn, cursor);
		}

		if (node.optional) {
			emitOptionalGuard(fn, cursor, callee, shortCircuits);
		}

		if (node.arguments.some((arg) => arg.type === "SpreadElement")) {
			const argumentsArray = compileSpreadArgumentsArray(
				program,
				fn,
				cursor,
				node.arguments,
			);
			const destination = nextRegisterDestination(fn);
			cursor.block.instructions.push({
				type: "callSpread",
				registers: [destination, callee, thisRegister, argumentsArray],
			});
			return destination;
		}

		const args = node.arguments.map((arg) =>
			arg.type === "SpreadElement" ? -1 : compileExpression(program, fn, cursor, arg),
		);
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "call",
			registers: [destination, callee, thisRegister, ...args],
		});
		return destination;
	}

	// The non-optional head of the chain (an identifier, this, parenthesized
	// expression, etc.).
	return compileExpression(program, fn, cursor, node);
}

function compileFunctionExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.FunctionExpression | ESTree.ArrowFunctionExpression,
	nameHint?: string,
) {
	// NamedEvaluation only applies to anonymous functions; a named function
	// expression keeps its own name.
	const anonymous = expression.type === "ArrowFunctionExpression" || !expression.id;

	const destination = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createFunction",
		registers: [destination],
		functionIndex: compileNewFunctionExpression(
			program,
			fn,
			expression,
			undefined,
			anonymous ? nameHint : undefined,
		),
	});

	return destination;
}

function compileAssignment(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	assignmentExpression: ESTree.AssignmentExpression,
): number {
	if (
		assignmentExpression.operator === "||=" ||
		assignmentExpression.operator === "&&=" ||
		assignmentExpression.operator === "??="
	) {
		return compileLogicalAssignment(program, fn, cursor, assignmentExpression);
	}

	if (assignmentExpression.left.type === "Identifier") {
		return compileIdentifierAssignment(program, fn, cursor, assignmentExpression);
	}

	if (
		assignmentExpression.left.type === "ObjectPattern" ||
		assignmentExpression.left.type === "ArrayPattern"
	) {
		// Destructuring assignment is only valid with the plain = operator. The
		// expression evaluates to the right hand side value.
		const value = compileExpression(program, fn, cursor, assignmentExpression.right);
		compilePatternTarget(program, fn, cursor, assignmentExpression.left, value, true);
		return value;
	}

	if (assignmentExpression.left.type !== "MemberExpression") {
		return -1;
	}

	if (assignmentExpression.left.property.type === "PrivateIdentifier") {
		const name = `#${assignmentExpression.left.property.name}`;
		const object = compileExpression(
			program,
			fn,
			cursor,
			assignmentExpression.left.object,
		);

		let value: number;
		if (assignmentExpression.operator === "=") {
			value = compileExpression(program, fn, cursor, assignmentExpression.right);
		} else {
			const current = compilePrivateMemberLoad(program, fn, cursor, object, name);
			const right = compileExpression(program, fn, cursor, assignmentExpression.right);
			value = nextRegisterDestination(fn);
			cursor.block.instructions.push({
				type: "binary",
				registers: [value, current, right],
				operator: assignmentOperatorToBinaryOperator(assignmentExpression.operator),
			});
		}

		compilePrivateMemberStore(program, fn, cursor, object, name, value);
		return value;
	}

	const { object, key } = compileMemberObjectAndKey(
		program,
		fn,
		cursor,
		assignmentExpression.left,
	);

	// A compound assignment to a computed member both loads and stores at the
	// same key, so convert the key to a property key once (running its
	// @@toPrimitive / valueOf / toString a single time, after the base's
	// object-coercibility check) and reuse it.
	let effectiveKey = key;
	if (
		assignmentExpression.operator !== "=" &&
		assignmentExpression.left.computed &&
		key >= 0
	) {
		effectiveKey = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "toPropertyKey",
			registers: [effectiveKey, object, key],
		});
	}

	let value: number;
	if (assignmentExpression.operator === "=") {
		value = compileExpression(program, fn, cursor, assignmentExpression.right);
	} else {
		const binaryOperator = assignmentOperatorToBinaryOperator(
			assignmentExpression.operator,
		);
		const current = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "loadProperty",
			registers: [current, object, effectiveKey],
		});

		const right = compileExpression(program, fn, cursor, assignmentExpression.right);
		value = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "binary",
			registers: [value, current, right],
			operator: binaryOperator,
		});
	}

	if (assignmentExpression.left.object.type === "Super") {
		// super.x = v looks the property up on the super base but writes to
		// the current instance.
		const receiver = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "loadThis",
			registers: [receiver],
		});
		cursor.block.instructions.push({
			type: "storeSuperProperty",
			registers: [object, effectiveKey, value, receiver],
		});

		return value;
	}

	cursor.block.instructions.push({
		type: "storeProperty",
		registers: [object, effectiveKey, value],
	});

	return value;
}

function compileIdentifierAssignment(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	assignmentExpression: ESTree.AssignmentExpression,
): number {
	if (fn.semanticFile.withDynamicNodes.has(assignmentExpression.left)) {
		const left = assignmentExpression.left as ESTree.Identifier;
		let value: number;
		if (assignmentExpression.operator === "=") {
			value = compileExpression(
				program,
				fn,
				cursor,
				assignmentExpression.right,
				left.name,
			);
		} else {
			// Compound: the current value is itself a with-intercepted read.
			const current = compileWithDynamicRead(program, fn, cursor, left);
			const right = compileExpression(program, fn, cursor, assignmentExpression.right);
			value = nextRegisterDestination(fn);
			cursor.block.instructions.push({
				type: "binary",
				registers: [value, current, right],
				operator: assignmentOperatorToBinaryOperator(assignmentExpression.operator),
			});
		}
		compileWithDynamicWrite(program, fn, cursor, left, value, true);
		return value;
	}

	const binding = fn.semanticFile.nodeToBinding.get(assignmentExpression.left);
	if (!binding) {
		return -1;
	}

	if (binding.undeclared && !isIRIntrinsic(binding.name)) {
		// Sloppy `x = v` for an unresolved x creates/sets a global property and
		// evaluates to v. (Compound forms read first, so an absent global still
		// throws below — correct.)
		if (isSloppyFunction(fn) && assignmentExpression.operator === "=") {
			const value = compileExpression(program, fn, cursor, assignmentExpression.right);
			emitGlobalPropertyStore(program, fn, cursor, binding.name, value);
			return value;
		}

		// PutValue on an unresolvable reference throws ReferenceError; plain
		// assignments still evaluate the right hand side first, compound
		// forms throw on the read before it.
		if (assignmentExpression.operator === "=") {
			compileExpression(program, fn, cursor, assignmentExpression.right);
		}

		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "loadUndeclared",
			registers: [destination],
			nameStringIndex: getOrCreateStringConstant(program, binding.name),
		});

		return destination;
	}

	if (binding.kind === "const") {
		// Assignment to a const or imported binding is a TypeError (modules and
		// our pipeline are always strict). A plain assignment still evaluates its
		// right-hand side for its side effects before throwing.
		if (assignmentExpression.operator === "=") {
			compileExpression(program, fn, cursor, assignmentExpression.right);
		}
		return emitThrowTypeError(program, fn, cursor, "Assignment to constant variable.");
	}

	const location = getOrCreateBindingLocation(program, fn, binding);

	let value: number;
	if (assignmentExpression.operator === "=") {
		value = compileExpression(
			program,
			fn,
			cursor,
			assignmentExpression.right,
			// NamedEvaluation: anonymous right hand sides take the target name.
			binding.name,
		);
	} else {
		const binaryOperator = assignmentOperatorToBinaryOperator(
			assignmentExpression.operator,
		);
		const current = loadRegisterFromLocation(fn, cursor.block, location);
		const right = compileExpression(program, fn, cursor, assignmentExpression.right);
		value = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "binary",
			registers: [value, current, right],
			operator: binaryOperator,
		});
	}

	if (value === -1) {
		// The right hand side is not supported yet; skip the store instead of
		// emitting an invalid register reference.
		return -1;
	}

	storeRegisterAtLocation(cursor.block, location, value);
	return value;
}

/**
 * Compile a logical assignment (||=, &&=, ??=). The target is read once, and
 * the right hand side is evaluated and stored only when the short-circuit
 * condition calls for it: ||= assigns on a falsy current value, &&= on a
 * truthy one, ??= on null or undefined. The expression value is the current
 * value when it short-circuits, otherwise the assigned value.
 */
function compileLogicalAssignment(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	assignmentExpression: ESTree.AssignmentExpression,
): number {
	const left = assignmentExpression.left;

	let location: BindingLocation | undefined;
	let nameHint: string | undefined;
	let member: { object: number; key: number; isSuper: boolean } | undefined;
	let privateMember: { object: number; name: string } | undefined;
	let current: number;

	if (left.type === "Identifier") {
		const binding = fn.semanticFile.nodeToBinding.get(left);
		if (!binding) {
			return -1;
		}

		if (binding.undeclared && !isIRIntrinsic(binding.name)) {
			// GetValue on an unresolvable reference throws ReferenceError before
			// the operator can short-circuit.
			const destination = nextRegisterDestination(fn);
			cursor.block.instructions.push({
				type: "loadUndeclared",
				registers: [destination],
				nameStringIndex: getOrCreateStringConstant(program, binding.name),
			});
			return destination;
		}

		location = getOrCreateBindingLocation(program, fn, binding);
		nameHint = binding.name;
		current = loadRegisterFromLocation(fn, cursor.block, location);
	} else if (
		left.type === "MemberExpression" &&
		left.property.type === "PrivateIdentifier"
	) {
		const object = compileExpression(program, fn, cursor, left.object);
		privateMember = { object, name: `#${left.property.name}` };
		current = compilePrivateMemberLoad(program, fn, cursor, object, privateMember.name);
	} else if (left.type === "MemberExpression") {
		const compiled = compileMemberObjectAndKey(program, fn, cursor, left);
		member = {
			object: compiled.object,
			key: compiled.key,
			isSuper: left.object.type === "Super",
		};
		current = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "loadProperty",
			registers: [current, member.object, member.key],
		});
	} else {
		return -1;
	}

	const result = nextRegisterDestination(fn);
	cursor.block.instructions.push({ type: "move", registers: [result, current] });

	// The condition register decides whether to enter the assign branch.
	let condition = current;
	if (assignmentExpression.operator === "??=") {
		const undefinedRegister = compileUndefined(fn, cursor);
		condition = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "binary",
			registers: [condition, current, undefinedRegister],
			operator: "==",
		});
	}

	const conditionalJump: Extract<IRInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [condition],
		blocks: [-1],
	};
	const fallthroughJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(conditionalJump, fallthroughJump);

	// Assign branch: evaluate the right hand side and store it.
	const assignIdx = fn.blocks.push({ instructions: [] }) - 1;
	cursor.block = fn.blocks[assignIdx]!;
	const right = compileExpression(
		program,
		fn,
		cursor,
		assignmentExpression.right,
		nameHint,
	);
	if (right === -1) {
		return -1;
	}
	cursor.block.instructions.push({ type: "move", registers: [result, right] });

	if (location) {
		storeRegisterAtLocation(cursor.block, location, right);
	} else if (privateMember) {
		compilePrivateMemberStore(
			program,
			fn,
			cursor,
			privateMember.object,
			privateMember.name,
			right,
		);
	} else if (member) {
		if (member.isSuper) {
			const receiver = nextRegisterDestination(fn);
			cursor.block.instructions.push({ type: "loadThis", registers: [receiver] });
			cursor.block.instructions.push({
				type: "storeSuperProperty",
				registers: [member.object, member.key, right, receiver],
			});
		} else {
			cursor.block.instructions.push({
				type: "storeProperty",
				registers: [member.object, member.key, right],
			});
		}
	}

	const assignJoinJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(assignJoinJump);

	const joinIdx = fn.blocks.push({ instructions: [] }) - 1;
	if (assignmentExpression.operator === "||=") {
		// A truthy current value skips the assignment.
		conditionalJump.blocks[0] = joinIdx;
		fallthroughJump.blocks[0] = assignIdx;
	} else {
		// &&= enters on a truthy current value, ??= on a nil one.
		conditionalJump.blocks[0] = assignIdx;
		fallthroughJump.blocks[0] = joinIdx;
	}
	assignJoinJump.blocks[0] = joinIdx;
	cursor.block = fn.blocks[joinIdx]!;

	return result;
}

/**
 * Compile short-circuit logical expressions by branching around the right
 * hand side, with both sides writing the shared result register.
 */
function compileLogicalExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.LogicalExpression,
): number {
	const result = nextRegisterDestination(fn);
	const left = compileExpression(program, fn, cursor, expression.left);
	cursor.block.instructions.push({
		type: "move",
		registers: [result, left],
	});

	// The branch condition: && and || branch on the left value itself, while
	// ?? branches on it being null or undefined.
	let condition = left;
	if (expression.operator === "??") {
		const undefinedRegister = compileUndefined(fn, cursor);
		condition = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "binary",
			registers: [condition, left, undefinedRegister],
			operator: "==",
		});
	}

	const conditionalJump: Extract<IRInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [condition],
		blocks: [-1],
	};
	const fallthroughJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(conditionalJump, fallthroughJump);

	const rightIdx = fn.blocks.push({ instructions: [] }) - 1;
	cursor.block = fn.blocks[rightIdx]!;
	const right = compileExpression(program, fn, cursor, expression.right);
	cursor.block.instructions.push({
		type: "move",
		registers: [result, right],
	});
	const rightJoinJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(rightJoinJump);

	const joinIdx = fn.blocks.push({ instructions: [] }) - 1;
	if (expression.operator === "||") {
		// A truthy left value skips the right side.
		conditionalJump.blocks[0] = joinIdx;
		fallthroughJump.blocks[0] = rightIdx;
	} else {
		// && enters on a truthy left value, ?? enters on a nil left value.
		conditionalJump.blocks[0] = rightIdx;
		fallthroughJump.blocks[0] = joinIdx;
	}
	rightJoinJump.blocks[0] = joinIdx;
	cursor.block = fn.blocks[joinIdx]!;

	return result;
}

/**
 * Compile ternaries with the same branch-and-join structure as logical
 * expressions.
 */
function compileConditionalExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.ConditionalExpression,
): number {
	const result = nextRegisterDestination(fn);
	const condition = compileExpression(program, fn, cursor, expression.test);

	const consequentJump: Extract<IRInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [condition],
		blocks: [-1],
	};
	const alternateJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(consequentJump, alternateJump);

	const consequentIdx = fn.blocks.push({ instructions: [] }) - 1;
	cursor.block = fn.blocks[consequentIdx]!;
	const consequent = compileExpression(program, fn, cursor, expression.consequent);
	cursor.block.instructions.push({
		type: "move",
		registers: [result, consequent],
	});
	const consequentJoinJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(consequentJoinJump);

	const alternateIdx = fn.blocks.push({ instructions: [] }) - 1;
	cursor.block = fn.blocks[alternateIdx]!;
	const alternate = compileExpression(program, fn, cursor, expression.alternate);
	cursor.block.instructions.push({
		type: "move",
		registers: [result, alternate],
	});
	const alternateJoinJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(alternateJoinJump);

	const joinIdx = fn.blocks.push({ instructions: [] }) - 1;
	consequentJump.blocks[0] = consequentIdx;
	alternateJump.blocks[0] = alternateIdx;
	consequentJoinJump.blocks[0] = joinIdx;
	alternateJoinJump.blocks[0] = joinIdx;
	cursor.block = fn.blocks[joinIdx]!;

	return result;
}

/**
 * Compile untagged template literals as a string concatenation chain. The
 * leading quasi keeps the chain string-typed so + coerces the expressions.
 */
function compileTemplateLiteral(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.TemplateLiteral,
): number {
	let result = compileStaticString(
		program,
		fn,
		cursor,
		expression.quasis[0]?.value.cooked ?? "",
	);

	for (let i = 0; i < expression.expressions.length; i++) {
		const part = compileExpression(
			program,
			fn,
			cursor,
			expression.expressions[i] as ESTree.Expression,
		);
		let next = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "binary",
			registers: [next, result, part],
			operator: "+",
		});
		result = next;

		const quasi = expression.quasis[i + 1]?.value.cooked ?? "";
		if (quasi.length > 0) {
			const quasiRegister = compileStaticString(program, fn, cursor, quasi);
			next = nextRegisterDestination(fn);
			cursor.block.instructions.push({
				type: "binary",
				registers: [next, result, quasiRegister],
				operator: "+",
			});
			result = next;
		}
	}

	return result;
}

/**
 * Compile a tagged template `tag`a${x}b`` as `tag(strings, x)`, where `strings`
 * is the frozen template object (cooked array + frozen `.raw`). The `this` for
 * the call follows the same member/non-member rules as an ordinary call. The
 * strings object is built once and cached in a per-site global slot so repeated
 * evaluations of the same tagged template hand the tag a stable object identity
 * (required by the spec — tags routinely use it as a cache key / WeakMap key).
 */
function compileTaggedTemplate(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.TaggedTemplateExpression,
): number {
	const tagNode = expression.tag as unknown as ESTree.Node;

	let callee: number;
	let thisRegister: number;
	if (
		tagNode.type === "MemberExpression" &&
		tagNode.property.type === "PrivateIdentifier"
	) {
		thisRegister = compileExpression(program, fn, cursor, tagNode.object);
		callee = compilePrivateMemberLoad(
			program,
			fn,
			cursor,
			thisRegister,
			`#${tagNode.property.name}`,
		);
	} else if (tagNode.type === "MemberExpression") {
		const member = compileMemberObjectAndKey(program, fn, cursor, tagNode);
		thisRegister = member.object;
		callee = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "loadProperty",
			registers: [callee, member.object, member.key],
		});
	} else {
		callee = compileExpression(program, fn, cursor, expression.tag);
		thisRegister = compileUndefined(fn, cursor);
	}

	const quasis = expression.quasi.quasis;
	const cookedIndices = quasis.map((quasi) =>
		// An invalid escape sequence makes `cooked` null (legal only in a tagged
		// template); -1 encodes that the element is `undefined`.
		typeof quasi.value.cooked === "string"
			? getOrCreateStringConstant(program, quasi.value.cooked)
			: -1,
	);
	const rawIndices = quasis.map((quasi) =>
		getOrCreateStringConstant(program, quasi.value.raw ?? ""),
	);

	const stringsRegister = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createTemplateObject",
		registers: [stringsRegister],
		cacheSlot: program.nextGlobalIndex++,
		cookedIndices,
		rawIndices,
	});

	const args = expression.quasi.expressions.map((argument) =>
		compileExpression(program, fn, cursor, argument),
	);

	const destination = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "call",
		registers: [destination, callee, thisRegister, stringsRegister, ...args],
	});

	return destination;
}

function compileUnaryExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.UnaryExpression,
): number {
	if (expression.operator === "void") {
		compileExpression(program, fn, cursor, expression.argument);
		return compileUndefined(fn, cursor);
	}

	if (expression.operator === "delete") {
		return compileDeleteExpression(program, fn, cursor, expression);
	}

	if (expression.operator === "typeof" && expression.argument.type === "Identifier") {
		const argument = expression.argument;
		const binding = fn.semanticFile.nodeToBinding.get(argument);
		if (binding?.undeclared && !isIRIntrinsic(argument.name)) {
			if (fn.semanticFile.withDynamicNodes.has(argument)) {
				// With-intercepted but otherwise unresolvable: consult the active
				// with-object(s); only if none provide it is the result "undefined".
				return compileWithDynamicTypeof(program, fn, cursor, argument);
			}
			// typeof is the one reference read that resolves unresolvable
			// identifiers to "undefined" instead of throwing.
			return compileStaticString(program, fn, cursor, "undefined");
		}
	}

	if (
		expression.operator !== "!" &&
		expression.operator !== "-" &&
		expression.operator !== "+" &&
		expression.operator !== "~" &&
		expression.operator !== "typeof"
	) {
		return -1;
	}

	const operand = compileExpression(program, fn, cursor, expression.argument);
	const destination = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "unary",
		registers: [destination, operand],
		operator: expression.operator,
	});

	return destination;
}

/**
 * Compile delete. Member targets emit the delete instruction; any other
 * operand only gets evaluated and the result is true. Deleting an identifier
 * cannot reach this point: the parser rejects it in (implied) strict mode.
 */
function compileDeleteExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.UnaryExpression,
): number {
	if (expression.argument.type === "MemberExpression") {
		const { object, key } = compileMemberObjectAndKey(
			program,
			fn,
			cursor,
			expression.argument,
		);
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "deleteProperty",
			registers: [destination, object, key],
		});

		return destination;
	}

	// `delete <identifier>` is only reachable in sloppy mode (strict rejects it).
	if (expression.argument.type === "Identifier") {
		const binding = fn.semanticFile.nodeToBinding.get(expression.argument);
		// An unresolved name OR an intrinsic (both are global-object properties):
		// delete the property. A declared binding cannot be deleted (false below).
		if (binding?.undeclared) {
			// Delete the global object property (true when already absent / configurable).
			const global = nextRegisterDestination(fn);
			cursor.block.instructions.push({
				type: "loadIntrinsic",
				registers: [global],
				intrinsic: "globalThis",
			});
			const key = compileStaticString(program, fn, cursor, binding.name);
			const destination = nextRegisterDestination(fn);
			cursor.block.instructions.push({
				type: "deleteProperty",
				registers: [destination, global, key],
			});
			return destination;
		}
		// A resolvable binding cannot be deleted: `delete x` is false.
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "createBoolean",
			registers: [destination],
			value: false,
		});
		return destination;
	}

	compileExpression(program, fn, cursor, expression.argument);

	const destination = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createBoolean",
		registers: [destination],
		value: true,
	});

	return destination;
}

/**
 * Compile ++ and -- on identifiers and members. The operand goes through
 * ToNumber (unary plus) so the postfix result is the numeric old value.
 */
function compileUpdateExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.UpdateExpression,
): number {
	const operator = expression.operator === "++" ? "+" : "-";

	if (expression.argument.type === "Identifier") {
		const binding = fn.semanticFile.nodeToBinding.get(expression.argument);
		if (!binding) {
			return -1;
		}

		if (binding.kind === "const") {
			// `x++` / `--x` on a const or imported binding is a TypeError.
			return emitThrowTypeError(program, fn, cursor, "Assignment to constant variable.");
		}

		const location = getOrCreateBindingLocation(program, fn, binding);
		const current = loadRegisterFromLocation(fn, cursor.block, location);
		const oldValue = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "unary",
			registers: [oldValue, current],
			operator: "+",
		});

		const one = compileNumberLiteral(fn, cursor, 1);
		const newValue = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "binary",
			registers: [newValue, oldValue, one],
			operator,
		});
		storeRegisterAtLocation(cursor.block, location, newValue);

		return expression.prefix ? newValue : oldValue;
	}

	if (expression.argument.type === "MemberExpression") {
		const member = expression.argument;
		const isPrivate = member.property.type === "PrivateIdentifier";
		const privateName = isPrivate
			? `#${(member.property as ESTree.PrivateIdentifier).name}`
			: "";

		const object = isPrivate ? compileExpression(program, fn, cursor, member.object) : -1;
		const resolved = isPrivate
			? { object, key: -1 }
			: compileMemberObjectAndKey(program, fn, cursor, member);

		// ++/-- loads then stores at the same key, so a computed key is converted
		// to a property key once (running its coercion a single time) and reused.
		const effectiveKey =
			!isPrivate && member.computed && resolved.key >= 0
				? (() => {
						const pk = nextRegisterDestination(fn);
						cursor.block.instructions.push({
							type: "toPropertyKey",
							registers: [pk, resolved.object, resolved.key],
						});
						return pk;
					})()
				: resolved.key;

		const current = isPrivate
			? compilePrivateMemberLoad(program, fn, cursor, object, privateName)
			: (() => {
					const reg = nextRegisterDestination(fn);
					cursor.block.instructions.push({
						type: "loadProperty",
						registers: [reg, resolved.object, effectiveKey],
					});
					return reg;
				})();

		const oldValue = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "unary",
			registers: [oldValue, current],
			operator: "+",
		});

		const one = compileNumberLiteral(fn, cursor, 1);
		const newValue = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "binary",
			registers: [newValue, oldValue, one],
			operator,
		});

		if (isPrivate) {
			compilePrivateMemberStore(program, fn, cursor, object, privateName, newValue);
		} else {
			cursor.block.instructions.push({
				type: "storeProperty",
				registers: [resolved.object, effectiveKey, newValue],
			});
		}

		return expression.prefix ? newValue : oldValue;
	}

	return -1;
}

function assignmentOperatorToBinaryOperator(operator: string) {
	if (operator === "=") {
		throw new Error("Simple assignment has no binary operator");
	}

	const binaryOperator = operator.slice(0, -1);
	if (!isIRBinaryOperator(binaryOperator)) {
		throw new Error(`Unsupported assignment operator ${operator}`);
	}

	return binaryOperator;
}

function compileBinary(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	binaryExpression: ESTree.BinaryExpression,
): number {
	// Ergonomic brand check `#x in obj`: present iff obj carries the declaring
	// class's brand marker.
	if (
		binaryExpression.operator === "in" &&
		(binaryExpression.left as ESTree.Node).type === "PrivateIdentifier"
	) {
		const name = `#${(binaryExpression.left as unknown as ESTree.PrivateIdentifier).name}`;
		const entry = fn.classContext?.privateNames?.get(name);
		const object = compileExpression(program, fn, cursor, binaryExpression.right);
		const brand = entry ? privateBrandBinding(fn, entry) : undefined;
		if (!brand) {
			return -1;
		}

		const brandSymbol = loadCapturedBinding(program, fn, cursor, brand);
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "hasPrivate",
			registers: [destination, object, brandSymbol],
		});
		return destination;
	}

	if (!isIRBinaryOperator(binaryExpression.operator)) {
		throw new Error(`Unsupported binary operator ${binaryExpression.operator}`);
	}

	const left = compileExpression(program, fn, cursor, binaryExpression.left);
	const right = compileExpression(program, fn, cursor, binaryExpression.right);

	const destination = nextRegisterDestination(fn);

	cursor.block.instructions.push({
		type: "binary",

		registers: [destination, left, right],

		operator: binaryExpression.operator,
	});

	return destination;
}

/**
 * The static property name of a non-computed key, used for the __proto__
 * special form and for naming anonymous values.
 */
function staticPropertyName(property: ESTree.Property): string | undefined {
	if (property.computed) {
		return undefined;
	}

	if (property.key.type === "Identifier") {
		return property.key.name;
	}

	if (property.key.type === "Literal" && typeof property.key.value === "string") {
		return property.key.value;
	}

	return undefined;
}

/**
 * If every member is a static, non-index data property (no spread, computed key,
 * accessor, method, __proto__, duplicate, or index-like name, and at most
 * MAL_SHAPE_MAX_INLINE_SLOTS of them), return the ordered key names and value
 * expressions so the literal can be built in one shape; otherwise null.
 */
function staticObjectShape(
	objectExpression: ESTree.ObjectExpression,
): { names: Array<string>; values: Array<ESTree.Expression> } | null {
	const properties = objectExpression.properties;
	if (properties.length < 1 || properties.length > 32) {
		return null;
	}
	const names: Array<string> = [];
	const values: Array<ESTree.Expression> = [];
	const seen = new Set<string>();
	for (const property of properties) {
		if (property.type !== "Property" || property.method || property.kind !== "init") {
			return null;
		}
		const name = staticPropertyName(property);
		if (name === undefined || name === "__proto__" || seen.has(name)) {
			return null;
		}
		// Exclude any index-like name (a canonical numeric string is an integer-
		// indexed key, which lives in the overflow table, not a shape slot).
		if (!Number.isNaN(Number(name))) {
			return null;
		}
		seen.add(name);
		names.push(name);
		values.push(property.value as ESTree.Expression);
	}
	return { names, values };
}

function compileObjectExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	objectExpression: ESTree.ObjectExpression,
): number {
	const staticShape = staticObjectShape(objectExpression);
	if (staticShape !== null) {
		// Evaluate the values left-to-right (keys are constants, so no key
		// evaluation), then build the object directly in its final shape.
		const valueRegisters = staticShape.values.map((value, i) =>
			compileExpression(program, fn, cursor, value, staticShape.names[i]),
		);
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "createObjectShaped",
			registers: [destination, ...valueRegisters],
			keyStringIndices: staticShape.names.map((name) =>
				getOrCreateStringConstant(program, name),
			),
		});
		return destination;
	}

	const object = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createObject",
		registers: [object],
	});

	for (const property of objectExpression.properties) {
		if (property.type === "SpreadElement") {
			// Object spread copies the source's own enumerable properties into
			// the literal under construction.
			const source = compileExpression(program, fn, cursor, property.argument);
			cursor.block.instructions.push({
				type: "mergeDataProperties",
				registers: [object, source],
			});
			continue;
		}

		if (property.type !== "Property") {
			return -1;
		}

		const name = staticPropertyName(property);

		if (
			name === "__proto__" &&
			property.kind === "init" &&
			!property.shorthand &&
			!property.method
		) {
			// B.3.1: a literal `__proto__:` member sets the prototype when the
			// value is an object or null, and is ignored otherwise. Shorthand,
			// computed and method forms define an ordinary own property.
			const prototype = compileExpression(
				program,
				fn,
				cursor,
				property.value as ESTree.Expression,
			);
			cursor.block.instructions.push({
				type: "setPrototype",
				registers: [object, prototype],
				literal: true,
			});
			continue;
		}

		const key = compilePropertyKey(program, fn, cursor, property);

		if (property.kind === "get" || property.kind === "set") {
			const accessor = compileExpression(
				program,
				fn,
				cursor,
				property.value as ESTree.Expression,
				name !== undefined ? `${property.kind} ${name}` : undefined,
			);
			cursor.block.instructions.push({
				type: "defineAccessor",
				registers: [object, key, accessor],
				kind: property.kind,
				enumerable: true,
			});
			continue;
		}

		// PropertyDefinitionEvaluation uses CreateDataProperty: own defines
		// that never run setters inherited from Object.prototype.
		const value = compileExpression(
			program,
			fn,
			cursor,
			property.value as ESTree.Expression,
			name,
		);
		cursor.block.instructions.push({
			type: "defineProperty",
			registers: [object, key, value],
			enumerable: true,
		});
	}

	return object;
}

function compileArrayExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	arrayExpression: ESTree.ArrayExpression,
): number {
	const hasSpread = arrayExpression.elements.some(
		(element) => element?.type === "SpreadElement",
	);

	if (!hasSpread) {
		const array = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "createArray",
			registers: [array],
			length: arrayExpression.elements.length,
		});

		for (let index = 0; index < arrayExpression.elements.length; index++) {
			const element = arrayExpression.elements[index];
			if (!element) {
				continue;
			}

			const key = compileNumberLiteral(fn, cursor, index);
			const value = compileExpression(program, fn, cursor, element);
			// Array-literal elements are CreateDataPropertyOrThrow (own data
			// property), not [[Set]] — so a poisoned Array.prototype index
			// accessor is not consulted.
			cursor.block.instructions.push({
				type: "defineProperty",
				registers: [array, key, value],
				enumerable: true,
			});
		}

		return array;
	}

	// Spread makes the element indexes dynamic: append through a running
	// index register, spreads drain their source iterator.
	const array = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createArray",
		registers: [array],
		length: 0,
	});
	const index = compileNumberLiteral(fn, cursor, 0);
	const one = compileNumberLiteral(fn, cursor, 1);

	for (const element of arrayExpression.elements) {
		if (!element) {
			// Holes only advance the index; the final length store accounts
			// for trailing ones.
			cursor.block.instructions.push({
				type: "binary",
				registers: [index, index, one],
				operator: "+",
			});
			continue;
		}

		if (element.type === "SpreadElement") {
			const source = compileExpression(program, fn, cursor, element.argument);
			const iteratorRegister = nextRegisterDestination(fn);
			const nextRegister = nextRegisterDestination(fn);
			cursor.block.instructions.push({
				type: "getIterator",
				registers: [iteratorRegister, nextRegister, source],
			});
			compileIteratorDrainInto(
				fn,
				cursor,
				array,
				index,
				one,
				iteratorRegister,
				nextRegister,
			);
			continue;
		}

		const value = compileExpression(program, fn, cursor, element);
		cursor.block.instructions.push({
			type: "defineProperty",
			registers: [array, index, value],
			enumerable: true,
		});
		cursor.block.instructions.push({
			type: "binary",
			registers: [index, index, one],
			operator: "+",
		});
	}

	// Trailing holes only bumped the index; sync the length field.
	const lengthKey = compileStaticString(program, fn, cursor, "length");
	cursor.block.instructions.push({
		type: "storeProperty",
		registers: [array, lengthKey, index],
	});

	return array;
}

function compileMemberExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	memberExpression: ESTree.MemberExpression,
): number {
	if (memberExpression.property.type === "PrivateIdentifier") {
		// Private access is never on super and never computed.
		const object = compileExpression(program, fn, cursor, memberExpression.object);
		return compilePrivateMemberLoad(
			program,
			fn,
			cursor,
			object,
			`#${memberExpression.property.name}`,
		);
	}

	const { object, key } = compileMemberObjectAndKey(
		program,
		fn,
		cursor,
		memberExpression,
	);
	const destination = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "loadProperty",
		registers: [destination, object, key],
	});

	return destination;
}

function compileMemberObjectAndKey(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	memberExpression: ESTree.MemberExpression,
) {
	let object: number;
	if (memberExpression.object.type === "Super") {
		object = compileSuperObject(program, fn, cursor);
		if (object === -1) {
			return { object: -1, key: -1 };
		}
	} else {
		object = compileExpression(program, fn, cursor, memberExpression.object);
	}

	const key = memberExpression.computed
		? compileExpression(program, fn, cursor, memberExpression.property)
		: memberExpression.property.type === "Identifier"
			? compileStaticString(program, fn, cursor, memberExpression.property.name)
			: -1;

	return { object, key };
}

/**
 * Resolve the super lookup object: the parent prototype in instance members,
 * the parent itself in static ones.
 */
function compileSuperObject(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
): number {
	const classContext = fn.classContext;
	if (!classContext) {
		return -1;
	}

	if (!classContext.superBinding) {
		if (!classContext.classBinding) {
			return -1;
		}

		// Heritage-less classes resolve super through the home object's live
		// prototype chain, so setPrototypeOf mutations are observed.
		const location = getOrCreateBindingLocation(program, fn, classContext.classBinding);
		let home = loadRegisterFromLocation(fn, cursor.block, location);

		if (!classContext.isStatic) {
			const prototypeKey = compileStaticString(program, fn, cursor, "prototype");
			const prototype = nextRegisterDestination(fn);
			cursor.block.instructions.push({
				type: "loadProperty",
				registers: [prototype, home, prototypeKey],
			});
			home = prototype;
		}

		const object = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "loadPrototype",
			registers: [object, home],
		});

		return object;
	}

	const location = getOrCreateBindingLocation(program, fn, classContext.superBinding);
	const parent = loadRegisterFromLocation(fn, cursor.block, location);
	if (classContext.isStatic) {
		return parent;
	}

	const prototypeKey = compileStaticString(program, fn, cursor, "prototype");
	const object = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "loadProperty",
		registers: [object, parent, prototypeKey],
	});

	return object;
}

function compilePropertyKey(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	property: ESTree.Property,
) {
	if (property.computed) {
		return compileExpression(program, fn, cursor, property.key);
	}

	if (property.key.type === "Identifier") {
		return compileStaticString(program, fn, cursor, property.key.name);
	}

	if (property.key.type === "Literal") {
		return compileLiteral(program, fn, cursor, property.key);
	}

	return -1;
}

function compileStaticString(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	value: string,
) {
	const destination = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createString",
		registers: [destination],
		stringIndex: getOrCreateStringConstant(program, value),
	});

	return destination;
}

/**
 * Materialize a spread-bearing argument list into an array register, plain
 * arguments appended directly and spreads drained through their iterators.
 */
function compileSpreadArgumentsArray(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	args: Array<ESTree.Expression | ESTree.SpreadElement>,
): number {
	const array = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createArray",
		registers: [array],
		length: 0,
	});
	const index = compileNumberLiteral(fn, cursor, 0);
	const one = compileNumberLiteral(fn, cursor, 1);

	for (const arg of args) {
		if (arg.type === "SpreadElement") {
			const source = compileExpression(program, fn, cursor, arg.argument);
			const iteratorRegister = nextRegisterDestination(fn);
			const nextRegister = nextRegisterDestination(fn);
			cursor.block.instructions.push({
				type: "getIterator",
				registers: [iteratorRegister, nextRegister, source],
			});
			compileIteratorDrainInto(
				fn,
				cursor,
				array,
				index,
				one,
				iteratorRegister,
				nextRegister,
			);
			continue;
		}

		const value = compileExpression(program, fn, cursor, arg);
		cursor.block.instructions.push({
			type: "storeProperty",
			registers: [array, index, value],
		});
		cursor.block.instructions.push({
			type: "binary",
			registers: [index, index, one],
			operator: "+",
		});
	}

	return array;
}

function compileCall(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	callExpression: ESTree.CallExpression,
): number {
	const calleeNode = callExpression.callee as unknown as ESTree.Node;
	if ((calleeNode.type as string) === "Import") {
		return -1;
	}

	if (calleeNode.type === "Super") {
		return compileSuperCall(program, fn, cursor, callExpression);
	}

	if (fn.semanticFile.commonjs) {
		// `require("specifier")` resolves at build time to `__cjs_require(id)`.
		const required = tryCompileCjsRequireCall(program, fn, cursor, callExpression);
		if (required !== undefined) {
			return required;
		}
	}

	let callee: number;
	let thisRegister: number;
	if (
		calleeNode.type === "MemberExpression" &&
		calleeNode.property.type === "PrivateIdentifier"
	) {
		// obj.#m(): the receiver is the call's this, and the brand-checked
		// shared function (or accessor result) is the callee.
		thisRegister = compileExpression(program, fn, cursor, calleeNode.object);
		callee = compilePrivateMemberLoad(
			program,
			fn,
			cursor,
			thisRegister,
			`#${calleeNode.property.name}`,
		);
	} else if (calleeNode.type === "MemberExpression") {
		const member = compileMemberObjectAndKey(program, fn, cursor, calleeNode);
		thisRegister = member.object;
		if (calleeNode.object.type === "Super") {
			// Super method calls run on the current instance, not the parent
			// prototype the method was looked up on.
			thisRegister = nextRegisterDestination(fn);
			cursor.block.instructions.push({
				type: "loadThis",
				registers: [thisRegister],
			});
		}
		callee = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "loadProperty",
			registers: [callee, member.object, member.key],
		});
	} else {
		callee = compileExpression(
			program,
			fn,
			cursor,
			calleeNode as ESTree.Expression | ESTree.PrivateIdentifier,
		);
		thisRegister = compileUndefined(fn, cursor);
	}
	if (callExpression.arguments.some((arg) => arg.type === "SpreadElement")) {
		const argumentsArray = compileSpreadArgumentsArray(
			program,
			fn,
			cursor,
			callExpression.arguments,
		);
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "callSpread",
			registers: [destination, callee, thisRegister, argumentsArray],
		});

		return destination;
	}

	const args = callExpression.arguments.map((arg) => {
		if (arg.type === "SpreadElement") {
			return -1;
		}

		return compileExpression(program, fn, cursor, arg);
	});
	const destination = nextRegisterDestination(fn);

	cursor.block.instructions.push({
		type: "call",
		registers: [destination, callee, thisRegister, ...args],
	});

	return destination;
}

/**
 * Compile super(...) as a plain call of the captured parent constructor on
 * the current this. The spec's this-substitution for object returns from the
 * parent is approximated away.
 */
function compileSuperCall(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	callExpression: ESTree.CallExpression,
): number {
	const superBinding = fn.classContext?.superBinding;
	if (!superBinding) {
		return -1;
	}

	const location = getOrCreateBindingLocation(program, fn, superBinding);
	const parent = loadRegisterFromLocation(fn, cursor.block, location);

	// super(...) is [[Construct]](parent, args, new.target): the parent builds
	// `this` (forwarding the derived class's new.target so the instance gets the
	// derived prototype), which the op then binds as the active `this`. The args
	// are collected into an array (handling spread) for the construct.
	const argumentsArray = compileSpreadArgumentsArray(
		program,
		fn,
		cursor,
		callExpression.arguments,
	);
	const destination = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "constructSuper",
		registers: [destination, parent, argumentsArray],
	});

	// InitializeInstanceElements for a derived class runs right after super()
	// returns, with this now initialized.
	if (fn.classContext?.isConstructor) {
		emitInstanceElementInit(program, fn, cursor, fn.classContext);
	}

	return destination;
}

/**
 * Compile a new expression. The VM creates the this value from the callee's
 * prototype property and substitutes non-object return values.
 */
function compileNewExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.NewExpression,
): number {
	const calleeNode = expression.callee as unknown as ESTree.Node;
	if (calleeNode.type === "Super" || (calleeNode.type as string) === "Import") {
		return -1;
	}

	let callee = compileExpression(program, fn, cursor, calleeNode as ESTree.Expression);

	// An unsupported callee expression (e.g. dynamic `import()`) compiles to the
	// "no value" sentinel register -1. Constructing it must throw a TypeError, not
	// read an out-of-range register, so materialize an explicit `undefined`:
	// `new undefined` is a non-constructor and throws deterministically on both
	// backends (and keeps the function out of the native backend's r-1 bail).
	if (callee < 0) {
		callee = nextRegisterDestination(fn);
		cursor.block.instructions.push({ type: "createUndefined", registers: [callee] });
	}

	if (expression.arguments.some((arg) => arg.type === "SpreadElement")) {
		const argumentsArray = compileSpreadArgumentsArray(
			program,
			fn,
			cursor,
			expression.arguments,
		);
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "constructSpread",
			registers: [destination, callee, argumentsArray],
		});

		return destination;
	}

	const args = expression.arguments.map((arg) => {
		if (arg.type === "SpreadElement") {
			return -1;
		}

		return compileExpression(program, fn, cursor, arg);
	});
	const destination = nextRegisterDestination(fn);

	cursor.block.instructions.push({
		type: "construct",
		registers: [destination, callee, ...args],
	});

	return destination;
}

/**
 * Compile identifiers to load instructions.
 *
 * Statements that store the a variable internally handle the store instructions.
 */
function compileIdentifier(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	identifier: ESTree.Identifier,
): number {
	if (fn.semanticFile.withDynamicNodes.has(identifier)) {
		return compileWithDynamicRead(program, fn, cursor, identifier);
	}
	return compileStaticIdentifier(program, fn, cursor, identifier);
}

/**
 * A `with`-intercepted read: probe the active with-object(s) for the name; on a
 * miss (EMPTY sentinel) fall back to the static binding resolution. The two
 * paths join with the value in a single register.
 */
function compileWithDynamicRead(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	identifier: ESTree.Identifier,
): number {
	const result = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "withGet",
		registers: [result],
		nameStringIndex: getOrCreateStringConstant(program, identifier.name),
	});

	const emptyFlag = nextRegisterDestination(fn);
	cursor.block.instructions.push({ type: "isEmpty", registers: [emptyFlag, result] });

	const fallbackJump: Extract<IRInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [emptyFlag],
		blocks: [-1],
	};
	const foundJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(fallbackJump, foundJump);

	// Miss: resolve the static binding into the same result register.
	const fallbackIdx = fn.blocks.push({ instructions: [] }) - 1;
	cursor.block = fn.blocks[fallbackIdx]!;
	const staticValue = compileStaticIdentifier(program, fn, cursor, identifier);
	cursor.block.instructions.push({ type: "move", registers: [result, staticValue] });
	const fallbackJoin: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(fallbackJoin);

	const joinIdx = fn.blocks.push({ instructions: [] }) - 1;
	fallbackJump.blocks[0] = fallbackIdx;
	foundJump.blocks[0] = joinIdx;
	fallbackJoin.blocks[0] = joinIdx;
	cursor.block = fn.blocks[joinIdx]!;

	return result;
}

/**
 * `typeof name` where name is with-intercepted and has no static binding: probe
 * the with-object(s); a hit yields `typeof value`, a miss yields "undefined"
 * (never a ReferenceError — typeof of an unresolvable name does not throw).
 */
function compileWithDynamicTypeof(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	identifier: ESTree.Identifier,
): number {
	const result = nextRegisterDestination(fn);
	const probe = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "withGet",
		registers: [probe],
		nameStringIndex: getOrCreateStringConstant(program, identifier.name),
	});
	const emptyFlag = nextRegisterDestination(fn);
	cursor.block.instructions.push({ type: "isEmpty", registers: [emptyFlag, probe] });

	const missJump: Extract<IRInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [emptyFlag],
		blocks: [-1],
	};
	const hitJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(missJump, hitJump);

	// Hit: typeof the probed value.
	const hitIdx = fn.blocks.push({ instructions: [] }) - 1;
	cursor.block = fn.blocks[hitIdx]!;
	cursor.block.instructions.push({
		type: "unary",
		registers: [result, probe],
		operator: "typeof",
	});
	const hitJoin: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(hitJoin);

	// Miss: the name resolves nowhere → "undefined".
	const missIdx = fn.blocks.push({ instructions: [] }) - 1;
	cursor.block = fn.blocks[missIdx]!;
	const undefinedString = compileStaticString(program, fn, cursor, "undefined");
	cursor.block.instructions.push({ type: "move", registers: [result, undefinedString] });
	const missJoin: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(missJoin);

	const joinIdx = fn.blocks.push({ instructions: [] }) - 1;
	missJump.blocks[0] = missIdx;
	hitJump.blocks[0] = hitIdx;
	hitJoin.blocks[0] = joinIdx;
	missJoin.blocks[0] = joinIdx;
	cursor.block = fn.blocks[joinIdx]!;

	return result;
}

function compileStaticIdentifier(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	identifier: ESTree.Identifier,
): number {
	if (identifier.name === "undefined") {
		return compileUndefined(fn, cursor);
	}

	const binding = fn.semanticFile.nodeToBinding.get(identifier);
	if (!binding) {
		return -1;
	}

	if (binding.undeclared && isIRIntrinsic(identifier.name)) {
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "loadIntrinsic",
			registers: [destination],
			intrinsic: identifier.name,
		});
		return destination;
	}

	if (binding.implicit === "arguments") {
		if (fn.argumentsObjectRegister === undefined) {
			throw new Error("Missing reserved arguments object register");
		}

		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "move",
			registers: [destination, fn.argumentsObjectRegister],
		});

		return destination;
	}

	if (binding.undeclared) {
		// Strict: an unresolvable read throws ReferenceError. Sloppy: it resolves
		// against the global object (still ReferenceError if absent there).
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: isSloppyFunction(fn) ? "loadGlobalProperty" : "loadUndeclared",
			registers: [destination],
			nameStringIndex: getOrCreateStringConstant(program, identifier.name),
		});

		return destination;
	}

	const location = getOrCreateBindingLocation(program, fn, binding);
	const destination = loadRegisterFromLocation(fn, cursor.block, location);

	if (isTdzBinding(binding)) {
		// A let/const/class read before its declaration runs is in the temporal
		// dead zone: throw ReferenceError. Harmless once initialized; bindings
		// that are not hole-inited (catch params, loop vars) never read empty.
		cursor.block.instructions.push({
			type: "throwIfTdz",
			registers: [destination],
			nameStringIndex: getOrCreateStringConstant(program, identifier.name),
		});
	}

	return destination;
}

/**
 * Whether a binding is subject to the temporal dead zone: a let/const/class
 * binding — but not a hoisted function declaration (kind "let" in strict mode)
 * and not an import alias (its storage lives in, and is initialized by, the
 * exporting module).
 */
function isTdzBinding(binding: Binding): boolean {
	return (
		!binding.undeclared &&
		!binding.imported &&
		(binding.kind === "let" || binding.kind === "const") &&
		binding.declarationNode?.type !== "FunctionDeclaration"
	);
}

/**
 * Build an ES module namespace exotic object for `import * as ns from "m"` and
 * store it into the local binding. The runtime serves each export live from its
 * global slot (with TDZ enforcement) plus a @@toStringTag of "Module"; names
 * arrive already sorted from the linker. Exporters are module-top-level (global)
 * bindings; any that somehow are not are skipped.
 */
function emitNamespaceObject(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	binding: Binding,
	exports: Array<{ name: string; exporter: Binding }>,
) {
	const entries: Array<{ nameStringIndex: number; slot: number }> = [];
	for (const { name, exporter } of exports) {
		const location = getOrCreateBindingLocation(program, fn, exporter);
		if (location.type !== "global") {
			continue;
		}
		entries.push({
			nameStringIndex: getOrCreateStringConstant(program, name),
			slot: location.index,
		});
	}

	const namespace = nextRegisterDestination(fn);
	block.instructions.push({
		type: "createModuleNamespace",
		registers: [namespace],
		exports: entries,
	});

	const location = getOrCreateBindingLocation(program, fn, binding);
	storeRegisterAtLocation(block, location, namespace);
}

function loadRegisterFromLocation(
	fn: IRFunction,
	block: IRBlock,
	location: BindingLocation,
) {
	const destination = nextRegisterDestination(fn);
	switch (location.type) {
		case "local": {
			block.instructions.push({
				type: "loadLocal",
				registers: [destination],
				index: location.index,
			});
			break;
		}
		case "global": {
			block.instructions.push({
				type: "loadGlobal",
				registers: [destination],
				index: location.index,
			});
			break;
		}
		case "captured": {
			block.instructions.push({
				type: "loadCaptured",
				registers: [destination],

				functionIndex: location.functionIndex,
				index: location.index,
			});
			break;
		}
		case "globalProperty": {
			// `globalThis[name]` — undefined when not yet assigned (a hoisted var).
			const global = nextRegisterDestination(fn);
			block.instructions.push({
				type: "loadIntrinsic",
				registers: [global],
				intrinsic: "globalThis",
			});
			const key = nextRegisterDestination(fn);
			block.instructions.push({
				type: "createString",
				registers: [key],
				stringIndex: location.nameStringIndex,
			});
			block.instructions.push({
				type: "loadProperty",
				registers: [destination, global, key],
			});
			break;
		}
	}

	return destination;
}

function getArgumentsBinding(
	fn: IRFunction,
	node:
		| ESTree.FunctionDeclaration
		| ESTree.FunctionExpression
		| ESTree.ArrowFunctionExpression,
) {
	if (node.type === "ArrowFunctionExpression") {
		return undefined;
	}

	const scope = fn.semanticFile.nodeToScope.get(node);
	return scope?.bindings.find((binding) => binding.implicit === "arguments");
}

/**
 * The implicit lexical-`this` binding a non-arrow function exposes for nested
 * arrows to capture, or undefined. Arrows never own one (they inherit `this`).
 */
function getLexicalThisBinding(
	fn: IRFunction,
	node:
		| ESTree.FunctionDeclaration
		| ESTree.FunctionExpression
		| ESTree.ArrowFunctionExpression,
) {
	if (node.type === "ArrowFunctionExpression") {
		return undefined;
	}

	const scope = fn.semanticFile.nodeToScope.get(node);
	return scope?.bindings.find((binding) => binding.implicit === "this");
}

function compileLiteral(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	literal: ESTree.Literal,
): number {
	if (
		typeof literal.value === "number" &&
		Number.isInteger(literal.value) &&
		literal.value >= -2147483648 &&
		literal.value <= 2147483647
	) {
		return compileNumberLiteral(fn, cursor, literal.value);
	}

	if (typeof literal.value === "number") {
		// Every remaining number — finite non-integers, integers outside the i32
		// range, AND non-finite values like Infinity from an overflowing literal
		// (e.g. `1e309`) — materializes as an f64. Previously non-finite literals
		// fell through to `return -1` and were silently dropped (the store/call
		// read register -1), corrupting the value.
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "createF64",
			registers: [destination],
			value: literal.value,
		});

		return destination;
	}

	if (typeof literal.value === "boolean") {
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "createBoolean",
			registers: [destination],
			value: literal.value,
		});

		return destination;
	}

	if (typeof literal.value === "string") {
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "createString",
			registers: [destination],
			stringIndex: getOrCreateStringConstant(program, literal.value),
		});

		return destination;
	}

	if (typeof literal.value === "bigint") {
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "createBigint",
			registers: [destination],
			bigintIndex: getOrCreateBigintConstant(program, literal.value),
		});

		return destination;
	}

	if (literal.value === null) {
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "createNull",
			registers: [destination],
		});

		return destination;
	}

	// A regex literal `/pattern/flags` lowers to `new %RegExp%(pattern, flags)`.
	// Using the RegExp intrinsic (not a global lookup) matches the spec: a literal
	// always uses the original %RegExp%, immune to reassigning the global binding.
	// (The compiled matcher is rebuilt per evaluation; a per-site cache is a
	// possible later optimization.)
	if ("regex" in literal && literal.regex) {
		const constructor = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "loadIntrinsic",
			registers: [constructor],
			intrinsic: "RegExp",
		});
		const patternReg = compileStaticString(program, fn, cursor, literal.regex.pattern);
		const flagsReg = compileStaticString(program, fn, cursor, literal.regex.flags);
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "construct",
			registers: [destination, constructor, patternReg, flagsReg],
		});

		return destination;
	}

	return -1;
}

function compileUndefined(fn: IRFunction, cursor: IRCursor) {
	const destination = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createUndefined",
		registers: [destination],
	});

	return destination;
}

function compileNumberLiteral(fn: IRFunction, cursor: IRCursor, value: number) {
	const destination = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createNumber",
		registers: [destination],

		value,
	});

	return destination;
}

export function getOrCreateStringConstant(program: IntermediateProgram, value: string) {
	const existing = program.stringConstantToIndex.get(value);
	if (existing !== undefined) {
		return existing;
	}

	const codeUnits = [];
	for (let i = 0; i < value.length; i++) {
		codeUnits.push(value.charCodeAt(i));
	}

	const index = program.stringConstants.push(codeUnits) - 1;
	program.stringConstantToIndex.set(value, index);
	return index;
}

function getOrCreateSourcePosition(
	program: IntermediateProgram,
	line: number,
	column: number,
): number {
	const key = `${line}:${column}`;
	const existing = program.sourcePositionToIndex.get(key);
	if (existing !== undefined) {
		return existing;
	}

	const index = program.sourcePositions.push({ line, column }) - 1;
	program.sourcePositionToIndex.set(key, index);
	return index;
}

/**
 * Append an *inline* source position: code from `inlinedFunctionIndex` at
 * (line, column) that was inlined at `callerPosId` (a position one level out).
 * Not interned (each inline site is distinct). The trace formatter walks the
 * `callerPosId` chain, emitting one frame per inline level. Used by the inliner.
 */
export function addInlineSourcePosition(
	program: IntermediateProgram,
	line: number,
	column: number,
	inlinedFunctionIndex: number,
	callerPosId: number,
): number {
	return program.sourcePositions.push({ line, column, inlinedFunctionIndex, callerPosId }) - 1;
}

/**
 * Emit a source-position marker for `node` into `block`. A no-op when the node
 * carries no location (synthesized nodes). The marker sets the source position
 * inherited by every following instruction until the next marker.
 */
function emitSourcePos(
	program: IntermediateProgram,
	block: IRBlock,
	node: ESTree.Node,
): void {
	const loc = node.loc;
	if (!loc) {
		return;
	}

	block.instructions.push({
		type: "sourcePos",
		pos: getOrCreateSourcePosition(program, loc.start.line, loc.start.column),
	});
}

function getOrCreateBigintConstant(program: IntermediateProgram, value: bigint) {
	const existing = program.bigintConstantToIndex.get(value);
	if (existing !== undefined) {
		return existing;
	}

	const index = program.bigintConstants.push(value) - 1;
	program.bigintConstantToIndex.set(value, index);
	return index;
}

/**
 * We use virtual register per function in this conversion pass.
 *
 * At a later compiler stage these should be optimized to reduce the number of registers needed
 * with things like live-ness checking.
 */
function nextRegisterDestination(fn: IRFunction) {
	return fn.nextRegisterDestination++;
}

/**
 * Get or create a binding location.
 * We use incremental indices to assign unique locations to bindings. Memoizing the location
 * per binding.
 */
function getOrCreateBindingLocation(
	program: IntermediateProgram,
	fn: IRFunction,
	binding: Binding,
) {
	let location = program.bindingToStorage.get(binding);
	if (!location) {
		switch (binding.scopedTo) {
			case "local": {
				location = {
					type: "local",
					index: fn.nextLocalIndex++,
				};
				break;
			}
			case "captured": {
				location = {
					type: "captured",
					functionIndex: fn.functionIndex,
					index: fn.nextCapturedIndex++,
				};
				break;
			}
			case "global": {
				if (isScriptGlobalProperty(fn.semanticFile, binding)) {
					location = {
						type: "globalProperty",
						nameStringIndex: getOrCreateStringConstant(program, binding.name),
					};
				} else {
					location = {
						type: "global",
						index: program.nextGlobalIndex++,
					};
				}
				break;
			}
			default:
				throw new Error(
					`Unknown binding scope: ${binding.scopedTo} ${binding.name} ${binding.kind}`,
				);
		}

		program.bindingToStorage.set(binding, location);
	}

	return location;
}

/**
 * Store register at a binding location.
 */
function storeRegisterAtLocation(
	block: IRBlock,
	location: BindingLocation,
	register: number,
) {
	switch (location.type) {
		case "local": {
			block.instructions.push({
				type: "storeLocal",
				registers: [register],
				index: location.index,
			});
			break;
		}
		case "global": {
			block.instructions.push({
				type: "storeGlobal",
				registers: [register],
				index: location.index,
			});
			break;
		}
		case "captured": {
			block.instructions.push({
				type: "storeCaptured",
				registers: [register],

				functionIndex: location.functionIndex,
				index: location.index,
			});
			break;
		}
		case "globalProperty": {
			block.instructions.push({
				type: "storeGlobalProperty",
				registers: [register],
				nameStringIndex: location.nameStringIndex,
			});
			break;
		}
	}
}

/**
 * Things like if-statements don't need a full block body so might be bare statements.
 * We convert them to an array so we can keep if simple signature when compiling blocks.
 */
function normalizeStatementOrBlock(statement: ESTree.Statement) {
	if (statement.type === "BlockStatement") {
		return statement.body;
	}

	return [statement];
}
