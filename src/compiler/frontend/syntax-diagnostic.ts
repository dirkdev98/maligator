export type SyntaxDiagnosticPhase = "parse" | "resolution";

interface SourcePosition {
	readonly line: number;
	readonly column: number;
}

/** One-based source coordinates. The end, when present, is exclusive. */
export interface SyntaxDiagnosticLocation extends SourcePosition {
	readonly file: string;
	readonly end?: SourcePosition;
}

/** A language rejection with its semantic phase, independent of compiler staging. */
export class SyntaxDiagnostic extends SyntaxError {
	readonly phase: SyntaxDiagnosticPhase;
	readonly location?: SyntaxDiagnosticLocation;
	readonly sourceLine?: string;

	constructor(
		phase: SyntaxDiagnosticPhase,
		message: string,
		options?: ErrorOptions & { location?: SyntaxDiagnosticLocation; sourceLine?: string },
	) {
		super(message, options);
		this.phase = phase;
		this.location = options?.location;
		this.sourceLine = options?.sourceLine;
	}
}

export function formatSyntaxDiagnostic(error: SyntaxDiagnostic, color: boolean): string {
	const { location, sourceLine } = error;
	if (location === undefined) return `error: ${error.message}`;

	const heading = `${location.file}:${location.line}:${location.column}: ${error.message}`;
	if (sourceLine === undefined) return heading;

	const column = Math.min(location.column - 1, sourceLine.length);
	const start = Math.max(0, column - 60);
	const end = Math.min(sourceLine.length, start + 120);
	const prefix = start > 0 ? "..." : "";
	const suffix = end < sourceLine.length ? "..." : "";
	const indent = sourceLine.slice(start, column).replace(/[^\t]/g, " ");
	const caret = color ? "\u001b[31m^\u001b[0m" : "^";
	return `${heading}\n  ${prefix}${sourceLine.slice(start, end)}${suffix}\n  ${" ".repeat(prefix.length)}${indent}${caret}`;
}
