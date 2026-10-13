import { validateNativeVirtualValue } from "./native-virtual-value.ts";
import type { VmStackObjectPlanRegion } from "./program-image.ts";
import {
	vmInstructionReadRegisters,
	vmExceptionHandlerTargets,
} from "./runtime-image.ts";
import type { BytecodeInstruction, BytecodeExceptionHandler } from "./runtime-image.ts";

export function validateNativeStackObject(
	instructions: ReadonlyArray<BytecodeInstruction>,
	site: VmStackObjectPlanRegion["sites"][number],
	handlers: ReadonlyArray<BytecodeExceptionHandler> = [],
): void {
	function fail(): never {
		throw new RangeError("Invalid stack-object observation region");
	}
	const allocation = instructions[site.allocationIp];
	if (
		allocation?.opcode !== "CREATE_OBJECT_SHAPED" &&
		allocation?.opcode !== "CREATE_OBJECT"
	)
		fail();
	const consumers = new Map<number, ReadonlyArray<number>>();
	for (const access of site.accesses) {
		const instruction = instructions[access.ip];
		if (
			instruction?.opcode !== "LOAD_PROPERTY_STATIC" &&
			instruction?.opcode !== "STORE_PROPERTY_STATIC" &&
			instruction?.opcode !== "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT" &&
			instruction?.opcode !== "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT"
		)
			fail();
		consumers.set(access.ip, [instruction.object]);
	}
	if (site.inheritedAccessIp !== undefined) {
		const instruction = instructions[site.inheritedAccessIp];
		if (instruction?.opcode !== "LOAD_PROPERTY_STATIC") fail();
		consumers.set(site.inheritedAccessIp, [instruction.object]);
	}
	for (const materialization of site.materializations) {
		const instruction = instructions[materialization.ip];
		if (instruction === undefined) fail();
		if (materialization.kind === "return") {
			if (instruction.opcode !== "RETURN") fail();
			consumers.set(materialization.ip, [instruction.value]);
		} else {
			const values = materialization.values;
			if (
				values === undefined ||
				values.length === 0 ||
				values.some((value) => !vmInstructionReadRegisters(instruction).includes(value))
			)
				fail();
			if (instruction.opcode === "CALL" || instruction.opcode === "CALL_KNOWN") {
				if (
					(instruction.opcode === "CALL_KNOWN" &&
						(instruction.construct || instruction.argumentMode !== undefined)) ||
					values.some(
						(value) =>
							!instruction.arguments.includes(value) ||
							instruction.thisValue === value ||
							(instruction.opcode === "CALL" && instruction.callee === value),
					)
				)
					fail();
			}
			consumers.set(materialization.ip, values);
		}
	}
	// Identity-only objects retain their stack identity without publishing it to another activation.
	const identityOnly = !site.materializations.some(
		(materialization) => materialization.kind === "observe",
	);
	const exceptionTargets = vmExceptionHandlerTargets(instructions.length, handlers);
	const incoming = validateNativeVirtualValue(
		instructions,
		site.allocationIp,
		allocation.dst,
		consumers,
		fail,
		(instruction) =>
			identityOnly &&
			((instruction.opcode === "BINARY" &&
				(instruction.operator === "===" || instruction.operator === "!==")) ||
				instruction.opcode === "LOAD_PROTOTYPE" ||
				instruction.opcode === "TYPEOF_COMPARE" ||
				(instruction.opcode === "UNARY" && instruction.operator === "typeof")),
		!identityOnly,
		undefined,
		exceptionTargets,
	);
	if (!identityOnly) {
		if (exceptionTargets[site.allocationIp] !== undefined) fail();
		const handlerTargets = new Set(handlers.map((handler) => handler.handlerIp));
		for (const [ip, aliases] of incoming) {
			// Materialized aliases still belong to this allocation's lifetime.
			if (
				aliases.may.size > 0 &&
				(exceptionTargets[ip] !== undefined || handlerTargets.has(ip))
			)
				fail();
		}
	}
}
