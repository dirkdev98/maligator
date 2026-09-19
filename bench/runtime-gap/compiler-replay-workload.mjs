import { CoreFunctionBuilder } from "../../src/compiler/core/core-builder.ts";
import { buildCoreControlFlow } from "../../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../../src/compiler/core/core-ir-opcodes.ts";
import {
	corePlanVersionStamp,
	verifyCoreOptimizationPlan,
} from "../../src/compiler/core/core-ir-region-validity.ts";
import { buildCoreSpecializationRecipeTable } from "../../src/compiler/core/core-specialization-recipes.ts";
import { CoreProgram } from "../../src/compiler/core/core-store.ts";
import { conservativeCompilerProgramFacts } from "../../src/compiler/shared/compiler-facts.ts";

const FUNCTION_COUNT = 32;
const DIAMONDS_PER_FUNCTION = 16;
const sourcePath = "/runtime-gap/core-lowering-replay.js";

function compilationContext() {
	return {
		facts: conservativeCompilerProgramFacts(),
		data: {
			entrypointPath: sourcePath,
			moduleEvaluationOrder: [sourcePath],
			sourceFiles: [{ path: sourcePath, contents: "" }],
			cjsModuleFunctionIndices: [],
			hostInstallCandidates: [],
			singleAssignmentGlobalSlots: [],
			singleAssignmentCapturedSlots: [],
			retainedHostInstallers: [],
		},
	};
}

function appendReplayFunction(program, index) {
	const builder = new CoreFunctionBuilder(program, {
		parameterCount: 1,
		metadata: { sourcePath },
	});
	const entry = builder.createBlock([{ representation: "boxed" }]);
	const handler = builder.createBlock([
		{ role: "exception", representation: "boxed" },
		{ representation: "boxed" },
	]);
	const splitBlocks = Array.from({ length: DIAMONDS_PER_FUNCTION }, () =>
		builder.createBlock([{ representation: "boxed" }]),
	);
	const leftBlocks = Array.from({ length: DIAMONDS_PER_FUNCTION }, () =>
		builder.createBlock([{ representation: "boxed" }]),
	);
	const rightBlocks = Array.from({ length: DIAMONDS_PER_FUNCTION }, () =>
		builder.createBlock([{ representation: "boxed" }]),
	);
	const joinBlocks = Array.from({ length: DIAMONDS_PER_FUNCTION }, () =>
		builder.createBlock([{ representation: "boxed" }]),
	);
	const [callee] = builder.appendInstruction(entry, "createFunction", [], {
		attributes: { functionIndex: builder.functionId },
	});
	const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
	const input = builder.blockParameterValue(entry, 0);
	builder.setTerminator(entry, {
		kind: "jump",
		edge: { block: splitBlocks[0], arguments: [input] },
	});

	for (let stage = 0; stage < DIAMONDS_PER_FUNCTION; stage++) {
		const split = splitBlocks[stage];
		const left = leftBlocks[stage];
		const right = rightBlocks[stage];
		const join = joinBlocks[stage];
		const carried = builder.blockParameterValue(split, 0);
		const [condition] = builder.appendInstruction(split, "createBoolean", [], {
			attributes: { value: ((index + stage) & 1) === 0 },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(split, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [carried] },
			alternate: { block: right, arguments: [carried] },
		});

		const leftInput = builder.blockParameterValue(left, 0);
		const [leftResult] = builder.appendInstruction(left, "call", [
			callee,
			receiver,
			leftInput,
		]);
		builder.setHandler(left, handler, [leftInput]);
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: join, arguments: [leftResult] },
		});

		const rightInput = builder.blockParameterValue(right, 0);
		const [object] = builder.appendInstruction(right, "createObject", []);
		const [loaded] = builder.appendInstruction(right, "loadPropertyStatic", [object], {
			attributes: { stringIndex: stage & 7 },
		});
		const [rightResult] = builder.appendInstruction(right, "call", [
			callee,
			receiver,
			rightInput,
			loaded,
		]);
		builder.setHandler(right, handler, [rightInput]);
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: join, arguments: [rightResult] },
		});

		const joined = builder.blockParameterValue(join, 0);
		const next = splitBlocks[stage + 1];
		builder.setTerminator(
			join,
			next === undefined
				? { kind: "return", value: joined }
				: { kind: "jump", edge: { block: next, arguments: [joined] } },
		);
	}

	const recovered = builder.blockParameterValue(handler, 1);
	builder.setTerminator(handler, { kind: "return", value: recovered });
	return builder.finish(entry).function;
}

function emptyPlan(program, liveFunctions) {
	return {
		version: corePlanVersionStamp(program),
		liveFunctions,
		blockOrders: liveFunctions.map((functionId) => ({
			function: functionId,
			blocks: buildCoreControlFlow(program, functionId).reversePostorder,
			omittedBlocks: [],
		})),
		directEntries: [],
		directBuiltinCallbacks: [],
		operatorInputs: [],
		builtinInputs: [],
		privateNumericArrayElements: [],
		privatePackedRestArrayElements: [],
		unsignedArithmetic: [],
		recipes: buildCoreSpecializationRecipeTable([]),
		statistics: {
			considered: 0,
			applied: 0,
			declined: 0,
			appliedByKind: {},
			declinedByReason: {},
			generatedCodeConsumed: 0,
			compilerWorkConsumed: 0,
			admittedFunctions: 0,
			discoveredByKind: {},
			selectedByKind: {},
			declinedByPlanReason: {},
			verificationMs: 0,
		},
	};
}

const program = new CoreProgram(coreOpcodeRegistry, {
	stringConstants: Array.from({ length: 8 }, (_, index) =>
		Array.from(`field${index}`, (character) => character.charCodeAt(0)),
	),
});
const liveFunctions = Array.from({ length: FUNCTION_COUNT }, (_, index) =>
	appendReplayFunction(program, index),
);
const plan = emptyPlan(program, liveFunctions);
const sealed = program.seal();

export const compilerReplayCompilation = {
	program: sealed,
	context: compilationContext(),
	plan: verifyCoreOptimizationPlan(sealed, plan),
};

let instructionCount = 0;
for (const functionId of sealed.functionIds()) {
	for (const _instruction of sealed.function(functionId).instructionIds()) {
		instructionCount++;
	}
}
export const compilerReplayInstructionCount = instructionCount;
