import { CORE_NO_EFFECTS, CoreOpcodeRegistry, coreArity } from "./core-ir.ts";
import type { CoreEffectDomain, CoreInstructionEffects } from "./core-ir.ts";
import type { IRInstruction } from "./ir.ts";

/**
 * First complete opcode contract for the cutover. The legacy spelling remains
 * only while semantic lowering is moved into Core IR; all middle-end consumers
 * use this registry rather than private allowlists.
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
	"catch",
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
	"jump",
	"jumpIf",
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
	"return",
	"setFunctionName",
	"setPrototype",
	"setThis",
	"sourcePos",
	"storeCaptured",
	"storeGlobal",
	"storeGlobalProperty",
	"storeLocal",
	"storePrivate",
	"storeProperty",
	"storePropertyStatic",
	"storeSuperProperty",
	"throw",
	"throwIfTdz",
	"toPropertyKey",
	"tryBegin",
	"tryEnd",
	"typeofCompare",
	"unary",
	"withEnter",
	"withExit",
	"withGet",
	"withResolveBase",
	"withSet",
	"yield",
] as const satisfies ReadonlyArray<IRInstruction["type"]>;

type MissingOpcode = Exclude<IRInstruction["type"], (typeof CORE_OPCODES)[number]>;
const allOpcodesAreDeclared: MissingOpcode extends never ? true : never = true;
void allOpcodesAreDeclared;

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
	"jump",
	"jumpIf",
	"mergeDataProperties",
	"requireCoercible",
	"return",
	"setFunctionName",
	"setPrototype",
	"setThis",
	"sourcePos",
	"storeCaptured",
	"storeGlobal",
	"storeGlobalProperty",
	"storeLocal",
	"storePrivate",
	"storeProperty",
	"storePropertyStatic",
	"storeSuperProperty",
	"throw",
	"throwIfTdz",
	"tryBegin",
	"tryEnd",
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
	"jump",
	"jumpIf",
	"loadCaptured",
	"loadGlobal",
	"loadIntrinsic",
	"loadLocal",
	"loadNewTarget",
	"move",
	"return",
	"setThis",
	"sourcePos",
	"storeCaptured",
	"storeGlobal",
	"storeLocal",
	"throw",
	"tryBegin",
	"tryEnd",
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
	coreOpcodeRegistry.define({
		opcode,
		inputs: coreArity(0, 65_535),
		outputs: coreArity(outputs),
		effects: effectsFor(opcode),
		discardable: DISCARDABLE.has(opcode),
	});
}

export function coreOpcode(type: IRInstruction["type"]) {
	return coreOpcodeRegistry.require(type);
}
