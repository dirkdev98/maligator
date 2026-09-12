import { CoreEditor } from "./core-editor.ts";
import { coreTerminatorInput } from "./core-ir-control-flow.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionPassContext } from "./core-pass.ts";
import type { CoreStaticValueAnalysis } from "./core-static-values.ts";

function symbolStringIndex(editor: CoreEditor, text: string): number {
	const units = Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
	const found = editor.program.stringConstants.findIndex(
		(value) =>
			value.length === units.length &&
			value.every((unit, index) => unit === units[index]),
	);
	return found >= 0 ? found : editor.appendStringConstants([units]);
}

function replaceSymbolText(
	editor: CoreEditor,
	consumer: CoreInstructionId,
	text: CoreValueId,
) {
	const fn = editor.function;
	const block = fn.instructionBlock(consumer);
	const sourcePosition = fn.instructionSourcePosition(consumer);
	const prefix = editor.insertInstruction(block, consumer, "createString", [], {
		sourcePosition,
		attributes: { stringIndex: symbolStringIndex(editor, "Symbol(") },
	}).outputs[0]!;
	const suffix = editor.insertInstruction(block, consumer, "createString", [], {
		sourcePosition,
		attributes: { stringIndex: symbolStringIndex(editor, ")") },
	}).outputs[0]!;
	const start = editor.insertInstruction(block, consumer, "binary", [prefix, text], {
		sourcePosition,
		attributes: { operator: "+" },
	}).outputs[0]!;
	editor.replaceInstruction(consumer, "binary", [start, suffix], {
		attributes: { operator: "+" },
	});
}

function forwardOptionalSymbolDescription(
	context: CoreFunctionPassContext,
	producer: CoreInstructionId,
	input: CoreValueId,
) {
	const { program, item } = context;
	const fn = program.function(item.function);
	const root = fn.kernel.resultAt(fn.kernel.instructionResultStart(producer));
	const pending = [root],
		visited = new Set<CoreValueId>(),
		consumers = new Map<CoreInstructionId, "description" | "string">();
	let edits = 20,
		inspectedUses = 0;
	while (pending.length) {
		const value = pending.pop()!;
		if (visited.has(value)) continue;
		visited.add(value);
		if (visited.size > 64) return undefined;
		for (
			let use = fn.kernel.valueFirstUse(value);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			if (++inspectedUses > 256) return undefined;
			const consumer = fn.kernel.useInstruction(use);
			if (fn.instructionKind(consumer) !== "operation") continue;
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
				continue;
			const operation = attributes.operation;
			if (
				fn.kernel.useOperand(use) !== (operation === "String" ? 1 : 0) ||
				![
					"Symbol.prototype.description<get>",
					"Symbol.prototype.toString",
					"String",
				].includes(operation as string)
			)
				continue;
			const kind =
				operation === "Symbol.prototype.description<get>" ? "description" : "string";
			if (!consumers.has(consumer)) edits += kind === "description" ? 1 : 4;
			consumers.set(consumer, kind);
			if (edits > context.remainingEdits || consumers.size > 64) return undefined;
		}
	}
	if (consumers.size === 0) return undefined;
	const block = fn.instructionBlock(producer);
	const terminator = fn.blockTerminator(block);
	if (fn.instructionKind(terminator) === "guard") return undefined;
	const tail: Array<CoreInstructionId> = [];
	for (
		let next: CoreInstructionId | undefined = producer;
		next !== undefined && next !== terminator;
		next = fn.instructionNext(next)
	) {
		tail.push(next);
		if (edits + tail.length > context.remainingEdits) return undefined;
	}
	const handler = fn.kernel.blockHandlerBlock(block);
	const handlerArguments: Array<CoreValueId> = [];
	if (handler !== undefined) {
		const count = fn.kernel.blockHandlerArgumentCount(block);
		if (count > 64) return undefined;
		const start = fn.kernel.blockHandlerArgumentStart(block);
		const moved = new Set(tail);
		for (let index = 0; index < count; index++) {
			const argument = fn.kernel.handlerArgumentAt(start + index);
			// The conversion can throw before any value in the allocation tail exists.
			if (
				fn.kernel.valueDefinitionKind(argument) === 1 &&
				moved.has(coreInstructionId(fn.kernel.valueDefinitionOwner(argument)))
			)
				return undefined;
			handlerArguments.push(argument);
		}
	}
	const editor = CoreEditor.open(program, fn.id);
	const sourcePosition = fn.instructionSourcePosition(producer);
	const absent = editor.insertInstruction(block, producer, "createUndefined", [], {
		sourcePosition,
	}).outputs[0]!;
	const empty = editor.insertInstruction(block, producer, "createString", [], {
		sourcePosition,
		attributes: { stringIndex: symbolStringIndex(editor, "") },
	}).outputs[0]!;
	const condition = editor.insertInstruction(block, producer, "binary", [input, absent], {
		sourcePosition,
		attributes: { operator: "===" },
	}).outputs[0]!;
	const convert = editor.createBlock();
	const join = editor.createBlock([{}, {}]);
	const parameterStart = fn.kernel.blockParameterStart(join);
	const description = fn.kernel.blockParameterValue(parameterStart);
	const text = fn.kernel.blockParameterValue(parameterStart + 1);
	for (const instruction of tail) editor.moveInstruction(instruction, join);
	editor.setTerminator(join, {
		...coreTerminatorInput(fn, terminator),
		sourcePosition: fn.instructionSourcePosition(terminator),
	});
	// Undefined suppresses conversion but still creates a fresh symbol at the join.
	const captured = editor.insertInstruction(convert, undefined, "unary", [input], {
		sourcePosition,
		attributes: { operator: "tostring" },
	}).outputs[0]!;
	editor.setTerminator(convert, {
		kind: "jump",
		edge: { block: join, arguments: [captured, captured] },
		sourcePosition,
	});
	editor.replaceTerminator(block, {
		kind: "branch",
		condition,
		consequent: { block: join, arguments: [absent, empty] },
		alternate: { block: convert, arguments: [] },
		sourcePosition,
	});
	if (handler !== undefined) {
		editor.setHandler(convert, handler, handlerArguments);
		editor.setHandler(join, handler, handlerArguments);
	}
	const operandStart = fn.kernel.instructionOperandStart(producer);
	const inputs = Array.from(
		{ length: fn.kernel.instructionOperandCount(producer) },
		(_, index) => fn.kernel.operandAt(operandStart + index),
	);
	inputs[1] = description;
	editor.replaceOperands(producer, inputs);
	for (const [consumer, kind] of consumers) {
		if (kind === "string") replaceSymbolText(editor, consumer, text);
		else editor.replaceInstruction(consumer, "move", [description]);
	}
	return editor.commit();
}

export function forwardSymbolDescription(
	context: CoreFunctionPassContext,
	analysis: CoreStaticValueAnalysis,
	consumer: CoreInstructionId,
	receiver: CoreValueId | undefined,
	observation: "description" | "string" | "key",
) {
	if (
		receiver === undefined ||
		context.remainingEdits < (observation === "string" ? 8 : 3)
	)
		return undefined;
	const { program, item } = context;
	const fn = program.function(item.function);
	for (let depth = 0; depth < 64; depth++) {
		if (fn.kernel.valueDefinitionKind(receiver) !== 1) return undefined;
		const producer = coreInstructionId(fn.kernel.valueDefinitionOwner(receiver));
		const start = fn.kernel.instructionOperandStart(producer);
		if (fn.instructionOpcodeName(producer) === "move") {
			receiver = fn.kernel.operandAt(start);
			continue;
		}
		if (fn.instructionOpcodeName(producer) !== "callKnown") return undefined;
		const attributes = fn.instructionAttributes(producer);
		if (
			attributes.construct ||
			attributes.argumentMode !== undefined ||
			(attributes.operation !== "Symbol.for" &&
				(observation === "key" || attributes.operation !== "Symbol")) ||
			fn.kernel.instructionOperandCount(producer) < 2
		)
			return undefined;
		let input = fn.kernel.operandAt(start + 1);
		const fact = analysis.queryAt(input, producer);
		const string = fact.kind === "known" && fact.brand === "string";
		if (
			!string &&
			attributes.operation === "Symbol" &&
			(fact.kind !== "known" || fact.brand === "undefined")
		)
			return forwardOptionalSymbolDescription(context, producer, input);
		const editor = CoreEditor.open(program, fn.id);
		if (!string) {
			// Capture text at creation; later metadata reads must not repeat coercion.
			input = editor.insertInstruction(
				fn.instructionBlock(producer),
				producer,
				"unary",
				[input],
				{
					attributes: { operator: "tostring" },
					sourcePosition: fn.instructionSourcePosition(producer),
				},
			).outputs[0]!;
			const inputs = Array.from(
				{ length: fn.kernel.instructionOperandCount(producer) },
				(_, index) => fn.kernel.operandAt(start + index),
			);
			inputs[1] = input;
			editor.replaceOperands(producer, inputs);
		}
		if (observation === "string") replaceSymbolText(editor, consumer, input);
		else editor.replaceInstruction(consumer, "move", [input]);
		return editor.commit();
	}
	return undefined;
}

export function eliminateSymbolDescription(
	context: CoreFunctionPassContext,
	analysis: CoreStaticValueAnalysis,
	instruction: CoreInstructionId,
	input: CoreValueId | undefined,
) {
	if (input === undefined || analysis.constant(input) !== undefined) return undefined;
	const fact = analysis.query(input);
	const mayBeUndefined = fact.kind !== "known" || fact.brand === "undefined";
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
	const block = fn.instructionBlock(instruction);
	const terminator = fn.blockTerminator(block);
	const tail: Array<CoreInstructionId> = [];
	if (mayBeUndefined) {
		if (fn.instructionKind(terminator) === "guard") return undefined;
		for (
			let next = fn.instructionNext(instruction);
			next !== undefined && next !== terminator;
			next = fn.instructionNext(next)
		) {
			tail.push(next);
			if (
				edits + tail.length + fn.kernel.valueUseCount(root) + 20 >
				context.remainingEdits
			)
				return undefined;
		}
		if (edits + tail.length + fn.kernel.valueUseCount(root) + 20 > context.remainingEdits)
			return undefined;
	}
	const editor = CoreEditor.open(program, fn.id);
	let description = root,
		text = root;
	if (mayBeUndefined) {
		const sourcePosition = fn.instructionSourcePosition(instruction);
		const absent = editor.insertInstruction(block, instruction, "createUndefined", [], {
			sourcePosition,
		}).outputs[0]!;
		const kinds = new Set(consumers.values());
		const absentInputs: Array<CoreValueId> = [];
		if (kinds.has("description")) absentInputs.push(absent);
		if (kinds.has("string"))
			absentInputs.push(
				editor.insertInstruction(block, instruction, "createString", [], {
					sourcePosition,
					attributes: { stringIndex: symbolStringIndex(editor, "") },
				}).outputs[0]!,
			);
		const convert = editor.createBlock();
		const join = editor.createBlock(absentInputs.map(() => ({})));
		const start = fn.kernel.blockParameterStart(join);
		description = fn.kernel.blockParameterValue(start);
		text = fn.kernel.blockParameterValue(start + absentInputs.length - 1);
		for (const next of tail) editor.moveInstruction(next, join);
		editor.replaceValueUses(root, description);
		editor.setTerminator(join, {
			...coreTerminatorInput(fn, terminator),
			sourcePosition: fn.instructionSourcePosition(terminator),
		});
		const condition = editor.insertInstruction(
			block,
			instruction,
			"binary",
			[input, absent],
			{
				sourcePosition,
				attributes: { operator: "===" },
			},
		).outputs[0]!;
		editor.moveInstruction(instruction, convert);
		editor.replaceTerminator(block, {
			kind: "branch",
			condition,
			consequent: { block: join, arguments: absentInputs },
			alternate: { block: convert, arguments: [] },
			sourcePosition,
		});
		editor.setTerminator(convert, {
			kind: "jump",
			edge: { block: join, arguments: absentInputs.map(() => root) },
			sourcePosition,
		});
		const handler = fn.kernel.blockHandlerBlock(block);
		if (handler !== undefined) {
			const start = fn.kernel.blockHandlerArgumentStart(block);
			const arguments_ = Array.from(
				{ length: fn.kernel.blockHandlerArgumentCount(block) },
				(_, index) => fn.kernel.handlerArgumentAt(start + index),
			);
			editor.setHandler(convert, handler, arguments_);
			editor.setHandler(join, handler, arguments_);
		}
	}
	// Coercion belongs to Symbol creation, even when its description is read after effects.
	editor.replaceInstruction(instruction, "unary", [input], {
		attributes: { operator: "tostring" },
	});
	for (const [consumer, kind] of consumers) {
		if (kind === "description") {
			editor.replaceInstruction(consumer, "move", [description]);
			continue;
		}
		replaceSymbolText(editor, consumer, text);
	}
	return editor.commit();
}
