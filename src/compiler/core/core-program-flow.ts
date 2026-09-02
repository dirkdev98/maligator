import type { CoreFunctionId } from "./core-ir.ts";
import type { CoreOptimizationReportBuilder } from "./core-optimization-report.ts";
import {
	CORE_PROGRAM_FLOW_BODY,
	CORE_PROGRAM_FLOW_CALLS,
	CORE_PROGRAM_FLOW_CFG,
	CORE_PROGRAM_FLOW_EXCEPTION,
	CORE_PROGRAM_FLOW_FACTS,
	CORE_PROGRAM_FLOW_MEMORY,
	CORE_PROGRAM_FLOW_REPRESENTATIONS,
	CORE_PROGRAM_FLOW_SPECIALIZATION,
} from "./core-store.ts";
import type {
	CoreProgram,
	CoreProgramFlowDomainMask,
} from "./core-store.ts";

export type CoreProgramFlowDimensionMask = number;

export const CORE_PROGRAM_FLOW_TARGETS = 1 << 0;
export const CORE_PROGRAM_FLOW_EFFECTS = 1 << 1;
export const CORE_PROGRAM_FLOW_ESCAPE = 1 << 2;
export const CORE_PROGRAM_FLOW_CONTAINMENT = 1 << 3;
export const CORE_PROGRAM_FLOW_RETURN_PROVENANCE = 1 << 4;
export const CORE_PROGRAM_FLOW_RETURN_KIND = 1 << 5;
export const CORE_PROGRAM_FLOW_RETURN_REPRESENTATION = 1 << 6;
export const CORE_PROGRAM_FLOW_REACHABILITY = 1 << 7;

export const CORE_PROGRAM_FLOW_SUMMARIES =
	CORE_PROGRAM_FLOW_EFFECTS |
	CORE_PROGRAM_FLOW_ESCAPE |
	CORE_PROGRAM_FLOW_CONTAINMENT |
	CORE_PROGRAM_FLOW_RETURN_PROVENANCE |
	CORE_PROGRAM_FLOW_RETURN_REPRESENTATION;

const ALL_PROGRAM_FLOW_DIMENSIONS =
	CORE_PROGRAM_FLOW_TARGETS |
	CORE_PROGRAM_FLOW_EFFECTS |
	CORE_PROGRAM_FLOW_ESCAPE |
	CORE_PROGRAM_FLOW_CONTAINMENT |
	CORE_PROGRAM_FLOW_RETURN_PROVENANCE |
	CORE_PROGRAM_FLOW_RETURN_KIND |
	CORE_PROGRAM_FLOW_RETURN_REPRESENTATION |
	CORE_PROGRAM_FLOW_REACHABILITY;

export function coreProgramFlowDimensionsForDomains(
	domains: CoreProgramFlowDomainMask,
): CoreProgramFlowDimensionMask {
	let dimensions = 0;
	if (
		(domains &
			(CORE_PROGRAM_FLOW_BODY |
				CORE_PROGRAM_FLOW_CFG |
				CORE_PROGRAM_FLOW_EXCEPTION |
				CORE_PROGRAM_FLOW_CALLS |
				CORE_PROGRAM_FLOW_FACTS)) !==
		0
	)
		dimensions |= ALL_PROGRAM_FLOW_DIMENSIONS;
	if ((domains & CORE_PROGRAM_FLOW_MEMORY) !== 0) {
		dimensions |=
			CORE_PROGRAM_FLOW_EFFECTS |
			CORE_PROGRAM_FLOW_ESCAPE |
			CORE_PROGRAM_FLOW_CONTAINMENT |
			CORE_PROGRAM_FLOW_RETURN_PROVENANCE;
	}
	if ((domains & CORE_PROGRAM_FLOW_REPRESENTATIONS) !== 0) {
		dimensions |=
			CORE_PROGRAM_FLOW_RETURN_KIND | CORE_PROGRAM_FLOW_RETURN_REPRESENTATION;
	}
	if ((domains & CORE_PROGRAM_FLOW_SPECIALIZATION) !== 0) {
		dimensions |= CORE_PROGRAM_FLOW_RETURN_PROVENANCE;
	}
	return dimensions;
}

export class CoreProgramFlowEngine {
	readonly #program: CoreProgram;
	readonly #report: CoreOptimizationReportBuilder | undefined;
	#cursor = 0;
	#revision = 0;
	#epoch = 0;
	#membership = new Uint32Array(0);
	#domains = new Uint16Array(0);
	#dimensions = new Uint16Array(0);
	readonly #dirtyFunctions: Array<CoreFunctionId> = [];

	constructor(program: CoreProgram, report?: CoreOptimizationReportBuilder) {
		this.#program = program;
		this.#report = report;
	}

	get revision(): number {
		return this.#revision;
	}

	get dirtyFunctionCount(): number {
		return this.#dirtyFunctions.length;
	}

	refresh(): this {
		const revision = this.#program.programFlowRevision;
		if (revision === this.#revision) return this;
		this.#report?.increment("programFlowJournalEntries", revision - this.#cursor);
		this.#ensureCapacity(this.#program.functionCapacity);
		this.#epoch++;
		if (this.#epoch === 0xffff_ffff) {
			this.#membership.fill(0);
			this.#epoch = 1;
		}
		this.#dirtyFunctions.length = 0;
		for (let cursor = this.#cursor; cursor < revision; cursor++) {
			const functionId = this.#program.programFlowFunctionAt(cursor);
			const domains = this.#program.programFlowDomainMaskAt(cursor);
			if (this.#membership[functionId] !== this.#epoch) {
				this.#membership[functionId] = this.#epoch;
				this.#domains[functionId] = 0;
				this.#dimensions[functionId] = 0;
				this.#dirtyFunctions.push(functionId);
			}
			this.#domains[functionId] = this.#domains[functionId]! | domains;
			this.#dimensions[functionId] =
				this.#dimensions[functionId]! | coreProgramFlowDimensionsForDomains(domains);
		}
		this.#cursor = revision;
		this.#revision = revision;
		this.#report?.increment("programFlowDirtyFunctions", this.#dirtyFunctions.length);
		for (const functionId of this.#dirtyFunctions) {
			const dimensions = this.#dimensions[functionId]!;
			if ((dimensions & CORE_PROGRAM_FLOW_TARGETS) !== 0) {
				this.#report?.increment("programFlowTargetWakeups");
			}
			if ((dimensions & CORE_PROGRAM_FLOW_SUMMARIES) !== 0) {
				this.#report?.increment("programFlowSummaryWakeups");
			}
			if ((dimensions & CORE_PROGRAM_FLOW_RETURN_KIND) !== 0) {
				this.#report?.increment("programFlowValueKindWakeups");
			}
			if ((dimensions & CORE_PROGRAM_FLOW_REACHABILITY) !== 0) {
				this.#report?.increment("programFlowReachabilityWakeups");
			}
		}
		return this;
	}

	dirtyFunctionAt(index: number): CoreFunctionId {
		const functionId = this.#dirtyFunctions[index];
		if (functionId === undefined) throw new Error(`Unknown dirty function index ${index}`);
		return functionId;
	}

	dirtyDomains(functionId: CoreFunctionId): CoreProgramFlowDomainMask {
		return this.#membership[functionId] === this.#epoch ? this.#domains[functionId]! : 0;
	}

	dirtyDimensions(functionId: CoreFunctionId): CoreProgramFlowDimensionMask {
		return this.#membership[functionId] === this.#epoch
			? this.#dimensions[functionId]!
			: 0;
	}

	#ensureCapacity(capacity: number): void {
		if (this.#membership.length >= capacity) return;
		const membership = new Uint32Array(capacity);
		membership.set(this.#membership);
		this.#membership = membership;
		const domains = new Uint16Array(capacity);
		domains.set(this.#domains);
		this.#domains = domains;
		const dimensions = new Uint16Array(capacity);
		dimensions.set(this.#dimensions);
		this.#dimensions = dimensions;
	}
}
