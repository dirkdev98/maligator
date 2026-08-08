import { performance } from "node:perf_hooks";

function formatDuration(durationMs: number): string {
	if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
	if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
	const minutes = Math.floor(durationMs / 60_000);
	const seconds = Math.round((durationMs - minutes * 60_000) / 1000);
	return `${minutes}m ${seconds}s`;
}

function writeLine(stream: NodeJS.WriteStream, message: string): void {
	stream.write(`${message}\n`);
}

/** Human-facing build progress. Status belongs on stderr; stdout is the result. */
export class BuildReporter {
	readonly verbose: boolean;
	readonly #startedAt = performance.now();

	constructor(verbose: boolean) {
		this.verbose = verbose;
	}

	start(
		name: string,
		mode: "development" | "production",
		action: "Building" | "Preparing" = "Building",
	): void {
		writeLine(process.stderr, `${action} ${name} (${mode})`);
	}

	phase<Result>(
		label: string,
		run: () => Result,
		detail?: (result: Result) => string | undefined,
	): Result {
		const startedAt = performance.now();
		if (this.verbose) {
			writeLine(
				process.stderr,
				`[+${formatDuration(startedAt - this.#startedAt)}] ${label} started`,
			);
		} else {
			process.stderr.write(`  ${label}... `);
		}
		try {
			const result = run();
			const elapsed = formatDuration(performance.now() - startedAt);
			const suffix = detail?.(result);
			if (this.verbose) {
				writeLine(
					process.stderr,
					`[+${formatDuration(performance.now() - this.#startedAt)}] ${label} completed in ${elapsed}${suffix === undefined ? "" : ` · ${suffix}`}`,
				);
			} else {
				process.stderr.write(
					`done in ${elapsed}${suffix === undefined ? "" : ` · ${suffix}`}\n`,
				);
			}
			return result;
		} catch (error) {
			const elapsed = formatDuration(performance.now() - startedAt);
			if (this.verbose) {
				writeLine(
					process.stderr,
					`[+${formatDuration(performance.now() - this.#startedAt)}] ${label} failed after ${elapsed}`,
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
			`${formatDuration(durationMs)}${detail === undefined ? "" : ` · ${detail}`}`,
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
		writeLine(
			process.stderr,
			`${label} ${resultPath} in ${formatDuration(performance.now() - this.#startedAt)}`,
		);
		if (emitResult) writeLine(process.stdout, resultPath);
	}
}
