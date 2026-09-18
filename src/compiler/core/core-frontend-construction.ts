import type { SemanticFile } from "../frontend/semantic-analysis.ts";
import type {
	CompilerImmediateValue,
	CompilerInstruction,
} from "../shared/compiler-instruction.ts";
import { CoreFunctionBuilder } from "./core-builder.ts";
import { coreOpcode, isCoreOpcode } from "./core-ir-opcodes.ts";
import { coreBlockId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreEdge,
	CoreFunctionId,
	CoreFunctionMetadata,
	CoreInstructionId,
	CoreInstructionAttributes,
	CoreImmediate,
	CoreTerminatorInput,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreProgram } from "./core-store.ts";

export interface CoreConstructionBlock {
	emitter: CoreInstructionEmitter;
}

interface LiteralSwitchInput {
	readonly selector: number;
	readonly cases: ReadonlyArray<{
		readonly value: CoreImmediate;
		readonly block: number;
	}>;
	readonly defaultTarget: Extract<CompilerInstruction, { type: "jump" }>;
}

export interface CoreInstructionEmitter {
	emitLiteralSwitch(input: LiteralSwitchInput): void;
	emit(...instructions: Array<CompilerInstruction>): void;
	last(): CompilerInstruction | undefined;
}

export interface CoreConstructionFunction {
	readonly semanticFile: SemanticFile;
	readonly functionIndex: number;
	readonly nameStringIndex: number;
	blocks: Array<CoreConstructionBlock>;
	readonly parameterCount: number;
	readonly length: number;
	readonly nextCapturedIndex: number;
	readonly mappedArguments?: boolean;
	readonly mappedArgumentSlots?: Array<number>;
	readonly strict?: boolean;
	readonly hasPrototype?: boolean;
	readonly isGenerator?: boolean;
	readonly isAsync?: boolean;
	readonly bodyEntryBlock?: number;
	readonly completionRegister?: number;
	readonly classContext?: {
		readonly isConstructor?: boolean;
		readonly isDerivedConstructor?: boolean;
	};
}

type VirtualPhiId = number & { readonly __virtualPhiId: unique symbol };
type ConstructionValue = CoreValueId | VirtualPhiId;

class DefinitionTable {
	readonly #latest = new Map<number, number>();
	readonly #versions: Array<number> = [];
	readonly #values: Array<ConstructionValue> = [];
	readonly #previous: Array<number> = [];
	#version = 0;

	get version(): number {
		return this.#version;
	}

	get(variable: number, version = this.#version): ConstructionValue | undefined {
		let revision = this.#latest.get(variable) ?? -1;
		while (revision >= 0 && this.#versions[revision]! > version) {
			revision = this.#previous[revision]!;
		}
		return revision < 0 ? undefined : this.#values[revision];
	}

	set(variable: number, value: ConstructionValue): void {
		this.#version++;
		const revision = this.#values.length;
		this.#versions.push(this.#version);
		this.#values.push(value);
		this.#previous.push(this.#latest.get(variable) ?? -1);
		this.#latest.set(variable, revision);
	}
}

interface ConstructionState {
	readonly core: CoreBlockId;
	readonly isEntry: boolean;
	readonly definitions: DefinitionTable;
	readonly entryValues: Map<number, ConstructionValue>;
	readonly materializedPhis: Array<VirtualPhiId>;
	terminator?: TerminatorDraft;
	handler?: HandlerDraft;
	exceptionValue?: CoreValueId;
}

interface ValueEnvironment {
	readonly state: ConstructionState;
	readonly version: number;
}

interface VirtualPhi {
	readonly state: ConstructionState;
	readonly variable: number;
}

interface DeferredOperands {
	readonly instruction: CoreInstructionId;
	readonly inputs: ReadonlyArray<ConstructionValue>;
}

type TargetReference =
	| { readonly kind: "state"; readonly state: ConstructionState }
	| {
			readonly kind: "instruction";
			readonly instruction: Extract<CompilerInstruction, { blocks: Array<number> }>;
			readonly slot: number;
	  }
	| { readonly kind: "fallthrough"; readonly block: number };

type TerminatorDraft =
	| {
			readonly kind: "switch";
			readonly selector: ConstructionValue;
			readonly cases: ReadonlyArray<{
				readonly value: CoreImmediate;
				readonly target: TargetReference;
			}>;
			readonly defaultTarget: TargetReference;
			readonly environment: ValueEnvironment;
			readonly sourcePosition?: number;
	  }
	| {
			readonly kind: "jump";
			readonly target: TargetReference;
			readonly environment: ValueEnvironment;
			readonly sourcePosition?: number;
	  }
	| {
			readonly kind: "branch";
			readonly condition: ConstructionValue;
			readonly consequent: TargetReference;
			readonly alternate: TargetReference;
			readonly environment: ValueEnvironment;
			readonly sourcePosition?: number;
	  }
	| {
			readonly kind: "return" | "throw";
			readonly value: ConstructionValue;
			readonly sourcePosition?: number;
	  }
	| { readonly kind: "unreachable" };

interface HandlerDraft {
	readonly target: TargetReference;
	readonly environment: ValueEnvironment;
}

interface PendingConditional {
	readonly instruction: Extract<CompilerInstruction, { type: "jumpIf" }>;
	readonly state: ConstructionState;
	readonly condition: ConstructionValue;
	readonly sourcePosition?: number;
}

function destinationCount(instruction: CompilerInstruction): number {
	if (!("registers" in instruction)) return 0;
	if (isCoreOpcode(instruction.type)) return coreOpcode(instruction.type).outputs.minimum;
	if (instruction.type === "catch") return 1;
	if (
		instruction.type === "jumpIf" ||
		instruction.type === "return" ||
		instruction.type === "throw"
	) {
		return 0;
	}
	throw new Error(`Unknown Core construction instruction ${String(instruction.type)}`);
}

function definedVariables(instruction: CompilerInstruction): Array<number> {
	if (!("registers" in instruction)) return [];
	return instruction.registers
		.slice(0, destinationCount(instruction))
		.filter((register) => register >= 0);
}

function cloneCoreAttribute(
	value: unknown,
	path: string,
	ancestors: ReadonlySet<object> = new Set(),
): unknown {
	if (
		value === undefined ||
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string"
	) {
		return value;
	}
	if (typeof value !== "object") {
		throw new Error(`Unsupported Core attribute ${path}: ${typeof value}`);
	}
	if (ancestors.has(value)) throw new Error(`Cyclic Core attribute ${path}`);
	const nextAncestors = new Set(ancestors).add(value);
	if (Array.isArray(value)) {
		return Array.from(value as ReadonlyArray<unknown>, (entry, index) =>
			cloneCoreAttribute(entry, `${path}[${index}]`, nextAncestors),
		);
	}
	const prototype = Object.getPrototypeOf(value) as unknown;
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(`Unsupported Core attribute object ${path}`);
	}
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		result[key] = cloneCoreAttribute(entry, `${path}.${key}`, nextAncestors);
	}
	return result;
}

function instructionAttributes(
	instruction: CompilerInstruction,
	expandImmediateOperands: boolean,
): CoreInstructionAttributes {
	const attributes: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(instruction)) {
		if (
			key !== "type" &&
			key !== "registers" &&
			key !== "blocks" &&
			!(expandImmediateOperands && key === "immediateValues")
		) {
			attributes[key] = cloneCoreAttribute(value, `${instruction.type}.${key}`);
		}
	}
	return attributes as CoreInstructionAttributes;
}

function immediateOperand(
	instruction: CompilerInstruction,
	position: number,
): CompilerImmediateValue | undefined {
	return instruction.type === "call" || instruction.type === "construct"
		? instruction.immediateValues?.[position]
		: undefined;
}

function valueEnvironment(state: ConstructionState): ValueEnvironment {
	return { state, version: state.definitions.version };
}

function virtualPhiId(index: number): VirtualPhiId {
	return (-index - 1) as VirtualPhiId;
}

function virtualPhiIndex(value: VirtualPhiId): number {
	return -(value as number) - 1;
}

function isVirtualPhi(value: ConstructionValue): value is VirtualPhiId {
	return value < 0;
}

function localVariable(index: number): number {
	return -1_000_000_000 - index;
}

class BlockEmitter implements CoreInstructionEmitter {
	#last: CompilerInstruction | undefined;
	#pendingConditional: PendingConditional | undefined;
	readonly #construction: DirectCoreFunctionConstruction;
	readonly #logicalBlock: number;
	readonly #entry: ConstructionState;
	#tail: ConstructionState;

	constructor(
		construction: DirectCoreFunctionConstruction,
		logicalBlock: number,
		entry: ConstructionState,
	) {
		this.#construction = construction;
		this.#logicalBlock = logicalBlock;
		this.#entry = entry;
		this.#tail = entry;
	}

	emit(...instructions: Array<CompilerInstruction>): void {
		for (const instruction of instructions) {
			this.#construction.emit(this, instruction);
			this.#last = instruction;
		}
	}

	emitLiteralSwitch(input: LiteralSwitchInput): void {
		this.#construction.emitLiteralSwitch(this, input);
		this.#last = input.defaultTarget;
	}

	last(): CompilerInstruction | undefined {
		return this.#last;
	}

	get logicalBlock(): number {
		return this.#logicalBlock;
	}

	get tail(): ConstructionState {
		return this.#tail;
	}

	get entry(): ConstructionState {
		return this.#entry;
	}

	set tail(state: ConstructionState) {
		this.#tail = state;
	}

	get pendingConditional(): PendingConditional | undefined {
		return this.#pendingConditional;
	}

	set pendingConditional(value: PendingConditional | undefined) {
		this.#pendingConditional = value;
	}
}

class ConstructionBlockList extends Array<CoreConstructionBlock> {
	readonly #construction: DirectCoreFunctionConstruction;

	constructor(construction: DirectCoreFunctionConstruction) {
		super();
		this.#construction = construction;
	}

	override push(...blocks: Array<CoreConstructionBlock>): number {
		for (const block of blocks) {
			const logicalBlock = this.length;
			super.push(block);
			this.#construction.bindBlock(block, logicalBlock);
		}
		return this.length;
	}
}

export class DirectCoreFunctionConstruction {
	readonly #fn: CoreConstructionFunction;
	readonly #builder: CoreFunctionBuilder;
	readonly #states: Array<ConstructionState> = [];
	readonly #blocks: Array<BlockEmitter> = [];
	readonly #virtualPhis: Array<VirtualPhi> = [];
	readonly #phiAliases: Array<ConstructionValue | undefined> = [];
	readonly #deferredOperands: Array<DeferredOperands> = [];
	readonly #activeHandlers: Array<Extract<CompilerInstruction, { type: "tryBegin" }>> =
		[];
	readonly #prelude: ConstructionState;
	readonly #entry: CoreBlockId;
	#placeholderValue: CoreValueId | undefined;
	#virtualPhisCollapsed = 0;
	#materializedBlockParameters = 0;
	#edgeArgumentsEmitted = 0;
	#aliasResolutions = 0;
	#maximumUnresolvedPhiDepth = 0;
	#sourcePosition: number | undefined;

	constructor(program: CoreProgram, fn: CoreConstructionFunction) {
		this.#fn = fn;
		this.#builder = new CoreFunctionBuilder(program, {
			isGenerator: fn.isGenerator === true,
			isAsync: fn.isAsync === true,
			parameterCount: fn.parameterCount,
		});
		if (this.#builder.functionId !== fn.functionIndex) {
			throw new Error(
				`Core function id ${this.#builder.functionId} does not match semantic function ${fn.functionIndex}`,
			);
		}
		this.#entry = this.#builder.createBlock(
			Array.from({ length: fn.parameterCount }, () => ({
				representation: "boxed" as const,
			})),
		);
		this.#prelude = this.#createState(this.#entry, true);
		for (let index = 0; index < fn.parameterCount; index++) {
			const parameter = this.#builder.blockParameterValue(this.#entry, index);
			this.#prelude.entryValues.set(index, parameter);
			this.#prelude.definitions.set(index, parameter);
		}
		// Async generators use GENERATOR_START at their body entry. ASYNC_START is
		// exclusively the promise-producing prologue for ordinary async functions;
		// emitting both would make an async generator adopt the same frame twice.
		if (fn.isAsync === true && fn.isGenerator !== true) {
			this.#emitInstruction(this.#prelude, { type: "asyncStart" });
		}
		fn.blocks = new ConstructionBlockList(this);
	}

	bindBlock(block: CoreConstructionBlock, logicalBlock: number): void {
		const entry = this.#createState(this.#builder.createBlock(), false);
		const emitter = new BlockEmitter(this, logicalBlock, entry);
		this.#blocks.push(emitter);
		block.emitter = emitter;
		if (logicalBlock === 0 && this.#fn.completionRegister !== undefined) {
			this.#emitInstruction(this.#prelude, {
				type: "createUndefined",
				registers: [this.#fn.completionRegister],
			});
		}
		if (this.#fn.isGenerator === true && logicalBlock === this.#fn.bodyEntryBlock) {
			emitter.emit({ type: "generatorStart" });
		}
	}

	emitEntryInstructions(...instructions: Array<CompilerInstruction>): void {
		const sourcePosition = this.#sourcePosition;
		this.#sourcePosition = undefined;
		try {
			for (const instruction of instructions) {
				this.#emitInstruction(this.#prelude, instruction);
			}
		} finally {
			this.#sourcePosition = sourcePosition;
		}
	}

	emitLiteralSwitch(emitter: BlockEmitter, input: LiteralSwitchInput): void {
		if (emitter.tail.terminator !== undefined && emitter.pendingConditional === undefined)
			return;
		if (emitter.pendingConditional !== undefined) this.#flushConditional(emitter);
		emitter.tail.terminator = {
			kind: "switch",
			selector: this.#read(emitter.tail, input.selector),
			cases: input.cases.map((label) => ({
				value: label.value,
				target: { kind: "fallthrough", block: label.block },
			})),
			defaultTarget: { kind: "instruction", instruction: input.defaultTarget, slot: 0 },
			environment: valueEnvironment(emitter.tail),
			...(this.#sourcePosition === undefined
				? {}
				: { sourcePosition: this.#sourcePosition }),
		};
	}

	emit(emitter: BlockEmitter, instruction: CompilerInstruction): void {
		if (emitter.tail.terminator !== undefined && emitter.pendingConditional === undefined)
			return;
		if (emitter.pendingConditional !== undefined && instruction.type !== "jump") {
			this.#flushConditional(emitter);
		}
		if (instruction.type === "sourcePos") {
			this.#sourcePosition = instruction.pos;
			return;
		}
		if (instruction.type === "tryBegin") {
			this.#activeHandlers.push(instruction);
			return;
		}
		if (instruction.type === "tryEnd") {
			if (this.#activeHandlers.pop() === undefined) {
				throw new Error("Unbalanced tryEnd during Core construction");
			}
			return;
		}
		if (instruction.type === "catch") {
			const exception = this.#ensureExceptionParameter(emitter.tail);
			emitter.tail.definitions.set(instruction.registers[0], exception);
			return;
		}
		if (instruction.type === "loadLocal") {
			emitter.tail.definitions.set(
				instruction.registers[0],
				this.#read(emitter.tail, localVariable(instruction.index)),
			);
			return;
		}
		if (instruction.type === "storeLocal") {
			emitter.tail.definitions.set(
				localVariable(instruction.index),
				this.#read(emitter.tail, instruction.registers[0]),
			);
			return;
		}
		if (instruction.type === "jumpIf") {
			const condition = this.#read(emitter.tail, instruction.registers[0]);
			emitter.pendingConditional = {
				instruction,
				state: emitter.tail,
				condition,
				...(this.#sourcePosition === undefined
					? {}
					: { sourcePosition: this.#sourcePosition }),
			};
			return;
		}
		if (instruction.type === "jump") {
			const pending = emitter.pendingConditional;
			if (pending !== undefined) {
				pending.state.terminator = {
					kind: "branch",
					condition: pending.condition,
					consequent: { kind: "instruction", instruction: pending.instruction, slot: 0 },
					alternate: { kind: "instruction", instruction, slot: 0 },
					environment: valueEnvironment(pending.state),
					...(pending.sourcePosition === undefined
						? {}
						: { sourcePosition: pending.sourcePosition }),
				};
				emitter.pendingConditional = undefined;
				return;
			}
			emitter.tail.terminator = {
				kind: "jump",
				target: { kind: "instruction", instruction, slot: 0 },
				environment: valueEnvironment(emitter.tail),
				...(this.#sourcePosition === undefined
					? {}
					: { sourcePosition: this.#sourcePosition }),
			};
			return;
		}
		if (instruction.type === "return" || instruction.type === "throw") {
			const state = this.#isolateThrowingState(emitter, instruction.type === "throw");
			const environment = valueEnvironment(state);
			state.terminator = {
				kind: instruction.type,
				value: this.#read(state, instruction.registers[0]),
				...(this.#sourcePosition === undefined
					? {}
					: { sourcePosition: this.#sourcePosition }),
			};
			if (instruction.type === "throw") this.#attachHandler(state, environment);
			return;
		}
		this.#emitOrdinary(emitter, instruction);
	}

	finish(): CoreFunctionId {
		if (this.#activeHandlers.length !== 0) {
			throw new Error("Unbalanced tryBegin during Core construction");
		}
		for (const emitter of this.#blocks) {
			if (emitter.pendingConditional !== undefined) this.#flushConditional(emitter, true);
			if (emitter.tail.terminator === undefined) {
				const next = emitter.logicalBlock + 1;
				emitter.tail.terminator =
					next < this.#blocks.length
						? {
								kind: "jump",
								target: { kind: "fallthrough", block: next },
								environment: valueEnvironment(emitter.tail),
							}
						: { kind: "unreachable" };
			}
		}
		if (this.#blocks.length === 0) throw new Error("Core function has no body blocks");
		this.#prelude.terminator = {
			kind: "jump",
			target: { kind: "state", state: this.#blocks[0]!.entry },
			environment: valueEnvironment(this.#prelude),
		};

		this.#resolveVirtualPhis();
		this.#patchDeferredOperands();
		this.#materializeControlFlow();
		this.#builder.program._recordConstructionStatistics({
			virtualPhisCreated: this.#virtualPhis.length,
			virtualPhisCollapsed: this.#virtualPhisCollapsed,
			materializedBlockParameters: this.#materializedBlockParameters,
			edgeArgumentsEmitted: this.#edgeArgumentsEmitted,
			definitionSnapshotEntriesCopied: 0,
			aliasResolutions: this.#aliasResolutions,
			maximumUnresolvedPhiDepth: this.#maximumUnresolvedPhiDepth,
		});
		this.#builder.configureFunction({
			isGenerator: this.#fn.isGenerator === true,
			isAsync: this.#fn.isAsync === true,
			parameterCount: this.#fn.parameterCount,
			metadata: this.#metadata(),
		});
		const bodyEntry = this.#fn.bodyEntryBlock;
		return this.#builder.finish(
			this.#entry,
			bodyEntry === undefined
				? undefined
				: coreBlockId(this.#blocks[bodyEntry]!.entry.core),
		).function;
	}

	#metadata(): CoreFunctionMetadata {
		const isClassConstructor = this.#fn.classContext?.isConstructor ?? false;
		return {
			sourcePath: this.#fn.semanticFile.path,
			sourceStrict: this.#fn.semanticFile.strict,
			nameStringIndex: this.#fn.nameStringIndex,
			length: this.#fn.length,
			mappedArguments: this.#fn.mappedArguments ?? false,
			mappedArgumentSlots: [...(this.#fn.mappedArgumentSlots ?? [])],
			capturedCount: this.#fn.nextCapturedIndex,
			strict: this.#fn.strict ?? this.#fn.semanticFile.strict,
			isClassConstructor,
			isDerivedConstructor:
				isClassConstructor && (this.#fn.classContext?.isDerivedConstructor ?? false),
			hasPrototype: this.#fn.hasPrototype ?? true,
			lexicalThis: this.#fn.lexicalThis ?? false,
		};
	}

	#createState(core: CoreBlockId, isEntry: boolean): ConstructionState {
		const state: ConstructionState = {
			core,
			isEntry,
			definitions: new DefinitionTable(),
			entryValues: new Map(),
			materializedPhis: [],
		};
		this.#states.push(state);
		return state;
	}

	#newInternalState(): ConstructionState {
		return this.#createState(this.#builder.createBlock(), false);
	}

	#flushConditional(emitter: BlockEmitter, logicalFallthrough = false): void {
		const pending = emitter.pendingConditional;
		if (pending === undefined) return;
		const alternate = logicalFallthrough
			? ({ kind: "fallthrough", block: emitter.logicalBlock + 1 } as const)
			: ({ kind: "state", state: this.#newInternalState() } as const);
		pending.state.terminator = {
			kind: "branch",
			condition: pending.condition,
			consequent: { kind: "instruction", instruction: pending.instruction, slot: 0 },
			alternate,
			environment: valueEnvironment(pending.state),
			...(pending.sourcePosition === undefined
				? {}
				: { sourcePosition: pending.sourcePosition }),
		};
		if (alternate.kind === "state") emitter.tail = alternate.state;
		emitter.pendingConditional = undefined;
	}

	#emitOrdinary(emitter: BlockEmitter, instruction: CompilerInstruction): void {
		const mayThrow =
			isCoreOpcode(instruction.type) && coreOpcode(instruction.type).effects.mayThrow;
		let state = emitter.tail;
		if (mayThrow && this.#activeHandlers.length > 0) {
			state = this.#isolateThrowingState(emitter, true);
		}
		const environment = valueEnvironment(state);
		this.#emitInstruction(state, instruction);
		if (mayThrow && this.#activeHandlers.length > 0) {
			this.#attachHandler(state, environment);
			const continuation = this.#newInternalState();
			state.terminator = {
				kind: "jump",
				target: { kind: "state", state: continuation },
				environment: valueEnvironment(state),
			};
			emitter.tail = continuation;
		}
	}

	#isolateThrowingState(emitter: BlockEmitter, active: boolean): ConstructionState {
		if (!active || this.#builder.bodyInstructionIds(emitter.tail.core).length === 0) {
			return emitter.tail;
		}
		const isolated = this.#newInternalState();
		emitter.tail.terminator = {
			kind: "jump",
			target: { kind: "state", state: isolated },
			environment: valueEnvironment(emitter.tail),
		};
		emitter.tail = isolated;
		return isolated;
	}

	#attachHandler(state: ConstructionState, environment: ValueEnvironment): void {
		const active = this.#activeHandlers.at(-1);
		if (active === undefined) return;
		state.handler = {
			target: { kind: "instruction", instruction: active, slot: 0 },
			environment,
		};
	}

	#emitInstruction(state: ConstructionState, instruction: CompilerInstruction): void {
		if (!isCoreOpcode(instruction.type)) {
			throw new Error(`Cannot emit structural ${instruction.type} as a Core instruction`);
		}
		const destinations = definedVariables(instruction);
		const inputs: Array<ConstructionValue> = [];
		let expandedImmediates = false;
		if ("registers" in instruction) {
			for (
				let position = destinationCount(instruction);
				position < instruction.registers.length;
				position++
			) {
				const variable = instruction.registers[position]!;
				if (variable >= 0) {
					inputs.push(this.#read(state, variable));
					continue;
				}
				const immediate = immediateOperand(instruction, position);
				if (immediate === undefined) continue;
				inputs.push(this.#appendImmediate(state, immediate));
				expandedImmediates = true;
			}
		}
		const hasVirtualInputs = inputs.some(isVirtualPhi);
		const inserted = this.#builder.editor.appendInstruction(
			state.core,
			instruction.type,
			hasVirtualInputs
				? inputs.map((input) =>
						isVirtualPhi(input) ? this.#ensurePlaceholderValue() : input,
					)
				: (inputs as ReadonlyArray<CoreValueId>),
			{
				outputCount: destinations.length,
				attributes: instructionAttributes(instruction, expandedImmediates),
				...(this.#sourcePosition === undefined
					? {}
					: { sourcePosition: this.#sourcePosition }),
			},
		);
		if (hasVirtualInputs) {
			this.#deferredOperands.push({ instruction: inserted.instruction, inputs });
		}
		for (const [index, variable] of destinations.entries()) {
			const output = inserted.outputs[index]!;
			state.definitions.set(variable, output);
		}
	}

	#appendImmediate(state: ConstructionState, value: CompilerImmediateValue): CoreValueId {
		const specification = (() => {
			switch (value.kind) {
				case "undefined":
					return { opcode: "createUndefined", attributes: {} } as const;
				case "null":
					return { opcode: "createNull", attributes: {} } as const;
				case "boolean":
					return { opcode: "createBoolean", attributes: { value: value.value } } as const;
				case "number":
					return { opcode: "createNumber", attributes: { value: value.value } } as const;
				case "string":
					return {
						opcode: "createString",
						attributes: { stringIndex: value.index },
					} as const;
			}
		})();
		const [output] = this.#builder.appendInstruction(
			state.core,
			specification.opcode,
			[],
			{
				attributes: specification.attributes,
				...(this.#sourcePosition === undefined
					? {}
					: { sourcePosition: this.#sourcePosition }),
			},
		);
		return output!;
	}

	#ensurePlaceholderValue(): CoreValueId {
		if (this.#placeholderValue !== undefined) return this.#placeholderValue;
		const [value] = this.#builder.appendInstruction(
			this.#prelude.core,
			"createUndefined",
			[],
		);
		this.#placeholderValue = value!;
		return value!;
	}

	#read(state: ConstructionState, variable: number): ConstructionValue {
		return state.definitions.get(variable) ?? this.#readEntry(state, variable);
	}

	#readEntry(state: ConstructionState, variable: number): ConstructionValue {
		const existing = state.entryValues.get(variable);
		if (existing !== undefined) return existing;
		if (state.isEntry) {
			const [undefinedValue] = this.#builder.appendInstruction(
				state.core,
				"createUndefined",
				[],
			);
			state.entryValues.set(variable, undefinedValue!);
			state.definitions.set(variable, undefinedValue!);
			return undefinedValue!;
		}
		const phi = virtualPhiId(this.#virtualPhis.length);
		this.#virtualPhis.push({ state, variable });
		this.#phiAliases.push(undefined);
		state.entryValues.set(variable, phi);
		return phi;
	}

	#ensureExceptionParameter(state: ConstructionState): CoreValueId {
		if (state.exceptionValue !== undefined) return state.exceptionValue;
		const exception = this.#builder.prependBlockParameter(state.core, {
			role: "exception",
			representation: "boxed",
		});
		state.exceptionValue = exception;
		return exception;
	}

	#resolveTarget(reference: TargetReference): ConstructionState {
		switch (reference.kind) {
			case "state":
				return reference.state;
			case "fallthrough": {
				const emitter = this.#blocks[reference.block];
				if (emitter === undefined) {
					throw new Error(
						`Core fallthrough targets missing logical block ${reference.block}`,
					);
				}
				return this.#entryState(emitter);
			}
			case "instruction": {
				const logicalBlock = reference.instruction.blocks[reference.slot];
				if (logicalBlock === undefined || logicalBlock < 0) {
					throw new Error(`Unresolved Core construction block target ${logicalBlock}`);
				}
				const emitter = this.#blocks[logicalBlock];
				if (emitter === undefined) {
					throw new Error(`Unknown Core construction block ${logicalBlock}`);
				}
				return this.#entryState(emitter);
			}
		}
	}

	#entryState(emitter: BlockEmitter): ConstructionState {
		return emitter.entry;
	}

	#resolveEnvironment(
		environment: ValueEnvironment,
		variable: number,
	): ConstructionValue {
		return (
			environment.state.definitions.get(variable, environment.version) ??
			this.#readEntry(environment.state, variable)
		);
	}

	#allEdgeDrafts(): Array<{
		readonly target: ConstructionState;
		readonly environment: ValueEnvironment;
	}> {
		const edges: Array<{
			readonly target: ConstructionState;
			readonly environment: ValueEnvironment;
		}> = [];
		for (const state of this.#states) {
			const terminator = state.terminator;
			if (terminator?.kind === "jump") {
				edges.push({
					target: this.#resolveTarget(terminator.target),
					environment: terminator.environment,
				});
			} else if (terminator?.kind === "branch") {
				edges.push(
					{
						target: this.#resolveTarget(terminator.consequent),
						environment: terminator.environment,
					},
					{
						target: this.#resolveTarget(terminator.alternate),
						environment: terminator.environment,
					},
				);
			}
			if (terminator?.kind === "switch") {
				for (const target of [
					...terminator.cases.map((label) => label.target),
					terminator.defaultTarget,
				])
					edges.push({
						target: this.#resolveTarget(target),
						environment: terminator.environment,
					});
			}
			if (state.handler !== undefined) {
				const target = this.#resolveTarget(state.handler.target);
				this.#ensureExceptionParameter(target);
				edges.push({ target, environment: state.handler.environment });
			}
		}
		return edges;
	}

	#resolveVirtualPhis(): void {
		const incoming = new Map<ConstructionState, Array<ValueEnvironment>>();
		for (const edge of this.#allEdgeDrafts()) {
			const environments = incoming.get(edge.target) ?? [];
			environments.push(edge.environment);
			incoming.set(edge.target, environments);
		}
		const mutableIncomingStarts: Array<number> = [];
		const incomingValues: Array<ConstructionValue> = [];
		for (let index = 0; index < this.#virtualPhis.length; index++) {
			const phi = this.#virtualPhis[index]!;
			mutableIncomingStarts[index] = incomingValues.length;
			for (const environment of incoming.get(phi.state) ?? []) {
				incomingValues.push(this.#resolveEnvironment(environment, phi.variable));
			}
		}
		const count = this.#virtualPhis.length;
		mutableIncomingStarts[count] = incomingValues.length;
		const incomingStarts = Uint32Array.from(mutableIncomingStarts);

		const reverseStarts = new Uint32Array(count + 1);
		for (let index = 0; index < count; index++) {
			for (
				let position = incomingStarts[index]!;
				position < incomingStarts[index + 1]!;
				position++
			) {
				const value = incomingValues[position]!;
				if (isVirtualPhi(value)) reverseStarts[virtualPhiIndex(value) + 1]!++;
			}
		}
		for (let index = 1; index <= count; index++) {
			reverseStarts[index]! += reverseStarts[index - 1]!;
		}
		const reversePositions = reverseStarts.slice(0, count);
		const reverseEdges = new Uint32Array(reverseStarts[count]!);
		for (let index = 0; index < count; index++) {
			for (
				let position = incomingStarts[index]!;
				position < incomingStarts[index + 1]!;
				position++
			) {
				const value = incomingValues[position]!;
				if (!isVirtualPhi(value)) continue;
				const dependency = virtualPhiIndex(value);
				reverseEdges[reversePositions[dependency]!] = index;
				reversePositions[dependency]!++;
			}
		}

		const visited = new Uint8Array(count);
		const order = new Uint32Array(count);
		let orderLength = 0;
		for (let start = 0; start < count; start++) {
			if (visited[start] !== 0) continue;
			const nodes = [start];
			const positions = [incomingStarts[start]!];
			visited[start] = 1;
			while (nodes.length > 0) {
				const stackPosition = positions.length - 1;
				const node = nodes[stackPosition]!;
				let next = positions[stackPosition]!;
				const end = incomingStarts[node + 1]!;
				let descended = false;
				while (next < end) {
					const value = incomingValues[next++]!;
					positions[stackPosition] = next;
					if (!isVirtualPhi(value)) continue;
					const dependency = virtualPhiIndex(value);
					if (visited[dependency] !== 0) continue;
					visited[dependency] = 1;
					nodes.push(dependency);
					positions.push(incomingStarts[dependency]!);
					descended = true;
					break;
				}
				if (descended) continue;
				order[orderLength++] = node;
				nodes.pop();
				positions.pop();
			}
		}

		const componentByPhi = new Int32Array(count);
		componentByPhi.fill(-1);
		const nextMember = new Int32Array(count);
		nextMember.fill(-1);
		const componentHeads: Array<number> = [];
		for (let position = orderLength - 1; position >= 0; position--) {
			const start = order[position]!;
			if (componentByPhi[start] !== -1) continue;
			const component = componentHeads.length;
			let head = -1;
			const stack = [start];
			componentByPhi[start] = component;
			while (stack.length > 0) {
				const node = stack.pop()!;
				nextMember[node] = head;
				head = node;
				for (
					let reverse = reverseStarts[node]!;
					reverse < reverseStarts[node + 1]!;
					reverse++
				) {
					const predecessor = reverseEdges[reverse]!;
					if (componentByPhi[predecessor] !== -1) continue;
					componentByPhi[predecessor] = component;
					stack.push(predecessor);
				}
			}
			componentHeads.push(head);
		}

		for (let component = componentHeads.length - 1; component >= 0; component--) {
			this.#resolveVirtualPhiComponent(
				componentHeads[component]!,
				nextMember,
				componentByPhi,
				incomingStarts,
				incomingValues,
			);
		}
		this.#materializeVirtualPhis();
	}

	#resolveVirtualPhiComponent(
		head: number,
		nextMember: Int32Array,
		componentByPhi: Int32Array,
		incomingStarts: Uint32Array,
		incomingValues: ReadonlyArray<ConstructionValue>,
	): void {
		const component = componentByPhi[head]!;
		let replacement: ConstructionValue | undefined;
		let conflicting = false;
		let memberCount = 0;
		for (let member = head; member >= 0; member = nextMember[member]!) {
			memberCount++;
			for (
				let position = incomingStarts[member]!;
				position < incomingStarts[member + 1]!;
				position++
			) {
				const value = incomingValues[position]!;
				if (isVirtualPhi(value) && componentByPhi[virtualPhiIndex(value)] === component) {
					continue;
				}
				const concrete = this.#canonicalConstructionValue(value);
				if (replacement === undefined) replacement = concrete;
				else if (replacement !== concrete) conflicting = true;
			}
		}
		if (!conflicting) {
			this.#phiAliases[head] = replacement ?? this.#ensurePlaceholderValue();
			for (let member = nextMember[head]!; member >= 0; member = nextMember[member]!) {
				this.#phiAliases[member] = virtualPhiId(head);
			}
			this.#virtualPhisCollapsed += memberCount;
			return;
		}
		for (let member = head; member >= 0; member = nextMember[member]!) {
			const phi = this.#virtualPhis[member]!;
			this.#phiAliases[member] = virtualPhiId(member);
			phi.state.materializedPhis.push(virtualPhiId(member));
			this.#materializedBlockParameters++;
		}
	}

	#materializeVirtualPhis(): void {
		for (let stateIndex = 0; stateIndex < this.#states.length; stateIndex++) {
			const state = this.#states[stateIndex]!;
			if (state.materializedPhis.length === 0) continue;
			const parameters = this.#builder.appendBlockParameters(
				state.core,
				new Array(state.materializedPhis.length).fill({}),
			);
			for (let index = 0; index < parameters.length; index++) {
				this.#phiAliases[virtualPhiIndex(state.materializedPhis[index]!)] =
					parameters[index]!;
			}
		}
	}

	#canonicalConstructionValue(value: ConstructionValue): ConstructionValue {
		if (!isVirtualPhi(value)) return value;
		const path: Array<number> = [];
		while (isVirtualPhi(value)) {
			const index = virtualPhiIndex(value);
			const alias = this.#phiAliases[index];
			if (alias === undefined) throw new Error(`Unresolved virtual phi ${index}`);
			if (alias === value) break;
			path.push(index);
			value = alias;
		}
		this.#aliasResolutions += path.length;
		this.#maximumUnresolvedPhiDepth = Math.max(
			this.#maximumUnresolvedPhiDepth,
			path.length,
		);
		for (const index of path) this.#phiAliases[index] = value;
		return value;
	}

	#coreValue(value: ConstructionValue): CoreValueId {
		const resolved = this.#canonicalConstructionValue(value);
		if (isVirtualPhi(resolved)) {
			throw new Error(`Unmaterialized virtual phi ${virtualPhiIndex(resolved)}`);
		}
		return resolved;
	}

	#patchDeferredOperands(): void {
		for (const deferred of this.#deferredOperands) {
			this.#builder.editor.replaceOperands(
				deferred.instruction,
				deferred.inputs.map((input) => this.#coreValue(input)),
			);
		}
	}

	#materializeControlFlow(): void {
		const edge = (
			reference: TargetReference,
			environment: ValueEnvironment,
		): CoreEdge => {
			const target = this.#resolveTarget(reference);
			const arguments_ = target.materializedPhis.map((phi) => {
				const variable = this.#virtualPhis[virtualPhiIndex(phi)]!.variable;
				return this.#coreValue(this.#resolveEnvironment(environment, variable));
			});
			this.#edgeArgumentsEmitted += arguments_.length;
			const result: CoreEdge = {
				block: target.core,
				arguments: arguments_,
			};
			return result;
		};

		for (const state of this.#states) {
			if (state.handler !== undefined) {
				const target = this.#resolveTarget(state.handler.target);
				this.#ensureExceptionParameter(target);
				const handlerEdge = edge(state.handler.target, state.handler.environment);
				this.#builder.setHandler(state.core, target.core, handlerEdge.arguments);
			}
			const draft = state.terminator;
			if (draft === undefined)
				throw new Error(`Core construction block ${state.core} is open`);
			let terminator: CoreTerminatorInput;
			switch (draft.kind) {
				case "jump":
					terminator = {
						kind: "jump",
						edge: edge(draft.target, draft.environment),
						...(draft.sourcePosition === undefined
							? {}
							: { sourcePosition: draft.sourcePosition }),
					};
					break;
				case "switch":
					terminator = {
						kind: "switch",
						discriminant: this.#coreValue(draft.selector),
						cases: draft.cases.map((label) => ({
							value: label.value,
							edge: edge(label.target, draft.environment),
						})),
						default: edge(draft.defaultTarget, draft.environment),
						...(draft.sourcePosition === undefined
							? {}
							: { sourcePosition: draft.sourcePosition }),
					};
					break;
				case "branch":
					terminator = {
						kind: "branch",
						condition: this.#coreValue(draft.condition),
						consequent: edge(draft.consequent, draft.environment),
						alternate: edge(draft.alternate, draft.environment),
						...(draft.sourcePosition === undefined
							? {}
							: { sourcePosition: draft.sourcePosition }),
					};
					break;
				case "return":
				case "throw":
					terminator = {
						kind: draft.kind,
						value: this.#coreValue(draft.value),
						...(draft.sourcePosition === undefined
							? {}
							: { sourcePosition: draft.sourcePosition }),
					};
					break;
				case "unreachable":
					terminator = { kind: "unreachable" };
					break;
			}
			this.#builder.setTerminator(state.core, terminator);
		}
	}
}

const constructions = new WeakMap<object, DirectCoreFunctionConstruction>();

export function initializeDirectCoreFunction(
	program: CoreProgram,
	fn: CoreConstructionFunction,
): void {
	if (constructions.has(fn))
		throw new Error("Core function construction already initialized");
	constructions.set(fn, new DirectCoreFunctionConstruction(program, fn));
}

export function emitCoreEntryInstructions(
	fn: CoreConstructionFunction,
	...instructions: Array<CompilerInstruction>
): void {
	const construction = constructions.get(fn);
	if (construction === undefined)
		throw new Error("Core function construction is not initialized");
	construction.emitEntryInstructions(...instructions);
}

export function finishDirectCoreFunction(fn: CoreConstructionFunction): CoreFunctionId {
	const construction = constructions.get(fn);
	if (construction === undefined)
		throw new Error("Core function construction is not initialized");
	constructions.delete(fn);
	return construction.finish();
}
