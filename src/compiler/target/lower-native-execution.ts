import type { CoreCompilation } from "../core/core-compilation.ts";
import type { ExecutionProgram } from "./execution-ir.ts";
import type { LowerCoreToExecutionOptions } from "./lower-execution.ts";
import { lowerCoreCompilationToExecutionProgram } from "./lower-execution.ts";
import { verifyNativeExecutionProgram } from "./verify-native-execution.ts";

/** Lower the generic execution contract and verify its native image obligations. */
export function lowerCoreCompilationToExecution(
	compilation: CoreCompilation,
	options: LowerCoreToExecutionOptions = {},
): ExecutionProgram {
	const program = lowerCoreCompilationToExecutionProgram(compilation, options);
	verifyNativeExecutionProgram(program);
	return program;
}
