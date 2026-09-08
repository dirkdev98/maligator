import {
	CORE_MEMORY_FAMILY_DOMAINS,
	CORE_NO_EFFECTS,
	CoreOpcodeRegistry,
	coreArity,
} from "./core-ir.ts";
import type {
	CoreAccessMode,
	CoreEffectDomain,
	CoreInstructionEffects,
	CoreInstructionId,
	CoreMemoryFamily,
	CoreOpcodeAccess,
	CoreOpcodeAllocation,
	CoreOpcodeCallTransfer,
	CoreOpcodeId,
} from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

/**
 * Canonical Core operations. Control flow, exception entry, and source-position
 * markers are structural Core concepts and therefore cannot appear as opcodes.
 */
export const CORE_OPCODES = [
	"arrayRest",
	"asyncStart",
	"await",
	"binary",
	"call",
	"callBuiltin",
	"callLiteralMethod",
	"callSpread",
	"callSpreadIterable",
	"callRestArguments",
	"checkSuperClass",
	"construct",
	"constructSpread",
	"constructSuper",
	"constructSuperExplicit",
	"copyDataProperties",
	"createArgumentsObject",
	"createArray",
	"createBigint",
	"createBoolean",
	"createEmpty",
	"createF64",
	"createFunction",
	"createModuleNamespace",
	"createNull",
	"createNumber",
	"createObject",
	"createObjectShaped",
	"createPrivateName",
	"createPrivateNames",
	"createRestArguments",
	"createString",
	"createTemplateObject",
	"createUndefined",
	"defineAccessor",
	"definePrivate",
	"defineProperty",
	"deleteProperty",
	"envCopy",
	"envPop",
	"envPush",
	"forInKeys",
	"generatorStart",
	"getAsyncIterator",
	"getIterator",
	"guardFunctionIndex",
	"hasPrivate",
	"declareGlobalLexical",
	"globalBindingQuery",
	"initGlobalVars",
	"initPrivateFields",
	"instantiateLiteralTemplate",
	"isEmpty",
	"iteratorClose",
	"iteratorNext",
	"iteratorStep",
	"loadArgument",
	"loadArgumentCount",
	"loadCallee",
	"loadCaptured",
	"loadGlobalIndex",
	"loadGlobal",
	"loadGlobalProperty",
	"loadIntrinsic",
	"loadLocal",
	"loadNewTarget",
	"loadPrivate",
	"loadProperty",
	"loadPropertyStaticShapeCase",
	"loadPropertyStatic",
	"loadPrototype",
	"loadStaticArgument",
	"loadSuperProperty",
	"loadThis",
	"loadUndeclared",
	"mathBinaryNumber",
	"mathUnaryNumber",
	"mergeDataProperties",
	"move",
	"requireCoercible",
	"rootUse",
	"setFunctionName",
	"setPrototype",
	"setThis",
	"selectShapeCase",
	"storeCaptured",
	"storeGlobal",
	"storeGlobalProperty",
	"storeLocal",
	"storePrivate",
	"storeProperty",
	"storePropertyStatic",
	"storeSuperProperty",
	"throwIfTdz",
	"toPropertyKey",
	"typeofCompare",
	"unary",
	"withEnter",
	"withExit",
	"withGet",
	"withResolveBase",
	"withSet",
	"yield",
] as const;

export type CoreOpcode = (typeof CORE_OPCODES)[number];

const NO_OUTPUT = new Set<CoreOpcode>([
	"declareGlobalLexical",
	"asyncStart",
	"checkSuperClass",
	"createPrivateNames",
	"defineAccessor",
	"definePrivate",
	"defineProperty",
	"envCopy",
	"envPop",
	"envPush",
	"generatorStart",
	"initGlobalVars",
	"initPrivateFields",
	"iteratorClose",
	"mergeDataProperties",
	"requireCoercible",
	"rootUse",
	"setFunctionName",
	"setPrototype",
	"setThis",
	"storeCaptured",
	"storeGlobal",
	"storeGlobalProperty",
	"storeLocal",
	"storePrivate",
	"storeProperty",
	"storePropertyStatic",
	"storeSuperProperty",
	"throwIfTdz",
	"withEnter",
	"withExit",
]);

const TWO_OUTPUTS = new Set<CoreOpcode>([
	"await",
	"getAsyncIterator",
	"getIterator",
	"iteratorStep",
	"loadStaticArgument",
	"yield",
]);

const GC_FREE = new Set<CoreOpcode>([
	"createBoolean",
	"createEmpty",
	"createF64",
	"createNull",
	"createNumber",
	"createUndefined",
	"guardFunctionIndex",
	"selectShapeCase",
	"isEmpty",
	"loadCaptured",
	"loadGlobalIndex",
	"loadGlobal",
	"loadIntrinsic",
	"loadLocal",
	"loadNewTarget",
	"mathBinaryNumber",
	"mathUnaryNumber",
	"move",
	"rootUse",
	"setThis",
	"storeCaptured",
	"storeGlobal",
	"storeLocal",
	"typeofCompare",
	"withExit",
]);

const NO_THROW = new Set<CoreOpcode>([
	...GC_FREE,
	// The async prologue allocates its hidden state and result promise but keeps
	// executing synchronously and cannot surface a JavaScript throw.
	"asyncStart",
	"createArray",
	"createBigint",
	"createFunction",
	"createModuleNamespace",
	"createObject",
	"createObjectShaped",
	"createString",
	"createTemplateObject",
	"initGlobalVars",
	"loadArgument",
	"loadArgumentCount",
	"loadCallee",
	"mathBinaryNumber",
	"mathUnaryNumber",
]);

const CALLS_USER_CODE = new Set<CoreOpcode>([
	"arrayRest",
	"binary",
	"call",
	"callBuiltin",
	"callLiteralMethod",
	"callSpread",
	"callSpreadIterable",
	"callRestArguments",
	"checkSuperClass",
	"construct",
	"constructSpread",
	"constructSuper",
	"constructSuperExplicit",
	"copyDataProperties",
	"defineAccessor",
	"definePrivate",
	"defineProperty",
	"deleteProperty",
	"forInKeys",
	// GetPrototypeFromConstructor reads the mutable callee.prototype property.
	"generatorStart",
	"getAsyncIterator",
	"getIterator",
	"hasPrivate",
	"initPrivateFields",
	"iteratorClose",
	"iteratorNext",
	"iteratorStep",
	"loadGlobalProperty",
	"globalBindingQuery",
	"loadPrivate",
	"loadProperty",
	"loadPropertyStatic",
	"loadPropertyStaticShapeCase",
	"loadPrototype",
	"loadSuperProperty",
	"mergeDataProperties",
	"requireCoercible",
	"setFunctionName",
	"setPrototype",
	"storeGlobalProperty",
	"storePrivate",
	"storeProperty",
	"storePropertyStatic",
	"storeSuperProperty",
	"toPropertyKey",
	"unary",
	"withEnter",
	"withGet",
	"withResolveBase",
	"withSet",
]);

const DISCARDABLE = new Set<CoreOpcode>([
	"createBigint",
	"createBoolean",
	"createEmpty",
	"createF64",
	"createFunction",
	"createNull",
	"createNumber",
	"createString",
	"createUndefined",
	// Validated templates allocate private data; unused results cannot expose the cache slot.
	"instantiateLiteralTemplate",
	"guardFunctionIndex",
	"selectShapeCase",
	"isEmpty",
	"loadCaptured",
	"loadGlobalIndex",
	"loadGlobal",
	"loadIntrinsic",
	"loadLocal",
	"loadNewTarget",
	"mathBinaryNumber",
	"mathUnaryNumber",
	"move",
	"typeofCompare",
]);

const read = (
	family: CoreMemoryFamily,
	rest: Omit<CoreOpcodeAccess, "family" | "mode"> = {},
) => ({ family, mode: "read", ...rest }) as const satisfies CoreOpcodeAccess;

const write = (
	family: CoreMemoryFamily,
	rest: Omit<CoreOpcodeAccess, "family" | "mode"> = {},
) => ({ family, mode: "write", ...rest }) as const satisfies CoreOpcodeAccess;

/**
 * The single declaration of which memory each opcode names. Effect domains are
 * derived from this table, so a new memory operation cannot declare an effect
 * domain and a location that disagree, and no pass needs its own opcode switch
 * to recognize a load or a store.
 *
 * Heap families are named without a base until the alias oracle can prove two
 * bases distinct; `baseOperand` and `keyAttribute` are recorded where the operand
 * order is unambiguous so that oracle has them, and are ignored by the current
 * whole-family partitioning.
 */
const OPCODE_ACCESSES = {
	// The callee is implicit in the activation rather than an SSA operand.
	generatorStart: [read("prototype")],
	// Operation-specific refinements narrow this conservative receiver-state envelope.
	callLiteralMethod: [
		read("object-slot", { baseOperand: 0 }),
		write("object-slot", { baseOperand: 0 }),
	],
	callBuiltin: [
		read("object-slot", { baseOperand: 0 }),
		write("object-slot", { baseOperand: 0 }),
	],
	loadLocal: [read("local-slot", { attributes: ["index"] })],
	storeLocal: [write("local-slot", { attributes: ["index"], valueOperand: 0 })],
	loadCaptured: [read("captured-slot", { attributes: ["functionIndex", "index"] })],
	storeCaptured: [
		write("captured-slot", {
			attributes: ["functionIndex", "index"],
			valueOperand: 0,
		}),
	],
	// A scope-chain edit rebinds every captured cell reachable from this activation.
	envPush: [write("captured-slot")],
	envCopy: [write("captured-slot")],
	envPop: [write("captured-slot")],
	createPrivateNames: [write("captured-slot")],
	loadThis: [read("activation-this")],
	setThis: [write("activation-this", { valueOperand: 0 })],
	constructSuper: [write("activation-this")],
	constructSuperExplicit: [write("activation-this")],
	loadGlobal: [read("global-slot", { attributes: ["index"] })],
	storeGlobal: [write("global-slot", { attributes: ["index"], valueOperand: 0 })],
	initGlobalVars: [write("global-slot")],
	declareGlobalLexical: [read("global-slot"), write("global-property")],
	globalBindingQuery: [
		read("global-slot"),
		read("global-property"),
		write("global-property"),
	],
	// Namespace exports remain live reads; the cached object preserves namespace identity.
	createModuleNamespace: [
		read("global-slot"),
		write("global-slot", { attributes: ["cacheSlot"] }),
	],
	// A reusable literal publishes its fully constructed tree to a private slot on first use.
	instantiateLiteralTemplate: [
		read("global-slot", { attributes: ["cacheSlot"] }),
		write("global-slot", { attributes: ["cacheSlot"] }),
	],
	// Tagged templates expose the identity stored in their dedicated per-site slot.
	createTemplateObject: [
		read("global-slot", { attributes: ["cacheSlot"] }),
		write("global-slot", { attributes: ["cacheSlot"] }),
	],
	loadGlobalProperty: [
		read("global-slot"),
		read("global-property", { keyAttribute: "nameStringIndex" }),
	],
	storeGlobalProperty: [
		write("global-slot"),
		write("global-property", {
			keyAttribute: "nameStringIndex",
			valueOperand: 0,
		}),
	],
	loadProperty: [read("object-slot", { baseOperand: 0, keyOperand: 1 })],
	loadPropertyStatic: [
		read("object-slot", { baseOperand: 0, keyAttribute: "stringIndex" }),
	],
	loadPropertyStaticShapeCase: [
		read("object-slot", { baseOperand: 0, keyAttribute: "stringIndex" }),
	],
	storeProperty: [
		write("object-slot", { baseOperand: 0, keyOperand: 1, valueOperand: 2 }),
	],
	storePropertyStatic: [
		write("object-slot", {
			baseOperand: 0,
			keyAttribute: "stringIndex",
			valueOperand: 1,
		}),
	],
	loadPrototype: [read("prototype", { baseOperand: 0 })],
	setPrototype: [write("prototype", { baseOperand: 0, valueOperand: 1 })],
	deleteProperty: [
		write("object-slot", { baseOperand: 0, keyOperand: 1 }),
		write("shape", { baseOperand: 0, keyOperand: 1 }),
	],
	defineProperty: [
		write("object-slot", {
			baseOperand: 0,
			keyOperand: 1,
			valueOperand: 2,
			establishesOwnDataSlot: true,
		}),
		write("shape", { baseOperand: 0, keyOperand: 1 }),
	],
	defineAccessor: [
		write("object-slot", { baseOperand: 0, keyOperand: 1, valueOperand: 2 }),
		write("shape", { baseOperand: 0, keyOperand: 1 }),
	],
	definePrivate: [write("object-slot"), write("shape")],
	initPrivateFields: [write("object-slot"), write("shape")],
	copyDataProperties: [write("object-slot"), write("shape")],
	mergeDataProperties: [write("object-slot"), write("shape")],
	hasPrivate: [read("object-slot")],
	loadPrivate: [read("object-slot")],
	storePrivate: [write("object-slot")],
	loadSuperProperty: [read("object-slot")],
	storeSuperProperty: [write("object-slot")],
	withGet: [read("object-slot")],
	withResolveBase: [read("object-slot")],
	withSet: [write("object-slot")],
} as const satisfies Partial<Record<CoreOpcode, ReadonlyArray<CoreOpcodeAccess>>>;

/**
 * Fresh aggregates whose own data slots Core knows without asking the runtime.
 * The frontend only emits `createObjectShaped` for a literal made entirely of
 * static, non-index, non-`__proto__`, unique data properties, so every declared
 * key is an own writable data slot of an ordinary object from the moment it
 * exists — the property that lets an analysis skip a prototype walk.
 */
const OPCODE_ALLOCATIONS = {
	createObjectShaped: {
		kind: "named-slots",
		keysAttribute: "keyStringIndices",
		firstValueOperand: 0,
	},
	createArray: {
		kind: "indexed",
		lengthAttribute: "length",
		initialElements: "none",
	},
} as const satisfies Partial<Record<CoreOpcode, CoreOpcodeAllocation>>;

/**
 * The single declaration of which operand each opcode enters as a callable and
 * how its result relates to what that callable returned. Every consumer that
 * needs a call — the callee-target lattice, the interprocedural call graph —
 * reads this table, so an opcode cannot be a call for one of them and not the
 * other, and a newly added control transfer is not a call anywhere until it is
 * declared here.
 *
 * Builtin and literal-method calls name their callee in attributes rather than
 * operands, so they do not transfer script-function targets.
 */
const OPCODE_CALL_TRANSFERS = {
	callRestArguments: {
		calleeOperand: 0,
		result: "call-completion",
		invocation: "call",
		receiverOperand: 1,
		arguments: { kind: "activation" },
	},
	call: {
		calleeOperand: 0,
		result: "call-completion",
		invocation: "call",
		receiverOperand: 1,
		arguments: { kind: "positional", firstOperand: 2 },
	},
	callSpread: {
		calleeOperand: 0,
		result: "call-completion",
		invocation: "call",
		receiverOperand: 1,
		arguments: { kind: "aggregate", operand: 2 },
	},
	callSpreadIterable: {
		calleeOperand: 0,
		result: "call-completion",
		invocation: "call",
		receiverOperand: 1,
		arguments: { kind: "aggregate", operand: 2 },
	},
	construct: {
		calleeOperand: 0,
		result: "construct-completion",
		invocation: "construct",
		arguments: { kind: "positional", firstOperand: 1 },
	},
	constructSpread: {
		calleeOperand: 0,
		result: "construct-completion",
		invocation: "construct",
		arguments: { kind: "aggregate", operand: 1 },
	},
	// Super construction enters the parent and binds the object it produces as
	// `this`, so its result is a [[Construct]] completion like any other. It stays
	// unmodeled because the interesting half of the chain is elsewhere: a derived
	// constructor's own completion substitutes this object without any Core value
	// naming it, and modeling one end while the other is conservative buys
	// nothing.
	constructSuper: {
		calleeOperand: 0,
		result: "unmodeled",
		invocation: "construct",
		arguments: { kind: "aggregate", operand: 1 },
	},
	constructSuperExplicit: {
		calleeOperand: 0,
		result: "unmodeled",
		invocation: "construct",
		arguments: { kind: "aggregate", operand: 1 },
	},
} as const satisfies Partial<Record<CoreOpcode, CoreOpcodeCallTransfer>>;

function opcodeCallTransfer(opcode: CoreOpcode): CoreOpcodeCallTransfer | undefined {
	return (OPCODE_CALL_TRANSFERS as Partial<Record<CoreOpcode, CoreOpcodeCallTransfer>>)[
		opcode
	];
}

/** Operands inspected without anything retaining the reference passed in. */
const OBSERVES_OPERANDS = new Set<CoreOpcode>([
	"isEmpty",
	"move",
	"rootUse",
	"throwIfTdz",
	"typeofCompare",
]);

/**
 * Opcodes whose result `CanBeHeldWeakly` rejects, so no `WeakRef` or
 * `FinalizationRegistry` can observe when it becomes unreachable.
 *
 * `binary` and `unary` are here because no JavaScript operator evaluates to an
 * object or a symbol: every arithmetic, bitwise, comparison, `typeof`, `void`,
 * `delete`, and increment result is a number, string, bigint, boolean,
 * `undefined`, or `null`. Well-known symbols are deliberately excluded — the
 * registry rejects only symbols with a global-registry key, so `Symbol.iterator`
 * can be held weakly and `loadIntrinsic` therefore cannot join this set.
 */
const RESULT_CANNOT_BE_HELD_WEAKLY = new Set<CoreOpcode>([
	"binary",
	"createBigint",
	"createBoolean",
	"createEmpty",
	"createF64",
	"createNull",
	"createNumber",
	"createString",
	"createUndefined",
	"guardFunctionIndex",
	"isEmpty",
	"loadArgumentCount",
	"mathBinaryNumber",
	"mathUnaryNumber",
	"selectShapeCase",
	"typeofCompare",
	"unary",
]);

function opcodeAllocation(opcode: CoreOpcode): CoreOpcodeAllocation | undefined {
	return (OPCODE_ALLOCATIONS as Partial<Record<CoreOpcode, CoreOpcodeAllocation>>)[
		opcode
	];
}

function opcodeAccesses(opcode: CoreOpcode): ReadonlyArray<CoreOpcodeAccess> {
	return (
		(OPCODE_ACCESSES as Partial<Record<CoreOpcode, ReadonlyArray<CoreOpcodeAccess>>>)[
			opcode
		] ?? []
	);
}

const INPUT_ARITIES = {
	arrayRest: [1, 1],
	asyncStart: [0, 0],
	await: [1, 1],
	binary: [2, 2],
	call: [2, 65_535],
	callBuiltin: [1, 65_535],
	callLiteralMethod: [1, 65_535],
	callSpread: [3, 3],
	callSpreadIterable: [3, 3],
	callRestArguments: [3, 3],
	checkSuperClass: [1, 1],
	construct: [1, 65_535],
	constructSpread: [2, 2],
	constructSuper: [2, 2],
	constructSuperExplicit: [4, 4],
	copyDataProperties: [1, 65_535],
	createArgumentsObject: [0, 0],
	createArray: [0, 0],
	createBigint: [0, 0],
	createBoolean: [0, 0],
	createEmpty: [0, 0],
	createF64: [0, 0],
	createFunction: [0, 0],
	createModuleNamespace: [0, 0],
	createNull: [0, 0],
	createNumber: [0, 0],
	createObject: [0, 65_535],
	createObjectShaped: [0, 65_535],
	createPrivateName: [0, 0],
	createPrivateNames: [0, 0],
	createRestArguments: [0, 0],
	createString: [0, 0],
	createTemplateObject: [0, 0],
	createUndefined: [0, 0],
	defineAccessor: [3, 3],
	definePrivate: [3, 3],
	defineProperty: [3, 3],
	deleteProperty: [2, 2],
	envCopy: [0, 0],
	envPop: [0, 0],
	envPush: [0, 0],
	forInKeys: [1, 1],
	generatorStart: [0, 0],
	getAsyncIterator: [1, 1],
	getIterator: [1, 1],
	guardFunctionIndex: [1, 1],
	selectShapeCase: [1, 1],
	hasPrivate: [2, 2],
	initGlobalVars: [0, 0],
	declareGlobalLexical: [0, 0],
	globalBindingQuery: [0, 0],
	initPrivateFields: [1, 65_535],
	instantiateLiteralTemplate: [0, 0],
	isEmpty: [1, 1],
	iteratorClose: [1, 1],
	iteratorNext: [2, 2],
	iteratorStep: [2, 2],
	loadArgument: [0, 0],
	loadArgumentCount: [0, 0],
	loadCallee: [0, 0],
	loadCaptured: [0, 0],
	loadGlobalIndex: [0, 0],
	loadGlobal: [0, 0],
	loadGlobalProperty: [0, 0],
	loadIntrinsic: [0, 0],
	loadLocal: [0, 0],
	loadNewTarget: [0, 0],
	loadPrivate: [2, 2],
	loadProperty: [2, 2],
	loadPropertyStatic: [1, 1],
	loadPropertyStaticShapeCase: [2, 2],
	loadPrototype: [1, 1],
	loadStaticArgument: [2, 2],
	loadSuperProperty: [3, 3],
	loadThis: [0, 0],
	loadUndeclared: [0, 0],
	mathBinaryNumber: [2, 2],
	mathUnaryNumber: [1, 1],
	mergeDataProperties: [2, 2],
	move: [1, 1],
	requireCoercible: [1, 1],
	rootUse: [1, 65_535],
	setFunctionName: [2, 2],
	setPrototype: [2, 2],
	setThis: [1, 1],
	storeCaptured: [1, 1],
	storeGlobal: [1, 1],
	storeGlobalProperty: [1, 1],
	storeLocal: [1, 1],
	storePrivate: [3, 3],
	storeProperty: [3, 3],
	storePropertyStatic: [2, 2],
	storeSuperProperty: [4, 4],
	throwIfTdz: [1, 1],
	toPropertyKey: [2, 2],
	typeofCompare: [1, 1],
	unary: [1, 1],
	withEnter: [1, 1],
	withExit: [0, 0],
	withGet: [0, 0],
	withResolveBase: [0, 0],
	withSet: [1, 1],
	yield: [1, 1],
} as const satisfies Record<CoreOpcode, readonly [number, number]>;

/**
 * Indexed access still shares the ordinary property opcodes. The alias oracle
 * can refine those declarations to an exact `element` location, whose family
 * overlaps both domains, without introducing an array-specific opcode.
 */
function domainsFor(
	opcode: CoreOpcode,
	kind: "reads" | "writes",
): Array<CoreEffectDomain> {
	const mode: CoreAccessMode = kind === "reads" ? "read" : "write";
	const domains = new Set<CoreEffectDomain>();
	for (const access of opcodeAccesses(opcode)) {
		if (access.mode !== mode) continue;
		for (const domain of CORE_MEMORY_FAMILY_DOMAINS[access.family]) domains.add(domain);
	}
	if (CALLS_USER_CODE.has(opcode)) domains.add("host");
	return [...domains];
}

function effectsFor(opcode: CoreOpcode): CoreInstructionEffects {
	const reads = domainsFor(opcode, "reads");
	const writes = domainsFor(opcode, "writes");
	if (
		reads.length === 0 &&
		writes.length === 0 &&
		GC_FREE.has(opcode) &&
		NO_THROW.has(opcode) &&
		!CALLS_USER_CODE.has(opcode) &&
		opcode !== "await" &&
		opcode !== "yield"
	) {
		return CORE_NO_EFFECTS;
	}
	return {
		reads,
		writes,
		mayThrow: !NO_THROW.has(opcode),
		maySuspend: opcode === "await" || opcode === "yield" || opcode === "generatorStart",
		mayGc: !GC_FREE.has(opcode),
		callsUserCode: CALLS_USER_CODE.has(opcode),
	};
}

export const coreOpcodeRegistry = new CoreOpcodeRegistry();
for (const opcode of CORE_OPCODES) {
	const outputs = NO_OUTPUT.has(opcode) ? 0 : TWO_OUTPUTS.has(opcode) ? 2 : 1;
	const [minimumInputs, maximumInputs] = INPUT_ARITIES[opcode];
	const accesses = opcodeAccesses(opcode);
	const allocation = opcodeAllocation(opcode);
	const callTransfer = opcodeCallTransfer(opcode);
	coreOpcodeRegistry.define({
		opcode,
		inputs: coreArity(minimumInputs, maximumInputs),
		outputs: coreArity(outputs),
		effects: effectsFor(opcode),
		discardable: DISCARDABLE.has(opcode),
		attributeRelocations: [],
		...(accesses.length === 0 ? {} : { accesses }),
		...(allocation === undefined ? {} : { allocation }),
		...(callTransfer === undefined ? {} : { callTransfer }),
		...(OBSERVES_OPERANDS.has(opcode) ? { observesOperands: true } : {}),
		...(RESULT_CANNOT_BE_HELD_WEAKLY.has(opcode)
			? { resultCannotBeHeldWeakly: true }
			: {}),
	});
}

/**
 * Effects an instruction actually has: its opcode's baseline, narrowed by a
 * verified refinement when one is attached. Every consumer of Core effects reads
 * them through here so a refinement can never be honoured in one analysis and
 * ignored in another.
 */
export function coreInstructionEffects(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	registry: CoreOpcodeRegistry = fn.registry,
): CoreInstructionEffects {
	return (
		fn.instructionEffectRefinement(instruction)?.effects ??
		registry.byId(fn.instructionOpcode(instruction)).effects
	);
}

const CORE_OPCODE_SET: ReadonlySet<string> = new Set(CORE_OPCODES);

export function isCoreOpcode(type: string): type is CoreOpcode {
	return CORE_OPCODE_SET.has(type);
}

export function coreOpcode(type: CoreOpcode) {
	return coreOpcodeRegistry.require(type);
}

export function coreOpcodeSet(
	...opcodes: ReadonlyArray<CoreOpcode>
): ReadonlySet<CoreOpcodeId> {
	return new Set(opcodes.map((opcode) => coreOpcode(opcode).id));
}
