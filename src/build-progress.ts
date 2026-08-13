import { performance } from "node:perf_hooks";
import { formatCommandDuration } from "./command-progress.ts";

function writeLine(stream: NodeJS.WriteStream, message: string): void {
	stream.write(`${message}\n`);
}

/** Human-facing build progress. Status belongs on stderr; stdout is the result. */
export class BuildReporter {
	readonly verbose: boolean;
	readonly compact: boolean;
	readonly #startedAt = performance.now();

	constructor(verbose: boolean, compact = false) {
		this.verbose = verbose;
		this.compact = compact;
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
	): Result {
		const startedAt = performance.now();
		if (this.compact) return run();
		if (this.verbose) {
			writeLine(
				process.stderr,
				`[+${formatCommandDuration(startedAt - this.#startedAt)}] ${label} started`,
			);
		} else {
			process.stderr.write(`  ${label}... `);
		}
		try {
			const result = run();
			const elapsed = formatCommandDuration(performance.now() - startedAt);
			const suffix = detail?.(result);
			if (this.verbose) {
				writeLine(
					process.stderr,
					`[+${formatCommandDuration(performance.now() - this.#startedAt)}] ${label} completed in ${elapsed}${suffix === undefined ? "" : ` · ${suffix}`}`,
				);
			} else {
				process.stderr.write(
					`done in ${elapsed}${suffix === undefined ? "" : ` · ${suffix}`}\n`,
				);
			}
			return result;
		} catch (error) {
			const elapsed = formatCommandDuration(performance.now() - startedAt);
			if (this.verbose) {
				writeLine(
					process.stderr,
					`[+${formatCommandDuration(performance.now() - this.#startedAt)}] ${label} failed after ${elapsed}`,
				);
			} else {
				process.stderr.write(`failed after ${elapsed}\n`);
			}
			throw error;
		}
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
		writeLine(process.stderr, `warning: ${message}`);
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
