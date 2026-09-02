import { CoreEditor } from "./core-editor.ts";
import { CoreFunctionKernel } from "./core-function-kernel.ts";
import {
	coreBlockId,
	coreFactId,
	coreFunctionId,
	coreInstructionId,
	coreOpcodeId,
	coreValueId,
} from "./core-ir.ts";
import type {
	CoreAttributeValue,
	CoreBlockId,
	CoreBlockParameter,
	CoreBlockParameterSpec,
	CoreEffectRefinement,
	CoreEdge,
	CoreExceptionHandler,
	CoreFact,
	CoreFactId,
	CoreFunctionId,
	CoreFunctionMetadata,
	CoreFunctionOptions,
	CoreImmediate,
	CoreInstructionAttributes,
	CoreInstructionEffects,
	CoreInstructionId,
	CoreOpcodeId,
	CoreOpcodeRegistry,
	CoreRepresentation,
	CoreTerminatorPayload,
	CoreValueDefinition,
	CoreValueId,
} from "./core-ir.ts";

export interface CoreStoreMutation {
	readonly __coreStoreMutation: never;
}

const CORE_STORE_MUTATION = Symbol("Core store mutation") as unknown as CoreStoreMutation;

export type CoreChangeDomain =
	| "body"
	| "cfg"
	| "exceptionFlow"
	| "calls"
	| "memoryEffects"
	| "facts"
	| "representations"
	| "specializationInputs";

export type CoreProgramChangeDomain =
	| "functions"
	| "data"
	| "sourcePositions"
	| "calls"
	| "facts"
	| "representations"
	| "specializationInputs";

export interface CoreFunctionVersions {
	readonly body: number;
	readonly cfg: number;
	readonly exceptionFlow: number;
	readonly calls: number;
	readonly memoryEffects: number;
	readonly facts: number;
	readonly representations: number;
	readonly specializationInputs: number;
}

export interface CoreProgramVersions {
	readonly functions: number;
	readonly data: number;
	readonly sourcePositions: number;
	readonly calls: number;
	readonly facts: number;
	readonly representations: number;
	readonly specializationInputs: number;
}

export interface CoreChangeSet {
	readonly function: CoreFunctionId;
	readonly domains: ReadonlyArray<CoreChangeDomain>;
	readonly programDomains: ReadonlyArray<CoreProgramChangeDomain>;
	readonly blocks: ReadonlyArray<CoreBlockId>;
	readonly instructions: ReadonlyArray<CoreInstructionId>;
	readonly values: ReadonlyArray<CoreValueId>;
	readonly facts: ReadonlyArray<CoreFactId>;
	readonly edges: ReadonlyArray<CoreChangedEdge>;
	readonly calls: ReadonlyArray<CoreInstructionId>;
	readonly edits: number;
}

export interface CoreChangedEdge {
	readonly kind: "control-flow" | "exception";
	readonly source: CoreBlockId;
	readonly target: CoreBlockId;
}

export interface CoreUse {
	readonly instruction: CoreInstructionId;
	readonly operand: number;
}

export interface CoreBlockLayout {
	readonly live: boolean;
	readonly firstInstruction: number;
	readonly lastInstruction: number;
	readonly parameterStart: number;
	readonly parameterCount: number;
}

export interface CoreInstructionLayout {
	readonly live: boolean;
	readonly opcode: number;
	readonly block: number;
	readonly previous: number;
	readonly next: number;
	readonly operandStart: number;
	readonly operandCount: number;
	readonly resultStart: number;
	readonly resultCount: number;
	readonly sourcePosition: number;
	readonly effectRefinementRef: number;
}

export interface CoreEffectRefinementLayout {
	readonly live: boolean;
}

export interface CoreValueLayout {
	readonly live: boolean;
	readonly definitionKind: "block-parameter" | "instruction";
	readonly definitionOwner: number;
	readonly definitionIndex: number;
	readonly firstUse: number;
	readonly useCount: number;
}

export interface CoreUseLayout {
	readonly live: boolean;
	readonly value: CoreValueId;
	readonly instruction: CoreInstructionId;
	readonly operand: number;
	readonly previous: number;
	readonly next: number;
}

export interface CoreSourcePosition {
	readonly line: number;
	readonly column: number;
	readonly inlinedFunctionIndex?: number;
	readonly callerPosId?: number;
}

export interface CoreProgramDataTables {
	readonly stringConstants?: ReadonlyArray<ReadonlyArray<number>>;
	readonly bigintConstants?: ReadonlyArray<bigint>;
	readonly literalTemplateData?: ReadonlyArray<number>;
	readonly sourcePositions?: ReadonlyArray<CoreSourcePosition>;
	readonly globalCount?: number;
}

export type CoreInstructionKind =
	| "operation"
	| "jump"
	| "branch"
	| "guard"
	| "switch"
	| "return"
	| "throw"
	| "unreachable";

const REPRESENTATIONS = [
	"boxed",
	"f64",
	"i32",
	"boolean",
	"string",
	"string-span",
	"projected-elements",
	"dense-elements",
	"scalarized-object",
] as const satisfies ReadonlyArray<CoreRepresentation>;

const REPRESENTATION_IDS = new Map<CoreRepresentation, number>(
	REPRESENTATIONS.map((representation, index) => [representation, index]),
);
type CoreValueDefinitionKind = 0 | 1;

const TERMINATOR_CODES: Readonly<
	Record<Exclude<CoreInstructionKind, "operation">, number>
> = {
	jump: -1,
	branch: -2,
	guard: -3,
	switch: -4,
	return: -5,
	throw: -6,
	unreachable: -7,
};

const TERMINATOR_KINDS = new Map<number, Exclude<CoreInstructionKind, "operation">>(
	Object.entries(TERMINATOR_CODES).map(([kind, code]) => [
		code,
		kind as Exclude<CoreInstructionKind, "operation">,
	]),
);

const FUNCTION_DOMAINS: ReadonlyArray<CoreChangeDomain> = [
	"body",
	"cfg",
	"exceptionFlow",
	"calls",
	"memoryEffects",
	"facts",
	"representations",
	"specializationInputs",
];

const PROGRAM_DOMAINS: ReadonlyArray<CoreProgramChangeDomain> = [
	"functions",
	"data",
	"sourcePositions",
	"calls",
	"facts",
	"representations",
	"specializationInputs",
];

function defaultMetadata(parameterCount: number): CoreFunctionMetadata {
	return {
		sourcePath: "<core>",
		sourceStrict: false,
		nameStringIndex: 0,
		length: parameterCount,
		mappedArguments: false,
		mappedArgumentSlots: [],
		capturedCount: 0,
		strict: false,
		isClassConstructor: false,
		isDerivedConstructor: false,
		hasPrototype: true,
	};
}

function checkedCount(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative safe integer, received ${value}`);
	}
	return value;
}

function sortedIds<Id extends number>(ids: ReadonlySet<Id>): Array<Id> {
	return [...ids].sort((left, right) => left - right);
}

type CoreTerminatorShape =
	| {
			readonly kind: "jump";
			readonly block: CoreBlockId;
			readonly argumentCount: number;
	  }
	| {
			readonly kind: "branch";
			readonly consequentBlock: CoreBlockId;
			readonly consequentArgumentCount: number;
			readonly alternateBlock: CoreBlockId;
			readonly alternateArgumentCount: number;
	  }
	| {
			readonly kind: "guard";
			readonly fact: CoreFactId;
			readonly successBlock: CoreBlockId;
			readonly successArgumentCount: number;
			readonly fallbackBlock: CoreBlockId;
			readonly fallbackArgumentCount: number;
	  }
	| {
			readonly kind: "switch";
			readonly cases: ReadonlyArray<{
				readonly value: CoreImmediate;
				readonly block: CoreBlockId;
				readonly argumentCount: number;
			}>;
			readonly defaultBlock: CoreBlockId;
			readonly defaultArgumentCount: number;
	  }
	| { readonly kind: "return" }
	| { readonly kind: "throw" }
	| { readonly kind: "unreachable" };

function freezeImmediate(value: CoreImmediate): CoreImmediate {
	return Object.freeze({ ...value });
}

function terminatorShape(payload: CoreTerminatorPayload): CoreTerminatorShape {
	switch (payload.kind) {
		case "jump":
			return Object.freeze({
				kind: "jump",
				block: payload.edge.block,
				argumentCount: payload.edge.arguments.length,
			});
		case "branch":
			return Object.freeze({
				kind: "branch",
				consequentBlock: payload.consequent.block,
				consequentArgumentCount: payload.consequent.arguments.length,
				alternateBlock: payload.alternate.block,
				alternateArgumentCount: payload.alternate.arguments.length,
			});
		case "guard":
			return Object.freeze({
				kind: "guard",
				fact: payload.fact,
				successBlock: payload.success.block,
				successArgumentCount: payload.success.arguments.length,
				fallbackBlock: payload.fallback.block,
				fallbackArgumentCount: payload.fallback.arguments.length,
			});
		case "switch":
			return Object.freeze({
				kind: "switch",
				cases: Object.freeze(
					payload.cases.map(({ value, edge }) =>
						Object.freeze({
							value: freezeImmediate(value),
							block: edge.block,
							argumentCount: edge.arguments.length,
						}),
					),
				),
				defaultBlock: payload.default.block,
				defaultArgumentCount: payload.default.arguments.length,
			});
		case "return":
		case "throw":
			return Object.freeze({ kind: payload.kind });
		case "unreachable":
			return Object.freeze({ kind: "unreachable" });
	}
}

function terminatorPayloadFromShape(
	shape: CoreTerminatorShape,
	operands: ReadonlyArray<CoreValueId>,
): CoreTerminatorPayload {
	let cursor = 0;
	const takeValue = (): CoreValueId => {
		const value = operands[cursor++];
		if (value === undefined) throw new Error(`Malformed Core ${shape.kind} operands`);
		return value;
	};
	const takeEdge = (block: CoreBlockId, count: number): CoreEdge => {
		const end = cursor + count;
		if (end > operands.length) throw new Error(`Malformed Core ${shape.kind} operands`);
		const edge = { block, arguments: operands.slice(cursor, end) };
		cursor = end;
		return edge;
	};
	let payload: CoreTerminatorPayload;
	switch (shape.kind) {
		case "jump":
			payload = {
				kind: "jump",
				edge: takeEdge(shape.block, shape.argumentCount),
			};
			break;
		case "branch":
			payload = {
				kind: "branch",
				condition: takeValue(),
				consequent: takeEdge(shape.consequentBlock, shape.consequentArgumentCount),
				alternate: takeEdge(shape.alternateBlock, shape.alternateArgumentCount),
			};
			break;
		case "guard":
			payload = {
				kind: "guard",
				condition: takeValue(),
				fact: shape.fact,
				success: takeEdge(shape.successBlock, shape.successArgumentCount),
				fallback: takeEdge(shape.fallbackBlock, shape.fallbackArgumentCount),
			};
			break;
		case "switch":
			payload = {
				kind: "switch",
				discriminant: takeValue(),
				cases: shape.cases.map(({ value, block, argumentCount }) => ({
					value: { ...value },
					edge: takeEdge(block, argumentCount),
				})),
				default: takeEdge(shape.defaultBlock, shape.defaultArgumentCount),
			};
			break;
		case "return":
		case "throw":
			payload = { kind: shape.kind, value: takeValue() };
			break;
		case "unreachable":
			payload = { kind: "unreachable" };
			break;
	}
	if (cursor !== operands.length)
		throw new Error(`Malformed Core ${shape.kind} operands`);
	return payload;
}

function freezeAttribute(value: CoreAttributeValue): CoreAttributeValue {
	if (Array.isArray(value)) return Object.freeze(value.map(freezeAttribute));
	if (value !== null && typeof value === "object") {
		return Object.freeze(
			Object.fromEntries(
				Object.entries(value).map(([key, entry]) => [key, freezeAttribute(entry)]),
			),
		);
	}
	return value;
}

function freezeAttributes(
	attributes: CoreInstructionAttributes,
): CoreInstructionAttributes {
	return freezeAttribute(attributes) as CoreInstructionAttributes;
}

function freezeEffects(effects: CoreInstructionEffects): CoreInstructionEffects {
	return Object.freeze({
		...effects,
		reads: Object.freeze([...effects.reads]),
		writes: Object.freeze([...effects.writes]),
	});
}

function freezeRefinement(
	refinement: CoreEffectRefinement | undefined,
): CoreEffectRefinement | undefined {
	return refinement === undefined
		? undefined
		: Object.freeze({
				effects: freezeEffects(refinement.effects),
				proof: refinement.proof,
			});
}

function freezeMetadata(metadata: CoreFunctionMetadata): CoreFunctionMetadata {
	return Object.freeze({
		...metadata,
		mappedArgumentSlots: Object.freeze([...metadata.mappedArgumentSlots]),
	});
}

function freezeUnknown(value: unknown): unknown {
	if (Array.isArray(value)) return Object.freeze(value.map(freezeUnknown));
	if (value !== null && typeof value === "object") {
		const prototype = Object.getPrototypeOf(value) as unknown;
		if (prototype === Object.prototype || prototype === null) {
			return Object.freeze(
				Object.fromEntries(
					Object.entries(value).map(([key, entry]) => [key, freezeUnknown(entry)]),
				),
			);
		}
		return Object.freeze(value);
	}
	return value;
}

function freezeFact(id: CoreFactId, fact: Omit<CoreFact, "id">): CoreFact {
	return Object.freeze({
		...fact,
		id,
		value: freezeUnknown(fact.value),
		claims: Object.freeze(
			fact.claims.map((claim) =>
				Object.freeze(
					claim.kind === "effect"
						? { ...claim, effects: freezeEffects(claim.effects) }
						: claim.kind === "identity"
							? { ...claim, identities: Object.freeze([...claim.identities]) }
							: claim.kind === "shape"
								? { ...claim, shapes: Object.freeze([...claim.shapes]) }
								: { ...claim },
				),
			),
		),
		validity: Object.freeze({ ...fact.validity }),
		obligations: Object.freeze(
			fact.obligations.map((obligation) => Object.freeze({ ...obligation })),
		),
	});
}

function terminatorOperands(payload: CoreTerminatorPayload): Array<CoreValueId> {
	switch (payload.kind) {
		case "jump":
			return [...payload.edge.arguments];
		case "branch":
			return [
				payload.condition,
				...payload.consequent.arguments,
				...payload.alternate.arguments,
			];
		case "guard":
			return [
				payload.condition,
				...payload.success.arguments,
				...payload.fallback.arguments,
			];
		case "switch":
			return [
				payload.discriminant,
				...payload.cases.flatMap(({ edge }) => edge.arguments),
				...payload.default.arguments,
			];
		case "return":
		case "throw":
			return [payload.value];
		case "unreachable":
			return [];
	}
}

export class CoreFunctionStore {
	readonly id: CoreFunctionId;
	readonly registry: CoreOpcodeRegistry;
	#program: CoreProgram;
	#isGenerator: boolean;
	#isAsync: boolean;
	#parameterCount: number;
	#metadata: CoreFunctionMetadata;
	#parameters: Array<CoreValueId> = [];
	#entry: CoreBlockId | undefined;
	#bodyEntry: CoreBlockId | undefined;
	#activeEditor = false;
	#sealed = false;

	readonly #versions: Record<CoreChangeDomain, number> = {
		body: 0,
		cfg: 0,
		exceptionFlow: 0,
		calls: 0,
		memoryEffects: 0,
		facts: 0,
		representations: 0,
		specializationInputs: 0,
	};

	readonly #blockLive: Array<number> = [];
	readonly #blockFirstInstruction: Array<number> = [];
	readonly #blockLastInstruction: Array<number> = [];
	readonly #blockParameterStart: Array<number> = [];
	readonly #blockParameterCount: Array<number> = [];
	readonly #blockHandler: Array<CoreExceptionHandler | undefined> = [];
	readonly #blockParameterValues: Array<CoreValueId> = [];
	readonly #blockParameterRoles: Array<"value" | "exception"> = [];
	readonly #blockParameterFreeBySize: Array<Array<number> | undefined> = [];

	readonly #instructionLive: Array<number> = [];
	readonly #instructionOpcode: Array<number> = [];
	readonly #instructionBlock: Array<number> = [];
	readonly #instructionPrevious: Array<number> = [];
	readonly #instructionNext: Array<number> = [];
	readonly #instructionOperandStart: Array<number> = [];
	readonly #instructionOperandCount: Array<number> = [];
	readonly #instructionResultStart: Array<number> = [];
	readonly #instructionResultCount: Array<number> = [];
	readonly #instructionSourcePosition: Array<number> = [];
	readonly #instructionEffectRefinementRef: Array<number> = [];
	readonly #instructionPayload: Array<
		CoreInstructionAttributes | CoreTerminatorShape | undefined
	> = [];
	readonly #operands: Array<CoreValueId> = [];
	readonly #operandUses: Array<number> = [];
	readonly #operandFreeBySize: Array<Array<number> | undefined> = [];
	readonly #results: Array<CoreValueId> = [];

	readonly #valueLive: Array<number> = [];
	readonly #valueRepresentation: Array<number> = [];
	readonly #valueDefinitionKind: Array<number> = [];
	readonly #valueDefinitionOwner: Array<number> = [];
	readonly #valueDefinitionIndex: Array<number> = [];
	readonly #valueFirstUse: Array<number> = [];
	readonly #valueUseCount: Array<number> = [];

	readonly #useLive: Array<number> = [];
	readonly #useValue: Array<CoreValueId> = [];
	readonly #useInstruction: Array<CoreInstructionId> = [];
	readonly #useOperand: Array<number> = [];
	readonly #usePrevious: Array<number> = [];
	readonly #useNext: Array<number> = [];
	readonly #freeUses: Array<number> = [];
	#liveUseVisits = 0;
	#deadUseSkips = 0;
	#trackUseTraversal = false;

	readonly #facts: Array<CoreFact | undefined> = [];
	readonly #effectRefinements: Array<CoreEffectRefinement | undefined> = [];
	#sealedBlocks: ReadonlyArray<CoreBlockId> | undefined;
	#sealedInstructions: ReadonlyArray<CoreInstructionId> | undefined;
	readonly kernel: CoreFunctionKernel;

	constructor(
		mutation: CoreStoreMutation,
		program: CoreProgram,
		id: CoreFunctionId,
		options: CoreFunctionOptions,
	) {
		this.#requireMutation(mutation);
		this.#program = program;
		this.id = id;
		this.registry = program.registry;
		this.#isGenerator = options.isGenerator === true;
		this.#isAsync = options.isAsync === true;
		this.#parameterCount = checkedCount(
			options.parameterCount ?? 0,
			"Core parameter count",
		);
		this.#metadata = freezeMetadata({
			...defaultMetadata(this.#parameterCount),
			...options.metadata,
			mappedArgumentSlots: [...(options.metadata?.mappedArgumentSlots ?? [])],
		});
		this.kernel = new CoreFunctionKernel({
			blockLive: this.#blockLive,
			blockFirstInstruction: this.#blockFirstInstruction,
			blockLastInstruction: this.#blockLastInstruction,
			blockParameterStart: this.#blockParameterStart,
			blockParameterCount: this.#blockParameterCount,
			blockParameterValues: this.#blockParameterValues,
			instructionLive: this.#instructionLive,
			instructionOpcode: this.#instructionOpcode,
			instructionBlock: this.#instructionBlock,
			instructionPrevious: this.#instructionPrevious,
			instructionNext: this.#instructionNext,
			instructionOperandStart: this.#instructionOperandStart,
			instructionOperandCount: this.#instructionOperandCount,
			instructionResultStart: this.#instructionResultStart,
			instructionResultCount: this.#instructionResultCount,
			operands: this.#operands,
			results: this.#results,
			valueLive: this.#valueLive,
			valueDefinitionKind: this.#valueDefinitionKind,
			valueDefinitionOwner: this.#valueDefinitionOwner,
			valueDefinitionIndex: this.#valueDefinitionIndex,
			valueFirstUse: this.#valueFirstUse,
			valueUseCount: this.#valueUseCount,
			useLive: this.#useLive,
			useValue: this.#useValue,
			useInstruction: this.#useInstruction,
			useOperand: this.#useOperand,
			usePrevious: this.#usePrevious,
			useNext: this.#useNext,
		});
	}

	get isGenerator(): boolean {
		return this.#isGenerator;
	}

	get isAsync(): boolean {
		return this.#isAsync;
	}

	get metadata(): CoreFunctionMetadata {
		return this.#metadata;
	}

	get parameterCount(): number {
		return this.#parameterCount;
	}

	get finished(): boolean {
		return this.#entry !== undefined;
	}

	get parameters(): ReadonlyArray<CoreValueId> {
		return [...this.#parameters];
	}

	get entry(): CoreBlockId {
		if (this.#entry === undefined)
			throw new Error(`Core function ${this.id} is unfinished`);
		return this.#entry;
	}

	get bodyEntry(): CoreBlockId | undefined {
		return this.#bodyEntry;
	}

	get versions(): CoreFunctionVersions {
		return { ...this.#versions };
	}

	get blockCapacity(): number {
		return this.#blockLive.length;
	}

	get instructionCapacity(): number {
		return this.#instructionLive.length;
	}

	get valueCapacity(): number {
		return this.#valueLive.length;
	}

	get factCapacity(): number {
		return this.#facts.length;
	}

	get blockParameterCapacity(): number {
		return this.#blockParameterValues.length;
	}

	get operandCapacity(): number {
		return this.#operands.length;
	}

	get resultCapacity(): number {
		return this.#results.length;
	}

	get useCapacity(): number {
		return this.#useLive.length;
	}

	get effectRefinementCapacity(): number {
		return this.#effectRefinements.length;
	}

	get sealed(): boolean {
		return this.#sealed;
	}

	*blockIds(): Iterable<CoreBlockId> {
		if (this.#sealedBlocks !== undefined) {
			yield* this.#sealedBlocks;
			return;
		}
		for (let id = 0; id < this.#blockLive.length; id++) {
			if (this.#blockLive[id] === 1) yield coreBlockId(id);
		}
	}

	*instructionIds(block?: CoreBlockId): Iterable<CoreInstructionId> {
		if (block === undefined) {
			if (this.#sealedInstructions !== undefined) {
				yield* this.#sealedInstructions;
				return;
			}
			for (let id = 0; id < this.#instructionLive.length; id++) {
				if (this.#instructionLive[id] === 1) yield coreInstructionId(id);
			}
			return;
		}
		this.#requireBlock(block);
		for (
			let instruction = this.#blockFirstInstruction[block] ?? -1;
			instruction >= 0;
			instruction = this.#instructionNext[instruction] ?? -1
		) {
			yield coreInstructionId(instruction);
		}
	}

	*valueIds(): Iterable<CoreValueId> {
		for (const block of this.blockIds()) {
			for (const { value } of this.blockParameters(block)) yield value;
		}
		for (const instruction of this.instructionIds()) {
			for (const value of this.instructionResults(instruction)) yield value;
		}
	}

	*bodyInstructionIds(block: CoreBlockId): Iterable<CoreInstructionId> {
		for (const instruction of this.instructionIds(block)) {
			if (this.instructionKind(instruction) === "operation") yield instruction;
		}
	}

	*factIds(): Iterable<CoreFactId> {
		for (let id = 0; id < this.#facts.length; id++) {
			if (this.#facts[id] !== undefined) yield coreFactId(id);
		}
	}

	isBlockLive(id: CoreBlockId): boolean {
		return this.#blockLive[id] === 1;
	}

	isInstructionLive(id: CoreInstructionId): boolean {
		return this.#instructionLive[id] === 1;
	}

	isValueLive(id: CoreValueId): boolean {
		return this.#valueLive[id] === 1;
	}

	isFactLive(id: CoreFactId): boolean {
		return this.#facts[id] !== undefined;
	}

	blockLayout(id: number): CoreBlockLayout {
		if (!Number.isSafeInteger(id) || id < 0 || id >= this.blockCapacity) {
			throw new Error(`Unknown Core block row ${id}`);
		}
		return {
			live: this.#blockLive[id] === 1,
			firstInstruction: this.#blockFirstInstruction[id]!,
			lastInstruction: this.#blockLastInstruction[id]!,
			parameterStart: this.#blockParameterStart[id]!,
			parameterCount: this.#blockParameterCount[id]!,
		};
	}

	instructionLayout(id: number): CoreInstructionLayout {
		if (!Number.isSafeInteger(id) || id < 0 || id >= this.instructionCapacity) {
			throw new Error(`Unknown Core instruction row ${id}`);
		}
		return {
			live: this.#instructionLive[id] === 1,
			opcode: this.#instructionOpcode[id]!,
			block: this.#instructionBlock[id]!,
			previous: this.#instructionPrevious[id]!,
			next: this.#instructionNext[id]!,
			operandStart: this.#instructionOperandStart[id]!,
			operandCount: this.#instructionOperandCount[id]!,
			resultStart: this.#instructionResultStart[id]!,
			resultCount: this.#instructionResultCount[id]!,
			sourcePosition: this.#instructionSourcePosition[id]!,
			effectRefinementRef: this.#instructionEffectRefinementRef[id]!,
		};
	}

	effectRefinementLayout(id: number): CoreEffectRefinementLayout {
		if (!Number.isSafeInteger(id) || id < 0 || id >= this.effectRefinementCapacity) {
			throw new Error(`Unknown Core effect-refinement row ${id}`);
		}
		return { live: this.#effectRefinements[id] !== undefined };
	}

	effectRefinementRecord(id: number): CoreEffectRefinement {
		const refinement = this.#effectRefinements[id];
		if (refinement === undefined) {
			throw new Error(`Unknown Core effect-refinement ${id}`);
		}
		return refinement;
	}

	valueLayout(id: number): CoreValueLayout {
		if (!Number.isSafeInteger(id) || id < 0 || id >= this.valueCapacity) {
			throw new Error(`Unknown Core value row ${id}`);
		}
		return {
			live: this.#valueLive[id] === 1,
			definitionKind:
				this.#valueDefinitionKind[id] === 0 ? "block-parameter" : "instruction",
			definitionOwner: this.#valueDefinitionOwner[id]!,
			definitionIndex: this.#valueDefinitionIndex[id]!,
			firstUse: this.#valueFirstUse[id]!,
			useCount: this.#valueUseCount[id]!,
		};
	}

	useLayout(id: number): CoreUseLayout {
		if (!Number.isSafeInteger(id) || id < 0 || id >= this.useCapacity) {
			throw new Error(`Unknown Core use row ${id}`);
		}
		return {
			live: this.#useLive[id] === 1,
			value: this.#useValue[id]!,
			instruction: this.#useInstruction[id]!,
			operand: this.#useOperand[id]!,
			previous: this.#usePrevious[id]!,
			next: this.#useNext[id]!,
		};
	}

	blockParameterValue(index: number): CoreValueId {
		const value = this.#blockParameterValues[index];
		if (value === undefined) throw new Error(`Unknown Core block parameter row ${index}`);
		return value;
	}

	blockParameterRole(index: number): "value" | "exception" {
		const role = this.#blockParameterRoles[index];
		if (role === undefined) throw new Error(`Unknown Core block parameter row ${index}`);
		return role;
	}

	operandRecord(index: number): { readonly value: CoreValueId; readonly use: number } {
		const value = this.#operands[index];
		const use = this.#operandUses[index];
		if (value === undefined || use === undefined) {
			throw new Error(`Unknown Core operand row ${index}`);
		}
		return { value, use };
	}

	resultRecord(index: number): CoreValueId {
		const value = this.#results[index];
		if (value === undefined) throw new Error(`Unknown Core result row ${index}`);
		return value;
	}

	blockParameters(id: CoreBlockId): ReadonlyArray<CoreBlockParameter> {
		this.#requireBlock(id);
		const start = this.#blockParameterStart[id]!;
		const count = this.#blockParameterCount[id]!;
		return Array.from({ length: count }, (_, index) => {
			const value = this.#blockParameterValues[start + index]!;
			return {
				value,
				representation: this.valueRepresentation(value),
				role: this.#blockParameterRoles[start + index]!,
			};
		});
	}

	blockHandler(id: CoreBlockId): CoreExceptionHandler | undefined {
		this.#requireBlock(id);
		const handler = this.#blockHandler[id];
		return handler === undefined
			? undefined
			: { block: handler.block, arguments: [...handler.arguments] };
	}

	blockTerminator(id: CoreBlockId): CoreInstructionId {
		this.#requireBlock(id);
		const last = this.#blockLastInstruction[id] ?? -1;
		if (last < 0 || this.#instructionOpcode[last]! >= 0) {
			throw new Error(`Core block ${id} has no terminator`);
		}
		return coreInstructionId(last);
	}

	instructionKind(id: CoreInstructionId): CoreInstructionKind {
		this.#requireInstruction(id);
		const opcode = this.#instructionOpcode[id]!;
		if (opcode >= 0) return "operation";
		const kind = TERMINATOR_KINDS.get(opcode);
		if (kind === undefined) throw new Error(`Unknown Core structural opcode ${opcode}`);
		return kind;
	}

	instructionBlock(id: CoreInstructionId): CoreBlockId {
		this.#requireInstruction(id);
		return coreBlockId(this.#instructionBlock[id]!);
	}

	instructionPrevious(id: CoreInstructionId): CoreInstructionId | undefined {
		this.#requireInstruction(id);
		const previous = this.#instructionPrevious[id]!;
		return previous < 0 ? undefined : coreInstructionId(previous);
	}

	instructionNext(id: CoreInstructionId): CoreInstructionId | undefined {
		this.#requireInstruction(id);
		const next = this.#instructionNext[id]!;
		return next < 0 ? undefined : coreInstructionId(next);
	}

	instructionOpcode(id: CoreInstructionId): CoreOpcodeId {
		this.#requireInstruction(id);
		const opcode = this.#instructionOpcode[id]!;
		if (opcode < 0) throw new Error(`Core instruction ${id} is not an operation`);
		return coreOpcodeId(opcode);
	}

	instructionOpcodeName(id: CoreInstructionId): string {
		return this.registry.byId(this.instructionOpcode(id)).opcode;
	}

	instructionOperands(id: CoreInstructionId): ReadonlyArray<CoreValueId> {
		this.#requireInstruction(id);
		const start = this.#instructionOperandStart[id]!;
		return this.#operands.slice(start, start + this.#instructionOperandCount[id]!);
	}

	instructionResults(id: CoreInstructionId): ReadonlyArray<CoreValueId> {
		this.#requireInstruction(id);
		const start = this.#instructionResultStart[id]!;
		return this.#results.slice(start, start + this.#instructionResultCount[id]!);
	}

	instructionSourcePosition(id: CoreInstructionId): number | undefined {
		this.#requireInstruction(id);
		const position = this.#instructionSourcePosition[id]!;
		return position < 0 ? undefined : position;
	}

	instructionEffectRefinement(id: CoreInstructionId): CoreEffectRefinement | undefined {
		this.#requireInstruction(id);
		const reference = this.#instructionEffectRefinementRef[id]!;
		if (reference < 0) return undefined;
		const refinement = this.#effectRefinements[reference];
		if (refinement === undefined) {
			throw new Error(
				`Core instruction ${id} references deleted effect refinement ${reference}`,
			);
		}
		return refinement;
	}

	instructionAttributes(id: CoreInstructionId): CoreInstructionAttributes {
		if (this.instructionKind(id) !== "operation") {
			throw new Error(`Core instruction ${id} is not an operation`);
		}
		return this.#instructionPayload[id] ?? {};
	}

	terminatorPayload(id: CoreInstructionId): CoreTerminatorPayload {
		if (this.instructionKind(id) === "operation") {
			throw new Error(`Core instruction ${id} is not a terminator`);
		}
		return terminatorPayloadFromShape(
			this.#instructionPayload[id] as CoreTerminatorShape,
			this.instructionOperands(id),
		);
	}

	valueRepresentation(id: CoreValueId): CoreRepresentation {
		this.#requireValue(id);
		return REPRESENTATIONS[this.#valueRepresentation[id]!]!;
	}

	valueDefinition(id: CoreValueId): CoreValueDefinition {
		this.#requireValue(id);
		const owner = this.#valueDefinitionOwner[id]!;
		const index = this.#valueDefinitionIndex[id]!;
		return this.#valueDefinitionKind[id] === 0
			? { kind: "block-parameter", block: coreBlockId(owner), index }
			: { kind: "instruction", instruction: coreInstructionId(owner), index };
	}

	valueUseCount(id: CoreValueId): number {
		this.#requireValue(id);
		return this.#valueUseCount[id]!;
	}

	*uses(id: CoreValueId): Iterable<CoreUse> {
		this.#requireValue(id);
		for (let use = this.#valueFirstUse[id]!; use >= 0; use = this.#useNext[use]!) {
			if (this.#trackUseTraversal) this.#liveUseVisits++;
			yield {
				instruction: this.#useInstruction[use]!,
				operand: this.#useOperand[use]!,
			};
		}
	}

	configureUseTraversalStatistics(enabled: boolean): void {
		this.#liveUseVisits = 0;
		this.#deadUseSkips = 0;
		this.#trackUseTraversal = enabled;
	}

	useTraversalStatistics(): {
		readonly liveVisits: number;
		readonly deadSkips: number;
	} {
		return { liveVisits: this.#liveUseVisits, deadSkips: this.#deadUseSkips };
	}

	storageStatistics(): {
		readonly abandonedOperands: number;
		readonly abandonedParameters: number;
	} {
		let liveOperands = 0;
		for (let instruction = 0; instruction < this.#instructionLive.length; instruction++) {
			if (this.#instructionLive[instruction] === 1) {
				liveOperands += this.#instructionOperandCount[instruction]!;
			}
		}
		let liveParameters = 0;
		for (let block = 0; block < this.#blockLive.length; block++) {
			if (this.#blockLive[block] === 1) {
				liveParameters += this.#blockParameterCount[block]!;
			}
		}
		return {
			abandonedOperands: this.#operands.length - liveOperands,
			abandonedParameters: this.#blockParameterValues.length - liveParameters,
		};
	}

	fact(id: CoreFactId): CoreFact {
		const fact = this.#facts[id];
		if (fact === undefined || fact.id !== id) throw new Error(`Unknown Core fact ${id}`);
		return fact;
	}

	_beginEdit(mutation: CoreStoreMutation): void {
		this.#requireMutation(mutation);
		if (this.#sealed || this.#program.sealed) {
			throw new Error(`Core function ${this.id} is sealed`);
		}
		if (this.#activeEditor)
			throw new Error(`Core function ${this.id} already has an editor`);
		this.#activeEditor = true;
	}

	_endEdit(mutation: CoreStoreMutation, domains: ReadonlySet<CoreChangeDomain>): void {
		this.#requireMutation(mutation);
		if (!this.#activeEditor) throw new Error(`Core function ${this.id} has no editor`);
		for (const domain of domains) this.#versions[domain]++;
		this.#activeEditor = false;
	}

	_createBlock(
		mutation: CoreStoreMutation,
		parameters: ReadonlyArray<CoreBlockParameterSpec>,
	): { readonly block: CoreBlockId; readonly values: ReadonlyArray<CoreValueId> } {
		this.#assertEditing(mutation);
		const block = coreBlockId(this.#blockLive.length);
		this.#blockLive.push(1);
		this.#blockFirstInstruction.push(-1);
		this.#blockLastInstruction.push(-1);
		this.#blockHandler.push(undefined);
		const values = parameters.map((spec, index) =>
			this.#createValue(spec.representation ?? "boxed", 0, block, index),
		);
		this.#replaceBlockParameterRange(
			block,
			values,
			parameters.map((p) => p.role ?? "value"),
		);
		return { block, values };
	}

	_appendBlockParameter(
		mutation: CoreStoreMutation,
		block: CoreBlockId,
		spec: CoreBlockParameterSpec,
		prepend: boolean,
	): CoreValueId {
		this.#assertEditing(mutation);
		const existing = this.blockParameters(block);
		const index = prepend ? 0 : existing.length;
		const value = this.#createValue(spec.representation ?? "boxed", 0, block, index);
		const values = existing.map((parameter) => parameter.value);
		const roles = existing.map((parameter) => parameter.role);
		if (prepend) {
			values.unshift(value);
			roles.unshift(spec.role ?? "value");
		} else {
			values.push(value);
			roles.push(spec.role ?? "value");
		}
		for (const [parameterIndex, parameterValue] of values.entries()) {
			this.#valueDefinitionIndex[parameterValue] = parameterIndex;
		}
		this.#replaceBlockParameterRange(block, values, roles);
		return value;
	}

	_removeBlockParameter(
		mutation: CoreStoreMutation,
		block: CoreBlockId,
		index: number,
	): CoreValueId {
		this.#assertEditing(mutation);
		const parameters = this.blockParameters(block);
		const parameter = parameters[index];
		if (parameter === undefined) {
			throw new Error(`Unknown Core block ${block} parameter ${index}`);
		}
		if (this.#valueUseCount[parameter.value] !== 0) {
			throw new Error(
				`Cannot remove Core block ${block} parameter ${index}; value ${parameter.value} is used`,
			);
		}
		const remaining = parameters.filter((_, parameterIndex) => parameterIndex !== index);
		for (const [parameterIndex, entry] of remaining.entries()) {
			this.#valueDefinitionIndex[entry.value] = parameterIndex;
		}
		this.#valueLive[parameter.value] = 0;
		this.#replaceBlockParameterRange(
			block,
			remaining.map(({ value }) => value),
			remaining.map(({ role }) => role),
		);
		return parameter.value;
	}

	_insertOperation(
		mutation: CoreStoreMutation,
		block: CoreBlockId,
		before: CoreInstructionId | undefined,
		opcode: CoreOpcodeId,
		operands: ReadonlyArray<CoreValueId>,
		outputRepresentations: ReadonlyArray<CoreRepresentation>,
		attributes: CoreInstructionAttributes,
		sourcePosition: number | undefined,
		effectRefinement: CoreEffectRefinement | undefined,
	): {
		readonly instruction: CoreInstructionId;
		readonly results: ReadonlyArray<CoreValueId>;
	} {
		this.#assertEditing(mutation);
		this.#requireBlock(block);
		if (before !== undefined && this.instructionBlock(before) !== block) {
			throw new Error(`Core instruction ${before} is not in block ${block}`);
		}
		let insertionPoint = before;
		if (insertionPoint === undefined) {
			const last = this.#blockLastInstruction[block]!;
			if (last >= 0 && this.#instructionOpcode[last]! < 0) {
				insertionPoint = coreInstructionId(last);
			}
		}
		const instruction = this.#allocateInstruction(
			block,
			opcode,
			operands,
			outputRepresentations,
			freezeAttributes(attributes),
			sourcePosition,
			effectRefinement,
			insertionPoint,
		);
		return { instruction, results: this.instructionResults(instruction) };
	}

	_setTerminator(
		mutation: CoreStoreMutation,
		block: CoreBlockId,
		payload: CoreTerminatorPayload,
		sourcePosition: number | undefined,
	): CoreInstructionId {
		this.#assertEditing(mutation);
		this.#requireBlock(block);
		const last = this.#blockLastInstruction[block]!;
		if (last >= 0 && this.#instructionOpcode[last]! < 0) {
			throw new Error(`Core block ${block} already has a terminator`);
		}
		return this.#allocateInstruction(
			block,
			TERMINATOR_CODES[payload.kind],
			terminatorOperands(payload),
			[],
			terminatorShape(payload),
			sourcePosition,
			undefined,
			undefined,
		);
	}

	_replaceOperation(
		mutation: CoreStoreMutation,
		instruction: CoreInstructionId,
		opcode: CoreOpcodeId,
		operands: ReadonlyArray<CoreValueId>,
		attributes: CoreInstructionAttributes,
		sourcePosition: number | undefined,
		effectRefinement: CoreEffectRefinement | undefined,
	): void {
		this.#assertEditing(mutation);
		if (this.instructionKind(instruction) !== "operation") {
			throw new Error(`Core instruction ${instruction} is not an operation`);
		}
		this.#instructionOpcode[instruction] = opcode;
		this.#instructionPayload[instruction] = freezeAttributes(attributes);
		this.#instructionSourcePosition[instruction] = sourcePosition ?? -1;
		this.#replaceEffectRefinement(instruction, effectRefinement);
		this._replaceOperands(mutation, instruction, operands);
	}

	_setInstructionEffectRefinement(
		mutation: CoreStoreMutation,
		instruction: CoreInstructionId,
		refinement: CoreEffectRefinement | undefined,
	): void {
		this.#assertEditing(mutation);
		if (this.instructionKind(instruction) !== "operation") {
			throw new Error(`Core instruction ${instruction} is not an operation`);
		}
		this.#replaceEffectRefinement(instruction, refinement);
	}

	_replaceOperands(
		mutation: CoreStoreMutation,
		instruction: CoreInstructionId,
		operands: ReadonlyArray<CoreValueId>,
	): void {
		this.#assertEditing(mutation);
		this.#requireInstruction(instruction);
		this.#writeOperandRange(instruction, operands);
	}

	_removeInstruction(mutation: CoreStoreMutation, instruction: CoreInstructionId): void {
		this.#assertEditing(mutation);
		this.#requireInstruction(instruction);
		for (const result of this.instructionResults(instruction)) {
			if (this.#valueUseCount[result] !== 0) {
				throw new Error(
					`Cannot remove Core instruction ${instruction}; value ${result} is used`,
				);
			}
		}
		const operandStart = this.#instructionOperandStart[instruction]!;
		for (let index = 0; index < this.#instructionOperandCount[instruction]!; index++) {
			this.#deactivateUse(this.#operandUses[operandStart + index]!);
		}
		this.#releaseOperandRange(operandStart, this.#instructionOperandCount[instruction]!);
		this.#instructionOperandStart[instruction] = 0;
		this.#instructionOperandCount[instruction] = 0;
		for (const result of this.instructionResults(instruction))
			this.#valueLive[result] = 0;
		this.#removeEffectRefinement(instruction);
		const block = this.#instructionBlock[instruction]!;
		const previous = this.#instructionPrevious[instruction]!;
		const next = this.#instructionNext[instruction]!;
		if (previous < 0) this.#blockFirstInstruction[block] = next;
		else this.#instructionNext[previous] = next;
		if (next < 0) this.#blockLastInstruction[block] = previous;
		else this.#instructionPrevious[next] = previous;
		this.#instructionLive[instruction] = 0;
		this.#instructionPrevious[instruction] = -1;
		this.#instructionNext[instruction] = -1;
	}

	_moveInstruction(
		mutation: CoreStoreMutation,
		instruction: CoreInstructionId,
		block: CoreBlockId,
		before: CoreInstructionId | undefined,
	): void {
		this.#assertEditing(mutation);
		if (this.instructionKind(instruction) !== "operation") {
			throw new Error(`Core instruction ${instruction} is not an operation`);
		}
		this.#requireBlock(block);
		if (before === instruction) {
			throw new Error(`Core instruction ${instruction} cannot move before itself`);
		}
		if (before !== undefined && this.instructionBlock(before) !== block) {
			throw new Error(`Core instruction ${before} is not in block ${block}`);
		}
		const oldBlock = this.#instructionBlock[instruction]!;
		const oldPrevious = this.#instructionPrevious[instruction]!;
		const oldNext = this.#instructionNext[instruction]!;
		if (oldPrevious < 0) this.#blockFirstInstruction[oldBlock] = oldNext;
		else this.#instructionNext[oldPrevious] = oldNext;
		if (oldNext < 0) this.#blockLastInstruction[oldBlock] = oldPrevious;
		else this.#instructionPrevious[oldNext] = oldPrevious;

		let insertionPoint = before;
		if (insertionPoint === undefined) {
			const last = this.#blockLastInstruction[block]!;
			if (last >= 0 && this.#instructionOpcode[last]! < 0) {
				insertionPoint = coreInstructionId(last);
			}
		}
		const beforeIndex = insertionPoint ?? -1;
		const previous =
			beforeIndex < 0
				? this.#blockLastInstruction[block]!
				: this.#instructionPrevious[beforeIndex]!;
		this.#instructionBlock[instruction] = block;
		this.#instructionPrevious[instruction] = previous;
		this.#instructionNext[instruction] = beforeIndex;
		if (previous < 0) this.#blockFirstInstruction[block] = instruction;
		else this.#instructionNext[previous] = instruction;
		if (beforeIndex < 0) this.#blockLastInstruction[block] = instruction;
		else this.#instructionPrevious[beforeIndex] = instruction;
	}

	_removeBlock(mutation: CoreStoreMutation, block: CoreBlockId): void {
		this.#assertEditing(mutation);
		this.#requireBlock(block);
		if (block === this.entry || block === this.#bodyEntry) {
			throw new Error(`Cannot remove Core entry block ${block}`);
		}
		for (const instruction of [...this.instructionIds(block)].reverse()) {
			this._removeInstruction(mutation, instruction);
		}
		for (const parameter of this.blockParameters(block)) {
			if (this.#valueUseCount[parameter.value] !== 0) {
				const uses = [...this.uses(parameter.value)]
					.map(
						({ instruction, operand }) =>
							`@${instruction}:${operand} in b${this.instructionBlock(instruction)}`,
					)
					.join(", ");
				throw new Error(
					`Cannot remove Core block ${block}; parameter ${parameter.value} is used by ${uses}`,
				);
			}
			this.#valueLive[parameter.value] = 0;
		}
		this.#blockLive[block] = 0;
		this.#blockFirstInstruction[block] = -1;
		this.#blockLastInstruction[block] = -1;
		this.#blockHandler[block] = undefined;
		this.#replaceBlockParameterRange(block, [], []);
	}

	_setValueRepresentation(
		mutation: CoreStoreMutation,
		value: CoreValueId,
		representation: CoreRepresentation,
	): boolean {
		this.#assertEditing(mutation);
		this.#requireValue(value);
		const encoded = REPRESENTATION_IDS.get(representation);
		if (encoded === undefined)
			throw new Error(`Unknown Core representation ${representation}`);
		if (this.#valueRepresentation[value] === encoded) return false;
		this.#valueRepresentation[value] = encoded;
		return true;
	}

	_setHandler(
		mutation: CoreStoreMutation,
		block: CoreBlockId,
		handler: CoreExceptionHandler | undefined,
	): void {
		this.#assertEditing(mutation);
		this.#requireBlock(block);
		if (handler !== undefined) this.#requireBlock(handler.block);
		this.#blockHandler[block] =
			handler === undefined
				? undefined
				: Object.freeze({
						block: handler.block,
						arguments: Object.freeze([...handler.arguments]),
					});
	}

	_replaceTerminatorPayload(
		mutation: CoreStoreMutation,
		instruction: CoreInstructionId,
		payload: CoreTerminatorPayload,
	): void {
		this.#assertEditing(mutation);
		if (this.instructionKind(instruction) === "operation") {
			throw new Error(`Core instruction ${instruction} is not a terminator`);
		}
		this.#instructionOpcode[instruction] = TERMINATOR_CODES[payload.kind];
		this.#instructionPayload[instruction] = terminatorShape(payload);
		this._replaceOperands(mutation, instruction, terminatorOperands(payload));
	}

	_addFact(mutation: CoreStoreMutation, fact: Omit<CoreFact, "id">): CoreFactId {
		this.#assertEditing(mutation);
		const id = coreFactId(this.#facts.length);
		this.#facts.push(freezeFact(id, fact));
		return id;
	}

	_replaceFact(
		mutation: CoreStoreMutation,
		fact: CoreFactId,
		replacement: Omit<CoreFact, "id">,
	): void {
		this.#assertEditing(mutation);
		if (!this.isFactLive(fact)) throw new Error(`Unknown Core fact ${fact}`);
		this.#facts[fact] = freezeFact(fact, replacement);
	}

	_removeFact(mutation: CoreStoreMutation, fact: CoreFactId): void {
		this.#assertEditing(mutation);
		if (!this.isFactLive(fact)) throw new Error(`Unknown Core fact ${fact}`);
		this.#facts[fact] = undefined;
	}

	_configureFunction(mutation: CoreStoreMutation, options: CoreFunctionOptions): void {
		this.#assertEditing(mutation);
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
			this.#metadata = freezeMetadata({
				...this.#metadata,
				...options.metadata,
				mappedArgumentSlots:
					options.metadata.mappedArgumentSlots === undefined
						? this.#metadata.mappedArgumentSlots
						: [...options.metadata.mappedArgumentSlots],
			});
		}
	}

	_finishFunction(
		mutation: CoreStoreMutation,
		entry: CoreBlockId,
		bodyEntry: CoreBlockId | undefined,
	): void {
		this.#assertEditing(mutation);
		const parameters = this.blockParameters(entry);
		if (parameters.length < this.#parameterCount) {
			throw new Error(
				`Core entry block has ${parameters.length} parameters for a ${this.#parameterCount}-parameter ABI`,
			);
		}
		this.#parameters = parameters.slice(0, this.#parameterCount).map((parameter) => {
			if (parameter.role !== "value" || parameter.representation !== "boxed") {
				throw new Error("Core ABI parameters must be boxed value parameters");
			}
			return parameter.value;
		});
		this.#entry = entry;
		this.#bodyEntry = bodyEntry;
	}

	_seal(mutation: CoreStoreMutation): void {
		this.#requireMutation(mutation);
		if (this.#activeEditor)
			throw new Error(`Core function ${this.id} has an active editor`);
		this.#sealedBlocks = Object.freeze([...this.blockIds()]);
		this.#sealedInstructions = Object.freeze([...this.instructionIds()]);
		this.#sealed = true;
	}

	_bumpProgramVersions(
		mutation: CoreStoreMutation,
		domains: ReadonlySet<CoreProgramChangeDomain>,
	): void {
		this.#requireMutation(mutation);
		this.#program._bumpVersions(mutation, domains);
	}

	#allocateInstruction(
		block: CoreBlockId,
		opcode: CoreOpcodeId | number,
		operands: ReadonlyArray<CoreValueId>,
		outputRepresentations: ReadonlyArray<CoreRepresentation>,
		payload: CoreInstructionAttributes | CoreTerminatorShape,
		sourcePosition: number | undefined,
		effectRefinement: CoreEffectRefinement | undefined,
		before: CoreInstructionId | undefined,
	): CoreInstructionId {
		const instruction = coreInstructionId(this.#instructionLive.length);
		const beforeIndex = before ?? -1;
		const previous =
			beforeIndex < 0
				? this.#blockLastInstruction[block]!
				: this.#instructionPrevious[beforeIndex]!;
		this.#instructionLive.push(1);
		this.#instructionOpcode.push(opcode);
		this.#instructionBlock.push(block);
		this.#instructionPrevious.push(previous);
		this.#instructionNext.push(beforeIndex);
		this.#instructionOperandStart.push(0);
		this.#instructionOperandCount.push(0);
		this.#instructionResultStart.push(this.#results.length);
		this.#instructionResultCount.push(outputRepresentations.length);
		this.#instructionSourcePosition.push(sourcePosition ?? -1);
		this.#instructionEffectRefinementRef.push(
			this.#appendEffectRefinement(effectRefinement),
		);
		this.#instructionPayload.push(payload);
		if (previous < 0) this.#blockFirstInstruction[block] = instruction;
		else this.#instructionNext[previous] = instruction;
		if (beforeIndex < 0) this.#blockLastInstruction[block] = instruction;
		else this.#instructionPrevious[beforeIndex] = instruction;
		this.#writeOperandRange(instruction, operands);
		for (const [index, representation] of outputRepresentations.entries()) {
			this.#results.push(this.#createValue(representation, 1, instruction, index));
		}
		return instruction;
	}

	#appendEffectRefinement(refinement: CoreEffectRefinement | undefined): number {
		if (refinement === undefined) return -1;
		const reference = this.#effectRefinements.length;
		this.#effectRefinements.push(freezeRefinement(refinement));
		return reference;
	}

	#replaceEffectRefinement(
		instruction: CoreInstructionId,
		refinement: CoreEffectRefinement | undefined,
	): void {
		this.#removeEffectRefinement(instruction);
		this.#instructionEffectRefinementRef[instruction] =
			this.#appendEffectRefinement(refinement);
	}

	#removeEffectRefinement(instruction: CoreInstructionId): void {
		const reference = this.#instructionEffectRefinementRef[instruction]!;
		if (reference < 0) return;
		this.#effectRefinements[reference] = undefined;
		this.#instructionEffectRefinementRef[instruction] = -1;
	}

	#createValue(
		representation: CoreRepresentation,
		definitionKind: CoreValueDefinitionKind,
		definitionOwner: CoreBlockId | CoreInstructionId,
		definitionIndex: number,
	): CoreValueId {
		const encoded = REPRESENTATION_IDS.get(representation);
		if (encoded === undefined)
			throw new Error(`Unknown Core representation ${representation}`);
		const value = coreValueId(this.#valueLive.length);
		this.#valueLive.push(1);
		this.#valueRepresentation.push(encoded);
		this.#valueDefinitionKind.push(definitionKind);
		this.#valueDefinitionOwner.push(definitionOwner);
		this.#valueDefinitionIndex.push(definitionIndex);
		this.#valueFirstUse.push(-1);
		this.#valueUseCount.push(0);
		return value;
	}

	#replaceBlockParameterRange(
		block: CoreBlockId,
		values: ReadonlyArray<CoreValueId>,
		roles: ReadonlyArray<"value" | "exception">,
	): void {
		const oldStart = this.#blockParameterStart[block] ?? 0;
		const oldCount = this.#blockParameterCount[block] ?? 0;
		let start = oldStart;
		if (oldCount !== values.length) {
			this.#releaseBlockParameterRange(oldStart, oldCount);
			start = this.#allocateBlockParameterRange(values.length);
		}
		this.#blockParameterStart[block] = start;
		this.#blockParameterCount[block] = values.length;
		for (let index = 0; index < values.length; index++) {
			this.#blockParameterValues[start + index] = values[index]!;
			this.#blockParameterRoles[start + index] = roles[index]!;
		}
	}

	#writeOperandRange(
		instruction: CoreInstructionId,
		operands: ReadonlyArray<CoreValueId>,
	): void {
		const oldStart = this.#instructionOperandStart[instruction] ?? 0;
		const oldCount = this.#instructionOperandCount[instruction] ?? 0;
		if (oldCount === operands.length) {
			let unchanged = true;
			for (const [operand, value] of operands.entries()) {
				this.#requireValue(value);
				if (this.#operands[oldStart + operand] !== value) unchanged = false;
			}
			if (unchanged) return;
			for (let index = 0; index < oldCount; index++) {
				this.#deactivateUse(this.#operandUses[oldStart + index]!);
			}
			for (const [operand, value] of operands.entries()) {
				const index = oldStart + operand;
				this.#operands[index] = value;
				this.#operandUses[index] = this.#allocateUse(value, instruction, operand);
			}
			return;
		}
		for (let index = 0; index < oldCount; index++) {
			this.#deactivateUse(this.#operandUses[oldStart + index]!);
		}
		this.#releaseOperandRange(oldStart, oldCount);
		const start = this.#allocateOperandRange(operands.length);
		this.#instructionOperandStart[instruction] = start;
		this.#instructionOperandCount[instruction] = operands.length;
		for (const [operand, value] of operands.entries()) {
			this.#requireValue(value);
			this.#operands[start + operand] = value;
			this.#operandUses[start + operand] = this.#allocateUse(value, instruction, operand);
		}
	}

	#allocateUse(
		value: CoreValueId,
		instruction: CoreInstructionId,
		operand: number,
	): number {
		const use = this.#freeUses.pop() ?? this.#useLive.length;
		const next = this.#valueFirstUse[value]!;
		this.#useLive[use] = 1;
		this.#useValue[use] = value;
		this.#useInstruction[use] = instruction;
		this.#useOperand[use] = operand;
		this.#usePrevious[use] = -1;
		this.#useNext[use] = next;
		if (next >= 0) this.#usePrevious[next] = use;
		this.#valueFirstUse[value] = use;
		this.#valueUseCount[value] = this.#valueUseCount[value]! + 1;
		return use;
	}

	#deactivateUse(use: number): void {
		if (this.#useLive[use] !== 1) return;
		const value = this.#useValue[use]!;
		const previous = this.#usePrevious[use]!;
		const next = this.#useNext[use]!;
		if (previous < 0) this.#valueFirstUse[value] = next;
		else this.#useNext[previous] = next;
		if (next >= 0) this.#usePrevious[next] = previous;
		this.#useLive[use] = 0;
		this.#usePrevious[use] = -1;
		this.#useNext[use] = -1;
		this.#valueUseCount[value] = this.#valueUseCount[value]! - 1;
		this.#freeUses.push(use);
	}

	#allocateOperandRange(count: number): number {
		if (count === 0) return 0;
		const free = this.#operandFreeBySize[count]?.pop();
		if (free !== undefined) return free;
		const start = this.#operands.length;
		this.#operands.length += count;
		this.#operandUses.length += count;
		return start;
	}

	#releaseOperandRange(start: number, count: number): void {
		if (count === 0) return;
		for (let index = 0; index < count; index++) {
			this.#operandUses[start + index] = -1;
		}
		const free = this.#operandFreeBySize[count] ?? [];
		free.push(start);
		this.#operandFreeBySize[count] = free;
	}

	#allocateBlockParameterRange(count: number): number {
		if (count === 0) return 0;
		const free = this.#blockParameterFreeBySize[count]?.pop();
		if (free !== undefined) return free;
		const start = this.#blockParameterValues.length;
		this.#blockParameterValues.length += count;
		this.#blockParameterRoles.length += count;
		return start;
	}

	#releaseBlockParameterRange(start: number, count: number): void {
		if (count === 0) return;
		const free = this.#blockParameterFreeBySize[count] ?? [];
		free.push(start);
		this.#blockParameterFreeBySize[count] = free;
	}

	#requireMutation(mutation: CoreStoreMutation): void {
		if (mutation !== CORE_STORE_MUTATION)
			throw new Error("Core store mutation is private");
	}

	#assertEditing(mutation: CoreStoreMutation): void {
		this.#requireMutation(mutation);
		if (!this.#activeEditor) throw new Error(`Core function ${this.id} has no editor`);
	}

	#requireBlock(id: CoreBlockId): void {
		if (!this.isBlockLive(id)) throw new Error(`Unknown Core block ${id}`);
	}

	#requireInstruction(id: CoreInstructionId): void {
		if (!this.isInstructionLive(id)) throw new Error(`Unknown Core instruction ${id}`);
	}

	#requireValue(id: CoreValueId): void {
		if (!this.isValueLive(id)) throw new Error(`Unknown Core value ${id}`);
	}
}

export class CoreProgram {
	readonly registry: CoreOpcodeRegistry;
	readonly #functions: Array<CoreFunctionStore | undefined> = [];
	readonly #versions: Record<CoreProgramChangeDomain, number> = {
		functions: 0,
		data: 0,
		sourcePositions: 0,
		calls: 0,
		facts: 0,
		representations: 0,
		specializationInputs: 0,
	};
	#stringConstants: ReadonlyArray<ReadonlyArray<number>> = [];
	#bigintConstants: ReadonlyArray<bigint> = [];
	#literalTemplateData: ReadonlyArray<number> = [];
	#sourcePositions: ReadonlyArray<CoreSourcePosition> = [];
	#globalCount = 0;
	#sealed = false;

	constructor(registry: CoreOpcodeRegistry, data: CoreProgramDataTables = {}) {
		this.registry = registry;
		this.#setData(data);
	}

	get sealed(): boolean {
		return this.#sealed;
	}

	get versions(): CoreProgramVersions {
		return { ...this.#versions };
	}

	get functionCapacity(): number {
		return this.#functions.length;
	}

	get stringConstants(): ReadonlyArray<ReadonlyArray<number>> {
		return this.#stringConstants;
	}

	get bigintConstants(): ReadonlyArray<bigint> {
		return this.#bigintConstants;
	}

	get literalTemplateData(): ReadonlyArray<number> {
		return this.#literalTemplateData;
	}

	get sourcePositions(): ReadonlyArray<CoreSourcePosition> {
		return this.#sourcePositions;
	}

	get globalCount(): number {
		return this.#globalCount;
	}

	*functionIds(): Iterable<CoreFunctionId> {
		for (let id = 0; id < this.#functions.length; id++) {
			if (this.#functions[id] !== undefined) yield coreFunctionId(id);
		}
	}

	hasFunction(id: CoreFunctionId): boolean {
		const fn = this.#functions[id];
		return fn !== undefined && fn.id === id;
	}

	function(id: CoreFunctionId): CoreFunctionStore {
		const fn = this.#functions[id];
		if (fn === undefined || fn.id !== id) throw new Error(`Unknown Core function ${id}`);
		return fn;
	}

	_openEditor(functionId: CoreFunctionId): CoreEditor {
		return CoreEditor._open(CORE_STORE_MUTATION, this, this.function(functionId), false);
	}

	_createEditor(options: CoreFunctionOptions): CoreEditor {
		return CoreEditor._open(
			CORE_STORE_MUTATION,
			this,
			this._createFunction(CORE_STORE_MUTATION, options),
			true,
		);
	}

	_configureProgramData(data: CoreProgramDataTables): void {
		this._setProgramData(CORE_STORE_MUTATION, data);
	}

	seal(): SealedCoreProgram {
		if (this.#sealed) return this as SealedCoreProgram;
		for (const fn of this.#functions) fn?._seal(CORE_STORE_MUTATION);
		this.#sealed = true;
		return this as SealedCoreProgram;
	}

	_createFunction(
		mutation: CoreStoreMutation,
		options: CoreFunctionOptions,
	): CoreFunctionStore {
		this.#requireMutation(mutation);
		if (this.#sealed) throw new Error("Core program is sealed");
		const id = coreFunctionId(this.#functions.length);
		const fn = new CoreFunctionStore(mutation, this, id, options);
		this.#functions.push(fn);
		return fn;
	}

	_setProgramData(mutation: CoreStoreMutation, data: CoreProgramDataTables): void {
		this.#requireMutation(mutation);
		if (this.#sealed) throw new Error("Core program is sealed");
		this.#setData(data);
		this.#versions.data++;
	}

	_appendSourcePositions(
		mutation: CoreStoreMutation,
		positions: ReadonlyArray<CoreSourcePosition>,
	): number {
		this.#requireMutation(mutation);
		if (this.#sealed) throw new Error("Core program is sealed");
		const start = this.#sourcePositions.length;
		this.#sourcePositions = Object.freeze([
			...this.#sourcePositions,
			...positions.map((position) => Object.freeze({ ...position })),
		]);
		return start;
	}

	_bumpVersions(
		mutation: CoreStoreMutation,
		domains: ReadonlySet<CoreProgramChangeDomain>,
	): void {
		this.#requireMutation(mutation);
		for (const domain of domains) this.#versions[domain]++;
	}

	#wireData(data: CoreProgramDataTables): void {
		this.#stringConstants = Object.freeze(
			(data.stringConstants ?? []).map((units) => Object.freeze([...units])),
		);
		this.#bigintConstants = Object.freeze([...(data.bigintConstants ?? [])]);
		this.#literalTemplateData = Object.freeze([...(data.literalTemplateData ?? [])]);
		this.#sourcePositions = Object.freeze(
			(data.sourcePositions ?? []).map((position) => Object.freeze({ ...position })),
		);
		this.#globalCount = checkedCount(data.globalCount ?? 0, "Core global count");
	}

	#setData(data: CoreProgramDataTables): void {
		this.#wireData(data);
	}

	#requireMutation(mutation: CoreStoreMutation): void {
		if (mutation !== CORE_STORE_MUTATION)
			throw new Error("Core store mutation is private");
	}
}

export type SealedCoreProgram = CoreProgram & { readonly sealed: true };

export const CORE_FUNCTION_VERSION_DOMAINS = FUNCTION_DOMAINS;
export const CORE_PROGRAM_VERSION_DOMAINS = PROGRAM_DOMAINS;
export const sortCoreIds = sortedIds;
