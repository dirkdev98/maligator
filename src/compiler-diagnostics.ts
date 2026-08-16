import type { SourceSiteId, UnknownFactReason } from "./compiler-facts.ts";

export type CompilerDiagnosticCode =
	| "primordial.mutation"
	| `optimization.applied.${string}`
	| `optimization.declined.${UnknownFactReason}`;

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
