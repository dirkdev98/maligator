import { performance } from "node:perf_hooks";
import {
	clearProgressLine,
	formatCommandDuration,
	startElapsedTicker,
} from "./command-progress.ts";
import type { CompilationPhase } from "./compiler-service.ts";

function writeLine(stream: NodeJS.WriteStream, message: string): void {
	stream.write(`${message}\n`);
}

/** Human-facing build progress. Status belongs on stderr; stdout is the result. */
export class BuildReporter {
	readonly verbose: boolean;
	readonly compact: boolean;
	readonly #startedAt = performance.now();
	readonly #checkpoint: (() => void) | undefined;
	readonly #onPhase: ((phase: CompilationPhase) => void) | undefined;
	#elapsed: { label: string; stop?: () => boolean; shown: boolean } | undefined;

	constructor(
		verbose: boolean,
		compact = false,
		checkpoint?: () => void,
		onPhase?: (phase: CompilationPhase) => void,
	) {
		this.verbose = verbose;
		this.compact = compact;
		this.#checkpoint = checkpoint;
		this.#onPhase = onPhase;
	}

	start(
		name: string,
		mode: "development" | "production",
		action: "Building" | "Preparing" = "Building",
	): void {
		if (this.compact) return;
		writeLine(process.stderr, `${action} ${name} (${mode})`);
	}

	phase<Result>(
		label: string,
		run: () => Result,
		detail?: (result: Result) => string | undefined,
		options?: { elapsed: boolean },
	): Result {
		const startedAt = this.#startPhase(label);
		let shown = false;
		try {
			const stop =
				options?.elapsed === true && !this.verbose
					? startElapsedTicker(label)
					: undefined;
			if (stop !== undefined) this.#elapsed = { label, stop, shown: false };
			let result: Result;
			try {
				result = run();
			} finally {
				const elapsed = this.#elapsed;
				this.#elapsed = undefined;
				shown = (elapsed?.stop?.() ?? false) || elapsed?.shown === true;
			}
			return this.#completePhase(label, startedAt, result, detail, shown);
		} catch (error) {
			return this.#failPhase(label, startedAt, error, shown);
		}
	}

	async phaseAsync<Result>(
		label: string,
		run: () => Promise<Result>,
		detail?: (result: Result) => string | undefined,
	): Promise<Result> {
		const startedAt = this.#startPhase(label);
		try {
			return this.#completePhase(label, startedAt, await run(), detail);
		} catch (error) {
			return this.#failPhase(label, startedAt, error);
		}
	}

	#startPhase(label: string): number {
		this.#checkpoint?.();
		const startedAt = performance.now();
		this.#onPhase?.({ label, state: "started" });
		if (!this.compact && this.verbose) {
			writeLine(
				process.stderr,
				`[+${formatCommandDuration(startedAt - this.#startedAt)}] ${label} started`,
			);
		} else if (!this.compact) {
			process.stderr.write(`  ${label}... `);
		}
		return startedAt;
	}

	#completePhase<Result>(
		label: string,
		startedAt: number,
		result: Result,
		detail?: (result: Result) => string | undefined,
		shown = false,
	): Result {
		this.#checkpoint?.();
		this.#onPhase?.({
			label,
			state: "completed",
			durationMs: performance.now() - startedAt,
		});
		if (this.compact && !shown) return result;
		const elapsed = formatCommandDuration(performance.now() - startedAt);
		const suffix = detail?.(result);
		if (this.verbose) {
			writeLine(
				process.stderr,
				`[+${formatCommandDuration(performance.now() - this.#startedAt)}] ${label} completed in ${elapsed}${suffix === undefined ? "" : ` · ${suffix}`}`,
			);
		} else {
			if (shown) process.stderr.write(`${clearProgressLine}  ${label}... `);
			process.stderr.write(
				`done in ${elapsed}${suffix === undefined ? "" : ` · ${suffix}`}\n`,
			);
		}
		return result;
	}

	#failPhase(label: string, startedAt: number, error: unknown, shown = false): never {
		this.#onPhase?.({
			label,
			state: "failed",
			durationMs: performance.now() - startedAt,
		});
		if (this.compact && !shown) throw error;
		const elapsed = formatCommandDuration(performance.now() - startedAt);
		if (this.verbose) {
			writeLine(
				process.stderr,
				`[+${formatCommandDuration(performance.now() - this.#startedAt)}] ${label} failed after ${elapsed}`,
			);
		} else {
			if (shown) process.stderr.write(`${clearProgressLine}  ${label}... `);
			process.stderr.write(`failed after ${elapsed}\n`);
		}
		throw error;
	}

	detail(label: string, value: string | number): void {
		if (this.verbose) writeLine(process.stderr, `    ${label}: ${value}`);
	}

	timing(label: string, durationMs: number, detail?: string): void {
		this.detail(
			label,
			`${formatCommandDuration(durationMs)}${detail === undefined ? "" : ` · ${detail}`}`,
		);
	}

	warning(message: string): void {
		const elapsed = this.#elapsed;
		if (elapsed !== undefined) {
			elapsed.shown = (elapsed.stop?.() ?? false) || elapsed.shown;
			elapsed.stop = undefined;
			if (elapsed.shown || !this.compact) process.stderr.write(clearProgressLine);
		}
		writeLine(process.stderr, `warning: ${message}`);
		if (elapsed !== undefined && !this.compact && !elapsed.shown)
			process.stderr.write(`  ${elapsed.label}... `);
	}

	complete(
		label: "Built" | "Ready" | "Serialized",
		resultPath: string,
		emitResult: boolean,
	): void {
		if (this.compact) {
			if (emitResult) writeLine(process.stdout, resultPath);
			return;
		}
		writeLine(
			process.stderr,
			`${label} ${resultPath} in ${formatCommandDuration(performance.now() - this.#startedAt)}`,
		);
		if (emitResult) writeLine(process.stdout, resultPath);
	}
}
