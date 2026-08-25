import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	BYTECODE_OPERATIONS,
	generateBytecodeOperationInclude,
} from "../src/compiler/target/bytecode-operation-spec.ts";
import type { BytecodeInstruction } from "../src/compiler/target/lower-vm.ts";

type MissingOperation = Exclude<
	BytecodeInstruction["opcode"],
	(typeof BYTECODE_OPERATIONS)[number]
>;
type UnknownOperation = Exclude<
	(typeof BYTECODE_OPERATIONS)[number],
	BytecodeInstruction["opcode"]
>;
const operationContractIsExact: [MissingOperation, UnknownOperation] extends [
	never,
	never,
]
	? true
	: never = true;

describe("bytecode operation specification", () => {
	it("covers the instruction union exactly with unique numeric tags", () => {
		expect(operationContractIsExact).toBe(true);
		expect(new Set(BYTECODE_OPERATIONS).size).toBe(BYTECODE_OPERATIONS.length);
	});

	it("keeps the generated C contract current", () => {
		expect(readFileSync("runtime/src/generated/bytecode_operations.inc", "utf8")).toBe(
			generateBytecodeOperationInclude(),
		);
	});
});
