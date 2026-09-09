import { CoreEditor } from "./core-editor.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionPassContext } from "./core-pass.ts";
import type { CoreStaticValueAnalysis } from "./core-static-values.ts";

export function eliminateSymbolDescription(
	context: CoreFunctionPassContext,
	analysis: CoreStaticValueAnalysis,
	instruction: CoreInstructionId,
	input: CoreValueId | undefined,
) {
	if (input === undefined || analysis.constant(input) !== undefined) return undefined;
	const fact = analysis.query(input);
	if (fact.kind !== "known" || fact.brand === "undefined") return undefined;
	const { program, item } = context;
	const fn = program.function(item.function);
	const root = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
	const pending = [root],
		visited = new Set<CoreValueId>(),
		consumers = new Map<CoreInstructionId, "description" | "string">();
	let edits = 1;
	while (pending.length) {
		const value = pending.pop()!;
		if (visited.has(value)) continue;
		visited.add(value);
		if (visited.size > 64 || fn.kernel.valueHandlerUseCount(value) !== 0)
			return undefined;
		for (
			let use = fn.kernel.valueFirstUse(value);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			const consumer = fn.kernel.useInstruction(use);
			if (fn.instructionKind(consumer) !== "operation") return undefined;
			const opcode = fn.instructionOpcodeName(consumer);
			if (opcode === "move") {
				pending.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(consumer)));
				if (pending.length + visited.size > 64) return undefined;
				continue;
			}
			const attributes = fn.instructionAttributes(consumer);
			if (
				opcode !== "callKnown" ||
				attributes.construct ||
				attributes.argumentMode !== undefined
			)
				return undefined;
			const operation = attributes.operation;
			if (
				fn.kernel.useOperand(use) !== (operation === "String" ? 1 : 0) ||
				![
					"Symbol.prototype.description<get>",
					"Symbol.prototype.toString",
					"String",
				].includes(operation as string)
			)
				return undefined;
			const kind =
				operation === "Symbol.prototype.description<get>" ? "description" : "string";
			if (!consumers.has(consumer)) edits += kind === "description" ? 1 : 4;
			consumers.set(consumer, kind);
			if (edits > context.remainingEdits || consumers.size > 64) return undefined;
		}
	}
	if (consumers.size === 0 || edits + 2 > context.remainingEdits) return undefined;
	const editor = CoreEditor.open(program, fn.id);
	// Coercion belongs to Symbol creation, even when its description is read after effects.
	editor.replaceInstruction(instruction, "unary", [input], {
		attributes: { operator: "tostring" },
	});
	const stringIndex = (text: string) => {
		const units = Array.from(text, (character) => character.charCodeAt(0));
		const found = program.stringConstants.findIndex(
			(value) =>
				value.length === units.length &&
				value.every((unit, index) => unit === units[index]),
		);
		return found >= 0 ? found : editor.appendStringConstants([units]);
	};
	for (const [consumer, kind] of consumers) {
		if (kind === "description") {
			editor.replaceInstruction(consumer, "move", [root]);
			continue;
		}
		const block = fn.instructionBlock(consumer);
		const sourcePosition = fn.instructionSourcePosition(consumer);
		const prefix = editor.insertInstruction(block, consumer, "createString", [], {
			sourcePosition,
			attributes: { stringIndex: stringIndex("Symbol(") },
		}).outputs[0]!;
		const suffix = editor.insertInstruction(block, consumer, "createString", [], {
			sourcePosition,
			attributes: { stringIndex: stringIndex(")") },
		}).outputs[0]!;
		const start = editor.insertInstruction(block, consumer, "binary", [prefix, root], {
			sourcePosition,
			attributes: { operator: "+" },
		}).outputs[0]!;
		editor.replaceInstruction(consumer, "binary", [start, suffix], {
			attributes: { operator: "+" },
		});
	}
	return editor.commit();
}
