import { unconfinedDynamicCode } from "../shared/compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_UNDEFINED,
	COMPILER_NUMERIC_BINARY_OPERATORS,
	COMPILER_NUMERIC_UNARY_OPERATORS,
} from "../shared/compiler-value-kinds.ts";
import { coreCalleeTargetsSingleFunction } from "./core-callee-targets.ts";
import { coreClosedCapturedValueSlots } from "./core-compilation.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import type { CoreEditor } from "./core-editor.ts";
import {
	emitGuardedIterationInstruction,
	guardedIterationEntrySplittable,
	guardIterationCloses,
	splitGuardedIterationEntry,
} from "./core-guarded-iteration.ts";
import type { CoreGuardedIterationEdits } from "./core-guarded-iteration.ts";
import {
	CORE_GENERATOR_FUSION_TWIN_ATTRIBUTE,
	coreUnscopedInstructionAttributes,
} from "./core-internal-attributes.ts";
import { buildCoreControlFlow, coreTerminatorInput } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import { analyzeCoreValueKinds } from "./core-ir-value-kinds.ts";
import { coreInstructionId } from "./core-ir.ts";
import type {
	CoreAttributeValue,
	CoreBlockId,
	CoreEdge,
	CoreFunctionId,
	CoreInstructionId,
	CoreRepresentation,
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
	/** Values defined before the yield that some path after resumption reads. */
	readonly live: ReadonlyArray<CoreValueId>;
}

export interface CoreGeneratorFusion extends Protocol, GeneratorShape {
	readonly target: CoreFunctionId;
	/**
	 * Mutable primordials keep the original protocol as a twin that a guard selects
	 * at loop entry; `state` is then the generator state the fused path threads
	 * through the twin's iterations.
	 */
	readonly guarded: boolean;
	readonly state: ReadonlyArray<CoreValueId>;
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
	const live: Array<CoreValueId> = [];
	for (const value of fn.valueIds()) {
		const definitionKind = fn.kernel.valueDefinitionKind(value);
		const owner = fn.kernel.valueDefinitionOwner(value);
		const definition = definitionKind === 1 ? coreInstructionId(owner) : undefined;
		const block =
			definitionKind === 0 ? (owner as CoreBlockId) : fn.instructionBlock(definition!);
		if (
			!control.dominates(block, yieldBlock) ||
			(block === yieldBlock && definition !== undefined && !before.has(definition))
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
		let resumed = observed(yieldBlock, true);
		while (!resumed && pending.length > 0) {
			const next = pending.pop()!;
			if (visited.has(next)) continue;
			visited.add(next);
			resumed = observed(next, false);
		}
		if (!resumed) continue;
		if (!returns.every((returned) => control.dominates(block, returned)))
			return undefined;
		live.push(value);
	}

	return {
		blocks: control.reversePostorder,
		instructions,
		yield: yieldInstruction,
		yieldBlock,
		live,
	};
}

/** The cell a `loadGlobal`, `storeGlobal`, `loadCaptured` or `storeCaptured` names. */
function cellKey(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): string | undefined {
	const attrs = fn.instructionAttributes(instruction);
	switch (fn.instructionOpcodeName(instruction)) {
		case "loadGlobal":
		case "storeGlobal":
			return typeof attrs.index === "number" ? `global:${attrs.index}` : undefined;
		case "loadCaptured":
		case "storeCaptured":
			return typeof attrs.functionIndex === "number" && typeof attrs.index === "number"
				? `captured:${attrs.functionIndex}:${attrs.index}`
				: undefined;
		default:
			return undefined;
	}
}

interface Alias {
	readonly function: CoreFunctionId;
	readonly value: CoreValueId;
}

interface FunctionReferences {
	readonly bodyVersion: number;
	readonly creations: ReadonlyArray<{
		readonly target: unknown;
		readonly value: CoreValueId;
	}>;
	readonly loads: ReadonlyArray<{ readonly cell: string; readonly value: CoreValueId }>;
}

const functionReferences = new WeakMap<CoreFunctionStore, FunctionReferences>();

function referencesOf(fn: CoreFunctionStore): FunctionReferences {
	// An open editor's edits move no version until it commits.
	const bodyVersion = fn.hasActiveEditor ? undefined : fn.version("body");
	const cached = functionReferences.get(fn);
	if (bodyVersion !== undefined && cached?.bodyVersion === bodyVersion) return cached;
	const creations: Array<{ target: unknown; value: CoreValueId }> = [],
		loads: Array<{ cell: string; value: CoreValueId }> = [];
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode === "createFunction")
			creations.push({
				target: fn.instructionAttributes(instruction).functionIndex,
				value: results(fn, instruction)[0]!,
			});
		else if (opcode === "loadGlobal" || opcode === "loadCaptured") {
			const cell = cellKey(fn, instruction);
			if (cell !== undefined) loads.push({ cell, value: results(fn, instruction)[0]! });
		}
	}
	const references = { bodyVersion: bodyVersion ?? -1, creations, loads };
	if (bodyVersion !== undefined) functionReferences.set(fn, references);
	return references;
}

/**
 * Where a program creates each function and reads each private cell, so a privacy
 * proof visits only its generator's own aliases. A private cell is one every reader
 * of which is a Core load: a private module slot, or a captured cell outside any
 * mapped arguments object. CommonJS top-level bindings are captured cells of the
 * module wrapper, so they are as private as an ES module's slots.
 */
interface PrivacyIndex {
	readonly versions: string;
	readonly context: CoreCompilationContext;
	readonly privateCells: ReadonlySet<string>;
	readonly creations: ReadonlyMap<unknown, ReadonlyArray<Alias>>;
	readonly loads: ReadonlyMap<string, ReadonlyArray<Alias>>;
	/** Proof results per generator under `targets`, which they also depend on. */
	readonly proofs: WeakMap<object, Map<CoreFunctionId, boolean>>;
}

const privacyIndexes = new WeakMap<CoreProgram, PrivacyIndex>();

/**
 * What the index and the cached proofs read: function bodies, and through the
 * local value kinds of argument checks, the domains those kinds depend on.
 */
const PRIVACY_FUNCTION_DOMAINS = [
	"body",
	"cfg",
	"exceptionFlow",
	"memoryEffects",
	"normalResults",
	"representations",
] as const;

function privacyIndex(
	program: CoreProgram,
	context: CoreCompilationContext,
): PrivacyIndex {
	const versions = [
		program.programVersion("functions"),
		...PRIVACY_FUNCTION_DOMAINS.map((domain) => program.functionVersion(domain)),
	].join(":");
	const cached = privacyIndexes.get(program);
	if (
		program.editingFunctions.size === 0 &&
		cached?.versions === versions &&
		cached.context === context
	)
		return cached;
	const privateCells = new Set<string>();
	const links = new Set(
		[
			...(context.data.moduleLinks?.imports ?? []),
			...(context.data.moduleLinks?.exports ?? []),
		].map((link) => link.slot),
	);
	// Lexical slots a function can read in their dead zone are as private as
	// initialized ones; their dead-zone checks reveal only initialization.
	for (const slot of [
		...(context.data.initializedModuleGlobalSlots ?? []),
		...(context.data.moduleVarGlobalSlots ?? []),
		...(context.data.moduleLexicalSlots ?? []).map(({ slot }) => slot),
	])
		if (!links.has(slot)) privateCells.add(`global:${slot}`);
	for (const { owner, index } of coreClosedCapturedValueSlots(program, context))
		privateCells.add(`captured:${owner}:${index}`);
	const creations = new Map<unknown, Array<Alias>>(),
		loads = new Map<string, Array<Alias>>();
	for (const id of program.functionIds()) {
		const references = referencesOf(program.function(id));
		for (const { target, value } of references.creations) {
			const group = creations.get(target);
			if (group === undefined) creations.set(target, [{ function: id, value }]);
			else group.push({ function: id, value });
		}
		for (const { cell, value } of references.loads) {
			if (!privateCells.has(cell)) continue;
			const group = loads.get(cell);
			if (group === undefined) loads.set(cell, [{ function: id, value }]);
			else group.push({ function: id, value });
		}
	}
	const index: PrivacyIndex = {
		versions,
		context,
		privateCells,
		creations,
		loads,
		proofs: new WeakMap<object, Map<CoreFunctionId, boolean>>(),
	};
	if (program.editingFunctions.size === 0) privacyIndexes.set(program, index);
	return index;
}

const publishedFunctionSets = new WeakMap<
	CoreProgram,
	{
		readonly targets: object;
		readonly functionsVersion: number;
		readonly published: ReadonlySet<CoreFunctionId>;
	}
>();

/** Every function some function's summary publishes beyond the program's view. */
function publishedFunctions(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
): ReadonlySet<CoreFunctionId> {
	const functionsVersion = program.programVersion("functions");
	const cached = publishedFunctionSets.get(program);
	if (
		cached?.targets === summaries.targets &&
		cached.functionsVersion === functionsVersion
	)
		return cached.published;
	const published = new Set<CoreFunctionId>();
	for (const id of program.functionIds())
		for (const target of summaries.targets.publishedFunctions(id)) published.add(target);
	publishedFunctionSets.set(program, {
		targets: summaries.targets,
		functionsVersion,
		published,
	});
	return published;
}

/**
 * Whether every invocation of `target` is a for-of protocol call a fusion can
 * replace. A private callable is insufficient if another invocation exposes its
 * shared prototype, so the proof follows every alias of every closure of `target`
 * and requires every use to remain inside its own traversal.
 */
function privateInvocations(
	program: CoreProgram,
	context: CoreCompilationContext,
	summaries: CoreProgramSummaries,
	target: CoreFunctionId,
	kind: KindQuery,
): boolean {
	if (publishedFunctions(program, summaries).has(target)) return false;
	const index = privacyIndex(program, context);
	let proofs = index.proofs.get(summaries.targets);
	if (proofs === undefined) {
		proofs = new Map();
		index.proofs.set(summaries.targets, proofs);
	}
	let proof = proofs.get(target);
	if (proof === undefined) {
		proof = provePrivateInvocations(program, summaries, index, target, kind);
		proofs.set(target, proof);
	}
	return proof;
}

function provePrivateInvocations(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	index: PrivacyIndex,
	target: CoreFunctionId,
	kind: KindQuery,
): boolean {
	const pending: Array<Alias> = [...(index.creations.get(target) ?? [])];
	if (pending.length === 0) return false;
	const seen = new Set<string>(),
		cells = new Set<string>(),
		controls = new Map<CoreFunctionId, CoreControlFlow>();
	let calls = 0,
		work = 0;
	for (let cursor = 0; cursor < pending.length; cursor++) {
		const { function: id, value } = pending[cursor]!;
		const fn = program.function(id);
		const key = `${id}:${value}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (
			seen.size > 512 ||
			fn.kernel.valueHandlerUseCount(value) !== 0 ||
			coreCalleeTargetsSingleFunction(summaries.targets.targets(id, value)) !== target
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
					for (const [at, argument] of edge.arguments.entries())
						if (argument === value)
							pending.push({ function: id, value: parameters(fn, edge.block)[at]! });
				continue;
			}
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "move") {
				pending.push({ function: id, value: results(fn, instruction)[0]! });
				continue;
			}
			// A dead-zone check only tests whether the binding is initialized yet.
			if (opcode === "rootUse" || (opcode === "throwIfTdz" && position === 0)) continue;
			if (opcode === "storeGlobal" || opcode === "storeCaptured") {
				const cell = cellKey(fn, instruction);
				if (position !== 0 || cell === undefined || !index.privateCells.has(cell))
					return false;
				if (!cells.has(cell)) {
					cells.add(cell);
					pending.push(...(index.loads.get(cell) ?? []));
				}
				continue;
			}
			if (opcode !== "call" || position !== 0 || fn.isAsync || fn.isGenerator)
				return false;
			const attrs = fn.instructionAttributes(instruction),
				inputs = operands(fn, instruction);
			// A guarded fusion's twin and rebuild calls hand their generator only to
			// the protocol; user code can see it only once the protector has failed,
			// which permanently selects the twin of every later fused loop.
			const twin = attrs[CORE_GENERATOR_FUSION_TWIN_ATTRIBUTE] === true;
			if (
				attrs.argumentMode !== undefined ||
				attrs.construct ||
				inputs.length !== program.function(target).parameterCount + 2 ||
				kind(id, inputs[1]!) !== COMPILER_VALUE_KIND_UNDEFINED ||
				inputs
					.slice(2)
					.some((argument) => kind(id, argument) !== COMPILER_VALUE_KIND_NUMBER)
			)
				return false;
			if (!twin) {
				let control = controls.get(id);
				if (control === undefined) {
					control = buildCoreControlFlow(program, id, { exceptions: true });
					controls.set(id, control);
				}
				if (protocol(fn, instruction, control) === undefined) return false;
			}
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
		unconfinedDynamicCode(context.facts) ||
		context.facts.world.realms ||
		caller.isAsync ||
		caller.isGenerator ||
		caller.instructionOpcodeName(call) !== "call" ||
		caller.instructionAttributes(call)[CORE_GENERATOR_FUSION_TWIN_ATTRIBUTE] === true
	)
		return undefined;
	const guarded = context.facts.world.primordialPolicy !== "locked";
	const target = coreCalleeTargetsSingleFunction(
		summaries.targets.targets(caller.id, operands(caller, call)[0]!),
	);
	if (target === undefined || target === caller.id) return undefined;
	const shape = generatorShape(program, target);
	if (shape === undefined) return undefined;
	const control = buildCoreControlFlow(program, caller.id, { exceptions: true });
	const consumer = protocol(caller, call, control);
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
	const state = guarded ? threadedState(generator, shape) : [];
	if (
		guarded &&
		(state.some(
			(value) => dummyOpcode(generator.valueRepresentation(value)) === undefined,
		) ||
			consumer.closes.some(
				(close) => !control.dominates(consumer.header, caller.instructionBlock(close)),
			) ||
			!guardedIterationEntrySplittable(caller, call))
	)
		return undefined;
	return {
		...consumer,
		...shape,
		target,
		guarded,
		state,
		versions: [...program.functionIds()].map((id) => ({
			function: id,
			versions: program.function(id).versions,
		})),
		functionsVersion: program.programVersion("functions"),
		dataVersion: program.programVersion("data"),
		cost:
			shape.instructions.length +
			parameters(caller, consumer.header).length * shape.blocks.length +
			(guarded
				? (state.length + 1) * shape.blocks.length + 16 + 12 * consumer.closes.length
				: 0),
	};
}

/** Instructions a guarded fusion evaluates once at loop entry instead of in place. */
function hoistedAtEntry(fn: CoreFunctionStore, instruction: CoreInstructionId): boolean {
	return (
		fn.instructionKind(instruction) === "operation" &&
		[
			"createNumber",
			"createI32",
			"createF64",
			"createBoolean",
			"createUndefined",
			"createNull",
			"loadArgument",
		].includes(fn.instructionOpcodeName(instruction))
	);
}

/*
 * The twin also reaches the consumer header, so fused generator blocks no longer
 * dominate the loop body. Live state that entry does not define once is carried
 * through every fused block and the header instead.
 */
function threadedState(
	fn: CoreFunctionStore,
	shape: GeneratorShape,
): ReadonlyArray<CoreValueId> {
	const parametersOfFunction = new Set(
		Array.from({ length: fn.parameterCount }, (_, index) =>
			fn.kernel.functionParameter(index),
		),
	);
	return shape.live.filter(
		(value) =>
			!parametersOfFunction.has(value) &&
			(fn.kernel.valueDefinitionKind(value) !== 1 ||
				!hoistedAtEntry(fn, coreInstructionId(fn.kernel.valueDefinitionOwner(value)))),
	);
}

function dummyOpcode(representation: CoreRepresentation): string | undefined {
	switch (representation) {
		case "boxed":
			return "createUndefined";
		case "i32":
		case "f64":
			return "createNumber";
		case "boolean":
			return "createBoolean";
		default:
			return undefined;
	}
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
	if (plan.guarded) return applyGuardedGeneratorFusion(program, editor, plan, positions);
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

/*
 * Mutable primordials guard the fusion as a guarded iteration (see
 * core-guarded-iteration.ts): the generator-protocol protector covers
 * %GeneratorPrototype% and %IteratorPrototype%, so while it holds at the call, the
 * fused body replaces the call, GetIterator and every step; otherwise the original
 * ones run as the twin, chosen once per loop and re-dispatched at the back edge.
 * Fused and twin steps meet at the consumer header, which therefore carries the
 * threaded generator state and the number of values consumed so far.
 *
 * A fused close rebuilds the suspended generator by calling the private generator
 * function again and resuming it as many times as the loop consumed values. The
 * generator body is pure and was never exposed, so the rebuilt generator is the one
 * the loop would have held.
 */
function applyGuardedGeneratorFusion(
	program: CoreProgram,
	editor: CoreEditor,
	plan: CoreGeneratorFusion,
	positions: ReadonlyMap<CoreInstructionId, number | undefined>,
): { instructionsIntroduced: number; blocksIntroduced: number } {
	const caller = editor.function,
		generator = program.function(plan.target);
	const callInputs = operands(caller, plan.call),
		carry = parameters(caller, plan.header);
	const [oldValue, oldDone] = results(caller, plan.step);
	const sourcePosition = caller.instructionSourcePosition(plan.call);
	const edits: CoreGuardedIterationEdits = { instructions: 0, blocks: 0 };
	const createBlock = (
		specs: ReadonlyArray<{ representation: CoreRepresentation }> = [],
	) => {
		edits.blocks++;
		return editor.createBlock(specs);
	};
	const emit = (
		block: CoreBlockId,
		opcode: string,
		inputs: ReadonlyArray<CoreValueId> = [],
		attributes: Readonly<Record<string, CoreAttributeValue>> = {},
		representation?: CoreRepresentation,
	): CoreValueId =>
		emitGuardedIterationInstruction(
			editor,
			edits,
			block,
			opcode,
			inputs,
			sourcePosition,
			attributes,
			representation,
		);

	const initialTerminator = caller.blockTerminator(plan.initial);
	const entryEdge = coreTerminatorInput(caller, initialTerminator);
	if (entryEdge.kind !== "jump") throw new Error("Generator fusion entry changed");
	const entryPosition = caller.instructionSourcePosition(initialTerminator);
	const twinAttributes = {
		...caller.instructionAttributes(plan.call),
		[CORE_GENERATOR_FUSION_TWIN_ATTRIBUTE]: true,
	};
	editor.replaceInstruction(plan.call, "call", callInputs, {
		attributes: twinAttributes,
		sourcePosition,
		effectRefinement: caller.instructionEffectRefinement(plan.call),
	});
	const { join, fused } = splitGuardedIterationEntry(
		caller,
		editor,
		edits,
		[plan.call, plan.get],
		"generator-protocol",
	);

	// Everything the fused path needs before its first block is defined once in the
	// join, which dominates both paths.
	const values = new Map<CoreValueId, CoreValueId>();
	const absent = emit(join, "createUndefined");
	const zero = emit(join, "createNumber", [], { value: 0 });
	const dummy = emit(
		join,
		"createNumber",
		[],
		{ value: 0 },
		caller.valueRepresentation(oldValue!),
	);
	const yes = emit(
		join,
		"createBoolean",
		[],
		{ value: true },
		caller.valueRepresentation(oldDone!),
	);
	const no = emit(
		join,
		"createBoolean",
		[],
		{ value: false },
		caller.valueRepresentation(oldDone!),
	);
	const noValues = emit(join, "createNumber", [], { value: 0 }, "f64");
	const one = emit(join, "createNumber", [], { value: 1 }, "f64");
	const argumentValue = (index: number, representation: CoreRepresentation) => {
		const argument = callInputs[index + 2]!;
		return caller.valueRepresentation(argument) === representation
			? argument
			: emit(join, "move", [argument], {}, representation);
	};
	for (let index = 0; index < generator.parameterCount; index++) {
		const source = generator.kernel.functionParameter(index);
		values.set(source, argumentValue(index, generator.valueRepresentation(source)));
	}
	const hoisted = new Set<CoreInstructionId>();
	for (const instruction of plan.instructions) {
		if (!hoistedAtEntry(generator, instruction)) continue;
		hoisted.add(instruction);
		const output = results(generator, instruction)[0]!;
		const representation = generator.valueRepresentation(output);
		values.set(
			output,
			generator.instructionOpcodeName(instruction) === "loadArgument"
				? argumentValue(
						generator.instructionAttributes(instruction).index as number,
						representation,
					)
				: emit(
						join,
						generator.instructionOpcodeName(instruction),
						[],
						coreUnscopedInstructionAttributes(
							generator.instructionAttributes(instruction),
						),
						representation,
					),
		);
	}
	const yieldedResults = results(generator, plan.yield);
	values.set(yieldedResults[0]!, absent);
	values.set(yieldedResults[1]!, zero);
	const stateRepresentations = plan.state.map((value) => ({
		representation: generator.valueRepresentation(value),
	}));
	const dummies = new Map<CoreRepresentation, CoreValueId>();
	const stateDummies = stateRepresentations.map(({ representation }) => {
		let value = dummies.get(representation);
		if (value === undefined) {
			const opcode = dummyOpcode(representation)!;
			value = emit(
				join,
				opcode,
				[],
				opcode === "createUndefined"
					? {}
					: { value: opcode === "createBoolean" ? false : 0 },
				representation,
			);
			dummies.set(representation, value);
		}
		return value;
	});

	// The header receives the consumed count, the step result and the threaded state.
	const carryRepresentations = carry.map((value) => ({
		representation: caller.valueRepresentation(value),
	}));
	const headerAdded = editor.appendBlockParameters(plan.header, [
		{ representation: "f64" },
		{ representation: caller.valueRepresentation(oldValue!) },
		{ representation: caller.valueRepresentation(oldDone!) },
		...stateRepresentations,
	]);
	const [consumed, yielded, done] = headerAdded;
	const headerState = headerAdded.slice(3);
	editor.replaceValueUses(oldValue!, yielded!);
	editor.replaceValueUses(oldDone!, done!);
	const headerHandler = caller.kernel.blockHandlerBlock(plan.header);
	const headerHandlerStart = caller.kernel.blockHandlerArgumentStart(plan.header);
	const headerHandlerArguments = Array.from(
		{ length: caller.kernel.blockHandlerArgumentCount(plan.header) },
		(_, index) => caller.kernel.handlerArgumentAt(headerHandlerStart + index),
	);
	const attachHandler = (block: CoreBlockId, current: ReadonlyArray<CoreValueId>) => {
		if (headerHandler === undefined) return;
		editor.setHandler(
			block,
			headerHandler,
			headerHandlerArguments.map((value) => {
				const at = carry.indexOf(value);
				return at < 0 ? value : current[at]!;
			}),
		);
	};

	// The twin's step keeps the original iterator record.
	const twinStep = createBlock(carryRepresentations);
	const twinCarry = parameters(caller, twinStep);
	attachHandler(twinStep, twinCarry);
	editor.moveInstruction(plan.step, twinStep);
	editor.setTerminator(twinStep, {
		kind: "jump",
		edge: {
			block: plan.header,
			arguments: [...twinCarry, noValues, oldValue!, oldDone!, ...stateDummies],
		},
		sourcePosition: caller.instructionSourcePosition(plan.step),
	});

	// Fused blocks carry the consumer's loop state, the count and the generator state.
	const fusedCarry = [...carryRepresentations, { representation: "f64" as const }];
	const blocks = new Map<CoreBlockId, CoreBlockId>();
	for (const block of plan.blocks) {
		const original = block === generator.entry ? [] : parameters(generator, block);
		blocks.set(
			block,
			createBlock([
				...original.map((value) => ({
					representation: generator.valueRepresentation(value),
				})),
				...fusedCarry,
				...stateRepresentations,
			]),
		);
	}
	const entry = blocks.get(generator.entry)!;
	const resume = createBlock([...fusedCarry, ...stateRepresentations]);
	const stateIndex = new Map(plan.state.map((value, index) => [value, index]));
	interface Frame {
		readonly carry: ReadonlyArray<CoreValueId>;
		readonly state: Array<CoreValueId>;
	}
	const frame = (block: CoreBlockId, originalCount: number): Frame => {
		const params = parameters(caller, block);
		return {
			carry: params.slice(originalCount, originalCount + fusedCarry.length),
			state: params.slice(originalCount + fusedCarry.length),
		};
	};
	const lookup = (current: Frame, value: CoreValueId): CoreValueId => {
		const at = stateIndex.get(value);
		const mapped = at === undefined ? values.get(value) : current.state[at];
		if (mapped === undefined) throw new Error("Generator fusion input is not dominated");
		return mapped;
	};
	const define = (current: Frame, value: CoreValueId, mapped: CoreValueId) => {
		values.set(value, mapped);
		const at = stateIndex.get(value);
		if (at !== undefined) current.state[at] = mapped;
	};
	const mapEdge = (edge: CoreEdge, current: Frame): CoreEdge => ({
		block: blocks.get(edge.block)!,
		arguments: [
			...edge.arguments.map((value) => lookup(current, value)),
			...current.carry,
			...current.state,
		],
	});
	const headerEdge = (
		current: Frame,
		value: CoreValueId,
		complete: CoreValueId,
	): CoreEdge => ({
		block: plan.header,
		arguments: [
			...current.carry.slice(0, carry.length),
			current.carry[carry.length]!,
			value,
			complete,
			...current.state,
		],
	});
	for (const sourceBlock of plan.blocks) {
		let destination = blocks.get(sourceBlock)!;
		const original =
			sourceBlock === generator.entry ? [] : parameters(generator, sourceBlock);
		let current = frame(destination, original.length);
		const destinationParameters = parameters(caller, destination);
		original.forEach((value, index) =>
			define(current, value, destinationParameters[index]!),
		);
		attachHandler(destination, current.carry);
		for (const instruction of generator.bodyInstructionIds(sourceBlock)) {
			const opcode = generator.instructionOpcodeName(instruction);
			if (opcode === "generatorStart" || hoisted.has(instruction)) continue;
			if (instruction === plan.yield) {
				let value = lookup(current, operands(generator, instruction)[0]!);
				if (caller.valueRepresentation(value) !== caller.valueRepresentation(oldValue!))
					value = emit(
						destination,
						"move",
						[value],
						{},
						caller.valueRepresentation(oldValue!),
					);
				editor.setTerminator(destination, {
					kind: "jump",
					edge: headerEdge(current, value, no),
					sourcePosition: positions.get(instruction),
				});
				destination = resume;
				current = frame(resume, 0);
				attachHandler(destination, current.carry);
				continue;
			}
			const inputs = operands(generator, instruction).map((value) =>
				lookup(current, value),
			);
			const outputs = results(generator, instruction);
			const created = editor.appendInstruction(destination, opcode, inputs, {
				outputCount: outputs.length,
				outputRepresentations: outputs.map((value) =>
					generator.valueRepresentation(value),
				),
				attributes: coreUnscopedInstructionAttributes(
					generator.instructionAttributes(instruction),
				),
				sourcePosition: positions.get(instruction),
			});
			edits.instructions++;
			outputs.forEach((value, index) => define(current, value, created.outputs[index]!));
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
				value: lookup(current, terminal.value),
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
				condition: lookup(current, terminal.condition),
				consequent: mapEdge(terminal.consequent, current),
				alternate: mapEdge(terminal.alternate, current),
				sourcePosition: position,
			});
		else throw new Error("Unsupported generator fusion terminator");
	}

	editor.replaceTerminator(join, {
		kind: "branch",
		condition: fused,
		consequent: {
			block: entry,
			arguments: [...entryEdge.edge.arguments, noValues, ...stateDummies],
		},
		alternate: { block: twinStep, arguments: entryEdge.edge.arguments },
		sourcePosition: entryPosition,
	});

	// Back edges resume whichever path the loop entered on.
	const dispatch = createBlock(carryRepresentations);
	const dispatchCarry = parameters(caller, dispatch);
	attachHandler(dispatch, dispatchCarry);
	const counted = emit(dispatch, "binary", [consumed!, one], { operator: "+" }, "f64");
	editor.setTerminator(dispatch, {
		kind: "branch",
		condition: fused,
		consequent: { block: resume, arguments: [...dispatchCarry, counted, ...headerState] },
		alternate: { block: twinStep, arguments: dispatchCarry },
		sourcePosition,
	});
	const redirect = (edge: CoreEdge): CoreEdge =>
		edge.block !== plan.header ? edge : { block: dispatch, arguments: edge.arguments };
	for (const block of plan.predecessors) {
		if (block === plan.initial) continue;
		const terminal = coreTerminatorInput(caller, caller.blockTerminator(block));
		if (terminal.kind === "jump")
			editor.replaceTerminator(block, { ...terminal, edge: redirect(terminal.edge) });
		else if (terminal.kind === "branch")
			editor.replaceTerminator(block, {
				...terminal,
				consequent: redirect(terminal.consequent),
				alternate: redirect(terminal.alternate),
			});
		else throw new Error("Unsupported generator fusion predecessor");
	}

	const exit = createBlock();
	emit(exit, "rootUse", [callInputs[0]!]);
	const headerDispatch = coreTerminatorInput(caller, caller.blockTerminator(plan.header));
	if (headerDispatch.kind !== "branch")
		throw new Error("Generator fusion dispatch changed");
	editor.setTerminator(exit, { kind: "jump", edge: headerDispatch.consequent });
	editor.replaceTerminator(plan.header, {
		...headerDispatch,
		consequent: { block: exit, arguments: [] },
	});

	guardIterationCloses(
		caller,
		editor,
		edits,
		plan.closes,
		fused,
		"generator-protocol",
		(block) => {
			edits.instructions++;
			const rebuilt = editor.appendInstruction(block, "call", callInputs, {
				attributes: twinAttributes,
				sourcePosition,
			}).outputs[0]!;
			return {
				iterator: rebuilt,
				next: emit(block, "loadIntrinsic", [], { intrinsic: "__generatorPrototypeNext" }),
				consumed: emit(block, "binary", [consumed!, one], { operator: "+" }, "f64"),
			};
		},
	);
	return { instructionsIntroduced: edits.instructions, blocksIntroduced: edits.blocks };
}
