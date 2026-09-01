import { coreFactId } from "./core-ir.ts";
import type {
	AppendCoreInstructionOptions,
	CoreBlockId,
	CoreBlockParameterSpec,
	CoreEdge,
	CoreEffectRefinement,
	CoreFact,
	CoreFactId,
	CoreFunctionId,
	CoreFunctionOptions,
	CoreInstructionId,
	CoreOpcodeDescriptor,
	CoreRepresentation,
	CoreTerminatorInput,
	CoreTerminatorPayload,
	CoreValueId,
	SetCoreGuardTerminatorInput,
} from "./core-ir.ts";
import { CORE_STORE_MUTATION, sortCoreIds } from "./core-store.ts";
import type {
	CoreChangeDomain,
	CoreChangeSet,
	CoreFunctionStore,
	CoreProgram,
	CoreProgramChangeDomain,
	CoreProgramDataTables,
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

function redirectPayload(
	payload: CoreTerminatorPayload,
	from: CoreBlockId,
	replacement: CoreEdge,
): CoreTerminatorPayload {
	const edge = (candidate: CoreEdge): CoreEdge =>
		candidate.block === from ? replacement : candidate;
	switch (payload.kind) {
		case "jump":
			return { kind: "jump", edge: edge(payload.edge) };
		case "branch":
			return {
				kind: "branch",
				condition: payload.condition,
				consequent: edge(payload.consequent),
				alternate: edge(payload.alternate),
			};
		case "guard":
			return {
				kind: "guard",
				condition: payload.condition,
				fact: payload.fact,
				success: edge(payload.success),
				fallback: edge(payload.fallback),
			};
		case "switch":
			return {
				kind: "switch",
				discriminant: payload.discriminant,
				cases: payload.cases.map(({ value, edge: candidate }) => ({
					value,
					edge: edge(candidate),
				})),
				default: edge(payload.default),
			};
		case "return":
		case "throw":
		case "unreachable":
			return payload;
	}
}

function replacePayloadValue(
	payload: CoreTerminatorPayload,
	from: CoreValueId,
	replacement: CoreValueId,
): CoreTerminatorPayload {
	const value = (candidate: CoreValueId): CoreValueId =>
		candidate === from ? replacement : candidate;
	const edge = (candidate: CoreEdge): CoreEdge => ({
		block: candidate.block,
		arguments: candidate.arguments.map(value),
	});
	switch (payload.kind) {
		case "jump":
			return { kind: "jump", edge: edge(payload.edge) };
		case "branch":
			return {
				kind: "branch",
				condition: value(payload.condition),
				consequent: edge(payload.consequent),
				alternate: edge(payload.alternate),
			};
		case "guard":
			return {
				kind: "guard",
				condition: value(payload.condition),
				fact: payload.fact,
				success: edge(payload.success),
				fallback: edge(payload.fallback),
			};
		case "switch":
			return {
				kind: "switch",
				discriminant: value(payload.discriminant),
				cases: payload.cases.map(({ value: immediate, edge: candidate }) => ({
					value: immediate,
					edge: edge(candidate),
				})),
				default: edge(payload.default),
			};
		case "return":
		case "throw":
			return { kind: payload.kind, value: value(payload.value) };
		case "unreachable":
			return payload;
	}
}

export class CoreEditor {
	readonly program: CoreProgram;
	readonly function: CoreFunctionStore;
	readonly #domains = new Set<CoreChangeDomain>();
	readonly #programDomains = new Set<CoreProgramChangeDomain>();
	readonly #blocks = new Set<CoreBlockId>();
	readonly #instructions = new Set<CoreInstructionId>();
	readonly #values = new Set<CoreValueId>();
	readonly #facts = new Set<CoreFactId>();
	#edits = 0;
	#committed = false;

	private constructor(program: CoreProgram, fn: CoreFunctionStore, newFunction: boolean) {
		this.program = program;
		this.function = fn;
		fn._beginEdit(CORE_STORE_MUTATION);
		if (newFunction) this.#programDomains.add("functions");
	}

	static createFunction(
		program: CoreProgram,
		options: CoreFunctionOptions = {},
	): CoreEditor {
		return new CoreEditor(
			program,
			program._createFunction(CORE_STORE_MUTATION, options),
			true,
		);
	}

	static open(program: CoreProgram, functionId: CoreFunctionId): CoreEditor {
		return new CoreEditor(program, program.function(functionId), false);
	}

	static configureProgram(program: CoreProgram, data: CoreProgramDataTables): void {
		program._setProgramData(CORE_STORE_MUTATION, data);
	}

	createBlock(parameters: ReadonlyArray<CoreBlockParameterSpec> = []): CoreBlockId {
		this.#assertActive();
		const created = this.function._createBlock(CORE_STORE_MUTATION, parameters);
		this.#touchBlock(created.block);
		for (const value of created.values) this.#values.add(value);
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
		const value = this.function._removeBlockParameter(CORE_STORE_MUTATION, block, index);
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
			CORE_STORE_MUTATION,
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
		for (const output of created.results) this.#values.add(output);
		this.#markForOperation(descriptor, options.effectRefinement);
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
		const outputCount = this.function.instructionResults(instruction).length;
		const descriptor = this.#operation(opcode, inputs.length, outputCount);
		this.function._replaceOperation(
			CORE_STORE_MUTATION,
			instruction,
			descriptor.id,
			inputs,
			options.attributes ?? {},
			options.sourcePosition,
			options.effectRefinement,
		);
		this.#instructions.add(instruction);
		this.#touchBlock(this.function.instructionBlock(instruction));
		this.#markForOperation(previousDescriptor, previousRefinement);
		this.#markForOperation(descriptor, options.effectRefinement);
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
		this.function._replaceOperands(CORE_STORE_MUTATION, instruction, inputs);
		this.#instructions.add(instruction);
		this.#touchBlock(this.function.instructionBlock(instruction));
		this.#markForOperation(descriptor, undefined);
		this.#edits++;
	}

	setInstructionEffectRefinement(
		instruction: CoreInstructionId,
		refinement: CoreEffectRefinement,
	): void {
		this.#assertActive();
		const descriptor = this.program.registry.byId(
			this.function.instructionOpcode(instruction),
		);
		this.function._setInstructionEffectRefinement(
			CORE_STORE_MUTATION,
			instruction,
			refinement,
		);
		this.#instructions.add(instruction);
		this.#touchBlock(this.function.instructionBlock(instruction));
		this.#mark("memoryEffects", "facts", "specializationInputs");
		if (descriptor.callTransfer !== undefined) {
			this.#mark("calls");
		}
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
		for (const value of this.function.instructionResults(instruction))
			this.#values.add(value);
		this.function._removeInstruction(CORE_STORE_MUTATION, instruction);
		this.#instructions.add(instruction);
		this.#touchBlock(block);
		if (descriptor === undefined) this.#mark("body", "cfg", "specializationInputs");
		else this.#markForOperation(descriptor, undefined);
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
		this.function._moveInstruction(CORE_STORE_MUTATION, instruction, block, before);
		this.#instructions.add(instruction);
		this.#touchBlock(previousBlock);
		this.#touchBlock(block);
		this.#markForOperation(descriptor, refinement);
		this.#edits++;
	}

	replaceValueUses(value: CoreValueId, replacement: CoreValueId): void {
		this.#assertActive();
		if (value === replacement) return;
		const uses = [...this.function.uses(value)];
		const changed = new Map<CoreInstructionId, Array<CoreValueId>>();
		const terminators = new Set<CoreInstructionId>();
		for (const { instruction, operand } of uses) {
			if (this.function.instructionKind(instruction) !== "operation") {
				terminators.add(instruction);
				continue;
			}
			const operands = changed.get(instruction) ?? [
				...this.function.instructionOperands(instruction),
			];
			operands[operand] = replacement;
			changed.set(instruction, operands);
		}
		for (const [instruction, operands] of changed) {
			this.replaceOperands(instruction, operands);
		}
		for (const instruction of terminators) {
			const payload = replacePayloadValue(
				this.function.terminatorPayload(instruction),
				value,
				replacement,
			);
			this.function._replaceTerminatorPayload(CORE_STORE_MUTATION, instruction, payload);
			this.#instructions.add(instruction);
			this.#touchBlock(this.function.instructionBlock(instruction));
			this.#mark("body", "specializationInputs");
			if (payload.kind === "guard") this.#mark("facts");
			this.#edits++;
		}
		for (const block of this.function.blockIds()) {
			const handler = this.function.blockHandler(block);
			if (handler === undefined || !handler.arguments.includes(value)) continue;
			this.setHandler(
				block,
				handler.block,
				handler.arguments.map((argument) =>
					argument === value ? replacement : argument,
				),
			);
		}
		this.#values.add(value);
		this.#values.add(replacement);
	}

	removeBlock(block: CoreBlockId): void {
		this.#assertActive();
		const instructions = [...this.function.instructionIds(block)];
		const values = [
			...this.function.blockParameters(block).map(({ value }) => value),
			...instructions.flatMap((instruction) =>
				this.function.instructionResults(instruction),
			),
		];
		this.function._removeBlock(CORE_STORE_MUTATION, block);
		this.#blocks.add(block);
		for (const instruction of instructions) this.#instructions.add(instruction);
		for (const value of values) this.#values.add(value);
		this.#mark("body", "cfg", "exceptionFlow", "specializationInputs");
		this.#edits++;
	}

	setValueRepresentation(value: CoreValueId, representation: CoreRepresentation): void {
		this.#assertActive();
		if (
			!this.function._setValueRepresentation(CORE_STORE_MUTATION, value, representation)
		) {
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
		this.function._setHandler(CORE_STORE_MUTATION, block, {
			block: handlerBlock,
			arguments: [...arguments_],
		});
		this.#touchBlock(block);
		this.#touchBlock(handlerBlock);
		this.#mark("exceptionFlow", "specializationInputs");
		this.#edits++;
	}

	clearHandler(block: CoreBlockId): void {
		this.#assertActive();
		this.function._setHandler(CORE_STORE_MUTATION, block, undefined);
		this.#touchBlock(block);
		this.#mark("exceptionFlow", "specializationInputs");
		this.#edits++;
	}

	setTerminator(block: CoreBlockId, input: CoreTerminatorInput): CoreInstructionId {
		this.#assertActive();
		const { payload, sourcePosition } = payloadWithoutSourcePosition(input);
		const instruction = this.function._setTerminator(
			CORE_STORE_MUTATION,
			block,
			payload,
			sourcePosition,
		);
		this.#touchBlock(block);
		this.#instructions.add(instruction);
		this.#mark("body", "cfg", "specializationInputs");
		if (payload.kind === "guard") this.#mark("facts");
		this.#edits++;
		return instruction;
	}

	replaceTerminator(block: CoreBlockId, input: CoreTerminatorInput): void {
		this.#assertActive();
		const { payload } = payloadWithoutSourcePosition(input);
		const instruction = this.function.blockTerminator(block);
		this.function._replaceTerminatorPayload(CORE_STORE_MUTATION, instruction, payload);
		this.#touchBlock(block);
		this.#instructions.add(instruction);
		this.#mark("body", "cfg", "specializationInputs");
		if (payload.kind === "guard") this.#mark("facts");
		this.#edits++;
	}

	setGuardTerminator(block: CoreBlockId, input: SetCoreGuardTerminatorInput): CoreFactId {
		this.#assertActive();
		const factId = coreFactId(this.function.factCapacity);
		const instruction = this.function._setTerminator(
			CORE_STORE_MUTATION,
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
		const created = this.function._addFact(CORE_STORE_MUTATION, {
			...input.fact,
			claims: [...input.fact.claims],
			validity: { kind: "guard", instruction },
			obligations: [{ kind: "guard", instruction }, ...(input.fact.obligations ?? [])],
		});
		this.#touchBlock(block);
		this.#instructions.add(instruction);
		this.#facts.add(created);
		this.#mark("body", "cfg", "facts", "specializationInputs");
		this.#edits++;
		return created;
	}

	redirectEdge(block: CoreBlockId, from: CoreBlockId, replacement: CoreEdge): void {
		this.#assertActive();
		const terminator = this.function.blockTerminator(block);
		const before = this.function.terminatorPayload(terminator);
		const after = redirectPayload(before, from, replacement);
		this.function._replaceTerminatorPayload(CORE_STORE_MUTATION, terminator, after);
		this.#touchBlock(block);
		this.#touchBlock(from);
		this.#touchBlock(replacement.block);
		this.#instructions.add(terminator);
		this.#mark("body", "cfg", "specializationInputs");
		this.#edits++;
	}

	addFact(fact: Omit<CoreFact, "id">): CoreFactId {
		this.#assertActive();
		const id = this.function._addFact(CORE_STORE_MUTATION, fact);
		this.#facts.add(id);
		this.#mark("facts", "specializationInputs");
		this.#edits++;
		return id;
	}

	replaceFact(fact: CoreFactId, replacement: Omit<CoreFact, "id">): void {
		this.#assertActive();
		this.function._replaceFact(CORE_STORE_MUTATION, fact, replacement);
		this.#facts.add(fact);
		this.#mark("facts", "specializationInputs");
		this.#edits++;
	}

	removeFact(fact: CoreFactId): void {
		this.#assertActive();
		for (const instruction of this.function.instructionIds()) {
			if (
				this.function.instructionKind(instruction) === "guard" &&
				this.function.terminatorPayload(instruction).kind === "guard" &&
				(this.function.terminatorPayload(instruction) as { readonly fact: CoreFactId })
					.fact === fact
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
		this.function._removeFact(CORE_STORE_MUTATION, fact);
		this.#facts.add(fact);
		this.#mark("facts", "specializationInputs");
		this.#edits++;
	}

	configureFunction(options: CoreFunctionOptions): void {
		this.#assertActive();
		this.function._configureFunction(CORE_STORE_MUTATION, options);
		this.#mark("body", "specializationInputs");
		this.#edits++;
	}

	finishFunction(entry: CoreBlockId, bodyEntry?: CoreBlockId): void {
		this.#assertActive();
		this.function._finishFunction(CORE_STORE_MUTATION, entry, bodyEntry);
		this.#touchBlock(entry);
		if (bodyEntry !== undefined) this.#touchBlock(bodyEntry);
		this.#mark("body", "specializationInputs");
		this.#edits++;
	}

	commit(): CoreChangeSet {
		this.#assertActive();
		this.function._endEdit(CORE_STORE_MUTATION, this.#domains);
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
		this.function._bumpProgramVersions(CORE_STORE_MUTATION, this.#programDomains);
		this.#committed = true;
		return Object.freeze({
			function: this.function.id,
			domains: Object.freeze([...this.#domains]),
			programDomains: Object.freeze([...this.#programDomains]),
			blocks: Object.freeze(sortCoreIds(this.#blocks)),
			instructions: Object.freeze(sortCoreIds(this.#instructions)),
			values: Object.freeze(sortCoreIds(this.#values)),
			facts: Object.freeze(sortCoreIds(this.#facts)),
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
			CORE_STORE_MUTATION,
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
		descriptor: CoreOpcodeDescriptor,
		refinement: CoreEffectRefinement | undefined,
	): void {
		this.#mark("body", "specializationInputs");
		if (descriptor.callTransfer !== undefined) {
			this.#mark("calls");
		}
		if (
			descriptor.effects.reads.length > 0 ||
			descriptor.effects.writes.length > 0 ||
			descriptor.effects.mayThrow ||
			descriptor.effects.maySuspend ||
			descriptor.effects.mayGc ||
			refinement !== undefined
		) {
			this.#mark("memoryEffects");
		}
		if (refinement !== undefined) this.#mark("facts");
	}

	#mark(...domains: ReadonlyArray<CoreChangeDomain>): void {
		for (const domain of domains) this.#domains.add(domain);
	}

	#touchBlock(block: CoreBlockId): void {
		this.#blocks.add(block);
	}

	#assertActive(): void {
		if (this.#committed) throw new Error("Core editor has already committed");
	}
}
