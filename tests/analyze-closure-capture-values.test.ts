import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { analyzeClosureCaptureValues } from "../src/compiler/target/analyze-closure-capture-values.ts";
import { analyzeClosureCaptures } from "../src/compiler/target/analyze-closure-captures.ts";
import { compactCaptureStorage } from "../src/compiler/target/compact-capture-storage.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";
import {
	analysisProgram,
	programAnalysisContext,
} from "./helpers/core-program-analysis.ts";

type Shape =
	| "valid"
	| "before"
	| "branch"
	| "loop"
	| "exception-cycle"
	| "handler"
	| "reset"
	| "twice"
	| "unknown"
	| "sibling-write"
	| "other-creator"
	| "private"
	| "mapped"
	| "dynamic";

const base = compileSemanticProgramToProgramImage(
	analyzeSourceAndRunSemanticAnalysis("globalThis.result = 1;", "/capture-values.js"),
);

function proof(
	shape: Shape,
	options: { closed?: boolean; fact?: boolean; relocated?: boolean } = {},
) {
	const program = analysisProgram();
	const owner = new CoreFunctionBuilder(program, {
		parameterCount: 1,
		metadata: {
			strict: shape !== "mapped",
			capturedCount: 3,
			...(shape === "mapped" ? { mappedArguments: true, mappedArgumentSlots: [2] } : {}),
		},
	});
	const leaf = new CoreFunctionBuilder(program, { metadata: { strict: true } });
	const slot = { functionIndex: owner.functionId, index: 2 };
	const leafBody = leaf.createBlock();
	const [loaded] = leaf.appendInstruction(leafBody, "loadCaptured", [], {
		attributes: slot,
	});
	leaf.setTerminator(leafBody, { kind: "return", value: loaded! });
	leaf.finish(leafBody);
	const entry = owner.createBlock([{}]);
	const value = owner.blockParameterValue(entry, 0);
	const [empty] = owner.appendInstruction(entry, "createEmpty", []);
	owner.appendInstruction(entry, "storeCaptured", [empty!], { attributes: slot });
	const body = owner.createBlock();
	const write = (input = value) =>
		owner.appendInstruction(body, "storeCaptured", [input], { attributes: slot });
	const create = (block = body) =>
		owner.appendInstruction(block, "createFunction", [], {
			attributes: { functionIndex: leaf.functionId },
		})[0]!;
	if (shape === "branch") {
		const bypass = owner.createBlock();
		owner.setTerminator(entry, {
			kind: "branch",
			condition: value,
			consequent: { block: body, arguments: [] },
			alternate: { block: bypass, arguments: [] },
		});
		write();
		owner.setTerminator(body, { kind: "jump", edge: { block: bypass, arguments: [] } });
		const closure = create(bypass);
		owner.setTerminator(bypass, { kind: "return", value: closure });
	} else {
		owner.setTerminator(entry, { kind: "jump", edge: { block: body, arguments: [] } });
		if (shape === "before") create();
		if (shape === "unknown" || shape === "handler") {
			const [receiver] = owner.appendInstruction(body, "createUndefined", []);
			const [result] = owner.appendInstruction(body, "call", [value, receiver!]);
			write(shape === "unknown" ? result! : value);
		} else write();
		const closure = create();
		if (shape === "reset")
			owner.appendInstruction(body, "storeCaptured", [empty!], { attributes: slot });
		if (shape === "twice") write();
		if (shape === "private")
			owner.appendInstruction(body, "createPrivateNames", [], {
				attributes: { functionIndex: owner.functionId, capturedIndices: [2] },
			});
		if (shape === "dynamic") owner.appendInstruction(body, "withEnter", [value]);
		if (shape === "loop") {
			const done = owner.createBlock();
			owner.setTerminator(body, {
				kind: "branch",
				condition: value,
				consequent: { block: body, arguments: [] },
				alternate: { block: done, arguments: [] },
			});
			owner.setTerminator(done, { kind: "return", value: closure });
		} else {
			if (shape === "handler" || shape === "exception-cycle") {
				const handler = owner.createBlock([{ role: "exception" }]);
				owner.setHandler(body, handler);
				if (shape === "exception-cycle") {
					const [receiver] = owner.appendInstruction(body, "createUndefined", []);
					owner.appendInstruction(body, "call", [value, receiver!]);
					owner.setTerminator(handler, {
						kind: "jump",
						edge: { block: body, arguments: [] },
					});
				} else {
					const caughtClosure = create(handler);
					owner.setTerminator(handler, { kind: "return", value: caughtClosure });
				}
			}
			owner.setTerminator(body, { kind: "return", value: closure });
		}
	}
	owner.finish(entry);
	if (shape === "sibling-write" || shape === "other-creator") {
		const sibling = new CoreFunctionBuilder(program);
		const body = sibling.createBlock();
		const [result] = sibling.appendInstruction(body, "createUndefined", []);
		if (shape === "sibling-write")
			sibling.appendInstruction(body, "storeCaptured", [result!], { attributes: slot });
		else
			sibling.appendInstruction(body, "createFunction", [], {
				attributes: { functionIndex: leaf.functionId },
			});
		sibling.setTerminator(body, { kind: "return", value: result! });
		sibling.finish(body);
	}
	verifyCoreProgram(program);
	const ids = [...program.functionIds()];
	if (options.relocated) ids.reverse();
	const coreToExecution = ids.map(() => -1);
	for (const [index, id] of ids.entries()) coreToExecution[id] = index;
	const ownerIndex = coreToExecution[owner.functionId]!;
	const leafIndex = coreToExecution[leaf.functionId]!;
	const functions = ids.map((id) => ({
		...base.runtime.functions[0]!,
		strict: true,
		capturedCount: id === owner.functionId ? 3 : 0,
		registerCount: 1,
		instructions:
			id === leaf.functionId
				? [
						{
							opcode: "LOAD_CAPTURED" as const,
							dst: 0,
							ownerFunctionIndex: ownerIndex,
							index: 2,
						},
						{ opcode: "RETURN" as const, value: 0 },
					]
				: [
						{ opcode: "CREATE_FUNCTION" as const, dst: 0, functionIndex: leafIndex },
						{ opcode: "RETURN" as const, value: 0 },
					],
	}));
	const image: ProgramImage = {
		...base,
		runtime: { ...base.runtime, functions },
		native: createConservativeNativePlan(functions),
	};
	const context = programAnalysisContext(options.closed ?? true);
	const execution = {
		core: program.seal(),
		context: {
			...context,
			data: {
				...context.data,
				singleAssignmentCapturedSlots:
					options.fact === false ? [] : [{ owner: owner.functionId, index: 2 }],
			},
		},
		functionMap: { executionToCore: ids, coreToExecution },
	};
	return { image, execution, leafIndex, ownerIndex };
}

describe("persistent immutable closure capture proof", () => {
	it("snapshots an initialized owner slot and preserves the owner fallback", () => {
		const { image, execution, leafIndex, ownerIndex } = proof("valid");
		const result = analyzeClosureCaptures(
			analyzeClosureCaptureValues(image, execution),
			execution.context,
		);
		expect(result.runtime.functions[leafIndex]).toMatchObject({
			closureCaptureValues: [{ ownerFunctionIndex: ownerIndex, capturedIndex: 2 }],
			closureCaptureOwners: [ownerIndex],
		});
	});

	it("relocates Core owners and compacts value descriptors with their source slots", () => {
		const { image, execution, leafIndex, ownerIndex } = proof("valid", {
			relocated: true,
		});
		const result = compactCaptureStorage(
			analyzeClosureCaptureValues(image, execution),
			execution.context,
		);
		expect(result.runtime.functions[ownerIndex]!.capturedCount).toBe(1);
		expect(result.runtime.functions[leafIndex]!.closureCaptureValues).toEqual([
			{ ownerFunctionIndex: ownerIndex, capturedIndex: 0 },
		]);
		expect(result.runtime.functions[leafIndex]!.instructions[0]).toMatchObject({
			ownerFunctionIndex: ownerIndex,
			index: 0,
		});
	});

	it.each<Shape>([
		"before",
		"branch",
		"loop",
		"exception-cycle",
		"handler",
		"reset",
		"twice",
		"unknown",
		"sibling-write",
		"other-creator",
		"private",
		"mapped",
		"dynamic",
	])("keeps owning cells for an unproven initializer: %s", (shape) => {
		const { image, execution, leafIndex } = proof(shape);
		expect(
			analyzeClosureCaptureValues(image, execution).runtime.functions[leafIndex]!
				.closureCaptureValues,
		).toBeUndefined();
	});

	it.each([{ closed: false }, { fact: false }])(
		"requires source closure and a source immutability fact: %j",
		(options) => {
			const { image, execution } = proof("valid", options);
			expect(analyzeClosureCaptureValues(image, execution)).toBe(image);
		},
	);
});
