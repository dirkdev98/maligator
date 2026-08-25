import type { CoreCompilationContext } from "../core/core-compilation.ts";
import {
	coreKnownOwnSlotFromAttribute,
	coreShapeCaseCandidatesFromAttribute,
	coreShapeOriginKeys,
} from "../core/core-ir-shape-provenance.ts";
import { coreInstructionId } from "../core/core-ir.ts";
import type { CoreProgram } from "../core/core-ir.ts";
import { directBuiltinOperationIds } from "../shared/builtin-registry.ts";
import type { DirectBuiltinOperationId } from "../shared/builtin-registry.ts";
import type {
	CompilerImmediateValue,
	CompilerInstruction,
} from "../shared/compiler-instruction.ts";
import type { ExecutionFunction, ExecutionProgram } from "./execution-ir.ts";
import { verifyExecutionProgram } from "./verify-execution.ts";

/** Portable VM image contract and lowering. No native ABI or region plan belongs here. */

type CompilerBinaryOperator = Extract<
	CompilerInstruction,
	{ type: "binary" }
>["operator"];
type CompilerUnaryOperator = Extract<CompilerInstruction, { type: "unary" }>["operator"];
type CompilerIntrinsic = Extract<
	CompilerInstruction,
	{ type: "loadIntrinsic" }
>["intrinsic"];
type CompilerTypeofResult = Extract<
	CompilerInstruction,
	{ type: "typeofCompare" }
>["expected"];

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
	value: CompilerImmediateValue | undefined,
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

/** No-fallback numeric Math operation order used by VM instructions and MALW. */
export const VM_MATH_UNARY_NUMBER_OPERATIONS = [
	"Math.abs",
	"Math.floor",
	"Math.ceil",
	"Math.round",
	"Math.trunc",
	"Math.sqrt",
	"Math.cbrt",
	"Math.sign",
	"Math.log",
	"Math.log2",
	"Math.log10",
	"Math.exp",
	"Math.sin",
	"Math.cos",
	"Math.tan",
	"Math.asin",
	"Math.acos",
	"Math.atan",
	"Math.sinh",
	"Math.cosh",
	"Math.tanh",
	"Math.asinh",
	"Math.acosh",
	"Math.atanh",
	"Math.log1p",
	"Math.expm1",
	"Math.fround",
] as const;

export const VM_MATH_BINARY_NUMBER_OPERATIONS = ["Math.min", "Math.max"] as const;

export interface VmKnownOwnSlotCandidate {
	readonly shapeFunctionIndex: number;
	readonly shapeCacheIndex: number;
	readonly slot: number;
}

export interface VmShapeCaseCandidate {
	readonly shapeFunctionIndex: number;
	readonly shapeCacheIndex: number;
}

/** Portable VM state consumed by both the interpreter and compiled code. */
export interface RuntimeImage {
	/** Absolute source entry used for Node-compatible process.argv[1]. */
	entrypointPath: string;
	functionCount: number;
	functions: Array<BytecodeFunction>;
	stringConstants: Array<Array<number>>;
	bigintConstants: Array<bigint>;
	literalTemplateData: Array<number>;
	precompiledLiteralShapes: Array<VmPrecompiledLiteralShape>;
	globalCount: number;
	files: Array<string>;
	sourcePositions: Array<{
		line: number;
		column: number;
		inlinedFunctionIndex?: number;
		callerPosId?: number;
	}>;
	cjsModuleFunctionIndices: Array<number>;
	hostInstalls: Array<{
		installer: string;
		exports: Array<{ name: string; slot: number }>;
	}>;
}

/** Exact builtin calls whose dynamic property/callback seam was erased in Core. */
export const VM_DIRECT_BUILTIN_OPERATIONS = directBuiltinOperationIds;

type VmMathUnaryNumberOperation = (typeof VM_MATH_UNARY_NUMBER_OPERATIONS)[number];
type VmMathBinaryNumberOperation = (typeof VM_MATH_BINARY_NUMBER_OPERATIONS)[number];
type VmDirectBuiltinOperation = DirectBuiltinOperationId;

function vmMathUnaryNumberOperation(operation: string): VmMathUnaryNumberOperation {
	if ((VM_MATH_UNARY_NUMBER_OPERATIONS as ReadonlyArray<string>).includes(operation)) {
		return operation as VmMathUnaryNumberOperation;
	}
	throw new Error(`Unknown unary numeric Math operation ${operation}`);
}

function vmMathBinaryNumberOperation(operation: string): VmMathBinaryNumberOperation {
	if ((VM_MATH_BINARY_NUMBER_OPERATIONS as ReadonlyArray<string>).includes(operation)) {
		return operation as VmMathBinaryNumberOperation;
	}
	throw new Error(`Unknown binary numeric Math operation ${operation}`);
}

function vmDirectBuiltinOperation(operation: string): VmDirectBuiltinOperation {
	if ((VM_DIRECT_BUILTIN_OPERATIONS as ReadonlyArray<string>).includes(operation)) {
		return operation as VmDirectBuiltinOperation;
	}
	throw new Error(`Unknown direct builtin operation ${operation}`);
}

export interface VmPrecompiledLiteralShape {
	readonly functionIndex: number;
	readonly shapeCacheIndex: number;
	readonly keyStringIndices: ReadonlyArray<number>;
}

/**
 * Keep inline with the C struct
 */
export interface BytecodeExceptionHandler {
	startIp: number;
	endIp: number;
	handlerIp: number;
}

/** Resolve the innermost active handler for every VM instruction. */
export function vmExceptionHandlerTargets(
	instructionCount: number,
	handlers: ReadonlyArray<BytecodeExceptionHandler>,
): Array<number | undefined> {
	const ordered = [...handlers].sort(
		(left, right) => left.startIp - right.startIp || right.endIp - left.endIp,
	);
	const active: Array<BytecodeExceptionHandler> = [];
	const targets = new Array<number | undefined>(instructionCount);
	let next = 0;
	for (let ip = 0; ip < instructionCount; ip++) {
		while (active.length > 0 && active[active.length - 1]!.endIp <= ip) active.pop();
		while (next < ordered.length && ordered[next]!.startIp <= ip) {
			const handler = ordered[next++]!;
			const parent = active[active.length - 1];
			if (parent !== undefined && handler.endIp > parent.endIp) {
				throw new Error("Crossing exception-handler ranges");
			}
			active.push(handler);
		}
		targets[ip] = active[active.length - 1]?.handlerIp;
	}
	return targets;
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
export interface BytecodeFunction {
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

	/** Number of VM-local entries in this function's literal-shape cache. */
	literalShapeCount: number;

	instructions: Array<BytecodeInstruction>;
	handlers: Array<BytecodeExceptionHandler>;

	/**
	 * Debug-info: index into RuntimeImage.files for this function's source file.
	 */
	fileIndex: number;

	/**
	 * Debug-info: parallel to `instructions` — positions[i] is the source-position
	 * id (index into RuntimeImage.sourcePositions) of instruction i, or -1 when
	 * unknown (e.g. prologue code before the first statement marker). Built from
	 * the stripped `sourcePos` markers. The VM resolves a frame's position by its
	 * instruction pointer; the native backend emits coalesced `pos` writes from it.
	 */
	positions: Array<number>;
	/** Dense profile site for each instruction, or -1 when no source is known. */
	profileSiteIds?: Array<number>;
}

/** -1 never retains; INT32_MAX always retains nonempty input; otherwise the
 * largest static index whose absence requires the supplied argument slice. */
export function computeArgumentRetentionLimit(
	fn: Pick<BytecodeFunction, "argumentSnapshotCount" | "instructions">,
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
		BytecodeFunction,
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
export type BytecodeInstruction =
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
	  }
	| {
			opcode: "MATH_UNARY_NUMBER";
			dst: number;
			src: number;
			operation: VmMathUnaryNumberOperation;
	  }
	| {
			opcode: "MATH_BINARY_NUMBER";
			dst: number;
			left: number;
			right: number;
			operation: VmMathBinaryNumberOperation;
	  }
	| {
			opcode: "CALL_BUILTIN";
			dst: number;
			thisValue: number;
			argumentCount: number;
			arguments: Array<number>;
			operation: VmDirectBuiltinOperation;
	  }
	| {
			opcode: "CONSTRUCT";
			dst: number;
			callee: number;
			argumentCount: number;
			arguments: Array<number>;
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
			intrinsic: CompilerIntrinsic;
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
	  }
	| {
			opcode: "LOAD_PROPERTY_STATIC";
			dst: number;
			object: number;
			stringIndex: number;
			icIndex: number;
	  }
	| {
			opcode: "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT";
			dst: number;
			object: number;
			stringIndex: number;
			icIndex: number;
			/** Ordered exact shaped-literal guards tried before the generic fallback. */
			candidates: ReadonlyArray<VmKnownOwnSlotCandidate>;
	  }
	| {
			opcode: "SELECT_SHAPE_CASE";
			dst: number;
			object: number;
			/** Exact portable shaped-literal rows, in the order used by load slot tables. */
			candidates: ReadonlyArray<VmShapeCaseCandidate>;
	  }
	| {
			opcode: "LOAD_PROPERTY_STATIC_SHAPE_CASE";
			dst: number;
			object: number;
			shapeCase: number;
			stringIndex: number;
			icIndex: number;
			/** Own data slot for each candidate in the defining selector. */
			slots: ReadonlyArray<number>;
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
	  }
	| {
			opcode: "STORE_PROPERTY_STATIC";
			object: number;
			value: number;
			stringIndex: number;
			icIndex: number;
	  }
	| {
			opcode: "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT";
			object: number;
			value: number;
			stringIndex: number;
			icIndex: number;
			/** Ordered exact shaped-literal guards tried before the generic fallback. */
			candidates: ReadonlyArray<VmKnownOwnSlotCandidate>;
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
			operator: CompilerBinaryOperator;
	  }
	| {
			opcode: "UNARY";
			dst: number;
			src: number;
			operator: CompilerUnaryOperator;
	  }
	| {
			opcode: "TYPEOF_COMPARE";
			dst: number;
			src: number;
			expected: CompilerTypeofResult;
			negated: boolean;
	  };

/** Every physical register defined by an instruction, including multi-result ops. */
export function vmInstructionWriteRegisters(
	instruction: BytecodeInstruction,
): ReadonlyArray<number> {
	switch (instruction.opcode) {
		case "YIELD":
		case "AWAIT":
			return [instruction.valueDst, instruction.modeDst];
		case "GET_ITERATOR":
		case "GET_ASYNC_ITERATOR":
			return [instruction.iteratorDst, instruction.nextDst];
		case "ITERATOR_NEXT":
			return [instruction.resultDst];
		case "ITERATOR_STEP":
			return [instruction.valueDst, instruction.doneDst];
		case "WITH_SET":
			return [instruction.found];
		default: {
			const dst = (instruction as { readonly dst?: number }).dst;
			return dst === undefined ? [] : [dst];
		}
	}
}

const VM_REGISTER_USE_FIELDS = [
	"src",
	"value",
	"cond",
	"callee",
	"thisValue",
	"object",
	"key",
	"left",
	"right",
	"receiver",
	"source",
	"target",
	"direct",
	"fallback",
	"iterator",
	"next",
	"accessor",
	"func",
	"parent",
	"newTarget",
	"found",
	"awaitedSrc",
	"yieldedSrc",
	"iterable",
	"argumentsArray",
	"shapeCase",
] as const;

const VM_REGISTER_USE_ARRAY_FIELDS = [
	"arguments",
	"valueRegisters",
	"keyRegisters",
	"excluded",
] as const;

/** Whether an instruction reads a physical register. Literal-bearing CREATE
 * instructions are excluded so equal numeric payloads cannot masquerade as a
 * register use. */
export function vmInstructionUsesRegister(
	instruction: BytecodeInstruction,
	register: number,
): boolean {
	if (
		instruction.opcode === "CREATE_NUMBER" ||
		instruction.opcode === "CREATE_F64" ||
		instruction.opcode === "CREATE_BOOLEAN"
	) {
		return false;
	}
	const row = instruction as unknown as Record<string, unknown>;
	if (VM_REGISTER_USE_FIELDS.some((field) => row[field] === register)) return true;
	return VM_REGISTER_USE_ARRAY_FIELDS.some(
		(field) => Array.isArray(row[field]) && row[field].includes(register),
	);
}

/** Whether an instruction defines a physical register, including multi-result opcodes. */
export function vmInstructionDefinesRegister(
	instruction: BytecodeInstruction,
	register: number,
): boolean {
	return vmInstructionWriteRegisters(instruction).includes(register);
}

export function countPropertyIcSites(
	instructions: ReadonlyArray<BytecodeInstruction>,
): number {
	let count = 0;
	for (const instruction of instructions) {
		switch (instruction.opcode) {
			case "LOAD_PROPERTY":
			case "LOAD_PROPERTY_STATIC":
			case "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT":
			case "LOAD_PROPERTY_STATIC_SHAPE_CASE":
			case "STORE_PROPERTY":
			case "STORE_PROPERTY_STATIC":
			case "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT":
				count++;
				break;
		}
	}
	return count;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		!Object.is(value, -0)
	);
}

function vmNamedShapeKeyIdentity(units: ReadonlyArray<number>): string | undefined {
	if (
		units.length === 9 &&
		units.every((unit, offset) => unit === "__proto__".charCodeAt(offset))
	) {
		return undefined;
	}
	if (units.length > 0 && !(units.length > 1 && units[0] === 0x30)) {
		let index = 0;
		let digits = true;
		for (const unit of units) {
			if (unit < 0x30 || unit > 0x39) {
				digits = false;
				break;
			}
			index = index * 10 + (unit - 0x30);
			if (index > 0xffff_ffff) {
				digits = false;
				break;
			}
		}
		if (digits && index !== 0xffff_ffff) return undefined;
	}
	return units.join(",");
}

/** Reject malformed VM-level guarded slot references at every output boundary. */
export function validateVmKnownOwnSlots(definition: RuntimeImage): void {
	const descriptors = new Map<string, VmPrecompiledLiteralShape>();
	for (const descriptor of definition.precompiledLiteralShapes) {
		const { functionIndex, shapeCacheIndex, keyStringIndices } = descriptor;
		const functionEntry = definition.functions[functionIndex];
		const identity = `${functionIndex}\0${shapeCacheIndex}`;
		if (
			!isNonnegativeSafeInteger(functionIndex) ||
			!isNonnegativeSafeInteger(shapeCacheIndex) ||
			functionEntry === undefined ||
			shapeCacheIndex >= functionEntry.literalShapeCount ||
			!Array.isArray(keyStringIndices) ||
			keyStringIndices.length < 1 ||
			keyStringIndices.length > 64 ||
			keyStringIndices.some(
				(index) =>
					!isNonnegativeSafeInteger(index) || index >= definition.stringConstants.length,
			) ||
			descriptors.has(identity)
		) {
			throw new RangeError("invalid precompiled literal shape");
		}
		const canonicalKeys = new Set<string>();
		for (const index of descriptor.keyStringIndices) {
			const units = definition.stringConstants[index]!;
			const key = vmNamedShapeKeyIdentity(units);
			if (key === undefined || canonicalKeys.has(key)) {
				throw new RangeError("invalid precompiled literal shape");
			}
			canonicalKeys.add(key);
		}
		descriptors.set(identity, descriptor);
	}
	for (const fn of definition.functions) {
		let physicalShapeCount = 0;
		for (const instruction of fn.instructions) {
			if (instruction.opcode !== "CREATE_OBJECT_SHAPED") continue;
			if (instruction.shapeCacheIndex !== physicalShapeCount) {
				throw new RangeError(
					`literal shape index ${instruction.shapeCacheIndex}, expected ${physicalShapeCount}`,
				);
			}
			if (
				instruction.count !== instruction.keyStringIndices.length ||
				instruction.count !== instruction.valueRegisters.length
			) {
				throw new RangeError("invalid shaped object operands");
			}
			physicalShapeCount++;
		}
		if (
			!isNonnegativeSafeInteger(fn.literalShapeCount) ||
			physicalShapeCount > fn.literalShapeCount
		) {
			throw new RangeError("invalid literal shape cache layout");
		}
	}
	for (const fn of definition.functions) {
		for (const instruction of fn.instructions) {
			if (
				instruction.opcode !== "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT" &&
				instruction.opcode !== "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT"
			) {
				continue;
			}
			const rawCandidates: unknown = instruction.candidates;
			if (
				!isNonnegativeSafeInteger(instruction.stringIndex) ||
				instruction.stringIndex >= definition.stringConstants.length ||
				!Array.isArray(rawCandidates) ||
				rawCandidates.length < 1 ||
				rawCandidates.length > 4
			) {
				throw new RangeError("invalid known-own-slot access");
			}
			const candidates = rawCandidates as ReadonlyArray<unknown>;
			const identities = new Set<string>();
			for (const value of candidates) {
				if (typeof value !== "object" || value === null || Array.isArray(value)) {
					throw new RangeError("invalid known-own-slot access");
				}
				const candidate = value as Partial<VmKnownOwnSlotCandidate>;
				const { shapeFunctionIndex, shapeCacheIndex, slot } = candidate;
				if (
					Object.keys(value).length !== 3 ||
					!isNonnegativeSafeInteger(shapeFunctionIndex) ||
					!isNonnegativeSafeInteger(shapeCacheIndex) ||
					!isNonnegativeSafeInteger(slot)
				) {
					throw new RangeError("invalid known-own-slot access");
				}
				const identity = `${shapeFunctionIndex}\0${shapeCacheIndex}`;
				const descriptor = descriptors.get(identity);
				if (
					identities.has(identity) ||
					descriptor === undefined ||
					slot >= descriptor.keyStringIndices.length ||
					descriptor.keyStringIndices[slot] !== instruction.stringIndex
				) {
					throw new RangeError("invalid known-own-slot access");
				}
				identities.add(identity);
			}
		}
	}
}

const VM_SHAPE_CASE_MIN_LOADS = 2;
const VM_SHAPE_CASE_MAX_LOADS = 16;
const VM_SHAPE_CASE_MAX_SPAN = 64;

function vmShapeCaseTransparent(instruction: BytecodeInstruction): boolean {
	switch (instruction.opcode) {
		case "MOVE":
		case "CREATE_NUMBER":
		case "CREATE_F64":
		case "CREATE_BOOLEAN":
		case "CREATE_UNDEFINED":
		case "CREATE_EMPTY":
		case "CREATE_NULL":
		case "GUARD_FUNCTION_INDEX":
		case "LOAD_CAPTURED":
		case "STORE_CAPTURED":
		case "LOAD_GLOBAL":
		case "STORE_GLOBAL":
		case "LOAD_INTRINSIC":
		case "LOAD_NEW_TARGET":
		case "LOAD_THIS":
		case "SET_THIS":
		case "IS_EMPTY":
		case "TYPEOF_COMPARE":
		case "MATH_UNARY_NUMBER":
		case "MATH_BINARY_NUMBER":
		case "WITH_EXIT":
		case "SELECT_SHAPE_CASE":
			return true;
		default:
			return false;
	}
}

/** Reject forged or stale shared shape-case certificates in a runtime image. */
export function validateVmShapeCases(definition: RuntimeImage): void {
	// Also validates the shared precompiled-shape table and physical cache layout.
	validateVmKnownOwnSlots(definition);
	const descriptors = new Map<string, VmPrecompiledLiteralShape>();
	for (const descriptor of definition.precompiledLiteralShapes) {
		descriptors.set(
			`${descriptor.functionIndex}\0${descriptor.shapeCacheIndex}`,
			descriptor,
		);
	}
	for (const fn of definition.functions) {
		for (const [selectorIp, rawSelector] of fn.instructions.entries()) {
			if (rawSelector.opcode !== "SELECT_SHAPE_CASE") continue;
			const rawCandidates: unknown = rawSelector.candidates;
			if (
				!isNonnegativeSafeInteger(rawSelector.dst) ||
				rawSelector.dst >= fn.registerCount ||
				!isNonnegativeSafeInteger(rawSelector.object) ||
				rawSelector.object >= fn.registerCount ||
				!Array.isArray(rawCandidates) ||
				rawCandidates.length < 1 ||
				rawCandidates.length > 4
			) {
				throw new RangeError("invalid shape-case selector");
			}
			const candidates = rawCandidates as ReadonlyArray<unknown>;
			const candidateDescriptors: Array<VmPrecompiledLiteralShape> = [];
			const identities = new Set<string>();
			for (const rawCandidate of candidates) {
				if (
					typeof rawCandidate !== "object" ||
					rawCandidate === null ||
					Array.isArray(rawCandidate)
				) {
					throw new RangeError("invalid shape-case selector");
				}
				const candidate = rawCandidate as Partial<VmShapeCaseCandidate>;
				if (
					Object.keys(rawCandidate).length !== 2 ||
					!isNonnegativeSafeInteger(candidate.shapeFunctionIndex) ||
					!isNonnegativeSafeInteger(candidate.shapeCacheIndex)
				) {
					throw new RangeError("invalid shape-case selector");
				}
				const identity = `${candidate.shapeFunctionIndex}\0${candidate.shapeCacheIndex}`;
				const descriptor = descriptors.get(identity);
				if (descriptor === undefined || identities.has(identity)) {
					throw new RangeError("invalid shape-case selector");
				}
				identities.add(identity);
				candidateDescriptors.push(descriptor);
			}

			const uses: Array<{
				readonly ip: number;
				readonly instruction: Extract<
					BytecodeInstruction,
					{ opcode: "LOAD_PROPERTY_STATIC_SHAPE_CASE" }
				>;
			}> = [];
			for (let ip = selectorIp + 1; ip < fn.instructions.length; ip++) {
				const instruction = fn.instructions[ip]!;
				if (vmInstructionDefinesRegister(instruction, rawSelector.dst)) break;
				if (!vmInstructionUsesRegister(instruction, rawSelector.dst)) continue;
				if (
					instruction.opcode !== "LOAD_PROPERTY_STATIC_SHAPE_CASE" ||
					instruction.shapeCase !== rawSelector.dst ||
					instruction.object !== rawSelector.object
				) {
					throw new RangeError("invalid shape-case selector use");
				}
				uses.push({ ip, instruction });
			}
			if (
				uses.length < VM_SHAPE_CASE_MIN_LOADS ||
				uses.length > VM_SHAPE_CASE_MAX_LOADS ||
				uses.at(-1)!.ip - selectorIp > VM_SHAPE_CASE_MAX_SPAN
			) {
				throw new RangeError("invalid shape-case selector use count or span");
			}
			const useIps = new Set(uses.map(({ ip }) => ip));
			const lastUseIp = uses.at(-1)!.ip;
			for (let ip = selectorIp + 1; ip <= lastUseIp; ip++) {
				const instruction = fn.instructions[ip]!;
				// The selector licenses one exact live receiver value, not a physical
				// register forever. A definition of that register before a later use
				// would let a forged runtime image apply the old case to a new object.
				// The final use may overwrite the receiver after reading it.
				if (
					ip < lastUseIp &&
					vmInstructionDefinesRegister(instruction, rawSelector.object)
				) {
					throw new RangeError("shape-case selector receiver is redefined");
				}
				if (useIps.has(ip)) continue;
				if (!vmShapeCaseTransparent(instruction)) {
					throw new RangeError("shape-case selector crosses an invalid instruction");
				}
			}
			for (const { instruction } of uses) {
				const rawSlots: unknown = instruction.slots;
				if (
					!isNonnegativeSafeInteger(instruction.dst) ||
					instruction.dst >= fn.registerCount ||
					!isNonnegativeSafeInteger(instruction.object) ||
					instruction.object >= fn.registerCount ||
					!isNonnegativeSafeInteger(instruction.shapeCase) ||
					instruction.shapeCase >= fn.registerCount ||
					!isNonnegativeSafeInteger(instruction.stringIndex) ||
					instruction.stringIndex >= definition.stringConstants.length ||
					!Array.isArray(rawSlots) ||
					rawSlots.length !== candidateDescriptors.length
				) {
					throw new RangeError("invalid shape-case load");
				}
				for (const [candidateIndex, rawSlot] of rawSlots.entries()) {
					const descriptor = candidateDescriptors[candidateIndex]!;
					if (
						!isNonnegativeSafeInteger(rawSlot) ||
						rawSlot >= descriptor.keyStringIndices.length ||
						descriptor.keyStringIndices[rawSlot] !== instruction.stringIndex
					) {
						throw new RangeError("invalid shape-case load");
					}
				}
			}
		}
		for (const [ip, instruction] of fn.instructions.entries()) {
			if (instruction.opcode !== "LOAD_PROPERTY_STATIC_SHAPE_CASE") continue;
			let producer: BytecodeInstruction | undefined;
			for (let before = ip - 1; before >= 0; before--) {
				const candidate = fn.instructions[before]!;
				if (!vmInstructionDefinesRegister(candidate, instruction.shapeCase)) continue;
				producer = candidate;
				break;
			}
			if (producer?.opcode !== "SELECT_SHAPE_CASE") {
				throw new RangeError("shape-case load has no selector");
			}
		}
	}
}

interface VmKnownShapeOrigin {
	readonly keyStringIndices: ReadonlyArray<number>;
	readonly shapeCacheIndex: number;
}

interface VmKnownShapeLayout {
	readonly origins: ReadonlyArray<ReadonlyMap<number, VmKnownShapeOrigin>>;
	readonly literalShapeCounts: ReadonlyArray<number>;
	readonly precompiledLiteralShapes: ReadonlyArray<VmPrecompiledLiteralShape>;
}

/**
 * Resolve Core shape-origin anchors to dense VM cache rows. Physical shaped
 * allocations keep their bytecode row; constructor-derived layouts reserve a
 * synthetic row after the physical prefix. Every row used by a guard receives a
 * portable descriptor, so both static and wire/interpreted output intern the
 * same live shape before the access executes.
 */
function buildKnownShapeLayout(
	core: CoreProgram,
	functions: ReadonlyArray<ExecutionFunction>,
): VmKnownShapeLayout {
	const origins: Array<Map<number, VmKnownShapeOrigin>> = [];
	const layoutRows: Array<Map<string, number>> = [];
	const literalShapeCounts: Array<number> = [];
	for (const fn of functions) {
		const cacheIndexByInstruction = new Map<CompilerInstruction, number>();
		const rows = new Map<string, number>();
		let shapeCacheIndex = 0;
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.type === "createObjectShaped") {
					cacheIndexByInstruction.set(instruction, shapeCacheIndex);
					rows.set(instruction.keyStringIndices.join(","), shapeCacheIndex++);
				}
			}
		}

		const functionOrigins = new Map<number, VmKnownShapeOrigin>();
		for (const safepoint of fn.gc.safepoints) {
			if (safepoint.kind !== "operation") continue;
			if (safepoint.instruction.type !== "createObjectShaped") continue;
			const cacheIndex = cacheIndexByInstruction.get(safepoint.instruction);
			if (cacheIndex === undefined || functionOrigins.has(safepoint.coreInstruction)) {
				throw new Error(
					`Invalid shaped-literal origin ${fn.functionIndex}:${safepoint.coreInstruction}`,
				);
			}
			functionOrigins.set(safepoint.coreInstruction, {
				keyStringIndices: safepoint.instruction.keyStringIndices,
				shapeCacheIndex: cacheIndex,
			});
		}
		origins[fn.functionIndex] = functionOrigins;
		layoutRows[fn.functionIndex] = rows;
		literalShapeCounts[fn.functionIndex] = shapeCacheIndex;
	}

	const coreInstructions = core.functions.map(
		(fn) =>
			new Map(
				fn.blocks.flatMap((block) =>
					block.instructions.map((instruction) => [instruction.id, instruction] as const),
				),
			),
	);
	const descriptors = new Map<string, VmPrecompiledLiteralShape>();
	const coreOriginKeys = new Map<string, ReadonlyArray<number>>();
	const ensureOrigin = (
		functionIndex: number,
		shapeInstruction: number,
	): { readonly keys: ReadonlyArray<number>; readonly origin: VmKnownShapeOrigin } => {
		const coreOriginIdentity = `${functionIndex}\0${shapeInstruction}`;
		const originFunction = core.functions[functionIndex];
		const originInstruction = coreInstructions[functionIndex]?.get(
			coreInstructionId(shapeInstruction),
		);
		if (
			originFunction?.functionIndex !== functionIndex ||
			originInstruction === undefined
		) {
			throw new Error(`Invalid known shape origin ${functionIndex}:${shapeInstruction}`);
		}
		let keys = coreOriginKeys.get(coreOriginIdentity);
		if (keys === undefined) {
			keys = coreShapeOriginKeys(core, originFunction, originInstruction);
			if (keys !== undefined) coreOriginKeys.set(coreOriginIdentity, keys);
		}
		if (keys === undefined) {
			throw new Error(`Invalid known shape origin ${functionIndex}:${shapeInstruction}`);
		}

		let origin = origins[functionIndex]?.get(shapeInstruction);
		if (origin !== undefined) {
			if (
				origin.keyStringIndices.length !== keys.length ||
				origin.keyStringIndices.some((key, index) => key !== keys[index])
			) {
				throw new Error(
					`Shape origin layout changed ${functionIndex}:${shapeInstruction}`,
				);
			}
		} else {
			const rows = layoutRows[functionIndex];
			const functionOrigins = origins[functionIndex];
			if (rows === undefined || functionOrigins === undefined) {
				throw new Error(`Unknown shape-origin function ${functionIndex}`);
			}
			const layout = keys.join(",");
			let shapeCacheIndex = rows.get(layout);
			if (shapeCacheIndex === undefined) {
				shapeCacheIndex = literalShapeCounts[functionIndex]!;
				literalShapeCounts[functionIndex] = shapeCacheIndex + 1;
				rows.set(layout, shapeCacheIndex);
			}
			origin = { keyStringIndices: keys, shapeCacheIndex };
			functionOrigins.set(shapeInstruction, origin);
		}
		const identity = `${functionIndex}\0${origin.shapeCacheIndex}`;
		descriptors.set(identity, {
			functionIndex,
			shapeCacheIndex: origin.shapeCacheIndex,
			keyStringIndices: [...origin.keyStringIndices],
		});
		return { keys, origin };
	};
	for (const owner of core.functions) {
		for (const block of owner.blocks) {
			for (const instruction of block.instructions) {
				const claim = coreKnownOwnSlotFromAttribute(instruction.attributes.knownOwnSlot);
				if (claim !== undefined) {
					for (const candidate of claim.candidates) {
						const functionIndex = candidate.shapeFunctionIndex;
						const { keys } = ensureOrigin(functionIndex, candidate.shapeInstruction);
						if (
							candidate.slot >= keys.length ||
							keys[candidate.slot] !== instruction.attributes.stringIndex
						) {
							throw new Error(
								`Invalid known shape origin ${functionIndex}:${candidate.shapeInstruction}`,
							);
						}
					}
				}
				const shapeCases = coreShapeCaseCandidatesFromAttribute(
					instruction.attributes.shapeCaseCandidates,
				);
				if (shapeCases !== undefined) {
					for (const candidate of shapeCases) {
						ensureOrigin(candidate.shapeFunctionIndex, candidate.shapeInstruction);
					}
				}
			}
		}
	}
	return {
		origins,
		literalShapeCounts,
		precompiledLiteralShapes: [...descriptors.values()],
	};
}

/**
 * Run-length compress a function's per-instruction position ids into
 * (start_ip, pos_id) entries: a new entry only where the position changes. The
 * runtime resolves a frame's position by finding the last entry with
 * start_ip <= instruction_pointer. Shared by the C-literal emitter (emit-program-image)
 * and the wire serializer (program-image-codec); it lives here, alongside the VM
 * image types, so the self-hostable codec cone never imports emit-program-image
 * (which pulls node:path + the render-native-c native backend).
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

export interface RuntimeFunctionLoweringPlan {
	readonly bytecode: BytecodeFunction;
	readonly blockStartIps: ReadonlyMap<number, number>;
	readonly instructionIndexByTargetInstruction: ReadonlyMap<CompilerInstruction, number>;
	readonly propertyIcIndexByInstruction: ReadonlyMap<CompilerInstruction, number>;
}

export interface RuntimeProgramLoweringPlan {
	readonly runtime: RuntimeImage;
	readonly functions: ReadonlyArray<RuntimeFunctionLoweringPlan>;
}

/** Lower an ExecutionProgram already verified by its terminal owner. */
export function lowerVerifiedExecutionToRuntimePlan(
	program: ExecutionProgram,
): RuntimeProgramLoweringPlan {
	const { core, context } = program;
	const files: Array<string> = [];
	const fileToIndex = new Map<string, number>();
	const fileIndexFor = (path: string): number => {
		const existing = fileToIndex.get(path);
		if (existing !== undefined) return existing;
		const index = files.push(path) - 1;
		fileToIndex.set(path, index);
		return index;
	};
	const knownShapeLayout = buildKnownShapeLayout(core, program.functions);
	const functionPlans = program.functions.map((fn, index) =>
		lowerExecutionFunctionToBytecode(
			fn,
			fileIndexFor(fn.sourcePath),
			core.stringConstants,
			knownShapeLayout.origins,
			knownShapeLayout.literalShapeCounts[index]!,
		),
	);
	const functions = functionPlans.map(({ bytecode }) => bytecode);
	const runtime: RuntimeImage = {
		entrypointPath: context.data.entrypointPath,
		functionCount: functions.length,
		functions,
		stringConstants: core.stringConstants.map((units) => [...units]),
		bigintConstants: [...core.bigintConstants],
		literalTemplateData: [...core.literalTemplateData],
		precompiledLiteralShapes: [...knownShapeLayout.precompiledLiteralShapes],
		globalCount: core.globalCount,
		cjsModuleFunctionIndices: [...context.data.cjsModuleFunctionIndices],
		hostInstalls: buildHostInstalls(context, functions),
		files,
		sourcePositions: core.sourcePositions.map((position) => ({ ...position })),
	};
	validateVmShapeCases(runtime);
	return { runtime, functions: functionPlans };
}

export function lowerExecutionToRuntimeImage(program: ExecutionProgram): RuntimeImage {
	verifyExecutionProgram(program);
	return lowerVerifiedExecutionToRuntimePlan(program).runtime;
}

function buildHostInstalls(
	context: CoreCompilationContext,
	functions: Array<BytecodeFunction>,
): RuntimeImage["hostInstalls"] {
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

	const manifest: RuntimeImage["hostInstalls"] = [];
	const installFor = (installer: string) => {
		let install = manifest.find((entry) => entry.installer === installer);
		if (!install) {
			install = { installer, exports: [] };
			manifest.push(install);
		}
		return install;
	};
	for (const hostModule of context.data.hostInstallCandidates) {
		const usedExports: Array<{ name: string; slot: number }> = [];
		for (const { name, slot } of hostModule.exports) {
			if (readGlobalSlots.has(slot)) {
				usedExports.push({ name, slot });
			}
		}
		if (usedExports.length > 0) {
			installFor(hostModule.installer).exports.push(...usedExports);
		}
	}

	for (const installer of context.data.retainedHostInstallers) installFor(installer);

	return manifest;
}

function lowerExecutionFunctionToBytecode(
	fn: ExecutionFunction,
	fileIndex: number,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
	knownShapeOrigins: ReadonlyArray<ReadonlyMap<number, VmKnownShapeOrigin>>,
	literalShapeCount: number,
): RuntimeFunctionLoweringPlan {
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

	const instructions: Array<BytecodeInstruction> = [];
	let propertyIcCount = 0;
	const propertyIcIndexByInstruction = new Map<CompilerInstruction, number>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.type === "loadProperty" ||
				instruction.type === "loadPropertyStatic" ||
				instruction.type === "loadPropertyStaticShapeCase" ||
				instruction.type === "storeProperty" ||
				instruction.type === "storePropertyStatic"
			) {
				propertyIcIndexByInstruction.set(instruction, propertyIcCount++);
			}
		}
	}
	let physicalLiteralShapeCount = 0;
	const handlers: Array<BytecodeExceptionHandler> = [];
	const openExceptionRanges: Array<{ startIp: number; handlerIp: number }> = [];
	const positions: Array<number> = [];
	const instructionIndexByTargetInstruction = new Map<CompilerInstruction, number>();
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
			instructionIndexByTargetInstruction.set(instruction, instructionIndex);
			let vmInstruction: BytecodeInstruction;
			if (instruction.type === "selectShapeCase") {
				const candidates = instruction.shapeCaseCandidates.map((candidate) => {
					const origin = knownShapeOrigins[candidate.shapeFunctionIndex]?.get(
						candidate.shapeInstruction,
					);
					if (origin === undefined) {
						throw new Error(
							`Invalid shape-case origin ${candidate.shapeFunctionIndex}:${candidate.shapeInstruction}`,
						);
					}
					return {
						shapeFunctionIndex: candidate.shapeFunctionIndex,
						shapeCacheIndex: origin.shapeCacheIndex,
					};
				});
				vmInstruction = {
					opcode: "SELECT_SHAPE_CASE",
					dst: instruction.registers[0],
					object: instruction.registers[1],
					candidates,
				};
			} else {
				vmInstruction = lowerInstructionToBytecodeInstruction(blockStartIps, instruction);
			}
			if (
				(instruction.type === "loadPropertyStatic" ||
					instruction.type === "storePropertyStatic") &&
				instruction.knownOwnSlot
			) {
				const candidates = instruction.knownOwnSlot.candidates.map((candidate) => {
					const { shapeFunctionIndex, shapeInstruction, slot } = candidate;
					const origin = knownShapeOrigins[shapeFunctionIndex]?.get(shapeInstruction);
					if (
						origin === undefined ||
						!Number.isInteger(slot) ||
						slot < 0 ||
						slot >= origin.keyStringIndices.length ||
						origin.keyStringIndices[slot] !== instruction.stringIndex
					) {
						throw new Error(
							`Invalid known-own-slot access origin ${shapeFunctionIndex}:${shapeInstruction}:${slot}`,
						);
					}
					return { shapeFunctionIndex, shapeCacheIndex: origin.shapeCacheIndex, slot };
				});
				vmInstruction =
					instruction.type === "loadPropertyStatic"
						? {
								opcode: "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT",
								dst: instruction.registers[0],
								object: instruction.registers[1],
								stringIndex: instruction.stringIndex,
								icIndex: -1,
								candidates,
							}
						: {
								opcode: "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT",
								object: instruction.registers[0],
								value: instruction.registers[1],
								stringIndex: instruction.stringIndex,
								icIndex: -1,
								candidates,
							};
			}
			switch (vmInstruction.opcode) {
				case "LOAD_PROPERTY":
				case "LOAD_PROPERTY_STATIC":
				case "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT":
				case "LOAD_PROPERTY_STATIC_SHAPE_CASE":
				case "STORE_PROPERTY":
				case "STORE_PROPERTY_STATIC":
				case "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT":
					vmInstruction.icIndex = propertyIcIndexByInstruction.get(instruction)!;
					break;
				case "CREATE_OBJECT_SHAPED":
					vmInstruction.shapeCacheIndex = physicalLiteralShapeCount++;
					break;
			}
			instructions.push(vmInstruction);
			positions.push(currentPos);
		}
	}
	if (openExceptionRanges.length > 0) {
		throw new Error("Unbalanced try marker at end of function");
	}
	if (physicalLiteralShapeCount > literalShapeCount) {
		throw new Error(`Literal shape cache underflow in function ${fn.functionIndex}`);
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
		registerCount: fn.registerCount,
	});

	const bytecode: BytecodeFunction = {
		nameStringIndex: fn.nameStringIndex,
		isGenerator: fn.isGenerator,
		isAsync: fn.isAsync,
		parameterCount: fn.parameterCount,
		mappedArguments: fn.mappedArguments,
		mappedArgumentSlots: [...fn.mappedArgumentSlots],
		length: fn.length,
		registerCount: fn.registerCount,
		capturedCount: fn.capturedCount,
		strict: fn.strict,
		needsArguments,
		argumentSnapshotCount,
		argumentSnapshotPlan,
		isDerivedConstructor: fn.isDerivedConstructor,
		isClassConstructor: fn.isClassConstructor,
		hasPrototype: fn.hasPrototype,
		literalShapeCount,
		instructions,
		handlers,
		fileIndex,
		positions,
	};
	return {
		bytecode,
		blockStartIps,
		instructionIndexByTargetInstruction,
		propertyIcIndexByInstruction,
	};
}

function lowerInstructionToBytecodeInstruction(
	blockStartIps: Map<number, number>,
	instruction: CompilerInstruction,
): BytecodeInstruction {
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
			return {
				opcode: "CREATE_ARRAY",
				dst: instruction.registers[0],
				length: instruction.length,
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
		case "call": {
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
			};
		}
		case "mathUnaryNumber":
			return {
				opcode: "MATH_UNARY_NUMBER",
				dst: instruction.registers[0],
				src: instruction.registers[1],
				operation: vmMathUnaryNumberOperation(instruction.operation),
			};
		case "mathBinaryNumber":
			return {
				opcode: "MATH_BINARY_NUMBER",
				dst: instruction.registers[0],
				left: instruction.registers[1],
				right: instruction.registers[2],
				operation: vmMathBinaryNumberOperation(instruction.operation),
			};
		case "callBuiltin":
			return {
				opcode: "CALL_BUILTIN",
				dst: instruction.registers[0],
				thisValue: instruction.registers[1],
				argumentCount: instruction.registers.length - 2,
				arguments: instruction.registers.slice(2),
				operation: vmDirectBuiltinOperation(instruction.operation),
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
			};
		case "loadPropertyStatic":
			return {
				opcode: "LOAD_PROPERTY_STATIC",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				stringIndex: instruction.stringIndex,
				icIndex: -1,
			};
		case "loadPropertyStaticShapeCase":
			return {
				opcode: "LOAD_PROPERTY_STATIC_SHAPE_CASE",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				shapeCase: instruction.registers[2],
				stringIndex: instruction.stringIndex,
				icIndex: -1,
				slots: instruction.shapeCaseSlots,
			};
		case "selectShapeCase":
			throw new Error("selectShapeCase must resolve its shape origins before lowering");
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
			return {
				opcode: "BINARY",
				dst: instruction.registers[0],
				left: instruction.registers[1],
				right: instruction.registers[2],
				operator: instruction.operator,
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
