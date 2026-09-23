import type { ConstructedCoreCompilation } from "./core-compilation.ts";
import type { CoreFunctionId, CoreInstructionId } from "./core-ir.ts";

export interface CorePgoHints {
	readonly digest: string;
	readonly measuredWorkBonusPercent?: number;
	functionEntries(id: CoreFunctionId): number | undefined;
	functionCpuCost?(id: CoreFunctionId): number | undefined;
	callAttempts(id: CoreFunctionId, instruction: CoreInstructionId): number | undefined;
	guardedCallHits?(
		id: CoreFunctionId,
		instruction: CoreInstructionId,
		targets: ReadonlyArray<CoreFunctionId>,
	): number | undefined;
	/** Counts only distinct identities the optimizer queried. */
	queryCoverage?(): CorePgoQueryCoverage;
}

export interface CorePgoQueryCoverage {
	readonly functions: Readonly<
		Record<
			| "positive"
			| "zero"
			| "unmatchedRevision"
			| "untrainedOrigin"
			| "missingOrigin"
			| "unsupportedBody",
			number
		>
	>;
	readonly calls: Readonly<
		Record<
			| "positive"
			| "zero"
			| "unmatchedProfile"
			| "missingSite"
			| "missingOrigin"
			| "ownerMismatch",
			number
		>
	>;
	readonly targets: Readonly<Record<"positive" | "zero" | "unknown", number>>;
}

export interface CorePgoInput {
	readonly digest: string;
	readonly policy: string;
	bind(compilation: ConstructedCoreCompilation): CorePgoHints;
}
