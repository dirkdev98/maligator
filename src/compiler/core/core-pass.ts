import type {
	CoreAnalysisDefinition,
	CoreAnalysisManager,
} from "./core-analysis-manager.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import type { CoreFunctionFeatureBits } from "./core-function-features.ts";
import type { CoreFunctionOpcodeSites } from "./core-function-opcode-sites.ts";
import type { CoreFunctionId, CoreInstructionId, CoreOpcodeId } from "./core-ir.ts";
import type {
	CoreChangeDomain,
	CoreChangeSet,
	CoreFunctionStore,
	CoreProgram,
	CoreProgramChangeDomain,
} from "./core-store.ts";

export type CoreOptimizationStage =
	| "canonicalize"
	| "control-flow"
	| "proofs"
	| "memory"
	| "interprocedural"
	| "finalize";

export type CorePassWakeKind = CoreChangeDomain | CoreProgramChangeDomain;

export interface CoreFunctionPassWorkItem {
	readonly function: CoreFunctionId;
}

export interface CorePassBudget {
	readonly maxWorkItems: number;
	readonly maxEdits: number;
	readonly exhaustion: "stop" | "error";
}

export class CoreOptimizationBudgetError extends Error {}

export interface CorePassCapabilities {
	readonly cfg: boolean;
	readonly calls: boolean;
	readonly facts: boolean;
	readonly representations: boolean;
}

export interface CoreFunctionPassContext {
	readonly program: CoreProgram;
	readonly compilationContext: CoreCompilationContext;
	readonly item: CoreFunctionPassWorkItem;
	readonly remainingEdits: number;
	deferForBudget(): void;
	analysis<Result>(definition: CoreAnalysisDefinition<Result>): Result;
	instructions(): Iterable<CoreInstructionId>;
}

export interface CoreFunctionPassAdmissionContext {
	readonly program: CoreProgram;
	readonly compilationContext: CoreCompilationContext;
	readonly function: CoreFunctionId;
}

export interface CoreFunctionPassAdmission {
	readonly predicate: string;
	hasOpportunity(context: CoreFunctionPassAdmissionContext): boolean;
}

type RunFunctionPass = (context: CoreFunctionPassContext) => CoreChangeSet | undefined;

interface CoreFunctionPassPreparation {
	readonly predicate: string;
	// The prepared execution belongs to one dequeued function snapshot. The
	// scheduler consumes it before any other pass can edit that snapshot.
	prepare(
		context: CoreFunctionPassAdmissionContext,
		candidates: ReadonlyArray<CoreInstructionId> | undefined,
	): RunFunctionPass | undefined;
}

interface CoreFunctionPassDefinition {
	readonly name: string;
	readonly stage: CoreOptimizationStage;
	readonly requiredFunctionFeatures?: CoreFunctionFeatureBits;
	readonly requiredFunctionOpcodesAny?: ReadonlyArray<string>;
	readonly candidates?: {
		readonly dependencies: ReadonlyArray<CoreChangeDomain>;
		readonly opcodes: ReadonlyArray<string>;
		matches?(
			this: void,
			fn: CoreFunctionStore,
			instruction: CoreInstructionId,
			opcode: string,
		): boolean;
	};
	readonly requiredAnalyses: ReadonlyArray<CoreAnalysisDefinition<unknown>>;
	readonly wakesOn: ReadonlyArray<CorePassWakeKind>;
	readonly changes: CorePassCapabilities;
	readonly budget: CorePassBudget;
}

export type CoreFunctionPass = CoreFunctionPassDefinition &
	(
		| { readonly admission?: CoreFunctionPassAdmission; readonly run: RunFunctionPass }
		| { readonly admission: CoreFunctionPassPreparation; readonly run?: never }
	);

export class CoreFunctionPassContextDriver implements CoreFunctionPassContext {
	readonly program: CoreProgram;
	readonly compilationContext: CoreCompilationContext;
	readonly item: CoreFunctionPassWorkItem;
	readonly #analyses: CoreAnalysisManager;
	readonly #pass: CoreFunctionPass;
	#remainingEdits = 0;
	readonly #candidateIndex:
		| {
				readonly opcodes: ReadonlyArray<CoreOpcodeId>;
				sites: CoreFunctionOpcodeSites | undefined;
				readonly versions: Array<number>;
				instructions: ReadonlyArray<CoreInstructionId>;
				matches: ReadonlyArray<CoreInstructionId>;
		  }
		| undefined;

	constructor(
		program: CoreProgram,
		compilationContext: CoreCompilationContext,
		analyses: CoreAnalysisManager,
		pass: CoreFunctionPass,
		functionId: CoreFunctionId,
	) {
		this.program = program;
		this.compilationContext = compilationContext;
		this.#analyses = analyses;
		this.#pass = pass;
		this.item = Object.freeze({ function: functionId });
		if (pass.candidates !== undefined) {
			const opcodes = new Set<CoreOpcodeId>();
			for (const opcode of pass.candidates.opcodes) {
				const descriptor = program.registry.get(opcode);
				if (descriptor !== undefined) opcodes.add(descriptor.id);
			}
			this.#candidateIndex = {
				opcodes: [...opcodes],
				sites: undefined,
				versions: [],
				instructions: [],
				matches: [],
			};
		}
	}

	get remainingEdits(): number {
		return this.#remainingEdits;
	}

	instructions(): Iterable<CoreInstructionId> {
		return (
			this.candidateInstructions() ??
			this.program.function(this.item.function).instructionIds()
		);
	}

	candidateInstructions(): ReadonlyArray<CoreInstructionId> | undefined {
		const index = this.#candidateIndex;
		if (index === undefined) return undefined;
		const fn = this.program.function(this.item.function);
		const selector = this.#pass.candidates!;
		const sites = fn.opcodeSites();
		let current = index.sites === sites;
		if (!current) {
			index.sites = sites;
			index.instructions = sites.instructions(index.opcodes);
			index.versions.length = 0;
		}
		const matches = selector.matches;
		if (matches === undefined) return index.instructions;
		for (
			let dependency = 0;
			current && dependency < selector.dependencies.length;
			dependency++
		) {
			current =
				index.versions[dependency] === fn.version(selector.dependencies[dependency]!);
		}
		if (!current) {
			index.matches = index.instructions.filter((instruction) =>
				matches(fn, instruction, fn.instructionOpcodeName(instruction)),
			);
			for (let dependency = 0; dependency < selector.dependencies.length; dependency++) {
				index.versions[dependency] = fn.version(selector.dependencies[dependency]!);
			}
		}
		return index.matches;
	}

	prepare(remainingEdits: number): CoreFunctionPassContext {
		this.#remainingEdits = remainingEdits;
		return this;
	}

	deferForBudget(): void {
		if (this.#pass.budget.exhaustion === "error")
			throw new CoreOptimizationBudgetError(
				`Required Core pass ${this.#pass.name} exhausted its work budget`,
			);
	}

	analysis<Result>(definition: CoreAnalysisDefinition<Result>): Result {
		if (definition.scope !== "function") {
			throw new Error(
				`Core function pass ${this.#pass.name} queried ${definition.scope}-scoped analysis ${definition.key}`,
			);
		}
		let declared = false;
		for (const allowed of this.#pass.requiredAnalyses) {
			if (allowed.key !== definition.key) continue;
			declared = true;
			break;
		}
		if (!declared) {
			throw new Error(
				`Core pass ${this.#pass.name} queried undeclared analysis ${definition.key}`,
			);
		}
		return this.#analyses.get(definition, {
			scope: "function",
			function: this.item.function,
		});
	}
}
