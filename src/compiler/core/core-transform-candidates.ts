import type { CoreFunctionId, CoreInstructionId } from "./core-ir.ts";

export type CoreTransformKind =
	| "static-argument-specialization"
	| "finite-dispatch"
	| "inline"
	| "guarded-inline"
	| "array-predicate-inline"
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
	| "builtin-collection-call-chain"
	| "array-values-iterator-cursor"
	| "string-iterator-cursor"
	| "typed-array-iterator-cursor"
	| "map-iterator-cursor"
	| "set-iterator-cursor"
	| "iterator-result-virtualization"
	| "iterator-entry-pair-virtualization"
	| "fresh-array-length"
	| "indexed-length-loop"
	| "function-call-chain"
	| "string-split-cursor";

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
	readonly exposure?: number;
	readonly kind: CoreTransformKind;
	readonly caller: CoreFunctionId;
	readonly site: CoreInstructionId;
	readonly revision: number;
	readonly priorityClass: number;
	readonly priorityScore: number;
	readonly targets: ReadonlyArray<CoreFunctionId>;
	readonly targetSetKind?: "closed" | "open-hints";
	readonly generatedCodeCost: number;
	readonly compilerWorkCost: number;
	readonly expansive: boolean;
	readonly unsupportedReason?: CoreTransformDeclineReason;
}

export interface CoreTransformDiscoveryCost {
	readonly exposure?: number;
	readonly caller: CoreFunctionId;
	// A lower bound for admission; discovery itself does not consume generated code.
	readonly generatedCodeCost: number;
	readonly compilerWorkCost: number;
}

export interface CoreTransformBudgetLimits {
	readonly perSiteExpansions: number;
	readonly perCallerExpansions: number;
	readonly perCallerGeneratedCode: number;
	readonly perCallerCompilerWork: number;
	readonly programGeneratedCode: number;
	readonly programCompilerWork: number;
	readonly profileUnknownWorkLimit?: number;
}

export const DEFAULT_CORE_TRANSFORM_BUDGETS: CoreTransformBudgetLimits = Object.freeze({
	perSiteExpansions: 1,
	perCallerExpansions: 64,
	perCallerGeneratedCode: 192,
	perCallerCompilerWork: 768,
	programGeneratedCode: 1_024,
	programCompilerWork: 16_384,
});

export const DEFAULT_CORE_SPECIALIZATION_BUDGETS: CoreTransformBudgetLimits =
	Object.freeze({
		perSiteExpansions: 1,
		perCallerExpansions: 64,
		perCallerGeneratedCode: 512,
		perCallerCompilerWork: 2_048,
		programGeneratedCode: 4_096,
		programCompilerWork: 32_768,
	});

export function coreProgramTransformBudgets(
	limits: CoreTransformBudgetLimits,
	liveInstructions: number,
): CoreTransformBudgetLimits {
	// Keep optimization density stable as reachable code grows, without inflating individual bodies.
	const scale = Math.max(1, liveInstructions / 32_768);
	return Object.freeze({
		...limits,
		programGeneratedCode: Math.ceil(limits.programGeneratedCode * scale),
		programCompilerWork: Math.ceil(limits.programCompilerWork * scale),
	});
}

export const CORE_SPECIALIZATION_EXPANSIONS_PER_FUNCTION = 4;

export interface CoreTransformBudgetStatistics {
	readonly considered: number;
	readonly applied: number;
	readonly declined: number;
	readonly appliedByKind: Readonly<Record<CoreTransformKind, number>>;
	readonly declinedByReason: Readonly<Record<CoreTransformDeclineReason, number>>;
	readonly generatedCodeConsumed: number;
	readonly compilerWorkConsumed: number;
	readonly profileBudget?: CoreProfileBudgetStatistics;
}

export interface CoreProfileBudgetStatistics {
	readonly unknown: Readonly<{
		compilerWorkConsumed: number;
		generatedCodeConsumed: number;
	}>;
	readonly measured: Readonly<{
		compilerWorkConsumed: number;
		generatedCodeConsumed: number;
	}>;
	readonly unknownWorkLimit: number;
	readonly unknownCodeLimit: number;
	readonly measuredWorkLimit: number;
	readonly measuredCodeLimit: number;
}

interface CallerConsumption {
	expansions: number;
	generatedCode: number;
	compilerWork: number;
}

function transformKindCounts(): Record<CoreTransformKind, number> {
	return {
		"static-argument-specialization": 0,
		"finite-dispatch": 0,
		inline: 0,
		"guarded-inline": 0,
		"array-predicate-inline": 0,
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
		"array-values-iterator-cursor": 0,
		"string-iterator-cursor": 0,
		"typed-array-iterator-cursor": 0,
		"map-iterator-cursor": 0,
		"set-iterator-cursor": 0,
		"iterator-result-virtualization": 0,
		"iterator-entry-pair-virtualization": 0,
		"fresh-array-length": 0,
		"indexed-length-loop": 0,
		"function-call-chain": 0,
		"string-split-cursor": 0,
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
	if ((left.exposure === undefined) !== (right.exposure === undefined))
		return left.exposure !== undefined;
	if (left.priorityClass !== right.priorityClass)
		return left.priorityClass < right.priorityClass;
	if (left.priorityScore !== right.priorityScore)
		return left.priorityScore < right.priorityScore;
	if (left.caller !== right.caller) return left.caller < right.caller;
	if (left.site !== right.site) return left.site < right.site;
	if (left.kind !== right.kind) return left.kind < right.kind;
	const count = Math.min(left.targets.length, right.targets.length);
	for (let index = 0; index < count; index++) {
		if (left.targets[index] !== right.targets[index])
			return left.targets[index]! < right.targets[index]!;
	}
	return left.targets.length < right.targets.length;
}

function roundRobinByCaller<Value extends { readonly caller: CoreFunctionId }>(
	values: ReadonlyArray<Value>,
): Array<Value> {
	const groups = new Map<CoreFunctionId, Array<Value>>();
	for (const value of values) {
		const group = groups.get(value.caller);
		if (group === undefined) groups.set(value.caller, [value]);
		else group.push(value);
	}
	const ordered: Array<Value> = [];
	let active = [...groups.values()];
	for (let index = 0; active.length > 0; index++) {
		const next: Array<Array<Value>> = [];
		for (const group of active) {
			ordered.push(group[index]!);
			if (group.length > index + 1) next.push(group);
		}
		active = next;
	}
	return ordered;
}

function sameCandidateIdentity(
	left: CoreTransformCandidate,
	right: CoreTransformCandidate,
): boolean {
	return (
		left.kind === right.kind &&
		left.targetSetKind === right.targetSetKind &&
		left.revision === right.revision &&
		left.targets.length === right.targets.length &&
		left.targets.every((target, index) => target === right.targets[index])
	);
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
	readonly #known = new Map<
		CoreFunctionId,
		Map<CoreInstructionId, Array<CoreTransformCandidate>>
	>();
	readonly #queue: Array<CoreTransformCandidate> = [];
	#fairQueue: Array<CoreTransformCandidate> = [];
	#fairCursor = 0;
	readonly #appliedByKind = transformKindCounts();
	readonly #declinedByReason = declineReasonCounts();
	readonly #siteExpansions = new Map<CoreFunctionId, Map<CoreInstructionId, number>>();
	readonly #caller = new Map<CoreFunctionId, CallerConsumption>();
	#considered = 0;
	#applied = 0;
	#declined = 0;
	#generatedCode = 0;
	#compilerWork = 0;
	#profileScheduling = false;
	readonly #unknownUse = { work: 0, code: 0 };
	readonly #measuredUse = { work: 0, code: 0 };
	enablePgoScheduling(): void {
		this.#profileScheduling = true;
	}
	#profileBudget(
		cost: CoreTransformDiscoveryCost,
	): CoreTransformDeclineReason | undefined {
		if (!this.#profileScheduling) return undefined;
		const unknown = cost.exposure === undefined;
		const used = unknown ? this.#unknownUse : this.#measuredUse;
		const work =
			this.#limits.profileUnknownWorkLimit ??
			Math.floor(this.#limits.programCompilerWork * 0.2);
		const code = Math.floor(this.#limits.programGeneratedCode * 0.2);
		if (
			used.work + cost.compilerWorkCost >
			(unknown ? work : this.#limits.programCompilerWork - work)
		)
			return "compiler-work-cost";
		if (
			used.code + cost.generatedCodeCost >
			(unknown ? code : this.#limits.programGeneratedCode - code)
		)
			return "generated-code-cost";
		return undefined;
	}
	#recordProfile(cost: CoreTransformDiscoveryCost, applied: boolean): void {
		if (!this.#profileScheduling) return;
		const used = cost.exposure === undefined ? this.#unknownUse : this.#measuredUse;
		used.work += cost.compilerWorkCost;
		if (applied) used.code += cost.generatedCodeCost;
	}

	constructor(limits: CoreTransformBudgetLimits = DEFAULT_CORE_TRANSFORM_BUDGETS) {
		this.#limits = limits;
	}

	orderDiscovery<Opportunity extends { readonly caller: CoreFunctionId }>(
		opportunities: ReadonlyArray<Opportunity>,
	): ReadonlyArray<Opportunity> {
		return this.#profileScheduling ? opportunities : roundRobinByCaller(opportunities);
	}

	offer(candidate: CoreTransformCandidate): boolean {
		const caller =
			this.#known.get(candidate.caller) ??
			new Map<CoreInstructionId, Array<CoreTransformCandidate>>();
		const known = caller.get(candidate.site) ?? [];
		if (known.some((prior) => sameCandidateIdentity(prior, candidate))) return false;
		known.push(candidate);
		caller.set(candidate.site, known);
		this.#known.set(candidate.caller, caller);
		pushCandidate(this.#queue, candidate);
		this.#considered++;
		return true;
	}

	next(): CoreTransformCandidate | undefined {
		if (this.#profileScheduling) return popCandidate(this.#queue);
		if (this.#fairCursor < this.#fairQueue.length && this.#queue.length === 0)
			return this.#fairQueue[this.#fairCursor++];
		const candidates = this.#fairQueue.slice(this.#fairCursor);
		for (
			let candidate = popCandidate(this.#queue);
			candidate !== undefined;
			candidate = popCandidate(this.#queue)
		)
			candidates.push(candidate);
		if (this.#fairCursor < this.#fairQueue.length)
			candidates.sort((left, right) =>
				candidatePrecedes(left, right) ? -1 : candidatePrecedes(right, left) ? 1 : 0,
			);
		this.#fairQueue = roundRobinByCaller(candidates);
		this.#fairCursor = 0;
		const next = this.#fairQueue[0];
		if (next !== undefined) this.#fairCursor = 1;
		return next;
	}

	beginPhase(): void {
		if (this.#queue.length !== 0 || this.#fairCursor < this.#fairQueue.length) {
			throw new Error("Cannot begin a Core transform phase with pending candidates");
		}
		this.#known.clear();
	}

	#activeLimits(limits?: CoreTransformBudgetLimits): CoreTransformBudgetLimits {
		if (limits === undefined) return this.#limits;
		return {
			perSiteExpansions: Math.min(
				this.#limits.perSiteExpansions,
				limits.perSiteExpansions,
			),
			perCallerExpansions: Math.min(
				this.#limits.perCallerExpansions,
				limits.perCallerExpansions,
			),
			perCallerGeneratedCode: Math.min(
				this.#limits.perCallerGeneratedCode,
				limits.perCallerGeneratedCode,
			),
			perCallerCompilerWork: Math.min(
				this.#limits.perCallerCompilerWork,
				limits.perCallerCompilerWork,
			),
			programGeneratedCode: Math.min(
				this.#limits.programGeneratedCode,
				limits.programGeneratedCode,
			),
			programCompilerWork: Math.min(
				this.#limits.programCompilerWork,
				limits.programCompilerWork,
			),
		};
	}

	programBudgetExhaustionReason(
		limits?: CoreTransformBudgetLimits,
	): CoreTransformDeclineReason | undefined {
		const active = this.#activeLimits(limits);
		if (this.#generatedCode >= active.programGeneratedCode) {
			return "generated-code-cost";
		}
		if (this.#compilerWork >= active.programCompilerWork) {
			return "compiler-work-cost";
		}
		return undefined;
	}

	discardPending(reason: CoreTransformDeclineReason): number {
		let discarded = 0;
		while (this.next() !== undefined) {
			this.recordDeclined(reason);
			discarded++;
		}
		return discarded;
	}

	admit(
		candidate: CoreTransformCandidate,
		limits?: CoreTransformBudgetLimits,
	): CoreTransformDeclineReason | undefined {
		if (candidate.unsupportedReason !== undefined) return candidate.unsupportedReason;
		const profileReason = this.#profileBudget(candidate);
		if (profileReason !== undefined) return profileReason;
		const active = this.#activeLimits(limits);
		const caller = this.#caller.get(candidate.caller) ?? {
			expansions: 0,
			generatedCode: 0,
			compilerWork: 0,
		};
		if (candidate.expansive) {
			const siteExpansions = this.#siteExpansions.get(candidate.caller);
			if (
				(siteExpansions?.get(candidate.site) ?? 0) >= active.perSiteExpansions ||
				caller.expansions >= active.perCallerExpansions
			)
				return "expansion-limit";
		}
		if (
			caller.generatedCode + candidate.generatedCodeCost >
				active.perCallerGeneratedCode ||
			this.#generatedCode + candidate.generatedCodeCost > active.programGeneratedCode
		)
			return "generated-code-cost";
		if (
			caller.compilerWork + candidate.compilerWorkCost > active.perCallerCompilerWork ||
			this.#compilerWork + candidate.compilerWorkCost > active.programCompilerWork
		)
			return "compiler-work-cost";
		return undefined;
	}

	admitDiscovery(
		cost: CoreTransformDiscoveryCost,
	): CoreTransformDeclineReason | undefined {
		const profileReason = this.#profileBudget(cost);
		if (profileReason !== undefined) return profileReason;
		const active = this.#limits;
		const caller = this.#caller.get(cost.caller);
		if (
			(caller?.generatedCode ?? 0) + cost.generatedCodeCost >
				active.perCallerGeneratedCode ||
			this.#generatedCode + cost.generatedCodeCost > active.programGeneratedCode
		)
			return "generated-code-cost";
		if (
			(caller?.compilerWork ?? 0) + cost.compilerWorkCost >
				active.perCallerCompilerWork ||
			this.#compilerWork + cost.compilerWorkCost > active.programCompilerWork
		)
			return "compiler-work-cost";
		return undefined;
	}

	recordDiscovery(cost: CoreTransformDiscoveryCost): void {
		this.#recordProfile(cost, false);
		const caller = this.#caller.get(cost.caller) ?? {
			expansions: 0,
			generatedCode: 0,
			compilerWork: 0,
		};
		caller.compilerWork += cost.compilerWorkCost;
		this.#caller.set(cost.caller, caller);
		this.#compilerWork += cost.compilerWorkCost;
	}

	recordApplied(candidate: CoreTransformCandidate): void {
		this.#recordProfile(candidate, true);
		const caller = this.#caller.get(candidate.caller) ?? {
			expansions: 0,
			generatedCode: 0,
			compilerWork: 0,
		};
		if (candidate.expansive) {
			caller.expansions++;
			const siteExpansions =
				this.#siteExpansions.get(candidate.caller) ??
				new Map<CoreInstructionId, number>();
			siteExpansions.set(candidate.site, (siteExpansions.get(candidate.site) ?? 0) + 1);
			this.#siteExpansions.set(candidate.caller, siteExpansions);
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
		const unknownWorkLimit =
			this.#limits.profileUnknownWorkLimit ??
			Math.floor(this.#limits.programCompilerWork * 0.2);
		const unknownCodeLimit = Math.floor(this.#limits.programGeneratedCode * 0.2);
		return Object.freeze({
			considered: this.#considered,
			applied: this.#applied,
			declined: this.#declined,
			appliedByKind: Object.freeze({ ...this.#appliedByKind }),
			declinedByReason: Object.freeze({ ...this.#declinedByReason }),
			generatedCodeConsumed: this.#generatedCode,
			compilerWorkConsumed: this.#compilerWork,
			...(this.#profileScheduling
				? {
						profileBudget: Object.freeze({
							unknown: Object.freeze({
								compilerWorkConsumed: this.#unknownUse.work,
								generatedCodeConsumed: this.#unknownUse.code,
							}),
							measured: Object.freeze({
								compilerWorkConsumed: this.#measuredUse.work,
								generatedCodeConsumed: this.#measuredUse.code,
							}),
							unknownWorkLimit,
							unknownCodeLimit,
							measuredWorkLimit: this.#limits.programCompilerWork - unknownWorkLimit,
							measuredCodeLimit: this.#limits.programGeneratedCode - unknownCodeLimit,
						}),
					}
				: {}),
		});
	}

	statisticsSince(
		baseline: CoreTransformBudgetStatistics,
	): CoreTransformBudgetStatistics {
		const subtractCounts = <Key extends string>(
			current: Readonly<Record<Key, number>>,
			prior: Readonly<Record<Key, number>>,
		): Readonly<Record<Key, number>> =>
			Object.freeze(
				Object.fromEntries(
					Object.entries(current).map(([key, value]) => [
						key,
						(value as number) - (prior[key as Key] ?? 0),
					]),
				) as Record<Key, number>,
			);
		const current = this.statistics();
		return Object.freeze({
			considered: current.considered - baseline.considered,
			applied: current.applied - baseline.applied,
			declined: current.declined - baseline.declined,
			appliedByKind: subtractCounts(current.appliedByKind, baseline.appliedByKind),
			declinedByReason: subtractCounts(
				current.declinedByReason,
				baseline.declinedByReason,
			),
			generatedCodeConsumed:
				current.generatedCodeConsumed - baseline.generatedCodeConsumed,
			compilerWorkConsumed: current.compilerWorkConsumed - baseline.compilerWorkConsumed,
			...(current.profileBudget === undefined
				? {}
				: {
						profileBudget: Object.freeze({
							unknown: Object.freeze({
								compilerWorkConsumed:
									current.profileBudget.unknown.compilerWorkConsumed -
									(baseline.profileBudget?.unknown.compilerWorkConsumed ?? 0),
								generatedCodeConsumed:
									current.profileBudget.unknown.generatedCodeConsumed -
									(baseline.profileBudget?.unknown.generatedCodeConsumed ?? 0),
							}),
							measured: Object.freeze({
								compilerWorkConsumed:
									current.profileBudget.measured.compilerWorkConsumed -
									(baseline.profileBudget?.measured.compilerWorkConsumed ?? 0),
								generatedCodeConsumed:
									current.profileBudget.measured.generatedCodeConsumed -
									(baseline.profileBudget?.measured.generatedCodeConsumed ?? 0),
							}),
							unknownWorkLimit: current.profileBudget.unknownWorkLimit,
							unknownCodeLimit: current.profileBudget.unknownCodeLimit,
							measuredWorkLimit: current.profileBudget.measuredWorkLimit,
							measuredCodeLimit: current.profileBudget.measuredCodeLimit,
						}),
					}),
		});
	}
}
