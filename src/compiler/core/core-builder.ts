import { CoreEditor } from "./core-editor.ts";
import type {
	AppendCoreInstructionOptions,
	CoreBlockId,
	CoreBlockParameterSpec,
	CoreFact,
	CoreFactId,
	CoreFunctionId,
	CoreFunctionOptions,
	CoreInstructionId,
	CoreRepresentation,
	CoreTerminatorInput,
	CoreValueId,
	SetCoreGuardTerminatorInput,
} from "./core-ir.ts";
import type { CoreChangeSet, CoreProgram } from "./core-store.ts";

export interface FinishedCoreFunction {
	readonly function: CoreFunctionId;
	readonly changes: CoreChangeSet;
}

export class CoreFunctionBuilder {
	readonly program: CoreProgram;
	readonly editor: CoreEditor;

	constructor(program: CoreProgram, options: CoreFunctionOptions = {}) {
		this.program = program;
		this.editor = CoreEditor.createFunction(program, options);
	}

	get functionId(): CoreFunctionId {
		return this.editor.function.id;
	}

	createBlock(parameters: ReadonlyArray<CoreBlockParameterSpec> = []): CoreBlockId {
		return this.editor.createBlock(parameters);
	}

	blockParameterValue(block: CoreBlockId, index: number): CoreValueId {
		if (this.editor.function.kernel.blockLive(block) === 0) {
			throw new Error(`Unknown Core block ${block}`);
		}
		const count = this.editor.function.kernel.blockParameterCount(block);
		if (!Number.isInteger(index) || index < 0 || index >= count) {
			throw new Error(`Unknown Core block ${block} parameter ${index}`);
		}
		return this.editor.function.kernel.blockParameterValue(
			this.editor.function.kernel.blockParameterStart(block) + index,
		);
	}

	bodyInstructionIds(block: CoreBlockId): ReadonlyArray<CoreInstructionId> {
		return [...this.editor.function.bodyInstructionIds(block)];
	}

	appendBlockParameter(
		block: CoreBlockId,
		spec: CoreBlockParameterSpec = {},
	): CoreValueId {
		return this.editor.appendBlockParameter(block, spec);
	}

	prependBlockParameter(
		block: CoreBlockId,
		spec: CoreBlockParameterSpec = {},
	): CoreValueId {
		return this.editor.prependBlockParameter(block, spec);
	}

	appendInstruction(
		block: CoreBlockId,
		opcode: string,
		inputs: ReadonlyArray<CoreValueId>,
		options: AppendCoreInstructionOptions = {},
	): ReadonlyArray<CoreValueId> {
		return this.editor.appendInstruction(block, opcode, inputs, options).outputs;
	}

	setValueRepresentation(value: CoreValueId, representation: CoreRepresentation): void {
		this.editor.setValueRepresentation(value, representation);
	}

	setHandler(
		block: CoreBlockId,
		handlerBlock: CoreBlockId,
		arguments_: ReadonlyArray<CoreValueId> = [],
	): void {
		this.editor.setHandler(block, handlerBlock, arguments_);
	}

	setTerminator(block: CoreBlockId, terminator: CoreTerminatorInput): CoreInstructionId {
		return this.editor.setTerminator(block, terminator);
	}

	setGuardTerminator(block: CoreBlockId, input: SetCoreGuardTerminatorInput): CoreFactId {
		return this.editor.setGuardTerminator(block, input);
	}

	addFact(fact: Omit<CoreFact, "id">): CoreFactId {
		return this.editor.addFact(fact);
	}

	configureFunction(options: CoreFunctionOptions): void {
		this.editor.configureFunction(options);
	}

	finish(entry: CoreBlockId, bodyEntry?: CoreBlockId): FinishedCoreFunction {
		this.editor.finishFunction(entry, bodyEntry);
		return { function: this.functionId, changes: this.editor.commit() };
	}
}
