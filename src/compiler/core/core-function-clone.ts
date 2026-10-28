import { CoreEditor } from "./core-editor.ts";
import { buildCoreControlFlow, coreTerminatorInput } from "./core-ir-control-flow.ts";
import { CORE_PRIMITIVE_EFFECT_FACT } from "./core-ir-value-kinds.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreTerminatorInput,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

/**
 * Whether `cloneCoreFunction` can copy `fn`. Facts belong to their function, so
 * only primitive effects, which the clone's own passes reprove, may be
 * dropped; guards and every other refinement keep the original unique.
 */
export function coreFunctionIsCloneable(fn: CoreFunctionStore): boolean {
	if (fn.isGenerator || fn.isAsync || fn.handlerBlockCount > 0) return false;
	for (const block of fn.blockIds())
		if (fn.instructionKind(fn.blockTerminator(block)) === "guard") return false;
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const refinement = fn.instructionEffectRefinement(instruction);
		if (refinement === undefined) continue;
		const opcode = fn.instructionOpcodeName(instruction);
		const fact = fn.fact(refinement.proof);
		if (
			(opcode !== "unary" && opcode !== "binary" && opcode !== "queryStaticData") ||
			fact.kind !== CORE_PRIMITIVE_EFFECT_FACT ||
			fact.obligations.length !== 0
		)
			return false;
	}
	return true;
}

/** A new function with `fn`'s parameters, metadata, and body. */
export function cloneCoreFunction(
	program: CoreProgram,
	fn: CoreFunctionStore,
): CoreFunctionId {
	if (!coreFunctionIsCloneable(fn))
		throw new Error(`Core function ${fn.id} is not cloneable`);
	const editor = CoreEditor.createFunction(program, {
		parameterCount: fn.parameterCount,
		metadata: fn.metadata,
	});
	const blocks = new Map<CoreBlockId, CoreBlockId>();
	const values = new Map<CoreValueId, CoreValueId>();
	// Reverse postorder visits every definition before its non-phi uses.
	const live = buildCoreControlFlow(program, fn.id).reversePostorder;
	for (const source of live) {
		const start = fn.kernel.blockParameterStart(source);
		const count = fn.kernel.blockParameterCount(source);
		const created = editor.createBlock(
			Array.from({ length: count }, (_, index) => ({
				representation: fn.valueRepresentation(
					fn.kernel.blockParameterValue(start + index),
				),
				...(fn.kernel.blockParameterRole(start + index) === 1
					? { role: "exception" as const }
					: {}),
			})),
		);
		blocks.set(source, created);
		const createdStart = editor.function.kernel.blockParameterStart(created);
		for (let index = 0; index < count; index++)
			values.set(
				fn.kernel.blockParameterValue(start + index),
				editor.function.kernel.blockParameterValue(createdStart + index),
			);
	}
	const map = (value: CoreValueId): CoreValueId => {
		const mapped = values.get(value);
		if (mapped === undefined)
			throw new Error(`Core clone of ${fn.id} lost value ${value}`);
		return mapped;
	};
	for (const source of live) {
		const output = blocks.get(source)!;
		for (const instruction of fn.bodyInstructionIds(source)) {
			const resultStart = fn.kernel.instructionResultStart(instruction);
			const resultCount = fn.kernel.instructionResultCount(instruction);
			const operandStart = fn.kernel.instructionOperandStart(instruction);
			const operands = Array.from(
				{ length: fn.kernel.instructionOperandCount(instruction) },
				(_, index) => fn.kernel.operandAt(operandStart + index),
			);
			const created = editor.appendInstruction(
				output,
				fn.instructionOpcodeName(instruction),
				operands.map(map),
				{
					attributes: fn.instructionAttributes(instruction),
					sourcePosition: fn.instructionSourcePosition(instruction),
					outputCount: resultCount,
					outputRepresentations: Array.from({ length: resultCount }, (_, index) =>
						fn.valueRepresentation(fn.kernel.resultAt(resultStart + index)),
					),
				},
			);
			created.outputs.forEach((output, index) =>
				values.set(fn.kernel.resultAt(resultStart + index), output),
			);
		}
	}
	const block = (original: CoreBlockId): CoreBlockId => {
		const mapped = blocks.get(original);
		if (mapped === undefined)
			throw new Error(`Core clone of ${fn.id} lost block ${original}`);
		return mapped;
	};
	const edge = (input: {
		block: CoreBlockId;
		arguments: ReadonlyArray<CoreValueId>;
	}) => ({
		block: block(input.block),
		arguments: input.arguments.map(map),
	});
	for (const source of live) {
		const output = block(source);
		const terminator = fn.blockTerminator(source);
		const original = coreTerminatorInput(fn, terminator);
		const sourcePosition = fn.instructionSourcePosition(terminator);
		const positioned = sourcePosition === undefined ? {} : { sourcePosition };
		let input: CoreTerminatorInput;
		switch (original.kind) {
			case "jump":
				input = { kind: "jump", edge: edge(original.edge), ...positioned };
				break;
			case "branch":
				input = {
					kind: "branch",
					condition: map(original.condition),
					consequent: edge(original.consequent),
					alternate: edge(original.alternate),
					...positioned,
				};
				break;
			case "switch":
				input = {
					kind: "switch",
					discriminant: map(original.discriminant),
					cases: original.cases.map(({ value, edge: caseEdge }) => ({
						value,
						edge: edge(caseEdge),
					})),
					default: edge(original.default),
					...positioned,
				};
				break;
			case "return":
			case "throw":
				input = { kind: original.kind, value: map(original.value), ...positioned };
				break;
			case "unreachable":
				input = { kind: "unreachable", ...positioned };
				break;
			case "guard":
				throw new Error(`Core clone of ${fn.id} reached a guard`);
		}
		editor.setTerminator(output, input);
	}
	editor.finishFunction(
		block(fn.entry),
		fn.bodyEntry === undefined ? undefined : block(fn.bodyEntry),
	);
	editor.commit();
	return editor.function.id;
}
