import type { ESTree } from "meriyah";
import type { PlatformData } from "../../platform/catalog.ts";
import { debugEnabled, log } from "../../utils.ts";
import { isPureDataCjsModule } from "../frontend/cjs-exports.ts";
import {
	DIRECT_EVAL_PRIVATE_FIELD,
	DIRECT_EVAL_PRIVATE_GETTER,
	DIRECT_EVAL_PRIVATE_METHOD,
	DIRECT_EVAL_PRIVATE_SETTER,
	DIRECT_EVAL_PRIVATE_STATIC,
	directEvalDirtyTrackerKey,
	directEvalHomeScopeKey,
	directEvalInstanceInitializerScopeKey,
	directEvalPrivateScopeKey,
	directEvalPersistentScopeKey,
	directEvalScopeObjectKey,
	directEvalSuperConstructorScopeKey,
	directEvalSuperNewTargetScopeKey,
	directEvalSuperThisStateScopeKey,
	encodeDirectEvalContext,
} from "../frontend/direct-eval-context.ts";
import type {
	DirectEvalContext,
	DirectEvalPrivateNameContext,
	DirectEvalPrivateSlot,
} from "../frontend/direct-eval-context.ts";
import {
	ESTREE_SKIP,
	ESTREE_STOP,
	traverseEstree,
} from "../frontend/estree-traversal.ts";
import { linkModules } from "../frontend/linker.ts";
import { COMMONJS_BINDINGS } from "../frontend/semantic-analysis.ts";
import { FUNCTION_UNIT_NODE_TYPES } from "../frontend/semantic-analysis.ts";
import type {
	Binding,
	Scope,
	SemanticFile,
	SemanticProgram,
	StaticArgumentsAccess,
} from "../frontend/semantic-analysis.ts";
import { SyntaxDiagnostic } from "../frontend/syntax-diagnostic.ts";
import {
	compilerFactIsWorldInvariant,
	conservativeCompilerProgramFacts,
} from "../shared/compiler-facts.ts";
import type { CompilerProgramFacts } from "../shared/compiler-facts.ts";
import type {
	CompilerBinaryOperator,
	CompilerInstruction,
	CompilerIntrinsic,
} from "../shared/compiler-instruction.ts";
import {
	NATIVE_STRING_SWITCH_CASE_LIMIT,
	NATIVE_STRING_SWITCH_CODE_UNIT_LIMIT,
} from "../shared/native-string-switch.ts";
import { coreProgramDataFromSemantic } from "./core-compilation.ts";
import type {
	CoreCapturedSlotRef,
	ConstructedCoreCompilation,
	CoreHostInstallCandidate,
} from "./core-compilation.ts";
import { CoreEditor } from "./core-editor.ts";
import { formatCoreProgram } from "./core-format.ts";
import {
	emitCoreEntryInstructions,
	finishDirectCoreFunction,
	initializeDirectCoreFunction,
} from "./core-frontend-construction.ts";
import type {
	CoreConstructionBlock,
	CoreInstructionEmitter,
} from "./core-frontend-construction.ts";
import { coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import { verifyCoreProgram } from "./core-ir-verifier.ts";
import { CoreProgram } from "./core-store.ts";

interface CoreFrontendContext {
	/**
	 * The semantic program that we are compiling.
	 */
	semantic: SemanticProgram;
	core: CoreProgram;
	/** Shared immutable analysis seed and program summaries. */
	facts: CompilerProgramFacts;
	intrinsicGlobalReads: boolean;

	/**
	 * Eval-completion mode: compile the entry (Script) so it returns its
	 * completion value instead of undefined. Set only when compiling source for
	 * runtime `eval`; off for ordinary programs and for nested function bodies
	 * (which keep their own `return` semantics).
	 */
	evalCompletion: boolean;

	/**
	 * Direct-eval mode: compiling source for a *direct* eval, where free
	 * (undeclared) identifiers may resolve against the caller's scope. Encoded
	 * caller bindings use the `with`-dynamic path (withGet/withSet) before falling
	 * back to the global. Off for indirect eval and ordinary programs.
	 */
	evalDirect: boolean;
	/** Inherited syntax/private shape for a dynamically compiled direct eval. */
	directEvalContext: DirectEvalContext;
	/** Internal values captured by a direct-eval entry for precise writeback. */
	directEvalScopeObjectBinding?: Binding;
	directEvalDirtyTrackerBinding?: Binding;
	directEvalPersistentScopeBinding?: Binding;

	nextFunctionIndex: number;
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
	 * Prefix-encoded immutable data-literal templates. Instructions reference an
	 * offset in this flat u32 stream; evaluation instantiates a fresh mutable graph.
	 */
	literalTemplateData: Array<number>;

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
	/** Module path to its lazy init function, or null when merged/eagerly initialized. */
	compiledModuleInitForPaths: Map<string, number | null>;

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

	/** Keep track of which function nodes we compiled already. */
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
	 * `export default` value, keyed by module path (see
	 * src/compiler/frontend/linker.ts).
	 */
	moduleDefaultBinding: Map<string, Binding>;

	/**
	 * `import * as ns` namespace objects to build per importing module path (see
	 * src/compiler/frontend/linker.ts): the local binding plus the exported names
	 * and the exporter
	 * binding each property reads live.
	 */
	namespaceImports: Map<
		string,
		Array<{
			binding: Binding;
			module: string;
			deferred: boolean;
			exports: Array<{ name: string; exporter: Binding }>;
		}>
	>;
	moduleNamespaces: Map<string, Array<{ name: string; exporter: Binding }>>;
	dynamicModuleStatusSlot: Map<string, number>;
	moduleEvaluationErrorSlot: Map<string, number>;
	deferredModuleNamespaceSlot: Map<string, number>;
	moduleNamespaceSlot: Map<string, number>;

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
	 * initialize from `require(cjsPath)` (see src/compiler/frontend/linker.ts).
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

	/** Stable namespace-object slots for ES modules reached by CommonJS require. */
	cjsEsmNamespaceSlot: Map<string, number>;

	/** Stable exports-object slots for host built-ins reached by CommonJS require. */
	cjsHostSlot: Map<string, number>;

	/**
	 * Host built-in (`node:*`) modules reachable in the graph, each with the
	 * synthetic global bindings backing its exports (see
	 * src/compiler/frontend/linker.ts). After
	 * compilation program-image resolves the bindings that got a global slot to build the
	 * install manifest; an imported-but-unused export never gets a slot and drops
	 * out (dead-code elimination). Empty unless a `node:*` module is imported.
	 */
	hostModules: Array<{
		specifier: string;
		installer: string;
		exports: Array<{
			name: string;
			binding: Binding;
			constant?: PlatformData;
		}>;
	}>;

	/**
	 * Free Node globals installed with `process` (see
	 * src/compiler/frontend/linker.ts).
	 * `retained` becomes true when reachable compilation encounters it; program-image
	 * then emits its slot-free installer manifest. Null otherwise.
	 */
	hostProcess: { installer: string; retained: boolean } | null;

	/** Free global `Buffer`, installed by the same installer as `node:buffer`. */
	hostBuffer: { installer: string; retained: boolean } | null;
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
			// A script top-level `var`/`function`: a property of the global object
			// (read/written by name), so it is observable as `globalThis.x`.
			// Modules keep the fast flat-slot `global` storage.
			type: "globalProperty";
			nameStringIndex: number;
	  };

/**
 * A single private member's resolution, shared by every function of the class
 * through the class context. Exactly one of field/method/get/set is populated:
 * a field carries its own-property key symbol, a method carries the shared
 * function value, an accessor carries its get/set functions. brandBinding is
 * the brand marker of the *declaring* class, so access from a nested class
 * brand-checks against the right class.
 */
interface SemanticPrivateName {
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
type SemanticInstanceFieldKey =
	// Non-computed public key, the own-property name.
	| { kind: "name"; name: string }
	// Computed key, converted once at class definition and captured.
	| { kind: "captured"; binding: Binding };

type SemanticInstanceFieldPlanEntry =
	| {
			private: true;
			fieldBinding: Binding;
			valueNode: ESTree.Expression | null;
			nameHint: string;
			initializerNode: ESTree.PropertyDefinition;
	  }
	| {
			private: false;
			key: SemanticInstanceFieldKey;
			valueNode: ESTree.Expression | null;
			initializerNode: ESTree.PropertyDefinition;
	  };

/**
 * A static class element in source order, run once by the static initializer
 * with this = the constructor: a static field install or a static block body.
 */
type SemanticStaticElement =
	| { kind: "field"; entry: SemanticInstanceFieldPlanEntry }
	| { kind: "block"; node: ESTree.StaticBlock; body: Array<ESTree.Statement> };

/**
 * Class body context carried by constructor and method functions so super
 * references can reach the parent class through its captured binding.
 */
interface SemanticClassContext {
	superBinding?: Binding;

	/**
	 * The class constructor itself, for heritage-less classes: super
	 * references resolve dynamically through the home object's prototype
	 * chain so setPrototypeOf mutations are observed.
	 */
	classBinding?: Binding;

	/**
	 * Object-literal methods/accessors: the [[HomeObject]] is the object literal
	 * itself, held in a captured binding. `super.x` resolves to
	 * GetPrototypeOf(homeObject).x (ECMA-262 GetSuperBase). Distinct from a
	 * class home (there is no `prototype` indirection and never static).
	 */
	homeObjectBinding?: Binding;

	isStatic: boolean;

	/**
	 * The private environment, shared by the constructor and every method:
	 * the per-class-evaluation symbols and brand markers are captured so any
	 * `#x` reference resolves lexically with no dynamic lookup.
	 */
	privateNames?: Map<string, SemanticPrivateName>;
	instanceBrandBinding?: Binding;
	staticBrandBinding?: Binding;

	/**
	 * Constructor-only: drives where InitializeInstanceElements is woven in.
	 * Base constructors install at the body prologue; derived constructors
	 * install right after super() returns.
	 */
	isConstructor?: boolean;
	isDerivedConstructor?: boolean;
	instanceFieldPlan?: Array<SemanticInstanceFieldPlanEntry>;

	/** Shared derived-constructor environment used by lexical arrows and eval. */
	usesSharedSuperState?: boolean;
	superThisStateBinding?: Binding;
	superNewTargetBinding?: Binding;
	instanceInitializerBinding?: Binding;
}

interface CoreFrontendFunction {
	semanticFile: SemanticFile;
	functionIndex: number;

	/**
	 * Eval-completion variable (see CoreFrontendContext.evalCompletion). When set,
	 * this is the Script entry function: statement evaluation maintains its
	 * completion value here, the function returns it, and it is initialized to
	 * undefined at entry. Undefined on every other function.
	 */
	completionRegister?: number;
	/** Activation-owned object containing sloppy eval-created var bindings. */
	directEvalPersistentScopeRegister?: number;

	/**
	 * Set while compiling this function's parameter expressions (defaults / rest /
	 * destructuring). A sloppy direct eval encountered here cannot hoist a var over
	 * a parameter-environment binding. Non-arrow functions put their implicit
	 * `arguments` binding there too; arrows only have explicit parameter bindings.
	 */
	inParameterExpression?: boolean;

	/**
	 * Set while compiling a public/private field initializer (woven into the
	 * constructor frame). A field initializer runs via [[Call]], so new.target is
	 * undefined even though the constructor's frame carries the class as
	 * new.target — MetaProperty compiles to undefined in this context.
	 */
	inFieldInitializer?: boolean;

	/**
	 * String constant index of the function name, empty string for anonymous
	 * functions.
	 */
	nameStringIndex: number;

	blocks: Array<CoreFrontendBlock>;
	argumentsObjectRegister?: number;
	/** Prologue snapshots for statically classified direct arguments reads. */
	staticArgumentsRegisters?: Map<ESTree.Node, number>;
	/** Live parameter bindings for statically classified mapped index reads. */
	staticMappedArgumentBindings?: Map<ESTree.Node, Binding>;
	/** Register cache for the lazily created missing-index arguments object. */
	staticArgumentsFallbackRegister?: number;
	classContext?: SemanticClassContext;

	/**
	 * Whether this function owns a `prototype` property. Constructors (normal
	 * function declarations/expressions, class constructors) and generators /
	 * async generators do; methods, getters, setters, arrows and async
	 * (non-generator) functions do not. Undefined defaults to true; the method /
	 * accessor / arrow sites set it false.
	 */
	hasPrototype?: boolean;
	lexicalThis?: boolean;

	/**
	 * For a derived constructor whose `this` is captured by a nested arrow: the
	 * implicit lexical-`this` binding (a captured cell). super() refreshes the
	 * cell with the bound `this` so the arrow observes it. Undefined otherwise.
	 */
	lexicalThisBinding?: Binding;

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
	 * Number of boxed ABI parameters before evaluating and assigning destructured
	 * arguments.
	 */
	parameterCount: number;

	/** Captured binding slot for each mapped Arguments index, or undefined when unmapped. */
	mappedArgumentSlots?: Array<number>;
	mappedArguments?: boolean;

	/**
	 * The Function.prototype.length value: formal parameters before the first
	 * default or rest parameter. Differs from parameterCount, which keeps the
	 * full formal count for the calling convention.
	 */
	length: number;

	/**
	 * The next function-local variable identity used by direct SSA construction.
	 */
	nextCoreVariable: number;

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
	loops?: Array<SemanticControlContext>;

	/**
	 * Labels collected by a LabeledStatement, consumed by the immediately
	 * following loop/switch when it creates its context so labeled break and
	 * continue can target it.
	 */
	pendingLabels?: Array<string>;
}

interface SemanticControlContext {
	/**
	 * break targets the innermost breakable (loop/switch) or, when labeled, the
	 * matching labeled scope; continue the innermost / matching loop. "label"
	 * marks a labeled non-loop statement, a break-only target. "finally" entries
	 * carry no target but sit on the same stack so abrupt completions route
	 * through enclosing finalizers in lexical order. "with" entries likewise carry
	 * no target; they pop the active with-object as control leaves the body.
	 * "iterator" entries track a destructuring iterator across suspension.
	 */
	kind: "loop" | "switch" | "finally" | "label" | "with" | "iterator";
	breakJumps: Array<Extract<CompilerInstruction, { type: "jump" }>>;
	continueJumps: Array<Extract<CompilerInstruction, { type: "jump" }>>;

	/**
	 * Labels attached to this scope (a single statement may carry several).
	 */
	labels?: Set<string>;

	/**
	 * for-of loops carry their iterator register so break and return can
	 * emit the spec IteratorClose before leaving the loop.
	 */
	iteratorRegister?: number;
	/** Stable IteratorRecord.[[Done]] state for conditional, single-shot cleanup. */
	iteratorDoneRegister?: number;
	/** Non-throw exits propagate return() failures and validate its result. */
	iteratorCloseNormal?: boolean;
	/** Async iterators await return() before completing the enclosing exit. */
	iteratorCloseAsync?: boolean;

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
	finallyEntryJumps?: Array<Extract<CompilerInstruction, { type: "jump" }>>;
	completionKindReg?: number;
	completionValueReg?: number;
	disposeCapabilityLocation?: BindingLocation;
	disposeAsync?: boolean;

	/**
	 * For kind === "finally": the abrupt-completion dispatch arms that actually
	 * route through this finalizer. Keyed by routing identity (e.g. "return",
	 * "break", "continue:outer") so each distinct target gets one arm; each
	 * carries a unique kind code and the epilogue re-dispatch for it. NORMAL
	 * needs no arm (it falls through).
	 */
	finalizerArms?: Map<string, { kind: number; fill: (block: CoreFrontendBlock) => void }>;
}

interface CoreFrontendBlock extends CoreConstructionBlock {
	emitter: CoreInstructionEmitter;
}

/**
 * Mutable handle to the block currently being emitted into.
 *
 * Short-circuit expressions create blocks mid-expression and advance the
 * cursor, so instructions following a sub-expression land in the right block.
 */
interface CoreFrontendCursor {
	block: CoreFrontendBlock;
}

const unboundCoreEmitter: CoreInstructionEmitter = {
	emitLiteralSwitch() {
		throw new Error("Core frontend block is not attached to a function");
	},
	emit() {
		throw new Error("Core frontend block is not attached to a function");
	},
	last() {
		return undefined;
	},
};

const compilerPrivateIntrinsics = new Set<string>([
	"__cjs_require",
	"__directEval",
	"__dynamicImport",
	"__configureDeferredNamespace",
	"__evaluateModuleSync",
	"__newDisposeCapability",
	"__addDisposableResource",
	"__disposeResources",
]);

const compilerIntrinsics = new Set<string>([
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
	"DisposableStack",
	"AsyncDisposableStack",
	"SuppressedError",
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
	"Atomics",
	"Reflect",
	"Proxy",
	"console",
	"globalThis",
	"eval",
	"NaN",
	"Infinity",
	...compilerPrivateIntrinsics,
]);

function identifierLoadsIntrinsic(
	program: CoreFrontendContext,
	name: string,
): name is CompilerIntrinsic {
	// NaN and Infinity are non-writable, non-configurable globals in every policy.
	return (
		compilerIntrinsics.has(name) &&
		(program.intrinsicGlobalReads ||
			name === "NaN" ||
			name === "Infinity" ||
			compilerPrivateIntrinsics.has(name) ||
			compilerFactIsWorldInvariant(program.facts.immutableGlobalBindings.get(name)))
	);
}

const compilerBinaryOperators = new Set<string>([
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

function isCompilerBinaryOperator(operator: string): operator is CompilerBinaryOperator {
	return compilerBinaryOperators.has(operator);
}

/**
 * Construct canonical Core directly from a semantically analyzed program.
 *
 * Choosing a tracing compiler might bite us in the back later, as we might drop things like
 * functions that are used in dynamic `eval`. But for now it has some advantages:
 *
 * - We can easily skip behavior that we don't support yet.
 * - We do some dead code elimination as well.
 *
 * We might never support dynamic eval tho, so in that case we are all setup ;)
 */
export function constructSemanticProgramCore(
	semantic: SemanticProgram,
	options: {
		evalCompletion?: boolean;
		evalDirect?: boolean;
		directEvalContext?: DirectEvalContext;
		facts?: CompilerProgramFacts;
		intrinsicGlobalReads?: boolean;
	} = {},
): ConstructedCoreCompilation {
	const program: CoreFrontendContext = {
		semantic,
		core: new CoreProgram(coreOpcodeRegistry),
		facts: options.facts ?? conservativeCompilerProgramFacts(),
		intrinsicGlobalReads: options.intrinsicGlobalReads ?? false,
		evalCompletion: options.evalCompletion ?? false,
		evalDirect: options.evalDirect ?? false,
		directEvalContext: options.directEvalContext ?? {
			allowSuperProperty: false,
			allowSuperCall: false,
			hasInstanceInitializer: false,
			allowNewTarget: false,
			privateNames: [],
			varConflictNames: [],
			varEnvironmentNames: [],
			varEnvironmentIsGlobal: false,
		},

		nextFunctionIndex: 0,
		stringConstants: [],
		stringConstantToIndex: new Map(),

		sourcePositions: [],
		sourcePositionToIndex: new Map(),

		bigintConstants: [],
		bigintConstantToIndex: new Map(),
		literalTemplateData: [],

		bindingFunctionNode: new Map(),

		compiledModuleInitForPaths: new Map(),
		bindingToStorage: new Map(),
		nextLoopScopeId: -1,
		nodeToFunctionCache: new Map(),

		nextGlobalIndex: 0,

		moduleDefaultBinding: new Map(),
		namespaceImports: new Map(),
		moduleNamespaces: new Map(),
		dynamicModuleStatusSlot: new Map(),
		moduleEvaluationErrorSlot: new Map(),
		deferredModuleNamespaceSlot: new Map(),
		moduleNamespaceSlot: new Map(),

		cjsModuleId: new Map(),
		cjsWrapperFunctionIndex: [],
		cjsImports: new Map(),
		cjsEagerSlot: new Map(),
		cjsEsmNamespaceSlot: new Map(),
		cjsHostSlot: new Map(),

		hostModules: [],
		hostProcess: null,
		hostBuffer: null,
	};

	// Cross-module linking: aliases imported names to their exporter bindings (a
	// no-op for a single-module program). Must run before frontend lowering so
	// identifier resolution sees the aliased bindings.
	const linkage = linkModules(semantic);
	for (const [path, binding] of linkage.moduleDefaultBinding) {
		program.moduleDefaultBinding.set(path, binding);
	}
	for (const [path, imports] of linkage.namespaceImports) {
		program.namespaceImports.set(path, imports);
	}
	for (const [path, exports] of linkage.moduleNamespaces) {
		program.moduleNamespaces.set(path, exports);
	}
	for (const [path, imports] of linkage.cjsImports) {
		program.cjsImports.set(path, imports);
	}
	// Host-module bindings resolve to slots as reachable code compiles. Process
	// instead records reachable compilation without allocating a private slot.
	program.hostModules = linkage.hostModules;
	program.hostProcess = linkage.hostProcess
		? { installer: linkage.hostProcess.installer, retained: false }
		: null;
	program.hostBuffer = linkage.hostBuffer
		? { installer: linkage.hostBuffer.installer, retained: false }
		: null;

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
		classifyCommonJsHostModules(program);
		compileMergedModuleInit(program, evaluationOrder);
		compileCjsWrappers(program);
	}

	const compilation = finishCoreProgram(program);
	if (debugEnabled) log.debug(formatCoreProgram(compilation.program));
	verifyCoreProgram(compilation.program, { stage: "construction" }, compilation.context);
	return compilation;
}

function finishCoreProgram(program: CoreFrontendContext): ConstructedCoreCompilation {
	const hostInstallCandidates = coreHostInstallCandidates(program);
	CoreEditor.configureProgram(program.core, {
		stringConstants: program.stringConstants,
		bigintConstants: program.bigintConstants,
		literalTemplateData: program.literalTemplateData,
		sourcePositions: program.sourcePositions,
		globalCount: program.nextGlobalIndex,
	});
	const candidates = coreSingleAssignmentCellCandidates(program);
	return {
		program: program.core,
		context: {
			facts: program.facts,
			data: coreProgramDataFromSemantic(program.semantic, {
				cjsModuleFunctionIndices: [...program.cjsWrapperFunctionIndex],
				hostInstallCandidates,
				pureModuleInitializers: [...program.compiledModuleInitForPaths].flatMap(
					([modulePath, functionIndex]) => {
						if (
							functionIndex === null ||
							program.semantic.graph?.modules.get(modulePath)?.platform?.evaluation !==
								"side-effect-free"
						)
							return [];
						return [
							{
								functionIndex,
								exportSlots: (program.moduleNamespaces.get(modulePath) ?? []).flatMap(
									({ exporter }) => {
										const location = program.bindingToStorage.get(exporter);
										return location?.type === "global" ? [location.index] : [];
									},
								),
							},
						];
					},
				),
				singleAssignmentGlobalSlots: candidates.singleAssignmentGlobalSlots,
				singleAssignmentCapturedSlots: candidates.singleAssignmentCapturedSlots,
				retainedHostInstallers: [program.hostProcess, program.hostBuffer]
					.flatMap((host) => (host?.retained === true ? [host.installer] : []))
					.filter(
						(installer, index, installers) => installers.indexOf(installer) === index,
					),
			}),
		},
	};
}

/**
 * Compiler-owned cells eligible for the whole-Core single-assignment proof.
 *
 * `const` and a named function expression's own-name binding are source-level
 * immutable candidates. Mutable captured lets require a whole-Core writer proof,
 * so they are published only by the later analysis layer rather than becoming a
 * frontend fact. Imported names are already aliased to their exporting binding.
 */
function coreSingleAssignmentCellCandidates(program: CoreFrontendContext): {
	singleAssignmentGlobalSlots: Array<number>;
	singleAssignmentCapturedSlots: Array<CoreCapturedSlotRef>;
} {
	const globals = new Set<number>();
	const captured = new Map<string, CoreCapturedSlotRef>();
	for (const [binding, location] of program.bindingToStorage) {
		const sourceImmutable =
			binding.kind === "const" || binding.immutableSelfReference === true;
		if (sourceImmutable && location.type === "global") globals.add(location.index);
		else if (sourceImmutable && location.type === "captured") {
			captured.set(`${location.functionIndex}:${location.index}`, {
				owner: location.functionIndex,
				index: location.index,
			});
		}
	}
	return {
		singleAssignmentGlobalSlots: [...globals].sort((left, right) => left - right),
		singleAssignmentCapturedSlots: [...captured.values()].sort(
			(left, right) => left.owner - right.owner || left.index - right.index,
		),
	};
}

function coreHostInstallCandidates(
	program: CoreFrontendContext,
): Array<CoreHostInstallCandidate> {
	const candidates = new Map<
		string,
		Array<CoreHostInstallCandidate["exports"][number]>
	>();
	for (const hostModule of program.hostModules) {
		const entries = candidates.get(hostModule.installer) ?? [];
		for (const { name, binding, constant } of hostModule.exports) {
			const location = program.bindingToStorage.get(binding);
			if (location?.type === "global") {
				entries.push({
					name,
					slot: location.index,
					...(constant === undefined ? {} : { constant }),
				});
				if (constant !== undefined) {
					const pending = [constant];
					while (pending.length > 0) {
						const value = pending.pop()!;
						getOrCreateStringConstant(program, typeof value);
						if (typeof value === "string") getOrCreateStringConstant(program, value);
						else if (value !== null && typeof value === "object")
							pending.push(...Object.values(value));
					}
				}
			}
		}
		if (entries.length > 0) candidates.set(hostModule.installer, entries);
	}
	return [...candidates].map(([installer, entries]) => ({
		installer,
		exports: entries,
	}));
}

function registerCoreFunction(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
): void {
	if (fn.functionIndex !== program.nextFunctionIndex) {
		throw new Error(
			`Core function ${fn.functionIndex} is out of sequence; expected ${program.nextFunctionIndex}`,
		);
	}
	initializeDirectCoreFunction(program.core, fn);
	program.nextFunctionIndex++;
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
	program: CoreFrontendContext,
	evaluationOrder: Array<string>,
	cjsEntryId?: number,
) {
	const fileByPath = new Map(program.semantic.files.map((file) => [file.path, file]));

	// Nested functions are traced lazily and would otherwise try to compile a
	// separate per-file init; mark every module compiled up front since the
	// merged init already covers every module's top-level.
	for (const modulePath of evaluationOrder) {
		if (
			program.semantic.graph?.modules.get(modulePath)?.platform?.evaluation !==
			"side-effect-free"
		)
			program.compiledModuleInitForPaths.set(modulePath, null);
	}

	const fn: CoreFrontendFunction = {
		// Switched to each module in turn so identifier resolution uses the right
		// file's bindings while compiling that module's segment.
		semanticFile: program.semantic.files[0]!,
		functionIndex: program.nextFunctionIndex,
		nameStringIndex: getOrCreateStringConstant(program, ""),
		blocks: [],
		isAsync: evaluationOrder.some((path) => {
			const file = fileByPath.get(path);
			return file !== undefined && !file.commonjs && hasTopLevelAwait(file.ast);
		}),

		parameterCount: 0,
		length: 0,
		nextCoreVariable: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};
	registerCoreFunction(program, fn);

	let tail: CoreFrontendBlock | null = null;

	// Pure-data CommonJS modules are built once up front, before any module body.
	if (program.cjsEagerSlot.size > 0) {
		const eagerBlock: CoreFrontendBlock = { emitter: unboundCoreEmitter };
		fn.blocks.push(eagerBlock);
		emitCjsEagerInits(program, fn, { block: eagerBlock });
		tail = eagerBlock;
	}
	if (program.cjsHostSlot.size > 0) {
		const hostBlock: CoreFrontendBlock = { emitter: unboundCoreEmitter };
		fn.blocks.push(hostBlock);
		if (tail) {
			tail.emitter.emit({ type: "jump", blocks: [fn.blocks.length - 1] });
		}
		emitCommonJsHostInits(program, fn, { block: hostBlock });
		tail = hostBlock;
	}
	if (
		[...program.namespaceImports.values()].some((imports) =>
			imports.some((entry) => entry.deferred),
		)
	) {
		const deferredNamespaceBlock: CoreFrontendBlock = {
			emitter: unboundCoreEmitter,
		};
		const blockIndex = fn.blocks.push(deferredNamespaceBlock) - 1;
		if (tail) tail.emitter.emit({ type: "jump", blocks: [blockIndex] });
		emitDeferredModuleNamespaceInits(program, fn, deferredNamespaceBlock);
		tail = deferredNamespaceBlock;
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
		if (
			program.semantic.graph?.modules.get(modulePath)?.platform?.evaluation ===
			"side-effect-free"
		) {
			const evaluationBlock: CoreFrontendBlock = { emitter: unboundCoreEmitter };
			const blockIndex = fn.blocks.push(evaluationBlock) - 1;
			if (tail) tail.emitter.emit({ type: "jump", blocks: [blockIndex] });
			emitModuleSyncEvaluationCall(program, fn, evaluationBlock, file, false);
			tail = evaluationBlock;
			continue;
		}

		const prologue: CoreFrontendBlock = { emitter: unboundCoreEmitter };
		const prologueIndex = fn.blocks.push(prologue) - 1;
		// Chain the previous module's tail into this module's segment.
		if (tail) {
			tail.emitter.emit({ type: "jump", blocks: [prologueIndex] });
		}

		emitModulePrologue(program, fn, prologue, file);
		emitModuleEvaluationState(program, fn, prologue, file.path, 1);
		// Initialize CommonJS imports (require + property reads) before the body.
		emitCjsImportInits(program, fn, { block: prologue }, file);
		const bodyEntry = compileStatementsToBlock(program, fn, file.ast.body, true);
		prologue.emitter.emit({ type: "jump", blocks: [bodyEntry] });

		tail = fn.blocks[fn.blocks.length - 1]!;
		emitModuleEvaluationState(program, fn, tail, file.path, 2);
	}

	if (cjsEntryId !== undefined) {
		const entryBlock: CoreFrontendBlock = { emitter: unboundCoreEmitter };
		const entryBlockIndex = fn.blocks.push(entryBlock) - 1;
		if (tail) {
			tail.emitter.emit({ type: "jump", blocks: [entryBlockIndex] });
		}
		const cursor: CoreFrontendCursor = { block: entryBlock };
		emitRequiredEsmNamespaceInits(program, fn, entryBlock);
		emitCjsRequire(program, fn, cursor, cjsEntryId);
	}

	endFunction(program, fn);
}

/** Materialize each synchronously-required ESM namespace after ESM evaluation. */
function emitRequiredEsmNamespaceInits(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
) {
	for (const [modulePath, slot] of program.cjsEsmNamespaceSlot) {
		const namespace = emitNamespaceObjectRegister(
			program,
			fn,
			block,
			program.moduleNamespaces.get(modulePath) ?? [],
			modulePath,
		);
		block.emitter.emit({ type: "storeGlobal", registers: [namespace], index: slot });
	}
}

/**
 * Compile the top-level statements of a single-module program (or the
 * entrypoint when there is only one module) into its own init function.
 */
function compileFileInit(program: CoreFrontendContext, initFile: SemanticFile) {
	if (program.compiledModuleInitForPaths.has(initFile.path)) {
		return program.compiledModuleInitForPaths.get(initFile.path) ?? -1;
	}

	const fn: CoreFrontendFunction = {
		semanticFile: initFile,
		functionIndex: program.nextFunctionIndex,
		nameStringIndex: getOrCreateStringConstant(program, ""),
		blocks: [],
		isAsync: hasTopLevelAwait(initFile.ast),

		parameterCount: 0,
		length: 0,
		nextCoreVariable: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};

	registerCoreFunction(program, fn);
	program.compiledModuleInitForPaths.set(initFile.path, fn.functionIndex);
	const inheritedContextBindings = program.evalDirect
		? prepareDirectEvalClassContext(program, fn)
		: [];

	// Eval entry: reserve the completion register up front so body
	// ExpressionStatements can move into it; endFunction returns it.
	if (program.evalCompletion) {
		fn.completionRegister = nextCoreVariable(fn);
	}
	const evaluationDependencies = moduleSyncEvaluationDependencies(program, initFile);

	// A prologue block (TDZ inits + namespace objects) only when needed, so a
	// module with only var/function top-levels compiles exactly as before.
	if (
		moduleNeedsPrologue(program, initFile) ||
		program.evalDirect ||
		evaluationDependencies.length > 0
	) {
		const prologue: CoreFrontendBlock = { emitter: unboundCoreEmitter };
		fn.blocks.push(prologue);
		if (moduleNeedsPrologue(program, initFile)) {
			emitModulePrologue(program, fn, prologue, initFile);
		}
		for (const dependency of evaluationDependencies) {
			emitModuleSyncEvaluationCall(program, fn, prologue, dependency, false);
		}
		if (program.evalDirect) {
			const prologueCursor = { block: prologue };
			emitDirectEvalContextBindings(
				program,
				fn,
				prologueCursor,
				inheritedContextBindings,
			);
			emitDirectEvalVarDeclarations(program, fn, prologueCursor, initFile);
			emitLexicalProviderCaptures(program, fn, prologueCursor, initFile.ast, false);
			const bodyEntry = compileStatementsToBlock(program, fn, initFile.ast.body, true);
			prologueCursor.block.emitter.emit({ type: "jump", blocks: [bodyEntry] });
		} else {
			const bodyEntry = compileStatementsToBlock(program, fn, initFile.ast.body, true);
			prologue.emitter.emit({ type: "jump", blocks: [bodyEntry] });
		}
	} else {
		compileStatementsToBlock(program, fn, initFile.ast.body, true);
	}

	endFunction(program, fn);

	return fn.functionIndex;
}

function moduleSyncEvaluationDependencies(
	program: CoreFrontendContext,
	file: SemanticFile,
): Array<SemanticFile> {
	const record = program.semantic.graph?.modules.get(file.path);
	const files = new Map(
		program.semantic.files.map((candidate) => [candidate.path, candidate]),
	);
	const seen = new Set<string>();
	const dependencies: Array<SemanticFile> = [];
	for (const dependency of record?.dependencies ?? []) {
		if (
			(dependency.kind !== "import" && dependency.kind !== "export") ||
			dependency.resolvedPath === null ||
			dependency.resolvedPath === file.path ||
			seen.has(dependency.resolvedPath)
		) {
			continue;
		}
		const target = files.get(dependency.resolvedPath);
		if (!target || target.commonjs || hasTopLevelAwait(target.ast)) continue;
		seen.add(dependency.resolvedPath);
		dependencies.push(target);
	}
	return dependencies;
}

function emitModuleSyncEvaluationCall(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	target: SemanticFile,
	throwOnEvaluating: boolean,
): void {
	const targetIndex = compileFileInit(program, target);
	const initFn =
		targetIndex >= 0 ? nextCoreVariable(fn) : compileUndefined(fn, { block });
	if (targetIndex >= 0) {
		block.emitter.emit({
			type: "createFunction",
			registers: [initFn],
			functionIndex: targetIndex,
		});
	}
	const callee = nextCoreVariable(fn);
	block.emitter.emit({
		type: "loadIntrinsic",
		registers: [callee],
		intrinsic: "__evaluateModuleSync",
	});
	const cursor = { block };
	const destination = nextCoreVariable(fn);
	const reentry = nextCoreVariable(fn);
	block.emitter.emit({
		type: "createBoolean",
		registers: [reentry],
		value: throwOnEvaluating,
	});
	block.emitter.emit({
		type: "call",
		registers: [
			destination,
			callee,
			compileUndefined(fn, cursor),
			initFn,
			compileGlobalIndex(fn, cursor, getDynamicModuleStatusSlot(program, target.path)),
			compileGlobalIndex(fn, cursor, getModuleEvaluationErrorSlot(program, target.path)),
			reentry,
		],
	});
}

function emitModuleEvaluationState(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	modulePath: string,
	state: number,
): void {
	const value = nextCoreVariable(fn);
	block.emitter.emit({ type: "createNumber", registers: [value], value: state });
	block.emitter.emit({
		type: "storeGlobal",
		registers: [value],
		index: getDynamicModuleStatusSlot(program, modulePath),
	});
}

/** EvalDeclarationInstantiation for sloppy direct-eval vars not already present. */
function emitDirectEvalVarDeclarations(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	file: SemanticFile,
): void {
	if (
		file.strict ||
		program.directEvalContext.varEnvironmentIsGlobal ||
		!program.directEvalPersistentScopeBinding
	) {
		return;
	}
	const existing = new Set(program.directEvalContext.varEnvironmentNames);
	const scope = file.scopes.find((candidate) => candidate.node === file.ast);
	const names = new Set(
		scope?.bindings
			.filter(
				(binding) =>
					binding.kind === "var" &&
					!binding.undeclared &&
					binding.implicit === undefined &&
					!existing.has(binding.name),
			)
			.map((binding) => binding.name) ?? [],
	);
	if (names.size === 0) return;

	const persistent = loadCapturedBinding(
		program,
		fn,
		cursor,
		program.directEvalPersistentScopeBinding,
	);
	for (const name of names) {
		const base = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "withResolveBase",
			registers: [base],
			nameStringIndex: getOrCreateStringConstant(program, name),
		});
		const alreadyPersistent = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "binary",
			registers: [alreadyPersistent, base, persistent],
			operator: "===",
		});
		const skip: Extract<CompilerInstruction, { type: "jumpIf" }> = {
			type: "jumpIf",
			registers: [alreadyPersistent],
			blocks: [-1],
		};
		const createJump: Extract<CompilerInstruction, { type: "jump" }> = {
			type: "jump",
			blocks: [-1],
		};
		cursor.block.emitter.emit(skip, createJump);

		const createIndex = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
		const createBlock = fn.blocks[createIndex]!;
		const undefinedValue = nextCoreVariable(fn);
		createBlock.emitter.emit({
			type: "createUndefined",
			registers: [undefinedValue],
		});
		storeDirectEvalScopeValue(
			program,
			fn,
			{ block: createBlock },
			persistent,
			name,
			undefinedValue,
		);
		const createJoin: Extract<CompilerInstruction, { type: "jump" }> = {
			type: "jump",
			blocks: [-1],
		};
		createBlock.emitter.emit(createJoin);

		const joinIndex = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
		skip.blocks[0] = joinIndex;
		createJump.blocks[0] = createIndex;
		createJoin.blocks[0] = joinIndex;
		cursor.block = fn.blocks[joinIndex]!;
	}
}

interface DirectEvalContextBinding {
	key: string;
	binding: Binding;
}

function prepareDirectEvalClassContext(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
): Array<DirectEvalContextBinding> {
	const inherited = program.directEvalContext;
	const bindings: Array<DirectEvalContextBinding> = [];
	program.directEvalScopeObjectBinding = createCapturedBinding(
		program,
		fn,
		"__eval_scope",
	);
	program.directEvalDirtyTrackerBinding = createCapturedBinding(
		program,
		fn,
		"__eval_dirty",
	);
	program.directEvalPersistentScopeBinding = createCapturedBinding(
		program,
		fn,
		"__eval_persistent",
	);
	bindings.push(
		{ key: directEvalScopeObjectKey(), binding: program.directEvalScopeObjectBinding },
		{ key: directEvalDirtyTrackerKey(), binding: program.directEvalDirtyTrackerBinding },
		{
			key: directEvalPersistentScopeKey(),
			binding: program.directEvalPersistentScopeBinding,
		},
	);
	let homeObjectBinding: Binding | undefined;
	if (inherited.allowSuperProperty) {
		homeObjectBinding = createCapturedBinding(program, fn, "__eval_home");
		bindings.push({ key: directEvalHomeScopeKey(), binding: homeObjectBinding });
	}
	let superBinding: Binding | undefined;
	let superThisStateBinding: Binding | undefined;
	let superNewTargetBinding: Binding | undefined;
	let instanceInitializerBinding: Binding | undefined;
	if (inherited.allowSuperCall) {
		superBinding = createCapturedBinding(program, fn, "__eval_super");
		superThisStateBinding = createCapturedBinding(program, fn, "__eval_super_this");
		superNewTargetBinding = createCapturedBinding(program, fn, "__eval_super_new_target");
		bindings.push(
			{ key: directEvalSuperConstructorScopeKey(), binding: superBinding },
			{ key: directEvalSuperThisStateScopeKey(), binding: superThisStateBinding },
			{ key: directEvalSuperNewTargetScopeKey(), binding: superNewTargetBinding },
		);
		if (inherited.hasInstanceInitializer) {
			instanceInitializerBinding = createCapturedBinding(
				program,
				fn,
				"__eval_instance_initializer",
			);
			bindings.push({
				key: directEvalInstanceInitializerScopeKey(),
				binding: instanceInitializerBinding,
			});
		}
	}

	const privateNames = new Map<string, SemanticPrivateName>();
	for (let index = 0; index < inherited.privateNames.length; index++) {
		const inheritedName = inherited.privateNames[index]!;
		const makeBinding = (slot: DirectEvalPrivateSlot): Binding => {
			const binding = createCapturedBinding(
				program,
				fn,
				`__eval_private_${index}_${slot}`,
			);
			bindings.push({ key: directEvalPrivateScopeKey(index, slot), binding });
			return binding;
		};
		const entry: SemanticPrivateName = {
			static: (inheritedName.flags & DIRECT_EVAL_PRIVATE_STATIC) !== 0,
			brandBinding: makeBinding("brand"),
		};
		if (inheritedName.flags & DIRECT_EVAL_PRIVATE_FIELD)
			entry.fieldBinding = makeBinding("field");
		if (inheritedName.flags & DIRECT_EVAL_PRIVATE_METHOD) {
			entry.methodBinding = makeBinding("method");
		}
		if (inheritedName.flags & DIRECT_EVAL_PRIVATE_GETTER)
			entry.getBinding = makeBinding("get");
		if (inheritedName.flags & DIRECT_EVAL_PRIVATE_SETTER)
			entry.setBinding = makeBinding("set");
		privateNames.set(inheritedName.name, entry);
	}

	if (homeObjectBinding || superBinding || privateNames.size > 0) {
		fn.classContext = {
			isStatic: false,
			homeObjectBinding,
			superBinding,
			privateNames: privateNames.size > 0 ? privateNames : undefined,
			usesSharedSuperState: inherited.allowSuperCall,
			superThisStateBinding,
			superNewTargetBinding,
			instanceInitializerBinding,
		};
	}
	return bindings;
}

function emitDirectEvalContextBindings(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	bindings: Array<DirectEvalContextBinding>,
): void {
	for (const { key, binding } of bindings) {
		const value = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "withGet",
			registers: [value],
			nameStringIndex: getOrCreateStringConstant(program, key),
		});
		storeRegisterAtLocation(
			cursor.block,
			getOrCreateBindingLocation(program, fn, binding),
			value,
		);
	}
}

/**
 * Compile a CommonJS program: every reachable module becomes a wrapper function
 * run lazily through `require`, and a synthetic entry (function 0) kicks the
 * graph off by requiring the entrypoint. Eligible ESM dependencies are
 * evaluated first and exposed to require as stable namespace objects.
 */
function compileCjsProgram(program: CoreFrontendContext, initFile: SemanticFile) {
	assignCjsModuleIds(program);
	classifyPureDataCjsModules(program);
	classifyCommonJsHostModules(program);
	classifyCommonJsEsmModules(program);
	validateSynchronousCommonJsEsm(program);

	// Function 0 is the program entry: build pure-data modules, then require() the
	// entrypoint module.
	const entryId = program.cjsModuleId.get(initFile.path)!;
	if (program.cjsEsmNamespaceSlot.size > 0) {
		compileMergedModuleInit(program, program.semantic.graph!.evaluationOrder, entryId);
	} else {
		compileCjsEntryDriver(program, entryId);
	}
	compileCjsWrappers(program);
}

/** Allocate one stable namespace slot for every ESM target of CommonJS require. */
function classifyCommonJsEsmModules(program: CoreFrontendContext) {
	const graph = program.semantic.graph;
	if (!graph) {
		return;
	}
	for (const record of graph.modules.values()) {
		if (record.goal !== "cjs") {
			continue;
		}
		for (const dependency of record.dependencies) {
			const resolvedPath = dependency.resolvedPath;
			const target = resolvedPath ? graph.modules.get(resolvedPath) : undefined;
			if (
				dependency.kind === "require" &&
				resolvedPath &&
				target?.goal === "module" &&
				!target.host &&
				!program.cjsEsmNamespaceSlot.has(resolvedPath)
			) {
				program.cjsEsmNamespaceSlot.set(resolvedPath, program.nextGlobalIndex++);
			}
		}
	}
}

/** Reject mixed graphs that cannot be evaluated synchronously by scope hoisting. */
function validateSynchronousCommonJsEsm(program: CoreFrontendContext) {
	if (program.cjsEsmNamespaceSlot.size === 0) {
		return;
	}
	const graph = program.semantic.graph!;
	const synchronousGraph = new Set<string>();
	const visit = (modulePath: string) => {
		if (synchronousGraph.has(modulePath)) {
			return;
		}
		synchronousGraph.add(modulePath);
		for (const dependency of graph.modules.get(modulePath)?.dependencies ?? []) {
			if (dependency.kind !== "dynamic" && dependency.resolvedPath) {
				visit(dependency.resolvedPath);
			}
		}
	};
	for (const modulePath of program.cjsEsmNamespaceSlot.keys()) {
		visit(modulePath);
	}
	for (const file of program.semantic.files) {
		if (synchronousGraph.has(file.path) && !file.commonjs && hasTopLevelAwait(file.ast)) {
			throw new Error(
				`CommonJS cannot synchronously require an ES module graph with top-level await (${file.path})`,
			);
		}
	}
	for (const cycle of graph.cycles) {
		if (
			cycle.some((modulePath) => {
				const record = graph.modules.get(modulePath);
				return (
					synchronousGraph.has(modulePath) && record?.goal === "module" && !record.host
				);
			})
		) {
			throw new Error(
				`CommonJS cannot synchronously require a cyclic ES module graph (${cycle.join(", ")})`,
			);
		}
	}
}

/** Assign a registry id to every CommonJS module in the graph. */
function assignCjsModuleIds(program: CoreFrontendContext) {
	for (const file of program.semantic.files) {
		if (file.commonjs && !program.cjsModuleId.has(file.path)) {
			program.cjsModuleId.set(file.path, program.cjsModuleId.size);
		}
	}
}

/** Give each side-effect-free pure-data CommonJS module an eager exports slot. */
function classifyPureDataCjsModules(program: CoreFrontendContext) {
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

/** Allocate one stable exports slot for each host built-in reached by require. */
function classifyCommonJsHostModules(program: CoreFrontendContext) {
	const graph = program.semantic.graph;
	if (!graph) {
		return;
	}
	for (const record of graph.modules.values()) {
		for (const dependency of record.dependencies) {
			const resolvedPath = dependency.resolvedPath;
			if (
				dependency.kind === "require" &&
				resolvedPath !== null &&
				graph.modules.get(resolvedPath)?.host &&
				!program.cjsHostSlot.has(resolvedPath)
			) {
				program.cjsHostSlot.set(resolvedPath, program.nextGlobalIndex++);
			}
		}
	}
}

/**
 * A register holding a CommonJS module's `module.exports`: a direct slot read for
 * a pure-data module (built once at init), else a lazy `require()` call.
 */
function emitCjsModuleExports(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	cjsPath: string,
): number {
	const esmNamespaceSlot = program.cjsEsmNamespaceSlot.get(cjsPath);
	if (esmNamespaceSlot !== undefined) {
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "loadGlobal",
			registers: [destination],
			index: esmNamespaceSlot,
		});
		return destination;
	}
	const hostSlot = program.cjsHostSlot.get(cjsPath);
	if (hostSlot !== undefined) {
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "loadGlobal",
			registers: [destination],
			index: hostSlot,
		});
		return destination;
	}
	const slot = program.cjsEagerSlot.get(cjsPath);
	if (slot !== undefined) {
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "loadGlobal",
			registers: [destination],
			index: slot,
		});
		return destination;
	}
	return emitCjsRequire(program, fn, cursor, program.cjsModuleId.get(cjsPath)!);
}

/** Build host CommonJS exports once, preserving the ESM default object's identity. */
function emitCommonJsHostInits(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
) {
	for (const [specifier, slot] of program.cjsHostSlot) {
		const hostModule = program.hostModules.find(
			(candidate) => candidate.specifier === specifier,
		);
		if (!hostModule) {
			throw new Error(`Missing linked host module '${specifier}'`);
		}

		const defaultExport = hostModule.exports.find((entry) => entry.name === "default");
		let exportsRegister: number;
		if (defaultExport) {
			exportsRegister = loadRegisterFromLocation(
				fn,
				cursor.block,
				getOrCreateBindingLocation(program, fn, defaultExport.binding),
			);
		} else {
			exportsRegister = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "createObject",
				registers: [exportsRegister],
			});
			for (const hostExport of hostModule.exports) {
				const value = loadRegisterFromLocation(
					fn,
					cursor.block,
					getOrCreateBindingLocation(program, fn, hostExport.binding),
				);
				emitStoreProperty(program, fn, cursor, exportsRegister, hostExport.name, value);
			}
		}
		cursor.block.emitter.emit({
			type: "storeGlobal",
			registers: [exportsRegister],
			index: slot,
		});
	}
}

/**
 * Build every pure-data module's exports once into its slot (via the registry,
 * so identity is shared with any lazy require). Emitted at program start, before
 * any module body runs; safe because these modules have no observable side
 * effects.
 */
function emitCjsEagerInits(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
) {
	for (const [cjsPath, slot] of program.cjsEagerSlot) {
		const value = emitCjsRequire(program, fn, cursor, program.cjsModuleId.get(cjsPath)!);
		cursor.block.emitter.emit({
			type: "storeGlobal",
			registers: [value],
			index: slot,
		});
	}
}

/** Compile every CommonJS module's wrapper, recording its index by id. */
function compileCjsWrappers(program: CoreFrontendContext) {
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
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
			valueRegister = nextCoreVariable(fn);
			cursor.block.emitter.emit({
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	objectRegister: number,
	name: string,
): number {
	const keyRegister = compileStaticString(program, fn, cursor, name);
	const destination = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "loadProperty",
		registers: [destination, objectRegister, keyRegister],
	});
	return destination;
}

/** `object.name = value` (data store). */
function emitStoreProperty(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	objectRegister: number,
	name: string,
	valueRegister: number,
) {
	const keyRegister = compileStaticString(program, fn, cursor, name);
	cursor.block.emitter.emit({
		type: "storeProperty",
		registers: [objectRegister, keyRegister, valueRegister],
	});
}

/** The synthetic CJS program entry (function 0): `require(entryId)`. */
function compileCjsEntryDriver(program: CoreFrontendContext, entryId: number) {
	const fn: CoreFrontendFunction = {
		semanticFile: program.semantic.files[0]!,
		functionIndex: program.nextFunctionIndex,
		nameStringIndex: getOrCreateStringConstant(program, ""),
		blocks: [],

		parameterCount: 0,
		length: 0,
		nextCoreVariable: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};
	registerCoreFunction(program, fn);

	const block: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	fn.blocks.push(block);
	const cursor: CoreFrontendCursor = { block };
	emitCommonJsHostInits(program, fn, cursor);
	emitCjsEagerInits(program, fn, cursor);
	emitCjsRequire(program, fn, cursor, entryId);

	endFunction(program, fn);
}

/**
 * Compile one CommonJS module as its wrapper function
 * `(module, exports, require, __filename, __dirname) { …module body… }`. The
 * wrapper's `this` is `exports` (set by mal_vm_cjs_require), so module top-level
 * `this` resolves correctly with no special handling.
 */
function compileCjsModuleWrapper(
	program: CoreFrontendContext,
	file: SemanticFile,
): number {
	program.compiledModuleInitForPaths.set(file.path, null);

	const fn: CoreFrontendFunction = {
		semanticFile: file,
		functionIndex: program.nextFunctionIndex,
		nameStringIndex: getOrCreateStringConstant(program, ""),
		blocks: [],

		parameterCount: COMMONJS_BINDINGS.length,
		length: COMMONJS_BINDINGS.length,
		nextCoreVariable: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};
	registerCoreFunction(program, fn);

	const paramsBlock: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	fn.blocks.push(paramsBlock);

	// Bind the wrapper parameters to the incoming argument registers [0..5), in
	// the order mal_vm_cjs_require passes them.
	const programScope = file.scopes[0];
	for (const name of COMMONJS_BINDINGS) {
		const register = nextCoreVariable(fn);
		const binding = programScope?.bindings.find(
			(candidate) => candidate.name === name && !candidate.undeclared,
		);
		if (binding) {
			const location = getOrCreateBindingLocation(program, fn, binding);
			storeRegisterAtLocation(paramsBlock, location, register);
		}
	}
	for (const [name, value] of [
		["__filename", file.path],
		["__dirname", commonJsDirname(file.path)],
	] as const) {
		const binding = programScope?.bindings.find(
			(candidate) => candidate.name === name && !candidate.undeclared,
		);
		if (binding) {
			const register = compileStaticString(program, fn, { block: paramsBlock }, value);
			storeRegisterAtLocation(
				paramsBlock,
				getOrCreateBindingLocation(program, fn, binding),
				register,
			);
		}
	}

	// Top-level let/const start in their TDZ, then run the module body.
	if (programScope) {
		emitTdzHoleInits(program, fn, paramsBlock, programScope.bindings);
	}
	const bodyEntry = compileStatementsToBlock(program, fn, file.ast.body, true);
	paramsBlock.emitter.emit({ type: "jump", blocks: [bodyEntry] });

	endFunction(program, fn);
	return fn.functionIndex;
}

/** dirname for the absolute loader path without adding a compiler host dependency. */
function commonJsDirname(filePath: string): string {
	const separator = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
	if (separator < 0) {
		return ".";
	}
	if (separator === 0) {
		return filePath[0]!;
	}
	if (separator === 2 && filePath[1] === ":") {
		return filePath.slice(0, 3);
	}
	return filePath.slice(0, separator);
}

/** Emit a call to the CJS `require` intrinsic with a numeric module id. */
function emitCjsRequire(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	moduleId: number,
): number {
	const callee = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "loadIntrinsic",
		registers: [callee],
		intrinsic: "__cjs_require",
	});
	const thisRegister = compileUndefined(fn, cursor);
	const idRegister = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createNumber",
		registers: [idRegister],
		value: moduleId,
	});
	const destination = nextCoreVariable(fn);
	cursor.block.emitter.emit({
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
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
	if (cjsPath === null) {
		return emitMissingCjsModuleThrow(
			program,
			fn,
			cursor,
			specifier.value,
			fn.semanticFile.path,
		);
	}
	if (
		cjsPath === undefined ||
		(!program.cjsModuleId.has(cjsPath) &&
			!program.cjsHostSlot.has(cjsPath) &&
			!program.cjsEsmNamespaceSlot.has(cjsPath))
	) {
		return undefined;
	}
	return emitCjsModuleExports(program, fn, cursor, cjsPath);
}

function emitMissingCjsModuleThrow(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	specifier: string,
	requesterPath: string,
): number {
	const constructor = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "loadIntrinsic",
		registers: [constructor],
		intrinsic: "Error",
	});
	const message = compileStaticString(
		program,
		fn,
		cursor,
		`Cannot find module '${specifier}'\nRequire stack:\n- ${requesterPath}`,
	);
	const error = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "construct",
		registers: [error, constructor, message],
	});
	const code = compileStaticString(program, fn, cursor, "MODULE_NOT_FOUND");
	emitStoreProperty(program, fn, cursor, error, "code", code);
	cursor.block.emitter.emit({ type: "throw", registers: [error] });
	return error;
}

/**
 * Resolve a `require` specifier through the graph. `null` means the missing
 * module was retained specifically so its Node-shaped error can be caught.
 */
function resolveCjsModulePath(
	program: CoreFrontendContext,
	file: SemanticFile,
	specifier: string,
): string | null | undefined {
	const dependency = program.semantic.graph?.modules
		.get(file.path)
		?.dependencies.find(
			(candidate) =>
				candidate.kind === "require" &&
				candidate.specifier === specifier &&
				(candidate.resolvedPath !== null || candidate.catchableMissing),
		);
	return dependency?.resolvedPath;
}

/**
 * Store the uninitialized ("empty") sentinel into a scope's let/const/class
 * binding slots (their temporal dead zone), so a read before the declaration
 * runs throws ReferenceError. Skips functions (hoisted) and imports (aliased).
 */
function emitTdzHoleInits(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	bindings: Array<Binding>,
) {
	for (const binding of bindings) {
		if (!isTdzBinding(binding)) {
			continue;
		}
		const location = getOrCreateBindingLocation(program, fn, binding);
		const register = nextCoreVariable(fn);
		block.emitter.emit({ type: "createEmpty", registers: [register] });
		storeRegisterAtLocation(block, location, register);
	}
}

/**
 * DeclarationInstantiation: create each canonical `var` binding once before
 * body execution. Parameters, function declarations, and CommonJS wrapper
 * parameters already have their entry value and must not be reset.
 */
function emitVarDeclarationInits(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	scope: Scope,
	functionNames: ReadonlySet<string>,
) {
	const seen = new Set<string>();
	let pendingGlobalNames: Array<number> = [];
	const flushGlobalNames = () => {
		if (pendingGlobalNames.length === 0) return;
		block.emitter.emit({
			type: "initGlobalVars",
			nameStringIndices: pendingGlobalNames,
			declarationConfigurable: program.evalCompletion,
		});
		pendingGlobalNames = [];
	};
	const functionNode = scope.node.type.includes("Function")
		? scope.node
		: scope.parent?.node.type.includes("Function")
			? scope.parent.node
			: undefined;
	const parameterNodes = new Set<ESTree.Node>(
		functionNode && "params" in functionNode ? functionNode.params : [],
	);
	const argumentsBinding =
		functionNode &&
		(functionNode.type === "FunctionDeclaration" ||
			functionNode.type === "FunctionExpression" ||
			functionNode.type === "ArrowFunctionExpression")
			? getArgumentsBinding(fn, functionNode)
			: undefined;

	for (const binding of scope.bindings) {
		if (seen.has(binding.name)) {
			continue;
		}
		seen.add(binding.name);

		if (
			binding.kind !== "var" ||
			functionNames.has(binding.name) ||
			isDirectEvalVarBindingValue(program, fn, binding) ||
			binding.undeclared ||
			binding.implicit ||
			binding === argumentsBinding ||
			binding.declarationNode === functionNode ||
			(binding.declarationNode && parameterNodes.has(binding.declarationNode)) ||
			(fn.semanticFile.commonjs &&
				COMMONJS_BINDINGS.some((name) => name === binding.name))
		) {
			continue;
		}

		const location = getOrCreateBindingLocation(program, fn, binding);
		if (location.type === "globalProperty") {
			pendingGlobalNames.push(location.nameStringIndex);
			continue;
		} else {
			flushGlobalNames();
			const parameterBinding = scope.parent?.bindings.find(
				(candidate) =>
					candidate !== binding &&
					candidate.kind === "var" &&
					candidate.name === binding.name &&
					candidate.declarationNode !== undefined &&
					parameterNodes.has(candidate.declarationNode),
			);
			if (parameterBinding) {
				const parameterLocation = getOrCreateBindingLocation(
					program,
					fn,
					parameterBinding,
				);
				const value = loadRegisterFromLocation(fn, block, parameterLocation);
				storeRegisterAtLocation(block, location, value);
			}
		}
	}
	flushGlobalNames();
}

function emitGlobalDeclarationChecks(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	scope: Scope,
	functionDeclarations: ReadonlyArray<ESTree.FunctionDeclaration>,
	functionNames: ReadonlySet<string>,
) {
	for (const declaration of functionDeclarations) {
		const binding = fn.semanticFile.nodeToBinding.get(declaration);
		if (!binding || !isScriptGlobalProperty(program, fn.semanticFile, binding)) {
			continue;
		}
		const location = getOrCreateBindingLocation(program, fn, binding);
		if (location.type !== "globalProperty") {
			continue;
		}
		const check = nextCoreVariable(fn);
		block.emitter.emit({ type: "createEmpty", registers: [check] });
		block.emitter.emit({
			type: "storeGlobalProperty",
			registers: [check],
			nameStringIndex: location.nameStringIndex,
			declaration: true,
			declarationConfigurable: program.evalCompletion,
		});
	}

	const seen = new Set<string>();
	for (const binding of scope.bindings) {
		if (
			seen.has(binding.name) ||
			functionNames.has(binding.name) ||
			binding.kind !== "var" ||
			binding.undeclared ||
			binding.implicit ||
			!isScriptGlobalProperty(program, fn.semanticFile, binding)
		) {
			continue;
		}
		seen.add(binding.name);
		const location = getOrCreateBindingLocation(program, fn, binding);
		if (location.type !== "globalProperty") {
			continue;
		}
		const check = nextCoreVariable(fn);
		block.emitter.emit({ type: "createNull", registers: [check] });
		block.emitter.emit({
			type: "storeGlobalProperty",
			registers: [check],
			nameStringIndex: location.nameStringIndex,
			declaration: true,
			declarationConfigurable: program.evalCompletion,
		});
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
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
function moduleNeedsPrologue(program: CoreFrontendContext, file: SemanticFile): boolean {
	return (
		(file.scopes[0]?.bindings ?? []).some(isTdzBinding) ||
		(program.namespaceImports.get(file.path)?.length ?? 0) > 0 ||
		fileUsesImportMeta(file)
	);
}

function isImportMeta(node: ESTree.Node): node is ESTree.MetaProperty {
	return (
		node.type === "MetaProperty" &&
		node.meta.name === "import" &&
		node.property.name === "meta"
	);
}

function fileUsesImportMeta(file: SemanticFile): boolean {
	return (
		traverseEstree(file.ast.body, (node) =>
			isImportMeta(node) ? ESTREE_STOP : undefined,
		) === ESTREE_STOP
	);
}

function importMetaSlot(program: CoreFrontendContext, file: SemanticFile): number {
	const key = `\0import-meta:${file.path}`;
	let slot = program.dynamicModuleStatusSlot.get(key);
	if (slot === undefined) {
		slot = program.nextGlobalIndex++;
		program.dynamicModuleStatusSlot.set(key, slot);
	}
	return slot;
}

function importMetaUrl(filePath: string): string {
	const normalized = filePath.replaceAll("\\", "/");
	const encoded = normalized
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `file://${encoded.startsWith("/") ? "" : "/"}${encoded}`;
}

function emitImportMetaInit(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	file: SemanticFile,
): void {
	if (!fileUsesImportMeta(file)) return;

	const cursor = { block };
	const object = nextCoreVariable(fn);
	block.emitter.emit({ type: "createObject", registers: [object] });
	for (const [name, value] of [["url", importMetaUrl(file.path)]] as const) {
		emitStoreProperty(
			program,
			fn,
			cursor,
			object,
			name,
			compileStaticString(program, fn, cursor, value),
		);
	}
	if (program.semantic.graph?.nodeEnabled) {
		for (const [name, value] of [
			["filename", file.path],
			["dirname", commonJsDirname(file.path)],
		] as const) {
			emitStoreProperty(
				program,
				fn,
				cursor,
				object,
				name,
				compileStaticString(program, fn, cursor, value),
			);
		}
		const main = nextCoreVariable(fn);
		block.emitter.emit({
			type: "createBoolean",
			registers: [main],
			value: file.path === program.semantic.entrypointPath,
		});
		emitStoreProperty(program, fn, cursor, object, "main", main);
	}
	block.emitter.emit({
		type: "storeGlobal",
		registers: [object],
		index: importMetaSlot(program, file),
	});
}

/**
 * Emit a module's init prologue into `block`: store the uninitialized sentinel
 * into top-level let/const/class slots (their temporal dead zone), then build
 * any `import * as ns` namespace objects.
 */
function emitModulePrologue(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	file: SemanticFile,
) {
	emitTdzHoleInits(program, fn, block, file.scopes[0]?.bindings ?? []);
	emitImportMetaInit(program, fn, block, file);
	for (const namespaceImport of program.namespaceImports.get(file.path) ?? []) {
		if (namespaceImport.deferred) {
			const namespace = loadRegisterFromLocation(fn, block, {
				type: "global",
				index: getDeferredModuleNamespaceSlot(program, namespaceImport.module),
			});
			storeRegisterAtLocation(
				block,
				getOrCreateBindingLocation(program, fn, namespaceImport.binding),
				namespace,
			);
		} else {
			emitNamespaceObject(
				program,
				fn,
				block,
				namespaceImport.binding,
				namespaceImport.exports,
				namespaceImport.module,
			);
		}
	}
}

/**
 * If any of the given modules has top-level await, make the init an async
 * function: it returns a promise and suspends on each top-level await,
 * resuming via the microtask queue. Because the merged init runs modules'
 * top-levels sequentially in evaluation order, a suspended await holds up the
 * dependents that follow it — the spec ordering falls out for free.
 */
/**
 * Whether a module has top-level await: an AwaitExpression that is not nested
 * inside a function (so it runs as part of module evaluation).
 */
function hasTopLevelAwait(ast: ESTree.Program): boolean {
	return (
		traverseEstree(ast.body, (node) => {
			if (node.type === "AwaitExpression") return ESTREE_STOP;
			if (node.type === "VariableDeclaration" && node.kind === "await using") {
				return ESTREE_STOP;
			}
			if (
				node.type === "FunctionDeclaration" ||
				node.type === "FunctionExpression" ||
				node.type === "ArrowFunctionExpression"
			) {
				return ESTREE_SKIP;
			}
		}) === ESTREE_STOP
	);
}

/**
 * ContainsArguments (static semantics): whether `node` references the identifier
 * `arguments` outside a nested non-arrow function. A non-arrow function has its
 * own `arguments` binding (stop there); an arrow inherits it (descend). Used for
 * the class field-initializer early error — a field runs with no `arguments`, so
 * `x = arguments` (or `() => arguments`) is a SyntaxError.
 */
export function referencesArguments(node: unknown): boolean {
	return (
		traverseEstree(node, (current, { parent, key }) => {
			if (
				current.type === "FunctionDeclaration" ||
				current.type === "FunctionExpression"
			) {
				return ESTREE_SKIP;
			}
			if (current.type !== "Identifier" || current.name !== "arguments") return;
			if (parent?.type === "MemberExpression" && key === "property" && !parent.computed) {
				return;
			}
			if (
				(parent?.type === "Property" ||
					parent?.type === "MethodDefinition" ||
					parent?.type === "PropertyDefinition") &&
				key === "key" &&
				!parent.computed
			) {
				return;
			}
			return ESTREE_STOP;
		}) === ESTREE_STOP
	);
}

/**
 * Whether `node` contains a `super` reference that binds to the nearest
 * enclosing method — i.e. descends through arrow functions (which inherit
 * super lexically) but stops at nested non-arrow functions, methods, and
 * classes, which establish their own [[HomeObject]]. Used to decide whether an
 * object literal's methods need a home-object binding threaded to them.
 */
function referencesSuper(node: unknown): boolean {
	return (
		traverseEstree(node, (current) => {
			if (current.type === "Super") return ESTREE_STOP;
			if (
				current.type === "FunctionExpression" ||
				current.type === "FunctionDeclaration" ||
				current.type === "ClassExpression" ||
				current.type === "ClassDeclaration"
			) {
				return ESTREE_SKIP;
			}
		}) === ESTREE_STOP
	);
}

/**
 * The lexical class environment a nested function inherits from its enclosing
 * class. PrivateEnvironment and super binding are lexical (ECMA-262): any code
 * textually inside a class member — nested functions, arrows, functions in field
 * initializers — resolves the class's `#x` names, and an *arrow* additionally
 * inherits `super` (it has no own super). The private-name map and the super /
 * home-object bindings are carried forward; the constructor / field-plan parts
 * are per-function and must not leak (a nested function is not the constructor
 * and, unless an arrow, has its own this/super).
 */
function inheritedPrivateEnvironment(
	fn: CoreFrontendFunction,
	isArrow: boolean,
): SemanticClassContext | undefined {
	const context = fn.classContext;
	if (!context) {
		return undefined;
	}
	const hasPrivateNames = context.privateNames && context.privateNames.size > 0;
	// A non-arrow nested function only needs the private environment; an arrow
	// also inherits super/home-object bindings (super is lexical in arrows).
	const superBinding = isArrow ? context.superBinding : undefined;
	const classBinding = isArrow ? context.classBinding : undefined;
	const homeObjectBinding = isArrow ? context.homeObjectBinding : undefined;
	const instanceBrandBinding = isArrow ? context.instanceBrandBinding : undefined;
	const staticBrandBinding = isArrow ? context.staticBrandBinding : undefined;
	const usesSharedSuperState = isArrow ? context.usesSharedSuperState : undefined;
	const superThisStateBinding = isArrow ? context.superThisStateBinding : undefined;
	const superNewTargetBinding = isArrow ? context.superNewTargetBinding : undefined;
	const instanceInitializerBinding = isArrow
		? context.instanceInitializerBinding
		: undefined;
	if (!hasPrivateNames && !superBinding && !classBinding && !homeObjectBinding) {
		return undefined;
	}
	return {
		isStatic: context.isStatic,
		privateNames: context.privateNames,
		superBinding,
		classBinding,
		homeObjectBinding,
		instanceBrandBinding,
		staticBrandBinding,
		usesSharedSuperState,
		superThisStateBinding,
		superNewTargetBinding,
		instanceInitializerBinding,
	};
}

function compileNewFunction(
	program: CoreFrontendContext,
	binding: Binding,
	functionNode: ESTree.Node,
	classContext?: SemanticClassContext,
) {
	if (
		functionNode.type !== "FunctionDeclaration" &&
		functionNode.type !== "FunctionExpression" &&
		functionNode.type !== "ArrowFunctionExpression"
	) {
		return -1;
	}

	const cached = program.nodeToFunctionCache.get(functionNode);
	if (cached) {
		return cached.fnIndex;
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
	const fn: CoreFrontendFunction = {
		semanticFile: fnFile,
		functionIndex: program.nextFunctionIndex,
		nameStringIndex: getOrCreateStringConstant(
			program,
			("id" in functionNode ? functionNode.id?.name : undefined) ?? binding.name,
		),
		blocks: [],
		classContext,
		strict: functionStrict(fnFile, functionNode),
		isGenerator:
			functionNode.type !== "ArrowFunctionExpression" && functionNode.generator,
		isAsync: functionNode.async === true,

		parameterCount: functionNode.params.length,
		length: computeFunctionLength(functionNode),
		nextCoreVariable: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};

	registerCoreFunction(program, fn);
	program.nodeToFunctionCache.set(functionNode, { fnIndex: fn.functionIndex });

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
	paramsCursor.block.emitter.emit({
		type: "jump",
		blocks: [bodyBlock],
	});

	endFunction(program, fn);

	return fn.functionIndex;
}

function compileNewFunctionExpression(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	functionNode: ESTree.FunctionExpression | ESTree.ArrowFunctionExpression,
	classContext?: SemanticClassContext,
	nameOverride?: string,
	isMethod?: boolean,
) {
	const cached = program.nodeToFunctionCache.get(functionNode);
	if (cached) {
		return cached.fnIndex;
	}

	const isArrow = functionNode.type === "ArrowFunctionExpression";
	const isGenerator = !isArrow && functionNode.generator;
	// Only constructors and generators own a `prototype`: an arrow or a
	// (non-generator) method/getter/setter does not. Plain function expressions
	// and class constructors keep it (default true); async is excluded at runtime.
	const hasPrototype = isGenerator ? true : !(isArrow || isMethod);

	const compiledFn: CoreFrontendFunction = {
		semanticFile: fn.semanticFile,
		functionIndex: program.nextFunctionIndex,
		nameStringIndex: getOrCreateStringConstant(
			program,
			nameOverride ??
				(functionNode.type === "FunctionExpression" ? (functionNode.id?.name ?? "") : ""),
		),
		blocks: [],
		classContext,
		inFieldInitializer: isArrow ? fn.inFieldInitializer : undefined,
		hasPrototype,
		lexicalThis: isArrow,
		strict: functionStrict(fn.semanticFile, functionNode),
		isGenerator,
		isAsync: functionNode.async === true,

		parameterCount: functionNode.params.length,
		length: computeFunctionLength(functionNode),
		nextCoreVariable: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};

	registerCoreFunction(program, compiledFn);
	program.nodeToFunctionCache.set(functionNode, { fnIndex: compiledFn.functionIndex });
	if (
		classContext?.isConstructor &&
		classContext.isDerivedConstructor &&
		classContext.usesSharedSuperState
	) {
		classContext.superThisStateBinding =
			getLexicalThisBinding(compiledFn, functionNode) ??
			createCapturedBinding(program, compiledFn, "__super_this_state");
		classContext.superNewTargetBinding =
			getLexicalNewTargetBinding(compiledFn, functionNode) ??
			createCapturedBinding(program, compiledFn, "__super_new_target");
	}

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
	paramsCursor.block.emitter.emit({
		type: "jump",
		blocks: [bodyBlock],
	});

	endFunction(program, compiledFn);

	return compiledFn.functionIndex;
}

/**
 * Create a synthetic captured binding owned by the enclosing function, used
 * for the class machinery (super, class self-reference, private symbols and
 * shared private functions). Ownership is claimed here so inner functions
 * resolve the slot through the enclosing frame's environment.
 */
function createCapturedBinding(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
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
function mintPrivateNames(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	bindings: Array<Binding | undefined>,
) {
	const capturedIndices: Array<number> = [];
	for (const binding of bindings) {
		if (!binding) continue;
		const location = getOrCreateBindingLocation(program, fn, binding);
		if (location.type !== "captured" || location.functionIndex !== fn.functionIndex) {
			throw new Error(
				"Private names must use captured slots owned by the class evaluator",
			);
		}
		capturedIndices.push(location.index);
	}
	if (capturedIndices.length === 0) return;
	cursor.block.emitter.emit({
		type: "createPrivateNames",
		functionIndex: fn.functionIndex,
		capturedIndices,
	});
}

/**
 * Emit one field installation: a private field through its hidden symbol
 * (definePrivate) or a public field as an own enumerable data property
 * (CreateDataProperty). `this` is the receiver being initialized.
 */
function emitFieldInstall(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	entry: SemanticInstanceFieldPlanEntry,
) {
	emitLexicalProviderCaptures(program, fn, cursor, entry.initializerNode, true);
	const nameHint = entry.private
		? entry.nameHint
		: entry.key.kind === "name"
			? entry.key.name
			: undefined;

	let value: number;
	if (entry.valueNode) {
		// A field initializer runs via [[Call]], so its new.target is undefined —
		// even though it is woven into the constructor's frame (whose new.target is
		// the class). Flag the context so MetaProperty compiles to undefined.
		const savedInFieldInitializer = fn.inFieldInitializer;
		fn.inFieldInitializer = true;
		value = compileExpression(program, fn, cursor, entry.valueNode, nameHint);
		fn.inFieldInitializer = savedInFieldInitializer;
		if (value === -1) {
			value = compileUndefined(fn, cursor);
		}
	} else {
		value = compileUndefined(fn, cursor);
	}

	const thisRegister = nextCoreVariable(fn);
	cursor.block.emitter.emit({ type: "loadThis", registers: [thisRegister] });

	if (entry.private) {
		const symbol = loadRegisterFromLocation(
			fn,
			cursor.block,
			getOrCreateBindingLocation(program, fn, entry.fieldBinding),
		);
		cursor.block.emitter.emit({
			type: "definePrivate",
			registers: [thisRegister, symbol, value],
		});
		return;
	}

	const key =
		entry.key.kind === "name"
			? compileStaticString(program, fn, cursor, entry.key.name)
			: loadRegisterFromLocation(
					fn,
					cursor.block,
					getOrCreateBindingLocation(program, fn, entry.key.binding),
				);

	cursor.block.emitter.emit({
		type: "defineProperty",
		registers: [thisRegister, key, value],
		enumerable: true,
	});
}

/** Snapshot a field/static-block provider for arrows that capture its context. */
function emitLexicalProviderCaptures(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	node: ESTree.PropertyDefinition | ESTree.StaticBlock | ESTree.Program,
	newTargetIsUndefined: boolean,
): void {
	const scope = fn.semanticFile.nodeToScope.get(node);
	const thisBinding = scope?.bindings.find((binding) => binding.implicit === "this");
	if (thisBinding?.scopedTo === "captured" && !fn.classContext?.superThisStateBinding) {
		const value = nextCoreVariable(fn);
		cursor.block.emitter.emit({ type: "loadThis", registers: [value] });
		storeRegisterAtLocation(
			cursor.block,
			getOrCreateBindingLocation(program, fn, thisBinding),
			value,
		);
	}

	const newTargetBinding = scope?.bindings.find(
		(binding) => binding.implicit === "new.target",
	);
	if (
		newTargetBinding?.scopedTo === "captured" &&
		!fn.classContext?.superNewTargetBinding
	) {
		const value = newTargetIsUndefined
			? compileUndefined(fn, cursor)
			: nextCoreVariable(fn);
		if (!newTargetIsUndefined) {
			cursor.block.emitter.emit({ type: "loadNewTarget", registers: [value] });
		}
		storeRegisterAtLocation(
			cursor.block,
			getOrCreateBindingLocation(program, fn, newTargetBinding),
			value,
		);
	}
}

/**
 * Emit the InitializeInstanceElements sequence on `this`: install the brand
 * marker (covering private methods/accessors) and then run public and private
 * field initializers in source order. No-op when the class has none.
 */
function emitInstanceElementInit(
	program: CoreFrontendContext,
	ctorFn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	classContext: SemanticClassContext,
) {
	const brand = classContext.instanceBrandBinding;
	const plan = classContext.instanceFieldPlan ?? [];
	if (!brand && plan.length === 0) {
		return;
	}

	if (brand) {
		const thisRegister = nextCoreVariable(ctorFn);
		cursor.block.emitter.emit({ type: "loadThis", registers: [thisRegister] });
		const symbol = loadRegisterFromLocation(
			ctorFn,
			cursor.block,
			getOrCreateBindingLocation(program, ctorFn, brand),
		);
		const marker = nextCoreVariable(ctorFn);
		cursor.block.emitter.emit({
			type: "createBoolean",
			registers: [marker],
			value: true,
		});
		cursor.block.emitter.emit({
			type: "definePrivate",
			registers: [thisRegister, symbol, marker],
		});
	}

	for (let i = 0; i < plan.length; ) {
		const entry = plan[i]!;
		if (!entry.private || entry.valueNode !== null) {
			emitFieldInstall(program, ctorFn, cursor, entry);
			i++;
			continue;
		}

		const thisRegister = nextCoreVariable(ctorFn);
		cursor.block.emitter.emit({ type: "loadThis", registers: [thisRegister] });
		const keys: Array<number> = [];
		let next = i;
		while (next < plan.length) {
			const candidate = plan[next]!;
			if (!candidate.private || candidate.valueNode !== null) break;
			keys.push(
				loadRegisterFromLocation(
					ctorFn,
					cursor.block,
					getOrCreateBindingLocation(program, ctorFn, candidate.fieldBinding),
				),
			);
			next++;
		}
		cursor.block.emitter.emit({
			type: "initPrivateFields",
			registers: [thisRegister, ...keys],
		});
		i = next;
	}
}

/**
 * Build the static initializer: a synthetic function run once with
 * this = constructor. It installs the static brand and runs static field
 * initializers in source order.
 */
function buildStaticInitializer(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	staticContext: SemanticClassContext,
	staticElements: Array<SemanticStaticElement>,
	staticBrandBinding: Binding | undefined,
): number {
	const initFn: CoreFrontendFunction = {
		semanticFile: fn.semanticFile,
		functionIndex: program.nextFunctionIndex,
		nameStringIndex: getOrCreateStringConstant(program, ""),
		blocks: [],
		classContext: staticContext,
		// Class code is always strict.
		strict: true,
		parameterCount: 0,
		length: 0,
		nextCoreVariable: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};
	registerCoreFunction(program, initFn);

	const block: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	initFn.blocks.push(block);
	const cursor: CoreFrontendCursor = { block };

	if (staticBrandBinding) {
		const thisRegister = nextCoreVariable(initFn);
		cursor.block.emitter.emit({ type: "loadThis", registers: [thisRegister] });
		const symbol = loadRegisterFromLocation(
			initFn,
			cursor.block,
			getOrCreateBindingLocation(program, initFn, staticBrandBinding),
		);
		const marker = nextCoreVariable(initFn);
		cursor.block.emitter.emit({
			type: "createBoolean",
			registers: [marker],
			value: true,
		});
		cursor.block.emitter.emit({
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

		emitLexicalProviderCaptures(program, initFn, cursor, element.node, true);
		const entryBlock = compileStatementsToBlock(program, initFn, element.body, true);
		cursor.block.emitter.emit({ type: "jump", blocks: [entryBlock] });
		cursor.block = initFn.blocks.at(-1)!;
	}

	endFunction(program, initFn);
	return initFn.functionIndex;
}

/** Build the caller-owned InitializeInstanceElements closure used by eval/arrow super(). */
function buildInstanceInitializer(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	constructorContext: SemanticClassContext,
): number {
	const initFn: CoreFrontendFunction = {
		semanticFile: fn.semanticFile,
		functionIndex: program.nextFunctionIndex,
		nameStringIndex: getOrCreateStringConstant(program, ""),
		blocks: [],
		classContext: {
			...constructorContext,
			isConstructor: false,
			isDerivedConstructor: false,
			usesSharedSuperState: false,
			superThisStateBinding: undefined,
			superNewTargetBinding: undefined,
			instanceInitializerBinding: undefined,
		},
		hasPrototype: false,
		strict: true,
		parameterCount: 0,
		length: 0,
		nextCoreVariable: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};
	registerCoreFunction(program, initFn);

	const block: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	initFn.blocks.push(block);
	emitInstanceElementInit(program, initFn, { block }, constructorContext);
	endFunction(program, initFn);
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	classNode: ESTree.ClassDeclaration | ESTree.ClassExpression,
	nameHint?: string,
): number {
	const classId = program.nextFunctionIndex;
	const selfBinding = classNode.id
		? fn.semanticFile.nodeToBinding.get(classNode.id)
		: undefined;
	if (selfBinding && !selfBinding.undeclared) {
		// ClassDefinitionEvaluation creates the immutable inner name before
		// evaluating heritage. Reserve its owner here so heritage closures capture
		// this frame, and leave it in the TDZ through class-element evaluation.
		const location = getOrCreateBindingLocation(program, fn, selfBinding);
		const empty = nextCoreVariable(fn);
		cursor.block.emitter.emit({ type: "createEmpty", registers: [empty] });
		storeRegisterAtLocation(cursor.block, location, empty);
	}

	let superBinding: Binding | undefined;
	let parent = -1;
	if (classNode.superClass) {
		parent = compileExpression(program, fn, cursor, classNode.superClass);
		if (parent === -1) {
			return -1;
		}

		// ClassDefinitionEvaluation: the superclass must be a constructor whose
		// `prototype` is an object or null (or the null literal, handled below).
		// `extends 42`, `extends Math.abs`, `extends boundFn` (no prototype) throw.
		if (
			!(classNode.superClass.type === "Literal" && classNode.superClass.value === null)
		) {
			cursor.block.emitter.emit({ type: "checkSuperClass", registers: [parent] });
		}

		superBinding = createCapturedBinding(program, fn, `__super_${classId}`);
		storeRegisterAtLocation(
			cursor.block,
			getOrCreateBindingLocation(program, fn, superBinding),
			parent,
		);
	}
	// Every class method has the constructor/prototype as its home object. Keep
	// that live object available so setPrototypeOf mutations affect super reads.
	const classBinding = createCapturedBinding(program, fn, `__class_${classId}`);

	// Scan the body once to build the private environment and field plans. The
	// symbols are minted at class definition (below); here we only allocate the
	// captured bindings that will hold them. ownNames holds this class's own
	// declarations; they are layered over the enclosing class's private
	// environment so a nested class can still reach an outer class's privates.
	const ownNames = new Map<string, SemanticPrivateName>();
	let instanceBrandBinding: Binding | undefined;
	let staticBrandBinding: Binding | undefined;
	const instanceFieldPlan: Array<SemanticInstanceFieldPlanEntry> = [];
	const staticElements: Array<SemanticStaticElement> = [];
	const computedFieldKeys = new Map<ESTree.PropertyDefinition, Binding>();

	const ensurePrivateEntry = (name: string, isStatic: boolean): SemanticPrivateName => {
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
			staticElements.push({ kind: "block", node: member, body: member.body });
			continue;
		}

		if (member.type === "PropertyDefinition") {
			// Static Semantics early error: a class field initializer may not
			// reference `arguments` (a field runs with no `arguments` binding).
			if (referencesArguments(member.value ?? undefined)) {
				throw new SyntaxDiagnostic(
					"parse",
					"'arguments' is not allowed in a class field initializer",
				);
			}
			const valueNode = (member.value ?? null) as ESTree.Expression | null;
			let entry: SemanticInstanceFieldPlanEntry;
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
					initializerNode: member,
				};
			} else if (member.computed) {
				// Every public computed field key is converted once during class
				// definition, then loaded by instance or static initialization.
				const keyBinding = createCapturedBinding(
					program,
					fn,
					`__fk_${classId}_${computedFieldKeys.size}`,
				);
				computedFieldKeys.set(member, keyBinding);
				entry = {
					private: false,
					key: { kind: "captured", binding: keyBinding },
					valueNode,
					initializerNode: member,
				};
			} else {
				entry = {
					private: false,
					key: { kind: "name", name: classFieldKeyName(member.key) },
					valueNode,
					initializerNode: member,
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
	const privateNames = new Map<string, SemanticPrivateName>([
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
	const compileComputedKey = (
		keyNode: ESTree.Expression | ESTree.PrivateIdentifier,
	): number => {
		if (keyNode.type === "PrivateIdentifier") return -1;
		const savedClassContext = fn.classContext;
		fn.classContext = {
			...(savedClassContext ?? { isStatic: false }),
			privateNames: sharedContext.privateNames,
		};
		try {
			return compileExpression(program, fn, cursor, keyNode);
		} finally {
			fn.classContext = savedClassContext;
		}
	};
	const compileComputedPropertyKey = (
		keyNode: ESTree.Expression | ESTree.PrivateIdentifier,
	): number => {
		let key = compileComputedKey(keyNode);
		if (key === -1) {
			key = compileUndefined(fn, cursor);
		}
		return compilePropertyNameValue(fn, cursor, key);
	};

	const constructorNode = classNode.body.body.find(
		(member): member is ESTree.MethodDefinition =>
			member.type === "MethodDefinition" && member.kind === "constructor",
	);
	const constructorScope =
		constructorNode?.value.type === "FunctionExpression"
			? fn.semanticFile.nodeToScope.get(constructorNode.value)
			: undefined;
	const usesSharedSuperState = Boolean(
		parent !== -1 &&
		constructorNode &&
		(fn.semanticFile.hasDirectEval.has(constructorNode.value) ||
			constructorScope?.bindings.some((binding) => binding.implicit === "this")),
	);
	const instanceInitializerBinding =
		usesSharedSuperState && (instanceBrandBinding || instanceFieldPlan.length > 0)
			? createCapturedBinding(program, fn, `__instance_init_${classId}`)
			: undefined;
	// NamedEvaluation: anonymous class expressions take the binding name.
	const className = classNode.id?.name ?? nameHint ?? "";
	const constructorContext: SemanticClassContext = {
		...sharedContext,
		isStatic: false,
		isConstructor: true,
		isDerivedConstructor: parent !== -1,
		instanceFieldPlan,
		usesSharedSuperState,
		instanceInitializerBinding,
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
	if (instanceInitializerBinding) {
		const initializerIndex = buildInstanceInitializer(program, fn, constructorContext);
		const initializer = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "createFunction",
			registers: [initializer],
			functionIndex: initializerIndex,
		});
		storeRegisterAtLocation(
			cursor.block,
			getOrCreateBindingLocation(program, fn, instanceInitializerBinding),
			initializer,
		);
	}

	const ctor = nextCoreVariable(fn);
	cursor.block.emitter.emit({
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

	// Mint the per-evaluation private symbols (brand markers and field keys).
	// Only this class's own names are minted here; inherited names were minted
	// by their declaring class.
	mintPrivateNames(program, fn, cursor, [
		instanceBrandBinding,
		staticBrandBinding,
		...[...ownNames.values()].map((entry) => entry.fieldBinding),
	]);

	// Wire the prototype chains. `extends null` is a heritage class whose
	// protoParent is null and whose constructorParent is %Function.prototype%
	// (ClassDefinitionEvaluation), rather than reading the superclass's prototype.
	const extendsNull =
		classNode.superClass?.type === "Literal" && classNode.superClass.value === null;
	const prototypeKey = compileStaticString(program, fn, cursor, "prototype");
	let prototype: number;
	if (parent !== -1) {
		const parentPrototype = nextCoreVariable(fn);
		if (extendsNull) {
			cursor.block.emitter.emit({
				type: "createNull",
				registers: [parentPrototype],
			});
		} else {
			cursor.block.emitter.emit({
				type: "loadProperty",
				registers: [parentPrototype, parent, prototypeKey],
			});
		}

		prototype = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "createObject",
			registers: [prototype],
		});
		cursor.block.emitter.emit({
			type: "setPrototype",
			registers: [prototype, parentPrototype],
			literal: false,
		});

		const constructorKey = compileStaticString(program, fn, cursor, "constructor");
		cursor.block.emitter.emit({
			type: "defineProperty",
			registers: [prototype, constructorKey, ctor],
			enumerable: false,
		});
		cursor.block.emitter.emit({
			type: "defineProperty",
			registers: [ctor, prototypeKey, prototype],
			enumerable: false,
			writable: false,
			configurable: false,
		});
		// constructorParent: the superclass, or %Function.prototype% for extends null.
		let constructorParent = parent;
		if (extendsNull) {
			const functionCtor = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "loadIntrinsic",
				registers: [functionCtor],
				intrinsic: "Function",
			});
			constructorParent = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "loadProperty",
				registers: [constructorParent, functionCtor, prototypeKey],
			});
		}
		cursor.block.emitter.emit({
			type: "setPrototype",
			registers: [ctor, constructorParent],
			literal: false,
		});
	} else {
		// Materializes the default prototype with its constructor backref.
		prototype = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "loadProperty",
			registers: [prototype, ctor, prototypeKey],
		});
	}

	for (const member of classNode.body.body) {
		if (member.type === "PropertyDefinition") {
			const binding = computedFieldKeys.get(member);
			if (binding) {
				const propertyKey = compileComputedPropertyKey(member.key);
				storeRegisterAtLocation(
					cursor.block,
					getOrCreateBindingLocation(program, fn, binding),
					propertyKey,
				);
			}
			continue;
		}

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
		// The method's own function name: a getter/setter is prefixed "get "/"set "
		// (SetFunctionName with a prefix); a static string/number key uses its
		// string form. A computed key ("") gets its name at runtime below.
		const memberStaticName = isPrivate
			? privateName
			: member.computed
				? ""
				: member.key.type === "Identifier"
					? member.key.name
					: member.key.type === "Literal"
						? String(member.key.value)
						: "";
		const accessorPrefix =
			member.kind === "get" ? "get " : member.kind === "set" ? "set " : "";
		const methodName = memberStaticName === "" ? "" : accessorPrefix + memberStaticName;
		const key = isPrivate
			? -1
			: member.computed
				? compileComputedPropertyKey(member.key)
				: compileClassMemberKey(program, fn, cursor, member);
		const methodIndex = compileNewFunctionExpression(
			program,
			fn,
			member.value,
			{ ...sharedContext, isStatic: member.static },
			methodName,
			true,
		);
		const method = nextCoreVariable(fn);
		cursor.block.emitter.emit({
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
		// A computed-key method/accessor is an anonymous function definition; its
		// name comes from the (already-evaluated) key at runtime, prefixed
		// "get "/"set " for accessors. Static keys were named at creation.
		if (member.computed) {
			cursor.block.emitter.emit({
				type: "setFunctionName",
				registers: [method, key],
				namePrefix:
					member.kind === "get" ? "get" : member.kind === "set" ? "set" : undefined,
			});
		}
		if (member.kind === "get" || member.kind === "set") {
			cursor.block.emitter.emit({
				type: "defineAccessor",
				registers: [target, key, method],
				kind: member.kind,
				enumerable: false,
			});
		} else {
			cursor.block.emitter.emit({
				type: "defineProperty",
				registers: [target, key, method],
				enumerable: false,
			});
		}
	}

	// Class element evaluation observes the inner name's TDZ. Initialize it only
	// after computed keys and methods are processed, but before static elements
	// run and can reference the class by name.
	if (selfBinding && !selfBinding.undeclared) {
		storeRegisterAtLocation(
			cursor.block,
			getOrCreateBindingLocation(program, fn, selfBinding),
			ctor,
		);
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
		const initFunction = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "createFunction",
			registers: [initFunction],
			functionIndex: staticInitIndex,
		});
		const result = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "call",
			registers: [result, initFunction, ctor],
		});
	}

	return ctor;
}

function compileClassMemberKey(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
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
function privateBrandBinding(
	_fn: CoreFrontendFunction,
	entry: SemanticPrivateName,
): Binding | undefined {
	return entry.brandBinding;
}

/**
 * Brand-check a receiver against a private member's class. Reads the brand
 * marker through loadPrivate, which throws a TypeError when the receiver was
 * not branded by the declaring class. The loaded value is discarded.
 */
function emitPrivateBrandCheck(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	objectReg: number,
	entry: SemanticPrivateName,
) {
	const brand = privateBrandBinding(fn, entry);
	if (!brand) {
		return;
	}

	const brandSymbol = loadCapturedBinding(program, fn, cursor, brand);
	const discard = nextCoreVariable(fn);
	cursor.block.emitter.emit({
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	message: string,
): number {
	const constructor = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "loadIntrinsic",
		registers: [constructor],
		intrinsic: "TypeError",
	});
	const messageRegister = compileStaticString(program, fn, cursor, message);
	const error = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "construct",
		registers: [error, constructor, messageRegister],
	});
	cursor.block.emitter.emit({ type: "throw", registers: [error] });
	return error;
}

interface CompiledPrivateMemberReference {
	object: number;
	name: string;
}

/** Evaluate a private member reference without performing its later GetValue/PutValue. */
function compilePrivateMemberReference(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	member: ESTree.MemberExpression,
): CompiledPrivateMemberReference {
	if (member.property.type !== "PrivateIdentifier") {
		throw new Error("Expected a private member reference");
	}
	return {
		object: compileExpression(program, fn, cursor, member.object),
		name: `#${member.property.name}`,
	};
}

/**
 * Compile a private member read `obj.#x`: a direct slot read for fields, the
 * shared function for methods, or a brand-checked getter call for accessors.
 */
function compilePrivateMemberLoad(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	objectReg: number,
	name: string,
): number {
	const entry = fn.classContext?.privateNames?.get(name);
	if (!entry || objectReg === -1) {
		return -1;
	}

	if (entry.fieldBinding) {
		const symbol = loadCapturedBinding(program, fn, cursor, entry.fieldBinding);
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
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
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
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
		cursor.block.emitter.emit({
			type: "storePrivate",
			registers: [objectReg, symbol, valueReg],
		});
		return;
	}

	emitPrivateBrandCheck(program, fn, cursor, objectReg, entry);
	if (entry.setBinding) {
		const setter = loadCapturedBinding(program, fn, cursor, entry.setBinding);
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	superBinding: Binding | undefined,
	name: string,
	classContext: SemanticClassContext,
): number {
	const ctorFn: CoreFrontendFunction = {
		semanticFile: fn.semanticFile,
		functionIndex: program.nextFunctionIndex,
		nameStringIndex: getOrCreateStringConstant(program, name),
		blocks: [],
		classContext,
		// Class code is always strict.
		strict: true,

		parameterCount: 0,
		length: 0,
		nextCoreVariable: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};
	registerCoreFunction(program, ctorFn);

	const block: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	ctorFn.blocks.push(block);
	const cursor: CoreFrontendCursor = { block };

	if (superBinding) {
		const location = getOrCreateBindingLocation(program, ctorFn, superBinding);
		const parent = loadRegisterFromLocation(ctorFn, cursor.block, location);

		// `constructor(...args) { super(...args); }`: forward every argument to
		// the parent's [[Construct]] (with the active new.target) and bind the
		// result as `this`.
		const argumentsArray = nextCoreVariable(ctorFn);
		cursor.block.emitter.emit({
			type: "createRestArguments",
			registers: [argumentsArray],
			startIndex: 0,
		});

		const result = nextCoreVariable(ctorFn);
		cursor.block.emitter.emit({
			type: "constructSuper",
			registers: [result, parent, argumentsArray],
		});
	}

	// InitializeInstanceElements: a base default constructor installs at entry;
	// a derived one installs right after the synthesized super() returns.
	emitInstanceElementInit(program, ctorFn, cursor, classContext);

	endFunction(program, ctorFn);
	return ctorFn.functionIndex;
}

/**
 * Return 'undefined' from all blocks that don't unconditionally jump yet.
 */
function endFunction(program: CoreFrontendContext, fn: CoreFrontendFunction) {
	for (const block of fn.blocks) {
		const lastInstruction = block.emitter.last();
		if (
			lastInstruction?.type === "return" ||
			lastInstruction?.type === "jump" ||
			lastInstruction?.type === "throw"
		) {
			continue;
		}

		// The eval entry returns its completion value; every other function's
		// implicit return is undefined.
		if (fn.completionRegister !== undefined) {
			emitReturn(program, fn, block, fn.completionRegister);
			continue;
		}

		const destinationRegister = nextCoreVariable(fn);
		block.emitter.emit({
			type: "createUndefined",
			registers: [destinationRegister],
		});
		emitReturn(program, fn, block, destinationRegister);
	}

	const functionId = finishDirectCoreFunction(fn);
	if (functionId !== fn.functionIndex) {
		throw new Error(
			`Finished Core function ${functionId} does not match semantic function ${fn.functionIndex}`,
		);
	}
}

function superThisStateKey(): string {
	return "\0maligator.super.this";
}

function loadSharedSuperThis(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	checkInitialized: boolean,
): number {
	const binding = fn.classContext?.superThisStateBinding;
	if (!binding) {
		throw new Error("Missing shared super this binding");
	}
	const state = loadRegisterFromLocation(
		fn,
		cursor.block,
		getOrCreateBindingLocation(program, fn, binding),
	);
	const key = compileStaticString(program, fn, cursor, superThisStateKey());
	const value = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "loadProperty",
		registers: [value, state, key],
	});
	if (checkInitialized) {
		cursor.block.emitter.emit({
			type: "throwIfTdz",
			registers: [value],
			nameStringIndex: getOrCreateStringConstant(program, "this"),
		});
	}
	return value;
}

function storeSharedSuperThis(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	value: number,
): void {
	const binding = fn.classContext?.superThisStateBinding;
	if (!binding) {
		throw new Error("Missing shared super this binding");
	}
	const state = loadRegisterFromLocation(
		fn,
		cursor.block,
		getOrCreateBindingLocation(program, fn, binding),
	);
	const key = compileStaticString(program, fn, cursor, superThisStateKey());
	cursor.block.emitter.emit({
		type: "storeProperty",
		registers: [state, key, value],
	});
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
function isSloppyFunction(fn: CoreFrontendFunction): boolean {
	return !(fn.strict ?? fn.semanticFile.strict);
}

/**
 * A global *script* top-level `var`/`function` binds a property of the global
 * object (spec: CreateGlobalVarBinding/CreateGlobalFunctionBinding) — observable
 * as `globalThis.x` — in BOTH strict and sloppy mode (GlobalDeclarationInstantiation
 * does not consult strictness here). `let`/`const`/`class` go to the global
 * declarative record (our flat slots), and a module's top-level bindings are
 * module-scoped (also flat slots), so both are excluded. Strict eval declarations
 * stay in the eval environment even when their names match global lexicals.
 */
function isScriptGlobalProperty(
	program: CoreFrontendContext,
	file: SemanticFile,
	binding: Binding,
): boolean {
	return (
		file.type === "script" &&
		!(program.evalCompletion && file.strict && !binding.undeclared) &&
		binding.scopedTo === "global" &&
		(binding.kind === "var" || binding.declarationNode?.type === "FunctionDeclaration")
	);
}

/** SetMutableBinding through the global object's Object Environment Record. */
function emitGlobalPropertyStore(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	name: string,
	value: number,
) {
	cursor.block.emitter.emit({
		type: "storeGlobalProperty",
		registers: [value],
		nameStringIndex: getOrCreateStringConstant(program, name),
		declaration: false,
		declarationConfigurable: false,
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	node:
		| ESTree.FunctionDeclaration
		| ESTree.FunctionExpression
		| ESTree.ArrowFunctionExpression,
): CoreFrontendCursor {
	const block: CoreFrontendBlock = {
		emitter: unboundCoreEmitter,
	};
	fn.blocks.push(block);
	const cursor: CoreFrontendCursor = { block };

	// Claim the pinned parameter registers up front: destructuring and default
	// expressions allocate registers of their own, so allocating per-parameter
	// inside the loop would break the [0..parameterCount) calling convention.
	const parameterRegisters = node.params.map(() => nextCoreVariable(fn));

	// The arguments object snapshots the frame arguments, which parameter
	// initialization never mutates; creating it before the parameter logic
	// keeps it available to default value expressions.
	const argumentsBinding = getArgumentsBinding(fn, node);
	const canMapArguments =
		!(fn.strict ?? fn.semanticFile.strict) &&
		node.params.every((param) => param.type === "Identifier");
	const mappedParameterBindings = new Map<number, Binding>();
	if (canMapArguments) {
		const names = new Set<string>();
		for (let i = node.params.length - 1; i >= 0; i--) {
			const param = node.params[i]!;
			if (param.type !== "Identifier" || names.has(param.name)) continue;
			names.add(param.name);
			const binding = fn.semanticFile.nodeToBinding.get(param);
			if (binding) mappedParameterBindings.set(i, binding);
		}
	}
	const materializesArguments =
		argumentsBinding?.usageNodes.some(
			(usage) => fn.semanticFile.staticArgumentsAccesses.get(usage) === undefined,
		) ?? false;
	const lazilyMaterializesArguments =
		argumentsBinding !== undefined &&
		fn.semanticFile.lazyArgumentsBindings.has(argumentsBinding);
	let hasStaticIndex = false;
	if (argumentsBinding && (!materializesArguments || lazilyMaterializesArguments)) {
		for (const usage of argumentsBinding.usageNodes) {
			const access = fn.semanticFile.staticArgumentsAccesses.get(usage);
			if (access?.kind === "index") hasStaticIndex = true;
		}
	}
	const needsStaticFallback = hasStaticIndex;
	if ((materializesArguments || needsStaticFallback) && canMapArguments) {
		fn.mappedArguments = true;
		fn.mappedArgumentSlots = new Array<number>(node.params.length).fill(-1);
		for (const [i, binding] of mappedParameterBindings) {
			binding.scopedTo = "captured";
			const location = getOrCreateBindingLocation(program, fn, binding);
			if (location.type !== "captured")
				throw new Error("Mapped parameter must be captured");
			fn.mappedArgumentSlots[i] = location.index;
		}
	}
	if (argumentsBinding && (!materializesArguments || lazilyMaterializesArguments)) {
		let argumentCountRegister: number | undefined;
		const indexRegisters = new Map<number, number>();
		for (const usage of argumentsBinding.usageNodes) {
			const access = fn.semanticFile.staticArgumentsAccesses.get(usage);
			if (!access) continue;
			const mappedBinding =
				access.kind === "index" ? mappedParameterBindings.get(access.index) : undefined;
			if (mappedBinding) {
				(fn.staticMappedArgumentBindings ??= new Map()).set(usage, mappedBinding);
				continue;
			}
			let destination =
				access.kind === "length"
					? argumentCountRegister
					: indexRegisters.get(access.index);
			if (destination === undefined) {
				destination = nextCoreVariable(fn);
				block.emitter.emit(
					access.kind === "length"
						? { type: "loadArgumentCount", registers: [destination] }
						: { type: "loadArgument", registers: [destination], index: access.index },
				);
				if (access.kind === "length") argumentCountRegister = destination;
				else indexRegisters.set(access.index, destination);
			}
			(fn.staticArgumentsRegisters ??= new Map()).set(usage, destination);
		}
	}
	if (argumentsBinding && lazilyMaterializesArguments) {
		const empty = nextCoreVariable(fn);
		block.emitter.emit({ type: "createEmpty", registers: [empty] });
		fn.argumentsObjectRegister = empty;
		storeRegisterAtLocation(
			block,
			getOrCreateBindingLocation(program, fn, argumentsBinding),
			empty,
		);
	} else if (argumentsBinding && needsStaticFallback) {
		const emptyFallback = compileUndefined(fn, cursor);
		fn.argumentsObjectRegister = emptyFallback;
		fn.staticArgumentsFallbackRegister = emptyFallback;
	} else if (argumentsBinding && materializesArguments) {
		const destination = nextCoreVariable(fn);
		fn.argumentsObjectRegister = destination;
		block.emitter.emit({
			type: "createArgumentsObject",
			registers: [destination],
		});

		// `arguments` is mutable, so both direct reads and lexical reads from an
		// arrow must use its normal binding storage. Keep argumentsObjectRegister as
		// metadata that prevents optimizations from treating this as an ordinary
		// inlinable function.
		const location = getOrCreateBindingLocation(program, fn, argumentsBinding);
		storeRegisterAtLocation(block, location, destination);
	}

	// When a nested arrow captures this function's `this` lexically, semantic
	// analysis put an implicit `this` binding on this (non-arrow) function's scope.
	// Snapshot `this` into its captured slot at entry — before the body (and any
	// nested arrow) is compiled — so the slot's owner is this function and the
	// arrow's `loadCaptured` walks to it. (Arrows never own such a binding.)
	const thisBinding = getLexicalThisBinding(fn, node);
	const sharedThisBinding = fn.classContext?.isConstructor
		? fn.classContext.superThisStateBinding
		: undefined;
	if (sharedThisBinding) {
		const state = nextCoreVariable(fn);
		const empty = nextCoreVariable(fn);
		block.emitter.emit(
			{ type: "createObject", registers: [state] },
			{ type: "createEmpty", registers: [empty] },
		);
		const key = compileStaticString(program, fn, cursor, superThisStateKey());
		block.emitter.emit({ type: "storeProperty", registers: [state, key, empty] });
		storeRegisterAtLocation(
			block,
			getOrCreateBindingLocation(program, fn, sharedThisBinding),
			state,
		);
	} else if (thisBinding && thisBinding.scopedTo === "captured") {
		const location = getOrCreateBindingLocation(program, fn, thisBinding);
		if (fn.classContext?.isConstructor && fn.classContext.isDerivedConstructor) {
			// A derived constructor's `this` is uninitialized until super() (which
			// stores the cell — see compileSuperCall). loadThis would throw here, so
			// seed the cell with the EMPTY sentinel; a nested arrow reading `this`
			// before super() then throws via the cell, matching direct access.
			const emptyRegister = nextCoreVariable(fn);
			block.emitter.emit({ type: "createEmpty", registers: [emptyRegister] });
			storeRegisterAtLocation(block, location, emptyRegister);
			// Stash so compileSuperCall can refresh the cell once super() binds this.
			fn.lexicalThisBinding = thisBinding;
		} else {
			const thisRegister = nextCoreVariable(fn);
			block.emitter.emit({ type: "loadThis", registers: [thisRegister] });
			storeRegisterAtLocation(block, location, thisRegister);
		}
	}

	// When a nested arrow captures this function's `new.target` lexically, snapshot
	// it into its captured slot at entry. new.target is fixed for the activation
	// (set at [[Construct]], undefined otherwise), so the entry snapshot is valid
	// even for a derived constructor.
	const newTargetBinding =
		(fn.classContext?.isConstructor
			? fn.classContext.superNewTargetBinding
			: undefined) ?? getLexicalNewTargetBinding(fn, node);
	if (newTargetBinding && newTargetBinding.scopedTo === "captured") {
		const newTargetRegister = nextCoreVariable(fn);
		block.emitter.emit({ type: "loadNewTarget", registers: [newTargetRegister] });
		storeRegisterAtLocation(
			block,
			getOrCreateBindingLocation(program, fn, newTargetBinding),
			newTargetRegister,
		);
	}

	// A named function expression binds its own name to the closure in an immutable
	// binding scoped to its body (CreateImmutableBinding + InitializeBinding), so
	// the body can reference itself (recursion). Initialize that binding to the
	// callee at entry. Only named function/generator/async EXPRESSIONS carry an
	// immutableSelfReference binding (mapped from the function node); declarations
	// bind their name in the parent scope and need no entry init, and shadowing by a
	// same-named parameter simply leaves this store's location unread.
	const selfNameBinding = fn.semanticFile.nodeToBinding.get(node);
	if (selfNameBinding?.immutableSelfReference) {
		const calleeRegister = nextCoreVariable(fn);
		block.emitter.emit({ type: "loadCallee", registers: [calleeRegister] });
		storeRegisterAtLocation(
			block,
			getOrCreateBindingLocation(program, fn, selfNameBinding),
			calleeRegister,
		);
	}

	// Parameter TDZ: parameters initialize left to right, so a default that reads
	// a not-yet-initialized (or its own) parameter is a ReferenceError. Seed
	// simple identifier parameter slots with EMPTY before processing so such a
	// read hits the dead zone; the guard is emitted in compileIdentifier while
	// inParameterExpression. Only needed when a parameter has a default.
	if (node.params.some((param) => param.type === "AssignmentPattern")) {
		for (const param of node.params) {
			const id =
				param.type === "Identifier"
					? param
					: param.type === "AssignmentPattern" && param.left.type === "Identifier"
						? param.left
						: undefined;
			if (!id) {
				continue;
			}
			const binding = fn.semanticFile.nodeToBinding.get(id);
			if (!binding || binding.undeclared) {
				continue;
			}
			const empty = nextCoreVariable(fn);
			cursor.block.emitter.emit({ type: "createEmpty", registers: [empty] });
			storeRegisterAtLocation(
				cursor.block,
				getOrCreateBindingLocation(program, fn, binding),
				empty,
			);
		}
	}

	// A direct eval anywhere in these parameter expressions is in a
	// parameter-expression context (see CoreFrontendFunction.inParameterExpression). Nested
	// function/arrow bodies get their own CoreFrontendFunction, so the flag does not leak
	// into them.
	const savedInParams = fn.inParameterExpression;
	fn.inParameterExpression = true;
	for (let i = 0; i < node.params.length; i++) {
		const param = node.params[i]!;

		if (param.type === "RestElement") {
			// The pinned register holds a stray positional argument; replace it
			// with the collected rest array.
			const rest = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "createRestArguments",
				registers: [rest],
				startIndex: i,
			});
			compilePatternTarget(program, fn, cursor, param.argument, rest);
			continue;
		}

		compilePatternTarget(program, fn, cursor, param, parameterRegisters[i]!);
	}
	fn.inParameterExpression = savedInParams;

	return cursor;
}

/**
 * Initialize a destructuring target with the given value register. Handles
 * both binding patterns (parameters, declarations, catch) and assignment
 * patterns, where targets may also be member expressions.
 */
function compilePatternTarget(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
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
			if (target.property.type === "PrivateIdentifier") {
				const reference = compilePrivateMemberReference(program, fn, cursor, target);
				compilePrivateMemberStore(
					program,
					fn,
					cursor,
					reference.object,
					reference.name,
					value,
				);
				break;
			}
			const member = compileMemberObjectAndKey(program, fn, cursor, target);
			if (member.object === -1 || member.key === -1) {
				break;
			}
			compileMemberStore(cursor, member, value);
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
		case "CallExpression": {
			// A CallExpression is not a valid assignment target (AssignmentTargetType
			// is invalid, 13.15.1), so `[f() = 1] = x` / `[(f()), b] = y` are early
			// SyntaxErrors. meriyah in webcompat mode fails to reject these, so
			// enforce the early error here (only in a destructuring *assignment*).
			if (isAssign) {
				throw new SyntaxDiagnostic("parse", "Invalid destructuring assignment target");
			}
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	identifier: ESTree.Identifier,
	value: number,
	isAssign = false,
) {
	if (identifierUsesDynamicEnvironment(program, fn, identifier)) {
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	identifier: ESTree.Identifier,
	value: number,
	isAssign = false,
) {
	const found = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "withSet",
		registers: [found, value],
		nameStringIndex: getOrCreateStringConstant(program, identifier.name),
	});

	const skipJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [found],
		blocks: [-1],
	};
	const fallbackJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(skipJump, fallbackJump);

	const fallbackIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	cursor.block = fn.blocks[fallbackIdx]!;
	compileStaticIdentifierTarget(program, fn, cursor, identifier, value, isAssign);
	const fallbackJoin: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(fallbackJoin);

	const joinIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	skipJump.blocks[0] = joinIdx;
	fallbackJump.blocks[0] = fallbackIdx;
	fallbackJoin.blocks[0] = joinIdx;
	cursor.block = fn.blocks[joinIdx]!;
}

/**
 * A `with`-intercepted identifier assignment with spec-correct reference
 * ordering: the reference base (the with-object providing the name, or none) is
 * resolved BEFORE the right-hand side, then GetValue/PutValue operate on that
 * captured base. This matters when the RHS deletes or replaces the binding
 * (`with(scope){ x = (delete scope.x, 2) }` must still write `scope.x`), which
 * the withSet-after-RHS path in `compileWithDynamicWrite` gets wrong.
 */
function compileWithDynamicAssignment(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	assignmentExpression: ESTree.AssignmentExpression,
	left: ESTree.Identifier,
): number {
	const nameStringIndex = getOrCreateStringConstant(program, left.name);
	const base = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "withResolveBase",
		registers: [base],
		nameStringIndex,
	});
	const key = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createString",
		registers: [key],
		stringIndex: nameStringIndex,
	});
	const empty = nextCoreVariable(fn);
	cursor.block.emitter.emit({ type: "isEmpty", registers: [empty, base] });
	const missJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [empty],
		blocks: [-1],
	};
	const foundJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(missJump, foundJump);
	const result = nextCoreVariable(fn);

	const compileValue = (branch: CoreFrontendCursor, current?: number): number => {
		const right = compileExpression(
			program,
			fn,
			branch,
			assignmentExpression.right,
			left.name,
		);
		if (assignmentExpression.operator === "=") return right;
		const value = nextCoreVariable(fn);
		branch.block.emitter.emit({
			type: "binary",
			registers: [value, current!, right],
			operator: assignmentOperatorToBinaryOperator(assignmentExpression.operator),
		});
		return value;
	};

	const foundIndex = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	const foundCursor = { block: fn.blocks[foundIndex]! };
	let foundCurrent: number | undefined;
	if (assignmentExpression.operator !== "=") {
		foundCurrent = nextCoreVariable(fn);
		foundCursor.block.emitter.emit({
			type: "loadProperty",
			registers: [foundCurrent, base, key],
		});
	}
	const foundValue = compileValue(foundCursor, foundCurrent);
	compileWithBaseStore(program, fn, foundCursor, base, key, left, foundValue);
	foundCursor.block.emitter.emit({ type: "move", registers: [result, foundValue] });
	const foundJoin: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	foundCursor.block.emitter.emit(foundJoin);

	const missIndex = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	const missCursor = { block: fn.blocks[missIndex]! };
	const missCurrent =
		assignmentExpression.operator === "="
			? undefined
			: compileStaticIdentifier(program, fn, missCursor, left);
	const missValue = compileValue(missCursor, missCurrent);
	compileStaticIdentifierTarget(program, fn, missCursor, left, missValue, true);
	missCursor.block.emitter.emit({ type: "move", registers: [result, missValue] });
	const missJoin: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	missCursor.block.emitter.emit(missJoin);

	const joinIndex = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	missJump.blocks[0] = missIndex;
	foundJump.blocks[0] = foundIndex;
	foundJoin.blocks[0] = joinIndex;
	missJoin.blocks[0] = joinIndex;
	cursor.block = fn.blocks[joinIndex]!;
	return result;
}

/**
 * Read `name` from a captured with-base: if `base` is a real object (not the
 * EMPTY sentinel) read the property off it (running any getter); otherwise
 * resolve the static binding. Both paths join into one result register.
 */
function compileWithBaseRead(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	base: number,
	key: number,
	identifier: ESTree.Identifier,
): number {
	const result = nextCoreVariable(fn);
	const emptyFlag = nextCoreVariable(fn);
	cursor.block.emitter.emit({ type: "isEmpty", registers: [emptyFlag, base] });

	const missJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [emptyFlag],
		blocks: [-1],
	};
	const foundJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(missJump, foundJump);

	// Found: [[Get]] the property off the captured base object.
	const foundIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	cursor.block = fn.blocks[foundIdx]!;
	cursor.block.emitter.emit({
		type: "loadProperty",
		registers: [result, base, key],
	});
	const foundJoin: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(foundJoin);

	// Miss: resolve the static binding into the same result register.
	const missIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	cursor.block = fn.blocks[missIdx]!;
	const staticValue = compileStaticIdentifier(program, fn, cursor, identifier);
	cursor.block.emitter.emit({ type: "move", registers: [result, staticValue] });
	const missJoin: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(missJoin);

	const joinIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	foundJump.blocks[0] = foundIdx;
	missJump.blocks[0] = missIdx;
	foundJoin.blocks[0] = joinIdx;
	missJoin.blocks[0] = joinIdx;
	cursor.block = fn.blocks[joinIdx]!;
	return result;
}

/**
 * Store `value` to a captured with-base: if `base` is a real object (not EMPTY)
 * call the Object Environment Record's SetMutableBinding semantics; otherwise
 * fall back to the static store. A strict nested function can resolve through a
 * `with` environment even though the `with` statement itself is sloppy-only.
 */
function compileWithBaseStore(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	base: number,
	key: number,
	identifier: ESTree.Identifier,
	value: number,
) {
	const emptyFlag = nextCoreVariable(fn);
	cursor.block.emitter.emit({ type: "isEmpty", registers: [emptyFlag, base] });

	const missJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [emptyFlag],
		blocks: [-1],
	};
	const foundJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(missJump, foundJump);

	// Found: SetMutableBinding on the captured with-object. In strict code a
	// binding that vanished between GetValue and PutValue (a getter that deleted
	// it during a compound read) is unresolvable, so PutValue re-checks
	// HasProperty and throws a ReferenceError instead of recreating the property.
	const foundIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	cursor.block = fn.blocks[foundIdx]!;
	const stillExists = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "binary",
		registers: [stillExists, key, base],
		operator: "in",
	});
	let throwJoin: Extract<CompilerInstruction, { type: "jump" }> | undefined;
	if (!isSloppyFunction(fn)) {
		const storeJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
			type: "jumpIf",
			registers: [stillExists],
			blocks: [-1],
		};
		const throwJump: Extract<CompilerInstruction, { type: "jump" }> = {
			type: "jump",
			blocks: [-1],
		};
		cursor.block.emitter.emit(storeJump, throwJump);

		const throwIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
		cursor.block = fn.blocks[throwIdx]!;
		const undeclared = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "loadUndeclared",
			registers: [undeclared],
			nameStringIndex: getOrCreateStringConstant(program, identifier.name),
		});
		throwJoin = { type: "jump", blocks: [-1] };
		cursor.block.emitter.emit(throwJoin);

		const storeIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
		storeJump.blocks[0] = storeIdx;
		throwJump.blocks[0] = throwIdx;
		cursor.block = fn.blocks[storeIdx]!;
	}
	cursor.block.emitter.emit({
		type: "storeProperty",
		registers: [base, key, value],
	});
	emitDirectEvalDirtyMark(program, fn, cursor, base, key);
	const foundJoin: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(foundJoin);

	// Miss: static store.
	const missIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	cursor.block = fn.blocks[missIdx]!;
	compileStaticIdentifierTarget(program, fn, cursor, identifier, value, true);
	const missJoin: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(missJoin);

	const joinIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	foundJump.blocks[0] = foundIdx;
	missJump.blocks[0] = missIdx;
	foundJoin.blocks[0] = joinIdx;
	missJoin.blocks[0] = joinIdx;
	if (throwJoin) {
		throwJoin.blocks[0] = joinIdx;
	}
	cursor.block = fn.blocks[joinIdx]!;
}

/** Record a Set only when a captured with-reference targets the injected eval scope. */
function emitDirectEvalDirtyMark(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	base: number,
	key: number,
): void {
	const scopeBinding = program.directEvalScopeObjectBinding;
	const dirtyBinding = program.directEvalDirtyTrackerBinding;
	if (!scopeBinding || !dirtyBinding) return;

	const evalScope = loadCapturedBinding(program, fn, cursor, scopeBinding);
	const isEvalScope = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "binary",
		registers: [isEvalScope, base, evalScope],
		operator: "===",
	});
	const markJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [isEvalScope],
		blocks: [-1],
	};
	const skipJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(markJump, skipJump);

	const markIndex = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	cursor.block = fn.blocks[markIndex]!;
	const dirtyTracker = loadCapturedBinding(program, fn, cursor, dirtyBinding);
	const assigned = nextCoreVariable(fn);
	cursor.block.emitter.emit(
		{ type: "createBoolean", registers: [assigned], value: true },
		{ type: "storeProperty", registers: [dirtyTracker, key, assigned] },
	);
	const markJoin: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(markJoin);

	const joinIndex = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	markJump.blocks[0] = markIndex;
	skipJump.blocks[0] = joinIndex;
	markJoin.blocks[0] = joinIndex;
	cursor.block = fn.blocks[joinIndex]!;
}

function compileStaticIdentifierTarget(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
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
	const hostGlobalLocation = retainHostGlobal(program, binding)
		? globalPropertyLocation(program, binding.name)
		: null;

	if (isAssign) {
		emitWriteTdzGuard(program, fn, cursor.block, binding, hostGlobalLocation);
	}

	if (isAssign && binding.kind === "const" && !binding.undeclared) {
		// Destructuring assignment to a const binding is a TypeError, matching the
		// plain-assignment path (PutValue → SetMutableBinding on an immutable
		// binding). The right-hand side / iterator steps have already run.
		emitThrowTypeError(program, fn, cursor, "Assignment to constant variable.");
		return;
	}

	if (binding.undeclared && !compilerPrivateIntrinsics.has(binding.name)) {
		// A statically-undeclared name can still resolve through the global object's
		// Object Environment Record. The runtime store checks whether the property
		// exists and throws for an actually-unresolvable strict assignment.
		emitGlobalPropertyStore(program, fn, cursor, binding.name, value);
		return;
	}

	const location = hostGlobalLocation ?? getOrCreateBindingLocation(program, fn, binding);
	storeRegisterAtLocation(cursor.block, location, value);
}

/**
 * Resolve a default value: `target = expr` initializes from expr only when the
 * value is undefined. Same branch-and-join structure as ternaries.
 */
function compileDefaultedValue(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	value: number,
	defaultExpression: ESTree.Expression,
	nameHint?: string,
): number {
	const result = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "move",
		registers: [result, value],
	});

	const undefinedRegister = compileUndefined(fn, cursor);
	const condition = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "binary",
		registers: [condition, value, undefinedRegister],
		operator: "===",
	});

	const defaultJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [condition],
		blocks: [-1],
	};
	const skipJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(defaultJump, skipJump);

	const defaultIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	cursor.block = fn.blocks[defaultIdx]!;
	const defaultValue = compileExpression(
		program,
		fn,
		cursor,
		defaultExpression,
		nameHint,
	);
	cursor.block.emitter.emit({
		type: "move",
		registers: [result, defaultValue],
	});
	const joinJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(joinJump);

	const joinIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	defaultJump.blocks[0] = defaultIdx;
	skipJump.blocks[0] = joinIdx;
	joinJump.blocks[0] = joinIdx;
	cursor.block = fn.blocks[joinIdx]!;

	return result;
}

function compileObjectPatternTarget(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	pattern: ESTree.ObjectPattern,
	value: number,
	isAssign = false,
) {
	// Nil sources throw even when the pattern reads no properties.
	cursor.block.emitter.emit({
		type: "requireCoercible",
		registers: [value],
	});

	// Keys consumed by earlier properties are excluded from the rest copy.
	const consumedKeys: Array<number> = [];

	for (const property of pattern.properties) {
		if (property.type === "RestElement" || property.type === "SpreadElement") {
			// Rest is last by grammar. The typings allow SpreadElement here,
			// both shapes carry the target in argument.
			const privateTarget = isAssign
				? privateAssignmentMemberTarget(property.argument)
				: undefined;
			const privateReference = privateTarget
				? compilePrivateMemberReference(program, fn, cursor, privateTarget)
				: undefined;
			const rest = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "copyDataProperties",
				registers: [rest, value, ...consumedKeys],
			});
			if (privateReference) {
				compilePrivateMemberStore(
					program,
					fn,
					cursor,
					privateReference.object,
					privateReference.name,
					rest,
				);
			} else {
				compilePatternTarget(program, fn, cursor, property.argument, rest, isAssign);
			}
			continue;
		}

		if (property.type !== "Property") {
			continue;
		}

		let key = compilePropertyKey(program, fn, cursor, property);
		if (key === -1) {
			continue;
		}
		if (property.computed) {
			// PropertyName evaluation applies ToPropertyKey once. Reuse that
			// canonical string/symbol for both the property read and the later
			// rest-exclusion list so an observable coercion cannot run twice.
			const propertyKey = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "toPropertyKey",
				registers: [propertyKey, value, key],
			});
			key = propertyKey;
		}
		consumedKeys.push(key);
		// KeyedDestructuringAssignmentEvaluation evaluates a non-pattern target
		// reference before GetV. Preserve the private receiver now, but defer the
		// brand-checked PrivateSet until after the source getter and initializer.
		const privateTarget = isAssign
			? privateAssignmentMemberTarget(property.value)
			: undefined;
		const privateReference = privateTarget
			? compilePrivateMemberReference(program, fn, cursor, privateTarget)
			: undefined;

		const propertyValue = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "loadProperty",
			registers: [propertyValue, value, key],
		});
		if (privateReference) {
			const assignedValue =
				property.value.type === "AssignmentPattern" && property.value.right
					? compileDefaultedValue(
							program,
							fn,
							cursor,
							propertyValue,
							property.value.right,
						)
					: propertyValue;
			compilePrivateMemberStore(
				program,
				fn,
				cursor,
				privateReference.object,
				privateReference.name,
				assignedValue,
			);
		} else {
			compilePatternTarget(program, fn, cursor, property.value, propertyValue, isAssign);
		}
	}
}

function privateAssignmentMemberTarget(
	target: ESTree.Node,
): ESTree.MemberExpression | undefined {
	const assignmentTarget = target.type === "AssignmentPattern" ? target.left : target;
	return assignmentTarget.type === "MemberExpression" &&
		assignmentTarget.property.type === "PrivateIdentifier"
		? assignmentTarget
		: undefined;
}

/**
 * Drain an iterator into array[index++] with a step loop. The loop-carried
 * registers survive the back edge because multi-block registers are never
 * freed by the allocator.
 */
function compileIteratorDrainInto(
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	array: number,
	index: number,
	one: number,
	iteratorRegister: number,
	nextRegister: number,
	doneRegister = nextCoreVariable(fn),
) {
	const headerIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	cursor.block.emitter.emit({
		type: "jump",
		blocks: [headerIdx],
	});

	const header = fn.blocks[headerIdx]!;
	const valueRegister = nextCoreVariable(fn);
	header.emitter.emit({
		type: "iteratorStep",
		registers: [valueRegister, doneRegister, iteratorRegister, nextRegister],
	});
	const exitJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [doneRegister],
		blocks: [-1],
	};
	header.emitter.emit(exitJump);

	const bodyIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	header.emitter.emit({
		type: "jump",
		blocks: [bodyIdx],
	});
	const body = fn.blocks[bodyIdx]!;
	body.emitter.emit({
		type: "storeProperty",
		registers: [array, index, valueRegister],
	});
	// Increment in place: index is loop-carried.
	body.emitter.emit({
		type: "binary",
		registers: [index, index, one],
		operator: "+",
	});
	body.emitter.emit({
		type: "jump",
		blocks: [headerIdx],
	});

	const afterIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	exitJump.blocks[0] = afterIdx;
	cursor.block = fn.blocks[afterIdx]!;
}

/**
 * Drain the rest of an iterator into a fresh array.
 */
function compileIteratorRest(
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	iteratorRegister: number,
	nextRegister: number,
	doneRegister?: number,
): number {
	const rest = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createArray",
		registers: [rest],
		length: 0,
	});
	const index = compileNumberLiteral(fn, cursor, 0);
	const one = compileNumberLiteral(fn, cursor, 1);
	compileIteratorDrainInto(
		fn,
		cursor,
		rest,
		index,
		one,
		iteratorRegister,
		nextRegister,
		doneRegister,
	);

	return rest;
}

/**
 * Run assignment-target evaluation in a protected range. Iterator steps stay
 * outside this helper: a throw from next() must not close the iterator.
 */
function compileWithIteratorCloseOnThrow(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	iteratorRegister: number,
	compileTarget: () => void,
	doneRegister?: number,
): void {
	const tryBegin: Extract<CompilerInstruction, { type: "tryBegin" }> = {
		type: "tryBegin",
		blocks: [-1, -1],
	};
	cursor.block.emitter.emit(tryBegin);

	compileTarget();

	const tryExit: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const tryExitIdx = fn.blocks.push(tryExit) - 1;
	tryExit.emitter.emit({ type: "tryEnd" });
	tryBegin.blocks[1] = tryExitIdx;
	cursor.block.emitter.emit({ type: "jump", blocks: [tryExitIdx] });

	const handler: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	tryBegin.blocks[0] = fn.blocks.push(handler) - 1;
	const caught = nextCoreVariable(fn);
	handler.emitter.emit({ type: "catch", registers: [caught] });

	const rethrowBlock = emitIteratorCloseForCompletion(
		program,
		fn,
		handler,
		iteratorRegister,
		false,
		doneRegister,
	);
	rethrowBlock.emitter.emit({ type: "throw", registers: [caught] });

	const continuationIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	tryExit.emitter.emit({ type: "jump", blocks: [continuationIdx] });
	cursor.block = fn.blocks[continuationIdx]!;
}

/**
 * Evaluate an assignment element's member reference before consuming its
 * iterator. The raw key is deliberately not coerced here; PutValue performs
 * ToPropertyKey later. Locals carry the reference across tryEnd's invisible edge.
 */
function compileCapturedMemberReference(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	target: ESTree.MemberExpression,
	iteratorRegister: number,
	doneRegister?: number,
): CompiledMemberReference | CompiledPrivateMemberReference {
	if (target.property.type === "PrivateIdentifier") {
		const objectSlot = fn.nextLocalIndex++;
		compileWithIteratorCloseOnThrow(
			program,
			fn,
			cursor,
			iteratorRegister,
			() => {
				const reference = compilePrivateMemberReference(program, fn, cursor, target);
				cursor.block.emitter.emit({
					type: "storeLocal",
					registers: [reference.object],
					index: objectSlot,
				});
			},
			doneRegister,
		);

		const capturedObject = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "loadLocal",
			registers: [capturedObject],
			index: objectSlot,
		});
		return { object: capturedObject, name: `#${target.property.name}` };
	}

	let compiled: CompiledMemberReference = { object: -1, key: -1 };
	let slots: { object: number; key: number; receiver?: number } | undefined;

	compileWithIteratorCloseOnThrow(
		program,
		fn,
		cursor,
		iteratorRegister,
		() => {
			compiled = compileMemberObjectAndKey(program, fn, cursor, target);
			if (compiled.object === -1 || compiled.key === -1) {
				return;
			}

			slots = {
				object: fn.nextLocalIndex++,
				key: fn.nextLocalIndex++,
				receiver: compiled.receiver === undefined ? undefined : fn.nextLocalIndex++,
			};
			cursor.block.emitter.emit(
				{
					type: "storeLocal",
					registers: [compiled.object],
					index: slots.object,
				},
				{ type: "storeLocal", registers: [compiled.key], index: slots.key },
			);
			if (compiled.receiver !== undefined && slots.receiver !== undefined) {
				cursor.block.emitter.emit({
					type: "storeLocal",
					registers: [compiled.receiver],
					index: slots.receiver,
				});
			}
		},
		doneRegister,
	);

	if (!slots) {
		return compiled;
	}

	const object = nextCoreVariable(fn);
	const key = nextCoreVariable(fn);
	cursor.block.emitter.emit(
		{ type: "loadLocal", registers: [object], index: slots.object },
		{ type: "loadLocal", registers: [key], index: slots.key },
	);
	if (slots.receiver === undefined) {
		return { object, key };
	}

	const receiver = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "loadLocal",
		registers: [receiver],
		index: slots.receiver,
	});
	return { object, key, receiver };
}

function compileCapturedMemberStore(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	reference: CompiledMemberReference | CompiledPrivateMemberReference,
	value: number,
): void {
	if ("name" in reference) {
		compilePrivateMemberStore(
			program,
			fn,
			cursor,
			reference.object,
			reference.name,
			value,
		);
	} else if (reference.object !== -1 && reference.key !== -1) {
		compileMemberStore(cursor, reference, value);
	}
}

function compileArrayPatternTarget(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	pattern: ESTree.ArrayPattern,
	value: number,
	isAssign = false,
) {
	// Spec-shaped: the source goes through GetIterator (nil and non-iterable
	// values throw TypeError), elements consume steps in order.
	const iteratorRegister = nextCoreVariable(fn);
	const nextRegister = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "getIterator",
		registers: [iteratorRegister, nextRegister, value],
	});
	const doneRegister = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createBoolean",
		registers: [doneRegister],
		value: false,
	});
	const iteratorScope: SemanticControlContext = {
		kind: "iterator",
		breakJumps: [],
		continueJumps: [],
		iteratorRegister,
		iteratorDoneRegister: doneRegister,
		iteratorCloseNormal: true,
	};
	(fn.loops ??= []).push(iteratorScope);

	for (const element of pattern.elements) {
		if (element?.type === "RestElement") {
			// Assignment rest evaluates its reference before it starts draining. Keep
			// its raw base/key/receiver, then PutValue only after exhaustion.
			const capturedMember =
				isAssign && element.argument.type === "MemberExpression"
					? compileCapturedMemberReference(
							program,
							fn,
							cursor,
							element.argument,
							iteratorRegister,
							doneRegister,
						)
					: undefined;

			// Rest is last by grammar and exhausts the iterator: next() and the
			// eventual store are outside the close-on-reference-abrupt range.
			const rest = compileIteratorRest(
				fn,
				cursor,
				iteratorRegister,
				nextRegister,
				doneRegister,
			);
			fn.loops.pop();
			if (capturedMember) {
				compileCapturedMemberStore(program, fn, cursor, capturedMember, rest);
			} else {
				compilePatternTarget(program, fn, cursor, element.argument, rest, isAssign);
			}
			return;
		}

		// A simple assignment element evaluates its reference before advancing the
		// iterator. AssignmentPattern only delays its initializer and PutValue.
		const assignmentPattern = element as unknown as
			| ESTree.AssignmentPattern
			| null
			| undefined;
		const defaultTarget = assignmentPattern?.left as unknown as ESTree.Node | undefined;
		const memberTarget =
			isAssign && element?.type === "MemberExpression"
				? element
				: isAssign &&
					  assignmentPattern?.type === "AssignmentPattern" &&
					  defaultTarget?.type === "MemberExpression"
					? defaultTarget
					: undefined;
		const capturedMember = memberTarget
			? compileCapturedMemberReference(
					program,
					fn,
					cursor,
					memberTarget,
					iteratorRegister,
					doneRegister,
				)
			: undefined;

		// Holes consume a step without binding. An exhausted iterator steps
		// to undefined; the extra next() calls past done are a known
		// deviation from the spec's [[Done]] tracking.
		const elementValue = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "iteratorStep",
			registers: [elementValue, doneRegister, iteratorRegister, nextRegister],
		});

		if (element) {
			if (capturedMember) {
				compileWithIteratorCloseOnThrow(
					program,
					fn,
					cursor,
					iteratorRegister,
					() => {
						const assignedValue =
							assignmentPattern?.type === "AssignmentPattern" && assignmentPattern.right
								? compileDefaultedValue(
										program,
										fn,
										cursor,
										elementValue,
										assignmentPattern.right,
									)
								: elementValue;
						compileCapturedMemberStore(
							program,
							fn,
							cursor,
							capturedMember,
							assignedValue,
						);
					},
					doneRegister,
				);
			} else if (isAssign) {
				compileWithIteratorCloseOnThrow(
					program,
					fn,
					cursor,
					iteratorRegister,
					() => compilePatternTarget(program, fn, cursor, element, elementValue, true),
					doneRegister,
				);
			} else {
				compileWithIteratorCloseOnThrow(
					program,
					fn,
					cursor,
					iteratorRegister,
					() => compilePatternTarget(program, fn, cursor, element, elementValue, false),
					doneRegister,
				);
			}
		}
	}

	cursor.block = emitIteratorCloseForCompletion(
		program,
		fn,
		cursor.block,
		iteratorRegister,
		true,
		doneRegister,
	);
	fn.loops.pop();
}

/**
 * Lower any list of statements into a frontend register block.
 *
 * It adds the block to the function and returns the block index.
 */
function compileStatementsToBlock(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	statements: Array<ESTree.Statement>,
	/**
	 * Hoist top-level function declarations in this list to the start of the
	 * block, matching FunctionDeclarationInstantiation / GlobalDeclarationInstantiation:
	 * the function object is created and bound before any other statement runs, so
	 * code may call (or otherwise reference) the function before its textual position.
	 *
	 * Only set for function bodies, program/module bodies and class static blocks -
	 * the lists where a function declaration is function/global-scoped in both strict
	 * and sloppy mode. Nested blocks initialize their lexical function binding at block
	 * entry; Annex B mirrors that value into the var scope at the textual position.
	 */
	hoistFunctions = false,
	resourceScope = true,
): number {
	if (
		resourceScope &&
		statements.some(
			(statement) =>
				statement.type === "VariableDeclaration" &&
				(statement.kind === "using" || statement.kind === "await using"),
		)
	) {
		return compileDisposableStatementScope(program, fn, statements, hoistFunctions);
	}

	let block: CoreFrontendBlock = {
		emitter: unboundCoreEmitter,
	};
	// Store the first block index so we can return that to allow jumping to that block.
	const blockIdx = fn.blocks.push(block) - 1;

	const firstStatement = statements[0];
	const firstScope = firstStatement
		? fn.semanticFile.nodeToScope.get(firstStatement)
		: undefined;
	// Statements normally map to their containing lexical scope. Declarations
	// that introduce their own nested scope map to that scope instead, so step
	// back to the scope whose bindings are initialized by this statement list.
	const enclosingScope =
		firstScope && firstScope.node === firstStatement
			? (firstScope.parent ?? undefined)
			: firstScope;

	// A captured block binding must belong to the activation executing this
	// statement list. Its initializer can be a closure that reads the binding
	// recursively; compiling that closure first would otherwise let the child
	// function claim the storage slot for itself. Reserve direct block bindings
	// before compiling any initializer, just as function-body hoisting does.
	for (const binding of enclosingScope?.bindings ?? []) {
		if (binding.scopedTo === "captured") {
			getOrCreateBindingLocation(program, fn, binding);
		}
	}

	// Hoisting pre-pass: bind every top-level function declaration up front so the
	// loop below can skip re-emitting them at their textual position.
	const hoistedDeclarations = new Set<ESTree.Node>();
	const annexBHoistedDeclarations = new Set<ESTree.FunctionDeclaration>();
	const functionDeclarations = statements.flatMap((statement) => {
		const declaration =
			statement.type === "FunctionDeclaration"
				? statement
				: statement.type === "ExportNamedDeclaration" &&
					  statement.declaration?.type === "FunctionDeclaration"
					? statement.declaration
					: undefined;
		return declaration ? [declaration] : [];
	});
	if (hoistFunctions) {
		// Function/Eval/GlobalDeclarationInstantiation scans in reverse and keeps
		// only the final declaration for each name.
		const functionNames = new Set<string>();
		const functionsToInitialize: Array<ESTree.FunctionDeclaration> = [];
		for (let i = functionDeclarations.length - 1; i >= 0; i--) {
			const declaration = functionDeclarations[i]!;
			const name = declaration.id?.name;
			if (name === undefined || functionNames.has(name)) {
				continue;
			}
			functionNames.add(name);
			functionsToInitialize.unshift(declaration);
		}
		const declarationScopes: Array<Scope> = [];
		for (
			let scope: Scope | null | undefined = enclosingScope;
			scope;
			scope = scope.parent
		) {
			declarationScopes.push(scope);
			if (FUNCTION_UNIT_NODE_TYPES.has(scope.node.type)) break;
		}
		for (const scope of declarationScopes) {
			emitGlobalDeclarationChecks(
				program,
				fn,
				block,
				scope,
				functionsToInitialize,
				functionNames,
			);
		}

		if (
			fn.semanticFile.type === "script" &&
			!program.evalCompletion &&
			declarationScopes.includes(fn.semanticFile.scopes[0]!)
		) {
			const lexicalBindings = fn.semanticFile.scopes[0]!.bindings.filter(
				(binding) =>
					!binding.undeclared &&
					!binding.implicit &&
					binding.scopedTo === "global" &&
					(binding.kind === "let" || binding.kind === "const") &&
					!isScriptGlobalProperty(program, fn.semanticFile, binding),
			);
			for (const checkOnly of [true, false]) {
				for (const binding of lexicalBindings) {
					const location = getOrCreateBindingLocation(program, fn, binding);
					if (location.type !== "global")
						throw new Error("Global lexical binding requires a global slot");
					block.emitter.emit({
						type: "declareGlobalLexical",
						nameStringIndex: getOrCreateStringConstant(program, binding.name),
						index: location.index,
						immutable: binding.kind === "const",
						checkOnly,
					});
				}
			}
		}

		// Reserve this function's own captured-binding slots before compiling any
		// hoisted function body. getOrCreateBindingLocation charges a captured slot
		// to whichever function first *requests* it; hoisting lets a nested
		// closure's body run before the owning declaration, so without this the
		// closure would wrongly claim ownership (wrong owner functionIndex + slot)
		// of a binding that actually lives in this activation. Touching them here
		// makes `fn` the owner, and the nested closure then resolves to that slot.
		for (const scope of declarationScopes) {
			for (const binding of scope.bindings) {
				if (binding.scopedTo === "captured") {
					getOrCreateBindingLocation(program, fn, binding);
				}
			}
		}

		for (const declaration of functionsToInitialize) {
			compileFunctionDeclaration(program, fn, block, declaration);
		}
		for (const declaration of functionDeclarations) {
			hoistedDeclarations.add(declaration);
		}
		for (const scope of declarationScopes) {
			emitVarDeclarationInits(program, fn, block, scope, functionNames);
		}
	} else {
		for (const declaration of functionDeclarations) {
			const binding = fn.semanticFile.nodeToBinding.get(declaration);
			if (binding?.kind !== "let") continue;
			compileFunctionDeclaration(program, fn, block, declaration, false);
			if (binding.annexBVarBinding) {
				annexBHoistedDeclarations.add(declaration);
			} else {
				hoistedDeclarations.add(declaration);
			}
		}
	}

	for (const statement of statements) {
		if (statement.type === "BlockStatement" && statement.body.length === 0) {
			continue;
		}

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
				emitter: unboundCoreEmitter,
			};

			const jumpTarget = fn.blocks.push(block) - 1;
			// Unconditionally add the jump. In a later pass we can optimize these jumps out.
			for (let i = lastBlockIdx + 1; i < jumpTarget; i++) {
				fn.blocks[i]!.emitter.emit({
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
				if (annexBHoistedDeclarations.has(statement)) {
					compileAnnexBVarAssignment(program, fn, block, statement);
				} else if (!hoistedDeclarations.has(statement)) {
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
				compileBreakStatement(program, fn, block, statement);
				break;
			}
			case "ContinueStatement": {
				compileContinueStatement(program, fn, block, statement);
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

		// Nothing after a direct abrupt completion in this statement list is
		// reachable. Besides avoiding dead IR, stopping here keeps structured
		// try markers balanced: a terminated emitter intentionally drops a later
		// tryBegin, while lowering that unreachable try would otherwise create a
		// fresh block containing its unmatched tryEnd.
		if (
			statement.type === "ReturnStatement" ||
			statement.type === "ThrowStatement" ||
			statement.type === "BreakStatement" ||
			statement.type === "ContinueStatement"
		) {
			break;
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
		block = { emitter: unboundCoreEmitter };
		const jumpTarget = fn.blocks.push(block) - 1;
		for (let i = lastBlockIdx + 1; i < jumpTarget; i++) {
			fn.blocks[i]!.emitter.emit({
				type: "jump",
				blocks: [jumpTarget],
			});
		}
	}

	return blockIdx;
}

function compileDisposableStatementScope(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	statements: Array<ESTree.Statement>,
	hoistFunctions: boolean,
): number {
	const { entryIdx } = compileDisposableRegion(
		program,
		fn,
		statements.some(
			(statement) =>
				statement.type === "VariableDeclaration" && statement.kind === "await using",
		),
		(entry) => {
			const bodyEntry = compileStatementsToBlock(
				program,
				fn,
				statements,
				hoistFunctions,
				false,
			);
			entry.emitter.emit({ type: "jump", blocks: [bodyEntry] });
			return fn.blocks.at(-1)!;
		},
	);
	return entryIdx;
}

function compileDisposableRegion(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	disposeAsync: boolean,
	compileProtected: (entry: CoreFrontendBlock) => CoreFrontendBlock,
): { entryIdx: number; tail: CoreFrontendBlock } {
	const entry: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const entryIdx = fn.blocks.push(entry) - 1;
	const cursor: CoreFrontendCursor = { block: entry };
	const createCapability = nextCoreVariable(fn);
	entry.emitter.emit({
		type: "loadIntrinsic",
		registers: [createCapability],
		intrinsic: "__newDisposeCapability",
	});
	const undefinedValue = compileUndefined(fn, cursor);
	const capability = nextCoreVariable(fn);
	entry.emitter.emit({
		type: "call",
		registers: [capability, createCapability, undefinedValue],
	});
	const capabilityLocation: BindingLocation = {
		type: "local",
		index: fn.nextLocalIndex++,
	};
	storeRegisterAtLocation(entry, capabilityLocation, capability);

	const kindReg = nextCoreVariable(fn);
	const valueReg = nextCoreVariable(fn);
	const finallyCtx: SemanticControlContext = {
		kind: "finally",
		breakJumps: [],
		continueJumps: [],
		finallyEntryJumps: [],
		completionKindReg: kindReg,
		completionValueReg: valueReg,
		finalizerArms: new Map(),
		disposeCapabilityLocation: capabilityLocation,
		disposeAsync,
	};
	const tryBegin: Extract<CompilerInstruction, { type: "tryBegin" }> = {
		type: "tryBegin",
		blocks: [-1, -1],
	};
	entry.emitter.emit(tryBegin);

	fn.loops ??= [];
	fn.loops.push(finallyCtx);
	const bodyLast = compileProtected(entry);
	fn.loops.pop();

	const normalExit: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const normalExitIdx = fn.blocks.push(normalExit) - 1;
	normalExit.emitter.emit({ type: "tryEnd" });
	tryBegin.blocks[1] = normalExitIdx;
	bodyLast.emitter.emit({ type: "jump", blocks: [normalExitIdx] });
	routeThroughFinalizer(normalExit, finallyCtx, "normal", null);

	const handler: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	tryBegin.blocks[0] = fn.blocks.push(handler) - 1;
	const caught = nextCoreVariable(fn);
	handler.emitter.emit({ type: "catch", registers: [caught] });
	routeThroughFinalizer(
		handler,
		finallyCtx,
		"throw",
		(block) => block.emitter.emit({ type: "throw", registers: [valueReg] }),
		caught,
	);

	const finalizer: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const finalizerIdx = fn.blocks.push(finalizer) - 1;
	for (const jump of finallyCtx.finallyEntryJumps!) {
		jump.blocks[0] = finalizerIdx;
	}

	const dispose = nextCoreVariable(fn);
	const finalizerThis = compileUndefined(fn, { block: finalizer });
	const finalizerCapability = loadRegisterFromLocation(fn, finalizer, capabilityLocation);
	const throwKind = nextCoreVariable(fn);
	const hasError = nextCoreVariable(fn);
	finalizer.emitter.emit(
		{
			type: "loadIntrinsic",
			registers: [dispose],
			intrinsic: "__disposeResources",
		},
		{
			type: "createNumber",
			registers: [throwKind],
			value: finallyCtx.finalizerArms!.get("throw")!.kind,
		},
		{
			type: "binary",
			registers: [hasError, kindReg, throwKind],
			operator: "===",
		},
	);
	const disposeResult = nextCoreVariable(fn);
	finalizer.emitter.emit({
		type: "call",
		registers: [
			disposeResult,
			dispose,
			finalizerThis,
			finalizerCapability,
			hasError,
			valueReg,
		],
	});
	let synchronousDisposeJump:
		| Extract<CompilerInstruction, { type: "jumpIf" }>
		| undefined;
	let asyncDisposeTail: CoreFrontendBlock | undefined;
	if (finallyCtx.disposeAsync) {
		const undefinedValue = nextCoreVariable(fn);
		const disposedSynchronously = nextCoreVariable(fn);
		finalizer.emitter.emit(
			{ type: "createUndefined", registers: [undefinedValue] },
			{
				type: "binary",
				registers: [disposedSynchronously, disposeResult, undefinedValue],
				operator: "===",
			},
		);
		synchronousDisposeJump = {
			type: "jumpIf",
			registers: [disposedSynchronously],
			blocks: [-1],
		};
		finalizer.emitter.emit(synchronousDisposeJump);
		const asyncDispose: CoreFrontendBlock = { emitter: unboundCoreEmitter };
		const asyncDisposeIdx = fn.blocks.push(asyncDispose) - 1;
		finalizer.emitter.emit({ type: "jump", blocks: [asyncDisposeIdx] });
		const asyncDisposeCursor: CoreFrontendCursor = { block: asyncDispose };
		compileAwaitRegister(program, fn, asyncDisposeCursor, disposeResult);
		asyncDisposeTail = asyncDisposeCursor.block;
	}

	const dispatchBlocks: Array<{ kind: number; idx: number }> = [];
	for (const { kind, fill } of finallyCtx.finalizerArms!.values()) {
		const arm: CoreFrontendBlock = { emitter: unboundCoreEmitter };
		const idx = fn.blocks.push(arm) - 1;
		fill(arm);
		dispatchBlocks.push({ kind, idx });
	}
	const epilogue: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const epilogueIdx = fn.blocks.push(epilogue) - 1;
	if (synchronousDisposeJump) {
		synchronousDisposeJump.blocks[0] = epilogueIdx;
		asyncDisposeTail!.emitter.emit({ type: "jump", blocks: [epilogueIdx] });
	} else {
		finalizer.emitter.emit({ type: "jump", blocks: [epilogueIdx] });
	}
	for (const { kind, idx } of dispatchBlocks) {
		const constant = nextCoreVariable(fn);
		const matches = nextCoreVariable(fn);
		epilogue.emitter.emit(
			{ type: "createNumber", registers: [constant], value: kind },
			{
				type: "binary",
				registers: [matches, kindReg, constant],
				operator: "===",
			},
			{ type: "jumpIf", registers: [matches], blocks: [idx] },
		);
	}
	return { entryIdx, tail: epilogue };
}

function compileClassDeclaration(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	statement: ESTree.ClassDeclaration,
) {
	const binding = fn.semanticFile.nodeToBinding.get(statement);
	if (!binding) {
		return;
	}

	const cursor: CoreFrontendCursor = { block };
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
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

	const cursor: CoreFrontendCursor = { block };
	let value: number;
	if (declaration.type === "FunctionDeclaration") {
		const functionIndex = compileNewFunctionExpression(
			program,
			fn,
			declaration as unknown as ESTree.FunctionExpression,
			undefined,
			"default",
		);
		value = nextCoreVariable(fn);
		cursor.block.emitter.emit({
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	statement: ESTree.ExpressionStatement,
) {
	const cursor: CoreFrontendCursor = { block };
	const result = compileExpression(program, fn, cursor, statement.expression);
	// Eval completion: record this statement's value as the running completion.
	// Use cursor.block (the expression's final block after any control flow), so
	// the move lands where the result is live; an unexecuted branch never reaches
	// here, giving the correct last-executed-value semantics.
	if (fn.completionRegister !== undefined && result !== undefined) {
		cursor.block.emitter.emit({
			type: "move",
			registers: [fn.completionRegister, result],
		});
	}
}

/** Initialize a compound statement's spec-level completion value. */
function resetEvalCompletion(fn: CoreFrontendFunction, block: CoreFrontendBlock) {
	if (fn.completionRegister !== undefined) {
		block.emitter.emit({
			type: "createUndefined",
			registers: [fn.completionRegister],
		});
	}
}

function compileFunctionDeclaration(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	statement: ESTree.FunctionDeclaration,
	initializeAnnexBVar = true,
) {
	const binding = fn.semanticFile.nodeToBinding.get(statement);
	if (!binding) {
		return;
	}

	const onlyUsedByDeclaration =
		binding.usageNodes.length === 0 ||
		(binding.usageNodes.length === 1 &&
			(binding.usageNodes[0] === statement || binding.usageNodes[0] === statement.id));
	if (
		onlyUsedByDeclaration &&
		!binding.annexBVarBinding &&
		!isScriptGlobalProperty(program, fn.semanticFile, binding) &&
		!(statement.id && isDirectEvalVarBinding(program, fn, statement.id))
	) {
		// Function is only used in its declaration, so we can skip it.
		return;
	}

	// Nested compilation may reach this captured declaration through direct eval.
	const location = getOrCreateBindingLocation(program, fn, binding);
	const fnIndex = compileNewFunction(
		program,
		binding,
		statement,
		inheritedPrivateEnvironment(fn, false),
	);

	const destination = nextCoreVariable(fn);
	block.emitter.emit({
		type: "createFunction",
		registers: [destination],

		functionIndex: fnIndex,
	});
	if (
		statement.id &&
		isNewDirectEvalVarBinding(program, fn, statement.id) &&
		program.directEvalPersistentScopeBinding
	) {
		const persistent = loadCapturedBinding(
			program,
			fn,
			{ block },
			program.directEvalPersistentScopeBinding,
		);
		storeDirectEvalScopeValue(
			program,
			fn,
			{ block },
			persistent,
			statement.id.name,
			destination,
		);
		return;
	}
	if (statement.id && identifierUsesDynamicEnvironment(program, fn, statement.id)) {
		compileWithDynamicWrite(program, fn, { block }, statement.id, destination);
		return;
	}

	if (location.type === "globalProperty") {
		block.emitter.emit({
			type: "storeGlobalProperty",
			registers: [destination],
			nameStringIndex: location.nameStringIndex,
			declaration: true,
			declarationConfigurable: program.evalCompletion,
		});
	} else {
		storeRegisterAtLocation(block, location, destination);
	}
	if (initializeAnnexBVar) {
		compileAnnexBVarAssignment(program, fn, block, statement);
	}
}

function compileAnnexBVarAssignment(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	statement: ESTree.FunctionDeclaration,
): void {
	const binding = fn.semanticFile.nodeToBinding.get(statement);
	const outer = binding?.annexBVarBinding;
	if (!binding || !outer) return;
	const value = loadRegisterFromLocation(
		fn,
		block,
		getOrCreateBindingLocation(program, fn, binding),
	);
	if (isDirectEvalVarBindingValue(program, fn, outer)) {
		const found = nextCoreVariable(fn);
		block.emitter.emit({
			type: "withSet",
			registers: [found, value],
			nameStringIndex: getOrCreateStringConstant(program, outer.name),
		});
		return;
	}
	const outerLocation = getOrCreateBindingLocation(program, fn, outer);
	if (outerLocation.type === "globalProperty") {
		emitGlobalPropertyStore(program, fn, { block }, outer.name, value);
	} else {
		storeRegisterAtLocation(block, outerLocation, value);
	}
}

function compileSwitchStatement(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	statement: ESTree.SwitchStatement,
) {
	const switchContext: SemanticControlContext = {
		kind: "switch",
		breakJumps: [],
		continueJumps: [],
		labels: takePendingLabels(fn),
	};
	(fn.loops ??= []).push(switchContext);

	const cursor: CoreFrontendCursor = { block };
	const discriminant = compileExpression(program, fn, cursor, statement.discriminant);
	resetEvalCompletion(fn, cursor.block);
	const scope = fn.semanticFile.nodeToScope.get(statement);
	if (scope) emitTdzHoleInits(program, fn, cursor.block, scope.bindings);

	const bodyStarts: Array<number> = [];
	let previousTail: CoreFrontendBlock | undefined;
	for (const switchCase of statement.cases) {
		const start = compileStatementsToBlock(program, fn, switchCase.consequent);
		if (previousTail) {
			previousTail.emitter.emit({
				type: "jump",
				blocks: [start],
			});
		}

		bodyStarts.push(start);
		previousTail = fn.blocks.at(-1)!;
	}

	const lastBodyExitJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	previousTail?.emitter.emit(lastBodyExitJump);

	const numericCases: Array<{ value: number; block: number }> = [];
	const stringCases: Array<{ value: string; block: number }> = [];
	let allNumeric = true;
	let allStrings = true;
	let stringCodeUnits = 0;
	for (const [i, switchCase] of statement.cases.entries()) {
		const test = switchCase.test;
		if (test === null) continue;
		if (allStrings) {
			if (
				test.type === "Literal" &&
				typeof test.value === "string" &&
				stringCases.length < NATIVE_STRING_SWITCH_CASE_LIMIT &&
				test.value.length <= NATIVE_STRING_SWITCH_CODE_UNIT_LIMIT - stringCodeUnits
			) {
				stringCases.push({ value: test.value, block: bodyStarts[i]! });
				stringCodeUnits += test.value.length;
			} else allStrings = false;
		}
		const value =
			test.type === "Literal" && typeof test.value === "number"
				? test.value
				: test.type === "UnaryExpression" &&
					  test.operator === "-" &&
					  test.argument.type === "Literal" &&
					  typeof test.argument.value === "number"
					? -test.argument.value
					: undefined;
		if (
			value === undefined ||
			!Number.isInteger(value) ||
			value < -2147483648 ||
			value > 2147483647
		)
			allNumeric = false;
		else numericCases.push({ value: value === 0 ? 0 : value, block: bodyStarts[i]! });
	}
	const nativeNumeric = allNumeric && numericCases.length >= 4;
	const nativeStrings = allStrings && stringCases.length >= 2;
	let defaultCase = -1;
	for (let i = 0; i < statement.cases.length; i++) {
		const switchCase = statement.cases[i]!;
		if (!switchCase.test) {
			defaultCase = i;
			continue;
		}

		if (nativeNumeric || nativeStrings) continue;
		const test = compileExpression(program, fn, cursor, switchCase.test);
		const matches = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "binary",
			registers: [matches, discriminant, test],
			operator: "===",
		});
		cursor.block.emitter.emit({
			type: "jumpIf",
			registers: [matches],
			blocks: [bodyStarts[i]!],
		});
	}

	const missJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [defaultCase >= 0 ? bodyStarts[defaultCase]! : -1],
	};
	if (nativeNumeric || nativeStrings)
		cursor.block.emitter.emitLiteralSwitch({
			selector: discriminant,
			cases: nativeNumeric
				? numericCases.map(({ value, block }) => ({
						value: { kind: "number", value },
						block,
					}))
				: stringCases.map(({ value, block }) => ({
						value: { kind: "string", index: getOrCreateStringConstant(program, value) },
						block,
					})),
			defaultTarget: missJump,
		});
	else cursor.block.emitter.emit(missJump);

	const exitIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	statement: ESTree.WhileStatement,
) {
	resetEvalCompletion(fn, block);
	const perIter = setupPerIterationScope(program, fn, statement);
	if (perIter) {
		block.emitter.emit({
			type: "envPush",
			scopeId: perIter.scopeId,
			slotCount: perIter.slotCount,
		});
	}
	const headerIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	block.emitter.emit({
		type: "jump",
		blocks: [headerIdx],
	});

	const loop: SemanticControlContext = {
		kind: "loop",
		breakJumps: [],
		continueJumps: [],
		labels: takePendingLabels(fn),
		perIterationScopeId: perIter?.scopeId,
		perIterationSlotCount: perIter?.slotCount,
	};
	(fn.loops ??= []).push(loop);

	const headerCursor: CoreFrontendCursor = { block: fn.blocks[headerIdx]! };
	const condition = compileExpression(program, fn, headerCursor, statement.test);

	const bodyIdx = compileStatementsToBlock(
		program,
		fn,
		normalizeStatementOrBlock(statement.body),
	);
	const bodyLastBlock = fn.blocks.at(-1)!;
	let iterationEntryIdx = bodyIdx;
	if (perIter) {
		const iterationEntry: CoreFrontendBlock = { emitter: unboundCoreEmitter };
		iterationEntryIdx = fn.blocks.push(iterationEntry) - 1;
		iterationEntry.emitter.emit(
			{
				type: "envCopy",
				scopeId: perIter.scopeId,
				slotCount: perIter.slotCount,
			},
			{ type: "jump", blocks: [bodyIdx] },
		);
	}
	headerCursor.block.emitter.emit({
		type: "jumpIf",
		registers: [condition],
		blocks: [iterationEntryIdx],
	});
	const exitJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		// Patched below, once the exit block exists.
		blocks: [-1],
	};
	headerCursor.block.emitter.emit(exitJump);

	// Back edge from the body tail to the condition.
	bodyLastBlock.emitter.emit({
		type: "jump",
		blocks: [headerIdx],
	});

	const exitIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	if (perIter) {
		fn.blocks[exitIdx]!.emitter.emit({ type: "envPop" });
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
 * Compile a do-while loop: the body runs first, the condition block at the
 * bottom decides on re-entry.
 */
function compileDoWhileStatement(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	statement: ESTree.DoWhileStatement,
) {
	resetEvalCompletion(fn, block);
	const perIter = setupPerIterationScope(program, fn, statement);
	if (perIter) {
		block.emitter.emit({
			type: "envPush",
			scopeId: perIter.scopeId,
			slotCount: perIter.slotCount,
		});
	}
	const loop: SemanticControlContext = {
		kind: "loop",
		breakJumps: [],
		continueJumps: [],
		labels: takePendingLabels(fn),
		perIterationScopeId: perIter?.scopeId,
		perIterationSlotCount: perIter?.slotCount,
	};
	(fn.loops ??= []).push(loop);

	const bodyIdx = compileStatementsToBlock(
		program,
		fn,
		normalizeStatementOrBlock(statement.body),
	);
	const bodyLastBlock = fn.blocks.at(-1)!;
	let iterationEntryIdx = bodyIdx;
	if (perIter) {
		const iterationEntry: CoreFrontendBlock = { emitter: unboundCoreEmitter };
		iterationEntryIdx = fn.blocks.push(iterationEntry) - 1;
		iterationEntry.emitter.emit(
			{
				type: "envCopy",
				scopeId: perIter.scopeId,
				slotCount: perIter.slotCount,
			},
			{ type: "jump", blocks: [bodyIdx] },
		);
	}
	block.emitter.emit({
		type: "jump",
		blocks: [iterationEntryIdx],
	});

	const conditionIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	bodyLastBlock.emitter.emit({
		type: "jump",
		blocks: [conditionIdx],
	});

	const conditionCursor: CoreFrontendCursor = { block: fn.blocks[conditionIdx]! };
	const condition = compileExpression(program, fn, conditionCursor, statement.test);
	conditionCursor.block.emitter.emit({
		type: "jumpIf",
		registers: [condition],
		blocks: [iterationEntryIdx],
	});
	const exitJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	conditionCursor.block.emitter.emit(exitJump);

	const exitIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	if (perIter) {
		fn.blocks[exitIdx]!.emitter.emit({ type: "envPop" });
	}
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
 * If a loop's lexical head or body bindings are captured by a closure, they need a
 * fresh environment each iteration so every closure observes its own binding.
 * Move those bindings into a synthetic capture scope (a negative env id that never
 * collides with a function index); the loop lowering emits the ENV_PUSH/COPY/POP ops.
 * Returns null when no such binding is captured (the common case — zero overhead).
 */
function setupPerIterationScope(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	loopNode:
		| ESTree.ForStatement
		| ESTree.ForInStatement
		| ESTree.ForOfStatement
		| ESTree.WhileStatement
		| ESTree.DoWhileStatement,
): { scopeId: number; slotCount: number } | null {
	const loopScope = fn.semanticFile.nodeToScope.get(loopNode);
	const ownedScopes = new Set<Scope>();
	if (loopScope?.node === loopNode) {
		ownedScopes.add(loopScope);
	}
	traverseEstree(loopNode.body, (node) => {
		if (FUNCTION_UNIT_NODE_TYPES.has(node.type)) return ESTREE_SKIP;
		if (LOOP_STATEMENT_TYPES.has(node.type)) return ESTREE_SKIP;
		const scope = fn.semanticFile.nodeToScope.get(node);
		if (scope?.node === node) ownedScopes.add(scope);
	});
	const captured = [...ownedScopes].flatMap(({ bindings }) =>
		bindings.filter((binding) => binding.scopedTo === "captured"),
	);
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	statement: ESTree.ForStatement,
) {
	if (
		statement.init?.type === "VariableDeclaration" &&
		(statement.init.kind === "using" || statement.init.kind === "await using")
	) {
		const { entryIdx } = compileDisposableRegion(
			program,
			fn,
			statement.init.kind === "await using",
			(entry) => {
				compileForStatementBody(program, fn, entry, statement);
				return fn.blocks.at(-1)!;
			},
		);
		block.emitter.emit({ type: "jump", blocks: [entryIdx] });
		return;
	}

	compileForStatementBody(program, fn, block, statement);
}

function compileForStatementBody(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	statement: ESTree.ForStatement,
) {
	// Per-iteration env, if head or body bindings are captured. ENV_PUSH enters scope
	// L0 (so the init stores into it), ENV_COPY before the first test copies L0→L1,
	// each update copies Li→Li+1 (the increment runs in the new env), and ENV_POP
	// restores the enclosing env on exit. Set up before the init compiles so the
	// head bindings resolve to the scope env.
	const perIter = setupPerIterationScope(program, fn, statement);
	if (perIter) {
		block.emitter.emit({
			type: "envPush",
			scopeId: perIter.scopeId,
			slotCount: perIter.slotCount,
		});
	}

	const initCursor: CoreFrontendCursor = { block };
	if (statement.init?.type === "VariableDeclaration") {
		compileVariableDeclaration(program, fn, block, statement.init);
		// The declaration manages its own cursor; re-resolve the tail block.
		initCursor.block = fn.blocks.at(-1) === block ? block : fn.blocks.at(-1)!;
	} else if (statement.init) {
		compileExpression(program, fn, initCursor, statement.init);
	}

	if (perIter) {
		initCursor.block.emitter.emit({
			type: "envCopy",
			scopeId: perIter.scopeId,
			slotCount: perIter.slotCount,
		});
	}
	resetEvalCompletion(fn, initCursor.block);

	const headerIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	initCursor.block.emitter.emit({
		type: "jump",
		blocks: [headerIdx],
	});

	const loop: SemanticControlContext = {
		kind: "loop",
		breakJumps: [],
		continueJumps: [],
		labels: takePendingLabels(fn),
		perIterationScopeId: perIter?.scopeId,
		perIterationSlotCount: perIter?.slotCount,
	};
	(fn.loops ??= []).push(loop);

	const headerCursor: CoreFrontendCursor = { block: fn.blocks[headerIdx]! };
	let condition: number;
	if (statement.test) {
		condition = compileExpression(program, fn, headerCursor, statement.test);
	} else {
		condition = nextCoreVariable(fn);
		headerCursor.block.emitter.emit({
			type: "createBoolean",
			registers: [condition],
			value: true,
		});
	}

	const bodyIdx = compileStatementsToBlock(program, fn, [statement.body]);
	headerCursor.block.emitter.emit({
		type: "jumpIf",
		registers: [condition],
		blocks: [bodyIdx],
	});
	const exitJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	headerCursor.block.emitter.emit(exitJump);

	// The update block is the continue target and closes the back edge.
	const bodyLastBlock = fn.blocks.at(-1)!;
	const updateIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	bodyLastBlock.emitter.emit({
		type: "jump",
		blocks: [updateIdx],
	});

	const updateCursor: CoreFrontendCursor = { block: fn.blocks[updateIdx]! };
	// CreatePerIterationEnvironment: copy the bindings forward (Li→Li+1) before the
	// increment, so the increment and next test/body run in the fresh env.
	if (perIter) {
		updateCursor.block.emitter.emit({
			type: "envCopy",
			scopeId: perIter.scopeId,
			slotCount: perIter.slotCount,
		});
	}
	if (statement.update) {
		compileExpression(program, fn, updateCursor, statement.update);
	}
	updateCursor.block.emitter.emit({
		type: "jump",
		blocks: [headerIdx],
	});

	const exitIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	// The exit block runs ENV_POP for the normal (test-false) exit and for any break
	// targeting this loop (both jump here). A break/continue crossing this loop to an
	// outer target instead pops via emitBreak/emitContinue.
	if (perIter) {
		fn.blocks[exitIdx]!.emitter.emit({ type: "envPop" });
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	statement: ESTree.ForOfStatement,
) {
	const entryCursor: CoreFrontendCursor = { block };
	const perIter = setupPerIterationScope(program, fn, statement);
	const lexicalHead =
		statement.left.type === "VariableDeclaration" && statement.left.kind !== "var";
	if (perIter && lexicalHead) {
		entryCursor.block.emitter.emit({
			type: "envPush",
			scopeId: perIter.scopeId,
			slotCount: perIter.slotCount,
		});
	}
	if (lexicalHead) {
		const scope = fn.semanticFile.nodeToScope.get(statement);
		if (scope) {
			// ForIn/OfHeadEvaluation evaluates the RHS with every ForDeclaration
			// bound name present but uninitialized, including destructuring names.
			emitTdzHoleInits(program, fn, entryCursor.block, scope.bindings);
		}
	}
	const iterable = compileExpression(program, fn, entryCursor, statement.right);
	if (iterable === -1) {
		return;
	}
	resetEvalCompletion(fn, entryCursor.block);

	if (statement.await) {
		compileForAwaitOfLoop(
			program,
			fn,
			entryCursor,
			iterable,
			statement.left,
			statement.body,
			perIter,
			lexicalHead && perIter !== null,
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
			lexicalHead && perIter !== null,
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	statement: ESTree.ForInStatement,
) {
	const entryCursor: CoreFrontendCursor = { block };
	const perIter = setupPerIterationScope(program, fn, statement);
	const lexicalHead =
		statement.left.type === "VariableDeclaration" && statement.left.kind !== "var";
	if (perIter && lexicalHead) {
		entryCursor.block.emitter.emit({
			type: "envPush",
			scopeId: perIter.scopeId,
			slotCount: perIter.slotCount,
		});
	}
	if (lexicalHead) {
		const scope = fn.semanticFile.nodeToScope.get(statement);
		if (scope) {
			emitTdzHoleInits(program, fn, entryCursor.block, scope.bindings);
		}
	}
	const source = compileExpression(program, fn, entryCursor, statement.right);
	if (source === -1) {
		return;
	}

	const keys = nextCoreVariable(fn);
	entryCursor.block.emitter.emit({
		type: "forInKeys",
		registers: [keys, source],
	});
	resetEvalCompletion(fn, entryCursor.block);

	compileForInOfLoop(
		program,
		fn,
		entryCursor,
		keys,
		statement.left,
		statement.body,
		perIter,
		lexicalHead && perIter !== null,
	);
}

function compileForInOfIteration(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	bindBlock: CoreFrontendBlock,
	left: ESTree.ForOfStatement["left"],
	valueRegister: number,
	body: ESTree.Statement,
): CoreFrontendBlock {
	const resourceDeclaration =
		left.type === "VariableDeclaration" &&
		(left.kind === "using" || left.kind === "await using");
	if (resourceDeclaration) {
		const { entryIdx, tail } = compileDisposableRegion(
			program,
			fn,
			left.kind === "await using",
			(entry) =>
				compileForInOfBindingAndBody(program, fn, entry, left, valueRegister, body, true),
		);
		bindBlock.emitter.emit({ type: "jump", blocks: [entryIdx] });
		return tail;
	}

	return compileForInOfBindingAndBody(
		program,
		fn,
		bindBlock,
		left,
		valueRegister,
		body,
		false,
	);
}

function compileForInOfBindingAndBody(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	bindBlock: CoreFrontendBlock,
	left: ESTree.ForOfStatement["left"],
	valueRegister: number,
	body: ESTree.Statement,
	resourceDeclaration: boolean,
): CoreFrontendBlock {
	const bindCursor: CoreFrontendCursor = { block: bindBlock };
	const boundValue = resourceDeclaration
		? compileAddDisposableResource(
				fn,
				bindCursor,
				valueRegister,
				left.type === "VariableDeclaration" && left.kind === "await using",
			)
		: valueRegister;
	if (left.type === "VariableDeclaration") {
		const declaration = left.declarations[0];
		if (declaration) {
			compilePatternTarget(program, fn, bindCursor, declaration.id, boundValue);
		}
	} else {
		compilePatternTarget(program, fn, bindCursor, left, boundValue, true);
	}

	const bodyIdx = compileStatementsToBlock(program, fn, [body]);
	bindCursor.block.emitter.emit({ type: "jump", blocks: [bodyIdx] });
	return fn.blocks.at(-1)!;
}

/**
 * The shared body of for-of and for-in: drive an iterable through the iterator
 * protocol, binding each value to the loop target and running the body inside a
 * protected range that closes the iterator on a throw.
 */
function compileForInOfLoop(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	entryCursor: CoreFrontendCursor,
	iterable: number,
	left: ESTree.ForOfStatement["left"],
	body: ESTree.Statement,
	perIter: { scopeId: number; slotCount: number } | null,
	perIterEnvEntered: boolean,
) {
	const labels = takePendingLabels(fn);
	const iteratorRegister = nextCoreVariable(fn);
	const nextRegister = nextCoreVariable(fn);
	entryCursor.block.emitter.emit({
		type: "getIterator",
		registers: [iteratorRegister, nextRegister, iterable],
	});
	if (perIter && !perIterEnvEntered) {
		entryCursor.block.emitter.emit({
			type: "envPush",
			scopeId: perIter.scopeId,
			slotCount: perIter.slotCount,
		});
	}

	const headerIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	entryCursor.block.emitter.emit({
		type: "jump",
		blocks: [headerIdx],
	});

	const loop: SemanticControlContext = {
		kind: "loop",
		breakJumps: [],
		continueJumps: [],
		iteratorRegister,
		iteratorCloseNormal: true,
		labels,
		perIterationScopeId: perIter?.scopeId,
		perIterationSlotCount: perIter?.slotCount,
	};
	(fn.loops ??= []).push(loop);

	const header = fn.blocks[headerIdx]!;
	const valueRegister = nextCoreVariable(fn);
	const doneRegister = nextCoreVariable(fn);
	loop.iteratorDoneRegister = doneRegister;
	header.emitter.emit({
		type: "iteratorStep",
		registers: [valueRegister, doneRegister, iteratorRegister, nextRegister],
	});
	const exitJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [doneRegister],
		// Patched below, once the exit block exists.
		blocks: [-1],
	};
	header.emitter.emit(exitJump);

	// Binding and body run inside a protected range; a throw closes the
	// iterator and propagates. The step itself stays unprotected, as specced.
	const bindBlock: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const bindIdx = fn.blocks.push(bindBlock) - 1;
	header.emitter.emit({
		type: "jump",
		blocks: [bindIdx],
	});

	// A fresh per-iteration env; continue re-enters via the header, so this re-runs
	// each iteration. The head pattern and body TDZ initialization overwrite copied
	// values before user code can observe them.
	if (perIter) {
		bindBlock.emitter.emit({
			type: "envCopy",
			scopeId: perIter.scopeId,
			slotCount: perIter.slotCount,
		});
	}

	const tryBegin: Extract<CompilerInstruction, { type: "tryBegin" }> = {
		type: "tryBegin",
		// Patched below: [handler, end].
		blocks: [-1, -1],
	};
	bindBlock.emitter.emit(tryBegin);

	// The protected range ends before the back edge.
	const bodyLastBlock = compileForInOfIteration(
		program,
		fn,
		bindBlock,
		left,
		valueRegister,
		body,
	);
	const back: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const backIdx = fn.blocks.push(back) - 1;
	back.emitter.emit({ type: "tryEnd" }, { type: "jump", blocks: [headerIdx] });
	bodyLastBlock.emitter.emit({
		type: "jump",
		blocks: [backIdx],
	});
	tryBegin.blocks[1] = backIdx;

	// Handler: close the iterator, rethrow the original completion.
	const handlerBlock: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	tryBegin.blocks[0] = fn.blocks.push(handlerBlock) - 1;
	const caughtRegister = nextCoreVariable(fn);
	handlerBlock.emitter.emit({
		type: "catch",
		registers: [caughtRegister],
	});
	const rethrowBlock = emitIteratorCloseForCompletion(
		program,
		fn,
		handlerBlock,
		iteratorRegister,
		false,
		doneRegister,
	);
	rethrowBlock.emitter.emit({
		type: "throw",
		registers: [caughtRegister],
	});

	const exitIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	// Restore the enclosing env on the normal (done) exit and on any break targeting
	// this loop (both jump here). The throw handler above does not pop: a rethrow
	// unwinds the frame (or is caught in an outer scope, where the per-iteration
	// env's parent chain still resolves correctly).
	if (perIter) {
		fn.blocks[exitIdx]!.emitter.emit({ type: "envPop" });
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	entryCursor: CoreFrontendCursor,
	iterable: number,
	left: ESTree.ForOfStatement["left"],
	body: ESTree.Statement,
	perIter: { scopeId: number; slotCount: number } | null,
	perIterEnvEntered: boolean,
) {
	const labels = takePendingLabels(fn);
	const iteratorRegister = nextCoreVariable(fn);
	const nextRegister = nextCoreVariable(fn);
	const doneRegister = nextCoreVariable(fn);
	entryCursor.block.emitter.emit({
		type: "getAsyncIterator",
		registers: [iteratorRegister, nextRegister, iterable],
	});
	entryCursor.block.emitter.emit({
		type: "createBoolean",
		registers: [doneRegister],
		value: false,
	});
	if (perIter && !perIterEnvEntered) {
		entryCursor.block.emitter.emit({
			type: "envPush",
			scopeId: perIter.scopeId,
			slotCount: perIter.slotCount,
		});
	}

	const headerIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	entryCursor.block.emitter.emit({ type: "jump", blocks: [headerIdx] });

	const loop: SemanticControlContext = {
		kind: "loop",
		breakJumps: [],
		continueJumps: [],
		iteratorRegister,
		iteratorDoneRegister: doneRegister,
		iteratorCloseNormal: true,
		iteratorCloseAsync: true,
		labels,
		perIterationScopeId: perIter?.scopeId,
		perIterationSlotCount: perIter?.slotCount,
	};
	(fn.loops ??= []).push(loop);

	// Header: raw = next.call(iterator); result = await raw; unpack done/value.
	// The await splits the header — emitResumeDispatch moves the cursor onto a
	// continuation block, where the unpack and exit test live.
	const headerCursor: CoreFrontendCursor = { block: fn.blocks[headerIdx]! };
	const rawRegister = nextCoreVariable(fn);
	headerCursor.block.emitter.emit({
		type: "iteratorNext",
		registers: [rawRegister, iteratorRegister, nextRegister],
	});
	const resultRegister = compileAwaitRegister(program, fn, headerCursor, rawRegister);

	const doneKey = nextCoreVariable(fn);
	headerCursor.block.emitter.emit({
		type: "createString",
		registers: [doneKey],
		stringIndex: getOrCreateStringConstant(program, "done"),
	});
	headerCursor.block.emitter.emit({
		type: "loadProperty",
		registers: [doneRegister, resultRegister, doneKey],
	});
	const exitJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [doneRegister],
		blocks: [-1],
	};
	headerCursor.block.emitter.emit(exitJump);

	const valueRegister = nextCoreVariable(fn);
	const valueKey = nextCoreVariable(fn);
	headerCursor.block.emitter.emit({
		type: "createString",
		registers: [valueKey],
		stringIndex: getOrCreateStringConstant(program, "value"),
	});
	headerCursor.block.emitter.emit({
		type: "loadProperty",
		registers: [valueRegister, resultRegister, valueKey],
	});

	// Binding and body run inside a protected range; a throw closes the iterator.
	const bindBlock: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const bindIdx = fn.blocks.push(bindBlock) - 1;
	headerCursor.block.emitter.emit({ type: "jump", blocks: [bindIdx] });

	if (perIter) {
		bindBlock.emitter.emit({
			type: "envCopy",
			scopeId: perIter.scopeId,
			slotCount: perIter.slotCount,
		});
	}

	const tryBegin: Extract<CompilerInstruction, { type: "tryBegin" }> = {
		type: "tryBegin",
		blocks: [-1, -1],
	};
	bindBlock.emitter.emit(tryBegin);

	const bodyLastBlock = compileForInOfIteration(
		program,
		fn,
		bindBlock,
		left,
		valueRegister,
		body,
	);
	const back: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const backIdx = fn.blocks.push(back) - 1;
	back.emitter.emit({ type: "tryEnd" }, { type: "jump", blocks: [headerIdx] });
	bodyLastBlock.emitter.emit({ type: "jump", blocks: [backIdx] });
	tryBegin.blocks[1] = backIdx;

	// Handler: await the close, but preserve the original throw over every close
	// failure as required by AsyncIteratorClose.
	const handlerBlock: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	tryBegin.blocks[0] = fn.blocks.push(handlerBlock) - 1;
	const caughtRegister = nextCoreVariable(fn);
	handlerBlock.emitter.emit({ type: "catch", registers: [caughtRegister] });
	const rethrowBlock = emitIteratorCloseForCompletion(
		program,
		fn,
		handlerBlock,
		iteratorRegister,
		false,
		doneRegister,
		true,
	);
	rethrowBlock.emitter.emit({ type: "throw", registers: [caughtRegister] });

	const exitIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	if (perIter) {
		fn.blocks[exitIdx]!.emitter.emit({ type: "envPop" });
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
function takePendingLabels(fn: CoreFrontendFunction): Set<string> | undefined {
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
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
		block.emitter.emit({ type: "jump", blocks: [entry] });
		return;
	}

	// Labeled non-loop statement: a break-only target.
	const labelContext: SemanticControlContext = {
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
	block.emitter.emit({ type: "jump", blocks: [bodyEntry] });
	const bodyTail = fn.blocks.at(-1)!;
	fn.loops.pop();

	const joinIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	bodyTail.emitter.emit({ type: "jump", blocks: [joinIdx] });
	for (const jump of labelContext.breakJumps) {
		jump.blocks[0] = joinIdx;
	}
}

function compileBreakStatement(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
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
	emitBreak(program, fn, block, label);
}

function compileContinueStatement(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
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

	emitContinue(program, fn, block, label);
}

/**
 * Compile a throw statement. The unwinding to the nearest handler happens in
 * the VM based on the statically known handler ranges.
 */
function compileThrowStatement(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	statement: ESTree.ThrowStatement,
) {
	const cursor: CoreFrontendCursor = { block };
	const value = compileExpression(program, fn, cursor, statement.argument);
	cursor.block.emitter.emit({
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	statement: ESTree.TryStatement,
) {
	const tryBegin: Extract<CompilerInstruction, { type: "tryBegin" }> = {
		type: "tryBegin",
		// Patched below, once the handler and exit blocks exist.
		blocks: [-1, -1],
	};
	block.emitter.emit(tryBegin);

	const tryBlock = compileStatementsToBlock(program, fn, [statement.block]);
	block.emitter.emit({
		type: "jump",
		blocks: [tryBlock],
	});

	// The end marker lives directly after the try body, so the protected range
	// ends before the handler.
	const tryBodyLastBlock = fn.blocks.at(-1)!;
	const tryExit: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const tryExitIdx = fn.blocks.push(tryExit) - 1;
	tryExit.emitter.emit({ type: "tryEnd" });
	tryBegin.blocks[1] = tryExitIdx;
	tryBodyLastBlock.emitter.emit({
		type: "jump",
		blocks: [tryExitIdx],
	});

	// The handler block must start with the catch instruction, which consumes
	// the throw completion the unwinder left in place.
	const handlerBlock: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	tryBegin.blocks[0] = fn.blocks.push(handlerBlock) - 1;

	const caughtRegister = nextCoreVariable(fn);
	handlerBlock.emitter.emit({
		type: "catch",
		registers: [caughtRegister],
	});

	if (statement.handler) {
		// Catch parameter destructuring can branch; throws inside it happen
		// past the protected range and so propagate outward, as specced.
		const handlerCursor: CoreFrontendCursor = { block: handlerBlock };
		if (statement.handler.param) {
			compilePatternTarget(
				program,
				fn,
				handlerCursor,
				statement.handler.param,
				caughtRegister,
			);
		}

		const catchBlock = compileStatementsToBlock(program, fn, [statement.handler.body]);
		handlerCursor.block.emitter.emit({
			type: "jump",
			blocks: [catchBlock],
		});
	} else {
		// try with neither catch nor finally is invalid; rethrow to be safe.
		handlerBlock.emitter.emit({
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	statement: ESTree.TryStatement,
) {
	const kindReg = nextCoreVariable(fn);
	const valueReg = nextCoreVariable(fn);
	const finallyCtx: SemanticControlContext = {
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
	const routeNormal = (target: CoreFrontendBlock) =>
		routeThroughFinalizer(target, finallyCtx, "normal", null);
	// Route a thrown completion in: the epilogue re-throws the stashed value.
	const routeThrow = (target: CoreFrontendBlock, value: number) =>
		routeThroughFinalizer(
			target,
			finallyCtx,
			"throw",
			(b) => b.emitter.emit({ type: "throw", registers: [valueReg] }),
			value,
		);

	// --- protected try body ---
	const tryBegin: Extract<CompilerInstruction, { type: "tryBegin" }> = {
		type: "tryBegin",
		blocks: [-1, -1],
	};
	block.emitter.emit(tryBegin);

	fn.loops ??= [];
	fn.loops.push(finallyCtx);
	const tryBlock = compileStatementsToBlock(program, fn, [statement.block]);
	block.emitter.emit({ type: "jump", blocks: [tryBlock] });
	const tryBodyLastBlock = fn.blocks.at(-1)!;
	fn.loops.pop();

	// Normal completion of the try body ends the protected range and enters the
	// finalizer with a NORMAL completion.
	const tryNormalExit: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const tryNormalExitIdx = fn.blocks.push(tryNormalExit) - 1;
	tryNormalExit.emitter.emit({ type: "tryEnd" });
	tryBegin.blocks[1] = tryNormalExitIdx;
	tryBodyLastBlock.emitter.emit({ type: "jump", blocks: [tryNormalExitIdx] });
	routeNormal(tryNormalExit);

	// --- handler for the try body ---
	const handlerBlock: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	tryBegin.blocks[0] = fn.blocks.push(handlerBlock) - 1;
	const caughtRegister = nextCoreVariable(fn);
	handlerBlock.emitter.emit({ type: "catch", registers: [caughtRegister] });

	if (statement.handler) {
		// Bind the catch parameter, then run the catch body in its own protected
		// range so a throw out of it still runs the finalizer.
		const handlerCursor: CoreFrontendCursor = { block: handlerBlock };
		if (statement.handler.param) {
			compilePatternTarget(
				program,
				fn,
				handlerCursor,
				statement.handler.param,
				caughtRegister,
			);
		}

		const catchTryBegin: Extract<CompilerInstruction, { type: "tryBegin" }> = {
			type: "tryBegin",
			blocks: [-1, -1],
		};
		handlerCursor.block.emitter.emit(catchTryBegin);

		fn.loops.push(finallyCtx);
		const catchBlock = compileStatementsToBlock(program, fn, [statement.handler.body]);
		handlerCursor.block.emitter.emit({ type: "jump", blocks: [catchBlock] });
		const catchBodyLastBlock = fn.blocks.at(-1)!;
		fn.loops.pop();

		const catchNormalExit: CoreFrontendBlock = { emitter: unboundCoreEmitter };
		const catchNormalExitIdx = fn.blocks.push(catchNormalExit) - 1;
		catchNormalExit.emitter.emit({ type: "tryEnd" });
		catchTryBegin.blocks[1] = catchNormalExitIdx;
		catchBodyLastBlock.emitter.emit({ type: "jump", blocks: [catchNormalExitIdx] });
		routeNormal(catchNormalExit);

		const catchHandler: CoreFrontendBlock = { emitter: unboundCoreEmitter };
		catchTryBegin.blocks[0] = fn.blocks.push(catchHandler) - 1;
		const caught2 = nextCoreVariable(fn);
		catchHandler.emitter.emit({ type: "catch", registers: [caught2] });
		routeThrow(catchHandler, caught2);
	} else {
		// No catch clause: an exception in the body runs the finalizer then
		// re-propagates.
		routeThrow(handlerBlock, caughtRegister);
	}

	// --- finalizer body, compiled once with the finally context popped so its
	// own abrupt completions route to *enclosing* finalizers and override the
	// pending one. ---
	const finalizerEntryIdx = compileStatementsToBlock(program, fn, [statement.finalizer!]);
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
		const armBlock: CoreFrontendBlock = { emitter: unboundCoreEmitter };
		const idx = fn.blocks.push(armBlock) - 1;
		fill(armBlock);
		dispatchBlocks.push({ kind, idx });
	}

	const epilogue: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const epilogueIdx = fn.blocks.push(epilogue) - 1;
	finalizerLastBlock.emitter.emit({ type: "jump", blocks: [epilogueIdx] });

	for (const { kind, idx } of dispatchBlocks) {
		const constReg = nextCoreVariable(fn);
		const matchReg = nextCoreVariable(fn);
		epilogue.emitter.emit({
			type: "createNumber",
			registers: [constReg],
			value: kind,
		});
		epilogue.emitter.emit({
			type: "binary",
			registers: [matchReg, kindReg, constReg],
			operator: "===",
		});
		epilogue.emitter.emit({ type: "jumpIf", registers: [matchReg], blocks: [idx] });
	}
	// Fall through: NORMAL completion continues after the try.
}

/**
 * A bare block statement `{ ... }`: compile its body inline (block-scoped
 * declarations are resolved by sema). Without this, block bodies were silently
 * skipped, since the statement switch had no BlockStatement case.
 */
function compileBlockStatement(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	statement: ESTree.BlockStatement,
) {
	// Block-scoped let/const/class start uninitialized (TDZ) at block entry.
	const scope = fn.semanticFile.nodeToScope.get(statement);
	if (scope) {
		emitTdzHoleInits(program, fn, block, scope.bindings);
	}
	const bodyEntry = compileStatementsToBlock(program, fn, statement.body);
	block.emitter.emit({ type: "jump", blocks: [bodyEntry] });
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	statement: ESTree.WithStatement,
) {
	const cursor: CoreFrontendCursor = { block };
	const object = compileExpression(program, fn, cursor, statement.object);
	cursor.block.emitter.emit({ type: "withEnter", registers: [object] });
	resetEvalCompletion(fn, cursor.block);

	const withContext: SemanticControlContext = {
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

	cursor.block.emitter.emit({ type: "jump", blocks: [bodyEntry] });

	// Normal completion of the body pops the with-object, then falls through to
	// a fresh exit block (the back edge / continuation the dispatch loop resumes
	// from). Abrupt exits (break/continue/return) emit their own withExit.
	const bodyTail = fn.blocks.at(-1)!;
	bodyTail.emitter.emit({ type: "withExit", registers: [] });
	const exitIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	bodyTail.emitter.emit({ type: "jump", blocks: [exitIdx] });
}

/**
 * Compile an if statement, reading the condition and jumping to the consequent or alternate
 * block.
 */
function compileIfStatement(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	statement: ESTree.IfStatement,
) {
	const cursor: CoreFrontendCursor = { block };
	const condition = compileExpression(program, fn, cursor, statement.test);
	resetEvalCompletion(fn, cursor.block);
	const consequentBlock = compileStatementsToBlock(
		program,
		fn,
		normalizeStatementOrBlock(statement.consequent),
	);
	cursor.block.emitter.emit({
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
	cursor.block.emitter.emit({
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

/** Throw unless value is an ECMAScript Object, returning the success block. */
function emitIteratorResultObjectCheck(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	value: number,
): CoreFrontendBlock {
	const valid: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const validIdx = fn.blocks.push(valid) - 1;
	const invalid: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const invalidIdx = fn.blocks.push(invalid) - 1;
	const typeName = nextCoreVariable(fn);
	const isFunction = nextCoreVariable(fn);
	const isObject = nextCoreVariable(fn);
	const notObject = nextCoreVariable(fn);
	const nullValue = nextCoreVariable(fn);
	const isNull = nextCoreVariable(fn);
	const functionName = nextCoreVariable(fn);
	const objectName = nextCoreVariable(fn);

	block.emitter.emit(
		{ type: "unary", registers: [typeName, value], operator: "typeof" },
		{
			type: "createString",
			registers: [functionName],
			stringIndex: getOrCreateStringConstant(program, "function"),
		},
		{ type: "binary", registers: [isFunction, typeName, functionName], operator: "===" },
		{ type: "jumpIf", registers: [isFunction], blocks: [validIdx] },
		{
			type: "createString",
			registers: [objectName],
			stringIndex: getOrCreateStringConstant(program, "object"),
		},
		{ type: "binary", registers: [isObject, typeName, objectName], operator: "===" },
		{ type: "unary", registers: [notObject, isObject], operator: "!" },
		{ type: "jumpIf", registers: [notObject], blocks: [invalidIdx] },
		{ type: "createNull", registers: [nullValue] },
		{ type: "binary", registers: [isNull, value, nullValue], operator: "===" },
		{ type: "jumpIf", registers: [isNull], blocks: [invalidIdx] },
		{ type: "jump", blocks: [validIdx] },
	);

	const typeError = nextCoreVariable(fn);
	const error = nextCoreVariable(fn);
	const message = nextCoreVariable(fn);
	invalid.emitter.emit(
		{ type: "loadIntrinsic", registers: [typeError], intrinsic: "TypeError" },
		{
			type: "createString",
			registers: [message],
			stringIndex: getOrCreateStringConstant(
				program,
				"Iterator return result is not an object",
			),
		},
		{ type: "construct", registers: [error, typeError, message] },
		{ type: "throw", registers: [error] },
	);
	return valid;
}

/**
 * AsyncIteratorClose: call return(), await its result, and apply the supplied
 * completion precedence. A throw completion still waits for cleanup but wins
 * over getter/call/await failures; a normal completion propagates those failures
 * and rejects a fulfilled primitive.
 */
function emitAsyncIteratorClose(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	iteratorRegister: number,
	normal: boolean,
): CoreFrontendBlock {
	const tryBegin: Extract<CompilerInstruction, { type: "tryBegin" }> | undefined = normal
		? undefined
		: { type: "tryBegin", blocks: [-1, -1] };
	if (tryBegin) block.emitter.emit(tryBegin);

	const returnKey = nextCoreVariable(fn);
	const returnMethod = nextCoreVariable(fn);
	const undefinedValue = nextCoreVariable(fn);
	const noReturn = nextCoreVariable(fn);
	block.emitter.emit(
		{
			type: "createString",
			registers: [returnKey],
			stringIndex: getOrCreateStringConstant(program, "return"),
		},
		{ type: "loadProperty", registers: [returnMethod, iteratorRegister, returnKey] },
		{ type: "createUndefined", registers: [undefinedValue] },
		{
			type: "binary",
			registers: [noReturn, returnMethod, undefinedValue],
			operator: "==",
		},
	);
	const noReturnJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [noReturn],
		blocks: [-1],
	};
	block.emitter.emit(noReturnJump);

	const result = nextCoreVariable(fn);
	block.emitter.emit({
		type: "call",
		registers: [result, returnMethod, iteratorRegister],
	});

	// A return resumption while this await is in flight must not recursively
	// close the same iterator. Outer iterator/finally cleanup remains visible.
	const closingScopeIndex = fn.loops?.findLastIndex(
		(scope) => scope.iteratorRegister === iteratorRegister,
	);
	const closingScope =
		closingScopeIndex === undefined || closingScopeIndex < 0
			? undefined
			: fn.loops!.splice(closingScopeIndex, 1)[0];
	const closeCursor: CoreFrontendCursor = { block };
	const awaited = compileAwaitRegister(program, fn, closeCursor, result);
	if (closingScope && closingScopeIndex !== undefined) {
		fn.loops!.splice(closingScopeIndex, 0, closingScope);
	}

	if (normal) {
		closeCursor.block = emitIteratorResultObjectCheck(
			program,
			fn,
			closeCursor.block,
			awaited,
		);
		const continuation: CoreFrontendBlock = { emitter: unboundCoreEmitter };
		const continuationIdx = fn.blocks.push(continuation) - 1;
		noReturnJump.blocks[0] = continuationIdx;
		closeCursor.block.emitter.emit({ type: "jump", blocks: [continuationIdx] });
		return continuation;
	}

	const tryExit: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const tryExitIdx = fn.blocks.push(tryExit) - 1;
	tryExit.emitter.emit({ type: "tryEnd" });
	tryBegin!.blocks[1] = tryExitIdx;
	noReturnJump.blocks[0] = tryExitIdx;
	closeCursor.block.emitter.emit({ type: "jump", blocks: [tryExitIdx] });

	const handler: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	tryBegin!.blocks[0] = fn.blocks.push(handler) - 1;
	const ignored = nextCoreVariable(fn);
	handler.emitter.emit({ type: "catch", registers: [ignored] });

	const continuation: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const continuationIdx = fn.blocks.push(continuation) - 1;
	tryExit.emitter.emit({ type: "jump", blocks: [continuationIdx] });
	handler.emitter.emit({ type: "jump", blocks: [continuationIdx] });
	return continuation;
}

/**
 * Close one iterator for the supplied completion kind. A tracked [[Done]] flag
 * skips exhausted iterators and is set before return() so a close failure cannot
 * cause an enclosing handler to close the same iterator again.
 */
function emitIteratorCloseForCompletion(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	iteratorRegister: number,
	normal: boolean,
	doneRegister?: number,
	async = false,
): CoreFrontendBlock {
	const emitClose = (target: CoreFrontendBlock) => {
		if (async) {
			return emitAsyncIteratorClose(program, fn, target, iteratorRegister, normal);
		}
		target.emitter.emit({
			type: "iteratorClose",
			registers: [iteratorRegister],
			normal,
		});
		return target;
	};

	if (doneRegister === undefined) {
		return emitClose(block);
	}

	const skipJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [doneRegister],
		blocks: [-1],
	};
	block.emitter.emit(skipJump);

	const closeBlock: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const closeIdx = fn.blocks.push(closeBlock) - 1;
	block.emitter.emit({ type: "jump", blocks: [closeIdx] });
	closeBlock.emitter.emit({
		type: "createBoolean",
		registers: [doneRegister],
		value: true,
	});
	const closeEnd = emitClose(closeBlock);

	const continuation: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const continuationIdx = fn.blocks.push(continuation) - 1;
	skipJump.blocks[0] = continuationIdx;
	closeEnd.emitter.emit({ type: "jump", blocks: [continuationIdx] });
	return continuation;
}

/**
 * Set a finalizer's pending completion and jump into it. Each distinct routing
 * `key` (e.g. "return", "break", "continue:outer") gets a unique kind code and
 * an epilogue arm carrying its re-dispatch; NORMAL (key "normal") needs no arm
 * and falls through. Kind codes are local to one finalizer's kind register.
 */
function routeThroughFinalizer(
	block: CoreFrontendBlock,
	scope: SemanticControlContext,
	key: string,
	fill: ((block: CoreFrontendBlock) => void) | null,
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

	block.emitter.emit({
		type: "createNumber",
		registers: [scope.completionKindReg!],
		value: kind,
	});
	if (valueRegister !== undefined) {
		block.emitter.emit({
			type: "move",
			registers: [scope.completionValueReg!, valueRegister],
		});
	} else if (scope.disposeCapabilityLocation !== undefined) {
		block.emitter.emit({
			type: "createUndefined",
			registers: [scope.completionValueReg!],
		});
	}
	const jump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	block.emitter.emit(jump);
	scope.finallyEntryJumps!.push(jump);
}

/**
 * Emit a return, routing it through any enclosing finalizers and closing
 * for-of iterators on the way out, innermost first. The innermost finalizer
 * takes over the return: its epilogue resumes the walk from its own position
 * once the finally body has run.
 */
function emitReturn(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	valueRegister: number,
) {
	const scopes = fn.loops ?? [];
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i]!;

		if (scope.kind === "finally") {
			routeThroughFinalizer(
				block,
				scope,
				"return",
				(b) => emitReturn(program, fn, b, scope.completionValueReg!),
				valueRegister,
			);
			return;
		}

		if (scope.kind === "with") {
			block.emitter.emit({ type: "withExit", registers: [] });
		}

		if (scope.iteratorRegister !== undefined) {
			block = emitIteratorCloseForCompletion(
				program,
				fn,
				block,
				scope.iteratorRegister,
				scope.iteratorCloseNormal === true,
				scope.iteratorDoneRegister,
				scope.iteratorCloseAsync === true,
			);
		}
	}
	if (
		fn.classContext?.isConstructor &&
		fn.classContext.isDerivedConstructor &&
		fn.classContext.superThisStateBinding
	) {
		const currentThis = loadSharedSuperThis(program, fn, { block }, false);
		block.emitter.emit({ type: "setThis", registers: [currentThis] });
	}

	block.emitter.emit({
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
function emitBreak(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	label?: string,
) {
	const scopes = fn.loops ?? [];
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i]!;

		if (scope.kind === "finally") {
			routeThroughFinalizer(
				block,
				scope,
				label === undefined ? "break" : `break:${label}`,
				(b) => emitBreak(program, fn, b, label),
			);
			return;
		}

		// Leaving a with body pops its object.
		if (scope.kind === "with") {
			block.emitter.emit({ type: "withExit", registers: [] });
		}

		// Leaving this loop closes its for-of iterator.
		if (scope.iteratorRegister !== undefined) {
			block = emitIteratorCloseForCompletion(
				program,
				fn,
				block,
				scope.iteratorRegister,
				scope.iteratorCloseNormal === true,
				scope.iteratorDoneRegister,
				scope.iteratorCloseAsync === true,
			);
		}

		const isTarget =
			label === undefined
				? scope.kind === "loop" || scope.kind === "switch"
				: scope.labels?.has(label) === true;

		// Restore the enclosing env when crossing a per-iteration loop to an outer
		// target; the target loop's own exit block pops for a direct break.
		if (scope.perIterationScopeId !== undefined && !isTarget) {
			block.emitter.emit({ type: "envPop" });
		}

		if (isTarget) {
			const jump: Extract<CompilerInstruction, { type: "jump" }> = {
				type: "jump",
				blocks: [-1],
			};
			block.emitter.emit(jump);
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
function emitContinue(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	label?: string,
) {
	const scopes = fn.loops ?? [];
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i]!;

		if (scope.kind === "finally") {
			routeThroughFinalizer(
				block,
				scope,
				label === undefined ? "continue" : `continue:${label}`,
				(b) => emitContinue(program, fn, b, label),
			);
			return;
		}

		// Continuing out of a with body pops its object (a with is never a
		// continue target).
		if (scope.kind === "with") {
			block.emitter.emit({ type: "withExit", registers: [] });
			continue;
		}
		if (scope.kind === "iterator") {
			block = emitIteratorCloseForCompletion(
				program,
				fn,
				block,
				scope.iteratorRegister!,
				scope.iteratorCloseNormal === true,
				scope.iteratorDoneRegister,
				scope.iteratorCloseAsync === true,
			);
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
				block = emitIteratorCloseForCompletion(
					program,
					fn,
					block,
					scope.iteratorRegister,
					scope.iteratorCloseNormal === true,
					scope.iteratorDoneRegister,
					scope.iteratorCloseAsync === true,
				);
			}
			if (scope.perIterationScopeId !== undefined) {
				block.emitter.emit({ type: "envPop" });
			}
			continue;
		}

		const jump: Extract<CompilerInstruction, { type: "jump" }> = {
			type: "jump",
			blocks: [-1],
		};
		block.emitter.emit(jump);
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
	return (
		traverseEstree(node, (current) =>
			TAIL_CALL_BLOCKERS.has(current.type) ? ESTREE_STOP : undefined,
		) === ESTREE_STOP
	);
}

/**
 * Decide whether the function admits self-recursive tail-call elimination, and
 * record the loop header. Called after parameter compilation (so
 * argumentsObjectRegister is known) and immediately before the body is
 * compiled, so the body block this records matches the one compileStatementsToBlock
 * is about to push, and compileReturnStatement can see the eligibility.
 */
function prepareTailCallLoop(
	fn: CoreFrontendFunction,
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
		(fn.staticArgumentsRegisters?.size ?? 0) === 0 &&
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
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

	cursor.block.emitter.emit({ type: "jump", blocks: [fn.bodyEntryBlock] });
	return true;
}

/**
 * Naively compile a return statement.
 */
function compileReturnStatement(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	statement: ESTree.ReturnStatement,
) {
	const cursor: CoreFrontendCursor = { block };

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

	emitReturn(program, fn, cursor.block, returnRegister);
}

function compileAddDisposableResource(
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	resource: number,
	asyncHint: boolean,
): number {
	const disposal = fn.loops?.findLast(
		(scope) => scope.disposeCapabilityLocation !== undefined,
	);
	if (disposal?.disposeCapabilityLocation === undefined) {
		throw new Error("resource declaration has no disposal scope");
	}
	const capability = loadRegisterFromLocation(
		fn,
		cursor.block,
		disposal.disposeCapabilityLocation,
	);
	const addResource = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "loadIntrinsic",
		registers: [addResource],
		intrinsic: "__addDisposableResource",
	});
	const thisValue = compileUndefined(fn, cursor);
	const asyncHintRegister = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createBoolean",
		registers: [asyncHintRegister],
		value: asyncHint,
	});
	const added = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "call",
		registers: [added, addResource, thisValue, capability, resource, asyncHintRegister],
	});
	return added;
}

function compileVariableDeclaration(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	statement: ESTree.VariableDeclaration,
) {
	const cursor: CoreFrontendCursor = { block };
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

		// `var` bindings are initialized once by DeclarationInstantiation. A bare
		// declaration has no runtime assignment at its textual position.
		if (statement.kind === "var" && !decl.init) {
			continue;
		}

		let source = compileExpression(
			program,
			fn,
			cursor,

			// Initialize variables to undefined if they don't have an initializer.
			decl.init ?? { type: "Identifier", name: "undefined" },

			// NamedEvaluation: anonymous initializers take the binding name.
			decl.id.type === "Identifier" ? decl.id.name : undefined,
		);
		if (statement.kind === "using" || statement.kind === "await using") {
			source = compileAddDisposableResource(
				fn,
				cursor,
				source,
				statement.kind === "await using",
			);
		}

		if (decl.id.type === "ObjectPattern" || decl.id.type === "ArrayPattern") {
			compilePatternTarget(program, fn, cursor, decl.id, source);
			continue;
		}

		const binding = fn.semanticFile.nodeToBinding.get(decl.id);
		if (!binding) {
			continue;
		}
		if (
			decl.id.type === "Identifier" &&
			isNewDirectEvalVarBinding(program, fn, decl.id) &&
			program.directEvalPersistentScopeBinding
		) {
			const persistent = loadCapturedBinding(
				program,
				fn,
				cursor,
				program.directEvalPersistentScopeBinding,
			);
			storeDirectEvalScopeValue(program, fn, cursor, persistent, binding.name, source);
			continue;
		}

		// A `var x = init` whose `x` is intercepted by an active `with`-object runs
		// its initializer as an assignment (PutValue), so it must set the with-object
		// property when one provides `x` — only the hoisted binding declaration is
		// unconditionally function-scoped, not the initializer store. (`decl.init`
		// only: a bare `var x;` performs no assignment.) The miss branch stores the
		// hoisted local like the normal path below.
		if (
			decl.init &&
			decl.id.type === "Identifier" &&
			identifierUsesDynamicEnvironment(program, fn, decl.id)
		) {
			const nameStringIndex = getOrCreateStringConstant(program, binding.name);
			const base = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "withResolveBase",
				registers: [base],
				nameStringIndex,
			});
			const key = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "createString",
				registers: [key],
				stringIndex: nameStringIndex,
			});
			compileWithBaseStore(program, fn, cursor, base, key, decl.id, source);
			continue;
		}

		const location = getOrCreateBindingLocation(program, fn, binding);
		storeRegisterAtLocation(cursor.block, location, source);
	}
}

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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	expression: ESTree.YieldExpression,
) {
	const operand = compileExpression(program, fn, cursor, expression.argument!);

	// In an async generator, yield* delegates to an ASYNC iterator and awaits
	// each inner next/throw/return result and each yielded value (the spec's
	// Await steps in yield* + AsyncGeneratorYield).
	const isAsync = fn.isAsync === true;

	// Loop-carried registers (kept alive across the back edge by the
	// >1-block freeing guard in the allocator).
	const iterator = nextCoreVariable(fn);
	const nextMethod = nextCoreVariable(fn);
	const sentValue = nextCoreVariable(fn);
	const mode = nextCoreVariable(fn);
	const result = nextCoreVariable(fn);
	const exprResult = nextCoreVariable(fn);

	cursor.block.emitter.emit({
		type: isAsync ? "getAsyncIterator" : "getIterator",
		registers: [iterator, nextMethod, operand],
	});
	cursor.block.emitter.emit({ type: "createUndefined", registers: [sentValue] });
	cursor.block.emitter.emit({ type: "createNumber", registers: [mode], value: 0 });

	const header: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const headerIdx = fn.blocks.push(header) - 1;
	const nextMode: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const nextModeIdx = fn.blocks.push(nextMode) - 1;
	const throwMode: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const throwModeIdx = fn.blocks.push(throwMode) - 1;
	const noThrow: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const noThrowIdx = fn.blocks.push(noThrow) - 1;
	const returnMode: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const returnModeIdx = fn.blocks.push(returnMode) - 1;
	const noReturn: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const noReturnIdx = fn.blocks.push(noReturn) - 1;
	const check: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const checkIdx = fn.blocks.push(check) - 1;
	const doneBlock: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const doneIdx = fn.blocks.push(doneBlock) - 1;
	const doneReturn: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const doneReturnIdx = fn.blocks.push(doneReturn) - 1;
	const continuation: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const continuationIdx = fn.blocks.push(continuation) - 1;

	cursor.block.emitter.emit({ type: "jump", blocks: [headerIdx] });

	const stringRegister = (block: CoreFrontendBlock, value: string) => {
		const reg = nextCoreVariable(fn);
		block.emitter.emit({
			type: "createString",
			registers: [reg],
			stringIndex: getOrCreateStringConstant(program, value),
		});
		return reg;
	};
	const nullishGuard = (block: CoreFrontendBlock, valueReg: number, target: number) => {
		const undef = nextCoreVariable(fn);
		const isNullish = nextCoreVariable(fn);
		block.emitter.emit({ type: "createUndefined", registers: [undef] });
		block.emitter.emit({
			type: "binary",
			registers: [isNullish, valueReg, undef],
			operator: "==",
		});
		block.emitter.emit({ type: "jumpIf", registers: [isNullish], blocks: [target] });
	};
	const modeEquals = (block: CoreFrontendBlock, modeValue: number, target: number) => {
		const constReg = nextCoreVariable(fn);
		const matchReg = nextCoreVariable(fn);
		block.emitter.emit({
			type: "createNumber",
			registers: [constReg],
			value: modeValue,
		});
		block.emitter.emit({
			type: "binary",
			registers: [matchReg, mode, constReg],
			operator: "===",
		});
		block.emitter.emit({ type: "jumpIf", registers: [matchReg], blocks: [target] });
	};
	// After an inner next/throw/return call leaves its result in `result`, await
	// it (async delegation) and continue to the done/value check.
	const stepAndContinue = (block: CoreFrontendBlock) => {
		if (isAsync) {
			const stepCursor: CoreFrontendCursor = { block };
			const awaited = compileAwaitRegister(program, fn, stepCursor, result);
			stepCursor.block.emitter.emit({ type: "move", registers: [result, awaited] });
			stepCursor.block.emitter.emit({ type: "jump", blocks: [checkIdx] });
		} else {
			block.emitter.emit({ type: "jump", blocks: [checkIdx] });
		}
	};

	// header: dispatch on the resume mode.
	modeEquals(header, RESUME_MODE_THROW, throwModeIdx);
	modeEquals(header, RESUME_MODE_RETURN, returnModeIdx);
	header.emitter.emit({ type: "jump", blocks: [nextModeIdx] });

	// next(): advance via the cached next method.
	nextMode.emitter.emit({
		type: "call",
		registers: [result, nextMethod, iterator, sentValue],
	});
	stepAndContinue(nextMode);

	// throw(): forward to the inner throw, or close + TypeError if absent.
	{
		const throwM = nextCoreVariable(fn);
		throwMode.emitter.emit({
			type: "loadProperty",
			registers: [throwM, iterator, stringRegister(throwMode, "throw")],
		});
		nullishGuard(throwMode, throwM, noThrowIdx);
		throwMode.emitter.emit({
			type: "call",
			registers: [result, throwM, iterator, sentValue],
		});
		stepAndContinue(throwMode);
	}
	noThrow.emitter.emit({ type: "iteratorClose", registers: [iterator] });
	{
		const te = nextCoreVariable(fn);
		noThrow.emitter.emit({
			type: "loadIntrinsic",
			registers: [te],
			intrinsic: "TypeError",
		});
		const err = nextCoreVariable(fn);
		noThrow.emitter.emit({
			type: "construct",
			registers: [
				err,
				te,
				stringRegister(noThrow, "The iterator does not provide a 'throw' method"),
			],
		});
		noThrow.emitter.emit({ type: "throw", registers: [err] });
	}

	// return(): forward to the inner return, or return the received value.
	{
		const returnM = nextCoreVariable(fn);
		returnMode.emitter.emit({
			type: "loadProperty",
			registers: [returnM, iterator, stringRegister(returnMode, "return")],
		});
		nullishGuard(returnMode, returnM, noReturnIdx);
		returnMode.emitter.emit({
			type: "call",
			registers: [result, returnM, iterator, sentValue],
		});
		stepAndContinue(returnMode);
	}
	// No inner `return` method: return the received value directly. An async
	// delegation awaits it first (spec: "If generatorKind is async, set value to
	// ? Await(value)"), so a returned promise resolves before it leaves yield*.
	if (isAsync) {
		const noReturnCursor: CoreFrontendCursor = { block: noReturn };
		const awaited = compileAwaitRegister(program, fn, noReturnCursor, sentValue);
		emitReturn(program, fn, noReturnCursor.block, awaited);
	} else {
		emitReturn(program, fn, noReturn, sentValue);
	}

	// check: FIRST validate the (already-awaited, for async) inner result is an
	// Object — the spec's "If Type(innerResult) is not Object, throw a TypeError"
	// step, which runs AFTER the Await so a thenable value is still awaited
	// without inspecting it. A next/throw/return method that returns a primitive
	// (e.g. `next()` returning 42) is a TypeError, not a silently-swallowed
	// `{ done: undefined }`. All three resume modes reach here, so this covers
	// them for both sync and async delegation.
	const checkBody: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const checkBodyIdx = fn.blocks.push(checkBody) - 1;
	const notObject: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const notObjectIdx = fn.blocks.push(notObject) - 1;
	{
		const typeName = nextCoreVariable(fn);
		check.emitter.emit({
			type: "unary",
			registers: [typeName, result],
			operator: "typeof",
		});
		// typeof "function" → a callable object: always valid.
		const isFunc = nextCoreVariable(fn);
		check.emitter.emit({
			type: "binary",
			registers: [isFunc, typeName, stringRegister(check, "function")],
			operator: "===",
		});
		check.emitter.emit({
			type: "jumpIf",
			registers: [isFunc],
			blocks: [checkBodyIdx],
		});
		// Otherwise it must be typeof "object" AND not null (typeof null is
		// "object"); anything else (number/string/boolean/undefined/symbol/bigint)
		// is a non-object result.
		const isObjType = nextCoreVariable(fn);
		check.emitter.emit({
			type: "binary",
			registers: [isObjType, typeName, stringRegister(check, "object")],
			operator: "===",
		});
		const notObjType = nextCoreVariable(fn);
		check.emitter.emit({
			type: "unary",
			registers: [notObjType, isObjType],
			operator: "!",
		});
		check.emitter.emit({
			type: "jumpIf",
			registers: [notObjType],
			blocks: [notObjectIdx],
		});
		nullishGuard(check, result, notObjectIdx);
		check.emitter.emit({ type: "jump", blocks: [checkBodyIdx] });
	}
	{
		const te = nextCoreVariable(fn);
		notObject.emitter.emit({
			type: "loadIntrinsic",
			registers: [te],
			intrinsic: "TypeError",
		});
		const err = nextCoreVariable(fn);
		notObject.emitter.emit({
			type: "construct",
			registers: [err, te, stringRegister(notObject, "Iterator result is not an object")],
		});
		notObject.emitter.emit({ type: "throw", registers: [err] });
	}

	// checkBody: a done result ends the delegation; otherwise yield the value out
	// and loop back to advance the inner iterator on the next resume.
	{
		const doneReg = nextCoreVariable(fn);
		checkBody.emitter.emit({
			type: "loadProperty",
			registers: [doneReg, result, stringRegister(checkBody, "done")],
		});
		checkBody.emitter.emit({
			type: "jumpIf",
			registers: [doneReg],
			blocks: [doneIdx],
		});
		const valueReg = nextCoreVariable(fn);
		checkBody.emitter.emit({
			type: "loadProperty",
			registers: [valueReg, result, stringRegister(checkBody, "value")],
		});
		// The inner yield: suspend the outer generator. On resume the sent value
		// and resume mode drive the next loop iteration (no throw/return dispatch
		// here — the mode is forwarded into the delegation above). The delegated
		// value is NOT awaited: the spec's async delegate path is
		// AsyncGeneratorYield(? IteratorValue(innerResult)) with no Await around
		// it (only a plain `yield x` awaits x). Awaiting here would wrongly unwrap
		// a promise yielded by a hand-written async iterator. For a sync operand
		// the value is already awaited inside the AsyncFromSyncIterator wrapper.
		checkBody.emitter.emit({
			type: "yield",
			registers: [sentValue, mode, valueReg],
		});
		// AsyncGeneratorUnwrapYieldResumption: after AsyncGeneratorYield resumes,
		// a return() resumption awaits its value before the loop dispatches it to
		// the inner iterator's return (or, absent one, re-awaits + returns it). A
		// next()/throw() resumption is used as-is (not awaited). The awaited value
		// replaces `sentValue` so returnMode forwards the unwrapped value.
		if (isAsync) {
			const unwrapAwait: CoreFrontendBlock = { emitter: unboundCoreEmitter };
			const unwrapAwaitIdx = fn.blocks.push(unwrapAwait) - 1;
			modeEquals(checkBody, RESUME_MODE_RETURN, unwrapAwaitIdx);
			checkBody.emitter.emit({ type: "jump", blocks: [headerIdx] });
			const unwrapCursor: CoreFrontendCursor = { block: unwrapAwait };
			const awaited = compileAwaitRegister(program, fn, unwrapCursor, sentValue);
			unwrapCursor.block.emitter.emit({
				type: "move",
				registers: [sentValue, awaited],
			});
			unwrapCursor.block.emitter.emit({ type: "jump", blocks: [headerIdx] });
		} else {
			checkBody.emitter.emit({ type: "jump", blocks: [headerIdx] });
		}
	}

	// doneBlock: extract the final value. A return() resumption that finishes
	// the inner returns from the outer generator; otherwise it is the yield*
	// expression value.
	{
		const doneValue = nextCoreVariable(fn);
		doneBlock.emitter.emit({
			type: "loadProperty",
			registers: [doneValue, result, stringRegister(doneBlock, "value")],
		});
		modeEquals(doneBlock, RESUME_MODE_RETURN, doneReturnIdx);
		doneBlock.emitter.emit({ type: "move", registers: [exprResult, doneValue] });
		doneBlock.emitter.emit({ type: "jump", blocks: [continuationIdx] });
		emitReturn(program, fn, doneReturn, doneValue);
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
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
		yieldedSrc = compileAwaitRegister(program, fn, cursor, yieldedSrc);
	}

	const valueDst = nextCoreVariable(fn);
	const modeDst = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "yield",
		registers: [valueDst, modeDst, yieldedSrc],
	});

	return emitResumeDispatch(
		program,
		fn,
		cursor,
		valueDst,
		modeDst,
		fn.isAsync && fn.isGenerator,
	);
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	valueDst: number,
	modeDst: number,
	// AsyncGeneratorUnwrapYieldResumption: an async generator's `yield` awaits a
	// return() resumption value before unwinding (only yield, not await, and not
	// sync generators). yield* handles its inner yield's resumption separately.
	awaitReturnValue = false,
): number {
	// throw() resumption: throw the sent value at the suspend point.
	const throwBlock: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const throwIdx = fn.blocks.push(throwBlock) - 1;
	throwBlock.emitter.emit({ type: "throw", registers: [valueDst] });

	// return() resumption: return the sent value, through enclosing finalizers.
	const returnBlock: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const returnIdx = fn.blocks.push(returnBlock) - 1;
	if (awaitReturnValue) {
		const returnCursor: CoreFrontendCursor = { block: returnBlock };
		const awaited = compileAwaitRegister(program, fn, returnCursor, valueDst);
		emitReturn(program, fn, returnCursor.block, awaited);
	} else {
		emitReturn(program, fn, returnBlock, valueDst);
	}

	const continuation: CoreFrontendBlock = { emitter: unboundCoreEmitter };
	const continuationIdx = fn.blocks.push(continuation) - 1;

	const throwConst = nextCoreVariable(fn);
	const isThrow = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createNumber",
		registers: [throwConst],
		value: RESUME_MODE_THROW,
	});
	cursor.block.emitter.emit({
		type: "binary",
		registers: [isThrow, modeDst, throwConst],
		operator: "===",
	});
	cursor.block.emitter.emit({
		type: "jumpIf",
		registers: [isThrow],
		blocks: [throwIdx],
	});

	const returnConst = nextCoreVariable(fn);
	const isReturn = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createNumber",
		registers: [returnConst],
		value: RESUME_MODE_RETURN,
	});
	cursor.block.emitter.emit({
		type: "binary",
		registers: [isReturn, modeDst, returnConst],
		operator: "===",
	});
	cursor.block.emitter.emit({
		type: "jumpIf",
		registers: [isReturn],
		blocks: [returnIdx],
	});

	cursor.block.emitter.emit({ type: "jump", blocks: [continuationIdx] });

	// next()/fulfilled resumption continues here with the sent/resolved value.
	cursor.block = continuation;
	return valueDst;
}

function compileAwaitExpression(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	expression: ESTree.AwaitExpression,
): number {
	const awaitedSrc = compileExpression(program, fn, cursor, expression.argument);
	return compileAwaitRegister(program, fn, cursor, awaitedSrc);
}

/** Suspend on the value in awaitedSrc and continue with the settled value. */
function compileAwaitRegister(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	awaitedSrc: number,
): number {
	const valueDst = nextCoreVariable(fn);
	const modeDst = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "await",
		registers: [valueDst, modeDst, awaitedSrc],
	});

	return emitResumeDispatch(program, fn, cursor, valueDst, modeDst);
}

/**
 * Expression compilation dispatch.
 *
 * Expressions return the logical variable identity holding their Core value.
 *
 * nameHint carries the NamedEvaluation name for anonymous function and class
 * expressions: the binding or property name the value is assigned to.
 */
function compileExpression(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
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
		case "ImportExpression": {
			return compileImportExpression(
				program,
				fn,
				cursor,
				expression.source,
				expression.options,
			);
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
			if (fn.classContext?.superThisStateBinding) {
				return loadSharedSuperThis(program, fn, cursor, true);
			}
			// An arrow inherits `this` lexically: semantic analysis bound this node to
			// an implicit `this` binding on the enclosing non-arrow function, captured
			// through the closure env. Read it like any captured binding. (Unbound
			// `this` — directly in a non-arrow function, or top-level — falls through.)
			const thisBinding = fn.semanticFile.nodeToBinding.get(expression);
			if (thisBinding?.implicit === "this") {
				const location = getOrCreateBindingLocation(program, fn, thisBinding);
				return loadRegisterFromLocation(fn, cursor.block, location);
			}
			const destination = nextCoreVariable(fn);
			// Top-level `this` in a global *script* is globalThis in BOTH strict
			// and sloppy mode (ScriptEvaluation binds globalThis regardless of
			// strictness); only a module's top-level `this` is undefined. A DIRECT
			// eval instead inherits the caller's `this` (threaded onto the eval
			// entry frame), so its top-level `this` is a plain loadThis.
			let scope = fn.semanticFile.nodeToScope.get(expression);
			while (
				scope &&
				scope.node.type !== "Program" &&
				scope.node.type !== "FunctionDeclaration" &&
				scope.node.type !== "FunctionExpression" &&
				scope.node.type !== "PropertyDefinition" &&
				scope.node.type !== "StaticBlock"
			) {
				scope = scope.parent ?? undefined;
			}
			if (
				scope?.node.type === "Program" &&
				fn.semanticFile.type === "script" &&
				!fn.semanticFile.commonjs &&
				!program.evalDirect
			) {
				cursor.block.emitter.emit({
					type: "loadIntrinsic",
					registers: [destination],
					intrinsic: "globalThis",
				});
				return destination;
			}
			cursor.block.emitter.emit({
				type: "loadThis",
				registers: [destination],
			});
			return destination;
		}
		case "MetaProperty": {
			if (isImportMeta(expression)) {
				const destination = nextCoreVariable(fn);
				cursor.block.emitter.emit({
					type: "loadGlobal",
					registers: [destination],
					index: importMetaSlot(program, fn.semanticFile),
				});
				return destination;
			}
			if (fn.classContext?.superNewTargetBinding && !fn.inFieldInitializer) {
				return loadRegisterFromLocation(
					fn,
					cursor.block,
					getOrCreateBindingLocation(program, fn, fn.classContext.superNewTargetBinding),
				);
			}
			// new.target: the active frame's new.target. An arrow inherits new.target
			// lexically — sema bound it to an implicit "new.target" binding on the
			// enclosing non-arrow function, captured through the closure env.
			const newTargetBinding = fn.semanticFile.nodeToBinding.get(expression);
			if (newTargetBinding?.implicit === "new.target") {
				const location = getOrCreateBindingLocation(program, fn, newTargetBinding);
				return loadRegisterFromLocation(fn, cursor.block, location);
			}
			// A field initializer runs via [[Call]]: new.target is undefined, not the
			// constructor's new.target (whose frame the initializer is woven into).
			if (fn.inFieldInitializer) {
				return compileUndefined(fn, cursor);
			}
			const destination = nextCoreVariable(fn);
			cursor.block.emitter.emit({
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	node: ESTree.Expression,
): number {
	const result = nextCoreVariable(fn);
	const shortCircuits: Array<Extract<CompilerInstruction, { type: "jumpIf" }>> = [];
	const value = compileChainElement(program, fn, cursor, node, shortCircuits);
	if (value === -1) {
		return -1;
	}

	cursor.block.emitter.emit({ type: "move", registers: [result, value] });
	if (shortCircuits.length === 0) {
		return result;
	}

	const successJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(successJump);

	// Short-circuit landing block: the chain result is undefined.
	const shortIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	const shortBlock = fn.blocks[shortIdx]!;
	const shortCursor: CoreFrontendCursor = { block: shortBlock };
	const undefinedRegister = compileUndefined(fn, shortCursor);
	shortBlock.emitter.emit({ type: "move", registers: [result, undefinedRegister] });
	const shortJoinJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	shortBlock.emitter.emit(shortJoinJump);

	const joinIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
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
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	base: number,
	shortCircuits: Array<Extract<CompilerInstruction, { type: "jumpIf" }>>,
) {
	const undefinedRegister = compileUndefined(fn, cursor);
	const isNil = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "binary",
		registers: [isNil, base, undefinedRegister],
		operator: "==",
	});

	const shortJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [isNil],
		blocks: [-1],
	};
	const continueJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(shortJump, continueJump);
	shortCircuits.push(shortJump);

	const continueIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	continueJump.blocks[0] = continueIdx;
	cursor.block = fn.blocks[continueIdx]!;
}

/**
 * Recursively compile one node of an optional chain, threading the short-
 * circuit jump list through nested member accesses and calls.
 */
function compileChainElement(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	node: ESTree.Expression,
	shortCircuits: Array<Extract<CompilerInstruction, { type: "jumpIf" }>>,
): number {
	if (node.type === "MemberExpression") {
		if (node.object.type === "Super") {
			return compileMemberLoad(
				fn,
				cursor,
				compileMemberObjectAndKey(program, fn, cursor, node),
			);
		}
		const object = compileChainElement(program, fn, cursor, node.object, shortCircuits);
		if (object === -1) {
			return -1;
		}

		if (node.optional) {
			emitOptionalGuard(fn, cursor, object, shortCircuits);
		}

		// `obj?.#x` / `(chain).#x`: OptionalChain . PrivateIdentifier resolves the
		// private slot/method rather than a named own property.
		if (node.property.type === "PrivateIdentifier") {
			return compilePrivateMemberLoad(
				program,
				fn,
				cursor,
				object,
				`#${node.property.name}`,
			);
		}

		const key = node.computed
			? compileExpression(program, fn, cursor, node.property)
			: node.property.type === "Identifier"
				? compileStaticString(program, fn, cursor, node.property.name)
				: -1;
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "loadProperty",
			registers: [destination, object, key],
		});
		return destination;
	}

	if (node.type === "CallExpression") {
		const calleeNode = node.callee as unknown as ESTree.Node;
		// A super() call inside an optional chain (`super()?.a`) is still a
		// SuperCall — route it through compileSuperCall (which binds `this`), not
		// the ordinary callee path, then let the chain continue on its result.
		if (calleeNode.type === "Super") {
			return compileSuperCall(program, fn, cursor, node);
		}
		let callee: number;
		let thisRegister: number;
		if (calleeNode.type === "MemberExpression") {
			if (calleeNode.object.type === "Super") {
				const member = compileMemberObjectAndKey(program, fn, cursor, calleeNode);
				thisRegister = member.receiver!;
				callee = compileMemberLoad(fn, cursor, member);
			} else {
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

				thisRegister = object;
				if (calleeNode.property.type === "PrivateIdentifier") {
					// `obj?.#m()` / `(chain).#m()`: brand-checked private method/getter.
					callee = compilePrivateMemberLoad(
						program,
						fn,
						cursor,
						object,
						`#${calleeNode.property.name}`,
					);
				} else {
					const key = calleeNode.computed
						? compileExpression(program, fn, cursor, calleeNode.property)
						: calleeNode.property.type === "Identifier"
							? compileStaticString(program, fn, cursor, calleeNode.property.name)
							: -1;
					callee = nextCoreVariable(fn);
					cursor.block.emitter.emit({
						type: "loadProperty",
						registers: [callee, object, key],
					});
				}
			}
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
			if (node.arguments.length === 1 && node.arguments[0]?.type === "SpreadElement") {
				const iterable = compileExpression(
					program,
					fn,
					cursor,
					node.arguments[0].argument,
				);
				const destination = nextCoreVariable(fn);
				cursor.block.emitter.emit({
					type: "callSpreadIterable",
					registers: [destination, callee, thisRegister, iterable],
				});
				return destination;
			}
			const argumentsArray = compileSpreadArgumentsArray(
				program,
				fn,
				cursor,
				node.arguments,
			);
			const destination = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "callSpread",
				registers: [destination, callee, thisRegister, argumentsArray],
			});
			return destination;
		}

		const args = node.arguments.map((arg) =>
			arg.type === "SpreadElement" ? -1 : compileExpression(program, fn, cursor, arg),
		);
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	expression: ESTree.FunctionExpression | ESTree.ArrowFunctionExpression,
	nameHint?: string,
) {
	// NamedEvaluation only applies to anonymous functions; a named function
	// expression keeps its own name.
	const anonymous = expression.type === "ArrowFunctionExpression" || !expression.id;

	const destination = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createFunction",
		registers: [destination],
		functionIndex: compileNewFunctionExpression(
			program,
			fn,
			expression,
			inheritedPrivateEnvironment(fn, expression.type === "ArrowFunctionExpression"),
			anonymous ? nameHint : undefined,
		),
	});

	return destination;
}

function compileAssignment(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
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
			value = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "binary",
				registers: [value, current, right],
				operator: assignmentOperatorToBinaryOperator(assignmentExpression.operator),
			});
		}

		compilePrivateMemberStore(program, fn, cursor, object, name, value);
		return value;
	}

	const member = compileMemberObjectAndKey(
		program,
		fn,
		cursor,
		assignmentExpression.left,
	);
	const { object, key } = member;

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
		effectiveKey = compileMemberKeyOnce(fn, cursor, member);
	}

	let value: number;
	if (assignmentExpression.operator === "=") {
		value = compileExpression(program, fn, cursor, assignmentExpression.right);
	} else {
		const binaryOperator = assignmentOperatorToBinaryOperator(
			assignmentExpression.operator,
		);
		const current = nextCoreVariable(fn);
		cursor.block.emitter.emit(
			member.receiver === undefined
				? { type: "loadProperty", registers: [current, object, effectiveKey] }
				: {
						type: "loadSuperProperty",
						registers: [current, object, effectiveKey, member.receiver],
					},
		);

		const right = compileExpression(program, fn, cursor, assignmentExpression.right);
		value = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "binary",
			registers: [value, current, right],
			operator: binaryOperator,
		});
	}

	compileMemberStore(cursor, { ...member, key: effectiveKey }, value);

	return value;
}

function compileIdentifierAssignment(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	assignmentExpression: ESTree.AssignmentExpression,
): number {
	if (
		assignmentExpression.left.type === "Identifier" &&
		identifierUsesDynamicEnvironment(program, fn, assignmentExpression.left)
	) {
		// A `with`-intercepted assignment must capture the reference base (which
		// with-object, if any, provides the name) BEFORE evaluating the right-hand
		// side, then PutValue through that captured base (spec 11.13.1 / with
		// S12.10) — so a RHS that deletes/mutates the binding still writes to the
		// originally-resolved object.
		return compileWithDynamicAssignment(
			program,
			fn,
			cursor,
			assignmentExpression,
			assignmentExpression.left,
		);
	}

	const binding = fn.semanticFile.nodeToBinding.get(assignmentExpression.left);
	if (!binding) {
		return -1;
	}

	const hostGlobalLocation = retainHostGlobal(program, binding)
		? globalPropertyLocation(program, binding.name)
		: null;
	const runtimeGlobalLocation =
		binding.undeclared && !compilerPrivateIntrinsics.has(binding.name)
			? globalPropertyLocation(program, binding.name)
			: null;
	if (
		binding.undeclared &&
		!compilerPrivateIntrinsics.has(binding.name) &&
		!hostGlobalLocation
	) {
		// A plain assignment must resolve against the runtime global object in both
		// modes. Sloppy code creates an absent property; strict code throws only when
		// the property is actually absent. Resolve the strict reference before the
		// RHS: a RHS that creates the property must not turn an initially-unresolvable
		// reference into a resolvable one. Compound forms read first below.
		if (assignmentExpression.operator === "=") {
			let initiallyPresent: number | undefined;
			if (!isSloppyFunction(fn)) {
				initiallyPresent = nextCoreVariable(fn);
				cursor.block.emitter.emit({
					type: "globalBindingQuery",
					registers: [initiallyPresent],
					nameStringIndex: getOrCreateStringConstant(program, binding.name),
					query: "has",
				});
			}
			const value = compileExpression(program, fn, cursor, assignmentExpression.right);
			if (initiallyPresent !== undefined) {
				const storeJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
					type: "jumpIf",
					registers: [initiallyPresent],
					blocks: [-1],
				};
				const throwJump: Extract<CompilerInstruction, { type: "jump" }> = {
					type: "jump",
					blocks: [-1],
				};
				cursor.block.emitter.emit(storeJump, throwJump);

				const storeIndex = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
				cursor.block = fn.blocks[storeIndex]!;
				emitGlobalPropertyStore(program, fn, cursor, binding.name, value);
				const storeJoin: Extract<CompilerInstruction, { type: "jump" }> = {
					type: "jump",
					blocks: [-1],
				};
				cursor.block.emitter.emit(storeJoin);

				const throwIndex = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
				cursor.block = fn.blocks[throwIndex]!;
				const undeclared = nextCoreVariable(fn);
				cursor.block.emitter.emit({
					type: "loadUndeclared",
					registers: [undeclared],
					nameStringIndex: getOrCreateStringConstant(program, binding.name),
				});
				const throwJoin: Extract<CompilerInstruction, { type: "jump" }> = {
					type: "jump",
					blocks: [-1],
				};
				cursor.block.emitter.emit(throwJoin);

				const joinIndex = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
				storeJump.blocks[0] = storeIndex;
				throwJump.blocks[0] = throwIndex;
				storeJoin.blocks[0] = joinIndex;
				throwJoin.blocks[0] = joinIndex;
				cursor.block = fn.blocks[joinIndex]!;
				return value;
			}
			emitGlobalPropertyStore(program, fn, cursor, binding.name, value);
			return value;
		}
		// A compound assignment continues below: it must resolve a property that
		// can have appeared on the global object at runtime, then read and store it.
	}

	if (binding.immutableSelfReference) {
		// A named function expression's own-name binding is immutable
		// (CreateImmutableBinding, N-strict = false): reassigning it is a no-op in
		// sloppy code and a TypeError in strict code — mode-dependent, unlike
		// const. The right-hand side (or compound read+op) is still evaluated for
		// its side effects; the assignment expression yields that value.
		let value: number;
		if (assignmentExpression.operator === "=") {
			value = compileExpression(program, fn, cursor, assignmentExpression.right);
		} else {
			const location = getOrCreateBindingLocation(program, fn, binding);
			const current = loadRegisterFromLocation(fn, cursor.block, location);
			const right = compileExpression(program, fn, cursor, assignmentExpression.right);
			value = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "binary",
				registers: [value, current, right],
				operator: assignmentOperatorToBinaryOperator(assignmentExpression.operator),
			});
		}
		if (!isSloppyFunction(fn)) {
			return emitThrowTypeError(program, fn, cursor, "Assignment to constant variable.");
		}
		// Sloppy: the store is silently skipped; the expression value is the RHS.
		return value;
	}

	if (binding.kind === "const") {
		const location =
			hostGlobalLocation ?? getOrCreateBindingLocation(program, fn, binding);
		// SetMutableBinding checks initialization before immutability. Compound
		// assignment also performs GetValue, the RHS, and the operator before its
		// failing PutValue; plain assignment evaluates only the RHS first.
		if (assignmentExpression.operator === "=") {
			compileExpression(program, fn, cursor, assignmentExpression.right);
			emitWriteTdzGuard(program, fn, cursor.block, binding, hostGlobalLocation);
		} else {
			const current = loadRegisterFromLocation(fn, cursor.block, location);
			emitTdzGuard(program, fn, cursor.block, binding, current);
			const right = compileExpression(program, fn, cursor, assignmentExpression.right);
			if (right === -1) {
				return -1;
			}
			const value = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "binary",
				registers: [value, current, right],
				operator: assignmentOperatorToBinaryOperator(assignmentExpression.operator),
			});
		}
		return emitThrowTypeError(program, fn, cursor, "Assignment to constant variable.");
	}

	const location =
		hostGlobalLocation ??
		runtimeGlobalLocation ??
		getOrCreateBindingLocation(program, fn, binding);

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
		if (value === -1) {
			// The right hand side is not supported yet; skip the store instead of
			// emitting an invalid register reference.
			return -1;
		}
		// PutValue runs after the RHS, so its TDZ check fires only once the RHS
		// side effects have happened — a plain `x = <rhw>; let x` throws here.
		emitWriteTdzGuard(program, fn, cursor.block, binding, hostGlobalLocation);
	} else {
		const binaryOperator = assignmentOperatorToBinaryOperator(
			assignmentExpression.operator,
		);
		const current = loadRegisterFromLocation(fn, cursor.block, location);
		// A compound assignment GetValues the target before the RHS, so a still-
		// uninitialized `x += …; let x` throws on that read, before any RHS work.
		emitTdzGuard(program, fn, cursor.block, binding, current);
		const right = compileExpression(program, fn, cursor, assignmentExpression.right);
		if (right === -1) {
			return -1;
		}
		value = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "binary",
			registers: [value, current, right],
			operator: binaryOperator,
		});
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	assignmentExpression: ESTree.AssignmentExpression,
): number {
	const left = assignmentExpression.left;

	let location: BindingLocation | undefined;
	let identifierBinding: Binding | undefined;
	let nameHint: string | undefined;
	let member: CompiledMemberReference | undefined;
	let privateMember: { object: number; name: string } | undefined;
	let withReference:
		| { base: number; key: number; identifier: ESTree.Identifier }
		| undefined;
	let current: number;

	if (left.type === "Identifier") {
		const binding = fn.semanticFile.nodeToBinding.get(left);
		if (!binding) {
			return -1;
		}

		identifierBinding = binding;
		nameHint = binding.name;
		if (identifierUsesDynamicEnvironment(program, fn, left)) {
			const nameStringIndex = getOrCreateStringConstant(program, left.name);
			const base = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "withResolveBase",
				registers: [base],
				nameStringIndex,
			});
			const key = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "createString",
				registers: [key],
				stringIndex: nameStringIndex,
			});
			withReference = { base, key, identifier: left };
			current = compileWithBaseRead(program, fn, cursor, base, key, left);
		} else {
			const hostGlobalLocation = retainHostGlobal(program, binding)
				? globalPropertyLocation(program, binding.name)
				: null;
			location =
				hostGlobalLocation ??
				(binding.undeclared && !compilerPrivateIntrinsics.has(binding.name)
					? globalPropertyLocation(program, binding.name)
					: getOrCreateBindingLocation(program, fn, binding));
			current = loadRegisterFromLocation(fn, cursor.block, location);
			emitTdzGuard(program, fn, cursor.block, binding, current);
		}
	} else if (
		left.type === "MemberExpression" &&
		left.property.type === "PrivateIdentifier"
	) {
		const object = compileExpression(program, fn, cursor, left.object);
		privateMember = { object, name: `#${left.property.name}` };
		current = compilePrivateMemberLoad(program, fn, cursor, object, privateMember.name);
	} else if (left.type === "MemberExpression") {
		let compiled = compileMemberObjectAndKey(program, fn, cursor, left);
		if (left.computed && compiled.key >= 0) {
			const key = compileMemberKeyOnce(fn, cursor, compiled);
			compiled = { ...compiled, key };
		}
		member = compiled;
		current = compileMemberLoad(fn, cursor, member);
	} else {
		return -1;
	}

	const result = nextCoreVariable(fn);
	cursor.block.emitter.emit({ type: "move", registers: [result, current] });

	// The condition register decides whether to enter the assign branch.
	let condition = current;
	if (assignmentExpression.operator === "??=") {
		const undefinedRegister = compileUndefined(fn, cursor);
		condition = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "binary",
			registers: [condition, current, undefinedRegister],
			operator: "==",
		});
	}

	const conditionalJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [condition],
		blocks: [-1],
	};
	const fallthroughJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(conditionalJump, fallthroughJump);

	// Assign branch: evaluate the right hand side and store it.
	const assignIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
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
	cursor.block.emitter.emit({ type: "move", registers: [result, right] });

	if (withReference) {
		compileWithBaseStore(
			program,
			fn,
			cursor,
			withReference.base,
			withReference.key,
			withReference.identifier,
			right,
		);
	} else if (location) {
		if (identifierBinding?.kind === "const") {
			emitThrowTypeError(program, fn, cursor, "Assignment to constant variable.");
		} else {
			storeRegisterAtLocation(cursor.block, location, right);
		}
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
		compileMemberStore(cursor, member, right);
	}

	const assignJoinJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(assignJoinJump);

	const joinIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	expression: ESTree.LogicalExpression,
): number {
	const result = nextCoreVariable(fn);
	const left = compileExpression(program, fn, cursor, expression.left);
	cursor.block.emitter.emit({
		type: "move",
		registers: [result, left],
	});

	// The branch condition: && and || branch on the left value itself, while
	// ?? branches on it being null or undefined.
	let condition = left;
	if (expression.operator === "??") {
		const undefinedRegister = compileUndefined(fn, cursor);
		condition = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "binary",
			registers: [condition, left, undefinedRegister],
			operator: "==",
		});
	}

	const conditionalJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [condition],
		blocks: [-1],
	};
	const fallthroughJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(conditionalJump, fallthroughJump);

	const rightIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	cursor.block = fn.blocks[rightIdx]!;
	const right = compileExpression(program, fn, cursor, expression.right);
	cursor.block.emitter.emit({
		type: "move",
		registers: [result, right],
	});
	const rightJoinJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(rightJoinJump);

	const joinIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	expression: ESTree.ConditionalExpression,
): number {
	const result = nextCoreVariable(fn);
	const condition = compileExpression(program, fn, cursor, expression.test);

	const consequentJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [condition],
		blocks: [-1],
	};
	const alternateJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(consequentJump, alternateJump);

	const consequentIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	cursor.block = fn.blocks[consequentIdx]!;
	const consequent = compileExpression(program, fn, cursor, expression.consequent);
	cursor.block.emitter.emit({
		type: "move",
		registers: [result, consequent],
	});
	const consequentJoinJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(consequentJoinJump);

	const alternateIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	cursor.block = fn.blocks[alternateIdx]!;
	const alternate = compileExpression(program, fn, cursor, expression.alternate);
	cursor.block.emitter.emit({
		type: "move",
		registers: [result, alternate],
	});
	const alternateJoinJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(alternateJoinJump);

	const joinIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	consequentJump.blocks[0] = consequentIdx;
	alternateJump.blocks[0] = alternateIdx;
	consequentJoinJump.blocks[0] = joinIdx;
	alternateJoinJump.blocks[0] = joinIdx;
	cursor.block = fn.blocks[joinIdx]!;

	return result;
}

function compileTemplateLiteral(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
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
		const stringPart = nextCoreVariable(fn);
		// Template substitutions use the string hint and coerce before the next expression.
		cursor.block.emitter.emit({
			type: "unary",
			registers: [stringPart, part],
			operator: "tostring",
		});
		let next = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "binary",
			registers: [next, result, stringPart],
			operator: "+",
		});
		result = next;

		const quasi = expression.quasis[i + 1]?.value.cooked ?? "";
		if (quasi.length > 0) {
			const quasiRegister = compileStaticString(program, fn, cursor, quasi);
			next = nextCoreVariable(fn);
			cursor.block.emitter.emit({
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
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
		thisRegister = member.receiver ?? member.object;
		callee = compileMemberLoad(fn, cursor, member);
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

	const stringsRegister = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createTemplateObject",
		registers: [stringsRegister],
		cacheSlot: program.nextGlobalIndex++,
		cookedIndices,
		rawIndices,
	});

	const args = expression.quasi.expressions.map((argument) =>
		compileExpression(program, fn, cursor, argument),
	);

	const destination = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "call",
		registers: [destination, callee, thisRegister, stringsRegister, ...args],
	});

	return destination;
}

function compileUnaryExpression(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
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
		if (binding) {
			retainHostGlobal(program, binding);
		}
		if (binding?.undeclared && !identifierLoadsIntrinsic(program, argument.name)) {
			if (
				fn.semanticFile.withDynamicNodes.has(argument) ||
				directEvalFreeIdentifierUsesDynamicEnvironment(program, fn, argument)
			) {
				return compileWithDynamicTypeof(program, fn, cursor, argument);
			}
			const destination = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "globalBindingQuery",
				registers: [destination],
				nameStringIndex: getOrCreateStringConstant(program, argument.name),
				query: "typeof",
			});
			return destination;
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
	const destination = nextCoreVariable(fn);
	cursor.block.emitter.emit({
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	expression: ESTree.UnaryExpression,
): number {
	if (expression.argument.type === "MemberExpression") {
		const { object, key } = compileMemberObjectAndKey(
			program,
			fn,
			cursor,
			expression.argument,
		);
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "deleteProperty",
			registers: [destination, object, key],
		});

		return destination;
	}

	// `delete <identifier>` is only reachable in sloppy mode (strict rejects it).
	if (expression.argument.type === "Identifier") {
		// A `with`-intercepted name deletes the property off the active with-object
		// that provides it (spec DeleteBinding on the object environment record),
		// falling back to the static delete when no with-object has it.
		if (fn.semanticFile.withDynamicNodes.has(expression.argument)) {
			return compileWithDynamicDelete(program, fn, cursor, expression.argument);
		}
		return compileStaticIdentifierDelete(program, fn, cursor, expression.argument);
	}

	compileExpression(program, fn, cursor, expression.argument);

	const destination = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createBoolean",
		registers: [destination],
		value: true,
	});

	return destination;
}

// An unresolved name may still identify a non-deletable binding created by an earlier script.

function compileStaticIdentifierDelete(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	identifier: ESTree.Identifier,
): number {
	const binding = fn.semanticFile.nodeToBinding.get(identifier);
	if (binding?.undeclared) {
		retainHostGlobal(program, binding);
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "globalBindingQuery",
			registers: [destination],
			nameStringIndex: getOrCreateStringConstant(program, identifier.name),
			query: "delete",
		});
		return destination;
	}
	const destination = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createBoolean",
		registers: [destination],
		value: false,
	});
	return destination;
}

/**
 * `delete <identifier>` inside a `with`: probe the active with-object(s) for the
 * name (innermost first, honoring `Symbol.unscopables`); if one provides it, delete
 * the property off that object; otherwise fall back to the static delete. The two
 * paths join with the boolean result in one register.
 */
function compileWithDynamicDelete(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	identifier: ESTree.Identifier,
): number {
	const nameStringIndex = getOrCreateStringConstant(program, identifier.name);
	const base = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "withResolveBase",
		registers: [base],
		nameStringIndex,
	});
	const result = nextCoreVariable(fn);
	const emptyFlag = nextCoreVariable(fn);
	cursor.block.emitter.emit({ type: "isEmpty", registers: [emptyFlag, base] });

	const missJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [emptyFlag],
		blocks: [-1],
	};
	const foundJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(missJump, foundJump);

	// Found: delete the property off the captured with-object.
	const foundIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	cursor.block = fn.blocks[foundIdx]!;
	const key = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createString",
		registers: [key],
		stringIndex: nameStringIndex,
	});
	cursor.block.emitter.emit({
		type: "deleteProperty",
		registers: [result, base, key],
	});
	const foundJoin: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(foundJoin);

	// Miss: static delete into the same result register.
	const missIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	cursor.block = fn.blocks[missIdx]!;
	const staticResult = compileStaticIdentifierDelete(program, fn, cursor, identifier);
	cursor.block.emitter.emit({ type: "move", registers: [result, staticResult] });
	const missJoin: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(missJoin);

	const joinIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	foundJump.blocks[0] = foundIdx;
	missJump.blocks[0] = missIdx;
	foundJoin.blocks[0] = joinIdx;
	missJoin.blocks[0] = joinIdx;
	cursor.block = fn.blocks[joinIdx]!;
	return result;
}

/**
 * Compile ++ and -- on identifiers and members. The operand goes through
 * ToNumber (unary plus) so the postfix result is the numeric old value.
 */
function compileUpdateExpression(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	expression: ESTree.UpdateExpression,
): number {
	// UpdateExpression coerces with ToNumeric (not ToNumber): a BigInt operand
	// stays a BigInt, and the step then adds the unit of its own numeric type.
	// `oldValue` is the ToNumeric result, so postfix returns the coerced value.
	const step = expression.operator === "++" ? "increment" : "decrement";

	if (expression.argument.type === "Identifier") {
		const binding = fn.semanticFile.nodeToBinding.get(expression.argument);
		if (!binding) {
			return -1;
		}
		const hostGlobalLocation = retainHostGlobal(program, binding)
			? globalPropertyLocation(program, binding.name)
			: null;

		// A with-intercepted update must retain the environment reference resolved
		// before GetValue, even if its getter deletes the binding.
		if (identifierUsesDynamicEnvironment(program, fn, expression.argument)) {
			const nameStringIndex = getOrCreateStringConstant(
				program,
				expression.argument.name,
			);
			const base = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "withResolveBase",
				registers: [base],
				nameStringIndex,
			});
			const key = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "createString",
				registers: [key],
				stringIndex: nameStringIndex,
			});
			const current = compileWithBaseRead(
				program,
				fn,
				cursor,
				base,
				key,
				expression.argument,
			);
			const oldValue = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "unary",
				registers: [oldValue, current],
				operator: "tonumeric",
			});
			const newValue = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "unary",
				registers: [newValue, oldValue],
				operator: step,
			});
			compileWithBaseStore(program, fn, cursor, base, key, expression.argument, newValue);
			return expression.prefix ? newValue : oldValue;
		}

		const location =
			hostGlobalLocation ?? getOrCreateBindingLocation(program, fn, binding);
		const current = loadRegisterFromLocation(fn, cursor.block, location);
		emitTdzGuard(program, fn, cursor.block, binding, current);
		const oldValue = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "unary",
			registers: [oldValue, current],
			operator: "tonumeric",
		});

		const newValue = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "unary",
			registers: [newValue, oldValue],
			operator: step,
		});
		if (binding.kind === "const") {
			return emitThrowTypeError(program, fn, cursor, "Assignment to constant variable.");
		}
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
		const resolved: CompiledMemberReference = isPrivate
			? { object, key: -1 }
			: compileMemberObjectAndKey(program, fn, cursor, member);

		// ++/-- loads then stores at the same key, so a computed key is converted
		// to a property key once (running its coercion a single time) and reused.
		const effectiveKey =
			!isPrivate && member.computed && resolved.key >= 0
				? compileMemberKeyOnce(fn, cursor, resolved)
				: resolved.key;

		const current = isPrivate
			? compilePrivateMemberLoad(program, fn, cursor, object, privateName)
			: compileMemberLoad(fn, cursor, { ...resolved, key: effectiveKey });

		const oldValue = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "unary",
			registers: [oldValue, current],
			operator: "tonumeric",
		});

		const newValue = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "unary",
			registers: [newValue, oldValue],
			operator: step,
		});

		if (isPrivate) {
			compilePrivateMemberStore(program, fn, cursor, object, privateName, newValue);
		} else {
			compileMemberStore(cursor, { ...resolved, key: effectiveKey }, newValue);
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
	if (!isCompilerBinaryOperator(binaryOperator)) {
		throw new Error(`Unsupported assignment operator ${operator}`);
	}

	return binaryOperator;
}

function compileBinary(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
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
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "hasPrivate",
			registers: [destination, object, brandSymbol],
		});
		return destination;
	}

	if (!isCompilerBinaryOperator(binaryExpression.operator)) {
		throw new Error(`Unsupported binary operator ${binaryExpression.operator}`);
	}

	const left = compileExpression(program, fn, cursor, binaryExpression.left);
	const right = compileExpression(program, fn, cursor, binaryExpression.right);

	const destination = nextCoreVariable(fn);

	cursor.block.emitter.emit({
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

// Must stay in lockstep with MalLiteralTemplateTag in runtime/src/vm.h.
const LITERAL_TEMPLATE_NULL = 0;
const LITERAL_TEMPLATE_FALSE = 1;
const LITERAL_TEMPLATE_TRUE = 2;
const LITERAL_TEMPLATE_I32 = 3;
const LITERAL_TEMPLATE_F64 = 4;
const LITERAL_TEMPLATE_STRING = 5;
const LITERAL_TEMPLATE_BIGINT = 6;
const LITERAL_TEMPLATE_HOLE = 7;
const LITERAL_TEMPLATE_ARRAY = 8;
const LITERAL_TEMPLATE_OBJECT = 9;
const LITERAL_TEMPLATE_KEY = 10;
const MIN_LITERAL_TEMPLATE_WORDS = 32;
const literalNumberBits = new DataView(new ArrayBuffer(8));

function isArrayIndexName(name: string): boolean {
	if (!/^(?:0|[1-9][0-9]*)$/.test(name)) {
		return false;
	}
	const index = Number(name);
	return index <= 0xffff_fffe;
}

function isRegexLiteral(literal: ESTree.Literal): boolean {
	return "regex" in literal && literal.regex !== undefined && literal.regex !== null;
}

function staticNegativeNumber(node: ESTree.Expression): number | undefined {
	if (
		node.type !== "UnaryExpression" ||
		node.operator !== "-" ||
		node.argument.type !== "Literal" ||
		isRegexLiteral(node.argument) ||
		typeof node.argument.value !== "number"
	) {
		return undefined;
	}
	return -node.argument.value;
}

/** First template slice: recursively static arrays and plain data objects only. */
function isStaticLiteralTemplate(
	root: ESTree.ArrayExpression | ESTree.ObjectExpression,
): boolean {
	const pending: Array<ESTree.Expression> = [root];
	while (pending.length > 0) {
		const node = pending.pop()!;
		if (node.type === "ArrayExpression") {
			for (const element of node.elements) {
				if (element?.type === "SpreadElement") return false;
				if (element) pending.push(element);
			}
			continue;
		}
		if (node.type === "ObjectExpression") {
			const seen = new Set<string>();
			for (const property of node.properties) {
				if (
					property.type !== "Property" ||
					property.computed ||
					property.method ||
					property.kind !== "init"
				) {
					return false;
				}
				const name = staticPropertyName(property);
				if (
					name === undefined ||
					name === "__proto__" ||
					isArrayIndexName(name) ||
					seen.has(name)
				) {
					return false;
				}
				seen.add(name);
				pending.push(property.value as ESTree.Expression);
			}
			continue;
		}
		if (node.type === "Literal") {
			if (isRegexLiteral(node)) return false;
			const value = node.value;
			if (
				value === null ||
				typeof value === "boolean" ||
				typeof value === "number" ||
				typeof value === "string" ||
				typeof value === "bigint"
			) {
				continue;
			}
		}
		if (staticNegativeNumber(node) !== undefined) continue;
		return false;
	}
	return true;
}

function appendTemplateNumber(out: Array<number>, value: number): void {
	if (
		Number.isInteger(value) &&
		!Object.is(value, -0) &&
		value >= -2147483648 &&
		value <= 2147483647
	) {
		out.push(LITERAL_TEMPLATE_I32, value >>> 0);
		return;
	}
	literalNumberBits.setFloat64(0, value, true);
	out.push(
		LITERAL_TEMPLATE_F64,
		literalNumberBits.getUint32(0, true),
		literalNumberBits.getUint32(4, true),
	);
}

function compileLiteralTemplate(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	root: ESTree.ArrayExpression | ESTree.ObjectExpression,
): number | null {
	if (!isStaticLiteralTemplate(root)) return null;

	type Action =
		| { type: "node"; node: ESTree.Expression }
		| { type: "word"; word: number };
	const encoded: Array<number> = [];
	const actions: Array<Action> = [{ type: "node", node: root }];
	while (actions.length > 0) {
		const action = actions.pop()!;
		if (action.type === "word") {
			encoded.push(action.word);
			continue;
		}
		const node = action.node;
		if (node.type === "ArrayExpression") {
			encoded.push(LITERAL_TEMPLATE_ARRAY, node.elements.length);
			for (let i = node.elements.length - 1; i >= 0; --i) {
				const element = node.elements[i];
				actions.push(
					element === null || element === undefined
						? { type: "word", word: LITERAL_TEMPLATE_HOLE }
						: { type: "node", node: element },
				);
			}
			continue;
		}
		if (node.type === "ObjectExpression") {
			encoded.push(LITERAL_TEMPLATE_OBJECT, node.properties.length);
			for (let i = node.properties.length - 1; i >= 0; --i) {
				const property = node.properties[i] as ESTree.Property;
				const name = staticPropertyName(property)!;
				actions.push({ type: "node", node: property.value as ESTree.Expression });
				actions.push({
					type: "word",
					word: getOrCreateStringConstant(program, name),
				});
				actions.push({ type: "word", word: LITERAL_TEMPLATE_KEY });
			}
			continue;
		}
		const negative = staticNegativeNumber(node);
		if (negative !== undefined) {
			appendTemplateNumber(encoded, negative);
			continue;
		}
		const literal = node as ESTree.Literal;
		if (literal.value === null) encoded.push(LITERAL_TEMPLATE_NULL);
		else if (literal.value === false) encoded.push(LITERAL_TEMPLATE_FALSE);
		else if (literal.value === true) encoded.push(LITERAL_TEMPLATE_TRUE);
		else if (typeof literal.value === "number")
			appendTemplateNumber(encoded, literal.value);
		else if (typeof literal.value === "string") {
			encoded.push(
				LITERAL_TEMPLATE_STRING,
				getOrCreateStringConstant(program, literal.value),
			);
		} else {
			encoded.push(
				LITERAL_TEMPLATE_BIGINT,
				getOrCreateBigintConstant(program, literal.value as bigint),
			);
		}
	}

	// Small literals are cheaper on the ordinary Core path and remain visible to
	// scalar replacement. Templates target data large enough to reduce code size.
	if (encoded.length < MIN_LITERAL_TEMPLATE_WORDS) return null;

	const templateOffset = program.literalTemplateData.length;
	for (let index = 0; index < encoded.length; index++) {
		program.literalTemplateData.push(encoded[index]!);
	}
	const destination = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "instantiateLiteralTemplate",
		registers: [destination],
		templateOffset,
	});
	return destination;
}

/**
 * If every member is a static, non-index data property (no spread, computed key,
 * accessor, dynamic HomeObject, __proto__, duplicate, or index-like name, and at
 * most MAL_SHAPE_MAX_INLINE_SLOTS of them), return the ordered keys and properties
 * so the literal can be built in one shape; otherwise null. A concise method with
 * neither `super` nor direct eval is an ordinary enumerable data property and does
 * not need the object identity while its function is created.
 */
function staticObjectShape(
	fn: CoreFrontendFunction,
	objectExpression: ESTree.ObjectExpression,
): { names: Array<string>; properties: Array<ESTree.Property> } | null {
	const properties = objectExpression.properties;
	if (properties.length < 1 || properties.length > 64) {
		return null;
	}
	const names: Array<string> = [];
	const shapedProperties: Array<ESTree.Property> = [];
	const seen = new Set<string>();
	for (const property of properties) {
		if (property.type !== "Property" || property.kind !== "init") {
			return null;
		}
		if (property.method) {
			const value = property.value as ESTree.FunctionExpression;
			if (
				fn.semanticFile.hasDirectEval.has(value) ||
				referencesSuper(value.body) ||
				referencesSuper(value.params)
			) {
				return null;
			}
		}
		const name = staticPropertyName(property);
		if (name === undefined || name === "__proto__" || seen.has(name)) {
			return null;
		}
		// Canonical array indices live in the overflow table, not a shape slot.
		if (isArrayIndexName(name)) {
			return null;
		}
		seen.add(name);
		names.push(name);
		shapedProperties.push(property);
	}
	return { names, properties: shapedProperties };
}

/**
 * IsAnonymousFunctionDefinition: a function/arrow/class expression with no name of
 * its own, which NamedEvaluation may name from the binding/property it flows into.
 */
function isAnonymousFunctionDefinition(node: ESTree.Node | null | undefined): boolean {
	if (!node) {
		return false;
	}
	if (node.type === "ArrowFunctionExpression") {
		return true;
	}
	if (node.type === "FunctionExpression" || node.type === "ClassExpression") {
		return !node.id;
	}
	return false;
}

/**
 * Compile an object-literal method/accessor value with its [[HomeObject]] bound,
 * so `super.x` inside it (and inside nested arrows) resolves against the object.
 * Private names from a lexically enclosing class are inherited; isMethod strips
 * the erroneous `prototype` that a plain function value would carry.
 */
function compileObjectMemberFunction(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	valueNode: ESTree.FunctionExpression | ESTree.ArrowFunctionExpression,
	homeObjectBinding: Binding | undefined,
	nameHint: string | undefined,
): number {
	const inherited = inheritedPrivateEnvironment(fn, false);
	const classContext: SemanticClassContext = {
		isStatic: false,
		privateNames: inherited?.privateNames,
		homeObjectBinding,
	};
	const functionIndex = compileNewFunctionExpression(
		program,
		fn,
		valueNode,
		classContext,
		nameHint,
		true,
	);
	const destination = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createFunction",
		registers: [destination],
		functionIndex,
	});
	return destination;
}

function compileObjectExpression(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	objectExpression: ESTree.ObjectExpression,
): number {
	const template = compileLiteralTemplate(program, fn, cursor, objectExpression);
	if (template !== null) return template;

	const staticShape = staticObjectShape(fn, objectExpression);
	if (staticShape !== null) {
		// Evaluate the values left-to-right (keys are constants, so no key
		// evaluation), then build the object directly in its final shape.
		const valueRegisters = staticShape.properties.map((property, i) =>
			property.method
				? compileObjectMemberFunction(
						program,
						fn,
						cursor,
						property.value as ESTree.FunctionExpression,
						undefined,
						staticShape.names[i],
					)
				: compileExpression(
						program,
						fn,
						cursor,
						property.value as ESTree.Expression,
						staticShape.names[i],
					),
		);
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "createObjectShaped",
			registers: [destination, ...valueRegisters],
			keyStringIndices: staticShape.names.map((name) =>
				getOrCreateStringConstant(program, name),
			),
		});
		return destination;
	}

	const object = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createObject",
		registers: [object],
	});

	// If any method/accessor references `super`, the object literal is the
	// [[HomeObject]] for those definitions. Stash the object in a captured binding
	// the methods close over; `super.x` reads GetPrototypeOf(homeObject).x.
	let homeObjectBinding: Binding | undefined;
	const usesSuper = objectExpression.properties.some((property) => {
		if (
			property.type !== "Property" ||
			!(property.method || property.kind === "get" || property.kind === "set")
		) {
			return false;
		}
		// Scan inside the method (its body and parameter defaults), descending
		// through arrows but stopping at nested non-arrow functions — not the
		// method FunctionExpression node itself, which is a super boundary.
		const value = property.value as ESTree.FunctionExpression;
		return (
			fn.semanticFile.hasDirectEval.has(value) ||
			referencesSuper(value.body) ||
			referencesSuper(value.params)
		);
	});
	if (usesSuper) {
		homeObjectBinding = createCapturedBinding(
			program,
			fn,
			`__home_${program.nextFunctionIndex}`,
		);
		storeRegisterAtLocation(
			cursor.block,
			getOrCreateBindingLocation(program, fn, homeObjectBinding),
			object,
		);
	}

	for (const property of objectExpression.properties) {
		if (property.type === "SpreadElement") {
			// Object spread copies the source's own enumerable properties into
			// the literal under construction.
			const source = compileExpression(program, fn, cursor, property.argument);
			cursor.block.emitter.emit({
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
			cursor.block.emitter.emit({
				type: "setPrototype",
				registers: [object, prototype],
				literal: true,
			});
			continue;
		}

		let key = compilePropertyKey(program, fn, cursor, property);
		if (property.computed) key = compilePropertyNameValue(fn, cursor, key);

		if (property.kind === "get" || property.kind === "set") {
			const accessorNameHint =
				name !== undefined ? `${property.kind} ${name}` : undefined;
			const accessor = compileObjectMemberFunction(
				program,
				fn,
				cursor,
				property.value as ESTree.FunctionExpression,
				homeObjectBinding,
				accessorNameHint,
			);
			cursor.block.emitter.emit({
				type: "defineAccessor",
				registers: [object, key, accessor],
				kind: property.kind,
				enumerable: true,
			});
			continue;
		}

		// PropertyDefinitionEvaluation uses CreateDataProperty: own defines
		// that never run setters inherited from Object.prototype.
		const value = property.method
			? compileObjectMemberFunction(
					program,
					fn,
					cursor,
					property.value as ESTree.FunctionExpression,
					homeObjectBinding,
					name,
				)
			: compileExpression(program, fn, cursor, property.value as ESTree.Expression, name);
		// A computed key (no compile-time `name`) whose value is an anonymous
		// function definition takes its name from the key at runtime (a static key
		// was already handled by the `name` nameHint passed above).
		if (name === undefined && isAnonymousFunctionDefinition(property.value)) {
			cursor.block.emitter.emit({
				type: "setFunctionName",
				registers: [value, key],
			});
		}
		cursor.block.emitter.emit({
			type: "defineProperty",
			registers: [object, key, value],
			enumerable: true,
		});
	}

	return object;
}

function compileArrayExpression(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	arrayExpression: ESTree.ArrayExpression,
): number {
	const template = compileLiteralTemplate(program, fn, cursor, arrayExpression);
	if (template !== null) return template;

	const hasSpread = arrayExpression.elements.some(
		(element) => element?.type === "SpreadElement",
	);

	if (!hasSpread) {
		const array = nextCoreVariable(fn);
		cursor.block.emitter.emit({
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
			cursor.block.emitter.emit({
				type: "defineProperty",
				registers: [array, key, value],
				enumerable: true,
			});
		}

		return array;
	}

	// Spread makes the element indexes dynamic: append through a running
	// index register, spreads drain their source iterator.
	const array = nextCoreVariable(fn);
	cursor.block.emitter.emit({
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
			cursor.block.emitter.emit({
				type: "binary",
				registers: [index, index, one],
				operator: "+",
			});
			continue;
		}

		if (element.type === "SpreadElement") {
			const source = compileExpression(program, fn, cursor, element.argument);
			const iteratorRegister = nextCoreVariable(fn);
			const nextRegister = nextCoreVariable(fn);
			cursor.block.emitter.emit({
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
		cursor.block.emitter.emit({
			type: "defineProperty",
			registers: [array, index, value],
			enumerable: true,
		});
		cursor.block.emitter.emit({
			type: "binary",
			registers: [index, index, one],
			operator: "+",
		});
	}

	// Trailing holes only bumped the index; sync the length field.
	const lengthKey = compileStaticString(program, fn, cursor, "length");
	cursor.block.emitter.emit({
		type: "storeProperty",
		registers: [array, lengthKey, index],
	});

	return array;
}

function compileMemberExpression(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	memberExpression: ESTree.MemberExpression,
): number {
	const staticArgumentsResult = compileStaticArgumentsMember(
		program,
		fn,
		cursor,
		memberExpression,
	);
	if (staticArgumentsResult !== undefined) return staticArgumentsResult;
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

	const member = compileMemberObjectAndKey(program, fn, cursor, memberExpression);
	return compileMemberLoad(fn, cursor, member);
}

function compileStaticArgumentsMember(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	memberExpression: ESTree.MemberExpression,
): number | undefined {
	if (memberExpression.object.type !== "Identifier") return undefined;
	const usage = memberExpression.object;
	const access: StaticArgumentsAccess | undefined =
		fn.semanticFile.staticArgumentsAccesses.get(usage);
	if (access?.member !== memberExpression) return undefined;

	const mappedBinding = fn.staticMappedArgumentBindings?.get(usage);
	const snapshot = fn.staticArgumentsRegisters?.get(usage);
	if (access.kind === "length") return snapshot;
	const fallbackRegister = fn.staticArgumentsFallbackRegister;
	if (fallbackRegister === undefined || (!mappedBinding && snapshot === undefined)) {
		return undefined;
	}
	const direct = mappedBinding
		? loadRegisterFromLocation(
				fn,
				cursor.block,
				getOrCreateBindingLocation(program, fn, mappedBinding),
			)
		: snapshot!;
	const result = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "loadStaticArgument",
		registers: [result, fallbackRegister, direct, fallbackRegister],
		index: access.index,
	});
	return result;
}

interface CompiledMemberReference {
	object: number;
	key: number;
	receiver?: number;
}

function compileMemberLoad(
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	member: CompiledMemberReference,
): number {
	const destination = nextCoreVariable(fn);
	cursor.block.emitter.emit(
		member.receiver === undefined
			? {
					type: "loadProperty",
					registers: [destination, member.object, member.key],
				}
			: {
					type: "loadSuperProperty",
					registers: [destination, member.object, member.key, member.receiver],
				},
	);
	return destination;
}

function compileMemberKeyOnce(
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	member: CompiledMemberReference,
): number {
	let coercibleBase = member.object;
	if (member.receiver !== undefined) {
		// TO_PROPERTY_KEY also checks its ordinary member base. A super reference
		// checks its (possibly null) base only when GetValue runs, after key
		// conversion, so use an inert coercible value for this conversion step.
		coercibleBase = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "createBoolean",
			registers: [coercibleBase],
			value: true,
		});
	}
	const key = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "toPropertyKey",
		registers: [key, coercibleBase, member.key],
	});
	return key;
}

function compileMemberStore(
	cursor: CoreFrontendCursor,
	member: CompiledMemberReference,
	value: number,
): void {
	cursor.block.emitter.emit(
		member.receiver === undefined
			? { type: "storeProperty", registers: [member.object, member.key, value] }
			: {
					type: "storeSuperProperty",
					registers: [member.object, member.key, value, member.receiver],
				},
	);
}

function compileMemberObjectAndKey(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	memberExpression: ESTree.MemberExpression,
): CompiledMemberReference {
	let object = -1;
	let receiver: number | undefined;
	if (memberExpression.object.type === "Super") {
		// SuperProperty evaluation obtains the this binding before evaluating a
		// computed key. Keep it in the reference so reads and later writes use the
		// same receiver even if evaluation invokes arbitrary code.
		const lexicalThisBinding = fn.semanticFile.nodeToBinding.get(memberExpression.object);
		if (fn.classContext?.superThisStateBinding) {
			receiver = loadSharedSuperThis(program, fn, cursor, true);
		} else if (lexicalThisBinding?.implicit === "this") {
			receiver = loadRegisterFromLocation(
				fn,
				cursor.block,
				getOrCreateBindingLocation(program, fn, lexicalThisBinding),
			);
		} else {
			receiver = nextCoreVariable(fn);
			cursor.block.emitter.emit({ type: "loadThis", registers: [receiver] });
		}
	} else {
		object = compileExpression(program, fn, cursor, memberExpression.object);
	}

	const key = memberExpression.computed
		? compileExpression(program, fn, cursor, memberExpression.property)
		: memberExpression.property.type === "Identifier"
			? compileStaticString(program, fn, cursor, memberExpression.property.name)
			: -1;
	if (memberExpression.object.type === "Super") {
		object = compileSuperObject(program, fn, cursor);
		if (object === -1) {
			return { object: -1, key: -1, receiver };
		}
	}

	return { object, key, receiver };
}

/**
 * Resolve the super lookup object: the parent prototype in instance members,
 * the parent itself in static ones.
 */
function compileSuperObject(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
): number {
	const classContext = fn.classContext;
	if (!classContext) {
		return -1;
	}

	// Object-literal method: the [[HomeObject]] is the object literal itself, and
	// the super base is its (live) prototype — GetPrototypeOf(homeObject).
	if (classContext.homeObjectBinding) {
		const location = getOrCreateBindingLocation(
			program,
			fn,
			classContext.homeObjectBinding,
		);
		const home = loadRegisterFromLocation(fn, cursor.block, location);
		const object = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "loadPrototype",
			registers: [object, home],
		});
		return object;
	}

	if (classContext.classBinding) {
		// Class methods resolve through their live [[HomeObject]] rather than the
		// originally evaluated heritage value.
		const location = getOrCreateBindingLocation(program, fn, classContext.classBinding);
		let home = loadRegisterFromLocation(fn, cursor.block, location);

		if (!classContext.isStatic) {
			const prototypeKey = compileStaticString(program, fn, cursor, "prototype");
			const prototype = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "loadProperty",
				registers: [prototype, home, prototypeKey],
			});
			home = prototype;
		}

		const object = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "loadPrototype",
			registers: [object, home],
		});

		return object;
	}

	if (!classContext.superBinding) {
		return -1;
	}

	const location = getOrCreateBindingLocation(program, fn, classContext.superBinding);
	const parent = loadRegisterFromLocation(fn, cursor.block, location);
	if (classContext.isStatic) {
		return parent;
	}

	const prototypeKey = compileStaticString(program, fn, cursor, "prototype");
	const object = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "loadProperty",
		registers: [object, parent, prototypeKey],
	});

	return object;
}

function compilePropertyNameValue(
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	key: number,
): number {
	const coercible = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createBoolean",
		registers: [coercible],
		value: true,
	});
	const propertyKey = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "toPropertyKey",
		registers: [propertyKey, coercible, key],
	});
	return propertyKey;
}

function compilePropertyKey(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	value: string,
) {
	const destination = nextCoreVariable(fn);
	cursor.block.emitter.emit({
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	args: Array<ESTree.Expression | ESTree.SpreadElement>,
): number {
	const array = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createArray",
		registers: [array],
		length: 0,
	});
	const index = compileNumberLiteral(fn, cursor, 0);
	const one = compileNumberLiteral(fn, cursor, 1);

	for (const arg of args) {
		if (arg.type === "SpreadElement") {
			const source = compileExpression(program, fn, cursor, arg.argument);
			const iteratorRegister = nextCoreVariable(fn);
			const nextRegister = nextCoreVariable(fn);
			cursor.block.emitter.emit({
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
		cursor.block.emitter.emit({
			type: "storeProperty",
			registers: [array, index, value],
		});
		cursor.block.emitter.emit({
			type: "binary",
			registers: [index, index, one],
			operator: "+",
		});
	}

	return array;
}

/**
 * The bindings a direct eval can see in the caller — the current function's
 * params/locals and the block bindings in scope at the call site (nearest
 * shadows outer). Undeclared names are excluded: the eval'd code reaches those
 * through the global fallback. Semantic analysis conservatively treats the eval
 * as a use of every visible binding, so enclosing-function values are captured
 * and globals backed by internal slots can be marshaled too.
 */
function visibleBindingsForDirectEval(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	callNode: ESTree.Node,
): Map<string, Binding> {
	const result = new Map<string, Binding>();
	let scope: Scope | null | undefined = fn.semanticFile.nodeToScope.get(callNode);
	let unit: Scope | null | undefined = scope;
	while (unit && !FUNCTION_UNIT_NODE_TYPES.has(unit.node.type)) unit = unit.parent;
	const topLevelEval = unit?.node.type === "Program";
	while (scope) {
		for (const binding of scope.bindings) {
			if (
				!result.has(binding.name) &&
				!binding.undeclared &&
				!binding.implicit &&
				(!topLevelEval ||
					fn.semanticFile.evalDirect ||
					!isScriptGlobalProperty(program, fn.semanticFile, binding))
			) {
				result.set(binding.name, binding);
			}
		}
		scope = scope.parent;
	}
	const argumentsBinding = fn.semanticFile.nodeToBinding.get(callNode);
	if (argumentsBinding && !argumentsBinding.undeclared && !result.has("arguments")) {
		result.set("arguments", argumentsBinding);
	}
	return result;
}

function inheritedContextForDirectEval(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	callNode: ESTree.CallExpression,
): DirectEvalContext {
	const classContext = fn.classContext;
	const allowSuperProperty = Boolean(
		classContext?.homeObjectBinding ||
		classContext?.classBinding ||
		classContext?.superBinding,
	);
	const allowSuperCall = Boolean(
		!fn.inFieldInitializer &&
		classContext?.superBinding &&
		classContext.superThisStateBinding &&
		classContext.superNewTargetBinding,
	);
	const privateNames: Array<DirectEvalPrivateNameContext> = [];
	for (const [name, entry] of classContext?.privateNames ?? []) {
		let flags = entry.static ? DIRECT_EVAL_PRIVATE_STATIC : 0;
		if (entry.fieldBinding) flags |= DIRECT_EVAL_PRIVATE_FIELD;
		if (entry.methodBinding) flags |= DIRECT_EVAL_PRIVATE_METHOD;
		if (entry.getBinding) flags |= DIRECT_EVAL_PRIVATE_GETTER;
		if (entry.setBinding) flags |= DIRECT_EVAL_PRIVATE_SETTER;
		privateNames.push({ name, flags });
	}

	const callScope = fn.semanticFile.nodeToScope.get(callNode);
	let unit: Scope | null | undefined = callScope;
	while (unit && !FUNCTION_UNIT_NODE_TYPES.has(unit.node.type)) unit = unit.parent;
	const varConflictNames = new Set(
		program.evalDirect ? program.directEvalContext.varConflictNames : [],
	);
	const varEnvironmentNames = new Set(
		program.evalDirect ? program.directEvalContext.varEnvironmentNames : [],
	);
	for (const binding of visibleBindingsForDirectEval(program, fn, callNode).values()) {
		if (binding.kind !== "var" || binding.undeclared) continue;
		const ownerScope = fn.semanticFile.scopes.find((scope) =>
			scope.bindings.includes(binding),
		);
		let ownerUnit: Scope | null | undefined = ownerScope;
		while (ownerUnit && !FUNCTION_UNIT_NODE_TYPES.has(ownerUnit.node.type)) {
			ownerUnit = ownerUnit.parent;
		}
		if (ownerUnit === unit) varEnvironmentNames.add(binding.name);
	}
	if (
		fn.inParameterExpression &&
		unit &&
		(unit.node.type === "FunctionDeclaration" ||
			unit.node.type === "FunctionExpression" ||
			unit.node.type === "ArrowFunctionExpression")
	) {
		for (const binding of unit.bindings) {
			if (!binding.undeclared && binding.kind === "var") {
				varConflictNames.add(binding.name);
			}
		}
	}

	let lexicalScope = callScope;
	while (lexicalScope) {
		const includeUnit =
			lexicalScope !== unit ||
			unit?.node.type === "Program" ||
			unit?.node.type === "StaticBlock" ||
			unit?.node.type === "PropertyDefinition";
		if (includeUnit && !lexicalScope.dynamic) {
			for (const binding of lexicalScope.bindings) {
				const simpleCatchParameter =
					lexicalScope.node.type === "CatchClause" &&
					lexicalScope.node.param?.type === "Identifier" &&
					binding.declarationNode === lexicalScope.node.param;
				if (
					binding.kind !== "var" &&
					!binding.undeclared &&
					binding.implicit === undefined &&
					!simpleCatchParameter
				) {
					varConflictNames.add(binding.name);
				}
			}
		}
		if (lexicalScope === unit) break;
		lexicalScope = lexicalScope.parent ?? undefined;
	}
	let allowNewTarget = false;
	if (unit?.node.type === "Program") {
		allowNewTarget = program.evalDirect && program.directEvalContext.allowNewTarget;
	} else if (unit?.node.type === "ArrowFunctionExpression") {
		let owner = unit.parent;
		while (
			owner &&
			(owner.node.type === "ArrowFunctionExpression" ||
				!FUNCTION_UNIT_NODE_TYPES.has(owner.node.type))
		) {
			owner = owner.parent;
		}
		allowNewTarget =
			owner?.node.type === "Program"
				? program.evalDirect && program.directEvalContext.allowNewTarget
				: owner !== null && owner !== undefined;
	} else {
		allowNewTarget = unit !== null && unit !== undefined;
	}

	return {
		allowSuperProperty,
		allowSuperCall,
		hasInstanceInitializer: Boolean(classContext?.instanceInitializerBinding),
		allowNewTarget,
		privateNames,
		varConflictNames: [...varConflictNames],
		varEnvironmentNames: [...varEnvironmentNames],
		varEnvironmentIsGlobal:
			unit?.node.type === "Program" &&
			!program.evalDirect &&
			fn.semanticFile.type === "script",
	};
}

function storeDirectEvalScopeValue(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	scopeObject: number,
	keyName: string,
	value: number,
): void {
	const key = compileStaticString(program, fn, cursor, keyName);
	cursor.block.emitter.emit({
		type: "storeProperty",
		registers: [scopeObject, key, value],
	});
}

function loadDirectEvalHomeObject(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
): number {
	const classContext = fn.classContext;
	if (classContext?.homeObjectBinding) {
		return loadCapturedBinding(program, fn, cursor, classContext.homeObjectBinding);
	}
	if (!classContext?.classBinding) return -1;
	const constructor = loadCapturedBinding(program, fn, cursor, classContext.classBinding);
	if (classContext.isStatic) return constructor;
	const prototypeKey = compileStaticString(program, fn, cursor, "prototype");
	const prototype = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "loadProperty",
		registers: [prototype, constructor, prototypeKey],
	});
	return prototype;
}

function marshalDirectEvalInheritedContext(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	scopeObject: number,
	context: DirectEvalContext,
): void {
	if (context.allowSuperProperty) {
		const home = loadDirectEvalHomeObject(program, fn, cursor);
		if (home >= 0) {
			storeDirectEvalScopeValue(
				program,
				fn,
				cursor,
				scopeObject,
				directEvalHomeScopeKey(),
				home,
			);
		}
	}
	if (context.allowSuperCall) {
		const classContext = fn.classContext;
		const inheritedValues: Array<[string, Binding | undefined]> = [
			[directEvalSuperConstructorScopeKey(), classContext?.superBinding],
			[directEvalSuperThisStateScopeKey(), classContext?.superThisStateBinding],
			[directEvalSuperNewTargetScopeKey(), classContext?.superNewTargetBinding],
			[directEvalInstanceInitializerScopeKey(), classContext?.instanceInitializerBinding],
		];
		for (const [key, binding] of inheritedValues) {
			if (!binding) continue;
			storeDirectEvalScopeValue(
				program,
				fn,
				cursor,
				scopeObject,
				key,
				loadCapturedBinding(program, fn, cursor, binding),
			);
		}
	}

	for (let index = 0; index < context.privateNames.length; index++) {
		const inheritedName = context.privateNames[index]!;
		const entry = fn.classContext?.privateNames?.get(inheritedName.name);
		if (!entry) continue;
		const slots: Array<[DirectEvalPrivateSlot, Binding | undefined]> = [
			["brand", entry.brandBinding],
			["field", entry.fieldBinding],
			["method", entry.methodBinding],
			["get", entry.getBinding],
			["set", entry.setBinding],
		];
		for (const [slot, binding] of slots) {
			if (!binding) continue;
			storeDirectEvalScopeValue(
				program,
				fn,
				cursor,
				scopeObject,
				directEvalPrivateScopeKey(index, slot),
				loadCapturedBinding(program, fn, cursor, binding),
			);
		}
	}
}

function ensureDirectEvalPersistentScope(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
): number {
	if (program.evalDirect && program.directEvalPersistentScopeBinding) {
		return loadCapturedBinding(
			program,
			fn,
			cursor,
			program.directEvalPersistentScopeBinding,
		);
	}
	if (fn.directEvalPersistentScopeRegister === undefined) {
		const scope = nextCoreVariable(fn);
		const nullPrototype = nextCoreVariable(fn);
		fn.directEvalPersistentScopeRegister = scope;
		emitCoreEntryInstructions(
			fn,
			{ type: "createObject", registers: [scope] },
			{ type: "createNull", registers: [nullPrototype] },
			{ type: "setPrototype", registers: [scope, nullPrototype], literal: false },
			{ type: "withEnter", registers: [scope] },
		);
	}
	return fn.directEvalPersistentScopeRegister;
}

/**
 * Compile a direct `eval(arg, ...)`: snapshot the caller's visible bindings into
 * a scope object, invoke the direct-eval intrinsic (which pushes the object as a
 * with-scope and compiles the source so free identifiers resolve against it),
 * then write the (possibly mutated) bindings back. Reuses the with machinery and
 * ordinary binding loads/stores — no new opcodes, no caller-env plumbing.
 *
 * A sibling `dirtyTracker` object, keyed the same as the scope, rides along so
 * the runtime's withSet can record real Set evidence per name (see
 * mal_vm_op_with_set) — global writeback below reads that instead of inferring
 * "was this assigned" from value equality, which is wrong for NaN (NaN !== NaN)
 * and would skip an actual same-value Set through an accessor's setter.
 */
function compileDirectEval(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	callExpression: ESTree.CallExpression,
): number {
	const bindings = visibleBindingsForDirectEval(program, fn, callExpression);
	const inheritedContext = inheritedContextForDirectEval(program, fn, callExpression);
	const persistentScope =
		!inheritedContext.varEnvironmentIsGlobal && isSloppyFunction(fn)
			? ensureDirectEvalPersistentScope(program, fn, cursor)
			: undefined;

	const scopeObject = nextCoreVariable(fn);
	cursor.block.emitter.emit({ type: "createObject", registers: [scopeObject] });
	const nullPrototype = nextCoreVariable(fn);
	cursor.block.emitter.emit(
		{ type: "createNull", registers: [nullPrototype] },
		{
			type: "setPrototype",
			registers: [scopeObject, nullPrototype],
			literal: false,
		},
	);
	const dirtyTracker = nextCoreVariable(fn);
	cursor.block.emitter.emit(
		{ type: "createObject", registers: [dirtyTracker] },
		{
			type: "setPrototype",
			registers: [dirtyTracker, nullPrototype],
			literal: false,
		},
	);
	storeDirectEvalScopeValue(
		program,
		fn,
		cursor,
		scopeObject,
		directEvalScopeObjectKey(),
		scopeObject,
	);
	storeDirectEvalScopeValue(
		program,
		fn,
		cursor,
		scopeObject,
		directEvalDirtyTrackerKey(),
		dirtyTracker,
	);
	// Marshal each visible binding's current value onto the scope object by name.
	for (const [name, binding] of bindings) {
		let value: number;
		if (
			program.evalDirect &&
			!fn.semanticFile.strict &&
			!program.directEvalContext.varEnvironmentIsGlobal &&
			binding.kind === "var" &&
			!binding.undeclared &&
			!binding.implicit &&
			fn.semanticFile.scopes[0]?.bindings.includes(binding)
		) {
			value = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "withGet",
				registers: [value],
				nameStringIndex: getOrCreateStringConstant(program, name),
			});
		} else {
			const location = getOrCreateBindingLocation(program, fn, binding);
			value = loadRegisterFromLocation(fn, cursor.block, location);
		}
		const key = compileStaticString(program, fn, cursor, name);
		cursor.block.emitter.emit({
			type: "storeProperty",
			registers: [scopeObject, key, value],
		});
	}
	marshalDirectEvalInheritedContext(program, fn, cursor, scopeObject, inheritedContext);

	const callee = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "loadIntrinsic",
		registers: [callee],
		intrinsic: "__directEval",
	});
	const thisRegister = compileUndefined(fn, cursor);
	const source = compileExpression(
		program,
		fn,
		cursor,
		callExpression.arguments[0] as ESTree.Expression,
	);
	// Direct eval inherits the caller's strictness — pass it so the eval'd code's
	// strict/sloppy semantics are correct (a "use strict" prologue still promotes).
	const callerStrict = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createBoolean",
		registers: [callerStrict],
		value: !isSloppyFunction(fn),
	});
	// Retained in the intrinsic ABI; parameter-environment conflicts are encoded
	// in inheritedContext so arrows and non-arrow functions remain distinct.
	const inParamExpr = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createBoolean",
		registers: [inParamExpr],
		value: fn.inParameterExpression ?? false,
	});

	// Direct eval inherits the caller's this/new.target (GetThisEnvironment /
	// GetNewTarget resolve against the calling context). Pass them explicitly so
	// a compiled caller — which has no interpreter frame to read — threads them.
	// Match ThisExpression: top-level `this` in a script is globalThis; inside any
	// function it is the frame's `this`.
	let callerThis: number;
	const lexicalThisBinding = fn.semanticFile.directEvalThisBindings.get(callExpression);
	if (fn.classContext?.superThisStateBinding) {
		callerThis = loadSharedSuperThis(program, fn, cursor, false);
	} else if (lexicalThisBinding) {
		callerThis = loadRegisterFromLocation(
			fn,
			cursor.block,
			getOrCreateBindingLocation(program, fn, lexicalThisBinding),
		);
	} else {
		let owner: Scope | null | undefined = fn.semanticFile.nodeToScope.get(callExpression);
		while (owner && !FUNCTION_UNIT_NODE_TYPES.has(owner.node.type)) owner = owner.parent;
		while (owner?.node.type === "ArrowFunctionExpression") {
			owner = owner.parent;
			while (owner && !FUNCTION_UNIT_NODE_TYPES.has(owner.node.type))
				owner = owner.parent;
		}
		callerThis = nextCoreVariable(fn);
		if (
			owner?.node.type === "Program" &&
			fn.semanticFile.type === "script" &&
			!fn.semanticFile.commonjs &&
			!program.evalDirect
		) {
			cursor.block.emitter.emit({
				type: "loadIntrinsic",
				registers: [callerThis],
				intrinsic: "globalThis",
			});
		} else if (owner?.node.type === "Program" && !program.evalDirect) {
			cursor.block.emitter.emit({
				type: "createUndefined",
				registers: [callerThis],
			});
		} else {
			cursor.block.emitter.emit({ type: "loadThis", registers: [callerThis] });
		}
	}

	let callerNewTarget: number;
	const lexicalNewTargetBinding =
		fn.semanticFile.directEvalNewTargetBindings.get(callExpression);
	if (fn.classContext?.superNewTargetBinding) {
		callerNewTarget = loadRegisterFromLocation(
			fn,
			cursor.block,
			getOrCreateBindingLocation(program, fn, fn.classContext.superNewTargetBinding),
		);
	} else if (lexicalNewTargetBinding) {
		callerNewTarget = loadRegisterFromLocation(
			fn,
			cursor.block,
			getOrCreateBindingLocation(program, fn, lexicalNewTargetBinding),
		);
	} else if (fn.inFieldInitializer || !inheritedContext.allowNewTarget) {
		callerNewTarget = compileUndefined(fn, cursor);
	} else {
		callerNewTarget = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "loadNewTarget",
			registers: [callerNewTarget],
		});
	}

	// A field-initializer eval inherits the "no arguments" context: `arguments`
	// in the eval'd code is a SyntaxError. Pass the flag so the eval compile
	// applies the early error.
	const inFieldInitializer = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createBoolean",
		registers: [inFieldInitializer],
		value: fn.inFieldInitializer ?? false,
	});
	const inheritedContextRegister = compileStaticString(
		program,
		fn,
		cursor,
		encodeDirectEvalContext(inheritedContext),
	);
	const persistentScopeKey = compileStaticString(
		program,
		fn,
		cursor,
		directEvalPersistentScopeKey(),
	);
	const result = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "call",
		registers: [
			result,
			callee,
			thisRegister,
			source,
			persistentScope ?? scopeObject,
			callerStrict,
			dirtyTracker,
			callerThis,
			callerNewTarget,
			inFieldInitializer,
			inheritedContextRegister,
			scopeObject,
			persistentScopeKey,
		],
	});

	// Write mutated bindings back (const can't be reassigned; the eval throws if
	// it tries, so there is nothing to write back).
	for (const [name, binding] of bindings) {
		if (binding.kind === "const") {
			continue;
		}
		const location = getOrCreateBindingLocation(program, fn, binding);
		const key = compileStaticString(program, fn, cursor, name);
		const value = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "loadProperty",
			registers: [value, scopeObject, key],
		});
		if (location.type === "globalProperty") {
			// Write back only when eval actually Set this binding, per the dirty
			// tracker — not value equality (=== treats NaN as "changed" when it
			// isn't, and treats a same-value Set through an accessor as "unchanged"
			// when the setter must still run).
			const dirty = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "loadProperty",
				registers: [dirty, dirtyTracker, key],
			});
			const dirtyJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
				type: "jumpIf",
				registers: [dirty],
				blocks: [-1],
			};
			const skipJump: Extract<CompilerInstruction, { type: "jump" }> = {
				type: "jump",
				blocks: [-1],
			};
			cursor.block.emitter.emit(dirtyJump, skipJump);

			const writeBlock: CoreFrontendBlock = { emitter: unboundCoreEmitter };
			const writeIndex = fn.blocks.push(writeBlock) - 1;
			storeRegisterAtLocation(writeBlock, location, value);
			const joinJump: Extract<CompilerInstruction, { type: "jump" }> = {
				type: "jump",
				blocks: [-1],
			};
			writeBlock.emitter.emit(joinJump);

			const joinIndex = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
			dirtyJump.blocks[0] = writeIndex;
			skipJump.blocks[0] = joinIndex;
			joinJump.blocks[0] = joinIndex;
			cursor.block = fn.blocks[joinIndex]!;
			continue;
		}
		storeRegisterAtLocation(cursor.block, location, value);
	}

	return result;
}

function compileImportExpression(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	source: ESTree.Expression,
	options?: ESTree.Expression | null,
): number {
	const targetPath = dynamicImportTargetPath(program, fn, source);
	const specifier = compileExpression(program, fn, cursor, source);
	if (options) {
		compileExpression(program, fn, cursor, options);
	}
	if (targetPath) {
		return emitDynamicImportCall(program, fn, cursor, specifier, targetPath);
	}
	if (source.type === "Literal") {
		return emitDynamicImportCall(program, fn, cursor, specifier);
	}

	return emitDynamicImportCall(
		program,
		fn,
		cursor,
		specifier,
		undefined,
		dynamicImportCandidates(program, fn),
	);
}

interface DynamicImportCandidate {
	specifier: string;
	targetPath: string;
}

function dynamicImportCandidates(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
): Array<DynamicImportCandidate> {
	const record = program.semantic.graph?.modules.get(fn.semanticFile.path);
	const files = new Map(program.semantic.files.map((file) => [file.path, file]));
	const candidates = new Map<string, DynamicImportCandidate>();
	for (const dependency of record?.dependencies ?? []) {
		const targetFile =
			dependency.resolvedPath === null ? undefined : files.get(dependency.resolvedPath);
		if (
			dependency.kind !== "dynamic" ||
			dependency.resolvedPath === null ||
			targetFile === undefined ||
			targetFile.commonjs
		) {
			continue;
		}
		for (const candidateSpecifier of [dependency.specifier, dependency.resolvedPath]) {
			if (candidateSpecifier === null) continue;
			const candidate = {
				specifier: candidateSpecifier,
				targetPath: dependency.resolvedPath,
			};
			candidates.set(`${candidateSpecifier}\0${dependency.resolvedPath}`, candidate);
		}
	}
	return [...candidates.values()].sort(
		(left, right) =>
			left.specifier.localeCompare(right.specifier) ||
			left.targetPath.localeCompare(right.targetPath),
	);
}

function emitDynamicImportCall(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	specifier: number,
	targetPath?: string,
	candidates: ReadonlyArray<DynamicImportCandidate> = [],
): number {
	const emitTarget = (path: string | undefined): Array<number> => {
		const targetFile = path
			? program.semantic.files.find((file) => file.path === path)
			: undefined;
		// A self-import observes the active module; re-entering its init would recurse.
		const targetInitIndex = targetFile?.commonjs
			? -1
			: targetFile && path !== fn.semanticFile.path
				? compileFileInit(program, targetFile)
				: -1;
		const namespaceExports = path ? program.moduleNamespaces.get(path) : undefined;
		const initFn =
			targetInitIndex >= 0 ? nextCoreVariable(fn) : compileUndefined(fn, cursor);
		if (targetInitIndex >= 0) {
			cursor.block.emitter.emit({
				type: "createFunction",
				registers: [initFn],
				functionIndex: targetInitIndex,
			});
		}
		const namespace = namespaceExports
			? emitNamespaceObjectRegister(program, fn, cursor.block, namespaceExports, path)
			: compileUndefined(fn, cursor);
		const statusSlot = path ? getDynamicModuleStatusSlot(program, path) : -1;
		return [
			initFn,
			namespace,
			statusSlot < 0
				? compileNumberLiteral(fn, cursor, -1)
				: compileGlobalIndex(fn, cursor, statusSlot),
		];
	};

	const callee = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "loadIntrinsic",
		registers: [callee],
		intrinsic: "__dynamicImport",
	});
	const thisRegister = compileUndefined(fn, cursor);
	const targetArguments = emitTarget(targetPath);
	const candidateArguments = candidates.flatMap((candidate) => [
		compileStaticString(program, fn, cursor, candidate.specifier),
		...emitTarget(candidate.targetPath),
	]);
	const destination = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "call",
		registers: [
			destination,
			callee,
			thisRegister,
			specifier,
			...targetArguments,
			...candidateArguments,
		],
	});
	return destination;
}

function dynamicImportTargetPath(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	source: ESTree.Expression,
): string | undefined {
	if (source.type !== "Literal" || typeof source.value !== "string") {
		return undefined;
	}
	const record = program.semantic.graph?.modules.get(fn.semanticFile.path);
	return (
		record?.dependencies.find(
			(dependency) =>
				dependency.kind === "dynamic" && dependency.specifier === source.value,
		)?.resolvedPath ?? undefined
	);
}

function compileGlobalIndex(
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	index: number,
): number {
	const destination = nextCoreVariable(fn);
	cursor.block.emitter.emit({ type: "loadGlobalIndex", registers: [destination], index });
	return destination;
}

function getDynamicModuleStatusSlot(
	program: CoreFrontendContext,
	modulePath: string,
): number {
	let slot = program.dynamicModuleStatusSlot.get(modulePath);
	if (slot === undefined) {
		slot = program.nextGlobalIndex++;
		program.dynamicModuleStatusSlot.set(modulePath, slot);
	}
	return slot;
}

function getModuleEvaluationErrorSlot(
	program: CoreFrontendContext,
	modulePath: string,
): number {
	let slot = program.moduleEvaluationErrorSlot.get(modulePath);
	if (slot === undefined) {
		slot = program.nextGlobalIndex++;
		program.moduleEvaluationErrorSlot.set(modulePath, slot);
	}
	return slot;
}

function getDeferredModuleNamespaceSlot(
	program: CoreFrontendContext,
	modulePath: string,
): number {
	let slot = program.deferredModuleNamespaceSlot.get(modulePath);
	if (slot === undefined) {
		slot = program.nextGlobalIndex++;
		program.deferredModuleNamespaceSlot.set(modulePath, slot);
	}
	return slot;
}

function compileDynamicImport(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	callExpression: ESTree.CallExpression,
): number {
	const source = callExpression.arguments[0];
	return source
		? compileImportExpression(program, fn, cursor, source)
		: compileImportExpression(program, fn, cursor, {
				type: "Identifier",
				name: "undefined",
			});
}

function compileCall(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	callExpression: ESTree.CallExpression,
): number {
	const calleeNode = callExpression.callee as unknown as ESTree.Node;
	if ((calleeNode.type as string) === "Import") {
		return compileDynamicImport(program, fn, cursor, callExpression);
	}

	if (calleeNode.type === "Super") {
		return compileSuperCall(program, fn, cursor, callExpression);
	}

	// Direct eval — `eval(...)` where `eval` is the global (undeclared) binding.
	// The eval'd code must resolve free identifiers against the caller's scope, so
	// we marshal the visible bindings into a scope object and route through the
	// direct-eval intrinsic (which exposes the object as a with-scope). A spread
	// argument falls through to the ordinary (indirect-style) call.
	if (
		calleeNode.type === "Identifier" &&
		calleeNode.name === "eval" &&
		(fn.semanticFile.nodeToBinding.get(calleeNode)?.undeclared ?? false) &&
		callExpression.arguments.length > 0 &&
		!callExpression.arguments.some((arg) => arg.type === "SpreadElement")
	) {
		return compileDirectEval(program, fn, cursor, callExpression);
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
		thisRegister = member.receiver ?? member.object;
		callee = compileMemberLoad(fn, cursor, member);
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
		if (
			callExpression.arguments.length === 1 &&
			callExpression.arguments[0]?.type === "SpreadElement"
		) {
			const iterable = compileExpression(
				program,
				fn,
				cursor,
				callExpression.arguments[0].argument,
			);
			const destination = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "callSpreadIterable",
				registers: [destination, callee, thisRegister, iterable],
			});
			return destination;
		}
		const argumentsArray = compileSpreadArgumentsArray(
			program,
			fn,
			cursor,
			callExpression.arguments,
		);
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
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
	const arrayPredicate = tryCompileArrayPredicateCall(
		program,
		fn,
		cursor,
		calleeNode,
		callee,
		thisRegister,
		args,
		callExpression.arguments[0]?.type === "ArrowFunctionExpression" ||
			callExpression.arguments[0]?.type === "FunctionExpression",
	);
	if (arrayPredicate !== undefined) return arrayPredicate;
	const destination = nextCoreVariable(fn);

	cursor.block.emitter.emit({
		type: "call",
		registers: [destination, callee, thisRegister, ...args],
	});

	return destination;
}

function tryCompileArrayPredicateCall(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	calleeNode: ESTree.Node,
	callee: number,
	receiver: number,
	args: Array<number>,
	callbackIsKnownCallable: boolean,
): number | undefined {
	if (
		calleeNode.type !== "MemberExpression" ||
		calleeNode.property.type === "PrivateIdentifier" ||
		args.length < 1 ||
		args.length > 2
	) {
		return undefined;
	}
	const name =
		!calleeNode.computed && calleeNode.property.type === "Identifier"
			? calleeNode.property.name
			: undefined;
	if (name !== "every" && name !== "some") return undefined;

	const destination = nextCoreVariable(fn);
	const guard = nextCoreVariable(fn);
	const eligible = nextCoreVariable(fn);
	const undefinedValue = compileUndefined(fn, cursor);
	const methodId = compileNumberLiteral(fn, cursor, name === "some" ? 1 : 2);
	cursor.block.emitter.emit(
		{
			type: "loadIntrinsic",
			registers: [guard],
			intrinsic: "__arrayIterationEligible",
		},
		{
			type: "call",
			registers: [
				eligible,
				guard,
				undefinedValue,
				callee,
				receiver,
				methodId,
				callbackIsKnownCallable ? callee : args[0]!,
			],
		},
	);

	const fastJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [eligible],
		blocks: [-1],
	};
	const fallbackJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(fastJump, fallbackJump);

	const fallbackIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	const fallback = fn.blocks[fallbackIdx]!;
	fallback.emitter.emit({
		type: "call",
		registers: [destination, callee, receiver, ...args],
		guardedInlineFallback: true,
	});
	const fallbackJoin: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	fallback.emitter.emit(fallbackJoin);

	const fastIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	fastJump.blocks[0] = fastIdx;
	fallbackJump.blocks[0] = fallbackIdx;
	const fast = fn.blocks[fastIdx]!;
	const fastCursor = { block: fast };
	const lengthKey = compileStaticString(program, fn, fastCursor, "length");
	const length = nextCoreVariable(fn);
	const index = compileNumberLiteral(fn, fastCursor, 0);
	const one = compileNumberLiteral(fn, fastCursor, 1);
	fast.emitter.emit({
		type: "loadProperty",
		registers: [length, receiver, lengthKey],
	});
	const enterLoop: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	fast.emitter.emit(enterLoop);

	const headerIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	enterLoop.blocks[0] = headerIdx;
	const header = fn.blocks[headerIdx]!;
	const withinLength = nextCoreVariable(fn);
	header.emitter.emit({
		type: "binary",
		registers: [withinLength, index, length],
		operator: "<",
	});
	const bodyJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [withinLength],
		blocks: [-1],
	};
	const normalExitJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	header.emitter.emit(bodyJump, normalExitJump);

	const bodyIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	bodyJump.blocks[0] = bodyIdx;
	const body = fn.blocks[bodyIdx]!;
	const present = nextCoreVariable(fn);
	body.emitter.emit({
		type: "binary",
		registers: [present, index, receiver],
		operator: "in",
	});
	const invokeJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [present],
		blocks: [-1],
	};
	const skipJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	body.emitter.emit(invokeJump, skipJump);

	const invokeIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	invokeJump.blocks[0] = invokeIdx;
	const invoke = fn.blocks[invokeIdx]!;
	const element = nextCoreVariable(fn);
	const callbackResult = nextCoreVariable(fn);
	invoke.emitter.emit(
		{ type: "loadProperty", registers: [element, receiver, index] },
		{
			type: "call",
			registers: [
				callbackResult,
				args[0]!,
				args[1] ?? undefinedValue,
				element,
				index,
				receiver,
			],
		},
	);
	const stop = nextCoreVariable(fn);
	if (name === "every") {
		invoke.emitter.emit({
			type: "unary",
			registers: [stop, callbackResult],
			operator: "!",
		});
	} else {
		invoke.emitter.emit({ type: "move", registers: [stop, callbackResult] });
	}
	const earlyExitJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [stop],
		blocks: [-1],
	};
	const continueJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	invoke.emitter.emit(earlyExitJump, continueJump);

	const incrementIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	skipJump.blocks[0] = incrementIdx;
	continueJump.blocks[0] = incrementIdx;
	const increment = fn.blocks[incrementIdx]!;
	increment.emitter.emit(
		{ type: "binary", registers: [index, index, one], operator: "+" },
		{ type: "jump", blocks: [headerIdx] },
	);

	const normalExitIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	normalExitJump.blocks[0] = normalExitIdx;
	const normalExit = fn.blocks[normalExitIdx]!;
	normalExit.emitter.emit({
		type: "createBoolean",
		registers: [destination],
		value: name === "every",
	});
	const normalJoin: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	normalExit.emitter.emit(normalJoin);

	const earlyExitIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	earlyExitJump.blocks[0] = earlyExitIdx;
	const earlyExit = fn.blocks[earlyExitIdx]!;
	earlyExit.emitter.emit({
		type: "createBoolean",
		registers: [destination],
		value: name === "some",
	});
	const earlyJoin: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	earlyExit.emitter.emit(earlyJoin);

	const joinIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	fallbackJoin.blocks[0] = joinIdx;
	normalJoin.blocks[0] = joinIdx;
	earlyJoin.blocks[0] = joinIdx;
	cursor.block = fn.blocks[joinIdx]!;
	return destination;
}

/** Compile SuperCall with the active derived-constructor environment. */
function compileSuperCall(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
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
	const destination = nextCoreVariable(fn);
	if (fn.classContext?.superThisStateBinding && fn.classContext.superNewTargetBinding) {
		const newTarget = loadRegisterFromLocation(
			fn,
			cursor.block,
			getOrCreateBindingLocation(program, fn, fn.classContext.superNewTargetBinding),
		);
		const currentThis = loadSharedSuperThis(program, fn, cursor, false);
		cursor.block.emitter.emit({
			type: "move",
			registers: [destination, currentThis],
		});
		cursor.block.emitter.emit({
			type: "constructSuperExplicit",
			registers: [destination, parent, argumentsArray, newTarget, destination],
		});
		storeSharedSuperThis(program, fn, cursor, destination);

		if (fn.classContext.instanceInitializerBinding) {
			const initializer = loadRegisterFromLocation(
				fn,
				cursor.block,
				getOrCreateBindingLocation(
					program,
					fn,
					fn.classContext.instanceInitializerBinding,
				),
			);
			const ignored = nextCoreVariable(fn);
			cursor.block.emitter.emit({
				type: "call",
				registers: [ignored, initializer, destination],
			});
		}
		return destination;
	}
	cursor.block.emitter.emit({
		type: "constructSuper",
		registers: [destination, parent, argumentsArray],
	});

	// super() binds `this`; refresh the lexical-`this` cell (seeded EMPTY at entry)
	// so a nested arrow capturing `this` observes the bound instance.
	if (fn.lexicalThisBinding) {
		storeRegisterAtLocation(
			cursor.block,
			getOrCreateBindingLocation(program, fn, fn.lexicalThisBinding),
			destination,
		);
	}

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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
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
		callee = nextCoreVariable(fn);
		cursor.block.emitter.emit({ type: "createUndefined", registers: [callee] });
	}

	if (expression.arguments.some((arg) => arg.type === "SpreadElement")) {
		const argumentsArray = compileSpreadArgumentsArray(
			program,
			fn,
			cursor,
			expression.arguments,
		);
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
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
	const destination = nextCoreVariable(fn);

	cursor.block.emitter.emit({
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
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	identifier: ESTree.Identifier,
): number {
	if (identifierUsesDynamicEnvironment(program, fn, identifier)) {
		return compileWithDynamicRead(program, fn, cursor, identifier);
	}
	return compileStaticIdentifier(program, fn, cursor, identifier);
}

/**
 * A free (undeclared) identifier — one that resolves outside the unit being
 * compiled. In direct-eval mode these are routed through the with-dynamic path
 * so they probe the caller scope object before the global.
 */
function identifierIsFree(
	fn: CoreFrontendFunction,
	identifier: ESTree.Identifier,
): boolean {
	const binding = fn.semanticFile.nodeToBinding.get(identifier);
	return !binding || binding.undeclared === true;
}

function isDirectEvalVarBinding(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	identifier: ESTree.Identifier,
): boolean {
	const binding = fn.semanticFile.nodeToBinding.get(identifier);
	return binding ? isDirectEvalVarBindingValue(program, fn, binding) : false;
}

function isDirectEvalVarBindingValue(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	binding: Binding,
): boolean {
	if (
		!program.evalDirect ||
		fn.semanticFile.strict ||
		program.directEvalContext.varEnvironmentIsGlobal
	) {
		return false;
	}
	if (binding.kind !== "var" || binding.undeclared || binding.implicit) {
		return false;
	}
	return fn.semanticFile.scopes[0]?.bindings.includes(binding) ?? false;
}

function isNewDirectEvalVarBinding(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	identifier: ESTree.Identifier,
): boolean {
	return (
		isDirectEvalVarBinding(program, fn, identifier) &&
		!program.directEvalContext.varEnvironmentNames.includes(identifier.name)
	);
}

function identifierUsesDynamicEnvironment(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	identifier: ESTree.Identifier,
): boolean {
	return (
		fn.semanticFile.withDynamicNodes.has(identifier) ||
		directEvalFreeIdentifierUsesDynamicEnvironment(program, fn, identifier) ||
		isDirectEvalVarBinding(program, fn, identifier)
	);
}

function directEvalFreeIdentifierUsesDynamicEnvironment(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	identifier: ESTree.Identifier,
): boolean {
	return (
		program.evalDirect &&
		identifierIsFree(fn, identifier) &&
		(!program.directEvalContext.varEnvironmentIsGlobal ||
			program.directEvalContext.varConflictNames.includes(identifier.name) ||
			program.directEvalContext.varEnvironmentNames.includes(identifier.name))
	);
}

/**
 * A `with`-intercepted read: probe the active with-object(s) for the name; on a
 * miss (EMPTY sentinel) fall back to the static binding resolution. The two
 * paths join with the value in a single register.
 */
function compileWithDynamicRead(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	identifier: ESTree.Identifier,
): number {
	const result = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "withGet",
		registers: [result],
		nameStringIndex: getOrCreateStringConstant(program, identifier.name),
	});

	const emptyFlag = nextCoreVariable(fn);
	cursor.block.emitter.emit({ type: "isEmpty", registers: [emptyFlag, result] });

	const fallbackJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [emptyFlag],
		blocks: [-1],
	};
	const foundJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(fallbackJump, foundJump);

	// Miss: resolve the static binding into the same result register.
	const fallbackIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	cursor.block = fn.blocks[fallbackIdx]!;
	const staticValue = compileStaticIdentifier(program, fn, cursor, identifier);
	cursor.block.emitter.emit({ type: "move", registers: [result, staticValue] });
	const fallbackJoin: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(fallbackJoin);

	const joinIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	fallbackJump.blocks[0] = fallbackIdx;
	foundJump.blocks[0] = joinIdx;
	fallbackJoin.blocks[0] = joinIdx;
	cursor.block = fn.blocks[joinIdx]!;

	return result;
}

function compileWithDynamicTypeof(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	identifier: ESTree.Identifier,
): number {
	const result = nextCoreVariable(fn);
	const probe = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "withGet",
		registers: [probe],
		nameStringIndex: getOrCreateStringConstant(program, identifier.name),
	});
	const emptyFlag = nextCoreVariable(fn);
	cursor.block.emitter.emit({ type: "isEmpty", registers: [emptyFlag, probe] });

	const missJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [emptyFlag],
		blocks: [-1],
	};
	const hitJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(missJump, hitJump);

	// Hit: typeof the probed value.
	const hitIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	cursor.block = fn.blocks[hitIdx]!;
	cursor.block.emitter.emit({
		type: "unary",
		registers: [result, probe],
		operator: "typeof",
	});
	const hitJoin: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(hitJoin);

	const missIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	cursor.block = fn.blocks[missIdx]!;
	cursor.block.emitter.emit({
		type: "globalBindingQuery",
		registers: [result],
		nameStringIndex: getOrCreateStringConstant(program, identifier.name),
		query: "typeof",
	});
	const missJoin: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(missJoin);

	const joinIdx = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	missJump.blocks[0] = missIdx;
	hitJump.blocks[0] = hitIdx;
	hitJoin.blocks[0] = joinIdx;
	missJoin.blocks[0] = joinIdx;
	cursor.block = fn.blocks[joinIdx]!;

	return result;
}

function compileStaticIdentifier(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	identifier: ESTree.Identifier,
): number {
	if (identifier.name === "undefined") {
		return compileUndefined(fn, cursor);
	}

	const binding = fn.semanticFile.nodeToBinding.get(identifier);
	if (!binding) {
		return -1;
	}
	retainHostGlobal(program, binding);

	if (binding.undeclared && identifierLoadsIntrinsic(program, identifier.name)) {
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "loadIntrinsic",
			registers: [destination],
			intrinsic: identifier.name,
		});
		return destination;
	}

	if (binding.implicit === "arguments") {
		if (fn.semanticFile.lazyArgumentsBindings.has(binding)) {
			return loadLazyArgumentsObject(program, fn, cursor, binding);
		}
		// Direct reads use the local slot and arrow reads use the captured slot, so
		// assignment is observed consistently in both cases.
		const location = getOrCreateBindingLocation(program, fn, binding);
		return loadRegisterFromLocation(fn, cursor.block, location);
	}

	if (binding.undeclared) {
		// Bindings from earlier scripts are unavailable to this compilation and resolve at runtime.
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "loadGlobalProperty",
			registers: [destination],
			nameStringIndex: getOrCreateStringConstant(program, identifier.name),
		});

		return destination;
	}

	const location = getOrCreateBindingLocation(program, fn, binding);
	const destination = loadRegisterFromLocation(fn, cursor.block, location);

	emitTdzGuard(program, fn, cursor.block, binding, destination);

	return destination;
}

function loadLazyArgumentsObject(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	binding: Binding,
): number {
	const location = getOrCreateBindingLocation(program, fn, binding);
	const result = loadRegisterFromLocation(fn, cursor.block, location);
	const missing = nextCoreVariable(fn);
	cursor.block.emitter.emit({ type: "isEmpty", registers: [missing, result] });

	const materializeJump: Extract<CompilerInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [missing],
		blocks: [-1],
	};
	const readyJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(materializeJump, readyJump);

	const materializeIndex = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	cursor.block = fn.blocks[materializeIndex]!;
	cursor.block.emitter.emit({ type: "createArgumentsObject", registers: [result] });
	storeRegisterAtLocation(cursor.block, location, result);
	const materializedJump: Extract<CompilerInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.emitter.emit(materializedJump);

	const readyIndex = fn.blocks.push({ emitter: unboundCoreEmitter }) - 1;
	materializeJump.blocks[0] = materializeIndex;
	readyJump.blocks[0] = readyIndex;
	materializedJump.blocks[0] = readyIndex;
	cursor.block = fn.blocks[readyIndex]!;
	return result;
}

/** Mark a reachable free Node global and keep it on globalThis storage. */
function retainHostGlobal(program: CoreFrontendContext, binding: Binding): boolean {
	if (
		program.hostProcess &&
		binding.undeclared &&
		(binding.name === "process" ||
			binding.name === "global" ||
			binding.name === "TextEncoder" ||
			binding.name === "TextDecoder")
	) {
		program.hostProcess.retained = true;
		return true;
	}
	if (program.hostBuffer && binding.undeclared && binding.name === "Buffer") {
		program.hostBuffer.retained = true;
		return true;
	}
	return false;
}

function globalPropertyLocation(
	program: CoreFrontendContext,
	name: string,
): BindingLocation {
	return {
		type: "globalProperty",
		nameStringIndex: getOrCreateStringConstant(program, name),
	};
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
 * Whether accessing this binding must guard against the temporal dead zone.
 * Mirrors the read-side condition in compileStaticIdentifier: a lexical binding
 * whose slot may still hold EMPTY, or any binding reached while compiling a
 * parameter default (an earlier-declared parameter is initialized, a later one
 * is not, and only the runtime EMPTY check can tell them apart).
 */
function bindingNeedsTdzGuard(fn: CoreFrontendFunction, binding: Binding): boolean {
	return (
		!binding.undeclared && (isTdzBinding(binding) || (fn.inParameterExpression ?? false))
	);
}

/**
 * PutValue → SetMutableBinding on a still-uninitialized lexical binding is a
 * ReferenceError, and the spec runs that check before the const-immutability
 * TypeError. Guard the value already loaded from the binding's slot — the read a
 * compound/update/logical form performs anyway — so the check reuses that load.
 * A no-op once the slot holds a real value.
 */
function emitTdzGuard(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	binding: Binding,
	current: number,
) {
	if (!bindingNeedsTdzGuard(fn, binding)) {
		return;
	}
	block.emitter.emit({
		type: "throwIfTdz",
		registers: [current],
		nameStringIndex: getOrCreateStringConstant(program, binding.name),
	});
}

/**
 * The same guard for a write path that does not otherwise read the target (a
 * plain `=` or a destructuring-assignment leaf): load the current slot value
 * purely to check the EMPTY sentinel before the store. The load is deferred past
 * the predicate so an undeclared binding never allocates a slot.
 */
function emitWriteTdzGuard(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	binding: Binding,
	hostGlobalLocation: BindingLocation | null,
) {
	if (!bindingNeedsTdzGuard(fn, binding)) {
		return;
	}
	const location = hostGlobalLocation ?? getOrCreateBindingLocation(program, fn, binding);
	emitTdzGuard(
		program,
		fn,
		block,
		binding,
		loadRegisterFromLocation(fn, block, location),
	);
}

/**
 * Build an ES module namespace exotic object for `import * as ns from "m"` and
 * store it into the local binding. The runtime serves each export live from its
 * global slot (with TDZ enforcement) plus a @@toStringTag of "Module"; names
 * arrive already sorted from the linker. Exporters are module-top-level (global)
 * bindings; any that somehow are not are skipped.
 */
function emitDeferredModuleNamespaceInits(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
): void {
	const files = new Map(program.semantic.files.map((file) => [file.path, file]));
	const initialized = new Set<string>();
	for (const imports of program.namespaceImports.values()) {
		for (const namespaceImport of imports) {
			if (!namespaceImport.deferred || initialized.has(namespaceImport.module)) continue;
			initialized.add(namespaceImport.module);
			const target = files.get(namespaceImport.module);
			if (!target || target.commonjs) continue;

			const targetIndex = compileFileInit(program, target);
			const namespace = emitNamespaceObjectRegister(
				program,
				fn,
				block,
				namespaceImport.exports,
			);
			const initFn =
				targetIndex >= 0 ? nextCoreVariable(fn) : compileUndefined(fn, { block });
			if (targetIndex >= 0) {
				block.emitter.emit({
					type: "createFunction",
					registers: [initFn],
					functionIndex: targetIndex,
				});
			}
			const callee = nextCoreVariable(fn);
			block.emitter.emit({
				type: "loadIntrinsic",
				registers: [callee],
				intrinsic: "__configureDeferredNamespace",
			});
			const cursor = { block };
			const configured = nextCoreVariable(fn);
			block.emitter.emit({
				type: "call",
				registers: [
					configured,
					callee,
					compileUndefined(fn, cursor),
					namespace,
					initFn,
					compileGlobalIndex(
						fn,
						cursor,
						getDynamicModuleStatusSlot(program, namespaceImport.module),
					),
					compileGlobalIndex(
						fn,
						cursor,
						getModuleEvaluationErrorSlot(program, namespaceImport.module),
					),
				],
			});
			block.emitter.emit({
				type: "storeGlobal",
				registers: [namespace],
				index: getDeferredModuleNamespaceSlot(program, namespaceImport.module),
			});
		}
	}
}

function emitNamespaceObject(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	binding: Binding,
	exports: Array<{ name: string; exporter: Binding }>,
	modulePath: string,
) {
	const namespace = emitNamespaceObjectRegister(program, fn, block, exports, modulePath);
	const location = getOrCreateBindingLocation(program, fn, binding);
	storeRegisterAtLocation(block, location, namespace);
}

function emitNamespaceObjectRegister(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	exports: Array<{ name: string; exporter: Binding }>,
	modulePath?: string,
): number {
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

	let cacheSlot = -1;
	if (modulePath !== undefined) {
		const existing = program.moduleNamespaceSlot.get(modulePath);
		cacheSlot = existing ?? program.nextGlobalIndex++;
		program.moduleNamespaceSlot.set(modulePath, cacheSlot);
	}
	const namespace = nextCoreVariable(fn);
	block.emitter.emit({
		type: "createModuleNamespace",
		cacheSlot,
		registers: [namespace],
		exports: entries,
	});

	return namespace;
}

function loadRegisterFromLocation(
	fn: CoreFrontendFunction,
	block: CoreFrontendBlock,
	location: BindingLocation,
) {
	const destination = nextCoreVariable(fn);
	switch (location.type) {
		case "local": {
			block.emitter.emit({
				type: "loadLocal",
				registers: [destination],
				index: location.index,
			});
			break;
		}
		case "global": {
			block.emitter.emit({
				type: "loadGlobal",
				registers: [destination],
				index: location.index,
			});
			break;
		}
		case "captured": {
			block.emitter.emit({
				type: "loadCaptured",
				registers: [destination],

				functionIndex: location.functionIndex,
				index: location.index,
			});
			break;
		}
		case "globalProperty": {
			block.emitter.emit({
				type: "loadGlobalProperty",
				registers: [destination],
				nameStringIndex: location.nameStringIndex,
			});
			break;
		}
	}

	return destination;
}

function getArgumentsBinding(
	fn: CoreFrontendFunction,
	node:
		| ESTree.FunctionDeclaration
		| ESTree.FunctionExpression
		| ESTree.ArrowFunctionExpression,
) {
	if (node.type === "ArrowFunctionExpression") {
		return undefined;
	}

	const scope = fn.semanticFile.nodeToScope.get(node);
	const implicit = scope?.bindings.find((binding) => binding.implicit === "arguments");
	if (implicit) {
		return implicit;
	}

	// An explicit `var arguments` reuses the function's arguments-object binding;
	// a parameter or named-function self binding named arguments shadows it.
	const parameterNodes = new Set<ESTree.Node>(node.params);
	if (
		scope?.bindings.some(
			(binding) =>
				binding.name === "arguments" &&
				binding.declarationNode !== undefined &&
				parameterNodes.has(binding.declarationNode),
		)
	) {
		return undefined;
	}
	const explicit = scope?.bindings.find(
		(binding) =>
			binding.name === "arguments" &&
			binding.kind === "var" &&
			binding.declarationNode !== node &&
			(!binding.declarationNode || !parameterNodes.has(binding.declarationNode)),
	);
	if (explicit) {
		return explicit;
	}

	const bodyScope =
		node.body?.type === "BlockStatement"
			? fn.semanticFile.nodeToScope.get(node.body)
			: undefined;
	return bodyScope?.bindings.find(
		(binding) => binding.name === "arguments" && binding.kind === "var",
	);
}

/**
 * The implicit lexical-`this` binding a non-arrow function exposes for nested
 * arrows to capture, or undefined. Arrows never own one (they inherit `this`).
 */
function getLexicalThisBinding(
	fn: CoreFrontendFunction,
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

/**
 * The implicit lexical-`new.target` binding a non-arrow function exposes for
 * nested arrows to capture, or undefined. Arrows never own one.
 */
function getLexicalNewTargetBinding(
	fn: CoreFrontendFunction,
	node:
		| ESTree.FunctionDeclaration
		| ESTree.FunctionExpression
		| ESTree.ArrowFunctionExpression,
) {
	if (node.type === "ArrowFunctionExpression") {
		return undefined;
	}

	const scope = fn.semanticFile.nodeToScope.get(node);
	return scope?.bindings.find((binding) => binding.implicit === "new.target");
}

function compileLiteral(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
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
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "createF64",
			registers: [destination],
			value: literal.value,
		});

		return destination;
	}

	if (typeof literal.value === "boolean") {
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "createBoolean",
			registers: [destination],
			value: literal.value,
		});

		return destination;
	}

	if (typeof literal.value === "string") {
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "createString",
			registers: [destination],
			stringIndex: getOrCreateStringConstant(program, literal.value),
		});

		return destination;
	}

	if (typeof literal.value === "bigint") {
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "createBigint",
			registers: [destination],
			bigintIndex: getOrCreateBigintConstant(program, literal.value),
		});

		return destination;
	}

	if (literal.value === null) {
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
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
		const constructor = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "loadIntrinsic",
			registers: [constructor],
			intrinsic: "RegExp",
		});
		const patternReg = compileStaticString(program, fn, cursor, literal.regex.pattern);
		const flagsReg = compileStaticString(program, fn, cursor, literal.regex.flags);
		const destination = nextCoreVariable(fn);
		cursor.block.emitter.emit({
			type: "construct",
			registers: [destination, constructor, patternReg, flagsReg],
		});

		return destination;
	}

	return -1;
}

function compileUndefined(fn: CoreFrontendFunction, cursor: CoreFrontendCursor) {
	const destination = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createUndefined",
		registers: [destination],
	});

	return destination;
}

function compileNumberLiteral(
	fn: CoreFrontendFunction,
	cursor: CoreFrontendCursor,
	value: number,
) {
	const destination = nextCoreVariable(fn);
	cursor.block.emitter.emit({
		type: "createNumber",
		registers: [destination],

		value,
	});

	return destination;
}

export function getOrCreateStringConstant(program: CoreFrontendContext, value: string) {
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
	program: CoreFrontendContext,
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
	program: CoreFrontendContext,
	line: number,
	column: number,
	inlinedFunctionIndex: number,
	callerPosId: number,
): number {
	return (
		program.sourcePositions.push({ line, column, inlinedFunctionIndex, callerPosId }) - 1
	);
}

/**
 * Emit a source-position marker for `node` into `block`. A no-op when the node
 * carries no location (synthesized nodes). The marker sets the source position
 * inherited by every following instruction until the next marker.
 */
function emitSourcePos(
	program: CoreFrontendContext,
	block: CoreFrontendBlock,
	node: ESTree.Node,
): void {
	const loc = node.loc;
	if (!loc) {
		return;
	}

	block.emitter.emit({
		type: "sourcePos",
		pos: getOrCreateSourcePosition(program, loc.start.line, loc.start.column),
	});
}

function getOrCreateBigintConstant(program: CoreFrontendContext, value: bigint) {
	const existing = program.bigintConstantToIndex.get(value);
	if (existing !== undefined) {
		return existing;
	}

	const index = program.bigintConstants.push(value) - 1;
	program.bigintConstantToIndex.set(value, index);
	return index;
}

/** Allocate a logical variable; the Core constructor resolves it to SSA values. */
function nextCoreVariable(fn: CoreFrontendFunction) {
	return fn.nextCoreVariable++;
}

/**
 * Get or create a binding location.
 * We use incremental indices to assign unique locations to bindings. Memoizing the location
 * per binding.
 */
function getOrCreateBindingLocation(
	program: CoreFrontendContext,
	fn: CoreFrontendFunction,
	binding: Binding,
) {
	if (binding.undeclared && !compilerPrivateIntrinsics.has(binding.name)) {
		return globalPropertyLocation(program, binding.name);
	}
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
				if (isScriptGlobalProperty(program, fn.semanticFile, binding)) {
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
	block: CoreFrontendBlock,
	location: BindingLocation,
	register: number,
) {
	switch (location.type) {
		case "local": {
			block.emitter.emit({
				type: "storeLocal",
				registers: [register],
				index: location.index,
			});
			break;
		}
		case "global": {
			block.emitter.emit({
				type: "storeGlobal",
				registers: [register],
				index: location.index,
			});
			break;
		}
		case "captured": {
			block.emitter.emit({
				type: "storeCaptured",
				registers: [register],

				functionIndex: location.functionIndex,
				index: location.index,
			});
			break;
		}
		case "globalProperty": {
			block.emitter.emit({
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
