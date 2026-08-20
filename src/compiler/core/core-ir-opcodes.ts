import {
	CORE_MEMORY_FAMILY_DOMAINS,
	CORE_NO_EFFECTS,
	CoreOpcodeRegistry,
	coreArity,
} from "./core-ir.ts";
import type {
	CoreAccessMode,
	CoreEffectDomain,
	CoreInstruction,
	CoreInstructionEffects,
	CoreMemoryFamily,
	CoreOpcodeAccess,
} from "./core-ir.ts";

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
	"callSpread",
	"callSpreadIterable",
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
	"loadGlobal",
	"loadGlobalProperty",
	"loadIntrinsic",
	"loadLocal",
	"loadNewTarget",
	"loadPrivate",
	"loadProperty",
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
	"asyncStart",
	"createBoolean",
	"createEmpty",
	"createF64",
	"createNull",
	"createNumber",
	"createUndefined",
	"generatorStart",
	"guardFunctionIndex",
	"isEmpty",
	"loadCaptured",
	"loadGlobal",
	"loadIntrinsic",
	"loadLocal",
	"loadNewTarget",
	"mathBinaryNumber",
	"mathUnaryNumber",
	"move",
	"setThis",
	"storeCaptured",
	"storeGlobal",
	"storeLocal",
	"typeofCompare",
	"withExit",
]);

const NO_THROW = new Set<CoreOpcode>([
	...GC_FREE,
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
	"loadThis",
	"mathBinaryNumber",
	"mathUnaryNumber",
]);

const CALLS_USER_CODE = new Set<CoreOpcode>([
	"arrayRest",
	"binary",
	"call",
	"callBuiltin",
	"callSpread",
	"callSpreadIterable",
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
	"getAsyncIterator",
	"getIterator",
	"hasPrivate",
	"initPrivateFields",
	"iteratorClose",
	"iteratorNext",
	"iteratorStep",
	"loadGlobalProperty",
	"loadPrivate",
	"loadProperty",
	"loadPropertyStatic",
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
	"guardFunctionIndex",
	"isEmpty",
	"loadCaptured",
	"loadGlobal",
	"loadIntrinsic",
	"loadLocal",
	"loadNewTarget",
	"loadThis",
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
	loadLocal: [read("local-slot", { attributes: ["index"] })],
	storeLocal: [write("local-slot", { attributes: ["index"], valueOperand: 0 })],
	loadCaptured: [read("captured-slot", { attributes: ["functionIndex", "index"] })],
	storeCaptured: [
		write("captured-slot", { attributes: ["functionIndex", "index"], valueOperand: 0 }),
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
	loadGlobalProperty: [read("global-property", { keyAttribute: "nameStringIndex" })],
	storeGlobalProperty: [
		write("global-property", { keyAttribute: "nameStringIndex", valueOperand: 0 }),
	],
	loadProperty: [read("object-slot", { baseOperand: 0 })],
	loadPropertyStatic: [
		read("object-slot", { baseOperand: 0, keyAttribute: "stringIndex" }),
	],
	storeProperty: [write("object-slot", { baseOperand: 0, valueOperand: 2 })],
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
		write("object-slot", { baseOperand: 0 }),
		write("shape", { baseOperand: 0 }),
	],
	defineProperty: [write("object-slot"), write("shape")],
	defineAccessor: [write("object-slot"), write("shape")],
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
	callSpread: [3, 3],
	callSpreadIterable: [3, 3],
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
	hasPrivate: [2, 2],
	initGlobalVars: [0, 0],
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
	loadGlobal: [0, 0],
	loadGlobalProperty: [0, 0],
	loadIntrinsic: [0, 0],
	loadLocal: [0, 0],
	loadNewTarget: [0, 0],
	loadPrivate: [2, 2],
	loadProperty: [2, 2],
	loadPropertyStatic: [1, 1],
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
 * `array-element` is reachable only through the `element` family, which no opcode
 * declares yet: indexed access still lowers to a dynamic-key `object-slot`
 * access. Keeping the domain in the family table means the first `element`
 * producer automatically overlaps existing `object-property` readers.
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
		maySuspend: opcode === "await" || opcode === "yield" || opcode === "asyncStart",
		mayGc: !GC_FREE.has(opcode),
		callsUserCode: CALLS_USER_CODE.has(opcode),
	};
}

export const coreOpcodeRegistry = new CoreOpcodeRegistry();
for (const opcode of CORE_OPCODES) {
	const outputs = NO_OUTPUT.has(opcode) ? 0 : TWO_OUTPUTS.has(opcode) ? 2 : 1;
	const [minimumInputs, maximumInputs] = INPUT_ARITIES[opcode];
	const accesses = opcodeAccesses(opcode);
	coreOpcodeRegistry.define({
		opcode,
		inputs: coreArity(minimumInputs, maximumInputs),
		outputs: coreArity(outputs),
		effects: effectsFor(opcode),
		discardable: DISCARDABLE.has(opcode),
		...(accesses.length === 0 ? {} : { accesses }),
	});
}

/**
 * Effects an instruction actually has: its opcode's baseline, narrowed by a
 * verified refinement when one is attached. Every consumer of Core effects reads
 * them through here so a refinement can never be honoured in one analysis and
 * ignored in another.
 */
export function coreInstructionEffects(
	instruction: CoreInstruction,
): CoreInstructionEffects {
	return (
		instruction.effectRefinement?.effects ??
		coreOpcodeRegistry.require(instruction.opcode).effects
	);
}

const CORE_OPCODE_SET: ReadonlySet<string> = new Set(CORE_OPCODES);

export function isCoreOpcode(type: string): type is CoreOpcode {
	return CORE_OPCODE_SET.has(type);
}

export function coreOpcode(type: CoreOpcode) {
	return coreOpcodeRegistry.require(type);
}
