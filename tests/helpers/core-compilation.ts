import type {
	CoreCompilation,
	CoreCompilationContext,
	CoreProgramData,
} from "../../src/compiler/core/core-compilation.ts";
import type { CoreProgram } from "../../src/compiler/core/core-ir.ts";
import { conservativeCompilerProgramFacts } from "../../src/compiler/shared/compiler-facts.ts";

/** Explicit open-world context for target-lowering unit fixtures. */
export function coreCompilationForTest(
	program: CoreProgram,
	overrides: {
		readonly context?: Partial<CoreCompilationContext>;
		readonly data?: Partial<CoreProgramData>;
	} = {},
): CoreCompilation {
	const data: CoreProgramData = {
		entrypointPath: "<test>",
		moduleEvaluationOrder: [],
		sourceFiles: [],
		cjsModuleFunctionIndices: [],
		hostInstallCandidates: [],
		singleAssignmentGlobalSlots: [],
		singleAssignmentCapturedSlots: [],
		retainedHostInstallers: [],
		...overrides.data,
	};
	return {
		program,
		context: {
			facts: conservativeCompilerProgramFacts(),
			data,
			...overrides.context,
		},
	};
}
