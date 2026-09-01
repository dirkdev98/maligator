import type { SourceSiteId, UnknownFactReason } from "./compiler-facts.ts";

export type CompilerDiagnosticCode =
	| "primordial.mutation"
	| `optimization.applied.${string}`
	| `optimization.declined.${UnknownFactReason}`;

export interface CompilerFactFlowEvent {
	readonly phase:
		| "core-optimization"
		| "core-to-execution"
		| "runtime-output"
		| "native-output";
	readonly disposition: "produced" | "consumed" | "narrowed" | "dropped";
	readonly artifact: string;
	readonly functionIndex?: number;
	readonly instructionIndex?: number;
	readonly targetFunctionIndex?: number;
	readonly targetFunctionIndices?: ReadonlyArray<number>;
	readonly reason?:
		| "unsupported-consumer"
		| "instruction-elided"
		| "representation-mismatch";
}

export interface CompilerFactFlowEntry {
	readonly family: "call-targets";
	readonly siteId: string;
	readonly sourceSite?: SourceSiteId;
	readonly functions: ReadonlyArray<number>;
	readonly anyScript: boolean;
	readonly opaque: boolean;
	readonly events: ReadonlyArray<CompilerFactFlowEvent>;
}

/** Deterministic, tooling-only account of facts that reach or miss final outputs. */
export interface CompilerFactFlowReport {
	readonly schema: 1;
	readonly entries: ReadonlyArray<CompilerFactFlowEntry>;
	readonly summary: Readonly<
		Record<"produced" | "consumed" | "narrowed" | "dropped", number>
	>;
}

export interface CompilerDiagnostic {
	readonly code: CompilerDiagnosticCode;
	readonly severity: "warning" | "remark";
	readonly message: string;
	readonly path: string;
	readonly line: number;
	readonly column: number;
	readonly siteId: SourceSiteId;
}

export function compareCompilerDiagnostics(
	left: CompilerDiagnostic,
	right: CompilerDiagnostic,
): number {
	return (
		left.path.localeCompare(right.path) ||
		left.line - right.line ||
		left.column - right.column ||
		left.code.localeCompare(right.code)
	);
}
