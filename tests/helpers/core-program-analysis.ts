import type { CoreCompilationContext } from "../../src/compiler/core/core-compilation.ts";
import { CoreFunctionBuilder } from "../../src/compiler/core/core-builder.ts";
import { coreOpcodeRegistry } from "../../src/compiler/core/core-ir-opcodes.ts";
import type {
	CoreFunctionId,
	CoreInstructionId,
} from "../../src/compiler/core/core-ir.ts";
import { CoreProgram } from "../../src/compiler/core/core-store.ts";
import {
	conservativeCompilerProgramFacts,
	programClosureCertificate,
} from "../../src/compiler/shared/compiler-facts.ts";

export function programAnalysisContext(sourceClosed = true): CoreCompilationContext {
	const facts = conservativeCompilerProgramFacts();
	return {
		facts: sourceClosed
			? {
					...facts,
					closure: programClosureCertificate(
						{ kind: "whole-program", entry: "/entry.js" },
						[],
						[],
					),
				}
			: facts,
		data: {
			entrypointPath: "/entry.js",
			moduleEvaluationOrder: ["/entry.js"],
			sourceFiles: [{ path: "/entry.js", contents: "" }],
			cjsModuleFunctionIndices: [],
			hostInstallCandidates: [],
			singleAssignmentGlobalSlots: [],
			singleAssignmentCapturedSlots: [],
			retainedHostInstallers: [],
		},
	};
}

export function analysisProgram(): CoreProgram {
	return new CoreProgram(coreOpcodeRegistry, { globalCount: 4 });
}

export function appendLeaf(
	program: CoreProgram,
	sourcePath = "/entry.js",
): {
	readonly function: CoreFunctionId;
	readonly valueInstruction: CoreInstructionId;
} {
	const builder = new CoreFunctionBuilder(program, {
		metadata: { sourcePath },
	});
	const entry = builder.createBlock();
	const [value] = builder.appendInstruction(entry, "createUndefined", []);
	const [valueInstruction] = builder.bodyInstructionIds(entry);
	builder.setTerminator(entry, { kind: "return", value: value! });
	const { function: functionId } = builder.finish(entry);
	return { function: functionId, valueInstruction: valueInstruction! };
}

export function appendCaller(
	program: CoreProgram,
	target: number,
	sourcePath = "/entry.js",
): {
	readonly function: CoreFunctionId;
	readonly createFunctionInstruction: CoreInstructionId;
	readonly callInstruction: CoreInstructionId;
} {
	const builder = new CoreFunctionBuilder(program, {
		metadata: { sourcePath },
	});
	const entry = builder.createBlock();
	const [callee] = builder.appendInstruction(entry, "createFunction", [], {
		attributes: { functionIndex: target },
	});
	const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
	const [result] = builder.appendInstruction(entry, "call", [callee!, receiver!]);
	const [createFunctionInstruction, , callInstruction] =
		builder.bodyInstructionIds(entry);
	builder.setTerminator(entry, { kind: "return", value: result! });
	const { function: functionId } = builder.finish(entry);
	return {
		function: functionId,
		createFunctionInstruction: createFunctionInstruction!,
		callInstruction: callInstruction!,
	};
}
