import { createConservativeNativePlan } from "../../src/compiler/target/lower-vm.ts";
import type {
	BytecodeFunction,
	NativeFunctionPlan,
	ProgramImage,
	RuntimeImage,
} from "../../src/compiler/target/lower-vm.ts";

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
	functions[functionIndex] = update(
		functions[functionIndex]!,
		image.runtime.functions[functionIndex]!,
	);
	return { ...image, native: { ...image.native, functions } };
}
