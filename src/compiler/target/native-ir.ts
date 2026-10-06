import type { CoreTargetFunction, CoreTargetProgram } from "./core-target-ir.ts";

export interface NativeFunction extends CoreTargetFunction {
	readonly storageValues: ReadonlyArray<number>;
}

export interface NativeProgram extends CoreTargetProgram {
	readonly kind: "native";
	readonly functions: ReadonlyArray<NativeFunction>;
}
