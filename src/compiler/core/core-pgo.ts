import type { ConstructedCoreCompilation } from "./core-compilation.ts";
import type { CoreFunctionId, CoreInstructionId } from "./core-ir.ts";

export interface CorePgoHints {
	readonly digest: string;
	functionEntries(id: CoreFunctionId): number | undefined;
	callAttempts(id: CoreFunctionId, instruction: CoreInstructionId): number | undefined;
}

export interface CorePgoInput {
	readonly digest: string;
	readonly policy: string;
	bind(compilation: ConstructedCoreCompilation): CorePgoHints;
}
