import { performance } from "node:perf_hooks";
import { createCacheLease, maybeMaintainMaligatorCache } from "./cache-management.ts";
import type { CacheLease } from "./cache-management.ts";

export function formatCommandDuration(durationMs: number): string {
	if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
	if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
	const minutes = Math.floor(durationMs / 60_000);
	const seconds = Math.round((durationMs - minutes * 60_000) / 1000);
	return `${minutes}m ${seconds}s`;
}

export interface CommandProgressOptions {
	stream?: NodeJS.WriteStream;
	quiet?: boolean;
	cacheLease?: boolean;
	cacheRoot?: string;
}

/** Stable, non-interactive progress shared by repository and product commands. */
export class CommandProgress {
	readonly name: string;
	readonly #stream: NodeJS.WriteStream;
	readonly #quiet: boolean;
	readonly #startedAt = performance.now();
	#stageStartedAt = this.#startedAt;
	#cacheLease?: CacheLease;

	readonly #releaseCacheLease = () => {
		const lease = this.#cacheLease;
		if (lease === undefined) return;
		this.#cacheLease = undefined;
		lease.release();
		process.removeListener("exit", this.#releaseCacheLease);
	};

	constructor(name: string, options: CommandProgressOptions = {}) {
		this.name = name;
		this.#stream = options.stream ?? process.stderr;
		this.#quiet = options.quiet ?? false;
		if (options.cacheLease !== false) {
			try {
				maybeMaintainMaligatorCache();
			} catch {
				// Another live command or maintenance pass owns the cache. The lease
				// below remains the concurrency authority; automatic pruning is optional.
			}
			this.#cacheLease = createCacheLease(name, options.cacheRoot);
			process.once("exit", this.#releaseCacheLease);
		}
	}

	get elapsedMs(): number {
		return performance.now() - this.#startedAt;
	}

	#write(message: string): void {
		if (!this.#quiet) this.#stream.write(`[${this.name}] ${message}\n`);
	}

	start(message: string): void {
		this.#write(message);
	}

	stage(current: number, total: number, label: string): void {
		this.#stageStartedAt = performance.now();
		this.#write(`[${current}/${total}] ${label} started`);
	}

	stagePassed(current: number, total: number, label: string, detail?: string): void {
		const elapsed = formatCommandDuration(performance.now() - this.#stageStartedAt);
		this.#write(
			`[${current}/${total}] ${label} passed in ${elapsed}${detail === undefined ? "" : ` · ${detail}`}`,
		);
	}

	stageFailed(current: number, total: number, label: string): void {
		const elapsed = formatCommandDuration(performance.now() - this.#stageStartedAt);
		this.#write(`[${current}/${total}] ${label} failed after ${elapsed}`);
	}

	progress(current: number, total: number, label: string): void {
		this.#write(
			`[${current}/${total}] ${label} · total ${formatCommandDuration(this.elapsedMs)}`,
		);
	}

	detail(message: string): void {
		this.#write(message);
	}

	complete(label = "completed"): void {
		this.#write(`${label} in ${formatCommandDuration(this.elapsedMs)}`);
		this.#releaseCacheLease();
	}

	failed(label = "failed"): void {
		this.#write(`${label} after ${formatCommandDuration(this.elapsedMs)}`);
		this.#releaseCacheLease();
	}
}
