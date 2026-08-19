import { builtinOperationDescriptor } from "./builtin-registry.ts";
import {
	compilerFactIsWorldInvariant,
	knownBuiltinCallProves,
} from "./compiler-facts.ts";
import type {
	CompilerImmediateValue,
	CompilerInstruction,
} from "./compiler-instruction.ts";
import { coreOpcode, coreOpcodeRegistry, isCoreOpcode } from "./core-ir-opcodes.ts";
import { CoreFunctionBuilder, coreBlockId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreEdge,
	CoreFunction,
	CoreFunctionMetadata,
	CoreInstructionAttributes,
	CoreTerminatorInput,
	CoreValueId,
} from "./core-ir.ts";
import type { SemanticFile } from "./semantic-analysis.ts";

type ValueRepresentation = "boxed" | "f64" | "boolean";

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

type RepresentationRule =
	| {
			readonly kind: "fixed";
			readonly output: CoreValueId;
			readonly value: ValueRepresentation;
	  }
	| { readonly kind: "copy"; readonly output: CoreValueId; readonly input: CoreValueId }
	| {
			readonly kind: "join";
			readonly output: CoreValueId;
			readonly inputs: Array<CoreValueId>;
	  }
	| {
			readonly kind: "number-inputs";
			readonly output: CoreValueId;
			readonly inputs: ReadonlyArray<CoreValueId>;
	  };

interface PendingConditional {
	readonly instruction: Extract<CompilerInstruction, { type: "jumpIf" }>;
	readonly state: ConstructionState;
	readonly condition: CoreValueId;
	readonly sourcePosition?: number;
}

const COMPARE_OPERATORS = new Set(["<", "<=", ">", ">=", "===", "==", "!==", "!="]);
const NUMBER_FROM_NUMBERS = new Set([
	"+",
	"-",
	"*",
	"/",
	"&",
	"|",
	"^",
	"<<",
	">>",
	">>>",
	"%",
]);

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

function fixedRepresentation(
	instruction: CompilerInstruction,
	outputIndex: number,
): ValueRepresentation | undefined {
	if (instruction.type === "createNumber" || instruction.type === "createF64")
		return "f64";
	if (instruction.type === "mathUnaryNumber" || instruction.type === "mathBinaryNumber") {
		return "f64";
	}
	if (
		outputIndex === 0 &&
		(instruction.type === "createBoolean" ||
			instruction.type === "guardFunctionIndex" ||
			instruction.type === "hasPrivate" ||
			instruction.type === "isEmpty" ||
			instruction.type === "typeofCompare")
	) {
		return "boolean";
	}
	if (instruction.type === "binary" && COMPARE_OPERATORS.has(instruction.operator)) {
		return "boolean";
	}
	if (instruction.type === "unary" && instruction.operator === "!") return "boolean";
	return undefined;
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
	readonly #representationRules: Array<RepresentationRule> = [];
	readonly #activeHandlers: Array<Extract<CompilerInstruction, { type: "tryBegin" }>> =
		[];
	readonly #prelude: ConstructionState;
	readonly #entry: CoreBlockId;
	#sourcePosition: number | undefined;

	constructor(fn: CoreConstructionFunction) {
		this.#fn = fn;
		this.#builder = new CoreFunctionBuilder(fn.functionIndex, coreOpcodeRegistry, {
			isGenerator: fn.isGenerator === true,
			isAsync: fn.isAsync === true,
			parameterCount: fn.parameterCount,
		});
		this.#entry = this.#builder.createBlock(
			Array.from({ length: fn.parameterCount }, () => ({
				representation: "boxed" as const,
			})),
		);
		this.#prelude = this.#createState(this.#entry, true);
		for (const [index, parameter] of this.#builder
			.block(this.#entry)
			.parameters.entries()) {
			this.#prelude.entryValues.set(index, parameter.value);
			this.#prelude.definitions.set(index, parameter.value);
			this.#representationRules.push({
				kind: "fixed",
				output: parameter.value,
				value: "boxed",
			});
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

	finish(): CoreFunction {
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
		this.#solveRepresentations();
		this.#builder.configureFunction({
			isGenerator: this.#fn.isGenerator === true,
			isAsync: this.#fn.isAsync === true,
			parameterCount: this.#fn.parameterCount,
			metadata: this.#metadata(),
		});
		const finished = this.#builder.finish(this.#entry);
		const bodyEntry = this.#fn.bodyEntryBlock;
		return bodyEntry === undefined
			? finished
			: { ...finished, bodyEntry: coreBlockId(this.#blocks[bodyEntry]!.entry.core) };
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
		if (!active || this.#builder.block(emitter.tail.core).instructions.length === 0) {
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
			this.#addRepresentationRule(instruction, index, output, inputs);
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
		this.#representationRules.push({
			kind: "fixed",
			output: output!,
			value:
				value.kind === "number" ? "f64" : value.kind === "boolean" ? "boolean" : "boxed",
		});
		return output!;
	}

	#addRepresentationRule(
		instruction: CompilerInstruction,
		outputIndex: number,
		output: CoreValueId,
		inputs: ReadonlyArray<CoreValueId>,
	): void {
		const fixed = fixedRepresentation(instruction, outputIndex);
		if (fixed !== undefined) {
			this.#representationRules.push({ kind: "fixed", output, value: fixed });
			return;
		}
		if (outputIndex !== 0) {
			this.#representationRules.push({ kind: "fixed", output, value: "boxed" });
			return;
		}
		if (instruction.type === "move") {
			this.#representationRules.push({ kind: "copy", output, input: inputs[0]! });
			return;
		}
		if (instruction.type === "binary" && NUMBER_FROM_NUMBERS.has(instruction.operator)) {
			this.#representationRules.push({ kind: "number-inputs", output, inputs });
			return;
		}
		if (
			instruction.type === "unary" &&
			["-", "+", "~", "tonumeric", "increment", "decrement"].includes(
				instruction.operator,
			)
		) {
			this.#representationRules.push({ kind: "number-inputs", output, inputs });
			return;
		}
		if (instruction.type === "call") {
			const call = instruction.knownBuiltinCall;
			const descriptor =
				call === undefined ? undefined : builtinOperationDescriptor(call.operation);
			const argumentCount = instruction.registers.length - 3;
			if (
				call !== undefined &&
				descriptor?.nativeNumberArity === argumentCount &&
				knownBuiltinCallProves(call, call.operation) &&
				compilerFactIsWorldInvariant(call.identity)
			) {
				this.#representationRules.push({
					kind: "number-inputs",
					output,
					inputs: inputs.slice(2),
				});
				return;
			}
		}
		this.#representationRules.push({ kind: "fixed", output, value: "boxed" });
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
			this.#representationRules.push({
				kind: "fixed",
				output: undefinedValue!,
				value: "boxed",
			});
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
		this.#representationRules.push({
			kind: "fixed",
			output: exception,
			value: "boxed",
		});
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
		let changed = true;
		while (changed) {
			changed = false;
			for (const { target, environment } of this.#allEdgeDrafts()) {
				for (const variable of target.parameterVariables) {
					const before = environment.state.parameterVariables.length;
					this.#resolveEnvironment(environment, variable);
					if (environment.state.parameterVariables.length !== before) changed = true;
				}
			}
		}
	}

	#materializeControlFlow(): void {
		const joinRules = new Map<
			CoreValueId,
			Extract<RepresentationRule, { kind: "join" }>
		>();
		const addEdgeRules = (target: ConstructionState, edge: CoreEdge): void => {
			for (const [index, variable] of target.parameterVariables.entries()) {
				const output = target.entryValues.get(variable)!;
				let rule = joinRules.get(output);
				if (rule === undefined) {
					rule = { kind: "join", output, inputs: [] };
					joinRules.set(output, rule);
					this.#representationRules.push(rule);
				}
				rule.inputs.push(edge.arguments[index]!);
			}
		};
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
			addEdgeRules(target, result);
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

	#solveRepresentations(): void {
		const values = new Map<CoreValueId, ValueRepresentation | null>();
		for (const rule of this.#representationRules) values.set(rule.output, null);
		const candidate = (rule: RepresentationRule): ValueRepresentation | null => {
			switch (rule.kind) {
				case "fixed":
					return rule.value;
				case "copy":
					return values.get(rule.input) ?? null;
				case "number-inputs": {
					const inputs = rule.inputs.map((input) => values.get(input) ?? null);
					if (inputs.length === 0) return "f64";
					if (inputs.some((value) => value === "boxed" || value === "boolean")) {
						return "boxed";
					}
					return inputs.some((value) => value === "f64") ? "f64" : null;
				}
				case "join": {
					const known = rule.inputs
						.map((input) => values.get(input) ?? null)
						.filter((value): value is ValueRepresentation => value !== null);
					if (known.includes("boxed")) return "boxed";
					const typed = new Set(known);
					return typed.size > 1 ? "boxed" : (known[0] ?? null);
				}
			}
		};
		const converge = (): boolean => {
			let changed = false;
			for (const rule of this.#representationRules) {
				const next = candidate(rule);
				if (next === null) continue;
				const current = values.get(rule.output) ?? null;
				const joined =
					current === null ? next : current === next ? current : ("boxed" as const);
				if (joined !== current) {
					values.set(rule.output, joined);
					changed = true;
				}
			}
			return changed;
		};
		while (converge()) {
			// Fixed point over cyclic block parameters and number constraints.
		}
		for (const [value, representation] of values) {
			if (representation === null) values.set(value, "boxed");
		}
		while (converge()) {
			// Unknown cycles collapse to boxed and may force their dependents boxed.
		}
		for (const [value, representation] of values) {
			this.#builder.setValueRepresentation(value, representation ?? "boxed");
		}
	}
}

const constructions = new WeakMap<object, DirectCoreFunctionConstruction>();

export function initializeDirectCoreFunction(fn: CoreConstructionFunction): void {
	if (constructions.has(fn))
		throw new Error("Core function construction already initialized");
	constructions.set(fn, new DirectCoreFunctionConstruction(fn));
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

export function finishDirectCoreFunction(fn: CoreConstructionFunction): CoreFunction {
	const construction = constructions.get(fn);
	if (construction === undefined)
		throw new Error("Core function construction is not initialized");
	constructions.delete(fn);
	return construction.finish();
}
