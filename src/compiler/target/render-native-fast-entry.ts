import {
	compilerTypeofComparison,
	compilerValueKindTruthiness,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_NULLISH,
	COMPILER_VALUE_KIND_TO_NUMBER_PRIMITIVE,
	compilerValueKindMaskIsSubset,
} from "../shared/compiler-value-kinds.ts";
import {
	instructionInputIsInt32,
	instructionInputIntegerRange,
	instructionInputKind,
} from "../shared/instruction-facts.ts";
import type { CompilerIntegerRange } from "../shared/integer-range.ts";
import {
	compilerIntegerRangeComparison,
	compilerIntegerRangeTruthiness,
} from "../shared/integer-range.ts";
import { emitTypeofResult } from "./emit-program-image.ts";
import type { NativeControlFlowPlan } from "./native-control-flow.ts";
import { nativePrimitiveNumberExpression } from "./native-scalar-operators.ts";
import {
	nativeInstructionSourceRanges,
	shiftNativeSourceRanges,
} from "./native-source-map.ts";
import type { NativeSourceRange } from "./native-source-map.ts";
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

export interface NativeFastEntryInput {
	readonly onSourceMap?: (ranges: ReadonlyArray<NativeSourceRange>) => void;
	readonly fn: BytecodeFunction;
	readonly facts: NativeFunctionPlan["facts"];
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
	readonly globalIndex: (index: number) => string;
	readonly stringValue: (index: number) => string;
	readonly lengthProperty: (stringIndex: number) => boolean;
	/** Non-allocating statements that bind what `capturedLoad` reads. */
	readonly capturePrologue: ReadonlyArray<string>;
	readonly capturedLoad: (ownerFunctionIndex: number, index: number) => string;
	/** The fast body a CALL's proven exact target exports, if any, and its environment argument. */
	readonly calleeTry: (
		ip: number,
		callee: string,
	) => { readonly symbol: string; readonly environment: string } | undefined;
	readonly f64Literal: (value: number) => string;
}

/**
 * A frameless entry for a short loop-free body of side-effect-free reads: it runs the
 * body while every named load hits its cache, every indexed load reads a dense Array
 * element, every operator stays on Numbers, and every call reaches another such body
 * that succeeds, and otherwise restarts the activation in the full entry. Nothing
 * observable happens before a restart, and nothing can allocate, so it needs no frame
 * row, root frame, or safepoint. Undefined when the body needs any of them.
 */
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
		alwaysRestarts(fn, directEntry, new Set([...unreachable, ...elided])) ||
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
	const graph = fastEntryGraph(fn.instructions, branches, unreachable);
	if (hasCycle(graph)) return undefined;
	const accesses = new Map(
		[...graph.keys()].map((ip) => [
			ip,
			{
				reads:
					branches.has(ip) || elided.has(ip)
						? []
						: vmInstructionReadRegisters(fn.instructions[ip]!),
				writes: elided.has(ip) ? [] : vmInstructionWriteRegisters(fn.instructions[ip]!),
			},
		]),
	);
	const registers = new Set<number>();
	for (const { reads, writes } of accesses.values())
		for (const register of [...reads, ...writes]) registers.add(register);
	const exported = input.trySymbol !== undefined;
	const result = exported ? undefined : directEntry;
	const fieldLoads = new Map(
		directEntry?.fieldParameters?.loads.map((load) => [load.instructionIp, load.field]),
	);
	const targets = new Set<number>();
	const body: Array<readonly [number, string]> = [];
	let loadsProperties = false;
	let loadsCaptures = false;
	const instructions = [...graph.keys()]
		.filter((ip) => !elided.has(ip))
		.map((ip) => fn.instructions[ip]!);
	const constants = numberConstantRegisters(instructions, registers);
	const stringComparisons = new Map(
		input.stringComparisons.map((plan) => [plan.instructionIp, plan]),
	);
	const integers = int32ResultRegisters(instructions, fn.parameterCount, registers);
	const initialized = initializedFastRegisters(graph, accesses, registers);
	for (const register of constants.keys())
		if (!initialized.has(register)) constants.delete(register);
	for (const register of integers)
		if (!initialized.has(register)) integers.delete(register);
	for (const [ip, op] of fn.instructions.entries()) {
		if (unreachable.has(ip)) continue;
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
					);
		if (line === undefined) return undefined;
		if (op.opcode === "LOAD_PROPERTY_STATIC" && !fieldLoads.has(ip))
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

	const locals = [...registers].sort((left, right) => left - right);
	const fast = [
		...input.prologue,
		...(locals.length === 0
			? []
			: [`    MalValue ${locals.map((r) => `f${r}`).join(", ")};`]),
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
				? [`    f${register} = ${fastParameter(register, directEntry)};`]
				: initialized.has(register)
					? []
					: [`    f${register} = MAL_VALUE_UNDEFINED;`],
		),
		...lines,
	];
	const full = `    return ${input.fullSymbol}(${input.fullArguments.join(", ")});`;
	// C admits the pragma only before the body's first statement.
	const pragma = "#pragma STDC FP_CONTRACT OFF";
	const emit = (output: ReadonlyArray<string>): ReadonlyArray<string> => {
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
				nativeInstructionSourceRanges(fn, lines.slice(0, mappedLineCount), starts, ips),
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
	return emit([
		`${linkage}__attribute__((no_stack_protector)) __attribute__((aligned(64))) bool ${input.trySymbol}(${FAST_TRY_PARAMETERS}) {`,
		pragma,
		...fast,
		"__full:",
		"    return false;",
		"}",
		input.signature,
		"    MalValue __fast_result;",
		`    if (${fn.hasPrototype ? "mal_value_is_undefined(new_target) && " : ""}${input.trySymbol}(vm, this_value, args, arg_count, env, &__fast_result)) return __fast_result;`,
		full,
		"}",
	]);
}

/** Parameters of an exported fast body; it reports success and writes the result. */
export const FAST_TRY_PARAMETERS =
	"MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalEnv *env, MalValue *out";

const EQUALITY_OPERATORS: ReadonlySet<string> = new Set(["===", "!==", "==", "!="]);

// An operator proven never to see a Number would restart on every call.
function alwaysRestarts(
	fn: BytecodeFunction,
	directEntry: NativeDirectEntryPlan | undefined,
	unreachable: ReadonlySet<number>,
): boolean {
	return (directEntry?.instructionFacts ?? []).some(({ instructionIp, masks }) => {
		if (unreachable.has(instructionIp)) return false;
		const op = fn.instructions[instructionIp];
		const numeric =
			(op?.opcode === "BINARY" && !EQUALITY_OPERATORS.has(op.operator)) ||
			(op?.opcode === "UNARY" && op.operator !== "!");
		return numeric && masks.some((mask) => (mask & COMPILER_VALUE_KIND_NUMBER) === 0);
	});
}

function fastEntryGraph(
	instructions: ReadonlyArray<BytecodeInstruction>,
	branches: ReadonlyMap<number, number>,
	unreachable: ReadonlySet<number>,
): ReadonlyMap<number, ReadonlyArray<number>> {
	const graph = new Map<number, ReadonlyArray<number>>();
	for (const [ip, op] of instructions.entries()) {
		if (unreachable.has(ip)) continue;
		const target = branches.get(ip);
		graph.set(
			ip,
			target !== undefined
				? [target]
				: op.opcode === "RETURN"
					? []
					: op.opcode === "JUMP"
						? [op.targetIp]
						: op.opcode === "JUMP_IF"
							? [op.targetIp, ip + 1]
							: [ip + 1],
		);
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
): string {
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

interface FastNumbers {
	readonly kind: (register: number) => number;
	readonly isInt32: (register: number) => boolean;
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
		.map((register) => `!mal_ops_is_number(f${register})`);
	return checks.length === 0 ? "false" : checks.join(" || ");
}

function number(values: FastNumbers, register: number): string {
	const constant = values.constants.get(register);
	return constant === undefined
		? `mal_ops_number_as_f64(f${register})`
		: values.literal(constant);
}

function int32(values: FastNumbers, register: number): string {
	const constant = values.constants.get(register);
	return constant === undefined
		? values.isInt32(register)
			? `((i32) ${number(values, register)})`
			: `mal_ops_number_value_to_i32(f${register})`
		: `((i32) ${constant | 0})`;
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
		return `f${dst} = ${compared ? "MAL_VALUE_TRUE" : "MAL_VALUE_FALSE"};`;
	const numberFailure = numbers(values, left, right);
	const guard = numberFailure === "false" ? "" : `if (${numberFailure}) goto __full;`;
	if (operator === "===" || operator === "!==") {
		const constant = values.stringComparison;
		const equal =
			constant === undefined
				? `mal_ops_strict_equal_boxed(f${left}, f${right})`
				: constant.kind === "strings"
					? `mal_string_equals_constant_length(mal_value_to_string(f${constant.register === right ? left : right}), mal_value_to_string(f${constant.register}), ${constant.length})`
					: `mal_ops_strict_equal_string_constant(f${constant.register === right ? left : right}, f${constant.register}, ${constant.length})`;
		return `f${dst} = mal_value_new_boolean(${operator === "!==" ? "!" : ""}${equal});`;
	}
	if (operator === "==" || operator === "!=") {
		const not = operator === "!=" ? "!" : "";
		const numeric = `f${dst} = mal_value_new_boolean(${not}(${number(values, left)} == ${number(values, right)}));`;
		if (numberFailure === "false") return numeric;
		const nullish =
			(values.kind(left) | values.kind(right)) & COMPILER_VALUE_KIND_NULLISH;
		if (numberFailure === "true" && nullish === 0) return undefined;
		const fallback =
			nullish === 0
				? "goto __full;"
				: `if (mal_value_is_nil(f${left}) || mal_value_is_nil(f${right})) f${dst} = mal_value_new_boolean(${not}(mal_value_is_nil(f${left}) && mal_value_is_nil(f${right}))); else goto __full;`;
		return numberFailure === "true"
			? fallback
			: `if (!(${numberFailure})) ${numeric} else ${fallback}`;
	}
	if (numberFailure === "true") return undefined;
	if (NUMBER_COMPARISONS.has(operator))
		return `${guard} f${dst} = mal_value_new_boolean(${number(values, left)} ${operator} ${number(values, right)});`;
	if (INT32_OPERATORS.has(operator))
		return `${guard} f${dst} = mal_value_from_i32(${int32(values, left)} ${operator} ${int32(values, right)});`;
	if (operator === "<<")
		return `${guard} f${dst} = mal_value_from_i32((i32) ((u32) ${int32(values, left)} << ((u32) ${int32(values, right)} & 31u)));`;
	if (operator === ">>")
		return `${guard} f${dst} = mal_value_from_i32(${int32(values, left)} >> ((u32) ${int32(values, right)} & 31u));`;
	if (operator === ">>>")
		return `${guard} f${dst} = mal_ops_number_value((f64) ((u32) ${int32(values, left)} >> ((u32) ${int32(values, right)} & 31u)));`;
	if (NUMBER_OPERATORS.has(operator))
		return `${guard} f${dst} = mal_ops_number_value(${number(values, left)} ${operator} ${number(values, right)});`;
	if (operator === "%")
		return `${guard} f${dst} = mal_ops_number_value(fmod(${number(values, left)}, ${number(values, right)}));`;
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
		? nativePrimitiveNumberExpression(`f${src}`, values.kind(src))
		: number(values, src);
	switch (operator) {
		case "!": {
			const constant =
				compilerIntegerRangeTruthiness(values.range(src)) ??
				compilerValueKindTruthiness(values.kind(src));
			return constant === undefined
				? `f${dst} = mal_value_new_boolean(!mal_value_is_truthy(f${src}));`
				: `f${dst} = ${constant ? "MAL_VALUE_FALSE" : "MAL_VALUE_TRUE"};`;
		}
		case "-":
			return `${guard} f${dst} = mal_ops_number_value(-${numeric});`;
		case "+":
		case "tonumeric":
			return converts
				? `f${dst} = mal_ops_number_value(${numeric});`
				: `${guard} f${dst} = f${src};`;
		case "~":
			return `${guard} f${dst} = mal_value_from_i32(~${converts ? `mal_ops_number_to_i32(${numeric})` : int32(values, src)});`;
		case "increment":
			return `${guard} f${dst} = mal_ops_number_value(${numeric} + 1.0);`;
		case "decrement":
			return `${guard} f${dst} = mal_ops_number_value(${numeric} - 1.0);`;
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
): string | undefined {
	const masks = input.facts?.[ip]?.inputKindMasks;
	const values: FastNumbers = {
		range: (register) => instructionInputIntegerRange(input.facts?.[ip], register),
		isInt32: (register) => instructionInputIsInt32(input.facts?.[ip], register),
		kind(register) {
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
		if (operand >= 0) return `f${operand}`;
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
			return `f${op.dst} = f${op.src};`;
		case "CREATE_NUMBER":
		case "CREATE_F64":
			return `f${op.dst} = mal_ops_number_value(${input.f64Literal(op.value)});`;
		case "CREATE_BOOLEAN":
			return `f${op.dst} = ${op.value ? "MAL_VALUE_TRUE" : "MAL_VALUE_FALSE"};`;
		case "CREATE_STRING":
			return `f${op.dst} = ${input.stringValue(op.stringIndex)};`;
		case "CREATE_UNDEFINED":
			return `f${op.dst} = MAL_VALUE_UNDEFINED;`;
		case "CREATE_NULL":
			return `f${op.dst} = MAL_VALUE_NULL;`;
		case "LOAD_GLOBAL":
			return `f${op.dst} = vm->globals[${input.globalIndex(op.index)}];`;
		case "LOAD_CAPTURED":
			return `f${op.dst} = ${input.capturedLoad(op.ownerFunctionIndex, op.index)};`;
		case "THROW_IF_TDZ":
			return `if (mal_value_is_empty(f${op.src})) goto __full;`;
		case "LOAD_THIS":
			// A sloppy callee's receiver needs OrdinaryCallBindThis, which can allocate.
			return input.fn.strict ? `f${op.dst} = this_value;` : undefined;
		case "LOAD_PROPERTY_STATIC": {
			const field = fieldLoads.get(ip);
			if (field !== undefined) {
				const representation =
					input.directEntry!.fieldParameters!.representations[field]!;
				return `f${op.dst} = ${boxed(representation, `fp${field}`)};`;
			}
			const probe = input.lengthProperty(op.stringIndex)
				? "mal_vm_property_try_load_length_static"
				: "mal_vm_property_try_load_static";
			return `if (!${probe}(vm, f${op.object}, &__fast_ic[${op.icIndex}], &f${op.dst})) goto __full;`;
		}
		case "LOAD_PROPERTY":
			return `{ MalArrayObject *const __array = mal_vm_as_array(f${op.object}); if (__array == nullptr || !mal_ops_is_number(f${op.key}) || !mal_vm_array_try_get_index(__array, mal_ops_number_as_f64(f${op.key}), &f${op.dst})) goto __full; }`;
		case "BINARY":
			return fastBinary(op, values);
		case "UNARY":
			return fastUnary(op, values);
		case "TYPEOF_COMPARE": {
			const result = compilerTypeofComparison(values.kind(op.src), op.expected);
			if (result !== undefined)
				return `f${op.dst} = ${result !== op.negated ? "MAL_VALUE_TRUE" : "MAL_VALUE_FALSE"};`;
			return `f${op.dst} = mal_value_new_boolean(${op.negated ? "!" : ""}mal_vm_typeof_compare(f${op.src}, ${emitTypeofResult(op.expected)}));`;
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
				? `if (mal_ops_number_value_to_i32(f${op.cond}) != 0) ${target}`
				: `if (mal_value_is_truthy(f${op.cond})) ${target}`;
		}
		case "RETURN": {
			const returned = value(op.value);
			return returned === undefined
				? undefined
				: fastReturn(returned, exported ? undefined : input.directEntry, exported);
		}
		case "CALL": {
			const callee = op.callee < 0 ? undefined : input.calleeTry(ip, `f${op.callee}`);
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
			return `if (!${callee.symbol}(vm, ${receiver}, ${list}, ${args.length}, ${callee.environment}, &f${op.dst})) goto __full;`;
		}
		default:
			return undefined;
	}
}
