export type SyntaxDiagnosticPhase = "parse" | "resolution";

/** A language rejection with its semantic phase, independent of compiler staging. */
export class SyntaxDiagnostic extends SyntaxError {
	readonly phase: SyntaxDiagnosticPhase;

	constructor(phase: SyntaxDiagnosticPhase, message: string, options?: ErrorOptions) {
		super(message, options);
		this.phase = phase;
	}
}
