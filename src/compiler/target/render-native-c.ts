import {
	CORE_STRING_SPAN_CHARACTER_METHODS,
	CORE_STRING_SPAN_METHODS,
	CORE_STRING_SPAN_SEARCH_METHODS,
} from "../core/core-ir-regions.ts";
import type {
	CorePropertyPlacement,
	CoreStringSpanRangeOperation,
} from "../core/core-ir-regions.ts";
import {
	builtinResultIsInt32,
	DATA_VIEW_ACCESSOR_TYPES,
} from "../shared/builtin-registry.ts";
import {
	compilerComparisonInputKindsAvoidObjectCoercion,
	compilerValueKindTruthiness,
	compilerValueKindCanBeHeldWeakly,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE,
	COMPILER_VALUE_KIND_TO_NUMBER_PRIMITIVE,
	COMPILER_VALUE_KIND_TO_STRING_PRIMITIVE,
	compilerValueKindMaskIsSubset,
	compilerValueKindsHaveEmptyPrimitiveWrappers,
	COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED,
	COMPILER_VALUE_KIND_NULLISH,
	COMPILER_VALUE_KIND_UNDEFINED,
	compilerOperatorIsNullishEquality,
	compilerOperatorIsPrimitiveStringConcatenation,
	compilerNumberFastPathInputKind,
} from "../shared/compiler-value-kinds.ts";
import type { CompilerValueKindMask } from "../shared/compiler-value-kinds.ts";
import {
	instructionInputIsInt32,
	instructionInputIntegerRange,
	instructionResultIntegerRange,
	instructionInputKind,
} from "../shared/instruction-facts.ts";
import type { InstructionFacts } from "../shared/instruction-facts.ts";
import type { CompilerIntegerRange } from "../shared/integer-range.ts";
import {
	compilerIntegerRangeIsInt32,
	compilerIntegerRangeTruthiness,
	compilerIntegerRangeComparison,
} from "../shared/integer-range.ts";
import {
	knownBuiltinErrors,
	knownBuiltinErrorPrototype,
} from "../shared/known-builtin-errors.ts";
import { knownNativeEntries } from "../shared/known-native-entries.ts";
import { knownOperationFlags, knownOperations } from "../shared/known-operations.ts";
import { knownOperationIndex } from "../shared/known-operations.ts";
import {
	NATIVE_STRING_SWITCH_CODE_UNIT_LIMIT,
	nativeStringSwitchHash,
} from "../shared/native-string-switch.ts";
import { staticDataQueryTag } from "../shared/static-data-query.ts";
import { bytecodeLoopInstructions } from "./bytecode-loops.ts";
import {
	emitBinaryOperator,
	emitIntrinsic,
	emitUnaryOperator,
} from "./emit-program-image.ts";
import { generatedDeclarationSymbols } from "./generated-declaration-references.ts";
import type { NativeCallbackTransportPlan } from "./lower-native-callbacks.ts";
import type {
	NativeCallTargetTransport,
	NativeCallTransportPlan,
} from "./lower-native-calls.ts";
import {
	ENVIRONMENT_ABSENT,
	ENVIRONMENT_PRESENT,
	planLazyCaptureEnvironment,
} from "./lower-native-captures.ts";
import type {
	NativeCaptureAccessPlan,
	NativeLazyCaptureEnvironment,
} from "./lower-native-captures.ts";
import {
	numericLoopCodeUnitMethods,
	numericLoopOrder,
	nativeNumericBuiltinInstruction,
	lowerNativeFastPaths,
	numberRecordDataflow,
	numberRecordOrder,
	numberRecordSuccessors,
} from "./lower-native-fast-paths.ts";
import type {
	NativeConstructorInitializationAction,
	NativeFastPathPlans,
	NativeNumericLoopRegionPlan,
	NativeMathCallPlan,
	NativeNumberPredicatePlan,
	NativeNumberRecordDataflow,
	NativeNumberRecordRegionPlan,
	NativePairedArrayLoopAction,
	NativePropertyNumericUpdateAction,
	NativePropertyProjectionAction,
	NativePropertyProjectionOperand,
	NativePropertyReadRegionAction,
	NativePropertyReadPairAction,
} from "./lower-native-fast-paths.ts";
import type { NativeStackFieldRepresentation } from "./lower-native-objects.ts";
import { nativeRootedOutputRegisters } from "./lower-native-root-publication.ts";
import {
	nativeNumericWorkerContract,
	nativeVariantContract,
} from "./lower-native-storage.ts";
import type { NativeStringTransformPlan } from "./lower-native-string-transforms.ts";
import type { NativeSuspensionPlan } from "./lower-native-suspension.ts";
import { nativeControlFlowContract } from "./native-control-flow.ts";
import type { NativeControlFlowPlan } from "./native-control-flow.ts";
import { NATIVE_ENUMERATION_SNAPSHOT_CAPACITY } from "./native-object-enumeration-snapshot.ts";
import type { NativeObjectEnumerationSnapshotPlan } from "./native-object-enumeration-snapshot.ts";
import { nativeInactiveRootMasks, nativeRootMaskWordHex } from "./native-root-masks.ts";
import type { NativeInactiveRootMask } from "./native-root-masks.ts";
import {
	NATIVE_ARITH,
	NATIVE_BITWISE,
	NATIVE_COMPARE,
	MATH_UNARY_NATIVE_CALL,
	MATH_NUMBER_KERNELS,
	MATH_BINARY_OPERATIONS,
	NUMBER_PREDICATES,
	boxedNumberPredicateExpression,
	OBJECT_BRAND_PREDICATES,
	nativeObjectBrandPredicateExpression,
	nativeNumberPredicateExpression,
	nativeNumberPredicateInputExpression,
	nativeMathUnaryExpr,
	nativeMathBinaryExpr,
	nativeNumericBuiltinExpr,
	nativeBinaryNumberInputs,
	nativePrimitiveNumberExpression,
	nativeUnsignedRemainderExpression,
	nativeInt32ArithmeticExpression,
	nativeInt32UnaryExpression,
	nativeReflexiveEqualityExpression,
	nativeEqualityExpression,
	nativeTypeofComparisonExpression,
} from "./native-scalar-operators.ts";
import {
	nativeInstructionSourceRanges,
	shiftNativeSourceRanges,
} from "./native-source-map.ts";
import type { NativeSourceRange } from "./native-source-map.ts";
import type { NativeSpanConsumer } from "./native-span-continuation.ts";
import { nativeStringComparisonExpression } from "./native-string-comparisons.ts";
import type { NativeStringComparisonPlan } from "./native-string-comparisons.ts";
import { nativeValueConversion } from "./native-value-transport.ts";
import type { NativeValueConversion } from "./native-value-transport.ts";
import { profileOperationForInstruction } from "./profile-metadata.ts";
import {
	nativeFrameRootRegisters,
	nativeLoopUpdateTransportsValue,
	nativeInstructionEffects,
	nativeGuardedBuiltinEffects,
	nativeRecordAliases,
	sameNativeRecordLayout,
	vmCallProvesBuiltin,
	validateNativeDirectEntry,
	validateNativeLiteralSwitches,
	vmRegionActionsAreCurrent,
	vmNativeInstructionMayCaptureStack as nativeInstructionMayCaptureStack,
	vmSemanticProtectorGuard,
} from "./program-image.ts";
import type {
	NativeFunctionPlan,
	NativeDirectEntryPlan,
	NativeInstructionPlan,
	NativeRecordCall,
	NativeRecordLayout,
	NativeRecordObject,
	NativeRecordParameter,
	NativeRecordPass,
	VmGuardPlan,
	VmRegion,
	VmRegionAction,
	VmRegionLicense,
	VmRegisterRepresentation,
	VmSemanticDependency,
	VmSemanticProtectorFact,
} from "./program-image.ts";
import type { NativeFastTryParameters } from "./render-native-fast-entry.ts";
import { renderNativeFastEntry } from "./render-native-fast-entry.ts";
import {
	computeArgumentRetentionLimit,
	decodeVmValueOperand,
	restForwardFlags,
	vmExceptionHandlerTargets as exceptionHandlerTargets,
	vmInstructionReadRegisters,
	vmInstructionUsesRegister,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";
import type { BytecodeFunction, BytecodeInstruction } from "./runtime-image.ts";
import {
	DEFAULT_NATIVE_SPLIT_POLICY,
	splitNativeFunction,
} from "./split-native-function.ts";
import type { NativeSplitPolicy } from "./split-native-function.ts";

/**
 * The native-C backend: lower an eligible function straight to a C function
 * (no VM dispatch loop), installed as MalFunction.compiled. Only a subset of
 * opcodes is lowered; anything else makes a function ineligible (it falls back
 * to the interpreter).
 *
 * VALUE REPRESENTATION & UNBOXING: each register has a `RegisterRep`. A register
 * that Core target lowering marks as always holding a JS number —
 * literals and the results of +,-,*,/ and unary -,+ over other proven-number
 * registers — gets the `number` rep and is emitted as a C `double`, with native
 * arithmetic and no per-op type checks or boxing. Such a value is boxed (via
 * mal_ops_number_value, which canonicalizes int32/-0/NaN exactly as the
 * interpreter does) only at boundaries: when it flows into a boxed op, a global
 * store, a condition, or the return. This is guard-free: the proof is static, so
 * no runtime type checks are needed.
 *
 * MIXED-REP GUARDS: a binary op with one proven-number operand and one boxed
 * operand (typically a still-boxed parameter, e.g. the `i < n` of a counted
 * loop) emits a speculative fast path — `mal_ops_is_number(boxed) ? <native
 * double op> : <fully-general op>`. The guard is a few inline bit tests
 * (mal_ops_is_number / mal_ops_number_as_f64 are static inline in value_ops.h),
 * cheap and perfectly predicted in a hot loop, so the boxed operand never forces
 * a non-inlined value_ops call when it is in fact a number. The fast path is
 * observably identical to the fallback by construction.
 *
 * BOOLEANS: a register that always holds a JS boolean — the result of a
 * comparison, a logical `!`, or a boolean literal — gets the `boolean` rep and
 * is emitted as a C `bool`. A comparison then writes a raw bool (no
 * mal_value_new_boolean), a JUMP_IF on it branches directly (no
 * mal_value_is_truthy), and it is boxed (mal_value_new_boolean) only at a
 * boundary. A counted loop's `i < n` condition becomes a native compare feeding
 * a native branch with no boxing round-trip at all.
 *
 * The int32-overflow fix in mal_ops (add/sub/mul now promote to f64) is what
 * makes the unboxed double arithmetic behavior-identical to the interpreter.
 */

/**
 * How a register's value is held in the emitted C: a raw C `double`, a raw C
 * `bool`, or a boxed `MalValue`. A register reused across its lifetime for
 * values of different reps joins to `boxed` in the target-lowering plan.
 */
type RegisterRep = VmRegisterRepresentation;

function captureValueKey(ownerFunctionIndex: number, capturedIndex: number): string {
	return `${ownerFunctionIndex}:${capturedIndex}`;
}

interface NativeNumericFusionCandidate {
	readonly instructionIp: number;
	readonly finishIp: number;
	readonly action: NativeNumericFusionAction;
}

interface NativeRegionTopology {
	readonly actionsByKind: ReadonlyMap<VmRegion["kind"], ReadonlyArray<VmRegionAction>>;
	readonly stringSplitProjections: ReadonlyArray<{
		readonly projection: NativeStringSplitProjection;
		readonly elementLoads: NativeStringSplitProjectionSite["elementLoads"];
	}>;
	readonly stringSplitCursors: ReadonlyArray<NativeStringSplitCursor>;
	readonly regexpExecProjections: ReadonlyArray<{
		readonly projection: NativeRegExpExecProjection;
		readonly loads: NativeRegExpExecProjectionSite["loads"];
	}>;
	readonly regexpIteratorProjections: ReadonlyArray<{
		readonly projection: NativeRegExpIteratorProjection;
		readonly loads: NativeRegExpIteratorProjectionSite["loads"];
	}>;
	readonly numericFusionCandidates: ReadonlyArray<NativeNumericFusionCandidate>;
	readonly indexedLengthLoopActionByIp: ReadonlyMap<number, IndexedLengthLoopAction>;
	readonly nativeStringCharCodeAtChainActionByIp: ReadonlyMap<
		number,
		NativeStringCharCodeAtChainAction
	>;
	readonly nativeBuiltinCollectionCallChainActionByIp: ReadonlyMap<
		number,
		NativeBuiltinCollectionCallChainAction
	>;
	readonly nativeIteratorCursorActionByIp: ReadonlyMap<
		number,
		NativeIteratorCursorAction
	>;
	readonly nativeIteratorResultVirtualizationActionByIp: ReadonlyMap<
		number,
		NativeIteratorResultVirtualizationAction
	>;
	readonly nativeIteratorEntryPairVirtualizationActionByIp: ReadonlyMap<
		number,
		NativeIteratorEntryPairVirtualizationAction
	>;
}

/** Frame slots standing in for this activation's capture environment until it exists. */
interface NativeCaptureShadow {
	readonly plan: NativeLazyCaptureEnvironment;
	readonly base: number;
	/** Creates the environment from the shadow slots and assigns `env`. */
	readonly create: string;
	readonly rootFrame: boolean;
}

interface NativeBodyAnalysis {
	readonly captures: NativeCaptureAccessPlan;
	readonly regionTopology: (
		specializations: ReadonlyArray<VmRegion>,
		regionActions: ReadonlyArray<VmRegionAction>,
	) => NativeRegionTopology;
	readonly captureOwners: ReadonlyArray<number>;
	readonly stableCaptureOwners: ReadonlySet<number>;
	readonly copiedCaptures: ReadonlyMap<string, number>;
	readonly requiredCaptureOwners: ReadonlySet<number>;
	readonly jumpTargets: ReadonlySet<number>;
	readonly handlerTargets: ReadonlyArray<number | undefined>;
	readonly ownsCaptureEnvironment: boolean;
	readonly lazyCaptureEnvironment: NativeLazyCaptureEnvironment | undefined;
	readonly iterationEligibilityRegisters: ReadonlySet<number>;
	readonly writeRegistersAt: (instructionIp: number) => ReadonlyArray<number>;
}

function deferredRestArgumentRootIp(native: NativeFunctionPlan): number | undefined {
	const fn = native.body;
	const materializations = fn.instructions.flatMap((instruction, ip) =>
		instruction.opcode === "CREATE_REST_ARGUMENTS" &&
		native.instructions[ip]?.kind !== "virtual-packed-rest-array"
			? [ip]
			: [],
	);
	if (materializations.length !== 1 || fn.isAsync || fn.isGenerator) return undefined;
	const materialization = materializations[0]!;
	const safepoints = new Map(
		native.gc.safepoints.map((point) => [point.instructionIp, point.kind]),
	);
	const handlers =
		fn.handlers.length === 0
			? []
			: exceptionHandlerTargets(fn.instructions.length, fn.handlers);
	const pending = [0];
	const seen = new Uint8Array(fn.instructions.length);
	while (pending.length > 0) {
		const ip = pending.pop()!;
		if (ip === materialization || ip < 0 || ip >= seen.length || seen[ip] !== 0) continue;
		seen[ip] = 1;
		const instruction = fn.instructions[ip]!;
		const effects = nativeInstructionEffects(instruction, native.facts?.[ip]);
		if (
			safepoints.get(ip) === "loop-backedge" ||
			(safepoints.has(ip) && (effects.collection || effects.reentry))
		)
			return materialization;
		const handler = handlers[ip];
		if (handler !== undefined) pending.push(handler);
		if (instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF")
			pending.push(instruction.targetIp);
		if (!["JUMP", "RETURN", "THROW", "LOAD_UNDECLARED"].includes(instruction.opcode))
			pending.push(ip + 1);
	}
	return undefined;
}

function analyzeNativeBody(
	fn: BytecodeFunction,
	captures: NativeCaptureAccessPlan,
): NativeBodyAnalysis {
	const owners = new Set(captures.owners.map((owner) => owner.ownerFunctionIndex));
	const copied = new Map(
		captures.copiedValues.map((capture, index) => [
			captureValueKey(capture.ownerFunctionIndex, capture.capturedIndex),
			index,
		]),
	);
	const jumpTargets = new Set(fn.handlers.map((handler) => handler.handlerIp));
	const iterationEligibilityRegisters = new Set<number>();
	for (const [ip, instruction] of fn.instructions.entries()) {
		if (instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF")
			jumpTargets.add(instruction.targetIp);
		if (
			(fn.isGenerator || fn.isAsync) &&
			(instruction.opcode === "GENERATOR_START" ||
				instruction.opcode === "YIELD" ||
				instruction.opcode === "AWAIT")
		)
			jumpTargets.add(ip + 1);
		if (
			instruction.opcode === "LOAD_INTRINSIC" &&
			instruction.intrinsic === "__arrayIterationEligible"
		)
			iterationEligibilityRegisters.add(instruction.dst);
	}
	const regionTopologies = new Map<
		ReadonlyArray<VmRegionAction>,
		{ specializations: ReadonlyArray<VmRegion>; topology: NativeRegionTopology }
	>();
	let emptyRegionTopology: NativeRegionTopology | undefined;
	let writeRegistersByIp: Array<ReadonlyArray<number>> | undefined;
	return {
		captures,
		regionTopology(specializations, regionActions) {
			if (specializations.length === 0 && regionActions.length === 0)
				return (emptyRegionTopology ??= analyzeNativeRegionTopology(
					fn,
					specializations,
					regionActions,
				));
			const previous = regionTopologies.get(regionActions);
			if (previous?.specializations === specializations) return previous.topology;
			const topology = analyzeNativeRegionTopology(fn, specializations, regionActions);
			regionTopologies.set(regionActions, { specializations, topology });
			return topology;
		},
		writeRegistersAt: (ip) =>
			((writeRegistersByIp ??= [])[ip] ??= vmInstructionWriteRegisters(
				fn.instructions[ip]!,
			)),
		captureOwners: captures.owners.map((owner) => owner.ownerFunctionIndex),
		stableCaptureOwners: owners,
		copiedCaptures: copied,
		requiredCaptureOwners: new Set(
			captures.owners
				.filter((owner) => owner.lookupIndex >= 0)
				.map((owner) => owner.ownerFunctionIndex),
		),
		jumpTargets,
		handlerTargets:
			fn.handlers.length === 0
				? []
				: exceptionHandlerTargets(fn.instructions.length, fn.handlers),
		ownsCaptureEnvironment: captures.ownsEnvironment,
		lazyCaptureEnvironment: planLazyCaptureEnvironment(fn, captures),
		iterationEligibilityRegisters,
	};
}

// Named by stem so an overlay body's text survives index shifts elsewhere in its image.
function captureOwnerName(
	relocation: NativeRelocationExpressions,
	owner: number,
): string {
	return `__capture_owner_${relocation.stem(owner)}`;
}

/**
 * How an exact caller rebuilds the creation environment of a closure whose function
 * object its owner scope may have elided. `scope` and `owner` reuse the owner's
 * activation as-is or as the single tagged owner, `ancestor` tags the one outer
 * owner found from it, `none` captures nothing, and `chain` and `outer-chain`
 * reuse the activation or the innermost outer owner's scope only when the creator
 * left the callee empty.
 */
export type NativeDirectClosureEnvironment =
	| { readonly kind: "scope" | "none" | "owner" }
	| { readonly kind: "ancestor"; readonly owner: number }
	/** `layout` names the owners, so closures that share it share their chain test. */
	| { readonly kind: "chain"; readonly layout: string }
	| { readonly kind: "outer-chain"; readonly owner: number; readonly layout: string };

/** Direct closure plans are per creating function: each creator decides its own marker. */
export function nativeDirectClosureKey(target: number, creator: number): string {
	return `${target}:${creator}`;
}

/** The C environment argument for an exact call, or undefined when it reads the callee. */
function directClosureEnvironment(
	plan: NativeInstructionPlan | undefined,
	directClosures: ReadonlyMap<string, NativeDirectClosureEnvironment> | undefined,
	functionIndex: number | undefined,
	fixedCaptureOwners: ReadonlySet<number> | undefined,
	relocation: NativeRelocationExpressions,
	callee: string,
): string | undefined {
	if (plan?.kind !== "call" || plan.directClosureOwner === undefined) return undefined;
	const owner = plan.directClosureOwner;
	const environment =
		plan.directFunctionIndex === undefined
			? undefined
			: directClosures?.get(nativeDirectClosureKey(plan.directFunctionIndex, owner));
	if (environment === undefined) return undefined;
	if (environment.kind === "none") return "nullptr";
	const scope =
		owner === functionIndex
			? "env"
			: fixedCaptureOwners?.has(owner) === true
				? captureOwnerName(relocation, owner)
				: `mal_vm_capture_owner(env, ${relocation.ownerFunctionIndex(owner)})`;
	switch (environment.kind) {
		case "scope":
			return scope;
		case "owner":
			return `mal_env_tag_single_owner(${scope})`;
		case "ancestor":
			return `mal_env_tag_single_owner(mal_vm_capture_owner_at(${scope}, ${relocation.ownerFunctionIndex(environment.owner)}, 0))`;
		case "chain":
			return `(mal_value_is_empty(${callee}) ? ${scope} : mal_value_to_function_object(${callee})->creation_env)`;
		case "outer-chain":
			return `(mal_value_is_empty(${callee}) ? mal_vm_capture_owner_at(${scope}, ${relocation.ownerFunctionIndex(environment.owner)}, 0) : mal_value_to_function_object(${callee})->creation_env)`;
	}
}

/**
 * A chain test reads only the closure's owner layout and the scope it starts from,
 * and an activation that elides closures never changes its scope, so closures with
 * equal layouts share one per-activation answer, declared unknown before the body.
 */
function nativeClosureChainTests(
	fn: BytecodeFunction,
	nativeInstructions: ReadonlyArray<NativeInstructionPlan | undefined>,
	directClosures: ReadonlyMap<string, NativeDirectClosureEnvironment>,
	functionIndex: number | undefined,
	declarations: Array<string>,
): ReadonlyMap<number, string> {
	const tests = new Map<number, string>();
	const shared = new Map<string, string>();
	for (const [ip, instruction] of fn.instructions.entries()) {
		if (
			instruction.opcode !== "CREATE_FUNCTION" ||
			nativeInstructions[ip]?.kind !== "direct-closure"
		)
			continue;
		const closure = directClosures.get(
			nativeDirectClosureKey(instruction.functionIndex, functionIndex ?? -1),
		);
		if (closure?.kind !== "chain" && closure?.kind !== "outer-chain") continue;
		const key = `${closure.layout}@${closure.kind === "outer-chain" ? closure.owner : ""}`;
		let name = shared.get(key);
		if (name === undefined) {
			name = `__closure_chain_${shared.size}`;
			shared.set(key, name);
			declarations.push(`i8 ${name} = -1;`);
		}
		tests.set(ip, name);
	}
	return tests;
}

function initializeFixedCaptureOwners(
	captures: NativeCaptureAccessPlan,
	relocation: NativeRelocationExpressions,
	declare: boolean,
	incoming: "env" | "env->parent",
): Array<string> {
	const binding = declare ? "MalEnv *const " : "";
	const owners = captures.owners.map((owner) => owner.ownerFunctionIndex);
	const layout = captures.layout;
	// Native constructors encode these layouts as one tagged owner, a display,
	// or an exact complete chain. Wire overlays and resumed scopes can differ.
	if (captures.initialization === "complete-layout" && !relocation.relative) {
		if (layout.length === 1)
			return [
				`${binding}${captureOwnerName(relocation, owners[0]!)} = mal_env_untag_single_owner(${incoming});`,
			];
		const selected = new Set(owners);
		const chain: Array<string> = [];
		const last = layout.indexOf(owners[0]!);
		for (let index = layout.length - 1; index >= last; index--) {
			const owner = layout[index]!;
			if (selected.has(owner))
				chain.push(
					`  ${captureOwnerName(relocation, owner)} = ${index === 0 ? "mal_env_untag_single_owner(__capture_scope)" : "__capture_scope"};`,
				);
			if (index > last) chain.push("  __capture_scope = __capture_scope->parent;");
		}
		return [
			...(declare
				? owners.map((owner) => `MalEnv *${captureOwnerName(relocation, owner)};`)
				: []),
			`MalEnv *const __closure_captures = ${incoming};`,
			"if (__closure_captures->function_index == MAL_ENV_CAPTURE_VECTOR) {",
			"  MalEnv **const __capture_scopes = mal_env_capture_scopes(__closure_captures);",
			...owners.map(
				(owner) =>
					`  ${captureOwnerName(relocation, owner)} = __capture_scopes[${layout.indexOf(owner)}];`,
			),
			"} else {",
			"  MalEnv *__capture_scope = __closure_captures;",
			...chain,
			"}",
		];
	}
	if (owners.length > 1) {
		return [
			`${relocation.enabled ? "" : "static "}const i32 __capture_owner_ids[] = { ${owners.map((owner) => relocation.ownerFunctionIndex(owner)).join(", ")} };`,
			`MalEnv *__capture_owner_scopes[${owners.length}];`,
			`mal_vm_capture_owners(env, __capture_owner_ids, ${owners.length}, __capture_owner_scopes);`,
			...owners.map(
				(owner, index) =>
					`${binding}${captureOwnerName(relocation, owner)} = __capture_owner_scopes[${index}];`,
			),
		];
	}
	return captures.owners.map(
		({ ownerFunctionIndex: owner, lookupIndex: captureIndex }) => {
			const lookup =
				captureIndex < 0
					? `mal_vm_capture_owner(env, ${relocation.ownerFunctionIndex(owner)})`
					: `mal_vm_capture_owner_at(env, ${relocation.ownerFunctionIndex(owner)}, ${captureIndex})`;
			return `${binding}${captureOwnerName(relocation, owner)} = ${lookup};`;
		},
	);
}

function renderCapturedLoad(
	instruction: Extract<BytecodeInstruction, { opcode: "LOAD_CAPTURED" }>,
	ip: number,
	context: NativeInstructionContext,
	relocation: NativeRelocationExpressions,
): Array<string> {
	const copied = context.copiedCaptures?.get(
		captureValueKey(instruction.ownerFunctionIndex, instruction.index),
	);
	if (copied !== undefined) return [`r${instruction.dst} = __capture_value_${copied};`];
	if (context.fixedCaptureOwners?.has(instruction.ownerFunctionIndex)) {
		const owner = captureOwnerName(relocation, instruction.ownerFunctionIndex);
		if (context.requiredCaptureOwners?.has(instruction.ownerFunctionIndex))
			return [`r${instruction.dst} = ${owner}->slots[${instruction.index}];`];
		return [
			`r${instruction.dst} = ${owner} != nullptr ? ${owner}->slots[${instruction.index}] : MAL_VALUE_UNDEFINED;`,
		];
	}
	if (instruction.ownerFunctionIndex === context.ownedCaptureFunctionIndex) {
		const shadow = context.captureShadow;
		const state = shadow?.plan.states[ip] ?? ENVIRONMENT_PRESENT;
		const environment = `env->slots[${instruction.index}]`;
		if (shadow === undefined || (state & ENVIRONMENT_ABSENT) === 0)
			return [`r${instruction.dst} = ${environment};`];
		const frame = `__gc_slots[${shadow.base + instruction.index}]`;
		return [
			`r${instruction.dst} = ${state === ENVIRONMENT_ABSENT ? frame : `__capture_env_ready ? ${environment} : ${frame}`};`,
		];
	}
	return [
		`r${instruction.dst} = mal_vm_load_captured(env, ${relocation.ownerFunctionIndex(instruction.ownerFunctionIndex)}, ${instruction.index});`,
	];
}

function ensureCaptureEnvironment(
	shadow: NativeCaptureShadow | undefined,
	ip: number,
): Array<string> {
	const state = shadow?.plan.states[ip] ?? ENVIRONMENT_PRESENT;
	if (shadow === undefined || (state & ENVIRONMENT_ABSENT) === 0) return [];
	const create = [
		shadow.create,
		...(shadow.rootFrame ? ["__gc_frame.env = env;"] : []),
		...(shadow.plan.guarded ? ["__capture_env_ready = true;"] : []),
	];
	if (state === ENVIRONMENT_ABSENT) return create;
	return ["if (!__capture_env_ready) {", ...create.map((line) => `  ${line}`), "}"];
}

function initializeCopiedCaptureValues(
	captures: NativeCaptureAccessPlan,
	relocation: NativeRelocationExpressions,
): Array<string> {
	// A direct entry can receive an ordinary or foreign display. The inline
	// accessor validates the tuple before reading its certified display ordinal.
	return captures.copiedValues.map(
		(capture, index) =>
			`const MalValue __capture_value_${index} = mal_vm_load_captured_value_at(env, ${relocation.ownerFunctionIndex(capture.ownerFunctionIndex)}, ${capture.capturedIndex}, ${index});`,
	);
}

interface ClassLayoutCandidate {
	readonly layout: number;
	readonly index: number;
}

/**
 * A class-member access that first compares the receiver against shared class
 * cells. A miss tries to admit the receiver's layout before the original access
 * runs, so the first fully built instance any site sees enables every site.
 */
function classLayoutAccess(
	kind: "slot" | "method",
	candidates: ReadonlyArray<ClassLayoutCandidate>,
	object: string,
	receiver: string,
	hit: (candidate: ClassLayoutCandidate) => string,
	fallback: ReadonlyArray<string>,
): Array<string> {
	const guard = kind === "method" ? "MAL_CLASS_METHOD" : "MAL_CLASS_SLOT";
	return [
		...candidates.map(
			(candidate, position) =>
				`${position === 0 ? "if" : "else if"} (${guard}(${object}, ${candidate.layout})) ${hit(candidate)}`,
		),
		"else {",
		candidates
			.map(
				({ layout }, position) =>
					`${position === 0 ? "MAL_CLASS_MISS" : "MAL_CLASS_LEARN"}(${object}, ${receiver}, ${layout});`,
			)
			.join(" "),
		...fallback,
		"}",
	];
}

function isNumericRep(rep: RegisterRep): boolean {
	return rep === "number" || rep === "int32";
}

function nativeNumberTruthiness(
	value: string,
	range: CompilerIntegerRange | undefined,
	integer = false,
): string {
	const constant = compilerIntegerRangeTruthiness(range);
	return constant !== undefined
		? String(constant)
		: integer || range !== undefined
			? `(${value} != 0)`
			: `mal_number_is_truthy(${value})`;
}

// Operand expressions are pure reads; JavaScript producers have already executed.
function nativeTruthiness(
	value: string,
	representation: RegisterRep,
	kind: CompilerValueKindMask,
	range?: CompilerIntegerRange,
): string {
	const ranged = compilerIntegerRangeTruthiness(range);
	if (ranged !== undefined) return String(ranged);
	if (representation === "boolean") return value;
	if (isNumericRep(representation))
		return nativeNumberTruthiness(value, range, representation === "int32");
	const mask =
		representation === "string"
			? COMPILER_VALUE_KIND_STRING
			: range !== undefined
				? COMPILER_VALUE_KIND_NUMBER
				: kind || COMPILER_VALUE_KIND_TOP;
	const constant = compilerValueKindTruthiness(mask);
	if (constant !== undefined) return String(constant);
	if (mask === COMPILER_VALUE_KIND_TOP) return `mal_value_is_truthy(${value})`;
	const nil = (kinds: number): string =>
		kinds === COMPILER_VALUE_KIND_UNDEFINED
			? `mal_value_is_undefined(${value})`
			: kinds === COMPILER_VALUE_KIND_NULL
				? `mal_value_is_null(${value})`
				: `mal_value_is_nil(${value})`;
	let remaining =
		mask &
		~(
			COMPILER_VALUE_KIND_NUMBER |
			COMPILER_VALUE_KIND_BOOLEAN |
			COMPILER_VALUE_KIND_STRING |
			COMPILER_VALUE_KIND_BIGINT
		);
	const terminal = compilerValueKindTruthiness(remaining);
	let expression =
		remaining === 0
			? undefined
			: terminal === undefined
				? `!${nil(remaining & COMPILER_VALUE_KIND_NULLISH)}`
				: String(terminal);
	for (const scalar of [
		COMPILER_VALUE_KIND_BIGINT,
		COMPILER_VALUE_KIND_STRING,
		COMPILER_VALUE_KIND_BOOLEAN,
		COMPILER_VALUE_KIND_NUMBER,
	]) {
		if ((mask & scalar) === 0) continue;
		const test =
			scalar === COMPILER_VALUE_KIND_BIGINT
				? `mal_value_is_bigint(${value})`
				: scalar === COMPILER_VALUE_KIND_STRING
					? `mal_value_is_string(${value})`
					: scalar === COMPILER_VALUE_KIND_BOOLEAN
						? `mal_value_is_boolean(${value})`
						: `mal_ops_is_number(${value})`;
		const truth =
			scalar === COMPILER_VALUE_KIND_BIGINT
				? `(mal_bigint_value(mal_value_to_bigint(${value})) != 0)`
				: scalar === COMPILER_VALUE_KIND_STRING
					? `(mal_string_length(mal_value_to_string(${value})) != 0)`
					: scalar === COMPILER_VALUE_KIND_BOOLEAN
						? `mal_value_to_boolean(${value})`
						: nativeNumberTruthiness(`mal_ops_number_as_f64(${value})`, range);
		if (expression === undefined) expression = truth;
		else if (expression === "false")
			expression =
				scalar === COMPILER_VALUE_KIND_BOOLEAN
					? `(${value} == MAL_VALUE_TRUE)`
					: `(!${nil(remaining)} && ${truth})`;
		else if (expression === "true")
			expression =
				scalar === COMPILER_VALUE_KIND_BOOLEAN
					? `(${value} != MAL_VALUE_FALSE)`
					: `(!${test} || ${truth})`;
		else expression = `(${test} ? ${truth} : ${expression})`;

		remaining |= scalar;
	}
	return expression ?? `mal_value_is_truthy(${value})`;
}

export interface BackendProfileDecision {
	instructionIndex: number;
	operation: string;
	code: string;
	outcome: "applied" | "elided" | "guarded" | "retained" | "fallback";
	reasonCode?: string;
	details?: Record<string, string | number | boolean>;
}

const NUMBER_FORMAT_KERNELS: Readonly<
	Record<string, readonly [string, number, number, number]>
> = {
	"Number.prototype.toString": ["string", 2, 36, 10],
	"Number.prototype.toFixed": ["fixed", 0, 100, 0],
	"Number.prototype.toExponential": ["exponential", 0, 100, -1],
	"Number.prototype.toPrecision": ["precision", 1, 100, -1],
};

const STRING_SEARCH_KERNELS: Readonly<Record<string, readonly [string, string]>> = {
	"String.prototype.indexOf": ["INDEX_OF", "0.0"],
	"String.prototype.lastIndexOf": ["LAST_INDEX_OF", "NAN"],
	"String.prototype.includes": ["INCLUDES", "0.0"],
	"String.prototype.startsWith": ["STARTS_WITH", "0.0"],
	"String.prototype.endsWith": ["ENDS_WITH", "INFINITY"],
};

const URI_KERNELS: Readonly<Record<string, readonly [string, boolean?]>> = {
	encodeURI: ["encode", false],
	encodeURIComponent: ["encode", true],
	decodeURI: ["decode", true],
	decodeURIComponent: ["decode", false],
	"globalThis.escape": ["escape"],
	"globalThis.unescape": ["unescape"],
};

const STRING_RANGE_KERNELS: Readonly<Record<string, string>> = {
	"String.prototype.slice": "SLICE",
	"String.prototype.substring": "SUBSTRING",
	"String.prototype.substr": "SUBSTR",
};

const STRING_SPAN_RANGE_KERNELS: Readonly<Record<CoreStringSpanRangeOperation, string>> =
	{
		slice: "SLICE",
		substring: "SUBSTRING",
		substr: "SUBSTR",
		trim: "TRIM",
		trimStart: "TRIM_START",
		trimEnd: "TRIM_END",
		trimLeft: "TRIM_START",
		trimRight: "TRIM_END",
		toString: "TO_STRING",
		valueOf: "VALUE_OF",
	};

const STRING_CHARACTER_KERNELS: Readonly<Record<string, string>> = {
	"String.prototype.at": "AT",
	"String.prototype.charAt": "CHAR_AT",
	"String.prototype.codePointAt": "CODE_POINT_AT",
};

interface NativeCallCoverage {
	readonly emittedInstructions: ReadonlySet<number>;
	readonly directEntryCalls: ReadonlyMap<number, ReadonlySet<number>>;
}

export const COMPILED_FUNCTION_DECLARATION =
	"(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalEnv *env, MalValue callee, void *entry_state)";

// Generated frames index their arrays only by constants, so the per-call canary is waste.
const NATIVE_ENTRY_ATTRIBUTES = "__attribute__((no_stack_protector)) ";

// An entry enters its own frame, so call sites carry no bookkeeping; a row build pops it on every return.
const COMPILED_ENTRY_SCOPE = ["    MAL_FRAME_SCOPE();", "    (void) __frame_row;"];

function frameDescriptorName(symbol: string): string {
	return `mal_frame_desc_${symbol}`;
}

function compiledFrameEntry(symbol: string, functionIndex: string): Array<string> {
	return [
		"    MalNativeFrame __frame_record;",
		`    MalNativeFrame *const __frame_row = MAL_FRAME_ENTER(&__frame_record, ${frameDescriptorName(symbol)}, ${functionIndex});`,
	];
}

/** Declares `owner`, the C function holding `symbol`'s frame record, then its descriptor. */
function compiledFrameDescriptor(
	symbol: string,
	owner: string,
	ownerDeclaration: string,
): Array<string> {
	return [
		`${ownerDeclaration};`,
		`MAL_FRAME_DESC(${frameDescriptorName(symbol)}, ${owner});`,
	];
}

/** `name` is the function's index, or its stem in a relocatable overlay. */
export function nativeCallbackSymbol(
	name: number | string,
	entryId: number,
	suffix: string,
): string {
	return `mal_callback_${name}_${entryId}${suffix}`;
}

export interface CompiledFunction extends NativeCallCoverage {
	readonly declarationSymbols: ReadonlySet<string>;
	sourceMap?: ReadonlyArray<NativeSourceRange>;
	/** The C symbol to install as MalFunction.compiled. */
	symbol: string;
	/** Final decisions from the exact emitted variant, never an exploratory pass. */
	profileDecisions: Array<BackendProfileDecision>;
	/** The full `static MalValue ...(...) { ... }` definition. */
	source: string;
	/** Relocatable bodies read their image indices from `<symbol>_link`, defined elsewhere. */
	link?: ReadonlyArray<NativeLinkSlot>;
	/** The canonical body's exported frameless fast path, which other fast paths call. */
	trySymbol?: string;
	tryParameters?: NativeFastTryParameters;
	/** Additional native-only ordinary-call symbols emitted beside the canonical body. */
	directEntries: Array<{
		readonly declarationSymbols: ReadonlySet<string>;
		sourceMap?: ReadonlyArray<NativeSourceRange>;
		emittedInstructions: ReadonlySet<number>;
		directEntryCalls: ReadonlyMap<number, ReadonlySet<number>>;
		id: number;
		symbol: string;
		/** A relocatable entry's own link table, like `CompiledFunction.link`. */
		link?: ReadonlyArray<NativeLinkSlot>;
		/**
		 * Independently emitted definition so an optional ABI sibling cannot evict the canonical body.
		 */
		source: string;
		parameterRepresentations: ReadonlyArray<VmRegisterRepresentation>;
		/** Caller storage pointers that follow the parameters of a record entry. */
		resultFieldRepresentations?: ReadonlyArray<VmRegisterRepresentation>;
		/** Record parameters whose caller storage pointers follow the result's. */
		recordParameters?: ReadonlyArray<{
			readonly index: number;
			readonly representations: ReadonlyArray<VmRegisterRepresentation>;
		}>;
		resultRepresentation: VmRegisterRepresentation;
		leaf?: true;
		callbackSymbol?: string;
		reductionSymbol?: string;
		sortSymbol?: string;
	}>;
}

export type DirectCompiledEntries = ReadonlyMap<
	string,
	NativeDirectEntryPlan & { readonly leaf?: true }
>;

type NativeRelocationBase =
	| "function_base"
	| "global_base"
	| "string_base"
	| "bigint_base"
	| "literal_template_base"
	// The link slot holds an import's ordinal; the first attach resolves its slot.
	| "global_imports";

/** One overlay-local index that a relocatable body adds to its runtime relocation base. */
export interface NativeLinkSlot {
	readonly base: NativeRelocationBase;
	readonly index: number;
}

/**
 * Index-stable emission. The body is named by a caller-chosen stem and reads image
 * indices from its link table, so its text changes only when the function itself does.
 */
export interface NativeRelocatableEmission {
	readonly symbolStem: string;
	/**
	 * C expression for a spliced overlay's `const MalNativeProgramRelocation *`, whose
	 * bases the link slots are relative to. Without it the slots hold image indices.
	 */
	readonly relocation?: string;
	/** Every overlay function's stem, which names direct call and entry targets. */
	readonly symbolStems?: ReadonlyArray<string>;
	/** Ordinal of each global slot the image imports from an earlier image. */
	readonly importedGlobals?: ReadonlyMap<number, number>;
}

interface NativeRelocationExpressions {
	readonly declarationSymbols: Set<string>;
	reference(symbol: string): string;
	readonly enabled: boolean;
	/** Offsets every index by its overlay's base, so foreign images can share scope chains. */
	readonly relative: boolean;
	/** Symbol-name component of a function: its stem in an overlay, else its index. */
	stem(index: number): string;
	/** Slots in first-use order, referenced as `<link symbol>[slot]`. */
	readonly link: ReadonlyArray<NativeLinkSlot>;
	readonly functionIndex: (index: number) => string;
	ownerFunctionIndex(index: number): string;
	globalIndex(index: number): string;
	stringIndex(index: number): string;
	bigintIndex(index: number): string;
	templateOffset(index: number): string;
	stringValue(index: number): string;
	bigintValue(index: number, suffix: string): string;
}

function nativeRelocationExpressions(
	linkSymbol: string | undefined,
	symbolStems?: ReadonlyArray<string>,
	relative = false,
	importedGlobals?: ReadonlyMap<number, number>,
): NativeRelocationExpressions {
	const link: Array<NativeLinkSlot> = [];
	const slots = new Map<string, number>();
	const indexed = (base: NativeRelocationBase, index: number): string => {
		if (linkSymbol === undefined) return String(index);
		const key = `${base}:${index}`;
		let slot = slots.get(key);
		if (slot === undefined) {
			slot = link.push({ base, index }) - 1;
			slots.set(key, slot);
		}
		if (base === "global_imports") {
			if (!relative) throw new Error("imported globals require a relocated overlay");
			return `(__mal_relocation->global_imports[${linkSymbol}[${slot}]])`;
		}
		return relative
			? `(__mal_relocation->${base} + ${linkSymbol}[${slot}])`
			: `${linkSymbol}[${slot}]`;
	};
	const enabled = linkSymbol !== undefined;
	const declarationSymbols = new Set<string>();
	const reference = (symbol: string) => {
		declarationSymbols.add(symbol);
		return symbol;
	};
	return {
		declarationSymbols,
		reference,
		enabled,
		relative: enabled && relative,
		stem: (index) => {
			if (symbolStems === undefined) return String(index);
			const stem = symbolStems[index];
			if (stem === undefined)
				throw new Error(`native overlay has no stem for function ${index}`);
			return stem;
		},
		link,
		functionIndex: (index) => indexed("function_base", index),
		ownerFunctionIndex: (index) =>
			index < 0 ? String(index) : indexed("function_base", index),
		globalIndex: (index) => {
			const ordinal = importedGlobals?.get(index);
			return ordinal === undefined
				? indexed("global_base", index)
				: indexed("global_imports", ordinal);
		},
		stringIndex: (index) => indexed("string_base", index),
		bigintIndex: (index) => indexed("bigint_base", index),
		templateOffset: (index) => indexed("literal_template_base", index),
		// Widening mutates the row, so literals must use the current VM's copy.
		stringValue: (index) =>
			`mal_value_from_string(&vm->runtime_image->string_constants[${indexed("string_base", index)}])`,
		bigintValue: (index, suffix) =>
			enabled
				? `mal_value_from_bigint(&vm->runtime_image->bigint_constants[${indexed("bigint_base", index)}])`
				: `mal_value_from_bigint(&${reference(`mal_bigints${suffix}`)}[${index}])`,
	};
}

export function directCompiledEntryKey(functionIndex: number, entryId: number): string {
	return `${functionIndex}:${entryId}`;
}

const UNRELOCATED_NATIVE_EXPRESSIONS = nativeRelocationExpressions(undefined);

/**
 * Debug emission publishes a frame's source position as the matching entry of the
 * image function's position table (see `positionTableEntries`).
 */
export type NativeFramePositions = ReadonlyMap<number, number> & {
	readonly captureSourceMap?: boolean;
};

function nativePositionEntry(
	positions: NativeFramePositions,
	functionIndex: number,
	pos: number,
): number {
	const entry = positions.get(pos);
	if (entry === undefined)
		throw new Error(
			`Native function ${functionIndex} publishes source position ${pos} outside its position table`,
		);
	return entry;
}

interface CoroutineContext {
	readonly suspension: NativeSuspensionPlan;
	positionEntry(ip: number): number;
	/** C expression for the function's index, relocated in an overlay. */
	functionIndex: string;
	selfSlot: number;
	/** Runtime condition for copying call arguments into the suspended frame. */
	retainArguments: string;
	/** Async function (not a generator): returns its result promise, uses ASYNC_START/AWAIT. */
	isAsyncFunction: boolean;
	/** `async function*`: GENERATOR_START-based, but its yields await + settle requests. */
	isAsyncGenerator: boolean;
}

/**
 * The property producer a region's declining fast path must run for itself, or
 * undefined when Core kept the load in place. The choice is Core's — the emitter
 * reads `propertyPlacement` and never rediscovers it from the distance between
 * the load and its call, which would make an optimization depend on layout.
 *
 * A deferred load leaves its callee register unwritten on the fast path, so the
 * region must also hold a locked identity whose fast form never reads that
 * register. Core proves this and the target boundary re-checks it; a mismatch here
 * is a broken certificate rather than a reason to emit the load anyway.
 */
function regionFallbackPropertyLoad(
	fn: BytecodeFunction,
	placement: CorePropertyPlacement,
	propertyIp: number,
	lockedIdentity: boolean,
): Extract<BytecodeInstruction, { opcode: "LOAD_PROPERTY_STATIC" }> | undefined {
	if (placement !== "call-fallback") return undefined;
	const instruction = fn.instructions[propertyIp];
	if (instruction?.opcode !== "LOAD_PROPERTY_STATIC") {
		throw new Error(
			`Deferred region property at instruction ${propertyIp} is not a load`,
		);
	}
	if (!lockedIdentity) {
		throw new Error(
			`Deferred region property at instruction ${propertyIp} has no locked identity`,
		);
	}
	return instruction;
}

/**
 * The resume points of a coroutine — the instruction after each suspend
 * (GENERATOR_START/YIELD/AWAIT), where a resume re-enters. The instruction pointer
 * is advanced past the suspend before the frame is saved, so the resume IP is the
 * following instruction.
 */
function resumePointsOf(fn: BytecodeFunction): Array<number> {
	const points: Array<number> = [];
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const opcode = fn.instructions[ip]!.opcode;
		if (opcode === "GENERATOR_START" || opcode === "YIELD" || opcode === "AWAIT") {
			points.push(ip + 1);
		}
	}
	return points;
}

/**
 * Render an f64 value as a valid C double expression. `toExponential()` is fine
 * for finite values but yields the bare words `Infinity`/`NaN` for non-finite
 * ones, which are not C constants — emit compiler builtins instead (no <math.h>
 * dependency). NaN cannot appear in a source literal, but a folded computation
 * could, so it is handled defensively.
 */
export function cF64Literal(value: number): string {
	if (Object.is(value, -0)) {
		return "-0.0";
	}
	if (Number.isNaN(value)) {
		return '__builtin_nan("")';
	}
	if (value === Infinity) {
		return "__builtin_inf()";
	}
	if (value === -Infinity) {
		return "-__builtin_inf()";
	}
	return value.toExponential();
}

/**
 * The relational comparisons. When BOTH operands are boxed (no static proof
 * either is a number) the backend still speculates a numeric compare for these —
 * `a < b` is overwhelmingly numeric in hot code and relational comparison coerces
 * to a number anyway — but NOT for equality (both-boxed `==`/`===` is typically
 * object/string identity, where the numeric bet loses and the strict slow path is
 * already coercion-free). The mixed case (one operand proven number) still
 * speculates every comparison, equality included: there the numeric prior is real.
 */
const RELATIONAL_COMPARE = new Set<string>(["<", "<=", ">", ">="]);
const BOXED_COMPARE: Readonly<Record<string, string>> = {
	"<": "mal_ops_less_than",
	"<=": "mal_ops_less_equal",
	">": "mal_ops_greater_than",
	">=": "mal_ops_greater_equal",
	"==": "mal_ops_equal",
	"!=": "mal_ops_not_equal",
	"===": "mal_ops_strict_equal",
	"!==": "mal_ops_strict_not_equal",
};

function producesNumberFromNumbers(operator: string): boolean {
	return (
		operator in NATIVE_ARITH ||
		operator in NATIVE_BITWISE ||
		operator === ">>>" ||
		operator === "%" ||
		operator === "**"
	);
}

const INT32_RESULT_OPERATORS: ReadonlySet<string> = new Set(["&", "|", "^", "<<", ">>"]);

function nativeInt32Expr(operator: string, left: string, right: string): string | null {
	const bitwise = NATIVE_BITWISE[operator];
	if (bitwise === undefined) return null;
	if (operator === "<<") {
		// Unsigned shifting preserves the low 32 bits without signed-overflow UB.
		return `mal_ops_u32_to_i32((u32) ${left} << (${right} & 0x1F))`;
	}
	const right32 = operator === ">>" ? `(${right} & 0x1F)` : right;
	return `${left} ${bitwise} ${right32}`;
}

const LENGTH_PROPERTY_UNITS = [..."length"].map((character) => character.charCodeAt(0));

function isLengthPropertyName(units: ReadonlyArray<number> | undefined): boolean {
	return (
		units !== undefined &&
		units.length === LENGTH_PROPERTY_UNITS.length &&
		units.every((unit, index) => unit === LENGTH_PROPERTY_UNITS[index])
	);
}

function numberToInt32(value: string, isInt32 = false): string {
	return isInt32 ? `((i32) ${value})` : `mal_ops_number_to_i32(${value})`;
}

function nativeNumberExpr(
	operator: string,
	left: string,
	right: string,
	inputIntegerRanges: ReadonlyArray<CompilerIntegerRange | undefined> | undefined,
	leftScalar = left,
	rightScalar = right,
): string | null {
	const arith = NATIVE_ARITH[operator];
	if (arith !== undefined) {
		return `${left} ${arith} ${right}`;
	}
	const left32 = numberToInt32(
		leftScalar,
		compilerIntegerRangeIsInt32(inputIntegerRanges?.[0]),
	);
	const right32 = numberToInt32(
		rightScalar,
		compilerIntegerRangeIsInt32(inputIntegerRanges?.[1]),
	);
	const bitwise = nativeInt32Expr(operator, left32, right32);
	if (bitwise !== null) return `(f64) (${bitwise})`;
	if (operator === ">>>") {
		return `(f64) ((u32) ${left32} >> (${right32} & 0x1F))`;
	}
	if (operator === "%") {
		return (
			nativeUnsignedRemainderExpression(
				left,
				right,
				inputIntegerRanges?.[0],
				inputIntegerRanges?.[1],
				leftScalar,
				rightScalar,
			) ?? `mal_number_remainder(${left}, ${right})`
		);
	}
	if (operator === "**") return `mal_number_exponentiate(${left}, ${right})`;
	return null;
}

const INT32_BINARY_OPERATORS: ReadonlySet<string> = new Set(["&", "|", "^", "<<", ">>"]);

interface IntegerRange {
	readonly low: number;
	readonly high: number;
}

const INT32_RANGE: IntegerRange = { low: -(2 ** 31), high: 2 ** 31 - 1 };
const UINT32_RANGE: IntegerRange = { low: 0, high: 2 ** 32 - 1 };
// The entry guard admits a carried input into an integer local only within this range.
const ADMITTED_INPUT_RANGE: IntegerRange = { low: -(2 ** 31), high: 2 ** 32 - 1 };
// A range still growing after this many rounds is an accumulator with no bound.
const INTEGER_RANGE_ROUNDS = 8;

/**
 * Registers whose every write in the region yields a safe integer, never -0. Doubles
 * and int64 agree exactly on sums and differences of such values.
 */
function integralLoopRegisters(
	fn: BytecodeFunction,
	order: ReadonlyArray<number>,
	flow: NativeNumberRecordDataflow,
	inputs: ReadonlyArray<number>,
	// Registers whose every value in the region the entry guards already bound.
	pinned: ReadonlyMap<number, IntegerRange>,
	// The values an element load can produce, when every view holds integers.
	elementLoads?: IntegerRange,
	// Registers that stay doubles, as inputs whose entry admits fractions do.
	doubles: ReadonlySet<number> = new Set(),
): Set<number> {
	const writers = new Map<number, Array<BytecodeInstruction>>();
	for (const ip of order) {
		const op = fn.instructions[ip]!;
		for (const register of vmInstructionWriteRegisters(op)) {
			const ops = writers.get(register) ?? [];
			ops.push(op);
			writers.set(register, ops);
		}
	}
	const functionWrites = new Map<number, Array<BytecodeInstruction>>();
	for (const op of fn.instructions)
		for (const register of vmInstructionWriteRegisters(op))
			if (inputs.includes(register) && !writers.has(register))
				functionWrites.set(register, [...(functionWrites.get(register) ?? []), op]);
	// The entry guard bounds any integral input; only loop invariants that can hold nothing
	// but an admissible constant join, so a fractional invariant never declines the region.
	const constants = [...functionWrites].flatMap(([register, [op, ...others]]) =>
		register >= fn.parameterCount &&
		others.length === 0 &&
		(op?.opcode === "CREATE_NUMBER" || op?.opcode === "CREATE_F64") &&
		flow.kinds.get(register) === "number" &&
		Number.isInteger(op.value) &&
		!Object.is(op.value, -0) &&
		op.value >= ADMITTED_INPUT_RANGE.low &&
		op.value <= ADMITTED_INPUT_RANGE.high
			? [register]
			: [],
	);
	const fixed = new Set([...constants, ...pinned.keys()]);
	// Registers that are not inputs start from their local's zero initializer.
	const ranges = new Map<number, IntegerRange | "unbounded">([
		...constants.map((register): [number, IntegerRange] => [
			register,
			ADMITTED_INPUT_RANGE,
		]),
		...[...writers.keys()]
			.filter((register) => flow.kinds.get(register) === "number")
			.map((register): [number, IntegerRange | "unbounded"] => [
				register,
				doubles.has(register)
					? "unbounded"
					: (pinned.get(register) ??
						(inputs.includes(register) ? ADMITTED_INPUT_RANGE : { low: 0, high: 0 })),
			]),
	]);
	const rangeOf = (register: number): IntegerRange | undefined => {
		const range = ranges.get(register);
		return range === "unbounded" ? undefined : range;
	};
	// Rounding never brings an unsafe bound back into the safe range, so the check is exact.
	const safe = (low: number, high: number): IntegerRange | undefined =>
		Number.isSafeInteger(low) && Number.isSafeInteger(high) ? { low, high } : undefined;
	const written = (op: BytecodeInstruction): IntegerRange | undefined => {
		switch (op.opcode) {
			case "BINARY": {
				if (INT32_BINARY_OPERATORS.has(op.operator)) return INT32_RANGE;
				if (op.operator === ">>>") return UINT32_RANGE;
				const left = rangeOf(op.left);
				const right = rangeOf(op.right);
				if (left === undefined || right === undefined) return undefined;
				// Neither a sum nor a difference of integers that are not -0 is -0.
				if (op.operator === "+")
					return safe(left.low + right.low, left.high + right.high);
				if (op.operator === "-")
					return safe(left.low - right.high, left.high - right.low);
				return undefined;
			}
			case "UNARY": {
				if (op.operator === "~") return INT32_RANGE;
				const source = rangeOf(op.src);
				if (source === undefined) return undefined;
				if (op.operator === "increment") return safe(source.low + 1, source.high + 1);
				if (op.operator === "decrement") return safe(source.low - 1, source.high - 1);
				return undefined;
			}
			case "CREATE_NUMBER":
			case "CREATE_F64":
				return Object.is(op.value, -0) ? undefined : safe(op.value, op.value);
			case "MOVE":
				return rangeOf(op.src);
			case "LOAD_PROPERTY":
				return elementLoads;
			// A region admits a call only as a string's code unit read.
			case "CALL":
				return { low: 0, high: 0xffff };
			default: {
				const builtin = nativeNumericBuiltinInstruction(op);
				return builtin?.operation === "Math.imul"
					? INT32_RANGE
					: builtin?.operation === "Math.clz32"
						? { low: 0, high: 32 }
						: undefined;
			}
		}
	};
	const rounds = new Map<number, number>();
	for (let changed = true; changed;) {
		changed = false;
		for (const [register, current] of ranges) {
			if (current === "unbounded") continue;
			if (fixed.has(register)) {
				// A pin holds only while every write it guards stays an integer.
				if (writers.get(register)?.every((op) => written(op) !== undefined) === false) {
					ranges.set(register, "unbounded");
					changed = true;
				}
				continue;
			}
			let { low, high } = current;
			let bounded = true;
			for (const op of writers.get(register)!) {
				const range = written(op);
				if (range === undefined) {
					bounded = false;
					break;
				}
				low = Math.min(low, range.low);
				high = Math.max(high, range.high);
			}
			if (bounded && low === current.low && high === current.high) continue;
			const round = (rounds.get(register) ?? 0) + 1;
			rounds.set(register, round);
			ranges.set(
				register,
				bounded && round <= INTEGER_RANGE_ROUNDS ? { low, high } : "unbounded",
			);
			changed = true;
		}
	}
	return new Set(
		[...ranges].flatMap(([register, range]) => (range === "unbounded" ? [] : [register])),
	);
}

// Forward block flags preserve whole-label splitting while both loop modes retain their original fallback.
function emitNumericLoopRegion(
	fn: BytecodeFunction,
	plan: NativeNumericLoopRegionPlan,
	reps: ReadonlyArray<VmRegisterRepresentation>,
	propertyCache: string,
	// The C statement that performs the binding load at an instruction.
	bindingLoad: (ip: number) => string,
	facts: NativeFunctionPlan["facts"],
): ReadonlyArray<string> {
	const members = new Set(plan.claimedIps.filter((ip) => ip !== plan.entryIp));
	const order = numericLoopOrder(fn, plan.id, members, true);
	// A region admits a call only as a string's code unit read.
	const codeUnitReads = new Set(
		[...members].filter((ip) => fn.instructions[ip]?.opcode === "CALL"),
	);
	const flow =
		order === undefined
			? undefined
			: numberRecordDataflow(
					fn,
					order,
					-1,
					reps,
					plan.kind !== "integer",
					codeUnitReads.size === 0 ? undefined : codeUnitReads,
					true,
				);
	const codeUnitMethods =
		order === undefined
			? new Set<number>()
			: numericLoopCodeUnitMethods(fn, order, codeUnitReads);
	if (order === undefined || flow === undefined)
		throw new Error("Invalid native integer loop region");
	const floating = plan.kind !== "integer";
	// The deferred cursor's index is the iteration state a restart must rewind.
	const cursor =
		plan.kind === "array-iteration" ? `__iter_deferred_${plan.initializeIp}` : undefined;
	const id = floating ? `__typed_loop_${plan.id}` : `__integer_loop_${plan.id}`;
	const kindOf = (register: number) => {
		const kind = flow.kinds.get(register);
		if (kind === undefined) throw new Error("Native integer loop register has no kind");
		return kind;
	};
	const local = (register: number) => `${id}_r${register}`;
	const start = (register: number) => `${id}_s${register}`;
	// The header keeps the index within its guarded range, and the final step leaves it by one stride.
	const counter = plan.kind === "fixed-numeric" ? plan.counter : undefined;
	const pinned = new Map<number, IntegerRange>();
	if (counter !== undefined) {
		const low = Math.min(0, counter.stride);
		const high = UINT32_RANGE.high + Math.max(0, counter.stride);
		if (Number.isSafeInteger(low) && Number.isSafeInteger(high))
			pinned.set(counter.index, { low, high });
	}
	// Integer locals spare the double round trip that each ToInt32 would otherwise take.
	const baseIntegral = floating
		? integralLoopRegisters(fn, order, flow, plan.inputs, pinned)
		: new Set<number>();
	// Over views of integer kinds, element loads are integers too. Inputs keep the
	// representation their shared entry admits.
	const integerIntegral =
		plan.kind === "fixed-numeric"
			? integralLoopRegisters(
					fn,
					order,
					flow,
					plan.inputs,
					pinned,
					ADMITTED_INPUT_RANGE,
					new Set(plan.inputs.filter((register) => !baseIntegral.has(register))),
				)
			: baseIntegral;
	const integerOnly = [...integerIntegral].filter(
		(register) => !baseIntegral.has(register),
	);
	// Integer views pay where an int32 conversion or a key would otherwise convert a double.
	const integerBody = order.some((ip) => {
		const op = fn.instructions[ip]!;
		const operands =
			op.opcode === "LOAD_PROPERTY" || op.opcode === "STORE_PROPERTY"
				? [op.key]
				: (op.opcode === "BINARY" &&
							(INT32_BINARY_OPERATORS.has(op.operator) || op.operator === ">>>")) ||
					  (op.opcode === "UNARY" && op.operator === "~") ||
					  ["Math.imul", "Math.clz32"].includes(
							nativeNumericBuiltinInstruction(op)?.operation ?? "",
					  )
					? vmInstructionReadRegisters(op)
					: [];
		return operands.some((register) => integerOnly.includes(register));
	});
	// Each loop body renders its statements against its own mode's representations.
	let integral = baseIntegral;
	const cType = (register: number) =>
		kindOf(register) === "boolean"
			? "bool"
			: !floating || integral.has(register)
				? "i64"
				: "f64";
	const num = (register: number) =>
		integral.has(register) ? `(f64) ${local(register)}` : local(register);
	const intOf = (register: number, ip: number) =>
		integral.has(register)
			? `mal_safe_integer_to_i32(${local(register)})`
			: numberToInt32(local(register), instructionInputIsInt32(facts?.[ip], register));
	const guards: Array<string> = [];
	const typedViewGuards: Array<string> = [];
	const arrayViewGuards: Array<string> = [];
	const rangePrelude: Array<string> = [];
	const initial = new Map<number, string>();
	for (const register of plan.inputs) {
		const representation = reps[register];
		if (kindOf(register) === "boolean") {
			if (representation !== "boolean")
				throw new Error("Native integer loop Boolean input is not unboxed");
			initial.set(register, `r${register}`);
			continue;
		}
		if (representation === "int32" && !floating) {
			initial.set(register, `(i64) r${register}`);
			continue;
		}
		const value =
			representation === "boxed"
				? `mal_ops_number_as_f64(r${register})`
				: `(f64) r${register}`;
		if (representation === "boxed") guards.push(`mal_ops_is_number(r${register})`);
		if (integral.has(register)) {
			const admitted = `${representation === "boxed" ? `mal_ops_is_number(r${register}) && ` : ""}${value} == trunc(${value}) && ${value} >= -2147483648.0 && ${value} <= 4294967295.0 && (${value} != 0.0 || !signbit(${value}))`;
			guards.push(`(${admitted})`);
			initial.set(register, `(${admitted}) ? (i64) ${value} : 0`);
			continue;
		}
		if (floating)
			initial.set(
				register,
				representation === "boxed"
					? `mal_ops_is_number(r${register}) ? ${value} : NAN`
					: value,
			);
		else guards.push(`mal_safe_integer_admit(${value}, &${local(register)})`);
	}
	const readOnly =
		plan.kind === "fixed-numeric" && plan.views.every((view) => !view.writable);
	const records = new Set(plan.kind !== "integer" ? (plan.records ?? []) : []);
	const checkedViews = new Set(
		plan.kind === "fixed-numeric"
			? plan.views.flatMap((view) => (view.checked === true ? [view.object] : []))
			: [],
	);
	// Records exist only for Array views.
	const arrayOnly = plan.kind === "fixed-numeric" && records.size > 0;
	const views = plan.kind === "fixed-numeric" ? plan.views : [];
	const textViews = views.filter((view) => view.text === true);
	const elementViews = views.filter((view) => view.text !== true);
	const textObjects = new Set(textViews.map((view) => view.object));
	// A region reading only strings has one body; element views pick theirs by kind.
	const textual = textViews.length > 0 && elementViews.length === 0;
	const boundObject = counter?.boundObject;
	const lengthLoad =
		counter !== undefined && boundObject !== undefined
			? fn.instructions
					.slice(plan.id, counter.comparison)
					.find(
						(op) =>
							(op.opcode === "LOAD_PROPERTY_STATIC" ||
								op.opcode === "LOAD_PROPERTY_STATIC_ARRAY_LENGTH") &&
							op.dst === counter.bound,
					)
			: undefined;
	if (boundObject !== undefined && lengthLoad === undefined)
		throw new Error("Invalid typed loop length load");
	// Inputs and views read these registers, so the loads precede every local.
	const bindingLoads = order.flatMap((ip) => {
		const op = fn.instructions[ip]!;
		if (op.opcode !== "LOAD_GLOBAL" && op.opcode !== "LOAD_CAPTURED") return [];
		guards.unshift(`!mal_value_is_empty(r${op.dst})`);
		return [`  ${bindingLoad(ip)}`];
	});
	// The reads come from guarded builtin calls licensed by locked primordials, where a
	// primitive string's `charCodeAt` is the builtin, so admitting the string suffices.
	if (textViews.length > 0)
		rangePrelude.push(
			`  bool ${id}_text = ${textViews
				.map((view) => `mal_string_unit_span(r${view.object}, &${id}_s${view.object})`)
				.join(" && ")};`,
		);
	// A primitive string's length is its own, so the string's admission proves the bound.
	const textBound = boundObject !== undefined && textObjects.has(boundObject);
	if (counter !== undefined && textBound)
		rangePrelude.push(
			`  ${local(counter.bound)} = ${id}_text ? (f64) ${id}_s${boundObject}.length : 0.0;`,
		);
	if (textual) {
		rangePrelude.push(`  bool ${id}_typed = ${id}_text;`, `  bool ${id}_array = false;`);
		guards.unshift(`${id}_typed`);
	} else if (plan.kind === "fixed-numeric") {
		// Views are admitted before the range so a length bound can read the admitted length.
		// A TypedArray's length is an inherited getter, so a length bound also needs the
		// length load's cache to prove the intrinsic getter.
		const typedAdmissions =
			arrayOnly ||
			lengthLoad?.opcode === "LOAD_PROPERTY_STATIC_ARRAY_LENGTH" ||
			(boundObject !== undefined && !views.some((view) => view.object === boundObject))
				? ["false"]
				: [
						...elementViews.map(
							(view) =>
								`mal_vm_fixed_numeric_storage(r${view.object}, 0, ${view.writable}, &${id}_v${view.object})`,
						),
						...(lengthLoad?.opcode === "LOAD_PROPERTY_STATIC" && !textBound
							? [
									`mal_vm_admit_numeric_typed_array_length(vm, r${boundObject}, &${propertyCache}[${lengthLoad.icIndex}], &${id}_lt, &${id}_ll)`,
								]
							: []),
					];
		const typedPossible = typedAdmissions[0] !== "false";
		rangePrelude.push(
			...(typedPossible && lengthLoad?.opcode === "LOAD_PROPERTY_STATIC" && !textBound
				? [`  MalTypedArrayObject *${id}_lt = nullptr;`, `  u32 ${id}_ll = 0;`]
				: []),
			`  bool ${id}_typed = ${typedAdmissions.join(" && ")};`,
			`  bool ${id}_array = ${readOnly ? `!${id}_typed && ${elementViews.map((view) => `mal_vm_dense_number_storage(r${view.object}, &${id}_a${view.object})`).join(" && ")}` : "false"};`,
		);
		if (counter !== undefined && boundObject !== undefined && !textBound)
			rangePrelude.push(
				`  ${local(counter.bound)} = ${typedPossible ? `${id}_typed ? (f64) ${id}_v${boundObject}.length : ` : ""}${readOnly ? `${id}_array ? (f64) ${id}_a${boundObject}.length : ` : ""}0.0;`,
			);
		guards.unshift(`(${id}_typed || ${id}_array)`);
		if (textViews.length > 0) guards.unshift(`${id}_text`);
	}
	if (counter !== undefined) {
		const comparison = fn.instructions[counter.comparison]!;
		if (comparison.opcode !== "BINARY") throw new Error("Invalid typed loop comparison");
		const ascending = counter.stride > 0;
		const inclusive = comparison.operator === "<=" || comparison.operator === ">=";
		const index = local(counter.index);
		const bound =
			counter.limitOffset === 0
				? local(counter.bound)
				: `(${local(counter.bound)} + ${cF64Literal(counter.limitOffset)})`;
		guards.push(
			`${index} >= 0.0`,
			`${index} <= UINT32_MAX`,
			`${index} == trunc(${index})`,
			`${bound} ${ascending ? ">" : "<"}${inclusive ? "=" : ""} ${index}`,
			ascending ? `${bound} <= UINT32_MAX` : `${bound} >= ${inclusive ? "0.0" : "-1.0"}`,
			`${bound} == trunc(${bound})`,
		);
		const range = `${id}_range`,
			last = `${id}_last`;
		const limit = inclusive ? bound : `(${bound} ${ascending ? "-" : "+"} 1.0)`;
		const distance = ascending
			? `((u64) ${limit} - (u64) ${index})`
			: `((u64) ${index} - (u64) ${limit})`;
		const stride = Math.abs(counter.stride);
		rangePrelude.push(
			`  bool ${range} = ${guards.join(" && ")};`,
			// The direction and endpoint guards make both unsigned operands a nonempty integral range.
			`  f64 ${last} = ${range} ? (f64) ((u64) ${index} ${ascending ? "+" : "-"} (${distance} / (u32) ${stride}) * (u32) ${stride}) : 0.0;`,
		);
		guards.length = 0;
		guards.push(range);
		for (const view of views) {
			if (view.checked === true && !view.writable) continue;
			const low = `(${ascending ? index : last} + ${cF64Literal(view.minOffset)})`;
			const high = `(${ascending ? last : index} + ${cF64Literal(view.maxOffset + 1)})`;
			if (view.minOffset !== 0) guards.push(`${low} >= 0.0`);
			guards.push(`${high} <= UINT32_MAX`);
			if (view.text === true) {
				typedViewGuards.push(`(u32) ${high} <= ${id}_s${view.object}.length`);
				arrayViewGuards.push(`(u32) ${high} <= ${id}_s${view.object}.length`);
				continue;
			}
			typedViewGuards.push(`(u32) ${high} <= ${id}_v${view.object}.length`);
			arrayViewGuards.push(`(u32) ${high} <= ${id}_a${view.object}.count`);
		}
	}
	if (plan.kind === "fixed-numeric") {
		typedViewGuards.unshift(`${id}_typed`);
		arrayViewGuards.unshift(`${id}_array`);
	}
	const materialize = (register: number, value: string) => {
		const representation = reps[register];
		if (kindOf(register) === "boolean")
			return `r${register} = ${representation === "boolean" ? value : `mal_value_new_boolean(${value})`};`;
		return `r${register} = ${
			representation === "number"
				? `(f64) ${value}`
				: representation === "int32"
					? floating
						? `mal_ops_number_to_i32(${value})`
						: `(i32) ${value}`
					: `mal_ops_number_value((f64) ${value})`
		};`;
	};
	const isBranch = (ip: number) => {
		const opcode = fn.instructions[ip]?.opcode;
		return opcode === "JUMP" || opcode === "JUMP_IF";
	};
	const predecessors = new Map<number, number>();
	for (const ip of order)
		for (const successor of numberRecordSuccessors(fn.instructions[ip]!, ip))
			predecessors.set(successor, (predecessors.get(successor) ?? 0) + 1);
	const heads = order.filter(
		(ip) =>
			ip === plan.id ||
			!members.has(ip - 1) ||
			isBranch(ip - 1) ||
			predecessors.get(ip) !== 1,
	);
	const headSet = new Set(heads);
	const exitIndex = new Map(plan.exits.map((exit, index) => [exit.targetIp, index + 1]));
	// An exit to a member is an inner loop's header, where its back edge leaves to poll.
	const innerHeaders = new Set(
		plan.exits.flatMap((exit) => (members.has(exit.targetIp) ? [exit.targetIp] : [])),
	);
	const position = new Map(order.map((ip, index) => [ip, index]));
	// Inner loops jump backward, which forward block flags cannot express.
	const label = (mode: string, ip: number) => `${id}_${mode}_L${ip}`;
	// Iterations restart from their saved start, so a guard never resumes mid-iteration.
	const restart = `{ ${id}_exit = 0; break; }`;
	const reach = (ip: number, from: number, mode: string): string => {
		if (ip === plan.id)
			return `${plan.carried.map((register) => `${start(register)} = ${local(register)};`).join(" ")}${cursor === undefined ? "" : ` ${id}_si = ${id}_ci;`} if (mal_gc_poll_requested_in(${id}_isolate)) ${restart} continue;`;
		if (innerHeaders.has(ip))
			return `${position.get(ip)! <= position.get(from)! ? `if (mal_gc_poll_requested_in(${id}_isolate)) { ${id}_exit = ${exitIndex.get(ip)}; break; } ` : ""}goto ${label(mode, ip)};`;
		const exit = exitIndex.get(ip);
		if (exit !== undefined) return `{ ${id}_exit = ${exit}; break; }`;
		return innerHeaders.size > 0 ? `goto ${label(mode, ip)};` : `${id}_b${ip} = true;`;
	};
	const truthy = (register: number, ip: number): string =>
		kindOf(register) === "boolean"
			? local(register)
			: nativeNumberTruthiness(
					local(register),
					instructionInputIntegerRange(facts?.[ip], register),
					!floating || integral.has(register),
				);

	const int32 = (register: number) => `mal_safe_integer_to_i32(${local(register)})`;
	const checked = (call: string, dst: number) =>
		`if (__builtin_expect(!${call.replace("%DST%", `&${local(dst)}`)}, 0)) ${restart}`;
	const statement = (
		ip: number,
		mode: "f64" | "typed" | "integer" | "array" | "text",
	): string => {
		const op = fn.instructions[ip]!;
		switch (op.opcode) {
			case "CALL_KNOWN":
			case "MATH_UNARY_NUMBER":
			case "MATH_BINARY_NUMBER": {
				const builtin = floating ? nativeNumericBuiltinInstruction(op) : undefined;
				if (builtin === undefined) throw new Error("Invalid numeric loop builtin");
				if (integral.has(op.dst)) {
					const [first, second] = builtin.arguments.map((argument) =>
						argument.kind === "number"
							? `(i32) ${argument.value | 0}`
							: intOf(argument.register, ip),
					);
					return builtin.operation === "Math.imul"
						? `${local(op.dst)} = (i64) (i32) ((u32) ${first} * (u32) ${second});`
						: `{ u32 ${id}_z = (u32) ${first}; ${local(op.dst)} = ${id}_z == 0 ? 32 : __builtin_clz(${id}_z); }`;
				}
				const arguments_ = builtin.arguments.map((argument) =>
					argument.kind === "number"
						? cF64Literal(argument.value)
						: num(argument.register),
				);
				const expression = nativeNumericBuiltinExpr(
					builtin.operation,
					arguments_,
					facts?.[ip]?.inputIntegerRanges?.slice(op.opcode === "CALL_KNOWN" ? 1 : 0),
				);
				if (expression === null)
					throw new Error("Invalid numeric loop builtin expression");
				return `${local(op.dst)} = ${expression};`;
			}
			case "ITERATOR_STEP": {
				if (cursor === undefined) throw new Error("Invalid numeric loop iterator step");
				const element = records.has(op.valueDst)
					? `if (__builtin_expect(!mal_value_is_heap_type(${id}_e, MAL_HEAP_OBJECT), 0)) ${restart} ${local(op.valueDst)} = ${id}_e;`
					: `if (__builtin_expect(!mal_ops_is_number(${id}_e), 0)) ${restart} ${local(op.valueDst)} = mal_ops_number_as_f64(${id}_e);`;
				return `if (${id}_cd || ${id}_ci >= ${id}_a.length) { ${id}_cd = true; ${local(op.doneDst)} = true; } else { if (__builtin_expect(${id}_ci >= ${id}_a.count, 0)) ${restart} MalValue ${id}_e = ${id}_a.elements[${id}_ci]; ${element} ${id}_ci++; ${local(op.doneDst)} = false; }`;
			}
			case "LOAD_PROPERTY_STATIC":
			case "LOAD_PROPERTY_STATIC_ARRAY_LENGTH":
				// Admission already proved the method its code unit read ignores.
				if (codeUnitMethods.has(ip)) return "";
				if (op.opcode === "LOAD_PROPERTY_STATIC" && records.has(op.object))
					// The site's own-slot row proves the field; any other row ends the iteration.
					return `{ const MalObject *${id}_o = (const MalObject *) mal_value_to_heap(${local(op.object)}); if (__builtin_expect(${id}_o->shape != ${id}_shape${op.icIndex}, 0)) ${restart} MalValue ${id}_f = ((const MalValue *) mal_object_fields_nonempty(${id}_o))[${id}_slot${op.icIndex}]; if (__builtin_expect(!mal_ops_is_number(${id}_f), 0)) ${restart} ${local(op.dst)} = mal_ops_number_as_f64(${id}_f); }`;
				if (boundObject === undefined || op.object !== boundObject)
					throw new Error("Invalid numeric loop length load");
				return `${local(op.dst)} = (f64) ${id}_${textObjects.has(op.object) ? "s" : mode === "array" ? "a" : "v"}${op.object}.length;`;
			case "CALL": {
				const argument = op.arguments[0];
				if (!textObjects.has(op.thisValue) || argument === undefined)
					throw new Error("Invalid numeric loop code unit read");
				const key = integral.has(argument) ? local(argument) : num(argument);
				const length = `${id}_s${op.thisValue}.length`;
				// `charCodeAt` past the end is NaN, which the original loop produces.
				const bound = !checkedViews.has(op.thisValue)
					? ""
					: integral.has(argument)
						? `if (__builtin_expect(!(${key} >= 0 && ${key} < (i64) ${length}), 0)) ${restart} `
						: `if (__builtin_expect(!(${key} >= 0.0 && ${key} < (f64) ${length}) || ${key} != trunc(${key}), 0)) ${restart} `;
				return `{ ${bound}${local(op.dst)} = ${integral.has(op.dst) ? "(i64)" : "(f64)"} mal_string_unit_span_at(&${id}_s${op.thisValue}, (u32) ${key}); }`;
			}
			case "LOAD_PROPERTY": {
				const key = integral.has(op.key) ? local(op.key) : num(op.key);
				const length = `${id}_${mode === "array" ? "a" : "v"}${op.object}.${mode === "array" ? "count" : "length"}`;
				// Any other key leaves the view to the generic load, which handles holes and non-indices.
				const bound = !checkedViews.has(op.object)
					? ""
					: integral.has(op.key)
						? `if (__builtin_expect(!(${key} >= 0 && ${key} < (i64) ${length}), 0)) ${restart} `
						: `if (__builtin_expect(!(${key} >= 0.0 && ${key} < (f64) ${length}) || ${key} != trunc(${key}), 0)) ${restart} `;
				if (mode === "array" && records.has(op.dst))
					return `{ ${bound}MalValue ${id}_e = ${id}_a${op.object}.elements[(u32) ${key}]; if (__builtin_expect(!mal_value_is_heap_type(${id}_e, MAL_HEAP_OBJECT), 0)) ${restart} ${local(op.dst)} = ${id}_e; }`;
				if (mode === "array")
					return `{ ${bound}MalValue ${id}_e = ${id}_a${op.object}.elements[(u32) ${key}]; if (__builtin_expect(!mal_ops_is_number(${id}_e), 0)) ${restart} ${local(op.dst)} = mal_ops_number_as_f64(${id}_e); }`;
				if (mode === "f64")
					return `{ ${bound}${local(op.dst)} = mal_scalar_f64_from_bits(mal_scalar_load_native_u64(${id}_v${op.object}.data + (usize)(u32) ${key} * 8)); }`;
				if (mode === "integer" && integral.has(op.dst))
					return `{ ${bound}${local(op.dst)} = mal_vm_fixed_integer_load(&${id}_v${op.object}, (u32) ${key}); }`;
				return `{ ${bound}${local(op.dst)} = ${integral.has(op.dst) ? "(i64) " : ""}mal_vm_fixed_numeric_load(&${id}_v${op.object}, (u32) ${key}); }`;
			}
			case "STORE_PROPERTY": {
				if (mode === "array") throw new Error("Invalid dense Array loop store");
				const key = integral.has(op.key) ? local(op.key) : num(op.key);
				return mode === "f64"
					? `mal_scalar_store_native_u64(${id}_v${op.object}.data + (usize)(u32) ${key} * 8, mal_scalar_f64_to_bits(${num(op.value)}));`
					: `mal_vm_fixed_numeric_store(&${id}_v${op.object}, (u32) ${key}, ${num(op.value)});`;
			}
			case "REQUIRE_COERCIBLE":
				// The element load already restarted the iteration for anything but an object.
				if (!records.has(op.src)) throw new Error("Invalid numeric loop coercible check");
				return "";
			// The entry loaded the binding and declined its dead zone; nothing inside stores it.
			case "LOAD_GLOBAL":
			case "LOAD_CAPTURED":
			case "THROW_IF_TDZ":
				return "";
			case "CREATE_NUMBER":
			case "CREATE_F64":
				return `${local(op.dst)} = ${floating && !integral.has(op.dst) ? cF64Literal(op.value) : `INT64_C(${op.value})`};`;
			case "CREATE_BOOLEAN":
				return `${local(op.dst)} = ${op.value};`;
			case "MOVE":
				return `${local(op.dst)} = ${integral.has(op.dst) ? local(op.src) : num(op.src)};`;
			case "BINARY": {
				const compared = compilerIntegerRangeComparison(
					op.operator,
					instructionInputIntegerRange(facts?.[ip], op.left),
					instructionInputIntegerRange(facts?.[ip], op.right),
				);
				if (compared !== undefined) return `${local(op.dst)} = ${compared};`;
				const compare = NATIVE_COMPARE[op.operator];
				if (compare !== undefined) {
					const exact = integral.has(op.left) && integral.has(op.right);
					return `${local(op.dst)} = ${exact ? local(op.left) : num(op.left)} ${op.operator === "===" || op.operator === "==" ? "==" : op.operator === "!==" || op.operator === "!=" ? "!=" : compare} ${exact ? local(op.right) : num(op.right)};`;
				}
				const left = local(op.left);
				const right = local(op.right);
				if (floating && integral.has(op.dst)) {
					const shift = `((u32) ${intOf(op.right, ip)} & 31u)`;
					switch (op.operator) {
						case "+":
						case "-":
							return `${local(op.dst)} = ${left} ${op.operator} ${right};`;
						case "&":
						case "|":
						case "^":
							return `${local(op.dst)} = (i64) (${intOf(op.left, ip)} ${op.operator} ${intOf(op.right, ip)});`;
						case "<<":
							return `${local(op.dst)} = (i64) (i32) ((u32) ${intOf(op.left, ip)} << ${shift});`;
						case ">>":
							return `${local(op.dst)} = (i64) (${intOf(op.left, ip)} >> ${shift});`;
						case ">>>":
							return `${local(op.dst)} = (i64) ((u32) ${intOf(op.left, ip)} >> ${shift});`;
						default:
							throw new Error(`Invalid integral loop operator ${op.operator}`);
					}
				}
				if (floating) {
					const expression = nativeNumberExpr(
						op.operator,
						num(op.left),
						num(op.right),
						facts?.[ip]?.inputIntegerRanges,
						local(op.left),
						local(op.right),
					);
					if (expression === null) throw new Error("Invalid numeric loop operator");
					return `${local(op.dst)} = ${expression};`;
				}
				switch (op.operator) {
					case "+":
						return checked(`mal_safe_integer_add(${left}, ${right}, %DST%)`, op.dst);
					case "-":
						return checked(`mal_safe_integer_sub(${left}, ${right}, %DST%)`, op.dst);
					case "*":
						return checked(`mal_safe_integer_mul(${left}, ${right}, %DST%)`, op.dst);
					case "/":
						return checked(`mal_safe_integer_div(${left}, ${right}, %DST%)`, op.dst);
					case "%":
						return checked(`mal_safe_integer_rem(${left}, ${right}, %DST%)`, op.dst);
					case "&":
						return `${local(op.dst)} = (i64) (${int32(op.left)} & ${int32(op.right)});`;
					case "|":
						return `${local(op.dst)} = (i64) (${int32(op.left)} | ${int32(op.right)});`;
					case "^":
						return `${local(op.dst)} = (i64) (${int32(op.left)} ^ ${int32(op.right)});`;
					case "<<":
						return `${local(op.dst)} = (i64) (i32) ((u32) ${int32(op.left)} << ((u32) ${int32(op.right)} & 31u));`;
					case ">>":
						return `${local(op.dst)} = (i64) (${int32(op.left)} >> ((u32) ${int32(op.right)} & 31u));`;
					case ">>>":
						return `${local(op.dst)} = (i64) ((u32) ${int32(op.left)} >> ((u32) ${int32(op.right)} & 31u));`;
					default:
						throw new Error(`Invalid native integer loop operator ${op.operator}`);
				}
			}
			case "UNARY": {
				const source = floating ? num(op.src) : local(op.src);
				if (floating && op.operator === "~")
					return `${local(op.dst)} = ${integral.has(op.dst) ? "(i64)" : "(f64)"} ~${intOf(op.src, ip)};`;
				if (floating && integral.has(op.dst)) {
					if (op.operator !== "increment" && op.operator !== "decrement")
						throw new Error(`Invalid integral loop operator ${op.operator}`);
					return `${local(op.dst)} = ${local(op.src)} ${op.operator === "increment" ? "+" : "-"} 1;`;
				}
				if (floating) {
					const expression =
						op.operator === "-"
							? `-${source}`
							: op.operator === "increment"
								? `${source} + 1.0`
								: op.operator === "decrement"
									? `${source} - 1.0`
									: op.operator === "~"
										? `(f64) ~${numberToInt32(source, instructionInputIsInt32(facts?.[ip], op.src))}`
										: op.operator === "!"
											? `!(${truthy(op.src, ip)})`
											: source;
					return `${local(op.dst)} = ${expression};`;
				}
				switch (op.operator) {
					case "-":
						return `if (__builtin_expect(${source} == 0, 0)) ${restart} ${local(op.dst)} = -${source};`;
					case "increment":
						return checked(`mal_safe_integer_add(${source}, 1, %DST%)`, op.dst);
					case "decrement":
						return checked(`mal_safe_integer_sub(${source}, 1, %DST%)`, op.dst);
					case "~":
						return `${local(op.dst)} = (i64) ~${int32(op.src)};`;
					case "!":
						return `${local(op.dst)} = !(${truthy(op.src, ip)});`;
					default:
						return `${local(op.dst)} = ${source};`;
				}
			}
			case "JUMP":
				return reach(op.targetIp, ip, mode);
			case "JUMP_IF": {
				const ranged = compilerIntegerRangeTruthiness(
					instructionInputIntegerRange(facts?.[ip], op.cond),
				);
				return ranged === undefined
					? `if (${truthy(op.cond, ip)}) { ${reach(op.targetIp, ip, mode)} } else { ${reach(ip + 1, ip, mode)} }`
					: reach(ranged ? op.targetIp : ip + 1, ip, mode);
			}
			default:
				throw new Error(`Invalid native integer loop instruction ${op.opcode}`);
		}
	};
	// Nothing in a region updates a cache, and every restart re-enters through the header.
	const fieldCaches = [
		...new Set(
			order.flatMap((ip) => {
				const op = fn.instructions[ip]!;
				return op.opcode === "LOAD_PROPERTY_STATIC" && records.has(op.object)
					? [op.icIndex]
					: [];
			}),
		),
	];
	const loopBody = (
		mode: "f64" | "typed" | "integer" | "array" | "text",
	): ReadonlyArray<string> => {
		integral = mode === "integer" ? integerIntegral : baseIntegral;
		const lines = [
			// Inner declarations shadow the shared locals that hold doubles elsewhere.
			...(mode === "integer"
				? integerOnly.map((register) => `    i64 ${local(register)} = 0;`)
				: []),
			...fieldCaches.flatMap((cache) => [
				`    const struct MalShape *${id}_shape${cache} = ${propertyCache}[${cache}].mode == MAL_IC_MODE_SHAPE ? ${propertyCache}[${cache}].shape : nullptr;`,
				`    u8 ${id}_slot${cache} = ${propertyCache}[${cache}].slot;`,
			]),
			...plan.carried.map(
				(register) => `    ${cType(register)} ${start(register)} = ${local(register)};`,
			),
			// The cursor lives in memory its helpers can reach; the loop steps a local copy.
			...(cursor === undefined
				? []
				: [
						`    u64 ${id}_ci = ${cursor}.index;`,
						`    bool ${id}_cd = ${cursor}.done;`,
						`    u64 ${id}_si = ${id}_ci;`,
					]),
			`    u8 ${id}_exit = 0;`,
			// Region instructions make no calls, so the thread's isolate cannot change inside.
			`    MalIsolateLocals *${id}_isolate = mal_isolate_locals();`,
			"    for (;;) {",
			...(innerHeaders.size > 0
				? []
				: heads.slice(1).map((ip) => `      bool ${id}_b${ip} = false;`)),
		];
		for (const head of heads) {
			lines.push(
				head === plan.id
					? "      {"
					: innerHeaders.size > 0
						? `      ${label(mode, head)}: {`
						: `      if (${id}_b${head}) {`,
			);
			let ip = head;
			for (;;) {
				lines.push(`        ${statement(ip, mode)}`);
				if (isBranch(ip)) break;
				if (!members.has(ip + 1) || headSet.has(ip + 1)) {
					lines.push(`        ${reach(ip + 1, ip, mode)}`);
					break;
				}
				ip++;
			}
			lines.push("      }");
		}
		lines.push("    }");
		for (const [index, exit] of plan.exits.entries()) {
			lines.push(`    if (${id}_exit == ${index + 1}) {`);
			for (const register of exit.outputs)
				lines.push(`      ${materialize(register, local(register))}`);
			if (cursor !== undefined)
				lines.push(
					`      ${cursor}.index = ${id}_ci;`,
					`      ${cursor}.done = ${id}_cd;`,
				);
			lines.push(`      goto L${exit.targetIp};`, "    }");
		}
		for (const register of plan.carried)
			lines.push(`    ${materialize(register, start(register))}`);
		if (cursor !== undefined) lines.push(`    ${cursor}.index = ${id}_si;`);
		lines.push(`    goto L${plan.id};`);
		integral = baseIntegral;
		return lines;
	};
	const typedBodies = textual
		? ["    MAL_PERF_COUNT(fixed_typed_array_region_admissions);", ...loopBody("text")]
		: plan.kind === "fixed-numeric"
			? [
					"    MAL_PERF_COUNT(fixed_typed_array_region_admissions);",
					...((counter?.stride ?? 1) > 1
						? ["    MAL_PERF_COUNT(fixed_typed_array_stride_regions);"]
						: []),
					...(views.some((view) => view.minOffset !== 0 || view.maxOffset !== 0)
						? ["    MAL_PERF_COUNT(fixed_typed_array_affine_regions);"]
						: []),
					...elementViews.map(
						(view) =>
							`    MAL_PERF_COUNT(fixed_typed_array_region_views[${id}_v${view.object}.kind]);`,
					),
					// One bounded specialization keeps kind dispatch out of the established Float64 loop.
					`    if (${elementViews.map((view) => `${id}_v${view.object}.kind == MAL_TA_FLOAT64`).join(" && ")}) {`,
					"      MAL_PERF_COUNT(fixed_typed_array_region_f64_admissions);",
					...loopBody("f64").map((line) => `  ${line}`),
					...(!integerBody
						? []
						: [
								`    } else if (${elementViews.map((view) => `${id}_v${view.object}.kind < MAL_TA_FLOAT32`).join(" && ")}) {`,
								...loopBody("integer").map((line) => `  ${line}`),
							]),
					"    } else {",
					...loopBody("typed").map((line) => `  ${line}`),
					"    }",
				]
			: loopBody("typed");
	const arrayBody = (): ReadonlyArray<string> => [
		"    MAL_PERF_COUNT(dense_array_number_region_admissions);",
		...loopBody("array"),
	];
	const lengthBound = arrayOnly;
	if (plan.kind === "array-iteration")
		return [
			"{",
			`  MalDenseNumberSpan ${id}_a = {0};`,
			...[...flow.kinds].map(([register, kind]) =>
				records.has(register)
					? `  MalValue ${local(register)} = MAL_VALUE_UNDEFINED;`
					: `  ${cType(register)} ${local(register)} = ${initial.get(register) ?? (kind === "boolean" ? "false" : "0")};`,
			),
			`  if (${[`${cursor}.active`, `mal_vm_dense_number_storage(r${plan.iterator}, &${id}_a)`, ...guards].join(" && ")}) {`,
			...arrayBody(),
			"  }",
			"}",
		];
	return [
		"{",
		...bindingLoads,
		...textViews.map((view) => `  MalStringUnitSpan ${id}_s${view.object} = {0};`),
		...elementViews.flatMap((view) => [
			...(lengthBound ? [] : [`  MalTypedArraySpan ${id}_v${view.object} = {0};`]),
			...(readOnly ? [`  MalDenseNumberSpan ${id}_a${view.object} = {0};`] : []),
		]),
		...[...flow.kinds].map(([register, kind]) =>
			records.has(register)
				? `  MalValue ${local(register)} = MAL_VALUE_UNDEFINED;`
				: `  ${cType(register)} ${local(register)} = ${initial.get(register) ?? (kind === "boolean" ? "false" : "0")};`,
		),
		...rangePrelude,
		...(lengthBound
			? [`  if (${[...guards, ...arrayViewGuards].join(" && ")}) {`, ...arrayBody()]
			: [
					`  if (${[...guards, ...typedViewGuards].join(" && ") || "true"}) {`,
					...typedBodies,
					...(readOnly && !textual
						? [
								`  } else if (${[...guards, ...arrayViewGuards].join(" && ")}) {`,
								...arrayBody(),
							]
						: []),
				]),
		"  }",
		"}",
	];
}

function emitNumberRecordRegion(
	fn: BytecodeFunction,
	plan: NativeNumberRecordRegionPlan,
	reps: ReadonlyArray<VmRegisterRepresentation>,
	propertyCache: string,
	shapeSnapshots: Set<number> | undefined,
	facts: NativeFunctionPlan["facts"],
): ReadonlyArray<string> {
	const members = new Set(plan.claimedIps);
	const order = numberRecordOrder(fn, plan.id, plan.exitIp, (ip) => members.has(ip));
	const flow =
		order?.length === members.size
			? numberRecordDataflow(fn, order, plan.exitIp, reps)
			: undefined;
	if (order === undefined || flow === undefined)
		throw new Error("Invalid native number record region");
	const id = `__number_record_${plan.id}`;
	const kindOf = (register: number) => {
		const kind = flow.kinds.get(register);
		if (kind === undefined) throw new Error("Native number record register has no kind");
		return kind;
	};
	const local = (register: number) => `${id}_r${register}`;
	const fieldIndex = new Map(
		plan.fields.map((field, index) => [field.stringIndex, index]),
	);
	const field = (stringIndex: number) => {
		const index = fieldIndex.get(stringIndex);
		if (index === undefined) throw new Error("Native number record field is unadmitted");
		return `${id}_v${index}`;
	};
	const stored = plan.fields.flatMap((entry, index) => (entry.stored ? [index] : []));
	const guards = [
		`mal_vm_number_record_begin(r${plan.object}, ${stored.length > 0}, &${id})`,
	];
	for (const [index, { icIndex }] of plan.fields.entries()) {
		shapeSnapshots?.add(icIndex);
		const snapshot =
			shapeSnapshots === undefined
				? "&(MalShapeSnapshot) {0}"
				: `&${shapeSnapshotName(icIndex)}`;
		guards.push(
			`mal_vm_number_record_field(&${id}, &${propertyCache}[${icIndex}], ${snapshot}, &${id}_f${index}, &${id}_v${index})`,
		);
	}
	const initial = new Map<number, string>();
	for (const register of plan.inputs) {
		const representation = reps[register];
		if (kindOf(register) === "boolean") {
			if (representation !== "boolean")
				throw new Error("Native number record Boolean input is not unboxed");
			initial.set(register, `r${register}`);
		} else if (representation === "boxed") {
			guards.push(`mal_ops_is_number(r${register})`);
			initial.set(register, `mal_ops_number_as_f64(r${register})`);
		} else
			initial.set(
				register,
				representation === "int32" ? `(f64) r${register}` : `r${register}`,
			);
	}
	const isBranch = (ip: number) => {
		const opcode = fn.instructions[ip]?.opcode;
		return opcode === "JUMP" || opcode === "JUMP_IF";
	};
	const predecessors = new Map<number, number>();
	for (const ip of order)
		for (const successor of numberRecordSuccessors(fn.instructions[ip]!, ip))
			predecessors.set(successor, (predecessors.get(successor) ?? 0) + 1);
	// A block continues only into the next instruction when that is its sole entry.
	const heads = order.filter(
		(ip) =>
			ip === plan.id ||
			!members.has(ip - 1) ||
			isBranch(ip - 1) ||
			predecessors.get(ip) !== 1,
	);
	const headSet = new Set(heads);
	const reach = (ip: number) => (ip === plan.exitIp ? "" : `${id}_b${ip} = true;`);
	const truthy = (register: number, ip: number): string =>
		kindOf(register) === "boolean"
			? local(register)
			: nativeNumberTruthiness(
					local(register),
					instructionInputIntegerRange(facts?.[ip], register),
				);

	const statement = (ip: number): string => {
		const op = fn.instructions[ip]!;
		switch (op.opcode) {
			case "CALL_KNOWN":
			case "MATH_UNARY_NUMBER":
			case "MATH_BINARY_NUMBER": {
				const builtin = nativeNumericBuiltinInstruction(op);
				if (builtin === undefined) throw new Error("Invalid numeric record builtin");
				const arguments_ = builtin.arguments.map((argument) =>
					argument.kind === "number"
						? cF64Literal(argument.value)
						: local(argument.register),
				);
				const expression = nativeNumericBuiltinExpr(
					builtin.operation,
					arguments_,
					facts?.[ip]?.inputIntegerRanges?.slice(op.opcode === "CALL_KNOWN" ? 1 : 0),
				);
				if (expression === null)
					throw new Error("Invalid numeric record builtin expression");
				return `${local(op.dst)} = ${expression};`;
			}
			case "LOAD_PROPERTY_STATIC":
				return `${local(op.dst)} = ${field(op.stringIndex)};`;
			case "STORE_PROPERTY_STATIC":
				return `${field(op.stringIndex)} = ${local(op.value)};`;
			case "CREATE_NUMBER":
			case "CREATE_F64":
				return `${local(op.dst)} = ${cF64Literal(op.value)};`;
			case "CREATE_BOOLEAN":
				return `${local(op.dst)} = ${op.value};`;
			case "LOAD_INTRINSIC":
				return `r${op.dst} = vm->intrinsics[${emitIntrinsic(op.intrinsic)}];`;
			case "MOVE":
				return `${local(op.dst)} = ${local(op.src)};`;
			case "BINARY": {
				const compared = compilerIntegerRangeComparison(
					op.operator,
					instructionInputIntegerRange(facts?.[ip], op.left),
					instructionInputIntegerRange(facts?.[ip], op.right),
				);
				if (compared !== undefined) return `${local(op.dst)} = ${compared};`;
				const compare = NATIVE_COMPARE[op.operator];
				const expression =
					compare === undefined
						? nativeNumberExpr(
								op.operator,
								local(op.left),
								local(op.right),
								facts?.[ip]?.inputIntegerRanges,
							)
						: `${local(op.left)} ${compare} ${local(op.right)}`;
				if (expression === null) throw new Error("Invalid native number record operator");
				return `${local(op.dst)} = ${expression};`;
			}
			case "UNARY": {
				const source = local(op.src);
				const expression =
					op.operator === "-"
						? `-${source}`
						: op.operator === "increment"
							? `${source} + 1.0`
							: op.operator === "decrement"
								? `${source} - 1.0`
								: op.operator === "~"
									? `(f64) ~${numberToInt32(source, instructionInputIsInt32(facts?.[ip], op.src))}`
									: op.operator === "!"
										? `!${truthy(op.src, ip)}`
										: source;
				return `${local(op.dst)} = ${expression};`;
			}
			case "JUMP":
				return reach(op.targetIp);
			case "JUMP_IF": {
				const ranged = compilerIntegerRangeTruthiness(
					instructionInputIntegerRange(facts?.[ip], op.cond),
				);
				return ranged === undefined
					? `if (${truthy(op.cond, ip)}) { ${reach(op.targetIp)} } else { ${reach(ip + 1)} }`
					: reach(ranged ? op.targetIp : ip + 1);
			}
			default:
				throw new Error(`Invalid native number record instruction ${op.opcode}`);
		}
	};
	const lines = [
		"{",
		`  MalNumberRecord ${id};`,
		...plan.fields.map(
			(_, index) =>
				`  MalNumberRecordField ${id}_f${index} = {0}; f64 ${id}_v${index} = 0.0;`,
		),
		`  if (${guards.join(" && ")}) {`,
		`    mal_vm_number_record_admitted(&${id});`,
		...[...flow.kinds].map(
			([register, kind]) =>
				`    ${kind === "boolean" ? "bool" : "f64"} ${local(register)} = ${initial.get(register) ?? (kind === "boolean" ? "false" : "0.0")};`,
		),
		...heads.slice(1).map((ip) => `    bool ${id}_b${ip} = false;`),
	];
	for (const head of heads) {
		lines.push(head === plan.id ? "    {" : `    if (${id}_b${head}) {`);
		let ip = head;
		for (;;) {
			const emitted = statement(ip);
			if (emitted !== "") lines.push(`      ${emitted}`);
			if (isBranch(ip)) break;
			if (!members.has(ip + 1) || headSet.has(ip + 1)) {
				const fallthrough = reach(ip + 1);
				if (fallthrough !== "") lines.push(`      ${fallthrough}`);
				break;
			}
			ip++;
		}
		lines.push("    }");
	}
	for (const index of stored)
		lines.push(
			`    mal_vm_number_record_store(&${id}, ${id}_f${index}, ${id}_v${index});`,
		);
	for (const register of plan.outputs) {
		const value = local(register);
		const representation = reps[register];
		lines.push(
			`    r${register} = ${
				kindOf(register) === "boolean"
					? representation === "boolean"
						? value
						: `mal_value_new_boolean(${value})`
					: representation === "number"
						? value
						: representation === "int32"
							? `mal_ops_number_to_i32(${value})`
							: `mal_ops_number_value(${value})`
			};`,
		);
	}
	lines.push(`    goto L${plan.exitIp};`, "  }", "}");
	return lines;
}

function nativeUnsignedExpr(
	operator: string,
	left: string,
	right: string,
	leftScalar = left,
	rightScalar = right,
): string {
	if (!["+", "-", "*", "%"].includes(operator))
		throw new Error("Invalid lowered native unsigned operation");
	return `(u32)(${leftScalar}) ${operator} (u32)(${rightScalar})`;
}

/**
 * Operators whose fully-general op never sets a THROW completion, so a boxed
 * fallback can skip the check. Only the strict-equality operators qualify:
 * they compare without any coercion. Every other operator can throw — `in`/
 * `instanceof` directly, arithmetic/bitwise/shift on a BigInt domain error, and
 * the relational/loose-equality comparisons whenever an object operand runs a
 * throwing valueOf/toString (ToPrimitive) or a Symbol forces a TypeError.
 */
const NON_THROWING_BINARY = new Set<string>(["===", "!=="]);

/**
 * Whether a binary operator can leave a THROW completion that a boxed fallback
 * must propagate. The boxed (and mixed-rep fallback) paths reach the general op,
 * so they need the completion check unless the operator can never throw.
 */
function binaryOpCanThrow(operator: string): boolean {
	return !NON_THROWING_BINARY.has(operator);
}

function nativeRootMaskStatements(masks: Iterable<NativeInactiveRootMask>): {
	readonly statements: ReadonlyMap<NativeInactiveRootMask, string>;
	readonly declarations: ReadonlyArray<string>;
} {
	const statements = new Map<NativeInactiveRootMask, string>();
	const distinct = new Set(masks);
	let width = 0;
	for (const mask of distinct) width = Math.max(width, Math.ceil(mask.length / 2));
	const rows: Array<string> = [];
	for (const mask of distinct) {
		if (width <= 1) {
			statements.set(mask, `MAL_ROOT_MASK(0x${nativeRootMaskWordHex(mask, 0)})`);
			continue;
		}
		const words: Array<string> = [];
		for (let word = 0; word < width * 2; word += 2) {
			const hex = nativeRootMaskWordHex(mask, word);
			// Huge frames repeat all-inactive words in thousands of masks; spell them compactly.
			words.push(
				hex === "ffffffffffffffff"
					? "UINT64_MAX"
					: hex === "0"
						? "0"
						: `UINT64_C(0x${hex})`,
			);
		}
		// One indexed table keeps each wide publication site independent of the frame width.
		statements.set(mask, `MAL_ROOT_MASK_ROW(${rows.length})`);
		rows.push(`        { ${words.join(", ")} },`);
	}
	return {
		statements,
		declarations:
			rows.length === 0
				? []
				: [`    static const u64 __gc_inactive_rows[][${width}] = {`, ...rows, "    };"],
	};
}

function cInactiveRootMaskPublication(
	mask: NativeInactiveRootMask,
	statements?: ReadonlyMap<NativeInactiveRootMask, string>,
): string {
	const statement = statements?.get(mask);
	if (statement !== undefined) return statement;
	if (mask.length > 2) throw new Error("Native wide root mask lacks a static row");
	// Without the function's mask table a row may have set the tail, so clear it too.
	return `mal_gc_root_frame_set_inactive(&__gc_frame, UINT64_C(0x${nativeRootMaskWordHex(mask, 0)}), nullptr, 0)`;
}

interface NativeRootPublicationPoint {
	readonly incoming: ReadonlySet<number>;
	readonly outgoing: ReadonlySet<number>;
	/** Private slots with their active occupant, in slot encounter order. */
	readonly active: ReadonlyArray<readonly [slot: number, register: number]>;
}

interface NativeRootPublication {
	readonly privateCallResultIps: ReadonlySet<number>;
	readonly entryStableRegisters: ReadonlySet<number>;
	readonly slots: ReadonlyMap<number, number>;
	readonly slotRegisters: ReadonlyMap<number, ReadonlyArray<number>>;
	/** Private slots initialized from their sole occupant's entry value. */
	readonly entrySlotRegisters: ReadonlyMap<number, number>;
	readonly safepoints: ReadonlyMap<number, NativeRootPublicationPoint>;
}

const EMPTY_ROOT_PUBLICATION: ReadonlyArray<string> = Object.freeze([]);
/**
 * Conditional publication cannot update the known-published state, so every deferred
 * miss repeats every unpublished root. Past this many stores, one hot-path publication
 * keeps later misses short and a function's C linear in its live roots.
 */
const MAX_DEFERRED_ROOT_PUBLICATION_STORES = 8;
// Each throws only for one rejected value, so its roots and position belong on that path.
const VALUE_GUARD_OPCODES: ReadonlySet<string> = new Set([
	"THROW_IF_TDZ",
	"REQUIRE_COERCIBLE",
]);
const EMPTY_ROOTED_OUTPUTS: ReadonlyArray<number> = Object.freeze([]);

function nativeRootPublicationPoint(
	point: NativeFunctionPlan["gc"]["safepoints"][number],
	slots: ReadonlyMap<number, number>,
	slotOrder: ReadonlyMap<number, number>,
): NativeRootPublicationPoint {
	const active: Array<readonly [slot: number, register: number]> = [];
	for (const register of point.rootRegisters) {
		const slot = slots.get(register);
		if (slot !== undefined) active.push([slot, register]);
	}
	active.sort((left, right) => slotOrder.get(left[0])! - slotOrder.get(right[0])!);
	for (let index = 1; index < active.length; index++)
		if (active[index]![0] === active[index - 1]![0])
			throw new Error(`Native private roots interfere at ${point.instructionIp}`);
	return {
		incoming: new Set(point.incomingRootRegisters),
		outgoing: new Set(point.outgoingRootRegisters),
		active,
	};
}

function cPrivateRootPublication(
	plan: NativeRootPublication | undefined,
	ip: number,
	edge: "incoming" | "outgoing",
	knownPublished?: ReadonlyMap<number, number>,
): ReadonlyArray<string> {
	const point = plan?.safepoints.get(ip);
	if (plan === undefined || point === undefined) return EMPTY_ROOT_PUBLICATION;
	const live = edge === "incoming" ? point.incoming : point.outgoing;
	let stores: Array<string> | undefined;
	// Slots without an active occupant are left to the inactive mask.
	for (const [slot, register] of point.active) {
		if (!live.has(register)) {
			// An output-only root must stay empty until the helper returns its value.
			(stores ??= []).push(`__gc_slots[${slot}] = MAL_VALUE_UNDEFINED;`);
		} else if (
			!plan.entryStableRegisters.has(register) &&
			knownPublished?.get(slot) !== register
		)
			(stores ??= []).push(`__gc_slots[${slot}] = r${register};`);
	}
	return stores ?? EMPTY_ROOT_PUBLICATION;
}

/**
 * Emit a compiled C function for `fn`, or null when it uses a construct the
 * backend doesn't lower yet (the caller then leaves it to the interpreter).
 */
function emitCompiledVariant(
	fn: BytecodeFunction,
	analysis: NativeBodyAnalysis,
	native: NativeFunctionPlan,
	index: number,
	suffix: string,
	debug: NativeFramePositions | false,
	linkage: "static" | "external" = "static",
	directCompiledTargets: ReadonlySet<number> = new Set(),
	semanticProtectors: ReadonlyArray<VmSemanticProtectorFact> = [],
	directCompiledEntries: DirectCompiledEntries = new Map(),
	relocatable: NativeRelocatableEmission | false = false,
	directEntry?: NativeDirectEntryPlan,
	strictCompiledTargets: ReadonlySet<number> = new Set(),
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
	maxCodeUnits = Infinity,
	splitPolicy: NativeSplitPolicy = DEFAULT_NATIVE_SPLIT_POLICY,
	fastTryTargets: ReadonlyMap<number, NativeFastTryParameters | undefined> = new Map(),
	directClosures: ReadonlyMap<string, NativeDirectClosureEnvironment> = new Map(),
	onFastTryLookup?: (target: number) => void,
): CompiledFunction | null {
	// Generators and async functions suspend mid-body: they lower to a resumable C
	// function (a heap register frame + entry dispatch to the saved resume point)
	// rather than the straight-line shape below (see emitResumableFunction).
	if (fn.isGenerator || fn.isAsync) {
		if (directEntry !== undefined) return null;
		return emitResumableFunction(
			fn,
			analysis,
			native,
			index,
			suffix,
			debug,
			linkage,
			semanticProtectors,
			stringConstants,
			directCompiledTargets,
			directCompiledEntries,
			strictCompiledTargets,
			maxCodeUnits,
			relocatable,
		);
	}
	if (directEntry !== undefined) validateNativeDirectEntry(fn, directEntry);
	validateNativeLiteralSwitches(fn, native);
	const variant =
		directEntry === undefined ? native : nativeVariantContract(native, directEntry);
	const variantContract = nativeControlFlowContract(
		variant,
		variant.storage?.controlFlow,
	);
	const variantStorage = variantContract.storage;
	if (variantStorage === undefined)
		throw new Error("Native rendering requires a lowered storage plan");
	const worker = directEntry === undefined ? undefined : variantStorage.numericWorker;
	const pollingWorker = worker !== undefined && worker.pollingIps.length > 0;
	const nativeContract = pollingWorker
		? nativeNumericWorkerContract(variantContract)
		: variantContract;
	const storage = pollingWorker
		? {
				...variantStorage,
				expressionIps: worker.expressionIps,
				definitionInitializedRegisters: worker.definitionInitializedRegisters,
				rematerializedConstantIps: worker.rematerializedConstantIps,
			}
		: variantStorage;
	const elidedResults = new Set(storage.unusedRegisters);
	const elidedIps = new Set(storage.elidedPureIps);

	// A function with its own captured slots needs a per-activation MalEnv node
	// (function_index == this function) for LOAD/STORE_CAPTURED(owner == self) and
	// for the closures it creates to capture. The interpreter's
	// push_function_frame allocates it; the compiled function allocates the same
	// node at entry (below) and reassigns `env` to it, so the body's captured
	// access and CREATE_FUNCTION see this activation's slots.
	const capturesEnv = fn.capturedCount > 0;
	const lazyCaptures = analysis.lazyCaptureEnvironment;

	if (
		nativeContract.registerRepresentations.length !== fn.registerCount ||
		nativeContract.registerRepresentations.some(
			(representation, register) =>
				(representation !== "boxed" &&
					representation !== "int32" &&
					representation !== "number" &&
					representation !== "boolean" &&
					representation !== "string") ||
				(register < fn.parameterCount &&
					representation !==
						(directEntry?.parameterRepresentations[register] ?? "boxed")),
		)
	) {
		throw new Error(`Invalid register representations for function ${index}`);
	}
	const reps = [...nativeContract.registerRepresentations];
	const name = relocatable === false ? index : relocatable.symbolStem;
	const symbol =
		directEntry !== undefined
			? `mal_direct_${name}_${directEntry.id}${suffix}`
			: `mal_compiled_${name}${suffix}`;
	const relocation = nativeRelocationExpressions(
		relocatable === false ? undefined : `${symbol}_link`,
		relocatable === false ? undefined : relocatable.symbolStems,
		relocatable !== false && relocatable.relocation !== undefined,
		relocatable === false ? undefined : relocatable.importedGlobals,
	);

	const valueRegs = [...storage.rootRegisters];
	const slotOf = new Map(
		valueRegs.map((local, index) => [local, storage.rootSlots[index]!]),
	);
	const privateCallResultIps = new Set(storage.privateCallResultIps);
	const privateCandidates = new Set(storage.privateRegisters);
	const privateSlots = new Map(
		[...slotOf].filter(([register]) => privateCandidates.has(register)),
	);
	const slotRegisters = new Map<number, Array<number>>();
	for (const [register, slot] of privateSlots) {
		const registers = slotRegisters.get(slot) ?? [];
		registers.push(register);
		slotRegisters.set(slot, registers);
	}
	const slotOrder = new Map(
		[...slotRegisters.keys()].map((slot, order) => [slot, order]),
	);
	const definitionInitialized = new Set(storage.definitionInitializedRegisters);
	const entrySlotRegisters = new Map<number, number>();
	for (const [slot, registers] of slotRegisters)
		if (registers.length === 1 && !definitionInitialized.has(registers[0]!))
			entrySlotRegisters.set(slot, registers[0]!);
	const rootPublication: NativeRootPublication = {
		privateCallResultIps,
		entryStableRegisters: new Set(storage.entryStableRootRegisters),
		slots: privateSlots,
		slotRegisters,
		entrySlotRegisters,
		safepoints:
			privateSlots.size === 0
				? new Map()
				: new Map(
						nativeContract.gc.safepoints.map((point) => [
							point.instructionIp,
							nativeRootPublicationPoint(point, privateSlots, slotOrder),
						]),
					),
	};
	const slotCount = storage.rootSlotCount;
	const inactiveRootMasks = nativeInactiveRootMasks(nativeContract.gc.safepoints, slotOf);
	const rootMaskStatements = nativeRootMaskStatements(inactiveRootMasks.values());
	const gcSafepointKinds = new Map(
		nativeContract.gc.safepoints.map((safepoint) => [
			safepoint.instructionIp,
			safepoint.kind,
		]),
	);

	// A derived constructor's `this` is uninitialized (the EMPTY sentinel) until
	// super() binds it, and CONSTRUCT_SUPER reassigns it mid-body — so it can't be
	// the immutable `this_value` parameter. It lives in its own rooted slot (the
	// bound instance is live across the rest of the body), initialized from the
	// EMPTY parameter and read through the TDZ-checked LOAD_THIS / RETURN forms.
	const thisSlot = fn.isDerivedConstructor ? slotCount : -1;
	// Stack scanning finds `this_value` while the body still reads it.
	const conservativeRoots = storage.stackRoots === "conservative";
	const retainsThis =
		!conservativeRoots &&
		!fn.isDerivedConstructor &&
		nativeContract.gc.safepoints.length > 0 &&
		fn.instructions.some((instruction) => instruction.opcode === "LOAD_THIS");
	const receiverSlot = retainsThis ? slotCount : -1;
	const stackSlotsBase = slotCount + (fn.isDerivedConstructor || retainsThis ? 1 : 0);
	const topology = analysis.regionTopology(
		nativeContract.specializations,
		nativeContract.regionActions,
	);
	const directHeapObjectIps = new Set(storage.directHeapObjectIps);
	const recordAllocations = new Map(
		directEntry?.resultFields?.allocationIps.map((ip, index) => {
			const shape = directEntry.resultFields!.shapes?.[index];
			return [
				ip,
				{
					fields: shape ?? directEntry.resultFields!.keys.map((_, field) => field),
					...(shape === undefined ? {} : { shape: index }),
					storage: directEntry.resultFields!.storage,
				},
			] as const;
		}) ?? [],
	);
	const stackObjectSites = new Map<number, StackObjectSite>();
	let nextStackSlot = stackSlotsBase;
	for (const action of topology.actionsByKind.get("stack-object-plan") ?? []) {
		const region = nativeContract.specializations[action.regionIndex];
		if (region?.kind !== "stack-object-plan" || action.role !== "allocate") continue;
		const site = region.sites[action.primaryIndex ?? -1];
		if (site === undefined || action.ip !== site.allocationIp) {
			throw new Error("Invalid stack-object allocation action");
		}
		const instruction = fn.instructions[site.allocationIp];
		if (
			(instruction?.opcode !== "CREATE_OBJECT" &&
				instruction?.opcode !== "CREATE_OBJECT_SHAPED") ||
			(instruction.opcode === "CREATE_OBJECT"
				? site.slotCount !== 0
				: instruction.count !== site.slotCount) ||
			stackObjectSites.has(site.allocationIp)
		) {
			throw new Error(
				`Invalid stack-object metadata at instruction ${site.allocationIp}`,
			);
		}
		if (
			directHeapObjectIps.has(site.allocationIp) ||
			recordAllocations.has(site.allocationIp)
		)
			continue;
		const fieldRepresentations = nativeContract.storage!.stackObjects.find(
			(plan) => plan.allocationIp === site.allocationIp,
		)?.slotRepresentations;
		const elided = site.mode === "elided";
		stackObjectSites.set(site.allocationIp, {
			objectName: `__stack_object_${site.allocationIp}`,
			...(elided
				? { elided: true }
				: fieldRepresentations === undefined
					? { slotsOffset: nextStackSlot }
					: {
							fieldSlots: fieldRepresentations.map((representation, slot) => ({
								name:
									representation === "boxed" || representation === "string"
										? `__gc_slots[${nextStackSlot++}]`
										: `__stack_object_${site.allocationIp}_slot_${slot}`,
								representation,
							})),
						}),
			slotCount: site.slotCount,
		});
		if (!elided && fieldRepresentations === undefined) nextStackSlot += site.slotCount;
		if (
			site.materializations.some((materialization) => materialization.kind === "observe")
		)
			stackObjectSites.get(site.allocationIp)!.materializedSlot = nextStackSlot++;
	}
	const stackObjectMaterializations = new Map<number, StackObjectMaterialization>();
	const stackObjectAccesses = new Map<number, { site: StackObjectSite; slot: number }>();
	const stackObjectInheritedAccesses = new Map<number, StackObjectSite>();
	for (const action of topology.actionsByKind.get("stack-object-plan") ?? []) {
		const region = nativeContract.specializations[action.regionIndex];
		if (region?.kind !== "stack-object-plan" || action.role === "allocate") continue;
		const planSite = region.sites[action.primaryIndex ?? -1];
		if (
			planSite !== undefined &&
			(directHeapObjectIps.has(planSite.allocationIp) ||
				recordAllocations.has(planSite.allocationIp))
		)
			continue;
		const site =
			planSite === undefined ? undefined : stackObjectSites.get(planSite.allocationIp);
		if (planSite === undefined || site === undefined) {
			throw new Error("Stack-object action has no allocation site");
		}
		if (action.role === "materialize") {
			const materialization = planSite.materializations[action.secondaryIndex ?? -1];
			const instruction = fn.instructions[action.ip];
			if (
				materialization?.ip !== action.ip ||
				(materialization.kind === "return"
					? instruction?.opcode !== "RETURN"
					: materialization.values === undefined) ||
				stackObjectMaterializations.has(action.ip)
			) {
				throw new Error(
					`Invalid stack-object materialization metadata at instruction ${action.ip}`,
				);
			}
			stackObjectMaterializations.set(action.ip, {
				site,
				values:
					materialization.kind === "return" && instruction?.opcode === "RETURN"
						? [instruction.value]
						: materialization.values!,
			});
		} else if (action.role === "access") {
			const access = planSite.accesses[action.secondaryIndex ?? -1];
			const instruction = fn.instructions[action.ip];
			if (
				access?.ip !== action.ip ||
				(instruction?.opcode !== "LOAD_PROPERTY_STATIC" &&
					instruction?.opcode !== "STORE_PROPERTY_STATIC" &&
					instruction?.opcode !== "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT" &&
					instruction?.opcode !== "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT") ||
				access.slot < 0 ||
				access.slot >= site.slotCount ||
				stackObjectAccesses.has(action.ip)
			) {
				throw new Error(
					`Invalid stack-object access metadata at instruction ${action.ip}`,
				);
			}
			stackObjectAccesses.set(action.ip, { site, slot: access.slot });
		} else if (action.role === "inherited") {
			const instruction = fn.instructions[action.ip];
			if (
				planSite.inheritedAccessIp !== action.ip ||
				instruction?.opcode !== "LOAD_PROPERTY_STATIC" ||
				region.license.guard.dependencies.length === 0 ||
				site.inheritedLoadInstructionIndex !== undefined ||
				stackObjectInheritedAccesses.has(action.ip)
			) {
				throw new Error(
					`Invalid inherited stack-object access metadata at instruction ${action.ip}`,
				);
			}
			site.inheritedLoadInstructionIndex = action.ip;
			site.inheritedIcIndex = instruction.icIndex;
			site.inheritedFastName = `${site.objectName}_inherited_fast`;
			site.inheritedValueName = `${site.objectName}_inherited_value`;
			site.inheritedGuard = region.license.guard;
			stackObjectInheritedAccesses.set(action.ip, site);
		} else {
			throw new Error(`Invalid stack-object action ${action.role}`);
		}
	}
	const stringSplitProjectionSites = new Map<number, NativeStringSplitProjectionSite>();
	for (const { projection, elementLoads } of topology.stringSplitProjections) {
		stringSplitProjectionSites.set(projection.callIp, {
			projection,
			subjectSlot: nextStackSlot++,
			slotsOffset: nextStackSlot,
			elementLoads,
			lockedIdentity: projection.splitIdentity === "authority-invariant",
		});
		nextStackSlot += elementLoads.length;
	}
	const stringSplitCursorSites = new Map<number, NativeStringSplitCursorSite>();
	for (const cursor of topology.stringSplitCursors) {
		const callIp = cursor.anchors[0]!;
		const lengthIp = cursor.anchors[2]!;
		const backedgeIp = cursor.anchors[3]!;
		const hoistTrimIdentity = cursor.trimIdentity === "runtime-guarded";
		stringSplitCursorSites.set(callIp, {
			cursor,
			callIp,
			lengthIp,
			backedgeIp,
			subjectSlot: nextStackSlot,
			traversalSlot: nextStackSlot + 1,
			...(hoistTrimIdentity ? { trimCalleeSlot: nextStackSlot + 2 } : {}),
			semanticEpochStable: cursor.license.admission.mode === "stable",
			epochName: `__string_split_cursor_${callIp}_semantic_epoch`,
			lockedIdentity: cursor.splitIdentity === "authority-invariant",
			lockedTrimIdentity: cursor.trimIdentity === "authority-invariant",
		});
		nextStackSlot += hoistTrimIdentity ? 3 : 2;
	}
	const regexpExecProjectionSites = new Map<number, NativeRegExpExecProjectionSite>();
	for (const { projection, loads } of topology.regexpExecProjections) {
		regexpExecProjectionSites.set(projection.callIp, {
			projection,
			subjectSlot: nextStackSlot,
			slotsOffset: nextStackSlot + 1,
			loads,
			spanMask: loads.reduce(
				(mask, load, index) => mask | (load.consumer === undefined ? 0 : 1 << index),
				0,
			),
		});
		nextStackSlot += loads.length + 1;
	}
	const regexpIteratorProjectionSites = new Map<
		number,
		NativeRegExpIteratorProjectionSite
	>();
	for (const { projection, loads } of topology.regexpIteratorProjections) {
		regexpIteratorProjectionSites.set(projection.stepIp, {
			projection,
			subjectSlot: nextStackSlot,
			slotsOffset: nextStackSlot + 1,
			loads,
		});
		nextStackSlot += loads.length + 1;
	}
	const stringSpanSites = new Map<number, NativeStringSpanSite>();
	for (const span of nativeContract.specializations) {
		if (span.kind !== "string-span") continue;
		stringSpanSites.set(span.callIp, {
			span,
			producerIp: span.callIp,
			consumers: span.consumers,
			subjectSlot: nextStackSlot++,
			materializedSlot: nextStackSlot++,
		});
	}
	for (const continuation of storage.spanContinuations) {
		if (continuation.sourceKind === "range") {
			stringSpanSites.set(continuation.producerIp, {
				producerIp: continuation.producerIp,
				rangeOperation: continuation.rangeOperation!,
				consumers: continuation.consumers,
				subjectSlot: nextStackSlot++,
				materializedSlot: nextStackSlot++,
			});
			continue;
		}
		const projection =
			continuation.sourceKind === "split"
				? stringSplitProjectionSites.get(continuation.sourceCallIp)
				: regexpExecProjectionSites.get(continuation.sourceCallIp);
		const loads =
			projection === undefined
				? []
				: "elementLoads" in projection
					? projection.elementLoads
					: projection.loads;
		const slot = loads.findIndex((load) => load.ip === continuation.producerIp);
		if (projection === undefined || slot < 0)
			throw new Error("Span continuation lacks its producer");
		if ("spanMask" in projection) projection.spanMask |= 1 << slot;
		stringSpanSites.set(continuation.producerIp, {
			producerIp: continuation.producerIp,
			projection: {
				kind: continuation.sourceKind,
				callIp: continuation.sourceCallIp,
				slot,
			},
			consumers: continuation.consumers,
			subjectSlot: projection.subjectSlot,
			materializedSlot: projection.slotsOffset + slot,
		});
	}
	for (const site of stringSpanSites.values()) {
		for (const consumer of site.consumers) {
			if (consumer.kind !== "rangeCall") continue;
			const child = stringSpanSites.get(consumer.ip);
			if (child === undefined || child.parent !== undefined)
				throw new Error("Invalid nested span parent");
			child.parent = site;
		}
	}
	const objectEnumerationSnapshotSites = new Map<
		number,
		NativeObjectEnumerationSnapshotSite
	>();
	for (const plan of storage.objectEnumerationSnapshots) {
		const snapshot = plan.elementIps.length > 0;
		const elementsSlot = snapshot ? nextStackSlot : -1;
		if (snapshot) nextStackSlot += NATIVE_ENUMERATION_SNAPSHOT_CAPACITY;
		const materializedSlot = snapshot ? nextStackSlot++ : -1;
		objectEnumerationSnapshotSites.set(plan.callIp, {
			...plan,
			elementsSlot,
			materializedSlot,
		});
	}
	const fieldCalls = renderFieldCallSlots(fn, nativeContract, () => nextStackSlot++);
	const records: NativeRecordStorage = {
		allocations: recordAllocations,
		forwards: new Map(
			directEntry?.resultFields?.forwards?.map((forward) => [
				forward.callIp,
				directEntry.resultFields!.storage,
			]) ?? [],
		),
		...renderRecordCallSlots(
			fn,
			nativeContract,
			storage.callTransports,
			directCompiledEntries,
			() => nextStackSlot++,
			directEntry,
		),
	};
	const captureShadow: NativeCaptureShadow | undefined =
		lazyCaptures === undefined
			? undefined
			: {
					plan: lazyCaptures,
					create: `env = mal_env_new_from_frame(vm, env, ${relocation.functionIndex(index)}, ${fn.capturedCount}, ${fn.closureCaptureOwners !== undefined}, &__gc_slots[${nextStackSlot}]);`,
					base: nextStackSlot,
					rootFrame: !conservativeRoots,
				};
	if (lazyCaptures !== undefined) nextStackSlot += fn.capturedCount;
	const totalSlots = nextStackSlot;

	// `with` pushes an object environment record onto the `env` chain (WITH_ENTER),
	// so a with-function reassigns `env` and needs the root frame to keep the live
	// with-env rooted (the with-object is live across property accesses in the body).
	const hasWith = fn.instructions.some((i) => i.opcode === "WITH_ENTER");

	// A root frame is needed to scan MalValue registers, a derived constructor's
	// `this`, this activation's captured env, and/or a reassigned `with` env; every
	// exit past its link must unlink it.
	const needsRootFrame =
		!conservativeRoots &&
		(totalSlots > 0 ||
			capturesEnv ||
			hasWith ||
			analysis.captures.copiedValues.length > 0);
	const retainsForwardedArguments = fn.instructions.some(
		(instruction) => instruction.opcode === "CALL_REST_ARGUMENTS",
	);
	const deferredRestRootIp = retainsForwardedArguments
		? undefined
		: deferredRestArgumentRootIp(nativeContract);
	const retainsArguments = retainsForwardedArguments || deferredRestRootIp !== undefined;
	const restArgumentRootReleaseIp = fn.instructions.some(
		(instruction) =>
			instruction.opcode === "LOAD_ARGUMENT" ||
			instruction.opcode === "LOAD_STATIC_ARGUMENT" ||
			instruction.opcode === "CREATE_ARGUMENTS_OBJECT",
	)
		? undefined
		: deferredRestRootIp;
	const argumentUnlink = retainsArguments ? "mal_gc_unroot(&__argument_roots); " : "";
	const gcUnlink =
		argumentUnlink + (needsRootFrame ? "vm->root_frame_head = __gc_frame.prev; " : "");

	const profileDecisions: Array<BackendProfileDecision> = [];
	const expressionIps = new Set(
		[...storage.expressionIps, ...storage.rematerializedConstantIps].filter(
			(ip) => !elidedIps.has(ip),
		),
	);
	const expressionStringComparisons = new Map(
		storage.stringComparisons.map((plan) => [plan.instructionIp, plan]),
	);
	const expressionRegisters = new Map<number, string>(
		[...expressionIps].map((ip) => {
			const op = fn.instructions[ip]!;
			if (!("dst" in op)) throw new Error("Native expression lacks a destination");
			return [
				op.dst,
				renderScalarExpression(
					op,
					reps,
					nativeContract.instructions[ip],
					relocation,
					suffix,
					nativeContract.facts?.[ip],
					expressionStringComparisons.get(ip),
				),
			];
		}),
	);
	const body = emitBody(
		fn,
		analysis,
		index,
		nativeContract.specializations,
		nativeContract.regionActions,
		nativeContract.instructions,
		nativeContract.facts,
		inactiveRootMasks,
		rootMaskStatements.statements,
		gcSafepointKinds,
		suffix,
		reps,
		debug,
		gcUnlink,
		thisSlot,
		null,
		stackObjectSites,
		stackObjectAccesses,
		stackObjectMaterializations,
		stackObjectInheritedAccesses,
		stringSplitProjectionSites,
		stringSplitCursorSites,
		regexpExecProjectionSites,
		regexpIteratorProjectionSites,
		stringSpanSites,
		objectEnumerationSnapshotSites,
		directCompiledTargets,
		directCompiledEntries,
		directEntry?.resultRepresentation,
		vmSemanticProtectorGuard(semanticProtectors, "watched-methods"),
		profileDecisions,
		relocation,
		strictCompiledTargets,
		directEntry?.argumentRepresentations,
		new Map(
			directEntry?.constantBooleans?.map(({ instructionIp, value }) => [
				instructionIp,
				value,
			]),
		),
		directEntry?.fieldParameters,
		fieldCalls,
		nativeContract.literalSwitches,
		stringConstants,
		rootPublication,
		new Set(storage.expressionIps),
		new Set(storage.rematerializedConstantIps),
		storage,
		storage.callTransports,
		storage.callbackTransports,
		new Set(storage.rootPublicationContinuations),
		maxCodeUnits,
		restArgumentRootReleaseIp,
		captureShadow,
		directClosures,
		!conservativeRoots,
		records,
		storage.controlFlow,
		storage.elidedPureIps,
		storage.stringComparisons,
	);
	if (body === null) {
		return null;
	}
	for (const ip of [...records.calls.keys(), ...records.passes.keys()])
		if (!body.directEntryCalls.has(ip))
			throw new Error(`Native record call ${ip} did not reach its record entry`);
	const privateRegisters = new Set(rootPublication.slots.keys());

	// Defensive: a register operand of -1 (a "no register" sentinel beyond the
	// RETURN case handled below) would emit invalid C like `r-1`. Bail to the
	// interpreter rather than emit broken code.
	if (body.lines.some((line) => line.includes("r-") && /\br-\d/.test(line))) {
		return null;
	}

	const lines: Array<string> = [];

	const directParameters =
		directEntry === undefined
			? undefined
			: [
					...(
						directEntry.argumentRepresentations ?? directEntry.parameterRepresentations
					).map((representation, parameter) => ({
						type: cTypeOf(representation),
						name: `p${parameter}`,
					})),
					...(directEntry.fieldParameters?.representations.map((rep, field) => ({
						type: cTypeOf(rep),
						name: `fp${field}`,
					})) ?? []),
					...(directEntry.resultFields === undefined
						? []
						: recordRepresentations(directEntry.resultFields).map(
								(representation, field) => ({
									type: `${cTypeOf(representation)} *`,
									name: `rf${field}`,
								}),
							)),
					...(directEntry.recordParameters ?? []).flatMap((parameter) =>
						recordParameterRepresentations(parameter).map((representation, field) => ({
							type: `${cTypeOf(representation)} *`,
							name: `rp${parameter.index}_${field}`,
						})),
					),
				];
	const parameterList =
		directParameters === undefined
			? "MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalEnv *env, MalValue callee, void *entry_state"
			: [
					"MalVm *vm",
					"MalValue this_value",
					...directParameters.map(({ type, name }) => `${type} ${name}`),
					"MalEnv *env",
					"MalValue callee",
				].join(", ");
	const resultType =
		directEntry === undefined ? "MalValue" : cTypeOf(directEntry.resultRepresentation);
	// Keep native entries on 64-byte boundaries as neighboring generated code changes.
	const signature = `${linkage === "static" ? "static " : ""}${NATIVE_ENTRY_ATTRIBUTES}__attribute__((aligned(64))) ${resultType} ${symbol}(${parameterList}) {`;
	const frameSignature = `${linkage === "static" ? "static " : ""}${NATIVE_ENTRY_ATTRIBUTES}MAL_COMPILED_FRAME __attribute__((aligned(64))) ${resultType} ${symbol}(${parameterList}) {`;
	lines.push(`    (void) this_value;`);
	if (directEntry === undefined) lines.push(`    (void) new_target;`);
	lines.push(`    (void) env;`);
	lines.push(`    (void) callee;`);
	if (relocatable !== false && relocatable.relocation !== undefined)
		lines.push(
			`    const MalNativeProgramRelocation *__mal_relocation = ${relocatable.relocation};`,
		);
	if (directEntry === undefined) lines.push(`    (void) entry_state;`);
	lines.push(
		...compiledFrameEntry(symbol, relocation.functionIndex(index)),
		`    if (__frame_row == nullptr) return ${directEntry === undefined ? "MAL_VALUE_UNDEFINED" : zeroOf(directEntry.resultRepresentation)};`,
		...COMPILED_ENTRY_SCOPE,
	);
	if (directEntry !== undefined && body.resources.has("newTarget")) {
		lines.push(`    const MalValue new_target = MAL_VALUE_UNDEFINED;`);
	}
	if (body.resources.has("propertyCache") || body.resources.has("literalShapes")) {
		const cacheMisses = [
			body.resources.has("propertyCache")
				? `vm->property_cache[${relocation.functionIndex(index)}].sites == nullptr`
				: undefined,
			body.resources.has("literalShapes")
				? `vm->literal_shape_cache[${relocation.functionIndex(index)}] == nullptr`
				: undefined,
		].filter((condition) => condition !== undefined);
		lines.push(
			`    if (__builtin_expect(${cacheMisses.join(" || ")}, 0)) {`,
			`        mal_vm_ensure_function_caches(vm, ${relocation.functionIndex(index)});`,
			`    }`,
		);
	}
	if (body.resources.has("propertyCache")) {
		lines.push(
			`    MalInlineCache *__property_ic = vm->property_cache[${relocation.functionIndex(index)}].sites;`,
		);
	}
	if (body.resources.has("literalShapes")) {
		lines.push(
			`    MalShape **__literal_shapes = vm->literal_shape_cache[${relocation.functionIndex(index)}];`,
		);
	}

	// Numeric/scalar and eligible private boxed registers are plain C locals.
	// Continuously rooted values alias the frame; the shared r<i> spelling lets
	// instruction lowering preserve its existing intermediate/output contracts.
	if (totalSlots > 0) {
		lines.push(`    MalValue __gc_slots[${totalSlots}];`);
		// Without a root frame, only an escaped array keeps stores the collector must see.
		if (conservativeRoots)
			lines.push(`    __asm__ volatile("" : : "r"(__gc_slots) : "memory");`);
	}
	for (const site of stackObjectSites.values()) {
		if (site.elided === true) continue;
		lines.push(`    MalEmbeddedObject ${site.objectName};`);
		for (const slot of site.fieldSlots ?? [])
			if (slot.representation !== "boxed" && slot.representation !== "string")
				lines.push(`    ${cTypeOf(slot.representation)} ${slot.name};`);
		if (site.inheritedLoadInstructionIndex !== undefined) {
			lines.push(`    bool ${site.inheritedFastName} = false;`);
			lines.push(`    MalValue ${site.inheritedValueName} = MAL_VALUE_UNDEFINED;`);
		}
	}
	// Helper outputs temporarily rename their private register to its shadow slot.
	const aliasedPrivateRegisters = new Set<number>();
	for (const [ip, instruction] of fn.instructions.entries())
		for (const register of nativeRootedOutputRegisters(
			instruction,
			ip,
			rootPublication.privateCallResultIps,
		))
			if (privateRegisters.has(register)) aliasedPrivateRegisters.add(register);
	const definedRegisters: Array<number> = [];
	const privateLocals: Array<string> = [];
	for (let i = 0; i < fn.registerCount; i++) {
		if (elidedResults.has(i)) continue;
		const slot = slotOf.get(i);
		const expression = expressionRegisters.get(i);
		if (expression !== undefined) {
			lines.push(`#define r${i} (${expression})`);
			definedRegisters.push(i);
		} else if (aliasedPrivateRegisters.has(i)) {
			lines.push(`    MalPrivateRoot __private_r${i};`);
			lines.push(`#define r${i} (__private_r${i})`);
			definedRegisters.push(i);
		} else if (privateRegisters.has(i)) {
			privateLocals.push(`r${i}`);
		} else if (slot !== undefined) {
			definedRegisters.push(i);
			lines.push(`#define r${i} (__gc_slots[${slot}])`);
		} else {
			lines.push(`    ${cTypeOf(reps[i]!)} r${i};`);
		}
	}
	for (let start = 0; start < privateLocals.length; start += 32)
		lines.push(
			`    MalPrivateRoot ${privateLocals.slice(start, start + 32).join(", ")};`,
		);

	for (const local of records.locals)
		lines.push(
			`    ${cTypeOf(local.representation)} ${local.name} = ${zeroOf(local.representation)};`,
		);

	for (let i = 0; i < fn.parameterCount; i++) {
		lines.push(
			directEntry === undefined
				? `    r${i} = arg_count > ${i} ? args[${i}] : MAL_VALUE_UNDEFINED;`
				: directEntry.argumentRepresentations !== undefined &&
					  i >= directEntry.argumentRepresentations.length
					? `    r${i} = MAL_VALUE_UNDEFINED;`
					: `    r${i} = p${i};`,
		);
	}
	const zeroedSlots = new Set<number>();
	for (let i = fn.parameterCount; i < fn.registerCount; i++) {
		if (elidedResults.has(i)) continue;
		if (expressionRegisters.has(i)) continue;
		// A fresh frame scans every root slot until its first mask, so slot-backed roots start zeroed.
		if (definitionInitialized.has(i) && (privateRegisters.has(i) || !slotOf.has(i)))
			continue;
		const slot = privateRegisters.has(i) ? undefined : slotOf.get(i);
		if (slot !== undefined) {
			if (zeroedSlots.has(slot)) continue;
			zeroedSlots.add(slot);
		}
		lines.push(`    r${i} = ${zeroOf(reps[i]!)};`);
	}
	for (const slot of rootPublication.slotRegisters.keys()) {
		const register = rootPublication.entrySlotRegisters.get(slot);
		lines.push(
			`    __gc_slots[${slot}] = ${register === undefined ? "MAL_VALUE_UNDEFINED" : `r${register}`};`,
		);
	}
	if (fn.argumentSnapshotCount > 0) {
		lines.push(
			`    MAL_PERF_ADD(argument_snapshot_logical_values, ${fn.argumentSnapshotCount});`,
			`    MAL_PERF_ADD(argument_snapshot_destination_writes, ${fn.argumentSnapshotCount});`,
		);
	}
	// A derived constructor's rooted `this` slot starts as the (EMPTY) parameter.
	if (thisSlot >= 0) {
		lines.push(`    __gc_slots[${thisSlot}] = this_value;`);
	}
	// Sloppy binding can box this after the caller roots its inputs; later LOAD_THIS still needs that box.
	if (receiverSlot >= 0) {
		lines.push(`    __gc_slots[${receiverSlot}] = this_value;`);
	}
	// Stack-object slots are roots, not heap-object edges: initialize every slot
	// before publishing the frame, then keep the entire run rooted for the whole
	// activation (including calls, exceptions, and later loop iterations).
	for (let slot = stackSlotsBase; slot < totalSlots; slot++) {
		lines.push(`    __gc_slots[${slot}] = MAL_VALUE_UNDEFINED;`);
	}

	// Publish the root frame first, with every register slot already initialized,
	// so the collector can scan them before any allocation. mal_env_new is now a GC
	// allocation (MalEnv is a cell), so the env is built and linked into the
	// already-published frame afterwards — never held unrooted across a safepoint.
	if (needsRootFrame) {
		lines.push(
			`    ${relocatable !== false ? "" : "static "}const MalFrameDescriptor __gc_desc = { .function_index = ${relocation.functionIndex(index)}, .slot_count = ${totalSlots} };`,
			`    MalRootFrame __gc_frame = { .prev = vm->root_frame_head, .desc = &__gc_desc, .slots = ${totalSlots > 0 ? "__gc_slots" : "nullptr"}, .inactive_slots = 0, .env = ${fn.closureCaptureOwners?.length === 0 ? "nullptr" : "env"} };`,
			`    vm->root_frame_head = &__gc_frame;`,
		);
	}

	if (retainsArguments) {
		// Deferred and elided rest arrays cannot root incoming values across earlier safepoints.
		lines.push(
			"    MalRootSpan __argument_roots;",
			"    mal_gc_root(&__argument_roots, (MalValue *) args, arg_count);",
		);
	}

	// Allocate this activation's captured-slot env (mirroring the interpreter) and
	// reassign `env` so the body's LOAD/STORE_CAPTURED(self) and CREATE_FUNCTION use
	// it, then root it in the published frame. capturesEnv implies needsRootFrame.
	// A lazy activation keeps its captured slots in the frame until it needs the env.
	if (capturesEnv && lazyCaptures === undefined) {
		lines.push(
			`    env = ${fn.closureCaptureOwners === undefined ? "mal_env_new" : "mal_env_new_compact"}(vm, env, ${relocation.functionIndex(index)}, ${fn.capturedCount});`,
			...(needsRootFrame ? [`    __gc_frame.env = env;`] : []),
		);
	}
	if (lazyCaptures?.guarded === true) lines.push("    bool __capture_env_ready = false;");

	for (const line of initializeFixedCaptureOwners(
		analysis.captures,
		relocation,
		true,
		capturesEnv && lazyCaptures === undefined ? "env->parent" : "env",
	)) {
		lines.push(`    ${line}`);
	}
	for (const line of initializeCopiedCaptureValues(analysis.captures, relocation)) {
		lines.push(`    ${line}`);
	}

	// Falling off the end returns undefined — or `this` for a constructor with no
	// explicit object return. A derived constructor routes through the checked
	// helper (returning before super() is a ReferenceError); everything else uses
	// mal_ops_construct_result (with new_target set for a [[Construct]] call).
	const fallOff = [
		directEntry !== undefined
			? `    ${gcUnlink}return ${zeroOf(directEntry.resultRepresentation)};`
			: thisSlot >= 0
				? `    ${gcUnlink}return mal_vm_op_derived_construct_return(vm, MAL_VALUE_UNDEFINED, __gc_slots[${thisSlot}]);`
				: !fn.hasPrototype
					? `    ${gcUnlink}return MAL_VALUE_UNDEFINED;`
					: `    ${gcUnlink}return mal_ops_construct_result(MAL_VALUE_UNDEFINED, this_value, new_target);`,
	];
	// Shared throw-exit: unlink the root frame and leave the compiled frame with the
	// throw pending (the dispatch caller observes vm->completion). Reached only by
	// `goto` from a no-handler throw; placed after the unconditional fall-off return
	// so control never falls into it. Omitted when nothing routes here.
	const throwExit = body.resources.has("throwExit")
		? [
				`__throw_exit:;`,
				`    ${gcUnlink}return ${directEntry === undefined ? "MAL_VALUE_UNDEFINED" : zeroOf(directEntry.resultRepresentation)};`,
			]
		: [];
	const trailer = definedRegisters.map((register) => `#undef r${register}`);
	const split = splitNativeFunction(
		{
			symbol,
			signature: frameSignature,
			resultType,
			inactiveRows: rootMaskStatements.declarations,
			prologue: lines,
			body: body.lines,
			unitStarts: body.unitStarts,
			fallOff,
			fallOffLabel: `L${fn.instructions.length}`,
			throwExit,
			trailer,
		},
		splitPolicy,
	);
	const fullSymbol = `${symbol}_full`;
	let fastSourceMap: ReadonlyArray<NativeSourceRange> = [];
	let tryParameters: NativeFastTryParameters | undefined;
	const fastEntry =
		split === undefined &&
		directEntry?.resultFields === undefined &&
		directEntry?.recordParameters === undefined
			? renderNativeFastEntry({
					fn,
					onTryParameters: (parameters) => {
						tryParameters = parameters;
					},
					onSourceMap:
						debug !== false && debug.captureSourceMap
							? (ranges) => {
									fastSourceMap = ranges;
								}
							: undefined,
					facts: nativeContract.facts,
					instructions: nativeContract.instructions,
					classLayouts: !relocation.relative,
					directEntry,
					controlFlow: storage.controlFlow,
					elidedPureIps: storage.elidedPureIps,
					stringComparisons: storage.stringComparisons,
					// A specialized-only body is omitted after emission, taking its fast path with it.
					trySymbol:
						directEntry === undefined && native.specializedOnly !== true
							? `${symbol}_try`
							: undefined,
					calleeTry: (ip, callee) => {
						const plan = nativeContract.instructions[ip];
						const target =
							plan?.kind === "call"
								? (plan.directFunctionIndex ??
									(plan.guardedFunctionIndices?.length === 1
										? plan.guardedFunctionIndices[0]
										: undefined))
								: undefined;
						if (target !== undefined) onFastTryLookup?.(target);
						return target !== undefined && fastTryTargets.has(target)
							? {
									symbol: `mal_compiled_${relocation.stem(target)}${suffix}_try`,
									parameters: fastTryTargets.get(target),
									...(plan?.kind === "call" && plan.directFunctionIndex === undefined
										? {
												guard: `mal_vm_callee_has_index(vm, ${callee}, ${relocation.functionIndex(target)})`,
											}
										: {}),
									environment:
										directClosureEnvironment(
											plan,
											directClosures,
											index,
											analysis.stableCaptureOwners,
											relocation,
											callee,
										) ?? `mal_value_to_function_object(${callee})->creation_env`,
								}
							: undefined;
					},
					// Numeric overlays preserve the bytecode a frameless entry proves independently.
					specialized:
						worker !== undefined ||
						(nativeContract.literalSwitches?.length ?? 0) > 0 ||
						nativeContract.specializations.some(
							(region) => region.kind !== "numeric-fusion",
						) ||
						nativeContract.regionActions.some(
							(action) =>
								nativeContract.specializations[action.regionIndex]?.kind !==
								"numeric-fusion",
						) ||
						storage.numberRecordRegions.length > 0 ||
						storage.propertyReadRegions.length > 0 ||
						storage.propertyReadPairs.length > 0 ||
						storage.propertyProjections.length > 0,
					signature,
					fullSymbol,
					fullArguments:
						directParameters === undefined
							? [
									"vm",
									"this_value",
									"args",
									"arg_count",
									"new_target",
									"env",
									"callee",
									"entry_state",
								]
							: [
									"vm",
									"this_value",
									...directParameters.map(({ name }) => name),
									"env",
									"callee",
								],
					prologue:
						relocatable !== false && relocatable.relocation !== undefined
							? [
									`    const MalNativeProgramRelocation *__mal_relocation = ${relocatable.relocation};`,
								]
							: [],
					functionIndex: relocation.functionIndex(index),
					functionTargetIndex: relocation.functionIndex,
					globalIndex: (global) => relocation.globalIndex(global),
					stringIndex: (string) => relocation.stringIndex(string),
					stringValue: (string) => relocation.stringValue(string),
					lengthProperty: (string) => isLengthPropertyName(stringConstants[string]),
					capturePrologue: [
						...initializeFixedCaptureOwners(analysis.captures, relocation, true, "env"),
						...initializeCopiedCaptureValues(analysis.captures, relocation),
					],
					capturedLoad: (owner, slot) => {
						const copied = analysis.copiedCaptures.get(captureValueKey(owner, slot));
						if (copied !== undefined) return `__capture_value_${copied}`;
						if (!analysis.stableCaptureOwners.has(owner))
							return `mal_vm_load_captured(env, ${relocation.ownerFunctionIndex(owner)}, ${slot})`;
						const name = captureOwnerName(relocation, owner);
						return analysis.requiredCaptureOwners.has(owner)
							? `${name}->slots[${slot}]`
							: `(${name} != nullptr ? ${name}->slots[${slot}] : MAL_VALUE_UNDEFINED)`;
					},
					f64Literal: cF64Literal,
				})
			: undefined;
	const bodyOffset =
		joinedCodeUnits([
			fastEntry === undefined
				? frameSignature
				: `static ${NATIVE_ENTRY_ATTRIBUTES}MAL_COMPILED_FRAME __attribute__((noinline)) __attribute__((aligned(64))) ${resultType} ${fullSymbol}(${parameterList}) {`,
			"#pragma STDC FP_CONTRACT OFF",
			...rootMaskStatements.declarations,
			...lines,
		]) + 1;
	const definition = split ?? [
		fastEntry === undefined
			? frameSignature
			: `static ${NATIVE_ENTRY_ATTRIBUTES}MAL_COMPILED_FRAME __attribute__((noinline)) __attribute__((aligned(64))) ${resultType} ${fullSymbol}(${parameterList}) {`,
		// Each JavaScript arithmetic operation rounds separately, including expression chains.
		"#pragma STDC FP_CONTRACT OFF",
		...rootMaskStatements.declarations,
		...lines,
		...body.lines,
		...fallOff,
		...throwExit,
		"}",
		...trailer,
		...(fastEntry ?? []),
	];
	const source = [
		...(relocation.link.length === 0 ? [] : [`extern const i32 ${symbol}_link[];`]),
		...(fastEntry === undefined
			? compiledFrameDescriptor(
					symbol,
					symbol,
					`${linkage === "static" ? "static " : ""}${resultType} ${symbol}(${parameterList})`,
				)
			: compiledFrameDescriptor(
					symbol,
					fullSymbol,
					`static ${resultType} ${fullSymbol}(${parameterList})`,
				)),
		...definition,
	];
	if (joinedCodeUnits(source) > maxCodeUnits) return null;
	const definitionOffset =
		joinedCodeUnits(source.slice(0, source.length - definition.length)) + 1;
	const sourceMap =
		body.sourceMap === undefined
			? undefined
			: split === undefined
				? [
						...shiftNativeSourceRanges(body.sourceMap, definitionOffset + bodyOffset),
						...shiftNativeSourceRanges(
							fastSourceMap,
							definitionOffset +
								joinedCodeUnits(
									definition.slice(0, definition.length - (fastEntry?.length ?? 0)),
								) +
								1,
						),
					]
				: [
						{
							start: definitionOffset,
							end: joinedCodeUnits(source),
							positions: [...new Set(fn.positions.filter((pos) => pos >= 0))],
							precision: "function" as const,
						},
					];
	return {
		...(sourceMap === undefined ? {} : { sourceMap }),
		symbol,
		declarationSymbols: new Set([
			symbol,
			...relocation.declarationSymbols,
			...generatedDeclarationSymbols((fastEntry ?? []).join("\n")),
		]),
		source: source.join("\n"),
		...(relocation.enabled ? { link: relocation.link } : {}),
		...(fastEntry !== undefined &&
		directEntry === undefined &&
		native.specializedOnly !== true
			? {
					trySymbol: `${symbol}_try`,
					...(tryParameters === undefined ? {} : { tryParameters }),
				}
			: {}),
		profileDecisions,
		emittedInstructions: body.emittedInstructions,
		directEntryCalls: body.directEntryCalls,
		directEntries: [],
	};
}

function renderScalarExpression(
	op: BytecodeInstruction,
	reps: ReadonlyArray<RegisterRep>,
	plan?: NativeInstructionPlan,
	relocation: NativeRelocationExpressions = UNRELOCATED_NATIVE_EXPRESSIONS,
	suffix = "",
	facts?: InstructionFacts,
	stringComparison?: NativeStringComparisonPlan,
): string {
	const number = (local: number) =>
		reps[local] === "boxed" ? `mal_ops_number_as_f64(r${local})` : `(f64) r${local}`;
	const int32 = (local: number) =>
		reps[local] === "int32"
			? `r${local}`
			: instructionInputIsInt32(facts, local)
				? `((i32) ${number(local)})`
				: `mal_ops_number_to_i32(${number(local)})`;
	const resultIsInt32 = (dst: number) =>
		reps[dst] === "int32" ||
		compilerIntegerRangeIsInt32(instructionResultIntegerRange(facts, dst));
	const exactInteger = (local: number) =>
		reps[local] === "int32" || instructionInputIsInt32(facts, local)
			? int32(local)
			: undefined;
	const numberResult = (dst: number, expression: string) =>
		resultIsInt32(dst)
			? reps[dst] === "boxed"
				? `mal_value_from_i32((i32) (${expression}))`
				: `(i32) (${expression})`
			: reps[dst] === "boxed"
				? `mal_ops_number_value(${expression})`
				: expression;
	const booleanResult = (dst: number, expression: string) =>
		reps[dst] === "boxed" ? `mal_value_new_boolean(${expression})` : expression;
	const kind = (local: number) =>
		isNumericRep(reps[local]!)
			? COMPILER_VALUE_KIND_NUMBER
			: reps[local] === "boolean"
				? COMPILER_VALUE_KIND_BOOLEAN
				: reps[local] === "string"
					? COMPILER_VALUE_KIND_STRING
					: (instructionInputKind(facts, local) ?? COMPILER_VALUE_KIND_TOP);
	const boxed = (local: number) =>
		reps[local] === "int32"
			? `mal_value_from_i32(r${local})`
			: reps[local] === "number"
				? `mal_ops_number_value(r${local})`
				: reps[local] === "boolean"
					? `mal_value_new_boolean(r${local})`
					: `r${local}`;
	const scalar = (local: number) =>
		kind(local) === COMPILER_VALUE_KIND_NUMBER
			? number(local)
			: kind(local) === COMPILER_VALUE_KIND_BOOLEAN
				? reps[local] === "boolean"
					? `r${local}`
					: `mal_value_to_boolean(r${local})`
				: kind(local) === COMPILER_VALUE_KIND_STRING
					? `mal_value_to_string(r${local})`
					: undefined;
	switch (op.opcode) {
		case "CREATE_UNDEFINED":
			return "MAL_VALUE_UNDEFINED";
		case "CREATE_NULL":
			return "MAL_VALUE_NULL";
		case "CREATE_BIGINT":
			return relocation.bigintValue(op.bigintIndex, suffix);
		case "CREATE_STRING":
			return relocation.stringValue(op.stringIndex);
		case "CREATE_NUMBER":
		case "CREATE_F64":
			if (reps[op.dst] === "boxed")
				return op.opcode === "CREATE_NUMBER"
					? `mal_value_from_i32(${op.value})`
					: `mal_value_from_f64_convert_nan(${cF64Literal(op.value)})`;
			return reps[op.dst] === "int32"
				? `(i32) (${cF64Literal(op.value)})`
				: cF64Literal(op.value);
		case "CREATE_BOOLEAN":
			return reps[op.dst] === "boxed"
				? `mal_value_new_boolean(${op.value})`
				: String(op.value);
		case "MOVE":
			return `r${op.src}`;
		case "CALL_KNOWN": {
			if (
				op.operation !== "Object.is" ||
				op.construct ||
				op.argumentMode !== undefined ||
				(op.specialized !== undefined && op.specialized !== op.operation)
			)
				throw new Error("Invalid native equality expression");
			const a =
				op.arguments[0] === undefined
					? ({ kind: "undefined" } as const)
					: decodeVmValueOperand(op.arguments[0]);
			const b =
				op.arguments[1] === undefined
					? ({ kind: "undefined" } as const)
					: decodeVmValueOperand(op.arguments[1]);
			const value = (operand: ReturnType<typeof decodeVmValueOperand>): string => {
				switch (operand.kind) {
					case "register":
						return boxed(operand.register);
					case "undefined":
						return "MAL_VALUE_UNDEFINED";
					case "null":
						return "MAL_VALUE_NULL";
					case "boolean":
						return operand.value ? "MAL_VALUE_TRUE" : "MAL_VALUE_FALSE";
					case "number":
						return `mal_ops_number_value(${cF64Literal(operand.value)})`;
					case "string":
						return relocation.stringValue(operand.index);
				}
			};
			const kindOf = (
				operand: ReturnType<typeof decodeVmValueOperand>,
			): CompilerValueKindMask => {
				switch (operand.kind) {
					case "register":
						return kind(operand.register);
					case "undefined":
						return COMPILER_VALUE_KIND_UNDEFINED;
					case "null":
						return COMPILER_VALUE_KIND_NULL;
					case "boolean":
						return COMPILER_VALUE_KIND_BOOLEAN;
					case "number":
						return COMPILER_VALUE_KIND_NUMBER;
					case "string":
						return COMPILER_VALUE_KIND_STRING;
				}
			};
			const scalarOf = (
				operand: ReturnType<typeof decodeVmValueOperand>,
			): string | undefined => {
				if (operand.kind === "register") return scalar(operand.register);
				if (operand.kind === "number") return cF64Literal(operand.value);
				if (operand.kind === "boolean") return String(operand.value);
				if (operand.kind === "string") return `mal_value_to_string(${value(operand)})`;
				return undefined;
			};
			return booleanResult(
				op.dst,
				nativeStringComparisonExpression(
					stringComparison,
					op.arguments[0]!,
					value(a),
					value(b),
				) ??
					nativeEqualityExpression(
						"same-value",
						value(a),
						value(b),
						kindOf(a),
						kindOf(b),
						scalarOf(a),
						scalarOf(b),
						a.kind === "register" &&
							b.kind === "register" &&
							reps[a.register] === "int32" &&
							reps[b.register] === "int32",
						a.kind === "register"
							? instructionInputIntegerRange(facts, a.register)
							: undefined,
						b.kind === "register"
							? instructionInputIntegerRange(facts, b.register)
							: undefined,
					),
			);
		}
		case "UNARY": {
			if (op.operator === "!")
				return booleanResult(
					op.dst,
					`!(${nativeTruthiness(
						`r${op.src}`,
						reps[op.src]!,
						instructionInputKind(facts, op.src) ?? COMPILER_VALUE_KIND_TOP,
						instructionInputIntegerRange(facts, op.src),
					)})`,
				);

			if (op.operator === "~")
				return reps[op.dst] === "int32"
					? `~${int32(op.src)}`
					: reps[op.dst] === "boxed"
						? `mal_value_from_i32(~${int32(op.src)})`
						: `(f64) (~${int32(op.src)})`;
			if (resultIsInt32(op.dst)) {
				const expression = nativeInt32UnaryExpression(op.operator, exactInteger(op.src));
				if (expression !== undefined) return numberResult(op.dst, expression);
			}
			if (op.operator === "increment" || op.operator === "decrement")
				return numberResult(
					op.dst,
					`${number(op.src)} ${op.operator === "increment" ? "+" : "-"} 1.0`,
				);
			return numberResult(op.dst, `${op.operator === "-" ? "-" : ""}(${number(op.src)})`);
		}
		case "BINARY": {
			const compared = compilerIntegerRangeComparison(
				op.operator,
				instructionInputIntegerRange(facts, op.left),
				instructionInputIntegerRange(facts, op.right),
			);
			if (compared !== undefined) return booleanResult(op.dst, String(compared));
			if (op.operator === "===" || op.operator === "!==") {
				const equal =
					nativeStringComparisonExpression(
						stringComparison,
						op.left,
						boxed(op.left),
						boxed(op.right),
					) ??
					nativeEqualityExpression(
						"strict",
						boxed(op.left),
						boxed(op.right),
						kind(op.left),
						kind(op.right),
						scalar(op.left),
						scalar(op.right),
						reps[op.left] === "int32" && reps[op.right] === "int32",
						instructionInputIntegerRange(facts, op.left),
						instructionInputIntegerRange(facts, op.right),
					);
				return booleanResult(op.dst, op.operator === "!==" ? `!(${equal})` : equal);
			}
			if (op.left === op.right) {
				const kind =
					instructionInputKind(facts, op.left) ??
					(isNumericRep(reps[op.left]!)
						? COMPILER_VALUE_KIND_NUMBER
						: reps[op.left] === "boolean"
							? COMPILER_VALUE_KIND_BOOLEAN
							: reps[op.left] === "string"
								? COMPILER_VALUE_KIND_STRING
								: COMPILER_VALUE_KIND_TOP);
				const expression = nativeReflexiveEqualityExpression(
					op.operator,
					`r${op.left}`,
					isNumericRep(reps[op.left]!) || kind === COMPILER_VALUE_KIND_NUMBER
						? number(op.left)
						: undefined,
					kind,
					reps[op.left] === "int32" ||
						instructionInputIntegerRange(facts, op.left) !== undefined,
				);
				if (expression !== undefined) return booleanResult(op.dst, expression);
			}
			if (plan?.kind === "unsigned-arithmetic") {
				const expression = nativeUnsignedExpr(
					op.operator,
					number(op.left),
					number(op.right),
					isNumericRep(reps[op.left]!) ? `r${op.left}` : undefined,
					isNumericRep(reps[op.right]!) ? `r${op.right}` : undefined,
				);
				return reps[op.dst] === "int32"
					? `mal_ops_u32_to_i32(${expression})`
					: numberResult(op.dst, `(f64) (${expression})`);
			}
			if (NATIVE_BITWISE[op.operator] !== undefined || op.operator === ">>>") {
				const expression =
					op.operator === ">>>"
						? `(u32) ${int32(op.left)} >> (${int32(op.right)} & 0x1F)`
						: nativeInt32Expr(op.operator, int32(op.left), int32(op.right));
				if (expression === null)
					throw new Error("Invalid lowered native bitwise expression");
				return reps[op.dst] === "int32"
					? expression
					: reps[op.dst] === "boxed" && op.operator !== ">>>"
						? `mal_value_from_i32(${expression})`
						: numberResult(op.dst, `(f64) (${expression})`);
			}
			const operand = (local: number) =>
				reps[local] === "boolean" ? `r${local}` : number(local);
			if (NATIVE_COMPARE[op.operator] !== undefined)
				return booleanResult(
					op.dst,
					`${operand(op.left)} ${NATIVE_COMPARE[op.operator]} ${operand(op.right)}`,
				);
			if (resultIsInt32(op.dst)) {
				const expression =
					nativeInt32ArithmeticExpression(
						op.operator,
						exactInteger(op.left),
						exactInteger(op.right),
					) ??
					(op.operator === "%"
						? nativeUnsignedRemainderExpression(
								number(op.left),
								number(op.right),
								instructionInputIntegerRange(facts, op.left),
								instructionInputIntegerRange(facts, op.right),
								isNumericRep(reps[op.left]!) ? `r${op.left}` : number(op.left),
								isNumericRep(reps[op.right]!) ? `r${op.right}` : number(op.right),
								"int32",
							)
						: undefined);
				if (expression !== undefined) return numberResult(op.dst, expression);
			}
			const expression = nativeNumberExpr(
				op.operator,
				number(op.left),
				number(op.right),
				facts?.inputIntegerRanges,
				isNumericRep(reps[op.left]!) ? `r${op.left}` : undefined,
				isNumericRep(reps[op.right]!) ? `r${op.right}` : undefined,
			);
			if (expression === null)
				throw new Error("Invalid lowered native scalar expression");
			return numberResult(op.dst, expression);
		}
		case "MATH_UNARY_NUMBER": {
			const expression = nativeMathUnaryExpr(
				op.operation,
				number(op.src),
				instructionInputIntegerRange(facts, op.src),
			);
			if (expression === null)
				throw new Error("Invalid lowered native unary Math expression");
			return expression;
		}
		case "MATH_BINARY_NUMBER": {
			const expression = nativeMathBinaryExpr(
				op.operation,
				number(op.left),
				number(op.right),
				facts?.inputIntegerRanges,
			);
			if (expression === null)
				throw new Error("Invalid lowered native binary Math expression");
			return expression;
		}
		default:
			throw new Error("Invalid lowered native scalar opcode");
	}
}

function renderNumericLeaf(
	native: NativeFunctionPlan,
	entry: NativeDirectEntryPlan,
	onSourceMap?: (ranges: ReadonlyArray<NativeSourceRange>) => void,
): Array<string> | null {
	const fn = native.body;
	const storage = entry.storage;
	if (storage === undefined)
		throw new Error("Numeric worker rendering requires a storage plan");
	const leaf = storage.numericWorker;
	if (leaf === undefined || leaf.pollingIps.length > 0) return null;
	const unreachable = new Set(storage.controlFlow?.unreachableIps);
	const elided = new Set(storage.elidedPureIps);
	const branches = new Map(
		storage.controlFlow?.branches.map(({ instructionIp, targetIp }) => [
			instructionIp,
			targetIp,
		]),
	);
	const reps = entry.registerRepresentations;
	const scalar = (r: number) => ["number", "int32", "boolean"].includes(reps[r]!);
	const number = (r: number) => `(f64) r${r}`;
	const expressionStringComparisons = new Map(
		storage.stringComparisons.map((plan) => [plan.instructionIp, plan]),
	);
	const expressionIps = new Set(
		[...leaf.expressionIps, ...leaf.rematerializedConstantIps].filter(
			(ip) => !unreachable.has(ip) && !elided.has(ip),
		),
	);
	const registers = new Set<number>();
	for (const [ip, op] of fn.instructions.entries()) {
		if (unreachable.has(ip) || elided.has(ip)) continue;
		for (const register of [
			...(branches.has(ip) ? [] : vmInstructionReadRegisters(op)),
			...vmInstructionWriteRegisters(op),
		])
			registers.add(register);
	}
	const expressions = new Map(
		[...expressionIps].map((ip) => {
			const op = fn.instructions[ip]!;
			if (!("dst" in op)) throw new Error("Native expression lacks a destination");
			return [
				op.dst,
				renderScalarExpression(
					op,
					reps,
					native.instructions[ip],
					undefined,
					"",
					native.facts?.[ip],
					expressionStringComparisons.get(ip),
				),
			];
		}),
	);
	const fallthroughJumps = new Set(leaf.fallthroughJumpIps);
	const jumpTargets = new Set(
		fn.instructions.flatMap((op, ip) =>
			(op.opcode === "JUMP" && !fallthroughJumps.has(ip)) || op.opcode === "JUMP_IF"
				? [op.targetIp]
				: [],
		),
	);
	const body: Array<string> = [];
	const starts: Array<number> = [];
	const ips: Array<number> = [];
	for (const [ip, op] of fn.instructions.entries()) {
		if (unreachable.has(ip)) continue;
		if (jumpTargets.has(ip)) body.push(`L${ip}:;`);
		if (elided.has(ip)) continue;
		if (expressionIps.has(ip) || fallthroughJumps.has(ip)) continue;
		const target = branches.get(ip);
		if (target !== undefined) {
			if (target !== ip + 1) {
				starts.push(body.length);
				ips.push(ip);
				body.push(`goto L${target};`);
			}
			continue;
		}
		let line: string;
		switch (op.opcode) {
			case "JUMP":
			case "JUMP_IF":
				line = `${op.opcode === "JUMP_IF" ? `if (r${op.cond}) ` : ""}goto L${op.targetIp};`;
				break;
			case "CREATE_NUMBER":
			case "CREATE_F64":
				line = `r${op.dst} = ${cF64Literal(op.value)};`;
				break;
			case "CREATE_BOOLEAN":
				line = `r${op.dst} = ${op.value};`;
				break;
			case "MOVE":
				line = `r${op.dst} = r${op.src};`;
				break;
			case "LOAD_PROPERTY_STATIC": {
				const field = entry.fieldParameters?.loads.find(
					(load) => load.instructionIp === ip,
				);
				if (field === undefined)
					throw new Error("Numeric worker lacks a selected field load");
				line = `r${op.dst} = fp${field.field};`;
				break;
			}
			case "BINARY":
			case "UNARY":
			case "MATH_UNARY_NUMBER":
			case "MATH_BINARY_NUMBER":
				line = `r${op.dst} = ${renderScalarExpression(op, reps, native.instructions[ip], undefined, "", native.facts?.[ip], expressionStringComparisons.get(ip))};`;
				break;
			case "RETURN":
				line = `return ${number(op.value)};`;
				break;
			default:
				throw new Error("Invalid selected numeric worker instruction");
		}
		starts.push(body.length);
		ips.push(ip);
		body.push(line);
	}
	const declarations: Array<string> = [];
	const definitionInitialized = new Set(leaf.definitionInitializedRegisters);
	for (const [r, rep] of reps.entries()) {
		if (!scalar(r) || r < fn.parameterCount || !registers.has(r)) continue;
		const expression = expressions.get(r);
		if (expression !== undefined) {
			declarations.push(`#define r${r} (${expression})`);
		} else {
			const initial = definitionInitialized.has(r) ? "" : " = 0";
			declarations.push(`${cTypeOf(rep)} r${r}${initial};`);
		}
	}
	onSourceMap?.(
		shiftNativeSourceRanges(
			nativeInstructionSourceRanges(fn, body, starts, ips),
			declarations.length === 0 ? 0 : joinedCodeUnits(declarations) + 1,
		),
	);
	return [
		...declarations,
		...body,
		...[...expressions.keys()].map((r) => `#undef r${r}`),
	];
}

export function emitCompiledFunction(
	native: NativeFunctionPlan,
	index: number,
	suffix: string,
	debug: NativeFramePositions | false,
	linkage: "static" | "external" = "static",
	directCompiledTargets: ReadonlySet<number> = new Set(),
	semanticProtectors: ReadonlyArray<VmSemanticProtectorFact> = [],
	directCompiledEntries: DirectCompiledEntries = new Map(),
	relocatable: NativeRelocatableEmission | false = false,
	strictCompiledTargets: ReadonlySet<number> = new Set(),
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
	callbackEntries: ReadonlySet<string> = new Set(),
	maxCodeUnits = Infinity,
	splitPolicy: NativeSplitPolicy = DEFAULT_NATIVE_SPLIT_POLICY,
	sortKernelEntries: ReadonlySet<string> = new Set(),
	reductionEntries: ReadonlySet<string> = new Set(),
	fastTryTargets: ReadonlyMap<number, NativeFastTryParameters | undefined> = new Map(),
	directClosures: ReadonlyMap<string, NativeDirectClosureEnvironment> = new Map(),
): CompiledFunction | null {
	if (native.storage === undefined)
		throw new Error("Native rendering requires a lowered storage plan");
	return renderCompiledFunction(
		analyzeNativeBody(native.body, native.storage.captures),
		native,
		index,
		suffix,
		debug,
		linkage,
		directCompiledTargets,
		semanticProtectors,
		directCompiledEntries,
		relocatable,
		strictCompiledTargets,
		stringConstants,
		callbackEntries,
		maxCodeUnits,
		splitPolicy,
		sortKernelEntries,
		reductionEntries,
		fastTryTargets,
		directClosures,
	);
}

// The image is immutable during one emission; a fresh renderer rechecks later image mutations.
// Lookups include missing callees that can block fast admission.
export function createNativeFunctionRenderer(
	onFastTryLookup?: (caller: number, target: number) => void,
): typeof emitCompiledFunction {
	const analyses = new Map<
		number,
		{
			body: BytecodeFunction;
			captures: NativeCaptureAccessPlan;
			analysis: NativeBodyAnalysis;
		}
	>();
	return (
		native: NativeFunctionPlan,
		index: number,
		suffix: string,
		debug: NativeFramePositions | false,
		linkage: "static" | "external" = "static",
		directCompiledTargets: ReadonlySet<number> = new Set(),
		semanticProtectors: ReadonlyArray<VmSemanticProtectorFact> = [],
		directCompiledEntries: DirectCompiledEntries = new Map(),
		relocatable: NativeRelocatableEmission | false = false,
		strictCompiledTargets: ReadonlySet<number> = new Set(),
		stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
		callbackEntries: ReadonlySet<string> = new Set(),
		maxCodeUnits = Infinity,
		splitPolicy: NativeSplitPolicy = DEFAULT_NATIVE_SPLIT_POLICY,
		sortKernelEntries: ReadonlySet<string> = new Set(),
		reductionEntries: ReadonlySet<string> = new Set(),
		fastTryTargets: ReadonlyMap<number, NativeFastTryParameters | undefined> = new Map(),
		directClosures: ReadonlyMap<string, NativeDirectClosureEnvironment> = new Map(),
	): CompiledFunction | null => {
		if (native.storage === undefined)
			throw new Error("Native rendering requires a lowered storage plan");
		const previous = analyses.get(index);
		const analysis =
			previous?.body === native.body && previous.captures === native.storage.captures
				? previous.analysis
				: analyzeNativeBody(native.body, native.storage.captures);
		if (previous?.analysis !== analysis)
			analyses.set(index, {
				body: native.body,
				captures: native.storage.captures,
				analysis,
			});
		return renderCompiledFunction(
			analysis,
			native,
			index,
			suffix,
			debug,
			linkage,
			directCompiledTargets,
			semanticProtectors,
			directCompiledEntries,
			relocatable,
			strictCompiledTargets,
			stringConstants,
			callbackEntries,
			maxCodeUnits,
			splitPolicy,
			sortKernelEntries,
			reductionEntries,
			fastTryTargets,
			directClosures,
			onFastTryLookup === undefined
				? undefined
				: (target) => onFastTryLookup(index, target),
		);
	};
}

function renderCompiledFunction(
	analysis: NativeBodyAnalysis,
	native: NativeFunctionPlan,
	index: number,
	suffix: string,
	debug: NativeFramePositions | false,
	linkage: "static" | "external" = "static",
	directCompiledTargets: ReadonlySet<number> = new Set(),
	semanticProtectors: ReadonlyArray<VmSemanticProtectorFact> = [],
	directCompiledEntries: DirectCompiledEntries = new Map(),
	relocatable: NativeRelocatableEmission | false = false,
	strictCompiledTargets: ReadonlySet<number> = new Set(),
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
	callbackEntries: ReadonlySet<string> = new Set(),
	maxCodeUnits = Infinity,
	splitPolicy: NativeSplitPolicy = DEFAULT_NATIVE_SPLIT_POLICY,
	sortKernelEntries: ReadonlySet<string> = new Set(),
	reductionEntries: ReadonlySet<string> = new Set(),
	fastTryTargets: ReadonlyMap<number, NativeFastTryParameters | undefined> = new Map(),
	directClosures: ReadonlyMap<string, NativeDirectClosureEnvironment> = new Map(),
	onFastTryLookup?: (target: number) => void,
): CompiledFunction | null {
	const fn = native.body;
	const canonical = emitCompiledVariant(
		fn,
		analysis,
		native,
		index,
		suffix,
		debug,
		linkage,
		directCompiledTargets,
		semanticProtectors,
		directCompiledEntries,
		relocatable,
		undefined,
		strictCompiledTargets,
		stringConstants,
		maxCodeUnits,
		splitPolicy,
		fastTryTargets,
		directClosures,
		onFastTryLookup,
	);
	if (canonical === null) return null;
	const name = relocatable === false ? index : relocatable.symbolStem;
	const variants = native.directEntries.flatMap<{
		entry: NativeDirectEntryPlan;
		emitted: CompiledFunction;
		leaf: true | undefined;
		sortSymbol: string | undefined;
	}>((entry) => {
		const emitted = emitCompiledVariant(
			fn,
			analysis,
			native,
			index,
			suffix,
			debug,
			linkage,
			directCompiledTargets,
			semanticProtectors,
			directCompiledEntries,
			relocatable,
			entry,
			strictCompiledTargets,
			stringConstants,
			maxCodeUnits,
			splitPolicy,
			fastTryTargets,
			directClosures,
			onFastTryLookup,
		);
		if (emitted === null) return [];
		let leafSourceMap: ReadonlyArray<NativeSourceRange> = [];
		const worker = renderNumericLeaf(
			nativeVariantContract(native, entry),
			entry,
			debug !== false && debug.captureSourceMap
				? (ranges) => {
						leafSourceMap = ranges;
					}
				: undefined,
		);
		if (worker === null)
			return [{ entry, emitted, leaf: undefined, sortSymbol: undefined }];
		const parameters = entry.parameterRepresentations
			.map((rep, i) => `${cTypeOf(rep)} r${i}`)
			.concat(
				entry.fieldParameters?.representations.map(
					(rep, i) => `${cTypeOf(rep)} fp${i}`,
				) ?? [],
			);
		const args = entry.parameterRepresentations
			.map((_, i) => `p${i}`)
			.concat(entry.fieldParameters?.keys.map((_, i) => `fp${i}`) ?? []);
		const symbol = `${emitted.symbol}_leaf`;
		const sortSymbol =
			sortKernelEntries.has(directCompiledEntryKey(index, entry.id)) &&
			numericSortKernelEntry(entry)
				? `${emitted.symbol}_sort`
				: undefined;
		const leafPrefix = `static __attribute__((aligned(64))) f64 ${symbol}(${parameters.join(", ") || "void"}) {\n#pragma STDC FP_CONTRACT OFF\n`;
		const inserted = `    if (mal_vm_leaf_unobserved(vm) && mal_vm_leaf_stack_available(vm)) return ${symbol}(${args.join(", ")});\n`;
		const insertionOffset =
			emitted.source.indexOf("#pragma STDC FP_CONTRACT OFF\n") +
			"#pragma STDC FP_CONTRACT OFF\n".length;
		const sourceMap =
			emitted.sourceMap === undefined
				? undefined
				: [
						...shiftNativeSourceRanges(leafSourceMap, leafPrefix.length),
						...shiftNativeSourceRanges(
							emitted.sourceMap.map((range) => ({
								...range,
								start:
									range.start >= insertionOffset
										? range.start + inserted.length
										: range.start,
								end:
									range.end >= insertionOffset ? range.end + inserted.length : range.end,
							})),
							leafPrefix.length + worker.join("\n").length + 3,
						),
					];
		const source = `static __attribute__((aligned(64))) f64 ${symbol}(${parameters.join(", ") || "void"}) {\n#pragma STDC FP_CONTRACT OFF\n${worker.join("\n")}\n}\n${emitted.source.replace(
			"#pragma STDC FP_CONTRACT OFF\n",
			`#pragma STDC FP_CONTRACT OFF\n    if (mal_vm_leaf_unobserved(vm) && mal_vm_leaf_stack_available(vm)) return ${symbol}(${args.join(", ")});\n`,
		)}${sortSymbol === undefined ? "" : `\n${numericSortKernelDeclaration(sortSymbol)} {\n    mal_numeric_leaf_merge_sort(values, scratch, keys, count, ${symbol});\n}\n`}`;
		return [
			{
				entry,
				emitted: { ...emitted, source, sourceMap },
				leaf: true as const,
				sortSymbol,
			},
		];
	});
	return {
		...canonical,
		directEntries: variants.map(({ entry, emitted, leaf, sortSymbol }) => ({
			...(leaf === undefined ? {} : { leaf }),
			...(sortSymbol === undefined ? {} : { sortSymbol }),
			...(emitted.sourceMap === undefined ? {} : { sourceMap: emitted.sourceMap }),
			declarationSymbols: new Set([
				...emitted.declarationSymbols,
				...(callbackEntries.has(directCompiledEntryKey(index, entry.id))
					? [
							nativeCallbackSymbol(name, entry.id, suffix),
							`mal_compiled_${name}${suffix}`,
						]
					: []),
				...(reductionEntries.has(directCompiledEntryKey(index, entry.id))
					? [`${nativeCallbackSymbol(name, entry.id, suffix)}_reduce`]
					: []),
				...(sortSymbol === undefined ? [] : [sortSymbol]),
			]),
			emittedInstructions: emitted.emittedInstructions,
			directEntryCalls: emitted.directEntryCalls,
			id: entry.id,
			symbol: emitted.symbol,
			...(emitted.link === undefined ? {} : { link: emitted.link }),
			source:
				emitted.source +
				(callbackEntries.has(directCompiledEntryKey(index, entry.id))
					? `\n${renderCallbackAdapter(entry, name, suffix, linkage)}`
					: "") +
				(reductionEntries.has(directCompiledEntryKey(index, entry.id))
					? `\n${renderReductionAdapter(entry, name, suffix, linkage)}`
					: ""),
			...(reductionEntries.has(directCompiledEntryKey(index, entry.id))
				? { reductionSymbol: `${nativeCallbackSymbol(name, entry.id, suffix)}_reduce` }
				: {}),
			...(callbackEntries.has(directCompiledEntryKey(index, entry.id))
				? { callbackSymbol: nativeCallbackSymbol(name, entry.id, suffix) }
				: {}),
			parameterRepresentations: [
				...(entry.argumentRepresentations ?? entry.parameterRepresentations),
				...(entry.fieldParameters?.representations ?? []),
			],
			...(entry.resultFields === undefined
				? {}
				: { resultFieldRepresentations: recordRepresentations(entry.resultFields) }),
			...(entry.recordParameters === undefined
				? {}
				: {
						recordParameters: entry.recordParameters.map((parameter) => ({
							index: parameter.index,
							representations: recordParameterRepresentations(parameter),
						})),
					}),
			resultRepresentation: entry.resultRepresentation,
		})),
	};
}

function numericSortSite(
	instruction: BytecodeInstruction | undefined,
	plan: Extract<NativeInstructionPlan, { kind: "call" }>,
): NonNullable<typeof plan.numericSortCallback> | undefined {
	const callback = plan.numericSortCallback;
	return callback !== undefined &&
		instruction?.opcode === "CALL" &&
		instruction.arguments.length === (callback.viaCall ? 2 : 1)
		? callback
		: undefined;
}

/** Direct entries whose sort kernel a selected numeric sort site passes. */
export function numericSortKernelDemand(
	functions: ReadonlyArray<NativeFunctionPlan>,
): ReadonlySet<string> {
	const demand = new Set<string>();
	for (const native of functions)
		for (const [ip, plan] of native.instructions.entries()) {
			const site =
				plan?.kind === "call"
					? numericSortSite(native.body.instructions[ip], plan)
					: undefined;
			if (site !== undefined)
				demand.add(directCompiledEntryKey(site.functionIndex, site.entryId));
		}
	return demand;
}

// A numeric sort site can pass this kernel only where it would call the same leaf.
function numericSortKernelEntry(entry: NativeDirectEntryPlan): boolean {
	const parameters = entry.argumentRepresentations ?? entry.parameterRepresentations;
	return (
		parameters.length === 2 &&
		parameters.every((representation) => representation === "number") &&
		entry.resultRepresentation === "number" &&
		entry.fieldParameters === undefined
	);
}

export function numericSortKernelDeclaration(symbol: string): string {
	return `void ${symbol}(MalValue *values, MalValue *scratch, f64 *keys, u32 count)`;
}

function renderCallbackAdapter(
	entry: NativeDirectEntryPlan,
	name: number | string,
	suffix: string,
	linkage: "static" | "external",
): string {
	const parameters = entry.argumentRepresentations ?? entry.parameterRepresentations;
	const guards = [
		entry.argumentRepresentations === undefined
			? "arg_count >= 0"
			: `arg_count == ${entry.argumentRepresentations.length}`,
	];
	const values = parameters.map((rep, parameter) => {
		const value = `args[${parameter}]`;
		if (rep === "boxed")
			return `arg_count > ${parameter} ? ${value} : MAL_VALUE_UNDEFINED`;
		const predicate = rep === "number" ? "mal_ops_is_number" : `mal_value_is_${rep}`;
		guards.push(`arg_count > ${parameter} && ${predicate}(${value})`);
		return rep === "number"
			? `mal_ops_number_as_f64(${value})`
			: rep === "int32"
				? `mal_value_to_i32(${value})`
				: rep === "boolean"
					? `mal_value_to_boolean(${value})`
					: value;
	});
	const result =
		entry.resultRepresentation === "number"
			? "mal_ops_number_value(value)"
			: entry.resultRepresentation === "int32"
				? "mal_value_from_i32(value)"
				: entry.resultRepresentation === "boolean"
					? "mal_value_new_boolean(value)"
					: "value";
	// The runtime callback path owns activation, realm, receiver adjustment, and argument roots.
	return [
		`${linkage === "static" ? "static " : ""}MalValue ${nativeCallbackSymbol(name, entry.id, suffix)}${COMPILED_FUNCTION_DECLARATION} {`,
		`    if (!(${guards.map((guard) => `(${guard})`).join(" && ")})) {`,
		"        MAL_PERF_COUNT(array_iteration_typed_callback_fallbacks);",
		`        return mal_compiled_${name}${suffix}(vm, this_value, args, arg_count, new_target, env, callee, entry_state);`,
		"    }",
		"    MAL_PERF_COUNT(array_iteration_typed_callback_hits);",
		`    ${cTypeOf(entry.resultRepresentation)} value = mal_direct_${name}_${entry.id}${suffix}(vm, this_value${values.length ? `, ${values.join(", ")}` : ""}, env, callee);`,
		"    if (MAL_THREW()) return MAL_VALUE_UNDEFINED;",
		`    return ${result};`,
		"}",
	].join("\n");
}

export function numericReductionDeclaration(symbol: string): string {
	return `f64 ${symbol}(MalVm *vm, MalValue this_value, f64 accumulator, f64 value, f64 index, MalValue receiver, MalEnv *env, MalValue callee)`;
}

function renderReductionAdapter(
	entry: NativeDirectEntryPlan,
	name: number | string,
	suffix: string,
	linkage: "static" | "external",
): string {
	const values = ["accumulator", "value", "index", "receiver"].slice(
		0,
		(entry.argumentRepresentations ?? entry.parameterRepresentations).length,
	);
	return [
		`${linkage === "static" ? "static " : ""}${numericReductionDeclaration(`${nativeCallbackSymbol(name, entry.id, suffix)}_reduce`)} {`,
		`    return mal_direct_${name}_${entry.id}${suffix}(vm, this_value, ${values.join(", ")}, env, callee);`,
		"}",
	].join("\n");
}

function unboxedSnapshot(rep: RegisterRep, value: string): string {
	if (rep === "number") return `mal_ops_number_as_f64(${value})`;
	if (rep === "int32") return `(i32)mal_ops_number_as_f64(${value})`;
	if (rep === "boolean") return `mal_value_to_boolean(${value})`;
	return value;
}

type NativeRecordField = NativeRecordLayout["storage"][number];

function recordRepresentations(
	layout: NativeRecordLayout,
): Array<VmRegisterRepresentation> {
	return [
		...layout.storage.map((field) => field.representation),
		...(layout.shapes === undefined ? [] : ["int32" as const]),
	];
}

function recordParameterRepresentations(
	parameter: NativeRecordParameter,
): Array<VmRegisterRepresentation> {
	return [
		...(parameter.observerIps.length === 0
			? parameter.storage.map((field) => field.representation)
			: recordRepresentations(parameter)),
		"boxed",
		...(parameter.observerIps.length === 0 ? [] : ["boxed" as const]),
	];
}

interface NativeRecordSite {
	readonly slots: ReadonlyArray<string>;
	readonly storage: ReadonlyArray<NativeRecordField>;
	readonly keys: ReadonlyArray<number>;
	readonly shapes?: ReadonlyArray<ReadonlyArray<number>>;
	readonly shape?: string;
	readonly object?: string;
	readonly producer?: string;
	readonly escapes?: true;
}

function recordSlot(site: NativeRecordSite, offset: number): string {
	return site.slots[offset]!;
}

function recordBoxed(site: NativeRecordSite, field: number): string {
	const value = recordSlot(site, field);
	const representation = site.storage[field]!.representation;
	return representation === "int32"
		? `mal_value_from_i32(${value})`
		: representation === "number"
			? `mal_ops_number_value(${value})`
			: representation === "boolean"
				? `mal_value_new_boolean(${value})`
				: value;
}

function recordObject(site: NativeRecordSite): string {
	if (site.object === undefined) throw new Error("Native record has no object storage");
	return site.object;
}

function recordShape(site: NativeRecordSite): string {
	if (site.shape === undefined)
		throw new Error("Native record observer has no shape storage");
	return site.shape;
}

function recordProducer(site: NativeRecordSite): string {
	if (site.producer === undefined)
		throw new Error("Native record observer has no producer storage");
	return site.producer;
}

function recordStorage(
	site: NativeRecordSite,
	parameter: NativeRecordParameter,
): Array<string> {
	return [
		...site.slots,
		...(parameter.observerIps.length > 0 && parameter.shapes !== undefined
			? [recordShape(site)]
			: []),
		recordObject(site),
		...(parameter.observerIps.length === 0 ? [] : [recordProducer(site)]),
	].map((slot) => `&${slot}`);
}

interface NativeRecordStorage {
	readonly locals: ReadonlyArray<{
		readonly name: string;
		readonly representation: VmRegisterRepresentation;
	}>;
	/** A record entry's allocations, with their field indices and shape index. */
	readonly allocations: ReadonlyMap<
		number,
		{
			readonly fields: ReadonlyArray<number>;
			readonly shape?: number;
			readonly storage: ReadonlyArray<NativeRecordField>;
		}
	>;
	/** Forwarded calls of a record entry, with its field count. */
	readonly forwards: ReadonlyMap<number, ReadonlyArray<NativeRecordField>>;
	readonly calls: ReadonlyMap<number, NativeRecordSite>;
	/** Object literals created in caller storage. */
	readonly objects: ReadonlyMap<number, NativeRecordSite>;
	readonly accesses: ReadonlyMap<number, NativeRecordAccess>;
	readonly observers: ReadonlyMap<number, ReadonlyArray<NativeRecordObserver>>;
	/** Calls that hand records' storage to the record parameters of their entries. */
	readonly passes: ReadonlyMap<number, ReadonlyArray<NativeRecordPassSite>>;
}

interface NativeRecordPassSite {
	readonly site: NativeRecordSite;
	readonly argument: number;
}

interface NativeRecordAccess {
	readonly site: NativeRecordSite;
	readonly field: number;
}

interface NativeRecordObserver {
	readonly site: NativeRecordSite;
	readonly aliases: ReadonlyArray<number>;
}

const NO_NATIVE_RECORD_STORAGE: NativeRecordStorage = {
	locals: [],
	allocations: new Map(),
	forwards: new Map(),
	calls: new Map(),
	objects: new Map(),
	accesses: new Map(),
	observers: new Map(),
	passes: new Map(),
};

/**
 * Caller storage for record calls this variant sends to an emitted record entry.
 * Calls that fall back to an ordinary entry keep their ordinary result and uses.
 */
function renderRecordCallSlots(
	fn: BytecodeFunction,
	native: NativeFunctionPlan,
	callTransports: ReadonlyArray<NativeCallTransportPlan>,
	directCompiledEntries: DirectCompiledEntries,
	allocateSlot: () => number,
	directEntry: NativeDirectEntryPlan | undefined,
): Omit<NativeRecordStorage, "allocations" | "forwards"> {
	const unobserved = new Set([
		...(native.storage?.controlFlow?.unreachableIps ?? []),
		...(native.storage?.controlFlow?.branches.map((branch) => branch.instructionIp) ??
			[]),
		...(native.storage?.elidedPureIps ?? []),
	]);
	const locals: Array<{ name: string; representation: VmRegisterRepresentation }> = [];
	const allocateRecord = (
		layout: NativeRecordLayout,
		prefix: string,
		object: boolean,
		producer: boolean,
	): NativeRecordSite => {
		const slots = layout.storage.map((field, index) => {
			if ((field.kindMask & ~COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE) !== 0)
				return `__gc_slots[${allocateSlot()}]`;
			const name = `${prefix}_${index}`;
			locals.push({ name, representation: field.representation });
			return name;
		});
		const shape =
			layout.shapes === undefined ? undefined : `${prefix}_${layout.keys.length}`;
		if (shape !== undefined) locals.push({ name: shape, representation: "int32" });
		return {
			slots,
			keys: layout.keys,
			storage: layout.storage,
			...(layout.shapes === undefined ? {} : { shapes: layout.shapes }),
			...(shape === undefined ? {} : { shape }),
			...(object ? { object: `__gc_slots[${allocateSlot()}]` } : {}),
			...(producer ? { producer: `__gc_slots[${allocateSlot()}]` } : {}),
		};
	};
	const calls = new Map<number, NativeRecordSite>();
	const objects = new Map<number, NativeRecordSite>();
	const accesses = new Map<number, NativeRecordAccess>();
	const observers = new Map<number, Array<NativeRecordObserver>>();
	const passes = new Map<number, Array<NativeRecordPassSite>>();
	const transports = new Map(callTransports.map((plan) => [plan.instructionIp, plan]));
	const entryOf = (ip: number) => {
		const target = transports.get(ip)?.targets[0];
		return target === undefined
			? undefined
			: directCompiledEntries.get(
					directCompiledEntryKey(target.functionIndex, target.entryId),
				);
	};
	const passedObserver = (passed: ReadonlyArray<NativeRecordPass>): boolean =>
		passed.some(
			(pass) =>
				(entryOf(pass.callIp)?.recordParameters?.find(
					(parameter) => parameter.index === pass.argument,
				)?.observerIps.length ?? 0) > 0,
		);
	const addUses = (
		site: NativeRecordSite,
		uses: NativeRecordCall | NativeRecordObject | NativeRecordParameter,
		passed: ReadonlyArray<NativeRecordPass>,
	) => {
		for (const access of [...uses.loads, ...uses.stores])
			if (!unobserved.has(access.instructionIp))
				accesses.set(access.instructionIp, { site, field: access.field });
		for (const pass of passed)
			if (!unobserved.has(pass.callIp))
				passes.set(pass.callIp, [
					...(passes.get(pass.callIp) ?? []),
					{ site, argument: pass.argument },
				]);
		// A call whose entry takes no record parameter for it observes the record instead.
		const observerIps = [
			...uses.observerIps,
			...(uses.passes ?? [])
				.filter((pass) => !passed.includes(pass))
				.map((pass) => pass.callIp),
		].filter((ip) => !unobserved.has(ip));
		if (observerIps.length === 0) return;
		const aliases = nativeRecordAliases(fn, uses);
		for (const ip of observerIps)
			observers.set(ip, [
				...(observers.get(ip) ?? []),
				{ site, aliases: aliases.get(ip) ?? [] },
			]);
	};
	for (const parameter of directEntry?.recordParameters ?? []) {
		let next = parameter.keys.length;
		const observed = parameter.observerIps.length > 0;
		const pointer = (field: number) => `(*rp${parameter.index}_${field})`;
		const shape =
			observed && parameter.shapes !== undefined ? pointer(next++) : undefined;
		const site: NativeRecordSite = {
			slots: parameter.keys.map((_, field) => pointer(field)),
			storage: parameter.storage,
			keys: parameter.keys,
			...(parameter.shapes === undefined ? {} : { shapes: parameter.shapes }),
			...(shape === undefined ? {} : { shape }),
			object: pointer(next++),
			...(observed ? { producer: pointer(next) } : {}),
		};
		addUses(site, parameter, []);
	}
	for (const plan of native.recordCalls ?? []) {
		const entry = entryOf(plan.callIp);
		if (entry?.resultFields === undefined) continue;
		const layout = entry.resultFields;
		const passed = (plan.passes ?? []).filter((pass) => {
			const parameter = entryOf(pass.callIp)?.recordParameters?.find(
				(candidate) => candidate.index === pass.argument,
			);
			return parameter !== undefined && sameNativeRecordLayout(layout, parameter);
		});
		const observed =
			plan.observerIps.length > 0 || passed.length < (plan.passes?.length ?? 0);
		const escapes = layout.escapes === true;
		const object = observed || escapes || passed.length > 0;
		const producer = observed || passedObserver(passed);
		const site: NativeRecordSite = {
			...allocateRecord(layout, `__record_call_${plan.callIp}`, object, producer),
			...(escapes ? { escapes: true as const } : {}),
		};
		calls.set(plan.callIp, site);
		addUses(site, plan, passed);
	}
	for (const plan of native.recordObjects ?? []) {
		const allocation = fn.instructions[plan.allocationIp];
		if (allocation?.opcode !== "CREATE_OBJECT_SHAPED")
			throw new Error(
				`Native record object ${plan.allocationIp} is not an object literal`,
			);
		const layout = { keys: allocation.keyStringIndices, storage: plan.storage };
		const passed = (plan.passes ?? []).filter((pass) => {
			const parameter = entryOf(pass.callIp)?.recordParameters?.find(
				(candidate) => candidate.index === pass.argument,
			);
			return parameter !== undefined && sameNativeRecordLayout(layout, parameter);
		});
		const observed =
			plan.observerIps.length > 0 || passed.length < (plan.passes?.length ?? 0);
		const site = allocateRecord(
			layout,
			`__record_object_${plan.allocationIp}`,
			true,
			observed || passedObserver(passed),
		);
		objects.set(plan.allocationIp, site);
		addUses(site, plan, passed);
	}
	return { locals, calls, objects, accesses, observers, passes };
}

function renderFieldCallSlots(
	fn: BytecodeFunction,
	native: NativeFunctionPlan,
	allocateSlot: () => number,
): ReadonlyArray<NativeFieldCall> | undefined {
	return native.fieldCalls?.map((site): NativeFieldCall => {
		const allocation = fn.instructions[site.allocationIp];
		if (allocation?.opcode !== "CREATE_OBJECT_SHAPED")
			throw new Error("Invalid field call allocation");
		const boxedSlots = site.valueRepresentations.map((rep) =>
			rep === "boxed" || rep === "string" ? allocateSlot() : undefined,
		);
		return { ...site, allocation, boxedSlots };
	});
}

// Each C invocation owns computational locals and roots; only the selected snapshot survives.
function emitResumableFunction(
	fn: BytecodeFunction,
	analysis: NativeBodyAnalysis,
	native: NativeFunctionPlan,
	index: number,
	suffix: string,
	debug: NativeFramePositions | false,
	linkage: "static" | "external",
	semanticProtectors: ReadonlyArray<VmSemanticProtectorFact>,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
	directCompiledTargets: ReadonlySet<number>,
	directCompiledEntries: DirectCompiledEntries,
	strictCompiledTargets: ReadonlySet<number>,
	maxCodeUnits: number,
	relocatable: NativeRelocatableEmission | false = false,
): CompiledFunction | null {
	nativeFrameRootRegisters(fn, native);
	native = nativeControlFlowContract(native, native.storage?.controlFlow);
	const elidedResults = new Set(native.storage!.unusedRegisters);
	const elidedIps = new Set(native.storage!.elidedPureIps);
	const isAsyncFunction = fn.isAsync && !fn.isGenerator;
	const symbol = `mal_compiled_${relocatable === false ? index : relocatable.symbolStem}${suffix}`;
	const relocation = nativeRelocationExpressions(
		relocatable === false ? undefined : `${symbol}_link`,
		relocatable === false ? undefined : relocatable.symbolStems,
		relocatable !== false && relocatable.relocation !== undefined,
		relocatable === false ? undefined : relocatable.importedGlobals,
	);
	const isAsyncGenerator = fn.isAsync && fn.isGenerator;

	const reps = [...native.registerRepresentations];
	const suspension = native.storage!.suspension;
	if (suspension === undefined)
		throw new Error("Resumable native function lacks a suspension plan");
	const rootRegisters = native.storage!.rootRegisters;
	const selfSlot = rootRegisters.length;
	let nextSlot = selfSlot + 1;
	const fieldCalls = renderFieldCallSlots(fn, native, () => nextSlot++);
	const totalSlots = nextSlot;

	const capturesEnv = fn.capturedCount > 0;
	// Every exit after publishing the invocation's root frame must unlink it.
	const gcUnlink = "vm->root_frame_head = __gc_frame.prev; ";
	const argumentRetentionLimit = computeArgumentRetentionLimit(fn);
	const retainArguments =
		argumentRetentionLimit === 0x7fffffff
			? "arg_count > 0"
			: argumentRetentionLimit >= 0
				? `arg_count > 0 && arg_count <= ${argumentRetentionLimit}`
				: "false";

	// thisSlot is -1: a coroutine is never a derived constructor, and `this` is read
	// from the this_value parameter (which the resume path is invoked with from the
	// saved frame), so no mutable this-slot is needed.
	const profileDecisions: Array<BackendProfileDecision> = [];
	const registerSlots = new Map(rootRegisters.map((register, slot) => [register, slot]));
	const inactiveRootMasks = nativeInactiveRootMasks(native.gc.safepoints, registerSlots);
	const rootMaskStatements = nativeRootMaskStatements(inactiveRootMasks.values());
	const coro: CoroutineContext = {
		suspension,
		positionEntry: (ip) => {
			const pos = fn.positions[ip] ?? -1;
			return debug === false || pos < 0 ? -1 : nativePositionEntry(debug, index, pos);
		},
		functionIndex: relocation.functionIndex(index),
		selfSlot,
		retainArguments,
		isAsyncFunction,
		isAsyncGenerator,
	};
	const storage = native.storage!;
	const expressionStringComparisons = new Map(
		storage.stringComparisons.map((plan) => [plan.instructionIp, plan]),
	);
	const expressions = new Map<number, string>(
		[...storage.expressionIps, ...storage.rematerializedConstantIps]
			.filter((ip) => !elidedIps.has(ip))
			.map((ip) => {
				const op = fn.instructions[ip]!;
				if (!("dst" in op)) throw new Error("Native expression lacks a destination");
				return [
					op.dst,
					renderScalarExpression(
						op,
						reps,
						native.instructions[ip],
						relocation,
						suffix,
						native.facts?.[ip],
						expressionStringComparisons.get(ip),
					),
				];
			}),
	);
	const body = emitBody(
		fn,
		analysis,
		index,
		native.specializations,
		native.regionActions,
		native.instructions,
		native.facts,
		inactiveRootMasks,
		rootMaskStatements.statements,
		new Map(
			native.gc.safepoints.map((safepoint) => [safepoint.instructionIp, safepoint.kind]),
		),
		suffix,
		reps,
		debug,
		gcUnlink,
		-1,
		coro,
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		directCompiledTargets,
		directCompiledEntries,
		undefined,
		vmSemanticProtectorGuard(semanticProtectors, "watched-methods"),
		profileDecisions,
		relocation,
		strictCompiledTargets,
		undefined,
		undefined,
		undefined,
		fieldCalls,
		undefined,
		stringConstants,
		undefined,
		new Set(storage.expressionIps),
		new Set(storage.rematerializedConstantIps),
		storage,
		storage.callTransports,
		storage.callbackTransports,
		new Set(storage.rootPublicationContinuations),
		maxCodeUnits,
		undefined,
		undefined,
		undefined,
		storage.stackRoots !== "conservative",
		undefined,
		storage.controlFlow,
		storage.elidedPureIps,
		storage.stringComparisons,
	);
	if (body === null) {
		return null;
	}
	if (body.lines.some((line) => line.includes("r-") && /\br-\d/.test(line))) {
		return null;
	}
	// Resume dispatch bypasses body declarations; invocation state must precede it.
	const resumablePreamble = body.invocationPreamble;

	const resumePoints = resumePointsOf(fn);
	const self = relocation.functionIndex(index);

	const lines: Array<string> = [];

	const coroutineParameters =
		"MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalEnv *env, MalValue callee, void *entry_state";
	lines.push(
		...compiledFrameDescriptor(
			symbol,
			symbol,
			`${linkage === "static" ? "static " : ""}MalValue ${symbol}(${coroutineParameters})`,
		),
		`${linkage === "static" ? "static " : ""}${NATIVE_ENTRY_ATTRIBUTES}MAL_COMPILED_FRAME __attribute__((aligned(64))) MalValue ${symbol}(${coroutineParameters}) {`,
	);
	lines.push("#pragma STDC FP_CONTRACT OFF");
	if (relocatable !== false && relocatable.relocation !== undefined)
		lines.push(
			`    const MalNativeProgramRelocation *__mal_relocation = ${relocatable.relocation};`,
		);
	lines.push(...rootMaskStatements.declarations);
	lines.push(`    (void) this_value;`);
	lines.push(`    (void) new_target;`);
	// A refused resume settles the coroutine as the throwing body would.
	lines.push(
		...compiledFrameEntry(symbol, self),
		`    if (__frame_row == nullptr) {`,
		`        if (entry_state != nullptr) mal_vm_op_coroutine_throw_compiled(vm, (MalGeneratorObject *) entry_state, ((MalGeneratorObject *) entry_state)->frame.registers);`,
		`        return MAL_VALUE_UNDEFINED;`,
		`    }`,
		...COMPILED_ENTRY_SCOPE,
	);
	if (body.resources.has("propertyCache") || body.resources.has("literalShapes")) {
		const cacheMisses = [
			body.resources.has("propertyCache")
				? `vm->property_cache[${self}].sites == nullptr`
				: undefined,
			body.resources.has("literalShapes")
				? `vm->literal_shape_cache[${self}] == nullptr`
				: undefined,
		].filter((condition) => condition !== undefined);
		lines.push(
			`    if (__builtin_expect(${cacheMisses.join(" || ")}, 0)) {`,
			`        mal_vm_ensure_function_caches(vm, ${self});`,
			`    }`,
		);
	}
	if (body.resources.has("propertyCache")) {
		lines.push(`    MalInlineCache *__property_ic = vm->property_cache[${self}].sites;`);
	}
	if (body.resources.has("literalShapes")) {
		lines.push(`    MalShape **__literal_shapes = vm->literal_shape_cache[${self}];`);
	}
	lines.push(...resumablePreamble);

	lines.push(`    MalValue __gc_slots[${totalSlots}];`);
	for (let slot = selfSlot + 1; slot < totalSlots; slot++)
		lines.push(`    __gc_slots[${slot}] = MAL_VALUE_UNDEFINED;`);
	lines.push(`    MalValue *__suspend_slots = nullptr;`);
	lines.push(
		`    MalGeneratorObject *resume_state = (MalGeneratorObject *) entry_state;`,
	);
	for (const owner of analysis.captureOwners) {
		lines.push(`    MalEnv *${captureOwnerName(relocation, owner)};`);
	}
	lines.push(`    MalGeneratorObject *__coro = resume_state;`);
	lines.push(`    (void) __coro;`);
	if (isAsyncFunction) {
		// The result promise the caller receives; created by ASYNC_START on the fresh
		// run and returned at every exit (ignored on a resume, where it is undefined).
		lines.push(`    MalValue __async_result_promise = MAL_VALUE_UNDEFINED;`);
	}
	const definitionInitialized = new Set(storage.definitionInitializedRegisters);
	for (let i = 0; i < fn.registerCount; i++) {
		if (elidedResults.has(i)) continue;
		const slot = registerSlots.get(i);
		const expression = expressions.get(i);
		if (expression !== undefined) lines.push(`#define r${i} (${expression})`);
		else if (slot === undefined)
			lines.push(
				`    ${cTypeOf(reps[i]!)} r${i}${definitionInitialized.has(i) ? "" : ` = ${zeroOf(reps[i]!)}`};`,
			);
		else {
			lines.push(`#define r${i} (__gc_slots[${slot}])`);
			lines.push(`    r${i} = ${zeroOf(reps[i]!)};`);
		}
	}

	lines.push(
		// A relocated index is only known at run time, so its descriptor lives on the stack.
		`    ${relocatable === false ? "static " : ""}const MalFrameDescriptor __gc_desc = { .function_index = ${self}, .slot_count = ${totalSlots} };`,
		`    MalRootFrame __gc_frame;`,
	);

	lines.push(`    if (resume_state != nullptr) {`);
	lines.push(`        __suspend_slots = resume_state->frame.registers;`);
	lines.push(`        env = resume_state->frame.env;`);
	lines.push(`        args = resume_state->frame.arguments;`);
	lines.push(`        arg_count = resume_state->frame.argument_count;`);
	lines.push(`        callee = resume_state->frame.callee;`);
	lines.push(
		`        __gc_slots[${selfSlot}] = mal_value_from_object((MalObject *) __coro);`,
	);
	lines.push(
		`        __gc_frame = (MalRootFrame){ .prev = vm->root_frame_head, .desc = &__gc_desc, .slots = __gc_slots, .inactive_slots = 0, .env = env };`,
	);
	lines.push(`        vm->root_frame_head = &__gc_frame;`);
	for (const line of initializeFixedCaptureOwners(
		analysis.captures,
		relocation,
		false,
		fn.capturedCount > 0 ? "env->parent" : "env",
	)) {
		lines.push(`        ${line}`);
	}
	lines.push(`        switch (resume_state->frame.instruction_pointer) {`);
	for (const resumeIp of resumePoints) {
		const point = suspension.points.find(
			(point) => point.instructionIp + 1 === resumeIp,
		)!;
		const op = fn.instructions[point.instructionIp]!;
		const restore = (register: number, slot: number) =>
			`r${register} = ${unboxedSnapshot(reps[register]!, `__suspend_slots[${slot}]`)};`;
		lines.push(`        case ${resumeIp}:`);
		for (const [slot, register] of point.registers.entries())
			lines.push(`            ${restore(register, slot)}`);
		if (op.opcode === "YIELD" || op.opcode === "AWAIT") {
			lines.push(`            ${restore(op.valueDst, suspension.valueSlot)}`);
			lines.push(`            ${restore(op.modeDst, suspension.modeSlot)}`);
		}
		lines.push(
			`            mal_coroutine_clear_snapshot(__suspend_slots, ${suspension.slotCount});`,
		);
		lines.push(`            goto L${resumeIp};`);
	}
	// Unreachable: a saved resume IP is always one of the recorded points.
	lines.push(`        default: break;`);
	lines.push(`        }`);
	lines.push(`    } else {`);

	lines.push(`        __gc_slots[${selfSlot}] = MAL_VALUE_UNDEFINED;`);
	lines.push(
		`        __gc_frame = (MalRootFrame){ .prev = vm->root_frame_head, .desc = &__gc_desc, .slots = __gc_slots, .inactive_slots = 0, .env = ${fn.closureCaptureOwners?.length === 0 ? "nullptr" : "env"} };`,
	);
	lines.push(`        vm->root_frame_head = &__gc_frame;`);
	if (capturesEnv) {
		lines.push(
			`        env = ${fn.closureCaptureOwners === undefined ? "mal_env_new" : "mal_env_new_compact"}(vm, env, ${self}, ${fn.capturedCount});`,
			`        __gc_frame.env = env;`,
		);
	}
	for (let i = 0; i < fn.parameterCount; i++) {
		lines.push(`        r${i} = arg_count > ${i} ? args[${i}] : MAL_VALUE_UNDEFINED;`);
	}
	lines.push(
		`        __suspend_slots = mal_coroutine_alloc_registers(vm, ${suspension.slotCount});`,
	);
	if (fn.argumentSnapshotCount > 0) {
		lines.push(
			`        MAL_PERF_ADD(argument_snapshot_logical_values, ${fn.argumentSnapshotCount});`,
			`        MAL_PERF_ADD(argument_snapshot_destination_writes, ${fn.argumentSnapshotCount});`,
		);
	}
	for (const line of initializeFixedCaptureOwners(
		analysis.captures,
		relocation,
		false,
		fn.capturedCount > 0 ? "env->parent" : "env",
	)) {
		lines.push(`        ${line}`);
	}
	lines.push(`    }`);

	const bodyOffset = joinedCodeUnits(lines) + 1;
	for (const line of body.lines) {
		lines.push(line);
	}

	// Falling off the end is an implicit `return undefined` — complete the coroutine.
	const fallReturn = isAsyncFunction ? "__async_result_promise" : "MAL_VALUE_UNDEFINED";
	lines.push(
		`    ${gcUnlink}mal_vm_op_coroutine_return_compiled(vm, __coro, MAL_VALUE_UNDEFINED);`,
		`    return ${fallReturn};`,
	);
	// Shared throw-exit for a coroutine: complete the activation (free it, route the
	// throw by kind) before leaving the frame. __coro is null if the parameter
	// prologue threw before GENERATOR_START — then the raw buffer is released and the
	// throw propagates synchronously. Reached only by `goto`; omitted when unused.
	if (body.resources.has("throwExit")) {
		lines.push(
			`__throw_exit:;`,
			`    ${gcUnlink}mal_vm_op_coroutine_throw_compiled(vm, __coro, __suspend_slots); return ${fallReturn};`,
		);
	}
	lines.push("}");
	for (let i = 0; i < fn.registerCount; i++) {
		lines.push(`#undef r${i}`);
	}
	if (relocation.link.length > 0) lines.unshift(`extern const i32 ${symbol}_link[];`);
	if (joinedCodeUnits(lines) > maxCodeUnits) return null;

	return {
		symbol,
		declarationSymbols: new Set([symbol, ...relocation.declarationSymbols]),
		source: lines.join("\n"),
		...(body.sourceMap === undefined
			? {}
			: {
					sourceMap: shiftNativeSourceRanges(
						body.sourceMap,
						bodyOffset + (relocation.link.length > 0 ? lines[0]!.length + 1 : 0),
					),
				}),
		...(relocatable === false ? {} : { link: relocation.link }),
		profileDecisions,
		emittedInstructions: body.emittedInstructions,
		directEntryCalls: body.directEntryCalls,
		directEntries: [],
	};
}

/** Code units of `lines.join("\n")`, computed without building the string. */
function joinedCodeUnits(lines: ReadonlyArray<string>): number {
	let total = Math.max(0, lines.length - 1);
	for (const line of lines) total += line.length;
	return total;
}

/** The C type a register of the given rep is held in. */
function cTypeOf(rep: RegisterRep): string {
	return rep === "int32"
		? "i32"
		: rep === "number"
			? "double"
			: rep === "boolean"
				? "bool"
				: "MalValue";
}

/** The zero/default value a register of the given rep is initialized to. */
function zeroOf(rep: RegisterRep): string {
	return rep === "int32"
		? "0"
		: rep === "number"
			? "0.0"
			: rep === "boolean"
				? "false"
				: "MAL_VALUE_UNDEFINED";
}

/**
 * Whether an instruction may synchronously run JavaScript and therefore mutate
 * a watched semantic family.
 * Allocation and GC are safe: this runtime's collector does not run finalizers or
 * jobs inside a safepoint. Unknown instructions fail closed.
 */
type NativeStringSplitProjection = Extract<VmRegion, { kind: "string-split-projection" }>;

interface NativeStringSplitProjectionSite {
	subjectSlot: number;
	projection: NativeStringSplitProjection;
	slotsOffset: number;
	lockedIdentity: boolean;
	elementLoads: ReadonlyArray<
		NativeStringSplitProjection["loads"][number] & {
			kind: "element";
			index: number;
		}
	>;
}

interface NativeStringSplitProjectionAction {
	site: NativeStringSplitProjectionSite;
	role: "property" | "call" | "element" | "length";
	load?: NativeStringSplitProjection["loads"][number];
	propertyLoad?: Extract<BytecodeInstruction, { opcode: "LOAD_PROPERTY_STATIC" }>;
}

type NativeStringSplitCursor = Extract<VmRegion, { kind: "string-split-cursor" }>;

interface NativeStringSplitCursorSite {
	cursor: NativeStringSplitCursor;
	callIp: number;
	lengthIp: number;
	backedgeIp: number;
	subjectSlot: number;
	traversalSlot: number;
	trimCalleeSlot?: number;
	/** Core proved the admitted semantic epochs stable across every licensed use. */
	semanticEpochStable: boolean;
	epochName: string;
	lockedIdentity: boolean;
	lockedTrimIdentity: boolean;
}

interface NativeStringSplitCursorAction {
	site: NativeStringSplitCursorSite;
	role: "property" | "call" | "length" | "element" | "trimProperty" | "trimCall";
	propertyLoad?: Extract<BytecodeInstruction, { opcode: "LOAD_PROPERTY_STATIC" }>;
}

type NativeRegExpExecProjection = Extract<VmRegion, { kind: "regexp-exec-projection" }>;

interface NativeRegExpExecProjectionSite {
	projection: NativeRegExpExecProjection;
	subjectSlot: number;
	slotsOffset: number;
	loads: ReadonlyArray<NativeRegExpExecProjection["loads"][number]>;
	spanMask: number;
}

interface NativeRegExpExecProjectionAction {
	site: NativeRegExpExecProjectionSite;
	role:
		| "property"
		| "call"
		| "capture"
		| "length"
		| "charCodeAtProperty"
		| "charCodeAtCall"
		| "number"
		| "caseUpperProperty"
		| "caseUpperCall"
		| "caseLowerProperty"
		| "caseLowerCall"
		| "caseLength";
	load?: NativeRegExpExecProjection["loads"][number];
	propertyLoad?: Extract<BytecodeInstruction, { opcode: "LOAD_PROPERTY_STATIC" }>;
}

type NativeRegExpIteratorProjection = Extract<
	VmRegion,
	{ kind: "regexp-iterator-projection" }
>;

interface NativeRegExpIteratorProjectionSite {
	projection: NativeRegExpIteratorProjection;
	subjectSlot: number;
	slotsOffset: number;
	loads: ReadonlyArray<NativeRegExpIteratorProjection["loads"][number]>;
}

interface NativeRegExpIteratorProjectionAction {
	site: NativeRegExpIteratorProjectionSite;
	role: "step" | "capture" | "number";
	load?: NativeRegExpIteratorProjection["loads"][number];
}

type NativeStringSpan = Extract<VmRegion, { kind: "string-span" }>;

interface NativeObjectEnumerationSnapshotSite extends NativeObjectEnumerationSnapshotPlan {
	readonly elementsSlot: number;
	readonly materializedSlot: number;
}

interface NativeStringSpanSite {
	producerIp: number;
	span?: NativeStringSpan;
	rangeOperation?: CoreStringSpanRangeOperation;
	parent?: NativeStringSpanSite;
	projection?: { kind: "split" | "regexp"; callIp: number; slot: number };
	consumers: ReadonlyArray<NativeSpanConsumer>;
	subjectSlot: number;
	materializedSlot: number;
}
interface NativeStringSpanAction {
	site: NativeStringSpanSite;
	role: "range" | "projection" | NativeSpanConsumer["kind"];
	consumer?: NativeSpanConsumer;
}

type NativeStringCharCodeAtChain = Extract<
	VmRegion,
	{ kind: "string-char-code-at-chain" }
>;

interface NativeStringCharCodeAtChainAction {
	readonly chain: NativeStringCharCodeAtChain;
	readonly role: "property" | "call";
}

type NativeBuiltinCollectionCallChain = Extract<
	VmRegion,
	{ kind: "builtin-collection-call-chain" }
>;

interface NativeBuiltinCollectionCallChainAction {
	readonly chain: NativeBuiltinCollectionCallChain;
	readonly role: "property" | "call";
}

const DATA_VIEW_ELEMENT_SIZES: Readonly<
	Record<(typeof DATA_VIEW_ACCESSOR_TYPES)[number], number>
> = {
	Int8: 1,
	Uint8: 1,
	Int16: 2,
	Uint16: 2,
	Int32: 4,
	Uint32: 4,
	Float32: 4,
	Float64: 8,
};

/** The inline DataView access a guarded accessor call performs, if it is one. */
function dataViewAccessor(
	operation: string,
):
	| { readonly accessor: string; readonly size: number; readonly set: boolean }
	| undefined {
	const prefix = "DataView.prototype.";
	if (!operation.startsWith(prefix)) return undefined;
	const method = operation.slice(prefix.length);
	const kind = method.slice(0, 3);
	const type = DATA_VIEW_ACCESSOR_TYPES.find(
		(candidate) => method.slice(3) === candidate,
	);
	if ((kind !== "get" && kind !== "set") || type === undefined) return undefined;
	return {
		accessor: `MAL_DATA_VIEW_${kind.toUpperCase()}_${type.toUpperCase()}`,
		size: DATA_VIEW_ELEMENT_SIZES[type],
		set: kind === "set",
	};
}

function nativeBuiltinCollectionOperation(
	operation: NativeBuiltinCollectionCallChain["operation"],
): string {
	return {
		"Map.prototype.get": "MAL_GUARDED_BUILTIN_MAP_GET",
		"Map.prototype.set": "MAL_GUARDED_BUILTIN_MAP_SET",
		"Map.prototype.has": "MAL_GUARDED_BUILTIN_MAP_HAS",
		"Map.prototype.delete": "MAL_GUARDED_BUILTIN_MAP_DELETE",
		"Set.prototype.add": "MAL_GUARDED_BUILTIN_SET_ADD",
		"Set.prototype.has": "MAL_GUARDED_BUILTIN_SET_HAS",
		"Set.prototype.delete": "MAL_GUARDED_BUILTIN_SET_DELETE",
		"WeakMap.prototype.get": "MAL_GUARDED_BUILTIN_WEAK_MAP_GET",
		"WeakMap.prototype.set": "MAL_GUARDED_BUILTIN_WEAK_MAP_SET",
		"WeakMap.prototype.has": "MAL_GUARDED_BUILTIN_WEAK_MAP_HAS",
		"WeakMap.prototype.delete": "MAL_GUARDED_BUILTIN_WEAK_MAP_DELETE",
		"WeakSet.prototype.has": "MAL_GUARDED_BUILTIN_WEAK_SET_HAS",
		"WeakSet.prototype.add": "MAL_GUARDED_BUILTIN_WEAK_SET_ADD",
		"WeakSet.prototype.delete": "MAL_GUARDED_BUILTIN_WEAK_SET_DELETE",
	}[operation];
}

type NativeIteratorCursor = Extract<
	VmRegion,
	{
		kind:
			| "array-values-iterator-cursor"
			| "string-iterator-cursor"
			| "typed-array-iterator-cursor"
			| "map-iterator-cursor"
			| "set-iterator-cursor";
	}
>;

interface NativeIteratorCursorAction {
	readonly cursor: NativeIteratorCursor;
	readonly role: "initialize" | "step" | "close";
}

interface NativeArrayPairDestructureAction {
	readonly cursor: Extract<
		NativeIteratorCursor,
		{ readonly kind: "array-values-iterator-cursor" }
	>;
	readonly role: "initialize" | "step" | "close";
	readonly index?: 0 | 1;
}

interface NativeIteratorResultVirtualizationAction {
	readonly region: Extract<VmRegion, { kind: "iterator-result-virtualization" }>;
}

type NativeIteratorEntryPairVirtualization = Extract<
	VmRegion,
	{ kind: "iterator-entry-pair-virtualization" }
>;

interface NativeIteratorEntryPairVirtualizationAction {
	readonly region: NativeIteratorEntryPairVirtualization;
	readonly role: "outerStep" | "innerInitialize" | "innerStep" | "innerClose";
	readonly index?: number;
}

function nativeIteratorCursorProtocol(cursor: NativeIteratorCursor): string {
	switch (cursor.protocol) {
		case "array-values":
			return "MAL_ITERATOR_CURSOR_ARRAY_VALUES";
		case "string":
			return "MAL_ITERATOR_CURSOR_STRING_VALUES";
		case "typed-array-values":
			return "MAL_ITERATOR_CURSOR_TYPED_ARRAY_VALUES";
		case "map":
			return "MAL_ITERATOR_CURSOR_MAP";
		case "set":
			return "MAL_ITERATOR_CURSOR_SET";
	}
}

interface StackObjectSite {
	objectName: string;
	elided?: true;
	materializedSlot?: number;
	slotsOffset?: number;
	slotCount: number;
	fieldSlots?: ReadonlyArray<{
		readonly name: string;
		readonly representation: NativeStackFieldRepresentation;
	}>;
	inheritedLoadInstructionIndex?: number;
	inheritedIcIndex?: number;
	inheritedFastName?: string;
	inheritedValueName?: string;
	inheritedGuard?: VmGuardPlan;
}

interface StackObjectMaterialization {
	readonly site: StackObjectSite;
	readonly values: ReadonlyArray<number>;
}

function stackObjectSlotReference(site: StackObjectSite, slot: number): string {
	if (site.fieldSlots !== undefined) {
		const field = site.fieldSlots[slot];
		if (field === undefined) throw new Error("Invalid typed stack-object field");
		return field.name;
	}
	if (site.slotsOffset === undefined) throw new Error("Stack object lacks slot storage");
	return `__gc_slots[${site.slotsOffset + slot}]`;
}

function semanticDependencyMask(
	dependencies: ReadonlyArray<VmSemanticDependency>,
): string | undefined {
	const masks = new Set<string>();
	for (const dependency of dependencies) {
		if (dependency.kind === "world") continue;
		switch (dependency.family) {
			case "primitive-methods":
				masks.add("MAL_SEMANTIC_DEPENDENCY_PRIMITIVE_METHODS");
				break;
			case "watched-methods":
				masks.add("MAL_SEMANTIC_DEPENDENCY_WATCHED_METHODS");
				break;
			case "array-elements":
				masks.add("MAL_SEMANTIC_DEPENDENCY_ARRAY_ELEMENTS");
				break;
			case "global-bindings":
			case "object-shapes":
				throw new Error(`Unsupported native semantic dependency ${dependency.family}`);
		}
	}
	return masks.size === 0 ? undefined : [...masks].sort().join(" | ");
}

/** Translate named epoch dependencies only through the shared runtime bridge. */
function semanticDependencyAdmissionGuard(
	guard: VmGuardPlan,
	activityEpochName?: string,
): string {
	const mask = semanticDependencyMask(guard.dependencies);
	if (mask === undefined) return "true";
	return `mal_vm_semantic_dependencies_admit(vm, ${mask}, ${activityEpochName === undefined ? "nullptr" : `&${activityEpochName}`})`;
}

function semanticDependencyValidationGuard(
	guard: VmGuardPlan,
	activityEpochName: string,
): string {
	const mask = semanticDependencyMask(guard.dependencies);
	if (mask === undefined) return "true";
	return `mal_vm_semantic_dependencies_validate(vm, ${mask}, ${activityEpochName})`;
}

/**
 * Translate one named region license at its admission point. Local brand,
 * callback, shape, and argument checks stay beside the runtime protocol; this
 * function owns only shared semantic dependencies and verifies that a generic
 * twin exists before C emission may consume them.
 */
function regionAdmissionGuard(
	license: VmRegionLicense,
	activityEpochName?: string,
): string {
	if (
		license.genericTwin !== "retained" ||
		!license.guard.obligations.includes("fallback")
	) {
		throw new Error("Speculative region lacks its generic twin");
	}
	if (
		license.materialization !== "none" &&
		!license.guard.obligations.includes("materialize")
	) {
		throw new Error("Virtual region lacks its materialization contract");
	}
	return semanticDependencyAdmissionGuard(license.guard, activityEpochName);
}

function inheritedStackObjectProtectorGuard(site: StackObjectSite): string {
	const guard = site.inheritedGuard;
	if (
		guard === undefined ||
		!guard.obligations.includes("fallback") ||
		!guard.obligations.includes("materialize")
	) {
		throw new Error("Inherited stack-object site lacks its fallback contract");
	}
	return semanticDependencyAdmissionGuard(guard);
}

interface NativeNumericFusionAction {
	readonly role: "start" | "finish" | "link";
	readonly truncating: boolean;
	readonly id: number;
	readonly first: Extract<BytecodeInstruction, { opcode: "BINARY" }>;
}

interface IndexedLengthLoopAction {
	readonly loadIp: number;
	readonly role: "load" | "compare" | "coerce" | "update" | "element";
	readonly site: Extract<VmRegion, { kind: "indexed-length-loop" }>["sites"][number];
	readonly element?: Extract<
		VmRegion,
		{ kind: "indexed-length-loop" }
	>["sites"][number]["elements"][number];
}

interface NativeArrayPresenceProjectionAction {
	readonly role: "membership" | "load";
	readonly membershipIp: number;
	readonly indexed: IndexedLengthLoopAction;
}

type NativeBodyResource = "propertyCache" | "literalShapes" | "newTarget" | "throwExit";

interface EmittedBody extends NativeCallCoverage {
	readonly lines: Array<string>;
	/** Line index of each instruction's emission; earlier lines declare body state. */
	readonly unitStarts: ReadonlyArray<number>;
	readonly sourceMap?: ReadonlyArray<NativeSourceRange>;
	readonly invocationPreamble: Array<string>;
	readonly resources: ReadonlySet<NativeBodyResource>;
}

const NATIVE_BODY_REFERENCES: Readonly<Record<NativeBodyResource, string>> = {
	propertyCache: "__property_ic",
	literalShapes: "__literal_shapes",
	newTarget: "new_target",
	throwExit: "__throw_exit",
};

function shapeSnapshotName(icIndex: number): string {
	return `__shape_snapshot_${icIndex}`;
}

function nativeBodyReference(
	resources: Set<NativeBodyResource>,
	resource: NativeBodyResource,
): string {
	resources.add(resource);
	return NATIVE_BODY_REFERENCES[resource];
}

function emitStringSwitch(
	site: Extract<
		NonNullable<NativeFunctionPlan["literalSwitches"]>[number],
		{ kind: "string" }
	>,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
	suffix: string,
	selectorKind: CompilerValueKindMask,
	relocation: NativeRelocationExpressions,
	branch: (target: number, branchIp: number) => string,
):
	| {
			lines: Array<string>;
			strategy: "direct" | "length" | "hash" | "non-string";
	  }
	| undefined {
	const fallback = branch(site.defaultIp, site.endIp);
	if ((selectorKind & COMPILER_VALUE_KIND_STRING) === 0)
		return { lines: [fallback], strategy: "non-string" };
	const labels: Array<{
		stringIndex: number;
		codeUnits: ReadonlyArray<number>;
		targetIp: number;
		branchIp: number;
	}> = [];
	const seen = new Set<number>();
	let totalCodeUnits = 0;
	let minLength = Infinity;
	let maxLength = 0;
	for (const [index, label] of site.cases.entries()) {
		const codeUnits = stringConstants[label.stringIndex];
		if (codeUnits === undefined) return undefined;
		totalCodeUnits += codeUnits.length;
		if (totalCodeUnits > NATIVE_STRING_SWITCH_CODE_UNIT_LIMIT) return undefined;
		if (seen.has(label.stringIndex)) continue;
		seen.add(label.stringIndex);
		minLength = Math.min(minLength, codeUnits.length);
		maxLength = Math.max(maxLength, codeUnits.length);
		labels.push({
			...label,
			codeUnits,
			branchIp: site.instructionIp + index * 3 + 2,
		});
	}
	const lengths = new Map<number, Array<(typeof labels)[number]>>();
	let largestLengthGroup = 0;
	for (const label of labels) {
		const length = label.codeUnits.length;
		let group = lengths.get(length);
		if (group === undefined) lengths.set(length, (group = []));
		group.push(label);
		largestLengthGroup = Math.max(largestLengthGroup, group.length);
	}
	const strategy =
		labels.length <= 3
			? "direct"
			: lengths.size > 1 && largestLengthGroup <= 3
				? "length"
				: labels.length >= 8
					? "hash"
					: "direct";
	const value = `__switch_${site.instructionIp}`;
	const lines: Array<string> = [];
	if (selectorKind !== COMPILER_VALUE_KIND_STRING)
		lines.push(`if (!mal_value_is_string(r${site.selector})) { ${fallback} }`);
	lines.push(`MalString *${value} = mal_value_to_string(r${site.selector});`);
	const compare = (label: (typeof labels)[number]) =>
		`if (mal_string_equals(${value}, mal_value_to_string(${relocation.stringValue(label.stringIndex)}))) { ${branch(label.targetIp, label.branchIp)} }`;
	if (strategy === "direct") {
		for (const label of labels) lines.push(compare(label));
	} else {
		const groups =
			strategy === "length" ? lengths : new Map<number, Array<(typeof labels)[number]>>();
		if (strategy === "hash") {
			for (const label of labels) {
				const hash = nativeStringSwitchHash(label.codeUnits);
				let group = groups.get(hash);
				if (group === undefined) groups.set(hash, (group = []));
				group.push(label);
			}
			// Bound rope flattening when hashing an unknown selector that cannot match a literal.
			lines.push(
				`if (${value}->length < ${minLength} || ${value}->length > ${maxLength}) { ${fallback} }`,
			);
		}
		lines.push(
			`switch (${strategy === "length" ? `${value}->length` : `(u32) mal_string_hash(${value})`}) {`,
		);
		for (const [key, group] of groups) {
			lines.push(`case ${key}U:`);
			for (const label of group) lines.push(compare(label));
			lines.push("break;");
		}
		lines.push("}");
	}
	lines.push(fallback);
	return { lines, strategy };
}

function analyzeNativeRegionTopology(
	fn: BytecodeFunction,
	specializations: ReadonlyArray<VmRegion>,
	regionActions: ReadonlyArray<VmRegionAction>,
): NativeRegionTopology {
	if (!vmRegionActionsAreCurrent(specializations, regionActions)) {
		throw new Error("Native function has stale region actions");
	}
	const actionsByKind = new Map<VmRegion["kind"], Array<VmRegionAction>>();
	for (const action of regionActions) {
		const kind = specializations[action.regionIndex]!.kind;
		const actions = actionsByKind.get(kind) ?? [];
		actions.push(action);
		actionsByKind.set(kind, actions);
	}
	const stringSplitProjections: Array<
		NativeRegionTopology["stringSplitProjections"][number]
	> = [];
	const stringSplitCursors: Array<NativeStringSplitCursor> = [];
	const regexpExecProjections: Array<
		NativeRegionTopology["regexpExecProjections"][number]
	> = [];
	const regexpIteratorProjections: Array<
		NativeRegionTopology["regexpIteratorProjections"][number]
	> = [];
	const seenSplitCalls = new Set<number>();
	const seenCursorCalls = new Set<number>();
	const seenExecCalls = new Set<number>();
	const seenIteratorSteps = new Set<number>();
	for (const projection of specializations) {
		if (projection.kind === "string-split-projection") {
			const elementLoads = projection.loads
				.filter(
					(
						load,
					): load is NativeStringSplitProjection["loads"][number] & {
						kind: "element";
						index: number;
					} => load.kind === "element" && load.index !== undefined,
				)
				.sort((left, right) => left.index - right.index);
			if (
				elementLoads.length === 0 ||
				elementLoads.length > 8 ||
				seenSplitCalls.has(projection.callIp)
			) {
				throw new Error(
					`Invalid Core string-split projection at instruction ${projection.callIp}`,
				);
			}

			seenSplitCalls.add(projection.callIp);
			stringSplitProjections.push({ projection, elementLoads });
		} else if (projection.kind === "string-split-cursor") {
			const callIp = projection.anchors[0]!;
			if (seenCursorCalls.has(callIp))
				throw new Error(`Duplicate Core string-split cursor at instruction ${callIp}`);
			seenCursorCalls.add(callIp);
			stringSplitCursors.push(projection);
		} else if (projection.kind === "regexp-exec-projection") {
			const loads = [...projection.loads].sort(
				(left, right) => left.captureIndex - right.captureIndex,
			);
			if (
				loads.length === 0 ||
				loads.length > 8 ||
				seenExecCalls.has(projection.callIp) ||
				loads.some(
					(load, index) =>
						load.captureIndex <= 0 ||
						(index > 0 && loads[index - 1]!.captureIndex >= load.captureIndex),
				)
			) {
				throw new Error(
					`Invalid Core RegExp.exec projection at instruction ${projection.callIp}`,
				);
			}

			seenExecCalls.add(projection.callIp);
			regexpExecProjections.push({ projection, loads });
		} else if (projection.kind === "regexp-iterator-projection") {
			const loads = [...projection.loads].sort(
				(left, right) => left.captureIndex - right.captureIndex,
			);
			if (
				loads.length === 0 ||
				loads.length > 8 ||
				seenIteratorSteps.has(projection.stepIp) ||
				loads.some(
					(load, index) =>
						load.captureIndex <= 0 ||
						(index > 0 && loads[index - 1]!.captureIndex >= load.captureIndex),
				)
			) {
				throw new Error(
					`Invalid Core RegExp iterator projection at instruction ${projection.stepIp}`,
				);
			}

			seenIteratorSteps.add(projection.stepIp);
			regexpIteratorProjections.push({ projection, loads });
		}
	}
	const numericFusionCandidates: Array<NativeNumericFusionCandidate> = [];
	for (const action of regionActions) {
		const region = specializations[action.regionIndex];
		if (region?.kind !== "numeric-fusion") continue;
		const pair = region.pairs[action.primaryIndex ?? -1];
		if (pair === undefined || (action.role !== "start" && action.role !== "finish")) {
			throw new Error("Invalid numeric-fusion action");
		}
		const first = fn.instructions[pair.firstIp];
		const finish = fn.instructions[pair.finishIp];
		if (
			first?.opcode !== "BINARY" ||
			finish?.opcode !== "BINARY" ||
			action.ip !== (action.role === "start" ? pair.firstIp : pair.finishIp)
		) {
			throw new Error("Invalid numeric-fusion region");
		}
		const common = {
			id: pair.firstIp,
			first,
			truncating: region.representation === "binary-pairs-truncating-i32",
		};
		numericFusionCandidates.push({
			instructionIp: action.ip,
			finishIp: pair.finishIp,
			action: { ...common, role: action.role },
		});
	}
	const indexedLengthLoopActionByIp = new Map<number, IndexedLengthLoopAction>();
	for (const action of regionActions) {
		const region = specializations[action.regionIndex];
		if (region?.kind !== "indexed-length-loop") continue;
		const site = region.sites[action.primaryIndex ?? -1];
		if (
			site === undefined ||
			(action.role !== "load" &&
				action.role !== "compare" &&
				action.role !== "coerce" &&
				action.role !== "update" &&
				action.role !== "element")
		) {
			throw new Error("Invalid indexed-length-loop action");
		}
		const load = fn.instructions[site.loadIp];
		const comparison = fn.instructions[site.comparisonIp];
		const element =
			action.role === "element" ? site.elements[action.secondaryIndex ?? -1] : undefined;
		const length =
			comparison?.opcode === "BINARY"
				? site.lengthPosition === 1
					? comparison.left
					: comparison.right
				: -1;
		const other =
			comparison?.opcode === "BINARY"
				? site.lengthPosition === 1
					? comparison.right
					: comparison.left
				: -1;
		const elementInstruction =
			element === undefined ? undefined : fn.instructions[element.ip];
		const indexedInstruction =
			element?.indexIp === undefined ? undefined : fn.instructions[element.indexIp];
		const reverse = site.reverseInduction;
		const coercion =
			reverse === undefined ? undefined : fn.instructions[reverse.coercionIp];
		const update = reverse === undefined ? undefined : fn.instructions[reverse.updateIp];
		if (
			(load?.opcode !== "LOAD_PROPERTY_STATIC" &&
				load?.opcode !== "LOAD_PROPERTY_STATIC_ARRAY_LENGTH") ||
			comparison?.opcode !== "BINARY" ||
			!["<", "<=", ">", ">=", "==", "!=", "===", "!=="].includes(comparison.operator) ||
			(reverse === undefined
				? length !== load.dst
				: comparison.operator !== ">" ||
					coercion?.opcode !== "UNARY" ||
					coercion.operator !== "tonumeric" ||
					update?.opcode !== "UNARY" ||
					update.operator !== "decrement" ||
					coercion.dst !== update.src ||
					!nativeLoopUpdateTransportsValue(
						fn,
						reverse.updateIp,
						-1,
						site.comparisonIp,
						length,
					)) ||
			(action.role === "element"
				? element === undefined ||
					typeof element.arrayIndexIsUint32 !== "boolean" ||
					(element.kind === "load"
						? elementInstruction?.opcode !== "LOAD_PROPERTY"
						: elementInstruction?.opcode !== "STORE_PROPERTY") ||
					(elementInstruction?.opcode === "LOAD_PROPERTY" ||
					elementInstruction?.opcode === "STORE_PROPERTY"
						? elementInstruction.object !== load.object ||
							(reverse === undefined
								? elementInstruction.key !== other
								: element.indexIp === undefined
									? elementInstruction.key !== length
									: indexedInstruction?.opcode !== "BINARY" ||
										indexedInstruction.operator !== "-" ||
										indexedInstruction.left !== length ||
										elementInstruction.key !== indexedInstruction.dst)
						: true)
				: element !== undefined) ||
			((action.role === "coerce" || action.role === "update") && reverse === undefined) ||
			(element?.arrayIndexIsUint32 === true &&
				!(
					reverse === undefined &&
					((site.lengthPosition === 1 && comparison.operator === ">") ||
						(site.lengthPosition === 2 && comparison.operator === "<"))
				)) ||
			action.ip !==
				(action.role === "load"
					? site.loadIp
					: action.role === "compare"
						? site.comparisonIp
						: action.role === "coerce"
							? reverse!.coercionIp
							: action.role === "update"
								? reverse!.updateIp
								: element!.ip) ||
			indexedLengthLoopActionByIp.has(action.ip)
		) {
			throw new Error("Invalid indexed-length-loop region");
		}
		indexedLengthLoopActionByIp.set(action.ip, {
			loadIp: site.loadIp,
			role: action.role,
			site,
			...(element === undefined ? {} : { element }),
		});
	}
	const nativeStringCharCodeAtChainActionByIp = new Map<
		number,
		NativeStringCharCodeAtChainAction
	>();
	const nativeBuiltinCollectionCallChainActionByIp = new Map<
		number,
		NativeBuiltinCollectionCallChainAction
	>();
	for (const action of regionActions) {
		const chain = specializations[action.regionIndex];
		if (chain?.kind === "string-char-code-at-chain") {
			if (
				(action.role !== "property" && action.role !== "call") ||
				action.ip !== (action.role === "property" ? chain.propertyIp : chain.callIp) ||
				nativeStringCharCodeAtChainActionByIp.has(action.ip)
			) {
				throw new Error("Duplicate String.charCodeAt chain action");
			}
			nativeStringCharCodeAtChainActionByIp.set(action.ip, {
				chain,
				role: action.role,
			});
		} else if (chain?.kind === "builtin-collection-call-chain") {
			if (
				(action.role !== "property" && action.role !== "call") ||
				action.ip !== (action.role === "property" ? chain.propertyIp : chain.callIp) ||
				nativeBuiltinCollectionCallChainActionByIp.has(action.ip)
			) {
				throw new Error("Duplicate collection call-chain action");
			}
			nativeBuiltinCollectionCallChainActionByIp.set(action.ip, {
				chain,
				role: action.role,
			});
		}
	}
	const nativeIteratorCursorActionByIp = new Map<number, NativeIteratorCursorAction>();
	const nativeIteratorResultVirtualizationActionByIp = new Map<
		number,
		NativeIteratorResultVirtualizationAction
	>();
	const nativeIteratorEntryPairVirtualizationActionByIp = new Map<
		number,
		NativeIteratorEntryPairVirtualizationAction
	>();
	for (const action of regionActions) {
		const region = specializations[action.regionIndex];
		if (region === undefined) throw new Error("Native region action names no region");
		if (
			region.kind === "array-values-iterator-cursor" ||
			region.kind === "string-iterator-cursor" ||
			region.kind === "typed-array-iterator-cursor" ||
			region.kind === "map-iterator-cursor" ||
			region.kind === "set-iterator-cursor"
		) {
			if (
				(action.role !== "initialize" &&
					action.role !== "step" &&
					action.role !== "close") ||
				action.ip !==
					(action.role === "initialize"
						? region.initializeIp
						: action.role === "step"
							? region.stepIps[action.primaryIndex ?? -1]
							: region.kind === "array-values-iterator-cursor"
								? region.closeIps[action.primaryIndex ?? -1]
								: undefined) ||
				nativeIteratorCursorActionByIp.has(action.ip)
			) {
				throw new Error("Duplicate iterator cursor action");
			}
			nativeIteratorCursorActionByIp.set(action.ip, {
				cursor: region,
				role: action.role,
			});
		} else if (region.kind === "iterator-result-virtualization") {
			if (
				action.role !== "step" ||
				action.ip !== region.stepIps[action.primaryIndex ?? -1] ||
				nativeIteratorResultVirtualizationActionByIp.has(action.ip)
			) {
				throw new Error("Duplicate iterator-result virtualization action");
			}
			nativeIteratorResultVirtualizationActionByIp.set(action.ip, { region });
		} else if (region.kind === "iterator-entry-pair-virtualization") {
			const index = action.primaryIndex;
			const valid =
				(action.role === "outerStep" && action.ip === region.outerStepIp) ||
				(action.role === "innerInitialize" && action.ip === region.innerInitializeIp) ||
				(action.role === "innerStep" && action.ip === region.innerStepIps[index ?? -1]) ||
				(action.role === "innerClose" && action.ip === region.innerCloseIps[index ?? -1]);
			if (!valid || nativeIteratorEntryPairVirtualizationActionByIp.has(action.ip)) {
				throw new Error("Duplicate iterator entry-pair virtualization action");
			}
			nativeIteratorEntryPairVirtualizationActionByIp.set(action.ip, {
				region,
				role: action.role,
				...(index === undefined ? {} : { index }),
			});
		}
	}
	return {
		actionsByKind,
		stringSplitProjections,
		stringSplitCursors,
		regexpExecProjections,
		regexpIteratorProjections,
		numericFusionCandidates,
		indexedLengthLoopActionByIp,
		nativeStringCharCodeAtChainActionByIp,
		nativeBuiltinCollectionCallChainActionByIp,
		nativeIteratorCursorActionByIp,
		nativeIteratorResultVirtualizationActionByIp,
		nativeIteratorEntryPairVirtualizationActionByIp,
	};
}

function emitBody(
	fn: BytecodeFunction,
	analysis: NativeBodyAnalysis,
	functionIndex: number,
	specializations: ReadonlyArray<VmRegion>,
	regionActions: ReadonlyArray<VmRegionAction>,
	nativeInstructions: ReadonlyArray<NativeInstructionPlan | undefined>,
	nativeFacts: NativeFunctionPlan["facts"],
	inactiveRootMasks: ReadonlyMap<number, NativeInactiveRootMask>,
	inactiveRootMaskStatements: ReadonlyMap<NativeInactiveRootMask, string>,
	gcSafepointKinds: ReadonlyMap<
		number,
		NativeFunctionPlan["gc"]["safepoints"][number]["kind"]
	>,
	suffix: string,
	reps: Array<RegisterRep>,
	debug: NativeFramePositions | false,
	gcUnlink: string,
	thisSlot: number,
	coro: CoroutineContext | null,
	stackObjectSites: ReadonlyMap<number, StackObjectSite>,
	stackObjectAccesses: ReadonlyMap<number, { site: StackObjectSite; slot: number }>,
	stackObjectMaterializations: ReadonlyMap<number, StackObjectMaterialization>,
	stackObjectInheritedAccesses: ReadonlyMap<number, StackObjectSite>,
	stringSplitProjectionSites: ReadonlyMap<number, NativeStringSplitProjectionSite>,
	stringSplitCursorSites: ReadonlyMap<number, NativeStringSplitCursorSite>,
	regexpExecProjectionSites: ReadonlyMap<number, NativeRegExpExecProjectionSite>,
	regexpIteratorProjectionSites: ReadonlyMap<number, NativeRegExpIteratorProjectionSite>,
	stringSpanSites: ReadonlyMap<number, NativeStringSpanSite>,
	objectEnumerationSnapshotSites: ReadonlyMap<
		number,
		NativeObjectEnumerationSnapshotSite
	>,
	directCompiledTargets: ReadonlySet<number>,
	directCompiledEntries: DirectCompiledEntries,
	directResultRepresentation: VmRegisterRepresentation | undefined,
	watchedMethodsGuard: VmGuardPlan | undefined,
	profileDecisions: Array<BackendProfileDecision>,
	relocation: NativeRelocationExpressions = UNRELOCATED_NATIVE_EXPRESSIONS,
	strictCompiledTargets: ReadonlySet<number> = new Set(),
	directArgumentRepresentations?: ReadonlyArray<VmRegisterRepresentation>,
	directConstantBooleans: ReadonlyMap<number, boolean> = new Map(),
	directFields?: NativeDirectEntryPlan["fieldParameters"],
	fieldCalls?: ReadonlyArray<NativeFieldCall>,
	literalSwitches?: NativeFunctionPlan["literalSwitches"],
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
	rootPublication?: NativeRootPublication,
	expressionIps: ReadonlySet<number> = new Set(),
	rematerializedConstantIps: ReadonlySet<number> = new Set(),
	fastPathPlans: NativeFastPathPlans = {
		literalPropertyDefinitions: [],
		mathCalls: [],
		numberPredicates: [],
		stringTransforms: [],
		arrayInitializations: [],
		mapEntries: [],
		objectEnumerationSnapshots: [],
		spanContinuations: [],
		propertyProjections: [],
		propertyNumericUpdates: [],
		propertyReadRegions: [],
		propertyReadPairs: [],
		numberRecordRegions: [],
		numericLoopRegions: [],
		pairedArrayLoops: [],
		arrayPresence: [],
		arrayPairDestructure: [],
	},
	callTransports: ReadonlyArray<NativeCallTransportPlan> = [],
	callbackTransports: ReadonlyArray<NativeCallbackTransportPlan> = [],
	rootPublicationContinuations: ReadonlySet<number> = new Set(),
	maxCodeUnits = Infinity,
	restArgumentRootReleaseIp?: number,
	captureShadow?: NativeCaptureShadow,
	directClosures: ReadonlyMap<string, NativeDirectClosureEnvironment> = new Map(),
	// A conservative-root callee services pending polls at its entry instead.
	callReturnPolls = true,
	records: NativeRecordStorage = NO_NATIVE_RECORD_STORAGE,
	controlFlow?: NativeControlFlowPlan,
	elidedPureIps: ReadonlyArray<number> = [],
	stringComparisons: ReadonlyArray<NativeStringComparisonPlan> = [],
): EmittedBody | null {
	const elided = new Set(elidedPureIps);
	const unreachable = new Set(controlFlow?.unreachableIps);
	const branchTargets = new Map(
		controlFlow?.branches.map(({ instructionIp, targetIp }) => [instructionIp, targetIp]),
	);
	const callTransportByIp = new Map(
		callTransports.map((plan) => [plan.instructionIp, plan]),
	);
	const callbackTransportByIp = new Map(
		callbackTransports.map((plan) => [plan.instructionIp, plan]),
	);
	const expressionLocals = new Set(
		[...expressionIps].map((ip) => {
			const op = fn.instructions[ip]!;
			if (!("dst" in op)) throw new Error("Native expression lacks a destination");
			return op.dst;
		}),
	);
	const { stableCaptureOwners, copiedCaptures, requiredCaptureOwners } = analysis;
	const topology = analysis.regionTopology(specializations, regionActions);
	const {
		indexedLengthLoopActionByIp: allIndexedLengthLoopActions,
		nativeStringCharCodeAtChainActionByIp,
		nativeBuiltinCollectionCallChainActionByIp,
		nativeIteratorCursorActionByIp,
		nativeIteratorResultVirtualizationActionByIp,
		nativeIteratorEntryPairVirtualizationActionByIp,
	} = topology;
	const snapshotLengthIps = new Set(
		[...objectEnumerationSnapshotSites.values()].flatMap((site) => site.lengthIps),
	);
	const indexedLengthLoopActionByIp = new Map(
		[...allIndexedLengthLoopActions].filter(
			([, action]) => !snapshotLengthIps.has(action.loadIp),
		),
	);
	const numericFusionActionByIp = new Map<number, NativeNumericFusionAction>();
	const fusionCandidatesByIp = new Map<number, Array<NativeNumericFusionAction>>();
	for (const candidate of topology.numericFusionCandidates) {
		if (
			nativeInstructions[candidate.action.id]?.kind === "unsigned-arithmetic" ||
			nativeInstructions[candidate.finishIp]?.kind === "unsigned-arithmetic" ||
			[candidate.action.id, candidate.finishIp].some((ip) => {
				const masks = nativeFacts?.[ip]?.inputKindMasks;
				const instruction = fn.instructions[ip];
				return (
					instruction?.opcode === "BINARY" &&
					masks !== undefined &&
					masks.some(
						(mask) => compilerNumberFastPathInputKind(instruction.operator, mask) === 0,
					)
				);
			})
		)
			continue;
		const actions = fusionCandidatesByIp.get(candidate.instructionIp) ?? [];
		actions.push(candidate.action);
		fusionCandidatesByIp.set(candidate.instructionIp, actions);
	}
	// A chain keeps its head's temporaries: each link continues the value it consumes in place.
	const chainHeads = new Map<number, number>();
	for (const ip of [...fusionCandidatesByIp.keys()].sort((left, right) => left - right)) {
		const actions = fusionCandidatesByIp.get(ip)!;
		const finish = actions.find(({ role }) => role === "finish");
		const start = actions.find(({ role }) => role === "start");
		if (
			actions.length > 2 ||
			(actions.length === 2 && (finish === undefined || start === undefined))
		)
			throw new Error("Invalid numeric-fusion region");
		const incoming =
			finish === undefined
				? undefined
				: { ...finish, id: chainHeads.get(finish.id) ?? finish.id };
		if (incoming === undefined || start === undefined) {
			numericFusionActionByIp.set(ip, incoming ?? start!);
			continue;
		}
		const instruction = fn.instructions[ip];
		if (incoming.truncating || start.truncating || instruction?.opcode !== "BINARY")
			throw new Error("Invalid numeric-fusion region");
		// Each pair keeps its value unmaterialized only while its start's result is boxed.
		const incomingFused = reps[incoming.first.dst] === "boxed";
		if (incomingFused && reps[instruction.dst] === "boxed") {
			numericFusionActionByIp.set(ip, { ...incoming, role: "link" });
			chainHeads.set(ip, incoming.id);
		} else numericFusionActionByIp.set(ip, incomingFused ? incoming : start);
	}
	const nativeArrayPresenceProjectionActionByIp = new Map<
		number,
		NativeArrayPresenceProjectionAction
	>();
	for (const plan of fastPathPlans.arrayPresence) {
		const indexed = indexedLengthLoopActionByIp.get(plan.loadIp);
		if (indexed === undefined || indexed.role !== "element")
			throw new Error("Invalid native array presence reference");
		for (const [ip, role] of [
			[plan.membershipIp, "membership"],
			[plan.loadIp, "load"],
		] as const)
			nativeArrayPresenceProjectionActionByIp.set(ip, {
				role,
				membershipIp: plan.membershipIp,
				indexed,
			});
	}
	const nativeArrayPairDestructureActionByIp = new Map<
		number,
		NativeArrayPairDestructureAction
	>();
	for (const plan of fastPathPlans.arrayPairDestructure) {
		const cursor = specializations[plan.regionIndex];
		if (cursor?.kind !== "array-values-iterator-cursor")
			throw new Error("Invalid native array pair cursor reference");
		nativeArrayPairDestructureActionByIp.set(plan.initializeIp, {
			cursor,
			role: "initialize",
		});
		nativeArrayPairDestructureActionByIp.set(plan.firstStepIp, {
			cursor,
			role: "step",
			index: 0,
		});
		nativeArrayPairDestructureActionByIp.set(plan.secondStepIp, {
			cursor,
			role: "step",
			index: 1,
		});
		nativeArrayPairDestructureActionByIp.set(plan.closeIp, {
			cursor,
			role: "close",
		});
	}
	// Pair and entry-pair fast paths rewrite the inner iterator registers they share;
	// an entry-pair outer step steps a deferred loop cursor itself.
	const deferredIteratorCursors = new Set<number>();
	for (const { cursor, role } of nativeIteratorCursorActionByIp.values()) {
		const initialize = fn.instructions[cursor.initializeIp];
		if (
			role !== "initialize" ||
			initialize?.opcode !== "GET_ITERATOR" ||
			((instructionInputKind(nativeFacts?.[cursor.initializeIp], initialize.source) ??
				COMPILER_VALUE_KIND_TOP) &
				COMPILER_VALUE_KIND_OBJECT) ===
				0 ||
			cursor.kind !== "array-values-iterator-cursor" ||
			cursor.stateSynchronization !== "materialize-before-observation" ||
			[cursor.initializeIp, ...cursor.stepIps, ...cursor.closeIps].some(
				(ip) =>
					nativeArrayPairDestructureActionByIp.has(ip) ||
					(nativeIteratorEntryPairVirtualizationActionByIp.get(ip)?.role ??
						"outerStep") !== "outerStep",
			)
		)
			continue;
		deferredIteratorCursors.add(cursor.initializeIp);
	}
	const { handlerTargets } = analysis;
	// An admitted region continues at its exit labels.
	const jumpTargets =
		fastPathPlans.numberRecordRegions.length === 0 &&
		fastPathPlans.numericLoopRegions.length === 0
			? analysis.jumpTargets
			: new Set([
					...analysis.jumpTargets,
					...fastPathPlans.numberRecordRegions.map((plan) => plan.exitIp),
					...fastPathPlans.numericLoopRegions.flatMap((plan) =>
						plan.exits.map((exit) => exit.targetIp),
					),
				]);
	const numberRecordRegionById = new Map(
		fastPathPlans.numberRecordRegions.map((plan) => [plan.id, plan]),
	);
	const integerLoopRegionByEntry = new Map(
		fastPathPlans.numericLoopRegions.map((plan) => [plan.entryIp, plan]),
	);
	const ownsCaptureEnvironment = coro === null && analysis.ownsCaptureEnvironment;
	const staticDefineStringIndexByIp = new Map(
		fastPathPlans.literalPropertyDefinitions.map((plan) => [
			plan.instructionIp,
			plan.stringIndex,
		]),
	);
	const mathCalls = new Map(
		fastPathPlans.mathCalls.map((plan) => [plan.instructionIp, plan]),
	);
	const mathCalleeRegisters = new Set(
		fastPathPlans.mathCalls.flatMap((plan) => {
			const call = fn.instructions[plan.instructionIp];
			return call?.opcode === "CALL" ? [call.callee] : [];
		}),
	);
	const numberPredicates = new Map(
		fastPathPlans.numberPredicates.map((plan) => [plan.instructionIp, plan]),
	);
	const arrayInitializations = new Map(
		fastPathPlans.arrayInitializations.flatMap((plan) =>
			plan.claimedIps.map((ip) => [ip, plan] as const),
		),
	);
	const mapEntries = new Map(
		fastPathPlans.mapEntries.flatMap(
			(plan) =>
				[
					[plan.getIp, plan],
					[plan.setIp, plan],
				] as const,
		),
	);
	const objectEnumerationSnapshots = new Map(
		[...objectEnumerationSnapshotSites.values()].flatMap((site) =>
			site.claimedIps.map((ip) => [ip, site] as const),
		),
	);

	const stringTransforms = new Map(
		fastPathPlans.stringTransforms.map((plan) => [plan.instructionIp, plan]),
	);
	const { iterationEligibilityRegisters } = analysis;
	const nativeStringSplitProjectionActionByIp = new Map<
		number,
		NativeStringSplitProjectionAction
	>();
	for (const action of topology.actionsByKind.get("string-split-projection") ?? []) {
		const projection = specializations[action.regionIndex];
		if (projection?.kind !== "string-split-projection") continue;
		const site = stringSplitProjectionSites.get(projection.callIp);
		if (site === undefined) throw new Error("String.split projection action has no site");
		const propertyLoad = regionFallbackPropertyLoad(
			fn,
			projection.propertyPlacement,
			projection.propertyIp,
			site.lockedIdentity,
		);
		const load =
			action.primaryIndex === undefined
				? undefined
				: projection.loads[action.primaryIndex];
		if (
			(action.role !== "property" &&
				action.role !== "call" &&
				action.role !== "element" &&
				action.role !== "length") ||
			((action.role === "element" || action.role === "length") &&
				(load === undefined || load.kind !== action.role))
		) {
			throw new Error("Invalid String.split projection action");
		}
		nativeStringSplitProjectionActionByIp.set(action.ip, {
			site,
			role: action.role,
			...(load === undefined ? {} : { load }),
			...(propertyLoad === undefined ? {} : { propertyLoad }),
		});
	}
	const stringSplitTrimLengthSiteByIp = new Map<number, NativeStringSplitCursorSite>();
	const nativeStringSplitCursorActionByIp = new Map<
		number,
		NativeStringSplitCursorAction
	>();
	for (const action of topology.actionsByKind.get("string-split-cursor") ?? []) {
		const cursor = specializations[action.regionIndex];
		if (cursor?.kind !== "string-split-cursor") continue;
		const site = stringSplitCursorSites.get(cursor.anchors[0]!);
		if (site === undefined) throw new Error("String.split cursor action has no site");
		for (const lengthIp of cursor.primitiveStringLengthIps) {
			stringSplitTrimLengthSiteByIp.set(lengthIp, site);
		}
		const propertyLoad = regionFallbackPropertyLoad(
			fn,
			cursor.propertyPlacement,
			cursor.propertyIp,
			site.lockedIdentity,
		);
		if (
			action.role !== "property" &&
			action.role !== "call" &&
			action.role !== "length" &&
			action.role !== "element" &&
			action.role !== "trimProperty" &&
			action.role !== "trimCall"
		) {
			throw new Error("Invalid String.split cursor action");
		}
		nativeStringSplitCursorActionByIp.set(action.ip, {
			site,
			role: action.role,
			...(propertyLoad === undefined ? {} : { propertyLoad }),
		});
	}
	const nativeRegExpExecProjectionActionByIp = new Map<
		number,
		NativeRegExpExecProjectionAction
	>();
	for (const action of topology.actionsByKind.get("regexp-exec-projection") ?? []) {
		const projection = specializations[action.regionIndex];
		if (projection?.kind !== "regexp-exec-projection") continue;
		const site = regexpExecProjectionSites.get(projection.callIp);
		if (site === undefined) throw new Error("RegExp projection action has no site");
		const propertyLoad = regionFallbackPropertyLoad(
			fn,
			projection.propertyPlacement,
			projection.propertyIp,
			projection.lockedFreshLiteral,
		);
		const load =
			action.primaryIndex === undefined
				? undefined
				: projection.loads[action.primaryIndex];
		if (action.primaryIndex !== undefined && load === undefined) {
			throw new Error("Invalid RegExp projection action payload");
		}
		nativeRegExpExecProjectionActionByIp.set(action.ip, {
			site,
			role: action.role as NativeRegExpExecProjectionAction["role"],
			...(load === undefined ? {} : { load }),
			...(propertyLoad === undefined ? {} : { propertyLoad }),
		});
	}
	const nativeRegExpIteratorProjectionActionByIp = new Map<
		number,
		NativeRegExpIteratorProjectionAction
	>();
	for (const action of topology.actionsByKind.get("regexp-iterator-projection") ?? []) {
		const projection = specializations[action.regionIndex];
		if (projection?.kind !== "regexp-iterator-projection") continue;
		const site = regexpIteratorProjectionSites.get(projection.stepIp);
		if (site === undefined) throw new Error("RegExp iterator action has no site");
		const load =
			action.primaryIndex === undefined
				? undefined
				: projection.loads[action.primaryIndex];
		if (
			(action.role !== "step" && action.role !== "capture" && action.role !== "number") ||
			(action.primaryIndex !== undefined && load === undefined)
		) {
			throw new Error("Invalid RegExp iterator action");
		}
		nativeRegExpIteratorProjectionActionByIp.set(action.ip, {
			site,
			role: action.role,
			...(load === undefined ? {} : { load }),
		});
	}
	const nativeStringSpanActionByIp = new Map<number, NativeStringSpanAction>();
	for (const site of stringSpanSites.values()) {
		nativeStringSpanActionByIp.set(site.producerIp, {
			site,
			role: site.projection === undefined ? "range" : "projection",
		});
		for (const consumer of site.consumers)
			if (consumer.kind !== "rangeCall")
				nativeStringSpanActionByIp.set(consumer.ip, {
					site,
					role: consumer.kind,
					consumer,
				});
	}
	const lines: Array<string> = [];
	const resources = new Set<NativeBodyResource>();
	const emittedInstructions = new Set<number>();
	const directEntryCalls = new Map<number, Set<number>>();
	const stringLeafCaches = new Set<number>();
	// Record-region field rows whose last shape lives in a frame local; only loops reuse one.
	const shapeSnapshots = new Set<number>();
	const loopInstructions = bytecodeLoopInstructions(fn);
	const invocationPreamble: Array<string> = [];
	for (const action of nativeStringCharCodeAtChainActionByIp.values()) {
		if (action.role !== "call") continue;
		lines.push(`bool __string_char_code_at_${action.chain.callIp}_captured = false;`);
	}
	for (const action of nativeIteratorCursorActionByIp.values()) {
		if (action.role !== "initialize") continue;
		lines.push(
			`MalIteratorObject *__iter_cursor_${action.cursor.initializeIp} = nullptr;`,
		);
		if (action.cursor.protocol === "array-values") {
			lines.push(
				`MalIteratorObject *__iter_string_cursor_${action.cursor.initializeIp} = nullptr;`,
			);
		}
		if (deferredIteratorCursors.has(action.cursor.initializeIp)) {
			lines.push(
				`MalArrayValuesDeferredCursor __iter_deferred_${action.cursor.initializeIp} = { .active = false };`,
			);
		}
	}
	for (const action of nativeArrayPairDestructureActionByIp.values()) {
		if (action.role !== "initialize") continue;
		const id = action.cursor.initializeIp;
		lines.push(
			`bool __array_pair_${id}_fast = false;`,
			`MalValue __array_pair_${id}_first = MAL_VALUE_UNDEFINED;`,
			`MalValue __array_pair_${id}_second = MAL_VALUE_UNDEFINED;`,
			`bool __array_pair_${id}_first_done = false;`,
			`bool __array_pair_${id}_second_done = false;`,
		);
	}
	for (const action of nativeIteratorEntryPairVirtualizationActionByIp.values()) {
		if (action.role !== "outerStep") continue;
		const id = action.region.outerStepIp;
		lines.push(
			`bool __iter_entry_pair_${id}_fast = false;`,
			`MalValue __iter_entry_pair_${id}_first = MAL_VALUE_UNDEFINED;`,
			`MalValue __iter_entry_pair_${id}_second = MAL_VALUE_UNDEFINED;`,
		);
	}
	for (const site of stringSplitProjectionSites.values()) {
		lines.push(
			`bool __string_split_${site.projection.callIp}_fast = false;`,
			`u32 __string_split_${site.projection.callIp}_length = 0;`,
			`usize __string_split_${site.projection.callIp}_starts[${site.elementLoads.length}];`,
			`usize __string_split_${site.projection.callIp}_ends[${site.elementLoads.length}];`,
		);
	}
	for (const site of stringSplitCursorSites.values()) {
		const id = site.callIp;
		lines.push(
			`bool __string_split_cursor_${id}_active = false;`,
			`bool __string_split_cursor_${id}_has = false;`,
			`bool __string_split_cursor_${id}_trim_fast = false;`,
			`u32 __string_split_cursor_${id}_trim_length = 0;`,
			`MalStringSplitCursor __string_split_cursor_${id}_state = { 0 };`,
			`usize __string_split_cursor_${id}_start = 0;`,
			`usize __string_split_cursor_${id}_end = 0;`,
			...(site.semanticEpochStable || site.trimCalleeSlot === undefined
				? []
				: [`u64 ${site.epochName} = 0;`]),
		);
	}
	for (const site of regexpExecProjectionSites.values()) {
		lines.push(
			`bool __regexp_exec_${site.projection.callIp}_fast = false;`,
			`bool __regexp_exec_${site.projection.callIp}_projected = false;`,
			`i32 __regexp_exec_${site.projection.callIp}_starts[${site.loads.length}];`,
			`i32 __regexp_exec_${site.projection.callIp}_ends[${site.loads.length}];`,
		);
		for (const load of site.loads) {
			if (load.consumer?.kind === "charCodeAtZero") {
				lines.push(
					`bool __regexp_exec_${site.projection.callIp}_char_${load.consumer.callIp}_fast = false;`,
				);
			} else if (load.consumer?.kind === "asciiCaseLength") {
				lines.push(
					`bool __regexp_exec_${site.projection.callIp}_case_${load.consumer.upperCallIp}_fast = false;`,
					`u32 __regexp_exec_${site.projection.callIp}_case_${load.consumer.upperCallIp}_length = 0;`,
				);
			}
		}
	}
	for (const site of regexpIteratorProjectionSites.values()) {
		lines.push(
			`bool __regexp_iter_${site.projection.stepIp}_projected = false;`,
			`i32 __regexp_iter_${site.projection.stepIp}_starts[${site.loads.length}];`,
			`i32 __regexp_iter_${site.projection.stepIp}_ends[${site.loads.length}];`,
		);
	}
	for (const site of stringSpanSites.values()) {
		const id = site.producerIp;
		lines.push(
			`bool __string_span_${id}_active = false;`,
			`usize __string_span_${id}_start = 0;`,
			`usize __string_span_${id}_end = 0;`,
		);
	}
	for (const action of indexedLengthLoopActionByIp.values()) {
		if (action.role !== "load") continue;
		lines.push(
			`u8 __indexed_length_${action.loadIp}_kind = 0;`,
			`MalArrayObject *__indexed_length_${action.loadIp}_array = nullptr;`,
			`MalTypedArrayObject *__indexed_length_${action.loadIp}_typed_array = nullptr;`,
			`u32 __indexed_length_${action.loadIp}_value = 0;`,
			`f64 __indexed_length_${action.loadIp}_induction = 0;`,
		);
	}
	for (const action of nativeArrayPresenceProjectionActionByIp.values()) {
		if (action.role !== "membership") continue;
		lines.push(
			`i32 __array_presence_${action.membershipIp}_state = -1;`,
			`MalValue __array_presence_${action.membershipIp}_value = MAL_VALUE_UNDEFINED;`,
		);
	}
	if (
		[...stringSplitCursorSites.values()].some((site) => !site.lockedIdentity) ||
		[...nativeStringCharCodeAtChainActionByIp.values()].some(
			(action) =>
				action.role === "call" && action.chain.methodIdentity === "runtime-guarded",
		) ||
		[...regexpExecProjectionSites.values()].some((site) =>
			site.loads.some(
				(load) =>
					(load.consumer?.kind === "charCodeAtZero" ||
						load.consumer?.kind === "asciiCaseLength") &&
					load.consumer.methodIdentity === "runtime-guarded",
			),
		)
	) {
		const watchedMethodsAdmission =
			watchedMethodsGuard === undefined
				? "false"
				: semanticDependencyAdmissionGuard(watchedMethodsGuard);
		const watchedMethodsEpoch =
			watchedMethodsAdmission === "true"
				? "vm->semantic_epochs.watched_methods"
				: watchedMethodsAdmission === "false"
					? "0"
					: `${watchedMethodsAdmission} ? vm->semantic_epochs.watched_methods : 0`;
		(coro === null ? lines : invocationPreamble).push(
			`u64 __watched_methods_epoch = ${watchedMethodsEpoch};`,
		);
	}
	// Pair-fusion temporaries live for the whole C function so intervening property
	// loads retain their original position and control-flow labels never jump over a
	// declaration.
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const instruction = fn.instructions[ip]!;
		const fusion = numericFusionActionByIp.get(ip);
		if (
			instruction.opcode === "BINARY" &&
			fusion?.role === "start" &&
			(fusion.truncating || reps[instruction.dst] === "boxed")
		) {
			const id = fusion.id;
			if (fusion.truncating) {
				lines.push(`i32 __nf_${id}_integer = 0;`);
			}
			lines.push(`bool __nf_${id}_ok = false;`);
			lines.push(`f64 __nf_${id}_value = 0.0;`);
		}
	}
	// Publish source positions only before operations that can synchronously capture
	// this frame. Pure arithmetic/control-flow transitions need no native-frame write.
	const fieldAllocations = new Map<number, NativeFieldCall>();
	const fieldCallSites = new Map<number, NativeFieldCall>();
	const definitionPublicationBarriers = new Set([
		...specializations.flatMap((region) => region.claimedIps),
		...regionActions.map((action) => action.ip),
	]);
	for (const site of fieldCalls ?? []) {
		for (let ip = site.allocationIp; ip <= site.callIp; ip++)
			definitionPublicationBarriers.add(ip);
		fieldAllocations.set(site.allocationIp, site);
		fieldCallSites.set(site.callIp, site);
		for (let field = 0; field < site.allocation.count; field++) {
			if (site.boxedSlots[field] === undefined)
				(coro === null ? lines : invocationPreamble).push(
					`${cTypeOf(site.valueRepresentations[field]!)} __field_${site.allocationIp}_${field} = 0;`,
				);
		}
	}

	const fieldLoads = new Map(
		directFields?.loads.map((load) => [
			load.instructionIp,
			{
				field: load.field,
				representation: directFields.representations[load.field]!,
			},
		]),
	);
	const staticPropertyProjectionConflicts = (ip: number): boolean =>
		expressionIps.has(ip) ||
		nativeInstructions[ip] !== undefined ||
		fieldLoads.has(ip) ||
		objectEnumerationSnapshots.get(ip)?.kind === "entries" ||
		stackObjectAccesses.has(ip) ||
		stackObjectInheritedAccesses.has(ip) ||
		indexedLengthLoopActionByIp.has(ip) ||
		nativeStringSplitProjectionActionByIp.has(ip) ||
		nativeStringSplitCursorActionByIp.has(ip) ||
		nativeRegExpExecProjectionActionByIp.has(ip) ||
		nativeRegExpIteratorProjectionActionByIp.has(ip) ||
		nativeStringSpanActionByIp.has(ip) ||
		nativeStringCharCodeAtChainActionByIp.has(ip) ||
		nativeBuiltinCollectionCallChainActionByIp.has(ip);
	const nativeFastPaths = lowerNativeFastPaths(
		fn,
		reps,
		jumpTargets,
		staticPropertyProjectionConflicts,
		{ kind: "render", plans: fastPathPlans },
	);
	const propertyNumericUpdateActionByIp = nativeFastPaths.propertyNumericUpdateActions;
	const staticPropertyNumericActionByIp = nativeFastPaths.propertyProjectionActions;
	const propertyReadRegionActionByIp = nativeFastPaths.propertyReadRegionActions;
	const pairedArrayLoopActionByIp = nativeFastPaths.pairedArrayLoopActions;
	const constructorInitializationActionByIp =
		nativeFastPaths.constructorInitializationActions;
	const privateFieldReserve = nativeFastPaths.privateFieldReserve;
	for (const update of nativeFastPaths.propertyNumericUpdates) {
		lines.push(`bool __property_numeric_update_${update.id}_fast = false;`);
		lines.push(
			`f64 __property_numeric_update_${update.id}_old = 0.0, __property_numeric_update_${update.id}_next = 0.0;`,
		);
	}
	if (nativeFastPaths.constructorInitialization !== undefined) {
		const id = nativeFastPaths.constructorInitialization.id;
		lines.push(`bool __constructor_initialization_${id}_fast = false;`);
		lines.push(`MalObject *__constructor_initialization_${id}_object = nullptr;`);
	}
	for (const projection of nativeFastPaths.propertyProjections) {
		lines.push(`bool __property_projection_${projection.id}_fast = false;`);
		for (const [index] of projection.loads.entries())
			lines.push(`f64 __property_projection_${projection.id}_value_${index} = 0.0;`);
		for (const [index] of projection.steps.entries())
			lines.push(`f64 __property_projection_${projection.id}_step_${index} = 0.0;`);
	}
	for (const region of nativeFastPaths.propertyReadRegions) {
		lines.push(`MalNativePropertyReadRegion __property_region_${region.id} = {0};`);
	}
	for (const paired of nativeFastPaths.pairedArrayLoops) {
		lines.push(
			`bool __paired_array_${paired.id}_fast = false;`,
			`MalArrayObject *__paired_array_${paired.id}_secondary = nullptr;`,
		);
	}
	for (const pair of nativeFastPaths.propertyReadPairs) {
		const ip = pair.id;
		lines.push(`bool __property_projection_${ip}_fast = false;`);
		lines.push(
			`MalValue __property_projection_${ip}_first = MAL_VALUE_UNDEFINED;`,
			`MalValue __property_projection_${ip}_second = MAL_VALUE_UNDEFINED;`,
		);
	}
	const switches = new Map(
		fn.profileSiteIds === undefined
			? literalSwitches?.map((site) => [site.instructionIp, site])
			: [],
	);
	const stringComparisonsByIp = new Map(
		stringComparisons.map((plan) => [plan.instructionIp, plan]),
	);
	// Finite dispatch compares one loaded callee against each candidate class's method,
	// through separate guards or a call plan's guarded targets.
	const polymorphicMethodLoads = new Set<number>();
	for (const [ip, instruction] of fn.instructions.entries()) {
		if (instruction.opcode !== "LOAD_PROPERTY_STATIC") continue;
		let guards = 0;
		for (let next = ip + 1; next < Math.min(fn.instructions.length, ip + 24); next++) {
			const candidate = fn.instructions[next]!;
			if (
				candidate.opcode === "GUARD_FUNCTION_INDEX" &&
				candidate.callee === instruction.dst
			)
				guards++;
			if (candidate.opcode === "CALL" && candidate.callee === instruction.dst) {
				const plan = nativeInstructions[next];
				guards += plan?.kind === "call" ? (plan.guardedFunctionIndices?.length ?? 0) : 0;
			}
			if (vmInstructionWriteRegisters(candidate).includes(instruction.dst)) break;
		}
		if (guards >= 2) polymorphicMethodLoads.add(ip);
	}
	// Instruction emission consumes the context synchronously; fallbacks copy it.
	const instructionContext: {
		-readonly [Key in keyof NativeInstructionContext]: NativeInstructionContext[Key];
	} = {
		inactiveRootMaskStatements,
		nativePlan: undefined,
		stringConstants,
		staticDefineStringIndexByIp,
		iterationEligibilityRegisters,
		resources,
		directEntryCalls,
		stringLeafCaches,
		profileSiteId: undefined,
		profile: undefined,
		gcSafepoint: false,
		loopPoll: false,
		callReturnPolls,
		incomingRootPublication: undefined,
		eagerIncomingRootPublication: undefined,
		onIncomingRootPublication: undefined,
		outgoingRootPublication: undefined,
		rootedOutputReloads: undefined,
		loopBackedgeInactiveRootMask: undefined,
		valueGuardInactiveRootMask: undefined,
		guardedPropertyLoadInactiveRootMask: undefined,
		staticPropertyLoadInactiveRootMask: undefined,
		privateAccessInactiveRootMask: undefined,
		indexedPropertyInactiveRootMask: undefined,
		staticPropertyWriteInactiveRootMask: undefined,
		guardedCallRootPublication: undefined,
		guardedCallInactiveRootMask: undefined,
		iteratorStepRootPublication: undefined,
		iteratorStepInactiveRootMask: undefined,
		stackObjectSite: undefined,
		stackObjectAccess: undefined,
		stackObjectMaterialization: undefined,
		stackObjectInheritedAccess: undefined,
		directCompiledTargets,
		directCompiledEntries,
		ownedCaptureFunctionIndex: ownsCaptureEnvironment ? functionIndex : undefined,
		functionIndex,
		directClosures,
		captureShadow,
		fixedCaptureOwners: stableCaptureOwners,
		requiredCaptureOwners,
		copiedCaptures,
		strictCompiledTargets,
		directResultRepresentation,
		directArgumentRepresentations,
		constantBoolean: undefined,
		fieldLoad: undefined,
		fieldAllocation: undefined,
		fieldCall: undefined,
		fieldThrowSlots: undefined,
		recordAllocation: undefined,
		recordObject: undefined,
		recordForward: undefined,
		recordForwarded: undefined,
		recordAccess: undefined,
		recordObservers: undefined,
		recordCall: undefined,
		recordPasses: undefined,
		mathCall: undefined,
		numberPredicate: undefined,
		stringTransform: undefined,
		arrayInitialization: undefined,
		mapEntry: undefined,
		objectEnumerationSnapshot: undefined,
		mappedArguments: fn.mappedArguments,
		mappedArgumentSlots: fn.mappedArgumentSlots,
		hasPrototype: fn.hasPrototype,
		indexedLengthLoopAction: undefined,
		nativeArrayPresenceProjectionAction: undefined,
		pairedArrayLoopAction: undefined,
		nativeStringSplitProjectionAction: undefined,
		nativeStringSplitCursorAction: undefined,
		stringSplitTrimLengthSite: undefined,
		nativeRegExpExecProjectionAction: undefined,
		nativeRegExpIteratorProjectionAction: undefined,
		nativeStringSpanAction: undefined,
		nativeStringCharCodeAtChainAction: undefined,
		nativeBuiltinCollectionCallChainAction: undefined,
		nativeIteratorCursorAction: undefined,
		deferredIteratorCursor: false,
		nativeArrayPairDestructureAction: undefined,
		nativeIteratorResultVirtualizationAction: undefined,
		nativeIteratorEntryPairVirtualizationAction: undefined,
		numericFusionAction: undefined,
		staticPropertyProjectionAction: undefined,
		staticPropertyNumericAction: undefined,
		propertyNumericUpdateAction: undefined,
		propertyNumericUpdateFacts: undefined,
		propertyReadRegionAction: undefined,
		constructorInitializationAction: undefined,
		privateFieldReserveCount: undefined,
		slowPathFramePosition: undefined,
		polymorphicMethodLoad: false,
		stringComparisons: stringComparisonsByIp,
		relocation,
		closureChainTests: nativeClosureChainTests(
			fn,
			nativeInstructions,
			directClosures,
			functionIndex,
			lines,
		),
	};
	for (const plan of fastPathPlans.mapEntries)
		lines.push(`u32 __map_entry_${plan.getIp} = 0;`);
	for (const plan of fastPathPlans.objectEnumerationSnapshots)
		lines.push(
			`bool __enumeration_snapshot_${plan.callIp}_active = false;`,
			`u32 __enumeration_snapshot_${plan.callIp}_value = 0;`,
		);
	let lastPublishedPos = -1;
	let lastPublishedSite = -1;
	let lastPublishedInactiveRootMask: NativeInactiveRootMask | undefined;
	const knownPublishedPrivateRoots = new Map<number, number>();
	let adjacentRootContinuationIp = -1;
	let rootContinuationSnapshots:
		| Map<
				number,
				{
					readonly roots: ReadonlyMap<number, number>;
					readonly mask: NativeInactiveRootMask | undefined;
				}
		  >
		| undefined;
	if (rootPublication !== undefined) {
		for (const [slot, register] of rootPublication.entrySlotRegisters)
			knownPublishedPrivateRoots.set(slot, register);
	}
	const hasPrivateRoots = (rootPublication?.slots.size ?? 0) > 0;
	const activeFieldSlots = new Set<number>();
	if (coro !== null) invocationPreamble.push(...lines.splice(0));
	let measuredLines = 0;
	let measuredCodeUnits = 0;
	const unitStarts: Array<number> = [];
	const unitIps: Array<number> | undefined =
		debug !== false && debug.captureSourceMap ? [] : undefined;
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		// Give up before an over-budget body is complete, let alone joined into one string.
		for (; measuredLines < lines.length; measuredLines++)
			measuredCodeUnits += lines[measuredLines]!.length + 1;
		if (measuredCodeUnits > maxCodeUnits) return null;
		unitStarts.push(lines.length);
		unitIps?.push(ip);
		for (const slot of fieldCallSites.get(ip - 1)?.boxedSlots ?? [])
			if (slot !== undefined) activeFieldSlots.delete(slot);
		for (const slot of fieldAllocations.get(ip - 1)?.boxedSlots ?? [])
			if (slot !== undefined) activeFieldSlots.add(slot);
		if (unreachable.has(ip)) continue;
		if (jumpTargets.has(ip)) {
			lines.push(`L${ip}:;`);
			// Control can arrive with different published frame metadata.
			lastPublishedPos = -1;
			lastPublishedSite = -1;
			const snapshot = rootContinuationSnapshots?.get(ip);
			if (adjacentRootContinuationIp !== ip) {
				lastPublishedInactiveRootMask = snapshot?.mask;
				knownPublishedPrivateRoots.clear();
				if (snapshot !== undefined) {
					for (const [slot, register] of snapshot.roots)
						knownPublishedPrivateRoots.set(slot, register);
					rootContinuationSnapshots!.delete(ip);
				}
			}
		}
		if (elided.has(ip)) continue;
		const literalSwitch = switches.get(ip);
		if (literalSwitch !== undefined) {
			knownPublishedPrivateRoots.clear();
			const selector = literalSwitch.selector;
			const representation = reps[selector]!;
			const selectorFacts = nativeFacts?.[literalSwitch.instructionIp + 1];
			const selectorKind =
				representation === "boxed"
					? (instructionInputKind(selectorFacts, selector) ?? COMPILER_VALUE_KIND_TOP)
					: representation === "string"
						? COMPILER_VALUE_KIND_STRING
						: representation === "boolean"
							? COMPILER_VALUE_KIND_BOOLEAN
							: COMPILER_VALUE_KIND_NUMBER;
			const branch = (target: number, branchIp: number) => {
				const mask = inactiveRootMasks.get(branchIp);
				if (gcSafepointKinds.get(branchIp) !== "loop-backedge") return `goto L${target};`;
				const handler = handlerTargets[branchIp];
				const onThrow =
					handler !== undefined
						? `goto L${handler};`
						: `goto ${nativeBodyReference(resources, "throwExit")};`;
				return `if (mal_gc_poll_requested()) { ${cPrivateRootPublication(
					rootPublication,
					branchIp,
					"outgoing",
				)
					.map((line) => `${line} `)
					.join(
						"",
					)}${mask === undefined ? "" : `${cInactiveRootMaskPublication(mask, inactiveRootMaskStatements)}; `}mal_gc_safepoint(vm); if (mal_gc_poll_termination(vm)) ${onThrow} } goto L${target};`;
			};
			if (literalSwitch.kind === "string") {
				const emitted = emitStringSwitch(
					literalSwitch,
					stringConstants,
					suffix,
					selectorKind,
					relocation,
					branch,
				);
				if (emitted !== undefined) {
					lines.push(...emitted.lines);
					profileDecisions.push({
						instructionIndex: ip,
						operation: "switch",
						code: "native-string-switch",
						outcome: "applied",
						details: {
							strategy: emitted.strategy,
							cases: literalSwitch.cases.length,
						},
					});
					ip = literalSwitch.endIp;
					continue;
				}
			} else {
				const fallback = branch(literalSwitch.defaultIp, literalSwitch.endIp);
				const range = instructionInputIntegerRange(selectorFacts, selector);
				const matchPossible =
					range === undefined ||
					literalSwitch.cases.some(
						(label) => label.value >= range.minimum && label.value <= range.maximum,
					);
				if ((selectorKind & COMPILER_VALUE_KIND_NUMBER) === 0 || !matchPossible)
					lines.push(fallback);
				else {
					if (selectorKind !== COMPILER_VALUE_KIND_NUMBER)
						lines.push(`if (!mal_ops_is_number(r${selector})) { ${fallback} }`);
					const value = `__switch_${ip}`;
					const number =
						representation === "boxed"
							? `mal_ops_number_as_f64(r${selector})`
							: `r${selector}`;
					const int32 = representation === "int32" || compilerIntegerRangeIsInt32(range);
					if (!int32) {
						lines.push(`f64 ${value} = ${number};`);
						lines.push(
							`if (!(${value} >= -2147483648.0 && ${value} <= 2147483647.0 && ${value} == trunc(${value}))) { ${fallback} }`,
						);
					}
					lines.push(
						`switch (${representation === "int32" ? number : `(i32) (${int32 ? number : value})`}) {`,
					);
					const seen = new Set<number>();
					for (const [index, label] of literalSwitch.cases.entries()) {
						if (
							range !== undefined &&
							(label.value < range.minimum || label.value > range.maximum)
						)
							continue;
						if (seen.has(label.value)) continue;
						seen.add(label.value);
						lines.push(
							`case ${label.value}: ${branch(label.targetIp, ip + index * 3 + 2)}`,
						);
					}
					lines.push(`default: ${fallback}`, "}");
				}
				ip = literalSwitch.endIp;
				continue;
			}
		}
		if (expressionIps.has(ip) || rematerializedConstantIps.has(ip)) {
			emittedInstructions.add(ip);
			continue;
		}
		const integerLoop = integerLoopRegionByEntry.get(ip);
		// An iteration region steps the deferred cursor, so it needs that cursor.
		if (
			integerLoop !== undefined &&
			(integerLoop.kind !== "array-iteration" ||
				deferredIteratorCursors.has(integerLoop.initializeIp))
		)
			for (const line of emitNumericLoopRegion(
				fn,
				integerLoop,
				reps,
				nativeBodyReference(resources, "propertyCache"),
				(bindingIp) => {
					const binding = fn.instructions[bindingIp]!;
					if (binding.opcode === "LOAD_GLOBAL")
						return `r${binding.dst} = vm->globals[${relocation.globalIndex(binding.index)}];`;
					if (binding.opcode === "LOAD_CAPTURED")
						return renderCapturedLoad(
							binding,
							bindingIp,
							instructionContext,
							relocation,
						).join(" ");
					throw new Error("Invalid numeric loop binding load");
				},
				nativeFacts,
			))
				lines.push(`    ${line}`);
		const numberRecord = numberRecordRegionById.get(ip);
		if (numberRecord !== undefined)
			for (const line of emitNumberRecordRegion(
				fn,
				numberRecord,
				reps,
				nativeBodyReference(resources, "propertyCache"),
				loopInstructions[ip] === 1 ? shapeSnapshots : undefined,
				nativeFacts,
			))
				lines.push(`    ${line}`);
		const safepointKind = gcSafepointKinds.get(ip);
		const rootedOutputs = !hasPrivateRoots
			? EMPTY_ROOTED_OUTPUTS
			: nativeRootedOutputRegisters(
					fn.instructions[ip]!,
					ip,
					rootPublication!.privateCallResultIps,
				).filter((register) => rootPublication!.slots.has(register));
		const rootedOutputReloads =
			rootedOutputs.length === 0
				? EMPTY_ROOT_PUBLICATION
				: rootedOutputs.map(
						(register) =>
							`__private_r${register} = __gc_slots[${rootPublication!.slots.get(register)!}];`,
					);
		const incomingRootPublication = cPrivateRootPublication(
			rootPublication,
			ip,
			"incoming",
			knownPublishedPrivateRoots,
		);
		const deferrableRoots =
			incomingRootPublication.length <= MAX_DEFERRED_ROOT_PUBLICATION_STORES;
		const deferredPropertyRoots =
			deferrableRoots &&
			(fn.instructions[ip]!.opcode === "LOAD_PROPERTY_STATIC" ||
				fn.instructions[ip]!.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT" ||
				fn.instructions[ip]!.opcode === "LOAD_PROPERTY_STATIC_ARRAY_LENGTH") &&
			!staticPropertyProjectionConflicts(ip);
		const indexedPropertyInstruction = fn.instructions[ip]!;
		// Dense growth can allocate, but its allocator never collects inside the probe.
		const deferredIndexedPropertyRoots =
			deferrableRoots &&
			hasPrivateRoots &&
			(indexedPropertyInstruction.opcode === "LOAD_PROPERTY" ||
				indexedPropertyInstruction.opcode === "STORE_PROPERTY") &&
			(isNumericRep(reps[indexedPropertyInstruction.key]!) ||
				instructionInputKind(nativeFacts?.[ip], indexedPropertyInstruction.key) ===
					COMPILER_VALUE_KIND_NUMBER) &&
			!staticPropertyProjectionConflicts(ip) &&
			!stackObjectMaterializations.has(ip) &&
			!nativeArrayPresenceProjectionActionByIp.has(ip) &&
			!pairedArrayLoopActionByIp.has(ip) &&
			!nativeIteratorCursorActionByIp.has(ip) &&
			!nativeArrayPairDestructureActionByIp.has(ip) &&
			!nativeIteratorResultVirtualizationActionByIp.has(ip) &&
			!nativeIteratorEntryPairVirtualizationActionByIp.has(ip) &&
			!numericFusionActionByIp.has(ip) &&
			!staticPropertyNumericActionByIp.has(ip) &&
			!constructorInitializationActionByIp.has(ip);
		const staticPropertyWriteInstruction = fn.instructions[ip]!;
		const deferredStaticPropertyWriteRoots =
			deferrableRoots &&
			(staticPropertyWriteInstruction.opcode === "STORE_PROPERTY_STATIC" ||
				staticPropertyWriteInstruction.opcode ===
					"STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT" ||
				(hasPrivateRoots &&
					staticPropertyWriteInstruction.opcode === "DEFINE_PROPERTY" &&
					staticPropertyWriteInstruction.enumerable &&
					staticPropertyWriteInstruction.writable &&
					staticPropertyWriteInstruction.configurable &&
					staticDefineStringIndexByIp.has(ip) &&
					!definitionPublicationBarriers.has(ip))) &&
			nativeInstructions[ip] === undefined &&
			!stackObjectAccesses.has(ip) &&
			!stackObjectMaterializations.has(ip) &&
			!constructorInitializationActionByIp.has(ip);
		const deferredOperatorRoots =
			deferrableRoots && fn.instructions[ip]!.opcode === "BINARY";
		const deferredPrivateAccessRoots =
			deferrableRoots &&
			(fn.instructions[ip]!.opcode === "LOAD_PRIVATE" ||
				fn.instructions[ip]!.opcode === "STORE_PRIVATE");
		// Only selected private values need the operator's mask on its fallback edge.
		const eagerOperatorRootPublication =
			deferredOperatorRoots && (rootPublication?.slots.size ?? 0) === 0;
		const deferredValueGuardRoots =
			deferrableRoots && VALUE_GUARD_OPCODES.has(fn.instructions[ip]!.opcode);
		const deferredForInRoots =
			deferrableRoots && fn.instructions[ip]!.opcode === "FOR_IN_HAS";
		const iteratorCursorAction = nativeIteratorCursorActionByIp.get(ip);
		const deferredIteratorRoots =
			deferrableRoots &&
			coro === null &&
			fn.instructions[ip]!.opcode === "ITERATOR_STEP" &&
			nativeInstructions[ip] === undefined &&
			iteratorCursorAction?.role === "step" &&
			(iteratorCursorAction.cursor.protocol === "array-values" ||
				iteratorCursorAction.cursor.protocol === "string") &&
			!nativeArrayPairDestructureActionByIp.has(ip) &&
			!nativeIteratorEntryPairVirtualizationActionByIp.has(ip) &&
			!nativeRegExpIteratorProjectionActionByIp.has(ip);
		const guardedCallInstruction = fn.instructions[ip]!;
		const guardedCallPlan = nativeInstructions[ip];
		const guardedCallEffects =
			guardedCallPlan?.kind === "call" && guardedCallPlan.guardedBuiltinCall !== undefined
				? nativeGuardedBuiltinEffects(guardedCallPlan.guardedBuiltinCall.operation)
				: undefined;
		const deferredGuardedCallRoots =
			deferrableRoots &&
			coro === null &&
			guardedCallInstruction.opcode === "CALL" &&
			guardedCallPlan?.kind === "call" &&
			(mathCalls.has(ip) ||
				(guardedCallEffects !== undefined &&
					!guardedCallEffects.collection &&
					!guardedCallEffects.reentry)) &&
			// Rooted outputs alias shadow storage before dispatch, including reused inputs.
			!rootedOutputs.some((register) =>
				vmInstructionUsesRegister(guardedCallInstruction, register),
			) &&
			guardedCallPlan.numericSortCallback === undefined &&
			guardedCallPlan.directFunctionIndex === undefined &&
			guardedCallPlan.directEntryId === undefined &&
			guardedCallPlan.guardedFunctionIndices === undefined &&
			guardedCallPlan.directFunctionCall === undefined &&
			guardedCallPlan.directCallbackFunctionIndex === undefined &&
			!fieldCallSites.has(ip) &&
			!nativeStringCharCodeAtChainActionByIp.has(ip) &&
			!nativeStringSplitCursorActionByIp.has(ip) &&
			!nativeStringSplitProjectionActionByIp.has(ip) &&
			!nativeRegExpExecProjectionActionByIp.has(ip) &&
			!nativeRegExpIteratorProjectionActionByIp.has(ip) &&
			!nativeStringSpanActionByIp.has(ip) &&
			!nativeBuiltinCollectionCallChainActionByIp.has(ip);
		const effects = nativeInstructionEffects(fn.instructions[ip]!, nativeFacts?.[ip]);
		const publishesIncomingRoots =
			safepointKind !== "loop-backedge" &&
			!deferredPropertyRoots &&
			!deferredPrivateAccessRoots &&
			!deferredIndexedPropertyRoots &&
			!deferredStaticPropertyWriteRoots &&
			!deferredOperatorRoots &&
			!deferredValueGuardRoots &&
			!deferredForInRoots &&
			!deferredIteratorRoots &&
			!deferredGuardedCallRoots &&
			(effects.collection || effects.reentry);
		// Only rendered strings escape this map, so the body can update it in place.
		if (rootPublication !== undefined && hasPrivateRoots) {
			const point = rootPublication.safepoints.get(ip);
			if (publishesIncomingRoots && point !== undefined)
				for (const [slot, register] of point.active)
					if (point.incoming.has(register))
						knownPublishedPrivateRoots.set(slot, register);
			// Refined GC maps identify possible shadow clearing on either edge.
			if (point !== undefined)
				for (const [slot, register] of knownPublishedPrivateRoots)
					if (!point.incoming.has(register) || !point.outgoing.has(register))
						knownPublishedPrivateRoots.delete(slot);
			for (const register of analysis.writeRegistersAt(ip)) {
				const slot = rootPublication.slots.get(register);
				if (slot !== undefined && knownPublishedPrivateRoots.get(slot) === register)
					knownPublishedPrivateRoots.delete(slot);
			}
			// Polls read the shadow alias; the final reload establishes private equality.
			for (const register of rootedOutputs)
				knownPublishedPrivateRoots.set(rootPublication.slots.get(register)!, register);
		}
		const outgoingRootPublication = cPrivateRootPublication(
			rootPublication,
			ip,
			"outgoing",
			knownPublishedPrivateRoots,
		);
		if (publishesIncomingRoots) {
			for (const line of incomingRootPublication) lines.push(`    ${line}`);
		}
		const inactiveRootMask = inactiveRootMasks.get(ip);
		const operatorInactiveRootMask =
			deferredOperatorRoots && inactiveRootMask !== lastPublishedInactiveRootMask
				? inactiveRootMask
				: undefined;
		const indexedPropertyInactiveRootMask =
			deferredIndexedPropertyRoots && inactiveRootMask !== lastPublishedInactiveRootMask
				? inactiveRootMask
				: undefined;
		const staticPropertyWriteInactiveRootMask =
			deferredStaticPropertyWriteRoots &&
			inactiveRootMask !== lastPublishedInactiveRootMask
				? inactiveRootMask
				: undefined;
		const iteratorStepInactiveRootMask =
			deferredIteratorRoots && inactiveRootMask !== lastPublishedInactiveRootMask
				? inactiveRootMask
				: undefined;
		const guardedCallInactiveRootMask =
			(deferredGuardedCallRoots ||
				(safepointKind === "operation" && mathCalls.has(ip))) &&
			inactiveRootMask !== lastPublishedInactiveRootMask
				? inactiveRootMask
				: undefined;
		const loopBackedgeInactiveRootMask =
			safepointKind === "loop-backedge" &&
			inactiveRootMask !== lastPublishedInactiveRootMask
				? inactiveRootMask
				: undefined;
		const valueGuardInactiveRootMask =
			safepointKind === "operation" &&
			VALUE_GUARD_OPCODES.has(fn.instructions[ip]!.opcode) &&
			inactiveRootMask !== lastPublishedInactiveRootMask
				? inactiveRootMask
				: undefined;
		const guardedPropertyLoadInactiveRootMask =
			safepointKind === "operation" &&
			(fn.instructions[ip]!.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT" ||
				fn.instructions[ip]!.opcode === "LOAD_PROPERTY_STATIC_ARRAY_LENGTH") &&
			inactiveRootMask !== lastPublishedInactiveRootMask
				? inactiveRootMask
				: undefined;
		const staticPropertyLoadInactiveRootMask =
			safepointKind === "operation" &&
			fn.instructions[ip]!.opcode === "LOAD_PROPERTY_STATIC" &&
			nativeInstructions[ip] === undefined &&
			stackObjectAccesses.get(ip) === undefined &&
			objectEnumerationSnapshots.get(ip)?.kind !== "entries" &&
			stackObjectInheritedAccesses.get(ip) === undefined &&
			nativeStringSplitProjectionActionByIp.get(ip) === undefined &&
			nativeStringSplitCursorActionByIp.get(ip) === undefined &&
			nativeRegExpExecProjectionActionByIp.get(ip) === undefined &&
			nativeRegExpIteratorProjectionActionByIp.get(ip) === undefined &&
			nativeStringSpanActionByIp.get(ip) === undefined &&
			nativeStringCharCodeAtChainActionByIp.get(ip) === undefined &&
			nativeBuiltinCollectionCallChainActionByIp.get(ip) === undefined &&
			inactiveRootMask !== lastPublishedInactiveRootMask
				? inactiveRootMask
				: undefined;
		const privateAccessInactiveRootMask =
			safepointKind === "operation" &&
			(fn.instructions[ip]!.opcode === "LOAD_PRIVATE" ||
				fn.instructions[ip]!.opcode === "STORE_PRIVATE") &&
			inactiveRootMask !== lastPublishedInactiveRootMask
				? inactiveRootMask
				: undefined;
		if (
			inactiveRootMask !== undefined &&
			loopBackedgeInactiveRootMask === undefined &&
			operatorInactiveRootMask === undefined &&
			valueGuardInactiveRootMask === undefined &&
			guardedPropertyLoadInactiveRootMask === undefined &&
			staticPropertyLoadInactiveRootMask === undefined &&
			privateAccessInactiveRootMask === undefined &&
			indexedPropertyInactiveRootMask === undefined &&
			staticPropertyWriteInactiveRootMask === undefined &&
			iteratorStepInactiveRootMask === undefined &&
			guardedCallInactiveRootMask === undefined &&
			inactiveRootMask !== lastPublishedInactiveRootMask
		) {
			lines.push(
				`    ${cInactiveRootMaskPublication(inactiveRootMask, inactiveRootMaskStatements)};`,
			);
		}
		if (
			inactiveRootMask !== undefined &&
			loopBackedgeInactiveRootMask === undefined &&
			operatorInactiveRootMask === undefined &&
			valueGuardInactiveRootMask === undefined &&
			guardedPropertyLoadInactiveRootMask === undefined &&
			staticPropertyLoadInactiveRootMask === undefined &&
			privateAccessInactiveRootMask === undefined &&
			indexedPropertyInactiveRootMask === undefined &&
			staticPropertyWriteInactiveRootMask === undefined &&
			iteratorStepInactiveRootMask === undefined &&
			guardedCallInactiveRootMask === undefined
		) {
			lastPublishedInactiveRootMask = inactiveRootMask;
		}
		const instructionProfile: NativeInstructionProfile | undefined =
			(fn.profileSiteIds?.[ip] ?? -1) >= 0 ? {} : undefined;
		const arrayPresenceAction = nativeArrayPresenceProjectionActionByIp.get(ip);
		emittedInstructions.add(ip);
		let operatorMaskEmitted = false;
		instructionContext.nativePlan = nativeInstructions[ip];
		instructionContext.facts = nativeFacts?.[ip];
		instructionContext.profileSiteId = fn.profileSiteIds?.[ip];
		instructionContext.profile = instructionProfile;
		instructionContext.gcSafepoint = safepointKind !== undefined;
		instructionContext.loopPoll = safepointKind === "loop-backedge";
		instructionContext.branchTarget = branchTargets.get(ip);
		instructionContext.incomingRootPublication =
			deferredPropertyRoots ||
			deferredPrivateAccessRoots ||
			deferredIndexedPropertyRoots ||
			deferredStaticPropertyWriteRoots ||
			deferredOperatorRoots ||
			deferredValueGuardRoots ||
			deferredForInRoots ||
			deferredIteratorRoots ||
			deferredGuardedCallRoots
				? operatorInactiveRootMask === undefined
					? incomingRootPublication
					: [
							...incomingRootPublication,
							`${cInactiveRootMaskPublication(operatorInactiveRootMask, inactiveRootMaskStatements)};`,
						]
				: EMPTY_ROOT_PUBLICATION;
		instructionContext.eagerIncomingRootPublication = eagerOperatorRootPublication;
		instructionContext.onIncomingRootPublication =
			operatorInactiveRootMask === undefined
				? undefined
				: () => {
						operatorMaskEmitted = true;
					};
		instructionContext.outgoingRootPublication = outgoingRootPublication;
		instructionContext.rootedOutputReloads = rootedOutputReloads;
		instructionContext.loopBackedgeInactiveRootMask = loopBackedgeInactiveRootMask;
		instructionContext.valueGuardInactiveRootMask = valueGuardInactiveRootMask;
		instructionContext.guardedPropertyLoadInactiveRootMask =
			guardedPropertyLoadInactiveRootMask;
		instructionContext.staticPropertyLoadInactiveRootMask =
			staticPropertyLoadInactiveRootMask;
		instructionContext.privateAccessInactiveRootMask = privateAccessInactiveRootMask;
		instructionContext.indexedPropertyInactiveRootMask = indexedPropertyInactiveRootMask;
		instructionContext.staticPropertyWriteInactiveRootMask =
			staticPropertyWriteInactiveRootMask;
		instructionContext.guardedCallRootPublication = deferredGuardedCallRoots;
		instructionContext.guardedCallInactiveRootMask = guardedCallInactiveRootMask;
		instructionContext.iteratorStepRootPublication = deferredIteratorRoots;
		instructionContext.iteratorStepInactiveRootMask = iteratorStepInactiveRootMask;
		instructionContext.stackObjectSite = stackObjectSites.get(ip);
		instructionContext.stackObjectAccess = stackObjectAccesses.get(ip);
		instructionContext.stackObjectMaterialization = stackObjectMaterializations.get(ip);
		instructionContext.stackObjectInheritedAccess = stackObjectInheritedAccesses.get(ip);
		instructionContext.constantBoolean = directConstantBooleans.get(ip);
		instructionContext.fieldLoad = fieldLoads.get(ip);
		instructionContext.recordAllocation = records.allocations.get(ip);
		instructionContext.recordObject = records.objects.get(ip);
		instructionContext.recordForward = records.forwards.get(ip);
		instructionContext.recordAccess = records.accesses.get(ip);
		instructionContext.recordObservers = records.observers.get(ip);
		instructionContext.recordCall = records.calls.get(ip);
		instructionContext.recordPasses = records.passes.get(ip);
		instructionContext.fieldAllocation = fieldAllocations.get(ip);
		instructionContext.fieldCall = fieldCallSites.get(ip);
		instructionContext.fieldThrowSlots =
			activeFieldSlots.size === 0 ? EMPTY_ROOTED_OUTPUTS : [...activeFieldSlots];
		instructionContext.callTransport = callTransportByIp.get(ip);
		instructionContext.callbackTransport = callbackTransportByIp.get(ip);
		instructionContext.mathCall = mathCalls.get(ip);
		const contextInstruction = fn.instructions[ip]!;
		instructionContext.watchedMathCallee =
			contextInstruction.opcode === "LOAD_PROPERTY_STATIC" &&
			mathCalleeRegisters.has(contextInstruction.dst);
		instructionContext.numberPredicate = numberPredicates.get(ip);
		instructionContext.stringTransform = stringTransforms.get(ip);
		instructionContext.arrayInitialization = arrayInitializations.get(ip);
		instructionContext.mapEntry = mapEntries.get(ip);
		instructionContext.objectEnumerationSnapshot = objectEnumerationSnapshots.get(ip);
		instructionContext.indexedLengthLoopAction = indexedLengthLoopActionByIp.get(ip);
		instructionContext.nativeArrayPresenceProjectionAction = arrayPresenceAction;
		instructionContext.pairedArrayLoopAction = pairedArrayLoopActionByIp.get(ip);

		instructionContext.nativeStringSplitProjectionAction =
			nativeStringSplitProjectionActionByIp.get(ip);
		instructionContext.nativeStringSplitCursorAction =
			nativeStringSplitCursorActionByIp.get(ip);
		instructionContext.stringSplitTrimLengthSite = stringSplitTrimLengthSiteByIp.get(ip);
		instructionContext.nativeRegExpExecProjectionAction =
			nativeRegExpExecProjectionActionByIp.get(ip);
		instructionContext.nativeRegExpIteratorProjectionAction =
			nativeRegExpIteratorProjectionActionByIp.get(ip);
		instructionContext.nativeStringSpanAction = nativeStringSpanActionByIp.get(ip);
		instructionContext.nativeStringCharCodeAtChainAction =
			nativeStringCharCodeAtChainActionByIp.get(ip);
		instructionContext.nativeBuiltinCollectionCallChainAction =
			nativeBuiltinCollectionCallChainActionByIp.get(ip);
		instructionContext.nativeIteratorCursorAction =
			nativeIteratorCursorActionByIp.get(ip);
		instructionContext.deferredIteratorCursor = deferredIteratorCursors.has(
			instructionContext.nativeIteratorCursorAction?.cursor.initializeIp ?? -1,
		);
		instructionContext.nativeArrayPairDestructureAction =
			nativeArrayPairDestructureActionByIp.get(ip);
		instructionContext.nativeIteratorResultVirtualizationAction =
			nativeIteratorResultVirtualizationActionByIp.get(ip);
		instructionContext.nativeIteratorEntryPairVirtualizationAction =
			nativeIteratorEntryPairVirtualizationActionByIp.get(ip);
		instructionContext.numericFusionAction = numericFusionActionByIp.get(ip);
		instructionContext.staticPropertyProjectionAction =
			nativeFastPaths.propertyReadPairActions.get(ip);
		instructionContext.staticPropertyNumericAction =
			staticPropertyNumericActionByIp.get(ip);
		instructionContext.propertyNumericUpdateAction =
			propertyNumericUpdateActionByIp.get(ip);
		instructionContext.propertyNumericUpdateFacts =
			instructionContext.propertyNumericUpdateAction === undefined
				? undefined
				: nativeFacts?.[instructionContext.propertyNumericUpdateAction.plan.operationIp];
		instructionContext.propertyReadRegionAction = propertyReadRegionActionByIp.get(ip);
		instructionContext.constructorInitializationAction =
			constructorInitializationActionByIp.get(ip);
		instructionContext.privateFieldReserveCount =
			privateFieldReserve?.id === ip ? privateFieldReserve.count : undefined;
		instructionContext.polymorphicMethodLoad = polymorphicMethodLoads.has(ip);
		const scalarInputDeclarations: Array<string> = [];
		let scalarInputValues: Map<number, string> | undefined;
		const instruction = fn.instructions[ip]!;
		if (instruction.opcode === "CALL_KNOWN") {
			for (const operand of instruction.arguments) {
				const value = decodeVmValueOperand(operand);
				if (
					value.kind !== "register" ||
					!expressionLocals.has(value.register) ||
					scalarInputValues?.has(value.register)
				)
					continue;
				const name = `__known_argument_${ip}_${value.register}`;
				(scalarInputValues ??= new Map()).set(value.register, name);
				scalarInputDeclarations.push(
					`${cTypeOf(reps[value.register]!)} ${name} = r${value.register};`,
				);
			}
		} else if (
			(instruction.opcode === "LOAD_PROPERTY" ||
				instruction.opcode === "STORE_PROPERTY") &&
			expressionLocals.has(instruction.key)
		) {
			const name = `__indexed_key_${ip}`;
			scalarInputValues = new Map([[instruction.key, name]]);
			scalarInputDeclarations.push(
				`${cTypeOf(reps[instruction.key]!)} ${name} = r${instruction.key};`,
			);
		}
		instructionContext.scalarInputValues = scalarInputValues;
		const framePosition =
			debug !== false && nativeInstructionMayCaptureStack(instruction, reps)
				? (fn.positions[ip] ?? -1)
				: -1;
		const framePositionStore =
			debug !== false && framePosition !== -1 && framePosition !== lastPublishedPos
				? `MAL_FRAME_POS(__frame_row, ${nativePositionEntry(debug, functionIndex, framePosition)});`
				: undefined;
		const slowPathFramePosition =
			framePositionStore === undefined
				? undefined
				: { store: framePositionStore, consumed: false, elided: false };
		instructionContext.slowPathFramePosition = slowPathFramePosition;
		const emitted = emitInstruction(
			fn.instructions[ip]!,
			ip,
			suffix,
			reps,
			fn.strict,
			handlerTargets[ip],
			gcUnlink,
			thisSlot,
			coro,
			instructionContext,
		);
		if (emitted === null) {
			return null;
		}
		if (
			eagerOperatorRootPublication &&
			operatorMaskEmitted &&
			operatorInactiveRootMask !== undefined
		) {
			lines.push(
				`    ${cInactiveRootMaskPublication(operatorInactiveRootMask, inactiveRootMaskStatements)};`,
			);
			lastPublishedInactiveRootMask = operatorInactiveRootMask;
		} else if (
			operatorMaskEmitted ||
			valueGuardInactiveRootMask !== undefined ||
			guardedPropertyLoadInactiveRootMask !== undefined ||
			staticPropertyLoadInactiveRootMask !== undefined ||
			privateAccessInactiveRootMask !== undefined ||
			indexedPropertyInactiveRootMask !== undefined ||
			staticPropertyWriteInactiveRootMask !== undefined ||
			iteratorStepInactiveRootMask !== undefined ||
			guardedCallInactiveRootMask !== undefined
		) {
			// Conditional paths can preserve the old mask or publish the instruction's mask.
			lastPublishedInactiveRootMask = undefined;
		}
		if (slowPathFramePosition !== undefined && !slowPathFramePosition.elided) {
			if (slowPathFramePosition.consumed) {
				// Only the slow path published it, so the frame may still hold an older position.
				lastPublishedPos = -1;
			} else {
				lines.push(`    ${slowPathFramePosition.store}`);
				lastPublishedPos = framePosition;
			}
		}
		const profileSiteId = fn.profileSiteIds?.[ip] ?? -1;
		if (
			debug !== false &&
			profileSiteId >= 0 &&
			nativeInstructionMayCaptureStack(fn.instructions[ip]!, reps) &&
			profileSiteId !== lastPublishedSite
		) {
			lines.push(`    MAL_FRAME_SITE(vm, ${profileSiteId});`);
			lastPublishedSite = profileSiteId;
		}
		if (profileSiteId >= 0) {
			lines.push(`    MAL_PROFILE_SITE(vm, ${profileSiteId});`);
			const operationSite = profileOperationInstruction(fn.instructions[ip]!);
			const boxingSite = profileBoxesNativeValue(emitted);
			if (operationSite || boxingSite) {
				profileDecisions.push(
					...profileDecisionsForInstruction(
						fn.instructions[ip]!,
						ip,
						emitted,
						boxingSite,
						instructionProfile?.decision,
					),
				);
			}
		}
		for (const register of rootedOutputs) {
			lines.push(`#undef r${register}`);
			lines.push(
				`#define r${register} (__gc_slots[${rootPublication!.slots.get(register)!}])`,
			);
		}
		for (const line of scalarInputDeclarations) lines.push(`    ${line}`);
		for (const line of emitted) {
			lines.push(`    ${line}`);
		}
		for (const line of rootedOutputReloads) lines.push(`    ${line}`);
		// The array now owns these values; keep an empty span linked until the ordinary exit.
		if (ip === restArgumentRootReleaseIp) lines.push("    __argument_roots.count = 0;");
		for (const register of rootedOutputs) {
			lines.push(`#undef r${register}`);
			lines.push(`#define r${register} (__private_r${register})`);
		}
		if (
			(instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") &&
			rootPublicationContinuations.has(instruction.targetIp)
		) {
			if (instruction.targetIp === ip + 1)
				adjacentRootContinuationIp = instruction.targetIp;
			else if (
				knownPublishedPrivateRoots.size > 0 ||
				lastPublishedInactiveRootMask !== undefined
			) {
				// Skipped lexical blocks can change publication state before the taken target.
				(rootContinuationSnapshots ??= new Map()).set(instruction.targetIp, {
					roots: new Map(knownPublishedPrivateRoots),
					mask: lastPublishedInactiveRootMask,
				});
			}
		}
	}

	const leafCacheDeclarations = [
		...[...stringLeafCaches].map(
			(ip) => `MalStringLeafReadCache __string_leaf_cache_${ip} = {0};`,
		),
		...[...shapeSnapshots].map(
			(icIndex) => `MalShapeSnapshot ${shapeSnapshotName(icIndex)} = {0};`,
		),
	];
	if (coro === null) lines.unshift(...leafCacheDeclarations);
	else invocationPreamble.push(...leafCacheDeclarations);
	const declarationCount = coro === null ? leafCacheDeclarations.length : 0;

	return {
		lines,
		unitStarts: unitStarts.map((start) => start + declarationCount),
		...(unitIps === undefined
			? {}
			: {
					sourceMap: nativeInstructionSourceRanges(
						fn,
						lines,
						unitStarts.map((start) => start + declarationCount),
						unitIps,
						unitIps.map((ip) =>
							[
								...(integerLoopRegionByEntry.get(ip)?.claimedIps ?? []),
								...(numberRecordRegionById.get(ip)?.claimedIps ?? []),
							].map((claimed) => fn.positions[claimed] ?? -1),
						),
					),
				}),
		resources,
		invocationPreamble,
		emittedInstructions,
		directEntryCalls,
	};
}

function profileOperationInstruction(instruction: BytecodeInstruction): boolean {
	return profileDecisionOperation(instruction) !== "execute";
}

function profileDecisionOperation(instruction: BytecodeInstruction): string {
	return profileOperationForInstruction(instruction);
}

/** Classify the exact emitted body, after every native specialization pass. */
function profileDecisionsForInstruction(
	instruction: BytecodeInstruction,
	instructionIndex: number,
	emitted: ReadonlyArray<string>,
	boxingSite: boolean,
	explicitDecision: BackendProfileDecision | undefined,
): Array<BackendProfileDecision> {
	const operation = profileDecisionOperation(instruction);
	const source = emitted.join("\n");
	const decision = (
		code: string,
		outcome: BackendProfileDecision["outcome"],
		reasonCode?: string,
	): BackendProfileDecision => ({
		instructionIndex,
		operation,
		code,
		outcome,
		...(reasonCode === undefined ? {} : { reasonCode }),
		details: {
			opcode: instruction.opcode,
			...(instruction.opcode === "BINARY" || instruction.opcode === "UNARY"
				? { operator: instruction.operator }
				: {}),
		},
	});
	const decisions: Array<BackendProfileDecision> = [];

	if (operation === "call" || operation === "construct") {
		if (explicitDecision !== undefined) {
			decisions.push(explicitDecision);
		} else if (
			/__string_split_|__regexp_exec_|mal_builtin_string_slice_to_number/.test(source)
		) {
			decisions.push(
				decision(`${operation}.projected`, "guarded", "guarded-semantic-fallback"),
			);
		} else if (/mal_builtin_.*_direct\(/.test(source)) {
			decisions.push(
				decision(
					`${operation}.builtin-direct`,
					"retained",
					"runtime-helper-owned-dispatch",
				),
			);
		} else if (source.includes("mal_vm_call_direct(")) {
			decisions.push(
				decision("call.direct-compiled", "guarded", "callee-identity-guard"),
			);
		} else if (source.includes("mal_vm_call_cached(")) {
			decisions.push(
				decision(
					`${operation}.runtime-dispatch`,
					"retained",
					"runtime-target-guard-required",
				),
			);
		} else {
			decisions.push(
				decision(`${operation}.runtime`, "retained", "unsupported-native-call"),
			);
		}
	} else if (operation === "property") {
		if (
			source.includes("mal_vm_object_slot_store(mal_value_to_object(") ||
			source.includes("mal_object_field_load_shaped(mal_value_to_object(")
		) {
			decisions.push(decision("property.exact-own-slot", "applied"));
		} else if (
			source.includes("mal_vm_load_known_own_data(") ||
			source.includes("mal_vm_store_known_own_data(")
		) {
			decisions.push(decision("property.known-own-data", "applied"));
		} else if (source.includes("mal_vm_try_load_known_own_slots(")) {
			decisions.push(
				decision("property.known-own-slot", "guarded", "exact-shape-fallback"),
			);
		} else if (/__stack_object_|__regexp_exec_|__string_split_/.test(source)) {
			decisions.push(
				decision("property.projected", "guarded", "guarded-semantic-fallback"),
			);
		} else if (source.includes("mal_vm_local_watched_")) {
			decisions.push(decision("property.watched", "guarded", "invalidatable-epoch"));
		} else if (/mal_vm_array_fast_(load_index|store_index)\(/.test(source)) {
			decisions.push(
				decision(
					"property.array-inline-cache",
					"guarded",
					"runtime-shape-guard-required",
				),
			);
		} else if (
			/mal_vm_op_(?:load_property_ic(?:_static_miss)?|store_property_ic)\(/.test(source)
		) {
			decisions.push(
				decision(
					instruction.opcode.endsWith("_STATIC")
						? "property.static-inline-cache"
						: "property.dynamic-inline-cache",
					"retained",
					"runtime-shape-guard-required",
				),
			);
		} else {
			decisions.push(decision("property.native", "applied"));
		}
	} else if (operation === "allocation") {
		if (source.includes("__stack_object_")) {
			decisions.push(decision("allocation.stack", "elided"));
		} else {
			decisions.push(decision("allocation.heap", "retained", "heap-identity-retained"));
		}
	} else if (operation === "binary" || operation === "unary") {
		if (source.includes("mal_ops_is_number(")) {
			decisions.push(decision(`${operation}.native`, "guarded", "numeric-type-guard"));
		} else if (/mal_vm_(binary|unary)_op\(/.test(source)) {
			decisions.push(
				decision(`${operation}.runtime`, "retained", "representation-not-proven-native"),
			);
		} else {
			decisions.push(decision(`${operation}.native`, "applied"));
		}
	}

	if (boxingSite) {
		decisions.push({
			instructionIndex,
			operation: "boxing",
			code: "boxing.value-materialization",
			outcome: "retained",
			reasonCode: "boxed-representation-required",
			details: { opcode: instruction.opcode },
		});
	}
	return decisions;
}

function profileBoxesNativeValue(lines: ReadonlyArray<string>): boolean {
	return lines.some(
		(line) =>
			line.includes("mal_ops_number_value(") || line.includes("mal_value_new_boolean("),
	);
}

interface NativeInstructionProfile {
	decision?: BackendProfileDecision;
}

function nativeCallDecision(
	profile: NativeInstructionProfile | undefined,
	instructionIndex: number,
	code: string,
	outcome: BackendProfileDecision["outcome"],
	reasonCode?: string,
): void {
	if (profile === undefined) return;
	profile.decision = {
		instructionIndex,
		operation: "call",
		code,
		outcome,
		...(reasonCode === undefined ? {} : { reasonCode }),
		details: { opcode: "CALL" },
	};
}

type NativeProfileCallKind =
	| "boxing"
	| "regexp"
	| "string"
	| "call"
	| "construct"
	| "property"
	| "allocation"
	| "binary"
	| "unary";

function nativeProfileCall(
	kind: NativeProfileCallKind,
	expression: string,
	siteId: number,
	operation: string,
): string {
	if (siteId < 0) return expression;
	if (kind === "boxing") return `MAL_PROFILE_SITE_BOX(vm, ${siteId}, ${expression})`;
	if (kind === "regexp" || kind === "string") {
		const event =
			kind === "regexp"
				? "MAL_PROFILE_SITE_RUNTIME_REGEXP"
				: "MAL_PROFILE_SITE_RUNTIME_STRING";
		return `MAL_PROFILE_RUNTIME_VALUE(vm, ${siteId}, ${event}, ${expression})`;
	}
	return kind === operation
		? `MAL_PROFILE_FALLBACK_VALUE(vm, ${siteId}, ${expression})`
		: expression;
}

/**
 * Lower a single instruction to C, or null if it isn't handled yet. Reads of a
 * `number` register use the raw double; reads where a boxed value is required
 * box it through mal_ops_number_value. Adding an opcode here (and its unboxed
 * forms) is the main way this backend grows.
 */
interface NativeFieldCall {
	readonly allocationIp: number;
	readonly callIp: number;
	readonly valueRepresentations: ReadonlyArray<VmRegisterRepresentation>;
	readonly allocation: Extract<BytecodeInstruction, { opcode: "CREATE_OBJECT_SHAPED" }>;
	readonly boxedSlots: ReadonlyArray<number | undefined>;
	readonly entries: ReadonlyArray<{
		readonly functionIndex: number;
		readonly entryId: number;
	}>;
}

interface NativeSlowPathFramePosition {
	readonly store: string;
	consumed: boolean;
	/** The instruction's emitted form cannot capture a stack, so it needs no store. */
	elided: boolean;
}

interface NativeInstructionContext {
	readonly scalarInputValues?: ReadonlyMap<number, string>;
	readonly inactiveRootMaskStatements?: ReadonlyMap<NativeInactiveRootMask, string>;
	readonly ownedCaptureFunctionIndex?: number;
	/** The rendered function, which owns the scope its direct closures are created in. */
	readonly functionIndex?: number;
	readonly directClosures?: ReadonlyMap<string, NativeDirectClosureEnvironment>;
	/** The activation's memo of each chain test, by creation ip; equal layouts share one. */
	readonly closureChainTests?: ReadonlyMap<number, string>;
	readonly captureShadow?: NativeCaptureShadow;
	readonly fixedCaptureOwners?: ReadonlySet<number>;
	readonly requiredCaptureOwners?: ReadonlySet<number>;
	readonly copiedCaptures?: ReadonlyMap<string, number>;
	readonly resources: Set<NativeBodyResource>;
	readonly directEntryCalls: Map<number, Set<number>>;
	readonly stringLeafCaches: Set<number>;
	readonly profileSiteId?: number;
	readonly profile?: NativeInstructionProfile;
	readonly nativePlan?: NativeInstructionPlan;
	readonly facts?: InstructionFacts;
	readonly gcSafepoint: boolean;
	readonly loopPoll: boolean;
	readonly branchTarget?: number;
	readonly callReturnPolls: boolean;
	readonly incomingRootPublication?: ReadonlyArray<string>;
	readonly eagerIncomingRootPublication?: boolean;
	readonly onIncomingRootPublication?: () => void;
	readonly outgoingRootPublication?: ReadonlyArray<string>;
	readonly rootedOutputReloads?: ReadonlyArray<string>;
	readonly loopBackedgeInactiveRootMask?: NativeInactiveRootMask;
	readonly valueGuardInactiveRootMask?: NativeInactiveRootMask;
	readonly guardedPropertyLoadInactiveRootMask?: NativeInactiveRootMask;
	readonly staticPropertyLoadInactiveRootMask?: NativeInactiveRootMask;
	readonly privateAccessInactiveRootMask?: NativeInactiveRootMask;
	readonly indexedPropertyInactiveRootMask?: NativeInactiveRootMask;
	readonly staticPropertyWriteInactiveRootMask?: NativeInactiveRootMask;
	readonly guardedCallRootPublication?: boolean;
	readonly guardedCallInactiveRootMask?: NativeInactiveRootMask;
	readonly iteratorStepRootPublication?: boolean;
	readonly iteratorStepInactiveRootMask?: NativeInactiveRootMask;
	readonly stackObjectSite?: StackObjectSite;
	readonly stackObjectAccess?: { site: StackObjectSite; slot: number };
	readonly stackObjectMaterialization?: StackObjectMaterialization;
	readonly stackObjectInheritedAccess?: StackObjectSite;
	readonly strictCompiledTargets: ReadonlySet<number>;
	readonly directCompiledTargets: ReadonlySet<number>;
	readonly directCompiledEntries: DirectCompiledEntries;
	readonly directResultRepresentation?: VmRegisterRepresentation;
	readonly directArgumentRepresentations?: ReadonlyArray<VmRegisterRepresentation>;
	readonly constantBoolean?: boolean;
	readonly fieldLoad?: {
		readonly field: number;
		readonly representation: VmRegisterRepresentation;
	};
	readonly fieldAllocation?: NativeFieldCall;
	readonly fieldCall?: NativeFieldCall;
	readonly fieldEntryCall?: NativeFieldCall;
	readonly fieldThrowSlots?: ReadonlyArray<number>;
	/** An object literal created in caller storage instead of on the heap. */
	readonly recordObject?: NativeRecordSite;
	/** A record entry hands this allocation's fields to its caller instead of creating it. */
	readonly recordAllocation?: {
		readonly fields: ReadonlyArray<number>;
		readonly shape?: number;
		readonly storage: ReadonlyArray<NativeRecordField>;
	};
	/** A record entry returns this call's record; its fields go to the entry's own caller storage. */
	readonly recordForward?: ReadonlyArray<NativeRecordField>;
	/** Forwarded calls that reached the callee's record entry with that storage. */
	readonly recordForwarded?: Set<number>;
	/** A record field read or written in caller storage. */
	readonly recordAccess?: NativeRecordAccess;
	/** Uses of records that need the objects. */
	readonly recordObservers?: ReadonlyArray<NativeRecordObserver>;
	/** The caller storage a record call's entry fills. */
	readonly recordCall?: NativeRecordSite;
	/** Records whose storage this call hands to its entry's record parameters. */
	readonly recordPasses?: ReadonlyArray<NativeRecordPassSite>;
	readonly callTransport?: NativeCallTransportPlan;
	readonly callbackTransport?: NativeCallbackTransportPlan;
	readonly mathCall: NativeMathCallPlan | undefined;
	/** The load reads a callee that a guarded Math call checks, so its row is a watched intrinsic. */
	readonly watchedMathCallee?: boolean;
	/** The loaded value is a callee guarded against several function identities. */
	readonly polymorphicMethodLoad?: boolean;
	readonly stringComparisons?: ReadonlyMap<number, NativeStringComparisonPlan>;
	readonly numberPredicate?: NativeNumberPredicatePlan;
	readonly stringTransform?: NativeStringTransformPlan;
	readonly arrayInitialization?: {
		readonly allocationIp: number;
		readonly mode: "prepared" | "incremental";
		readonly values: ReadonlyArray<number>;
	};
	readonly mapEntry?: { readonly getIp: number; readonly setIp: number };
	readonly objectEnumerationSnapshot?: NativeObjectEnumerationSnapshotSite;
	readonly mappedArguments: boolean;
	readonly mappedArgumentSlots: ReadonlyArray<number>;
	readonly hasPrototype: boolean;
	readonly indexedLengthLoopAction?: IndexedLengthLoopAction;
	readonly nativeArrayPresenceProjectionAction?: NativeArrayPresenceProjectionAction;
	readonly pairedArrayLoopAction?: NativePairedArrayLoopAction;
	readonly nativeStringSplitProjectionAction?: NativeStringSplitProjectionAction;
	readonly nativeStringSplitCursorAction?: NativeStringSplitCursorAction;
	readonly stringSplitTrimLengthSite?: NativeStringSplitCursorSite;
	readonly nativeRegExpExecProjectionAction?: NativeRegExpExecProjectionAction;
	readonly nativeRegExpIteratorProjectionAction?: NativeRegExpIteratorProjectionAction;
	readonly nativeStringSpanAction?: NativeStringSpanAction;
	readonly nativeStringCharCodeAtChainAction?: NativeStringCharCodeAtChainAction;
	readonly nativeBuiltinCollectionCallChainAction?: NativeBuiltinCollectionCallChainAction;
	readonly nativeIteratorCursorAction?: NativeIteratorCursorAction;
	readonly deferredIteratorCursor: boolean;
	readonly nativeArrayPairDestructureAction?: NativeArrayPairDestructureAction;
	readonly nativeIteratorResultVirtualizationAction?: NativeIteratorResultVirtualizationAction;
	readonly nativeIteratorEntryPairVirtualizationAction?: NativeIteratorEntryPairVirtualizationAction;
	readonly numericFusionAction?: NativeNumericFusionAction;
	readonly staticPropertyProjectionAction?: NativePropertyReadPairAction;
	readonly staticPropertyNumericAction?: NativePropertyProjectionAction;
	readonly propertyNumericUpdateAction?: NativePropertyNumericUpdateAction;
	readonly propertyNumericUpdateFacts?: InstructionFacts;
	readonly propertyReadRegionAction?: NativePropertyReadRegionAction;
	readonly constructorInitializationAction?: NativeConstructorInitializationAction;
	readonly privateFieldReserveCount?: number;
	/**
	 * The instruction's pending frame-position store. An emitter whose fast path cannot
	 * throw may move it into its slow path by marking it consumed; otherwise it
	 * precedes the instruction.
	 */
	readonly slowPathFramePosition?: NativeSlowPathFramePosition;
	readonly relocation: NativeRelocationExpressions;
	readonly stringConstants: ReadonlyArray<ReadonlyArray<number>>;
	readonly staticDefineStringIndexByIp: ReadonlyMap<number, number>;
	// Registers loaded from the Array iteration guard; a call through one checks identity first.
	readonly iterationEligibilityRegisters?: ReadonlySet<number>;
}

type NativeTypedArrayElementKind = Extract<
	NativeInstructionPlan,
	{ readonly elementKind: unknown }
>["elementKind"];

function nativeTypedArrayKind(kind: NativeTypedArrayElementKind): string {
	switch (kind) {
		case "Int8Array":
			return "MAL_TA_INT8";
		case "Uint8Array":
			return "MAL_TA_UINT8";
		case "Uint8ClampedArray":
			return "MAL_TA_UINT8_CLAMPED";
		case "Int16Array":
			return "MAL_TA_INT16";
		case "Uint16Array":
			return "MAL_TA_UINT16";
		case "Int32Array":
			return "MAL_TA_INT32";
		case "Uint32Array":
			return "MAL_TA_UINT32";
		case "Float32Array":
			return "MAL_TA_FLOAT32";
		case "Float64Array":
			return "MAL_TA_FLOAT64";
	}
}

function nativeTypedArrayElementSize(kind: NativeTypedArrayElementKind): number {
	switch (kind) {
		case "Int8Array":
		case "Uint8Array":
		case "Uint8ClampedArray":
			return 1;
		case "Int16Array":
		case "Uint16Array":
			return 2;
		case "Int32Array":
		case "Uint32Array":
		case "Float32Array":
			return 4;
		case "Float64Array":
			return 8;
	}
}

// The unlink text restores `__gc_frame.prev` exactly when the activation linked a root frame.
function rootFrameEnvUpdate(gcUnlink: string): string {
	return gcUnlink.includes("__gc_frame.prev") ? " __gc_frame.env = env;" : "";
}

// Separate opcode families keep V8 from rejecting the entire dispatch for size.
class NativeInstructionEmission {
	readonly instruction: BytecodeInstruction;
	readonly ip: number;
	readonly suffix: string;
	readonly reps: Array<RegisterRep>;
	readonly strict: boolean;
	readonly handlerIp: number | undefined;
	readonly gcUnlink: string;
	readonly thisSlot: number;
	readonly coro: CoroutineContext | null;
	readonly context: NativeInstructionContext;
	readonly profileSiteId: number;
	readonly profileOperation: ReturnType<typeof profileDecisionOperation> | undefined;
	pollText: string | undefined = undefined;
	guardedCallPollText: string | undefined = undefined;
	guardedCallFallbackText: ReadonlyArray<string> | undefined = undefined;
	constructor(
		instruction: BytecodeInstruction,
		ip: number,
		suffix: string,
		reps: Array<RegisterRep>,
		strict: boolean,
		handlerIp: number | undefined,
		gcUnlink: string,
		thisSlot: number,
		coro: CoroutineContext | null,
		context: NativeInstructionContext,
		profileSiteId: number,
		profileOperation: ReturnType<typeof profileDecisionOperation> | undefined,
	) {
		this.instruction = instruction;
		this.ip = ip;
		this.suffix = suffix;
		this.reps = reps;
		this.strict = strict;
		this.handlerIp = handlerIp;
		this.gcUnlink = gcUnlink;
		this.thisSlot = thisSlot;
		this.coro = coro;
		this.context = context;
		this.profileSiteId = profileSiteId;
		this.profileOperation = profileOperation;
	}

	profileCall(kind: NativeProfileCallKind, expression: string): string {
		return this.profileOperation === undefined
			? expression
			: nativeProfileCall(kind, expression, this.profileSiteId, this.profileOperation);
	}

	inputValue(r: number): string {
		return this.context.scalarInputValues?.get(r) ?? `r${r}`;
	}

	boxed(r: number): string {
		return this.reps[r] === "int32"
			? `mal_value_from_i32(${this.inputValue(r)})`
			: this.reps[r] === "number"
				? this.profileCall("boxing", `mal_ops_number_value(${this.inputValue(r)})`)
				: this.reps[r] === "boolean"
					? this.profileCall("boxing", `mal_value_new_boolean(${this.inputValue(r)})`)
					: this.inputValue(r);
	}

	num(r: number): string {
		return this.reps[r] === "int32" ? `(f64) ${this.inputValue(r)}` : this.inputValue(r);
	}

	scalarNumber(register: number): string | undefined {
		return isNumericRep(this.reps[register]!) ? this.inputValue(register) : undefined;
	}

	truthy(r: number): string {
		return nativeTruthiness(
			this.inputValue(r),
			this.reps[r]!,
			instructionInputKind(this.context.facts, r) ?? COMPILER_VALUE_KIND_TOP,
			instructionInputIntegerRange(this.context.facts, r),
		);
	}

	reentrantValue(expression: string): string {
		const publication = this.context.incomingRootPublication ?? [];
		if (publication.length > 0) this.context.onIncomingRootPublication?.();
		return publication.length === 0 || this.context.eagerIncomingRootPublication
			? expression
			: `(${publication.map((store) => store.slice(0, -1)).join(", ")}, ${expression})`;
	}

	genericContext(): NativeInstructionContext {
		return {
			scalarInputValues: this.context.scalarInputValues,
			inactiveRootMaskStatements: this.context.inactiveRootMaskStatements,
			stringConstants: this.context.stringConstants,
			stringComparisons: this.context.stringComparisons,
			staticDefineStringIndexByIp: this.context.staticDefineStringIndexByIp,
			iterationEligibilityRegisters: this.context.iterationEligibilityRegisters,
			directEntryCalls: this.context.directEntryCalls,
			stringLeafCaches: this.context.stringLeafCaches,
			profileSiteId: this.context.profileSiteId,
			profile: this.context.profile,
			nativePlan: this.context.nativePlan,
			facts: this.context.facts,
			resources: this.context.resources,
			gcSafepoint: this.context.gcSafepoint,
			loopPoll: this.context.loopPoll,
			branchTarget: this.context.branchTarget,
			callReturnPolls: this.context.callReturnPolls,
			incomingRootPublication: this.context.incomingRootPublication,
			eagerIncomingRootPublication: this.context.eagerIncomingRootPublication,
			onIncomingRootPublication: this.context.onIncomingRootPublication,
			outgoingRootPublication: this.context.outgoingRootPublication,
			rootedOutputReloads: this.context.rootedOutputReloads,
			loopBackedgeInactiveRootMask: this.context.loopBackedgeInactiveRootMask,
			valueGuardInactiveRootMask: this.context.valueGuardInactiveRootMask,
			guardedPropertyLoadInactiveRootMask:
				this.context.guardedPropertyLoadInactiveRootMask,
			staticPropertyLoadInactiveRootMask: this.context.staticPropertyLoadInactiveRootMask,
			privateAccessInactiveRootMask: this.context.privateAccessInactiveRootMask,
			indexedPropertyInactiveRootMask: this.context.indexedPropertyInactiveRootMask,
			staticPropertyWriteInactiveRootMask:
				this.context.staticPropertyWriteInactiveRootMask,
			guardedCallRootPublication: this.context.guardedCallRootPublication,
			guardedCallInactiveRootMask: this.context.guardedCallInactiveRootMask,
			iteratorStepRootPublication: this.context.iteratorStepRootPublication,
			stringSplitTrimLengthSite: this.context.stringSplitTrimLengthSite,
			iteratorStepInactiveRootMask: this.context.iteratorStepInactiveRootMask,
			ownedCaptureFunctionIndex: this.context.ownedCaptureFunctionIndex,
			functionIndex: this.context.functionIndex,
			directClosures: this.context.directClosures,
			captureShadow: this.context.captureShadow,
			fixedCaptureOwners: this.context.fixedCaptureOwners,
			requiredCaptureOwners: this.context.requiredCaptureOwners,
			copiedCaptures: this.context.copiedCaptures,
			strictCompiledTargets: this.context.strictCompiledTargets,
			directCompiledTargets: this.context.directCompiledTargets,
			directCompiledEntries: this.context.directCompiledEntries,
			directResultRepresentation: this.context.directResultRepresentation,
			directArgumentRepresentations: this.context.directArgumentRepresentations,
			constantBoolean: this.context.constantBoolean,
			fieldEntryCall: this.context.fieldEntryCall,
			fieldThrowSlots: this.context.fieldThrowSlots,
			callTransport: this.context.callTransport,
			callbackTransport: this.context.callbackTransport,
			// A call's record ABI holds on whichever path emits the call.
			recordCall: this.context.recordCall,
			recordPasses: this.context.recordPasses,
			recordForward: this.context.recordForward,
			recordForwarded: this.context.recordForwarded,
			mathCall: this.context.mathCall,
			numberPredicate: this.context.numberPredicate,
			stringTransform: this.context.stringTransform,
			mappedArguments: this.context.mappedArguments,
			mappedArgumentSlots: this.context.mappedArgumentSlots,
			hasPrototype: this.context.hasPrototype,
			relocation: this.context.relocation,
			deferredIteratorCursor: false,
		};
	}

	emitGenericInstruction(
		overrides: Partial<NativeInstructionContext> = {},
	): Array<string> | null {
		return emitInstruction(
			this.instruction,
			this.ip,
			this.suffix,
			this.reps,
			this.strict,
			this.handlerIp,
			this.gcUnlink,
			this.thisSlot,
			this.coro,
			{ ...this.genericContext(), ...overrides },
		);
	}

	convert(mode: NativeValueConversion, value: string): string {
		switch (mode) {
			case "identity":
				return value;
			case "box-number":
				return this.profileCall("boxing", `mal_ops_number_value(${value})`);
			case "box-int32":
				return this.profileCall("boxing", `mal_value_from_i32(${value})`);
			case "box-boolean":
				return this.profileCall("boxing", `mal_value_new_boolean(${value})`);
			case "unbox-number":
				return `mal_ops_number_as_f64(${value})`;
			case "unbox-int32":
				return `mal_ops_number_value_to_i32(${value})`;
			case "unbox-boolean":
				return `mal_value_to_boolean(${value})`;
			case "int32-to-number":
				return `(f64) ${value}`;
			case "number-to-int32":
				return `mal_ops_number_to_i32(${value})`;
		}
	}

	convertedValue(source: RegisterRep, target: RegisterRep, value: string): string {
		const mode = nativeValueConversion(source, target);
		if (mode === undefined)
			throw new Error(`Unsupported native value conversion ${source} to ${target}`);
		return this.convert(mode, value);
	}

	stackSlotRep(site: StackObjectSite, slot: number): RegisterRep {
		return site.fieldSlots?.[slot]?.representation ?? "boxed";
	}

	stackLoad(site: StackObjectSite, slot: number, dst: number): string {
		return `r${dst} = ${this.convertedValue(this.stackSlotRep(site, slot), this.reps[dst]!, stackObjectSlotReference(site, slot))};`;
	}

	stackStore(site: StackObjectSite, slot: number, value: number): string {
		return `${stackObjectSlotReference(site, slot)} = ${this.convertedValue(this.reps[value]!, this.stackSlotRep(site, slot), `r${value}`)};`;
	}

	boxedOperand(operand: number): string {
		const decoded = decodeVmValueOperand(operand);
		switch (decoded.kind) {
			case "register":
				return this.boxed(decoded.register);
			case "undefined":
				return "MAL_VALUE_UNDEFINED";
			case "null":
				return "MAL_VALUE_NULL";
			case "boolean":
				return `MAL_VALUE_${decoded.value ? "TRUE" : "FALSE"}`;
			case "number":
				return `mal_value_from_i32(${decoded.value})`;
			case "string":
				return this.context.relocation.stringValue(decoded.index);
		}
	}

	operandRep(operand: number): RegisterRep {
		const decoded = decodeVmValueOperand(operand);
		return decoded.kind === "register"
			? this.reps[decoded.register]!
			: decoded.kind === "number"
				? "int32"
				: decoded.kind === "boolean" || decoded.kind === "string"
					? decoded.kind
					: "boxed";
	}

	recordStoredValue(
		field: NativeRecordField,
		source: RegisterRep,
		value: string,
	): string {
		if (field.representation !== "int32")
			return this.convertedValue(source, field.representation, value);
		if (source === "int32") return value;
		if (source === "number") return `((i32) ${value})`;
		if (source === "boxed") return `((i32) mal_ops_number_as_f64(${value}))`;
		throw new Error(`Unsupported native record integer store from ${source}`);
	}

	callValue(dst: number, value: string, conversion?: NativeValueConversion): string {
		const mode = conversion ?? nativeValueConversion("boxed", this.reps[dst]!);
		if (mode === undefined)
			throw new Error(`Unsupported native call result conversion to ${this.reps[dst]}`);
		if (
			this.reps[dst] === "int32" &&
			compilerIntegerRangeIsInt32(instructionResultIntegerRange(this.context.facts, dst))
		) {
			if (mode === "unbox-int32") return `((i32) mal_ops_number_as_f64(${value}))`;
			if (mode === "number-to-int32") return `((i32) ${value})`;
		}
		return this.convert(mode, value);
	}

	slowPathFramePosition(): Array<string> {
		const position = this.context.slowPathFramePosition;
		if (position === undefined) return [];
		position.consumed = true;
		return [`  ${position.store}`];
	}

	elideFramePosition(): void {
		if (this.context.slowPathFramePosition !== undefined)
			this.context.slowPathFramePosition.elided = true;
	}

	boxedLoad(dst: number, expression: string): Array<string> {
		if (this.reps[dst] === "boxed" || this.reps[dst] === "string")
			return [`r${dst} = ${expression};`, this.throwCheck()];
		const value = `__boxed_load_${this.ip}`;
		return [
			`MalValue ${value} = ${expression};`,
			this.throwCheck(),
			`r${dst} = ${this.callValue(dst, value)};`,
		];
	}

	resultIsInt32(dst: number): boolean {
		return (
			this.reps[dst] === "int32" ||
			compilerIntegerRangeIsInt32(instructionResultIntegerRange(this.context.facts, dst))
		);
	}

	storeNumber(dst: number, expression: string): string {
		return `r${dst} = ${
			this.reps[dst] === "number"
				? expression
				: this.resultIsInt32(dst)
					? this.reps[dst] === "int32"
						? `(i32) (${expression})`
						: this.profileCall("boxing", `mal_value_from_i32((i32) (${expression}))`)
					: this.profileCall("boxing", `mal_ops_number_value(${expression})`)
		};`;
	}

	storeMathNumber(dst: number, operation: string, expression: string): string {
		return builtinResultIsInt32(operation)
			? `r${dst} = ${this.reps[dst] === "number" ? expression : this.reps[dst] === "int32" ? `(i32)(${expression})` : this.profileCall("boxing", `mal_value_from_i32((i32)(${expression}))`)};`
			: this.storeNumber(dst, expression);
	}

	storeBoolean(dst: number, expression: string): string {
		return `r${dst} = ${this.reps[dst] === "boolean" ? expression : this.profileCall("boxing", `mal_value_new_boolean(${expression})`)};`;
	}
	// Exact-receiver collection builtin body. Keys already held as Numbers use the
	// unboxed entries, which canonicalize the f64 directly instead of boxing it first.
	collectionBuiltinCall(
		operation: string,
		receiver: string,
		args: ReadonlyArray<number>,
	):
		| { readonly call: string; readonly boolean: boolean; readonly mayThrow?: true }
		| undefined {
		const numberKey = args[0] === undefined ? null : this.nativeNumberOperand(args[0]);
		const key =
			numberKey ??
			(args[0] === undefined ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(args[0]));
		const value =
			args[1] === undefined ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(args[1]);
		const entry = (boxed: string, number: string): string =>
			`${numberKey === null ? boxed : number}(vm, ${receiver}, ${key}`;
		const mapEntry = this.context.mapEntry;
		if (
			mapEntry !== undefined &&
			(operation === "Map.prototype.get" || operation === "Map.prototype.set")
		) {
			const saved = `__map_entry_${mapEntry.getIp}`;
			const boxedKey = this.boxedOperand(args[0]!);
			return {
				call:
					operation === "Map.prototype.get"
						? `mal_builtin_map_get_entry(vm, ${receiver}, ${boxedKey}, &${saved})`
						: `mal_builtin_map_set_entry(vm, ${receiver}, ${boxedKey}, ${value}, ${saved})`,
				boolean: false,
			};
		}
		switch (operation) {
			case "Map.prototype.get":
				return {
					call: `${entry("mal_builtin_map_get_key", "mal_builtin_map_get_number")})`,
					boolean: false,
				};
			case "Map.prototype.set":
				return {
					call: `${entry("mal_builtin_map_set_key_value", "mal_builtin_map_set_number")}, ${value})`,
					boolean: false,
				};
			case "Map.prototype.has":
				return {
					call: `${entry("mal_builtin_map_has_key", "mal_builtin_map_has_number")})`,
					boolean: true,
				};
			case "Map.prototype.delete":
				return {
					call: `${entry("mal_builtin_map_delete_key", "mal_builtin_map_delete_number")})`,
					boolean: true,
				};
			case "Set.prototype.add":
				return {
					call: `${entry("mal_builtin_set_add_value", "mal_builtin_set_add_number")})`,
					boolean: false,
				};
			case "Set.prototype.has":
				return {
					call: `${entry("mal_builtin_set_has_value", "mal_builtin_set_has_number")})`,
					boolean: true,
				};
			case "Set.prototype.delete":
				return {
					call: `${entry("mal_builtin_set_delete_value", "mal_builtin_set_delete_number")})`,
					boolean: true,
				};
			case "WeakMap.prototype.get":
			case "WeakMap.prototype.has":
			case "WeakMap.prototype.delete":
			case "WeakSet.prototype.has":
			case "WeakSet.prototype.delete": {
				const [brand, , method] = operation.split(".");
				const stem = brand === "WeakMap" ? "weak_map" : "weak_set";
				const boxedKey =
					args[0] === undefined ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(args[0]);
				return {
					call: `mal_builtin_${stem}_${method}_key(${receiver}, ${boxedKey})`,
					boolean: method !== "get",
				};
			}
			case "WeakMap.prototype.set":
			case "WeakSet.prototype.add": {
				const boxedKey =
					args[0] === undefined ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(args[0]);
				if (
					args[0] !== undefined &&
					compilerValueKindCanBeHeldWeakly(
						this.operandKind(args[0]) ?? COMPILER_VALUE_KIND_TOP,
					)
				)
					return {
						call:
							operation === "WeakMap.prototype.set"
								? `mal_builtin_weak_map_set_holdable_key_value(${receiver}, ${boxedKey}, ${value})`
								: `mal_builtin_weak_set_add_holdable_key(${receiver}, ${boxedKey})`,
						boolean: false,
					};
				return {
					call:
						operation === "WeakMap.prototype.set"
							? `mal_builtin_weak_map_set_key_value(vm, ${receiver}, ${boxedKey}, ${value})`
							: `mal_builtin_weak_set_add_key(vm, ${receiver}, ${boxedKey})`,
					boolean: false,
					mayThrow: true,
				};
			}
			default:
				return undefined;
		}
	}

	fixedCollectionCall(
		operation: string,
		dst: number,
		receiver: number,
		args: ReadonlyArray<number>,
	): string | null {
		const body = this.collectionBuiltinCall(operation, this.boxedOperand(receiver), args);
		if (body === undefined) return null;
		const store = body.boolean
			? this.storeBoolean(dst, body.call)
			: `r${dst} = ${body.call};`;
		return body.mayThrow ? `${store}\n${this.throwCheck()}` : store;
	}

	operandKind(operand: number): CompilerValueKindMask | undefined {
		const representation = this.operandRep(operand);
		if (isNumericRep(representation)) return COMPILER_VALUE_KIND_NUMBER;
		if (representation === "boolean") return COMPILER_VALUE_KIND_BOOLEAN;
		if (representation === "string") return COMPILER_VALUE_KIND_STRING;
		const semantic = instructionInputKind(this.context.facts, operand);
		if (semantic !== undefined) return semantic;
		if (this.context.facts?.inputKindMasks !== undefined) {
			if (this.instruction.opcode === "UNARY" && this.instruction.src === operand)
				return this.context.facts.inputKindMasks[0]!;
			if (this.instruction.opcode === "BINARY") {
				if (this.instruction.left === operand)
					return this.context.facts.inputKindMasks[0]!;
				if (this.instruction.right === operand)
					return this.context.facts.inputKindMasks[1]!;
			}
		}
		if (
			this.context.facts?.inputKindMasks === undefined ||
			this.instruction.opcode !== "CALL_KNOWN"
		)
			return undefined;
		if (operand === this.instruction.thisValue)
			return this.context.facts.inputKindMasks[0]!;
		const index = this.instruction.arguments.indexOf(operand);
		return index < 0 ? undefined : this.context.facts.inputKindMasks[index + 1];
	}

	operandIsString(operand: number): boolean {
		return (
			this.operandRep(operand) === "string" ||
			this.operandKind(operand) === COMPILER_VALUE_KIND_STRING
		);
	}

	nativeNumberOperand(operand: number): string | null {
		const decoded = decodeVmValueOperand(operand);
		if (decoded.kind === "register") {
			return isNumericRep(this.reps[decoded.register]!)
				? this.num(decoded.register)
				: this.operandKind(operand) === COMPILER_VALUE_KIND_NUMBER
					? `mal_ops_number_as_f64(${this.boxedOperand(operand)})`
					: null;
		}
		return decoded.kind === "number" ? cF64Literal(decoded.value) : null;
	}

	nativeInt32Operand(operand: number): string | null {
		const decoded = decodeVmValueOperand(operand);
		if (decoded.kind === "register") {
			return this.reps[decoded.register] === "int32"
				? this.inputValue(decoded.register)
				: instructionInputIsInt32(this.context.facts, decoded.register)
					? `((i32) ${this.nativeNumberOperand(operand)!})`
					: this.reps[decoded.register] === "number"
						? `mal_ops_number_to_i32(${this.inputValue(decoded.register)})`
						: this.operandKind(operand) === COMPILER_VALUE_KIND_NUMBER
							? `mal_ops_number_value_to_i32(${this.boxedOperand(operand)})`
							: null;
		}
		return decoded.kind === "number" ? String(decoded.value) : null;
	}

	exactInt32Operand(operand: number): string | undefined {
		return this.operandRep(operand) === "int32" ||
			instructionInputIsInt32(this.context.facts, operand)
			? (this.nativeInt32Operand(operand) ?? undefined)
			: undefined;
	}

	nativeBooleanOperand(operand: number): string | null {
		const decoded = decodeVmValueOperand(operand);
		if (decoded.kind === "register") {
			return this.reps[decoded.register] === "boolean"
				? this.inputValue(decoded.register)
				: this.operandKind(operand) === COMPILER_VALUE_KIND_BOOLEAN
					? `mal_value_to_boolean(${this.boxedOperand(operand)})`
					: null;
		}
		return decoded.kind === "boolean" ? (decoded.value ? "true" : "false") : null;
	}

	nativeStringOperand(operand: number, provenString = false): string | null {
		const decoded = decodeVmValueOperand(operand);
		return provenString || decoded.kind === "string" || this.operandIsString(operand)
			? `mal_value_to_string(${this.boxedOperand(operand)})`
			: null;
	}

	operandTruthy(operand: number): string {
		const decoded = decodeVmValueOperand(operand);
		switch (decoded.kind) {
			case "undefined":
			case "null":
				return "false";
			case "boolean":
				return String(decoded.value);
			case "number":
				return String(decoded.value !== 0);
			case "string": {
				const text = this.context.stringConstants[decoded.index];
				return text === undefined
					? nativeTruthiness(
							this.boxedOperand(operand),
							"string",
							COMPILER_VALUE_KIND_STRING,
						)
					: String(text.length !== 0);
			}
			case "register":
				return nativeTruthiness(
					this.inputValue(decoded.register),
					this.reps[decoded.register]!,
					this.operandKind(operand) ?? COMPILER_VALUE_KIND_TOP,
					instructionInputIntegerRange(this.context.facts, decoded.register),
				);
		}
	}

	coerciveNumberOperand(operand: number): string | null {
		const boolean = this.nativeBooleanOperand(operand);
		return boolean === null
			? this.nativeNumberOperand(operand)
			: `(${boolean} ? 1.0 : 0.0)`;
	}
	// Typed numeric contracts survive boxed coroutine and entry storage.
	typedNumber(r: number): string {
		return this.reps[r] === "number" || this.reps[r] === "int32"
			? this.num(r)
			: `mal_ops_number_as_f64(${this.boxed(r)})`;
	}

	exactPrimitiveNumber(r: number, mask: CompilerValueKindMask): string {
		const number = isNumericRep(this.reps[r]!)
			? this.num(r)
			: `mal_ops_number_as_f64(${this.boxed(r)})`;
		const boolean =
			this.reps[r] === "boolean" ? `r${r}` : `mal_value_to_boolean(${this.boxed(r)})`;
		return nativePrimitiveNumberExpression(this.boxed(r), mask, number, boolean);
	}

	suspendSnapshot(): Array<string> {
		if (this.coro === null) throw new Error("Suspension outside a native coroutine");
		const point = this.coro.suspension.points.find(
			(point) => point.instructionIp === this.ip,
		);
		if (point === undefined) throw new Error("Native suspension lacks a spill plan");
		return [
			`mal_coroutine_clear_snapshot(__suspend_slots, ${this.coro.suspension.slotCount});`,
			...point.registers.map(
				(register, slot) => `__suspend_slots[${slot}] = ${this.boxed(register)};`,
			),
		];
	}

	// Handler jumps keep the frame live; uncaught throws share its unlink epilogue.
	onThrow(): string {
		const jump =
			this.handlerIp !== undefined
				? `goto L${this.handlerIp};`
				: `goto ${nativeBodyReference(this.context.resources, "throwExit")};`;
		const cleanup = [
			...(this.context.rootedOutputReloads ?? []),
			...(this.context.fieldThrowSlots ?? []).map(
				(slot) => `__gc_slots[${slot}] = MAL_VALUE_UNDEFINED;`,
			),
		];
		return cleanup.length === 0 ? jump : `{ ${cleanup.join(" ")} ${jump} }`;
	}

	throwCheck(): string {
		return `if (MAL_THREW()) ${this.onThrow()}`;
	}
	// A poll without corresponding exact-root metadata can expose dead slots or clear
	// a just-produced result under the preceding instruction's mask.
	// Isolate termination is sticky and re-arms mal_gc_poll, so it surfaces only at a
	// poll; raising it there unwinds through the ordinary throw path.
	safepoint(): string {
		return `mal_gc_safepoint(vm); if (mal_gc_poll_termination(vm)) ${this.onThrow()}`;
	}

	poll(): string {
		return (this.pollText ??=
			(this.context.outgoingRootPublication?.length ?? 0) > 0
				? `if (mal_gc_poll_requested()) { ${this.context.outgoingRootPublication!.join(" ")} ${this.context.loopBackedgeInactiveRootMask === undefined ? "" : `${cInactiveRootMaskPublication(this.context.loopBackedgeInactiveRootMask, this.context.inactiveRootMaskStatements)}; `}${this.safepoint()} }`
				: this.context.loopBackedgeInactiveRootMask === undefined
					? this.context.gcSafepoint
						? `if (mal_gc_poll_requested()) { ${this.safepoint()} }`
						: ""
					: `if (mal_gc_poll_requested()) { ${cInactiveRootMaskPublication(this.context.loopBackedgeInactiveRootMask, this.context.inactiveRootMaskStatements)}; ${this.safepoint()} }`);
	}

	guardedCallPoll(): string {
		return (this.guardedCallPollText ??=
			this.context.guardedCallInactiveRootMask === undefined
				? this.poll()
				: `if (mal_gc_poll_requested()) { ${(this.context.outgoingRootPublication ?? []).map((line) => `${line} `).join("")}${cInactiveRootMaskPublication(this.context.guardedCallInactiveRootMask, this.context.inactiveRootMaskStatements)}; ${this.safepoint()} }`);
	}

	callPoll(): string {
		return this.context.callReturnPolls ? this.guardedCallPoll() : "";
	}

	guardedCallFallbackRootPublication(): ReadonlyArray<string> {
		return (this.guardedCallFallbackText ??= [
			...(this.context.guardedCallRootPublication
				? (this.context.incomingRootPublication ?? []).map((line) => `  ${line}`)
				: []),
			...(this.context.guardedCallInactiveRootMask === undefined
				? []
				: [
						`  ${cInactiveRootMaskPublication(this.context.guardedCallInactiveRootMask, this.context.inactiveRootMaskStatements)};`,
					]),
		]);
	}

	get classLayoutsEnabled() {
		// Layout ordinals belong to the root image; overlays do not carry layouts.
		return !this.context.relocation.relative;
	}
	emitPropertyLoad(
		instruction: Extract<
			BytecodeInstruction,
			{ opcode: "LOAD_PROPERTY" | "LOAD_PROPERTY_STATIC" }
		>,
	): Array<string> | null {
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			this.context.staticPropertyNumericAction?.role === "load"
		) {
			const fallback = this.emitGenericInstruction();
			if (fallback === null) return null;
			const { plan, index } = this.context.staticPropertyNumericAction;
			if (index !== 0) {
				return [
					`if (!__property_projection_${plan.id}_fast) {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			const helper =
				plan.loads.length === 2
					? "mal_vm_property_try_load_static_number_pair"
					: plan.loads.length === 3
						? "mal_vm_property_try_load_static_number_triple"
						: "mal_vm_property_try_load_static_number_quad";
			const cacheArguments = plan.loads.map(
				(load) =>
					`&${nativeBodyReference(this.context.resources, "propertyCache")}[${load.icIndex}]`,
			);
			const valueArguments = plan.loads.map(
				(_load, valueIndex) => `&__property_projection_${plan.id}_value_${valueIndex}`,
			);
			const boxedGuards = plan.boxedRegisters.map(
				(register) => `mal_ops_is_number(r${register})`,
			);
			return [
				`__property_projection_${plan.id}_fast = ${boxedGuards.length === 0 ? "" : `${boxedGuards.join(" && ")} && `}${helper}(${this.boxed(instruction.object)}, ${[...cacheArguments, ...valueArguments].join(", ")});`,
				`if (!__property_projection_${plan.id}_fast) {`,
				...fallback.map((line) => `  ${line}`),
				`}`,
			];
		}
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			this.context.propertyReadRegionAction !== undefined
		) {
			const fallback = this.emitGenericInstruction();
			if (fallback === null) return null;
			const { plan, index } = this.context.propertyReadRegionAction;
			const region = `__property_region_${plan.id}`;
			const value = `__property_region_value_${this.ip}`;
			return [
				...(index === 0
					? [
							`${region} = mal_vm_property_read_region_begin(${this.boxed(instruction.object)});`,
						]
					: []),
				`MalValue ${value};`,
				`if (mal_vm_property_read_region_try_load(&${region}, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}], &${value})) {`,
				`  r${instruction.dst} = ${this.callValue(instruction.dst, value)};`,
				`} else {`,
				...fallback.map((line) => `  ${line}`),
				`}`,
			];
		}
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			this.context.staticPropertyProjectionAction !== undefined
		) {
			const fallback = this.emitGenericInstruction();
			if (fallback === null) return null;
			const { plan, role } = this.context.staticPropertyProjectionAction;
			const id = plan.id;
			const value = `__property_projection_${id}_${role}`;
			if (role === "second") {
				return [
					`if (__property_projection_${id}_fast) {`,
					`  r${instruction.dst} = ${this.callValue(instruction.dst, value)};`,
					`} else {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			return [
				`__property_projection_${id}_fast = mal_vm_property_try_load_static_pair(${this.boxed(instruction.object)}, &${nativeBodyReference(this.context.resources, "propertyCache")}[${plan.loads[0]!.icIndex}], &${nativeBodyReference(this.context.resources, "propertyCache")}[${plan.loads[1]!.icIndex}], &__property_projection_${id}_first, &__property_projection_${id}_second);`,
				`if (__property_projection_${id}_fast) {`,
				`  r${instruction.dst} = ${this.callValue(instruction.dst, value)};`,
				`} else {`,
				...fallback.map((line) => `  ${line}`),
				`}`,
			];
		}
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			this.context.nativeBuiltinCollectionCallChainAction?.role === "property"
		) {
			const fallback = this.emitGenericInstruction();
			if (fallback === null) return null;
			return [
				`if (!mal_vm_try_capture_collection_method(vm, ${nativeBuiltinCollectionOperation(this.context.nativeBuiltinCollectionCallChainAction.chain.operation)}, ${this.boxed(instruction.object)}, &r${instruction.dst})) {`,
				...fallback.map((line) => `  ${line}`),
				`}`,
			];
		}
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			this.context.nativeStringCharCodeAtChainAction?.role === "property"
		) {
			const { chain } = this.context.nativeStringCharCodeAtChainAction;
			const captured = `__string_char_code_at_${chain.callIp}_captured`;
			const receiver = this.boxed(instruction.object);
			const primitive =
				this.reps[instruction.object] === "string"
					? "true"
					: `mal_value_is_string(${receiver})`;
			const capture =
				chain.methodIdentity === "authority-invariant"
					? primitive
					: `${primitive} && mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}], &r${instruction.dst})`;
			return [
				`${captured} = ${capture};`,
				`if (${captured}) {`,
				...(chain.methodIdentity === "authority-invariant"
					? [`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`]
					: []),
				`} else {`,
				`  r${instruction.dst} = ${this.profileCall("property", `mal_vm_op_load_property_ic(vm, ${receiver}, mal_value_from_string(vm->string_constant_atoms[${this.context.relocation.stringIndex(instruction.stringIndex)}]), &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}])`)};`,
				`  ${this.throwCheck()}`,
				`}`,
			];
		}
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			(this.context.nativeStringSplitProjectionAction?.role === "property" ||
				this.context.nativeStringSplitCursorAction?.role === "property" ||
				this.context.nativeRegExpExecProjectionAction?.role === "property")
		) {
			return [];
		}
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			this.context.nativeRegExpExecProjectionAction?.role === "caseUpperProperty"
		) {
			const { site, load } = this.context.nativeRegExpExecProjectionAction;
			const slot = site.loads.findIndex((entry) => entry.ip === load?.ip);
			if (slot >= 0 && load?.consumer?.kind === "asciiCaseLength") {
				const fast = `__regexp_exec_${site.projection.callIp}_case_${load.consumer.upperCallIp}_fast`;
				const length = `__regexp_exec_${site.projection.callIp}_case_${load.consumer.upperCallIp}_length`;
				const start = `__regexp_exec_${site.projection.callIp}_starts[${slot}]`;
				const end = `__regexp_exec_${site.projection.callIp}_ends[${slot}]`;
				const authorityInvariant = load.consumer.methodIdentity === "authority-invariant";
				const lower = `__regexp_exec_${site.projection.callIp}_case_lower_${load.consumer.upperCallIp}`;
				const summary = authorityInvariant
					? this.profileCall(
							"string",
							`mal_builtin_string_ascii_case_chain_length_span_locked(vm, __gc_slots[${site.subjectSlot}], ${start}, ${end}, &${length})`,
						)
					: `mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}], &r${instruction.dst}) && mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &${nativeBodyReference(this.context.resources, "propertyCache")}[${load.consumer.lowerIcIndex}], &${lower}) && ${this.profileCall("string", `mal_builtin_string_ascii_case_chain_length_span(vm, r${instruction.dst}, ${lower}, __gc_slots[${site.subjectSlot}], ${start}, ${end}, &${length})`)}`;
				return [
					...(authorityInvariant ? [] : [`MalValue ${lower};`]),
					`${fast} = __regexp_exec_${site.projection.callIp}_projected && ${start} >= 0 && ${summary};`,
					`if (!${fast}) {`,
					`  if (__regexp_exec_${site.projection.callIp}_projected && ${start} >= 0) {`,
					`    __gc_slots[${site.slotsOffset + slot}] = ${this.profileCall("regexp", `mal_regexp_materialize_capture_span(vm, __gc_slots[${site.subjectSlot}], ${start}, ${end})`)};`,
					`    r${instruction.object} = __gc_slots[${site.slotsOffset + slot}];`,
					`  }`,
					`  r${instruction.dst} = ${this.profileCall("property", `mal_vm_op_load_property_ic(vm, ${this.boxedOperand(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${this.context.relocation.stringIndex(instruction.stringIndex)}]), &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}])`)};`,
					`  ${this.throwCheck()}`,
					`}`,
				];
			}
		}
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			this.context.nativeRegExpExecProjectionAction?.role === "caseLowerProperty"
		) {
			const { site, load } = this.context.nativeRegExpExecProjectionAction;
			if (load?.consumer?.kind === "asciiCaseLength") {
				const fast = `__regexp_exec_${site.projection.callIp}_case_${load.consumer.upperCallIp}_fast`;
				return [
					`if (${fast}) {`,
					`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
					`} else {`,
					`  r${instruction.dst} = ${this.profileCall("property", `mal_vm_op_load_property_ic(vm, ${this.boxedOperand(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${this.context.relocation.stringIndex(instruction.stringIndex)}]), &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}])`)};`,
					`  ${this.throwCheck()}`,
					`}`,
				];
			}
		}
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			this.context.nativeRegExpExecProjectionAction?.role === "caseLength"
		) {
			const { site, load } = this.context.nativeRegExpExecProjectionAction;
			if (load?.consumer?.kind === "asciiCaseLength") {
				const fast = `__regexp_exec_${site.projection.callIp}_case_${load.consumer.upperCallIp}_fast`;
				const length = `__regexp_exec_${site.projection.callIp}_case_${load.consumer.upperCallIp}_length`;
				const direct =
					this.reps[instruction.dst] === "number"
						? `(f64) ${length}`
						: `mal_value_from_i32((i32) ${length})`;
				return [
					`if (${fast}) {`,
					`  r${instruction.dst} = ${direct};`,
					`} else {`,
					`  r${instruction.dst} = ${this.profileCall("property", `mal_vm_op_load_property_ic(vm, ${this.boxedOperand(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${this.context.relocation.stringIndex(instruction.stringIndex)}]), &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}])`)};`,
					`  ${this.throwCheck()}`,
					`}`,
				];
			}
		}
		if (
			instruction.opcode === "LOAD_PROPERTY" &&
			this.context.nativeRegExpIteratorProjectionAction?.role === "capture"
		) {
			const { site, load } = this.context.nativeRegExpIteratorProjectionAction;
			const slot = site.loads.findIndex((entry) => entry.ip === load?.ip);
			if (slot >= 0) {
				return [
					`if (__regexp_iter_${site.projection.stepIp}_projected) {`,
					`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
					`} else {`,
					`  r${instruction.dst} = ${this.profileCall("property", `mal_vm_op_load_property_ic(vm, ${this.boxedOperand(instruction.object)}, ${this.boxedOperand(instruction.key)}, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}])`)};`,
					`  ${this.throwCheck()}`,
					`}`,
				];
			}
		}
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			this.context.nativeRegExpExecProjectionAction?.role === "length"
		) {
			const { site, load } = this.context.nativeRegExpExecProjectionAction;
			const slot = site.loads.findIndex((entry) => entry.ip === load?.ip);
			if (slot >= 0) {
				const start = `__regexp_exec_${site.projection.callIp}_starts[${slot}]`;
				const end = `__regexp_exec_${site.projection.callIp}_ends[${slot}]`;
				const direct =
					this.reps[instruction.dst] === "number"
						? `(f64) (${end} - ${start})`
						: `mal_value_from_i32(${end} - ${start})`;
				return [
					`if (__regexp_exec_${site.projection.callIp}_projected && ${start} >= 0) {`,
					`  r${instruction.dst} = ${direct};`,
					`} else {`,
					`  r${instruction.dst} = ${this.profileCall("property", `mal_vm_op_load_property_ic(vm, ${this.boxedOperand(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${this.context.relocation.stringIndex(instruction.stringIndex)}]), &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}])`)};`,
					`  ${this.throwCheck()}`,
					`}`,
				];
			}
		}
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			this.context.nativeRegExpExecProjectionAction?.role === "charCodeAtProperty"
		) {
			const { site, load } = this.context.nativeRegExpExecProjectionAction;
			const slot = site.loads.findIndex((entry) => entry.ip === load?.ip);
			if (slot >= 0 && load?.consumer?.kind === "charCodeAtZero") {
				const fast = `__regexp_exec_${site.projection.callIp}_char_${load.consumer.callIp}_fast`;
				const start = `__regexp_exec_${site.projection.callIp}_starts[${slot}]`;
				const identityCheck =
					load.consumer.methodIdentity === "authority-invariant"
						? ""
						: ` && mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}], &r${instruction.dst})`;
				return [
					`${fast} = false;`,
					`if (__regexp_exec_${site.projection.callIp}_projected && ${start} >= 0${identityCheck}) {`,
					`  ${fast} = true;`,
					`} else {`,
					`  if (__regexp_exec_${site.projection.callIp}_projected && ${start} >= 0) {`,
					`    __gc_slots[${site.slotsOffset + slot}] = ${this.profileCall("regexp", `mal_regexp_materialize_capture_span(vm, __gc_slots[${site.subjectSlot}], ${start}, __regexp_exec_${site.projection.callIp}_ends[${slot}])`)};`,
					`    r${instruction.object} = __gc_slots[${site.slotsOffset + slot}];`,
					`  }`,
					`  r${instruction.dst} = ${this.profileCall("property", `mal_vm_op_load_property_ic(vm, ${this.boxedOperand(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${this.context.relocation.stringIndex(instruction.stringIndex)}]), &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}])`)};`,
					`  ${this.throwCheck()}`,
					`}`,
				];
			}
		}
		if (
			instruction.opcode === "LOAD_PROPERTY" &&
			this.context.nativeRegExpExecProjectionAction?.role === "capture"
		) {
			const { site, load } = this.context.nativeRegExpExecProjectionAction;
			const slot = site.loads.findIndex((entry) => entry.ip === load?.ip);
			if (slot >= 0) {
				return [
					`if (__regexp_exec_${site.projection.callIp}_projected) {`,
					`  r${instruction.dst} = __gc_slots[${site.slotsOffset + slot}];`,
					`} else {`,
					`  r${instruction.dst} = ${this.profileCall("property", `mal_vm_op_load_property_ic(vm, ${this.boxedOperand(instruction.object)}, ${this.boxedOperand(instruction.key)}, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}])`)};`,
					`  ${this.throwCheck()}`,
					`}`,
				];
			}
		}
		if (this.context.stackObjectInheritedAccess !== undefined) {
			const fallback = this.emitGenericInstruction();
			if (fallback === null) return null;
			return [
				`if (${this.context.stackObjectInheritedAccess.inheritedFastName}) {`,
				`  r${instruction.dst} = ${this.callValue(instruction.dst, this.context.stackObjectInheritedAccess.inheritedValueName!)};`,
				`  mal_perf_ic_load_inherited_hit();`,
				`  mal_perf_stack_object_inherited_direct_load();`,
				`} else {`,
				...fallback.map((line) => `  ${line}`),
				`}`,
			];
		}
		if (this.context.stackObjectAccess !== undefined) {
			const { site, slot } = this.context.stackObjectAccess;
			if (site.inheritedLoadInstructionIndex === undefined) {
				return [this.stackLoad(site, slot, instruction.dst)];
			}
			const fallback = this.emitGenericInstruction();
			if (fallback === null) return null;
			return [
				`if (${site.inheritedFastName}) {`,
				`  ${this.stackLoad(site, slot, instruction.dst)}`,
				`} else {`,
				...fallback.map((line) => `  ${line}`),
				`}`,
			];
		}
		// Cache hits cannot collect; misses publish roots before calling user code.
		const receiverName = `__property_receiver_${this.ip}`;
		// An exact Array receiver needs no class test and is never a TypedArray.
		const exactArray = this.context.nativePlan?.kind === "exact-array-element";
		const arrayReceiver = exactArray
			? `mal_value_to_array_object(${this.boxed(instruction.object)})`
			: `mal_vm_as_array(${this.boxed(instruction.object)})`;
		const arrayPresent = exactArray ? "" : `${receiverName} && `;
		if (instruction.opcode === "LOAD_PROPERTY") {
			const numericKey = this.nativeNumberOperand(instruction.key);
			const int32Key =
				numericKey !== null &&
				(this.reps[instruction.key] === "int32" ||
					instructionInputIsInt32(this.context.facts, instruction.key))
					? this.nativeInt32Operand(instruction.key)
					: null;
			const indexBound =
				(instructionInputIntegerRange(this.context.facts, instruction.key)?.minimum ??
					-1) >= 0
					? ""
					: `${int32Key} >= 0 && `;
			const fallback = (position: ReadonlyArray<string>): Array<string> => [
				...position,
				...(this.context.incomingRootPublication ?? []).map((line) => `  ${line}`),
				...(this.context.indexedPropertyInactiveRootMask === undefined
					? []
					: [
							`  ${cInactiveRootMaskPublication(this.context.indexedPropertyInactiveRootMask, this.context.inactiveRootMaskStatements)};`,
						]),
				...this.boxedLoad(
					instruction.dst,
					numericKey !== null
						? this.profileCall(
								"property",
								`mal_vm_indexed_fast_load_index(vm, ${this.boxed(instruction.object)}, ${numericKey}, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}])`,
							)
						: `mal_vm_indexed_fast_load(vm, ${this.boxed(instruction.object)}, ${this.boxed(instruction.key)}, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}])`,
				).map((line) => `  ${line}`),
			];
			const ordinary = (position: ReadonlyArray<string> = []): Array<string> => {
				if (
					((this.operandKind(instruction.object) ?? COMPILER_VALUE_KIND_TOP) &
						COMPILER_VALUE_KIND_OBJECT) ===
						0 ||
					((this.operandKind(instruction.key) ?? COMPILER_VALUE_KIND_TOP) &
						COMPILER_VALUE_KIND_NUMBER) ===
						0
				)
					return fallback(position);
				return [
					`MalArrayObject *${receiverName} = ${arrayReceiver};`,
					`MalValue __v_${this.ip};`,
					int32Key !== null
						? `if (${arrayPresent}${indexBound}mal_vm_array_try_get_proven_index(${receiverName}, (u32) ${int32Key}, &__v_${this.ip})) {`
						: numericKey !== null
							? `if (${arrayPresent}mal_vm_array_try_get_index(${receiverName}, ${numericKey}, &__v_${this.ip})) {`
							: `if (${arrayPresent}mal_vm_array_try_get_value_index(${receiverName}, ${this.boxed(instruction.key)}, &__v_${this.ip})) {`,
					`  r${instruction.dst} = ${this.callValue(instruction.dst, `__v_${this.ip}`)};`,
					...(numericKey === null || exactArray
						? []
						: [
								`} else if (${receiverName} == nullptr && mal_vm_typed_array_try_get_index(${this.boxed(instruction.object)}, ${numericKey}, &__v_${this.ip})) {`,
								`  r${instruction.dst} = ${this.callValue(instruction.dst, `__v_${this.ip}`)};`,
							]),
					`} else {`,
					...fallback(position),
					`}`,
				];
			};
			if (this.context.nativeArrayPresenceProjectionAction?.role === "load") {
				const membershipIp =
					this.context.nativeArrayPresenceProjectionAction.membershipIp;
				const state = `__array_presence_${membershipIp}_state`;
				const fallback = this.emitGenericInstruction();
				if (fallback === null) return null;
				return [
					`if (${state} == 1) {`,
					`  r${instruction.dst} = ${this.callValue(instruction.dst, `__array_presence_${membershipIp}_value`)};`,
					`} else {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (this.context.pairedArrayLoopAction?.role === "load") {
				const { plan } = this.context.pairedArrayLoopAction;
				return [
					`MalValue __paired_element_${this.ip};`,
					`if (__paired_array_${plan.id}_fast && __paired_array_${plan.id}_secondary == mal_vm_as_array(${this.boxed(instruction.object)}) && mal_vm_array_try_get_proven_index(__paired_array_${plan.id}_secondary, (u32) ${this.typedNumber(instruction.key)}, &__paired_element_${this.ip})) {`,
					`  r${instruction.dst} = ${this.callValue(instruction.dst, `__paired_element_${this.ip}`)};`,
					`} else {`,
					...ordinary().map((line) => `  ${line}`),
					`}`,
				];
			}
			if (
				this.context.indexedLengthLoopAction?.role === "element" &&
				this.context.indexedLengthLoopAction.element?.kind === "load"
			) {
				const id = this.context.indexedLengthLoopAction.loadIp;
				const numericKeyGuard =
					this.context.indexedLengthLoopAction.site.reverseInduction !== undefined &&
					this.nativeNumberOperand(instruction.key) === null
						? `mal_ops_is_number(${this.boxed(instruction.key)}) && `
						: "";
				const numericKey =
					this.nativeNumberOperand(instruction.key) ??
					(this.context.indexedLengthLoopAction.site.reverseInduction !== undefined
						? `mal_ops_number_as_f64(${this.boxed(instruction.key)})`
						: this.typedNumber(instruction.key));
				const arrayLoad = this.context.indexedLengthLoopAction.element.arrayIndexIsUint32
					? `mal_vm_array_try_get_proven_index(__indexed_length_${id}_array, (u32) ${numericKey}, &__indexed_element_${this.ip})`
					: `mal_vm_array_try_get_index(__indexed_length_${id}_array, ${numericKey}, &__indexed_element_${this.ip})`;
				return [
					`MalValue __indexed_element_${this.ip};`,
					`if (__indexed_length_${id}_kind == 1 && ${numericKeyGuard}${arrayLoad}) {`,
					`  r${instruction.dst} = __indexed_element_${this.ip};`,
					`} else if (__indexed_length_${id}_kind == 2) {`,
					`  r${instruction.dst} = mal_typed_array_object_get(vm, __indexed_length_${id}_typed_array, mal_vm_typed_array_numeric_index(${numericKey}));`,
					`} else {`,
					...ordinary().map((line) => `  ${line}`),
					`}`,
				];
			}
			if (this.context.nativeStringSplitCursorAction?.role === "element") {
				const { site } = this.context.nativeStringSplitCursorAction;
				const id = site.callIp;
				const semanticValidation = site.semanticEpochStable
					? ""
					: `${semanticDependencyValidationGuard(site.cursor.license.guard, site.epochName)} && `;
				const trim = site.lockedTrimIdentity
					? [
							`  __string_split_cursor_${id}_trim_fast = ${this.profileCall("string", `mal_builtin_string_trim_span_length_locked(__gc_slots[${site.subjectSlot}], __string_split_cursor_${id}_start, __string_split_cursor_${id}_end, &__string_split_cursor_${id}_trim_length)`)};`,
						]
					: site.trimCalleeSlot !== undefined
						? [
								`  __string_split_cursor_${id}_trim_fast = ${semanticValidation}${this.profileCall("string", `mal_builtin_string_trim_span_length_locked(__gc_slots[${site.subjectSlot}], __string_split_cursor_${id}_start, __string_split_cursor_${id}_end, &__string_split_cursor_${id}_trim_length)`)};`,
							]
						: [
								`  MalValue __string_split_cursor_${id}_trim_callee;`,
								`  __string_split_cursor_${id}_trim_fast = mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &${nativeBodyReference(this.context.resources, "propertyCache")}[${site.cursor.trimIcIndex}], &__string_split_cursor_${id}_trim_callee) && ${this.profileCall("string", `mal_builtin_string_trim_span_length_direct(vm, __string_split_cursor_${id}_trim_callee, __gc_slots[${site.subjectSlot}], __string_split_cursor_${id}_start, __string_split_cursor_${id}_end, &__string_split_cursor_${id}_trim_length)`)};`,
							];
				return [
					`if (__string_split_cursor_${id}_active) {`,
					...trim,
					`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
					`  if (!__string_split_cursor_${id}_trim_fast) r${instruction.dst} = ${this.profileCall("string", `mal_builtin_string_span_materialize(vm, __gc_slots[${site.subjectSlot}], __string_split_cursor_${id}_start, __string_split_cursor_${id}_end)`)};`,
					`} else {`,
					...ordinary().map((line) => `  ${line}`),
					`}`,
				];
			}
			if (this.context.nativeStringSplitProjectionAction?.role === "element") {
				const { site, load } = this.context.nativeStringSplitProjectionAction;
				const slot = site.elementLoads.findIndex((entry) => entry.ip === load?.ip);
				if (slot >= 0) {
					return [
						`if (__string_split_${site.projection.callIp}_fast) {`,
						`  if (__string_split_${site.projection.callIp}_starts[${slot}] != SIZE_MAX && mal_value_is_undefined(__gc_slots[${site.slotsOffset + slot}])) {`,
						`    __gc_slots[${site.slotsOffset + slot}] = mal_builtin_string_span_materialize(vm, __gc_slots[${site.subjectSlot}], __string_split_${site.projection.callIp}_starts[${slot}], __string_split_${site.projection.callIp}_ends[${slot}]);`,
						`    ${this.throwCheck()}`,
						`  }`,
						`  r${instruction.dst} = __gc_slots[${site.slotsOffset + slot}];`,
						`} else {`,
						...ordinary().map((line) => `  ${line}`),
						`}`,
					];
				}
			}
			return this.reps[instruction.dst] === "boxed"
				? ordinary(this.slowPathFramePosition())
				: ordinary();
		}
		const probeHelper = isLengthPropertyName(
			this.context.stringConstants[instruction.stringIndex],
		)
			? "mal_vm_property_try_load_length_static"
			: this.context.polymorphicMethodLoad === true
				? "mal_vm_property_try_load_static_polymorphic"
				: "mal_vm_property_try_load_static";
		const probe = (): string =>
			`${this.context.watchedMathCallee === true ? `mal_vm_watched_own_value_try_load_static(vm, ${this.boxed(instruction.object)}, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}], &__v_${this.ip}) || ` : ""}${probeHelper}(vm, ${this.boxed(instruction.object)}, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}], &__v_${this.ip})`;
		const classLayout =
			this.context.nativePlan?.kind === "class-layout" && this.classLayoutsEnabled
				? this.context.nativePlan.site
				: undefined;
		const ordinary = (position: ReadonlyArray<string> = []): Array<string> =>
			classLayout === undefined
				? inlineCacheLoad(position)
				: [
						`{ MalObject *__co_${this.ip} = mal_vm_as_object(${this.boxed(instruction.object)});`,
						...classLayoutAccess(
							classLayout.kind,
							classLayout.candidates,
							`__co_${this.ip}`,
							this.boxed(instruction.object),
							({ layout, index }) =>
								`r${instruction.dst} = ${this.callValue(
									instruction.dst,
									classLayout.kind === "method"
										? `vm->class_cells[${layout}].methods[${index}]`
										: `mal_object_field_load_shaped(__co_${this.ip}, ${index})`,
								)};`,
							inlineCacheLoad(position),
						),
						"}",
					];
		const inlineCacheLoad = (position: ReadonlyArray<string> = []): Array<string> => [
			`MalValue __v_${this.ip};`,
			`if (${probe()}) {`,
			`  r${instruction.dst} = ${this.callValue(instruction.dst, `__v_${this.ip}`)};`,
			`} else {`,
			...position,
			...(this.context.incomingRootPublication ?? []).map((line) => `  ${line}`),
			...(this.context.staticPropertyLoadInactiveRootMask === undefined
				? []
				: [
						`  ${cInactiveRootMaskPublication(this.context.staticPropertyLoadInactiveRootMask, this.context.inactiveRootMaskStatements)};`,
					]),
			...this.boxedLoad(
				instruction.dst,
				this.profileCall(
					"property",
					`mal_vm_op_load_property_ic_static_miss(vm, ${this.boxed(instruction.object)}, ${this.context.relocation.stringIndex(instruction.stringIndex)}, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}])`,
				),
			).map((line) => `  ${line}`),
			`}`,
		];
		if (this.context.nativeStringSplitCursorAction?.role === "length") {
			const { site } = this.context.nativeStringSplitCursorAction;
			const id = site.callIp;
			const index = isNumericRep(this.reps[site.cursor.index]!)
				? this.num(site.cursor.index)
				: `mal_ops_number_as_f64(${this.boxed(site.cursor.index)})`;
			const value = `${index} + (__string_split_cursor_${id}_has ? 1.0 : 0.0)`;
			return [
				`if (__string_split_cursor_${id}_active) {`,
				`  __string_split_cursor_${id}_has = ${this.profileCall("string", `mal_builtin_string_split_cursor_next(__gc_slots[${site.subjectSlot}], __gc_slots[${site.traversalSlot}], &__string_split_cursor_${id}_state, &__string_split_cursor_${id}_start, &__string_split_cursor_${id}_end)`)};`,
				`  r${instruction.dst} = ${this.reps[instruction.dst] === "number" ? value : this.profileCall("boxing", `mal_ops_number_value(${value})`)};`,
				`  if (!__string_split_cursor_${id}_has) { __gc_slots[${site.subjectSlot}] = MAL_VALUE_UNDEFINED; __gc_slots[${site.traversalSlot}] = MAL_VALUE_UNDEFINED; }`,
				`} else {`,
				...ordinary().map((line) => `  ${line}`),
				`}`,
			];
		}
		if (this.context.nativeStringSplitCursorAction?.role === "trimProperty") {
			const id = this.context.nativeStringSplitCursorAction.site.callIp;
			return [
				`if (__string_split_cursor_${id}_active && __string_split_cursor_${id}_trim_fast) {`,
				`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
				`} else {`,
				...ordinary().map((line) => `  ${line}`),
				`}`,
			];
		}
		if (
			this.context.nativeStringSplitProjectionAction !== undefined &&
			this.context.nativeStringSplitProjectionAction.role !== "call"
		) {
			const { site, role, load } = this.context.nativeStringSplitProjectionAction;
			const fast = `__string_split_${site.projection.callIp}_fast`;
			if (role === "length") {
				return [
					`if (${fast}) {`,
					`  r${instruction.dst} = ${this.reps[instruction.dst] === "number" ? `(f64) __string_split_${site.projection.callIp}_length` : `mal_value_from_i32((i32) __string_split_${site.projection.callIp}_length)`};`,
					`} else {`,
					...ordinary().map((line) => `  ${line}`),
					`}`,
				];
			}
			const slot = site.elementLoads.findIndex((entry) => entry.ip === load?.ip);
			if (slot >= 0) {
				return [
					`if (${fast}) {`,
					`  if (__string_split_${site.projection.callIp}_starts[${slot}] != SIZE_MAX && mal_value_is_undefined(__gc_slots[${site.slotsOffset + slot}])) {`,
					`    __gc_slots[${site.slotsOffset + slot}] = mal_builtin_string_span_materialize(vm, __gc_slots[${site.subjectSlot}], __string_split_${site.projection.callIp}_starts[${slot}], __string_split_${site.projection.callIp}_ends[${slot}]);`,
					`    ${this.throwCheck()}`,
					`  }`,
					`  r${instruction.dst} = __gc_slots[${site.slotsOffset + slot}];`,
					`} else {`,
					...ordinary().map((line) => `  ${line}`),
					`}`,
				];
			}
		}
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			(this.context.nativePlan?.kind === "primitive-string-length" ||
				(this.operandKind(instruction.object) === COMPILER_VALUE_KIND_STRING &&
					isLengthPropertyName(this.context.stringConstants[instruction.stringIndex])))
		) {
			const length = `mal_string_length(mal_value_to_string(${this.boxed(instruction.object)}))`;
			const direct = `r${instruction.dst} = ${
				this.reps[instruction.dst] === "number"
					? `(f64) ${length}`
					: this.reps[instruction.dst] === "int32"
						? `(i32) ${length}`
						: `mal_value_from_i32((i32) ${length})`
			};`;
			const ordinaryLength =
				this.operandKind(instruction.object) === COMPILER_VALUE_KIND_STRING
					? [direct]
					: [
							`if (mal_value_is_string(${this.boxed(instruction.object)})) {`,
							`  ${direct}`,
							`} else {`,
							...ordinary().map((line) => `  ${line}`),
							`}`,
						];
			const site = this.context.stringSplitTrimLengthSite;
			if (site === undefined) return ordinaryLength;
			const scalar = `__string_split_cursor_${site.callIp}_trim_length`;
			const value =
				this.reps[instruction.dst] === "number"
					? `(f64) ${scalar}`
					: this.reps[instruction.dst] === "int32"
						? `(i32) ${scalar}`
						: `mal_value_from_i32((i32) ${scalar})`;
			return [
				`if (__string_split_cursor_${site.callIp}_active && __string_split_cursor_${site.callIp}_trim_fast) {`,
				`  r${instruction.dst} = ${value};`,
				`} else {`,
				...ordinaryLength.map((line) => `  ${line}`),
				`}`,
			];
		}
		return this.reps[instruction.dst] === "boxed"
			? ordinary(this.slowPathFramePosition())
			: ordinary();
	}
	emitBinary(
		instruction: Extract<BytecodeInstruction, { opcode: "BINARY" }>,
	): Array<string> | null {
		if (this.context.nativeArrayPresenceProjectionAction?.role === "membership") {
			const fallback = this.emitGenericInstruction();
			if (fallback === null) return null;
			const membershipIp = this.context.nativeArrayPresenceProjectionAction.membershipIp;
			const loadIp = this.context.nativeArrayPresenceProjectionAction.indexed.loadIp;
			const state = `__array_presence_${membershipIp}_state`;
			const probe = `${state} = __indexed_length_${loadIp}_kind == 1 ? mal_vm_array_try_get_present_proven_index(__indexed_length_${loadIp}_array, (u32) ${this.typedNumber(instruction.left)}, &__array_presence_${membershipIp}_value) : -1;`;
			return [
				probe,
				`if (${state} >= 0) {`,
				this.reps[instruction.dst] === "boolean"
					? `  r${instruction.dst} = ${state} != 0;`
					: `  r${instruction.dst} = mal_value_new_boolean(${state} != 0);`,
				`} else {`,
				...fallback.map((line) => `  ${line}`),
				`}`,
			];
		}
		if (this.context.staticPropertyNumericAction?.role === "step") {
			const { plan, index } = this.context.staticPropertyNumericAction;
			const operand = (value: NativePropertyProjectionOperand): string => {
				switch (value.kind) {
					case "load":
						return `__property_projection_${plan.id}_value_${value.index}`;
					case "step":
						return `__property_projection_${plan.id}_step_${value.index}`;
					case "register":
						return this.reps[value.register] === "boxed"
							? `mal_ops_number_as_f64(r${value.register})`
							: this.typedNumber(value.register);
				}
			};
			const step = plan.steps[index]!;
			const expression = nativeNumberExpr(
				instruction.operator,
				operand(step.left),
				operand(step.right),
				this.context.facts?.inputIntegerRanges,
				step.left.kind === "register" ? this.scalarNumber(step.left.register) : undefined,
				step.right.kind === "register"
					? this.scalarNumber(step.right.register)
					: undefined,
			);
			if (expression === null) return null;
			const last = index === plan.steps.length - 1;
			const startsFusion =
				last &&
				this.context.numericFusionAction?.role === "start" &&
				this.reps[instruction.dst] === "boxed";
			const fallback = startsFusion
				? emitInstruction(
						instruction,
						this.ip,
						this.suffix,
						this.reps,
						this.strict,
						this.handlerIp,
						this.gcUnlink,
						this.thisSlot,
						this.coro,
						{
							...this.genericContext(),
							numericFusionAction: this.context.numericFusionAction,
						},
					)
				: this.emitGenericInstruction();
			if (fallback === null) return null;
			const result = `__property_projection_${plan.id}_step_${index}`;
			const store = startsFusion
				? `__nf_${this.context.numericFusionAction.id}_ok = true; __nf_${this.context.numericFusionAction.id}_value = ${result};`
				: this.reps[instruction.dst] === "number"
					? `r${instruction.dst} = ${result};`
					: this.reps[instruction.dst] === "int32"
						? `r${instruction.dst} = mal_ops_number_to_i32(${result});`
						: `r${instruction.dst} = ${this.profileCall("boxing", `mal_ops_number_value(${result})`)};`;
			return [
				`if (__property_projection_${plan.id}_fast) {`,
				`  ${result} = ${expression};`,
				...(last && plan.terminalStore === undefined ? [`  ${store}`] : []),
				`} else {`,
				...fallback.map((line) => `  ${line}`),
				`}`,
			];
		}
		if (this.context.constantBoolean !== undefined)
			return [
				this.storeBoolean(
					instruction.dst,
					this.context.constantBoolean ? "true" : "false",
				),
			];
		const { dst, left, right, operator } = instruction;
		const effects = nativeInstructionEffects(instruction, this.context.facts);
		const inputKinds =
			this.context.facts?.inputKindMasks !== undefined &&
			this.context.facts.inputKindMasks.length === 2
				? this.context.facts.inputKindMasks
				: undefined;
		const binaryValue = (): string => {
			const comparison = BOXED_COMPARE[operator];
			// Value helpers neither invoke object hooks nor report Symbol comparison errors.
			return comparison !== undefined &&
				!effects.throwing &&
				!effects.reentry &&
				inputKinds !== undefined &&
				compilerComparisonInputKindsAvoidObjectCoercion(operator, inputKinds)
				? `${comparison}(${this.boxed(left)}, ${this.boxed(right)})`
				: `mal_vm_binary_op(vm, ${emitBinaryOperator(operator)}, ${this.boxed(left)}, ${this.boxed(right)})`;
		};
		const canThrow = binaryOpCanThrow(operator) && (effects.throwing || effects.reentry);
		if (!canThrow) this.elideFramePosition();
		const rangedComparison = compilerIntegerRangeComparison(
			operator,
			instructionInputIntegerRange(this.context.facts, left),
			instructionInputIntegerRange(this.context.facts, right),
		);
		if (rangedComparison !== undefined)
			return [this.storeBoolean(dst, String(rangedComparison))];
		if (this.context.numericFusionAction?.truncating) {
			const fusion = this.context.numericFusionAction;
			const integer = (register: number): string =>
				this.reps[register] === "int32"
					? `r${register}`
					: instructionInputIsInt32(this.context.facts, register)
						? this.nativeInt32Operand(register)!
						: this.reps[register] === "number"
							? `(i32)(${this.typedNumber(register)})`
							: `mal_value_to_i32(${this.boxed(register)})`;
			const integerGuard = (register: number): string =>
				this.reps[register] === "int32" ||
				instructionInputIsInt32(this.context.facts, register)
					? "true"
					: this.reps[register] === "number"
						? `(r${register} >= -2147483648.0 && r${register} <= 2147483647.0 && r${register} == trunc(r${register}))`
						: `mal_value_is_int32(${this.boxed(register)})`;
			if (fusion.role === "start") {
				const fallback = this.emitGenericInstruction();
				if (fallback === null) return null;
				// Retain the exact Number result for a failed finish guard, including restored artifacts.
				return [
					`__nf_${fusion.id}_ok = ${integerGuard(left)} && ${integerGuard(right)};`,
					`if (__nf_${fusion.id}_ok) {`,
					`  __nf_${fusion.id}_integer = mal_scalar_i32_from_bits((u32)(${integer(left)}) ${operator} (u32)(${integer(right)}));`,
					`  __nf_${fusion.id}_value = (f64)(${integer(left)}) ${operator} (f64)(${integer(right)});`,
					`} else {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			const temporary = `__nf_${fusion.id}_integer`;
			const expression = nativeInt32Expr(
				operator,
				left === fusion.first.dst ? temporary : integer(left),
				right === fusion.first.dst ? temporary : integer(right),
			);
			if (expression === null) throw new Error("Invalid truncating integer fusion");
			const external = left === fusion.first.dst ? right : left;
			const fallback = this.emitGenericInstruction();
			if (fallback === null) return null;
			return [
				`if (__nf_${fusion.id}_ok && ${integerGuard(external)}) {`,
				`  r${dst} = ${this.reps[dst] === "int32" ? expression : this.reps[dst] === "number" ? `(f64)(${expression})` : this.profileCall("boxing", `mal_value_from_i32(${expression})`)};`,
				`} else {`,
				`  if (__nf_${fusion.id}_ok) ${this.storeNumber(fusion.first.dst, `__nf_${fusion.id}_value`)}`,
				...fallback.map((line) => `  ${line}`),
				`}`,
			];
		}
		if (this.context.nativePlan?.kind === "unsigned-arithmetic") {
			const number = (register: number) =>
				isNumericRep(this.reps[register]!)
					? this.typedNumber(register)
					: `mal_ops_number_as_f64(${this.boxed(register)})`;
			return [
				this.storeNumber(
					dst,
					`(f64)(${nativeUnsignedExpr(
						operator,
						number(left),
						number(right),
						this.scalarNumber(left),
						this.scalarNumber(right),
					)})`,
				),
			];
		}
		const leftIsNum =
			isNumericRep(this.reps[left]!) ||
			this.operandKind(left) === COMPILER_VALUE_KIND_NUMBER;
		const rightIsNum =
			isNumericRep(this.reps[right]!) ||
			this.operandKind(right) === COMPILER_VALUE_KIND_NUMBER;
		if (this.resultIsInt32(dst) && leftIsNum && rightIsNum) {
			const expression =
				nativeInt32ArithmeticExpression(
					operator,
					this.exactInt32Operand(left),
					this.exactInt32Operand(right),
				) ??
				(operator === "%"
					? nativeUnsignedRemainderExpression(
							this.nativeNumberOperand(left)!,
							this.nativeNumberOperand(right)!,
							instructionInputIntegerRange(this.context.facts, left),
							instructionInputIntegerRange(this.context.facts, right),
							this.scalarNumber(left) ?? this.nativeNumberOperand(left)!,
							this.scalarNumber(right) ?? this.nativeNumberOperand(right)!,
							"int32",
						)
					: undefined);
			if (expression !== undefined) {
				this.elideFramePosition();
				return [this.storeNumber(dst, expression)];
			}
		}
		const numbersPossible =
			((this.operandKind(left) ?? COMPILER_VALUE_KIND_TOP) &
				COMPILER_VALUE_KIND_NUMBER) !==
				0 &&
			((this.operandKind(right) ?? COMPILER_VALUE_KIND_TOP) &
				COMPILER_VALUE_KIND_NUMBER) !==
				0;
		const dstIsBool = this.reps[dst] === "boolean";
		const compare = NATIVE_COMPARE[operator];
		if (this.reps[left] === "boolean" || this.reps[right] === "boolean") {
			const a = this.coerciveNumberOperand(left),
				b = this.coerciveNumberOperand(right);
			if (a !== null && b !== null) {
				if (compare !== undefined && operator !== "===" && operator !== "!==")
					return [this.storeBoolean(dst, `${a} ${compare} ${b}`)];
				const expression =
					operator === "**"
						? `mal_number_exponentiate(${a}, ${b})`
						: nativeNumberExpr(
								operator,
								a,
								b,
								this.context.facts?.inputIntegerRanges,
								this.scalarNumber(left),
								this.scalarNumber(right),
							);
				if (expression !== null) return [this.storeNumber(dst, expression)];
			}
		}
		const fusion = this.context.numericFusionAction;
		if (
			inputKinds !== undefined &&
			(!leftIsNum || !rightIsNum || operator === "**") &&
			(fusion === undefined ||
				this.reps[fusion.role === "start" ? dst : fusion.first.dst] !== "boxed") &&
			inputKinds.every((mask) =>
				compilerValueKindMaskIsSubset(mask, COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE),
			)
		) {
			const a = this.exactPrimitiveNumber(left, inputKinds[0]!);
			const b = this.exactPrimitiveNumber(right, inputKinds[1]!);
			if (RELATIONAL_COMPARE.has(operator))
				return [this.storeBoolean(dst, `${a} ${compare} ${b}`)];
			const expression =
				operator === "**"
					? `mal_number_exponentiate(${a}, ${b})`
					: nativeNumberExpr(
							operator,
							a,
							b,
							this.context.facts?.inputIntegerRanges,
							this.scalarNumber(left),
							this.scalarNumber(right),
						);
			if (expression !== null) return [this.storeNumber(dst, expression)];
		}
		if (this.context.indexedLengthLoopAction?.role === "compare") {
			const fallback = this.emitGenericInstruction();
			if (fallback === null) return null;
			const compareOperator = NATIVE_COMPARE[operator];
			if (compareOperator === undefined) return null;
			const reverse =
				this.context.indexedLengthLoopAction.site.reverseInduction !== undefined;
			const length = reverse
				? `__indexed_length_${this.context.indexedLengthLoopAction.loadIp}_induction`
				: `(f64) __indexed_length_${this.context.indexedLengthLoopAction.loadIp}_value`;
			const other =
				this.context.indexedLengthLoopAction.site.lengthPosition === 1 ? right : left;
			const otherNumber = reverse
				? `mal_ops_number_as_f64(${this.boxed(other)})`
				: this.typedNumber(other);
			const fast =
				this.context.indexedLengthLoopAction.site.lengthPosition === 1
					? `${length} ${compareOperator} ${otherNumber}`
					: `${otherNumber} ${compareOperator} ${length}`;
			return [
				`if (__indexed_length_${this.context.indexedLengthLoopAction.loadIp}_kind != 0${reverse ? ` && mal_ops_is_number(${this.boxed(other)})` : ""}) {`,
				dstIsBool
					? `  r${dst} = ${fast};`
					: `  r${dst} = ${this.profileCall("boxing", `mal_value_new_boolean(${fast})`)};`,
				`} else {`,
				...fallback.map((line) => `  ${line}`),
				`}`,
			];
		}
		if (
			operator === "in" &&
			((this.operandKind(right) ?? COMPILER_VALUE_KIND_TOP) &
				COMPILER_VALUE_KIND_OBJECT) !==
				0
		) {
			const membership = `__array_has_${this.ip}`;
			const fastMembership = `mal_vm_array_try_has(mal_vm_as_array(${this.boxed(right)}), ${leftIsNum ? this.typedNumber(left) : `mal_ops_number_as_f64(${this.boxed(left)})`})`;
			const ownKey = `mal_vm_shape_has_own_key(vm, ${this.boxed(right)}, ${this.boxed(left)}) ? 1 : -1`;
			return [
				`i32 ${membership} = ${leftIsNum ? fastMembership : ((this.operandKind(left) ?? COMPILER_VALUE_KIND_TOP) & COMPILER_VALUE_KIND_NUMBER) !== 0 ? `mal_ops_is_number(${this.boxed(left)}) ? ${fastMembership} : ${ownKey}` : ownKey};`,
				`if (${membership} >= 0) {`,
				dstIsBool
					? `  r${dst} = ${membership} != 0;`
					: `  r${dst} = mal_value_new_boolean(${membership} != 0);`,
				`} else {`,
				dstIsBool
					? `  r${dst} = mal_value_to_boolean(${this.profileCall("binary", this.reentrantValue(binaryValue()))});`
					: `  r${dst} = ${this.profileCall("binary", this.reentrantValue(binaryValue()))};`,
				...(canThrow ? [`  ${this.throwCheck()}`] : []),
				`}`,
			];
		}
		if (
			operator === "+" &&
			(fusion === undefined || fusion.role === "start") &&
			(this.reps[left] === "string" || inputKinds?.[0] === COMPILER_VALUE_KIND_STRING) &&
			(this.reps[right] === "string" || inputKinds?.[1] === COMPILER_VALUE_KIND_STRING)
		) {
			// A String start selects the fusion's boxed fallback for its matching finish.
			return [
				...(fusion === undefined ? [] : [`__nf_${fusion.id}_ok = false;`]),
				`r${dst} = ${this.profileCall("string", this.reentrantValue(`mal_vm_concat_strings_known(vm, mal_value_to_string(${this.boxed(left)}), mal_value_to_string(${this.boxed(right)}))`))};`,
				...(canThrow ? [this.throwCheck()] : []),
			];
		}
		if (
			(fusion === undefined || fusion.role === "start") &&
			inputKinds !== undefined &&
			compilerOperatorIsPrimitiveStringConcatenation("binary", operator, inputKinds)
		) {
			return [
				...(fusion === undefined ? [] : [`__nf_${fusion.id}_ok = false;`]),
				`r${dst} = ${this.profileCall("string", this.reentrantValue(`mal_vm_concat_primitive_strings(vm, ${this.boxed(left)}, ${this.boxed(right)})`))};`,
				...(canThrow ? [this.throwCheck()] : []),
			];
		}
		const fusedInput =
			fusion !== undefined && fusion.role !== "start" ? fusion.first.dst : undefined;
		const numericInputs =
			(!leftIsNum ||
				!rightIsNum ||
				this.reps[dst] === "boxed" ||
				fusedInput !== undefined) &&
			(producesNumberFromNumbers(operator) || RELATIONAL_COMPARE.has(operator))
				? nativeBinaryNumberInputs(
						operator,
						left === fusedInput || leftIsNum
							? COMPILER_VALUE_KIND_NUMBER
							: (this.operandKind(left) ?? COMPILER_VALUE_KIND_TOP),
						right === fusedInput || rightIsNum
							? COMPILER_VALUE_KIND_NUMBER
							: (this.operandKind(right) ?? COMPILER_VALUE_KIND_TOP),
						this.boxed(left),
						this.boxed(right),
					)
				: undefined;
		const numericOperand = (register: number): string =>
			this.exactPrimitiveNumber(
				register,
				numericInputs!.masks[register === left ? 0 : 1],
			);
		if (fusion?.role === "link") {
			const firstOnLeft = left === fusion.first.dst;
			const external = firstOnLeft ? right : left;
			const value = `__nf_${fusion.id}_value`;
			const slow = this.profileCall("binary", this.reentrantValue(binaryValue()));
			const fallback = [
				...(numericInputs?.guard === ""
					? []
					: [
							`if (__nf_${fusion.id}_ok) r${fusion.first.dst} = ${this.profileCall("boxing", `mal_ops_number_value(${value})`)};`,
							`__nf_${fusion.id}_ok = false;`,
						]),
				`r${dst} = ${slow};`,
				...(canThrow ? [this.throwCheck()] : []),
			];
			if (numericInputs === undefined) return fallback;
			const externalExpr = numericOperand(external);
			const nativeExpr = nativeNumberExpr(
				operator,
				firstOnLeft ? value : externalExpr,
				firstOnLeft ? externalExpr : value,
				this.context.facts?.inputIntegerRanges,
				firstOnLeft ? undefined : this.scalarNumber(external),
				firstOnLeft ? this.scalarNumber(external) : undefined,
			);
			if (nativeExpr === null) throw new Error("Invalid numeric-fusion link");
			return [
				`if (__nf_${fusion.id}_ok${numericInputs.guard === "" ? "" : ` && ${numericInputs.guard}`}) {`,
				`  ${value} = ${nativeExpr};`,
				`} else {`,
				...fallback.map((line) => `  ${line}`),
				`}`,
			];
		}
		if (fusion?.role === "start" && this.reps[dst] === "boxed") {
			if (numericInputs === undefined) {
				const fallback = this.emitGenericInstruction();
				if (fallback === null) return null;
				return [`__nf_${fusion.id}_ok = false;`, ...fallback];
			}
			const nativeExpr = nativeNumberExpr(
				operator,
				numericOperand(left),
				numericOperand(right),
				this.context.facts?.inputIntegerRanges,
				this.scalarNumber(left),
				this.scalarNumber(right),
			);
			if (nativeExpr === null) throw new Error("Invalid numeric-fusion start");
			if (numericInputs.guard === "")
				return [
					`__nf_${fusion.id}_ok = true;`,
					`__nf_${fusion.id}_value = ${nativeExpr};`,
				];
			const slow = this.profileCall("binary", this.reentrantValue(binaryValue()));
			return [
				`__nf_${fusion.id}_ok = ${numericInputs.guard};`,
				`if (__nf_${fusion.id}_ok) {`,
				`  __nf_${fusion.id}_value = ${nativeExpr};`,
				`} else {`,
				`  r${dst} = ${slow};`,
				...(canThrow ? [`  ${this.throwCheck()}`] : []),
				`}`,
			];
		}
		if (fusion?.role === "finish" && this.reps[fusion.first.dst] === "boxed") {
			const first = fusion.first;
			const firstOnLeft = left === first.dst;
			const external = firstOnLeft ? right : left;
			const comparison = NATIVE_COMPARE[operator];
			const equality = comparison !== undefined && !RELATIONAL_COMPARE.has(operator);
			const externalIsNum =
				isNumericRep(this.reps[external]!) ||
				this.operandKind(external) === COMPILER_VALUE_KIND_NUMBER;
			const externalGuard = equality
				? externalIsNum
					? ""
					: `mal_ops_is_number(${this.boxed(external)})`
				: numericInputs?.guard;
			const slow = this.profileCall("binary", this.reentrantValue(binaryValue()));
			const fallback = [
				...(canThrow ? this.slowPathFramePosition() : []),
				...(externalGuard === ""
					? []
					: [
							`if (__nf_${fusion.id}_ok) r${first.dst} = ${this.profileCall("boxing", `mal_ops_number_value(__nf_${fusion.id}_value)`)};`,
						]),
				...(comparison !== undefined
					? [
							this.reps[dst] === "boolean"
								? `r${dst} = mal_value_to_boolean(${slow});`
								: `r${dst} = ${slow};`,
							...(canThrow ? [this.throwCheck()] : []),
						]
					: [
							`MalValue __binary_result_${this.ip} = ${slow};`,
							...(canThrow ? [this.throwCheck()] : []),
							`r${dst} = ${this.callValue(dst, `__binary_result_${this.ip}`)};`,
						]),
			];
			if (externalGuard === undefined) return fallback;
			const externalExpr = equality
				? externalIsNum
					? this.typedNumber(external)
					: `mal_ops_number_as_f64(${this.boxed(external)})`
				: numericOperand(external);
			const fusedValue = `__nf_${fusion.id}_value`;
			let result: string;
			if (comparison !== undefined) {
				const expression = firstOnLeft
					? `${fusedValue} ${comparison} ${externalExpr}`
					: `${externalExpr} ${comparison} ${fusedValue}`;
				result = this.storeBoolean(dst, expression);
			} else {
				const nativeExpr = nativeNumberExpr(
					operator,
					firstOnLeft ? fusedValue : externalExpr,
					firstOnLeft ? externalExpr : fusedValue,
					this.context.facts?.inputIntegerRanges,
					firstOnLeft ? undefined : this.scalarNumber(external),
					firstOnLeft ? this.scalarNumber(external) : undefined,
				);
				if (nativeExpr === null) throw new Error("Invalid numeric-fusion finish");
				const fusedInt32 = numberToInt32(
					fusedValue,
					instructionInputIsInt32(this.context.facts, first.dst),
				);
				const externalInt32 =
					this.reps[external] === "int32"
						? this.inputValue(external)
						: numberToInt32(
								externalExpr,
								instructionInputIsInt32(this.context.facts, external),
							);
				const int32Result =
					this.reps[dst] === "int32" && INT32_RESULT_OPERATORS.has(operator)
						? nativeInt32Expr(
								operator,
								firstOnLeft ? fusedInt32 : externalInt32,
								firstOnLeft ? externalInt32 : fusedInt32,
							)
						: null;
				result = `r${dst} = ${this.reps[dst] === "number" ? nativeExpr : this.reps[dst] === "int32" ? (int32Result ?? `mal_ops_number_to_i32(${nativeExpr})`) : this.profileCall("boxing", `mal_ops_number_value(${nativeExpr})`)};`;
			}
			return [
				`if (__nf_${fusion.id}_ok${externalGuard === "" ? "" : ` && ${externalGuard}`}) {`,
				`  ${result}`,
				`} else {`,
				...fallback.map((line) => `  ${line}`),
				`}`,
			];
		}
		if (left === right) {
			const expression = nativeReflexiveEqualityExpression(
				operator,
				this.boxed(left),
				this.nativeNumberOperand(left) ?? undefined,
				this.operandKind(left),
				this.reps[left] === "int32" ||
					instructionInputIntegerRange(this.context.facts, left) !== undefined,
			);
			if (expression !== undefined) {
				this.elideFramePosition();
				return [this.storeBoolean(dst, expression)];
			}
		}
		if (
			(this.reps[dst] === "number" || this.reps[dst] === "int32") &&
			(!leftIsNum || !rightIsNum)
		) {
			const result = `__binary_result_${this.ip}`;
			const fallback = [
				`MalValue ${result} = ${this.profileCall("binary", this.reentrantValue(binaryValue()))};`,
				...(canThrow ? [this.throwCheck()] : []),
				`r${dst} = ${this.reps[dst] === "int32" ? `mal_ops_number_value_to_i32(${result})` : `mal_ops_number_as_f64(${result})`};`,
			];
			if (numericInputs === undefined) return fallback;
			// ToInt32 of an int32 operand or result is the identity, but clang cannot fold FJCVTZS.
			const int32Input = (register: number): string =>
				numericInputs.masks[register === left ? 0 : 1] !== COMPILER_VALUE_KIND_NUMBER
					? `mal_ops_number_to_i32(${numericOperand(register)})`
					: this.reps[register] === "int32"
						? this.inputValue(register)
						: instructionInputIsInt32(this.context.facts, register)
							? this.nativeInt32Operand(register)!
							: this.reps[register] === "number"
								? `mal_ops_number_to_i32(${this.inputValue(register)})`
								: `mal_ops_number_value_to_i32(${this.boxed(register)})`;
			const int32Expression = INT32_RESULT_OPERATORS.has(operator)
				? nativeInt32Expr(operator, int32Input(left), int32Input(right))
				: null;
			const expression =
				int32Expression === null
					? nativeNumberExpr(
							operator,
							numericOperand(left),
							numericOperand(right),
							this.context.facts?.inputIntegerRanges,
							this.scalarNumber(left),
							this.scalarNumber(right),
						)
					: `(f64) (${int32Expression})`;
			if (expression === null) return fallback;
			const fast =
				int32Expression !== null && this.reps[dst] === "int32"
					? `r${dst} = ${int32Expression};`
					: this.storeNumber(dst, expression);
			if (numericInputs.guard === "") {
				this.elideFramePosition();
				return [fast];
			}
			return [
				`if (${numericInputs.guard}) {`,
				`  ${fast}`,
				`} else {`,
				...this.slowPathFramePosition(),
				...fallback.map((line) => `  ${line}`),
				`}`,
			];
		}
		if (this.reps[dst] === "int32") {
			if (!leftIsNum || !rightIsNum) return null;
			const integer = nativeInt32Expr(
				operator,
				this.nativeInt32Operand(left)!,
				this.nativeInt32Operand(right)!,
			);
			const expression =
				integer ??
				nativeNumberExpr(
					operator,
					this.typedNumber(left),
					this.typedNumber(right),
					this.context.facts?.inputIntegerRanges,
					this.scalarNumber(left),
					this.scalarNumber(right),
				);
			this.elideFramePosition();
			return expression === null ? null : [this.storeNumber(dst, expression)];
		}
		if (this.reps[dst] === "number") {
			// Bail defensively if the lattice invariant ever breaks.
			if (!leftIsNum || !rightIsNum) {
				return null;
			}
			this.elideFramePosition();
			if (dst === left && ["+", "-", "*", "/"].includes(operator)) {
				return [`r${dst} ${operator}= ${this.typedNumber(right)};`];
			}
			if (dst === right && (operator === "+" || operator === "*")) {
				return [`r${dst} ${operator}= ${this.typedNumber(left)};`];
			}
			const expr = nativeNumberExpr(
				operator,
				this.typedNumber(left),
				this.typedNumber(right),
				this.context.facts?.inputIntegerRanges,
				this.scalarNumber(left),
				this.scalarNumber(right),
			);
			return expr === null ? null : [`r${dst} = ${expr};`];
		}
		if (operator === "**" && leftIsNum && rightIsNum) {
			this.elideFramePosition();
			return [
				this.storeNumber(
					dst,
					`mal_number_exponentiate(${this.typedNumber(left)}, ${this.typedNumber(right)})`,
				),
			];
		}
		const numericOf = (r: number): string =>
			this.reps[r] === "int32"
				? `(f64) r${r}`
				: this.reps[r] === "number"
					? `r${r}`
					: `mal_ops_number_as_f64(${this.boxed(r)})`;
		if (
			inputKinds !== undefined &&
			compilerOperatorIsNullishEquality("binary", operator, inputKinds)
		) {
			const other = compilerValueKindMaskIsSubset(
				inputKinds[1]!,
				COMPILER_VALUE_KIND_NULLISH,
			)
				? left
				: right;
			const positive =
				operator === "==" || operator === "!="
					? isNumericRep(this.reps[other]!) || this.reps[other] === "boolean"
						? "false"
						: `mal_value_is_nil(${this.boxed(other)})`
					: `${this.boxed(left)} == ${this.boxed(right)}`;
			this.elideFramePosition();
			return [
				this.storeBoolean(
					dst,
					operator === "!=" || operator === "!==" ? `!(${positive})` : positive,
				),
			];
		}
		// Exact Number/undefined domains require neither coercion nor a speculative fallback.
		if (
			inputKinds !== undefined &&
			inputKinds.every(
				(mask) => (mask & ~COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED) === 0,
			) &&
			compare !== undefined
		) {
			const exactUndefined = (r: number, mask: CompilerValueKindMask): string =>
				mask === COMPILER_VALUE_KIND_UNDEFINED
					? "true"
					: mask === COMPILER_VALUE_KIND_NUMBER
						? "false"
						: `mal_value_is_undefined(${this.boxed(r)})`;
			const exactNumberOrUndefined = (r: number, mask: CompilerValueKindMask): string =>
				mask === COMPILER_VALUE_KIND_UNDEFINED
					? '__builtin_nan("")'
					: mask === COMPILER_VALUE_KIND_NUMBER
						? numericOf(r)
						: `(${exactUndefined(r, mask)} ? __builtin_nan("") : ${numericOf(r)})`;
			const exactNumberOrUndefinedEquality = (
				leftMask: CompilerValueKindMask,
				rightMask: CompilerValueKindMask,
			): string => {
				if (leftMask === COMPILER_VALUE_KIND_UNDEFINED) {
					return exactUndefined(right, rightMask);
				}
				if (rightMask === COMPILER_VALUE_KIND_UNDEFINED) {
					return exactUndefined(left, leftMask);
				}
				if (
					leftMask === COMPILER_VALUE_KIND_NUMBER &&
					rightMask === COMPILER_VALUE_KIND_NUMBER
				) {
					return `${numericOf(left)} == ${numericOf(right)}`;
				}
				const leftUndefined = exactUndefined(left, leftMask);
				const rightUndefined = exactUndefined(right, rightMask);
				if (leftMask === COMPILER_VALUE_KIND_NUMBER) {
					return `!(${rightUndefined}) && ${numericOf(left)} == ${numericOf(right)}`;
				}
				if (rightMask === COMPILER_VALUE_KIND_NUMBER) {
					return `!(${leftUndefined}) && ${numericOf(left)} == ${numericOf(right)}`;
				}
				return `((${leftUndefined}) && (${rightUndefined})) || (!(${leftUndefined}) && !(${rightUndefined}) && ${numericOf(left)} == ${numericOf(right)})`;
			};
			const equality = ["==", "!=", "===", "!=="].includes(operator);
			const positive = equality
				? exactNumberOrUndefinedEquality(inputKinds[0]!, inputKinds[1]!)
				: `${exactNumberOrUndefined(left, inputKinds[0]!)} ${compare} ${exactNumberOrUndefined(right, inputKinds[1]!)}`;
			const result =
				operator === "!=" || operator === "!==" ? `!(${positive})` : positive;
			this.elideFramePosition();
			return [this.storeBoolean(dst, result)];
		}
		const stringComparison = this.context.stringComparisons?.get(this.ip);
		if (stringComparison?.kind === "strings") {
			const equal = this.profileCall(
				"string",
				nativeStringComparisonExpression(
					stringComparison,
					left,
					this.boxed(left),
					this.boxed(right),
				)!,
			);
			this.elideFramePosition();
			return [this.storeBoolean(dst, operator === "!==" ? `!${equal}` : equal)];
		}
		if (compare !== undefined) {
			if (leftIsNum && rightIsNum) {
				this.elideFramePosition();
				return [
					this.storeBoolean(
						dst,
						`${this.typedNumber(left)} ${compare} ${this.typedNumber(right)}`,
					),
				];
			}
			if (
				(this.reps[left] === "string" ||
					inputKinds?.[0] === COMPILER_VALUE_KIND_STRING) &&
				(this.reps[right] === "string" || inputKinds?.[1] === COMPILER_VALUE_KIND_STRING)
			) {
				const a = this.nativeStringOperand(left)!,
					b = this.nativeStringOperand(right)!;
				this.elideFramePosition();
				if (!RELATIONAL_COMPARE.has(operator)) {
					const equal = this.profileCall("string", `mal_string_equals(${a}, ${b})`);
					return [
						this.storeBoolean(
							dst,
							operator === "!=" || operator === "!==" ? `!${equal}` : equal,
						),
					];
				}
				return [
					this.storeBoolean(
						dst,
						`${this.profileCall("string", `mal_string_compare(${a}, ${b})`)} ${compare} 0`,
					),
				];
			}
		}
		if (operator === "===" || operator === "!==") {
			const equal =
				nativeStringComparisonExpression(
					stringComparison,
					left,
					this.boxed(left),
					this.boxed(right),
				) ??
				nativeEqualityExpression(
					"strict",
					this.boxed(left),
					this.boxed(right),
					this.operandKind(left),
					this.operandKind(right),
					this.nativeNumberOperand(left) ??
						this.nativeBooleanOperand(left) ??
						this.nativeStringOperand(left) ??
						undefined,
					this.nativeNumberOperand(right) ??
						this.nativeBooleanOperand(right) ??
						this.nativeStringOperand(right) ??
						undefined,
					this.reps[left] === "int32" && this.reps[right] === "int32",
					instructionInputIntegerRange(this.context.facts, left),
					instructionInputIntegerRange(this.context.facts, right),
				);
			this.elideFramePosition();
			return [this.storeBoolean(dst, operator === "!==" ? `!(${equal})` : equal)];
		}
		const slow = (): string =>
			this.profileCall("binary", this.reentrantValue(binaryValue()));
		const bothBoxed = !leftIsNum && !rightIsNum;
		const numberGuard = leftIsNum
			? rightIsNum
				? ""
				: `mal_ops_is_number(${this.boxed(right)})`
			: rightIsNum
				? `mal_ops_is_number(${this.boxed(left)})`
				: `mal_ops_is_number(${this.boxed(left)}) && mal_ops_is_number(${this.boxed(right)})`;
		if (compare !== undefined) {
			const completionCheck = canThrow ? this.throwCheck() : undefined;
			const compareCheck = completionCheck === undefined ? [] : [completionCheck];
			if (
				(numericInputs !== undefined && RELATIONAL_COMPARE.has(operator)) ||
				(numbersPossible && !bothBoxed)
			) {
				const guard = numericInputs?.guard ?? numberGuard;
				const fastBool =
					numericInputs === undefined
						? `${numericOf(left)} ${compare} ${numericOf(right)}`
						: `${numericOperand(left)} ${compare} ${numericOperand(right)}`;
				if (guard === "") {
					this.elideFramePosition();
					return [this.storeBoolean(dst, fastBool)];
				}
				if (canThrow) {
					return [
						`if (${guard}) {`,
						dstIsBool
							? `  r${dst} = ${fastBool};`
							: `  r${dst} = ${this.profileCall("boxing", `mal_value_new_boolean(${fastBool})`)};`,
						`} else {`,
						...this.slowPathFramePosition(),
						dstIsBool
							? `  r${dst} = mal_value_to_boolean(${slow()});`
							: `  r${dst} = ${slow()};`,
						`  ${completionCheck}`,
						`}`,
					];
				}
				return [
					dstIsBool
						? `r${dst} = ${guard} ? (${fastBool}) : mal_value_to_boolean(${slow()});`
						: `r${dst} = ${guard} ? ${this.profileCall("boxing", `mal_value_new_boolean(${fastBool})`)} : ${slow()};`,
					...compareCheck,
				];
			}
			return [
				dstIsBool ? `r${dst} = mal_value_to_boolean(${slow()});` : `r${dst} = ${slow()};`,
				...compareCheck,
			];
		}
		// Past here the result is boxed; a boolean-rep dst could only come from
		// a comparison (handled above), so anything else is a lattice bug.
		if (dstIsBool) {
			return null;
		}
		if (numericInputs !== undefined && producesNumberFromNumbers(operator)) {
			const nativeExpr = nativeNumberExpr(
				operator,
				numericOperand(left),
				numericOperand(right),
				this.context.facts?.inputIntegerRanges,
				this.scalarNumber(left),
				this.scalarNumber(right),
			);
			const int32Expr = INT32_RESULT_OPERATORS.has(operator)
				? nativeInt32Expr(
						operator,
						this.reps[left] === "int32"
							? this.inputValue(left)
							: numberToInt32(
									numericOperand(left),
									instructionInputIsInt32(this.context.facts, left),
								),
						this.reps[right] === "int32"
							? this.inputValue(right)
							: numberToInt32(
									numericOperand(right),
									instructionInputIsInt32(this.context.facts, right),
								),
					)
				: null;
			if (nativeExpr !== null) {
				const fast = this.profileCall(
					"boxing",
					operator === "+" &&
						bothBoxed &&
						numericInputs.masks.every((mask) => mask === COMPILER_VALUE_KIND_NUMBER)
						? `mal_ops_add_numbers(${this.boxed(left)}, ${this.boxed(right)})`
						: int32Expr !== null
							? `mal_value_from_i32(${int32Expr})`
							: `mal_ops_number_value(${nativeExpr})`,
				);
				if (numericInputs.guard === "") {
					this.elideFramePosition();
					return [`r${dst} = ${fast};`];
				}
				if (canThrow) {
					return [
						`if (${numericInputs.guard}) {`,
						`  r${dst} = ${fast};`,
						`} else {`,
						...this.slowPathFramePosition(),
						`  r${dst} = ${slow()};`,
						`  ${this.throwCheck()}`,
						`}`,
					];
				}
				return [`r${dst} = ${numericInputs.guard} ? ${fast} : ${slow()};`];
			}
		}
		const lowered = [`r${dst} = ${slow()};`];
		if (canThrow) {
			lowered.push(this.throwCheck());
		}
		return lowered;
	}
	emitKnownCall(
		instruction: Extract<BytecodeInstruction, { opcode: "CALL_KNOWN" }>,
	): Array<string> | null {
		const predicatePlan = this.context.numberPredicate;
		if (predicatePlan !== undefined) {
			const input = instruction.arguments[0];
			if (predicatePlan.mode === "non-number")
				return [this.storeBoolean(instruction.dst, "false")];
			if (predicatePlan.mode === "integer")
				return [
					this.storeBoolean(
						instruction.dst,
						instruction.operation === "Number.isNaN" ? "false" : "true",
					),
				];
			if (predicatePlan.mode === "number") {
				if (input === undefined)
					throw new Error("Missing planned Number predicate input");
				const number =
					this.nativeNumberOperand(input) ??
					`mal_ops_number_as_f64(${this.boxedOperand(input)})`;
				const predicate = nativeNumberPredicateExpression(instruction.operation, number);
				return [this.storeBoolean(instruction.dst, predicate)];
			}
			return [
				this.storeBoolean(
					instruction.dst,
					input === undefined
						? "false"
						: boxedNumberPredicateExpression(
								instruction.operation,
								this.boxedOperand(input),
							),
				),
			];
		}
		if (!instruction.construct && instruction.argumentMode === undefined) {
			const character = STRING_CHARACTER_KERNELS[instruction.operation];
			if (character !== undefined && this.operandIsString(instruction.thisValue)) {
				const operand = instruction.arguments[0];
				const position =
					operand === undefined || decodeVmValueOperand(operand).kind === "undefined"
						? "0.0"
						: this.nativeNumberOperand(operand);
				if (position !== null) {
					const result = `character_result_${this.ip}`;
					return [
						`MalValue ${result} = mal_builtin_string_character_numeric(vm, mal_value_to_string(${this.boxedOperand(instruction.thisValue)}), 0, mal_string_length(mal_value_to_string(${this.boxedOperand(instruction.thisValue)})), ${position}, MAL_STRING_CHARACTER_${character});`,
						`r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
						this.callPoll(),
					];
				}
			}
			if (["isNaN", "isFinite"].includes(instruction.operation)) {
				const input = instruction.arguments[0];
				const number = input === undefined ? "NAN" : this.nativeNumberOperand(input);
				if (number !== null)
					return [
						this.storeBoolean(
							instruction.dst,
							`${instruction.operation === "isNaN" ? "isnan" : "isfinite"}(${number})`,
						),
						this.callPoll(),
					];
			}
			if (["BigInt.asIntN", "BigInt.asUintN"].includes(instruction.operation)) {
				const width = instruction.arguments[0];
				const bits = width === undefined ? "0.0" : this.nativeNumberOperand(width);
				const input = instruction.arguments[1];
				if (bits !== null) {
					const result = `bigint_width_${this.ip}`;
					return [
						`MalValue ${result} = mal_builtin_bigint_width_number(vm, ${bits}, ${input === undefined ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(input)}, ${instruction.operation === "BigInt.asIntN"});`,
						this.throwCheck(),
						`r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
						this.callPoll(),
					];
				}
			}
			if (instruction.operation === "BigInt.prototype.toString") {
				const input = instruction.arguments[0];
				const option =
					input === undefined
						? { kind: "undefined" as const }
						: decodeVmValueOperand(input);
				const radix =
					option.kind === "undefined"
						? 10
						: option.kind === "number"
							? Math.trunc(option.value)
							: NaN;
				if (radix >= 2 && radix <= 36) {
					const result = `bigint_text_${this.ip}`;
					return [
						`MalValue ${result} = mal_builtin_bigint_to_string_radix(vm, ${this.boxedOperand(instruction.thisValue)}, ${radix});`,
						this.throwCheck(),
						`r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
						this.callPoll(),
					];
				}
			}
			if (instruction.operation === "String.prototype.charCodeAt") {
				const positionOperand = instruction.arguments[0];
				const position =
					positionOperand === undefined
						? "0.0"
						: this.nativeNumberOperand(positionOperand);
				if (this.operandIsString(instruction.thisValue) && position !== null) {
					this.context.stringLeafCaches.add(this.ip);
					return [
						`r${instruction.dst} = ${this.callValue(instruction.dst, this.profileCall("string", `mal_builtin_string_char_code_at_cached_number(vm, &__string_leaf_cache_${this.ip}, ${this.boxedOperand(instruction.thisValue)}, ${position})`))};`,
						this.callPoll(),
					];
				}
			}
			const format = NUMBER_FORMAT_KERNELS[instruction.operation];
			if (format !== undefined) {
				const receiver = this.nativeNumberOperand(instruction.thisValue);
				const option =
					instruction.arguments[0] === undefined
						? { kind: "undefined" as const }
						: decodeVmValueOperand(instruction.arguments[0]);
				const digits =
					option.kind === "undefined"
						? format[3]
						: option.kind === "number" &&
							  option.value >= format[1] &&
							  option.value <= format[2]
							? option.value
							: undefined;
				if (receiver !== null && digits !== undefined)
					return [
						`r${instruction.dst} = mal_builtin_number_to_${format[0]}_numeric(vm, ${receiver}, ${digits});`,
						this.callPoll(),
					];
			}
			if (
				["String.fromCharCode", "String.fromCodePoint"].includes(instruction.operation) &&
				instruction.arguments.length <= 64
			) {
				const arguments_ = instruction.arguments.map(this.nativeNumberOperand.bind(this));
				if (arguments_.every((argument) => argument !== null)) {
					const values =
						arguments_.length === 0 ? "nullptr" : `((f64[]){ ${arguments_.join(", ")} })`;
					const result = `codes_result_${this.ip}`;
					return [
						`MalValue ${result} = mal_builtin_string_from_codes_numbers(vm, ${values}, ${arguments_.length}, ${instruction.operation === "String.fromCodePoint" ? "true" : "false"});`,
						this.throwCheck(),
						`r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
						this.callPoll(),
					];
				}
			}
			if (instruction.operation === "Math.random") {
				return [
					this.storeNumber(instruction.dst, "mal_builtin_math_random_number()"),
					this.callPoll(),
				];
			}
			if (instruction.operation === "Math.sumPrecise") {
				const items = instruction.arguments[0];
				const result = `sum_result_${this.ip}`;
				return [
					`MalValue ${result} = mal_builtin_math_sum_precise_known(vm, ${items === undefined ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(items)});`,
					this.throwCheck(),
					`r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
					this.callPoll(),
				];
			}
			const numericKernel = MATH_NUMBER_KERNELS[instruction.operation];
			if (numericKernel !== undefined) {
				const arguments_ = Array.from({ length: numericKernel[1] }, (_, index) => {
					const operand = instruction.arguments[index];
					return operand === undefined ? "NAN" : this.nativeNumberOperand(operand);
				});
				if (arguments_.every((argument) => argument !== null)) {
					return [
						this.storeMathNumber(
							instruction.dst,
							instruction.operation,
							`${numericKernel[0]}(${arguments_.join(", ")})`,
						),
						this.callPoll(),
					];
				}
			}
			if (
				["Math.min", "Math.max", "Math.hypot"].includes(instruction.operation) &&
				instruction.arguments.length <= 64
			) {
				const arguments_ = instruction.arguments.map(this.nativeNumberOperand.bind(this));
				if (arguments_.every((argument) => argument !== null)) {
					const values =
						arguments_.length === 0 ? "nullptr" : `((f64[]){ ${arguments_.join(", ")} })`;
					const expression =
						arguments_.length === 2 && instruction.operation !== "Math.hypot"
							? nativeMathBinaryExpr(
									instruction.operation,
									arguments_[0]!,
									arguments_[1]!,
									this.context.facts?.inputIntegerRanges?.slice(1),
								)!
							: instruction.operation === "Math.hypot"
								? `mal_builtin_math_hypot_numbers(${values}, ${arguments_.length})`
								: `mal_builtin_math_min_max_numbers(${values}, ${arguments_.length}, ${instruction.operation === "Math.max" ? "true" : "false"})`;
					return [this.storeNumber(instruction.dst, expression), this.callPoll()];
				}
			}
			if (
				MATH_UNARY_NATIVE_CALL.has(instruction.operation) ||
				MATH_BINARY_OPERATIONS.has(instruction.operation)
			) {
				const arguments_ = instruction.arguments.map(this.nativeNumberOperand.bind(this));
				const expression =
					arguments_.length >= 1 && arguments_[0] !== null
						? nativeMathUnaryExpr(
								instruction.operation,
								arguments_[0]!,
								this.context.facts?.inputIntegerRanges?.[1],
							)
						: arguments_.length === 2 &&
							  arguments_.every((value) => value !== null) &&
							  MATH_BINARY_OPERATIONS.has(instruction.operation)
							? nativeMathBinaryExpr(
									instruction.operation,
									arguments_[0]!,
									arguments_[1]!,
								)
							: null;
				if (expression !== null)
					return [this.storeNumber(instruction.dst, expression), this.callPoll()];
			}
		}
		if (
			instruction.operation === "RegExp" &&
			instruction.construct &&
			instruction.argumentMode === undefined &&
			instruction.arguments.length === 2
		) {
			const [pattern, flags] = instruction.arguments.map(decodeVmValueOperand);
			// With two strings, constructing %RegExp% as its own new.target is RegExpCreate:
			// IsRegExp is false and %RegExp%.prototype is non-writable and non-configurable.
			if (pattern?.kind === "string" && flags?.kind === "string") {
				const value = `known_result_${this.ip}`;
				return [
					`MalValue ${value} = mal_regexp_create(vm, &vm->runtime_image->string_constants[${this.context.relocation.stringIndex(pattern.index)}], &vm->runtime_image->string_constants[${this.context.relocation.stringIndex(flags.index)}]);`,
					this.throwCheck(),
					`r${instruction.dst} = ${this.callValue(instruction.dst, value)};`,
					this.callPoll(),
				];
			}
		}
		if (
			!instruction.construct &&
			instruction.argumentMode === undefined &&
			OBJECT_BRAND_PREDICATES.has(instruction.operation)
		) {
			const argument = instruction.arguments[0];
			const predicate = nativeObjectBrandPredicateExpression(
				instruction.operation,
				argument === undefined ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(argument),
			);
			if (predicate !== undefined) return [this.storeBoolean(instruction.dst, predicate)];
		}
		if (
			instruction.specialized === undefined &&
			!(
				(instruction.operation === "String.prototype.split" ||
					NUMBER_PREDICATES.has(instruction.operation)) &&
				!instruction.construct &&
				instruction.argumentMode === undefined
			)
		) {
			const args = instruction.arguments.map(this.boxedOperand.bind(this));
			const arguments_ =
				args.length === 0 ? "nullptr" : `((MalValue[]){ ${args.join(", ")} })`;
			const value = `known_result_${this.ip}`;
			const fallback = [
				`MalValue ${value} = mal_vm_call_known_native(vm, ${knownNativeEntries()[knownOperationIndex(instruction.operation)!]}, ${knownOperationIndex(instruction.operation)}, ${this.boxedOperand(instruction.thisValue)}, ${arguments_}, ${args.length}, ${knownOperationFlags(instruction)});`,
				this.throwCheck(),
				`r${instruction.dst} = ${this.callValue(instruction.dst, value)};`,
				this.callPoll(),
			];
			if (!instruction.construct && instruction.argumentMode === undefined) {
				let guard: string | undefined;
				let direct: Array<string> | undefined;
				const first = instruction.arguments[0];
				const second = instruction.arguments[1];
				const numericKernel = MATH_NUMBER_KERNELS[instruction.operation];
				if (numericKernel !== undefined) {
					const guards: Array<string> = [];
					const numbers = Array.from({ length: numericKernel[1] }, (_, index) => {
						const operand = instruction.arguments[index];
						if (operand === undefined) return "NAN";
						const numeric = this.nativeNumberOperand(operand);
						if (numeric !== null) return numeric;
						const value = this.boxedOperand(operand);
						guards.push(`mal_ops_is_number(${value})`);
						return `mal_ops_number_as_f64(${value})`;
					});
					guard = guards.length === 0 ? "true" : guards.join(" && ");
					direct = [
						this.storeMathNumber(
							instruction.dst,
							instruction.operation,
							`${numericKernel[0]}(${numbers.join(", ")})`,
						),
						this.callPoll(),
					];
				} else if (
					(MATH_UNARY_NATIVE_CALL.has(instruction.operation) && first !== undefined) ||
					(MATH_BINARY_OPERATIONS.has(instruction.operation) &&
						instruction.arguments.length === 2)
				) {
					// Only a non-Number argument reaches ToNumber and its observable coercion.
					const guards: Array<string> = [];
					const number = (operand: number): string => {
						const numeric = this.nativeNumberOperand(operand);
						if (numeric !== null) return numeric;
						const value = this.boxedOperand(operand);
						guards.push(`mal_ops_is_number(${value})`);
						return `mal_ops_number_as_f64(${value})`;
					};
					const expression = MATH_BINARY_OPERATIONS.has(instruction.operation)
						? nativeMathBinaryExpr(
								instruction.operation,
								number(first!),
								number(second!),
								this.context.facts?.inputIntegerRanges?.slice(1),
							)
						: nativeMathUnaryExpr(
								instruction.operation,
								number(first!),
								instructionInputIntegerRange(this.context.facts, first!),
							);
					if (expression !== null) {
						guard = guards.length === 0 ? "true" : guards.join(" && ");
						direct = [
							this.storeMathNumber(instruction.dst, instruction.operation, expression),
							this.callPoll(),
						];
					}
				} else if (
					["parseInt", "parseFloat"].includes(instruction.operation) &&
					first !== undefined
				) {
					const source = this.boxedOperand(first);
					const omittedRadix =
						instruction.operation === "parseFloat" ||
						second === undefined ||
						decodeVmValueOperand(second).kind === "undefined";
					const radix = omittedRadix ? "0.0" : this.nativeNumberOperand(second);
					const guards = this.operandIsString(first)
						? []
						: [`mal_value_is_string(${source})`];
					if (radix === null)
						guards.push(`mal_ops_is_number(${this.boxedOperand(second!)})`);
					const number = radix ?? `mal_ops_number_as_f64(${this.boxedOperand(second!)})`;
					const expression =
						instruction.operation === "parseInt"
							? `mal_builtin_parse_int_string(${source}, ${number})`
							: `mal_builtin_parse_float_string(${source})`;
					guard = guards.length === 0 ? "true" : guards.join(" && ");
					direct = [this.storeNumber(instruction.dst, expression), this.callPoll()];
				} else if (instruction.operation === "Array.isArray" && first !== undefined) {
					// Only a proxy needs IsArray's unwrapping and its revoked-proxy TypeError.
					const input = this.boxedOperand(first);
					guard = `!mal_value_is_heap_type(${input}, MAL_HEAP_PROXY_OBJECT)`;
					direct = [
						this.storeBoolean(instruction.dst, `mal_value_is_array_object(${input})`),
						this.callPoll(),
					];
				} else if (
					["isNaN", "isFinite"].includes(instruction.operation) &&
					first !== undefined
				) {
					const input = this.boxedOperand(first);
					guard = `mal_ops_is_number(${input})`;
					direct = [
						this.storeBoolean(
							instruction.dst,
							`${instruction.operation === "isNaN" ? "isnan" : "isfinite"}(mal_ops_number_as_f64(${input}))`,
						),
						this.callPoll(),
					];
				} else if (
					["BigInt.asIntN", "BigInt.asUintN"].includes(instruction.operation) &&
					first !== undefined
				) {
					const width = this.boxedOperand(first);
					const result = `bigint_width_${this.ip}`;
					guard = `mal_ops_is_number(${width})`;
					direct = [
						`MalValue ${result} = mal_builtin_bigint_width_number(vm, mal_ops_number_as_f64(${width}), ${second === undefined ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(second)}, ${instruction.operation === "BigInt.asIntN"});`,
						this.throwCheck(),
						`r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
						this.callPoll(),
					];
				} else if (
					instruction.operation === "BigInt.prototype.toString" &&
					first !== undefined
				) {
					const radix = this.boxedOperand(first);
					const numeric = this.nativeNumberOperand(first);
					const number = numeric ?? `mal_ops_number_as_f64(${radix})`;
					const result = `bigint_text_${this.ip}`;
					guard = `${numeric === null ? `mal_ops_is_number(${radix}) && ` : ""}${number} >= 2.0 && ${number} < 37.0`;
					direct = [
						`MalValue ${result} = mal_builtin_bigint_to_string_radix(vm, ${this.boxedOperand(instruction.thisValue)}, (i32) ${number});`,
						this.throwCheck(),
						`r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
						this.callPoll(),
					];
				}
				if (direct !== undefined && guard !== undefined) {
					if (guard === "true") return direct;
					return [
						`if (${guard}) {`,
						...direct.map((line) => `  ${line}`),
						`} else {`,
						...fallback.map((line) => `  ${line}`),
						`}`,
					];
				}
			}
			const uri = URI_KERNELS[instruction.operation];
			if (
				uri !== undefined &&
				!instruction.construct &&
				instruction.argumentMode === undefined &&
				instruction.arguments[0] !== undefined
			) {
				const input = instruction.arguments[0];
				const value = this.boxedOperand(input);
				const result = `uri_result_${this.ip}`;
				const direct = [
					`MalValue ${result} = mal_builtin_uri_${uri[0]}_known(vm, mal_value_to_string(${value})${uri[1] === undefined ? "" : `, ${uri[1]}`});`,
					this.throwCheck(),
					`r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
					this.callPoll(),
				];
				if (this.operandIsString(input)) return direct;
				return [
					`if (mal_value_is_string(${value})) {`,
					...direct.map((line) => `  ${line}`),
					`} else {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (
				["String.prototype.replace", "String.prototype.replaceAll"].includes(
					instruction.operation,
				) &&
				!instruction.construct &&
				instruction.argumentMode === undefined &&
				instruction.arguments[0] !== undefined
			) {
				const receiver = this.boxedOperand(instruction.thisValue);
				const search = this.boxedOperand(instruction.arguments[0]);
				const replacement = instruction.arguments[1];
				const result = `replace_result_${this.ip}`;
				const direct = [
					`MalValue ${result} = mal_builtin_string_replace_known(vm, mal_value_to_string(${receiver}), mal_value_to_string(${search}), ${replacement === undefined ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(replacement)}, ${instruction.operation === "String.prototype.replaceAll"});`,
					this.throwCheck(),
					`r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
					this.callPoll(),
				];
				const guards = [
					...(this.operandIsString(instruction.thisValue)
						? []
						: [`mal_value_is_string(${receiver})`]),
					...(this.operandIsString(instruction.arguments[0])
						? []
						: [`mal_value_is_string(${search})`]),
				];
				if (guards.length === 0) return direct;
				return [
					`if (${guards.join(" && ")}) {`,
					...direct.map((line) => `  ${line}`),
					`} else {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			const transform = this.context.stringTransform;
			if (transform !== undefined) {
				const receiver = this.boxedOperand(instruction.thisValue);
				const string = `mal_value_to_string(${receiver})`;
				let expression: string;
				switch (transform.kind) {
					case "html": {
						const first = instruction.arguments[0];
						expression = `mal_builtin_string_html_known(vm, ${string}, ${first === undefined ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(first)}, "${transform.tag}", ${transform.attribute === undefined ? "nullptr" : `"${transform.attribute}"`})`;
						break;
					}
					case "trim":
						expression = `mal_builtin_string_trim_known(vm, ${string}, ${transform.start}, ${transform.end})`;
						break;
					case "is-well-formed":
						expression = `mal_builtin_string_is_well_formed_known(${string})`;
						break;
					case "to-well-formed":
						expression = `mal_builtin_string_to_well_formed_known(vm, ${string})`;
						break;
					case "normalize":
						expression = `mal_builtin_string_normalize_known(vm, ${string}, ${transform.form.includes("K")}, ${transform.form.endsWith("C")})`;
						break;
					case "case": {
						const locale =
							transform.locale === "turkic"
								? "(MAL_INTL ? MAL_UNICODE_LOCALE_TURKIC : MAL_UNICODE_LOCALE_ROOT)"
								: transform.locale === "lithuanian"
									? "(MAL_INTL ? MAL_UNICODE_LOCALE_LITHUANIAN : MAL_UNICODE_LOCALE_ROOT)"
									: "MAL_UNICODE_LOCALE_ROOT";
						expression = `mal_builtin_string_case_known(vm, ${string}, ${transform.upper}, ${locale})`;
						break;
					}
				}
				const result = `string_transform_${this.ip}`;
				const direct = [
					`MalValue ${result} = ${expression};`,
					this.throwCheck(),
					`r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
					this.callPoll(),
				];
				if (transform.receiver === "string") return direct;
				return [
					`if (mal_value_is_string(${receiver})) {`,
					...direct.map((line) => `  ${line}`),
					`} else {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (
				instruction.operation === "String.prototype.concat" &&
				!instruction.construct &&
				instruction.argumentMode === undefined
			) {
				const result = `concat_result_${this.ip}`;
				return [
					`MalValue ${result};`,
					`if (mal_builtin_string_concat_direct(vm, ${this.boxedOperand(instruction.thisValue)}, ${arguments_}, ${args.length}, &${result})) {`,
					`  ${this.throwCheck()}`,
					`  r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
					`  ${this.callPoll()}`,
					`} else {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (
				["String.prototype.padStart", "String.prototype.padEnd"].includes(
					instruction.operation,
				) &&
				!instruction.construct &&
				instruction.argumentMode === undefined
			) {
				const operand = instruction.arguments[0];
				const length =
					operand === undefined || decodeVmValueOperand(operand).kind === "undefined"
						? "0.0"
						: this.nativeNumberOperand(operand);
				if (length !== null) {
					const receiver = this.boxedOperand(instruction.thisValue);
					const fill = instruction.arguments[1];
					const result = `pad_result_${this.ip}`;
					const direct = [
						`MalValue ${result} = mal_builtin_string_pad_numeric(vm, mal_value_to_string(${receiver}), ${length}, ${fill === undefined ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(fill)}, ${instruction.operation === "String.prototype.padStart" ? "true" : "false"});`,
						this.throwCheck(),
						`r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
						this.callPoll(),
					];
					if (this.operandIsString(instruction.thisValue)) return direct;
					return [
						`if (mal_value_is_string(${receiver})) {`,
						...direct.map((line) => `  ${line}`),
						`} else {`,
						...fallback.map((line) => `  ${line}`),
						`}`,
					];
				}
			}
			const range = STRING_RANGE_KERNELS[instruction.operation];
			if (
				(range !== undefined || instruction.operation === "String.prototype.repeat") &&
				!instruction.construct &&
				instruction.argumentMode === undefined &&
				this.context.nativeStringSpanAction === undefined
			) {
				const position = (index: number, fallback: string) => {
					const operand = instruction.arguments[index];
					return operand === undefined ||
						decodeVmValueOperand(operand).kind === "undefined"
						? fallback
						: this.nativeNumberOperand(operand);
				};
				const start = position(0, "0.0");
				const end = range === undefined ? "0.0" : position(1, "INFINITY");
				if (start !== null && end !== null) {
					const receiver = this.boxedOperand(instruction.thisValue);
					const result = `range_result_${this.ip}`;
					const expression =
						range === undefined
							? `mal_builtin_string_repeat_numeric(vm, mal_value_to_string(${receiver}), ${start})`
							: `mal_builtin_string_range_numeric(vm, mal_value_to_string(${receiver}), ${start}, ${end}, MAL_STRING_RANGE_${range})`;
					const direct = [
						`MalValue ${result} = ${expression};`,
						this.throwCheck(),
						`r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
						this.callPoll(),
					];
					if (this.operandIsString(instruction.thisValue)) return direct;
					return [
						`if (mal_value_is_string(${receiver})) {`,
						...direct.map((line) => `  ${line}`),
						`} else {`,
						...fallback.map((line) => `  ${line}`),
						`}`,
					];
				}
			}
			const search = STRING_SEARCH_KERNELS[instruction.operation];
			const character = STRING_CHARACTER_KERNELS[instruction.operation];
			if (
				character !== undefined &&
				!instruction.construct &&
				instruction.argumentMode === undefined
			) {
				const positionOperand = instruction.arguments[0];
				const position =
					positionOperand === undefined ||
					decodeVmValueOperand(positionOperand).kind === "undefined"
						? "0.0"
						: this.nativeNumberOperand(positionOperand);
				if (position !== null) {
					const result = `character_result_${this.ip}`;
					return [
						`MalValue ${result};`,
						`if (mal_builtin_string_character_direct(vm, ${this.boxedOperand(instruction.thisValue)}, ${position}, MAL_STRING_CHARACTER_${character}, &${result})) {`,
						`  r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
						`  ${this.callPoll()}`,
						`} else {`,
						...fallback.map((line) => `  ${line}`),
						`}`,
					];
				}
			}
			if (
				search !== undefined &&
				!instruction.construct &&
				instruction.argumentMode === undefined &&
				instruction.arguments[0] !== undefined
			) {
				const positionOperand = instruction.arguments[1];
				const position =
					positionOperand === undefined ||
					decodeVmValueOperand(positionOperand).kind === "undefined"
						? search[1]
						: this.nativeNumberOperand(positionOperand);
				if (position !== null) {
					const result = `search_result_${this.ip}`;
					if (
						this.operandIsString(instruction.thisValue) &&
						this.operandIsString(instruction.arguments[0])
					) {
						return [
							`MalValue ${result} = mal_builtin_string_search_strings(mal_value_to_string(${this.boxedOperand(instruction.thisValue)}), 0, mal_string_length(mal_value_to_string(${this.boxedOperand(instruction.thisValue)})), mal_value_to_string(${this.boxedOperand(instruction.arguments[0])}), ${position}, MAL_STRING_SEARCH_${search[0]});`,
							`r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
							this.callPoll(),
						];
					}

					return [
						`MalValue ${result};`,
						`if (mal_builtin_string_search_direct(${this.boxedOperand(instruction.thisValue)}, ${this.boxedOperand(instruction.arguments[0])}, ${position}, MAL_STRING_SEARCH_${search[0]}, &${result})) {`,
						`  r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
						`  ${this.callPoll()}`,
						`} else {`,
						...fallback.map((line) => `  ${line}`),
						`}`,
					];
				}
			}

			if (
				this.context.nativeRegExpExecProjectionAction?.role === "number" ||
				this.context.nativeRegExpIteratorProjectionAction?.role === "number"
			) {
				const exec =
					this.context.nativeRegExpExecProjectionAction?.role === "number"
						? this.context.nativeRegExpExecProjectionAction
						: undefined;
				const iterator =
					this.context.nativeRegExpIteratorProjectionAction?.role === "number"
						? this.context.nativeRegExpIteratorProjectionAction
						: undefined;
				const action = exec ?? iterator!;
				const slot = action.site.loads.findIndex((entry) => entry.ip === action.load?.ip);
				if (slot >= 0) {
					const prefix =
						exec === undefined
							? `__regexp_iter_${iterator!.site.projection.stepIp}`
							: `__regexp_exec_${exec.site.projection.callIp}`;
					const start = `${prefix}_starts[${slot}]`,
						end = `${prefix}_ends[${slot}]`;
					const parsed = `mal_ops_string_range_to_number(mal_value_to_string(__gc_slots[${action.site.subjectSlot}]), (usize) ${start}, (usize) (${end} - ${start}))`;
					return [
						`if (${prefix}_projected) {`,
						`  r${instruction.dst} = ${start} < 0 ? ${this.reps[instruction.dst] === "number" ? "NAN" : "mal_value_new_nan()"} : ${this.reps[instruction.dst] === "number" ? `mal_ops_number_as_f64(${parsed})` : parsed};`,
						`} else {`,
						...fallback.map((line) => `  ${line}`),
						`}`,
						this.callPoll(),
					];
				}
			}
			if (this.context.nativeRegExpExecProjectionAction?.role === "call") {
				const { site } = this.context.nativeRegExpExecProjectionAction;
				const projection = site.projection;
				const indices = site.loads.map((load) => load.captureIndex).join(", ");
				const outputs = site.loads
					.map((_load, index) => `&__gc_slots[${site.slotsOffset + index}]`)
					.join(", ");
				const spanMask = site.spanMask;
				const parameters = `vm, ${this.boxedOperand(instruction.thisValue)}, ${this.boxedOperand(instruction.arguments[0]!)}, (const u32[]){ ${indices} }, (MalValue *[]){ ${outputs} }, ${site.loads.length}, ${spanMask}, __regexp_exec_${projection.callIp}_starts, __regexp_exec_${projection.callIp}_ends, &__gc_slots[${site.subjectSlot}], &r${instruction.dst}`;
				if (projection.lockedFreshLiteral)
					return [
						`__regexp_exec_${projection.callIp}_projected = false;`,
						`${this.profileCall("regexp", `mal_regexp_exec_capture_projection_locked(${parameters})`)};`,
						this.throwCheck(),
						`__regexp_exec_${projection.callIp}_projected = mal_value_is_boolean(r${instruction.dst});`,
						this.callPoll(),
					];
				const callee = `mal_vm_load_primordial(vm, ${knownOperations()[knownOperationIndex(instruction.operation)!]!.node})`;
				return [
					`__regexp_exec_${projection.callIp}_projected = false;`,
					`if (${this.profileCall("regexp", `mal_regexp_exec_capture_projection(vm, ${callee}, ${parameters.slice(4)})`)}) {`,
					`  ${this.throwCheck()}`,
					`  __regexp_exec_${projection.callIp}_projected = mal_value_is_boolean(r${instruction.dst});`,
					`} else {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
					this.callPoll(),
				];
			}
			return fallback;
		}

		const argsExpr = instruction.arguments.length
			? `((MalValue[]){ ${instruction.arguments.map(this.boxedOperand.bind(this)).join(", ")} })`
			: "nullptr";
		if (instruction.operation === "Array.prototype.push") {
			const receiver = this.boxedOperand(instruction.thisValue);
			const pushed = [
				`r${instruction.dst} = mal_builtin_array_push_contained(vm, ${receiver}, ${argsExpr}, ${instruction.arguments.length});`,
				this.throwCheck(),
			];
			if (instruction.arguments.length !== 1) return [...pushed, this.callPoll()];
			return [
				`if (mal_vm_array_contained_push_one(${receiver}, ${this.boxedOperand(instruction.arguments[0]!)})) {`,
				`  ${this.storeNumber(instruction.dst, `(f64) mal_value_to_array_object(${receiver})->length`)}`,
				"} else {",
				...pushed.map((line) => `  ${line}`),
				"}",
				this.callPoll(),
			];
		}
		// Popping a contained Array cannot throw or allocate.
		if (instruction.operation === "Array.prototype.pop") {
			return [
				`r${instruction.dst} = mal_builtin_array_pop_contained(vm, ${this.boxedOperand(instruction.thisValue)});`,
			];
		}
		if (instruction.operation === "Object.hasOwn") {
			return [
				...this.boxedLoad(
					instruction.dst,
					`mal_builtin_object_has_own_known(vm, ${argsExpr}, ${instruction.arguments.length})`,
				),
				this.callPoll(),
			];
		}
		if (instruction.operation === "Object.is") {
			const [left, right] = instruction.arguments;
			return [
				this.storeBoolean(
					instruction.dst,
					nativeStringComparisonExpression(
						this.context.stringComparisons?.get(this.ip),
						left!,
						left === undefined ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(left),
						right === undefined ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(right),
					) ??
						nativeEqualityExpression(
							"same-value",
							left === undefined ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(left),
							right === undefined ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(right),
							left === undefined ? COMPILER_VALUE_KIND_UNDEFINED : this.operandKind(left),
							right === undefined
								? COMPILER_VALUE_KIND_UNDEFINED
								: this.operandKind(right),
							left === undefined
								? undefined
								: (this.nativeNumberOperand(left) ??
										this.nativeBooleanOperand(left) ??
										this.nativeStringOperand(left) ??
										undefined),
							right === undefined
								? undefined
								: (this.nativeNumberOperand(right) ??
										this.nativeBooleanOperand(right) ??
										this.nativeStringOperand(right) ??
										undefined),
							left !== undefined &&
								right !== undefined &&
								this.operandRep(left) === "int32" &&
								this.operandRep(right) === "int32",
							left === undefined
								? undefined
								: instructionInputIntegerRange(this.context.facts, left),
							right === undefined
								? undefined
								: instructionInputIntegerRange(this.context.facts, right),
						),
				),
			];
		}
		if (instruction.operation === "Object.keys") {
			return [
				`r${instruction.dst} = mal_builtin_object_keys_known(vm, ${argsExpr}, ${instruction.arguments.length});`,
				this.throwCheck(),
				this.callPoll(),
			];
		}
		if (instruction.operation === "Object.values") {
			return [
				`r${instruction.dst} = mal_builtin_object_values_known(vm, ${argsExpr}, ${instruction.arguments.length});`,
				this.throwCheck(),
				this.callPoll(),
			];
		}
		if (instruction.operation === "String.prototype.charCodeAt") {
			this.context.stringLeafCaches.add(this.ip);
			const result = `char_code_result_${this.ip}`;
			return [
				`MalValue ${result} = ${this.profileCall("string", `mal_builtin_string_char_code_at_known(vm, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length}, &__string_leaf_cache_${this.ip})`)};`,
				this.throwCheck(),
				`r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
				this.callPoll(),
			];
		}
		const collectionCall = this.fixedCollectionCall(
			instruction.operation,
			instruction.dst,
			instruction.thisValue,
			instruction.arguments,
		);
		if (collectionCall !== null) return [collectionCall, this.callPoll()];
		if (NUMBER_PREDICATES.has(instruction.operation)) {
			const input = instruction.arguments[0];
			return [
				this.storeBoolean(
					instruction.dst,
					input === undefined
						? "false"
						: boxedNumberPredicateExpression(
								instruction.operation,
								this.boxedOperand(input),
							),
				),
			];
		}
		if (instruction.operation === "Number.prototype.valueOf") {
			const value = this.nativeNumberOperand(instruction.thisValue);
			if (value !== null) return [this.storeNumber(instruction.dst, value)];
			return [
				`r${instruction.dst} = ${this.callValue(instruction.dst, `mal_builtin_number_value_of_known(${this.boxedOperand(instruction.thisValue)})`)};`,
			];
		}
		if (instruction.operation === "Boolean.prototype.valueOf") {
			const value = this.nativeBooleanOperand(instruction.thisValue);
			if (value !== null) return [this.storeBoolean(instruction.dst, value)];
			return [
				`r${instruction.dst} = ${this.callValue(instruction.dst, `mal_builtin_boolean_value_of_known(${this.boxedOperand(instruction.thisValue)})`)};`,
			];
		}
		if (instruction.operation === "Date.now") {
			return [
				`r${instruction.dst} = ${this.callValue(instruction.dst, "mal_builtin_date_now_known()")};`,
			];
		}
		if (instruction.operation === "Date.parse") {
			return [
				...this.boxedLoad(
					instruction.dst,
					`mal_builtin_date_parse_known(vm, ${argsExpr}, ${instruction.arguments.length})`,
				),
				this.callPoll(),
			];
		}
		if (instruction.operation === "Date.UTC") {
			return [
				...this.boxedLoad(
					instruction.dst,
					`mal_builtin_date_utc_known(vm, ${argsExpr}, ${instruction.arguments.length})`,
				),
				this.callPoll(),
			];
		}
		if (instruction.operation !== "String.prototype.split") return null;
		if (this.context.nativeStringSplitCursorAction?.role === "call") {
			const { site } = this.context.nativeStringSplitCursorAction;
			const id = site.callIp;
			return [
				`__string_split_cursor_${id}_active = ${this.profileCall("string", `mal_builtin_string_split_cursor_init_locked(vm, ${this.boxedOperand(instruction.thisValue)}, ${this.boxedOperand(instruction.arguments[0]!)}, &__gc_slots[${site.subjectSlot}], &__gc_slots[${site.traversalSlot}], &__string_split_cursor_${id}_state)`)};`,
				`if (__string_split_cursor_${id}_active) {`,
				`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
				`} else {`,
				`  r${instruction.dst} = ${this.profileCall("string", `mal_builtin_string_split_direct(vm, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length})`)};`,
				`}`,
				this.throwCheck(),
				this.callPoll(),
			];
		}
		if (this.context.nativeStringSplitProjectionAction?.role === "call") {
			const { site } = this.context.nativeStringSplitProjectionAction;
			const projection = site.projection;
			const fast = `__string_split_${projection.callIp}_fast`;
			const indices = site.elementLoads.map((load) => load.index).join(", ");

			return [
				`__gc_slots[${site.subjectSlot}] = ${this.boxedOperand(instruction.thisValue)};`,
				...site.elementLoads.map(
					(_, index) => `__gc_slots[${site.slotsOffset + index}] = MAL_VALUE_UNDEFINED;`,
				),
				`${fast} = ${this.profileCall("string", `mal_builtin_string_split_projection_locked(vm, ${this.boxedOperand(instruction.thisValue)}, ${this.boxedOperand(instruction.arguments[0]!)}, (const u32[]){ ${indices} }, __string_split_${projection.callIp}_starts, __string_split_${projection.callIp}_ends, ${site.elementLoads.length}, &__string_split_${projection.callIp}_length)`)};`,
				`if (${fast}) {`,
				`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
				`} else {`,
				`  r${instruction.dst} = ${this.profileCall("string", `mal_builtin_string_split_direct(vm, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length})`)};`,
				`}`,
				this.throwCheck(),
				this.callPoll(),
			];
		}
		return [
			`r${instruction.dst} = ${this.profileCall("string", `mal_builtin_string_split_direct(vm, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length})`)};`,
			this.throwCheck(),
			this.callPoll(),
		];
	}
	emitCall(
		instruction: Extract<BytecodeInstruction, { opcode: "CALL" }>,
	): Array<string> | null {
		const callPlan =
			this.context.nativePlan?.kind === "call" ? this.context.nativePlan : undefined;
		const args = instruction.arguments;
		const argsExpr =
			args.length === 0
				? "nullptr"
				: `((MalValue[]){ ${args.map(this.boxedOperand.bind(this)).join(", ")} })`;
		const tmp = `call_result_${this.ip}`;
		const callResult = (value: string): string => this.callValue(instruction.dst, value);
		const calleeOperand = decodeVmValueOperand(instruction.callee);
		if (
			calleeOperand.kind === "register" &&
			this.context.iterationEligibilityRegisters?.has(calleeOperand.register) === true &&
			args.length === 4
		) {
			const callee = this.boxedOperand(instruction.callee);
			return [
				`if (${callee} == vm->intrinsics[MAL_INTRINSIC_ARRAY_ITERATION_ELIGIBLE]) {`,
				`  r${instruction.dst} = ${callResult(`mal_value_new_boolean(mal_builtin_array_iteration_eligible_values(vm, ${argsExpr}))`)};`,
				`} else {`,
				`  MalCompletion ${tmp} = mal_vm_call_cached(vm, ${callee}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
				`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`  r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
				`}`,
				this.callPoll(),
			];
		}
		if (this.context.nativeStringCharCodeAtChainAction?.role === "call") {
			const { chain } = this.context.nativeStringCharCodeAtChainAction;
			const captured = `__string_char_code_at_${chain.callIp}_captured`;
			const boundedArgument =
				args.length === 1 ? decodeVmValueOperand(args[0]!) : undefined;
			const boundedPosition =
				callPlan?.directStringCharCodeAtPosition === "inBounds" &&
				boundedArgument?.kind === "register" &&
				isNumericRep(this.reps[boundedArgument.register]!)
					? this.num(boundedArgument.register)
					: undefined;
			if (boundedPosition !== undefined) {
				this.context.stringLeafCaches.add(this.ip);
				const direct = this.profileCall(
					"string",
					`mal_builtin_string_char_code_at_cached_in_bounds(vm, &__string_leaf_cache_${this.ip}, ${this.boxedOperand(instruction.thisValue)}, (usize) ${boundedPosition})`,
				);
				return [
					`if (${captured}) {`,
					`  r${instruction.dst} = ${callResult(direct)};`,
					`} else {`,
					`  MAL_PERF_COUNT(string_char_code_at_direct_fallbacks);`,
					`  MalCompletion ${tmp} = ${this.profileCall("call", `mal_vm_call_cached(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
					`  r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
					`}`,
					this.callPoll(),
				];
			}
			if (chain.methodIdentity === "authority-invariant") {
				const value = `string_char_code_at_${this.ip}_value`;
				this.context.stringLeafCaches.add(this.ip);
				return [
					`if (${captured}) {`,
					`  MalValue ${value} = ${this.profileCall("string", `mal_builtin_string_char_code_at_known(vm, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length}, &__string_leaf_cache_${this.ip})`)};`,
					`  ${this.throwCheck()}`,
					`  r${instruction.dst} = ${callResult(value)};`,
					`} else {`,
					`  MAL_PERF_COUNT(string_char_code_at_direct_fallbacks);`,
					`  MalCompletion ${tmp} = ${this.profileCall("call", `mal_vm_call_cached(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
					`  r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
					`}`,
					this.callPoll(),
				];
			}
			this.context.stringLeafCaches.add(this.ip);
			return [
				`MalCompletion ${tmp};`,
				`if (${captured}) {`,
				`  ${tmp} = ${this.profileCall("string", `mal_builtin_string_char_code_at_direct(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length}, &__string_leaf_cache_${this.ip})`)};`,
				`} else {`,
				`  MAL_PERF_COUNT(string_char_code_at_direct_fallbacks);`,
				`  ${tmp} = ${this.profileCall("call", `mal_vm_call_cached(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
				`}`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
				this.callPoll(),
			];
		}
		if (this.context.nativeStringSplitCursorAction?.role === "call") {
			const { site, propertyLoad } = this.context.nativeStringSplitCursorAction;
			const id = site.callIp;
			const admission = regionAdmissionGuard(
				site.cursor.license,
				site.semanticEpochStable ? undefined : site.epochName,
			);
			const trimIdentity =
				site.trimCalleeSlot === undefined
					? "true"
					: `mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &${nativeBodyReference(this.context.resources, "propertyCache")}[${site.cursor.trimIcIndex}], &__gc_slots[${site.trimCalleeSlot}]) && ${this.profileCall("string", `mal_builtin_string_trim_identity(vm, __gc_slots[${site.trimCalleeSlot}])`)}`;
			const initialize = site.lockedIdentity
				? this.profileCall(
						"string",
						`mal_builtin_string_split_cursor_init_locked(vm, ${this.boxedOperand(instruction.thisValue)}, ${this.boxedOperand(instruction.arguments[0]!)}, &__gc_slots[${site.subjectSlot}], &__gc_slots[${site.traversalSlot}], &__string_split_cursor_${id}_state)`,
					)
				: `${admission} && ${trimIdentity} && ${this.profileCall("string", `mal_builtin_string_split_cursor_init(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${this.boxedOperand(instruction.arguments[0]!)}, &__gc_slots[${site.subjectSlot}], &__gc_slots[${site.traversalSlot}], &__string_split_cursor_${id}_state)`)}`;
			return [
				`__string_split_cursor_${id}_active = ${initialize};`,
				`if (__string_split_cursor_${id}_active) {`,
				`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
				`} else {`,
				...(propertyLoad === undefined
					? []
					: [
							`  r${propertyLoad.dst} = ${this.profileCall("property", `mal_vm_op_load_property_ic(vm, ${this.boxedOperand(propertyLoad.object)}, mal_value_from_string(vm->string_constant_atoms[${this.context.relocation.stringIndex(propertyLoad.stringIndex)}]), &${nativeBodyReference(this.context.resources, "propertyCache")}[${propertyLoad.icIndex}])`)};`,
							`  ${this.throwCheck()}`,
						]),
				`  MalCompletion ${tmp} = ${this.profileCall("call", `mal_vm_call_cached(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
				`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`  r${instruction.dst} = ${tmp}.value;`,
				`}`,
				this.callPoll(),
			];
		}
		if (this.context.nativeStringSplitCursorAction?.role === "trimCall") {
			const id = this.context.nativeStringSplitCursorAction.site.callIp;
			return [
				`if (__string_split_cursor_${id}_active && __string_split_cursor_${id}_trim_fast) {`,
				`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
				`} else {`,
				`  MalCompletion ${tmp} = ${this.profileCall("call", `mal_vm_call_cached(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
				`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`  r${instruction.dst} = ${tmp}.value;`,
				`}`,
				this.callPoll(),
			];
		}
		if (
			this.context.nativeRegExpExecProjectionAction?.role === "caseUpperCall" ||
			this.context.nativeRegExpExecProjectionAction?.role === "caseLowerCall"
		) {
			const { site, load } = this.context.nativeRegExpExecProjectionAction;
			if (load?.consumer?.kind === "asciiCaseLength") {
				const fast = `__regexp_exec_${site.projection.callIp}_case_${load.consumer.upperCallIp}_fast`;
				return [
					`if (${fast}) {`,
					`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
					`} else {`,
					`  MalCompletion ${tmp} = ${this.profileCall("call", `mal_vm_call_cached(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
					`  r${instruction.dst} = ${tmp}.value;`,
					`}`,
					this.callPoll(),
				];
			}
		}
		if (this.context.nativeRegExpIteratorProjectionAction?.role === "number") {
			const { site, load } = this.context.nativeRegExpIteratorProjectionAction;
			const slot = site.loads.findIndex((entry) => entry.ip === load?.ip);
			if (slot >= 0) {
				const start = `__regexp_iter_${site.projection.stepIp}_starts[${slot}]`;
				const end = `__regexp_iter_${site.projection.stepIp}_ends[${slot}]`;
				const parsed = `mal_ops_string_range_to_number(mal_value_to_string(__gc_slots[${site.subjectSlot}]), (usize) ${start}, (usize) (${end} - ${start}))`;
				const direct =
					this.reps[instruction.dst] === "number"
						? `mal_ops_number_as_f64(${parsed})`
						: parsed;
				return [
					`if (__regexp_iter_${site.projection.stepIp}_projected) {`,
					`  r${instruction.dst} = ${start} < 0 ? ${this.reps[instruction.dst] === "number" ? "NAN" : "mal_value_new_nan()"} : ${direct};`,
					`} else {`,
					`  MalCompletion ${tmp} = ${this.profileCall("call", `mal_vm_call_cached(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
					`  r${instruction.dst} = ${this.reps[instruction.dst] === "number" ? `mal_ops_number_as_f64(${tmp}.value)` : `${tmp}.value`};`,
					`}`,
					this.callPoll(),
				];
			}
		}
		if (this.context.nativeRegExpExecProjectionAction?.role === "number") {
			const { site, load } = this.context.nativeRegExpExecProjectionAction;
			const slot = site.loads.findIndex((entry) => entry.ip === load?.ip);
			if (slot >= 0) {
				const start = `__regexp_exec_${site.projection.callIp}_starts[${slot}]`;
				const end = `__regexp_exec_${site.projection.callIp}_ends[${slot}]`;
				const parsed = `mal_ops_string_range_to_number(mal_value_to_string(__gc_slots[${site.subjectSlot}]), (usize) ${start}, (usize) (${end} - ${start}))`;
				const direct =
					this.reps[instruction.dst] === "number"
						? `mal_ops_number_as_f64(${parsed})`
						: parsed;
				return [
					`if (__regexp_exec_${site.projection.callIp}_projected) {`,
					`  r${instruction.dst} = ${start} < 0 ? ${this.reps[instruction.dst] === "number" ? "NAN" : "mal_value_new_nan()"} : ${direct};`,
					`} else {`,
					`  MalCompletion ${tmp} = ${this.profileCall("call", `mal_vm_call_cached(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
					`  r${instruction.dst} = ${this.reps[instruction.dst] === "number" ? `mal_ops_number_as_f64(${tmp}.value)` : `${tmp}.value`};`,
					`}`,
					this.callPoll(),
				];
			}
		}
		if (this.context.nativeRegExpExecProjectionAction?.role === "charCodeAtCall") {
			const { site, load } = this.context.nativeRegExpExecProjectionAction;
			const slot = site.loads.findIndex((entry) => entry.ip === load?.ip);
			if (slot >= 0 && load?.consumer?.kind === "charCodeAtZero") {
				const fast = `__regexp_exec_${site.projection.callIp}_char_${this.ip}_fast`;
				const start = `__regexp_exec_${site.projection.callIp}_starts[${slot}]`;
				const end = `__regexp_exec_${site.projection.callIp}_ends[${slot}]`;
				const codeUnit = `mal_string_code_unit_at(mal_value_to_string(__gc_slots[${site.subjectSlot}]), (usize) ${start})`;
				const value =
					this.reps[instruction.dst] === "number"
						? `(f64) ${codeUnit}`
						: this.reps[instruction.dst] === "int32"
							? `(i32) ${codeUnit}`
							: `mal_value_from_i32(${codeUnit})`;
				const empty =
					this.reps[instruction.dst] === "number"
						? "NAN"
						: this.reps[instruction.dst] === "int32"
							? "0"
							: "mal_value_new_nan()";
				const direct = `(${end} > ${start} ? ${value} : ${empty})`;
				this.context.stringLeafCaches.add(this.ip);
				return [
					`if (${fast}) {`,
					`  r${instruction.dst} = ${direct};`,
					`} else {`,
					`  MalCompletion ${tmp} = ${this.profileCall("string", `mal_builtin_string_char_code_at_direct(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length}, &__string_leaf_cache_${this.ip})`)};`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
					`  r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
					`}`,
					this.callPoll(),
				];
			}
		}
		if (this.context.nativeRegExpExecProjectionAction?.role === "call") {
			const { site, propertyLoad } = this.context.nativeRegExpExecProjectionAction;
			const projection = site.projection;
			const fast = `__regexp_exec_${projection.callIp}_fast`;
			const indices = site.loads.map((load) => load.captureIndex).join(", ");
			const outputs = site.loads
				.map((_load, index) => `&__gc_slots[${site.slotsOffset + index}]`)
				.join(", ");
			const spanMask = site.spanMask;
			if (propertyLoad !== undefined) {
				return [
					`__regexp_exec_${projection.callIp}_projected = false;`,
					`${this.profileCall("regexp", `mal_regexp_exec_capture_projection_locked(vm, ${this.boxedOperand(instruction.thisValue)}, ${this.boxedOperand(instruction.arguments[0]!)}, (const u32[]){ ${indices} }, (MalValue *[]){ ${outputs} }, ${site.loads.length}, ${spanMask}, __regexp_exec_${projection.callIp}_starts, __regexp_exec_${projection.callIp}_ends, &__gc_slots[${site.subjectSlot}], &r${instruction.dst})`)};`,
					this.throwCheck(),
					`__regexp_exec_${projection.callIp}_projected = mal_value_is_boolean(r${instruction.dst});`,
					this.callPoll(),
				];
			}
			const project = this.profileCall(
				"regexp",
				`mal_regexp_exec_capture_projection(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${this.boxedOperand(instruction.arguments[0]!)}, (const u32[]){ ${indices} }, (MalValue *[]){ ${outputs} }, ${site.loads.length}, ${spanMask}, __regexp_exec_${projection.callIp}_starts, __regexp_exec_${projection.callIp}_ends, &__gc_slots[${site.subjectSlot}], &r${instruction.dst})`,
			);
			return [
				`__regexp_exec_${projection.callIp}_projected = false;`,
				`${fast} = ${project};`,
				`if (${fast}) {`,
				`  ${this.throwCheck()}`,
				`  __regexp_exec_${projection.callIp}_projected = mal_value_is_boolean(r${instruction.dst});`,
				`} else {`,
				`  MalCompletion ${tmp} = ${this.profileCall("call", `mal_vm_call_cached(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
				`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`  r${instruction.dst} = ${tmp}.value;`,
				`}`,
				this.callPoll(),
			];
		}

		if (this.context.nativeStringSplitProjectionAction?.role === "call") {
			const { site, propertyLoad } = this.context.nativeStringSplitProjectionAction;
			const projection = site.projection;
			const fast = `__string_split_${projection.callIp}_fast`;
			const indices = site.elementLoads.map((load) => load.index).join(", ");

			const project = site.lockedIdentity
				? this.profileCall(
						"string",
						`mal_builtin_string_split_projection_locked(vm, ${this.boxedOperand(instruction.thisValue)}, ${this.boxedOperand(instruction.arguments[0]!)}, (const u32[]){ ${indices} }, __string_split_${projection.callIp}_starts, __string_split_${projection.callIp}_ends, ${site.elementLoads.length}, &__string_split_${projection.callIp}_length)`,
					)
				: this.profileCall(
						"string",
						`mal_builtin_string_split_projection(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${this.boxedOperand(instruction.arguments[0]!)}, (const u32[]){ ${indices} }, __string_split_${projection.callIp}_starts, __string_split_${projection.callIp}_ends, ${site.elementLoads.length}, &__string_split_${projection.callIp}_length)`,
					);
			return [
				`__gc_slots[${site.subjectSlot}] = ${this.boxedOperand(instruction.thisValue)};`,
				...site.elementLoads.map(
					(_, index) => `__gc_slots[${site.slotsOffset + index}] = MAL_VALUE_UNDEFINED;`,
				),
				`${fast} = ${project};`,
				`if (${fast}) {`,
				`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
				`  ${this.callPoll()}`,
				`} else {`,
				...(propertyLoad === undefined
					? []
					: [
							`  r${propertyLoad.dst} = ${this.profileCall("property", `mal_vm_op_load_property_ic(vm, ${this.boxedOperand(propertyLoad.object)}, mal_value_from_string(vm->string_constant_atoms[${this.context.relocation.stringIndex(propertyLoad.stringIndex)}]), &${nativeBodyReference(this.context.resources, "propertyCache")}[${propertyLoad.icIndex}])`)};`,
							`  ${this.throwCheck()}`,
						]),
				`  MalCompletion ${tmp} = ${this.profileCall("call", `mal_vm_call_cached(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
				`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`  r${instruction.dst} = ${tmp}.value;`,
				`  ${this.callPoll()}`,
				`}`,
			];
		}
		const numericCallback =
			callPlan === undefined ? undefined : numericSortSite(instruction, callPlan);
		if (numericCallback !== undefined) {
			const entry = this.context.directCompiledEntries.get(
				directCompiledEntryKey(numericCallback.functionIndex, numericCallback.entryId),
			);
			if (entry !== undefined && numericSortKernelEntry(entry)) {
				const comparator = this.context.relocation.reference(
					`mal_direct_${this.context.relocation.stem(numericCallback.functionIndex)}_${numericCallback.entryId}${this.suffix}`,
				);
				return [
					`MalCompletion ${tmp} = mal_builtin_sort_numeric(vm, ${numericCallback.operation === "toSorted" ? "true" : "false"}, ${numericCallback.viaCall ? "true" : "false"}, ${this.context.relocation.functionIndex(numericCallback.functionIndex)}, ${comparator}, ${entry.leaf ? this.context.relocation.reference(`${comparator}_sort`) : "nullptr"}, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
					`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
					this.callPoll(),
				];
			}
		}
		const guardedBuiltinOperation = callPlan?.guardedBuiltinCall?.operation;
		if (guardedBuiltinOperation === "Object.is") {
			const [left, right] = args;
			const test =
				nativeStringComparisonExpression(
					this.context.stringComparisons?.get(this.ip),
					left!,
					left === undefined ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(left),
					right === undefined ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(right),
				) ??
				nativeEqualityExpression(
					"same-value",
					left === undefined ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(left),
					right === undefined ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(right),
					left === undefined ? COMPILER_VALUE_KIND_UNDEFINED : this.operandKind(left),
					right === undefined ? COMPILER_VALUE_KIND_UNDEFINED : this.operandKind(right),
					left === undefined
						? undefined
						: (this.nativeNumberOperand(left) ??
								this.nativeBooleanOperand(left) ??
								this.nativeStringOperand(left) ??
								undefined),
					right === undefined
						? undefined
						: (this.nativeNumberOperand(right) ??
								this.nativeBooleanOperand(right) ??
								this.nativeStringOperand(right) ??
								undefined),
					left !== undefined &&
						right !== undefined &&
						this.operandRep(left) === "int32" &&
						this.operandRep(right) === "int32",
					left === undefined
						? undefined
						: instructionInputIntegerRange(this.context.facts, left),
					right === undefined
						? undefined
						: instructionInputIntegerRange(this.context.facts, right),
				);
			return [
				`if (mal_builtin_object_is_callee_matches(${this.boxedOperand(instruction.callee)})) {`,
				this.storeBoolean(instruction.dst, test),
				`} else {`,
				...this.guardedCallFallbackRootPublication(),
				`MalCompletion ${tmp} = mal_vm_call_cached(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
				`}`,
				this.callPoll(),
			];
		}
		const dataViewAccess =
			guardedBuiltinOperation === undefined
				? undefined
				: dataViewAccessor(guardedBuiltinOperation);
		if (dataViewAccess !== undefined) {
			const operand = (index: number): number | undefined => args[index];
			const offset = operand(0);
			const index =
				offset === undefined
					? "0.0"
					: (this.nativeNumberOperand(offset) ??
						`(mal_ops_is_number(${this.boxedOperand(offset)}) ? mal_ops_number_as_f64(${this.boxedOperand(offset)}) : -1.0)`);
			const endian = operand(dataViewAccess.set ? 2 : 1);
			const littleEndian = endian === undefined ? "false" : this.operandTruthy(endian);
			const value = dataViewAccess.set ? operand(1) : undefined;
			const number =
				value === undefined
					? dataViewAccess.set
						? "NAN"
						: undefined
					: this.nativeNumberOperand(value);
			const bytes = `__data_view_${this.ip}`;
			const admitted = [
				`mal_data_view_accessor_is(${this.boxedOperand(instruction.callee)}, ${dataViewAccess.accessor})`,
				...(value !== undefined && number === null
					? [`mal_ops_is_number(${this.boxedOperand(value)})`]
					: []),
			];
			const access = dataViewAccess.set
				? `mal_data_view_write(${bytes}, ${dataViewAccess.accessor}, ${number ?? `mal_ops_number_as_f64(${this.boxedOperand(value!)})`}, ${littleEndian});`
				: this.storeNumber(
						instruction.dst,
						`mal_data_view_read(${bytes}, ${dataViewAccess.accessor}, ${littleEndian})`,
					);
			return [
				`byte *${bytes} = ${admitted.join(" && ")} ? mal_data_view_try_bytes(${this.boxedOperand(instruction.thisValue)}, ${index}, ${dataViewAccess.size}, ${dataViewAccess.set}) : nullptr;`,
				`if (${bytes} != nullptr) {`,
				`  ${access}`,
				...(dataViewAccess.set
					? [`  r${instruction.dst} = ${callResult("MAL_VALUE_UNDEFINED")};`]
					: []),
				`} else {`,
				...this.guardedCallFallbackRootPublication(),
				`  MalCompletion ${tmp} = ${this.profileCall("call", `mal_vm_call_cached(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
				`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`  r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
				`}`,
				this.callPoll(),
			];
		}
		if (
			guardedBuiltinOperation === "Boolean" ||
			guardedBuiltinOperation === "Boolean.prototype.valueOf" ||
			guardedBuiltinOperation === "Boolean.prototype.toString"
		) {
			const operation = {
				Boolean: "MAL_BOOLEAN_CALL",
				"Boolean.prototype.valueOf": "MAL_BOOLEAN_VALUE_OF",
				"Boolean.prototype.toString": "MAL_BOOLEAN_TO_STRING",
			}[guardedBuiltinOperation];
			const receiver = this.boxedOperand(instruction.thisValue);
			const argument = args[0];
			const primitiveReceiver = this.nativeBooleanOperand(instruction.thisValue);
			const receiverGuard =
				operation === "MAL_BOOLEAN_CALL" || primitiveReceiver !== null
					? ""
					: ` && mal_value_is_boolean(${receiver})`;
			const boolean = primitiveReceiver ?? `mal_value_to_boolean(${receiver})`;
			const result =
				operation === "MAL_BOOLEAN_CALL"
					? this.storeBoolean(
							instruction.dst,
							argument === undefined ? "false" : this.operandTruthy(argument),
						)
					: operation === "MAL_BOOLEAN_VALUE_OF"
						? this.storeBoolean(instruction.dst, boolean)
						: `r${instruction.dst} = ${callResult(`mal_value_from_string(mal_intrinsic_hot_ascii(vm, ${boolean} ? MAL_HOT_KEY_TRUE : MAL_HOT_KEY_FALSE))`)};`;
			return [
				`if (mal_builtin_boolean_callee_matches(${operation}, ${this.boxedOperand(instruction.callee)})${receiverGuard}) {`,
				result,
				`} else {`,
				...this.guardedCallFallbackRootPublication(),
				`MalCompletion ${tmp} = mal_vm_call_cached(vm, ${this.boxedOperand(instruction.callee)}, ${receiver}, ${argsExpr}, ${args.length});`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
				`}`,
				this.callPoll(),
			];
		}
		const numberPredicate = NUMBER_PREDICATES.get(guardedBuiltinOperation ?? "");
		if (numberPredicate !== undefined) {
			const argument = args[0];
			const number = argument === undefined ? null : this.nativeNumberOperand(argument);
			const test = nativeNumberPredicateInputExpression(
				guardedBuiltinOperation!,
				argument === undefined ? undefined : this.boxedOperand(argument),
				argument === undefined
					? COMPILER_VALUE_KIND_UNDEFINED
					: (this.operandKind(argument) ?? COMPILER_VALUE_KIND_TOP),
				number ?? undefined,
				argument === undefined
					? undefined
					: instructionInputIntegerRange(this.context.facts, argument),
			);
			return [
				`if (mal_builtin_number_predicate_callee_matches(${numberPredicate}, ${this.boxedOperand(instruction.callee)})) {`,
				this.storeBoolean(instruction.dst, test),
				`} else {`,
				...this.guardedCallFallbackRootPublication(),
				`MalCompletion ${tmp} = mal_vm_call_cached(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
				`}`,
				this.callPoll(),
			];
		}
		if (
			guardedBuiltinOperation === "Number.prototype.toFixed" ||
			guardedBuiltinOperation === "Number.prototype.toExponential" ||
			guardedBuiltinOperation === "Number.prototype.toPrecision"
		) {
			const method = {
				"Number.prototype.toFixed": "MAL_NUMBER_FORMAT_FIXED",
				"Number.prototype.toExponential": "MAL_NUMBER_FORMAT_EXPONENTIAL",
				"Number.prototype.toPrecision": "MAL_NUMBER_FORMAT_PRECISION",
			}[guardedBuiltinOperation];
			const option =
				args.length === 0 ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(args[0]!);
			const format = NUMBER_FORMAT_KERNELS[guardedBuiltinOperation]!;
			const constant =
				args.length === 0
					? { kind: "undefined" as const }
					: decodeVmValueOperand(args[0]!);
			const digits =
				constant.kind === "undefined"
					? format[3]
					: constant.kind === "number" &&
						  Number.isInteger(constant.value) &&
						  constant.value >= format[1] &&
						  constant.value <= format[2]
						? constant.value
						: undefined;
			const receiver = this.boxedOperand(instruction.thisValue);
			const guard =
				digits === undefined
					? `mal_builtin_number_format_try_direct(vm, ${method}, ${this.boxedOperand(instruction.callee)}, ${receiver}, ${option}, &__number_format_${this.ip})`
					: `mal_builtin_number_format_callee_matches(vm, ${method}, ${this.boxedOperand(instruction.callee)})`;
			return [
				...(digits === undefined ? [`MalValue __number_format_${this.ip};`] : []),
				`if (mal_ops_is_number(${receiver}) && ${guard}) {`,
				...(digits === undefined
					? []
					: [
							`MalValue __number_format_${this.ip} = mal_builtin_number_to_${format[0]}_numeric(vm, mal_ops_number_as_f64(${receiver}), ${digits});`,
						]),
				this.throwCheck(),
				`r${instruction.dst} = __number_format_${this.ip};`,
				`} else {`,
				`MalCompletion ${tmp} = mal_vm_call_cached(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`r${instruction.dst} = ${tmp}.value;`,
				`}`,
				this.callPoll(),
			];
		}
		if (
			this.context.nativeBuiltinCollectionCallChainAction?.role === "call" &&
			this.context.nativeBuiltinCollectionCallChainAction.chain.calleeGuard === "elided"
		) {
			const operation =
				this.context.nativeBuiltinCollectionCallChainAction.chain.operation;
			return [
				this.fixedCollectionCall(
					operation,
					instruction.dst,
					instruction.thisValue,
					args,
				)!,
				...(operation === "Map.prototype.set" ||
				operation === "Set.prototype.add" ||
				operation === "WeakMap.prototype.set" ||
				operation === "WeakSet.prototype.add"
					? [this.callPoll()]
					: []),
			];
		}
		const arrayIterationOperation =
			guardedBuiltinOperation === undefined
				? undefined
				: {
						"Array.prototype.forEach": "MAL_BUILTIN_ARRAY_ITERATION_FOR_EACH",
						"Map.prototype.forEach": "MAL_BUILTIN_MAP_FOR_EACH",
						"Set.prototype.forEach": "MAL_BUILTIN_SET_FOR_EACH",
						"Array.prototype.some": "MAL_BUILTIN_ARRAY_ITERATION_SOME",
						"Array.prototype.every": "MAL_BUILTIN_ARRAY_ITERATION_EVERY",
						"Array.prototype.find": "MAL_BUILTIN_ARRAY_ITERATION_FIND",
						"Array.prototype.findIndex": "MAL_BUILTIN_ARRAY_ITERATION_FIND_INDEX",
						"Array.prototype.map": "MAL_BUILTIN_ARRAY_ITERATION_MAP",
						"Array.prototype.filter": "MAL_BUILTIN_ARRAY_ITERATION_FILTER",
						"Array.prototype.reduce": "MAL_BUILTIN_ARRAY_ITERATION_REDUCE",
						"Array.prototype.reduceRight": "MAL_BUILTIN_ARRAY_ITERATION_REDUCE_RIGHT",
						"TypedArray.prototype.forEach": "MAL_BUILTIN_TYPED_ARRAY_FOR_EACH",
						"TypedArray.prototype.some": "MAL_BUILTIN_TYPED_ARRAY_SOME",
						"TypedArray.prototype.every": "MAL_BUILTIN_TYPED_ARRAY_EVERY",
						"TypedArray.prototype.find": "MAL_BUILTIN_TYPED_ARRAY_FIND",
						"TypedArray.prototype.findIndex": "MAL_BUILTIN_TYPED_ARRAY_FIND_INDEX",
						"TypedArray.prototype.map": "MAL_BUILTIN_TYPED_ARRAY_MAP",
						"TypedArray.prototype.filter": "MAL_BUILTIN_TYPED_ARRAY_FILTER",
						"TypedArray.prototype.findLast": "MAL_BUILTIN_TYPED_ARRAY_FIND_LAST",
						"TypedArray.prototype.findLastIndex":
							"MAL_BUILTIN_TYPED_ARRAY_FIND_LAST_INDEX",
						"Collection.prototype.forEach": "MAL_BUILTIN_COLLECTION_FOR_EACH",
						"ArrayOrTypedArray.prototype.some": "MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_SOME",
						"ArrayOrTypedArray.prototype.every": "MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_EVERY",
						"ArrayOrTypedArray.prototype.find": "MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_FIND",
						"ArrayOrTypedArray.prototype.findIndex":
							"MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_FIND_INDEX",
						"ArrayOrTypedArray.prototype.map": "MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_MAP",
						"ArrayOrTypedArray.prototype.filter":
							"MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_FILTER",
						"ArrayOrTypedArray.prototype.findLast":
							"MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_FIND_LAST",
						"ArrayOrTypedArray.prototype.findLastIndex":
							"MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_FIND_LAST_INDEX",
						"TypedArray.prototype.reduce": "MAL_BUILTIN_TYPED_ARRAY_REDUCE",
						"TypedArray.prototype.reduceRight": "MAL_BUILTIN_TYPED_ARRAY_REDUCE_RIGHT",
						"ArrayOrTypedArray.prototype.reduce":
							"MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_REDUCE",
						"ArrayOrTypedArray.prototype.reduceRight":
							"MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_REDUCE_RIGHT",
						"Array.prototype.findLast": "MAL_BUILTIN_ARRAY_ITERATION_FIND_LAST",
						"Array.prototype.findLastIndex":
							"MAL_BUILTIN_ARRAY_ITERATION_FIND_LAST_INDEX",
						"Array.prototype.flatMap": "MAL_BUILTIN_ARRAY_ITERATION_FLAT_MAP",
					}[
						guardedBuiltinOperation as
							| "Array.prototype.forEach"
							| "Map.prototype.forEach"
							| "Set.prototype.forEach"
							| "Array.prototype.some"
							| "Array.prototype.every"
							| "Array.prototype.find"
							| "Array.prototype.findIndex"
							| "Array.prototype.map"
							| "Array.prototype.filter"
							| "Array.prototype.reduce"
							| "Array.prototype.reduceRight"
							| "TypedArray.prototype.forEach"
							| "TypedArray.prototype.some"
							| "TypedArray.prototype.every"
							| "TypedArray.prototype.find"
							| "TypedArray.prototype.findIndex"
							| "TypedArray.prototype.map"
							| "TypedArray.prototype.filter"
							| "TypedArray.prototype.findLast"
							| "TypedArray.prototype.findLastIndex"
							| "Collection.prototype.forEach"
							| "ArrayOrTypedArray.prototype.some"
							| "ArrayOrTypedArray.prototype.every"
							| "ArrayOrTypedArray.prototype.find"
							| "ArrayOrTypedArray.prototype.findIndex"
							| "ArrayOrTypedArray.prototype.map"
							| "ArrayOrTypedArray.prototype.filter"
							| "ArrayOrTypedArray.prototype.findLast"
							| "ArrayOrTypedArray.prototype.findLastIndex"
							| "TypedArray.prototype.reduce"
							| "TypedArray.prototype.reduceRight"
							| "ArrayOrTypedArray.prototype.reduce"
							| "ArrayOrTypedArray.prototype.reduceRight"
							| "Array.prototype.findLast"
							| "Array.prototype.findLastIndex"
							| "Array.prototype.flatMap"
					];
		if (arrayIterationOperation !== undefined) {
			nativeCallDecision(
				this.context.profile,
				this.ip,
				"call.builtin-direct",
				"retained",
				"runtime-helper-owned-dispatch",
			);
			const callbackTarget = callPlan?.directCallbackFunctionIndex;
			const callbackEntry = this.context.callbackTransport;
			const callbackSymbol =
				callbackTarget !== undefined &&
				this.context.directCompiledTargets.has(callbackTarget)
					? callbackEntry !== undefined &&
						this.context.directCompiledEntries.has(
							directCompiledEntryKey(callbackTarget, callbackEntry.entryId),
						)
						? this.context.relocation.reference(
								nativeCallbackSymbol(
									this.context.relocation.stem(callbackTarget),
									callbackEntry.entryId,
									this.suffix,
								),
							)
						: this.context.relocation.reference(
								`mal_compiled_${this.context.relocation.stem(callbackTarget)}${this.suffix}`,
							)
					: "nullptr";
			const numericReduction =
				callbackEntry?.numericReduction === true &&
				callbackTarget !== undefined &&
				this.context.directCompiledTargets.has(callbackTarget) &&
				this.context.directCompiledEntries.has(
					directCompiledEntryKey(callbackTarget, callbackEntry.entryId),
				);
			const helper = numericReduction
				? "mal_builtin_array_numeric_reduce_direct"
				: "mal_builtin_array_iteration_direct";
			return [
				`MalCompletion ${tmp} = ${helper}(vm, ${arrayIterationOperation}, ${callPlan?.directCallbackFunctionIndex === undefined ? -1 : this.context.relocation.functionIndex(callPlan.directCallbackFunctionIndex)}, ${callbackSymbol}, ${numericReduction ? `${this.context.relocation.reference(`${callbackSymbol}_reduce`)}, ` : ""}${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
				this.callPoll(),
			];
		}
		if (
			guardedBuiltinOperation === "Map.prototype.get" ||
			guardedBuiltinOperation === "Map.prototype.set" ||
			guardedBuiltinOperation === "Map.prototype.has" ||
			guardedBuiltinOperation === "Map.prototype.delete" ||
			guardedBuiltinOperation === "Set.prototype.add" ||
			guardedBuiltinOperation === "Set.prototype.has" ||
			guardedBuiltinOperation === "Set.prototype.delete" ||
			guardedBuiltinOperation === "WeakMap.prototype.get" ||
			guardedBuiltinOperation === "WeakMap.prototype.set" ||
			guardedBuiltinOperation === "WeakMap.prototype.has" ||
			guardedBuiltinOperation === "WeakMap.prototype.delete" ||
			guardedBuiltinOperation === "WeakSet.prototype.has" ||
			guardedBuiltinOperation === "WeakSet.prototype.add" ||
			guardedBuiltinOperation === "WeakSet.prototype.delete"
		) {
			const operation = nativeBuiltinCollectionOperation(guardedBuiltinOperation);
			const exactReceiver = callPlan?.exactCollectionReceiver;
			const receiverFact =
				exactReceiver === "Map"
					? "MAL_BUILTIN_COLLECTION_RECEIVER_EXACT_MAP"
					: exactReceiver === "Set"
						? "MAL_BUILTIN_COLLECTION_RECEIVER_EXACT_SET"
						: exactReceiver === "WeakMap"
							? "MAL_BUILTIN_COLLECTION_RECEIVER_EXACT_WEAK_MAP"
							: exactReceiver === "WeakSet"
								? "MAL_BUILTIN_COLLECTION_RECEIVER_EXACT_WEAK_SET"
								: "MAL_BUILTIN_COLLECTION_RECEIVER_UNKNOWN";
			const callee = this.boxedOperand(instruction.callee);
			const receiver = this.boxedOperand(instruction.thisValue);
			// A method-name hint can refer to any collection brand at runtime.
			const method = guardedBuiltinOperation.slice(
				guardedBuiltinOperation.lastIndexOf(".") + 1,
			);
			const arms = (["Map", "Set", "WeakMap", "WeakSet"] as const).flatMap((brand) => {
				const builtin = this.collectionBuiltinCall(
					`${brand}.prototype.${method}`,
					receiver,
					args,
				);
				if (
					builtin === undefined ||
					(exactReceiver !== undefined && exactReceiver !== brand)
				)
					return [];
				const body = builtin.boolean
					? `mal_value_new_boolean(${builtin.call})`
					: builtin.call;
				const stem =
					brand === "WeakMap"
						? "weak_map"
						: brand === "WeakSet"
							? "weak_set"
							: brand.toLowerCase();
				const intrinsic = `MAL_INTRINSIC_${stem.toUpperCase()}_PROTOTYPE_${method.toUpperCase()}`;
				const brandCheck =
					exactReceiver === brand ? "" : ` && mal_value_is_${stem}_object(${receiver})`;
				// Arms keep the dispatcher's direct-hit counters, so either route reports the same hits.
				const counters = [
					...(exactReceiver === brand ? ["collection_exact_receiver_hits"] : []),
					`collection_direct_${stem}_${method}_hits`,
				];
				return [
					{
						guard: `${callee} == vm->intrinsics[${intrinsic}]${brandCheck}`,
						body,
						mayThrow: builtin.mayThrow === true,
						counters,
					},
				];
			});
			return [
				...arms.flatMap((arm, index) => [
					`${index === 0 ? "if" : "} else if"} (${arm.guard}) {`,
					...arm.counters.map((counter) => `  MAL_PERF_COUNT(${counter});`),
					`  r${instruction.dst} = ${callResult(arm.body)};`,
					...(arm.mayThrow ? [this.throwCheck()] : []),
				]),
				...(arms.length === 0 ? ["{"] : ["} else {"]),
				`  MalCompletion ${tmp} = mal_builtin_collection_direct(vm, ${operation}, ${receiverFact}, ${callee}, ${receiver}, ${argsExpr}, ${args.length});`,
				`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`  r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
				`}`,
				this.callPoll(),
			];
		}
		if (vmCallProvesBuiltin(callPlan, "Array.prototype.push")) {
			const direct = [
				`MalCompletion ${tmp} = mal_builtin_array_push_direct(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length}, nullptr);`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`r${instruction.dst} = ${tmp}.value;`,
			];
			if (args.length !== 1) return [...direct, this.callPoll()];
			const pushed = `__pushed_${this.ip}`;
			return [
				`MalValue ${pushed};`,
				`if (mal_vm_array_push_one_try(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${this.boxedOperand(args[0]!)}, &${pushed})) {`,
				`  r${instruction.dst} = ${pushed};`,
				"} else {",
				...direct.map((line) => `  ${line}`),
				"}",
				this.callPoll(),
			];
		}
		const dequeMethod = (["pop", "shift", "unshift"] as const).find((method) =>
			vmCallProvesBuiltin(callPlan, `Array.prototype.${method}`),
		);
		if (dequeMethod !== undefined) {
			return [
				`MalCompletion ${tmp} = mal_builtin_array_deque_direct(vm, MAL_GUARDED_BUILTIN_ARRAY_${dequeMethod.toUpperCase()}, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`r${instruction.dst} = ${tmp}.value;`,
				this.callPoll(),
			];
		}
		if (vmCallProvesBuiltin(callPlan, "Array.prototype.at")) {
			return [
				`MalCompletion ${tmp} = mal_builtin_array_at_direct(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`r${instruction.dst} = ${tmp}.value;`,
				this.callPoll(),
			];
		}
		if (vmCallProvesBuiltin(callPlan, "String.prototype.charCodeAt")) {
			if (this.context.guardedCallRootPublication) {
				this.context.stringLeafCaches.add(this.ip);
				const mask = this.context.guardedCallInactiveRootMask;
				const charPoll = mask === undefined ? this.callPoll() : this.guardedCallPoll();
				return [
					`MalValue __char_value_${this.ip};`,
					`if (mal_builtin_string_char_code_at_try(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length}, &__string_leaf_cache_${this.ip}, &__char_value_${this.ip})) {`,
					`  r${instruction.dst} = ${callResult(`__char_value_${this.ip}`)};`,
					`} else {`,
					...this.guardedCallFallbackRootPublication(),
					`  MalCompletion ${tmp} = mal_builtin_string_char_code_at_direct(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length}, &__string_leaf_cache_${this.ip});`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
					`  r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
					`}`,
					charPoll,
				];
			}

			const boundedArgument =
				args.length === 1 ? decodeVmValueOperand(args[0]!) : undefined;
			const boundedPosition =
				callPlan?.directStringCharCodeAtPosition === "inBounds" &&
				boundedArgument?.kind === "register" &&
				isNumericRep(this.reps[boundedArgument.register]!)
					? this.num(boundedArgument.register)
					: null;
			if (boundedPosition !== null) {
				this.context.stringLeafCaches.add(this.ip);
				return [
					`MalCompletion ${tmp} = ${this.profileCall("string", `mal_builtin_string_char_code_at_direct_in_bounds(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length}, ${boundedPosition}, &__string_leaf_cache_${this.ip})`)};`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
					`r${instruction.dst} = ${tmp}.value;`,
					this.callPoll(),
				];
			}
			this.context.stringLeafCaches.add(this.ip);
			return [
				`MalCompletion ${tmp} = ${this.profileCall("string", `mal_builtin_string_char_code_at_direct(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length}, &__string_leaf_cache_${this.ip})`)};`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`r${instruction.dst} = ${tmp}.value;`,
				this.callPoll(),
			];
		}
		if (callPlan?.directFunctionCall) {
			const target = callPlan.directCallTargetFunctionIndex;
			const compiled =
				target !== undefined && this.context.directCompiledTargets.has(target);
			return [
				`MalCompletion ${tmp} = mal_vm_call_function_call_direct${compiled ? "_compiled" : ""}(vm, ${target === undefined ? -1 : this.context.relocation.functionIndex(target)}, ${compiled ? `${this.context.relocation.reference(`mal_compiled_${this.context.relocation.stem(target)}${this.suffix}`)}, ` : ""}${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
				this.callPoll(),
			];
		}
		const directEntryParameters = (transport: NativeCallTargetTransport) =>
			transport.arguments
				.map((mode, parameter) => {
					const operand = args[parameter];
					if (operand === undefined) return "MAL_VALUE_UNDEFINED";
					const rep = this.operandRep(operand);
					const value =
						rep === "int32"
							? this.nativeInt32Operand(operand)!
							: rep === "number"
								? this.nativeNumberOperand(operand)!
								: rep === "boolean"
									? this.nativeBooleanOperand(operand)!
									: this.boxedOperand(operand);
					return this.convert(mode, value);
				})
				.concat(
					transport.fields.map(({ slot, conversion: mode }) => {
						const site = this.context.fieldEntryCall;
						if (site === undefined)
							throw new Error("Native field call transport lacks an allocation");
						return this.convert(
							mode,
							site.boxedSlots[slot] === undefined
								? `__field_${site.allocationIp}_${slot}`
								: `__gc_slots[${site.boxedSlots[slot]}]`,
						);
					}),
				);

		if (callPlan?.guardedFunctionIndices !== undefined) {
			nativeCallDecision(
				this.context.profile,
				this.ip,
				callPlan.guardedFunctionIndices.some((target) =>
					this.context.directCompiledTargets.has(target),
				)
					? "call.direct-compiled"
					: "call.direct-script",
				"guarded",
				"callee-identity-guard",
			);
			const guardedCallee = `__guarded_callee_${this.ip}`;
			const guardedIndex = `__guarded_index_${this.ip}`;
			const branches = callPlan.guardedFunctionIndices.flatMap((target, index) => {
				const transport = this.context.callTransport?.targets.find(
					(candidate) => candidate.functionIndex === target,
				);
				const entry =
					transport === undefined
						? undefined
						: this.context.directCompiledEntries.get(
								directCompiledEntryKey(target, transport.entryId),
							);
				if (entry !== undefined && transport !== undefined) {
					const parameters = directEntryParameters(transport);
					const covered = this.context.directEntryCalls.get(this.ip) ?? new Set<number>();
					covered.add(target);
					this.context.directEntryCalls.set(this.ip, covered);
					const value = `__guarded_entry_value_${this.ip}`;
					const receiver = this.context.strictCompiledTargets.has(target)
						? this.boxedOperand(instruction.thisValue)
						: `mal_vm_callee_this(vm, &vm->runtime_image->functions[${this.context.relocation.functionIndex(target)}], ${this.boxedOperand(instruction.thisValue)})`;
					return [
						`${index === 0 ? "if" : "else if"} (${guardedIndex} == ${this.context.relocation.functionIndex(target)}) {`,
						`  MAL_CALLEE_REALM_ENTER(${guardedCallee});`,
						"  MAL_PERF_COUNT(direct_entry_hits);",
						`  ${cTypeOf(transport.resultRepresentation)} ${value} = ${this.context.relocation.reference(`mal_direct_${this.context.relocation.stem(target)}_${entry.id}${this.suffix}`)}(vm, ${receiver}${parameters.length === 0 ? "" : `, ${parameters.join(", ")}`}, mal_value_to_function_object(${guardedCallee})->creation_env, ${guardedCallee});`,
						"  MAL_CALLEE_REALM_LEAVE();",
						`  ${this.throwCheck()}`,
						`  r${instruction.dst} = ${this.callValue(instruction.dst, value, transport.result)};`,
						"}",
					];
				}

				if (this.context.directCompiledTargets.has(target)) {
					const value = `__guarded_value_${this.ip}_${target}`;
					const receiver = this.context.strictCompiledTargets.has(target)
						? this.boxedOperand(instruction.thisValue)
						: `mal_vm_callee_this(vm, &vm->runtime_image->functions[${this.context.relocation.functionIndex(target)}], ${this.boxedOperand(instruction.thisValue)})`;
					return [
						`${index === 0 ? "if" : "else if"} (${guardedIndex} == ${this.context.relocation.functionIndex(target)}) {`,
						`  MAL_CALLEE_REALM_ENTER(${guardedCallee});`,
						`  MalValue ${value} = ${this.context.relocation.reference(`mal_compiled_${this.context.relocation.stem(target)}${this.suffix}`)}(vm, ${receiver}, ${argsExpr}, ${args.length}, MAL_VALUE_UNDEFINED, mal_value_to_function_object(${guardedCallee})->creation_env, ${guardedCallee}, nullptr);`,
						"  MAL_CALLEE_REALM_LEAVE();",
						`  ${this.throwCheck()}`,
						`  r${instruction.dst} = ${callResult(value)};`,
						"}",
					];
				}
				return [
					`${index === 0 ? "if" : "else if"} (${guardedIndex} == ${this.context.relocation.functionIndex(target)}) {`,
					`  MalCompletion ${tmp} = mal_vm_call_exact_script(vm, ${this.context.relocation.functionIndex(target)}, ${guardedCallee}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
					`  r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
					`}`,
				];
			});
			return [
				`MalValue ${guardedCallee} = ${this.boxedOperand(instruction.callee)};`,
				`i32 ${guardedIndex} = MAL_FUNCTION_INDEX_OF(${guardedCallee});`,
				...branches,
				`else {`,
				`  MalCompletion ${tmp} = ${this.profileCall("call", `mal_vm_call_cached(vm, ${guardedCallee}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
				`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`  r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
				`}`,
				this.callPoll(),
			];
		}
		if (callPlan?.directFunctionIndex !== undefined) {
			const target = callPlan.directFunctionIndex;
			const directFunction = `__direct_function_${this.ip}`;
			const targetIsStrict = this.context.strictCompiledTargets.has(target);
			const thisArgument = targetIsStrict
				? this.boxedOperand(instruction.thisValue)
				: `mal_vm_callee_this(vm, ${directFunction}, ${this.boxedOperand(instruction.thisValue)})`;
			const functionDeclaration = targetIsStrict
				? []
				: [
						`const MalFunction *${directFunction} = &vm->runtime_image->functions[${this.context.relocation.functionIndex(target)}];`,
					];
			const transport = this.context.callTransport?.targets.find(
				(candidate) => candidate.functionIndex === target,
			);
			const directEntry =
				transport === undefined
					? undefined
					: this.context.directCompiledEntries.get(
							directCompiledEntryKey(target, transport.entryId),
						);
			const directCallee = `__direct_callee_${this.ip}`;
			const directEnvironment =
				directClosureEnvironment(
					callPlan,
					this.context.directClosures,
					this.context.functionIndex,
					this.context.fixedCaptureOwners,
					this.context.relocation,
					directCallee,
				) ?? `mal_value_to_function_object(${directCallee})->creation_env`;
			if (directEntry !== undefined && transport !== undefined) {
				const directValue = `__direct_value_${this.ip}`;
				const forward =
					this.context.recordForwarded !== undefined &&
					directEntry.resultFields !== undefined;
				const recordArguments = (directEntry.recordParameters ?? []).map(
					(parameter) =>
						this.context.recordPasses?.find((pass) => pass.argument === parameter.index)
							?.site,
				);
				const parameters = [
					...directEntryParameters(transport),
					...(this.context.recordCall === undefined
						? []
						: [
								...this.context.recordCall.slots,
								...(this.context.recordCall.shapes === undefined
									? []
									: [recordShape(this.context.recordCall)]),
							].map((slot) => `&${slot}`)),
					...(forward
						? directEntry.resultFields.keys.map((_, field) => `rf${field}`)
						: []),
					...recordArguments.flatMap((site, index) =>
						site === undefined
							? []
							: recordStorage(site, directEntry.recordParameters![index]!),
					),
				];
				if (
					(this.context.recordCall !== undefined || forward) !==
						(directEntry.resultFields !== undefined) ||
					recordArguments.some((site) => site === undefined) ||
					recordArguments.length !== (this.context.recordPasses?.length ?? 0)
				)
					throw new Error(
						`Native record call ${this.ip} in function ${this.context.functionIndex} disagrees with its entry`,
					);
				if (forward) this.context.recordForwarded.add(this.ip);
				this.context.directEntryCalls.set(this.ip, new Set([target]));
				nativeCallDecision(
					this.context.profile,
					this.ip,
					"call.direct-native",
					"applied",
				);
				const directResult = this.callValue(
					instruction.dst,
					directValue,
					transport.result,
				);
				return [
					`MalValue ${directCallee} = ${this.boxedOperand(instruction.callee)};`,
					`MAL_PERF_COUNT(direct_entry_hits);`,
					...functionDeclaration,
					`${cTypeOf(directEntry.resultRepresentation)} ${directValue} = ${this.context.relocation.reference(`mal_direct_${this.context.relocation.stem(target)}_${directEntry.id}${this.suffix}`)}(vm, ${thisArgument}${parameters.length === 0 ? "" : `, ${parameters.join(", ")}`}, ${directEnvironment}, ${directCallee});`,
					`if (MAL_THREW()) ${this.onThrow()}`,
					`r${instruction.dst} = ${directResult};`,
					...(this.context.recordCall?.object === undefined
						? []
						: [
								// Another returned value is the record itself, as if observed.
								this.context.recordCall.escapes
									? `${recordObject(this.context.recordCall)} = ${this.boxed(instruction.dst)};`
									: `${recordObject(this.context.recordCall)} = MAL_VALUE_EMPTY;`,
								...(this.context.recordCall.producer === undefined
									? []
									: [`${recordProducer(this.context.recordCall)} = ${directCallee};`]),
							]),
					this.callPoll(),
				];
			}
			if (this.context.directCompiledTargets.has(target)) {
				nativeCallDecision(
					this.context.profile,
					this.ip,
					"call.direct-compiled",
					"applied",
				);
				const directValue = `__direct_value_${this.ip}`;
				return [
					`MalValue ${directCallee} = ${this.boxedOperand(instruction.callee)};`,
					...functionDeclaration,
					`MalValue ${directValue} = ${this.context.relocation.reference(`mal_compiled_${this.context.relocation.stem(target)}${this.suffix}`)}(vm, ${thisArgument}, ${argsExpr}, ${args.length}, MAL_VALUE_UNDEFINED, ${directEnvironment}, ${directCallee}, nullptr);`,
					`if (MAL_THREW()) ${this.onThrow()}`,
					`r${instruction.dst} = ${callResult(directValue)};`,
					this.callPoll(),
				];
			}
			return [
				`MalCompletion ${tmp} = ${this.profileCall("call", `mal_vm_call_direct(vm, ${this.context.relocation.functionIndex(callPlan.directFunctionIndex)}, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
				this.callPoll(),
			];
		}
		if (this.context.mathCall !== undefined) {
			const { operation, arity: operandCount } = this.context.mathCall;
			const kernel = (values: ReadonlyArray<string>): string | null =>
				operandCount === 1
					? nativeMathUnaryExpr(
							operation,
							values[0]!,
							args[0] === undefined
								? undefined
								: instructionInputIntegerRange(this.context.facts, args[0]),
						)
					: nativeMathBinaryExpr(
							operation,
							values[0]!,
							values[1]!,
							this.context.facts?.inputIntegerRanges?.slice(2),
						);
			const nativeOperands = instruction.arguments.map(
				this.nativeNumberOperand.bind(this),
			);
			const expression = kernel(
				instruction.arguments.map(
					(operand, index) =>
						nativeOperands[index] ??
						`mal_ops_number_as_f64(${this.boxedOperand(operand)})`,
				),
			);
			if (expression === null)
				throw new Error(`Native Math plan has no kernel for ${operation}`);
			// Locked primordials do not prove a loaded callee belongs to Math.
			const arity = this.context.mathCall.arity === 1 ? "UNARY" : "BINARY";
			const guards = [
				`mal_builtin_math_${arity.toLowerCase()}_callee_matches(MAL_MATH_${arity}_${operation.slice("Math.".length).toUpperCase()}, ${this.boxedOperand(instruction.callee)})`,
				...instruction.arguments.flatMap((operand, index) =>
					nativeOperands[index] === null
						? [`mal_ops_is_number(${this.boxedOperand(operand)})`]
						: [],
				),
			];
			return [
				`if (${guards.join(" && ")}) {`,
				`  ${this.storeMathNumber(instruction.dst, operation, expression)}`,
				`} else {`,
				...this.guardedCallFallbackRootPublication(),
				`  MalCompletion ${tmp} = ${this.profileCall("call", `mal_vm_call_cached(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
				`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
				`  r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
				`}`,
				this.guardedCallPoll(),
			];
		}
		// A per-site polymorphic call cache: exact native callees and ordinary compiled
		// closures sharing a function index skip the dispatch chain. Bound, proxy, and
		// interpreted callees stay on the slow path.
		return [
			`MalCompletion ${tmp} = ${this.profileCall("call", `mal_vm_call_cached(vm, ${this.boxedOperand(instruction.callee)}, ${this.boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
			`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
			`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
			this.callPoll(),
		];
	}

	get thisRef() {
		// Derived constructors rebind a rooted receiver when super() returns.
		return this.thisSlot >= 0 ? `__gc_slots[${this.thisSlot}]` : "this_value";
	}
	get coroReturnValue() {
		// Async entry returns its promise; coroutine resume ignores the C return value.
		return this.coro !== null && this.coro.isAsyncFunction
			? "__async_result_promise"
			: "MAL_VALUE_UNDEFINED";
	}
	emitPropertyStore(
		instruction: Extract<
			BytecodeInstruction,
			{ opcode: "STORE_PROPERTY" | "STORE_PROPERTY_STATIC" }
		>,
	): Array<string> | null {
		if (
			instruction.opcode === "STORE_PROPERTY_STATIC" &&
			this.context.staticPropertyNumericAction?.role === "store"
		) {
			const fallback = this.emitGenericInstruction();
			if (fallback === null) return null;
			const plan = this.context.staticPropertyNumericAction.plan;
			const prefix = `__property_projection_${plan.id}`;
			const result = `${prefix}_step_${plan.steps.length - 1}`;
			const cache = `&${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}]`;
			return [
				`if (${prefix}_fast) {`,
				`  MalNativeNumericFieldUpdate ${prefix}_update;`,
				`  f64 ${prefix}_old;`,
				`  if (!mal_vm_property_numeric_update_begin_same(${this.boxed(instruction.object)}, ${cache}, &${prefix}_update, &${prefix}_old) || !mal_vm_property_numeric_update_commit(&${prefix}_update, ${result}, nullptr)) {`,
				`    r${instruction.value} = mal_ops_number_value(${result});`,
				...fallback.map((line) => `    ${line}`),
				`  }`,
				`} else {`,
				...fallback.map((line) => `  ${line}`),
				`}`,
			];
		}
		if (this.context.stackObjectAccess !== undefined) {
			const { site, slot } = this.context.stackObjectAccess;
			return [this.stackStore(site, slot, instruction.value)];
		}
		if (
			instruction.opcode === "STORE_PROPERTY_STATIC" &&
			this.context.constructorInitializationAction !== undefined
		) {
			const fallback = this.emitGenericInstruction();
			if (fallback === null) return null;
			const { plan, index } = this.context.constructorInitializationAction;
			const fast = `__constructor_initialization_${plan.id}_fast`;
			const object = `__constructor_initialization_${plan.id}_object`;
			const cache = `&${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}]`;
			const begin =
				index === 0
					? [
							`${object} = mal_vm_as_object(${this.boxed(instruction.object)});`,
							`${fast} = ${object} != nullptr && mal_vm_constructor_try_begin_initialization(${object}, (const MalInlineCache *const[]){ ${this.context.constructorInitializationAction.stores.map((store) => `&${nativeBodyReference(this.context.resources, "propertyCache")}[${store.icIndex}]`).join(", ")} }, ${plan.stores.length});`,
						]
					: [];
			return [
				...begin,
				`if (${fast}) {`,
				`  mal_vm_constructor_initialization_store(${object}, ${cache}, ${this.boxed(instruction.value)});`,
				`} else {`,
				...fallback.map((line) => `  ${line}`),
				`}`,
			];
		}
		const key =
			instruction.opcode === "STORE_PROPERTY_STATIC"
				? `mal_value_from_string(vm->string_constant_atoms[${this.context.relocation.stringIndex(instruction.stringIndex)}])`
				: this.boxed(instruction.key);
		// See LOAD_PROPERTY: a monomorphic data-slot/dense-element hit runs no user code;
		// the general [[Set]] fallback keeps the throw check.
		const receiverName = `__property_receiver_${this.ip}`;
		const exactArray = this.context.nativePlan?.kind === "exact-array-element";
		const arrayReceiver = exactArray
			? `mal_value_to_array_object(${this.boxed(instruction.object)})`
			: `mal_vm_as_array(${this.boxed(instruction.object)})`;
		const arrayPresent = exactArray ? "" : `${receiverName} && `;
		if (instruction.opcode === "STORE_PROPERTY") {
			const numericKey = this.nativeNumberOperand(instruction.key);
			const int32Key =
				numericKey !== null &&
				(this.reps[instruction.key] === "int32" ||
					instructionInputIsInt32(this.context.facts, instruction.key))
					? this.nativeInt32Operand(instruction.key)
					: null;
			const indexBound =
				(instructionInputIntegerRange(this.context.facts, instruction.key)?.minimum ??
					-1) >= 0
					? ""
					: `${int32Key} >= 0 && `;
			const fallback = (position: ReadonlyArray<string>): Array<string> => [
				...position,
				...(this.context.incomingRootPublication ?? []).map((line) => `  ${line}`),
				...(this.context.indexedPropertyInactiveRootMask === undefined
					? []
					: [
							`  ${cInactiveRootMaskPublication(this.context.indexedPropertyInactiveRootMask, this.context.inactiveRootMaskStatements)};`,
						]),
				numericKey !== null
					? `  ${this.profileCall("property", `mal_vm_indexed_fast_store_index(vm, ${this.boxed(instruction.object)}, ${numericKey}, ${this.boxed(instruction.value)}, ${this.strict}, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}])`)};`
					: `  mal_vm_indexed_fast_store(vm, ${this.boxed(instruction.object)}, ${this.boxed(instruction.key)}, ${this.boxed(instruction.value)}, ${this.strict}, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}]);`,
				`  ${this.throwCheck()}`,
			];
			const ordinary = (position: ReadonlyArray<string> = []): Array<string> => {
				if (
					((this.operandKind(instruction.object) ?? COMPILER_VALUE_KIND_TOP) &
						COMPILER_VALUE_KIND_OBJECT) ===
						0 ||
					((this.operandKind(instruction.key) ?? COMPILER_VALUE_KIND_TOP) &
						COMPILER_VALUE_KIND_NUMBER) ===
						0
				)
					return fallback(position);
				return [
					`MalArrayObject *${receiverName} = ${arrayReceiver};`,
					int32Key !== null
						? `if (!(${arrayPresent}${indexBound}mal_vm_array_try_store_proven_index(${receiverName}, (u32) ${int32Key}, ${this.boxed(instruction.value)}))) {`
						: numericKey !== null
							? `if (!(${arrayPresent}mal_vm_array_try_store(${receiverName}, ${numericKey}, ${this.boxed(instruction.value)}))) {`
							: `if (!(${arrayPresent}mal_vm_array_try_store_value_index(${receiverName}, ${this.boxed(instruction.key)}, ${this.boxed(instruction.value)}))) {`,
					...fallback(position),
					`}`,
				];
			};
			if (
				this.context.indexedLengthLoopAction?.role === "element" &&
				this.context.indexedLengthLoopAction.element?.kind === "store"
			) {
				const id = this.context.indexedLengthLoopAction.loadIp;
				const numericKeyGuard =
					this.context.indexedLengthLoopAction.site.reverseInduction !== undefined &&
					this.nativeNumberOperand(instruction.key) === null
						? `mal_ops_is_number(${this.boxed(instruction.key)}) && `
						: "";
				const numericKey =
					this.nativeNumberOperand(instruction.key) ??
					(this.context.indexedLengthLoopAction.site.reverseInduction !== undefined
						? `mal_ops_number_as_f64(${this.boxed(instruction.key)})`
						: this.typedNumber(instruction.key));
				return [
					`if (__indexed_length_${id}_kind == 1 && ${numericKeyGuard}mal_vm_array_try_store(__indexed_length_${id}_array, ${numericKey}, ${this.boxed(instruction.value)})) {`,
					`} else if (__indexed_length_${id}_kind == 2) {`,
					`  mal_vm_numeric_typed_array_store_known_receiver(vm, __indexed_length_${id}_typed_array, ${numericKey}, ${this.boxed(instruction.value)}, ${this.strict});`,
					`  ${this.throwCheck()}`,
					`} else {`,
					...ordinary().map((line) => `  ${line}`),
					`}`,
				];
			}
			return numericKey !== null ? ordinary(this.slowPathFramePosition()) : ordinary();
		}
		const probe = (): string =>
			`${receiverName} && mal_vm_object_try_store_static(${receiverName}, ${this.boxed(instruction.value)}, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}])`;
		const slowStore = [
			...this.slowPathFramePosition(),
			...(this.context.incomingRootPublication ?? []).map((line) => `  ${line}`),
			...(this.context.staticPropertyWriteInactiveRootMask === undefined
				? []
				: [
						`  ${cInactiveRootMaskPublication(this.context.staticPropertyWriteInactiveRootMask, this.context.inactiveRootMaskStatements)};`,
					]),
			`  ${this.profileCall("property", `mal_vm_op_store_property_ic(vm, ${this.boxed(instruction.object)}, ${key}, ${this.boxed(instruction.value)}, ${this.strict}, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}])`)};`,
			`  ${this.throwCheck()}`,
		];
		if (
			((this.operandKind(instruction.object) ?? COMPILER_VALUE_KIND_TOP) &
				COMPILER_VALUE_KIND_OBJECT) ===
			0
		)
			return slowStore;
		const inlineCacheStore = [`if (!(${probe()})) {`, ...slowStore, `}`];
		const classLayout =
			this.context.nativePlan?.kind === "class-layout" &&
			this.context.nativePlan.site.kind === "slot" &&
			this.classLayoutsEnabled
				? this.context.nativePlan.site
				: undefined;
		return [
			`MalObject *${receiverName} = mal_vm_as_object(${this.boxed(instruction.object)});`,
			...(classLayout === undefined
				? inlineCacheStore
				: classLayoutAccess(
						"slot",
						classLayout.candidates,
						receiverName,
						this.boxed(instruction.object),
						({ index }) =>
							`mal_vm_object_slot_store(${receiverName}, ${index}, ${this.boxed(instruction.value)});`,
						inlineCacheStore,
					)),
		];
	}
	emitUnary(
		instruction: Extract<BytecodeInstruction, { opcode: "UNARY" }>,
	): Array<string> | null {
		const { dst, src, operator } = instruction;
		if (operator === "tostring" && this.operandIsString(src))
			return [`r${dst} = ${this.boxed(src)};`];
		const effects = nativeInstructionEffects(instruction, this.context.facts);
		const canThrow = effects.throwing || effects.reentry;
		if (!canThrow) this.elideFramePosition();
		if (
			this.context.indexedLengthLoopAction?.role === "coerce" ||
			this.context.indexedLengthLoopAction?.role === "update"
		) {
			const fallback = this.emitGenericInstruction();
			if (fallback === null) return null;
			const id = this.context.indexedLengthLoopAction.loadIp;
			const update = this.context.indexedLengthLoopAction.role === "update";
			return [
				`if (__indexed_length_${id}_kind == 1) {`,
				...(update ? [`  __indexed_length_${id}_induction -= 1.0;`] : []),
				`  ${this.storeNumber(dst, `__indexed_length_${id}_induction`)}`,
				`} else {`,
				...fallback.map((line) => `  ${line}`),
				`}`,
			];
		}
		if (
			operator === "tostring" &&
			(this.reps[src] === "boolean" ||
				(this.context.facts?.inputKindMasks !== undefined &&
					this.context.facts.inputKindMasks.length === 1 &&
					this.context.facts.inputKindMasks[0]! === COMPILER_VALUE_KIND_BOOLEAN))
		) {
			const value =
				this.reps[src] === "boolean"
					? `r${src}`
					: `mal_value_to_boolean(${this.boxed(src)})`;
			const text = `mal_value_from_string(mal_intrinsic_hot_ascii(vm, ${value} ? MAL_HOT_KEY_TRUE : MAL_HOT_KEY_FALSE))`;
			return [`r${dst} = ${this.callValue(dst, text)};`, this.poll()];
		}
		if (
			operator === "tostring" &&
			this.context.facts?.inputKindMasks?.length === 1 &&
			compilerValueKindMaskIsSubset(
				this.context.facts.inputKindMasks[0]!,
				COMPILER_VALUE_KIND_TO_STRING_PRIMITIVE,
			)
		) {
			const text = `mal_value_from_string(mal_ops_to_string(&vm->heap, ${this.boxed(src)}))`;
			return [`r${dst} = ${this.callValue(dst, text)};`, this.poll()];
		}
		if (
			this.context.facts?.inputKindMasks !== undefined &&
			this.context.facts.inputKindMasks.length === 1 &&
			compilerValueKindMaskIsSubset(
				this.context.facts.inputKindMasks[0]!,
				COMPILER_VALUE_KIND_TO_NUMBER_PRIMITIVE,
			) &&
			!isNumericRep(this.reps[src]!)
		) {
			const value = this.exactPrimitiveNumber(src, this.context.facts.inputKindMasks[0]!);
			const expression =
				operator === "-"
					? `-(${value})`
					: operator === "+" || operator === "tonumeric"
						? value
						: operator === "~"
							? `(f64)(~${numberToInt32(value, instructionInputIsInt32(this.context.facts, src))})`
							: operator === "increment" || operator === "decrement"
								? `${value} ${operator === "increment" ? "+" : "-"} 1.0`
								: null;
			if (expression !== null) return [this.storeNumber(dst, expression)];
		}

		if (this.reps[src] === "boolean") {
			const value = this.coerciveNumberOperand(src)!;
			const expression =
				operator === "-"
					? `-${value}`
					: operator === "+" || operator === "tonumeric"
						? value
						: operator === "~"
							? `(f64) (~(r${src} ? 1 : 0))`
							: operator === "increment" || operator === "decrement"
								? `${value} ${operator === "increment" ? "+" : "-"} 1.0`
								: null;
			if (expression !== null) return [this.storeNumber(dst, expression)];
		}
		if (this.resultIsInt32(dst)) {
			const expression = nativeInt32UnaryExpression(
				operator,
				this.exactInt32Operand(src),
			);
			if (expression !== undefined) {
				this.elideFramePosition();
				return [this.storeNumber(dst, expression)];
			}
		}
		if (isNumericRep(this.reps[src]!) && operator !== "!") {
			if (operator === "~") {
				const expression = `~${this.nativeInt32Operand(src)!}`;
				return [
					`r${dst} = ${this.reps[dst] === "int32" ? expression : this.reps[dst] === "number" ? `(f64) (${expression})` : `mal_value_from_i32(${expression})`};`,
				];
			}
			if (
				dst === src &&
				this.reps[dst] === "number" &&
				(operator === "increment" || operator === "decrement")
			) {
				return [`r${dst} ${operator === "increment" ? "+=" : "-="} 1.0;`];
			}
			const expression =
				operator === "-"
					? `-${this.num(src)}`
					: operator === "increment" || operator === "decrement"
						? `${this.num(src)} ${operator === "increment" ? "+" : "-"} 1.0`
						: operator === "+" || operator === "tonumeric"
							? this.num(src)
							: null;
			if (expression !== null && this.reps[dst] !== "boolean")
				return [this.storeNumber(dst, expression)];
		}
		if (isNumericRep(this.reps[dst]!)) {
			const value = `unary_number_${this.ip}`;
			return [
				`MalValue ${value} = ${this.profileCall("unary", `mal_vm_unary_op_fast(vm, ${emitUnaryOperator(operator)}, ${this.boxed(src)})`)};`,
				...(canThrow ? [this.throwCheck()] : []),
				`r${dst} = ${this.callValue(dst, value)};`,
			];
		}
		if (operator === "!") {
			const negated = `!(${this.truthy(src)})`;
			return [
				this.reps[dst] === "boolean"
					? `r${dst} = ${negated};`
					: `r${dst} = ${this.profileCall("boxing", `mal_value_new_boolean(${negated})`)};`,
			];
		}
		// A boolean-rep dst can only come from `!` (handled above).
		if (this.reps[dst] === "boolean") {
			return null;
		}
		const lowered = [
			`r${dst} = ${this.profileCall("unary", `mal_vm_unary_op_fast(vm, ${emitUnaryOperator(operator)}, ${this.boxed(src)})`)};`,
		];
		if (canThrow) {
			lowered.push(this.throwCheck());
		}
		return lowered;
	}
	emitIteratorStep(
		instruction: Extract<BytecodeInstruction, { opcode: "ITERATOR_STEP" }>,
	): Array<string> | null {
		if (this.context.nativeIteratorEntryPairVirtualizationAction?.role === "outerStep") {
			const { region } = this.context.nativeIteratorEntryPairVirtualizationAction;
			const rec = `iter_rec_${this.ip}`;
			const val = `iter_val_${this.ip}`;
			const done = `iter_done_${this.ip}`;
			const pairStep = `mal_vm_iterator_step_entry_pair_protocol_cursor(vm, &${rec}, &__iter_entry_pair_${this.ip}_first, &__iter_entry_pair_${this.ip}_second, &${done})`;
			const ordinaryStep = `mal_vm_iterator_step(vm, &${rec}, &${val}, &${done})`;
			const deferred =
				this.context.deferredIteratorCursor &&
				this.context.nativeIteratorCursorAction?.role === "step"
					? `__iter_deferred_${this.context.nativeIteratorCursorAction.cursor.initializeIp}`
					: undefined;
			return [
				`MalIteratorRecord ${rec} = { .iterator = ${this.boxed(instruction.iterator)}, .next_method = ${this.boxed(instruction.next)} };`,
				`MalValue ${val} = MAL_VALUE_UNDEFINED; bool ${done};`,
				`__iter_entry_pair_${this.ip}_fast = ${regionAdmissionGuard(region.license)} && ${
					deferred === undefined
						? pairStep
						: `(${deferred}.active ? mal_vm_array_values_deferred_entry_pair_step(vm, ${this.boxed(instruction.iterator)}, &${deferred}, &__iter_entry_pair_${this.ip}_first, &__iter_entry_pair_${this.ip}_second, &${done}) : ${pairStep})`
				};`,
				`if (!__iter_entry_pair_${this.ip}_fast && MAL_THREW()) ${this.onThrow()}`,
				`if (__iter_entry_pair_${this.ip}_fast) { MAL_PERF_COUNT(iterator_entry_pair_hits); } else { MAL_PERF_COUNT(iterator_entry_pair_fallbacks); }`,
				`if (!__iter_entry_pair_${this.ip}_fast && !${
					deferred === undefined
						? ordinaryStep
						: `(${deferred}.active ? mal_vm_array_values_deferred_step(vm, ${this.boxed(instruction.iterator)}, &${deferred}, &${val}, &${done}) : ${ordinaryStep})`
				}) ${this.onThrow()}`,
				`r${instruction.valueDst} = __iter_entry_pair_${this.ip}_fast ? MAL_VALUE_UNDEFINED : ${val};`,
				this.reps[instruction.doneDst] === "boolean"
					? `r${instruction.doneDst} = ${done};`
					: `r${instruction.doneDst} = ${this.profileCall("boxing", `mal_value_new_boolean(${done})`)};`,
			];
		}
		if (this.context.nativeIteratorEntryPairVirtualizationAction?.role === "innerStep") {
			const { region, index } = this.context.nativeIteratorEntryPairVirtualizationAction;
			const fallback = this.emitGenericInstruction();
			if (fallback === null || index === undefined) return null;
			const id = region.outerStepIp;
			const value =
				index === 0 ? `__iter_entry_pair_${id}_first` : `__iter_entry_pair_${id}_second`;
			return [
				`if (__iter_entry_pair_${id}_fast) {`,
				`  r${instruction.valueDst} = ${value};`,
				...(this.reps[instruction.doneDst] === "boolean"
					? [`  r${instruction.doneDst} = false;`]
					: [
							`  r${instruction.doneDst} = ${this.profileCall("boxing", `mal_value_new_boolean(false)`)};`,
						]),
				`} else {`,
				...fallback.map((line) => `  ${line}`),
				`}`,
			];
		}
		const rec = `iter_rec_${this.ip}`;
		const val = `iter_val_${this.ip}`;
		const done = `iter_done_${this.ip}`;
		const virtualResult =
			this.context.nativeIteratorResultVirtualizationAction !== undefined ||
			this.context.nativeRegExpIteratorProjectionAction?.role === "step";
		if (this.context.nativeIteratorResultVirtualizationAction !== undefined) {
			regionAdmissionGuard(
				this.context.nativeIteratorResultVirtualizationAction.region.license,
			);
		}
		const genericStep = virtualResult
			? `mal_vm_iterator_step_fast(vm, &${rec}, &${val}, &${done})`
			: `mal_vm_iterator_step(vm, &${rec}, &${val}, &${done})`;
		const cursorInitializeIp =
			this.context.nativeIteratorCursorAction?.role === "step"
				? this.context.nativeIteratorCursorAction.cursor.initializeIp
				: undefined;
		const cursorStep =
			cursorInitializeIp === undefined
				? undefined
				: this.context.nativeIteratorCursorAction?.cursor.protocol === "array-values"
					? `mal_vm_iterator_step_dense_array_cursor(vm, __iter_cursor_${cursorInitializeIp}, &${rec}, &${val}, &${done})`
					: `mal_vm_iterator_step_protocol_cursor(vm, __iter_cursor_${cursorInitializeIp}, &${rec}, &${val}, &${done})`;
		const deferred =
			this.context.deferredIteratorCursor && cursorInitializeIp !== undefined
				? `__iter_deferred_${cursorInitializeIp}`
				: undefined;
		const deferredOr = (call: string, otherwise: string): string =>
			deferred === undefined
				? otherwise
				: `(${deferred}.active ? ${call} : ${otherwise})`;
		const deferredStep = `mal_vm_array_values_deferred_step(vm, ${this.boxed(instruction.iterator)}, &${deferred}, &${val}, &${done})`;
		const step = deferredOr(
			deferredStep,
			cursorStep !== undefined
				? `(__iter_cursor_${cursorInitializeIp} != nullptr ? ${cursorStep} : ${genericStep})`
				: genericStep,
		);
		if (this.context.nativeRegExpIteratorProjectionAction?.role === "step") {
			const site = this.context.nativeRegExpIteratorProjectionAction.site;
			const admission = regionAdmissionGuard(site.projection.license);
			const indices = site.loads.map((load) => load.captureIndex).join(", ");
			const outputs = site.loads
				.map((_load, index) => `&__gc_slots[${site.slotsOffset + index}]`)
				.join(", ");
			const status = `regexp_iter_status_${this.ip}`;
			return [
				`MalIteratorRecord ${rec} = { .iterator = ${this.boxed(instruction.iterator)}, .next_method = ${this.boxed(instruction.next)} };`,
				`MalValue ${val}; bool ${done};`,
				`__regexp_iter_${site.projection.stepIp}_projected = false;`,
				`int ${status} = ${admission} ? ${this.profileCall("regexp", `mal_regexp_try_exact_iterator_capture_projection(vm, ${this.boxed(instruction.iterator)}, ${this.boxed(instruction.next)}, (const u32[]){ ${indices} }, (MalValue *[]){ ${outputs} }, ${site.loads.length}, __regexp_iter_${site.projection.stepIp}_starts, __regexp_iter_${site.projection.stepIp}_ends, &__gc_slots[${site.subjectSlot}], &${val}, &${done})`)} : 0;`,
				`if (${status} < 0) ${this.onThrow()}`,
				`if (${status} == 0 && !(${step})) ${this.onThrow()}`,
				`__regexp_iter_${site.projection.stepIp}_projected = ${status} > 0 && mal_value_is_boolean(${val});`,
				`r${instruction.valueDst} = ${val};`,
				this.reps[instruction.doneDst] === "boolean"
					? `r${instruction.doneDst} = ${done};`
					: `r${instruction.doneDst} = ${this.profileCall("boxing", `mal_value_new_boolean(${done})`)};`,
			];
		}
		const denseArrayProbe = `mal_vm_iterator_try_dense_array_step(&${rec}, &${val}, &${done})`;
		const denseArrayCursorProbe = `mal_vm_iterator_try_dense_array_cursor_step(__iter_cursor_${cursorInitializeIp}, &${val}, &${done})`;
		const denseProbe =
			cursorInitializeIp === undefined
				? denseArrayProbe
				: `(__iter_cursor_${cursorInitializeIp} != nullptr ? ${denseArrayCursorProbe} : ${denseArrayProbe})`;
		const iteratorProbe = deferredOr(
			`mal_vm_array_values_deferred_try_step(${this.boxed(instruction.iterator)}, &${deferred}, &${val}, &${done})`,
			this.context.nativeIteratorCursorAction?.cursor.protocol === "string"
				? `(__iter_cursor_${cursorInitializeIp} != nullptr && mal_vm_iterator_try_string_cursor_step(vm, __iter_cursor_${cursorInitializeIp}, &${val}, &${done}))`
				: this.context.nativeIteratorCursorAction?.cursor.protocol === "array-values" &&
					  cursorInitializeIp !== undefined
					? `(__iter_cursor_${cursorInitializeIp} != nullptr ? ${denseArrayCursorProbe} : (__iter_string_cursor_${cursorInitializeIp} != nullptr ? mal_vm_iterator_try_string_cursor_step(vm, __iter_string_cursor_${cursorInitializeIp}, &${val}, &${done}) : (${denseArrayProbe} || mal_vm_iterator_try_string_step(vm, &${rec}, &${val}, &${done}))))`
					: `(${denseProbe} || mal_vm_iterator_try_string_step(vm, &${rec}, &${val}, &${done}))`,
		);
		const iteratorFallback =
			this.context.nativeIteratorCursorAction?.cursor.protocol === "string"
				? step
				: deferredOr(
						deferredStep,
						`mal_vm_iterator_step(vm, &${rec}, &${val}, &${done})`,
					);
		const advance = this.context.iteratorStepRootPublication
			? [
					`if (!${iteratorProbe}) {`,
					...(this.context.incomingRootPublication ?? []).map((line) => `  ${line}`),
					...(this.context.iteratorStepInactiveRootMask === undefined
						? []
						: [
								`  ${cInactiveRootMaskPublication(this.context.iteratorStepInactiveRootMask, this.context.inactiveRootMaskStatements)};`,
							]),
					`  if (!(${iteratorFallback})) ${this.onThrow()}`,
					`}`,
				]
			: [`if (!(${step})) ${this.onThrow()}`];
		const lines = [
			`MalIteratorRecord ${rec} = { .iterator = ${this.boxed(instruction.iterator)}, .next_method = ${this.boxed(instruction.next)} };`,
			`MalValue ${val}; bool ${done};`,
			...advance,
			`r${instruction.valueDst} = ${val};`,
			this.reps[instruction.doneDst] === "boolean"
				? `r${instruction.doneDst} = ${done};`
				: `r${instruction.doneDst} = ${this.profileCall("boxing", `mal_value_new_boolean(${done})`)};`,
		];
		if (this.context.nativeArrayPairDestructureAction?.role === "step") {
			const id = this.context.nativeArrayPairDestructureAction.cursor.initializeIp;
			const suffix =
				this.context.nativeArrayPairDestructureAction.index === 0 ? "first" : "second";
			return [
				`if (__array_pair_${id}_fast) {`,
				`  r${instruction.valueDst} = __array_pair_${id}_${suffix};`,
				...(this.reps[instruction.doneDst] === "boolean"
					? [`  r${instruction.doneDst} = __array_pair_${id}_${suffix}_done;`]
					: [
							`  r${instruction.doneDst} = ${this.profileCall("boxing", `mal_value_new_boolean(__array_pair_${id}_${suffix}_done)`)};`,
						]),
				`} else {`,
				...lines.map((line) => `  ${line}`),
				`}`,
			];
		}
		return lines;
	}
	emitReturn(
		instruction: Extract<BytecodeInstruction, { opcode: "RETURN" }>,
	): Array<string> | null {
		// Register -1 is the "no value" sentinel (a synthesized empty return).
		let value =
			instruction.value < 0 ? "MAL_VALUE_UNDEFINED" : this.boxed(instruction.value);
		if (
			this.context.directResultRepresentation !== undefined &&
			!(
				this.context.directResultRepresentation === "boxed" &&
				this.context.stackObjectMaterialization !== undefined
			)
		) {
			if (this.context.stackObjectMaterialization !== undefined) return null;
			if (instruction.value < 0) {
				return [
					`${this.gcUnlink}return ${zeroOf(this.context.directResultRepresentation)};`,
				];
			}
			const directValue =
				this.context.directResultRepresentation === "int32"
					? this.reps[instruction.value] === "int32"
						? `r${instruction.value}`
						: `mal_ops_number_to_i32(${this.num(instruction.value)})`
					: this.context.directResultRepresentation === "number"
						? isNumericRep(this.reps[instruction.value]!)
							? this.num(instruction.value)
							: `mal_ops_number_as_f64(${this.boxed(instruction.value)})`
						: this.context.directResultRepresentation === "boolean"
							? this.reps[instruction.value] === "boolean"
								? `r${instruction.value}`
								: `mal_value_to_boolean(${this.boxed(instruction.value)})`
							: this.boxed(instruction.value);
			this.elideFramePosition();
			return [`${this.gcUnlink}return ${directValue};`];
		}
		const materialize: Array<string> = [];
		if (this.context.stackObjectMaterialization !== undefined) {
			const materialized = `materialized_ret_${this.ip}`;
			const fields = this.context.stackObjectMaterialization.site.fieldSlots;
			const helper =
				fields === undefined
					? `mal_vm_materialize_stack_object(vm, &${this.context.stackObjectMaterialization.site.objectName}.object)`
					: `mal_vm_materialize_stack_object_fields(vm, &${this.context.stackObjectMaterialization.site.objectName}.object, __stack_return_values_${this.ip}, ${fields.length})`;
			if (fields !== undefined)
				materialize.push(
					`MalValue __stack_return_values_${this.ip}[${fields.length}] = { ${fields
						.map((field) =>
							this.convertedValue(field.representation, "boxed", field.name),
						)
						.join(", ")} };`,
				);
			materialize.push(`MalValue ${materialized} = ${helper};`, this.throwCheck());
			value = materialized;
		}
		// A coroutine body's return completes the activation: free its buffer and
		// settle its promise / hand the value to the .next() driver.
		if (this.coro !== null) {
			return [
				...materialize,
				`${this.gcUnlink}mal_vm_op_coroutine_return_compiled(vm, __coro, ${value});`,
				`return ${this.coroReturnValue};`,
			];
		}
		const completion =
			this.context.nativePlan?.kind === "return-completion"
				? this.context.nativePlan.result
				: undefined;
		// Object completions also bypass an uninitialized derived receiver before super().
		if (completion === "object") {
			if (materialize.length === 0) this.elideFramePosition();
			return [...materialize, `${this.gcUnlink}return ${value};`];
		}
		// A derived constructor substitutes the super-bound `this` for a
		// non-object return, and returning before super() bound it is a
		// ReferenceError — so route through the checked helper (which can throw).
		if (this.thisSlot >= 0) {
			const ret = `derived_ret_${this.ip}`;
			return [
				...materialize,
				`MalValue ${ret} = mal_vm_op_derived_construct_return(vm, ${value}, ${this.thisRef});`,
				this.throwCheck(),
				`${this.gcUnlink}return ${ret};`,
			];
		}
		if (materialize.length === 0) this.elideFramePosition();
		if (!this.context.hasPrototype) {
			return [...materialize, `${this.gcUnlink}return ${value};`];
		}
		if (completion === "primitive")
			return [
				...materialize,
				`${this.gcUnlink}return mal_value_is_object(${nativeBodyReference(this.context.resources, "newTarget")}) ? this_value : ${value};`,
			];
		// Route through mal_ops_construct_result so a [[Construct]] invocation
		// (new_target set) substitutes `this` for a non-object completion; a
		// plain call passes the value through unchanged.
		return [
			...materialize,
			`${this.gcUnlink}return mal_ops_construct_result(${value}, this_value, ${nativeBodyReference(this.context.resources, "newTarget")});`,
		];
	}

	emitOrdinary(instruction: BytecodeInstruction): Array<string> | null {
		switch (instruction.opcode) {
			case "MOVE": {
				if (this.context.staticPropertyNumericAction?.role !== "skip")
					throw new Error("Native MOVE requires its property projection overlay");
				const fallback = this.emitGenericInstruction();
				if (fallback === null) return null;
				return [
					`if (!__property_projection_${this.context.staticPropertyNumericAction.plan.id}_fast) {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			case "BASE_CONSTRUCT_RESULT":
				return [
					`r${instruction.dst} = mal_value_is_object(${this.boxed(instruction.value)}) ? ${this.boxed(instruction.value)} : ${this.boxed(instruction.receiver)};`,
				];
			case "THROW_IF_TDZ": {
				if (this.context.staticPropertyNumericAction?.role === "skip") {
					const fallback = this.emitGenericInstruction();
					if (fallback === null) return null;
					return [
						`if (!__property_projection_${this.context.staticPropertyNumericAction.plan.id}_fast) {`,
						...fallback.map((line) => `  ${line}`),
						`}`,
					];
				}
				return [
					`if (mal_value_is_empty(${this.boxed(instruction.src)})) {`,
					...this.slowPathFramePosition(),
					...(this.context.incomingRootPublication ?? []).map((line) => `  ${line}`),
					...(this.context.valueGuardInactiveRootMask === undefined
						? []
						: [
								`  ${cInactiveRootMaskPublication(this.context.valueGuardInactiveRootMask, this.context.inactiveRootMaskStatements)};`,
							]),
					`  mal_vm_op_throw_if_tdz(vm, ${this.boxed(instruction.src)}, ${this.context.relocation.stringIndex(instruction.nameStringIndex)});`,
					`  ${this.throwCheck()}`,
					`}`,
				];
			}
			case "IS_EMPTY":
				if (this.reps[instruction.src] !== "boxed")
					return [this.storeBoolean(instruction.dst, "false")];
				return [
					this.reps[instruction.dst] === "boolean"
						? `r${instruction.dst} = mal_value_is_empty(${this.boxed(instruction.src)});`
						: `r${instruction.dst} = ${this.profileCall("boxing", `mal_value_new_boolean(mal_value_is_empty(${this.boxed(instruction.src)}))`)};`,
				];
			case "CREATE_OBJECT":
				if (this.context.stackObjectSite === undefined) {
					return [
						`r${instruction.dst} = ${this.profileCall("allocation", `mal_vm_op_create_object(vm)`)};`,
						this.throwCheck(),
					];
				}
				if (this.context.stackObjectSite.elided === true) {
					return [`r${instruction.dst} = MAL_VALUE_UNDEFINED;`];
				}
				return [
					"mal_perf_stack_object_init();",
					`mal_object_init_embedded_stack(&vm->heap, &${this.context.stackObjectSite.objectName}, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]), mal_shape_root(&vm->heap), nullptr);`,
					`r${instruction.dst} = mal_value_from_object(&${this.context.stackObjectSite.objectName}.object);`,
				];
			case "CREATE_BASE_CONSTRUCT_RECEIVER":
				return [
					`r${instruction.dst} = ${this.profileCall("allocation", `mal_vm_op_create_base_construct_receiver(vm, ${this.boxed(instruction.newTarget)}, ${instruction.constructorSlotReserve})`)};`,
					this.throwCheck(),
				];
			case "CREATE_OBJECT_SHAPED":
				return this.emitObjectLiteral(instruction);
			case "CREATE_ARRAY":
				if (this.context.nativePlan?.kind === "fresh-dense-reserve") {
					return [
						`r${instruction.dst} = ${this.profileCall("allocation", `mal_vm_op_create_array(vm, ${instruction.length})`)};`,
						`(void) mal_vm_try_fresh_dense_indexed_fill_reserve(vm, r${instruction.dst}, ${this.context.nativePlan.length});`,
					];
				}
				return [
					`r${instruction.dst} = ${this.profileCall("allocation", `mal_vm_op_create_array(vm, ${instruction.length})`)};`,
				];
			case "CREATE_ARRAY_FROM_ITERABLE":
				return [
					`r${instruction.dst} = ${this.profileCall("allocation", `mal_builtin_array_from_iterable(vm, ${this.boxed(instruction.src)})`)};`,
					this.throwCheck(),
				];
			case "INSTANTIATE_LITERAL_TEMPLATE": {
				const instantiate = `r${instruction.dst} = mal_vm_instantiate_literal_template(vm, ${this.context.relocation.templateOffset(instruction.templateOffset)}, ${instruction.cacheSlot === undefined ? "-1" : this.context.relocation.globalIndex(instruction.cacheSlot)});`;
				if (instruction.cacheSlot !== undefined)
					return [
						`r${instruction.dst} = vm->globals[${this.context.relocation.globalIndex(instruction.cacheSlot)}];`,
						`if (mal_value_is_undefined(r${instruction.dst})) {`,
						instantiate,
						this.throwCheck(),
						"}",
					];
				return [instantiate, this.throwCheck()];
			}
			case "QUERY_STATIC_DATA": {
				const result = `static_query_result_${this.ip}`;
				const effects = nativeInstructionEffects(instruction, this.context.facts);
				return [
					`MalValue ${result} = ${this.profileCall(instruction.queryKind === "has-own" ? "property" : "call", `mal_vm_query_static_data(vm, ${this.context.relocation.templateOffset(instruction.templateOffset)}, ${staticDataQueryTag(instruction.queryKind)}, ${this.boxed(instruction.needle)}, ${this.boxed(instruction.fromIndex)})`)};`,
					...(effects.throwing || effects.reentry ? [this.throwCheck()] : []),
					`r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
				];
			}
			case "CREATE_FUNCTION": {
				const create = `mal_vm_op_create_function(vm, ${this.context.relocation.functionIndex(instruction.functionIndex)}, env)`;
				const closure =
					this.context.nativePlan?.kind === "direct-closure"
						? this.context.directClosures?.get(
								nativeDirectClosureKey(
									instruction.functionIndex,
									this.context.functionIndex ?? -1,
								),
							)
						: undefined;
				const start =
					closure?.kind === "outer-chain"
						? `mal_vm_capture_owner_at(env, ${this.context.relocation.ownerFunctionIndex(closure.owner)}, 0)`
						: "env";
				if (closure?.kind !== "chain" && closure?.kind !== "outer-chain")
					return [
						...ensureCaptureEnvironment(this.context.captureShadow, this.ip),
						closure === undefined
							? `r${instruction.dst} = ${create};`
							: `r${instruction.dst} = MAL_VALUE_EMPTY;`,
					];
				const chainTest = `mal_vm_closure_chain_has_owners(vm, ${this.context.relocation.functionIndex(instruction.functionIndex)}, ${start})`;
				const memo = this.context.closureChainTests?.get(this.ip);
				return [
					...ensureCaptureEnvironment(this.context.captureShadow, this.ip),
					memo === undefined
						? `r${instruction.dst} = ${chainTest} ? MAL_VALUE_EMPTY : ${create};`
						: `r${instruction.dst} = (${memo} < 0 ? (${memo} = (i8) ${chainTest}) : ${memo}) ? MAL_VALUE_EMPTY : ${create};`,
				];
			}
			case "DEFINE_PROPERTY":
				return this.emitDefineProperty(instruction);
			case "DEFINE_ACCESSOR":
				// Object-literal / class getter or setter; no user code run.
				return [
					`mal_vm_op_define_accessor(vm, ${this.boxed(instruction.object)}, ${this.boxed(instruction.key)}, ${this.boxed(instruction.accessor)}, ${instruction.enumerable}, ${instruction.isSetter});`,
				];
			case "SET_PROTOTYPE":
				// Object-literal `__proto__:` member / class heritage; no user code run.
				return [
					`mal_vm_op_set_prototype(vm, ${this.boxed(instruction.object)}, ${this.boxed(instruction.prototype)}, ${instruction.literal});`,
				];
			case "MERGE_DATA_PROPERTIES":
				// Object spread `{...src}`: a source getter can throw, so propagate.
				return [
					`mal_vm_op_merge_data_properties(vm, ${this.boxed(instruction.target)}, ${this.boxed(instruction.src)});`,
					this.throwCheck(),
				];
			case "DELETE_PROPERTY": {
				if (
					compilerValueKindsHaveEmptyPrimitiveWrappers(
						this.operandKind(instruction.object) ?? COMPILER_VALUE_KIND_TOP,
					)
				) {
					const coercion =
						((this.operandKind(instruction.key) ?? COMPILER_VALUE_KIND_TOP) &
							COMPILER_VALUE_KIND_OBJECT) ===
						0
							? []
							: [
									`mal_vm_op_to_property_key(vm, ${this.boxed(instruction.object)}, ${this.boxed(instruction.key)});`,
									this.throwCheck(),
								];
					return [...coercion, this.storeBoolean(instruction.dst, "true")];
				}
				return this.boxedLoad(
					instruction.dst,
					`mal_vm_op_delete_property(vm, ${this.boxed(instruction.object)}, ${this.boxed(instruction.key)}, ${this.strict})`,
				);
			}
			case "LOAD_THIS":
				// A derived constructor's `this` is in a TDZ until super() binds it, so a
				// read before then is a ReferenceError; an ordinary function's `this` is
				// always initialized and reads straight from the parameter.
				return this.thisSlot >= 0
					? [
							`r${instruction.dst} = mal_vm_op_get_this(vm, ${this.thisRef});`,
							this.throwCheck(),
						]
					: [`r${instruction.dst} = this_value;`];
			case "LOAD_NEW_TARGET":
				return [
					`r${instruction.dst} = ${nativeBodyReference(this.context.resources, "newTarget")};`,
				];
			case "GUARD_FUNCTION_INDEX":
				if (this.reps[instruction.callee] !== "boxed")
					return [this.storeBoolean(instruction.dst, "false")];
				return [
					`r${instruction.dst} = mal_vm_callee_has_index(vm, ${this.boxed(instruction.callee)}, ${this.context.relocation.functionIndex(instruction.functionIndex)});`,
				];
			case "GUARD_BASE_CONSTRUCTOR_LAYOUT":
				if (this.reps[instruction.callee] !== "boxed")
					return [this.storeBoolean(instruction.dst, "false")];
				return [
					`r${instruction.dst} = mal_vm_guard_base_constructor_layout(vm, ${this.boxed(instruction.callee)}, ${this.context.relocation.functionIndex(instruction.functionIndex)}, ${instruction.keyStringIndices.length}, (const i32[]){ ${instruction.keyStringIndices.map((index) => this.context.relocation.stringIndex(index)).join(", ")} }, ${instruction.methodStringIndex < 0 ? -1 : this.context.relocation.stringIndex(instruction.methodStringIndex)}, ${instruction.methodFunctionIndex < 0 ? -1 : this.context.relocation.functionIndex(instruction.methodFunctionIndex)}, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}]);`,
				];
			case "LOAD_CALLEE":
				// The invoked closure — used to initialize a named function expression's
				// own-name binding. Only emitted in the entry prologue, so `callee` is the
				// fresh-call parameter (a coroutine resume skips the prologue).
				return [`r${instruction.dst} = callee;`];
			case "LOAD_CAPTURED": {
				const load = renderCapturedLoad(
					instruction,
					this.ip,
					this.context,
					this.context.relocation,
				);
				const materialize = this.context.nativePlan;
				if (
					materialize?.kind !== "closure-materialization" ||
					this.context.directClosures?.has(
						nativeDirectClosureKey(
							materialize.functionIndex,
							instruction.ownerFunctionIndex,
						),
					) !== true
				)
					return load;
				const owner = instruction.ownerFunctionIndex;
				const scope = `__closure_scope_${this.ip}`;
				const scopeExpression =
					owner === this.context.ownedCaptureFunctionIndex
						? "env"
						: this.context.fixedCaptureOwners?.has(owner) === true
							? captureOwnerName(this.context.relocation, owner)
							: `mal_vm_capture_owner(env, ${this.context.relocation.ownerFunctionIndex(owner)})`;
				// The owner left the marker instead of the object; the first escaping read creates it.
				return [
					...load,
					`if (__builtin_expect(mal_value_is_empty(r${instruction.dst}), 0)) {`,
					...(owner === this.context.ownedCaptureFunctionIndex
						? ensureCaptureEnvironment(this.context.captureShadow, this.ip).map(
								(line) => `  ${line}`,
							)
						: []),
					`  MalEnv *${scope} = ${scopeExpression};`,
					// A copied capture keeps the marker after an earlier read created the object.
					`  r${instruction.dst} = ${scope}->slots[${instruction.index}];`,
					`  if (mal_value_is_empty(r${instruction.dst})) {`,
					`    r${instruction.dst} = mal_vm_op_create_function(vm, ${this.context.relocation.functionIndex(materialize.functionIndex)}, ${scope});`,
					`    mal_gc_write_barrier(${scope}->slots[${instruction.index}]);`,
					`    ${scope}->slots[${instruction.index}] = r${instruction.dst};`,
					`    mal_gc_card(&${scope}->header, r${instruction.dst});`,
					"  }",
					"}",
				];
			}
			case "STORE_CAPTURED": {
				const needsCard = !compilerValueKindMaskIsSubset(
					this.operandKind(instruction.src) ?? COMPILER_VALUE_KIND_TOP,
					COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE,
				);
				const fixedOwner = this.context.fixedCaptureOwners?.has(
					instruction.ownerFunctionIndex,
				);
				const owner = fixedOwner
					? captureOwnerName(this.context.relocation, instruction.ownerFunctionIndex)
					: instruction.ownerFunctionIndex === this.context.ownedCaptureFunctionIndex
						? "env"
						: undefined;
				if (owner === undefined)
					return [
						`${needsCard ? "mal_vm_store_captured" : "mal_vm_store_captured_non_heap"}(env, ${this.context.relocation.ownerFunctionIndex(instruction.ownerFunctionIndex)}, ${instruction.index}, ${this.boxed(instruction.src)});`,
					];
				const store = [
					`mal_gc_write_barrier(${owner}->slots[${instruction.index}]);`,
					`${owner}->slots[${instruction.index}] = ${this.boxed(instruction.src)};`,
					...(needsCard
						? [`mal_gc_card(&${owner}->header, ${this.boxed(instruction.src)});`]
						: []),
				];
				if (fixedOwner) {
					if (this.context.requiredCaptureOwners?.has(instruction.ownerFunctionIndex))
						return store;
					return [`if (${owner} != nullptr) {`, ...store.map((line) => `  ${line}`), `}`];
				}
				const shadow = this.context.captureShadow;
				const state = shadow?.plan.states[this.ip] ?? ENVIRONMENT_PRESENT;
				if (shadow === undefined || (state & ENVIRONMENT_ABSENT) === 0) return store;
				const frame = `__gc_slots[${shadow.base + instruction.index}] = ${this.boxed(instruction.src)};`;
				if (state === ENVIRONMENT_ABSENT) return [frame];
				return [
					"if (__capture_env_ready) {",
					...store.map((line) => `  ${line}`),
					"} else {",
					`  ${frame}`,
					"}",
				];
			}
			case "ENV_PUSH":
			case "ENV_COPY":
			case "ENV_POP": {
				// Per-iteration loop env: reassign the `env` local (the body's
				// LOAD/STORE_CAPTURED + CREATE_FUNCTION read it) and keep the root frame's
				// env pointer current so the GC roots the live env chain. A capturing loop
				// always has a root frame (it creates a closure → a MalValue register).
				const frameUpdate = rootFrameEnvUpdate(this.gcUnlink);
				if (instruction.opcode === "ENV_POP") {
					return [`env = env->parent;${frameUpdate}`];
				}
				if (instruction.opcode === "ENV_PUSH") {
					return [
						`env = mal_env_new(vm, env, ${instruction.scopeId}, ${instruction.slotCount});${frameUpdate}`,
					];
				}
				// ENV_COPY: fresh sibling env (same parent), bindings copied forward. The
				// old env stays rooted via __gc_frame.env until the reassignment below.
				return [
					`{ MalEnv *__old_env = env; env = mal_env_new(vm, __old_env->parent, ${instruction.scopeId}, ${instruction.slotCount}); for (i32 __i = 0; __i < ${instruction.slotCount}; __i++) env->slots[__i] = __old_env->slots[__i]; }${frameUpdate}`,
				];
			}
			case "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT": {
				if (this.context.stackObjectAccess !== undefined) {
					const { site, slot } = this.context.stackObjectAccess;
					return [this.stackLoad(site, slot, instruction.dst)];
				}
				const candidates = instruction.candidates.flatMap((candidate) => [
					this.context.relocation.functionIndex(candidate.shapeFunctionIndex),
					candidate.shapeCacheIndex,
					candidate.slot,
				]);
				return [
					`MalValue __known_own_slot_${this.ip};`,
					`${this.context.relocation.enabled ? "" : "static "}const i32 __known_own_slot_candidates_${this.ip}[] = { ${candidates.join(", ")} };`,
					`if (mal_vm_try_load_known_own_slots(vm, ${this.boxed(instruction.object)}, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}], ${instruction.candidates.length}, __known_own_slot_candidates_${this.ip}, &__known_own_slot_${this.ip})) {`,
					`  r${instruction.dst} = ${this.callValue(instruction.dst, `__known_own_slot_${this.ip}`)};`,
					`} else {`,
					...(this.context.incomingRootPublication ?? []).map((line) => `  ${line}`),
					...(this.context.guardedPropertyLoadInactiveRootMask === undefined
						? []
						: [
								`  ${cInactiveRootMaskPublication(this.context.guardedPropertyLoadInactiveRootMask, this.context.inactiveRootMaskStatements)};`,
							]),
					...this.boxedLoad(
						instruction.dst,
						this.profileCall(
							"property",
							`mal_vm_op_load_property_ic(vm, ${this.boxed(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${this.context.relocation.stringIndex(instruction.stringIndex)}]), &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}])`,
						),
					).map((line) => `  ${line}`),
					`}`,
				];
			}
			case "SELECT_SHAPE_CASE": {
				const candidates = instruction.candidates.flatMap((candidate) => [
					this.context.relocation.functionIndex(candidate.shapeFunctionIndex),
					candidate.shapeCacheIndex,
				]);
				const selected = `mal_vm_select_shape_case(vm, ${this.boxed(instruction.object)}, ${instruction.candidates.length}, __shape_case_candidates_${this.ip})`;
				return [
					`${this.context.relocation.enabled ? "" : "static "}const i32 __shape_case_candidates_${this.ip}[] = { ${candidates.join(", ")} };`,
					this.reps[instruction.dst] === "number"
						? `r${instruction.dst} = (f64) ${selected};`
						: `r${instruction.dst} = mal_value_from_i32(${selected});`,
				];
			}
			case "LOAD_PROPERTY_STATIC_SHAPE_CASE": {
				const selected =
					this.reps[instruction.shapeCase] === "number"
						? `(i32) r${instruction.shapeCase}`
						: `(mal_value_is_int32(r${instruction.shapeCase}) ? mal_value_to_i32(r${instruction.shapeCase}) : -1)`;
				return [
					`MalValue __shape_case_value_${this.ip};`,
					`static const i32 __shape_case_slots_${this.ip}[] = { ${instruction.slots.join(", ")} };`,
					`if (mal_vm_try_load_shape_case(${this.boxed(instruction.object)}, ${selected}, ${instruction.slots.length}, __shape_case_slots_${this.ip}, &__shape_case_value_${this.ip})) {`,
					`  r${instruction.dst} = ${this.callValue(instruction.dst, `__shape_case_value_${this.ip}`)};`,
					`} else {`,
					...this.boxedLoad(
						instruction.dst,
						this.profileCall(
							"property",
							`mal_vm_op_load_property_ic(vm, ${this.boxed(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${this.context.relocation.stringIndex(instruction.stringIndex)}]), &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}])`,
						),
					).map((line) => `  ${line}`),
					`}`,
				];
			}
			case "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT": {
				if (this.context.stackObjectAccess !== undefined) {
					const { site, slot } = this.context.stackObjectAccess;
					return [this.stackStore(site, slot, instruction.value)];
				}
				const candidates = instruction.candidates.flatMap((candidate) => [
					this.context.relocation.functionIndex(candidate.shapeFunctionIndex),
					candidate.shapeCacheIndex,
					candidate.slot,
				]);
				return [
					`${this.context.relocation.enabled ? "" : "static "}const i32 __known_own_slot_store_candidates_${this.ip}[] = { ${candidates.join(", ")} };`,
					`if (!mal_vm_try_store_known_own_slots(vm, ${this.boxed(instruction.object)}, ${this.boxed(instruction.value)}, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}], ${instruction.candidates.length}, __known_own_slot_store_candidates_${this.ip})) {`,
					...(this.context.incomingRootPublication ?? []).map((line) => `  ${line}`),
					...(this.context.staticPropertyWriteInactiveRootMask === undefined
						? []
						: [
								`  ${cInactiveRootMaskPublication(this.context.staticPropertyWriteInactiveRootMask, this.context.inactiveRootMaskStatements)};`,
							]),
					`  ${this.profileCall("property", `mal_vm_op_store_property_ic(vm, ${this.boxed(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${this.context.relocation.stringIndex(instruction.stringIndex)}]), ${this.boxed(instruction.value)}, ${this.strict}, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}])`)};`,
					`  ${this.throwCheck()}`,
					`}`,
				];
			}
			case "LOAD_PROPERTY_STATIC_ARRAY_LENGTH": {
				const direct = this.storeNumber(
					instruction.dst,
					`(f64) mal_array_object_length(mal_value_to_array_object(${this.boxed(instruction.object)}))`,
				);
				return [
					`if (mal_value_is_heap_type(${this.boxed(instruction.object)}, MAL_HEAP_ARRAY_OBJECT)) {`,
					`  ${direct}`,
					`} else {`,
					...(this.context.incomingRootPublication ?? []).map((line) => `  ${line}`),
					...(this.context.guardedPropertyLoadInactiveRootMask === undefined
						? []
						: [
								`  ${cInactiveRootMaskPublication(this.context.guardedPropertyLoadInactiveRootMask, this.context.inactiveRootMaskStatements)};`,
							]),
					...this.boxedLoad(
						instruction.dst,
						this.profileCall(
							"property",
							`mal_vm_op_load_property_ic(vm, ${this.boxed(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${this.context.relocation.stringIndex(instruction.stringIndex)}]), &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}])`,
						),
					).map((line) => `  ${line}`),
					`}`,
				];
			}
			case "LOAD_PROPERTY":
			case "LOAD_PROPERTY_STATIC":
				return this.emitPropertyLoad(instruction);
			case "STORE_PROPERTY":
			case "STORE_PROPERTY_STATIC":
				return this.emitPropertyStore(instruction);
			case "TO_PROPERTY_KEY":
				if (
					compilerValueKindMaskIsSubset(
						this.operandKind(instruction.key) ?? COMPILER_VALUE_KIND_TOP,
						COMPILER_VALUE_KIND_STRING | COMPILER_VALUE_KIND_SYMBOL,
					)
				) {
					const copy = `r${instruction.dst} = ${this.boxed(instruction.key)};`;
					if (
						((this.operandKind(instruction.object) ?? COMPILER_VALUE_KIND_TOP) &
							COMPILER_VALUE_KIND_NULLISH) ===
						0
					)
						return [copy];
					return [
						`if (mal_value_is_nil(${this.boxed(instruction.object)})) {`,
						`  r${instruction.dst} = mal_vm_op_to_property_key(vm, ${this.boxed(instruction.object)}, ${this.boxed(instruction.key)});`,
						`  ${this.throwCheck()}`,
						"} else {",
						`  ${copy}`,
						"}",
					];
				}
				return [
					`r${instruction.dst} = mal_vm_op_to_property_key(vm, ${this.boxed(instruction.object)}, ${this.boxed(instruction.key)});`,
					this.throwCheck(),
				];
			case "LOAD_GLOBAL_INDEX":
				return [
					`r${instruction.dst} = mal_value_from_i32(${this.context.relocation.globalIndex(instruction.index)});`,
				];
			case "LOAD_GLOBAL":
				return [
					`r${instruction.dst} = vm->globals[${this.context.relocation.globalIndex(instruction.index)}];`,
				];
			case "STORE_GLOBAL":
				return [
					`vm->globals[${this.context.relocation.globalIndex(instruction.index)}] = ${this.boxed(instruction.src)};`,
				];
			case "STORE_GLOBAL_PROPERTY":
				// A var/function declaration that becomes a property of globalThis.
				return [
					`mal_vm_op_store_global_property(vm, ${this.context.relocation.stringIndex(instruction.nameStringIndex)}, ${this.boxed(instruction.src)}, ${this.strict}, ${instruction.declaration}, ${instruction.declarationConfigurable});`,
					this.throwCheck(),
				];
			case "DECLARE_GLOBAL_LEXICAL":
				return [
					`mal_vm_op_declare_global_lexical(vm, ${this.context.relocation.stringIndex(instruction.nameStringIndex)}, ${this.context.relocation.globalIndex(instruction.index)}, ${instruction.immutable}, ${instruction.checkOnly});`,
					this.throwCheck(),
				];
			case "GLOBAL_BINDING_QUERY":
				return [
					`r${instruction.dst} = mal_vm_op_global_binding_query(vm, ${this.context.relocation.stringIndex(instruction.nameStringIndex)}, ${["typeof", "has", "delete"].indexOf(instruction.query)});`,
					this.throwCheck(),
				];
			case "INIT_GLOBAL_VARS":
				return [
					`mal_vm_op_init_global_vars(vm, ${instruction.nameStringIndices.length}, (const i32[]){ ${instruction.nameStringIndices.map((index) => this.context.relocation.stringIndex(index)).join(", ")} }, ${instruction.declarationConfigurable});`,
					this.throwCheck(),
				];
			case "CREATE_ARGUMENTS_OBJECT":
				return [
					`r${instruction.dst} = mal_create_arguments_object(vm, args, arg_count, callee, env, ${this.context.mappedArguments}, ${this.context.mappedArgumentSlots.length}, ${this.context.mappedArgumentSlots.length > 0 ? `(const i32[]){ ${this.context.mappedArgumentSlots.join(", ")} }` : "nullptr"});`,
				];
			case "LOAD_ARGUMENT_COUNT":
				if (this.context.directArgumentRepresentations !== undefined)
					return [
						this.storeNumber(
							instruction.dst,
							String(this.context.directArgumentRepresentations.length),
						),
					];
				return [this.storeNumber(instruction.dst, "arg_count")];
			case "LOAD_ARGUMENT":
				if (this.context.directArgumentRepresentations !== undefined) {
					const representation =
						this.context.directArgumentRepresentations[instruction.index];
					if (representation === undefined)
						throw new Error("Direct entry reads an absent argument");
					const value = `p${instruction.index}`;
					return [
						representation === "number" || representation === "int32"
							? this.storeNumber(instruction.dst, value)
							: representation === "boolean"
								? this.storeBoolean(instruction.dst, value)
								: `r${instruction.dst} = ${value};`,
					];
				}
				return [
					`r${instruction.dst} = arg_count > ${instruction.index} ? args[${instruction.index}] : MAL_VALUE_UNDEFINED;`,
				];
			case "LOAD_STATIC_ARGUMENT": {
				if (this.context.directArgumentRepresentations !== undefined) {
					const representation =
						this.context.directArgumentRepresentations[instruction.index];
					if (representation === undefined || instruction.direct < 0)
						throw new Error("Direct entry lacks a supplied argument snapshot");
					const value = this.boxed(instruction.direct);
					return [
						representation === "number" || representation === "int32"
							? this.storeNumber(
									instruction.dst,
									isNumericRep(this.reps[instruction.direct]!)
										? this.num(instruction.direct)
										: `mal_ops_number_as_f64(${value})`,
								)
							: representation === "boolean"
								? this.storeBoolean(
										instruction.dst,
										this.reps[instruction.direct] === "boolean"
											? `r${instruction.direct}`
											: `mal_value_to_boolean(${value})`,
									)
								: `r${instruction.dst} = ${value};`,
					];
				}
				const direct =
					instruction.direct >= 0
						? this.boxed(instruction.direct)
						: `args[${instruction.index}]`;
				return [
					`if (arg_count > ${instruction.index}) {`,
					`  r${instruction.dst} = ${direct};`,
					`} else {`,
					`  if (mal_value_is_undefined(r${instruction.fallback})) {`,
					`    r${instruction.fallback} = mal_create_arguments_object(vm, args, arg_count, callee, env, ${this.context.mappedArguments}, ${this.context.mappedArgumentSlots.length}, ${this.context.mappedArgumentSlots.length > 0 ? `(const i32[]){ ${this.context.mappedArgumentSlots.join(", ")} }` : "nullptr"});`,
					`  }`,
					`  r${instruction.dst} = mal_vm_op_load_property(vm, r${instruction.fallback}, mal_value_from_i32(${instruction.index}));`,
					`  ${this.throwCheck()}`,
					`}`,
				];
			}
			case "CREATE_REST_ARGUMENTS":
				if (this.context.nativePlan?.kind === "virtual-packed-rest-array") return [];
				if (this.context.directArgumentRepresentations !== undefined) return null;
				// A rest parameter `function f(...rest)`: the call arguments from
				// startIndex onward. Reads the raw args, never throws.
				return [
					`r${instruction.dst} = mal_create_rest_arguments(vm, args, arg_count, ${instruction.startIndex});`,
				];
			case "ARRAY_REST":
				// Array-destructuring rest `[a, ...rest] = src`: a null/undefined source
				// or a throwing element read propagates.
				return [
					`r${instruction.dst} = mal_array_rest(vm, ${this.boxed(instruction.src)}, ${instruction.startIndex});`,
					this.throwCheck(),
				];
			case "FOR_IN_KEYS":
				// `for (k in source)`: build the enumeration key array; a proxy trap on
				// the source can throw, so propagate.
				return [
					`r${instruction.dst} = mal_for_in_keys(vm, ${this.boxed(instruction.source)});`,
					this.throwCheck(),
				];
			case "FOR_IN_HAS": {
				const operands = `${this.boxed(instruction.object)}, ${this.boxed(instruction.key)}`;
				const result = (present: string): string =>
					this.reps[instruction.dst] === "boolean"
						? present
						: `mal_value_new_boolean(${present})`;
				// A proxy on the prototype chain can trap HasProperty and throw.
				return [
					`if (mal_for_in_snapshot_holds(vm, ${this.boxed(instruction.object)}, ${this.boxed(instruction.keys)}) || mal_vm_shape_has_own_key(vm, ${operands})) {`,
					`  r${instruction.dst} = ${result("true")};`,
					`} else {`,
					...(this.context.incomingRootPublication ?? []).map((line) => `  ${line}`),
					`  r${instruction.dst} = ${result(`mal_for_in_has_slow(vm, ${operands})`)};`,
					`  ${this.throwCheck()}`,
					`}`,
				];
			}
			case "LOAD_PRIMORDIAL": {
				const effects = nativeInstructionEffects(instruction, this.context.facts);
				return [
					`r${instruction.dst} = mal_vm_load_primordial(vm, ${instruction.nodeIndex});`,
					...(effects.throwing || effects.reentry ? [this.throwCheck()] : []),
					this.poll(),
				];
			}
			case "LOAD_INTRINSIC":
				return [
					`r${instruction.dst} = vm->intrinsics[${emitIntrinsic(instruction.intrinsic)}];`,
				];
			case "BINARY":
				return this.emitBinary(instruction);
			case "TYPEOF_COMPARE": {
				const { dst, src, expected, negated } = instruction;
				const expression = nativeTypeofComparisonExpression(
					this.boxed(src),
					this.operandKind(src) ?? COMPILER_VALUE_KIND_TOP,
					expected,
				);
				if (expression === "true" || expression === "false") {
					const value = (expression === "true") !== negated;
					return [
						this.reps[dst] === "boolean"
							? `r${dst} = ${value ? "true" : "false"};`
							: `r${dst} = MAL_VALUE_${value ? "TRUE" : "FALSE"};`,
					];
				}
				const result = negated ? `!(${expression})` : expression;
				return [
					this.reps[dst] === "boolean"
						? `r${dst} = ${result};`
						: `r${dst} = ${this.profileCall("boxing", `mal_value_new_boolean(${result})`)};`,
				];
			}
			case "UNARY":
				return this.emitUnary(instruction);
			case "MATH_UNARY_NUMBER": {
				const expression = nativeMathUnaryExpr(
					instruction.operation,
					this.typedNumber(instruction.src),
					instructionInputIntegerRange(this.context.facts, instruction.src),
				);
				return expression === null
					? null
					: [this.storeNumber(instruction.dst, expression)];
			}
			case "MATH_BINARY_NUMBER": {
				const expression = nativeMathBinaryExpr(
					instruction.operation,
					this.typedNumber(instruction.left),
					this.typedNumber(instruction.right),
					this.context.facts?.inputIntegerRanges,
				);
				return expression === null
					? null
					: [this.storeNumber(instruction.dst, expression)];
			}
			case "PRECISE_NUMBER_SUM": {
				const values = instruction.arguments.map((register) =>
					isNumericRep(this.reps[register]!)
						? this.num(register)
						: `mal_ops_number_as_f64(${this.boxed(register)})`,
				);
				const result = `sum_result_${this.ip}`;
				return [
					`f64 ${result} = mal_builtin_math_sum_precise_numbers(vm, (const f64[]){ ${values.length ? values.join(", ") : "0.0"} }, ${values.length});`,
					this.throwCheck(),
					this.storeNumber(instruction.dst, result),
					this.poll(),
				];
			}
			case "STRING_CONCAT_LENGTH": {
				const result = `concat_length_${this.ip}`;
				return [
					`MalValue ${result} = mal_vm_string_concat_length(vm, ${this.boxed(instruction.prefixLength)}, ${this.boxed(instruction.part)}, ${instruction.followingQuasiLength}u);`,
					this.throwCheck(),
					`r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
				];
			}
			case "CONCAT_STRINGS": {
				const parts = instruction.arguments.map(this.boxed.bind(this));
				const result = `concat_result_${this.ip}`;
				return [
					`MalValue ${result} = mal_vm_concat_strings(vm, (const MalValue[]){ ${parts.join(", ")} }, ${parts.length});`,
					this.throwCheck(),
					`r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
				];
			}
			case "BUILTIN_ERROR":
				return [
					`r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
					`mal_vm_throw_error(vm, ${knownBuiltinErrorPrototype(instruction.error)}, ${JSON.stringify(knownBuiltinErrors[instruction.error].message)});`,
					this.throwCheck(),
				];
			case "PREPARED_STRING_COMPARE": {
				const bytes = this.context.stringConstants[instruction.stringIndex]!;
				const result = `collation_result_${this.ip}`;
				return [
					`MalValue ${result} = mal_builtin_string_locale_compare_prepared(vm, ${this.boxed(instruction.left)}, ${this.boxed(instruction.right)}, (const byte[]){ ${bytes.length === 0 ? "0" : bytes.join(", ")} }, ${bytes.length}, ${instruction.options});`,
					this.throwCheck(),
					`r${instruction.dst} = ${this.callValue(instruction.dst, result)};`,
					this.poll(),
				];
			}
			case "CALL_KNOWN":
				return this.emitKnownCall(instruction);
			case "CALL":
				return this.emitCall(instruction);
			case "CONSTRUCT": {
				const constructPlan =
					this.context.nativePlan?.kind === "construct"
						? this.context.nativePlan
						: undefined;
				// `new callee(args)`: marshal args (boxing numbers) and dispatch through
				// the guarded direct helper for exact script targets, otherwise generic
				// construction. Both return the completed [[Construct]] result.
				const args = instruction.arguments;
				const argsExpr =
					args.length === 0
						? "nullptr"
						: `((MalValue[]){ ${args.map(this.boxedOperand.bind(this)).join(", ")} })`;
				const tmp = `construct_result_${this.ip}`;
				const construct =
					constructPlan === undefined
						? this.profileCall(
								"construct",
								`mal_vm_construct_value(vm, ${this.boxedOperand(instruction.callee)}, ${argsExpr}, ${args.length})`,
							)
						: this.profileCall(
								"construct",
								`mal_vm_construct_direct(vm, ${this.context.relocation.functionIndex(constructPlan.directFunctionIndex)}, ${this.boxedOperand(instruction.callee)}, ${argsExpr}, ${args.length})`,
							);
				return [
					`MalCompletion ${tmp} = ${construct};`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
					`r${instruction.dst} = ${tmp}.value;`,
					this.callPoll(),
				];
			}
			case "THROW":
				// Set the throw completion, then route to the enclosing handler (a
				// try/catch in this same function) or out of the frame, exactly as
				// MAL_OP_THROW + the interpreter's unwinder do.
				return [
					`vm->completion = (MalCompletion) { .kind = MAL_COMPLETION_THROW, .value = ${this.boxed(instruction.value)} };`,
					this.onThrow(),
				];
			case "LOAD_UNDECLARED":
				// An undeclared reference always throws ReferenceError; the helper sets
				// the throw completion, so route it to the handler / out of the frame.
				return [
					`mal_vm_op_load_undeclared(vm, ${this.context.relocation.stringIndex(instruction.nameStringIndex)});`,
					this.onThrow(),
				];
			case "TRY_BEGIN":
			case "TRY_END":
				// Markers only: the protected range becomes the per-instruction handler
				// target computed in emitBody (the `onThrow()` goto), so no code is needed.
				return [];
			case "CATCH":
				// Handler entry: bind the pending thrown value and clear the completion,
				// exactly as mal_op_catch does. The dst is boxed (any value can be caught).
				// A terminating isolate's throw is uncatchable: keep propagating outward.
				return [
					`if (mal_gc_terminating()) ${this.onThrow()}`,
					`r${instruction.dst} = vm->completion.value;`,
					`vm->completion = (MalCompletion) { .kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED };`,
				];
			case "REQUIRE_COERCIBLE":
				if (
					((this.operandKind(instruction.src) ?? COMPILER_VALUE_KIND_TOP) &
						COMPILER_VALUE_KIND_NULLISH) ===
					0
				) {
					this.elideFramePosition();
					return [];
				}
				return [
					`if (mal_value_is_nil(${this.boxed(instruction.src)})) {`,
					...this.slowPathFramePosition(),
					...(this.context.incomingRootPublication ?? []).map((line) => `  ${line}`),
					...(this.context.valueGuardInactiveRootMask === undefined
						? []
						: [
								`  ${cInactiveRootMaskPublication(this.context.valueGuardInactiveRootMask, this.context.inactiveRootMaskStatements)};`,
							]),
					`  mal_vm_op_require_coercible(vm, ${this.boxed(instruction.src)});`,
					`  ${this.throwCheck()}`,
					`}`,
				];
			case "GET_ITERATOR":
				return this.emitGetIterator(instruction);
			case "GET_ASYNC_ITERATOR": {
				// GetIterator(source, async): fetch @@asyncIterator (falling back to a
				// sync iterator wrapped as async). A missing/throwing method propagates.
				const rec = `aiter_rec_${this.ip}`;
				return [
					`MalIteratorRecord ${rec};`,
					`if (!mal_vm_get_async_iterator(vm, ${this.boxed(instruction.source)}, &${rec})) ${this.onThrow()}`,
					`r${instruction.iteratorDst} = ${rec}.iterator;`,
					`r${instruction.nextDst} = ${rec}.next_method;`,
				];
			}
			case "ITERATOR_STEP":
				return this.emitIteratorStep(instruction);
			case "ITERATOR_CLOSE":
				return this.emitIteratorClose(instruction);
			case "JUMP":
				return [
					...(this.context.loopPoll ? [this.poll()] : []),
					...(instruction.targetIp === this.ip + 1
						? []
						: [`goto L${instruction.targetIp};`]),
				];
			case "JUMP_IF": {
				if (this.context.branchTarget !== undefined)
					return [
						...(this.context.loopPoll ? [this.poll()] : []),
						...(this.context.branchTarget === this.ip + 1
							? []
							: [`goto L${this.context.branchTarget};`]),
					];
				const condition = this.truthy(instruction.cond);
				if (condition === "false") return [];
				if (condition === "true")
					return [
						...(this.context.loopPoll ? [this.poll()] : []),
						...(instruction.targetIp === this.ip + 1
							? []
							: [`goto L${instruction.targetIp};`]),
					];
				return this.context.loopPoll
					? [`if (${condition}) { ${this.poll()} goto L${instruction.targetIp}; }`]
					: [`if (${condition}) goto L${instruction.targetIp};`];
			}

			case "RETURN":
				return this.emitReturn(instruction);
			case "LOAD_GLOBAL_PROPERTY":
				return [
					`r${instruction.dst} = mal_vm_op_load_global_property(vm, ${this.context.relocation.stringIndex(instruction.nameStringIndex)});`,
					this.throwCheck(),
				];
			case "LOAD_PROTOTYPE":
				// Reads the internal [[Prototype]] slot directly (no proxy trap) — never throws.
				return [
					`r${instruction.dst} = mal_vm_op_load_prototype(vm, ${this.boxed(instruction.object)});`,
				];
			case "LOAD_SUPER_PROPERTY":
				return [
					`r${instruction.dst} = mal_vm_op_load_super_property(vm, ${this.boxed(instruction.object)}, ${this.boxed(instruction.key)}, ${this.boxed(instruction.receiver)});`,
					this.throwCheck(),
				];
			case "SET_FUNCTION_NAME":
				// Installs the "name" data property from an already-evaluated key; no user code.
				return [
					`mal_vm_op_set_function_name(vm, ${this.boxed(instruction.func)}, ${this.boxed(instruction.key)}, ${instruction.prefix});`,
				];
			case "ITERATOR_NEXT": {
				// IteratorNext: call `next` with the iterator as `this` and no args, exactly
				// like a 0-arg CALL. A throw propagates via the completion.
				const tmp = `iter_next_${this.ip}`;
				return [
					`MalCompletion ${tmp} = mal_vm_call_value(vm, ${this.boxed(instruction.next)}, ${this.boxed(instruction.iterator)}, nullptr, 0);`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
					`r${instruction.resultDst} = ${tmp}.value;`,
					this.poll(),
				];
			}
			case "CREATE_TEMPLATE_OBJECT": {
				const count = instruction.cookedIndices.length;
				const cooked =
					count > 0
						? `(const i32[]){ ${instruction.cookedIndices.map((index) => (index < 0 ? String(index) : this.context.relocation.stringIndex(index))).join(", ")} }`
						: "nullptr";
				const raw =
					count > 0
						? `(const i32[]){ ${instruction.rawIndices.map((index) => this.context.relocation.stringIndex(index)).join(", ")} }`
						: "nullptr";
				return [
					`r${instruction.dst} = mal_vm_op_create_template_object(vm, ${this.context.relocation.globalIndex(instruction.cacheSlot)}, ${count}, ${cooked}, ${raw});`,
				];
			}
			case "CREATE_MODULE_NAMESPACE": {
				const count = instruction.nameIndices.length;
				const names =
					count > 0
						? `(const i32[]){ ${instruction.nameIndices.map((index) => this.context.relocation.stringIndex(index)).join(", ")} }`
						: "nullptr";
				const slots =
					count > 0
						? `(const i32[]){ ${instruction.slots.map((index) => this.context.relocation.globalIndex(index)).join(", ")} }`
						: "nullptr";
				return [
					`r${instruction.dst} = mal_vm_op_create_module_namespace(vm, ${instruction.cacheSlot < 0 ? "-1" : this.context.relocation.globalIndex(instruction.cacheSlot)}, ${count}, ${names}, ${slots});`,
				];
			}
			case "COPY_DATA_PROPERTIES": {
				// Object rest `{...rest}`: excluded keys are the sibling destructured
				// registers, boxed into a temp array (rooted originals + no synchronous
				// collection keep the copies live). A source getter can throw.
				const excluded =
					instruction.excluded.length > 0
						? `((MalValue[]){ ${instruction.excluded.map((r) => this.boxed(r)).join(", ")} })`
						: "nullptr";
				return [
					`r${instruction.dst} = mal_vm_op_copy_data_properties(vm, ${this.boxed(instruction.src)}, ${excluded}, ${instruction.excludedCount});`,
					this.throwCheck(),
				];
			}
			case "CREATE_PRIVATE_NAME":
				// A fresh unique private name (hidden symbol); never throws.
				return [`r${instruction.dst} = mal_vm_op_create_private_name(vm);`];
			case "CREATE_PRIVATE_NAMES":
				return [
					...ensureCaptureEnvironment(this.context.captureShadow, this.ip),
					`mal_vm_op_create_private_names(vm, env, ${this.context.relocation.ownerFunctionIndex(instruction.ownerFunctionIndex)}, ${instruction.capturedIndices.length}, (const i32[]){ ${instruction.capturedIndices.join(", ")} });`,
				];
			case "DEFINE_PRIVATE":
				// AddPrivateName on a fresh instance/class object; a duplicate install throws.
				return [
					...(this.context.privateFieldReserveCount === undefined
						? []
						: [
								`mal_vm_reserve_private_elements(${this.boxed(instruction.object)}, ${this.context.privateFieldReserveCount});`,
							]),
					`mal_vm_op_define_private(vm, ${this.boxed(instruction.object)}, ${this.boxed(instruction.key)}, ${this.boxed(instruction.value)});`,
					this.throwCheck(),
				];
			case "INIT_PRIVATE_FIELDS":
				return [
					...(this.context.privateFieldReserveCount === undefined
						? []
						: [
								`mal_vm_reserve_private_elements(${this.boxed(instruction.object)}, ${this.context.privateFieldReserveCount});`,
							]),
					`mal_vm_op_init_private_fields(vm, ${this.boxed(instruction.object)}, ${instruction.keyRegisters.length}, (const MalValue[]){ ${instruction.keyRegisters.map((key) => this.boxed(key)).join(", ")} });`,
					this.throwCheck(),
				];
			case "LOAD_PRIVATE": {
				const loaded = `__private_value_${this.ip}`;
				const hinted = [
					`MalValue ${loaded};`,
					`if (mal_vm_private_try_load(${this.boxed(instruction.object)}, ${this.boxed(instruction.key)}, &${loaded})) {`,
					`  r${instruction.dst} = ${this.callValue(instruction.dst, loaded)};`,
					`} else {`,
					...this.slowPathFramePosition(),
					...(this.context.incomingRootPublication ?? []).map((line) => `  ${line}`),
					...(this.context.privateAccessInactiveRootMask === undefined
						? []
						: [
								`  ${cInactiveRootMaskPublication(this.context.privateAccessInactiveRootMask, this.context.inactiveRootMaskStatements)};`,
							]),
					...this.boxedLoad(
						instruction.dst,
						`mal_vm_op_load_private(vm, ${this.boxed(instruction.object)}, ${this.boxed(instruction.key)})`,
					).map((line) => `  ${line}`),
					`}`,
				];
				const object = `__co_${this.ip}`;
				const load =
					this.context.nativePlan?.kind !== "class-layout" ||
					this.context.nativePlan.site.kind !== "slot" ||
					!this.classLayoutsEnabled
						? hinted
						: [
								`{ MalObject *${object} = mal_vm_as_object(${this.boxed(instruction.object)});`,
								...classLayoutAccess(
									"slot",
									this.context.nativePlan.site.candidates,
									object,
									this.boxed(instruction.object),
									({ index }) =>
										`r${instruction.dst} = ${this.callValue(instruction.dst, `mal_object_field_load_shaped(${object}, ${index})`)};`,
									hinted,
								),
								"}",
							];
				if (instruction.cached === undefined) return load;
				return [
					`if (!mal_value_is_empty(${this.boxed(instruction.cached)})) r${instruction.dst} = ${this.callValue(instruction.dst, this.boxed(instruction.cached))};`,
					"else {",
					...load,
					"}",
				];
			}
			case "GUARD_SERVICE_EPOCH":
				return [
					this.storeBoolean(
						instruction.dst,
						`mal_vm_guard_service_epoch(vm, ${this.typedNumber(instruction.epoch)})`,
					),
				];
			case "READ_SERVICE_EPOCH": {
				const epoch = "mal_vm_read_service_epoch(vm)";
				return [
					this.reps[instruction.dst] === "number"
						? `r${instruction.dst} = ${epoch};`
						: `r${instruction.dst} = mal_ops_number_value(${epoch});`,
				];
			}
			case "PROBE_READ": {
				const loaded = `__probe_value_${this.ip}`,
					success = `__probe_success_${this.ip}`;
				const probe =
					instruction.readKind === "named"
						? `mal_vm_probe_named_read(vm, ${this.boxed(instruction.object)}, ${this.context.relocation.stringIndex(instruction.stringIndex)}, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}], &${loaded})`
						: instruction.readKind === "getter" || instruction.readKind === "setter"
							? `mal_vm_probe_accessor_read(vm, ${this.boxed(instruction.object)}, ${this.context.relocation.stringIndex(instruction.stringIndex)}, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}], ${instruction.readKind === "setter"}, &${loaded})`
							: `mal_vm_probe_${instruction.readKind}_read(${this.boxed(instruction.object)}, ${this.boxed(instruction.key)}, &${loaded})`;
				return [
					`MalValue ${loaded};`,
					`bool ${success} = ${probe};`,
					`r${instruction.dst} = ${loaded};`,
					this.storeBoolean(instruction.success, success),
				];
			}
			case "STORE_PRIVATE": {
				// PrivateSet; the name must already be installed, else throws.
				const hinted = [
					`if (!mal_vm_private_try_store(${this.boxed(instruction.object)}, ${this.boxed(instruction.key)}, ${this.boxed(instruction.value)})) {`,
					...this.slowPathFramePosition(),
					...(this.context.incomingRootPublication ?? []).map((line) => `  ${line}`),
					...(this.context.privateAccessInactiveRootMask === undefined
						? []
						: [
								`  ${cInactiveRootMaskPublication(this.context.privateAccessInactiveRootMask, this.context.inactiveRootMaskStatements)};`,
							]),
					`  mal_vm_op_store_private(vm, ${this.boxed(instruction.object)}, ${this.boxed(instruction.key)}, ${this.boxed(instruction.value)});`,
					`  ${this.throwCheck()}`,
					`}`,
				];
				if (
					this.context.nativePlan?.kind !== "class-layout" ||
					this.context.nativePlan.site.kind !== "slot" ||
					!this.classLayoutsEnabled
				)
					return hinted;
				const object = `__co_${this.ip}`;
				return [
					`{ MalObject *${object} = mal_vm_as_object(${this.boxed(instruction.object)});`,
					...classLayoutAccess(
						"slot",
						this.context.nativePlan.site.candidates,
						object,
						this.boxed(instruction.object),
						({ index }) =>
							`mal_vm_object_slot_store(${object}, ${index}, ${this.boxed(instruction.value)});`,
						hinted,
					),
					"}",
				];
			}
			case "HAS_PRIVATE":
				// Ergonomic brand check `#x in obj`; a non-object receiver throws.
				return [
					this.reps[instruction.dst] === "boolean"
						? `r${instruction.dst} = mal_value_to_boolean(mal_vm_op_has_private(vm, ${this.boxed(instruction.object)}, ${this.boxed(instruction.key)}));`
						: `r${instruction.dst} = mal_vm_op_has_private(vm, ${this.boxed(instruction.object)}, ${this.boxed(instruction.key)});`,
					this.throwCheck(),
				];
			case "CALL_SPREAD": {
				// `f(...args)`: marshal the spread array and dispatch, mirroring CALL.
				const tmp = `call_spread_${this.ip}`;
				return [
					`MalCompletion ${tmp} = mal_vm_op_call_spread(vm, ${this.boxed(instruction.callee)}, ${this.boxed(instruction.thisValue)}, ${this.boxed(instruction.argumentsArray)});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
					`r${instruction.dst} = ${this.callValue(instruction.dst, `${tmp}.value`)};`,
					this.callPoll(),
				];
			}
			case "CALL_REST_ARGUMENTS": {
				const tmp = `call_rest_${this.ip}`;
				const prefix = instruction.prefixArguments;
				const prefixName = prefix.length === 0 ? "NULL" : `rest_prefix_${this.ip}`;
				return [
					...(prefix.length === 0
						? []
						: [
								`MalValue ${prefixName}[${prefix.length}] = { ${prefix.map(this.boxed.bind(this)).join(", ")} };`,
							]),
					`MalCompletion ${tmp} = mal_vm_op_call_rest_arguments(vm, ${this.boxed(instruction.callee)}, ${this.boxed(instruction.thisValue)}, ${this.boxed(instruction.receiver)}, args, arg_count, ${instruction.startIndex}, ${restForwardFlags(instruction)}, &r${instruction.state}, ${prefixName}, ${prefix.length});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
					`r${instruction.dst} = ${this.callValue(instruction.dst, `${tmp}.value`)};`,
					this.callPoll(),
				];
			}
			case "CALL_SPREAD_ITERABLE": {
				const tmp = `call_spread_iterable_${this.ip}`;
				const prefix = instruction.prefixArguments;
				const prefixName = prefix.length === 0 ? "NULL" : `spread_prefix_${this.ip}`;
				return [
					...(prefix.length === 0
						? []
						: [
								`MalValue ${prefixName}[${prefix.length}] = { ${prefix.map(this.boxed.bind(this)).join(", ")} };`,
							]),
					`MalCompletion ${tmp} = mal_vm_op_call_spread_iterable(vm, ${this.boxed(instruction.callee)}, ${this.boxed(instruction.thisValue)}, ${this.boxed(instruction.iterable)}, ${prefixName}, ${prefix.length});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
					`r${instruction.dst} = ${this.callValue(instruction.dst, `${tmp}.value`)};`,
					this.callPoll(),
				];
			}
			case "CONSTRUCT_SPREAD": {
				// `new C(...args)`: marshal the spread array and dispatch, mirroring CONSTRUCT.
				const tmp = `construct_spread_${this.ip}`;
				return [
					`MalCompletion ${tmp} = mal_vm_op_construct_spread(vm, ${this.boxed(instruction.callee)}, ${this.boxed(instruction.argumentsArray)});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
					`r${instruction.dst} = ${tmp}.value;`,
					this.callPoll(),
				];
			}
			case "WITH_ENTER": {
				// Push a `with` object environment record onto the env chain (nil throws).
				// A temp holds the new env so a throw leaves `env` at the pre-with scope for
				// an in-function handler. Keeping the with-object on the env chain (not a
				// frame-local stack) lets closures created in the body capture it.
				const tmp = `with_env_${this.ip}`;
				const frameUpdate = rootFrameEnvUpdate(this.gcUnlink);
				return [
					`MalEnv *${tmp} = mal_vm_op_with_enter(vm, env, ${this.boxed(instruction.object)});`,
					this.throwCheck(),
					`env = ${tmp};${frameUpdate}`,
				];
			}
			case "WITH_EXIT": {
				// Pop the with-env pushed by the matching WITH_ENTER.
				const frameUpdate = rootFrameEnvUpdate(this.gcUnlink);
				return [`env = env->parent;${frameUpdate}`];
			}
			case "WITH_GET":
				// Resolve a name against the with-envs on the chain; EMPTY sentinel on a miss
				// (the IR then falls back to the static binding). A getter / @@unscopables
				// can throw.
				return [
					`r${instruction.dst} = mal_vm_op_with_get(vm, env, ${this.context.relocation.stringIndex(instruction.nameStringIndex)});`,
					this.throwCheck(),
				];
			case "WITH_RESOLVE_BASE":
				// The reference base (the with-object itself) for a read/write through it.
				return [
					`r${instruction.dst} = mal_vm_op_with_resolve_base(vm, env, ${this.context.relocation.stringIndex(instruction.nameStringIndex)});`,
					this.throwCheck(),
				];
			case "WITH_SET":
				// Assign through the with-envs; `found` (always boxed-rep) reports whether a
				// binding matched so the IR can fall back to the static binding on a miss.
				return [
					`r${instruction.found} = ${this.profileCall("boxing", `mal_value_new_boolean(mal_vm_op_with_set(vm, env, ${this.context.relocation.stringIndex(instruction.nameStringIndex)}, ${this.boxed(instruction.value)}))`)};`,
					this.throwCheck(),
				];
			case "CHECK_SUPER_CLASS":
				// ClassDefinitionEvaluation heritage check; a bad `extends` value throws.
				return [
					`mal_vm_op_check_super_class(vm, ${this.boxed(instruction.parent)});`,
					this.throwCheck(),
				];
			case "STORE_SUPER_PROPERTY":
				// `super.p = v`: the base descriptor governs, the write hits `receiver`.
				// A setter or a strict-mode rejection throws.
				return [
					`mal_vm_op_store_super_property(vm, ${this.boxed(instruction.object)}, ${this.boxed(instruction.key)}, ${this.boxed(instruction.value)}, ${this.boxed(instruction.receiver)}, ${this.strict});`,
					this.throwCheck(),
				];
			case "CONSTRUCT_SUPER": {
				// `super(...args)`: construct the parent, bind the result as this activation's
				// (rooted, mutable) `this`, and yield it. Only appears in derived
				// constructors, so `thisRef` is always the rooted this-slot.
				const tmp = `construct_super_${this.ip}`;
				return [
					`MalCompletion ${tmp} = mal_vm_op_construct_super(vm, ${this.boxed(instruction.parent)}, ${this.boxed(instruction.argumentsArray)}, ${nativeBodyReference(this.context.resources, "newTarget")}, ${this.thisRef}, &${this.thisRef});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
					`r${instruction.dst} = ${this.thisRef};`,
					this.callPoll(),
				];
			}
			case "CONSTRUCT_SUPER_EXPLICIT": {
				const completion = `construct_super_explicit_${this.ip}`;
				const boundThis = `bound_super_this_${this.ip}`;
				return [
					`MalValue ${boundThis};`,
					`MalCompletion ${completion} = mal_vm_op_construct_super(vm, ${this.boxed(instruction.parent)}, ${this.boxed(instruction.argumentsArray)}, ${this.boxed(instruction.newTarget)}, ${this.boxed(instruction.dst)}, &${boundThis});`,
					`if (${completion}.kind == MAL_COMPLETION_THROW) ${this.onThrow()}`,
					`r${instruction.dst} = ${boundThis};`,
					this.callPoll(),
				];
			}
			case "SET_THIS":
				if (this.thisSlot < 0) return null;
				return [`${this.thisRef} = ${this.boxed(instruction.value)};`];
			case "GENERATOR_START": {
				// Resumable functions only. Build the generator/async-generator instance
				// adopting this activation's buffer, then suspend at the next instruction
				// and hand the generator back to the caller (the first .next() resumes it).
				if (this.coro === null) {
					return null;
				}
				return [
					...this.suspendSnapshot(),
					`__coro = mal_vm_op_generator_start_compiled(vm, callee, ${this.coro.functionIndex}, this_value, env, __suspend_slots, ${this.coro.suspension.slotCount}, args, arg_count, ${this.coro.retainArguments}, ${this.ip + 1}, ${this.coro.isAsyncGenerator});`,
					`__gc_slots[${this.coro.selfSlot}] = mal_value_from_object((MalObject *) __coro);`,
					`${this.gcUnlink}return mal_value_from_object((MalObject *) __coro);`,
				];
			}
			case "YIELD": {
				// Finish the snapshot before a helper can synchronously resume or free it.
				if (this.coro === null) {
					return null;
				}
				return [
					`MalValue yielded_${this.ip} = ${this.boxed(instruction.yieldedSrc)};`,
					...this.suspendSnapshot(),
					`${this.gcUnlink}mal_vm_op_yield_compiled(vm, __coro, yielded_${this.ip}, ${this.coro.suspension.valueSlot}, ${this.coro.suspension.modeSlot}, ${this.ip + 1}, ${this.coro.positionEntry(this.ip)}, env);`,
					`return ${this.coroReturnValue};`,
				];
			}
			case "TERMINAL_YIELD": {
				if (
					this.coro === null ||
					this.coro.isAsyncFunction ||
					this.coro.isAsyncGenerator
				) {
					return null;
				}
				return [
					`mal_vm_op_terminal_yield_compiled(vm, __coro, ${this.boxed(instruction.yieldedSrc)});`,
					`${this.gcUnlink}mal_generator_release_frame(vm, __coro); return ${this.coroReturnValue};`,
				];
			}
			case "ASYNC_START": {
				// Create the result promise + hidden async state adopting this
				// activation's buffer; unlike GENERATOR_START the body keeps running (no
				// suspend). Every later exit returns the promise (__async_result_promise).
				if (this.coro === null) {
					return null;
				}
				return [
					`__coro = mal_vm_op_async_start_compiled(vm, callee, ${this.coro.functionIndex}, this_value, env, __suspend_slots, ${this.coro.suspension.slotCount}, args, arg_count, ${this.coro.retainArguments}, &__async_result_promise);`,
					`__gc_slots[${this.coro.selfSlot}] = mal_value_from_object((MalObject *) __coro);`,
				];
			}
			case "AWAIT": {
				if (this.coro === null) {
					return null;
				}
				return [
					`MalValue awaited_${this.ip} = ${this.boxed(instruction.awaitedSrc)};`,
					...this.suspendSnapshot(),
					`${this.gcUnlink}mal_vm_op_await_compiled(vm, __coro, awaited_${this.ip}, ${this.coro.suspension.valueSlot}, ${this.coro.suspension.modeSlot}, ${this.ip + 1}, ${this.coro.positionEntry(this.ip)}, env);`,
					`return ${this.coroReturnValue};`,
				];
			}
			default:
				// Not lowered yet — the function stays on the interpreter. This is the
				// blank to fill in (calls, property access, captures, ...).
				return null;
		}
	}
	tryStringSpan(instruction: BytecodeInstruction): Array<string> | null | undefined {
		if (this.context.nativeStringSpanAction !== undefined) {
			const { site, role, consumer } = this.context.nativeStringSpanAction;
			const methodProperty = CORE_STRING_SPAN_METHODS.find(
				(method) => role === `${method}Property`,
			);
			const characterCall = CORE_STRING_SPAN_CHARACTER_METHODS.find(
				(method) => role === `${method}Call`,
			);
			const searchCall = CORE_STRING_SPAN_SEARCH_METHODS.find(
				(method) => role === `${method}Call`,
			);
			const { span } = site;
			const prefix = `__string_span_${site.producerIp}`;
			const source = `__gc_slots[${site.subjectSlot}]`;
			const materialized = `__gc_slots[${site.materializedSlot}]`;
			const materializeSpan = (
				valueSite: NativeStringSpanSite,
				value: number,
			): Array<string> => {
				const name = `__string_span_${valueSite.producerIp}`;
				const subject = `__gc_slots[${valueSite.subjectSlot}]`;
				const cached = `__gc_slots[${valueSite.materializedSlot}]`;
				return [
					`if (${name}_active) {`,
					`  if (mal_value_is_undefined(${cached})) {`,
					`    ${cached} = ${this.profileCall("string", `mal_builtin_string_span_materialize(vm, ${subject}, ${name}_start, ${name}_end)`)};`,
					`    ${this.throwCheck()}`,
					`  }`,
					`  r${value} = ${cached};`,
					`}`,
				];
			};
			const ordinary = this.emitGenericInstruction({
				nativeStringCharCodeAtChainAction: this.context.nativeStringCharCodeAtChainAction,
				nativeRegExpExecProjectionAction: this.context.nativeRegExpExecProjectionAction,
			});
			if (ordinary === null) return null;
			if (
				role === "range" &&
				(span !== undefined || site.rangeOperation !== undefined) &&
				(instruction.opcode === "CALL" || instruction.opcode === "CALL_KNOWN")
			) {
				const locked =
					instruction.opcode === "CALL_KNOWN" ||
					span?.builtinIdentities === "authority-invariant";
				const operation = span?.rangeOperation ?? site.rangeOperation!;
				const parent = site.parent;
				const parentPrefix =
					parent === undefined ? undefined : `__string_span_${parent.producerIp}`;
				const parentSource =
					parent === undefined ? undefined : `__gc_slots[${parent.subjectSlot}]`;
				const receiver =
					parent === undefined
						? this.boxedOperand(instruction.thisValue)
						: `${parentPrefix}_active ? ${parentSource} : ${this.boxedOperand(instruction.thisValue)}`;
				const bounds =
					parent === undefined
						? "0, SIZE_MAX"
						: `${parentPrefix}_active ? ${parentPrefix}_start : 0, ${parentPrefix}_active ? ${parentPrefix}_end : SIZE_MAX`;
				const callee =
					instruction.opcode === "CALL"
						? this.boxedOperand(instruction.callee)
						: "MAL_VALUE_UNDEFINED";
				const argument = (index: number): string =>
					instruction.arguments[index] === undefined
						? "MAL_VALUE_UNDEFINED"
						: this.boxedOperand(instruction.arguments[index]);
				return [
					`${materialized} = MAL_VALUE_UNDEFINED;`,
					`${source} = MAL_VALUE_UNDEFINED;`,
					`${prefix}_active = ${this.profileCall("string", `mal_builtin_string_range_span_init(${callee}, ${receiver}, ${bounds}, ${argument(0)}, ${argument(1)}, MAL_STRING_RANGE_${STRING_SPAN_RANGE_KERNELS[operation]}, ${locked ? "true" : "false"}, &${source}, &${prefix}_start, &${prefix}_end)`)};`,
					`if (${prefix}_active) {`,
					...(!operation.startsWith("trim")
						? []
						: [
								`  MAL_PERF_COUNT(string_span_trim_${parent === undefined ? "direct" : (parent.projection?.kind ?? "range")}_admissions);`,
							]),
					...(parent?.parent === undefined
						? []
						: [
								`  if (${parentPrefix}_active && __string_span_${parent.parent.producerIp}_active) MAL_PERF_COUNT(string_span_deep_admissions);`,
							]),
					`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
					`  ${this.poll()}`,
					`} else {`,
					...(parent === undefined
						? []
						: materializeSpan(parent, instruction.thisValue).map((line) => `  ${line}`)),
					...ordinary.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (
				role === "projection" &&
				site.projection !== undefined &&
				"dst" in instruction
			) {
				const { kind, callIp, slot } = site.projection;
				const projection =
					kind === "split" ? `__string_split_${callIp}` : `__regexp_exec_${callIp}`;
				const admitted =
					kind === "split" ? `${projection}_fast` : `${projection}_projected`;
				const present =
					kind === "split"
						? `${projection}_starts[${slot}] != SIZE_MAX`
						: `${projection}_starts[${slot}] >= 0`;
				return [
					`${prefix}_active = false;`,
					`if (${admitted}) {`,
					`  ${prefix}_start = ${projection}_starts[${slot}];`,
					`  ${prefix}_end = ${projection}_ends[${slot}];`,
					`  ${prefix}_active = ${present};`,
					`  if (${prefix}_active) MAL_PERF_COUNT(string_span_admissions);`,
					`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
					`} else {`,
					...ordinary.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (consumer === undefined) throw new Error("String-span action has no consumer");
			const materialize = materializeSpan(site, consumer.value);
			let guard = `${prefix}_active`;
			const declarations: Array<string> = [];
			let projected: string | undefined;
			if (role === "length" && instruction.opcode === "LOAD_PROPERTY_STATIC")
				projected = this.storeNumber(
					instruction.dst,
					`(f64) (${prefix}_end - ${prefix}_start)`,
				);
			else if (role === "equal" && instruction.opcode === "BINARY") {
				const other =
					instruction.left === consumer.value ? instruction.right : instruction.left;
				const equal = `mal_builtin_string_span_equal(${source}, ${prefix}_start, ${prefix}_end, ${this.boxedOperand(other)})`;
				projected = this.storeBoolean(
					instruction.dst,
					instruction.operator === "!==" ? `!${equal}` : equal,
				);
			} else if (
				(methodProperty !== undefined || role === "rangeProperty") &&
				instruction.opcode === "LOAD_PROPERTY_STATIC"
			) {
				const chain = this.context.nativeStringCharCodeAtChainAction?.chain;
				const captured =
					chain === undefined
						? undefined
						: `__string_char_code_at_${chain.callIp}_captured`;
				if (chain?.methodIdentity === "authority-invariant") {
					// The chain elides its locked callee; its admission must survive coercing fallback.
					projected = `${captured} = true; r${instruction.dst} = MAL_VALUE_UNDEFINED;`;
				} else {
					const method = `${prefix}_method_${this.ip}`;
					declarations.push(`MalValue ${method};`);
					// A non-index prototype data property is identical for every primitive string.
					guard += ` && mal_vm_property_try_load_static(vm, ${source}, &${nativeBodyReference(this.context.resources, "propertyCache")}[${instruction.icIndex}], &${method})`;
					// The overlapping chain's admission may belong to an earlier loop iteration.
					const resetCapture = captured === undefined ? "" : `${captured} = false; `;
					projected = `${resetCapture}r${instruction.dst} = ${this.callValue(instruction.dst, method)};`;
				}
			} else if (
				(role === "replaceCall" || role === "replaceAllCall") &&
				(instruction.opcode === "CALL" || instruction.opcode === "CALL_KNOWN")
			) {
				const result = `${prefix}_replace_${this.ip}`;
				declarations.push(`MalValue ${result};`);
				const locked = instruction.opcode === "CALL_KNOWN";
				const argument = (index: number) =>
					instruction.arguments[index] === undefined
						? "MAL_VALUE_UNDEFINED"
						: this.boxedOperand(instruction.arguments[index]);
				guard += ` && mal_builtin_string_span_replace(vm, ${locked ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(instruction.callee)}, ${locked}, ${source}, ${prefix}_start, ${prefix}_end, ${argument(0)}, ${argument(1)}, ${role === "replaceAllCall"}, &${result})`;
				projected = `${this.throwCheck()} r${instruction.dst} = ${this.callValue(instruction.dst, result)};`;
			} else if (
				role === "concatCall" &&
				(instruction.opcode === "CALL" || instruction.opcode === "CALL_KNOWN")
			) {
				const result = `${prefix}_concat_${this.ip}`;
				declarations.push(`MalValue ${result};`);
				const locked = instruction.opcode === "CALL_KNOWN";
				const args = instruction.arguments.map((argument) => this.boxedOperand(argument));
				const values = args.length
					? `(const MalValue[]){ ${args.join(", ")} }`
					: "nullptr";
				guard += ` && mal_builtin_string_span_concat(vm, ${locked ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(instruction.callee)}, ${locked}, ${source}, ${prefix}_start, ${prefix}_end, ${values}, ${args.length}, &${result})`;
				projected = `${this.throwCheck()} r${instruction.dst} = ${this.callValue(instruction.dst, result)};`;
			} else if (
				role === "repeatCall" &&
				(instruction.opcode === "CALL" || instruction.opcode === "CALL_KNOWN")
			) {
				const result = `${prefix}_repeat_${this.ip}`;
				declarations.push(`MalValue ${result};`);
				const locked = instruction.opcode === "CALL_KNOWN";
				const count =
					instruction.arguments[0] === undefined
						? "MAL_VALUE_UNDEFINED"
						: this.boxedOperand(instruction.arguments[0]);
				guard += ` && mal_builtin_string_span_repeat(vm, ${locked ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(instruction.callee)}, ${locked}, ${source}, ${prefix}_start, ${prefix}_end, ${count}, &${result})`;
				projected = `${this.throwCheck()} r${instruction.dst} = ${this.callValue(instruction.dst, result)};`;
			} else if (
				(role === "padStartCall" || role === "padEndCall") &&
				(instruction.opcode === "CALL" || instruction.opcode === "CALL_KNOWN")
			) {
				const result = `${prefix}_pad_${this.ip}`;
				declarations.push(`MalValue ${result};`);
				const locked = instruction.opcode === "CALL_KNOWN";
				const argument = (index: number) =>
					instruction.arguments[index] === undefined
						? "MAL_VALUE_UNDEFINED"
						: this.boxedOperand(instruction.arguments[index]);
				guard += ` && mal_builtin_string_span_pad(vm, ${locked ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(instruction.callee)}, ${locked}, ${source}, ${prefix}_start, ${prefix}_end, ${argument(0)}, ${argument(1)}, ${role === "padStartCall"}, &${result})`;
				projected = `${this.throwCheck()} r${instruction.dst} = ${this.callValue(instruction.dst, result)};`;
			} else if (
				(role === "toLowerCaseCall" || role === "toUpperCaseCall") &&
				(instruction.opcode === "CALL" || instruction.opcode === "CALL_KNOWN")
			) {
				const result = `${prefix}_case_${this.ip}`;
				declarations.push(`MalValue ${result};`);
				const locked = instruction.opcode === "CALL_KNOWN";
				guard += ` && mal_builtin_string_span_case(vm, ${locked ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(instruction.callee)}, ${locked}, ${source}, ${prefix}_start, ${prefix}_end, ${role === "toUpperCaseCall"}, &${result})`;
				projected = `${this.throwCheck()} r${instruction.dst} = ${this.callValue(instruction.dst, result)};`;
			} else if (
				role === "normalizeCall" &&
				(instruction.opcode === "CALL" || instruction.opcode === "CALL_KNOWN")
			) {
				const result = `${prefix}_normalize_${this.ip}`;
				declarations.push(`MalValue ${result};`);
				const locked = instruction.opcode === "CALL_KNOWN";
				const form =
					instruction.arguments[0] === undefined
						? "MAL_VALUE_UNDEFINED"
						: this.boxedOperand(instruction.arguments[0]);
				guard += ` && mal_builtin_string_span_normalize(vm, ${locked ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(instruction.callee)}, ${locked}, ${source}, ${prefix}_start, ${prefix}_end, ${form}, &${result})`;
				projected = `${this.throwCheck()} r${instruction.dst} = ${this.callValue(instruction.dst, result)};`;
			} else if (
				(role === "isWellFormedCall" || role === "toWellFormedCall") &&
				(instruction.opcode === "CALL" || instruction.opcode === "CALL_KNOWN")
			) {
				const result = `${prefix}_well_formed_${this.ip}`;
				declarations.push(`MalValue ${result};`);
				const locked = instruction.opcode === "CALL_KNOWN";
				guard += ` && mal_builtin_string_span_well_formed(vm, ${locked ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(instruction.callee)}, ${locked}, ${source}, ${prefix}_start, ${prefix}_end, ${role === "toWellFormedCall"}, &${result})`;
				projected = `${this.throwCheck()} r${instruction.dst} = ${this.callValue(instruction.dst, result)};`;
			} else if (
				role === "localeComparePrepared" &&
				instruction.opcode === "PREPARED_STRING_COMPARE"
			) {
				const result = `${prefix}_locale_compare_${this.ip}`;
				const bytes = this.context.stringConstants[instruction.stringIndex]!;
				declarations.push(`MalValue ${result};`);
				guard += ` && mal_builtin_string_span_locale_compare_prepared(vm, ${source}, ${prefix}_start, ${prefix}_end, ${this.boxed(instruction.right)}, (const byte[]){ ${bytes.length === 0 ? "0" : bytes.join(", ")} }, ${bytes.length}, ${instruction.options}, &${result})`;
				projected = `${this.throwCheck()} r${instruction.dst} = ${this.callValue(instruction.dst, result)};`;
			} else if (
				role === "localeCompareCall" &&
				(instruction.opcode === "CALL" || instruction.opcode === "CALL_KNOWN")
			) {
				const result = `${prefix}_locale_compare_${this.ip}`;
				declarations.push(`MalValue ${result};`);
				const locked = instruction.opcode === "CALL_KNOWN";
				const args = [0, 1, 2].map((index) =>
					instruction.arguments[index] === undefined
						? "MAL_VALUE_UNDEFINED"
						: this.boxedOperand(instruction.arguments[index]),
				);
				guard += ` && mal_builtin_string_span_locale_compare(vm, ${locked ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(instruction.callee)}, ${locked}, ${source}, ${prefix}_start, ${prefix}_end, ${args.join(", ")}, &${result})`;
				projected = `${this.throwCheck()} r${instruction.dst} = ${this.callValue(instruction.dst, result)};`;
			} else if (
				(role === "toLocaleLowerCaseCall" || role === "toLocaleUpperCaseCall") &&
				(instruction.opcode === "CALL" || instruction.opcode === "CALL_KNOWN")
			) {
				const result = `${prefix}_locale_case_${this.ip}`;
				declarations.push(`MalValue ${result};`);
				const locked = instruction.opcode === "CALL_KNOWN";
				const locales =
					instruction.arguments[0] === undefined
						? "MAL_VALUE_UNDEFINED"
						: this.boxedOperand(instruction.arguments[0]);
				guard += ` && mal_builtin_string_span_locale_case(vm, ${locked ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(instruction.callee)}, ${locked}, ${source}, ${prefix}_start, ${prefix}_end, ${locales}, ${role === "toLocaleUpperCaseCall"}, &${result})`;
				projected = `${this.throwCheck()} r${instruction.dst} = ${this.callValue(instruction.dst, result)};`;
			} else if (
				characterCall !== undefined &&
				(instruction.opcode === "CALL" || instruction.opcode === "CALL_KNOWN")
			) {
				const result = `${prefix}_code_${this.ip}`;
				const operation =
					characterCall === "charCodeAt"
						? "CHAR_CODE_AT"
						: STRING_CHARACTER_KERNELS[`String.prototype.${characterCall}`];
				if (operation === undefined)
					throw new Error("Unknown string span character operation");
				declarations.push(`MalValue ${result};`);
				const locked =
					instruction.opcode === "CALL_KNOWN" ||
					this.context.nativeStringCharCodeAtChainAction?.chain.methodIdentity ===
						"authority-invariant";
				const position =
					instruction.arguments[0] === undefined
						? "MAL_VALUE_UNDEFINED"
						: this.boxedOperand(instruction.arguments[0]);
				guard += ` && mal_builtin_string_span_character(vm, ${locked ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(instruction.callee)}, ${locked}, ${source}, ${prefix}_start, ${prefix}_end, ${position}, MAL_STRING_CHARACTER_${operation}, &${result})`;
				projected = `r${instruction.dst} = ${this.callValue(instruction.dst, result)};`;
			} else if (
				searchCall !== undefined &&
				(instruction.opcode === "CALL" || instruction.opcode === "CALL_KNOWN")
			) {
				const result = `${prefix}_search_${this.ip}`;
				const operation = STRING_SEARCH_KERNELS[`String.prototype.${searchCall}`];
				if (operation === undefined)
					throw new Error("Unknown string span search operation");
				declarations.push(`MalValue ${result};`);
				const locked = instruction.opcode === "CALL_KNOWN";
				const argument = (index: number) =>
					instruction.arguments[index] === undefined
						? "MAL_VALUE_UNDEFINED"
						: this.boxedOperand(instruction.arguments[index]);
				guard += ` && mal_builtin_string_span_search(vm, ${locked ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(instruction.callee)}, ${locked}, ${source}, ${prefix}_start, ${prefix}_end, ${argument(0)}, ${argument(1)}, MAL_STRING_SEARCH_${operation[0]}, &${result})`;
				const sourceKind =
					site.parent !== undefined ? "nested" : (site.projection?.kind ?? "range");
				projected = `${this.throwCheck()} MAL_PERF_COUNT(string_span_${sourceKind}_searches); r${instruction.dst} = ${this.callValue(instruction.dst, result)};`;
			} else if (
				(role === "parseInt" || role === "parseFloat") &&
				(instruction.opcode === "CALL" || instruction.opcode === "CALL_KNOWN")
			) {
				const result = `${prefix}_parse_${this.ip}`;
				declarations.push(`f64 ${result};`);
				const locked = instruction.opcode === "CALL_KNOWN";
				const radix =
					instruction.arguments[1] === undefined
						? "MAL_VALUE_UNDEFINED"
						: this.boxedOperand(instruction.arguments[1]);
				guard += ` && mal_builtin_number_span_parse(vm, ${locked ? "MAL_VALUE_UNDEFINED" : this.boxedOperand(instruction.callee)}, ${locked}, ${source}, ${prefix}_start, ${prefix}_end, ${radix}, ${role === "parseInt"}, &${result})`;
				const sourceKind =
					site.parent !== undefined ? "nested" : (site.projection?.kind ?? "range");
				projected = `MAL_PERF_COUNT(string_span_${sourceKind}_parses); ${this.storeNumber(instruction.dst, result)}`;
			} else if (
				(role === "isFinite" || role === "isNaN") &&
				(instruction.opcode === "CALL" || instruction.opcode === "CALL_KNOWN")
			) {
				const finite = role === "isFinite";
				if (instruction.opcode === "CALL")
					guard += ` && ${this.boxedOperand(instruction.callee)} == vm->intrinsics[MAL_INTRINSIC_${finite ? "IS_FINITE" : "IS_NAN"}]`;
				const number = `mal_ops_number_as_f64(mal_ops_string_range_to_number(mal_value_to_string(${source}), ${prefix}_start, ${prefix}_end - ${prefix}_start))`;
				projected = `MAL_PERF_COUNT(string_span_${finite ? "is_finite" : "is_nan"}_calls); ${this.storeBoolean(instruction.dst, `${finite ? "isfinite" : "isnan"}(${number})`)}`;
			} else if (
				role === "number" &&
				(instruction.opcode === "CALL" || instruction.opcode === "CALL_KNOWN")
			) {
				if (instruction.opcode === "CALL")
					guard += ` && ${this.boxedOperand(instruction.callee)} == vm->intrinsics[MAL_INTRINSIC_NUMBER_CONSTRUCTOR]`;
				projected = this.storeNumber(
					instruction.dst,
					`mal_ops_number_as_f64(mal_ops_string_range_to_number(mal_value_to_string(${source}), ${prefix}_start, ${prefix}_end - ${prefix}_start))`,
				);
			}
			if (projected === undefined) return [...materialize, ...ordinary];
			return [
				...declarations,
				`if (${guard}) {`,
				`  MAL_PERF_COUNT(string_span_projections);`,
				`  ${projected}`,
				`  ${this.poll()}`,
				`} else {`,
				...(role === "number" ||
				role === "parseInt" ||
				role === "parseFloat" ||
				role === "isFinite" ||
				role === "isNaN" ||
				role === "replaceCall" ||
				role === "replaceAllCall" ||
				role === "concatCall" ||
				role === "repeatCall" ||
				role === "padStartCall" ||
				role === "padEndCall" ||
				role === "toLowerCaseCall" ||
				role === "toUpperCaseCall" ||
				role === "normalizeCall" ||
				role === "localeCompareCall" ||
				role === "localeComparePrepared" ||
				role === "toLocaleLowerCaseCall" ||
				role === "toLocaleUpperCaseCall" ||
				role === "isWellFormedCall" ||
				role === "toWellFormedCall" ||
				methodProperty !== undefined ||
				characterCall !== undefined ||
				searchCall !== undefined ||
				role === "rangeProperty"
					? materialize.map((line) => `  ${line}`)
					: []),
				...ordinary.map((line) => `  ${line}`),
				`}`,
			];
		}
		return undefined;
	}

	emitObjectLiteral(
		instruction: Extract<BytecodeInstruction, { opcode: "CREATE_OBJECT_SHAPED" }>,
	): Array<string> | null {
		const stackObjectSite = this.context.stackObjectSite;
		if (stackObjectSite?.elided === true) {
			return [`r${instruction.dst} = MAL_VALUE_UNDEFINED;`];
		}
		// Build the literal's shape once in the VM-owned dense site row and
		// create the object directly in it — no per-property defines.
		const keys = instruction.keyStringIndices
			.map(
				(ki) => `vm->string_constant_atoms[${this.context.relocation.stringIndex(ki)}]`,
			)
			.join(", ");
		const values = instruction.valueRegisters.map((r) => this.boxed(r)).join(", ");
		const shape = [
			`MalShape *__oshape_${this.ip} = ${nativeBodyReference(this.context.resources, "literalShapes")}[${instruction.shapeCacheIndex}];`,
			`if (__oshape_${this.ip} == nullptr) { __oshape_${this.ip} = mal_shape_from_string_keys(&vm->heap, (MalString *[]){ ${keys} }, ${instruction.count}); ${nativeBodyReference(this.context.resources, "literalShapes")}[${instruction.shapeCacheIndex}] = __oshape_${this.ip}; }`,
		];
		if (stackObjectSite === undefined) {
			return [
				...shape,
				`r${instruction.dst} = ${this.profileCall("allocation", `mal_vm_create_object_shaped(vm, __oshape_${this.ip}, (MalValue[]){ ${values} }, ${instruction.count})`)};`,
				this.throwCheck(),
			];
		}
		const { objectName, slotsOffset } = stackObjectSite;
		if (stackObjectSite.inheritedLoadInstructionIndex !== undefined) {
			const fastName = stackObjectSite.inheritedFastName!;
			const inheritedValue = stackObjectSite.inheritedValueName!;
			const icName = `${objectName}_inherited_ic`;
			const prototypeName = `${objectName}_prototype`;
			return [
				...shape,
				`MalInlineCache *${icName} = &${nativeBodyReference(this.context.resources, "propertyCache")}[${stackObjectSite.inheritedIcIndex}];`,
				`MalObject *${prototypeName} = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);`,
				`${fastName} = ${icName}->mode == MAL_IC_MODE_INHERITED_VALUE && ${icName}->shape != nullptr && ${icName}->shape == __oshape_${this.ip} && ((${icName}->poly_count > 0 && ${icName}->proto_object[0] == ${prototypeName}) || (${icName}->poly_count == 0 && ${inheritedStackObjectProtectorGuard(stackObjectSite)} && ${icName}->receiver_type == MAL_HEAP_OBJECT && ${icName}->obj == ${prototypeName}));`,
				`if (${fastName}) {`,
				`  ${inheritedValue} = ${icName}->value;`,
				`  mal_perf_stack_object_init();`,
				`  mal_perf_stack_object_inherited_fast_init();`,
				`  mal_object_init_embedded_stack(&vm->heap, &${objectName}, ${prototypeName}, __oshape_${this.ip}, &__gc_slots[${slotsOffset!}]);`,
				...instruction.valueRegisters.map(
					(register, index) =>
						`  ${stackObjectSlotReference(stackObjectSite, index)} = ${this.boxed(register)};`,
				),
				`  r${instruction.dst} = mal_value_from_object(&${objectName}.object);`,
				`} else {`,
				`  mal_perf_stack_object_inherited_heap_fallback();`,
				`  r${instruction.dst} = ${this.profileCall("allocation", `mal_vm_create_object_shaped(vm, __oshape_${this.ip}, (MalValue[]){ ${values} }, ${instruction.count})`)};`,
				`  ${this.throwCheck()}`,
				`}`,
			];
		}
		return [
			...shape,
			...(stackObjectSite.materializedSlot === undefined
				? []
				: [`__gc_slots[${stackObjectSite.materializedSlot}] = MAL_VALUE_UNDEFINED;`]),
			"mal_perf_stack_object_init();",
			`mal_object_init_embedded_stack(&vm->heap, &${objectName}, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]), __oshape_${this.ip}, ${stackObjectSite.fieldSlots === undefined ? `&__gc_slots[${slotsOffset!}]` : "nullptr"});`,
			...instruction.valueRegisters.map((register, index) =>
				this.stackStore(stackObjectSite, index, register),
			),
			`r${instruction.dst} = mal_value_from_object(&${objectName}.object);`,
		];
	}
	emitDefineProperty(
		instruction: Extract<BytecodeInstruction, { opcode: "DEFINE_PROPERTY" }>,
	): Array<string> | null {
		const stringIndex = this.context.staticDefineStringIndexByIp.get(this.ip);
		const objectPossible =
			((this.operandKind(instruction.object) ?? COMPILER_VALUE_KIND_TOP) &
				COMPILER_VALUE_KIND_OBJECT) !==
			0;
		if (stringIndex !== undefined) {
			const cache = `&__dpc_${this.ip}`;
			const slowDefine = [
				...(this.context.incomingRootPublication ?? []).map((line) => `  ${line}`),
				...(this.context.staticPropertyWriteInactiveRootMask === undefined
					? []
					: [
							`  ${cInactiveRootMaskPublication(this.context.staticPropertyWriteInactiveRootMask, this.context.inactiveRootMaskStatements)};`,
						]),
				`  mal_vm_op_define_property_static_cached(vm, ${cache}, ${this.boxed(instruction.object)}, ${this.context.relocation.stringIndex(stringIndex)}, ${this.boxed(instruction.value)}, ${instruction.enumerable}, ${instruction.writable}, ${instruction.configurable});`,
				`  ${this.throwCheck()}`,
			];
			return [
				`static MAL_ISOLATE_LOCAL MalDefinePropertyCache __dpc_${this.ip};`,
				...(objectPossible
					? [
							`if (!mal_vm_try_define_property_static_cached(vm, ${cache}, ${this.boxed(instruction.object)}, ${this.boxed(instruction.value)}, ${instruction.enumerable}, ${instruction.writable}, ${instruction.configurable})) {`,
							...slowDefine,
							`}`,
						]
					: slowDefine),
			];
		}
		const define = `mal_vm_op_define_property(vm, ${this.boxed(instruction.object)}, ${this.boxed(instruction.key)}, ${this.boxed(instruction.value)}, ${instruction.enumerable}, ${instruction.writable}, ${instruction.configurable});`;
		const keyRepresentation = this.reps[instruction.key];
		const keyKind = this.operandKind(instruction.key) ?? COMPILER_VALUE_KIND_TOP;
		const numericKey = keyKind === COMPILER_VALUE_KIND_NUMBER;
		if (
			objectPossible &&
			(numericKey ||
				(keyRepresentation === "boxed" &&
					(keyKind & COMPILER_VALUE_KIND_NUMBER) !== 0)) &&
			instruction.enumerable &&
			instruction.writable &&
			instruction.configurable
		) {
			const array = `__define_array_${this.ip}`;
			const index =
				keyRepresentation === "number" || keyRepresentation === "int32"
					? this.num(instruction.key)
					: `mal_ops_number_as_f64(${this.boxed(instruction.key)})`;
			return [
				`MalArrayObject *${array} = mal_vm_as_array(${this.boxed(instruction.object)});`,
				`if (!(${array} && ${numericKey ? "" : `mal_ops_is_number(${this.boxed(instruction.key)}) && `}mal_vm_array_try_define_index(${array}, ${index}, ${this.boxed(instruction.value)}))) {`,
				`  ${define}`,
				`  ${this.throwCheck()}`,
				`}`,
			];
		}
		return [define, this.throwCheck()];
	}
	emitGetIterator(
		instruction: Extract<BytecodeInstruction, { opcode: "GET_ITERATOR" }>,
	): Array<string> | null {
		const rec = `iter_rec_${this.ip}`;
		const lines = [
			`MalIteratorRecord ${rec};`,
			`if (!mal_vm_get_iterator(vm, ${this.boxed(instruction.source)}, &${rec})) ${this.onThrow()}`,
			`r${instruction.iteratorDst} = ${rec}.iterator;`,
			`r${instruction.nextDst} = ${rec}.next_method;`,
		];
		if (this.context.nativeIteratorCursorAction?.role === "initialize") {
			const { cursor } = this.context.nativeIteratorCursorAction;
			lines.push(
				`__iter_cursor_${cursor.initializeIp} = mal_vm_iterator_protocol_cursor(&${rec}, ${nativeIteratorCursorProtocol(cursor)});`,
			);
			// The array speculation has no proof; a String source resolves its
			// protocol once here instead of revalidating it on every step.
			if (cursor.protocol === "array-values") {
				lines.push(
					`__iter_string_cursor_${cursor.initializeIp} = __iter_cursor_${cursor.initializeIp} == nullptr ? mal_vm_iterator_protocol_cursor(&${rec}, MAL_ITERATOR_CURSOR_STRING_VALUES) : nullptr;`,
				);
			}
		}
		if (
			this.context.deferredIteratorCursor &&
			this.context.nativeIteratorCursorAction?.role === "initialize"
		) {
			const id = this.context.nativeIteratorCursorAction.cursor.initializeIp;
			return [
				`if (mal_vm_array_values_deferred_begin(vm, ${this.boxed(instruction.source)}, &__iter_deferred_${id})) {`,
				`  r${instruction.iteratorDst} = ${this.boxed(instruction.source)};`,
				`  r${instruction.nextDst} = MAL_VALUE_UNDEFINED;`,
				`  __iter_cursor_${id} = nullptr;`,
				`  __iter_string_cursor_${id} = nullptr;`,
				`} else {`,
				...lines.map((line) => `  ${line}`),
				`}`,
			];
		}
		if (this.context.nativeArrayPairDestructureAction?.role === "initialize") {
			const id = this.context.nativeArrayPairDestructureAction.cursor.initializeIp;
			return [
				`__array_pair_${id}_fast = mal_builtin_array_pair_destructure_try(vm, ${this.boxed(instruction.source)}, &__array_pair_${id}_first, &__array_pair_${id}_first_done, &__array_pair_${id}_second, &__array_pair_${id}_second_done);`,
				`if (__array_pair_${id}_fast) {`,
				`  r${instruction.iteratorDst} = MAL_VALUE_UNDEFINED;`,
				`  r${instruction.nextDst} = MAL_VALUE_UNDEFINED;`,
				`  __iter_cursor_${id} = nullptr;`,
				...(this.context.nativeIteratorCursorAction?.role === "initialize" &&
				this.context.nativeIteratorCursorAction.cursor.protocol === "array-values"
					? [`  __iter_string_cursor_${id} = nullptr;`]
					: []),
				`} else {`,
				...lines.map((line) => `  ${line}`),
				`}`,
			];
		}
		if (
			this.context.nativeIteratorEntryPairVirtualizationAction?.role === "innerInitialize"
		) {
			const id =
				this.context.nativeIteratorEntryPairVirtualizationAction.region.outerStepIp;
			return [
				`if (__iter_entry_pair_${id}_fast) {`,
				`  r${instruction.iteratorDst} = MAL_VALUE_UNDEFINED;`,
				`  r${instruction.nextDst} = MAL_VALUE_UNDEFINED;`,
				`} else {`,
				...lines.map((line) => `  ${line}`),
				`}`,
			];
		}
		return lines;
	}
	emitIteratorClose(
		instruction: Extract<BytecodeInstruction, { opcode: "ITERATOR_CLOSE" }>,
	): Array<string> | null {
		if (this.context.nativeIteratorEntryPairVirtualizationAction?.role === "innerClose") {
			const fallback = this.emitGenericInstruction();
			if (fallback === null) return null;
			const id =
				this.context.nativeIteratorEntryPairVirtualizationAction.region.outerStepIp;
			return [
				`if (!__iter_entry_pair_${id}_fast) {`,
				...fallback.map((line) => `  ${line}`),
				`}`,
			];
		}
		const rec = `iter_rec_${this.ip}`;
		if (
			this.context.deferredIteratorCursor &&
			this.context.nativeIteratorCursorAction?.role === "close"
		) {
			const deferred = `__iter_deferred_${this.context.nativeIteratorCursorAction.cursor.initializeIp}`;
			const close = `mal_vm_array_values_deferred_close(vm, ${this.boxed(instruction.iterator)}, &${deferred}, ${instruction.normal})`;
			const record = `MalIteratorRecord ${rec} = { .iterator = ${this.boxed(instruction.iterator)}, .next_method = MAL_VALUE_UNDEFINED };`;
			return instruction.normal
				? [
						record,
						`if (${deferred}.active ? !${close} : !mal_vm_iterator_close_normal(vm, &${rec})) ${this.onThrow()}`,
					]
				: [
						record,
						`if (${deferred}.active) ${close}; else mal_vm_iterator_close(vm, &${rec});`,
						this.throwCheck(),
					];
		}
		if (instruction.normal) {
			// Normal-completion close: propagate return()'s throw and TypeError
			// on a non-object result.
			const lines = [
				`MalIteratorRecord ${rec} = { .iterator = ${this.boxed(instruction.iterator)}, .next_method = MAL_VALUE_UNDEFINED };`,
				`if (!mal_vm_iterator_close_normal(vm, &${rec})) ${this.onThrow()}`,
			];
			if (this.context.nativeArrayPairDestructureAction?.role === "close") {
				const id = this.context.nativeArrayPairDestructureAction.cursor.initializeIp;
				return [
					`if (!__array_pair_${id}_fast) {`,
					...lines.map((line) => `  ${line}`),
					`}`,
				];
			}
			return lines;
		}
		return [
			`MalIteratorRecord ${rec} = { .iterator = ${this.boxed(instruction.iterator)}, .next_method = MAL_VALUE_UNDEFINED };`,
			`mal_vm_iterator_close(vm, &${rec});`,
			this.throwCheck(),
		];
	}
}

function emitInstruction(
	instruction: BytecodeInstruction,
	ip: number,
	suffix: string,
	reps: Array<RegisterRep>,
	strict: boolean,
	handlerIp: number | undefined,
	gcUnlink: string,
	thisSlot: number,
	coro: CoroutineContext | null,
	context: NativeInstructionContext,
): Array<string> | null {
	// Resource discovery stays eager so unused poll text cannot change emitted epilogues.
	if (
		handlerIp === undefined &&
		((context.outgoingRootPublication?.length ?? 0) > 0 ||
			context.loopBackedgeInactiveRootMask !== undefined ||
			context.gcSafepoint ||
			context.guardedCallInactiveRootMask !== undefined)
	)
		nativeBodyReference(context.resources, "throwExit");

	if (context.propertyNumericUpdateAction === undefined) {
		switch (instruction.opcode) {
			case "CREATE_UNDEFINED":
				return [`r${instruction.dst} = MAL_VALUE_UNDEFINED;`];
			case "CREATE_NULL":
				return [`r${instruction.dst} = MAL_VALUE_NULL;`];
			case "CREATE_EMPTY":
				// The hole sentinel requires boxed storage; scalar locals cannot hold it.
				return [`r${instruction.dst} = MAL_VALUE_EMPTY;`];
			case "CREATE_BOOLEAN":
				return [
					reps[instruction.dst] === "boolean"
						? `r${instruction.dst} = ${instruction.value ? "true" : "false"};`
						: `r${instruction.dst} = ${nativeProfileCall("boxing", `mal_value_new_boolean(${instruction.value ? "true" : "false"})`, context.profileSiteId ?? -1, profileDecisionOperation(instruction))};`,
				];
			case "CREATE_NUMBER":
				return [
					reps[instruction.dst] === "int32"
						? `r${instruction.dst} = ${instruction.value};`
						: reps[instruction.dst] === "number"
							? `r${instruction.dst} = ${instruction.value};`
							: `r${instruction.dst} = mal_value_from_i32(${instruction.value});`,
				];
			case "CREATE_F64":
				return [
					reps[instruction.dst] === "int32"
						? `r${instruction.dst} = (i32) ${cF64Literal(instruction.value)};`
						: reps[instruction.dst] === "number"
							? `r${instruction.dst} = ${cF64Literal(instruction.value)};`
							: `r${instruction.dst} = mal_value_from_f64_convert_nan(${cF64Literal(instruction.value)});`,
				];
			case "CREATE_STRING":
				return [
					`r${instruction.dst} = ${context.relocation.stringValue(instruction.stringIndex)};`,
				];
			case "CREATE_BIGINT":
				return [
					`r${instruction.dst} = ${context.relocation.bigintValue(instruction.bigintIndex, suffix)};`,
				];
		}
	}

	const profileSiteId = context.profileSiteId ?? -1;

	const profileOperation =
		profileSiteId < 0 ? undefined : profileDecisionOperation(instruction);
	const emission = new NativeInstructionEmission(
		instruction,
		ip,
		suffix,
		reps,
		strict,
		handlerIp,
		gcUnlink,
		thisSlot,
		coro,
		context,
		profileSiteId,
		profileOperation,
	);

	if (
		instruction.opcode === "MOVE" &&
		context.propertyNumericUpdateAction === undefined &&
		context.staticPropertyNumericAction?.role !== "skip"
	) {
		// A move is also the explicit representation-conversion seam.
		const dst = instruction.dst;
		const read =
			reps[dst] === "int32"
				? reps[instruction.src] === "int32"
					? `r${instruction.src}`
					: reps[instruction.src] === "number"
						? `mal_ops_number_to_i32(r${instruction.src})`
						: `mal_ops_number_value_to_i32(${emission.boxed(instruction.src)})`
				: reps[dst] === "number"
					? reps[instruction.src] === "number"
						? emission.num(instruction.src)
						: reps[instruction.src] === "int32"
							? emission.num(instruction.src)
							: `mal_ops_number_as_f64(${emission.boxed(instruction.src)})`
					: reps[dst] === "boolean"
						? reps[instruction.src] === "boolean"
							? emission.truthy(instruction.src)
							: `mal_value_to_boolean(${emission.boxed(instruction.src)})`
						: emission.boxed(instruction.src);
		return [`r${dst} = ${read};`];
	}

	const {
		nativePlan,
		resources,
		stackObjectAccess,
		stackObjectMaterialization,
		directCompiledEntries,
		indexedLengthLoopAction,
		pairedArrayLoopAction,
		nativeStringSpanAction,
		propertyNumericUpdateAction,
		relocation,
	} = context;

	// An observer needs the record's object in its registers, however the instruction renders.
	if (context.recordObservers !== undefined) {
		const ordinary = emitInstruction(
			instruction,
			ip,
			suffix,
			reps,
			strict,
			handlerIp,
			gcUnlink,
			thisSlot,
			coro,
			{ ...context, recordObservers: undefined },
		);
		if (ordinary === null) return null;
		return [
			...context.recordObservers.flatMap(({ site, aliases }) => {
				const object = recordObject(site);
				const atom = (field: number) =>
					`vm->string_constant_atoms[${relocation.stringIndex(site.keys[field]!)}]`;
				const materialize = (fields: ReadonlyArray<number>) =>
					`${object} = mal_vm_materialize_record(vm, ${recordProducer(site)}, (MalString *[]){${fields.map(atom).join(", ")}}, (MalValue[]){${fields.map((field) => recordBoxed(site, field)).join(", ")}}, ${fields.length});`;
				const shapeIndex = site.shapes === undefined ? undefined : recordShape(site);
				// Record allocations are the only writers of this closed shape tag.
				return [
					`if (${object} == MAL_VALUE_EMPTY) {`,
					...(site.shapes === undefined
						? [`  ${materialize(site.keys.map((_, field) => field))}`]
						: site.shapes.map((fields, shape) => {
								const last = shape === site.shapes!.length - 1;
								return `  ${shape === 0 ? "" : "else "}${last ? "" : `if (${shapeIndex} == ${shape}) `}${materialize(fields)}`;
							})),
					`  ${emission.throwCheck()}`,
					`}`,
					...aliases.map((register) => `r${register} = ${object};`),
				];
			}),
			...ordinary,
		];
	}

	if (context.arrayInitialization !== undefined) {
		const plan = context.arrayInitialization;
		if (ip !== plan.allocationIp) {
			if (plan.mode === "prepared") return [];
			if (instruction.opcode !== "DEFINE_PROPERTY")
				throw new Error("Invalid incremental Array initializer");
			return [
				`mal_array_object_fresh_dense_append_reserved(mal_value_to_array_object(r${instruction.object}), ${emission.boxed(instruction.value)});`,
			];
		}
		if (instruction.opcode !== "CREATE_ARRAY")
			throw new Error("Invalid array initialization producer");
		const values = plan.values.map(emission.boxedOperand.bind(emission)).join(", ");
		const allocation =
			plan.mode === "prepared"
				? `mal_array_object_new_from_values(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), (MalValue[]){ ${values} }, ${plan.values.length})`
				: `mal_array_object_new_reserved(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), ${plan.values.length})`;
		return [
			`MAL_PERF_COUNT(array_initialization_regions);`,
			...(plan.mode === "incremental"
				? ["MAL_PERF_COUNT(array_initialization_incremental_regions);"]
				: []),
			...(plan.values.length > 8
				? ["MAL_PERF_COUNT(array_initialization_large_regions);"]
				: []),
			`r${instruction.dst} = ${emission.profileCall("allocation", `mal_value_from_array_object(${allocation})`)};`,
		];
	}

	if (nativeStringSpanAction !== undefined) {
		const rendered = emission.tryStringSpan(instruction);
		if (rendered !== undefined) return rendered;
	}

	if (
		indexedLengthLoopAction?.role === "load" &&
		(instruction.opcode === "LOAD_PROPERTY_STATIC" ||
			instruction.opcode === "LOAD_PROPERTY_STATIC_ARRAY_LENGTH")
	) {
		const ordinary = emission.emitGenericInstruction();
		if (ordinary === null) return null;
		const id = indexedLengthLoopAction.loadIp;
		if (
			((emission.operandKind(instruction.object) ?? COMPILER_VALUE_KIND_TOP) &
				COMPILER_VALUE_KIND_OBJECT) ===
			0
		)
			return [`__indexed_length_${id}_kind = 0;`, ...ordinary];
		const reverse = indexedLengthLoopAction.site.reverseInduction !== undefined;
		const pairedAdmission =
			pairedArrayLoopAction?.role === "admit"
				? [
						`  __paired_array_${pairedArrayLoopAction.plan.id}_secondary = mal_vm_as_array(${emission.boxed(pairedArrayLoopAction.plan.secondaryObject)});`,
						`  __paired_array_${pairedArrayLoopAction.plan.id}_fast = !__indexed_length_${id}_array->dense_deopted && !__indexed_length_${id}_array->dense_maybe_holey && __indexed_length_${id}_array->dense_count >= __indexed_length_${id}_value && __paired_array_${pairedArrayLoopAction.plan.id}_secondary != nullptr && !__paired_array_${pairedArrayLoopAction.plan.id}_secondary->dense_deopted && !__paired_array_${pairedArrayLoopAction.plan.id}_secondary->dense_maybe_holey && __paired_array_${pairedArrayLoopAction.plan.id}_secondary->dense_count >= __indexed_length_${id}_value && __paired_array_${pairedArrayLoopAction.plan.id}_secondary->length >= __indexed_length_${id}_value;`,
					]
				: [];
		return [
			...(pairedArrayLoopAction?.role === "admit"
				? [`__paired_array_${pairedArrayLoopAction.plan.id}_fast = false;`]
				: []),
			`__indexed_length_${id}_kind = 0;`,
			`__indexed_length_${id}_array = mal_vm_as_array(${emission.boxed(instruction.object)});`,
			`if (__indexed_length_${id}_array != nullptr) {`,
			`  __indexed_length_${id}_kind = 1;`,
			`  __indexed_length_${id}_value = __indexed_length_${id}_array->length;`,
			`  __indexed_length_${id}_induction = (f64) __indexed_length_${id}_value;`,
			`  r${instruction.dst} = ${reps[instruction.dst] === "number" ? `__indexed_length_${id}_induction` : `mal_value_from_u32(__indexed_length_${id}_value)`};`,
			`  mal_perf_ic_load_array_length_hit();`,
			...pairedAdmission,
			`} else if (${reverse ? "false" : `mal_vm_admit_numeric_typed_array_length(vm, ${emission.boxed(instruction.object)}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}], &__indexed_length_${id}_typed_array, &__indexed_length_${id}_value)`}) {`,
			`  __indexed_length_${id}_kind = 2;`,
			`  __indexed_length_${id}_induction = (f64) __indexed_length_${id}_value;`,
			`  r${instruction.dst} = ${reps[instruction.dst] === "number" ? `(f64) __indexed_length_${id}_value` : `mal_value_from_u32(__indexed_length_${id}_value)`};`,
			`} else {`,
			...ordinary.map((line) => `  ${line}`),
			`}`,
		];
	}

	if (context.objectEnumerationSnapshot !== undefined) {
		const site = context.objectEnumerationSnapshot;
		const name = `__enumeration_snapshot_${site.callIp}`;
		const ordinary = emission.emitGenericInstruction();
		if (ordinary === null) return null;
		const snapshot = site.elementIps.length > 0;
		const elements = `&__gc_slots[${site.elementsSlot}]`;
		const materialized = `__gc_slots[${site.materializedSlot}]`;
		if (
			ip === site.callIp &&
			(instruction.opcode === "CALL" || instruction.opcode === "CALL_KNOWN")
		) {
			const locked = instruction.opcode === "CALL_KNOWN";
			const args = `${locked ? "MAL_VALUE_UNDEFINED" : emission.boxedOperand(instruction.callee)}, ${emission.boxedOperand(instruction.arguments[0]!)}, ${locked}`;
			return [
				...(snapshot
					? [
							`for (u32 i = 0; i < ${NATIVE_ENUMERATION_SNAPSHOT_CAPACITY}; i++) __gc_slots[${site.elementsSlot} + i] = MAL_VALUE_UNDEFINED;`,
							`${materialized} = MAL_VALUE_UNDEFINED;`,
						]
					: []),
				`${name}_active = ${snapshot ? `mal_builtin_object_enumeration_snapshot(vm, ${args}, MAL_OBJECT_ENUMERATION_${site.kind.toUpperCase()}, ${elements}, ${NATIVE_ENUMERATION_SNAPSHOT_CAPACITY}, &${name}_value)` : `mal_builtin_object_enumeration_count(${args}, MAL_OBJECT_ENUMERATION_${site.kind.toUpperCase()}, &${name}_value)`};`,
				`if (${name}_active) {`,
				...(snapshot ? [`  ${emission.throwCheck()}`] : []),
				`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
				`  ${emission.poll()}`,
				`} else {`,
				...(snapshot
					? [
							`  for (u32 i = 0; i < ${NATIVE_ENUMERATION_SNAPSHOT_CAPACITY}; i++) (${elements})[i] = MAL_VALUE_UNDEFINED;`,
						]
					: []),
				...ordinary.map((line) => `  ${line}`),
				`}`,
			];
		}
		if (
			instruction.opcode !== "LOAD_PROPERTY_STATIC" &&
			instruction.opcode !== "LOAD_PROPERTY"
		)
			throw new Error("Invalid enumeration-snapshot consumer");
		const available = `${name}_active${snapshot ? ` && mal_value_is_undefined(${materialized})` : ""}`;
		const element = instruction.opcode === "LOAD_PROPERTY";
		const index = `${name}_index_${ip}`;
		const guard = element
			? `${available} && ${index} >= 0 && ${index} < ${name}_value && (f64) (u32) ${index} == ${index}`
			: available;
		return [
			...(element
				? [
						`f64 ${index} = mal_ops_is_number(${emission.boxedOperand(instruction.key)}) ? mal_ops_number_as_f64(${emission.boxedOperand(instruction.key)}) : -1;`,
					]
				: []),
			`if (${guard}) {`,
			`  ${element ? `r${instruction.dst} = ${emission.callValue(instruction.dst, site.kind === "entries" ? `mal_builtin_object_enumeration_entry(vm, ${elements}, (u32) ${index})` : `__gc_slots[${site.elementsSlot} + (u32) ${index}]`)};` : emission.storeNumber(instruction.dst, `(f64) ${name}_value`)}`,
			...(element && site.kind === "entries" ? [`  ${emission.poll()}`] : []),
			`} else {`,
			...(snapshot
				? [
						`  if (${name}_active) {`,
						`    if (mal_value_is_undefined(${materialized})) { MAL_PERF_COUNT(object_${site.kind}_snapshot_materializations); ${materialized} = mal_builtin_object_enumeration_materialize(vm, MAL_OBJECT_ENUMERATION_${site.kind.toUpperCase()}, ${elements}, ${name}_value); }`,
						`    r${instruction.object} = ${materialized};`,
						`  }`,
					]
				: []),
			...ordinary.map((line) => `  ${line}`),
			`}`,
		];
	}

	if (stackObjectMaterialization?.site.materializedSlot !== undefined) {
		const { site, values } = stackObjectMaterialization;
		const materialized = `__gc_slots[${site.materializedSlot}]`;
		const fields = site.fieldSlots;
		const ordinary = emission.emitGenericInstruction();
		if (ordinary === null) return null;
		return [
			`if (${values.map((value) => `r${value} == mal_value_from_object(&${site.objectName}.object)`).join(" || ")}) {`,
			` if (mal_value_is_undefined(${materialized})) {`,
			...(fields === undefined
				? []
				: [
						`  MalValue __stack_values_${ip}[${fields.length}] = { ${fields.map((field) => emission.convertedValue(field.representation, "boxed", field.name)).join(", ")} };`,
					]),
			`  ${materialized} = ${fields === undefined ? `mal_vm_materialize_stack_object(vm, &${site.objectName}.object)` : `mal_vm_materialize_stack_object_fields(vm, &${site.objectName}.object, __stack_values_${ip}, ${fields.length})`};`,
			`  ${emission.throwCheck()}`,
			`}`,
			...values.map(
				(value) =>
					`if (r${value} == mal_value_from_object(&${site.objectName}.object)) r${value} = ${materialized};`,
			),
			`}`,
			...ordinary,
		];
	}

	if (
		stackObjectAccess?.site.materializedSlot !== undefined &&
		(instruction.opcode === "LOAD_PROPERTY_STATIC" ||
			instruction.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT" ||
			instruction.opcode === "STORE_PROPERTY_STATIC" ||
			instruction.opcode === "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT")
	) {
		const { site, slot } = stackObjectAccess;
		const materialized = `__gc_slots[${site.materializedSlot}]`;
		const ordinary = emission.emitGenericInstruction({
			nativePlan: nativePlan?.kind === "known-own-data" ? nativePlan : undefined,
		});
		if (ordinary === null) return null;
		const virtual =
			instruction.opcode === "LOAD_PROPERTY_STATIC" ||
			instruction.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT"
				? emission.stackLoad(site, slot, instruction.dst)
				: emission.stackStore(site, slot, instruction.value);
		return [
			`if (r${instruction.object} == mal_value_from_object(&${site.objectName}.object) && mal_value_is_undefined(${materialized})) {`,
			`  ${virtual}`,
			`} else {`,
			`  if (r${instruction.object} == mal_value_from_object(&${site.objectName}.object)) r${instruction.object} = ${materialized};`,
			...ordinary.map((line) => `  ${line}`),
			`}`,
		];
	}

	if (nativePlan?.kind === "exact-own-slot" && stackObjectAccess === undefined) {
		switch (instruction.opcode) {
			case "LOAD_PROPERTY_STATIC":
			case "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT":
				return [
					"MAL_PERF_COUNT(exact_own_slot_loads);",
					`r${instruction.dst} = ${emission.callValue(instruction.dst, `mal_object_field_load_shaped(mal_value_to_object(${emission.boxed(instruction.object)}), ${nativePlan.slot})`)};`,
				];
			case "STORE_PROPERTY_STATIC":
			case "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT":
				return [
					"MAL_PERF_COUNT(exact_own_slot_stores);",
					`mal_vm_object_slot_store(mal_value_to_object(${emission.boxed(instruction.object)}), ${nativePlan.slot}, ${emission.boxed(instruction.value)});`,
				];
		}
	}

	if (
		nativePlan?.kind === "exact-packed-rest-array-length" &&
		instruction.opcode === "LOAD_PROPERTY_STATIC"
	) {
		const length =
			context.directArgumentRepresentations === undefined
				? `(arg_count > ${nativePlan.startIndex} ? arg_count - ${nativePlan.startIndex} : 0)`
				: String(
						Math.max(
							0,
							context.directArgumentRepresentations.length - nativePlan.startIndex,
						),
					);
		return [emission.storeNumber(instruction.dst, `(f64) ${length}`)];
	}

	if (
		nativePlan?.kind === "exact-array-length" &&
		(instruction.opcode === "LOAD_PROPERTY_STATIC" ||
			instruction.opcode === "LOAD_PROPERTY_STATIC_ARRAY_LENGTH")
	) {
		return [
			reps[instruction.dst] === "number"
				? `r${instruction.dst} = (f64) mal_array_object_length(mal_value_to_array_object(${emission.boxed(instruction.object)}));`
				: `r${instruction.dst} = mal_value_from_u32(mal_array_object_length(mal_value_to_array_object(${emission.boxed(instruction.object)})));`,
		];
	}

	if (
		nativePlan?.kind === "contained-fixed-typed-array-length" &&
		(instruction.opcode === "LOAD_PROPERTY_STATIC" ||
			instruction.opcode === "LOAD_PROPERTY_STATIC_ARRAY_LENGTH")
	) {
		return [
			reps[instruction.dst] === "number"
				? `r${instruction.dst} = (f64) mal_value_to_typed_array_object(${emission.boxed(instruction.object)})->length;`
				: `r${instruction.dst} = mal_value_from_u32(mal_value_to_typed_array_object(${emission.boxed(instruction.object)})->length);`,
		];
	}

	if (
		nativePlan?.kind === "exact-packed-rest-array-element" &&
		instruction.opcode === "LOAD_PROPERTY"
	) {
		const directArguments = context.directArgumentRepresentations;
		if (directArguments !== undefined) {
			const values = directArguments.slice(nativePlan.startIndex);
			if (values.length === 0)
				return [`r${instruction.dst} = ${zeroOf(reps[instruction.dst]!)};`];
			const numeric = isNumericRep(reps[instruction.dst]!) && values.every(isNumericRep);
			const directValue = (representation: VmRegisterRepresentation, index: number) => {
				const parameter = `p${nativePlan.startIndex + index}`;
				if (numeric) return representation === "int32" ? `(f64) ${parameter}` : parameter;
				return representation === "int32"
					? `mal_value_from_i32(${parameter})`
					: representation === "number"
						? `mal_ops_number_value(${parameter})`
						: representation === "boolean"
							? `mal_value_new_boolean(${parameter})`
							: parameter;
			};
			const index = `__rest_index_${ip}`;
			const lines = [
				"MAL_PERF_COUNT(array_contained_element_reads);",
				`u32 ${index} = (u32) ${emission.typedNumber(instruction.key)};`,
				`switch (${index}) {`,
				...values.flatMap((representation, offset) => [
					`case ${offset}: r${instruction.dst} = ${directValue(representation, offset)}; break;`,
				]),
				`default: r${instruction.dst} = ${zeroOf(reps[instruction.dst]!)}; break;`,
				"}",
			];
			if (
				indexedLengthLoopAction?.role === "element" &&
				indexedLengthLoopAction.element?.kind === "load" &&
				indexedLengthLoopAction.element.arrayIndexIsUint32
			)
				return lines;
			const rawIndex = `__rest_raw_index_${ip}`;
			return [
				`f64 ${rawIndex} = ${emission.typedNumber(instruction.key)};`,
				`if (${rawIndex} >= 0.0 && ${rawIndex} < ${values.length}.0 && ${rawIndex} == trunc(${rawIndex})) {`,
				...lines.map((line) => `  ${line}`),
				`} else { r${instruction.dst} = ${zeroOf(reps[instruction.dst]!)}; }`,
			];
		}
		if (
			indexedLengthLoopAction?.role === "element" &&
			indexedLengthLoopAction.element?.kind === "load" &&
			indexedLengthLoopAction.element.arrayIndexIsUint32
		) {
			return [
				"MAL_PERF_COUNT(array_contained_element_reads);",
				`r${instruction.dst} = ${emission.callValue(
					instruction.dst,
					`args[${nativePlan.startIndex} + (u32) ${emission.typedNumber(instruction.key)}]`,
				)};`,
			];
		}
		const index = `__rest_index_${ip}`;
		const length = `__rest_length_${ip}`;
		const value = `__rest_value_${ip}`;
		return [
			"MAL_PERF_COUNT(array_contained_element_reads);",
			`f64 ${index} = ${emission.typedNumber(instruction.key)};`,
			`u32 ${length} = arg_count > ${nativePlan.startIndex} ? (u32) (arg_count - ${nativePlan.startIndex}) : 0;`,
			`MalValue ${value} = MAL_VALUE_UNDEFINED;`,
			`if (${index} >= 0.0 && ${index} < (f64) ${length} && ${index} == trunc(${index})) {`,
			`  ${value} = args[${nativePlan.startIndex} + (u32) ${index}];`,
			`}`,
			`r${instruction.dst} = ${emission.callValue(instruction.dst, value)};`,
		];
	}

	if (
		nativePlan?.kind === "exact-contained-array-element" &&
		instruction.opcode === "LOAD_PROPERTY"
	) {
		const value = `__private_array_element_${ip}`;
		const array = `mal_value_to_array_object(${emission.boxed(instruction.object)})`;
		const load =
			indexedLengthLoopAction?.role === "element" &&
			indexedLengthLoopAction.element?.kind === "load" &&
			indexedLengthLoopAction.element.arrayIndexIsUint32
				? `mal_vm_private_array_try_get_proven_index(${array}, (u32) ${emission.typedNumber(instruction.key)}, &${value})`
				: `mal_vm_private_array_try_get_index(${array}, ${emission.typedNumber(instruction.key)}, &${value})`;
		return [
			"MAL_PERF_COUNT(array_contained_element_reads);",
			`MalValue ${value};`,
			`if (!${load}) {`,
			`  ${value} = ${emission.profileCall("property", `mal_vm_indexed_fast_load_index(vm, ${emission.boxed(instruction.object)}, ${emission.typedNumber(instruction.key)}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
			`  ${emission.throwCheck()}`,
			`}`,
			`r${instruction.dst} = ${emission.callValue(instruction.dst, value)};`,
		];
	}

	if (
		nativePlan?.kind === "exact-typed-array-element" ||
		nativePlan?.kind === "contained-fixed-typed-array-element"
	) {
		const kind = nativeTypedArrayKind(nativePlan.elementKind);
		const elementSize = nativeTypedArrayElementSize(nativePlan.elementKind);
		if (instruction.opcode === "LOAD_PROPERTY") {
			const numericKey = emission.nativeNumberOperand(instruction.key);
			const index =
				numericKey ?? `mal_ops_number_as_f64(${emission.boxed(instruction.key)})`;
			if (
				nativePlan.kind === "contained-fixed-typed-array-element" &&
				nativePlan.inBounds
			) {
				const array = `__typed_load_${ip}`;
				const bits = `mal_scalar_load_native_u${elementSize * 8}(${array}->buffer->data + ${array}->byte_offset + (usize)(u32)(${index}) * ${elementSize})`;
				const value =
					nativePlan.elementKind === "Float64Array"
						? `mal_scalar_f64_from_bits(${bits})`
						: nativePlan.elementKind === "Float32Array"
							? `mal_scalar_f32_from_bits(${bits})`
							: nativePlan.elementKind.startsWith("Int")
								? `mal_scalar_i${elementSize * 8}_from_bits(${bits})`
								: bits;
				return [
					`MalTypedArrayObject *${array} = mal_value_to_typed_array_object(${emission.boxed(instruction.object)});`,
					emission.storeNumber(instruction.dst, `(f64)(${value})`),
				];
			}
			const exactLoad = `${nativePlan.kind === "contained-fixed-typed-array-element" ? "mal_vm_contained_fixed_numeric_typed_array_load" : "mal_vm_exact_numeric_typed_array_load"}(mal_value_to_typed_array_object(${emission.boxed(instruction.object)}), mal_vm_typed_array_numeric_index(${index}), ${kind}, ${elementSize})`;
			if (numericKey !== null) {
				emission.elideFramePosition();
				return [
					"MAL_PERF_COUNT(exact_typed_array_loads);",
					`r${instruction.dst} = ${emission.callValue(instruction.dst, exactLoad)};`,
				];
			}
			if (
				((emission.operandKind(instruction.key) ?? COMPILER_VALUE_KIND_TOP) &
					COMPILER_VALUE_KIND_NUMBER) ===
				0
			)
				return [
					`r${instruction.dst} = ${emission.profileCall("property", `mal_vm_op_load_property_ic(vm, ${emission.boxed(instruction.object)}, ${emission.boxed(instruction.key)}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
					emission.throwCheck(),
				];
			return [
				`if (mal_ops_is_number(${emission.boxed(instruction.key)})) {`,
				"  MAL_PERF_COUNT(exact_typed_array_loads);",
				`  r${instruction.dst} = ${emission.callValue(instruction.dst, exactLoad)};`,
				"} else {",
				`  r${instruction.dst} = ${emission.profileCall("property", `mal_vm_op_load_property_ic(vm, ${emission.boxed(instruction.object)}, ${emission.boxed(instruction.key)}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
				`  ${emission.throwCheck()}`,
				"}",
			];
		}
		if (instruction.opcode === "STORE_PROPERTY") {
			const numericKey = emission.nativeNumberOperand(instruction.key);
			const numericValue = emission.nativeNumberOperand(instruction.value);
			const key =
				numericKey ?? `mal_ops_number_as_f64(${emission.boxed(instruction.key)})`;
			// Containment prevents buffer exposure; numeric operands need no observable coercion.
			if (
				nativePlan.kind === "contained-fixed-typed-array-element" &&
				(nativePlan.inBounds || numericKey !== null) &&
				numericValue !== null
			) {
				const array = `__typed_store_${ip}`;
				const index = `__typed_store_index_${ip}`;
				const storedBits =
					nativePlan.elementKind === "Uint8ClampedArray"
						? reps[instruction.value] === "int32"
							? `(r${instruction.value} <= 0 ? 0 : r${instruction.value} >= 255 ? 255 : (u8) r${instruction.value})`
							: `mal_typed_array_to_uint8_clamp(${numericValue})`
						: nativePlan.elementKind === "Float64Array"
							? `mal_scalar_f64_to_bits(${numericValue})`
							: nativePlan.elementKind === "Float32Array"
								? `mal_scalar_f32_to_bits((f32) ${numericValue})`
								: `(u${elementSize * 8}) ${emission.nativeInt32Operand(instruction.value)!}`;
				return [
					`MalTypedArrayObject *${array} = mal_value_to_typed_array_object(${emission.boxed(instruction.object)});`,
					`u32 ${index} = ${nativePlan.inBounds ? `(u32)(${key})` : `mal_vm_typed_array_numeric_index(${key})`};`,
					...(nativePlan.inBounds ? [] : [`if (${index} < ${array}->length) {`]),
					`  mal_scalar_store_native_u${elementSize * 8}(${array}->buffer->data + ${array}->byte_offset + (usize) ${index} * ${elementSize}, ${storedBits});`,
					...(nativePlan.inBounds ? [] : [`}`]),
				];
			}
			const exactStore = `mal_vm_numeric_typed_array_store_known_receiver(vm, mal_value_to_typed_array_object(${emission.boxed(instruction.object)}), ${key}, ${emission.boxed(instruction.value)}, ${strict});`;
			if (numericKey !== null) return [exactStore, emission.throwCheck()];
			if (
				((emission.operandKind(instruction.key) ?? COMPILER_VALUE_KIND_TOP) &
					COMPILER_VALUE_KIND_NUMBER) ===
				0
			)
				return [
					`mal_vm_indexed_fast_store(vm, ${emission.boxed(instruction.object)}, ${emission.boxed(instruction.key)}, ${emission.boxed(instruction.value)}, ${strict}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}]);`,
					emission.throwCheck(),
				];
			return [
				`if (mal_ops_is_number(${emission.boxed(instruction.key)})) {`,
				`  ${exactStore}`,
				`  ${emission.throwCheck()}`,
				"} else {",
				`  mal_vm_indexed_fast_store(vm, ${emission.boxed(instruction.object)}, ${emission.boxed(instruction.key)}, ${emission.boxed(instruction.value)}, ${strict}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}]);`,
				`  ${emission.throwCheck()}`,
				"}",
			];
		}
	}

	if (
		context.recordForward !== undefined &&
		context.recordForwarded === undefined &&
		instruction.opcode === "CALL"
	) {
		const forwarded = new Set<number>();
		const lines = emission.emitGenericInstruction({
			...context,
			recordForwarded: forwarded,
		});
		if (lines === null || forwarded.has(ip)) return lines;
		// The callee's literal is fresh and unchanged, so its slots are its fields in key order.
		return [
			...lines,
			...context.recordForward.map(
				(storage, field) =>
					`*rf${field} = ${emission.recordStoredValue(storage, "boxed", `mal_object_field_load_shaped(mal_value_to_object(${emission.boxed(instruction.dst)}), ${field})`)};`,
			),
			`r${instruction.dst} = MAL_VALUE_EMPTY;`,
		];
	}

	if (
		context.recordObject !== undefined &&
		instruction.opcode === "CREATE_OBJECT_SHAPED"
	) {
		const site = context.recordObject;
		return [
			...instruction.valueRegisters.map(
				(register, field) =>
					`${recordSlot(site, field)} = ${emission.recordStoredValue(site.storage[field]!, reps[register]!, emission.inputValue(register))};`,
			),
			`${recordObject(site)} = MAL_VALUE_EMPTY;`,
			...(site.producer === undefined
				? []
				: [`${recordProducer(site)} = vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE];`]),
			`r${instruction.dst} = MAL_VALUE_EMPTY;`,
		];
	}

	if (
		context.recordAllocation !== undefined &&
		instruction.opcode === "CREATE_OBJECT_SHAPED"
	) {
		const { fields, shape, storage } = context.recordAllocation;
		const count = storage.length;
		return [
			...instruction.valueRegisters.map(
				(register, index) =>
					`*rf${fields[index]!} = ${emission.recordStoredValue(storage[fields[index]!]!, reps[register]!, emission.inputValue(register))};`,
			),
			// A field this literal lacks reads as undefined, since no prototype has its key.
			...Array.from({ length: count }, (_, field) => field)
				.filter((field) => !fields.includes(field))
				.map((field) => `*rf${field} = MAL_VALUE_UNDEFINED;`),
			...(shape === undefined ? [] : [`*rf${count} = ${shape};`]),
			// The empty value tells the caller its storage holds the record.
			`r${instruction.dst} = MAL_VALUE_EMPTY;`,
		];
	}

	if (
		context.recordAccess !== undefined &&
		(instruction.opcode === "LOAD_PROPERTY_STATIC" ||
			instruction.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT" ||
			instruction.opcode === "STORE_PROPERTY_STATIC" ||
			instruction.opcode === "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT")
	) {
		const { site, field } = context.recordAccess;
		const slot = recordSlot(site, field);
		const virtual =
			instruction.opcode === "LOAD_PROPERTY_STATIC" ||
			instruction.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT"
				? `r${instruction.dst} = ${emission.convertedValue(site.storage[field]!.representation, reps[instruction.dst]!, slot)};`
				: `${slot} = ${emission.recordStoredValue(site.storage[field]!, reps[instruction.value]!, emission.inputValue(instruction.value))};`;
		if (site.object === undefined) return [virtual];
		// Once an observer created the object, it is the record: accesses go through it.
		const ordinary = emission.emitGenericInstruction();
		if (ordinary === null) return null;
		const object = recordObject(site);
		return [
			`if (${object} == MAL_VALUE_EMPTY) {`,
			`  ${virtual}`,
			`} else {`,
			`  r${instruction.object} = ${object};`,
			...ordinary.map((line) => `  ${line}`),
			`}`,
		];
	}

	if (context.fieldLoad !== undefined && instruction.opcode === "LOAD_PROPERTY_STATIC")
		return [
			context.fieldLoad.representation === "number"
				? emission.storeNumber(instruction.dst, `fp${context.fieldLoad.field}`)
				: context.fieldLoad.representation === "boolean"
					? emission.storeBoolean(instruction.dst, `fp${context.fieldLoad.field}`)
					: `r${instruction.dst} = fp${context.fieldLoad.field};`,
		];

	if (nativePlan?.kind === "known-own-data" && stackObjectAccess === undefined) {
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" ||
			instruction.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT"
		)
			return [
				`r${instruction.dst} = ${emission.callValue(instruction.dst, `mal_vm_load_known_own_data(${emission.boxed(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
			];
		if (
			instruction.opcode === "STORE_PROPERTY_STATIC" ||
			instruction.opcode === "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT"
		)
			return [
				`mal_vm_store_known_own_data(${emission.boxed(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), ${emission.boxed(instruction.value)}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}]);`,
			];
	}

	if (
		context.fieldAllocation !== undefined &&
		instruction.opcode === "CREATE_OBJECT_SHAPED"
	) {
		const site = context.fieldAllocation;
		return [
			...instruction.valueRegisters.map((register, field) => {
				const slot = site.boxedSlots[field];
				if (slot !== undefined)
					return `__gc_slots[${slot}] = ${emission.boxed(register)};`;
				const value =
					site.valueRepresentations[field] === "boolean"
						? reps[register] === "boolean"
							? `r${register}`
							: `mal_value_to_boolean(${emission.boxed(register)})`
						: isNumericRep(reps[register]!)
							? emission.num(register)
							: `mal_ops_number_as_f64(${emission.boxed(register)})`;
				return `__field_${ip}_${field} = ${value};`;
			}),
			`r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
		];
	}

	if (context.fieldCall !== undefined && instruction.opcode === "CALL") {
		const site = context.fieldCall;
		const targets = site.entries.filter(
			(entry) =>
				directCompiledEntries.has(
					directCompiledEntryKey(entry.functionIndex, entry.entryId),
				) &&
				context.callTransport?.targets.some(
					(target) =>
						target.functionIndex === entry.functionIndex &&
						target.entryId === entry.entryId,
				),
		);
		const callee = emission.boxedOperand(instruction.callee);
		const index = `__field_target_${ip}`;
		const shape = `__field_shape_${ip}`;
		const keys = site.allocation.keyStringIndices
			.map((key) => `vm->string_constant_atoms[${relocation.stringIndex(key)}]`)
			.join(", ");
		const values = site.allocation.keyStringIndices
			.map((_, field) =>
				site.boxedSlots[field] === undefined
					? site.valueRepresentations[field] === "boolean"
						? `mal_value_new_boolean(__field_${site.allocationIp}_${field})`
						: `mal_ops_number_value(__field_${site.allocationIp}_${field})`
					: `__gc_slots[${site.boxedSlots[field]}]`,
			)
			.join(", ");
		const rest = emitInstruction(
			instruction,
			ip,
			suffix,
			reps,
			strict,
			handlerIp,
			gcUnlink,
			thisSlot,
			coro,
			{ ...context, fieldCall: undefined, fieldEntryCall: site },
		);
		if (rest === null) return null;
		return [
			`i32 ${index} = MAL_FUNCTION_INDEX_OF(${callee});`,
			`if (!(${targets.map((target) => `${index} == ${relocation.functionIndex(target.functionIndex)}`).join(" || ") || "false"})) {`,
			`  MalShape *${shape} = ${nativeBodyReference(resources, "literalShapes")}[${site.allocation.shapeCacheIndex}];`,
			`  if (${shape} == nullptr) { ${shape} = mal_shape_from_string_keys(&vm->heap,(MalString *[]){${keys}},${site.allocation.count}); ${nativeBodyReference(resources, "literalShapes")}[${site.allocation.shapeCacheIndex}] = ${shape}; }`,
			`  r${site.allocation.dst} = mal_vm_create_object_shaped(vm,${shape},(MalValue[]){${values}},${site.allocation.count});`,
			`  ${emission.throwCheck()}`,
			`}`,
			...rest,
			...site.boxedSlots.flatMap((slot) =>
				slot === undefined ? [] : [`__gc_slots[${slot}] = MAL_VALUE_UNDEFINED;`],
			),
		];
	}

	if (propertyNumericUpdateAction !== undefined) {
		const { plan, role, load, store } = propertyNumericUpdateAction;
		const fallback = emission.emitGenericInstruction();
		if (fallback === null) return null;
		if (role === "constant") return fallback;
		const prefix = `__property_numeric_update_${plan.id}`;
		const materializations = plan.materializations
			.filter((value) => value.ip === ip)
			.map((value) => {
				const expression = `${prefix}_${value.value === "old" ? "old" : "next"}`;
				return emission.storeNumber(value.register, expression);
			});
		const dispatch =
			materializations.length === 0
				? [`if (!${prefix}_fast) {`, ...fallback.map((line) => `  ${line}`), `}`]
				: [
						`if (${prefix}_fast) {`,
						...materializations.map((line) => `  ${line}`),
						`} else {`,
						...fallback.map((line) => `  ${line}`),
						`}`,
					];
		if (role !== "load") return dispatch;
		const operand = plan.operation;
		let guard = "true";
		let expression: string | null;
		if (operand.kind === "unary") {
			expression = `${prefix}_old ${operand.operator === "increment" ? "+" : "-"} 1.0`;
		} else {
			let other: string;
			if (operand.right.kind === "literal") other = cF64Literal(operand.right.value);
			else {
				const register = operand.right.register;
				if (reps[register] === "boxed") {
					guard = `mal_ops_is_number(r${register})`;
					other = `mal_ops_number_as_f64(r${register})`;
				} else other = emission.num(register);
			}
			const otherScalar =
				operand.right.kind === "register"
					? emission.scalarNumber(operand.right.register)
					: undefined;
			expression = nativeNumberExpr(
				operand.operator,
				operand.propertyIsLeft ? `${prefix}_old` : other,
				operand.propertyIsLeft ? other : `${prefix}_old`,
				context.propertyNumericUpdateFacts?.inputIntegerRanges,
				operand.propertyIsLeft ? undefined : otherScalar,
				operand.propertyIsLeft ? otherScalar : undefined,
			);
		}
		if (expression === null) return null;
		const begin =
			load.stringIndex === store.stringIndex
				? `mal_vm_property_numeric_update_begin_same(${emission.boxed(load.object)}, &${nativeBodyReference(resources, "propertyCache")}[${store.icIndex}], &${prefix}_state, &${prefix}_old)`
				: `mal_vm_property_numeric_update_begin(${emission.boxed(load.object)}, &${nativeBodyReference(resources, "propertyCache")}[${load.icIndex}], &${nativeBodyReference(resources, "propertyCache")}[${store.icIndex}], &${prefix}_state, &${prefix}_old)`;
		return [
			`${prefix}_fast = false;`,
			`if (${guard}) {`,
			`  MalNativeNumericFieldUpdate ${prefix}_state;`,
			`  if (${begin}) {`,
			`    ${prefix}_next = ${expression};`,
			`    ${prefix}_fast = mal_vm_property_numeric_update_commit(&${prefix}_state, ${prefix}_next, nullptr);`,
			`  }`,
			`}`,
			...dispatch,
		];
	}

	return emission.emitOrdinary(instruction);
}

export type { RegisterRep };
