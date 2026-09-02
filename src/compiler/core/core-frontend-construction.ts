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
	CoreInstructionAttributes,
	CoreTerminatorInput,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreProgram } from "./core-store.ts";

export interface CoreConstructionBlock {
	emitter: CoreInstructionEmitter;
}

export interface CoreInstructionEmitter {
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

interface ConstructionState {
	readonly core: CoreBlockId;
	readonly isEntry: boolean;
	readonly definitions: Map<number, CoreValueId>;
	readonly entryValues: Map<number, CoreValueId>;
	readonly parameterVariables: Array<number>;
	terminator?: TerminatorDraft;
	handler?: HandlerDraft;
	exceptionValue?: CoreValueId;
}

interface ValueEnvironment {
	readonly state: ConstructionState;
	readonly definitions: ReadonlyMap<number, CoreValueId>;
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
			readonly kind: "jump";
			readonly target: TargetReference;
			readonly environment: ValueEnvironment;
			readonly sourcePosition?: number;
	  }
	| {
			readonly kind: "branch";
			readonly condition: CoreValueId;
			readonly consequent: TargetReference;
			readonly alternate: TargetReference;
			readonly environment: ValueEnvironment;
			readonly sourcePosition?: number;
	  }
	| {
			readonly kind: "return" | "throw";
			readonly value: CoreValueId;
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
	readonly condition: CoreValueId;
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
	return { state, definitions: new Map(state.definitions) };
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
	readonly #activeHandlers: Array<Extract<CompilerInstruction, { type: "tryBegin" }>> =
		[];
	readonly #prelude: ConstructionState;
	readonly #entry: CoreBlockId;
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

		this.#propagateEntryVariables();
		this.#materializeControlFlow();
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
		};
	}

	#createState(core: CoreBlockId, isEntry: boolean): ConstructionState {
		const state: ConstructionState = {
			core,
			isEntry,
			definitions: new Map(),
			entryValues: new Map(),
			parameterVariables: [],
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
		const inputs: Array<CoreValueId> = [];
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
		const outputs = this.#builder.appendInstruction(
			state.core,
			instruction.type,
			inputs,
			{
				outputCount: destinations.length,
				attributes: instructionAttributes(instruction, expandedImmediates),
				...(this.#sourcePosition === undefined
					? {}
					: { sourcePosition: this.#sourcePosition }),
			},
		);
		for (const [index, variable] of destinations.entries()) {
			const output = outputs[index]!;
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

	#read(state: ConstructionState, variable: number): CoreValueId {
		return state.definitions.get(variable) ?? this.#readEntry(state, variable);
	}

	#readEntry(state: ConstructionState, variable: number): CoreValueId {
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
		const parameter = this.#builder.appendBlockParameter(state.core);
		state.entryValues.set(variable, parameter);
		state.parameterVariables.push(variable);
		return parameter;
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

	#resolveEnvironment(environment: ValueEnvironment, variable: number): CoreValueId {
		return (
			environment.definitions.get(variable) ??
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
			if (state.handler !== undefined) {
				const target = this.#resolveTarget(state.handler.target);
				this.#ensureExceptionParameter(target);
				edges.push({ target, environment: state.handler.environment });
			}
		}
		return edges;
	}

	#propagateEntryVariables(): void {
		const incoming = new Map<ConstructionState, Array<ValueEnvironment>>();
		for (const edge of this.#allEdgeDrafts()) {
			const environments = incoming.get(edge.target) ?? [];
			environments.push(edge.environment);
			incoming.set(edge.target, environments);
		}
		const queue: Array<ConstructionState> = [];
		const queued = new Set<ConstructionState>();
		const processedVariables = new Map<ConstructionState, number>();
		const enqueue = (state: ConstructionState): void => {
			if (queued.has(state)) return;
			queued.add(state);
			queue.push(state);
		};
		for (const state of this.#states) {
			if (state.parameterVariables.length > 0) enqueue(state);
		}
		for (let index = 0; index < queue.length; index++) {
			const target = queue[index]!;
			queued.delete(target);
			const processed = processedVariables.get(target) ?? 0;
			const variables = target.parameterVariables.slice(processed);
			processedVariables.set(target, target.parameterVariables.length);
			for (const environment of incoming.get(target) ?? []) {
				for (const variable of variables) {
					const source = environment.state;
					const before = source.parameterVariables.length;
					this.#resolveEnvironment(environment, variable);
					if (source.parameterVariables.length !== before) enqueue(source);
				}
			}
		}
	}

	#materializeControlFlow(): void {
		const edge = (
			reference: TargetReference,
			environment: ValueEnvironment,
		): CoreEdge => {
			const target = this.#resolveTarget(reference);
			const result: CoreEdge = {
				block: target.core,
				arguments: target.parameterVariables.map((variable) =>
					this.#resolveEnvironment(environment, variable),
				),
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
				case "branch":
					terminator = {
						kind: "branch",
						condition: draft.condition,
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
						value: draft.value,
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
