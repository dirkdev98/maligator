import { StaticDescriptionInterner } from "../shared/static-values.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
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
	CoreAttributeRelocation,
	CoreBlockId,
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
	CoreValueId,
} from "./core-ir.ts";
import type { CoreStaticCellIndex } from "./core-static-value-cells.ts";

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

export type CoreProgramFlowDomainMask = number;

export const CORE_PROGRAM_FLOW_BODY = 1 << 0;
export const CORE_PROGRAM_FLOW_CFG = 1 << 1;
export const CORE_PROGRAM_FLOW_EXCEPTION = 1 << 2;
export const CORE_PROGRAM_FLOW_CALLS = 1 << 3;
export const CORE_PROGRAM_FLOW_MEMORY = 1 << 4;
export const CORE_PROGRAM_FLOW_FACTS = 1 << 5;
export const CORE_PROGRAM_FLOW_REPRESENTATIONS = 1 << 6;
export const CORE_PROGRAM_FLOW_SPECIALIZATION = 1 << 7;

function programFlowDomainBit(domain: CoreChangeDomain): CoreProgramFlowDomainMask {
	switch (domain) {
		case "body":
			return CORE_PROGRAM_FLOW_BODY;
		case "cfg":
			return CORE_PROGRAM_FLOW_CFG;
		case "exceptionFlow":
			return CORE_PROGRAM_FLOW_EXCEPTION;
		case "calls":
			return CORE_PROGRAM_FLOW_CALLS;
		case "memoryEffects":
			return CORE_PROGRAM_FLOW_MEMORY;
		case "facts":
			return CORE_PROGRAM_FLOW_FACTS;
		case "representations":
			return CORE_PROGRAM_FLOW_REPRESENTATIONS;
		case "specializationInputs":
			return CORE_PROGRAM_FLOW_SPECIALIZATION;
	}
}

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

export function coreFunctionVersionsAreCurrent(
	fn: CoreFunctionStore,
	snapshot: CoreFunctionVersions,
): boolean {
	return (
		snapshot.body === fn.version("body") &&
		snapshot.cfg === fn.version("cfg") &&
		snapshot.exceptionFlow === fn.version("exceptionFlow") &&
		snapshot.calls === fn.version("calls") &&
		snapshot.memoryEffects === fn.version("memoryEffects") &&
		snapshot.facts === fn.version("facts") &&
		snapshot.representations === fn.version("representations") &&
		snapshot.specializationInputs === fn.version("specializationInputs")
	);
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

export interface CoreFunctionLiveStorageCounts {
	readonly blocks: number;
	readonly instructions: number;
	readonly values: number;
	readonly uses: number;
	readonly operands: number;
	readonly blockParameters: number;
	readonly terminatorEdges: number;
	readonly terminatorArguments: number;
	readonly handlerArguments: number;
	readonly facts: number;
	readonly effectRefinements: number;
}

export interface CoreConstructionStatistics {
	readonly virtualPhisCreated: number;
	readonly virtualPhisCollapsed: number;
	readonly materializedBlockParameters: number;
	readonly edgeArgumentsEmitted: number;
	readonly definitionSnapshotEntriesCopied: number;
	readonly aliasResolutions: number;
	readonly maximumUnresolvedPhiDepth: number;
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
const BLOCK_PARAMETER_ROLES = ["value", "exception"] as const;
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

function freezeImmediate(value: CoreImmediate): CoreImmediate {
	return Object.freeze({ ...value });
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

const EMPTY_CORE_INSTRUCTION_ATTRIBUTES: CoreInstructionAttributes = Object.freeze({});

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

interface CoreLocalRelocations {
	readonly block: (id: CoreBlockId) => CoreBlockId;
	readonly instruction: (id: CoreInstructionId) => CoreInstructionId;
	readonly value: (id: CoreValueId) => CoreValueId;
	readonly fact: (id: CoreFactId) => CoreFactId;
}

function relocateAttributePath(
	value: CoreAttributeValue,
	path: ReadonlyArray<string>,
	pathIndex: number,
	relocation: CoreAttributeRelocation,
	relocations: CoreLocalRelocations,
): CoreAttributeValue {
	if (value === undefined) return value;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(
			`Core attribute relocation ${path.join(".")} crosses non-object data`,
		);
	}
	const key = path[pathIndex]!;
	const child = (value as Readonly<Record<string, CoreAttributeValue>>)[key];
	if (child === undefined) return value;
	let replacement: CoreAttributeValue;
	if (pathIndex + 1 < path.length) {
		replacement = relocateAttributePath(
			child,
			path,
			pathIndex + 1,
			relocation,
			relocations,
		);
	} else {
		const relocate = relocations[relocation.kind] as (id: never) => number;
		if (relocation.cardinality === "one") {
			if (!Number.isSafeInteger(child)) {
				throw new Error(
					`Core attribute relocation ${path.join(".")} requires one local ID`,
				);
			}
			replacement = relocate(child as never);
		} else {
			if (!Array.isArray(child) || !child.every(Number.isSafeInteger)) {
				throw new Error(`Core attribute relocation ${path.join(".")} requires local IDs`);
			}
			replacement = Object.freeze(child.map((id) => relocate(id as never)));
		}
	}
	if (replacement === child) return value;
	return Object.freeze({ ...value, [key]: replacement });
}

function relocateInstructionAttributes(
	attributes: CoreInstructionAttributes,
	contracts: ReadonlyArray<CoreAttributeRelocation>,
	relocations: CoreLocalRelocations,
): CoreInstructionAttributes {
	let relocated: CoreAttributeValue = attributes;
	for (const contract of contracts) {
		relocated = relocateAttributePath(relocated, contract.path, 0, contract, relocations);
	}
	return relocated as CoreInstructionAttributes;
}

export class CoreFunctionStore {
	readonly id: CoreFunctionId;
	readonly registry: CoreOpcodeRegistry;
	readonly generation: number;
	#program: CoreProgram;
	#isGenerator: boolean;
	#isAsync: boolean;
	#parameterCount: number;
	#metadata: CoreFunctionMetadata;
	readonly #parameters: Array<CoreValueId> = [];
	#entry: CoreBlockId | undefined;
	#bodyEntry: CoreBlockId | undefined;
	#activeEditor = false;
	#sealed = false;
	#retired = false;

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
	#featureVersion = 0;

	readonly #blockLive: Array<number> = [];
	readonly #blockFirstInstruction: Array<number> = [];
	readonly #blockLastInstruction: Array<number> = [];
	readonly #blockParameterStart: Array<number> = [];
	readonly #blockParameterCount: Array<number> = [];
	readonly #blockHandlerBlock: Array<number> = [];
	readonly #blockHandlerArgumentStart: Array<number> = [];
	readonly #blockHandlerArgumentCount: Array<number> = [];
	readonly #handlerBlocks: Array<CoreBlockId> = [];
	readonly #handlerBlockIndexes: Array<number> = [];
	readonly #blockParameterValues: Array<CoreValueId> = [];
	readonly #blockParameterRoles: Array<number> = [];
	readonly #blockParameterFreeBySize: Array<Array<number> | undefined> = [];
	readonly #handlerArguments: Array<CoreValueId> = [];
	readonly #handlerArgumentBlock: Array<number> = [];
	readonly #handlerArgumentPreviousUse: Array<number> = [];
	readonly #handlerArgumentNextUse: Array<number> = [];
	readonly #handlerArgumentFreeBySize: Array<Array<number> | undefined> = [];

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
	readonly #instructionTerminatorEdgeStart: Array<number> = [];
	readonly #instructionTerminatorEdgeCount: Array<number> = [];
	readonly #instructionTerminatorFact: Array<number> = [];
	readonly #instructionPayload: Array<CoreInstructionAttributes | undefined> = [];
	readonly #operands: Array<CoreValueId> = [];
	readonly #operandUses: Array<number> = [];
	readonly #operandFreeBySize: Array<Array<number> | undefined> = [];
	readonly #results: Array<CoreValueId> = [];
	readonly #terminatorEdgeBlock: Array<CoreBlockId> = [];
	readonly #terminatorEdgeArgumentStart: Array<number> = [];
	readonly #terminatorEdgeArgumentCount: Array<number> = [];
	readonly #terminatorEdgeCaseValue: Array<CoreImmediate | undefined> = [];
	readonly #terminatorEdgeFreeBySize: Array<Array<number> | undefined> = [];

	readonly #valueLive: Array<number> = [];
	readonly #valueRepresentation: Array<number> = [];
	readonly #valueDefinitionKind: Array<number> = [];
	readonly #valueDefinitionOwner: Array<number> = [];
	readonly #valueDefinitionIndex: Array<number> = [];
	readonly #valueFirstUse: Array<number> = [];
	readonly #valueUseCount: Array<number> = [];
	readonly #valueFirstHandlerUse: Array<number> = [];
	readonly #valueHandlerUseCount: Array<number> = [];

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
	#liveBlocks = 0;
	#liveInstructions = 0;
	#liveInstructionResults = 0;
	#liveOperands = 0;
	#liveBlockParameters = 0;
	#liveTerminatorEdges = 0;
	#liveTerminatorArguments = 0;
	#liveHandlerArguments = 0;
	#liveFacts = 0;
	#liveEffectRefinements = 0;

	readonly #facts: Array<CoreFact | undefined> = [];
	readonly #effectRefinements: Array<CoreEffectRefinement | undefined> = [];
	#sealedBlocks: ReadonlyArray<CoreBlockId> | undefined;
	#sealedInstructions: ReadonlyArray<CoreInstructionId> | undefined;
	#blockSnapshot: ReadonlyArray<CoreBlockId> | undefined;
	#instructionSnapshot: ReadonlyArray<CoreInstructionId> | undefined;
	readonly kernel: CoreFunctionKernel;

	constructor(
		mutation: CoreStoreMutation,
		program: CoreProgram,
		id: CoreFunctionId,
		options: CoreFunctionOptions,
		generation = program.generation,
	) {
		this.#requireMutation(mutation);
		this.#program = program;
		this.id = id;
		this.registry = program.registry;
		this.generation = generation;
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
		this.kernel = new CoreFunctionKernel(
			{
				blockLive: this.#blockLive,
				blockFirstInstruction: this.#blockFirstInstruction,
				blockLastInstruction: this.#blockLastInstruction,
				blockParameterStart: this.#blockParameterStart,
				blockParameterCount: this.#blockParameterCount,
				blockParameterValues: this.#blockParameterValues,
				blockParameterRoles: this.#blockParameterRoles,
				blockHandlerBlock: this.#blockHandlerBlock,
				blockHandlerArgumentStart: this.#blockHandlerArgumentStart,
				blockHandlerArgumentCount: this.#blockHandlerArgumentCount,
				handlerArguments: this.#handlerArguments,
				handlerArgumentBlock: this.#handlerArgumentBlock,
				handlerArgumentPreviousUse: this.#handlerArgumentPreviousUse,
				handlerArgumentNextUse: this.#handlerArgumentNextUse,
				instructionLive: this.#instructionLive,
				instructionOpcode: this.#instructionOpcode,
				instructionBlock: this.#instructionBlock,
				instructionPrevious: this.#instructionPrevious,
				instructionNext: this.#instructionNext,
				instructionOperandStart: this.#instructionOperandStart,
				instructionOperandCount: this.#instructionOperandCount,
				instructionResultStart: this.#instructionResultStart,
				instructionResultCount: this.#instructionResultCount,
				instructionSourcePosition: this.#instructionSourcePosition,
				instructionEffectRefinementRef: this.#instructionEffectRefinementRef,
				instructionTerminatorEdgeStart: this.#instructionTerminatorEdgeStart,
				instructionTerminatorEdgeCount: this.#instructionTerminatorEdgeCount,
				instructionTerminatorFact: this.#instructionTerminatorFact,
				operands: this.#operands,
				operandUses: this.#operandUses,
				results: this.#results,
				functionParameters: this.#parameters,
				terminatorEdgeBlock: this.#terminatorEdgeBlock,
				terminatorEdgeArgumentStart: this.#terminatorEdgeArgumentStart,
				terminatorEdgeArgumentCount: this.#terminatorEdgeArgumentCount,
				terminatorEdgeCaseValue: this.#terminatorEdgeCaseValue,
				valueLive: this.#valueLive,
				valueRepresentation: this.#valueRepresentation,
				valueDefinitionKind: this.#valueDefinitionKind,
				valueDefinitionOwner: this.#valueDefinitionOwner,
				valueDefinitionIndex: this.#valueDefinitionIndex,
				valueFirstUse: this.#valueFirstUse,
				valueUseCount: this.#valueUseCount,
				valueFirstHandlerUse: this.#valueFirstHandlerUse,
				valueHandlerUseCount: this.#valueHandlerUseCount,
				useLive: this.#useLive,
				useValue: this.#useValue,
				useInstruction: this.#useInstruction,
				useOperand: this.#useOperand,
				usePrevious: this.#usePrevious,
				useNext: this.#useNext,
			},
			() => {
				if (this.#trackUseTraversal) this.#liveUseVisits++;
			},
		);
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

	version(domain: CoreChangeDomain): number {
		return this.#versions[domain];
	}

	get featureVersion(): number {
		return this.#featureVersion;
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

	get terminatorEdgeCapacity(): number {
		return this.#terminatorEdgeBlock.length;
	}

	get handlerArgumentCapacity(): number {
		return this.#handlerArguments.length;
	}

	get handlerBlockCount(): number {
		return this.#handlerBlocks.length;
	}

	handlerBlockAt(index: number): CoreBlockId {
		const block = this.#handlerBlocks[index];
		if (block === undefined) throw new Error(`Unknown Core handler block index ${index}`);
		return block;
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

	blockIds(): Iterable<CoreBlockId> {
		if (this.#retired) this.#throwRetiredGeneration();
		if (this.#sealedBlocks !== undefined) return this.#sealedBlocks;
		if (!this.#activeEditor) {
			if (this.#blockSnapshot === undefined) {
				const blocks: Array<CoreBlockId> = [];
				for (let id = 0; id < this.#blockLive.length; id++) {
					if (this.#blockLive[id] === 1) blocks.push(coreBlockId(id));
				}
				this.#blockSnapshot = Object.freeze(blocks);
			}
			return this.#blockSnapshot;
		}
		return this.#liveBlockIds();
	}

	*#liveBlockIds(): Iterable<CoreBlockId> {
		for (let id = 0; id < this.#blockLive.length; id++) {
			if (this.#blockLive[id] === 1) yield coreBlockId(id);
		}
	}

	instructionIds(block?: CoreBlockId): Iterable<CoreInstructionId> {
		if (this.#retired) this.#throwRetiredGeneration();
		if (block === undefined && this.#sealedInstructions !== undefined)
			return this.#sealedInstructions;
		if (block === undefined && !this.#activeEditor) {
			if (this.#instructionSnapshot === undefined) {
				const instructions: Array<CoreInstructionId> = [];
				for (let id = 0; id < this.#instructionLive.length; id++) {
					if (this.#instructionLive[id] === 1) instructions.push(coreInstructionId(id));
				}
				this.#instructionSnapshot = Object.freeze(instructions);
			}
			return this.#instructionSnapshot;
		}
		return this.#liveInstructionIds(block);
	}

	*#liveInstructionIds(block?: CoreBlockId): Iterable<CoreInstructionId> {
		if (block === undefined) {
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
			const start = this.#blockParameterStart[block]!;
			const count = this.#blockParameterCount[block]!;
			for (let index = 0; index < count; index++) {
				yield this.#blockParameterValues[start + index]!;
			}
		}
		for (const instruction of this.instructionIds()) {
			const start = this.#instructionResultStart[instruction]!;
			const count = this.#instructionResultCount[instruction]!;
			for (let index = 0; index < count; index++) {
				yield this.#results[start + index]!;
			}
		}
	}

	*bodyInstructionIds(block: CoreBlockId): Iterable<CoreInstructionId> {
		this.#requireBlock(block);
		for (
			let instruction = this.#blockFirstInstruction[block] ?? -1;
			instruction >= 0;
			instruction = this.#instructionNext[instruction] ?? -1
		) {
			if (this.#retired) this.#throwRetiredGeneration();
			if (this.#instructionOpcode[instruction]! >= 0)
				yield coreInstructionId(instruction);
		}
	}

	hasBodyInstructions(block: CoreBlockId): boolean {
		this.#requireBlock(block);
		const first = this.#blockFirstInstruction[block] ?? -1;
		return first >= 0 && this.#instructionOpcode[first]! >= 0;
	}

	*factIds(): Iterable<CoreFactId> {
		if (this.#retired) this.#throwRetiredGeneration();
		for (let id = 0; id < this.#facts.length; id++) {
			if (this.#facts[id] !== undefined) yield coreFactId(id);
		}
	}

	isBlockLive(id: CoreBlockId): boolean {
		if (this.#retired) this.#throwRetiredGeneration();
		return this.#blockLive[id] === 1;
	}

	isInstructionLive(id: CoreInstructionId): boolean {
		if (this.#retired) this.#throwRetiredGeneration();
		return this.#instructionLive[id] === 1;
	}

	isValueLive(id: CoreValueId): boolean {
		if (this.#retired) this.#throwRetiredGeneration();
		return this.#valueLive[id] === 1;
	}

	isFactLive(id: CoreFactId): boolean {
		if (this.#retired) this.#throwRetiredGeneration();
		return this.#facts[id] !== undefined;
	}

	effectRefinementLive(id: number): boolean {
		if (!Number.isSafeInteger(id) || id < 0 || id >= this.effectRefinementCapacity) {
			throw new Error(`Unknown Core effect-refinement row ${id}`);
		}
		return this.#effectRefinements[id] !== undefined;
	}

	effectRefinementRecord(id: number): CoreEffectRefinement {
		const refinement = this.#effectRefinements[id];
		if (refinement === undefined) {
			throw new Error(`Unknown Core effect-refinement ${id}`);
		}
		return refinement;
	}

	blockParameterValue(index: number): CoreValueId {
		const value = this.#blockParameterValues[index];
		if (value === undefined) throw new Error(`Unknown Core block parameter row ${index}`);
		return value;
	}

	blockParameterRole(index: number): "value" | "exception" {
		const role = BLOCK_PARAMETER_ROLES[this.#blockParameterRoles[index]!];
		if (role === undefined) throw new Error(`Unknown Core block parameter row ${index}`);
		return role;
	}

	resultRecord(index: number): CoreValueId {
		const value = this.#results[index];
		if (value === undefined) throw new Error(`Unknown Core result row ${index}`);
		return value;
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

	valueRepresentation(id: CoreValueId): CoreRepresentation {
		this.#requireValue(id);
		return REPRESENTATIONS[this.#valueRepresentation[id]!]!;
	}

	valueUseCount(id: CoreValueId): number {
		this.#requireValue(id);
		return this.#valueUseCount[id]!;
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
		return {
			abandonedOperands: this.#operands.length - this.#liveOperands,
			abandonedParameters: this.#blockParameterValues.length - this.#liveBlockParameters,
		};
	}

	liveStorageCounts(): CoreFunctionLiveStorageCounts {
		return {
			blocks: this.#liveBlocks,
			instructions: this.#liveInstructions,
			values: this.#liveBlockParameters + this.#liveInstructionResults,
			uses: this.#liveOperands,
			operands: this.#liveOperands,
			blockParameters: this.#liveBlockParameters,
			terminatorEdges: this.#liveTerminatorEdges,
			terminatorArguments: this.#liveTerminatorArguments,
			handlerArguments: this.#liveHandlerArguments,
			facts: this.#liveFacts,
			effectRefinements: this.#liveEffectRefinements,
		};
	}

	_denseConstructionGenerationCopy(
		mutation: CoreStoreMutation,
		generation: number,
	): CoreFunctionStore {
		this.#requireMutation(mutation);
		if (this.#activeEditor) {
			throw new Error(`Core function ${this.id} has an active editor`);
		}
		if (this.#sealed) throw new Error(`Core function ${this.id} is sealed`);
		const dense = new CoreFunctionStore(
			mutation,
			this.#program,
			this.id,
			{
				isGenerator: this.#isGenerator,
				isAsync: this.#isAsync,
				parameterCount: this.#parameterCount,
				metadata: this.#metadata,
			},
			generation,
		);
		dense._beginEdit(mutation);
		const blockMap = new Int32Array(this.blockCapacity);
		const instructionMap = new Int32Array(this.instructionCapacity);
		const valueMap = new Int32Array(this.valueCapacity);
		const factMap = new Int32Array(this.factCapacity);
		blockMap.fill(-1);
		instructionMap.fill(-1);
		valueMap.fill(-1);
		factMap.fill(-1);
		const mappedBlock = (block: CoreBlockId): CoreBlockId => {
			const mapped = blockMap[block] ?? -1;
			if (mapped < 0) throw new Error(`Core block ${block} was not relocated`);
			return coreBlockId(mapped);
		};
		const mappedInstruction = (instruction: CoreInstructionId): CoreInstructionId => {
			const mapped = instructionMap[instruction] ?? -1;
			if (mapped < 0) {
				throw new Error(`Core instruction ${instruction} was not relocated`);
			}
			return coreInstructionId(mapped);
		};
		const mappedValue = (value: CoreValueId): CoreValueId => {
			const mapped = valueMap[value] ?? -1;
			if (mapped < 0) throw new Error(`Core value ${value} was not relocated`);
			return coreValueId(mapped);
		};
		const mappedFact = (fact: CoreFactId): CoreFactId => {
			const mapped = factMap[fact] ?? -1;
			if (mapped < 0) throw new Error(`Core fact ${fact} was not relocated`);
			return coreFactId(mapped);
		};

		const blocks = [...this.blockIds()];
		const operations: Array<CoreInstructionId> = [];
		for (const block of blocks) {
			const parameterStart = this.#blockParameterStart[block]!;
			const parameterCount = this.#blockParameterCount[block]!;
			const created = dense._createBlock(
				mutation,
				Array.from({ length: parameterCount }, (_, index) => {
					const row = parameterStart + index;
					const value = this.#blockParameterValues[row]!;
					return {
						representation: this.valueRepresentation(value),
						role: BLOCK_PARAMETER_ROLES[this.#blockParameterRoles[row]!]!,
					};
				}),
			);
			blockMap[block] = created.block;
			for (let index = 0; index < parameterCount; index++) {
				valueMap[this.#blockParameterValues[parameterStart + index]!] =
					created.values[index]!;
			}
			for (const instruction of this.instructionIds(block)) {
				if (this.instructionKind(instruction) === "operation") {
					operations.push(instruction);
				}
			}
		}

		const pendingDependencies = new Int32Array(this.instructionCapacity);
		const dependents = new Array<Array<CoreInstructionId> | undefined>(
			this.instructionCapacity,
		);
		const ready: Array<CoreInstructionId> = [];
		for (const instruction of operations) {
			const dependencies = new Set<CoreInstructionId>();
			const operandStart = this.#instructionOperandStart[instruction]!;
			const operandCount = this.#instructionOperandCount[instruction]!;
			for (let offset = 0; offset < operandCount; offset++) {
				const value = this.#operands[operandStart + offset]!;
				if ((valueMap[value] ?? -1) >= 0) continue;
				if (this.#valueDefinitionKind[value] !== 1) {
					throw new Error(`Core value ${value} has no live relocation source`);
				}
				const dependency = coreInstructionId(this.#valueDefinitionOwner[value]!);
				if (this.instructionKind(dependency) !== "operation") {
					throw new Error(`Core value ${value} is defined by a terminator`);
				}
				dependencies.add(dependency);
			}
			pendingDependencies[instruction] = dependencies.size;
			if (dependencies.size === 0) ready.push(instruction);
			for (const dependency of dependencies) {
				const users = dependents[dependency] ?? [];
				users.push(instruction);
				dependents[dependency] = users;
			}
		}
		let relocatedOperations = 0;
		for (let cursor = 0; cursor < ready.length; cursor++) {
			const instruction = ready[cursor]!;
			const operandStart = this.#instructionOperandStart[instruction]!;
			const operandCount = this.#instructionOperandCount[instruction]!;
			const resultStart = this.#instructionResultStart[instruction]!;
			const resultCount = this.#instructionResultCount[instruction]!;
			const opcode = coreOpcodeId(this.#instructionOpcode[instruction]!);
			const created = dense._insertOperation(
				mutation,
				mappedBlock(coreBlockId(this.#instructionBlock[instruction]!)),
				undefined,
				opcode,
				Array.from({ length: operandCount }, (_, index) =>
					mappedValue(this.#operands[operandStart + index]!),
				),
				Array.from({ length: resultCount }, (_, index) =>
					this.valueRepresentation(this.#results[resultStart + index]!),
				),
				EMPTY_CORE_INSTRUCTION_ATTRIBUTES,
				this.#instructionSourcePosition[instruction]! < 0
					? undefined
					: this.#instructionSourcePosition[instruction],
				undefined,
			);
			instructionMap[instruction] = created.instruction;
			for (let index = 0; index < resultCount; index++) {
				valueMap[this.#results[resultStart + index]!] = created.results[index]!;
			}
			relocatedOperations++;
			for (const dependent of dependents[instruction] ?? []) {
				pendingDependencies[dependent] = pendingDependencies[dependent]! - 1;
				if (pendingDependencies[dependent] === 0) ready.push(dependent);
			}
		}
		if (relocatedOperations !== operations.length) {
			throw new Error(`Core function ${this.id} has an instruction dependency cycle`);
		}
		for (const block of blocks) {
			let before: CoreInstructionId | undefined;
			const ordered = [...this.instructionIds(block)].filter(
				(instruction) => this.instructionKind(instruction) === "operation",
			);
			for (let index = ordered.length - 1; index >= 0; index--) {
				const instruction = mappedInstruction(ordered[index]!);
				dense._moveInstruction(mutation, instruction, mappedBlock(block), before);
				before = instruction;
			}
		}

		for (const factId of this.factIds()) {
			const fact = this.fact(factId);
			factMap[factId] = dense._addFact(mutation, {
				kind: fact.kind,
				value: fact.value,
				claims: fact.claims,
				validity: fact.validity,
				obligations: fact.obligations,
				origin: fact.origin,
			});
		}
		const readTerminator = (instruction: CoreInstructionId): CoreTerminatorPayload => {
			const kind = this.instructionKind(instruction);
			if (kind === "operation") {
				throw new Error(`Core instruction ${instruction} is not a terminator`);
			}
			const operandStart = this.#instructionOperandStart[instruction]!;
			const edgeStart = this.#instructionTerminatorEdgeStart[instruction]!;
			const edge = (offset: number): CoreEdge => {
				const row = edgeStart + offset;
				const argumentStart = this.#terminatorEdgeArgumentStart[row]!;
				const argumentCount = this.#terminatorEdgeArgumentCount[row]!;
				return {
					block: this.#terminatorEdgeBlock[row]!,
					arguments: this.#operands.slice(argumentStart, argumentStart + argumentCount),
				};
			};
			switch (kind) {
				case "jump":
					return { kind, edge: edge(0) };
				case "branch":
					return {
						kind,
						condition: this.#operands[operandStart]!,
						consequent: edge(0),
						alternate: edge(1),
					};
				case "guard":
					return {
						kind,
						condition: this.#operands[operandStart]!,
						fact: coreFactId(this.#instructionTerminatorFact[instruction]!),
						success: edge(0),
						fallback: edge(1),
					};
				case "switch": {
					const edgeCount = this.#instructionTerminatorEdgeCount[instruction]!;
					return {
						kind,
						discriminant: this.#operands[operandStart]!,
						cases: Array.from({ length: edgeCount - 1 }, (_, index) => ({
							value: this.#terminatorEdgeCaseValue[edgeStart + index]!,
							edge: edge(index),
						})),
						default: edge(edgeCount - 1),
					};
				}
				case "return":
				case "throw":
					return { kind, value: this.#operands[operandStart]! };
				case "unreachable":
					return { kind };
			}
		};
		const relocateEdge = (edge: CoreEdge): CoreEdge => ({
			block: mappedBlock(edge.block),
			arguments: edge.arguments.map(mappedValue),
		});
		const relocateTerminator = (
			payload: CoreTerminatorPayload,
		): CoreTerminatorPayload => {
			switch (payload.kind) {
				case "jump":
					return { kind: payload.kind, edge: relocateEdge(payload.edge) };
				case "branch":
					return {
						kind: payload.kind,
						condition: mappedValue(payload.condition),
						consequent: relocateEdge(payload.consequent),
						alternate: relocateEdge(payload.alternate),
					};
				case "guard":
					return {
						kind: payload.kind,
						condition: mappedValue(payload.condition),
						fact: mappedFact(payload.fact),
						success: relocateEdge(payload.success),
						fallback: relocateEdge(payload.fallback),
					};
				case "switch":
					return {
						kind: payload.kind,
						discriminant: mappedValue(payload.discriminant),
						cases: payload.cases.map(({ value, edge }) => ({
							value,
							edge: relocateEdge(edge),
						})),
						default: relocateEdge(payload.default),
					};
				case "return":
				case "throw":
					return { kind: payload.kind, value: mappedValue(payload.value) };
				case "unreachable":
					return { kind: payload.kind };
			}
		};
		for (const block of blocks) {
			const terminator = this.blockTerminator(block);
			const relocated = dense._setTerminator(
				mutation,
				mappedBlock(block),
				relocateTerminator(readTerminator(terminator)),
				this.#instructionSourcePosition[terminator]! < 0
					? undefined
					: this.#instructionSourcePosition[terminator],
			);
			instructionMap[terminator] = relocated;
		}
		for (const instruction of operations) {
			const relocated = mappedInstruction(instruction);
			const opcode = coreOpcodeId(this.#instructionOpcode[instruction]!);
			dense.#instructionPayload[relocated] = relocateInstructionAttributes(
				this.#instructionPayload[instruction] ?? EMPTY_CORE_INSTRUCTION_ATTRIBUTES,
				this.registry.byId(opcode).attributeRelocations,
				{
					block: (id) => mappedBlock(coreBlockId(id)),
					instruction: (id) => mappedInstruction(coreInstructionId(id)),
					value: (id) => mappedValue(coreValueId(id)),
					fact: (id) => mappedFact(coreFactId(id)),
				},
			);
		}

		for (const factId of this.factIds()) {
			const fact = this.fact(factId);
			dense._replaceFact(mutation, mappedFact(factId), {
				kind: fact.kind,
				value: fact.value,
				claims: fact.claims.map((claim) =>
					claim.kind === "effect"
						? { ...claim, instruction: mappedInstruction(claim.instruction) }
						: { ...claim, subject: mappedValue(claim.subject) },
				),
				validity:
					fact.validity.kind === "guard"
						? {
								...fact.validity,
								instruction: mappedInstruction(fact.validity.instruction),
							}
						: fact.validity,
				obligations: fact.obligations.map((obligation) =>
					obligation.kind === "guard"
						? {
								...obligation,
								instruction: mappedInstruction(obligation.instruction),
							}
						: obligation,
				),
				origin: fact.origin,
			});
		}
		for (const instruction of operations) {
			const refinement = this.instructionEffectRefinement(instruction);
			if (refinement === undefined) continue;
			dense._setInstructionEffectRefinement(mutation, mappedInstruction(instruction), {
				effects: refinement.effects,
				proof: mappedFact(refinement.proof),
			});
		}
		for (const block of blocks) {
			const handler = this.#blockHandlerBlock[block]!;
			if (handler < 0) continue;
			const argumentStart = this.#blockHandlerArgumentStart[block]!;
			const argumentCount = this.#blockHandlerArgumentCount[block]!;
			dense._setHandler(mutation, mappedBlock(block), {
				block: mappedBlock(coreBlockId(handler)),
				arguments: Array.from({ length: argumentCount }, (_, index) =>
					mappedValue(this.#handlerArguments[argumentStart + index]!),
				),
			});
		}
		dense._finishFunction(
			mutation,
			mappedBlock(this.entry),
			this.#bodyEntry === undefined ? undefined : mappedBlock(this.#bodyEntry),
		);
		dense.#activeEditor = false;
		for (const domain of FUNCTION_DOMAINS) {
			dense.#versions[domain] = this.#versions[domain] + 1;
		}
		dense.#featureVersion = this.#featureVersion + 1;
		return dense;
	}

	_retireConstructionGeneration(mutation: CoreStoreMutation): void {
		this.#requireMutation(mutation);
		if (this.#activeEditor) {
			throw new Error(`Core function ${this.id} has an active editor`);
		}
		this.#retired = true;
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
		this.#blockSnapshot = undefined;
		this.#instructionSnapshot = undefined;
		this.#activeEditor = true;
	}

	_endEdit(mutation: CoreStoreMutation, domains: ReadonlySet<CoreChangeDomain>): void {
		this.#requireMutation(mutation);
		if (!this.#activeEditor) throw new Error(`Core function ${this.id} has no editor`);
		for (const domain of domains) this.#versions[domain]++;
		if (domains.has("body") || domains.has("cfg") || domains.has("exceptionFlow")) {
			this.#featureVersion++;
		}
		this.#program._recordFunctionChange(mutation, this.id, domains);
		this.#activeEditor = false;
	}

	_createBlock(
		mutation: CoreStoreMutation,
		parameters: ReadonlyArray<CoreBlockParameterSpec>,
	): { readonly block: CoreBlockId; readonly values: ReadonlyArray<CoreValueId> } {
		this.#assertEditing(mutation);
		const block = coreBlockId(this.#blockLive.length);
		this.#blockLive.push(1);
		this.#liveBlocks++;
		this.#blockFirstInstruction.push(-1);
		this.#blockLastInstruction.push(-1);
		this.#blockHandlerBlock.push(-1);
		this.#blockHandlerArgumentStart.push(0);
		this.#blockHandlerArgumentCount.push(0);
		this.#handlerBlockIndexes.push(-1);
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
		return this._appendBlockParameters(mutation, block, [spec], prepend)[0]!;
	}

	_appendBlockParameters(
		mutation: CoreStoreMutation,
		block: CoreBlockId,
		specs: ReadonlyArray<CoreBlockParameterSpec>,
		prepend: boolean,
	): ReadonlyArray<CoreValueId> {
		this.#assertEditing(mutation);
		this.#requireBlock(block);
		if (specs.length === 0) return [];
		const start = this.#blockParameterStart[block]!;
		const count = this.#blockParameterCount[block]!;
		const added = specs.map((spec, offset) =>
			this.#createValue(
				spec.representation ?? "boxed",
				0,
				block,
				(prepend ? 0 : count) + offset,
			),
		);
		const values = new Array<CoreValueId>(count + added.length);
		const roles = new Array<"value" | "exception">(count + added.length);
		const existingOffset = prepend ? added.length : 0;
		for (let parameter = 0; parameter < count; parameter++) {
			values[existingOffset + parameter] = this.#blockParameterValues[start + parameter]!;
			roles[existingOffset + parameter] =
				BLOCK_PARAMETER_ROLES[this.#blockParameterRoles[start + parameter]!]!;
		}
		const addedOffset = prepend ? 0 : count;
		for (let offset = 0; offset < added.length; offset++) {
			values[addedOffset + offset] = added[offset]!;
			roles[addedOffset + offset] = specs[offset]!.role ?? "value";
		}
		for (const [parameterIndex, parameterValue] of values.entries()) {
			this.#valueDefinitionIndex[parameterValue] = parameterIndex;
		}
		this.#replaceBlockParameterRange(block, values, roles);
		return added;
	}

	_removeBlockParameter(
		mutation: CoreStoreMutation,
		block: CoreBlockId,
		index: number,
	): CoreValueId {
		this.#assertEditing(mutation);
		this.#requireBlock(block);
		const start = this.#blockParameterStart[block]!;
		const count = this.#blockParameterCount[block]!;
		if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
			throw new Error(`Unknown Core block ${block} parameter ${index}`);
		}
		const value = this.#blockParameterValues[start + index]!;
		if (this.#valueUseCount[value] !== 0) {
			throw new Error(
				`Cannot remove Core block ${block} parameter ${index}; value ${value} is used`,
			);
		}
		const values = new Array<CoreValueId>(count - 1);
		const roles = new Array<"value" | "exception">(count - 1);
		let destination = 0;
		for (let source = 0; source < count; source++) {
			if (source === index) continue;
			const parameterValue = this.#blockParameterValues[start + source]!;
			values[destination] = parameterValue;
			roles[destination] =
				BLOCK_PARAMETER_ROLES[this.#blockParameterRoles[start + source]!]!;
			this.#valueDefinitionIndex[parameterValue] = destination;
			destination++;
		}
		this.#valueLive[value] = 0;
		this.#replaceBlockParameterRange(block, values, roles);
		return value;
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
		const start = this.#instructionResultStart[instruction]!;
		const count = this.#instructionResultCount[instruction]!;
		return { instruction, results: this.#results.slice(start, start + count) };
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
		const instruction = this.#allocateInstruction(
			block,
			TERMINATOR_CODES[payload.kind],
			terminatorOperands(payload),
			[],
			undefined,
			sourcePosition,
			undefined,
			undefined,
		);
		this.#writeTerminatorMetadata(instruction, payload);
		return instruction;
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

	_replaceUseValue(
		mutation: CoreStoreMutation,
		use: number,
		replacement: CoreValueId,
	): void {
		this.#assertEditing(mutation);
		this.#requireValue(replacement);
		if (this.#useLive[use] !== 1) throw new Error(`Core use ${use} is not live`);
		const value = this.#useValue[use]!;
		if (value === replacement) return;
		const instruction = this.#useInstruction[use]!;
		const operand = this.#useOperand[use]!;
		const operandIndex = this.#instructionOperandStart[instruction]! + operand;
		if (this.#operandUses[operandIndex] !== use) {
			throw new Error(`Core use ${use} does not own its operand`);
		}
		const previous = this.#usePrevious[use]!;
		const next = this.#useNext[use]!;
		if (previous < 0) this.#valueFirstUse[value] = next;
		else this.#useNext[previous] = next;
		if (next >= 0) this.#usePrevious[next] = previous;
		this.#valueUseCount[value] = this.#valueUseCount[value]! - 1;
		const replacementFirstUse = this.#valueFirstUse[replacement]!;
		this.#useValue[use] = replacement;
		this.#usePrevious[use] = -1;
		this.#useNext[use] = replacementFirstUse;
		if (replacementFirstUse >= 0) this.#usePrevious[replacementFirstUse] = use;
		this.#valueFirstUse[replacement] = use;
		this.#valueUseCount[replacement] = this.#valueUseCount[replacement]! + 1;
		this.#operands[operandIndex] = replacement;
	}

	_replaceHandlerArgumentUse(
		mutation: CoreStoreMutation,
		use: number,
		replacement: CoreValueId,
	): void {
		this.#assertEditing(mutation);
		this.#requireValue(replacement);
		if ((this.#handlerArgumentBlock[use] ?? -1) < 0) {
			throw new Error(`Core handler argument use ${use} is not live`);
		}
		const value = this.#handlerArguments[use]!;
		if (value === replacement) return;
		this.#unlinkHandlerArgumentUse(use, value);
		this.#handlerArguments[use] = replacement;
		this.#linkHandlerArgumentUse(use, replacement);
	}

	_refreshOperandUses(mutation: CoreStoreMutation, instruction: CoreInstructionId): void {
		this.#assertEditing(mutation);
		this.#requireInstruction(instruction);
		const start = this.#instructionOperandStart[instruction]!;
		const count = this.#instructionOperandCount[instruction]!;
		for (let operand = 0; operand < count; operand++) {
			this.#deactivateUse(this.#operandUses[start + operand]!);
		}
		for (let operand = 0; operand < count; operand++) {
			this.#operandUses[start + operand] = this.#allocateUse(
				this.#operands[start + operand]!,
				instruction,
				operand,
			);
		}
	}

	_removeInstruction(mutation: CoreStoreMutation, instruction: CoreInstructionId): void {
		this.#assertEditing(mutation);
		this.#requireInstruction(instruction);
		const resultStart = this.#instructionResultStart[instruction]!;
		const resultCount = this.#instructionResultCount[instruction]!;
		for (let index = 0; index < resultCount; index++) {
			const result = this.#results[resultStart + index]!;
			if (this.#valueUseCount[result] !== 0 || this.#valueHandlerUseCount[result] !== 0) {
				throw new Error(
					`Cannot remove Core instruction ${instruction}; value ${result} is used`,
				);
			}
		}
		const operandStart = this.#instructionOperandStart[instruction]!;
		const operandCount = this.#instructionOperandCount[instruction]!;
		for (let index = 0; index < operandCount; index++) {
			this.#deactivateUse(this.#operandUses[operandStart + index]!);
		}
		this.#releaseOperandRange(operandStart, operandCount);
		this.#liveOperands -= operandCount;
		this.#instructionOperandStart[instruction] = 0;
		this.#instructionOperandCount[instruction] = 0;
		const edgeStart = this.#instructionTerminatorEdgeStart[instruction]!;
		const edgeCount = this.#instructionTerminatorEdgeCount[instruction]!;
		for (let edge = edgeStart; edge < edgeStart + edgeCount; edge++) {
			this.#liveTerminatorArguments -= this.#terminatorEdgeArgumentCount[edge]!;
		}
		this.#liveTerminatorEdges -= edgeCount;
		this.#releaseTerminatorEdgeRange(edgeStart, edgeCount);
		this.#instructionTerminatorEdgeStart[instruction] = 0;
		this.#instructionTerminatorEdgeCount[instruction] = 0;
		this.#instructionTerminatorFact[instruction] = -1;
		for (let index = 0; index < resultCount; index++) {
			this.#valueLive[this.#results[resultStart + index]!] = 0;
		}
		this.#liveInstructionResults -= resultCount;
		this.#removeEffectRefinement(instruction);
		const block = this.#instructionBlock[instruction]!;
		const previous = this.#instructionPrevious[instruction]!;
		const next = this.#instructionNext[instruction]!;
		if (previous < 0) this.#blockFirstInstruction[block] = next;
		else this.#instructionNext[previous] = next;
		if (next < 0) this.#blockLastInstruction[block] = previous;
		else this.#instructionPrevious[next] = previous;
		this.#instructionLive[instruction] = 0;
		this.#liveInstructions--;
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
		const parameterStart = this.#blockParameterStart[block]!;
		const parameterCount = this.#blockParameterCount[block]!;
		for (let index = 0; index < parameterCount; index++) {
			const parameter = this.#blockParameterValues[parameterStart + index]!;
			if (
				this.#valueUseCount[parameter] !== 0 ||
				this.#valueHandlerUseCount[parameter] !== 0
			) {
				const descriptions: Array<string> = [];
				for (
					let use = this.#valueFirstUse[parameter]!;
					use >= 0;
					use = this.#useNext[use]!
				) {
					if (this.#trackUseTraversal) this.#liveUseVisits++;
					const instruction = this.#useInstruction[use]!;
					descriptions.push(
						`@${instruction}:${this.#useOperand[use]} in b${this.instructionBlock(instruction)}`,
					);
				}
				for (
					let use = this.#valueFirstHandlerUse[parameter]!;
					use >= 0;
					use = this.#handlerArgumentNextUse[use]!
				) {
					descriptions.push(`exception edge from b${this.#handlerArgumentBlock[use]}`);
				}
				throw new Error(
					`Cannot remove Core block ${block}; parameter ${parameter} is used by ${descriptions.join(", ")}`,
				);
			}
			this.#valueLive[parameter] = 0;
		}
		this.#blockLive[block] = 0;
		this.#liveBlocks--;
		this.#blockFirstInstruction[block] = -1;
		this.#blockLastInstruction[block] = -1;
		const handlerArgumentCount = this.#blockHandlerArgumentCount[block]!;
		this.#releaseHandlerArgumentRange(
			this.#blockHandlerArgumentStart[block]!,
			handlerArgumentCount,
		);
		this.#liveHandlerArguments -= handlerArgumentCount;
		if (this.#blockHandlerBlock[block]! >= 0) this.#removeHandlerBlock(block);
		this.#blockHandlerBlock[block] = -1;
		this.#blockHandlerArgumentStart[block] = 0;
		this.#blockHandlerArgumentCount[block] = 0;
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
		const oldStart = this.#blockHandlerArgumentStart[block]!;
		const oldCount = this.#blockHandlerArgumentCount[block]!;
		const nextCount = handler?.arguments.length ?? 0;
		this.#liveHandlerArguments += nextCount - oldCount;
		let start = oldStart;
		if (oldCount !== nextCount) {
			this.#releaseHandlerArgumentRange(oldStart, oldCount);
			start = this.#allocateHandlerArgumentRange(nextCount);
		} else {
			this.#deactivateHandlerArgumentRange(oldStart, oldCount);
		}
		const hadHandler = this.#blockHandlerBlock[block]! >= 0;
		if (!hadHandler && handler !== undefined) {
			this.#handlerBlockIndexes[block] = this.#handlerBlocks.length;
			this.#handlerBlocks.push(block);
		} else if (hadHandler && handler === undefined) {
			this.#removeHandlerBlock(block);
		}
		this.#blockHandlerBlock[block] = handler?.block ?? -1;
		this.#blockHandlerArgumentStart[block] = start;
		this.#blockHandlerArgumentCount[block] = nextCount;
		if (handler !== undefined) {
			for (const [index, value] of handler.arguments.entries()) {
				this.#requireValue(value);
				const use = start + index;
				this.#handlerArguments[use] = value;
				this.#handlerArgumentBlock[use] = block;
				this.#linkHandlerArgumentUse(use, value);
			}
		}
	}

	#removeHandlerBlock(block: CoreBlockId): void {
		const index = this.#handlerBlockIndexes[block]!;
		if (index < 0) throw new Error(`Core block ${block} has no handler index`);
		const last = this.#handlerBlocks.pop()!;
		if (index < this.#handlerBlocks.length) {
			this.#handlerBlocks[index] = last;
			this.#handlerBlockIndexes[last] = index;
		}
		this.#handlerBlockIndexes[block] = -1;
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
		this.#instructionPayload[instruction] = undefined;
		this._replaceOperands(mutation, instruction, terminatorOperands(payload));
		this.#writeTerminatorMetadata(instruction, payload);
	}

	_addFact(mutation: CoreStoreMutation, fact: Omit<CoreFact, "id">): CoreFactId {
		this.#assertEditing(mutation);
		const id = coreFactId(this.#facts.length);
		this.#facts.push(freezeFact(id, fact));
		this.#liveFacts++;
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
		this.#liveFacts--;
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
		this.#requireBlock(entry);
		const start = this.#blockParameterStart[entry]!;
		const count = this.#blockParameterCount[entry]!;
		if (count < this.#parameterCount) {
			throw new Error(
				`Core entry block has ${count} parameters for a ${this.#parameterCount}-parameter ABI`,
			);
		}
		const values = new Array<CoreValueId>(this.#parameterCount);
		for (let index = 0; index < this.#parameterCount; index++) {
			const value = this.#blockParameterValues[start + index]!;
			this.#requireValue(value);
			if (
				this.#blockParameterRoles[start + index] !== 0 ||
				REPRESENTATIONS[this.#valueRepresentation[value]!] !== "boxed"
			) {
				throw new Error("Core ABI parameters must be boxed value parameters");
			}
			values[index] = value;
		}
		this.#parameters.splice(0, this.#parameters.length, ...values);
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
		payload: CoreInstructionAttributes | undefined,
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
		this.#liveInstructions++;
		this.#instructionOpcode.push(opcode);
		this.#instructionBlock.push(block);
		this.#instructionPrevious.push(previous);
		this.#instructionNext.push(beforeIndex);
		this.#instructionOperandStart.push(0);
		this.#instructionOperandCount.push(0);
		this.#instructionResultStart.push(this.#results.length);
		this.#instructionResultCount.push(outputRepresentations.length);
		this.#liveInstructionResults += outputRepresentations.length;
		this.#instructionSourcePosition.push(sourcePosition ?? -1);
		this.#instructionEffectRefinementRef.push(
			this.#appendEffectRefinement(effectRefinement),
		);
		this.#instructionTerminatorEdgeStart.push(0);
		this.#instructionTerminatorEdgeCount.push(0);
		this.#instructionTerminatorFact.push(-1);
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
		this.#liveEffectRefinements++;
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
		this.#liveEffectRefinements--;
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
		this.#valueFirstHandlerUse.push(-1);
		this.#valueHandlerUseCount.push(0);
		return value;
	}

	#replaceBlockParameterRange(
		block: CoreBlockId,
		values: ReadonlyArray<CoreValueId>,
		roles: ReadonlyArray<"value" | "exception">,
	): void {
		const oldStart = this.#blockParameterStart[block] ?? 0;
		const oldCount = this.#blockParameterCount[block] ?? 0;
		this.#liveBlockParameters += values.length - oldCount;
		let start = oldStart;
		if (oldCount !== values.length) {
			this.#releaseBlockParameterRange(oldStart, oldCount);
			start = this.#allocateBlockParameterRange(values.length);
		}
		this.#blockParameterStart[block] = start;
		this.#blockParameterCount[block] = values.length;
		for (let index = 0; index < values.length; index++) {
			this.#blockParameterValues[start + index] = values[index]!;
			this.#blockParameterRoles[start + index] = roles[index] === "exception" ? 1 : 0;
		}
	}

	#writeTerminatorMetadata(
		instruction: CoreInstructionId,
		payload: CoreTerminatorPayload,
	): void {
		const edgeCount =
			payload.kind === "jump"
				? 1
				: payload.kind === "branch" || payload.kind === "guard"
					? 2
					: payload.kind === "switch"
						? payload.cases.length + 1
						: 0;
		const oldStart = this.#instructionTerminatorEdgeStart[instruction] ?? 0;
		const oldCount = this.#instructionTerminatorEdgeCount[instruction] ?? 0;
		let oldArgumentCount = 0;
		for (let edge = oldStart; edge < oldStart + oldCount; edge++) {
			oldArgumentCount += this.#terminatorEdgeArgumentCount[edge]!;
		}
		this.#liveTerminatorEdges += edgeCount - oldCount;
		let start = oldStart;
		if (oldCount !== edgeCount) {
			this.#releaseTerminatorEdgeRange(oldStart, oldCount);
			start = this.#allocateTerminatorEdgeRange(edgeCount);
		}
		this.#instructionTerminatorEdgeStart[instruction] = start;
		this.#instructionTerminatorEdgeCount[instruction] = edgeCount;
		this.#instructionTerminatorFact[instruction] =
			payload.kind === "guard" ? payload.fact : -1;
		const operandStart = this.#instructionOperandStart[instruction]!;
		const operandCount = this.#instructionOperandCount[instruction]!;
		let operandOffset =
			payload.kind === "branch" ||
			payload.kind === "guard" ||
			payload.kind === "switch" ||
			payload.kind === "return" ||
			payload.kind === "throw"
				? 1
				: 0;
		let edgeOffset = 0;
		let argumentCount = 0;
		const writeEdge = (
			block: CoreBlockId,
			edgeArgumentCount: number,
			caseValue?: CoreImmediate,
		): void => {
			const row = start + edgeOffset++;
			this.#terminatorEdgeBlock[row] = block;
			this.#terminatorEdgeArgumentStart[row] = operandStart + operandOffset;
			this.#terminatorEdgeArgumentCount[row] = edgeArgumentCount;
			this.#terminatorEdgeCaseValue[row] =
				caseValue === undefined ? undefined : freezeImmediate(caseValue);
			operandOffset += edgeArgumentCount;
			argumentCount += edgeArgumentCount;
		};
		switch (payload.kind) {
			case "jump":
				writeEdge(payload.edge.block, payload.edge.arguments.length);
				break;
			case "branch":
				writeEdge(payload.consequent.block, payload.consequent.arguments.length);
				writeEdge(payload.alternate.block, payload.alternate.arguments.length);
				break;
			case "guard":
				writeEdge(payload.success.block, payload.success.arguments.length);
				writeEdge(payload.fallback.block, payload.fallback.arguments.length);
				break;
			case "switch":
				for (const branch of payload.cases) {
					writeEdge(branch.edge.block, branch.edge.arguments.length, branch.value);
				}
				writeEdge(payload.default.block, payload.default.arguments.length);
				break;
			case "return":
			case "throw":
			case "unreachable":
				break;
		}
		if (edgeOffset !== edgeCount || operandOffset !== operandCount) {
			throw new Error(`Malformed Core ${payload.kind} storage`);
		}
		this.#liveTerminatorArguments += argumentCount - oldArgumentCount;
	}

	#writeOperandRange(
		instruction: CoreInstructionId,
		operands: ReadonlyArray<CoreValueId>,
	): void {
		const oldStart = this.#instructionOperandStart[instruction] ?? 0;
		const oldCount = this.#instructionOperandCount[instruction] ?? 0;
		this.#liveOperands += operands.length - oldCount;
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

	#allocateTerminatorEdgeRange(count: number): number {
		if (count === 0) return 0;
		const free = this.#terminatorEdgeFreeBySize[count]?.pop();
		if (free !== undefined) return free;
		const start = this.#terminatorEdgeBlock.length;
		this.#terminatorEdgeBlock.length += count;
		this.#terminatorEdgeArgumentStart.length += count;
		this.#terminatorEdgeArgumentCount.length += count;
		this.#terminatorEdgeCaseValue.length += count;
		return start;
	}

	#releaseTerminatorEdgeRange(start: number, count: number): void {
		if (count === 0) return;
		for (let offset = 0; offset < count; offset++) {
			this.#terminatorEdgeCaseValue[start + offset] = undefined;
		}
		const free = this.#terminatorEdgeFreeBySize[count] ?? [];
		free.push(start);
		this.#terminatorEdgeFreeBySize[count] = free;
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

	#allocateHandlerArgumentRange(count: number): number {
		if (count === 0) return 0;
		const free = this.#handlerArgumentFreeBySize[count]?.pop();
		if (free !== undefined) return free;
		const start = this.#handlerArguments.length;
		this.#handlerArguments.length += count;
		this.#handlerArgumentBlock.length += count;
		this.#handlerArgumentPreviousUse.length += count;
		this.#handlerArgumentNextUse.length += count;
		return start;
	}

	#releaseHandlerArgumentRange(start: number, count: number): void {
		if (count === 0) return;
		this.#deactivateHandlerArgumentRange(start, count);
		const free = this.#handlerArgumentFreeBySize[count] ?? [];
		free.push(start);
		this.#handlerArgumentFreeBySize[count] = free;
	}

	#deactivateHandlerArgumentRange(start: number, count: number): void {
		for (let offset = 0; offset < count; offset++) {
			const use = start + offset;
			const value = this.#handlerArguments[use];
			if (value !== undefined && (this.#handlerArgumentBlock[use] ?? -1) >= 0) {
				this.#unlinkHandlerArgumentUse(use, value);
			}
			this.#handlerArgumentBlock[use] = -1;
			this.#handlerArgumentPreviousUse[use] = -1;
			this.#handlerArgumentNextUse[use] = -1;
		}
	}

	#linkHandlerArgumentUse(use: number, value: CoreValueId): void {
		const next = this.#valueFirstHandlerUse[value]!;
		this.#handlerArgumentPreviousUse[use] = -1;
		this.#handlerArgumentNextUse[use] = next;
		if (next >= 0) this.#handlerArgumentPreviousUse[next] = use;
		this.#valueFirstHandlerUse[value] = use;
		this.#valueHandlerUseCount[value] = this.#valueHandlerUseCount[value]! + 1;
	}

	#unlinkHandlerArgumentUse(use: number, value: CoreValueId): void {
		const previous = this.#handlerArgumentPreviousUse[use] ?? -1;
		const next = this.#handlerArgumentNextUse[use] ?? -1;
		if (previous < 0) this.#valueFirstHandlerUse[value] = next;
		else this.#handlerArgumentNextUse[previous] = next;
		if (next >= 0) this.#handlerArgumentPreviousUse[next] = previous;
		this.#handlerArgumentPreviousUse[use] = -1;
		this.#handlerArgumentNextUse[use] = -1;
		this.#valueHandlerUseCount[value] = this.#valueHandlerUseCount[value]! - 1;
	}

	#requireMutation(mutation: CoreStoreMutation): void {
		if (mutation !== CORE_STORE_MUTATION)
			throw new Error("Core store mutation is private");
	}

	#throwRetiredGeneration(): never {
		throw new Error(
			`Core function ${this.id} belongs to retired generation ${this.generation}`,
		);
	}

	#assertEditing(mutation: CoreStoreMutation): void {
		this.#requireMutation(mutation);
		if (!this.#activeEditor) throw new Error(`Core function ${this.id} has no editor`);
	}

	#requireBlock(id: CoreBlockId): void {
		if (this.#retired) this.#throwRetiredGeneration();
		if (this.#blockLive[id] !== 1) throw new Error(`Unknown Core block ${id}`);
	}

	#requireInstruction(id: CoreInstructionId): void {
		if (this.#retired) this.#throwRetiredGeneration();
		if (this.#instructionLive[id] !== 1)
			throw new Error(`Unknown Core instruction ${id}`);
	}

	#requireValue(id: CoreValueId): void {
		if (this.#retired) this.#throwRetiredGeneration();
		if (this.#valueLive[id] !== 1) throw new Error(`Unknown Core value ${id}`);
	}
}

export class CoreProgram {
	readonly registry: CoreOpcodeRegistry;
	#staticDescriptions: StaticDescriptionInterner | undefined;
	readonly #staticCellIndexes = new WeakMap<
		CoreCompilationContext,
		{ generation: number; index: CoreStaticCellIndex }
	>();

	staticCellIndex(
		context: CoreCompilationContext,
		create: () => CoreStaticCellIndex,
	): CoreStaticCellIndex {
		const cached = this.#staticCellIndexes.get(context);
		if (cached?.generation === this.#generation) return cached.index;
		const index = create();
		this.#staticCellIndexes.set(context, { generation: this.#generation, index });
		return index;
	}

	get staticDescriptions(): StaticDescriptionInterner {
		return (this.#staticDescriptions ??= new StaticDescriptionInterner());
	}
	readonly #functions: Array<CoreFunctionStore | undefined> = [];
	#generation = 0;
	readonly #versions: Record<CoreProgramChangeDomain, number> = {
		functions: 0,
		data: 0,
		sourcePositions: 0,
		calls: 0,
		facts: 0,
		representations: 0,
		specializationInputs: 0,
	};
	readonly #functionVersions: Record<CoreChangeDomain, number> = {
		body: 0,
		cfg: 0,
		exceptionFlow: 0,
		calls: 0,
		memoryEffects: 0,
		facts: 0,
		representations: 0,
		specializationInputs: 0,
	};
	readonly #programFlowFunctions: Array<number> = [];
	readonly #programFlowDomainMasks: Array<number> = [];
	#stringConstants: ReadonlyArray<ReadonlyArray<number>> = [];
	#bigintConstants: ReadonlyArray<bigint> = [];
	#literalTemplateData: ReadonlyArray<number> = [];
	#sourcePositions: ReadonlyArray<CoreSourcePosition> = [];
	#globalCount = 0;
	readonly #constructionStatistics = {
		virtualPhisCreated: 0,
		virtualPhisCollapsed: 0,
		materializedBlockParameters: 0,
		edgeArgumentsEmitted: 0,
		definitionSnapshotEntriesCopied: 0,
		aliasResolutions: 0,
		maximumUnresolvedPhiDepth: 0,
	};
	#sealed = false;

	constructor(registry: CoreOpcodeRegistry, data: CoreProgramDataTables = {}) {
		this.registry = registry;
		this.#setData(data);
	}

	get sealed(): boolean {
		return this.#sealed;
	}

	get generation(): number {
		return this.#generation;
	}

	get versions(): CoreProgramVersions {
		return { ...this.#versions };
	}

	programVersion(domain: CoreProgramChangeDomain): number {
		return this.#versions[domain];
	}

	functionVersion(domain: CoreChangeDomain): number {
		return this.#functionVersions[domain];
	}

	get programFlowRevision(): number {
		return this.#programFlowFunctions.length;
	}

	programFlowFunctionAt(revision: number): CoreFunctionId {
		const functionId = this.#programFlowFunctions[revision];
		if (functionId === undefined)
			throw new Error(`Unknown Core program-flow revision ${revision}`);
		return coreFunctionId(functionId);
	}

	programFlowDomainMaskAt(revision: number): CoreProgramFlowDomainMask {
		const domains = this.#programFlowDomainMasks[revision];
		if (domains === undefined)
			throw new Error(`Unknown Core program-flow revision ${revision}`);
		return domains;
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

	get constructionStatistics(): CoreConstructionStatistics {
		return Object.freeze({ ...this.#constructionStatistics });
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

	_recordConstructionStatistics(statistics: CoreConstructionStatistics): void {
		if (this.#sealed) throw new Error("Core program is sealed");
		this.#constructionStatistics.virtualPhisCreated += statistics.virtualPhisCreated;
		this.#constructionStatistics.virtualPhisCollapsed += statistics.virtualPhisCollapsed;
		this.#constructionStatistics.materializedBlockParameters +=
			statistics.materializedBlockParameters;
		this.#constructionStatistics.edgeArgumentsEmitted += statistics.edgeArgumentsEmitted;
		this.#constructionStatistics.definitionSnapshotEntriesCopied +=
			statistics.definitionSnapshotEntriesCopied;
		this.#constructionStatistics.aliasResolutions += statistics.aliasResolutions;
		this.#constructionStatistics.maximumUnresolvedPhiDepth = Math.max(
			this.#constructionStatistics.maximumUnresolvedPhiDepth,
			statistics.maximumUnresolvedPhiDepth,
		);
	}

	finalizeConstructionGeneration(): boolean {
		if (this.#generation === 1) return false;
		if (this.#sealed) {
			throw new Error("Cannot finalize a sealed Core program construction generation");
		}
		const generation = 1;
		for (let id = 0; id < this.#functions.length; id++) {
			const fn = this.#functions[id];
			if (fn !== undefined) {
				const dense = fn._denseConstructionGenerationCopy(
					CORE_STORE_MUTATION,
					generation,
				);
				fn._retireConstructionGeneration(CORE_STORE_MUTATION);
				this.#functions[id] = dense;
			}
		}
		this.#programFlowFunctions.length = 0;
		this.#programFlowDomainMasks.length = 0;
		for (const domain of FUNCTION_DOMAINS) this.#functionVersions[domain]++;
		for (const domain of PROGRAM_DOMAINS) this.#versions[domain]++;
		this.#generation = generation;
		return true;
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

	_appendLiteralConstant(
		mutation: CoreStoreMutation,
		data: ReadonlyArray<number>,
	): { templateOffset: number; cacheSlot: number } {
		this.#requireMutation(mutation);
		if (this.#sealed) throw new Error("Core program is sealed");
		const templateOffset = this.#literalTemplateData.length;
		this.#literalTemplateData = Object.freeze([...this.#literalTemplateData, ...data]);
		return { templateOffset, cacheSlot: this.#globalCount++ };
	}

	_appendStringConstants(
		mutation: CoreStoreMutation,
		values: ReadonlyArray<ReadonlyArray<number>>,
	): number {
		this.#requireMutation(mutation);
		if (this.#sealed) throw new Error("Core program is sealed");
		const start = this.#stringConstants.length;
		this.#stringConstants = Object.freeze([
			...this.#stringConstants,
			...values.map((units) => Object.freeze([...units])),
		]);
		return start;
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

	_recordFunctionChange(
		mutation: CoreStoreMutation,
		functionId: CoreFunctionId,
		domains: ReadonlySet<CoreChangeDomain>,
	): void {
		this.#requireMutation(mutation);
		if (domains.size === 0) return;
		let mask = 0;
		for (const domain of domains) {
			this.#functionVersions[domain]++;
			mask |= programFlowDomainBit(domain);
		}
		this.#programFlowFunctions.push(functionId);
		this.#programFlowDomainMasks.push(mask);
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
