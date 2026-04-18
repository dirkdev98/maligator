import type { VmDefinition, VmInstruction } from "./lower-vm.ts";

type VmBinaryOperator = Extract<VmInstruction, { opcode: "BINARY" }>["operator"];

/**
 * Emit a C translation unit with the static MalVmDefinition data.
 */
export function emitVmDefinition(definition: VmDefinition) {
	const lines = ['#include "vm.h"', ""];

	for (let i = 0; i < definition.functions.length; ++i) {
		const fn = definition.functions[i]!;
		lines.push(`static const MalInstruction mal_function_${i}_instructions[] = {`);

		for (const instruction of fn.instructions) {
			lines.push(`    ${emitInstruction(instruction)},`);
		}

		lines.push("};", "");
	}

	lines.push("static const MalFunction mal_functions[] = {");
	for (let i = 0; i < definition.functions.length; ++i) {
		const fn = definition.functions[i]!;
		lines.push("    {");
		lines.push(`        .parameter_count = ${fn.parameterCount},`);
		lines.push(`        .register_count = ${fn.registerCount},`);
		lines.push(`        .captured_count = ${fn.capturedCount},`);
		lines.push(`        .instruction_count = ${fn.instructions.length},`);
		lines.push(`        .instructions = mal_function_${i}_instructions,`);
		lines.push("    },");
	}
	lines.push("};", "");

	lines.push("const MalVmDefinition mal_vm_definition = {");
	lines.push(`    .function_count = ${definition.functionCount},`);
	lines.push("    .functions = mal_functions,");
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
		case "CREATE_UNDEFINED":
			return `{ .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = ${instruction.dst} } }`;
		case "CREATE_FUNCTION":
			return `{ .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = ${instruction.dst}, .function_index = ${instruction.functionIndex} } }`;
		case "LOAD_CAPTURED":
			return `{ .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = ${instruction.dst}, .owner_function_index = ${instruction.ownerFunctionIndex}, .index = ${instruction.index} } }`;
		case "LOAD_GLOBAL":
			return `{ .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = ${instruction.dst}, .index = ${instruction.index} } }`;
		case "STORE_CAPTURED":
			return `{ .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = ${instruction.src}, .owner_function_index = ${instruction.ownerFunctionIndex}, .index = ${instruction.index} } }`;
		case "STORE_GLOBAL":
			return `{ .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = ${instruction.src}, .index = ${instruction.index} } }`;
		case "BINARY":
			return `{ .opcode = MAL_OP_BINARY, .as.binary = { .dst = ${instruction.dst}, .left = ${instruction.left}, .right = ${instruction.right}, .op = ${emitBinaryOperator(instruction.operator)} } }`;
	}

	throw new Error(`Unknown vm instruction ${(instruction as { opcode: string }).opcode}`);
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
	}

	throw new Error("Unknown binary operator");
}
