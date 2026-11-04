import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../shared/compiler-value-kinds.ts";
import { coreCalleeTargetsSingleFunction } from "./core-callee-targets.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import type { CoreEditor } from "./core-editor.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import { coreFunctionId, coreInstructionId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreInstructionAttributes,
	CoreInstructionId,
	CoreFunctionId,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

interface Scalar {
	readonly kind: "scalar";
	readonly number: boolean;
	readonly value?: CoreValueId;
	readonly opcode?: string;
	readonly inputs?: ReadonlyArray<Scalar>;
	readonly attributes?: CoreInstructionAttributes;
}

interface RecordValue {
	readonly kind: "record";
	readonly fields: ReadonlyMap<number, FactoryValue>;
}

interface Closure {
	readonly kind: "closure";
	readonly target: number;
	readonly captures: ReadonlyMap<number, Scalar>;
}

type FactoryValue = Scalar | RecordValue | Closure;

export interface CoreFactoryProjection {
	readonly target: CoreFunctionId;
	readonly producer: CoreInstructionId;
	readonly load: CoreInstructionId;
	readonly call: CoreInstructionId;
	readonly destination?: CoreBlockId;
	readonly result: Scalar;
	readonly cost: number;
}

const NUMERIC_BINARY = new Set([
	"+",
	"-",
	"*",
	"/",
	"%",
	"**",
	"&",
	"|",
	"^",
	"<<",
	">>",
	">>>",
]);
const NUMERIC_UNARY = new Set(["+", "-", "~", "tonumeric", "increment", "decrement"]);
const CONSTANTS = new Set([
	"createNumber",
	"createI32",
	"createF64",
	"createBoolean",
	"createUndefined",
	"createNull",
]);
const LIMIT = 64;

function operands(fn: CoreFunctionStore, instruction: CoreInstructionId) {
	return Array.from(
		{ length: fn.kernel.instructionOperandCount(instruction) },
		(_, index) =>
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index),
	);
}

function output(fn: CoreFunctionStore, instruction: CoreInstructionId) {
	return fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
}

function definition(fn: CoreFunctionStore, value: CoreValueId) {
	return fn.kernel.valueDefinitionKind(value) === 1
		? coreInstructionId(fn.kernel.valueDefinitionOwner(value))
		: undefined;
}

/** Only private construction and total Number operations may move past an observer. */
function factoryValue(
	program: CoreProgram,
	fn: CoreFunctionStore,
	arguments_: ReadonlyArray<Scalar>,
	owner = fn.id as number,
	captures: ReadonlyMap<number, Scalar> = new Map(),
	factory = true,
	budget = { remaining: LIMIT * 2 },
): FactoryValue | undefined {
	if (
		!fn.metadata.strict ||
		fn.metadata.mappedArguments ||
		fn.isAsync ||
		fn.isGenerator ||
		fn.metadata.isClassConstructor ||
		fn.metadata.isDerivedConstructor ||
		(!factory && fn.metadata.capturedCount !== 0) ||
		arguments_.length < fn.parameterCount
	)
		return undefined;
	const values = new Map<CoreValueId, FactoryValue>();
	for (let index = 0; index < fn.parameterCount; index++)
		values.set(fn.kernel.functionParameter(index), arguments_[index]!);
	const cells = new Map(captures);
	const writes = new Set<number>();
	const visited = new Set<CoreBlockId>();
	let block = fn.entry;
	let work = 0;
	let createdClosure = false;
	for (;;) {
		if (
			visited.has(block) ||
			visited.size >= 4 ||
			fn.kernel.blockHandlerBlock(block) !== undefined
		)
			return undefined;
		visited.add(block);
		for (const instruction of fn.bodyInstructionIds(block)) {
			if (++work > LIMIT || --budget.remaining < 0) return undefined;
			const opcode = fn.instructionOpcodeName(instruction);
			const attributes = fn.instructionAttributes(instruction);
			const inputs = operands(fn, instruction).map((value) => values.get(value));
			let value: FactoryValue | undefined;
			if (CONSTANTS.has(opcode)) {
				value = {
					kind: "scalar",
					number: ["createNumber", "createI32", "createF64"].includes(opcode),
					opcode,
					inputs: [],
					attributes,
				};
			} else if (opcode === "move") value = inputs[0];
			else if (opcode === "loadArgument") value = arguments_[attributes.index as number];
			else if (opcode === "loadCaptured" && attributes.functionIndex === owner)
				value = cells.get(attributes.index as number);
			else if (
				opcode === "storeCaptured" &&
				factory &&
				attributes.functionIndex === owner
			) {
				const index = attributes.index as number;
				if (createdClosure || writes.has(index) || inputs[0]?.kind !== "scalar")
					return undefined;
				writes.add(index);
				cells.set(index, inputs[0]);
				continue;
			} else if (
				(opcode === "binary" && NUMERIC_BINARY.has(attributes.operator as string)) ||
				(opcode === "unary" && NUMERIC_UNARY.has(attributes.operator as string))
			) {
				if (
					!inputs.every(
						(input): input is Scalar => input?.kind === "scalar" && input.number,
					)
				)
					return undefined;
				value = {
					kind: "scalar",
					number: true,
					opcode,
					inputs,
					attributes: { operator: attributes.operator! },
				};
			} else if (opcode === "createObjectShaped" && factory) {
				const keys = attributes.keyStringIndices as ReadonlyArray<number>;
				if (inputs.some((input) => input === undefined) || keys.length !== inputs.length)
					return undefined;
				value = {
					kind: "record",
					fields: new Map(keys.map((key, index) => [key, inputs[index]!])),
				};
			} else if (opcode === "createFunction" && factory) {
				const target = attributes.functionIndex as number;
				// A descendant reads only the initialized, immutable cells of this activation.
				if (
					factoryValue(
						program,
						program.function(coreFunctionId(target)),
						[],
						owner,
						cells,
						false,
						budget,
					) === undefined
				)
					return undefined;
				createdClosure = true;
				value = { kind: "closure", target, captures: new Map(cells) };
			} else return undefined;
			if (value === undefined || fn.kernel.instructionResultCount(instruction) !== 1)
				return undefined;
			values.set(output(fn, instruction), value);
		}
		const terminator = fn.blockTerminator(block);
		if (fn.instructionKind(terminator) === "return")
			return values.get(operands(fn, terminator)[0]!);
		if (fn.instructionKind(terminator) !== "jump") return undefined;
		const edge = fn.kernel.terminatorEdgeStart(terminator);
		if (fn.kernel.terminatorEdgeArgumentCount(edge) !== 0) return undefined;
		block = fn.kernel.terminatorEdgeBlock(edge);
	}
}

function singleEvaluation(
	control: CoreControlFlow,
	source: CoreBlockId,
	destination: CoreBlockId,
): boolean {
	if (!control.dominates(source, destination)) return false;
	const visited = new Set<CoreBlockId>();
	const pending = [destination];
	while (pending.length > 0) {
		const block = pending.pop()!;
		if (visited.has(block)) continue;
		if (visited.size >= LIMIT) return false;
		visited.add(block);
		for (const edge of control.successors[block] ?? []) {
			if (edge.to === source) continue;
			if (edge.to === destination) return false;
			pending.push(edge.to);
		}
	}
	return true;
}

export function coreFactoryProjection(
	program: CoreProgram,
	context: CoreCompilationContext,
	summaries: CoreProgramSummaries,
	fn: CoreFunctionStore,
	call: CoreInstructionId,
	kind: (value: CoreValueId) => number,
	control: () => CoreControlFlow,
): CoreFactoryProjection | undefined {
	if (
		!summaries.targets.sourceClosed ||
		context.facts.world.realms ||
		fn.isAsync ||
		fn.isGenerator ||
		fn.instructionOpcodeName(call) !== "call" ||
		fn.instructionAttributes(call).argumentMode !== undefined ||
		fn.instructionAttributes(call).construct
	)
		return undefined;
	const args = operands(fn, call);
	if (args.length !== 2) return undefined;
	const load = definition(fn, args[0]!);
	if (
		load === undefined ||
		fn.instructionOpcodeName(load) !== "loadPropertyStatic" ||
		operands(fn, load)[0] !== args[1]
	)
		return undefined;
	const producer = definition(fn, args[1]!);
	if (
		producer === undefined ||
		fn.instructionOpcodeName(producer) !== "call" ||
		fn.instructionAttributes(producer).argumentMode !== undefined ||
		fn.instructionAttributes(producer).construct
	)
		return undefined;
	const source = fn.instructionBlock(producer);
	if (
		fn.instructionBlock(load) !== source ||
		fn.instructionBlock(call) !== source ||
		fn.kernel.blockHandlerBlock(source) !== undefined
	)
		return undefined;
	const site = summaries.targets.site(fn.id, producer);
	const target =
		site === undefined ? undefined : coreCalleeTargetsSingleFunction(site.targets);
	if (target === undefined) return undefined;
	const inputs = operands(fn, producer);
	if (inputs.length > 18) return undefined;
	if (kind(inputs[1]!) !== COMPILER_VALUE_KIND_UNDEFINED) return undefined;
	if (inputs.slice(2).some((value) => kind(value) !== COMPILER_VALUE_KIND_NUMBER))
		return undefined;
	const factory = program.function(target);
	const budget = { remaining: LIMIT * 2 };
	const value = factoryValue(
		program,
		factory,
		inputs.slice(2).map((value) => ({ kind: "scalar", number: true, value })),
		target,
		new Map(),
		true,
		budget,
	);
	if (value?.kind !== "record") return undefined;
	const field = value.fields.get(fn.instructionAttributes(load).stringIndex as number);
	if (field?.kind !== "closure") return undefined;
	const result = factoryValue(
		program,
		program.function(coreFunctionId(field.target)),
		[],
		target,
		field.captures,
		false,
		budget,
	);
	if (result?.kind !== "scalar") return undefined;
	if (
		fn.kernel.valueHandlerUseCount(args[1]!) !== 0 ||
		fn.kernel.valueHandlerUseCount(args[0]!) !== 0
	)
		return undefined;
	for (
		let use = fn.kernel.valueFirstUse(args[0]!);
		use >= 0;
		use = fn.kernel.useNext(use)
	)
		if (fn.kernel.useInstruction(use) !== call || fn.kernel.useOperand(use) !== 0)
			return undefined;
	let destination: CoreBlockId | undefined;
	let uses = 0;
	for (
		let use = fn.kernel.valueFirstUse(args[1]!);
		use >= 0;
		use = fn.kernel.useNext(use)
	) {
		if (++uses > 16) return undefined;
		const user = coreInstructionId(fn.kernel.useInstruction(use));
		if (user === load || (user === call && fn.kernel.useOperand(use) === 1)) continue;
		if (fn.instructionKind(user) !== "operation") return undefined;
		const opcode = fn.instructionOpcodeName(user);
		if (
			!(
				(opcode === "storePropertyStatic" && fn.kernel.useOperand(use) === 1) ||
				(opcode === "storeProperty" && fn.kernel.useOperand(use) === 2)
			)
		)
			return undefined;
		const block = fn.instructionBlock(user);
		if (
			block === source ||
			(destination !== undefined && destination !== block) ||
			fn.kernel.blockHandlerBlock(block) !== undefined
		)
			return undefined;
		destination = block;
	}
	if (destination !== undefined && !singleEvaluation(control(), source, destination))
		return undefined;
	return { target, producer, load, call, destination, result, cost: LIMIT * 2 };
}

export function applyCoreFactoryProjection(
	fn: CoreFunctionStore,
	editor: CoreEditor,
	plan: CoreFactoryProjection,
): number | undefined {
	if (
		![plan.producer, plan.load, plan.call].every((instruction) =>
			fn.isInstructionLive(instruction),
		)
	)
		return undefined;
	const block = fn.instructionBlock(plan.call);
	const emitted = new Map<Scalar, CoreValueId>();
	let introduced = 0;
	const scalar = (value: Scalar): CoreValueId => {
		if (value.value !== undefined) return value.value;
		let result = emitted.get(value);
		if (result === undefined) {
			result = editor.insertInstruction(
				block,
				plan.call,
				value.opcode!,
				value.inputs!.map(scalar),
				{
					attributes: value.attributes,
					sourcePosition: fn.instructionSourcePosition(plan.call),
				},
			).outputs[0]!;
			emitted.set(value, result);
			introduced++;
		}
		return result;
	};
	editor.replaceInstruction(plan.call, "move", [scalar(plan.result)]);
	editor.removeInstruction(plan.load);
	const inputs = operands(fn, plan.producer);
	editor.insertInstruction(block, plan.producer, "rootUse", [inputs[0]!], {
		outputCount: 0,
	});
	if (plan.destination === undefined) editor.removeInstruction(plan.producer);
	else {
		const anchor = coreInstructionId(fn.kernel.blockFirstInstruction(plan.destination));
		// The factory never reads its callee or an outer scope. Recreate its private
		// callable rather than extending the original callee's weakly observable lifetime.
		const callee = editor.insertInstruction(
			plan.destination,
			anchor,
			"createFunction",
			[],
			{
				attributes: { functionIndex: plan.target },
				sourcePosition: fn.instructionSourcePosition(plan.producer),
			},
		).outputs[0]!;
		editor.replaceOperands(plan.producer, [callee, ...inputs.slice(1)]);
		editor.moveInstruction(plan.producer, plan.destination, anchor);
		introduced++;
	}
	return introduced;
}
