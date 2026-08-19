import { CORE_NO_EFFECTS, CoreOpcodeRegistry, coreArity } from "./core-ir.ts";
import type { CoreEffectDomain, CoreInstructionEffects } from "./core-ir.ts";

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

const PROPERTY_READS = new Set<CoreOpcode>([
	"hasPrivate",
	"loadGlobalProperty",
	"loadPrivate",
	"loadProperty",
	"loadPropertyStatic",
	"loadPrototype",
	"loadSuperProperty",
	"withGet",
	"withResolveBase",
]);

const PROPERTY_WRITES = new Set<CoreOpcode>([
	"copyDataProperties",
	"defineAccessor",
	"definePrivate",
	"defineProperty",
	"deleteProperty",
	"initPrivateFields",
	"mergeDataProperties",
	"setPrototype",
	"storeGlobalProperty",
	"storePrivate",
	"storeProperty",
	"storePropertyStatic",
	"storeSuperProperty",
	"withSet",
]);

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

function domainsFor(
	opcode: CoreOpcode,
	kind: "reads" | "writes",
): Array<CoreEffectDomain> {
	const domains = new Set<CoreEffectDomain>();
	if (kind === "reads" && opcode === "loadCaptured") domains.add("captured-slot");
	if (kind === "writes" && opcode === "storeCaptured") domains.add("captured-slot");
	if (kind === "writes" && opcode === "createPrivateNames") {
		domains.add("captured-slot");
	}
	if (kind === "reads" && opcode === "loadGlobal") domains.add("global-slot");
	if (kind === "writes" && (opcode === "storeGlobal" || opcode === "initGlobalVars")) {
		domains.add("global-slot");
	}
	if (kind === "reads" && PROPERTY_READS.has(opcode)) {
		domains.add("object-property");
		if (opcode === "loadGlobalProperty") domains.add("global-property");
	}
	if (kind === "writes" && PROPERTY_WRITES.has(opcode)) {
		domains.add("object-property");
		if (opcode === "storeGlobalProperty") domains.add("global-property");
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
	coreOpcodeRegistry.define({
		opcode,
		inputs: coreArity(minimumInputs, maximumInputs),
		outputs: coreArity(outputs),
		effects: effectsFor(opcode),
		discardable: DISCARDABLE.has(opcode),
	});
}

const CORE_OPCODE_SET: ReadonlySet<string> = new Set(CORE_OPCODES);

export function isCoreOpcode(type: string): type is CoreOpcode {
	return CORE_OPCODE_SET.has(type);
}

export function coreOpcode(type: CoreOpcode) {
	return coreOpcodeRegistry.require(type);
}
