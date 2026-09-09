import { describe, expect, it } from "vitest";
import {
	CORE_OPCODES,
	coreOpcodeRegistry,
} from "../src/compiler/core/core-ir-opcodes.ts";
import { CoreOpcodeRegistry, coreArity } from "../src/compiler/core/core-ir.ts";
import {
	coreTargetOperationContracts,
	verifyCoreTargetOperationContracts,
} from "../src/compiler/target/core-operation-contract.ts";

function clonedRegistry(
	replace?: (
		opcode: string,
		descriptor: ReturnType<CoreOpcodeRegistry["require"]>,
	) => ReturnType<CoreOpcodeRegistry["require"]> | null,
): CoreOpcodeRegistry {
	const result = new CoreOpcodeRegistry();
	for (const descriptor of coreOpcodeRegistry.entries()) {
		const candidate =
			replace === undefined ? descriptor : replace(descriptor.opcode, descriptor);
		if (candidate !== null) result.define(candidate);
	}
	return result;
}

describe("Core target operation contract", () => {
	it("keeps builtin failures observable and GC-capable without reading input values", () => {
		const error = coreOpcodeRegistry.require("builtinError");
		expect(error.inputs).toEqual(coreArity(0));
		expect(error.discardable).toBe(false);
		expect(error.effects).toMatchObject({
			mayThrow: true,
			mayGc: true,
			callsUserCode: false,
			maySuspend: false,
		});
	});
	it("publishes lowering, representation, and safepoint ownership for every Core opcode", () => {
		expect([...coreTargetOperationContracts.keys()]).toEqual(CORE_OPCODES);
		expect(coreTargetOperationContracts.get("createF64")).toMatchObject({
			targetType: "createF64",
			outputCount: 1,
			representation: "core-value-register",
			safepoint: "instruction-effects",
		});
		expect(coreTargetOperationContracts.get("asyncStart")).toMatchObject({
			outputCount: 0,
			representation: "none",
		});
		expect(coreTargetOperationContracts.get("rootUse")).toMatchObject({
			targetType: "rootUse",
			outputCount: 0,
			representation: "none",
			safepoint: "instruction-effects",
		});
	});

	it("rejects a canonical registry that omits a target lowering", () => {
		const incomplete = clonedRegistry((opcode, descriptor) =>
			opcode === "binary" ? null : descriptor,
		);
		expect(() => verifyCoreTargetOperationContracts(incomplete)).toThrow(
			/Core target contract is missing opcode binary/,
		);
	});

	it("rejects an output shape the target representation contract cannot carry", () => {
		const variableOutputs = clonedRegistry((opcode, descriptor) =>
			opcode === "binary" ? { ...descriptor, outputs: coreArity(1, 2) } : descriptor,
		);
		expect(() => verifyCoreTargetOperationContracts(variableOutputs)).toThrow(
			/requires fixed outputs for binary, received 1\.\.2/,
		);
	});
});
