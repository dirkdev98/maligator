/**
 * Canonical middle-end IR.
 *
 * Core IR is block-based SSA. Every value and instruction has a stable,
 * function-local identity; blocks end in an explicit terminator; and opcode
 * semantics live in a single descriptor registry. The front end and VM are
 * deliberately outside this module.
 */

import type { SemanticProgram } from "../frontend/semantic-analysis.ts";
import type {
	CompilerOptimizationDecision,
	OptimizationPassDelta,
} from "../shared/compiler-diagnostics.ts";
import type { CompilerProgramFacts } from "../shared/compiler-facts.ts";

declare const coreBlockIdBrand: unique symbol;
declare const coreInstructionIdBrand: unique symbol;
declare const coreValueIdBrand: unique symbol;
declare const coreFactIdBrand: unique symbol;

export type CoreBlockId = number & { readonly [coreBlockIdBrand]: true };
export type CoreInstructionId = number & { readonly [coreInstructionIdBrand]: true };
export type CoreValueId = number & { readonly [coreValueIdBrand]: true };
export type CoreFactId = number & { readonly [coreFactIdBrand]: true };

function checkedId(value: number, kind: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${kind} must be a non-negative safe integer, received ${value}`);
	}
	return value;
}

export function coreBlockId(value: number): CoreBlockId {
	return checkedId(value, "Core block id") as CoreBlockId;
}

export function coreInstructionId(value: number): CoreInstructionId {
	return checkedId(value, "Core instruction id") as CoreInstructionId;
}

export function coreValueId(value: number): CoreValueId {
	return checkedId(value, "Core value id") as CoreValueId;
}

export function coreFactId(value: number): CoreFactId {
	return checkedId(value, "Core fact id") as CoreFactId;
}

export const CORE_EFFECT_DOMAINS = [
	"captured-slot",
	"global-slot",
	"global-property",
	"object-property",
	"array-element",
	"host",
	"io",
] as const;

export type CoreEffectDomain = (typeof CORE_EFFECT_DOMAINS)[number];

export interface CoreInstructionEffects {
	readonly reads: ReadonlyArray<CoreEffectDomain>;
	readonly writes: ReadonlyArray<CoreEffectDomain>;
	readonly mayThrow: boolean;
	readonly maySuspend: boolean;
	readonly mayGc: boolean;
	readonly callsUserCode: boolean;
}

export const CORE_NO_EFFECTS: CoreInstructionEffects = Object.freeze({
	reads: Object.freeze([]),
	writes: Object.freeze([]),
	mayThrow: false,
	maySuspend: false,
	mayGc: false,
	callsUserCode: false,
});

export interface CoreArity {
	readonly minimum: number;
	readonly maximum: number;
}

export function coreArity(exact: number): CoreArity;
export function coreArity(minimum: number, maximum: number): CoreArity;
export function coreArity(minimum: number, maximum = minimum): CoreArity {
	if (
		!Number.isSafeInteger(minimum) ||
		!Number.isSafeInteger(maximum) ||
		minimum < 0 ||
		maximum < minimum
	) {
		throw new Error(`Invalid Core IR arity ${minimum}..${maximum}`);
	}
	return Object.freeze({ minimum, maximum });
}

export interface CoreOpcodeDescriptor<Name extends string = string> {
	readonly opcode: Name;
	readonly inputs: CoreArity;
	readonly outputs: CoreArity;
	readonly effects: CoreInstructionEffects;
	/** Removing an unused result cannot change observable JavaScript behavior. */
	readonly discardable: boolean;
}

function validateEffectDomains(
	opcode: string,
	kind: "read" | "write",
	domains: ReadonlyArray<CoreEffectDomain>,
): void {
	const seen = new Set<CoreEffectDomain>();
	for (const domain of domains) {
		if (!CORE_EFFECT_DOMAINS.includes(domain)) {
			throw new Error(`Unknown ${kind} effect domain ${domain} for ${opcode}`);
		}
		if (seen.has(domain)) {
			throw new Error(`Duplicate ${kind} effect domain ${domain} for ${opcode}`);
		}
		seen.add(domain);
	}
}

export class CoreOpcodeRegistry {
	readonly #descriptors = new Map<string, CoreOpcodeDescriptor>();

	define<const Name extends string>(
		descriptor: CoreOpcodeDescriptor<Name>,
	): CoreOpcodeDescriptor<Name> {
		if (descriptor.opcode.length === 0) throw new Error("Core opcode cannot be empty");
		if (this.#descriptors.has(descriptor.opcode)) {
			throw new Error(`Duplicate Core opcode ${descriptor.opcode}`);
		}
		validateEffectDomains(descriptor.opcode, "read", descriptor.effects.reads);
		validateEffectDomains(descriptor.opcode, "write", descriptor.effects.writes);
		const frozen: CoreOpcodeDescriptor<Name> = Object.freeze({
			...descriptor,
			inputs: Object.freeze({ ...descriptor.inputs }),
			outputs: Object.freeze({ ...descriptor.outputs }),
			effects: Object.freeze({
				...descriptor.effects,
				reads: Object.freeze([...descriptor.effects.reads]),
				writes: Object.freeze([...descriptor.effects.writes]),
			}),
		});
		this.#descriptors.set(descriptor.opcode, frozen);
		return frozen;
	}

	get(opcode: string): CoreOpcodeDescriptor | undefined {
		return this.#descriptors.get(opcode);
	}

	require(opcode: string): CoreOpcodeDescriptor {
		const descriptor = this.get(opcode);
		if (descriptor === undefined) throw new Error(`Unknown Core opcode ${opcode}`);
		return descriptor;
	}

	entries(): ReadonlyArray<CoreOpcodeDescriptor> {
		return [...this.#descriptors.values()].sort((left, right) =>
			left.opcode.localeCompare(right.opcode),
		);
	}
}

export type CoreRepresentation =
	| "boxed"
	| "f64"
	| "i32"
	| "boolean"
	| "string-span"
	| "projected-elements"
	| "dense-elements"
	| "scalarized-object";

export type CoreFactValidity =
	| { readonly kind: "world"; readonly fact: string }
	| { readonly kind: "epoch"; readonly family: string }
	| { readonly kind: "guard"; readonly instruction: CoreInstructionId }
	| { readonly kind: "summary"; readonly digest: string }
	| { readonly kind: "asserted"; readonly source: string };

export type CoreFactObligation =
	| { readonly kind: "guard"; readonly instruction: CoreInstructionId }
	| { readonly kind: "fallback"; readonly id: string }
	| { readonly kind: "materialize"; readonly id: string };

export interface CoreFact {
	readonly id: CoreFactId;
	readonly kind: string;
	readonly value: unknown;
	readonly validity: CoreFactValidity;
	readonly obligations: ReadonlyArray<CoreFactObligation>;
	readonly origin: string;
}

export type CoreValueDefinition =
	| {
			readonly kind: "block-parameter";
			readonly block: CoreBlockId;
			readonly index: number;
	  }
	| {
			readonly kind: "instruction";
			readonly instruction: CoreInstructionId;
			readonly index: number;
	  };

export interface CoreValue {
	readonly id: CoreValueId;
	readonly representation: CoreRepresentation;
	readonly definition: CoreValueDefinition;
}

export interface CoreEffectRefinement {
	readonly effects: CoreInstructionEffects;
	readonly proof: CoreFactId;
}

export type CoreAttributeValue =
	| undefined
	| null
	| boolean
	| number
	| string
	| ReadonlyArray<CoreAttributeValue>
	| CoreAttributeObject;

// A recursive interface is required here; TypeScript rejects the equivalent
// recursive Record alias even though instruction attributes are ordinary data.
export interface CoreAttributeObject {
	readonly [key: string]: CoreAttributeValue;
}

export type CoreInstructionAttributes = Readonly<Record<string, CoreAttributeValue>>;

export interface CoreInstruction {
	readonly id: CoreInstructionId;
	readonly opcode: string;
	readonly inputs: ReadonlyArray<CoreValueId>;
	readonly outputs: ReadonlyArray<CoreValueId>;
	readonly attributes: CoreInstructionAttributes;
	readonly sourcePosition?: number;
	readonly effectRefinement?: CoreEffectRefinement;
}

export interface CoreBlockParameter {
	readonly value: CoreValueId;
	readonly representation: CoreRepresentation;
	readonly role: "value" | "exception";
}

export interface CoreEdge {
	readonly block: CoreBlockId;
	readonly arguments: ReadonlyArray<CoreValueId>;
}

export type CoreImmediate =
	| { readonly kind: "undefined" }
	| { readonly kind: "null" }
	| { readonly kind: "boolean"; readonly value: boolean }
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "string"; readonly index: number };

interface CoreTerminatorBase {
	readonly id: CoreInstructionId;
	readonly sourcePosition?: number;
}

export type CoreTerminator =
	| (CoreTerminatorBase & { readonly kind: "jump"; readonly edge: CoreEdge })
	| (CoreTerminatorBase & {
			readonly kind: "branch";
			readonly condition: CoreValueId;
			readonly consequent: CoreEdge;
			readonly alternate: CoreEdge;
	  })
	| (CoreTerminatorBase & {
			readonly kind: "guard";
			readonly condition: CoreValueId;
			/** Fact established only along the success edge. */
			readonly fact: CoreFactId;
			readonly success: CoreEdge;
			readonly fallback: CoreEdge;
	  })
	| (CoreTerminatorBase & {
			readonly kind: "switch";
			readonly discriminant: CoreValueId;
			readonly cases: ReadonlyArray<{
				readonly value: CoreImmediate;
				readonly edge: CoreEdge;
			}>;
			readonly default: CoreEdge;
	  })
	| (CoreTerminatorBase & { readonly kind: "return"; readonly value: CoreValueId })
	| (CoreTerminatorBase & { readonly kind: "throw"; readonly value: CoreValueId })
	| (CoreTerminatorBase & { readonly kind: "unreachable" });

export type CoreTerminatorInput = CoreTerminator extends infer Terminator
	? Terminator extends CoreTerminator
		? Omit<Terminator, "id">
		: never
	: never;

export interface CoreExceptionHandler {
	readonly block: CoreBlockId;
	/** Arguments after the handler's implicit exception parameter. */
	readonly arguments: ReadonlyArray<CoreValueId>;
}

export interface CoreBlock {
	readonly id: CoreBlockId;
	readonly parameters: ReadonlyArray<CoreBlockParameter>;
	readonly instructions: ReadonlyArray<CoreInstruction>;
	readonly terminator: CoreTerminator;
	readonly handler?: CoreExceptionHandler;
}

export interface CoreFunctionMetadata {
	readonly sourcePath: string;
	readonly sourceStrict: boolean;
	readonly nameStringIndex: number;
	readonly length: number;
	readonly mappedArguments: boolean;
	readonly mappedArgumentSlots: ReadonlyArray<number>;
	readonly capturedCount: number;
	readonly strict: boolean;
	readonly isClassConstructor: boolean;
	readonly isDerivedConstructor: boolean;
	readonly hasPrototype: boolean;
}

/**
 * Atomic optimization certificate expressed only in Core identities. Its
 * generic semantic twin stays in the graph, so a backend may consume or ignore
 * the entire certificate without changing JavaScript behavior.
 */
export interface CoreRegion {
	readonly kind: string;
	readonly anchors: ReadonlyArray<CoreInstructionId>;
	readonly claimedInstructions: ReadonlyArray<CoreInstructionId>;
	readonly ordinaryBlocks: ReadonlyArray<CoreBlockId>;
	readonly exceptionalBlocks: ReadonlyArray<CoreBlockId>;
	readonly data: CoreAttributeObject;
}

export interface CoreFunction {
	readonly functionIndex: number;
	readonly isGenerator: boolean;
	readonly isAsync: boolean;
	readonly metadata: CoreFunctionMetadata;
	/** Boxed incoming values in source formal-parameter order. */
	readonly parameters: ReadonlyArray<CoreValueId>;
	readonly entry: CoreBlockId;
	/** Loop header used when proven self-tail calls re-enter the function body. */
	readonly bodyEntry?: CoreBlockId;
	readonly blocks: ReadonlyArray<CoreBlock>;
	readonly values: ReadonlyArray<CoreValue>;
	readonly facts: ReadonlyArray<CoreFact>;
	readonly regions: ReadonlyArray<CoreRegion>;
	/** Incremented by every committed transform; analysis caches key on this. */
	readonly mutationEpoch: number;
}

/** Canonical middle-end program, independent of frontend and backend adapters. */
export interface CoreProgram {
	readonly functions: ReadonlyArray<CoreFunction>;
	readonly stringConstants: ReadonlyArray<ReadonlyArray<number>>;
	readonly bigintConstants: ReadonlyArray<bigint>;
	readonly literalTemplateData: ReadonlyArray<number>;
	readonly sourcePositions: ReadonlyArray<{
		readonly line: number;
		readonly column: number;
		readonly inlinedFunctionIndex?: number;
		readonly callerPosId?: number;
	}>;
	readonly globalCount: number;
	/**
	 * Whole-compilation data that is not part of function SSA. Standalone Core
	 * unit tests may omit it; every product compilation supplies it before the
	 * backend boundary.
	 */
	readonly compilation?: CoreCompilationMetadata;
}

export interface CoreHostInstallCandidate {
	readonly installer: string;
	readonly exports: ReadonlyArray<{ readonly name: string; readonly slot: number }>;
}

export interface CoreCompilationMetadata {
	readonly semantic: SemanticProgram;
	readonly facts: CompilerProgramFacts;
	readonly optimizationDecisions?: ReadonlyArray<CompilerOptimizationDecision>;
	readonly optimizationTrace?: ReadonlyArray<OptimizationPassDelta>;
	readonly cjsModuleFunctionIndices: ReadonlyArray<number>;
	/** Host exports with assigned global slots; the backend drops unread slots. */
	readonly hostInstallCandidates: ReadonlyArray<CoreHostInstallCandidate>;
	/** Slot-free installers retained by reachable global surfaces such as process. */
	readonly retainedHostInstallers: ReadonlyArray<string>;
}

interface MutableCoreBlock {
	readonly id: CoreBlockId;
	readonly parameters: Array<CoreBlockParameter>;
	readonly instructions: Array<CoreInstruction>;
	terminator?: CoreTerminator;
	handler?: CoreExceptionHandler;
}

export interface CoreBlockParameterSpec {
	readonly representation?: CoreRepresentation;
	readonly role?: "value" | "exception";
}

export interface CoreFunctionOptions {
	readonly isGenerator?: boolean;
	readonly isAsync?: boolean;
	readonly parameterCount?: number;
	readonly metadata?: Partial<CoreFunctionMetadata>;
}

export interface AppendCoreInstructionOptions {
	readonly outputCount?: number;
	readonly outputRepresentations?: ReadonlyArray<CoreRepresentation>;
	readonly attributes?: CoreInstructionAttributes;
	readonly sourcePosition?: number;
	readonly effectRefinement?: CoreEffectRefinement;
}

export interface SetCoreGuardTerminatorInput {
	readonly condition: CoreValueId;
	readonly success: CoreEdge;
	readonly fallback: CoreEdge;
	readonly sourcePosition?: number;
	readonly fact: Omit<CoreFact, "id" | "validity" | "obligations"> & {
		readonly obligations?: ReadonlyArray<
			Exclude<CoreFactObligation, { readonly kind: "guard" }>
		>;
	};
}

function arityAccepts(arity: CoreArity, count: number): boolean {
	return count >= arity.minimum && count <= arity.maximum;
}

/** Mutation API used by frontends and transforms; ids are monotonic and never reused. */
export class CoreFunctionBuilder {
	readonly #functionIndex: number;
	readonly #registry: CoreOpcodeRegistry;
	#isGenerator: boolean;
	#isAsync: boolean;
	readonly #parameterCount: number;
	#metadata: CoreFunctionMetadata;
	readonly #blocks: Array<MutableCoreBlock> = [];
	readonly #values: Array<CoreValue> = [];
	readonly #facts: Array<CoreFact> = [];
	#nextInstruction = 0;
	#mutationEpoch = 0;

	constructor(
		functionIndex: number,
		registry: CoreOpcodeRegistry,
		options: CoreFunctionOptions = {},
	) {
		if (!Number.isSafeInteger(functionIndex) || functionIndex < 0) {
			throw new Error(`Invalid function index ${functionIndex}`);
		}
		this.#functionIndex = functionIndex;
		this.#registry = registry;
		this.#isGenerator = options.isGenerator === true;
		this.#isAsync = options.isAsync === true;
		this.#parameterCount = options.parameterCount ?? 0;
		if (!Number.isSafeInteger(this.#parameterCount) || this.#parameterCount < 0) {
			throw new Error(`Invalid Core parameter count ${this.#parameterCount}`);
		}
		this.#metadata = {
			sourcePath: options.metadata?.sourcePath ?? "<core>",
			sourceStrict: options.metadata?.sourceStrict ?? false,
			nameStringIndex: options.metadata?.nameStringIndex ?? 0,
			length: options.metadata?.length ?? this.#parameterCount,
			mappedArguments: options.metadata?.mappedArguments ?? false,
			mappedArgumentSlots: [...(options.metadata?.mappedArgumentSlots ?? [])],
			capturedCount: options.metadata?.capturedCount ?? 0,
			strict: options.metadata?.strict ?? false,
			isClassConstructor: options.metadata?.isClassConstructor ?? false,
			isDerivedConstructor: options.metadata?.isDerivedConstructor ?? false,
			hasPrototype: options.metadata?.hasPrototype ?? true,
		};
	}

	createBlock(parameters: ReadonlyArray<CoreBlockParameterSpec> = []): CoreBlockId {
		const id = coreBlockId(this.#blocks.length);
		const block: MutableCoreBlock = { id, parameters: [], instructions: [] };
		this.#blocks.push(block);
		for (const [index, spec] of parameters.entries()) {
			const representation = spec.representation ?? "boxed";
			const value = this.#createValue(representation, {
				kind: "block-parameter",
				block: id,
				index,
			});
			block.parameters.push({
				value,
				representation,
				role: spec.role ?? "value",
			});
		}
		return id;
	}

	appendBlockParameter(
		blockId: CoreBlockId,
		spec: CoreBlockParameterSpec = {},
	): CoreValueId {
		const block = this.#requireBlock(blockId);
		const representation = spec.representation ?? "boxed";
		const value = this.#createValue(representation, {
			kind: "block-parameter",
			block: blockId,
			index: block.parameters.length,
		});
		block.parameters.push({
			value,
			representation,
			role: spec.role ?? "value",
		});
		this.#mutationEpoch++;
		return value;
	}

	prependBlockParameter(
		blockId: CoreBlockId,
		spec: CoreBlockParameterSpec = {},
	): CoreValueId {
		const block = this.#requireBlock(blockId);
		for (const [index, parameter] of block.parameters.entries()) {
			const existing = this.#values[parameter.value]!;
			this.#values[parameter.value] = {
				...existing,
				definition: { kind: "block-parameter", block: blockId, index: index + 1 },
			};
		}
		const representation = spec.representation ?? "boxed";
		const value = this.#createValue(representation, {
			kind: "block-parameter",
			block: blockId,
			index: 0,
		});
		block.parameters.unshift({
			value,
			representation,
			role: spec.role ?? "value",
		});
		this.#mutationEpoch++;
		return value;
	}

	value(id: CoreValueId): Readonly<CoreValue> {
		const value = this.#values[id];
		if (value === undefined || value.id !== id) {
			throw new Error(`Unknown Core value ${id}`);
		}
		return value;
	}

	setValueRepresentation(id: CoreValueId, representation: CoreRepresentation): void {
		const value = this.value(id);
		if (value.representation === representation) return;
		this.#values[id] = { ...value, representation };
		if (value.definition.kind === "block-parameter") {
			const parameter = this.#requireBlock(value.definition.block).parameters[
				value.definition.index
			];
			if (parameter?.value !== id) {
				throw new Error(`Core value ${id} does not match its block parameter`);
			}
			this.#requireBlock(value.definition.block).parameters[value.definition.index] = {
				...parameter,
				representation,
			};
		}
		this.#mutationEpoch++;
	}

	configureFunction(options: CoreFunctionOptions): void {
		this.#isGenerator = options.isGenerator ?? this.#isGenerator;
		this.#isAsync = options.isAsync ?? this.#isAsync;
		if (
			options.parameterCount !== undefined &&
			options.parameterCount !== this.#parameterCount
		) {
			throw new Error(
				`Cannot change Core parameter count from ${this.#parameterCount} to ${options.parameterCount}`,
			);
		}
		if (options.metadata !== undefined) {
			this.#metadata = {
				...this.#metadata,
				...options.metadata,
				mappedArgumentSlots:
					options.metadata.mappedArgumentSlots === undefined
						? this.#metadata.mappedArgumentSlots
						: [...options.metadata.mappedArgumentSlots],
			};
		}
		this.#mutationEpoch++;
	}

	block(id: CoreBlockId): Readonly<MutableCoreBlock> {
		return this.#requireBlock(id);
	}

	appendInstruction(
		blockId: CoreBlockId,
		opcode: string,
		inputs: ReadonlyArray<CoreValueId>,
		options: AppendCoreInstructionOptions = {},
	): ReadonlyArray<CoreValueId> {
		const block = this.#requireBlock(blockId);
		if (block.terminator !== undefined) {
			throw new Error(`Cannot append ${opcode} after terminator in block ${blockId}`);
		}
		const descriptor = this.#registry.require(opcode);
		if (!arityAccepts(descriptor.inputs, inputs.length)) {
			throw new Error(
				`${opcode} expects ${descriptor.inputs.minimum}..${descriptor.inputs.maximum} inputs, received ${inputs.length}`,
			);
		}
		const outputCount = options.outputCount ?? descriptor.outputs.minimum;
		if (!arityAccepts(descriptor.outputs, outputCount)) {
			throw new Error(
				`${opcode} expects ${descriptor.outputs.minimum}..${descriptor.outputs.maximum} outputs, received ${outputCount}`,
			);
		}
		if (
			options.outputRepresentations !== undefined &&
			options.outputRepresentations.length !== outputCount
		) {
			throw new Error(`${opcode} output representation count does not match outputs`);
		}
		const id = this.#allocateInstructionId();
		const outputs = Array.from({ length: outputCount }, (_, index) =>
			this.#createValue(options.outputRepresentations?.[index] ?? "boxed", {
				kind: "instruction",
				instruction: id,
				index,
			}),
		);
		block.instructions.push({
			id,
			opcode,
			inputs: [...inputs],
			outputs,
			attributes: { ...(options.attributes ?? {}) },
			...(options.sourcePosition === undefined
				? {}
				: { sourcePosition: options.sourcePosition }),
			...(options.effectRefinement === undefined
				? {}
				: { effectRefinement: options.effectRefinement }),
		});
		this.#mutationEpoch++;
		return outputs;
	}

	setHandler(
		blockId: CoreBlockId,
		handlerBlock: CoreBlockId,
		arguments_: ReadonlyArray<CoreValueId> = [],
	): void {
		const block = this.#requireBlock(blockId);
		this.#requireBlock(handlerBlock);
		block.handler = { block: handlerBlock, arguments: [...arguments_] };
		this.#mutationEpoch++;
	}

	setTerminator(
		blockId: CoreBlockId,
		terminator: CoreTerminatorInput,
	): CoreInstructionId {
		const block = this.#requireBlock(blockId);
		if (block.terminator !== undefined) {
			throw new Error(`Block ${blockId} already has a terminator`);
		}
		const id = this.#allocateInstructionId();
		block.terminator = { ...terminator, id };
		this.#mutationEpoch++;
		return id;
	}

	/** Create a fact and the CFG guard that establishes it as one atomic operation. */
	setGuardTerminator(
		blockId: CoreBlockId,
		input: SetCoreGuardTerminatorInput,
	): CoreFactId {
		const block = this.#requireBlock(blockId);
		if (block.terminator !== undefined) {
			throw new Error(`Block ${blockId} already has a terminator`);
		}
		this.#requireBlock(input.success.block);
		this.#requireBlock(input.fallback.block);
		const instruction = this.#allocateInstructionId();
		const fact = coreFactId(this.#facts.length);
		this.#facts.push({
			...input.fact,
			id: fact,
			validity: { kind: "guard", instruction },
			obligations: [{ kind: "guard", instruction }, ...(input.fact.obligations ?? [])],
		});
		block.terminator = {
			kind: "guard",
			id: instruction,
			condition: input.condition,
			fact,
			success: { ...input.success, arguments: [...input.success.arguments] },
			fallback: { ...input.fallback, arguments: [...input.fallback.arguments] },
			...(input.sourcePosition === undefined
				? {}
				: { sourcePosition: input.sourcePosition }),
		};
		this.#mutationEpoch++;
		return fact;
	}

	addFact(fact: Omit<CoreFact, "id">): CoreFactId {
		const id = coreFactId(this.#facts.length);
		this.#facts.push({ ...fact, id, obligations: [...fact.obligations] });
		this.#mutationEpoch++;
		return id;
	}

	finish(entry: CoreBlockId): CoreFunction {
		const entryBlock = this.#requireBlock(entry);
		if (entryBlock.parameters.length < this.#parameterCount) {
			throw new Error(
				`Core entry block has ${entryBlock.parameters.length} parameters for a ${this.#parameterCount}-parameter ABI`,
			);
		}
		const parameters = entryBlock.parameters
			.slice(0, this.#parameterCount)
			.map(({ value, representation, role }) => {
				if (role !== "value" || representation !== "boxed") {
					throw new Error("Core ABI parameters must be boxed value parameters");
				}
				return value;
			});
		const blocks = this.#blocks.map((block): CoreBlock => {
			if (block.terminator === undefined) {
				throw new Error(`Core block ${block.id} has no terminator`);
			}
			return {
				id: block.id,
				parameters: block.parameters.map((parameter) => ({ ...parameter })),
				instructions: block.instructions.map((instruction) => ({
					...instruction,
					inputs: [...instruction.inputs],
					outputs: [...instruction.outputs],
					attributes: { ...instruction.attributes },
				})),
				terminator: block.terminator,
				...(block.handler === undefined
					? {}
					: {
							handler: {
								block: block.handler.block,
								arguments: [...block.handler.arguments],
							},
						}),
			};
		});
		return {
			functionIndex: this.#functionIndex,
			isGenerator: this.#isGenerator,
			isAsync: this.#isAsync,
			metadata: {
				...this.#metadata,
				mappedArgumentSlots: [...this.#metadata.mappedArgumentSlots],
			},
			parameters,
			entry,
			blocks,
			values: this.#values.map((value) => ({ ...value })),
			facts: this.#facts.map((fact) => ({ ...fact, obligations: [...fact.obligations] })),
			regions: [],
			mutationEpoch: this.#mutationEpoch,
		};
	}

	#createValue(
		representation: CoreRepresentation,
		definition: CoreValueDefinition,
	): CoreValueId {
		const id = coreValueId(this.#values.length);
		this.#values.push({ id, representation, definition });
		return id;
	}

	#allocateInstructionId(): CoreInstructionId {
		return coreInstructionId(this.#nextInstruction++);
	}

	#requireBlock(id: CoreBlockId): MutableCoreBlock {
		const block = this.#blocks[id];
		if (block === undefined || block.id !== id) {
			throw new Error(`Unknown Core block ${id}`);
		}
		return block;
	}
}

function formatValue(value: CoreValueId): string {
	return `%${value}`;
}

function formatEdge(edge: CoreEdge): string {
	const arguments_ = edge.arguments.map(formatValue).join(", ");
	return `b${edge.block}(${arguments_})`;
}

function formatTerminator(terminator: CoreTerminator): string {
	switch (terminator.kind) {
		case "jump":
			return `jump ${formatEdge(terminator.edge)}`;
		case "branch":
			return `branch ${formatValue(terminator.condition)}, ${formatEdge(terminator.consequent)}, ${formatEdge(terminator.alternate)}`;
		case "guard":
			return `guard ${formatValue(terminator.condition)} proves !${terminator.fact}, ${formatEdge(terminator.success)}, ${formatEdge(terminator.fallback)}`;
		case "switch":
			return `switch ${formatValue(terminator.discriminant)}, ${terminator.cases
				.map(({ value, edge }) => `${JSON.stringify(value)}: ${formatEdge(edge)}`)
				.join(", ")}, default: ${formatEdge(terminator.default)}`;
		case "return":
			return `return ${formatValue(terminator.value)}`;
		case "throw":
			return `throw ${formatValue(terminator.value)}`;
		case "unreachable":
			return "unreachable";
	}
}

/** Deterministic textual form used by diagnostics and golden tests. */
export function formatCoreFunction(fn: CoreFunction): string {
	const signature = fn.parameters.map(formatValue).join(", ");
	const lines = [
		`core function ${fn.functionIndex}(${signature}) epoch ${fn.mutationEpoch} {`,
	];
	for (const block of fn.blocks) {
		const parameters = block.parameters
			.map(
				(parameter) =>
					`${formatValue(parameter.value)}: ${parameter.representation}${parameter.role === "exception" ? " exception" : ""}`,
			)
			.join(", ");
		const handler =
			block.handler === undefined
				? ""
				: ` handler b${block.handler.block}(${block.handler.arguments.map(formatValue).join(", ")})`;
		lines.push(`  b${block.id}(${parameters})${handler}:`);
		for (const instruction of block.instructions) {
			const outputs = instruction.outputs.map(formatValue).join(", ");
			const assignment = outputs.length === 0 ? "" : `${outputs} = `;
			const inputs = instruction.inputs.map(formatValue).join(", ");
			const attributes =
				Object.keys(instruction.attributes).length === 0
					? ""
					: ` ${JSON.stringify(instruction.attributes)}`;
			lines.push(
				`    @${instruction.id} ${assignment}${instruction.opcode}(${inputs})${attributes}`,
			);
		}
		lines.push(`    @${block.terminator.id} ${formatTerminator(block.terminator)}`);
	}
	lines.push("}");
	return lines.join("\n");
}
