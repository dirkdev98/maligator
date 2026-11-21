import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createCacheLease } from "./cache-management.ts";
import type { CacheLease } from "./cache-management.ts";

export function formatCommandDuration(durationMs: number): string {
	if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
	if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
	const minutes = Math.floor(durationMs / 60_000);
	const seconds = Math.round((durationMs - minutes * 60_000) / 1000);
	return `${minutes}m ${seconds}s`;
}

// Native tool invocations block the JS event loop. A separate process can refresh
// the line while they run, and the gate prevents a late tick after completion.
const elapsedTicker = `
discard() {
	/bin/rm -f "$1/shown"
	/bin/rmdir "$1/active" "$1/tick" "$1" 2>/dev/null
}
trap '/bin/rmdir "$1/tick" 2>/dev/null; if ! kill -0 "$3" 2>/dev/null; then discard "$1"; fi' EXIT
trap 'if [ -n "$sleeper" ]; then kill "$sleeper" 2>/dev/null; fi; discard "$1"; exit' HUP INT TERM
pause() {
	/bin/sleep "$1" &
	sleeper=$!
	wait "$sleeper"
	sleeper=
}
elapsed=3
pause "$elapsed"
while kill -0 "$3" 2>/dev/null && /bin/mkdir "$1/tick" 2>/dev/null; do
	[ -d "$1/active" ] || exit
	: > "$1/shown"
	printf '\\r\\033[2K  %s... %ss elapsed' "$2" "$elapsed" >&2
	/bin/rmdir "$1/tick"
	pause 1
	elapsed=$((elapsed + 1))
done
`;

export const clearProgressLine = "\r\u001b[2K";

/** Return a function that closes the ticker and reports whether it wrote a line. */
export function startElapsedTicker(label: string): (() => boolean) | undefined {
	if (process.stderr.isTTY !== true || process.env.TERM === "dumb") return undefined;
	const directory = mkdtempSync(join(tmpdir(), "maligator-progress-"));
	const active = join(directory, "active");
	const writing = join(directory, "tick");
	try {
		mkdirSync(active);
		const child = spawn(
			"/bin/sh",
			["-c", elapsedTicker, "elapsed-ticker", directory, label, String(process.pid)],
			{ stdio: ["ignore", "ignore", "inherit"] },
		);
		child.on("error", () => {});
		child.unref();
		return () => {
			rmSync(active, { force: true, recursive: true });
			const deadline = performance.now() + 250;
			const wait = new Int32Array(new SharedArrayBuffer(4));
			while (existsSync(writing) && performance.now() < deadline)
				Atomics.wait(wait, 0, 0, 5);
			const shown = existsSync(join(directory, "shown"));
			rmSync(directory, { force: true, recursive: true });
			child.kill();
			return shown;
		};
	} catch (error) {
		rmSync(directory, { force: true, recursive: true });
		throw error;
	}
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
