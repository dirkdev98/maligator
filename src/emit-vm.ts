import type { VmDefinition, VmInstruction } from "./lower-vm.ts";

type VmBinaryOperator = Extract<VmInstruction, { opcode: "BINARY" }>["operator"];

/**
 * Emit a C translation unit with the static MalVmDefinition data.
 */
export function emitVmDefinition(definition: VmDefinition) {
	const lines = ['#include "vm.h"', ""];

	for (let i = 0; i < definition.stringConstants.length; ++i) {
		const constant = definition.stringConstants[i]!;
		lines.push(
			`static const c16 mal_string_${i}_code_units[] = { ${constant.length > 0 ? constant.join(", ") : "0"} };`,
		);
	}

	if (definition.stringConstants.length > 0) {
		lines.push("", "static const MalStringConstant mal_string_constants[] = {");
		for (let i = 0; i < definition.stringConstants.length; ++i) {
			const constant = definition.stringConstants[i]!;
			lines.push(
				`    { .length = ${constant.length}, .code_units = mal_string_${i}_code_units },`,
			);
		}
		lines.push("};", "");
	}

	for (let i = 0; i < definition.functions.length; ++i) {
		const fn = definition.functions[i]!;
		lines.push(`static const MalInstruction mal_function_${i}_instructions[] = {`);

		for (const instruction of fn.instructions) {
			lines.push(`    ${emitInstruction(instruction)},`);
		}

		lines.push("};", "");

		if (fn.handlers.length > 0) {
			lines.push(`static const MalExceptionHandler mal_function_${i}_handlers[] = {`);
			for (const handler of fn.handlers) {
				lines.push(
					`    { .start_ip = ${handler.startIp}, .end_ip = ${handler.endIp}, .handler_ip = ${handler.handlerIp} },`,
				);
			}
			lines.push("};", "");
		}
	}

	lines.push("static const MalFunction mal_functions[] = {");
	for (let i = 0; i < definition.functions.length; ++i) {
		const fn = definition.functions[i]!;
		lines.push("    {");
		lines.push(`        .name_string_index = ${fn.nameStringIndex},`);
		lines.push(`        .parameter_count = ${fn.parameterCount},`);
		lines.push(`        .register_count = ${fn.registerCount},`);
		lines.push(`        .captured_count = ${fn.capturedCount},`);
		lines.push(`        .instruction_count = ${fn.instructions.length},`);
		lines.push(`        .instructions = mal_function_${i}_instructions,`);
		lines.push(`        .handler_count = ${fn.handlers.length},`);
		lines.push(
			`        .handlers = ${fn.handlers.length > 0 ? `mal_function_${i}_handlers` : "nullptr"},`,
		);
		lines.push("    },");
	}
	lines.push("};", "");

	lines.push("const MalVmDefinition mal_vm_definition = {");
	lines.push(`    .function_count = ${definition.functionCount},`);
	lines.push("    .functions = mal_functions,");
	lines.push(`    .string_constant_count = ${definition.stringConstants.length},`);
	lines.push(
		`    .string_constants = ${definition.stringConstants.length > 0 ? "mal_string_constants" : "nullptr"},`,
	);
	lines.push(`    .global_count = ${definition.globalCount},`);
	lines.push("};");

	return lines.join("\n");
}

function emitInstruction(instruction: VmInstruction) {
	switch (instruction.opcode) {
		case "MOVE":
			return `{ .opcode = MAL_OP_MOVE, .as.move = { .dst = ${instruction.dst}, .src = ${instruction.src} } }`;
		case "RETURN":
			return `{ .opcode = MAL_OP_RETURN, .as.ret = { .value = ${instruction.value} } }`;
		case "JUMP_IF":
			return `{ .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = ${instruction.cond}, .target_ip = ${instruction.targetIp} } }`;
		case "JUMP":
			return `{ .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = ${instruction.targetIp} } }`;
		case "CREATE_NUMBER":
			return `{ .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = ${instruction.dst}, .value = ${instruction.value} } }`;
		case "CREATE_F64":
			// JS number stringification round-trips as a C double literal.
			return `{ .opcode = MAL_OP_CREATE_F64, .as.create_f64 = { .dst = ${instruction.dst}, .value = ${instruction.value} } }`;
		case "CREATE_BOOLEAN":
			return `{ .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = ${instruction.dst}, .value = ${instruction.value ? 1 : 0} } }`;
		case "CREATE_STRING":
			return `{ .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = ${instruction.dst}, .string_index = ${instruction.stringIndex} } }`;
		case "CREATE_OBJECT":
			return `{ .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = ${instruction.dst} } }`;
		case "CREATE_ARRAY":
			return `{ .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = ${instruction.dst}, .length = ${instruction.length} } }`;
		case "CREATE_UNDEFINED":
			return `{ .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = ${instruction.dst} } }`;
		case "CREATE_NULL":
			return `{ .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = ${instruction.dst} } }`;
		case "CREATE_FUNCTION":
			return `{ .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = ${instruction.dst}, .function_index = ${instruction.functionIndex} } }`;
		case "CREATE_ARGUMENTS_OBJECT":
			return `{ .opcode = MAL_OP_CREATE_ARGUMENTS_OBJECT, .as.create_arguments_object = { .dst = ${instruction.dst} } }`;
		case "CALL":
			return `{ .opcode = MAL_OP_CALL, .as.call = { .dst = ${instruction.dst}, .callee = ${instruction.callee}, .this_value = ${instruction.thisValue}, .argument_count = ${instruction.argumentCount}, .arguments = ${emitCallArguments(instruction.arguments)} } }`;
		case "CONSTRUCT":
			return `{ .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = ${instruction.dst}, .callee = ${instruction.callee}, .argument_count = ${instruction.argumentCount}, .arguments = ${emitCallArguments(instruction.arguments)} } }`;
		case "THROW":
			return `{ .opcode = MAL_OP_THROW, .as.thrown = { .value = ${instruction.value} } }`;
		case "CATCH":
			return `{ .opcode = MAL_OP_CATCH, .as.caught = { .dst = ${instruction.dst} } }`;
		case "TRY_BEGIN":
			// The protected ranges live in the handler table; the markers only
			// keep the instruction pointers stable.
			return `{ .opcode = MAL_OP_TRY_BEGIN }`;
		case "TRY_END":
			return `{ .opcode = MAL_OP_TRY_END }`;
		case "LOAD_CAPTURED":
			return `{ .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = ${instruction.dst}, .owner_function_index = ${instruction.ownerFunctionIndex}, .index = ${instruction.index} } }`;
		case "LOAD_GLOBAL":
			return `{ .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = ${instruction.dst}, .index = ${instruction.index} } }`;
		case "LOAD_INTRINSIC":
			return `{ .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = ${instruction.dst}, .intrinsic = ${emitIntrinsic(instruction.intrinsic)} } }`;
		case "STORE_CAPTURED":
			return `{ .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = ${instruction.src}, .owner_function_index = ${instruction.ownerFunctionIndex}, .index = ${instruction.index} } }`;
		case "STORE_GLOBAL":
			return `{ .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = ${instruction.src}, .index = ${instruction.index} } }`;
		case "LOAD_PROPERTY":
			return `{ .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = ${instruction.dst}, .object = ${instruction.object}, .key = ${instruction.key} } }`;
		case "STORE_PROPERTY":
			return `{ .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = ${instruction.object}, .key = ${instruction.key}, .value = ${instruction.value} } }`;
		case "BINARY":
			return `{ .opcode = MAL_OP_BINARY, .as.binary = { .dst = ${instruction.dst}, .left = ${instruction.left}, .right = ${instruction.right}, .op = ${emitBinaryOperator(instruction.operator)} } }`;
		case "UNARY":
			return `{ .opcode = MAL_OP_UNARY, .as.unary = { .dst = ${instruction.dst}, .src = ${instruction.src}, .op = ${emitUnaryOperator(instruction.operator)} } }`;
	}

	throw new Error(`Unknown vm instruction ${(instruction as { opcode: string }).opcode}`);
}

function emitIntrinsic(
	intrinsic: Extract<VmInstruction, { opcode: "LOAD_INTRINSIC" }>["intrinsic"],
) {
	switch (intrinsic) {
		case "Object":
			return "MAL_INTRINSIC_OBJECT_CONSTRUCTOR";
		case "Array":
			return "MAL_INTRINSIC_ARRAY_CONSTRUCTOR";
		case "Function":
			return "MAL_INTRINSIC_FUNCTION_CONSTRUCTOR";
		case "Error":
			return "MAL_INTRINSIC_ERROR_CONSTRUCTOR";
		case "TypeError":
			return "MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR";
		case "RangeError":
			return "MAL_INTRINSIC_RANGE_ERROR_CONSTRUCTOR";
		case "ReferenceError":
			return "MAL_INTRINSIC_REFERENCE_ERROR_CONSTRUCTOR";
		case "SyntaxError":
			return "MAL_INTRINSIC_SYNTAX_ERROR_CONSTRUCTOR";
		case "String":
			return "MAL_INTRINSIC_STRING_CONSTRUCTOR";
		case "Number":
			return "MAL_INTRINSIC_NUMBER_CONSTRUCTOR";
		case "Boolean":
			return "MAL_INTRINSIC_BOOLEAN_CONSTRUCTOR";
		case "parseInt":
			return "MAL_INTRINSIC_PARSE_INT";
		case "parseFloat":
			return "MAL_INTRINSIC_PARSE_FLOAT";
		case "isNaN":
			return "MAL_INTRINSIC_IS_NAN";
		case "isFinite":
			return "MAL_INTRINSIC_IS_FINITE";
		case "Math":
			return "MAL_INTRINSIC_MATH";
		case "JSON":
			return "MAL_INTRINSIC_JSON";
		case "console":
			return "MAL_INTRINSIC_CONSOLE";
		case "globalThis":
			return "MAL_INTRINSIC_GLOBAL_THIS";
		case "NaN":
			return "MAL_INTRINSIC_NAN_VALUE";
		case "Infinity":
			return "MAL_INTRINSIC_INFINITY_VALUE";
	}
}

function emitUnaryOperator(
	operator: Extract<VmInstruction, { opcode: "UNARY" }>["operator"],
) {
	switch (operator) {
		case "!":
			return "MAL_UNARY_NOT";
		case "-":
			return "MAL_UNARY_NEGATE";
		case "+":
			return "MAL_UNARY_PLUS";
		case "~":
			return "MAL_UNARY_BIT_NOT";
		case "typeof":
			return "MAL_UNARY_TYPEOF";
	}

	throw new Error("Unknown unary operator");
}

function emitCallArguments(args: Array<number>) {
	if (args.length === 0) {
		return "nullptr";
	}

	return `(const i32[]) { ${args.join(", ")} }`;
}

/**
 * Convert operator to enum
 */
function emitBinaryOperator(operator: VmBinaryOperator) {
	switch (operator) {
		case "+":
			return "MAL_BIN_ADD";
		case "-":
			return "MAL_BIN_SUB";
		case "*":
			return "MAL_BIN_MUL";
		case "/":
			return "MAL_BIN_DIV";
		case "%":
			return "MAL_BIN_REM";
		case "&":
			return "MAL_BIN_BIT_AND";
		case "|":
			return "MAL_BIN_BIT_OR";
		case "^":
			return "MAL_BIN_BIT_XOR";
		case "<<":
			return "MAL_BIN_SHL";
		case ">>":
			return "MAL_BIN_SHR";
		case ">>>":
			return "MAL_BIN_USHR";
		case "<":
			return "MAL_BIN_LT";
		case "<=":
			return "MAL_BIN_LTE";
		case ">":
			return "MAL_BIN_GT";
		case ">=":
			return "MAL_BIN_GTE";
		case "==":
			return "MAL_BIN_EQ";
		case "!=":
			return "MAL_BIN_NEQ";
		case "===":
			return "MAL_BIN_STRICT_EQ";
		case "!==":
			return "MAL_BIN_STRICT_NEQ";
	}

	throw new Error("Unknown binary operator");
}
