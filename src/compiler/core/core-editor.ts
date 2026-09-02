import { coreBlockId, coreFactId } from "./core-ir.ts";
import type {
	AppendCoreInstructionOptions,
	CoreBlockId,
	CoreBlockParameterSpec,
	CoreEdge,
	CoreEffectRefinement,
	CoreFact,
	CoreFactId,
	CoreFunctionId,
	CoreFunctionMetadata,
	CoreFunctionOptions,
	CoreInstructionId,
	CoreOpcodeDescriptor,
	CoreRepresentation,
	CoreTerminatorInput,
	CoreTerminatorPayload,
	CoreValueId,
	SetCoreGuardTerminatorInput,
} from "./core-ir.ts";
import type {
	CoreChangeDomain,
	CoreChangeSet,
	CoreChangedEdge,
	CoreFunctionStore,
	CoreProgram,
	CoreProgramChangeDomain,
	CoreProgramDataTables,
	CoreSourcePosition,
	CoreStoreMutation,
} from "./core-store.ts";

export interface CoreInsertedInstruction {
	readonly instruction: CoreInstructionId;
	readonly outputs: ReadonlyArray<CoreValueId>;
}

function arityAccepts(
	arity: { readonly minimum: number; readonly maximum: number },
	count: number,
): boolean {
	return count >= arity.minimum && count <= arity.maximum;
}

function payloadWithoutSourcePosition(input: CoreTerminatorInput): {
	readonly payload: CoreTerminatorPayload;
	readonly sourcePosition: number | undefined;
} {
	const sourcePosition = input.sourcePosition;
	switch (input.kind) {
		case "jump":
			return { payload: { kind: "jump", edge: input.edge }, sourcePosition };
		case "branch":
			return {
				payload: {
					kind: "branch",
					condition: input.condition,
					consequent: input.consequent,
					alternate: input.alternate,
				},
				sourcePosition,
			};
		case "guard":
			return {
				payload: {
					kind: "guard",
					condition: input.condition,
					fact: input.fact,
					success: input.success,
					fallback: input.fallback,
				},
				sourcePosition,
			};
		case "switch":
			return {
				payload: {
					kind: "switch",
					discriminant: input.discriminant,
					cases: input.cases,
					default: input.default,
				},
				sourcePosition,
			};
		case "return":
		case "throw":
			return { payload: { kind: input.kind, value: input.value }, sourcePosition };
		case "unreachable":
			return { payload: { kind: "unreachable" }, sourcePosition };
	}
}

function terminatorPayloadFromKernel(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	value: (candidate: CoreValueId) => CoreValueId = (candidate) => candidate,
	redirect?: { readonly from: CoreBlockId; readonly replacement: CoreEdge },
): CoreTerminatorPayload {
	const kind = fn.instructionKind(instruction);
	if (kind === "operation") {
		throw new Error(`Core instruction ${instruction} is not a terminator`);
	}
	const kernel = fn.kernel;
	const operandStart = kernel.instructionOperandStart(instruction);
	const operandCount = kernel.instructionOperandCount(instruction);
	const edgeStart = kernel.terminatorEdgeStart(instruction);
	const edgeCount = kernel.terminatorEdgeCount(instruction);
	const operand = (offset: number): CoreValueId => {
		if (offset < 0 || offset >= operandCount) {
			throw new Error(`Malformed Core ${kind} operands`);
		}
		return value(kernel.operandAt(operandStart + offset));
	};
	const edge = (offset: number): CoreEdge => {
		if (offset < 0 || offset >= edgeCount) {
			throw new Error(`Malformed Core ${kind} edges`);
		}
		const row = edgeStart + offset;
		const block = kernel.terminatorEdgeBlock(row);
		if (redirect?.from === block) return redirect.replacement;
		const argumentStart = kernel.terminatorEdgeArgumentStart(row);
		const argumentCount = kernel.terminatorEdgeArgumentCount(row);
		if (
			argumentStart < operandStart ||
			argumentStart + argumentCount > operandStart + operandCount
		) {
			throw new Error(`Malformed Core ${kind} edge arguments`);
		}
		return {
			block,
			arguments: Array.from({ length: argumentCount }, (_, index) =>
				value(kernel.operandAt(argumentStart + index)),
			),
		};
	};
	switch (kind) {
		case "jump":
			return { kind, edge: edge(0) };
		case "branch":
			return {
				kind,
				condition: operand(0),
				consequent: edge(0),
				alternate: edge(1),
			};
		case "guard": {
			const fact = kernel.terminatorFact(instruction);
			if (fact === undefined) throw new Error("Malformed Core guard fact");
			return {
				kind,
				condition: operand(0),
				fact,
				success: edge(0),
				fallback: edge(1),
			};
		}
		case "switch":
			return {
				kind,
				discriminant: operand(0),
				cases: Array.from({ length: edgeCount - 1 }, (_, offset) => {
					const immediate = kernel.terminatorEdgeCaseValue(edgeStart + offset);
					if (immediate === undefined) {
						throw new Error(`Malformed Core switch case ${offset}`);
					}
					return { value: immediate, edge: edge(offset) };
				}),
				default: edge(edgeCount - 1),
			};
		case "return":
		case "throw":
			return { kind, value: operand(0) };
		case "unreachable":
			return { kind };
	}
}

function terminatorOperands(payload: CoreTerminatorPayload): ReadonlyArray<CoreValueId> {
	switch (payload.kind) {
		case "jump":
			return payload.edge.arguments;
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

function terminatorTargets(payload: CoreTerminatorPayload): ReadonlyArray<CoreBlockId> {
	switch (payload.kind) {
		case "jump":
			return [payload.edge.block];
		case "branch":
			return [payload.consequent.block, payload.alternate.block];
		case "guard":
			return [payload.success.block, payload.fallback.block];
		case "switch":
			return [...payload.cases.map(({ edge }) => edge.block), payload.default.block];
		case "return":
		case "throw":
		case "unreachable":
			return [];
	}
}

function sortedIds<Id extends number>(ids: ReadonlySet<Id>): Array<Id> {
	return [...ids].sort((left, right) => left - right);
}

function edgeKey(edge: CoreChangedEdge): string {
	return `${edge.kind}:${edge.source}:${edge.target}`;
}

function sortedEdges(
	edges: ReadonlyMap<string, CoreChangedEdge>,
): Array<CoreChangedEdge> {
	return [...edges.values()]
		.sort(
			(left, right) =>
				left.source - right.source ||
				left.target - right.target ||
				left.kind.localeCompare(right.kind),
		)
		.map((edge) => Object.freeze({ ...edge }));
}

function sameEffectRefinement(
	left: CoreEffectRefinement | undefined,
	right: CoreEffectRefinement | undefined,
): boolean {
	if (left === undefined || right === undefined) return left === right;
	if (left.proof !== right.proof) return false;
	const leftEffects = left.effects;
	const rightEffects = right.effects;
	return (
		leftEffects.mayThrow === rightEffects.mayThrow &&
		leftEffects.maySuspend === rightEffects.maySuspend &&
		leftEffects.mayGc === rightEffects.mayGc &&
		leftEffects.callsUserCode === rightEffects.callsUserCode &&
		leftEffects.reads.length === rightEffects.reads.length &&
		leftEffects.reads.every((domain, index) => domain === rightEffects.reads[index]) &&
		leftEffects.writes.length === rightEffects.writes.length &&
		leftEffects.writes.every((domain, index) => domain === rightEffects.writes[index])
	);
}

function sameFunctionMetadata(
	left: CoreFunctionMetadata,
	right: CoreFunctionMetadata,
): boolean {
	return (
		left.sourcePath === right.sourcePath &&
		left.sourceStrict === right.sourceStrict &&
		left.nameStringIndex === right.nameStringIndex &&
		left.length === right.length &&
		left.mappedArguments === right.mappedArguments &&
		left.mappedArgumentSlots.length === right.mappedArgumentSlots.length &&
		left.mappedArgumentSlots.every(
			(slot, index) => slot === right.mappedArgumentSlots[index],
		) &&
		left.capturedCount === right.capturedCount &&
		left.strict === right.strict &&
		left.isClassConstructor === right.isClassConstructor &&
		left.isDerivedConstructor === right.isDerivedConstructor &&
		left.hasPrototype === right.hasPrototype
	);
}

export class CoreEditor {
	readonly program: CoreProgram;
	readonly function: CoreFunctionStore;
	readonly #mutation: CoreStoreMutation;
	readonly #domains = new Set<CoreChangeDomain>();
	readonly #programDomains = new Set<CoreProgramChangeDomain>();
	readonly #blocks = new Set<CoreBlockId>();
	readonly #instructions = new Set<CoreInstructionId>();
	readonly #values = new Set<CoreValueId>();
	readonly #facts = new Set<CoreFactId>();
	readonly #edges = new Map<string, CoreChangedEdge>();
	readonly #calls = new Set<CoreInstructionId>();
	#edits = 0;
	#committed = false;

	get pendingEdits(): number {
		return this.#edits;
	}

	private constructor(
		mutation: CoreStoreMutation,
		program: CoreProgram,
		fn: CoreFunctionStore,
		newFunction: boolean,
	) {
		this.#mutation = mutation;
		this.program = program;
		this.function = fn;
		fn._beginEdit(mutation);
		if (newFunction) this.#programDomains.add("functions");
	}

	static _open(
		mutation: CoreStoreMutation,
		program: CoreProgram,
		fn: CoreFunctionStore,
		newFunction: boolean,
	): CoreEditor {
		return new CoreEditor(mutation, program, fn, newFunction);
	}

	static createFunction(
		program: CoreProgram,
		options: CoreFunctionOptions = {},
	): CoreEditor {
		return program._createEditor(options);
	}

	static open(program: CoreProgram, functionId: CoreFunctionId): CoreEditor {
		return program._openEditor(functionId);
	}

	static configureProgram(program: CoreProgram, data: CoreProgramDataTables): void {
		program._configureProgramData(data);
	}

	appendSourcePositions(positions: ReadonlyArray<CoreSourcePosition>): number {
		this.#assertActive();
		if (positions.length === 0) return this.program.sourcePositions.length;
		const start = this.program._appendSourcePositions(this.#mutation, positions);
		this.#programDomains.add("sourcePositions");
		this.#edits++;
		return start;
	}

	createBlock(parameters: ReadonlyArray<CoreBlockParameterSpec> = []): CoreBlockId {
		this.#assertActive();
		const created = this.function._createBlock(this.#mutation, parameters);
		this.#touchBlock(created.block);
		this.#touchValues(created.values);
		this.#mark("body", "cfg", "specializationInputs");
		this.#edits++;
		return created.block;
	}

	appendBlockParameter(
		block: CoreBlockId,
		spec: CoreBlockParameterSpec = {},
	): CoreValueId {
		return this.#addBlockParameter(block, spec, false);
	}

	prependBlockParameter(
		block: CoreBlockId,
		spec: CoreBlockParameterSpec = {},
	): CoreValueId {
		return this.#addBlockParameter(block, spec, true);
	}

	removeBlockParameter(block: CoreBlockId, index: number): void {
		this.#assertActive();
		const value = this.function._removeBlockParameter(this.#mutation, block, index);
		this.#touchBlock(block);
		this.#values.add(value);
		this.#mark("body", "cfg", "specializationInputs");
		this.#edits++;
	}

	appendInstruction(
		block: CoreBlockId,
		opcode: string,
		inputs: ReadonlyArray<CoreValueId>,
		options: AppendCoreInstructionOptions = {},
	): CoreInsertedInstruction {
		return this.insertInstruction(block, undefined, opcode, inputs, options);
	}

	insertInstruction(
		block: CoreBlockId,
		before: CoreInstructionId | undefined,
		opcode: string,
		inputs: ReadonlyArray<CoreValueId>,
		options: AppendCoreInstructionOptions = {},
	): CoreInsertedInstruction {
		this.#assertActive();
		const descriptor = this.#operation(opcode, inputs.length, options.outputCount);
		const outputCount = options.outputCount ?? descriptor.outputs.minimum;
		if (
			options.outputRepresentations !== undefined &&
			options.outputRepresentations.length !== outputCount
		) {
			throw new Error(`${opcode} output representation count does not match outputs`);
		}
		const created = this.function._insertOperation(
			this.#mutation,
			block,
			before,
			descriptor.id,
			inputs,
			Array.from(
				{ length: outputCount },
				(_, index) => options.outputRepresentations?.[index] ?? "boxed",
			),
			options.attributes ?? {},
			options.sourcePosition,
			options.effectRefinement,
		);
		this.#touchBlock(block);
		this.#instructions.add(created.instruction);
		this.#touchValues(inputs);
		this.#touchValues(created.results);
		this.#markForOperation(created.instruction, descriptor, options.effectRefinement);
		this.#edits++;
		return { instruction: created.instruction, outputs: created.results };
	}

	replaceInstruction(
		instruction: CoreInstructionId,
		opcode: string,
		inputs: ReadonlyArray<CoreValueId>,
		options: Omit<
			AppendCoreInstructionOptions,
			"outputCount" | "outputRepresentations"
		> = {},
	): void {
		this.#assertActive();
		const previousDescriptor = this.program.registry.byId(
			this.function.instructionOpcode(instruction),
		);
		const previousRefinement = this.function.instructionEffectRefinement(instruction);
		const outputCount = this.function.kernel.instructionResultCount(instruction);
		const descriptor = this.#operation(opcode, inputs.length, outputCount);
		this.#touchInstructionOperands(instruction);
		this.#touchInstructionResults(instruction);
		this.function._replaceOperation(
			this.#mutation,
			instruction,
			descriptor.id,
			inputs,
			options.attributes ?? {},
			options.sourcePosition,
			options.effectRefinement,
		);
		this.#instructions.add(instruction);
		this.#touchBlock(this.function.instructionBlock(instruction));
		this.#touchValues(inputs);
		this.#markForOperation(instruction, previousDescriptor, previousRefinement);
		this.#markForOperation(instruction, descriptor, options.effectRefinement);
		this.#edits++;
	}

	replaceOperands(
		instruction: CoreInstructionId,
		inputs: ReadonlyArray<CoreValueId>,
	): void {
		this.#assertActive();
		const descriptor = this.program.registry.byId(
			this.function.instructionOpcode(instruction),
		);
		if (!arityAccepts(descriptor.inputs, inputs.length)) {
			throw new Error(
				`${descriptor.opcode} expects ${descriptor.inputs.minimum}..${descriptor.inputs.maximum} inputs, received ${inputs.length}`,
			);
		}
		if (this.#instructionOperandsEqual(instruction, inputs)) return;
		const refinement = this.function.instructionEffectRefinement(instruction);
		this.#touchInstructionOperands(instruction);
		this.#touchInstructionResults(instruction);
		this.function._replaceOperands(this.#mutation, instruction, inputs);
		this.#instructions.add(instruction);
		this.#touchBlock(this.function.instructionBlock(instruction));
		this.#touchValues(inputs);
		this.#markForOperation(instruction, descriptor, refinement);
		this.#edits++;
	}

	setInstructionEffectRefinement(
		instruction: CoreInstructionId,
		refinement: CoreEffectRefinement,
	): void {
		this.#replaceInstructionEffectRefinement(instruction, refinement);
	}

	clearInstructionEffectRefinement(instruction: CoreInstructionId): void {
		this.#replaceInstructionEffectRefinement(instruction, undefined);
	}

	#replaceInstructionEffectRefinement(
		instruction: CoreInstructionId,
		refinement: CoreEffectRefinement | undefined,
	): void {
		this.#assertActive();
		if (this.function.instructionKind(instruction) !== "operation") {
			throw new Error(`Core instruction ${instruction} is not an operation`);
		}
		const previous = this.function.instructionEffectRefinement(instruction);
		if (sameEffectRefinement(previous, refinement)) return;
		this.function._setInstructionEffectRefinement(
			this.#mutation,
			instruction,
			refinement,
		);
		this.#instructions.add(instruction);
		this.#touchBlock(this.function.instructionBlock(instruction));
		this.#touchInstructionOperands(instruction);
		this.#touchInstructionResults(instruction);
		this.#touchRefinement(previous);
		this.#touchRefinement(refinement);
		this.#mark("memoryEffects", "facts", "specializationInputs");
		this.#edits++;
	}

	removeInstruction(instruction: CoreInstructionId): void {
		this.#assertActive();
		const block = this.function.instructionBlock(instruction);
		const kind = this.function.instructionKind(instruction);
		const descriptor =
			kind === "operation"
				? this.program.registry.byId(this.function.instructionOpcode(instruction))
				: undefined;
		const refinement =
			descriptor === undefined
				? undefined
				: this.function.instructionEffectRefinement(instruction);
		const guardFact =
			kind === "guard" ? this.function.kernel.terminatorFact(instruction) : undefined;
		this.#touchInstructionOperands(instruction);
		this.#touchInstructionResults(instruction);
		if (kind !== "operation") this.#touchStoredTerminator(block, instruction);
		this.function._removeInstruction(this.#mutation, instruction);
		this.#instructions.add(instruction);
		this.#touchBlock(block);
		if (descriptor === undefined) {
			this.#mark("body", "cfg", "specializationInputs");
			if (guardFact !== undefined) {
				this.#facts.add(guardFact);
				this.#mark("facts");
			}
		} else {
			this.#markForOperation(instruction, descriptor, refinement);
		}
		this.#edits++;
	}

	moveInstruction(
		instruction: CoreInstructionId,
		block: CoreBlockId,
		before?: CoreInstructionId,
	): void {
		this.#assertActive();
		const previousBlock = this.function.instructionBlock(instruction);
		const descriptor = this.program.registry.byId(
			this.function.instructionOpcode(instruction),
		);
		const refinement = this.function.instructionEffectRefinement(instruction);
		this.#touchInstructionOperands(instruction);
		this.#touchInstructionResults(instruction);
		this.function._moveInstruction(this.#mutation, instruction, block, before);
		this.#instructions.add(instruction);
		this.#touchBlock(previousBlock);
		this.#touchBlock(block);
		this.#markForOperation(instruction, descriptor, refinement);
		this.#edits++;
	}

	replaceValueUses(value: CoreValueId, replacement: CoreValueId): void {
		this.replaceValueUsesMany(new Map([[value, replacement]]));
	}

	replaceValueUsesMany(replacements: ReadonlyMap<CoreValueId, CoreValueId>): void {
		this.#assertActive();
		let effective = replacements;
		for (const [value, replacement] of replacements) {
			if (value !== replacement) continue;
			effective = new Map(
				[...replacements].filter(([candidate, target]) => candidate !== target),
			);
			break;
		}
		if (effective.size === 0) return;
		const replacement = (value: CoreValueId): CoreValueId =>
			effective.get(value) ?? value;
		const changed = new Array<Array<CoreValueId> | undefined>(
			this.function.instructionCapacity,
		);
		const changedInstructions: Array<CoreInstructionId> = [];
		const terminatorSeen = new Uint8Array(this.function.instructionCapacity);
		const terminators: Array<CoreInstructionId> = [];
		for (const value of effective.keys()) {
			let use = this.function.kernel.valueFirstUse(value);
			while (use >= 0) {
				const next = this.function.kernel.useNext(use);
				if (this.function.kernel.useLive(use) !== 0) {
					const instruction = this.function.kernel.useInstruction(use);
					if (this.function.kernel.instructionOpcode(instruction) < 0) {
						if (terminatorSeen[instruction] === 0) {
							terminatorSeen[instruction] = 1;
							terminators.push(instruction);
						}
					} else {
						const operand = this.function.kernel.useOperand(use);
						let operands = changed[instruction];
						if (operands === undefined) {
							operands = this.#copyInstructionOperands(instruction);
							changed[instruction] = operands;
							changedInstructions.push(instruction);
						}
						operands[operand] = replacement(operands[operand]!);
					}
				}
				use = next;
			}
		}
		for (const instruction of changedInstructions)
			this.replaceOperands(instruction, changed[instruction]!);
		for (const instruction of terminators) {
			const kind = this.function.instructionKind(instruction);
			const previousCondition =
				kind === "guard"
					? this.function.kernel.operandAt(
							this.function.kernel.instructionOperandStart(instruction),
						)
					: undefined;
			const fact =
				kind === "guard" ? this.function.kernel.terminatorFact(instruction) : undefined;
			const payload = terminatorPayloadFromKernel(
				this.function,
				instruction,
				replacement,
			);
			const block = this.function.instructionBlock(instruction);
			this.#touchStoredTerminator(block, instruction);
			this.function._replaceTerminatorPayload(this.#mutation, instruction, payload);
			this.#instructions.add(instruction);
			this.#touchTerminator(block, payload);
			this.#mark("body", "specializationInputs");
			if (
				fact !== undefined &&
				payload.kind === "guard" &&
				previousCondition !== payload.condition
			) {
				this.#facts.add(fact);
				this.#mark("facts");
			}
			this.#edits++;
		}
		for (let blockIndex = 0; blockIndex < this.function.blockCapacity; blockIndex++) {
			const block = coreBlockId(blockIndex);
			if (!this.function.isBlockLive(block)) continue;
			const handlerBlock = this.function.kernel.blockHandlerBlock(block);
			if (handlerBlock === undefined) continue;
			const argumentStart = this.function.kernel.blockHandlerArgumentStart(block);
			const argumentCount = this.function.kernel.blockHandlerArgumentCount(block);
			let arguments_: Array<CoreValueId> | undefined;
			for (let index = 0; index < argumentCount; index++) {
				const argument = this.function.kernel.handlerArgumentAt(argumentStart + index);
				const replacementValue = replacement(argument);
				if (arguments_ === undefined && replacementValue === argument) continue;
				arguments_ ??= Array.from({ length: argumentCount }, (_, argumentIndex) =>
					this.function.kernel.handlerArgumentAt(argumentStart + argumentIndex),
				);
				arguments_[index] = replacementValue;
			}
			if (arguments_ !== undefined) this.setHandler(block, handlerBlock, arguments_);
		}
		for (const [value, replacementValue] of effective) {
			this.#values.add(value);
			this.#values.add(replacementValue);
		}
	}

	removeBlock(block: CoreBlockId): void {
		this.#assertActive();
		this.#assertLiveBlock(block);
		const parameterStart = this.function.kernel.blockParameterStart(block);
		const parameterCount = this.function.kernel.blockParameterCount(block);
		for (let index = 0; index < parameterCount; index++) {
			this.#values.add(this.function.kernel.blockParameterValue(parameterStart + index));
		}
		this.#touchStoredHandler(block);
		for (const instruction of this.function.instructionIds(block)) {
			this.#instructions.add(instruction);
			this.#touchInstructionOperands(instruction);
			this.#touchInstructionResults(instruction);
			if (this.function.instructionKind(instruction) === "operation") {
				this.#markForOperation(
					instruction,
					this.program.registry.byId(this.function.instructionOpcode(instruction)),
					this.function.instructionEffectRefinement(instruction),
				);
				continue;
			}
			this.#touchStoredTerminator(block, instruction);
			const fact = this.function.kernel.terminatorFact(instruction);
			if (fact !== undefined) {
				this.#facts.add(fact);
				this.#mark("facts");
			}
		}
		this.function._removeBlock(this.#mutation, block);
		this.#blocks.add(block);
		this.#mark("body", "cfg", "exceptionFlow", "specializationInputs");
		this.#edits++;
	}

	setValueRepresentation(value: CoreValueId, representation: CoreRepresentation): void {
		this.#assertActive();
		if (!this.function._setValueRepresentation(this.#mutation, value, representation)) {
			return;
		}
		this.#values.add(value);
		this.#mark("representations", "specializationInputs");
		this.#edits++;
	}

	setHandler(
		block: CoreBlockId,
		handlerBlock: CoreBlockId,
		arguments_: ReadonlyArray<CoreValueId> = [],
	): void {
		this.#assertActive();
		this.#assertLiveBlock(block);
		this.#touchStoredHandler(block);
		this.#touchHandler(block, { block: handlerBlock, arguments: arguments_ });
		this.function._setHandler(this.#mutation, block, {
			block: handlerBlock,
			arguments: [...arguments_],
		});
		this.#mark("exceptionFlow", "specializationInputs");
		this.#edits++;
	}

	clearHandler(block: CoreBlockId): void {
		this.#assertActive();
		this.#assertLiveBlock(block);
		if (!this.#touchStoredHandler(block)) return;
		this.function._setHandler(this.#mutation, block, undefined);
		this.#mark("exceptionFlow", "specializationInputs");
		this.#edits++;
	}

	setTerminator(block: CoreBlockId, input: CoreTerminatorInput): CoreInstructionId {
		this.#assertActive();
		const { payload, sourcePosition } = payloadWithoutSourcePosition(input);
		const instruction = this.function._setTerminator(
			this.#mutation,
			block,
			payload,
			sourcePosition,
		);
		this.#touchBlock(block);
		this.#instructions.add(instruction);
		this.#touchTerminator(block, payload);
		this.#mark("body", "cfg", "specializationInputs");
		if (payload.kind === "guard") {
			this.#facts.add(payload.fact);
			this.#mark("facts");
		}
		this.#edits++;
		return instruction;
	}

	replaceTerminator(block: CoreBlockId, input: CoreTerminatorInput): void {
		this.#assertActive();
		const { payload } = payloadWithoutSourcePosition(input);
		const instruction = this.function.blockTerminator(block);
		const previousKind = this.function.instructionKind(instruction);
		const previousFact = this.function.kernel.terminatorFact(instruction);
		this.#touchStoredTerminator(block, instruction);
		this.function._replaceTerminatorPayload(this.#mutation, instruction, payload);
		this.#touchTerminator(block, payload);
		this.#instructions.add(instruction);
		this.#mark("body", "cfg", "specializationInputs");
		if (previousFact !== undefined) this.#facts.add(previousFact);
		if (payload.kind === "guard") this.#facts.add(payload.fact);
		if (previousKind === "guard" || payload.kind === "guard") this.#mark("facts");
		this.#edits++;
	}

	setGuardTerminator(block: CoreBlockId, input: SetCoreGuardTerminatorInput): CoreFactId {
		this.#assertActive();
		const factId = coreFactId(this.function.factCapacity);
		const instruction = this.function._setTerminator(
			this.#mutation,
			block,
			{
				kind: "guard",
				condition: input.condition,
				fact: factId,
				success: input.success,
				fallback: input.fallback,
			},
			input.sourcePosition,
		);
		const created = this.function._addFact(this.#mutation, {
			...input.fact,
			claims: [...input.fact.claims],
			validity: { kind: "guard", instruction },
			obligations: [{ kind: "guard", instruction }, ...(input.fact.obligations ?? [])],
		});
		this.#touchBlock(block);
		this.#instructions.add(instruction);
		this.#facts.add(created);
		this.#touchTerminator(block, {
			kind: "guard",
			condition: input.condition,
			fact: created,
			success: input.success,
			fallback: input.fallback,
		});
		this.#mark("body", "cfg", "facts", "specializationInputs");
		this.#edits++;
		return created;
	}

	redirectEdge(block: CoreBlockId, from: CoreBlockId, replacement: CoreEdge): void {
		this.#assertActive();
		const terminator = this.function.blockTerminator(block);
		const fact = this.function.kernel.terminatorFact(terminator);
		const after = terminatorPayloadFromKernel(this.function, terminator, undefined, {
			from,
			replacement,
		});
		this.#touchStoredTerminator(block, terminator);
		this.function._replaceTerminatorPayload(this.#mutation, terminator, after);
		this.#touchTerminator(block, after);
		this.#instructions.add(terminator);
		this.#mark("body", "cfg", "specializationInputs");
		if (fact !== undefined) {
			this.#facts.add(fact);
			this.#mark("facts");
		}
		this.#edits++;
	}

	addFact(fact: Omit<CoreFact, "id">): CoreFactId {
		this.#assertActive();
		const id = this.function._addFact(this.#mutation, fact);
		this.#facts.add(id);
		this.#mark("facts", "specializationInputs");
		this.#edits++;
		return id;
	}

	replaceFact(fact: CoreFactId, replacement: Omit<CoreFact, "id">): void {
		this.#assertActive();
		this.function._replaceFact(this.#mutation, fact, replacement);
		this.#facts.add(fact);
		this.#mark("facts", "specializationInputs");
		this.#edits++;
	}

	removeFact(fact: CoreFactId): void {
		this.#assertActive();
		for (const instruction of this.function.instructionIds()) {
			if (
				this.function.instructionKind(instruction) === "guard" &&
				this.function.kernel.terminatorFact(instruction) === fact
			) {
				throw new Error(
					`Cannot remove Core fact ${fact} while guard @${instruction} uses it`,
				);
			}
			if (
				this.function.instructionKind(instruction) === "operation" &&
				this.function.instructionEffectRefinement(instruction)?.proof === fact
			) {
				throw new Error(
					`Cannot remove Core fact ${fact} while refinement @${instruction} uses it`,
				);
			}
		}
		this.function._removeFact(this.#mutation, fact);
		this.#facts.add(fact);
		this.#mark("facts", "specializationInputs");
		this.#edits++;
	}

	configureFunction(options: CoreFunctionOptions): void {
		this.#assertActive();
		const metadata =
			options.metadata === undefined
				? this.function.metadata
				: {
						...this.function.metadata,
						...options.metadata,
						mappedArgumentSlots:
							options.metadata.mappedArgumentSlots ??
							this.function.metadata.mappedArgumentSlots,
					};
		if (
			(options.isGenerator ?? this.function.isGenerator) === this.function.isGenerator &&
			(options.isAsync ?? this.function.isAsync) === this.function.isAsync &&
			(options.parameterCount ?? this.function.parameterCount) ===
				this.function.parameterCount &&
			sameFunctionMetadata(this.function.metadata, metadata)
		) {
			return;
		}
		this.function._configureFunction(this.#mutation, options);
		this.#mark("body", "specializationInputs");
		this.#edits++;
	}

	finishFunction(entry: CoreBlockId, bodyEntry?: CoreBlockId): void {
		this.#assertActive();
		const parameterCount = this.function.parameterCount;
		const entryParameterStart = this.function.kernel.blockParameterStart(entry);
		const entryParameterCount = this.function.kernel.blockParameterCount(entry);
		let parametersMatch = entryParameterCount === parameterCount;
		for (let index = 0; parametersMatch && index < parameterCount; index++) {
			parametersMatch =
				this.function.kernel.functionParameter(index) ===
				this.function.kernel.blockParameterValue(entryParameterStart + index);
		}
		if (
			this.function.finished &&
			this.function.entry === entry &&
			this.function.bodyEntry === bodyEntry &&
			parametersMatch
		) {
			return;
		}
		this.function._finishFunction(this.#mutation, entry, bodyEntry);
		this.#touchBlock(entry);
		if (bodyEntry !== undefined) this.#touchBlock(bodyEntry);
		this.#mark("body", "specializationInputs");
		this.#edits++;
	}

	commit(): CoreChangeSet {
		this.#assertActive();
		this.function._endEdit(this.#mutation, this.#domains);
		for (const domain of this.#domains) {
			switch (domain) {
				case "calls":
					this.#programDomains.add("calls");
					break;
				case "facts":
					this.#programDomains.add("facts");
					break;
				case "representations":
					this.#programDomains.add("representations");
					break;
				case "specializationInputs":
					this.#programDomains.add("specializationInputs");
					break;
				case "body":
				case "cfg":
				case "exceptionFlow":
				case "memoryEffects":
					break;
			}
		}
		this.function._bumpProgramVersions(this.#mutation, this.#programDomains);
		this.#committed = true;
		return Object.freeze({
			function: this.function.id,
			domains: Object.freeze([...this.#domains]),
			programDomains: Object.freeze([...this.#programDomains]),
			blocks: Object.freeze(sortedIds(this.#blocks)),
			instructions: Object.freeze(sortedIds(this.#instructions)),
			values: Object.freeze(sortedIds(this.#values)),
			facts: Object.freeze(sortedIds(this.#facts)),
			edges: Object.freeze(sortedEdges(this.#edges)),
			calls: Object.freeze(sortedIds(this.#calls)),
			edits: this.#edits,
		});
	}

	#addBlockParameter(
		block: CoreBlockId,
		spec: CoreBlockParameterSpec,
		prepend: boolean,
	): CoreValueId {
		this.#assertActive();
		const value = this.function._appendBlockParameter(
			this.#mutation,
			block,
			spec,
			prepend,
		);
		this.#touchBlock(block);
		this.#values.add(value);
		this.#mark("body", "cfg", "specializationInputs");
		this.#edits++;
		return value;
	}

	#operation(
		opcode: string,
		inputCount: number,
		requestedOutputCount: number | undefined,
	): CoreOpcodeDescriptor {
		const descriptor = this.program.registry.require(opcode);
		if (!arityAccepts(descriptor.inputs, inputCount)) {
			throw new Error(
				`${opcode} expects ${descriptor.inputs.minimum}..${descriptor.inputs.maximum} inputs, received ${inputCount}`,
			);
		}
		const outputCount = requestedOutputCount ?? descriptor.outputs.minimum;
		if (!arityAccepts(descriptor.outputs, outputCount)) {
			throw new Error(
				`${opcode} expects ${descriptor.outputs.minimum}..${descriptor.outputs.maximum} outputs, received ${outputCount}`,
			);
		}
		return descriptor;
	}

	#markForOperation(
		instruction: CoreInstructionId,
		descriptor: CoreOpcodeDescriptor,
		refinement: CoreEffectRefinement | undefined,
	): void {
		this.#mark("body", "specializationInputs");
		if (descriptor.callTransfer !== undefined) {
			this.#mark("calls");
			this.#calls.add(instruction);
		}
		if (
			descriptor.effects.reads.length > 0 ||
			descriptor.effects.writes.length > 0 ||
			descriptor.effects.mayThrow ||
			descriptor.effects.maySuspend ||
			descriptor.effects.mayGc ||
			descriptor.effects.callsUserCode ||
			refinement !== undefined
		) {
			this.#mark("memoryEffects");
		}
		if (refinement !== undefined) this.#mark("facts");
		this.#touchRefinement(refinement);
	}

	#mark(...domains: ReadonlyArray<CoreChangeDomain>): void {
		for (const domain of domains) this.#domains.add(domain);
	}

	#touchBlock(block: CoreBlockId): void {
		this.#blocks.add(block);
	}

	#touchValues(values: ReadonlyArray<CoreValueId>): void {
		for (const value of values) this.#values.add(value);
	}

	#copyInstructionOperands(instruction: CoreInstructionId): Array<CoreValueId> {
		const start = this.function.kernel.instructionOperandStart(instruction);
		const count = this.function.kernel.instructionOperandCount(instruction);
		return Array.from({ length: count }, (_, index) =>
			this.function.kernel.operandAt(start + index),
		);
	}

	#instructionOperandsEqual(
		instruction: CoreInstructionId,
		inputs: ReadonlyArray<CoreValueId>,
	): boolean {
		const count = this.function.kernel.instructionOperandCount(instruction);
		if (count !== inputs.length) return false;
		const start = this.function.kernel.instructionOperandStart(instruction);
		for (let index = 0; index < count; index++) {
			if (this.function.kernel.operandAt(start + index) !== inputs[index]) {
				return false;
			}
		}
		return true;
	}

	#touchInstructionOperands(instruction: CoreInstructionId): void {
		const start = this.function.kernel.instructionOperandStart(instruction);
		const count = this.function.kernel.instructionOperandCount(instruction);
		for (let index = 0; index < count; index++) {
			this.#values.add(this.function.kernel.operandAt(start + index));
		}
	}

	#touchInstructionResults(instruction: CoreInstructionId): void {
		const start = this.function.kernel.instructionResultStart(instruction);
		const count = this.function.kernel.instructionResultCount(instruction);
		for (let index = 0; index < count; index++) {
			this.#values.add(this.function.kernel.resultAt(start + index));
		}
	}

	#touchStoredTerminator(block: CoreBlockId, instruction: CoreInstructionId): void {
		this.#touchBlock(block);
		this.#touchInstructionOperands(instruction);
		const edgeStart = this.function.kernel.terminatorEdgeStart(instruction);
		const edgeCount = this.function.kernel.terminatorEdgeCount(instruction);
		for (let index = 0; index < edgeCount; index++) {
			const target = this.function.kernel.terminatorEdgeBlock(edgeStart + index);
			this.#touchBlock(target);
			this.#touchEdge({ kind: "control-flow", source: block, target });
		}
	}

	#touchStoredHandler(block: CoreBlockId): boolean {
		const handlerBlock = this.function.kernel.blockHandlerBlock(block);
		if (handlerBlock === undefined) return false;
		this.#touchBlock(block);
		this.#touchBlock(handlerBlock);
		const argumentStart = this.function.kernel.blockHandlerArgumentStart(block);
		const argumentCount = this.function.kernel.blockHandlerArgumentCount(block);
		for (let index = 0; index < argumentCount; index++) {
			this.#values.add(this.function.kernel.handlerArgumentAt(argumentStart + index));
		}
		this.#touchEdge({ kind: "exception", source: block, target: handlerBlock });
		return true;
	}

	#touchTerminator(block: CoreBlockId, payload: CoreTerminatorPayload): void {
		this.#touchBlock(block);
		this.#touchValues(terminatorOperands(payload));
		for (const target of terminatorTargets(payload)) {
			this.#touchBlock(target);
			this.#touchEdge({ kind: "control-flow", source: block, target });
		}
	}

	#touchHandler(block: CoreBlockId, handler: CoreEdge): void {
		this.#touchBlock(block);
		this.#touchBlock(handler.block);
		this.#touchValues(handler.arguments);
		this.#touchEdge({ kind: "exception", source: block, target: handler.block });
	}

	#touchRefinement(refinement: CoreEffectRefinement | undefined): void {
		if (refinement !== undefined) this.#facts.add(refinement.proof);
	}

	#touchEdge(edge: CoreChangedEdge): void {
		this.#edges.set(edgeKey(edge), edge);
	}

	#assertLiveBlock(block: CoreBlockId): void {
		if (this.function.kernel.blockLive(block) === 0) {
			throw new Error(`Unknown Core block ${block}`);
		}
	}

	#assertActive(): void {
		if (this.#committed) throw new Error("Core editor has already committed");
	}
}
