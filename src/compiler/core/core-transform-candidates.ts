import type { CoreFunctionId, CoreInstructionId } from "./core-ir.ts";

export type CoreTransformKind =
	| "call-refresh"
	| "finite-dispatch"
	| "inline"
	| "guarded-inline"
	| "direct-entry"
	| "guarded-direct-call"
	| "stack-object-plan"
	| "dense-array-plan"
	| "numeric-fusion"
	| "string-split-projection"
	| "string-slice-number"
	| "regexp-exec-projection"
	| "regexp-iterator-projection"
	| "string-char-code-at-chain"
	| "builtin-collection-call-chain";

export type CoreTransformDeclineReason =
	| "expansion-limit"
	| "generated-code-cost"
	| "compiler-work-cost"
	| "unsupported-graph"
	| "recursive"
	| "overlap"
	| "stale-anchor"
	| "representation"
	| "target-support";

export interface CoreTransformCandidate {
	readonly key: string;
	readonly kind: CoreTransformKind;
	readonly caller: CoreFunctionId;
	readonly site: CoreInstructionId;
	readonly targets: ReadonlyArray<CoreFunctionId>;
	readonly generatedCodeCost: number;
	readonly compilerWorkCost: number;
	readonly expansive: boolean;
	readonly unsupportedReason?: CoreTransformDeclineReason;
}

export interface CoreTransformBudgetLimits {
	readonly perSiteExpansions: number;
	readonly perCallerExpansions: number;
	readonly perCallerGeneratedCode: number;
	readonly perCallerCompilerWork: number;
	readonly programGeneratedCode: number;
	readonly programCompilerWork: number;
}

export const DEFAULT_CORE_TRANSFORM_BUDGETS: CoreTransformBudgetLimits = Object.freeze({
	perSiteExpansions: 1,
	perCallerExpansions: 64,
	perCallerGeneratedCode: 192,
	perCallerCompilerWork: 768,
	programGeneratedCode: 1_024,
	programCompilerWork: 16_384,
});

export interface CoreTransformBudgetStatistics {
	readonly considered: number;
	readonly applied: number;
	readonly declined: number;
	readonly appliedByKind: Readonly<Record<CoreTransformKind, number>>;
	readonly declinedByReason: Readonly<Record<CoreTransformDeclineReason, number>>;
	readonly generatedCodeConsumed: number;
	readonly compilerWorkConsumed: number;
}

interface CallerConsumption {
	expansions: number;
	generatedCode: number;
	compilerWork: number;
}

function transformKindCounts(): Record<CoreTransformKind, number> {
	return {
		"call-refresh": 0,
		"finite-dispatch": 0,
		inline: 0,
		"guarded-inline": 0,
		"direct-entry": 0,
		"guarded-direct-call": 0,
		"stack-object-plan": 0,
		"dense-array-plan": 0,
		"numeric-fusion": 0,
		"string-split-projection": 0,
		"string-slice-number": 0,
		"regexp-exec-projection": 0,
		"regexp-iterator-projection": 0,
		"string-char-code-at-chain": 0,
		"builtin-collection-call-chain": 0,
	};
}

function declineReasonCounts(): Record<CoreTransformDeclineReason, number> {
	return {
		"expansion-limit": 0,
		"generated-code-cost": 0,
		"compiler-work-cost": 0,
		"unsupported-graph": 0,
		recursive: 0,
		overlap: 0,
		"stale-anchor": 0,
		representation: 0,
		"target-support": 0,
	};
}

function candidatePrecedes(
	left: CoreTransformCandidate,
	right: CoreTransformCandidate,
): boolean {
	return left.key < right.key;
}

function pushCandidate(
	heap: Array<CoreTransformCandidate>,
	candidate: CoreTransformCandidate,
): void {
	let index = heap.length;
	heap.push(candidate);
	while (index > 0) {
		const parent = Math.floor((index - 1) / 2);
		if (!candidatePrecedes(candidate, heap[parent]!)) break;
		heap[index] = heap[parent]!;
		index = parent;
	}
	heap[index] = candidate;
}

function popCandidate(
	heap: Array<CoreTransformCandidate>,
): CoreTransformCandidate | undefined {
	const first = heap[0];
	const last = heap.pop();
	if (first === undefined || last === undefined || heap.length === 0) return first;
	let index = 0;
	while (true) {
		const left = index * 2 + 1;
		if (left >= heap.length) break;
		const right = left + 1;
		const child =
			right < heap.length && candidatePrecedes(heap[right]!, heap[left]!) ? right : left;
		if (!candidatePrecedes(heap[child]!, last)) break;
		heap[index] = heap[child]!;
		index = child;
	}
	heap[index] = last;
	return first;
}

export class CoreTransformCandidateService {
	readonly #limits: CoreTransformBudgetLimits;
	readonly #known = new Set<string>();
	readonly #queue: Array<CoreTransformCandidate> = [];
	readonly #appliedByKind = transformKindCounts();
	readonly #declinedByReason = declineReasonCounts();
	readonly #siteExpansions = new Map<string, number>();
	readonly #caller = new Map<CoreFunctionId, CallerConsumption>();
	#considered = 0;
	#applied = 0;
	#declined = 0;
	#generatedCode = 0;
	#compilerWork = 0;

	constructor(limits: CoreTransformBudgetLimits = DEFAULT_CORE_TRANSFORM_BUDGETS) {
		this.#limits = limits;
	}

	offer(candidate: CoreTransformCandidate): boolean {
		if (this.#known.has(candidate.key)) return false;
		this.#known.add(candidate.key);
		pushCandidate(this.#queue, candidate);
		this.#considered++;
		return true;
	}

	next(): CoreTransformCandidate | undefined {
		return popCandidate(this.#queue);
	}

	admit(candidate: CoreTransformCandidate): CoreTransformDeclineReason | undefined {
		if (candidate.unsupportedReason !== undefined) return candidate.unsupportedReason;
		const caller = this.#caller.get(candidate.caller) ?? {
			expansions: 0,
			generatedCode: 0,
			compilerWork: 0,
		};
		if (candidate.expansive) {
			const siteKey = `${candidate.caller}:${candidate.site}`;
			if (
				(this.#siteExpansions.get(siteKey) ?? 0) >= this.#limits.perSiteExpansions ||
				caller.expansions >= this.#limits.perCallerExpansions
			)
				return "expansion-limit";
		}
		if (
			caller.generatedCode + candidate.generatedCodeCost >
				this.#limits.perCallerGeneratedCode ||
			this.#generatedCode + candidate.generatedCodeCost >
				this.#limits.programGeneratedCode
		)
			return "generated-code-cost";
		if (
			caller.compilerWork + candidate.compilerWorkCost >
				this.#limits.perCallerCompilerWork ||
			this.#compilerWork + candidate.compilerWorkCost > this.#limits.programCompilerWork
		)
			return "compiler-work-cost";
		return undefined;
	}

	recordApplied(candidate: CoreTransformCandidate): void {
		const caller = this.#caller.get(candidate.caller) ?? {
			expansions: 0,
			generatedCode: 0,
			compilerWork: 0,
		};
		if (candidate.expansive) {
			caller.expansions++;
			const siteKey = `${candidate.caller}:${candidate.site}`;
			this.#siteExpansions.set(siteKey, (this.#siteExpansions.get(siteKey) ?? 0) + 1);
		}
		caller.generatedCode += candidate.generatedCodeCost;
		caller.compilerWork += candidate.compilerWorkCost;
		this.#caller.set(candidate.caller, caller);
		this.#generatedCode += candidate.generatedCodeCost;
		this.#compilerWork += candidate.compilerWorkCost;
		this.#applied++;
		this.#appliedByKind[candidate.kind]++;
	}

	recordDeclined(reason: CoreTransformDeclineReason): void {
		this.#declined++;
		this.#declinedByReason[reason]++;
	}

	statistics(): CoreTransformBudgetStatistics {
		return Object.freeze({
			considered: this.#considered,
			applied: this.#applied,
			declined: this.#declined,
			appliedByKind: Object.freeze({ ...this.#appliedByKind }),
			declinedByReason: Object.freeze({ ...this.#declinedByReason }),
			generatedCodeConsumed: this.#generatedCode,
			compilerWorkConsumed: this.#compilerWork,
		});
	}
}
