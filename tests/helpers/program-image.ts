import { createConservativeNativePlan } from "../../src/compiler/target/lower-vm.ts";
import type {
	BytecodeFunction,
	NativeFunctionPlan,
	ProgramImage,
} from "../../src/compiler/target/lower-vm.ts";

type RuntimeProgramImage = Omit<ProgramImage, "nativePlan">;

/** Build an explicit conservative native contract for a hand-authored fixture. */
export function testProgramImage(image: RuntimeProgramImage): ProgramImage {
	return { ...image, nativePlan: createConservativeNativePlan(image.functions) };
}

/** Replace one native plan while preserving its bytecode function. */
export function withNativeFunctionPlan(
	image: ProgramImage,
	functionIndex: number,
	update: (plan: NativeFunctionPlan, fn: BytecodeFunction) => NativeFunctionPlan,
): ProgramImage {
	const functions = [...image.nativePlan.functions];
	functions[functionIndex] = update(
		functions[functionIndex]!,
		image.functions[functionIndex]!,
	);
	return { ...image, nativePlan: { functions } };
}
