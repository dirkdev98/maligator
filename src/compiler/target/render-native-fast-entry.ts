import type { CompilerClassLayoutSite } from "../shared/compiler-instruction.ts";
import {
	compilerValueKindTruthiness,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_UNDEFINED,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_NULLISH,
	COMPILER_VALUE_KIND_TO_NUMBER_PRIMITIVE,
	compilerValueKindMaskIsSubset,
	compilerValueKindsHaveEmptyPrimitiveWrappers,
} from "../shared/compiler-value-kinds.ts";
import {
	instructionInputIsInt32,
	instructionResultIntegerRange,
	instructionInputIntegerRange,
	instructionInputKind,
} from "../shared/instruction-facts.ts";
import type { CompilerIntegerRange } from "../shared/integer-range.ts";
import {
	compilerIntegerRangeComparison,
	compilerIntegerRangeIsInt32,
	compilerIntegerRangeTruthiness,
	COMPILER_INT32_RANGE,
} from "../shared/integer-range.ts";
import { emitIntrinsic } from "./emit-program-image.ts";
import type { NativeControlFlowPlan } from "./native-control-flow.ts";
import {
	nativeBinaryNumberInputs,
	nativePrimitiveNumberExpression,
	nativeUnsignedRemainderExpression,
	nativeInt32ArithmeticExpression,
	nativeInt32UnaryExpression,
	nativeReflexiveEqualityExpression,
	nativeEqualityExpression,
	nativeTypeofComparisonExpression,
	nativeMathNumberArity,
	nativeGuardedMathArity,
	nativeNumericBuiltinExpr,
	NUMBER_PREDICATES,
	nativeNumberPredicateInputExpression,
	nativeObjectBrandPredicateExpression,
	OBJECT_BRAND_PREDICATES,
} from "./native-scalar-operators.ts";
import {
	nativeInstructionSourceRanges,
	shiftNativeSourceRanges,
} from "./native-source-map.ts";
import type { NativeSourceRange } from "./native-source-map.ts";
import { nativeStringComparisonExpression } from "./native-string-comparisons.ts";
import type { NativeStringComparisonPlan } from "./native-string-comparisons.ts";
import type {
	NativeDirectEntryPlan,
	NativeFunctionPlan,
	VmRegisterRepresentation,
} from "./program-image.ts";
import {
	decodeVmValueOperand,
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";
import type { BytecodeFunction, BytecodeInstruction } from "./runtime-image.ts";

const MAXIMUM_FAST_ENTRY_INSTRUCTIONS = 64;

export type NativeFastTryParameters = ReadonlyArray<"i32" | "boxed">;

export function nativeFastTryParameterList(parameters?: NativeFastTryParameters): string {
	return parameters === undefined
		? FAST_TRY_PARAMETERS
		: [
				"MalVm *vm",
				"MalValue this_value",
				...parameters.map(
					(kind, index) => `${kind === "i32" ? "i32" : "MalValue"} __fast_p${index}`,
				),
				"MalEnv *env",
				"MalValue *out",
			].join(", ");
}

export interface NativeFastEntryInput {
	readonly onSourceMap?: (ranges: ReadonlyArray<NativeSourceRange>) => void;
	readonly onTryParameters?: (parameters: NativeFastTryParameters | undefined) => void;
	readonly fn: BytecodeFunction;
	readonly facts: NativeFunctionPlan["facts"];
	readonly instructions: NativeFunctionPlan["instructions"];
	readonly classLayouts: boolean;
	readonly directEntry: NativeDirectEntryPlan | undefined;
	readonly controlFlow: NativeControlFlowPlan | undefined;
	readonly elidedPureIps: ReadonlyArray<number>;
	readonly stringComparisons: ReadonlyArray<NativeStringComparisonPlan>;
	/** The full entry already answers this body without a frame or with a better dispatch. */
	readonly specialized: boolean;
	/** The original entry signature, ending in `{`. */
	readonly signature: string;
	/** The canonical entry also exports its fast body as `trySymbol` for other fast bodies. */
	readonly trySymbol: string | undefined;
	readonly fullSymbol: string;
	readonly fullArguments: ReadonlyArray<string>;
	readonly prologue: ReadonlyArray<string>;
	/** C expression for this function's property-cache row. */
	readonly functionIndex: string;
	readonly functionTargetIndex: (index: number) => string;
	readonly globalIndex: (index: number) => string;
	readonly stringIndex: (index: number) => string;
	readonly stringValue: (index: number) => string;
	readonly lengthProperty: (stringIndex: number) => boolean;
	/** Non-allocating statements that bind what `capturedLoad` reads. */
	readonly capturePrologue: ReadonlyArray<string>;
	readonly capturedLoad: (ownerFunctionIndex: number, index: number) => string;
	/** The fast body a CALL's proven exact target exports, if any, and its environment argument. */
	readonly calleeTry: (
		ip: number,
		callee: string,
	) =>
		| {
				readonly symbol: string;
				readonly environment: string;
				readonly guard?: string;
				readonly parameters?: NativeFastTryParameters;
		  }
		| undefined;
	readonly f64Literal: (value: number) => string;
}

function fastClassSite(
	input: NativeFastEntryInput,
	ip: number,
): CompilerClassLayoutSite | undefined {
	const plan = input.instructions[ip];
	return input.classLayouts &&
		plan?.kind === "class-layout" &&
		plan.site.candidates.length > 0
		? plan.site
		: undefined;
}

function fastClassRead(
	site: CompilerClassLayoutSite,
	ip: number,
	receiver: number,
	destination: number,
): string {
	const object = `__fast_object_${ip}`;
	const guard = site.kind === "method" ? "MAL_CLASS_METHOD" : "MAL_CLASS_SLOT";
	return `{ MalObject *const ${object} = mal_vm_as_object(__fast_r${receiver}); ${site.candidates.map(({ layout, index }, position) => `${position === 0 ? "if" : "else if"} (${guard}(${object}, ${layout})) __fast_r${destination} = ${site.kind === "method" ? `vm->class_cells[${layout}].methods[${index}]` : `mal_object_field_load_shaped(${object}, ${index})`};`).join(" ")} else goto __full; }`;
}

/** A fast path may restart only before JavaScript effects or allocation, using the original arguments. */
export function renderNativeFastEntry(
	input: NativeFastEntryInput,
): ReadonlyArray<string> | undefined {
	const { fn, directEntry } = input;
	const unreachable = new Set(input.controlFlow?.unreachableIps);
	const elided = new Set(input.elidedPureIps);
	const branches = new Map(
		input.controlFlow?.branches.map(({ instructionIp, targetIp }) => [
			instructionIp,
			targetIp,
		]),
	);
	if (
		input.specialized ||
		fn.isGenerator ||
		fn.isAsync ||
		fn.isClassConstructor ||
		fn.isDerivedConstructor ||
		fn.capturedCount !== 0 ||
		fn.mappedArguments ||
		fn.needsArguments ||
		fn.argumentSnapshotCount !== 0 ||
		fn.handlers.length !== 0 ||
		fn.instructions.length - unreachable.size > MAXIMUM_FAST_ENTRY_INSTRUCTIONS
	)
		return undefined;
	const fieldLoads = new Map(
		directEntry?.fieldParameters?.loads.map((load) => [load.instructionIp, load.field]),
	);
	const stringComparisons = new Map(
		input.stringComparisons.map((plan) => [plan.instructionIp, plan]),
	);
	const exported = input.trySymbol !== undefined;
	const rejected = new Set<number>();
	for (const [ip, op] of fn.instructions.entries()) {
		if (unreachable.has(ip) || elided.has(ip)) continue;
		const target = branches.get(ip);
		if (
			fastInstruction(
				target === undefined ? op : { opcode: "JUMP", targetIp: target },
				ip,
				input,
				fieldLoads,
				new Set(),
				exported,
				new Map(),
				stringComparisons.get(ip),
				new Set(),
				new Set(),
				undefined,
			) === undefined
		)
			rejected.add(ip);
	}
	const graph = fastEntryGraph(fn.instructions, branches, unreachable, rejected);
	if (hasCycle(graph)) return undefined;
	const fallsThrough =
		fn.instructions.length === 0 ||
		[...graph.values()].some((next) => next.includes(fn.instructions.length));
	if (
		!fallsThrough &&
		![...graph.keys()].some(
			(ip) => !rejected.has(ip) && fn.instructions[ip]!.opcode === "RETURN",
		)
	)
		return undefined;
	const accesses = new Map(
		[...graph.keys()].map((ip) => [
			ip,
			{
				reads:
					branches.has(ip) || elided.has(ip) || rejected.has(ip)
						? []
						: vmInstructionReadRegisters(fn.instructions[ip]!),
				writes:
					elided.has(ip) || rejected.has(ip)
						? []
						: vmInstructionWriteRegisters(fn.instructions[ip]!),
			},
		]),
	);
	const registers = new Set<number>();
	for (const { reads, writes } of accesses.values())
		for (const register of [...reads, ...writes]) registers.add(register);
	const result = exported ? undefined : directEntry;
	const targets = new Set<number>();
	const body: Array<readonly [number, string]> = [];
	let loadsProperties = false;
	let loadsCaptures = false;
	const instructions = [...graph.keys()]
		.filter((ip) => !elided.has(ip) && !rejected.has(ip))
		.map((ip) => fn.instructions[ip]!);
	const constants = numberConstantRegisters(instructions, registers);
	const integers = int32ResultRegisters(instructions, fn.parameterCount, registers);
	const cachedNumbers = cachedNumberResultRegisters(
		instructions,
		fn.parameterCount,
		registers,
	);
	const initialized = initializedFastRegisters(graph, accesses, registers);
	const tryParameters = exported
		? scalarTryParameters(fn, graph, accesses, rejected)
		: undefined;
	for (const register of constants.keys())
		if (!initialized.has(register)) constants.delete(register);
	for (const register of integers)
		if (!initialized.has(register)) integers.delete(register);
	for (const register of cachedNumbers)
		if (!initialized.has(register)) cachedNumbers.delete(register);
	for (const [ip, op] of fn.instructions.entries()) {
		if (!graph.has(ip)) continue;
		if (rejected.has(ip)) {
			body.push([ip, "goto __full;"]);
			continue;
		}
		if (elided.has(ip)) {
			body.push([ip, ""]);
			continue;
		}
		const target = branches.get(ip);
		const line =
			target === ip + 1
				? ""
				: fastInstruction(
						target === undefined ? op : { opcode: "JUMP", targetIp: target },
						ip,
						input,
						fieldLoads,
						targets,
						exported,
						constants,
						stringComparisons.get(ip),
						integers,
						cachedNumbers,
						tryParameters,
					);
		if (line === undefined) return undefined;
		if (
			op.opcode === "LOAD_PROPERTY_STATIC" &&
			!fieldLoads.has(ip) &&
			input.instructions[ip]?.kind !== "known-own-data" &&
			fastClassSite(input, ip) === undefined &&
			!(
				input.lengthProperty(op.stringIndex) &&
				instructionInputKind(input.facts?.[ip], op.object) === COMPILER_VALUE_KIND_STRING
			)
		)
			loadsProperties = true;
		if (op.opcode === "LOAD_CAPTURED") loadsCaptures = true;
		body.push([ip, line]);
	}
	const lines: Array<string> = [];
	const starts: Array<number> = [];
	const ips: Array<number> = [];
	for (const [ip, line] of body) {
		if (targets.has(ip)) lines.push(`F${ip}:;`);
		starts.push(lines.length);
		ips.push(ip);
		if (line.length > 0) lines.push(`    ${line}`);
	}
	const mappedLineCount = lines.length;
	if (targets.has(fn.instructions.length)) lines.push(`F${fn.instructions.length}:;`);
	lines.push(`    ${fastReturn("MAL_VALUE_UNDEFINED", result, exported)}`);

	// Register identifiers share C's namespace with runtime typedefs such as f32 and f64.
	const locals = [...registers].sort((left, right) => left - right);
	const fast = [
		...input.prologue,
		...(locals.length === 0
			? []
			: [`    MalValue ${locals.map((r) => `__fast_r${r}`).join(", ")};`]),
		...(cachedNumbers.size === 0
			? []
			: [
					`    f64 ${[...cachedNumbers]
						.sort((left, right) => left - right)
						.map((r) => `__fast_n${r}`)
						.join(", ")};`,
				]),
		"    if (!mal_vm_leaf_unobserved(vm) || !mal_vm_leaf_stack_available(vm)) goto __full;",
		...(loadsProperties
			? [
					`    MalInlineCache *const __fast_ic = vm->property_cache[${input.functionIndex}].sites;`,
					"    if (__fast_ic == nullptr) goto __full;",
				]
			: []),
		...(loadsCaptures ? input.capturePrologue.map((line) => `    ${line}`) : []),
		...locals.flatMap((register) =>
			register < fn.parameterCount
				? [
						`    __fast_r${register} = ${fastParameter(register, directEntry, tryParameters)};`,
					]
				: initialized.has(register)
					? []
					: [`    __fast_r${register} = MAL_VALUE_UNDEFINED;`],
		),
		...lines,
	];
	const full = `    return ${input.fullSymbol}(${input.fullArguments.join(", ")});`;
	// C admits the pragma only before the body's first statement.
	const pragma = "#pragma STDC FP_CONTRACT OFF";
	const emit = (output: ReadonlyArray<string>): ReadonlyArray<string> => {
		if (exported) input.onTryParameters?.(tryParameters);
		// The fast body follows its prologue; suffix text is deliberately unmapped.
		const fastStart = exported
			? 2
			: 2 + (fn.hasPrototype && directEntry === undefined ? 1 : 0);
		const prefix = output.slice(0, fastStart).join("\n");
		const prologue = fast.slice(0, fast.length - lines.length).join("\n");
		const offset =
			(fastStart === 0 ? 0 : prefix.length + 1) +
			(prologue.length === 0 ? 0 : prologue.length + 1);
		input.onSourceMap?.(
			shiftNativeSourceRanges(
				nativeInstructionSourceRanges(
					{
						...fn,
						positions: fn.positions.map((position, ip) =>
							graph.has(ip) ? position : -1,
						),
					},
					lines.slice(0, mappedLineCount),
					starts,
					ips,
				),
				offset,
			),
		);
		return output;
	};
	if (!exported)
		return emit([
			input.signature,
			pragma,
			...(fn.hasPrototype && directEntry === undefined
				? ["    if (!mal_value_is_undefined(new_target)) goto __full;"]
				: []),
			...fast,
			"__full:",
			full,
			"}",
		]);
	const linkage = input.signature.startsWith("static ") ? "static " : "";
	// Int32 tags exclude negative zero, fractional keys and values needing coercion.
	const entryGuards =
		tryParameters?.flatMap((kind, index) =>
			kind === "i32"
				? [`arg_count > ${index}`, `mal_value_is_int32(args[${index}])`]
				: [],
		) ?? [];
	const arguments_ =
		tryParameters === undefined
			? "args, arg_count"
			: tryParameters
					.map((kind, index) =>
						kind === "i32"
							? `mal_value_to_i32(args[${index}])`
							: `(arg_count > ${index} ? args[${index}] : MAL_VALUE_UNDEFINED)`,
					)
					.join(", ");
	return emit([
		`${linkage}__attribute__((no_stack_protector)) __attribute__((aligned(64))) bool ${input.trySymbol}(${nativeFastTryParameterList(tryParameters)}) {`,
		pragma,
		...fast,
		"__full:",
		"    return false;",
		"}",
		input.signature,
		"    MalValue __fast_result;",
		`    if (${fn.hasPrototype ? "mal_value_is_undefined(new_target) && " : ""}${entryGuards.length === 0 ? "" : `${entryGuards.join(" && ")} && `}${input.trySymbol}(vm, this_value, ${arguments_}, env, &__fast_result)) return __fast_result;`,
		full,
		"}",
	]);
}

/** Parameters of an exported fast body; it reports success and writes the result. */
export const FAST_TRY_PARAMETERS =
	"MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalEnv *env, MalValue *out";

function fastEntryGraph(
	instructions: ReadonlyArray<BytecodeInstruction>,
	branches: ReadonlyMap<number, number>,
	unreachable: ReadonlySet<number>,
	rejected: ReadonlySet<number>,
): ReadonlyMap<number, ReadonlyArray<number>> {
	const graph = new Map<number, ReadonlyArray<number>>();
	const pending = [0];
	while (pending.length > 0) {
		const ip = pending.pop()!;
		const op = instructions[ip];
		if (op === undefined || unreachable.has(ip) || graph.has(ip)) continue;
		const target = branches.get(ip);
		const next = rejected.has(ip)
			? []
			: target !== undefined
				? [target]
				: op.opcode === "RETURN"
					? []
					: op.opcode === "JUMP"
						? [op.targetIp]
						: op.opcode === "JUMP_IF"
							? [op.targetIp, ip + 1]
							: [ip + 1];
		graph.set(ip, next);
		pending.push(...next);
	}
	return graph;
}

// A loop needs a poll, and a poll needs a frame.
function hasCycle(graph: ReadonlyMap<number, ReadonlyArray<number>>): boolean {
	const state = new Map<number, number>();
	const visit = (ip: number): boolean => {
		const next = graph.get(ip);
		if (next === undefined || state.get(ip) === 2) return false;
		if (state.get(ip) === 1) return true;
		state.set(ip, 1);
		if (next.some(visit)) return true;
		state.set(ip, 2);
		return false;
	};
	return visit(0);
}

function initializedFastRegisters(
	graph: ReadonlyMap<number, ReadonlyArray<number>>,
	accesses: ReadonlyMap<
		number,
		{
			readonly reads: ReadonlyArray<number>;
			readonly writes: ReadonlyArray<number>;
		}
	>,
	registers: ReadonlySet<number>,
): ReadonlySet<number> {
	const initialized = new Set<number>();
	for (const register of registers) {
		const pending = [0];
		const visited = new Set<number>();
		let safe = true;
		while (pending.length > 0) {
			const ip = pending.pop()!;
			if (visited.has(ip) || !graph.has(ip)) continue;
			visited.add(ip);
			const access = accesses.get(ip)!;
			if (access.reads.includes(register)) {
				safe = false;
				break;
			}
			if (!access.writes.includes(register)) pending.push(...graph.get(ip)!);
		}
		if (safe) initialized.add(register);
	}
	return initialized;
}

function scalarTryParameters(
	fn: BytecodeFunction,
	graph: ReadonlyMap<number, ReadonlyArray<number>>,
	accesses: ReadonlyMap<
		number,
		{ readonly reads: ReadonlyArray<number>; readonly writes: ReadonlyArray<number> }
	>,
	rejected: ReadonlySet<number>,
): NativeFastTryParameters | undefined {
	if (fn.parameterCount === 0 || fn.parameterCount > 4) return undefined;
	const parameters = Array.from(
		{ length: fn.parameterCount },
		(): "i32" | "boxed" => "boxed",
	);
	for (let parameter = 0; parameter < parameters.length; parameter++) {
		if ([...accesses.values()].some((access) => access.writes.includes(parameter)))
			continue;
		// The stricter ABI must not penalize successful paths that bypass the index.
		const pending = [0],
			visited = new Set<number>();
		let indexed = false,
			required = true;
		while (pending.length > 0) {
			const ip = pending.pop()!;
			if (visited.has(ip) || rejected.has(ip)) continue;
			visited.add(ip);
			const op = fn.instructions[ip];
			if (op === undefined || op.opcode === "RETURN") {
				required = false;
				break;
			}
			if (!graph.has(ip)) continue;
			if (
				op.opcode === "LOAD_PROPERTY" &&
				op.key === parameter &&
				accesses.get(ip)?.reads.includes(parameter)
			) {
				indexed = true;
				continue;
			}
			pending.push(...graph.get(ip)!);
		}
		if (required && indexed) parameters[parameter] = "i32";
	}
	return parameters.includes("i32") ? parameters : undefined;
}

function boxed(representation: VmRegisterRepresentation, value: string): string {
	switch (representation) {
		case "number":
			return `mal_ops_number_value(${value})`;
		case "int32":
			return `mal_value_from_i32(${value})`;
		case "boolean":
			return `mal_value_new_boolean(${value})`;
		case "boxed":
		case "string":
			return value;
	}
}

function fastParameter(
	index: number,
	directEntry: NativeDirectEntryPlan | undefined,
	tryParameters?: NativeFastTryParameters,
): string {
	if (tryParameters !== undefined)
		return tryParameters[index] === "i32"
			? `mal_value_from_i32(__fast_p${index})`
			: `__fast_p${index}`;
	if (directEntry === undefined)
		return `arg_count > ${index} ? args[${index}] : MAL_VALUE_UNDEFINED`;
	const representations =
		directEntry.argumentRepresentations ?? directEntry.parameterRepresentations;
	const representation = representations[index];
	return representation === undefined
		? "MAL_VALUE_UNDEFINED"
		: boxed(representation, `p${index}`);
}

// A result outside the entry's representation restarts so the full entry reports it.
function fastReturn(
	value: string,
	directEntry: NativeDirectEntryPlan | undefined,
	exported: boolean,
): string {
	if (exported) return `{ *out = ${value}; return true; }`;
	switch (directEntry?.resultRepresentation) {
		case undefined:
		case "boxed":
			return `return ${value};`;
		case "string":
			return `{ MalValue __r = ${value}; if (!mal_value_is_string(__r)) goto __full; return __r; }`;
		case "boolean":
			return `{ MalValue __r = ${value}; if (!mal_value_is_boolean(__r)) goto __full; return mal_value_to_boolean(__r); }`;
		case "number":
			return `{ MalValue __r = ${value}; if (!mal_ops_is_number(__r)) goto __full; return mal_ops_number_as_f64(__r); }`;
		case "int32":
			return `{ MalValue __r = ${value}; if (!mal_ops_is_number(__r)) goto __full; f64 __d = mal_ops_number_as_f64(__r); if (!(__d >= INT32_MIN && __d <= INT32_MAX) || (f64) (i32) __d != __d) goto __full; return (i32) __d; }`;
	}
}

/** Registers whose every definition stores the same Number, so uses can read the literal. */
function numberConstantRegisters(
	instructions: ReadonlyArray<BytecodeInstruction>,
	registers: ReadonlySet<number>,
): Map<number, number> {
	const constants = new Map<number, number>();
	const varying = new Set<number>();
	for (const op of instructions) {
		if (!("dst" in op) || !registers.has(op.dst)) continue;
		if (
			(op.opcode === "CREATE_NUMBER" || op.opcode === "CREATE_F64") &&
			!varying.has(op.dst) &&
			(!constants.has(op.dst) || Object.is(constants.get(op.dst), op.value))
		) {
			constants.set(op.dst, op.value);
			continue;
		}
		constants.delete(op.dst);
		varying.add(op.dst);
	}
	return constants;
}

/** Registers only int32 operators define, so a branch can test the integer itself. */
function int32ResultRegisters(
	instructions: ReadonlyArray<BytecodeInstruction>,
	parameterCount: number,
	registers: ReadonlySet<number>,
): Set<number> {
	const integers = new Set<number>();
	const varying = new Set<number>();
	for (const op of instructions) {
		if (!("dst" in op) || !registers.has(op.dst)) continue;
		const integer =
			(op.opcode === "BINARY" &&
				(INT32_OPERATORS.has(op.operator) ||
					op.operator === "<<" ||
					op.operator === ">>")) ||
			(op.opcode === "UNARY" && op.operator === "~");
		if (integer && op.dst >= parameterCount && !varying.has(op.dst)) {
			integers.add(op.dst);
			continue;
		}
		integers.delete(op.dst);
		varying.add(op.dst);
	}
	return integers;
}

/**
 * Successful fast execution establishes these Number facts. Every admitted writer
 * updates the double cache alongside the boxed value.
 */
function cachedNumberResultRegisters(
	instructions: ReadonlyArray<BytecodeInstruction>,
	parameterCount: number,
	registers: ReadonlySet<number>,
): Set<number> {
	const numeric = new Set<number>();
	const varying = new Set<number>();
	for (const op of instructions) {
		if (!("dst" in op) || !registers.has(op.dst)) continue;
		const number =
			op.opcode === "CREATE_NUMBER" ||
			op.opcode === "CREATE_F64" ||
			(op.opcode === "BINARY" &&
				(NUMBER_OPERATORS.has(op.operator) ||
					op.operator === ">>>" ||
					op.operator === "%" ||
					op.operator === "**")) ||
			(op.opcode === "UNARY" &&
				(op.operator === "-" ||
					op.operator === "increment" ||
					op.operator === "decrement"));
		if (number && op.dst >= parameterCount && !varying.has(op.dst)) {
			numeric.add(op.dst);
			continue;
		}
		numeric.delete(op.dst);
		varying.add(op.dst);
	}
	return numeric;
}

interface FastNumbers {
	readonly parameters: NativeFastTryParameters | undefined;
	readonly cachedNumbers: ReadonlySet<number>;
	readonly kind: (register: number) => number;
	readonly isInt32: (register: number) => boolean;
	readonly resultIsInt32: (register: number) => boolean;
	readonly range: (register: number) => CompilerIntegerRange | undefined;
	readonly constants: ReadonlyMap<number, number>;
	readonly literal: (value: number) => string;
	readonly stringComparison: NativeStringComparisonPlan | undefined;
}

function numbers(values: FastNumbers, ...registers: ReadonlyArray<number>): string {
	if (
		registers.some(
			(register) => (values.kind(register) & COMPILER_VALUE_KIND_NUMBER) === 0,
		)
	)
		return "true";
	const checks = registers
		.filter(
			(register) =>
				!values.constants.has(register) &&
				values.kind(register) !== COMPILER_VALUE_KIND_NUMBER,
		)
		.map((register) => `!mal_ops_is_number(__fast_r${register})`);
	return checks.length === 0 ? "false" : checks.join(" || ");
}

function number(values: FastNumbers, register: number): string {
	if (values.parameters?.[register] === "i32") return `((f64) __fast_p${register})`;
	const constant = values.constants.get(register);
	return constant === undefined
		? values.cachedNumbers.has(register)
			? `__fast_n${register}`
			: `mal_ops_number_as_f64(__fast_r${register})`
		: values.literal(constant);
}

function equalityScalar(
	values: FastNumbers,
	operand: number,
	boxed: string,
): string | undefined {
	switch (values.kind(operand)) {
		case COMPILER_VALUE_KIND_NUMBER: {
			if (operand >= 0) return number(values, operand);
			const decoded = decodeVmValueOperand(operand);
			return decoded.kind === "number" ? values.literal(decoded.value) : undefined;
		}
		case COMPILER_VALUE_KIND_BOOLEAN:
			return `mal_value_to_boolean(${boxed})`;
		case COMPILER_VALUE_KIND_STRING:
			return `mal_value_to_string(${boxed})`;
		default:
			return undefined;
	}
}

function int32(values: FastNumbers, register: number): string {
	if (values.parameters?.[register] === "i32") return `__fast_p${register}`;
	const constant = values.constants.get(register);
	return constant === undefined
		? values.isInt32(register)
			? `((i32) ${number(values, register)})`
			: `mal_ops_number_value_to_i32(__fast_r${register})`
		: `((i32) ${constant | 0})`;
}

function exactInteger(values: FastNumbers, register: number): string | undefined {
	const constant = values.constants.get(register);
	return values.isInt32(register) ||
		(constant !== undefined &&
			Number.isInteger(constant) &&
			!Object.is(constant, -0) &&
			constant >= -0x8000_0000 &&
			constant <= 0x7fff_ffff)
		? int32(values, register)
		: undefined;
}

function storeNumber(values: FastNumbers, dst: number, expression: string): string {
	const integer = values.resultIsInt32(dst);
	const computed = integer ? `((i32) (${expression}))` : expression;
	const stored = values.cachedNumbers.has(dst)
		? `(__fast_n${dst} = ${computed})`
		: computed;
	return `__fast_r${dst} = ${integer ? `mal_value_from_i32((i32) ${stored})` : `mal_ops_number_value(${stored})`};`;
}

const NUMBER_COMPARISONS: ReadonlySet<string> = new Set(["<", "<=", ">", ">="]);
const INT32_OPERATORS: ReadonlySet<string> = new Set(["&", "|", "^"]);
const NUMBER_OPERATORS: ReadonlySet<string> = new Set(["+", "-", "*", "/"]);

function fastBinary(
	op: Extract<BytecodeInstruction, { opcode: "BINARY" }>,
	values: FastNumbers,
): string | undefined {
	const { dst, left, right, operator } = op;
	const compared = compilerIntegerRangeComparison(
		operator,
		values.range(left),
		values.range(right),
	);
	if (compared !== undefined)
		return `__fast_r${dst} = ${compared ? "MAL_VALUE_TRUE" : "MAL_VALUE_FALSE"};`;
	if (left === right) {
		const expression = nativeReflexiveEqualityExpression(
			operator,
			`__fast_r${left}`,
			values.kind(left) === COMPILER_VALUE_KIND_NUMBER ? number(values, left) : undefined,
			values.kind(left),
			values.isInt32(left) || values.range(left) !== undefined,
		);
		if (expression !== undefined)
			return `__fast_r${dst} = mal_value_new_boolean(${expression});`;
	}
	if (operator === "===" || operator === "!==") {
		const equal =
			nativeStringComparisonExpression(
				values.stringComparison,
				left,
				`__fast_r${left}`,
				`__fast_r${right}`,
			) ??
			nativeEqualityExpression(
				"strict",
				`__fast_r${left}`,
				`__fast_r${right}`,
				values.kind(left),
				values.kind(right),
				equalityScalar(values, left, `__fast_r${left}`),
				equalityScalar(values, right, `__fast_r${right}`),
				values.isInt32(left) && values.isInt32(right),
				values.range(left),
				values.range(right),
			);
		return `__fast_r${dst} = mal_value_new_boolean(${operator === "!==" ? `!(${equal})` : equal});`;
	}
	if (operator === "==" || operator === "!=") {
		const numberFailure = numbers(values, left, right);
		const not = operator === "!=" ? "!" : "";
		const numeric = `__fast_r${dst} = mal_value_new_boolean(${not}(${number(values, left)} == ${number(values, right)}));`;
		if (numberFailure === "false") return numeric;
		const nullish =
			(values.kind(left) | values.kind(right)) & COMPILER_VALUE_KIND_NULLISH;
		if (numberFailure === "true" && nullish === 0) return undefined;
		const fallback =
			nullish === 0
				? "goto __full;"
				: `if (mal_value_is_nil(__fast_r${left}) || mal_value_is_nil(__fast_r${right})) __fast_r${dst} = mal_value_new_boolean(${not}(mal_value_is_nil(__fast_r${left}) && mal_value_is_nil(__fast_r${right}))); else goto __full;`;
		return numberFailure === "true"
			? fallback
			: `if (!(${numberFailure})) ${numeric} else ${fallback}`;
	}
	const inputs = nativeBinaryNumberInputs(
		operator,
		values.constants.has(left) ? COMPILER_VALUE_KIND_NUMBER : values.kind(left),
		values.constants.has(right) ? COMPILER_VALUE_KIND_NUMBER : values.kind(right),
		`__fast_r${left}`,
		`__fast_r${right}`,
	);
	if (inputs === undefined) return undefined;
	const mask = (register: number) => inputs.masks[register === left ? 0 : 1];
	const guard = inputs.guard === "" ? "" : `if (!(${inputs.guard})) goto __full;`;
	const numeric = (register: number) =>
		mask(register) === COMPILER_VALUE_KIND_NUMBER
			? number(values, register)
			: nativePrimitiveNumberExpression(`__fast_r${register}`, mask(register));
	const integer = (register: number) =>
		mask(register) === COMPILER_VALUE_KIND_NUMBER
			? int32(values, register)
			: `mal_ops_number_to_i32(${numeric(register)})`;
	if (values.resultIsInt32(dst)) {
		const expression =
			nativeInt32ArithmeticExpression(
				operator,
				exactInteger(values, left),
				exactInteger(values, right),
			) ??
			(operator === "%"
				? nativeUnsignedRemainderExpression(
						numeric(left),
						numeric(right),
						values.range(left),
						values.range(right),
						numeric(left),
						numeric(right),
						"int32",
					)
				: undefined);
		if (expression !== undefined)
			return `${guard} ${storeNumber(values, dst, expression)}`;
	}
	if (NUMBER_COMPARISONS.has(operator))
		return `${guard} __fast_r${dst} = mal_value_new_boolean(${numeric(left)} ${operator} ${numeric(right)});`;
	if (INT32_OPERATORS.has(operator))
		return `${guard} __fast_r${dst} = mal_value_from_i32(${integer(left)} ${operator} ${integer(right)});`;
	if (operator === "<<")
		return `${guard} __fast_r${dst} = mal_value_from_i32((i32) ((u32) ${integer(left)} << ((u32) ${integer(right)} & 31u)));`;
	if (operator === ">>")
		return `${guard} __fast_r${dst} = mal_value_from_i32(${integer(left)} >> ((u32) ${integer(right)} & 31u));`;
	if (operator === ">>>")
		return `${guard} ${storeNumber(values, dst, `(f64) ((u32) ${integer(left)} >> ((u32) ${integer(right)} & 31u))`)}`;
	if (NUMBER_OPERATORS.has(operator))
		return `${guard} ${storeNumber(values, dst, `${numeric(left)} ${operator} ${numeric(right)}`)}`;
	if (operator === "%") {
		const expression =
			nativeUnsignedRemainderExpression(
				numeric(left),
				numeric(right),
				values.range(left),
				values.range(right),
			) ?? `mal_number_remainder(${numeric(left)}, ${numeric(right)})`;
		return `${guard} ${storeNumber(values, dst, expression)}`;
	}
	if (operator === "**")
		return `${guard} ${storeNumber(values, dst, `mal_number_exponentiate(${numeric(left)}, ${numeric(right)})`)}`;
	return undefined;
}

function fastUnary(
	op: Extract<BytecodeInstruction, { opcode: "UNARY" }>,
	values: FastNumbers,
): string | undefined {
	const { dst, src, operator } = op;
	const primitive = compilerValueKindMaskIsSubset(
		values.kind(src),
		COMPILER_VALUE_KIND_TO_NUMBER_PRIMITIVE,
	);
	const numberFailure = primitive ? "false" : numbers(values, src);
	if (operator !== "!" && numberFailure === "true") return undefined;
	const guard = numberFailure === "false" ? "" : `if (${numberFailure}) goto __full;`;
	const converts = primitive && values.kind(src) !== COMPILER_VALUE_KIND_NUMBER;
	const numeric = converts
		? nativePrimitiveNumberExpression(`__fast_r${src}`, values.kind(src))
		: number(values, src);
	if (values.resultIsInt32(dst)) {
		const expression = nativeInt32UnaryExpression(operator, exactInteger(values, src));
		if (expression !== undefined)
			return `${guard} ${storeNumber(values, dst, expression)}`;
	}
	switch (operator) {
		case "!": {
			const constant =
				compilerIntegerRangeTruthiness(values.range(src)) ??
				compilerValueKindTruthiness(values.kind(src));
			return constant === undefined
				? values.kind(src) === COMPILER_VALUE_KIND_NUMBER
					? `__fast_r${dst} = mal_value_new_boolean(!mal_number_is_truthy(${number(values, src)}));`
					: `__fast_r${dst} = mal_value_new_boolean(!mal_value_is_truthy(__fast_r${src}));`
				: `__fast_r${dst} = ${constant ? "MAL_VALUE_FALSE" : "MAL_VALUE_TRUE"};`;
		}
		case "-":
			return `${guard} ${storeNumber(values, dst, `-${numeric}`)}`;
		case "+":
		case "tonumeric":
			return converts
				? `__fast_r${dst} = mal_ops_number_value(${numeric});`
				: `${guard} __fast_r${dst} = __fast_r${src};`;
		case "~":
			return `${guard} __fast_r${dst} = mal_value_from_i32(~${converts ? `mal_ops_number_to_i32(${numeric})` : int32(values, src)});`;
		case "increment":
			return `${guard} ${storeNumber(values, dst, `${numeric} + 1.0`)}`;
		case "decrement":
			return `${guard} ${storeNumber(values, dst, `${numeric} - 1.0`)}`;
		default:
			return undefined;
	}
}

function fastInstruction(
	op: BytecodeInstruction,
	ip: number,
	input: NativeFastEntryInput,
	fieldLoads: ReadonlyMap<number, number>,
	targets: Set<number>,
	exported: boolean,
	constants: ReadonlyMap<number, number>,
	stringComparison: NativeStringComparisonPlan | undefined,
	integers: ReadonlySet<number>,
	cachedNumbers: ReadonlySet<number>,
	tryParameters: NativeFastTryParameters | undefined,
): string | undefined {
	const masks = input.facts?.[ip]?.inputKindMasks;
	const values: FastNumbers = {
		parameters: tryParameters,
		cachedNumbers,
		resultIsInt32: (register) =>
			compilerIntegerRangeIsInt32(
				instructionResultIntegerRange(input.facts?.[ip], register),
			),
		range: (register) =>
			tryParameters?.[register] === "i32"
				? COMPILER_INT32_RANGE
				: instructionInputIntegerRange(input.facts?.[ip], register),
		isInt32: (register) =>
			tryParameters?.[register] === "i32" ||
			instructionInputIsInt32(input.facts?.[ip], register),
		kind(register) {
			if (tryParameters?.[register] === "i32") return COMPILER_VALUE_KIND_NUMBER;
			if (
				constants.has(register) ||
				cachedNumbers.has(register) ||
				integers.has(register)
			)
				return COMPILER_VALUE_KIND_NUMBER;
			if (register < 0) {
				const decoded = decodeVmValueOperand(register);
				switch (decoded.kind) {
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
			}
			const kind = instructionInputKind(input.facts?.[ip], register);
			if (kind !== undefined) return kind;
			if (masks !== undefined) {
				if (op.opcode === "UNARY" && op.src === register) return masks[0]!;
				if (op.opcode === "BINARY") {
					if (op.left === register) return masks[0]!;
					if (op.right === register) return masks[1]!;
				}
			}
			return COMPILER_VALUE_KIND_TOP;
		},
		constants,
		literal: input.f64Literal,
		stringComparison,
	};
	const value = (operand: number): string | undefined => {
		if (operand >= 0) return `__fast_r${operand}`;
		const decoded = decodeVmValueOperand(operand);
		switch (decoded.kind) {
			case "undefined":
				return "MAL_VALUE_UNDEFINED";
			case "null":
				return "MAL_VALUE_NULL";
			case "boolean":
				return decoded.value ? "MAL_VALUE_TRUE" : "MAL_VALUE_FALSE";
			case "number":
				return `mal_ops_number_value(${input.f64Literal(decoded.value)})`;
			case "string":
				return input.stringValue(decoded.index);
			default:
				return undefined;
		}
	};
	const jump = (target: number): string | undefined => {
		if (target < 0 || target > input.fn.instructions.length) return undefined;
		targets.add(target);
		return `goto F${target};`;
	};

	switch (op.opcode) {
		case "MOVE":
			return `__fast_r${op.dst} = __fast_r${op.src};`;
		case "CREATE_NUMBER":
		case "CREATE_F64":
			return storeNumber(values, op.dst, input.f64Literal(op.value));
		case "CREATE_BOOLEAN":
			return `__fast_r${op.dst} = ${op.value ? "MAL_VALUE_TRUE" : "MAL_VALUE_FALSE"};`;
		case "CREATE_STRING":
			return `__fast_r${op.dst} = ${input.stringValue(op.stringIndex)};`;
		case "CREATE_UNDEFINED":
			return `__fast_r${op.dst} = MAL_VALUE_UNDEFINED;`;
		case "CREATE_NULL":
			return `__fast_r${op.dst} = MAL_VALUE_NULL;`;
		case "LOAD_GLOBAL":
			return `__fast_r${op.dst} = vm->globals[${input.globalIndex(op.index)}];`;
		case "LOAD_GLOBAL_PROPERTY":
			return `if (!mal_vm_global_data_property_cached(vm, ${input.stringIndex(op.nameStringIndex)}, &__fast_r${op.dst})) goto __full;`;
		case "LOAD_INTRINSIC":
			return `__fast_r${op.dst} = vm->intrinsics[${emitIntrinsic(op.intrinsic)}];`;
		case "LOAD_CAPTURED":
			return `__fast_r${op.dst} = ${input.capturedLoad(op.ownerFunctionIndex, op.index)};`;
		case "THROW_IF_TDZ":
			return `if (mal_value_is_empty(__fast_r${op.src})) goto __full;`;
		case "DELETE_PROPERTY": {
			if (!compilerValueKindsHaveEmptyPrimitiveWrappers(values.kind(op.object)))
				return undefined;
			const key = values.kind(op.key);
			if (key === COMPILER_VALUE_KIND_OBJECT) return undefined;
			const boxedKey = value(op.key);
			if ((key & COMPILER_VALUE_KIND_OBJECT) !== 0 && boxedKey === undefined)
				return undefined;
			const guard =
				(key & COMPILER_VALUE_KIND_OBJECT) === 0
					? ""
					: `if (mal_value_is_object(${boxedKey})) goto __full; `;
			return `${guard}__fast_r${op.dst} = MAL_VALUE_TRUE;`;
		}
		case "REQUIRE_COERCIBLE": {
			const kind = values.kind(op.src);
			if ((kind & COMPILER_VALUE_KIND_NULLISH) === 0) return "";
			return compilerValueKindMaskIsSubset(kind, COMPILER_VALUE_KIND_NULLISH)
				? undefined
				: `if (mal_value_is_nil(__fast_r${op.src})) goto __full;`;
		}
		case "LOAD_THIS":
			// A sloppy callee's receiver needs OrdinaryCallBindThis, which can allocate.
			return input.fn.strict ? `__fast_r${op.dst} = this_value;` : undefined;
		case "GUARD_FUNCTION_INDEX":
			return `__fast_r${op.dst} = mal_value_new_boolean(mal_vm_callee_has_index(vm, __fast_r${op.callee}, ${input.functionTargetIndex(op.functionIndex)}));`;
		case "LOAD_PRIVATE": {
			const site = fastClassSite(input, ip);
			if (site?.kind !== "slot") return undefined;
			const probe = fastClassRead(site, ip, op.object, op.dst);
			return op.cached === undefined
				? probe
				: `if (!mal_value_is_empty(__fast_r${op.cached})) __fast_r${op.dst} = __fast_r${op.cached}; else { ${probe} }`;
		}
		case "LOAD_PROPERTY_STATIC":
		case "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT": {
			const field = fieldLoads.get(ip);
			if (field !== undefined) {
				const representation =
					input.directEntry!.fieldParameters!.representations[field]!;
				return `__fast_r${op.dst} = ${boxed(representation, `fp${field}`)};`;
			}
			if (input.instructions[ip]?.kind === "known-own-data")
				return `__fast_r${op.dst} = mal_vm_load_known_own_data(__fast_r${op.object}, mal_value_from_string(vm->string_constant_atoms[${input.stringIndex(op.stringIndex)}]), nullptr);`;
			const classSite = fastClassSite(input, ip);
			if (classSite !== undefined) return fastClassRead(classSite, ip, op.object, op.dst);
			if (op.opcode !== "LOAD_PROPERTY_STATIC") return undefined;
			if (
				input.lengthProperty(op.stringIndex) &&
				values.kind(op.object) === COMPILER_VALUE_KIND_STRING
			)
				return `__fast_r${op.dst} = mal_value_from_i32((i32) mal_string_length(mal_value_to_string(__fast_r${op.object})));`;
			const probe = input.lengthProperty(op.stringIndex)
				? "mal_vm_property_try_load_length_static"
				: "mal_vm_property_try_load_static";
			return `if (!${probe}(vm, __fast_r${op.object}, &__fast_ic[${op.icIndex}], &__fast_r${op.dst})) goto __full;`;
		}
		case "LOAD_PROPERTY": {
			if ((values.kind(op.object) & COMPILER_VALUE_KIND_OBJECT) === 0) return undefined;
			const failure = numbers(values, op.key);
			if (failure === "true") return undefined;
			const guard = failure === "false" ? "" : `${failure} || `;
			const integral = values.isInt32(op.key) || integers.has(op.key);
			const index = integral ? int32(values, op.key) : number(values, op.key);
			const bound =
				integral && (values.range(op.key)?.minimum ?? -1) < 0 ? `${index} < 0 || ` : "";
			const probe = integral
				? `mal_vm_array_try_get_proven_index(__array, (u32) ${index}, &__fast_r${op.dst})`
				: `mal_vm_array_try_get_index(__array, ${index}, &__fast_r${op.dst})`;
			return `{ MalArrayObject *const __array = mal_vm_as_array(__fast_r${op.object}); if (__array == nullptr || ${guard}${bound}!${probe}) goto __full; }`;
		}
		case "BINARY":
			return fastBinary(op, values);
		case "UNARY":
			return fastUnary(op, values);
		case "MATH_UNARY_NUMBER":
			return fastMath(op.operation, [op.src], op.dst, values, value);
		case "MATH_BINARY_NUMBER":
			return fastMath(op.operation, [op.left, op.right], op.dst, values, value);
		case "TYPEOF_COMPARE": {
			const expression = nativeTypeofComparisonExpression(
				`__fast_r${op.src}`,
				values.kind(op.src),
				op.expected,
			);
			if (expression === "true" || expression === "false")
				return `__fast_r${op.dst} = ${(expression === "true") !== op.negated ? "MAL_VALUE_TRUE" : "MAL_VALUE_FALSE"};`;
			return `__fast_r${op.dst} = mal_value_new_boolean(${op.negated ? `!(${expression})` : expression});`;
		}
		case "JUMP":
			return op.targetIp === ip + 1 ? "" : jump(op.targetIp);
		case "JUMP_IF": {
			const target = jump(op.targetIp);
			if (target === undefined) return undefined;
			const constant =
				compilerIntegerRangeTruthiness(values.range(op.cond)) ??
				compilerValueKindTruthiness(values.kind(op.cond));
			if (constant !== undefined) return constant ? target : "";
			return integers.has(op.cond)
				? `if (mal_ops_number_value_to_i32(__fast_r${op.cond}) != 0) ${target}`
				: values.kind(op.cond) === COMPILER_VALUE_KIND_NUMBER
					? `if (mal_number_is_truthy(${number(values, op.cond)})) ${target}`
					: `if (mal_value_is_truthy(__fast_r${op.cond})) ${target}`;
		}
		case "RETURN": {
			const returned = value(op.value);
			return returned === undefined
				? undefined
				: fastReturn(returned, exported ? undefined : input.directEntry, exported);
		}
		case "CALL": {
			const plan = input.instructions[ip];
			const operation =
				plan?.kind === "call" ? plan.guardedBuiltinCall?.operation : undefined;
			const predicate = NUMBER_PREDICATES.get(operation ?? "");
			if (operation !== undefined && predicate !== undefined) {
				const callee = value(op.callee);
				const expression = fastNumberPredicate(
					operation,
					op.arguments.slice(0, op.argumentCount),
					op.dst,
					values,
					value,
				);
				return callee === undefined || expression === undefined
					? undefined
					: `if (!mal_builtin_number_predicate_callee_matches(${predicate}, ${callee})) goto __full; ${expression}`;
			}
			const arity =
				operation === undefined
					? undefined
					: nativeGuardedMathArity(operation, op.argumentCount);
			if (operation !== undefined && arity !== undefined) {
				const callee = value(op.callee);
				const expression = fastMath(
					operation,
					op.arguments.slice(0, op.argumentCount),
					op.dst,
					values,
					value,
				);
				const kind = arity === 1 ? "unary" : "binary";
				return callee === undefined || expression === undefined
					? undefined
					: `if (!mal_builtin_math_${kind}_callee_matches(MAL_MATH_${kind.toUpperCase()}_${operation.slice("Math.".length).toUpperCase()}, ${callee})) goto __full; ${expression}`;
			}
			if (plan?.kind === "call" && plan.guardedBuiltinCall?.operation === "Object.is") {
				const callee = value(op.callee);
				const expression = fastSameValue(
					op.arguments.slice(0, op.argumentCount),
					values,
					value,
				);
				return callee === undefined || expression === undefined
					? undefined
					: `if (!mal_builtin_object_is_callee_matches(${callee})) goto __full; __fast_r${op.dst} = mal_value_new_boolean(${expression});`;
			}
			const callee =
				op.callee < 0 ? undefined : input.calleeTry(ip, `__fast_r${op.callee}`);
			const receiver = value(op.thisValue);
			const args = op.arguments.slice(0, op.argumentCount).map(value);
			if (
				callee === undefined ||
				op.callee < 0 ||
				receiver === undefined ||
				args.some((arg) => arg === undefined)
			)
				return undefined;
			const list =
				args.length === 0 ? "nullptr" : `(const MalValue[]){ ${args.join(", ")} }`;
			const guards = callee.guard === undefined ? [] : [`!(${callee.guard})`];
			const arguments_ =
				callee.parameters === undefined
					? `${list}, ${args.length}`
					: callee.parameters
							.map((kind, index) => {
								const boxed = args[index] ?? "MAL_VALUE_UNDEFINED";
								if (kind === "boxed") return boxed;
								const register = op.arguments[index];
								const scalar =
									register === undefined || index >= op.argumentCount
										? undefined
										: exactInteger(values, register);
								if (scalar !== undefined) return scalar;
								guards.push(`!mal_value_is_int32(${boxed})`);
								return `mal_value_to_i32(${boxed})`;
							})
							.join(", ");
			return `if (${guards.length === 0 ? "" : `${guards.join(" || ")} || `}!${callee.symbol}(vm, ${receiver}, ${arguments_}, ${callee.environment}, &__fast_r${op.dst})) goto __full;`;
		}
		case "CALL_KNOWN": {
			if (
				op.construct ||
				op.argumentMode !== undefined ||
				(op.specialized !== undefined && op.specialized !== op.operation)
			)
				return undefined;
			if (OBJECT_BRAND_PREDICATES.has(op.operation)) {
				const argument = op.arguments[0];
				const boxed = argument === undefined ? "MAL_VALUE_UNDEFINED" : value(argument);
				const predicate =
					boxed === undefined
						? undefined
						: nativeObjectBrandPredicateExpression(op.operation, boxed);
				return predicate === undefined
					? undefined
					: `__fast_r${op.dst} = mal_value_new_boolean(${predicate});`;
			}
			if (NUMBER_PREDICATES.has(op.operation))
				return fastNumberPredicate(
					op.operation,
					op.arguments.slice(0, op.argumentCount),
					op.dst,
					values,
					value,
				);
			if (op.operation !== "Object.is")
				return fastMath(
					op.operation,
					op.arguments.slice(0, op.argumentCount),
					op.dst,
					values,
					value,
				);
			const expression = fastSameValue(op.arguments, values, value);
			return expression === undefined
				? undefined
				: `__fast_r${op.dst} = mal_value_new_boolean(${expression});`;
		}
		default:
			return undefined;
	}
}

function fastNumberPredicate(
	operation: string,
	args: ReadonlyArray<number>,
	dst: number,
	values: FastNumbers,
	value: (operand: number) => string | undefined,
): string | undefined {
	const input = args[0];
	const boxed = input === undefined ? undefined : value(input);
	if (input !== undefined && boxed === undefined) return undefined;
	const kind = input === undefined ? COMPILER_VALUE_KIND_UNDEFINED : values.kind(input);
	const expression = nativeNumberPredicateInputExpression(
		operation,
		boxed,
		kind,
		input !== undefined && kind === COMPILER_VALUE_KIND_NUMBER
			? equalityScalar(values, input, boxed!)
			: undefined,
		input === undefined ? undefined : values.range(input),
	);
	return `__fast_r${dst} = mal_value_new_boolean(${expression});`;
}

function fastMath(
	operation: string,
	args: ReadonlyArray<number>,
	dst: number,
	values: FastNumbers,
	value: (operand: number) => string | undefined,
): string | undefined {
	const arity = nativeMathNumberArity(operation, args.length);
	if (arity === undefined) return undefined;
	const numbers: Array<string> = [],
		guards: Array<string> = [],
		ranges: Array<CompilerIntegerRange | undefined> = [];
	for (let index = 0; index < arity; index++) {
		const argument = args[index];
		if (argument === undefined) {
			numbers.push("NAN");
			ranges.push(undefined);
			continue;
		}
		const boxed = value(argument);
		if (boxed === undefined) return undefined;
		const kind = values.kind(argument);
		let numeric: string;
		if (compilerValueKindMaskIsSubset(kind, COMPILER_VALUE_KIND_TO_NUMBER_PRIMITIVE))
			numeric =
				kind === COMPILER_VALUE_KIND_NUMBER && argument >= 0
					? number(values, argument)
					: nativePrimitiveNumberExpression(boxed, kind);
		else {
			if ((kind & COMPILER_VALUE_KIND_NUMBER) === 0) return undefined;
			guards.push(`!mal_ops_is_number(${boxed})`);
			numeric = `mal_ops_number_as_f64(${boxed})`;
		}
		numbers.push(numeric);
		ranges.push(values.range(argument));
	}
	const expression = nativeNumericBuiltinExpr(operation, numbers, ranges);
	if (expression === null) return undefined;
	return `${guards.length === 0 ? "" : `if (${guards.join(" || ")}) goto __full; `}${storeNumber(values, dst, expression)}`;
}

function fastSameValue(
	args: ReadonlyArray<number>,
	values: FastNumbers,
	value: (operand: number) => string | undefined,
): string | undefined {
	const [left, right] = args;
	const a = left === undefined ? "MAL_VALUE_UNDEFINED" : value(left);
	const b = right === undefined ? "MAL_VALUE_UNDEFINED" : value(right);
	if (a === undefined || b === undefined) return undefined;
	const constant = nativeStringComparisonExpression(values.stringComparison, left!, a, b);
	if (constant !== undefined) return constant;
	return nativeEqualityExpression(
		"same-value",
		a,
		b,
		left === undefined ? COMPILER_VALUE_KIND_UNDEFINED : values.kind(left),
		right === undefined ? COMPILER_VALUE_KIND_UNDEFINED : values.kind(right),
		left === undefined ? undefined : equalityScalar(values, left, a),
		right === undefined ? undefined : equalityScalar(values, right, b),
		left !== undefined &&
			right !== undefined &&
			values.isInt32(left) &&
			values.isInt32(right),
		left === undefined ? undefined : values.range(left),
		right === undefined ? undefined : values.range(right),
	);
}
