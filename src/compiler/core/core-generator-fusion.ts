import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_UNDEFINED,
	COMPILER_NUMERIC_BINARY_OPERATORS,
	COMPILER_NUMERIC_UNARY_OPERATORS,
} from "../shared/compiler-value-kinds.ts";
import { coreCalleeTargetsSingleFunction } from "./core-callee-targets.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import type { CoreEditor } from "./core-editor.ts";
import { coreUnscopedInstructionAttributes } from "./core-internal-attributes.ts";
import { buildCoreControlFlow, coreTerminatorInput } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import { analyzeCoreValueKinds } from "./core-ir-value-kinds.ts";
import { coreInstructionId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreEdge,
	CoreFunctionId,
	CoreInstructionId,
	CoreTerminatorInput,
	CoreValueId,
} from "./core-ir.ts";
import { coreFunctionVersionsAreCurrent } from "./core-store.ts";
import type {
	CoreFunctionStore,
	CoreFunctionVersions,
	CoreProgram,
} from "./core-store.ts";

interface Protocol {
	readonly call: CoreInstructionId;
	readonly get: CoreInstructionId;
	readonly step: CoreInstructionId;
	readonly closes: ReadonlyArray<CoreInstructionId>;
	readonly header: CoreBlockId;
	readonly initial: CoreBlockId;
	readonly predecessors: ReadonlyArray<CoreBlockId>;
}

interface GeneratorShape {
	readonly blocks: ReadonlyArray<CoreBlockId>;
	readonly instructions: ReadonlyArray<CoreInstructionId>;
	readonly yield: CoreInstructionId;
	readonly yieldBlock: CoreBlockId;
}

export interface CoreGeneratorFusion extends Protocol, GeneratorShape {
	readonly target: CoreFunctionId;
	readonly versions: ReadonlyArray<{
		readonly function: CoreFunctionId;
		readonly versions: CoreFunctionVersions;
	}>;
	readonly functionsVersion: number;
	readonly dataVersion: number;
	readonly cost: number;
}

type KindQuery = (functionId: CoreFunctionId, value: CoreValueId) => number;

function operands(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): Array<CoreValueId> {
	const start = fn.kernel.instructionOperandStart(instruction);
	return Array.from(
		{ length: fn.kernel.instructionOperandCount(instruction) },
		(_, index) => fn.kernel.operandAt(start + index),
	);
}

function results(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): Array<CoreValueId> {
	const start = fn.kernel.instructionResultStart(instruction);
	return Array.from(
		{ length: fn.kernel.instructionResultCount(instruction) },
		(_, index) => fn.kernel.resultAt(start + index),
	);
}

function parameters(fn: CoreFunctionStore, block: CoreBlockId): Array<CoreValueId> {
	const start = fn.kernel.blockParameterStart(block);
	return Array.from({ length: fn.kernel.blockParameterCount(block) }, (_, index) =>
		fn.kernel.blockParameterValue(start + index),
	);
}

function edges(input: CoreTerminatorInput): ReadonlyArray<CoreEdge> {
	return input.kind === "jump"
		? [input.edge]
		: input.kind === "branch"
			? [input.consequent, input.alternate]
			: input.kind === "switch"
				? [...input.cases.map((entry) => entry.edge), input.default]
				: [];
}

function uses(
	fn: CoreFunctionStore,
	value: CoreValueId,
): Array<{ instruction: CoreInstructionId; position: number }> {
	const result = [];
	for (let use = fn.kernel.valueFirstUse(value); use >= 0; use = fn.kernel.useNext(use)) {
		if (fn.kernel.useLive(use) !== 0)
			result.push({
				instruction: coreInstructionId(fn.kernel.useInstruction(use)),
				position: fn.kernel.useOperand(use),
			});
	}
	return result;
}

function bridges(
	source: ReturnType<CoreFunctionStore["valueRepresentation"]>,
	destination: ReturnType<CoreFunctionStore["valueRepresentation"]>,
): boolean {
	return (
		source === destination ||
		destination === "boxed" ||
		(source === "i32" && destination === "f64")
	);
}

function protocol(
	fn: CoreFunctionStore,
	call: CoreInstructionId,
	control: CoreControlFlow,
): Protocol | undefined {
	if (fn.instructionOpcodeName(call) !== "call" || results(fn, call).length !== 1)
		return undefined;
	const value = results(fn, call)[0]!;
	if (fn.kernel.valueHandlerUseCount(value) !== 0) return undefined;
	const consumers = uses(fn, value);
	if (consumers.length !== 1 || consumers[0]!.position !== 0) return undefined;
	const get = consumers[0]!.instruction;
	if (
		fn.instructionKind(get) !== "operation" ||
		fn.instructionOpcodeName(get) !== "getIterator" ||
		fn.instructionNext(call) !== get ||
		results(fn, get).length !== 2
	)
		return undefined;
	const [iterator, next] = results(fn, get);
	if (
		fn.kernel.valueHandlerUseCount(iterator!) !== 0 ||
		fn.kernel.valueHandlerUseCount(next!) !== 0
	)
		return undefined;
	const closes: Array<CoreInstructionId> = [];
	let step: CoreInstructionId | undefined;
	for (const { instruction, position } of uses(fn, iterator!)) {
		if (fn.instructionKind(instruction) !== "operation" || position !== 0)
			return undefined;
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode === "iteratorClose") closes.push(instruction);
		else if (
			opcode === "iteratorStep" &&
			step === undefined &&
			operands(fn, instruction)[1] === next
		)
			step = instruction;
		else return undefined;
	}
	if (
		step === undefined ||
		uses(fn, next!).some(
			({ instruction, position }) => instruction !== step || position !== 1,
		)
	)
		return undefined;
	const header = fn.instructionBlock(step),
		initial = fn.instructionBlock(call);
	if ([...fn.bodyInstructionIds(header)].length !== 1 || results(fn, step).length !== 2)
		return undefined;
	const [yielded, doneValue] = results(fn, step);
	const dispatch = coreTerminatorInput(fn, fn.blockTerminator(header));
	const entry = coreTerminatorInput(fn, fn.blockTerminator(initial));
	if (
		dispatch.kind !== "branch" ||
		dispatch.condition !== doneValue ||
		entry.kind !== "jump" ||
		entry.edge.block !== header ||
		control.dominates(header, initial)
	)
		return undefined;
	const predecessors = control.predecessors[header] ?? [];
	if (
		predecessors.some(
			(edge) =>
				edge.kind !== "ordinary" ||
				(edge.from !== initial &&
					!control.dominatesEdge(header, dispatch.alternate.block, edge.from)),
		) ||
		predecessors.filter((edge) => edge.from === initial).length !== 1
	)
		return undefined;
	if (
		predecessors.some(
			(edge) =>
				!["jump", "branch"].includes(fn.instructionKind(fn.blockTerminator(edge.from))),
		)
	)
		return undefined;
	// The iterator value is unspecified once done. A numeric dummy is safe only on
	// that edge; every observation of the yielded value must follow the body edge.
	for (const { instruction } of uses(fn, yielded!))
		if (
			!control.dominatesEdge(
				header,
				dispatch.alternate.block,
				fn.instructionBlock(instruction),
			)
		)
			return undefined;
	for (const block of fn.blockIds()) {
		const start = fn.kernel.blockHandlerArgumentStart(block);
		for (let index = 0; index < fn.kernel.blockHandlerArgumentCount(block); index++)
			if (
				fn.kernel.handlerArgumentAt(start + index) === yielded &&
				!control.dominatesEdge(header, dispatch.alternate.block, block)
			)
				return undefined;
	}
	if (closes.length > 32) return undefined;
	return {
		call,
		get,
		step,
		closes,
		header,
		initial,
		predecessors: [...new Set(predecessors.map((edge) => edge.from))],
	};
}

function generatorShape(
	program: CoreProgram,
	target: CoreFunctionId,
): GeneratorShape | undefined {
	const fn = program.function(target);
	if (
		!fn.isGenerator ||
		fn.isAsync ||
		!fn.metadata.strict ||
		fn.metadata.mappedArguments ||
		fn.metadata.capturedCount !== 0 ||
		fn.parameterCount > 4 ||
		fn.metadata.length !== fn.parameterCount
	)
		return undefined;
	const control = buildCoreControlFlow(program, target, { exceptions: true });
	if (control.irreducibleCycles.length > 0 || control.reachable.size > 24)
		return undefined;
	const instructions: Array<CoreInstructionId> = [],
		returns: Array<CoreBlockId> = [];
	let yieldInstruction: CoreInstructionId | undefined,
		start = 0;
	for (const block of control.reversePostorder) {
		if (fn.kernel.blockHandlerBlock(block) !== undefined) return undefined;
		const term = fn.blockTerminator(block);
		const terminal = fn.instructionKind(term);
		if (!["jump", "branch", "return", "throw"].includes(terminal)) return undefined;
		if (terminal === "return") returns.push(block);
		for (const instruction of fn.bodyInstructionIds(block)) {
			const opcode = fn.instructionOpcodeName(instruction);
			const attrs = fn.instructionAttributes(instruction);
			if (opcode === "yield") {
				if (
					yieldInstruction !== undefined ||
					results(fn, instruction).length !== 2 ||
					attrs.delegatedResult === true
				)
					return undefined;
				yieldInstruction = instruction;
			} else if (opcode === "generatorStart") start++;
			else if (opcode === "loadArgument") {
				if (
					typeof attrs.index !== "number" ||
					attrs.index < 0 ||
					attrs.index >= fn.parameterCount
				)
					return undefined;
			} else if (opcode === "binary") {
				if (
					!COMPILER_NUMERIC_BINARY_OPERATORS.has(attrs.operator as string) &&
					!["<", "<=", ">", ">=", "==", "!=", "===", "!=="].includes(
						attrs.operator as string,
					)
				)
					return undefined;
			} else if (opcode === "unary") {
				if (
					attrs.operator !== "!" &&
					!COMPILER_NUMERIC_UNARY_OPERATORS.has(attrs.operator as string)
				)
					return undefined;
			} else if (
				![
					"createNumber",
					"createI32",
					"createF64",
					"createBoolean",
					"createUndefined",
					"createNull",
					"move",
					"rootUse",
				].includes(opcode)
			)
				return undefined;
			instructions.push(instruction);
		}
		instructions.push(term);
	}
	if (
		start !== 1 ||
		yieldInstruction === undefined ||
		instructions.length > 64 ||
		returns.length === 0
	)
		return undefined;
	const kinds = analyzeCoreValueKinds(program, fn, control, {
		parameterMasks: Array.from(
			{ length: fn.parameterCount },
			() => COMPILER_VALUE_KIND_NUMBER,
		),
		operationResultMask(instruction, output) {
			if (fn.instructionOpcodeName(instruction) !== "yield") return undefined;
			return results(fn, instruction)[0] === output
				? COMPILER_VALUE_KIND_UNDEFINED
				: COMPILER_VALUE_KIND_NUMBER;
		},
	});
	if (kinds.kindMask(operands(fn, yieldInstruction)[0]!) !== COMPILER_VALUE_KIND_NUMBER)
		return undefined;
	const yieldBlock = fn.instructionBlock(yieldInstruction);
	const before = new Set<CoreInstructionId>();
	for (const instruction of fn.bodyInstructionIds(yieldBlock)) {
		if (instruction === yieldInstruction) break;
		before.add(instruction);
	}
	// Completion also reaches the consumer dispatch. Any state used after resumption
	// must therefore be defined on the completion paths, even when done is constant.
	for (const value of fn.valueIds()) {
		const definitionKind = fn.kernel.valueDefinitionKind(value);
		const owner = fn.kernel.valueDefinitionOwner(value);
		const definition = definitionKind === 1 ? coreInstructionId(owner) : undefined;
		const block =
			definitionKind === 0 ? (owner as CoreBlockId) : fn.instructionBlock(definition!);
		if (
			!control.dominates(block, yieldBlock) ||
			(block === yieldBlock && definition !== undefined && !before.has(definition)) ||
			returns.every((returned) => control.dominates(block, returned))
		)
			continue;
		const observed = (at: CoreBlockId, afterYield: boolean): boolean => {
			if (!afterYield && definitionKind === 0 && at === block) return false;
			let ready = !afterYield;
			for (const instruction of [...fn.bodyInstructionIds(at), fn.blockTerminator(at)]) {
				if (!ready) {
					if (instruction === yieldInstruction) ready = true;
					continue;
				}
				if (instruction === definition) return false;
				if (operands(fn, instruction).includes(value)) return true;
			}
			pending.push(...(control.successors[at] ?? []).map((edge) => edge.to));
			return false;
		};
		const pending: Array<CoreBlockId> = [],
			visited = new Set<CoreBlockId>();
		if (observed(yieldBlock, true)) return undefined;
		while (pending.length > 0) {
			const next = pending.pop()!;
			if (visited.has(next)) continue;
			visited.add(next);
			if (observed(next, false)) return undefined;
		}
	}

	return {
		blocks: control.reversePostorder,
		instructions,
		yield: yieldInstruction,
		yieldBlock,
	};
}

// A private callable is insufficient if another invocation exposes its shared prototype.
// Follow every alias and require every result to remain inside its own traversal.
function privateInvocations(
	program: CoreProgram,
	context: CoreCompilationContext,
	summaries: CoreProgramSummaries,
	target: CoreFunctionId,
	kind: KindQuery,
): boolean {
	const slots = new Set([
		...(context.data.initializedModuleGlobalSlots ?? []),
		...(context.data.moduleVarGlobalSlots ?? []),
	]);
	for (const link of [
		...(context.data.moduleLinks?.imports ?? []),
		...(context.data.moduleLinks?.exports ?? []),
	])
		slots.delete(link.slot);
	const reads = new Map<number, Array<{ fn: CoreFunctionStore; value: CoreValueId }>>();
	const pending: Array<{ fn: CoreFunctionStore; value: CoreValueId }> = [];
	let work = 0;
	for (const id of program.functionIds()) {
		const fn = program.function(id);
		if (summaries.targets.publishedFunctions(id).includes(target)) return false;
		for (const instruction of fn.instructionIds()) {
			if (++work > 8_192) return false;
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction),
				attrs = fn.instructionAttributes(instruction);
			if (opcode === "createFunction" && attrs.functionIndex === target)
				pending.push({ fn, value: results(fn, instruction)[0]! });
			if (opcode === "loadGlobal" && typeof attrs.index === "number") {
				const group = reads.get(attrs.index) ?? [];
				group.push({ fn, value: results(fn, instruction)[0]! });
				reads.set(attrs.index, group);
			}
		}
	}
	if (pending.length === 0) return false;
	const seen = new Set<string>(),
		cells = new Set<number>();
	let calls = 0;
	for (let cursor = 0; cursor < pending.length; cursor++) {
		const { fn, value } = pending[cursor]!;
		const key = `${fn.id}:${value}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (
			seen.size > 512 ||
			fn.kernel.valueHandlerUseCount(value) !== 0 ||
			coreCalleeTargetsSingleFunction(summaries.targets.targets(fn.id, value)) !== target
		)
			return false;
		for (const { instruction, position } of uses(fn, value)) {
			if (++work > 8_192) return false;
			if (fn.instructionKind(instruction) !== "operation") {
				const terminal = coreTerminatorInput(fn, instruction);
				if (
					(terminal.kind !== "jump" && terminal.kind !== "branch") ||
					(terminal.kind === "branch" && terminal.condition === value)
				)
					return false;
				for (const edge of edges(terminal))
					for (const [index, argument] of edge.arguments.entries())
						if (argument === value)
							pending.push({ fn, value: parameters(fn, edge.block)[index]! });
				continue;
			}
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "move") {
				pending.push({ fn, value: results(fn, instruction)[0]! });
				continue;
			}
			if (opcode === "rootUse") continue;
			if (opcode === "storeGlobal") {
				const slot = fn.instructionAttributes(instruction).index;
				if (position !== 0 || typeof slot !== "number" || !slots.has(slot)) return false;
				if (!cells.has(slot)) {
					cells.add(slot);
					pending.push(...(reads.get(slot) ?? []));
				}
				continue;
			}
			if (opcode !== "call" || position !== 0 || fn.isAsync || fn.isGenerator)
				return false;
			const attrs = fn.instructionAttributes(instruction),
				inputs = operands(fn, instruction);
			if (
				attrs.argumentMode !== undefined ||
				attrs.construct ||
				inputs.length !== program.function(target).parameterCount + 2 ||
				kind(fn.id, inputs[1]!) !== COMPILER_VALUE_KIND_UNDEFINED ||
				inputs
					.slice(2)
					.some((argument) => kind(fn.id, argument) !== COMPILER_VALUE_KIND_NUMBER)
			)
				return false;
			if (
				protocol(
					fn,
					instruction,
					buildCoreControlFlow(program, fn.id, { exceptions: true }),
				) === undefined
			)
				return false;
			calls++;
		}
	}
	return calls > 0;
}

export function coreGeneratorFusion(
	program: CoreProgram,
	context: CoreCompilationContext,
	summaries: CoreProgramSummaries,
	caller: CoreFunctionStore,
	call: CoreInstructionId,
	kind: KindQuery,
): CoreGeneratorFusion | undefined {
	if (
		!summaries.targets.sourceClosed ||
		context.facts.world.primordialPolicy !== "locked" ||
		context.facts.world.eval !== "disabled" ||
		context.facts.world.realms ||
		caller.isAsync ||
		caller.isGenerator ||
		caller.instructionOpcodeName(call) !== "call"
	)
		return undefined;
	const target = coreCalleeTargetsSingleFunction(
		summaries.targets.targets(caller.id, operands(caller, call)[0]!),
	);
	if (target === undefined || target === caller.id) return undefined;
	const shape = generatorShape(program, target);
	if (shape === undefined) return undefined;
	const consumer = protocol(
		caller,
		call,
		buildCoreControlFlow(program, caller.id, { exceptions: true }),
	);
	if (
		consumer === undefined ||
		!privateInvocations(program, context, summaries, target, kind)
	)
		return undefined;
	const generator = program.function(target),
		arguments_ = operands(caller, call).slice(2);
	if (
		parameters(generator, generator.entry).some(
			(value) =>
				!Array.from({ length: generator.parameterCount }, (_, index) =>
					generator.kernel.functionParameter(index),
				).includes(value),
		)
	)
		return undefined;
	for (let index = 0; index < generator.parameterCount; index++)
		if (
			!bridges(
				caller.valueRepresentation(arguments_[index]!),
				generator.valueRepresentation(generator.kernel.functionParameter(index)),
			)
		)
			return undefined;
	for (const instruction of shape.instructions)
		if (
			generator.instructionKind(instruction) === "operation" &&
			generator.instructionOpcodeName(instruction) === "loadArgument" &&
			!bridges(
				caller.valueRepresentation(
					arguments_[generator.instructionAttributes(instruction).index as number]!,
				),
				generator.valueRepresentation(results(generator, instruction)[0]!),
			)
		)
			return undefined;
	if (
		!bridges(
			generator.valueRepresentation(operands(generator, shape.yield)[0]!),
			caller.valueRepresentation(results(caller, consumer.step)[0]!),
		)
	)
		return undefined;
	return {
		...consumer,
		...shape,
		target,
		versions: [...program.functionIds()].map((id) => ({
			function: id,
			versions: program.function(id).versions,
		})),
		functionsVersion: program.programVersion("functions"),
		dataVersion: program.programVersion("data"),
		cost:
			shape.instructions.length +
			parameters(caller, consumer.header).length * shape.blocks.length,
	};
}

export function applyCoreGeneratorFusion(
	program: CoreProgram,
	editor: CoreEditor,
	plan: CoreGeneratorFusion,
	positions: ReadonlyMap<CoreInstructionId, number | undefined>,
): { instructionsIntroduced: number; blocksIntroduced: number } | undefined {
	if (
		program.programVersion("functions") !== plan.functionsVersion ||
		program.programVersion("data") !== plan.dataVersion ||
		[...program.functionIds()].length !== plan.versions.length ||
		plan.versions.some(
			(entry) =>
				!coreFunctionVersionsAreCurrent(program.function(entry.function), entry.versions),
		)
	)
		return undefined;
	const caller = editor.function,
		generator = program.function(plan.target);
	const callInputs = operands(caller, plan.call),
		carry = parameters(caller, plan.header);
	const [oldValue, oldDone] = results(caller, plan.step);
	const representations = carry.map((value) => ({
		representation: caller.valueRepresentation(value),
	}));
	const [yielded, done] = editor.appendBlockParameters(plan.header, [
		{ representation: caller.valueRepresentation(oldValue!) },
		{ representation: caller.valueRepresentation(oldDone!) },
	]);
	editor.replaceValueUses(oldValue!, yielded!);
	editor.replaceValueUses(oldDone!, done!);
	const values = new Map<CoreValueId, CoreValueId>(),
		blocks = new Map<CoreBlockId, CoreBlockId>(),
		carries = new Map<CoreBlockId, ReadonlyArray<CoreValueId>>();
	for (const block of plan.blocks) {
		const original = block === generator.entry ? [] : parameters(generator, block);
		const created = editor.createBlock([
			...original.map((value) => ({
				representation: generator.valueRepresentation(value),
			})),
			...representations,
		]);
		blocks.set(block, created);
		const params = parameters(caller, created);
		original.forEach((value, index) => values.set(value, params[index]!));
		carries.set(block, params.slice(original.length));
	}
	const entry = blocks.get(generator.entry)!;
	let introduced = 0;
	const constant = (
		opcode: string,
		attrs: Record<string, number | boolean> = {},
		representation?: ReturnType<CoreFunctionStore["valueRepresentation"]>,
	) => {
		introduced++;
		return editor.appendInstruction(entry, opcode, [], {
			attributes: attrs,
			...(representation === undefined
				? {}
				: { outputRepresentations: [representation] }),
		}).outputs[0]!;
	};
	const absent = constant("createUndefined"),
		zero = constant("createNumber", { value: 0 });
	const dummy = constant(
		"createNumber",
		{ value: 0 },
		caller.valueRepresentation(oldValue!),
	);
	const yes = constant(
			"createBoolean",
			{ value: true },
			caller.valueRepresentation(oldDone!),
		),
		no = constant(
			"createBoolean",
			{ value: false },
			caller.valueRepresentation(oldDone!),
		);
	for (let index = 0; index < generator.parameterCount; index++) {
		const source = generator.kernel.functionParameter(index),
			argument = callInputs[index + 2]!;
		if (generator.valueRepresentation(source) === caller.valueRepresentation(argument))
			values.set(source, argument);
		else {
			values.set(
				source,
				editor.appendInstruction(entry, "move", [argument], {
					outputRepresentations: [generator.valueRepresentation(source)],
				}).outputs[0]!,
			);
			introduced++;
		}
	}
	const yieldedResults = results(generator, plan.yield);
	values.set(yieldedResults[0]!, absent);
	values.set(yieldedResults[1]!, zero);
	const resume = editor.createBlock(representations),
		resumeCarry = parameters(caller, resume);
	const mapEdge = (edge: CoreEdge, current: ReadonlyArray<CoreValueId>): CoreEdge => ({
		block: blocks.get(edge.block)!,
		arguments: [...edge.arguments.map((value) => values.get(value)!), ...current],
	});
	const headerEdge = (
		current: ReadonlyArray<CoreValueId>,
		value: CoreValueId,
		complete: CoreValueId,
	): CoreEdge => ({ block: plan.header, arguments: [...current, value, complete] });
	const attachHandler = (block: CoreBlockId, current: ReadonlyArray<CoreValueId>) => {
		const handler = caller.kernel.blockHandlerBlock(plan.header);
		if (handler === undefined) return;
		const start = caller.kernel.blockHandlerArgumentStart(plan.header);
		const args = Array.from(
			{ length: caller.kernel.blockHandlerArgumentCount(plan.header) },
			(_, index) => {
				const value = caller.kernel.handlerArgumentAt(start + index);
				const at = carry.indexOf(value);
				return at < 0 ? value : current[at]!;
			},
		);
		editor.setHandler(block, handler, args);
	};
	for (const sourceBlock of plan.blocks) {
		let destination = blocks.get(sourceBlock)!,
			current = carries.get(sourceBlock)!;
		attachHandler(destination, current);
		for (const instruction of generator.bodyInstructionIds(sourceBlock)) {
			const opcode = generator.instructionOpcodeName(instruction);
			if (opcode === "generatorStart") continue;
			if (instruction === plan.yield) {
				let value = values.get(operands(generator, instruction)[0]!)!;
				if (caller.valueRepresentation(value) !== caller.valueRepresentation(oldValue!)) {
					value = editor.appendInstruction(destination, "move", [value], {
						outputRepresentations: [caller.valueRepresentation(oldValue!)],
					}).outputs[0]!;
					introduced++;
				}
				editor.setTerminator(destination, {
					kind: "jump",
					edge: headerEdge(current, value, no),
					sourcePosition: positions.get(instruction),
				});
				destination = resume;
				current = resumeCarry;
				attachHandler(destination, current);
				continue;
			}
			if (opcode === "loadArgument") {
				const output = results(generator, instruction)[0]!,
					argument =
						callInputs[
							2 + (generator.instructionAttributes(instruction).index as number)
						]!;
				if (
					generator.valueRepresentation(output) === caller.valueRepresentation(argument)
				)
					values.set(output, argument);
				else {
					values.set(
						output,
						editor.appendInstruction(destination, "move", [argument], {
							outputRepresentations: [generator.valueRepresentation(output)],
						}).outputs[0]!,
					);
					introduced++;
				}
				continue;
			}
			const inputs = operands(generator, instruction).map((value) => values.get(value));
			if (inputs.some((value) => value === undefined))
				throw new Error("Generator fusion input is not dominated");
			const outputs = results(generator, instruction);
			const created = editor.appendInstruction(
				destination,
				opcode,
				inputs as ReadonlyArray<CoreValueId>,
				{
					outputCount: outputs.length,
					outputRepresentations: outputs.map((value) =>
						generator.valueRepresentation(value),
					),
					attributes: coreUnscopedInstructionAttributes(
						generator.instructionAttributes(instruction),
					),
					sourcePosition: positions.get(instruction),
				},
			);
			introduced++;
			outputs.forEach((value, index) => values.set(value, created.outputs[index]!));
		}
		const terminalId = generator.blockTerminator(sourceBlock),
			terminal = coreTerminatorInput(generator, terminalId);
		const position = positions.get(terminalId);
		if (terminal.kind === "return")
			editor.setTerminator(destination, {
				kind: "jump",
				edge: headerEdge(current, dummy, yes),
				sourcePosition: position,
			});
		else if (terminal.kind === "throw")
			editor.setTerminator(destination, {
				kind: "throw",
				value: values.get(terminal.value)!,
				sourcePosition: position,
			});
		else if (terminal.kind === "jump")
			editor.setTerminator(destination, {
				kind: "jump",
				edge: mapEdge(terminal.edge, current),
				sourcePosition: position,
			});
		else if (terminal.kind === "branch")
			editor.setTerminator(destination, {
				kind: "branch",
				condition: values.get(terminal.condition)!,
				consequent: mapEdge(terminal.consequent, current),
				alternate: mapEdge(terminal.alternate, current),
				sourcePosition: position,
			});
		else throw new Error("Unsupported generator fusion terminator");
	}
	const redirect = (edge: CoreEdge, initial: boolean): CoreEdge =>
		edge.block !== plan.header
			? edge
			: { block: initial ? entry : resume, arguments: edge.arguments };
	for (const block of plan.predecessors) {
		const terminal = coreTerminatorInput(caller, caller.blockTerminator(block));
		if (terminal.kind === "jump")
			editor.replaceTerminator(block, {
				...terminal,
				edge: redirect(terminal.edge, block === plan.initial),
			});
		else if (terminal.kind === "branch")
			editor.replaceTerminator(block, {
				...terminal,
				consequent: redirect(terminal.consequent, false),
				alternate: redirect(terminal.alternate, false),
			});
		else throw new Error("Unsupported generator fusion predecessor");
	}
	const exit = editor.createBlock();
	editor.appendInstruction(exit, "rootUse", [callInputs[0]!], { outputCount: 0 });
	introduced++;
	const dispatch = coreTerminatorInput(caller, caller.blockTerminator(plan.header));
	if (dispatch.kind !== "branch") throw new Error("Generator fusion dispatch changed");
	editor.setTerminator(exit, { kind: "jump", edge: dispatch.consequent });
	editor.replaceTerminator(plan.header, {
		...dispatch,
		consequent: { block: exit, arguments: [] },
	});
	for (const close of plan.closes) {
		editor.replaceInstruction(close, "rootUse", [callInputs[0]!]);
		introduced++;
	}
	editor.removeInstruction(plan.step);
	editor.removeInstruction(plan.get);
	editor.removeInstruction(plan.call);
	return { instructionsIntroduced: introduced, blocksIntroduced: blocks.size + 2 };
}
