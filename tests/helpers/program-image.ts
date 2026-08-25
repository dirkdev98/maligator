import { createConservativeNativePlan } from "../../src/compiler/target/program-image.ts";
import type {
	NativeFunctionPlan,
	ProgramImage,
} from "../../src/compiler/target/program-image.ts";
import type {
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
	functions[functionIndex] = update(
		functions[functionIndex]!,
		image.runtime.functions[functionIndex]!,
	);
	return { ...image, native: { ...image.native, functions } };
}
