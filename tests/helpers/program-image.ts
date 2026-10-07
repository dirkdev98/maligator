import { lowerNativeFunctionStorage } from "../../src/compiler/target/lower-native-storage.ts";
import {
	createConservativeNativePlan,
	vmRegionActions,
} from "../../src/compiler/target/program-image.ts";
import type {
	NativeFunctionPlan,
	ProgramImage,
} from "../../src/compiler/target/program-image.ts";
import { vmInstructionUsesPropertyCache } from "../../src/compiler/target/runtime-image.ts";
import type {
	BytecodeInstruction,
	BytecodeFunction,
	RuntimeImage,
} from "../../src/compiler/target/runtime-image.ts";

/** Build an explicit conservative native contract for a hand-authored fixture. */
export function testProgramImage(runtime: RuntimeImage): ProgramImage {
	return {
		runtime,
		native: createConservativeNativePlan(runtime.functions),
		diagnostics: {},
	};
}

/** Replace one native plan while preserving its bytecode function. */
export function withNativeFunctionPlan(
	image: ProgramImage,
	functionIndex: number,
	update: (plan: NativeFunctionPlan, fn: BytecodeFunction) => NativeFunctionPlan,
): ProgramImage {
	const functions = [...image.native.functions];
	const updated = update(functions[functionIndex]!, functions[functionIndex]!.body);
	const next = { ...updated, regionActions: vmRegionActions(updated.specializations) };
	try {
		functions[functionIndex] = lowerNativeFunctionStorage(next);
	} catch {
		functions[functionIndex] = next;
	}
	return { ...image, native: { ...image.native, functions } };
}

export function testPropertyCacheCount(
	instructions: ReadonlyArray<BytecodeInstruction>,
): number {
	return instructions.reduce(
		(count, instruction) =>
			vmInstructionUsesPropertyCache(instruction)
				? Math.max(count, instruction.icIndex + 1)
				: count,
		0,
	);
}
