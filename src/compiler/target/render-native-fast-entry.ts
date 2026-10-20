import { COMPILER_VALUE_KIND_NUMBER } from "../shared/compiler-value-kinds.ts";
import { emitTypeofResult } from "./emit-program-image.ts";
import type { NativeDirectEntryPlan, VmRegisterRepresentation } from "./program-image.ts";
import type { BytecodeFunction, BytecodeInstruction } from "./runtime-image.ts";

const MAXIMUM_FAST_ENTRY_INSTRUCTIONS = 64;

export interface NativeFastEntryInput {
	readonly fn: BytecodeFunction;
	readonly directEntry: NativeDirectEntryPlan | undefined;
	/** The full entry already answers this body without a frame or with a better dispatch. */
	readonly specialized: boolean;
	/** The original entry signature, ending in `{`. */
	readonly signature: string;
	readonly fullSymbol: string;
	readonly fullArguments: ReadonlyArray<string>;
	readonly prologue: ReadonlyArray<string>;
	/** C expression for this function's property-cache row. */
	readonly functionIndex: string;
	readonly globalIndex: (index: number) => string;
	readonly stringValue: (index: number) => string;
	/** Non-allocating statements that bind what `capturedLoad` reads. */
	readonly capturePrologue: ReadonlyArray<string>;
	readonly capturedLoad: (ownerFunctionIndex: number, index: number) => string;
	readonly f64Literal: (value: number) => string;
}

/**
 * A frameless entry for a short loop-free body of side-effect-free reads: it runs the
 * body while every property load hits its cache and every operator stays on Numbers,
 * and otherwise restarts the activation in the full entry. Nothing observable happens
 * before a restart, and nothing can allocate or call, so it needs no frame row, root
 * frame, or safepoint. Undefined when the body needs any of them.
 */
export function renderNativeFastEntry(
	input: NativeFastEntryInput,
): ReadonlyArray<string> | undefined {
	const { fn, directEntry } = input;
	if (
		input.specialized ||
		alwaysRestarts(fn, directEntry) ||
		fn.isGenerator ||
		fn.isAsync ||
		fn.isClassConstructor ||
		fn.isDerivedConstructor ||
		fn.capturedCount !== 0 ||
		fn.mappedArguments ||
		fn.needsArguments ||
		fn.argumentSnapshotCount !== 0 ||
		fn.handlers.length !== 0 ||
		fn.instructions.length > MAXIMUM_FAST_ENTRY_INSTRUCTIONS ||
		hasCycle(fn.instructions)
	)
		return undefined;
	const fieldLoads = new Map(
		directEntry?.fieldParameters?.loads.map((load) => [load.instructionIp, load.field]),
	);
	const targets = new Set<number>();
	const body: Array<string> = [];
	let loadsProperties = false;
	let loadsCaptures = false;
	for (const [ip, op] of fn.instructions.entries()) {
		const line = fastInstruction(op, ip, input, fieldLoads, targets);
		if (line === undefined) return undefined;
		if (op.opcode === "LOAD_PROPERTY_STATIC" && !fieldLoads.has(ip))
			loadsProperties = true;
		if (op.opcode === "LOAD_CAPTURED") loadsCaptures = true;
		body.push(line);
	}
	const lines: Array<string> = [];
	for (const [ip, line] of body.entries()) {
		if (targets.has(ip)) lines.push(`F${ip}:;`);
		lines.push(`    ${line}`);
	}
	if (targets.has(fn.instructions.length)) lines.push(`F${fn.instructions.length}:;`);
	lines.push(`    ${fastReturn("MAL_VALUE_UNDEFINED", directEntry)}`);

	const registers = Array.from(
		{ length: fn.registerCount },
		(_, register) => `f${register}`,
	);
	const guards = [
		"!mal_vm_leaf_unobserved(vm)",
		"!mal_vm_leaf_stack_available(vm)",
		...(directEntry === undefined && fn.hasPrototype
			? ["!mal_value_is_undefined(new_target)"]
			: []),
	];
	return [
		input.signature,
		"#pragma STDC FP_CONTRACT OFF",
		...input.prologue,
		...(registers.length === 0 ? [] : [`    MalValue ${registers.join(", ")};`]),
		`    if (${guards.join(" || ")}) goto __full;`,
		...(loadsProperties
			? [
					`    MalInlineCache *const __fast_ic = vm->property_cache[${input.functionIndex}].sites;`,
					"    if (__fast_ic == nullptr) goto __full;",
				]
			: []),
		...(loadsCaptures ? input.capturePrologue.map((line) => `    ${line}`) : []),
		...registers.map((register, index) =>
			index < fn.parameterCount
				? `    ${register} = ${fastParameter(index, directEntry)};`
				: `    ${register} = MAL_VALUE_UNDEFINED;`,
		),
		...lines,
		"__full:",
		`    return ${input.fullSymbol}(${input.fullArguments.join(", ")});`,
		"}",
	];
}

const EQUALITY_OPERATORS: ReadonlySet<string> = new Set(["===", "!==", "==", "!="]);

// An operator proven never to see a Number would restart on every call.
function alwaysRestarts(
	fn: BytecodeFunction,
	directEntry: NativeDirectEntryPlan | undefined,
): boolean {
	return (directEntry?.operatorInputs ?? []).some(({ instructionIp, masks }) => {
		const op = fn.instructions[instructionIp];
		const numeric =
			(op?.opcode === "BINARY" && !EQUALITY_OPERATORS.has(op.operator)) ||
			(op?.opcode === "UNARY" && op.operator !== "!");
		return numeric && masks.some((mask) => (mask & COMPILER_VALUE_KIND_NUMBER) === 0);
	});
}

// A loop needs a poll, and a poll needs a frame.
function hasCycle(instructions: ReadonlyArray<BytecodeInstruction>): boolean {
	const state = new Uint8Array(instructions.length);
	const successors = (ip: number): ReadonlyArray<number> => {
		const op = instructions[ip]!;
		switch (op.opcode) {
			case "RETURN":
				return [];
			case "JUMP":
				return [op.targetIp];
			case "JUMP_IF":
				return [op.targetIp, ip + 1];
			default:
				return [ip + 1];
		}
	};
	const visit = (ip: number): boolean => {
		if (ip < 0 || ip >= instructions.length || state[ip] === 2) return false;
		if (state[ip] === 1) return true;
		state[ip] = 1;
		if (successors(ip).some(visit)) return true;
		state[ip] = 2;
		return false;
	};
	return visit(0);
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
): string {
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

function numbers(...registers: ReadonlyArray<number>): string {
	return registers.map((register) => `!mal_ops_is_number(f${register})`).join(" || ");
}

function number(register: number): string {
	return `mal_ops_number_as_f64(f${register})`;
}

function int32(register: number): string {
	return `mal_ops_number_to_i32(${number(register)})`;
}

const NUMBER_COMPARISONS: ReadonlySet<string> = new Set(["<", "<=", ">", ">="]);
const INT32_OPERATORS: ReadonlySet<string> = new Set(["&", "|", "^"]);
const NUMBER_OPERATORS: ReadonlySet<string> = new Set(["+", "-", "*", "/"]);

function fastBinary(
	op: Extract<BytecodeInstruction, { opcode: "BINARY" }>,
): string | undefined {
	const { dst, left, right, operator } = op;
	const guard = `if (${numbers(left, right)}) goto __full;`;
	if (operator === "===" || operator === "!==")
		return `f${dst} = mal_value_new_boolean(${operator === "!==" ? "!" : ""}mal_ops_strict_equal_boxed(f${left}, f${right}));`;
	if (operator === "==" || operator === "!=") {
		// Only Number pairs and nullish operands avoid ToPrimitive and string comparison.
		const not = operator === "!=" ? "!" : "";
		return `if (mal_ops_is_number(f${left}) && mal_ops_is_number(f${right})) f${dst} = mal_value_new_boolean(${not}(${number(left)} == ${number(right)})); else if (mal_value_is_nil(f${left}) || mal_value_is_nil(f${right})) f${dst} = mal_value_new_boolean(${not}(mal_value_is_nil(f${left}) && mal_value_is_nil(f${right}))); else goto __full;`;
	}
	if (NUMBER_COMPARISONS.has(operator))
		return `${guard} f${dst} = mal_value_new_boolean(${number(left)} ${operator} ${number(right)});`;
	if (INT32_OPERATORS.has(operator))
		return `${guard} f${dst} = mal_value_from_i32(${int32(left)} ${operator} ${int32(right)});`;
	if (operator === "<<")
		return `${guard} f${dst} = mal_value_from_i32((i32) ((u32) ${int32(left)} << ((u32) ${int32(right)} & 31u)));`;
	if (operator === ">>")
		return `${guard} f${dst} = mal_value_from_i32(${int32(left)} >> ((u32) ${int32(right)} & 31u));`;
	if (operator === ">>>")
		return `${guard} f${dst} = mal_ops_number_value((f64) ((u32) ${int32(left)} >> ((u32) ${int32(right)} & 31u)));`;
	if (NUMBER_OPERATORS.has(operator))
		return `${guard} f${dst} = mal_ops_number_value(${number(left)} ${operator} ${number(right)});`;
	if (operator === "%")
		return `${guard} f${dst} = mal_ops_number_value(fmod(${number(left)}, ${number(right)}));`;
	return undefined;
}

function fastUnary(
	op: Extract<BytecodeInstruction, { opcode: "UNARY" }>,
): string | undefined {
	const { dst, src, operator } = op;
	const guard = `if (${numbers(src)}) goto __full;`;
	switch (operator) {
		case "!":
			return `f${dst} = mal_value_new_boolean(!mal_value_is_truthy(f${src}));`;
		case "-":
			return `${guard} f${dst} = mal_ops_number_value(-${number(src)});`;
		case "+":
		case "tonumeric":
			return `${guard} f${dst} = f${src};`;
		case "~":
			return `${guard} f${dst} = mal_value_from_i32(~${int32(src)});`;
		case "increment":
			return `${guard} f${dst} = mal_ops_number_value(${number(src)} + 1.0);`;
		case "decrement":
			return `${guard} f${dst} = mal_ops_number_value(${number(src)} - 1.0);`;
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
): string | undefined {
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
			return `if (!mal_vm_property_try_load_static(vm, f${op.object}, &__fast_ic[${op.icIndex}], &f${op.dst})) goto __full;`;
		}
		case "BINARY":
			return fastBinary(op);
		case "UNARY":
			return fastUnary(op);
		case "TYPEOF_COMPARE":
			return `f${op.dst} = mal_value_new_boolean(${op.negated ? "!" : ""}mal_vm_typeof_compare(f${op.src}, ${emitTypeofResult(op.expected)}));`;
		case "JUMP":
			return jump(op.targetIp);
		case "JUMP_IF": {
			const target = jump(op.targetIp);
			return target === undefined
				? undefined
				: `if (mal_value_is_truthy(f${op.cond})) ${target}`;
		}
		case "RETURN":
			return fastReturn(`f${op.value}`, input.directEntry);
		default:
			return undefined;
	}
}
