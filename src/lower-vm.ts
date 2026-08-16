import type { OptimizationPassDelta } from "./compiler-diagnostics.ts";
import type { CompilerGuardPlan } from "./compiler-facts.ts";
import type {
	IntermediateProgram,
	IRFunction,
	IRImmediateValue,
	IRInstruction,
	IRNumericHofPlanOperation,
} from "./ir.ts";
import { computeSafepointRoots } from "./liveness.ts";
import { buildProfileMetadata } from "./profile-metadata.ts";
import type { CompilerRemark, ProfileSite } from "./profile-metadata.ts";
import type { Binding } from "./semantic-analysis.ts";

type IRBinaryOperator = Extract<IRInstruction, { type: "binary" }>["operator"];
type IRUnaryOperator = Extract<IRInstruction, { type: "unary" }>["operator"];
type IRIntrinsic = Extract<IRInstruction, { type: "loadIntrinsic" }>["intrinsic"];
type IRTypeofResult = Extract<IRInstruction, { type: "typeofCompare" }>["expected"];

const VM_VALUE_UNDEFINED = -1;
const VM_VALUE_NULL = -2;
const VM_VALUE_FALSE = -3;
const VM_VALUE_TRUE = -4;
const VM_VALUE_STRING_BASE = -5;
const VM_VALUE_MAX_PAYLOAD = 0x0fff_ffff;
const VM_VALUE_STRING_MIN = VM_VALUE_STRING_BASE - VM_VALUE_MAX_PAYLOAD;
const VM_VALUE_I28_BASE = -0x2000_0000;
const VM_VALUE_I28_MIN = VM_VALUE_I28_BASE - VM_VALUE_MAX_PAYLOAD;

export type DecodedVmValueOperand =
	| { kind: "register"; register: number }
	| { kind: "undefined" }
	| { kind: "null" }
	| { kind: "boolean"; value: boolean }
	| { kind: "number"; value: number }
	| { kind: "string"; index: number };

export function encodeVmValueOperand(
	register: number,
	value: IRImmediateValue | undefined,
): number {
	if (value === undefined) return register;
	switch (value.kind) {
		case "undefined":
			return VM_VALUE_UNDEFINED;
		case "null":
			return VM_VALUE_NULL;
		case "boolean":
			return value.value ? VM_VALUE_TRUE : VM_VALUE_FALSE;
		case "string":
			return VM_VALUE_STRING_BASE - value.index;
		case "number": {
			const zigzag = value.value >= 0 ? value.value * 2 : -value.value * 2 - 1;
			return VM_VALUE_I28_BASE - zigzag;
		}
	}
}

export function decodeVmValueOperand(operand: number): DecodedVmValueOperand {
	if (operand >= 0) return { kind: "register", register: operand };
	switch (operand) {
		case VM_VALUE_UNDEFINED:
			return { kind: "undefined" };
		case VM_VALUE_NULL:
			return { kind: "null" };
		case VM_VALUE_FALSE:
			return { kind: "boolean", value: false };
		case VM_VALUE_TRUE:
			return { kind: "boolean", value: true };
	}
	if (operand <= VM_VALUE_STRING_BASE && operand >= VM_VALUE_STRING_MIN) {
		return { kind: "string", index: VM_VALUE_STRING_BASE - operand };
	}
	if (operand <= VM_VALUE_I28_BASE && operand >= VM_VALUE_I28_MIN) {
		const payload = VM_VALUE_I28_BASE - operand;
		return {
			kind: "number",
			value: payload % 2 === 0 ? payload / 2 : -(payload + 1) / 2,
		};
	}
	throw new Error(`Invalid VM value operand ${operand}`);
}

export function rebaseVmValueOperand(operand: number, stringBase: number): number {
	const decoded = decodeVmValueOperand(operand);
	return decoded.kind === "string"
		? VM_VALUE_STRING_BASE - (decoded.index + stringBase)
		: operand;
}

export type VmGuardedBuiltinOperation =
	| "Array.prototype.push"
	| "String.prototype.charCodeAt"
	| "Map.prototype.get"
	| "Map.prototype.set"
	| "Set.prototype.add";

export type VmSemanticDependency =
	| { readonly kind: "world"; readonly fact: "primordials.locked" }
	| {
			readonly kind: "epoch";
			readonly family:
				| "primitive-methods"
				| "watched-methods"
				| "array-elements"
				| "global-bindings"
				| "object-shapes";
	  };

export type VmGuardObligation = "generic-call" | "materialize";

/** Backend-neutral proof contract retained across frontend-cache serialization. */
export interface VmGuardPlan {
	readonly dependencies: ReadonlyArray<VmSemanticDependency>;
	readonly obligations: ReadonlyArray<VmGuardObligation>;
}

export interface VmGuardedBuiltinCall {
	readonly operation: VmGuardedBuiltinOperation;
	/** The shared semantic facts and fallback contract for this specialization. */
	readonly guard: VmGuardPlan;
}

export function vmCallProvesBuiltin(
	instruction: Extract<VmInstruction, { opcode: "CALL" }>,
	operation: VmGuardedBuiltinOperation,
): boolean {
	return instruction.guardedBuiltinCall?.operation === operation;
}

/**
 * Keep inline with the C struct
 */
export interface VmDefinition {
	/** Absolute source entry used for Node-compatible process.argv[1]. */
	entrypointPath: string;
	functionCount: number;
	functions: Array<VmFunction>;
	stringConstants: Array<Array<number>>;
	bigintConstants: Array<bigint>;
	literalTemplateData: Array<number>;
	globalCount: number;

	/**
	 * Debug-info file table: file id -> source path (relative to the compiler's
	 * working directory). A function's `fileIndex` points here; the runtime
	 * prefixes each with `compiled://` for stack-trace frames.
	 */
	files: Array<string>;

	/**
	 * Debug-info position table: pos id -> (line, column), shared by all
	 * functions (the file is resolved per-function). A function's per-instruction
	 * `positions` index into this.
	 */
	sourcePositions: Array<{
		line: number;
		column: number;
		inlinedFunctionIndex?: number;
		callerPosId?: number;
	}>;

	/** Build-local source sites and structured optimization decisions. Profile
	 * builds emit these; ordinary generated code ignores them. */
	profileSites?: Array<ProfileSite>;
	profileRemarks?: Array<CompilerRemark>;
	optimizationTrace?: Array<OptimizationPassDelta>;

	/**
	 * CommonJS module table: index (module id) -> wrapper function index. Empty
	 * for programs with no CommonJS modules.
	 */
	cjsModuleFunctionIndices: Array<number>;

	/**
	 * Host-install manifest: for each `node:*` built-in whose exports the program
	 * uses, plus the slot-free global `process` installer, the native installer's C
	 * symbol and any global slots it fills. Dead-code elimination drops unused
	 * entries, so an ordinary program's manifest is empty. Installers run after VM
	 * init / host attach and before execution; a definition decoded from the wire
	 * keeps the same name/slot entries but its installer pointer is unresolved (null).
	 */
	hostInstalls: Array<{
		installer: string;
		exports: Array<{ name: string; slot: number }>;
	}>;
}

/**
 * Keep inline with the C struct
 */
export interface VmExceptionHandler {
	startIp: number;
	endIp: number;
	handlerIp: number;
}

export const ARGUMENT_SNAPSHOT_SOURCE_COUNT = -1;
export const ARGUMENT_SNAPSHOT_SOURCE_SCRATCH = -2;

/** One operation in the cycle-safe parallel move performed at frame entry. */
export interface VmArgumentSnapshotMove {
	/** A negative value saves the source to scratch; `~destination` is restored later. */
	destination: number;
	/** Argument index, or one of the ARGUMENT_SNAPSHOT_SOURCE_* sentinels. */
	source: number;
}

/**
 * Keep inline with the C struct
 */
export interface VmFunction {
	nameStringIndex: number;
	isGenerator: boolean;
	isAsync: boolean;
	parameterCount: number;
	mappedArguments: boolean;
	mappedArgumentSlots: Array<number>;
	length: number;
	registerCount: number;
	capturedCount: number;
	strict: boolean;

	/**
	 * Whether the function may retain passed arguments after frame entry. Entry
	 * snapshots do not require the retained slice.
	 */
	needsArguments: boolean;

	/** Number of leading raw-argument snapshot instructions run at frame entry. */
	argumentSnapshotCount: number;

	/** Precomputed parallel-move schedule for the entry snapshot prefix. */
	argumentSnapshotPlan: Array<VmArgumentSnapshotMove>;

	/**
	 * A derived class constructor: `this` starts uninitialized (TDZ) and is bound
	 * only by super(), so the construct site allocates no eager `this` and reads
	 * of `this` before super() throw ReferenceError.
	 */
	isDerivedConstructor: boolean;

	/**
	 * A class constructor (base or derived): its `prototype` property is
	 * non-writable (MakeConstructor with writablePrototype = false), unlike a
	 * normal function's writable prototype.
	 */
	isClassConstructor: boolean;

	/**
	 * Whether this function owns a `prototype` property. False for methods,
	 * getters, setters and arrows (not constructors); true for normal functions,
	 * class constructors and generators. (Async non-generators are excluded at
	 * runtime by kind.)
	 */
	hasPrototype: boolean;

	instructions: Array<VmInstruction>;
	handlers: Array<VmExceptionHandler>;

	/**
	 * Debug-info: index into VmDefinition.files for this function's source file.
	 */
	fileIndex: number;

	/**
	 * Debug-info: parallel to `instructions` — positions[i] is the source-position
	 * id (index into VmDefinition.sourcePositions) of instruction i, or -1 when
	 * unknown (e.g. prologue code before the first statement marker). Built from
	 * the stripped `sourcePos` markers. The VM resolves a frame's position by its
	 * instruction pointer; the native backend emits coalesced `pos` writes from it.
	 */
	positions: Array<number>;
	/** Dense profile site for each instruction, or -1 when no source is known. */
	profileSiteIds?: Array<number>;
	/** Compile-only bridge from VM instructions to final shared compiler facts. */
	compilerSiteIds?: Array<string | undefined>;

	/**
	 * COMPILE-ONLY (not part of the C `MalFunction` struct): the registers the
	 * native backend must spill into this function's GC root frame — those live at
	 * or used by a GC safepoint (`computeSafepointRoots`), already
	 * in this function's post-allocation register numbering. emit-c roots exactly
	 * the boxed registers in this set; a register absent from it never holds a live
	 * value at a collection point. Undefined for generator/async functions (the
	 * native backend bails on those) — emit-c then falls back to rooting every
	 * boxed register.
	 */
	gcRootRegisters?: ReadonlyArray<number>;

	/**
	 * EMITTER-ONLY: allocation-free summaries of fully inlined String scan regions.
	 * These are never serialized; the ordinary VM instructions remain complete.
	 */
	nativeStringScanRegions?: ReadonlyArray<{
		entryIp: number;
		exitIp: number;
		input: number;
		lengthLoadIp: number;
		lengthResult: number;
		matchResult: number;
		matchCodeUnit: number;
	}>;

	/** EMITTER-ONLY: selected element/length projections of an exact String split. */
	nativeStringSplitProjections?: ReadonlyArray<{
		callIp: number;
		callee: number;
		receiver: number;
		separatorStringIndex: number;
		result: number;
		loads: ReadonlyArray<{
			ip: number;
			kind: "element" | "length";
			index?: number;
			dst: number;
		}>;
	}>;

	/** EMITTER-ONLY: one closed indexed split loop streamed as trimmed spans. */
	nativeStringSplitCursors?: ReadonlyArray<{
		callIp: number;
		callee: number;
		receiver: number;
		separator: number;
		result: number;
		index: number;
		lengthIp: number;
		elementIp: number;
		trimPropertyIp: number;
		trimIcIndex: number;
		trimCallIp: number;
		backedgeIp: number;
		exitIp: number;
	}>;

	/** EMITTER-ONLY: selected capture projections of an exact RegExp exec result. */
	nativeRegExpExecProjections?: ReadonlyArray<{
		callIp: number;
		callee: number;
		receiver: number;
		input: number;
		result: number;
		loads: ReadonlyArray<{
			ip: number;
			captureIndex: number;
			dst: number;
			consumer?:
				| { kind: "length"; propertyIp: number }
				| { kind: "charCodeAtZero"; propertyIp: number; callIp: number }
				| { kind: "number"; callIp: number }
				| {
						kind: "asciiCaseLength";
						upperPropertyIp: number;
						upperCallIp: number;
						lowerPropertyIp: number;
						lowerIcIndex: number;
						lowerCallIp: number;
						lengthPropertyIp: number;
				  };
		}>;
	}>;

	/** EMITTER-ONLY: closed exact RegExp iterator capture spans. */
	nativeRegExpIteratorProjections?: ReadonlyArray<{
		stepIp: number;
		iterator: number;
		next: number;
		value: number;
		done: number;
		loads: ReadonlyArray<{
			ip: number;
			captureIndex: number;
			dst: number;
			numberCallIp: number;
		}>;
	}>;

	/** EMITTER-ONLY: exact builtin String slice immediately consumed by Number. */
	nativeStringSliceNumberFusions?: ReadonlyArray<{
		sliceCallIp: number;
		numberCallIp: number;
		numberCallee: number;
		receiver: number;
		sliceStart: number;
		result: number;
	}>;

	/** EMITTER-ONLY: activation-local exact no-reviver JSON.parse templates. */
	nativeInvariantJsonParseCaches?: ReadonlyArray<{
		callIp: number;
		jsonObject: number;
		parseCallee: number;
		text: number;
		result: number;
	}>;

	/**
	 * EMITTER-ONLY: activation-local final primitive-record templates for one
	 * exact adjacent JSON.parse(text).map(pureProjection) chain. The complete
	 * proof is recomputed after wire loading; the ordinary parse/map instructions
	 * remain the fallback and interpreter semantics.
	 */
	nativeInvariantJsonMapTemplates?: ReadonlyArray<{
		parseCallIp: number;
		mapLoadIp: number;
		mapCallIp: number;
		jsonObject: number;
		parseCallee: number;
		text: number;
		parseResult: number;
		mapCallee: number;
		callback: number;
		mapResult: number;
		targetFunctionIndex: number;
		captures: ReadonlyArray<{ ownerFunctionIndex: number; index: number }>;
		rowPropertyLoads: number;
		primitiveRowStringIndices: ReadonlyArray<number>;
		nestedBaseStringIndex: number;
		nestedValueStringIndex: number;
		excludedStringIndices: ReadonlyArray<number>;
	}>;

	/**
	 * EMITTER-ONLY: activation-local result memo for an exact script call whose
	 * sole aggregate argument is a private, push-constructed dense Number Array.
	 * Recomputed from the lowered CFG after wire loading; never serialized.
	 */
	nativePrivateAggregateMemos?: ReadonlyArray<{
		allocationIp: number;
		constructionPushIps: ReadonlyArray<number>;
		callIp: number;
		targetFunctionIndex: number;
		callee: number;
		input: number;
		result: number;
	}>;

	/**
	 * SERIALIZED COMPILER METADATA: bounded numeric callback plans captured before
	 * HOF lowering erases callback identity. The interpreter ignores this table;
	 * native emission may consume only plans that pass wire validation.
	 */
	nativeNumericHofRegions?: ReadonlyArray<{
		method: "reduce";
		guardCallIp: number;
		initialValueIp: number;
		initialMoveIp: number;
		fastResultIp: number;
		fastExitIp: number;
		slowCallIp: number;
		callbackFunctionIndex: number;
		receiver: number;
		initial: number;
		result: number;
		pollPolicy: "end-only-no-preempt";
		operations: ReadonlyArray<IRNumericHofPlanOperation>;
		resultOperand: number;
	}>;

	/**
	 * COMPILE-ONLY: exact CREATE_OBJECT/CREATE_OBJECT_SHAPED sites proven safe for
	 * native stack emission. Omitted by the wire codec, so deserialized/interpreted
	 * functions retain ordinary heap allocation semantics.
	 */
	stackObjectSites?: ReadonlyArray<{ instructionIndex: number; slotCount: number }>;
	stackObjectAccesses?: ReadonlyArray<{
		instructionIndex: number;
		allocationInstructionIndex: number;
		slot: number;
	}>;
	stackObjectInheritedAccesses?: ReadonlyArray<{
		instructionIndex: number;
		allocationInstructionIndex: number;
	}>;

	/**
	 * COMPILE-ONLY: partial-escape materializations keyed to RETURN instruction
	 * indices. The allocation index resolves the stack storage to clone. Omitted by
	 * the wire codec so interpreter behavior and the serialized opcode set are
	 * unchanged.
	 */
	stackObjectMaterializations?: ReadonlyArray<{
		returnInstructionIndex: number;
		allocationInstructionIndex: number;
	}>;
}

/** -1 never retains; INT32_MAX always retains nonempty input; otherwise the
 * largest static index whose absence requires the supplied argument slice. */
export function computeArgumentRetentionLimit(
	fn: Pick<VmFunction, "argumentSnapshotCount" | "instructions">,
): number {
	const argumentInstructions = fn.instructions.slice(fn.argumentSnapshotCount);
	if (
		argumentInstructions.some(
			(instruction) =>
				instruction.opcode === "CREATE_ARGUMENTS_OBJECT" ||
				instruction.opcode === "CREATE_REST_ARGUMENTS" ||
				instruction.opcode === "LOAD_ARGUMENT",
		)
	) {
		return 0x7fffffff;
	}
	return argumentInstructions.reduce(
		(maximum, instruction) =>
			instruction.opcode === "LOAD_STATIC_ARGUMENT"
				? Math.max(maximum, instruction.index)
				: maximum,
		-1,
	);
}

/**
 * Schedule the snapshot prefix as a parallel move. Snapshot destinations are a
 * dense, distinct range after the pinned parameters, which lets frame setup
 * preserve them without a per-call initialized-register bitmap.
 */
export function buildArgumentSnapshotPlan(
	fn: Pick<
		VmFunction,
		"argumentSnapshotCount" | "instructions" | "parameterCount" | "registerCount"
	>,
): Array<VmArgumentSnapshotMove> {
	const snapshots: Array<{ destination: number; source: number | null }> = [];
	if (
		!Number.isInteger(fn.argumentSnapshotCount) ||
		fn.argumentSnapshotCount < 0 ||
		fn.argumentSnapshotCount > fn.instructions.length
	) {
		throw new RangeError("invalid argument snapshot count");
	}
	if (fn.parameterCount + fn.argumentSnapshotCount > fn.registerCount) {
		throw new RangeError("argument snapshot destinations exceed register count");
	}
	for (let i = 0; i < fn.argumentSnapshotCount; i++) {
		const instruction = fn.instructions[i];
		if (
			instruction?.opcode !== "LOAD_ARGUMENT_COUNT" &&
			instruction?.opcode !== "LOAD_ARGUMENT"
		) {
			throw new RangeError("argument snapshot prefix mismatch");
		}
		const destination = instruction.dst;
		if (destination !== fn.parameterCount + i) {
			throw new RangeError(
				"argument snapshot destinations must be dense after parameters",
			);
		}
		if (
			instruction.opcode === "LOAD_ARGUMENT" &&
			(!Number.isInteger(instruction.index) || instruction.index > 0x7fffffff)
		) {
			throw new RangeError("invalid argument snapshot source index");
		}
		if (instruction.opcode === "LOAD_ARGUMENT" && instruction.index < 0) {
			throw new RangeError("negative argument index");
		}
		snapshots.push({
			destination,
			source: instruction.opcode === "LOAD_ARGUMENT" ? instruction.index : null,
		});
	}
	const next = fn.instructions[fn.argumentSnapshotCount];
	if (next?.opcode === "LOAD_ARGUMENT_COUNT" || next?.opcode === "LOAD_ARGUMENT") {
		throw new RangeError("argument snapshot prefix mismatch");
	}

	const remaining = [...snapshots];
	const plan: Array<VmArgumentSnapshotMove> = [];
	const emitDirect = (move: (typeof remaining)[number]): void => {
		plan.push({
			destination: move.destination,
			source: move.source ?? ARGUMENT_SNAPSHOT_SOURCE_COUNT,
		});
	};
	const readyIndex = (): number => {
		const sources = new Set(
			remaining.flatMap((move) => (move.source === null ? [] : [move.source])),
		);
		return remaining.findIndex((move) => !sources.has(move.destination));
	};

	while (remaining.length > 0) {
		// A present self-move is already in place; when missing, runtime writes
		// undefined. It never destroys a source and cannot participate in a cycle.
		const selfIndex = remaining.findIndex(
			(move) => move.source !== null && move.source === move.destination,
		);
		if (selfIndex >= 0) {
			emitDirect(remaining.splice(selfIndex, 1)[0]!);
			continue;
		}

		const ready = readyIndex();
		if (ready >= 0) {
			emitDirect(remaining.splice(ready, 1)[0]!);
			continue;
		}

		// Every remaining destination is still a source, so break one cycle. The
		// destination becomes safe after following ready moves around that cycle.
		const cycle = remaining.find((move) => move.source !== null);
		if (!cycle || cycle.source === null) {
			throw new Error("unable to schedule argument snapshots");
		}
		plan.push({ destination: ~cycle.destination, source: cycle.source });
		remaining.splice(remaining.indexOf(cycle), 1);
		while (remaining.some((move) => move.source === cycle.destination)) {
			const nextReady = readyIndex();
			if (nextReady < 0) {
				throw new Error("unable to resolve argument snapshot cycle");
			}
			emitDirect(remaining.splice(nextReady, 1)[0]!);
		}
		plan.push({
			destination: cycle.destination,
			source: ARGUMENT_SNAPSHOT_SOURCE_SCRATCH,
		});
	}

	return plan;
}

/**
 * Keep inline with the C struct
 */
export type VmInstruction =
	| {
			opcode: "MOVE";
			dst: number;
			src: number;
	  }
	| {
			opcode: "RETURN";
			value: number;
	  }
	| {
			opcode: "JUMP_IF";
			cond: number;
			targetIp: number;
	  }
	| {
			opcode: "JUMP";
			targetIp: number;
	  }
	| {
			opcode: "CREATE_NUMBER";
			dst: number;
			value: number;
	  }
	| {
			opcode: "CREATE_F64";
			dst: number;
			value: number;
	  }
	| {
			opcode: "CREATE_BOOLEAN";
			dst: number;
			value: boolean;
	  }
	| {
			opcode: "CREATE_STRING";
			dst: number;
			stringIndex: number;
	  }
	| {
			opcode: "CREATE_BIGINT";
			dst: number;
			bigintIndex: number;
	  }
	| {
			opcode: "CREATE_OBJECT";
			dst: number;
			nativeFiniteConstruction?: {
				icIndex: number;
				numberGuards: Array<number>;
				keyStringIndices: Array<number>;
				virtualRecord?: true;
			};
	  }
	| {
			opcode: "CREATE_OBJECT_SHAPED";
			dst: number;
			count: number;
			keyStringIndices: Array<number>;
			valueRegisters: Array<number>;
			shapeCacheIndex: number;
	  }
	| {
			opcode: "CREATE_ARRAY";
			dst: number;
			length: number;
			/** COMPILE-ONLY: native bounded push-only virtual array state. */
			nativeCardinalityRegion?: { maximumLength: number; guard: VmGuardPlan };
			/** COMPILE-ONLY: exact capacity for a proven pristine indexed fill. */
			nativeFreshDenseReserveLength?: number;
			/** EMITTER-ONLY: private identity-range Array virtualization action. */
			nativeAffineRangeVirtualization?: {
				allocationIp: number;
				role: "allocation";
			};
	  }
	| {
			opcode: "INSTANTIATE_LITERAL_TEMPLATE";
			dst: number;
			templateOffset: number;
	  }
	| {
			opcode: "CREATE_MODULE_NAMESPACE";
			dst: number;
			nameIndices: Array<number>;
			slots: Array<number>;
	  }
	| {
			opcode: "CREATE_TEMPLATE_OBJECT";
			dst: number;
			cacheSlot: number;
			cookedIndices: Array<number>;
			rawIndices: Array<number>;
	  }
	| {
			opcode: "CREATE_UNDEFINED";
			dst: number;
	  }
	| {
			opcode: "CREATE_EMPTY";
			dst: number;
	  }
	| {
			opcode: "CREATE_NULL";
			dst: number;
	  }
	| {
			opcode: "CREATE_FUNCTION";
			dst: number;
			functionIndex: number;
	  }
	| {
			opcode: "CREATE_ARGUMENTS_OBJECT";
			dst: number;
	  }
	| {
			opcode: "LOAD_ARGUMENT_COUNT";
			dst: number;
	  }
	| {
			opcode: "LOAD_ARGUMENT";
			dst: number;
			index: number;
	  }
	| {
			opcode: "LOAD_STATIC_ARGUMENT";
			dst: number;
			direct: number;
			fallback: number;
			index: number;
	  }
	| {
			opcode: "LOAD_THIS";
			dst: number;
	  }
	| {
			opcode: "LOAD_NEW_TARGET";
			dst: number;
	  }
	| {
			opcode: "LOAD_CALLEE";
			dst: number;
	  }
	| {
			opcode: "CALL";
			dst: number;
			callee: number;
			thisValue: number;
			argumentCount: number;
			arguments: Array<number>;
			/** COMPILE-ONLY: guarded direct script-function target for native emission. */
			directFunctionIndex?: number;
			/** COMPILE-ONLY: guarded intrinsic Function.prototype.call flattening. */
			directFunctionCall?: true;
			/** COMPILE-ONLY: exact script receiver of directFunctionCall, when known. */
			directCallTargetFunctionIndex?: number;
			/** COMPILE-ONLY: canonical guarded intrinsic identity and fallback plan. */
			guardedBuiltinCall?: VmGuardedBuiltinCall;
			/** COMPILE-ONLY: append a proven stack record to virtual history. */
			nativeCardinalityPush?: {
				allocationInstructionIndex: number;
				pushedStackObjectAllocationInstructionIndex: number;
			};
			/** COMPILE-ONLY: statically proven Number-position strength. */
			directStringCharCodeAtPosition?: "integer" | "inBounds";
			/** COMPILE-ONLY: closed String.prototype.search over a fresh RegExp literal. */
			directStringSearchRegExp?: true;
			/** COMPILE-ONLY: consume an elided fixed RegExp literal search result. */
			directStringSearchLiteralConstructIp?: number;
	  }
	| {
			opcode: "CONSTRUCT";
			dst: number;
			callee: number;
			argumentCount: number;
			arguments: Array<number>;
			/** COMPILE-ONLY: guarded direct script-constructor target for native emission. */
			directFunctionIndex?: number;
			/** COMPILE-ONLY: fixed literal search attempted at this construction site. */
			directStringSearchLiteral?: {
				callIp: number;
				searchCallee: number;
				receiver: number;
				patternStringIndex: number;
			};
	  }
	| {
			opcode: "THROW";
			value: number;
	  }
	| {
			opcode: "CATCH";
			dst: number;
	  }
	| {
			/** Legacy wire opcode; new lowering stores only the handler table. */
			opcode: "TRY_BEGIN";
			handlerIp: number;
	  }
	| {
			/** Legacy wire opcode; new lowering stores only the handler table. */
			opcode: "TRY_END";
	  }
	| {
			opcode: "GENERATOR_START";
	  }
	| {
			opcode: "ASYNC_START";
	  }
	| {
			opcode: "YIELD";
			yieldedSrc: number;
			valueDst: number;
			modeDst: number;
	  }
	| {
			opcode: "TERMINAL_YIELD";
			yieldedSrc: number;
	  }
	| {
			opcode: "AWAIT";
			awaitedSrc: number;
			valueDst: number;
			modeDst: number;
	  }
	| {
			opcode: "LOAD_INTRINSIC";
			dst: number;
			intrinsic: IRIntrinsic;
	  }
	| {
			opcode: "LOAD_CAPTURED";
			dst: number;
			ownerFunctionIndex: number;
			index: number;
	  }
	| {
			opcode: "GUARD_FUNCTION_INDEX";
			dst: number;
			callee: number;
			functionIndex: number;
	  }
	| {
			opcode: "LOAD_GLOBAL";
			dst: number;
			index: number;
	  }
	| {
			opcode: "STORE_CAPTURED";
			src: number;
			ownerFunctionIndex: number;
			index: number;
	  }
	| {
			opcode: "ENV_PUSH" | "ENV_COPY";
			scopeId: number;
			slotCount: number;
	  }
	| {
			opcode: "ENV_POP";
	  }
	| {
			opcode: "STORE_GLOBAL";
			src: number;
			index: number;
	  }
	| {
			opcode: "LOAD_PROPERTY";
			dst: number;
			object: number;
			key: number;
			icIndex: number;
			nativeFiniteKey?: {
				minimum: number;
				ordinal: number;
				stringIndices: Array<number>;
			};
			nativeFiniteRecordAccess?: {
				allocationInstructionIndex: number;
			};
			nativeClosedGlobalTable?: {
				baseIndex: number;
				stateIndex: number;
				mask: number;
				direct: boolean;
			};
			nativeCardinalityAccess?: {
				role: "push" | "length" | "element" | "field";
				allocationInstructionIndex: number;
				fieldSlot?: number;
			};
			/** EMITTER-ONLY: load from a private `array[i] = i` virtual range. */
			nativeAffineRangeVirtualization?: {
				allocationIp: number;
				role: "load";
			};
	  }
	| {
			opcode: "LOAD_PROPERTY_STATIC";
			dst: number;
			object: number;
			stringIndex: number;
			icIndex: number;
			/** COMPILE-ONLY: guarded primitive-String `length` fast read. */
			nativePrimitiveStringLength?: true;
			nativeCardinalityAccess?: {
				role: "push" | "length" | "element" | "field";
				allocationInstructionIndex: number;
				fieldSlot?: number;
			};
	  }
	| {
			opcode: "LOAD_SUPER_PROPERTY";
			dst: number;
			object: number;
			key: number;
			receiver: number;
	  }
	| {
			opcode: "STORE_PROPERTY";
			object: number;
			key: number;
			value: number;
			icIndex: number;
			nativeFiniteKey?: {
				minimum: number;
				ordinal: number;
				stringIndices: Array<number>;
			};
			nativeClosedGlobalTable?: {
				baseIndex: number;
				stateIndex: number;
				mask: number;
				direct: boolean;
			};
			/** EMITTER-ONLY: producer store for a private identity virtual range. */
			nativeAffineRangeVirtualization?: {
				allocationIp: number;
				role: "store";
			};
	  }
	| {
			opcode: "STORE_PROPERTY_STATIC";
			object: number;
			value: number;
			stringIndex: number;
			icIndex: number;
	  }
	| {
			opcode: "TO_PROPERTY_KEY";
			dst: number;
			object: number;
			key: number;
	  }
	| {
			opcode: "STORE_SUPER_PROPERTY";
			object: number;
			key: number;
			value: number;
			receiver: number;
	  }
	| {
			opcode: "LOAD_PROTOTYPE";
			dst: number;
			object: number;
	  }
	| {
			opcode: "GET_ITERATOR";
			iteratorDst: number;
			nextDst: number;
			source: number;
	  }
	| {
			opcode: "GET_ASYNC_ITERATOR";
			iteratorDst: number;
			nextDst: number;
			source: number;
	  }
	| {
			opcode: "ITERATOR_NEXT";
			resultDst: number;
			iterator: number;
			next: number;
	  }
	| {
			opcode: "ITERATOR_STEP";
			valueDst: number;
			doneDst: number;
			iterator: number;
			next: number;
	  }
	| {
			opcode: "ITERATOR_CLOSE";
			iterator: number;
			normal: boolean;
	  }
	| {
			opcode: "FOR_IN_KEYS";
			dst: number;
			source: number;
	  }
	| {
			opcode: "CALL_SPREAD";
			dst: number;
			callee: number;
			thisValue: number;
			argumentsArray: number;
	  }
	| {
			opcode: "CALL_SPREAD_ITERABLE";
			dst: number;
			callee: number;
			thisValue: number;
			iterable: number;
	  }
	| {
			opcode: "CONSTRUCT_SPREAD";
			dst: number;
			callee: number;
			argumentsArray: number;
	  }
	| {
			opcode: "CONSTRUCT_SUPER";
			dst: number;
			parent: number;
			argumentsArray: number;
	  }
	| {
			opcode: "CONSTRUCT_SUPER_EXPLICIT";
			dst: number;
			parent: number;
			argumentsArray: number;
			newTarget: number;
	  }
	| {
			opcode: "SET_THIS";
			value: number;
	  }
	| {
			opcode: "MERGE_DATA_PROPERTIES";
			target: number;
			src: number;
	  }
	| {
			opcode: "DELETE_PROPERTY";
			dst: number;
			object: number;
			key: number;
	  }
	| {
			opcode: "DEFINE_ACCESSOR";
			object: number;
			key: number;
			accessor: number;
			isSetter: boolean;
			enumerable: boolean;
	  }
	| {
			opcode: "DEFINE_PROPERTY";
			object: number;
			key: number;
			value: number;
			enumerable: boolean;
			writable: boolean;
			configurable: boolean;
	  }
	| {
			opcode: "SET_FUNCTION_NAME";
			func: number;
			key: number;
			// 0 = no prefix, 1 = "get ", 2 = "set ".
			prefix: number;
	  }
	| {
			opcode: "CREATE_PRIVATE_NAME";
			dst: number;
	  }
	| {
			opcode: "CREATE_PRIVATE_NAMES";
			ownerFunctionIndex: number;
			capturedIndices: Array<number>;
	  }
	| {
			opcode: "DEFINE_PRIVATE";
			object: number;
			key: number;
			value: number;
	  }
	| {
			opcode: "INIT_PRIVATE_FIELDS";
			object: number;
			keyRegisters: Array<number>;
	  }
	| {
			opcode: "LOAD_PRIVATE";
			dst: number;
			object: number;
			key: number;
	  }
	| {
			opcode: "STORE_PRIVATE";
			object: number;
			key: number;
			value: number;
	  }
	| {
			opcode: "HAS_PRIVATE";
			dst: number;
			object: number;
			key: number;
	  }
	| {
			opcode: "SET_PROTOTYPE";
			object: number;
			prototype: number;
			literal: boolean;
	  }
	| {
			opcode: "LOAD_UNDECLARED";
			dst: number;
			nameStringIndex: number;
	  }
	| {
			opcode: "LOAD_GLOBAL_PROPERTY";
			dst: number;
			nameStringIndex: number;
	  }
	| {
			opcode: "STORE_GLOBAL_PROPERTY";
			src: number;
			nameStringIndex: number;
			declaration: boolean;
			declarationConfigurable: boolean;
	  }
	| {
			opcode: "INIT_GLOBAL_VARS";
			nameStringIndices: Array<number>;
			declarationConfigurable: boolean;
	  }
	| {
			opcode: "THROW_IF_TDZ";
			src: number;
			nameStringIndex: number;
	  }
	| {
			opcode: "WITH_ENTER";
			object: number;
	  }
	| {
			opcode: "WITH_EXIT";
	  }
	| {
			opcode: "WITH_GET";
			dst: number;
			nameStringIndex: number;
	  }
	| {
			opcode: "WITH_RESOLVE_BASE";
			dst: number;
			nameStringIndex: number;
	  }
	| {
			opcode: "WITH_SET";
			found: number;
			value: number;
			nameStringIndex: number;
	  }
	| {
			opcode: "IS_EMPTY";
			dst: number;
			src: number;
	  }
	| {
			opcode: "REQUIRE_COERCIBLE";
			src: number;
	  }
	| {
			opcode: "CHECK_SUPER_CLASS";
			parent: number;
	  }
	| {
			opcode: "CREATE_REST_ARGUMENTS";
			dst: number;
			startIndex: number;
	  }
	| {
			opcode: "ARRAY_REST";
			dst: number;
			src: number;
			startIndex: number;
	  }
	| {
			opcode: "COPY_DATA_PROPERTIES";
			dst: number;
			src: number;
			excludedCount: number;
			excluded: Array<number>;
	  }
	| {
			opcode: "BINARY";
			dst: number;
			left: number;
			right: number;
			operator: IRBinaryOperator;
			nativeNumericFusion?:
				| { role: "start"; id: number }
				| {
						role: "finish";
						id: number;
						first: {
							dst: number;
							left: number;
							right: number;
							operator: IRBinaryOperator;
						};
				  };
			nativeFiniteString?: {
				minimum: number;
				stringIndices: Array<number>;
			};
	  }
	| {
			opcode: "UNARY";
			dst: number;
			src: number;
			operator: IRUnaryOperator;
	  }
	| {
			opcode: "TYPEOF_COMPARE";
			dst: number;
			src: number;
			expected: IRTypeofResult;
			negated: boolean;
	  };

export function countPropertyIcSites(instructions: ReadonlyArray<VmInstruction>): number {
	let count = 0;
	for (const instruction of instructions) {
		switch (instruction.opcode) {
			case "LOAD_PROPERTY":
			case "LOAD_PROPERTY_STATIC":
			case "STORE_PROPERTY":
			case "STORE_PROPERTY_STATIC":
				count++;
				break;
		}
	}
	return count;
}

export function countLiteralShapeSites(
	instructions: ReadonlyArray<VmInstruction>,
): number {
	return instructions.filter(
		(instruction) => instruction.opcode === "CREATE_OBJECT_SHAPED",
	).length;
}

export interface VmDefinitionStats {
	functionCount: number;
	instructionCount: number;
}

/**
 * Run-length compress a function's per-instruction position ids into
 * (start_ip, pos_id) entries: a new entry only where the position changes. The
 * runtime resolves a frame's position by finding the last entry with
 * start_ip <= instruction_pointer. Shared by the C-literal emitter (emit-vm)
 * and the wire serializer (serialize-vm); it lives here, alongside the VM
 * definition types, so the self-hostable serializer cone never imports emit-vm
 * (which pulls node:path + the emit-c native backend).
 */
export function compressPositions(
	positions: Array<number>,
): Array<{ startIp: number; posId: number }> {
	const runs: Array<{ startIp: number; posId: number }> = [];
	for (let ip = 0; ip < positions.length; ++ip) {
		const posId = positions[ip]!;
		if (runs.length === 0 || runs[runs.length - 1]!.posId !== posId) {
			runs.push({ startIp: ip, posId });
		}
	}
	return runs;
}

/**
 * Aggregate code-size metrics for a compiled definition: how many functions
 * were emitted and the total instruction count across all of them.
 */
export function vmDefinitionStats(definition: VmDefinition): VmDefinitionStats {
	let instructionCount = 0;
	for (const fn of definition.functions) {
		instructionCount += fn.instructions.length;
	}

	return { functionCount: definition.functions.length, instructionCount };
}

/**
 * Lower optimized IR to a VM definition that can then be emitted as C.
 */
export function lowerIrProgramToVmDefinition(
	program: IntermediateProgram,
	profile = false,
): VmDefinition {
	// Build the debug-info file table: distinct source paths in first-seen order.
	const files: Array<string> = [];
	const fileToIndex = new Map<string, number>();
	const fileIndexFor = (path: string): number => {
		const existing = fileToIndex.get(path);
		if (existing !== undefined) {
			return existing;
		}
		const index = files.push(path) - 1;
		fileToIndex.set(path, index);
		return index;
	};
	const functions = program.functions.map((fn) =>
		lowerFunctionToVmFunction(
			fn,
			fileIndexFor(fn.semanticFile.path),
			profile ? program.facts.instructionSites : undefined,
		),
	);

	const definition: VmDefinition = {
		entrypointPath: program.semantic.entrypointPath,
		functionCount: program.functions.length,
		functions,
		stringConstants: program.stringConstants,
		bigintConstants: program.bigintConstants,
		literalTemplateData: program.literalTemplateData,
		globalCount: program.nextGlobalIndex,
		cjsModuleFunctionIndices: program.cjsWrapperFunctionIndex,
		hostInstalls: buildHostInstalls(program, functions),
		files,
		sourcePositions: program.sourcePositions,
		...(profile ? { optimizationTrace: program.optimizationTrace } : {}),
	};
	if (profile) buildProfileMetadata(program, definition);
	return definition;
}

/**
 * Resolve the linker's host built-in bindings to global slots read by the final
 * VM instruction stream. Slot assignment can outlive an optimized-away read, so
 * the emitted functions, rather than bindingToStorage alone, determine export
 * retention. Process remains statically retained from global-property analysis.
 */
function buildHostInstalls(
	program: IntermediateProgram,
	functions: Array<VmFunction>,
): VmDefinition["hostInstalls"] {
	const readGlobalSlots = new Set<number>();
	for (const fn of functions) {
		for (const instruction of fn.instructions) {
			if (instruction.opcode === "LOAD_GLOBAL") {
				readGlobalSlots.add(instruction.index);
			} else if (instruction.opcode === "CREATE_MODULE_NAMESPACE") {
				for (const slot of instruction.slots) {
					readGlobalSlots.add(slot);
				}
			} else if (instruction.opcode === "CREATE_TEMPLATE_OBJECT") {
				readGlobalSlots.add(instruction.cacheSlot);
			}
		}
	}

	const globalSlotOf = (binding: Binding): number | null => {
		const location = program.bindingToStorage.get(binding);
		return location?.type === "global" && readGlobalSlots.has(location.index)
			? location.index
			: null;
	};

	const manifest: VmDefinition["hostInstalls"] = [];
	const installFor = (installer: string) => {
		let install = manifest.find((entry) => entry.installer === installer);
		if (!install) {
			install = { installer, exports: [] };
			manifest.push(install);
		}
		return install;
	};
	for (const hostModule of program.hostModules) {
		const usedExports: Array<{ name: string; slot: number }> = [];
		for (const { name, binding } of hostModule.exports) {
			const slot = globalSlotOf(binding);
			if (slot !== null) {
				usedExports.push({ name, slot });
			}
		}
		if (usedExports.length > 0) {
			installFor(hostModule.installer).exports.push(...usedExports);
		}
	}

	if (program.hostProcess?.retained) {
		installFor(program.hostProcess.installer);
	}
	if (program.hostBuffer?.retained) {
		installFor(program.hostBuffer.installer);
	}

	return manifest;
}

/**
 * Lower a function to a VM function. Note that we drop blocks and instead move to jumps to
 * absolute instructions.
 */
function lowerFunctionToVmFunction(
	fn: IRFunction,
	fileIndex: number,
	instructionSites?: WeakMap<object, { id: string }>,
): VmFunction {
	// Source-position and exception-range markers carry no executable opcode, so
	// block start IPs count only instructions that survive flattening.
	const blockStartIps = new Map<number, number>();
	let nextInstructionPointer = 0;

	for (let i = 0; i < fn.blocks.length; ++i) {
		blockStartIps.set(i, nextInstructionPointer);
		for (const instruction of fn.blocks[i]!.instructions) {
			if (
				instruction.type !== "sourcePos" &&
				instruction.type !== "tryBegin" &&
				instruction.type !== "tryEnd"
			) {
				nextInstructionPointer += 1;
			}
		}
	}

	const instructions: Array<VmInstruction> = [];
	const compilerSiteIds: Array<string | undefined> = [];
	let propertyIcCount = 0;
	const propertyIcIndexByInstruction = new Map<IRInstruction, number>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.type === "loadProperty" ||
				instruction.type === "loadPropertyStatic" ||
				instruction.type === "storeProperty" ||
				instruction.type === "storePropertyStatic"
			) {
				propertyIcIndexByInstruction.set(instruction, propertyIcCount++);
			}
		}
	}
	let literalShapeCount = 0;
	const handlers: Array<VmExceptionHandler> = [];
	const openExceptionRanges: Array<{ startIp: number; handlerIp: number }> = [];
	const positions: Array<number> = [];
	const stackObjectSites: Array<{ instructionIndex: number; slotCount: number }> = [];
	const stackObjectSiteInstructionById = new Map<number, number>();
	const pendingStackObjectMaterializations: Array<{
		returnInstructionIndex: number;
		siteId: number;
	}> = [];
	const pendingStackObjectAccesses: Array<{
		instructionIndex: number;
		siteId: number;
		slot: number;
	}> = [];
	const pendingStackObjectInheritedAccesses: Array<{
		instructionIndex: number;
		siteId: number;
	}> = [];
	const instructionIndexByIrInstruction = new Map<IRInstruction, number>();
	const pendingCardinalityAccesses: Array<{
		instruction: Extract<
			VmInstruction,
			{ opcode: "LOAD_PROPERTY" | "LOAD_PROPERTY_STATIC" }
		>;
		allocation: Extract<IRInstruction, { type: "createArray" }>;
		role: "push" | "length" | "element" | "field";
		fieldSlot?: number;
	}> = [];
	const pendingFiniteRecordAccesses: Array<{
		instruction: Extract<VmInstruction, { opcode: "LOAD_PROPERTY" }>;
		allocation: Extract<IRInstruction, { type: "createObject" }>;
	}> = [];
	const pendingCardinalityPushes: Array<{
		instruction: Extract<VmInstruction, { opcode: "CALL" }>;
		allocation: Extract<IRInstruction, { type: "createArray" }>;
		stackObjectSiteId: number;
	}> = [];
	const pendingNumericHofRegions: Array<{
		guard: Extract<IRInstruction, { type: "call" }>;
		region: NonNullable<Extract<IRInstruction, { type: "call" }>["numericHofRegion"]>;
	}> = [];
	let currentPos = -1;
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (instruction.type === "sourcePos") {
				currentPos = instruction.pos;
				continue;
			}
			if (instruction.type === "tryBegin") {
				const handlerIp = blockStartIps.get(instruction.blocks[0]);
				if (handlerIp === undefined) {
					throw new Error(`Unknown handler target block ${instruction.blocks[0]}`);
				}
				openExceptionRanges.push({ startIp: instructions.length, handlerIp });
				continue;
			}
			if (instruction.type === "tryEnd") {
				const range = openExceptionRanges.pop();
				if (range === undefined) {
					throw new Error(`Unbalanced try marker at instruction ${instructions.length}`);
				}
				handlers.push({ ...range, endIp: instructions.length });
				continue;
			}
			const instructionIndex = instructions.length;
			instructionIndexByIrInstruction.set(instruction, instructionIndex);
			const vmInstruction = lowerInstructionToVmInstruction(blockStartIps, instruction);
			switch (vmInstruction.opcode) {
				case "LOAD_PROPERTY":
				case "LOAD_PROPERTY_STATIC":
				case "STORE_PROPERTY":
				case "STORE_PROPERTY_STATIC":
					vmInstruction.icIndex = propertyIcIndexByInstruction.get(instruction)!;
					break;
				case "CREATE_OBJECT":
					if (
						vmInstruction.nativeFiniteConstruction !== undefined &&
						instruction.type === "createObject" &&
						instruction.nativeFiniteConstruction !== undefined
					) {
						vmInstruction.nativeFiniteConstruction.icIndex =
							propertyIcIndexByInstruction.get(
								instruction.nativeFiniteConstruction.source,
							) ?? -1;
					}
					break;
				case "CREATE_OBJECT_SHAPED":
					vmInstruction.shapeCacheIndex = literalShapeCount++;
					break;
			}
			instructions.push(vmInstruction);
			compilerSiteIds.push(instructionSites?.get(instruction)?.id);
			if (
				(instruction.type === "loadProperty" ||
					instruction.type === "loadPropertyStatic") &&
				instruction.nativeCardinalityAccess !== undefined &&
				(vmInstruction.opcode === "LOAD_PROPERTY" ||
					vmInstruction.opcode === "LOAD_PROPERTY_STATIC")
			) {
				pendingCardinalityAccesses.push({
					instruction: vmInstruction,
					allocation: instruction.nativeCardinalityAccess.allocation,
					role: instruction.nativeCardinalityAccess.role,
					fieldSlot: instruction.nativeCardinalityAccess.fieldSlot,
				});
			}
			if (
				instruction.type === "loadProperty" &&
				instruction.nativeFiniteRecordAccess !== undefined &&
				vmInstruction.opcode === "LOAD_PROPERTY"
			) {
				pendingFiniteRecordAccesses.push({
					instruction: vmInstruction,
					allocation: instruction.nativeFiniteRecordAccess.allocation,
				});
			}
			if (
				instruction.type === "call" &&
				instruction.nativeCardinalityPush !== undefined &&
				vmInstruction.opcode === "CALL"
			) {
				if (instruction.cardinalityPushStackObjectSiteId === undefined) {
					throw new Error("Cardinality push lacks a proven stack-object argument");
				}
				pendingCardinalityPushes.push({
					instruction: vmInstruction,
					allocation: instruction.nativeCardinalityPush.allocation,
					stackObjectSiteId: instruction.cardinalityPushStackObjectSiteId,
				});
			}
			if (instruction.type === "call" && instruction.numericHofRegion !== undefined) {
				pendingNumericHofRegions.push({
					guard: instruction,
					region: instruction.numericHofRegion,
				});
			}
			if (
				(instruction.type === "createObject" ||
					instruction.type === "createObjectShaped") &&
				instruction.stackObject
			) {
				stackObjectSites.push({
					instructionIndex,
					slotCount:
						instruction.type === "createObjectShaped"
							? instruction.keyStringIndices.length
							: 0,
				});
				if (instruction.stackObjectSiteId !== undefined) {
					if (stackObjectSiteInstructionById.has(instruction.stackObjectSiteId)) {
						throw new Error(
							`Duplicate stack-object site id ${instruction.stackObjectSiteId}`,
						);
					}
					stackObjectSiteInstructionById.set(
						instruction.stackObjectSiteId,
						instructionIndex,
					);
				}
			}
			if (
				instruction.type === "return" &&
				instruction.stackObjectMaterializeSiteId !== undefined
			) {
				pendingStackObjectMaterializations.push({
					returnInstructionIndex: instructionIndex,
					siteId: instruction.stackObjectMaterializeSiteId,
				});
			}
			if (
				(instruction.type === "loadProperty" ||
					instruction.type === "loadPropertyStatic" ||
					instruction.type === "storeProperty" ||
					instruction.type === "storePropertyStatic") &&
				instruction.stackObjectSiteId !== undefined &&
				instruction.stackObjectSlot !== undefined
			) {
				pendingStackObjectAccesses.push({
					instructionIndex,
					siteId: instruction.stackObjectSiteId,
					slot: instruction.stackObjectSlot,
				});
			}
			if (
				(instruction.type === "loadProperty" ||
					instruction.type === "loadPropertyStatic") &&
				instruction.stackObjectInheritedSiteId !== undefined
			) {
				pendingStackObjectInheritedAccesses.push({
					instructionIndex,
					siteId: instruction.stackObjectInheritedSiteId,
				});
			}
			positions.push(currentPos);
		}
	}
	if (openExceptionRanges.length > 0) {
		throw new Error("Unbalanced try marker at end of function");
	}
	const stackObjectMaterializations = pendingStackObjectMaterializations.map(
		({ returnInstructionIndex, siteId }) => {
			const allocationInstructionIndex = stackObjectSiteInstructionById.get(siteId);
			if (allocationInstructionIndex === undefined) {
				throw new Error(`Unknown stack-object materialization site id ${siteId}`);
			}
			return { returnInstructionIndex, allocationInstructionIndex };
		},
	);
	const stackObjectAccesses = pendingStackObjectAccesses.map(
		({ instructionIndex, siteId, slot }) => {
			const allocationInstructionIndex = stackObjectSiteInstructionById.get(siteId);
			if (allocationInstructionIndex === undefined) {
				throw new Error(`Unknown stack-object access site id ${siteId}`);
			}
			return { instructionIndex, allocationInstructionIndex, slot };
		},
	);
	const stackObjectInheritedAccesses = pendingStackObjectInheritedAccesses.map(
		({ instructionIndex, siteId }) => {
			const allocationInstructionIndex = stackObjectSiteInstructionById.get(siteId);
			if (allocationInstructionIndex === undefined) {
				throw new Error(`Unknown inherited stack-object site id ${siteId}`);
			}
			return { instructionIndex, allocationInstructionIndex };
		},
	);
	for (const pending of pendingCardinalityAccesses) {
		const allocationInstructionIndex = instructionIndexByIrInstruction.get(
			pending.allocation,
		);
		if (allocationInstructionIndex === undefined) {
			throw new Error("Unknown cardinality-region array allocation");
		}
		pending.instruction.nativeCardinalityAccess = {
			role: pending.role,
			allocationInstructionIndex,
			fieldSlot: pending.fieldSlot,
		};
	}
	for (const pending of pendingFiniteRecordAccesses) {
		const allocationInstructionIndex = instructionIndexByIrInstruction.get(
			pending.allocation,
		);
		if (allocationInstructionIndex === undefined) {
			throw new Error("Unknown virtual finite-record allocation");
		}
		pending.instruction.nativeFiniteRecordAccess = { allocationInstructionIndex };
	}
	for (const pending of pendingCardinalityPushes) {
		const allocationInstructionIndex = instructionIndexByIrInstruction.get(
			pending.allocation,
		);
		const pushedStackObjectAllocationInstructionIndex =
			stackObjectSiteInstructionById.get(pending.stackObjectSiteId);
		if (
			allocationInstructionIndex === undefined ||
			pushedStackObjectAllocationInstructionIndex === undefined
		) {
			throw new Error("Unknown cardinality-region allocation dependency");
		}
		pending.instruction.nativeCardinalityPush = {
			allocationInstructionIndex,
			pushedStackObjectAllocationInstructionIndex,
		};
	}
	const nativeNumericHofRegions: Array<
		NonNullable<VmFunction["nativeNumericHofRegions"]>[number]
	> = [];
	for (const pending of pendingNumericHofRegions) {
		const guardCallIp = instructionIndexByIrInstruction.get(pending.guard);
		const initialValueIp = instructionIndexByIrInstruction.get(
			pending.region.initialValue,
		);
		const initialMoveIp = instructionIndexByIrInstruction.get(pending.region.initialMove);
		const fastResultIp = instructionIndexByIrInstruction.get(pending.region.fastResult);
		const fastExitIp = instructionIndexByIrInstruction.get(pending.region.fastExit);
		const slowCallIp = instructionIndexByIrInstruction.get(pending.region.slowCall);
		if (
			guardCallIp === undefined ||
			initialValueIp === undefined ||
			initialMoveIp === undefined ||
			fastResultIp === undefined ||
			fastExitIp === undefined ||
			slowCallIp === undefined
		) {
			continue; // an optimizer removed an anchor; fail closed without reconstruction
		}
		const guard = instructions[guardCallIp];
		const initialValue = instructions[initialValueIp];
		const initialMove = instructions[initialMoveIp];
		const fastResult = instructions[fastResultIp];
		const fastExit = instructions[fastExitIp];
		const slowCall = instructions[slowCallIp];
		const receiverOperand =
			guard?.opcode === "CALL" ? decodeVmValueOperand(guard.arguments[0]!) : undefined;
		const slowReceiverOperand =
			slowCall?.opcode === "CALL" ? decodeVmValueOperand(slowCall.thisValue) : undefined;
		if (
			guard?.opcode !== "CALL" ||
			(initialValue?.opcode !== "CREATE_NUMBER" &&
				initialValue?.opcode !== "CREATE_F64") ||
			initialMove?.opcode !== "MOVE" ||
			fastResult?.opcode !== "MOVE" ||
			fastExit?.opcode !== "JUMP" ||
			slowCall?.opcode !== "CALL" ||
			receiverOperand?.kind !== "register" ||
			slowReceiverOperand?.kind !== "register" ||
			slowReceiverOperand.register !== receiverOperand.register
		) {
			continue;
		}
		nativeNumericHofRegions.push({
			method: pending.region.method,
			guardCallIp,
			initialValueIp,
			initialMoveIp,
			fastResultIp,
			fastExitIp,
			slowCallIp,
			callbackFunctionIndex: pending.region.callbackFunctionIndex,
			receiver: receiverOperand.register,
			initial: initialMove.src,
			result: fastResult.dst,
			pollPolicy: "end-only-no-preempt",
			operations: pending.region.operations,
			resultOperand: pending.region.resultOperand,
		});
	}

	// Classified length/legacy index reads form an entry prefix. Frame creation
	// snapshots that prefix before parameter initialization and starts interpretation
	// after it. Fused static reads retain arguments for their lazy missing-index path.
	let argumentSnapshotCount = 0;
	while (
		instructions[argumentSnapshotCount]?.opcode === "LOAD_ARGUMENT_COUNT" ||
		instructions[argumentSnapshotCount]?.opcode === "LOAD_ARGUMENT"
	) {
		argumentSnapshotCount++;
	}
	const needsArguments =
		computeArgumentRetentionLimit({
			argumentSnapshotCount,
			instructions,
		}) >= 0;
	const argumentSnapshotPlan = buildArgumentSnapshotPlan({
		argumentSnapshotCount,
		instructions,
		parameterCount: fn.parameterCount,
		registerCount: fn.nextRegisterDestination,
	});

	// GC root-frame minimization (C1): the native backend spills only registers
	// live at a safepoint, not every boxed register. The aggregate-only API avoids
	// constructing diagnostic per-safepoint Sets. This runs post-allocation, so a
	// complexity fallback safely returns every physical register. Skipped for
	// generator/async functions, which the native backend does not compile.
	const isResumable = (fn.isGenerator ?? false) || (fn.isAsync ?? false);
	const gcRootRegisters = isResumable
		? undefined
		: [...computeSafepointRoots(fn).registers];

	return {
		nameStringIndex: fn.nameStringIndex,
		isGenerator: fn.isGenerator ?? false,
		isAsync: fn.isAsync ?? false,
		parameterCount: fn.parameterCount,
		mappedArguments: fn.mappedArguments ?? false,
		mappedArgumentSlots: fn.mappedArgumentSlots ?? [],
		length: fn.length,
		registerCount: fn.nextRegisterDestination,
		capturedCount: fn.nextCapturedIndex,
		strict: fn.strict ?? fn.semanticFile.strict,
		needsArguments,
		argumentSnapshotCount,
		argumentSnapshotPlan,
		isDerivedConstructor:
			(fn.classContext?.isConstructor ?? false) &&
			(fn.classContext?.isDerivedConstructor ?? false),
		isClassConstructor: fn.classContext?.isConstructor ?? false,
		hasPrototype: fn.hasPrototype ?? true,
		instructions,
		handlers,
		fileIndex,
		positions,
		compilerSiteIds: compilerSiteIds.some((site) => site !== undefined)
			? compilerSiteIds
			: undefined,
		gcRootRegisters,
		stackObjectSites: stackObjectSites.length > 0 ? stackObjectSites : undefined,
		stackObjectAccesses: stackObjectAccesses.length > 0 ? stackObjectAccesses : undefined,
		stackObjectInheritedAccesses:
			stackObjectInheritedAccesses.length > 0 ? stackObjectInheritedAccesses : undefined,
		stackObjectMaterializations:
			stackObjectMaterializations.length > 0 ? stackObjectMaterializations : undefined,
		nativeNumericHofRegions:
			nativeNumericHofRegions.length > 0 ? nativeNumericHofRegions : undefined,
	};
}

/**
 * Map the IR to the VM instruction set.
 */
function lowerGuardPlan(plan: CompilerGuardPlan): VmGuardPlan | undefined {
	const dependencies: Array<VmSemanticDependency> = [];
	for (const dependency of plan.dependencies) {
		if (dependency.kind === "world" && dependency.fact === "primordials.locked") {
			dependencies.push({ kind: "world", fact: "primordials.locked" });
			continue;
		}
		if (dependency.kind === "epoch") {
			dependencies.push({ kind: "epoch", family: dependency.family });
			continue;
		}
		return undefined;
	}
	const obligations = [
		...new Set(
			plan.obligations.map(
				(obligation): VmGuardObligation =>
					obligation.kind === "fallback" ? "generic-call" : "materialize",
			),
		),
	];
	if (dependencies.length === 0 || obligations.length === 0) return undefined;
	return { dependencies, obligations };
}

function lowerGuardedBuiltinCall(
	instruction: Extract<IRInstruction, { type: "call" }>,
): VmGuardedBuiltinCall | undefined {
	const call = instruction.knownBuiltinCall;
	if (
		call === undefined ||
		call.identity.kind !== "known" ||
		call.identity.value !== call.operation ||
		(call.operation !== "Array.prototype.push" &&
			call.operation !== "String.prototype.charCodeAt" &&
			call.operation !== "Map.prototype.get" &&
			call.operation !== "Map.prototype.set" &&
			call.operation !== "Set.prototype.add")
	) {
		return undefined;
	}
	const guard = lowerGuardPlan(call.identity.proof);
	if (guard === undefined || !guard.obligations.includes("generic-call")) {
		return undefined;
	}
	return {
		operation: call.operation,
		guard,
	};
}

function lowerInstructionToVmInstruction(
	blockStartIps: Map<number, number>,
	instruction: IRInstruction,
): VmInstruction {
	switch (instruction.type) {
		case "sourcePos":
			// Markers are consumed into `positions` and stripped before this point.
			throw new Error("sourcePos marker must be stripped before lowering");
		case "move":
			return {
				opcode: "MOVE",
				dst: instruction.registers[0],
				src: instruction.registers[1],
			};
		case "return":
			return {
				opcode: "RETURN",
				value: instruction.registers[0],
			};
		case "jumpIf": {
			const targetIp = blockStartIps.get(instruction.blocks[0]);
			if (targetIp === undefined) {
				throw new Error(`Unknown jump target block ${instruction.blocks[0]}`);
			}

			return {
				opcode: "JUMP_IF",
				cond: instruction.registers[0],
				targetIp,
			};
		}
		case "jump": {
			const targetIp = blockStartIps.get(instruction.blocks[0]);
			if (targetIp === undefined) {
				throw new Error(`Unknown jump target block ${instruction.blocks[0]}`);
			}

			return {
				opcode: "JUMP",
				targetIp,
			};
		}
		case "createNumber":
			return {
				opcode: "CREATE_NUMBER",
				dst: instruction.registers[0],
				value: instruction.value,
			};
		case "createF64":
			return {
				opcode: "CREATE_F64",
				dst: instruction.registers[0],
				value: instruction.value,
			};
		case "createBoolean":
			return {
				opcode: "CREATE_BOOLEAN",
				dst: instruction.registers[0],
				value: instruction.value,
			};
		case "createString":
			return {
				opcode: "CREATE_STRING",
				dst: instruction.registers[0],
				stringIndex: instruction.stringIndex,
			};
		case "createBigint":
			return {
				opcode: "CREATE_BIGINT",
				dst: instruction.registers[0],
				bigintIndex: instruction.bigintIndex,
			};
		case "createObject":
			return {
				opcode: "CREATE_OBJECT",
				dst: instruction.registers[0],
				...(instruction.nativeFiniteConstruction === undefined
					? {}
					: {
							nativeFiniteConstruction: {
								icIndex: -1,
								numberGuards: instruction.registers.slice(1),
								keyStringIndices: [
									...instruction.nativeFiniteConstruction.keyStringIndices,
								],
								...(instruction.nativeFiniteConstruction.virtualRecord === true
									? { virtualRecord: true as const }
									: {}),
							},
						}),
			};
		case "createObjectShaped":
			return {
				opcode: "CREATE_OBJECT_SHAPED",
				dst: instruction.registers[0],
				count: instruction.registers.length - 1,
				keyStringIndices: instruction.keyStringIndices,
				valueRegisters: instruction.registers.slice(1),
				shapeCacheIndex: -1,
			};
		case "createArray": {
			let nativeCardinalityRegion:
				| { maximumLength: number; guard: VmGuardPlan }
				| undefined;
			if (instruction.nativeCardinalityRegion !== undefined) {
				const guard = lowerGuardPlan(instruction.nativeCardinalityRegion.guard);
				if (guard === undefined || !guard.obligations.includes("materialize")) {
					throw new Error("Cardinality region lacks a materialization guard plan");
				}
				nativeCardinalityRegion = {
					maximumLength: instruction.nativeCardinalityRegion.maximumLength,
					guard,
				};
			}
			return {
				opcode: "CREATE_ARRAY",
				dst: instruction.registers[0],
				length: instruction.length,
				nativeFreshDenseReserveLength: instruction.nativeFreshDenseReserveLength,
				nativeCardinalityRegion,
			};
		}
		case "instantiateLiteralTemplate":
			return {
				opcode: "INSTANTIATE_LITERAL_TEMPLATE",
				dst: instruction.registers[0],
				templateOffset: instruction.templateOffset,
			};
		case "createModuleNamespace":
			return {
				opcode: "CREATE_MODULE_NAMESPACE",
				dst: instruction.registers[0],
				nameIndices: instruction.exports.map((entry) => entry.nameStringIndex),
				slots: instruction.exports.map((entry) => entry.slot),
			};
		case "createTemplateObject":
			return {
				opcode: "CREATE_TEMPLATE_OBJECT",
				dst: instruction.registers[0],
				cacheSlot: instruction.cacheSlot,
				cookedIndices: instruction.cookedIndices,
				rawIndices: instruction.rawIndices,
			};
		case "createUndefined":
			return {
				opcode: "CREATE_UNDEFINED",
				dst: instruction.registers[0],
			};
		case "createEmpty":
			return {
				opcode: "CREATE_EMPTY",
				dst: instruction.registers[0],
			};
		case "createNull":
			return {
				opcode: "CREATE_NULL",
				dst: instruction.registers[0],
			};
		case "createFunction":
			return {
				opcode: "CREATE_FUNCTION",
				dst: instruction.registers[0],
				functionIndex: instruction.functionIndex,
			};
		case "createArgumentsObject":
			return {
				opcode: "CREATE_ARGUMENTS_OBJECT",
				dst: instruction.registers[0],
			};
		case "loadArgumentCount":
			return {
				opcode: "LOAD_ARGUMENT_COUNT",
				dst: instruction.registers[0],
			};
		case "loadArgument":
			return {
				opcode: "LOAD_ARGUMENT",
				dst: instruction.registers[0],
				index: instruction.index,
			};
		case "loadStaticArgument":
			return {
				opcode: "LOAD_STATIC_ARGUMENT",
				dst: instruction.registers[0],
				direct: instruction.registers[2],
				fallback: instruction.registers[1],
				index: instruction.index,
			};
		case "loadThis":
			return {
				opcode: "LOAD_THIS",
				dst: instruction.registers[0],
			};
		case "loadNewTarget":
			return {
				opcode: "LOAD_NEW_TARGET",
				dst: instruction.registers[0],
			};
		case "guardFunctionIndex":
			return {
				opcode: "GUARD_FUNCTION_INDEX",
				dst: instruction.registers[0],
				callee: instruction.registers[1],
				functionIndex: instruction.functionIndex,
			};
		case "loadCallee":
			return {
				opcode: "LOAD_CALLEE",
				dst: instruction.registers[0],
			};
		case "call":
			return {
				opcode: "CALL",
				dst: instruction.registers[0],
				callee: encodeVmValueOperand(
					instruction.registers[1],
					instruction.immediateValues?.[1],
				),
				thisValue: encodeVmValueOperand(
					instruction.registers[2],
					instruction.immediateValues?.[2],
				),
				argumentCount: instruction.registers.length - 3,
				arguments: instruction.registers
					.slice(3)
					.map((register, index) =>
						encodeVmValueOperand(register, instruction.immediateValues?.[index + 3]),
					),
				directFunctionIndex: instruction.directFunctionIndex,
				directFunctionCall: instruction.directFunctionCall,
				directCallTargetFunctionIndex: instruction.directCallTargetFunctionIndex,
				guardedBuiltinCall: lowerGuardedBuiltinCall(instruction),
				directStringCharCodeAtPosition: instruction.directStringCharCodeAtPosition,
			};
		case "construct":
			return {
				opcode: "CONSTRUCT",
				dst: instruction.registers[0],
				callee: encodeVmValueOperand(
					instruction.registers[1],
					instruction.immediateValues?.[1],
				),
				argumentCount: instruction.registers.length - 2,
				arguments: instruction.registers
					.slice(2)
					.map((register, index) =>
						encodeVmValueOperand(register, instruction.immediateValues?.[index + 2]),
					),
				directFunctionIndex: instruction.directFunctionIndex,
			};
		case "throw":
			return {
				opcode: "THROW",
				value: instruction.registers[0],
			};
		case "catch":
			return {
				opcode: "CATCH",
				dst: instruction.registers[0],
			};
		case "tryBegin": {
			throw new Error("tryBegin marker must be stripped before lowering");
		}
		case "tryEnd":
			throw new Error("tryEnd marker must be stripped before lowering");
		case "generatorStart":
			return {
				opcode: "GENERATOR_START",
			};
		case "asyncStart":
			return {
				opcode: "ASYNC_START",
			};
		case "yield":
			if (instruction.terminal) {
				return {
					opcode: "TERMINAL_YIELD",
					yieldedSrc: instruction.registers[2],
				};
			}
			return {
				opcode: "YIELD",
				valueDst: instruction.registers[0],
				modeDst: instruction.registers[1],
				yieldedSrc: instruction.registers[2],
			};
		case "await":
			return {
				opcode: "AWAIT",
				valueDst: instruction.registers[0],
				modeDst: instruction.registers[1],
				awaitedSrc: instruction.registers[2],
			};
		case "loadIntrinsic":
			return {
				opcode: "LOAD_INTRINSIC",
				dst: instruction.registers[0],
				intrinsic: instruction.intrinsic,
			};
		case "loadCaptured":
			return {
				opcode: "LOAD_CAPTURED",
				dst: instruction.registers[0],
				ownerFunctionIndex: getInstructionFunctionIndex({
					type: instruction.type,
					functionIndex: instruction.functionIndex,
				}),
				index: instruction.index,
			};
		case "storeCaptured":
			return {
				opcode: "STORE_CAPTURED",
				src: instruction.registers[0],
				ownerFunctionIndex: getInstructionFunctionIndex({
					type: instruction.type,
					functionIndex: instruction.functionIndex,
				}),
				index: instruction.index,
			};
		case "envPush":
			return {
				opcode: "ENV_PUSH",
				scopeId: instruction.scopeId,
				slotCount: instruction.slotCount,
			};
		case "envCopy":
			return {
				opcode: "ENV_COPY",
				scopeId: instruction.scopeId,
				slotCount: instruction.slotCount,
			};
		case "envPop":
			return { opcode: "ENV_POP" };
		case "loadGlobal":
			return {
				opcode: "LOAD_GLOBAL",
				dst: instruction.registers[0],
				index: instruction.index,
			};
		case "storeGlobal":
			return {
				opcode: "STORE_GLOBAL",
				src: instruction.registers[0],
				index: instruction.index,
			};
		case "loadProperty":
			return {
				opcode: "LOAD_PROPERTY",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				key: instruction.registers[2],
				icIndex: -1,
				nativeClosedGlobalTable:
					instruction.nativeClosedGlobalTable === undefined
						? undefined
						: { ...instruction.nativeClosedGlobalTable },
				...(instruction.nativeFiniteKey === undefined
					? {}
					: {
							nativeFiniteKey: {
								minimum: instruction.nativeFiniteKey.minimum,
								ordinal: instruction.nativeFiniteKey.source.registers[2],
								stringIndices: [...instruction.nativeFiniteKey.stringIndices],
							},
						}),
			};
		case "loadPropertyStatic":
			return {
				opcode: "LOAD_PROPERTY_STATIC",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				stringIndex: instruction.stringIndex,
				icIndex: -1,
				nativePrimitiveStringLength: instruction.nativePrimitiveStringLength,
			};
		case "loadSuperProperty":
			return {
				opcode: "LOAD_SUPER_PROPERTY",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				key: instruction.registers[2],
				receiver: instruction.registers[3],
			};
		case "storeProperty":
			return {
				opcode: "STORE_PROPERTY",
				object: instruction.registers[0],
				key: instruction.registers[1],
				value: instruction.registers[2],
				icIndex: -1,
				nativeClosedGlobalTable:
					instruction.nativeClosedGlobalTable === undefined
						? undefined
						: { ...instruction.nativeClosedGlobalTable },
				...(instruction.nativeFiniteKey === undefined
					? {}
					: {
							nativeFiniteKey: {
								minimum: instruction.nativeFiniteKey.minimum,
								ordinal: instruction.nativeFiniteKey.source.registers[2],
								stringIndices: [...instruction.nativeFiniteKey.stringIndices],
							},
						}),
			};
		case "storePropertyStatic":
			return {
				opcode: "STORE_PROPERTY_STATIC",
				object: instruction.registers[0],
				value: instruction.registers[1],
				stringIndex: instruction.stringIndex,
				icIndex: -1,
			};
		case "toPropertyKey":
			return {
				opcode: "TO_PROPERTY_KEY",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				key: instruction.registers[2],
			};
		case "storeSuperProperty":
			return {
				opcode: "STORE_SUPER_PROPERTY",
				object: instruction.registers[0],
				key: instruction.registers[1],
				value: instruction.registers[2],
				receiver: instruction.registers[3],
			};
		case "loadPrototype":
			return {
				opcode: "LOAD_PROTOTYPE",
				dst: instruction.registers[0],
				object: instruction.registers[1],
			};
		case "getIterator":
			return {
				opcode: "GET_ITERATOR",
				iteratorDst: instruction.registers[0],
				nextDst: instruction.registers[1],
				source: instruction.registers[2],
			};
		case "getAsyncIterator":
			return {
				opcode: "GET_ASYNC_ITERATOR",
				iteratorDst: instruction.registers[0],
				nextDst: instruction.registers[1],
				source: instruction.registers[2],
			};
		case "iteratorNext":
			return {
				opcode: "ITERATOR_NEXT",
				resultDst: instruction.registers[0],
				iterator: instruction.registers[1],
				next: instruction.registers[2],
			};
		case "iteratorStep":
			return {
				opcode: "ITERATOR_STEP",
				valueDst: instruction.registers[0],
				doneDst: instruction.registers[1],
				iterator: instruction.registers[2],
				next: instruction.registers[3],
			};
		case "iteratorClose":
			return {
				opcode: "ITERATOR_CLOSE",
				iterator: instruction.registers[0],
				normal: instruction.normal === true,
			};
		case "forInKeys":
			return {
				opcode: "FOR_IN_KEYS",
				dst: instruction.registers[0],
				source: instruction.registers[1],
			};
		case "callSpread":
			return {
				opcode: "CALL_SPREAD",
				dst: instruction.registers[0],
				callee: instruction.registers[1],
				thisValue: instruction.registers[2],
				argumentsArray: instruction.registers[3],
			};
		case "callSpreadIterable":
			return {
				opcode: "CALL_SPREAD_ITERABLE",
				dst: instruction.registers[0],
				callee: instruction.registers[1],
				thisValue: instruction.registers[2],
				iterable: instruction.registers[3],
			};
		case "constructSpread":
			return {
				opcode: "CONSTRUCT_SPREAD",
				dst: instruction.registers[0],
				callee: instruction.registers[1],
				argumentsArray: instruction.registers[2],
			};
		case "constructSuper":
			return {
				opcode: "CONSTRUCT_SUPER",
				dst: instruction.registers[0],
				parent: instruction.registers[1],
				argumentsArray: instruction.registers[2],
			};
		case "constructSuperExplicit":
			return {
				opcode: "CONSTRUCT_SUPER_EXPLICIT",
				dst: instruction.registers[0],
				parent: instruction.registers[1],
				argumentsArray: instruction.registers[2],
				newTarget: instruction.registers[3],
			};
		case "setThis":
			return { opcode: "SET_THIS", value: instruction.registers[0] };
		case "mergeDataProperties":
			return {
				opcode: "MERGE_DATA_PROPERTIES",
				target: instruction.registers[0],
				src: instruction.registers[1],
			};
		case "deleteProperty":
			return {
				opcode: "DELETE_PROPERTY",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				key: instruction.registers[2],
			};
		case "defineAccessor":
			return {
				opcode: "DEFINE_ACCESSOR",
				object: instruction.registers[0],
				key: instruction.registers[1],
				accessor: instruction.registers[2],
				isSetter: instruction.kind === "set",
				enumerable: instruction.enumerable,
			};
		case "defineProperty":
			return {
				opcode: "DEFINE_PROPERTY",
				object: instruction.registers[0],
				key: instruction.registers[1],
				value: instruction.registers[2],
				enumerable: instruction.enumerable,
				writable: instruction.writable ?? true,
				configurable: instruction.configurable ?? true,
			};
		case "setFunctionName":
			return {
				opcode: "SET_FUNCTION_NAME",
				func: instruction.registers[0],
				key: instruction.registers[1],
				prefix:
					instruction.namePrefix === "get" ? 1 : instruction.namePrefix === "set" ? 2 : 0,
			};
		case "createPrivateName":
			return {
				opcode: "CREATE_PRIVATE_NAME",
				dst: instruction.registers[0],
			};
		case "createPrivateNames":
			return {
				opcode: "CREATE_PRIVATE_NAMES",
				ownerFunctionIndex: instruction.functionIndex,
				capturedIndices: instruction.capturedIndices,
			};
		case "definePrivate":
			return {
				opcode: "DEFINE_PRIVATE",
				object: instruction.registers[0],
				key: instruction.registers[1],
				value: instruction.registers[2],
			};
		case "initPrivateFields":
			return {
				opcode: "INIT_PRIVATE_FIELDS",
				object: instruction.registers[0],
				keyRegisters: instruction.registers.slice(1),
			};
		case "loadPrivate":
			return {
				opcode: "LOAD_PRIVATE",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				key: instruction.registers[2],
			};
		case "storePrivate":
			return {
				opcode: "STORE_PRIVATE",
				object: instruction.registers[0],
				key: instruction.registers[1],
				value: instruction.registers[2],
			};
		case "hasPrivate":
			return {
				opcode: "HAS_PRIVATE",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				key: instruction.registers[2],
			};
		case "setPrototype":
			return {
				opcode: "SET_PROTOTYPE",
				object: instruction.registers[0],
				prototype: instruction.registers[1],
				literal: instruction.literal,
			};
		case "loadUndeclared":
			return {
				opcode: "LOAD_UNDECLARED",
				dst: instruction.registers[0],
				nameStringIndex: instruction.nameStringIndex,
			};
		case "loadGlobalProperty":
			return {
				opcode: "LOAD_GLOBAL_PROPERTY",
				dst: instruction.registers[0],
				nameStringIndex: instruction.nameStringIndex,
			};
		case "storeGlobalProperty":
			return {
				opcode: "STORE_GLOBAL_PROPERTY",
				src: instruction.registers[0],
				nameStringIndex: instruction.nameStringIndex,
				declaration: instruction.declaration ?? false,
				declarationConfigurable: instruction.declarationConfigurable ?? false,
			};
		case "initGlobalVars":
			return {
				opcode: "INIT_GLOBAL_VARS",
				nameStringIndices: instruction.nameStringIndices,
				declarationConfigurable: instruction.declarationConfigurable,
			};
		case "throwIfTdz":
			return {
				opcode: "THROW_IF_TDZ",
				src: instruction.registers[0],
				nameStringIndex: instruction.nameStringIndex,
			};
		case "withEnter":
			return {
				opcode: "WITH_ENTER",
				object: instruction.registers[0],
			};
		case "withExit":
			return { opcode: "WITH_EXIT" };
		case "withGet":
			return {
				opcode: "WITH_GET",
				dst: instruction.registers[0],
				nameStringIndex: instruction.nameStringIndex,
			};
		case "withResolveBase":
			return {
				opcode: "WITH_RESOLVE_BASE",
				dst: instruction.registers[0],
				nameStringIndex: instruction.nameStringIndex,
			};
		case "withSet":
			return {
				opcode: "WITH_SET",
				found: instruction.registers[0],
				value: instruction.registers[1],
				nameStringIndex: instruction.nameStringIndex,
			};
		case "isEmpty":
			return {
				opcode: "IS_EMPTY",
				dst: instruction.registers[0],
				src: instruction.registers[1],
			};
		case "requireCoercible":
			return {
				opcode: "REQUIRE_COERCIBLE",
				src: instruction.registers[0],
			};
		case "checkSuperClass":
			return {
				opcode: "CHECK_SUPER_CLASS",
				parent: instruction.registers[0],
			};
		case "createRestArguments":
			return {
				opcode: "CREATE_REST_ARGUMENTS",
				dst: instruction.registers[0],
				startIndex: instruction.startIndex,
			};
		case "arrayRest":
			return {
				opcode: "ARRAY_REST",
				dst: instruction.registers[0],
				src: instruction.registers[1],
				startIndex: instruction.startIndex,
			};
		case "copyDataProperties":
			return {
				opcode: "COPY_DATA_PROPERTIES",
				dst: instruction.registers[0],
				src: instruction.registers[1],
				excludedCount: instruction.registers.length - 2,
				excluded: instruction.registers.slice(2),
			};
		case "binary": {
			const fusion = instruction.nativeNumericFusion;
			const nativeNumericFusion =
				fusion?.role === "finish" && fusion.first.type === "binary"
					? {
							role: "finish" as const,
							id: fusion.id,
							first: {
								dst: fusion.first.registers[0],
								left: fusion.first.registers[1],
								right: fusion.first.registers[2],
								operator: fusion.first.operator,
							},
						}
					: fusion?.role === "start"
						? fusion
						: undefined;
			return {
				opcode: "BINARY",
				dst: instruction.registers[0],
				left: instruction.registers[1],
				right: instruction.registers[2],
				operator: instruction.operator,
				...(nativeNumericFusion === undefined ? {} : { nativeNumericFusion }),
				...(instruction.nativeFiniteString === undefined
					? {}
					: {
							nativeFiniteString: {
								minimum: instruction.nativeFiniteString.minimum,
								stringIndices: [...instruction.nativeFiniteString.stringIndices],
							},
						}),
			};
		}
		case "unary":
			return {
				opcode: "UNARY",
				dst: instruction.registers[0],
				src: instruction.registers[1],
				operator: instruction.operator,
			};
		case "typeofCompare":
			return {
				opcode: "TYPEOF_COMPARE",
				dst: instruction.registers[0],
				src: instruction.registers[1],
				expected: instruction.expected,
				negated: instruction.negated,
			};
		case "loadLocal":
		case "storeLocal":
			throw new Error(`Unexpected non-optimized local instruction ${instruction.type}`);
	}

	throw new Error(`Unknown instruction ${(instruction as { type: string }).type}`);
}

function getInstructionFunctionIndex(instruction: {
	type: "loadCaptured" | "storeCaptured";
	functionIndex?: number;
}) {
	if (instruction.functionIndex === undefined) {
		throw new Error(`Missing function index for ${instruction.type}`);
	}

	return instruction.functionIndex;
}
