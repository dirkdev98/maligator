import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export interface DevelopmentDriverOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	readinessTimeoutMs?: number;
	requestTimeoutMs?: number;
	pollMs?: number;
	shutdownGraceMs?: number;
	shutdownTimeoutMs?: number;
}

export interface DevelopmentDriverExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	forced: boolean;
}

export function startDevelopmentDriver(
	executable: string,
	args: ReadonlyArray<string>,
	options: DevelopmentDriverOptions = {},
) {
	const readinessTimeoutMs = options.readinessTimeoutMs ?? 120_000;
	const requestTimeoutMs = options.requestTimeoutMs ?? 250;
	const pollMs = options.pollMs ?? 20;
	const shutdownGraceMs = options.shutdownGraceMs ?? 1500;
	const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5000;
	for (const duration of [
		readinessTimeoutMs,
		requestTimeoutMs,
		pollMs,
		shutdownGraceMs,
		shutdownTimeoutMs,
	]) {
		if (!Number.isFinite(duration) || duration <= 0)
			throw new RangeError("development driver durations must be positive");
	}
	if (shutdownGraceMs >= shutdownTimeoutMs)
		throw new RangeError("shutdown grace must precede shutdown timeout");
	const child = spawn(executable, [...args], {
		cwd: options.cwd,
		env: options.env,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let failure: Error | undefined;
	let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	let forced = false;
	let stopping: Promise<DevelopmentDriverExit> | undefined;
	child.stdout.setEncoding("utf-8");
	child.stderr.setEncoding("utf-8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	let observeExit!: () => void;
	const exited = new Promise<void>((resolve) => {
		observeExit = resolve;
	});
	child.once("error", (error) => {
		failure = error;
		observeExit();
	});
	child.once("exit", (code, signal) => {
		exit = { code, signal };
		observeExit();
	});
	let closed = false;
	const close = new Promise<void>((resolve) => {
		child.once("close", () => {
			closed = true;
			resolve();
		});
	});
	const output = () => `${stdout}\n${stderr}`;
	const requireRunning = () => {
		if (failure !== undefined)
			throw new Error(
				`development child failed to start: ${failure.message}\n${output()}`,
				{ cause: failure },
			);
		if (exit !== undefined)
			throw new Error(
				`development child exited before serving the requested revision (${exit.signal ?? exit.code}):\n${output()}`,
			);
	};
	const kill = (signal: NodeJS.Signals) => {
		if (process.platform === "win32") {
			child.kill(signal);
			return;
		}
		if (child.pid === undefined) return;
		try {
			process.kill(-child.pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	};
	return {
		get pid() {
			return child.pid;
		},
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
		get output() {
			return output();
		},
		async waitForRevision(revision: number): Promise<number> {
			const startedAt = performance.now();
			while (performance.now() - startedAt < readinessTimeoutMs) {
				requireRunning();
				const port = [...stdout.matchAll(/DX_HTTP_PORT (\d+)/g)].at(-1)?.[1];
				if (port !== undefined) {
					const controller = new AbortController();
					const timer = setTimeout(
						() => {
							controller.abort();
						},
						Math.min(
							requestTimeoutMs,
							readinessTimeoutMs - (performance.now() - startedAt),
						),
					);
					try {
						const response = await Promise.race([
							fetch(`http://127.0.0.1:${port}`, { signal: controller.signal }),
							exited.then(() => {
								controller.abort();
								requireRunning();
								throw new Error("development child exited");
							}),
						]);
						const body = await response.text();
						requireRunning();
						if (response.ok && body === String(revision))
							return performance.now() - startedAt;
					} catch {
						requireRunning();
					} finally {
						clearTimeout(timer);
						controller.abort();
					}
				}
				let delay: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						new Promise<void>((resolve) => {
							delay = setTimeout(resolve, pollMs);
						}),
						exited,
					]);
				} finally {
					clearTimeout(delay);
				}
			}
			requireRunning();
			throw new Error(`timed out waiting for served revision ${revision}:\n${output()}`);
		},
		stop(): Promise<DevelopmentDriverExit> {
			return (stopping ??= (async () => {
				if (!closed) {
					let force: ReturnType<typeof setTimeout> | undefined;
					let timeout: ReturnType<typeof setTimeout> | undefined;
					try {
						kill("SIGTERM");
						const expired = new Promise<never>((_resolve, reject) => {
							force = setTimeout(() => {
								forced = true;
								try {
									kill("SIGKILL");
								} catch (error) {
									reject(error instanceof Error ? error : new Error(String(error)));
								}
							}, shutdownGraceMs);
							timeout = setTimeout(() => {
								reject(
									new Error(
										`development child did not close after SIGKILL:\n${output()}`,
									),
								);
							}, shutdownTimeoutMs);
						});
						await Promise.race([close, expired]);
					} finally {
						clearTimeout(force);
						clearTimeout(timeout);
					}
				}
				return { code: child.exitCode, signal: child.signalCode, stdout, stderr, forced };
			})());
		},
	};
}
