import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { BuildCommandResult, CompilerInstallation } from "./cli-commands.ts";
import { restoreCompilerResult } from "./compiler-profile-result.ts";
import type { CompilerResultMessage } from "./compiler-profile-result.ts";
import type {
	CompilationPhase,
	CompilationRequest,
	CompilerService,
} from "./compiler-service.ts";
import type { DependencyFragmentWorker } from "./dependency-fragment-cache.ts";

export interface NodeCompilationJob {
	id: number;
	request: Omit<CompilationRequest, "producerDigests">;
	cancellation: SharedArrayBuffer;
	phases: boolean;
}

type NodeCompilationResult =
	| { id: number; ok: true; value: CompilerResultMessage }
	| { id: number; ok: false; error: unknown };

export type NodeCompilationReply =
	| NodeCompilationResult
	| { id: number; phase: CompilationPhase };

interface PendingCompilation {
	job: NodeCompilationJob;
	signal?: AbortSignal;
	abort: () => void;
	resolve: (value: BuildCommandResult) => void;
	reject: (reason: unknown) => void;
	onPhase?: (phase: CompilationPhase) => void;
	observerFailure?: { error: unknown };
}

export function createNodeCompilerService(
	installation: CompilerInstallation,
	dependencyWorker?: DependencyFragmentWorker,
): CompilerService {
	let worker: Worker | undefined;
	let active: PendingCompilation | undefined;
	const queued: Array<PendingCompilation> = [];
	let nextId = 0;
	let closing = false;
	let closed: Promise<void> | undefined;
	let resolveClosed: (() => void) | undefined;
	const settle = (pending: PendingCompilation, reply: NodeCompilationResult) => {
		pending.signal?.removeEventListener("abort", pending.abort);
		const directory = pending.job.request.profileDirectory;
		let outcome: { value: BuildCommandResult } | { error: unknown };
		try {
			if (pending.signal?.aborted) throw pending.signal.reason;
			if (pending.observerFailure !== undefined) throw pending.observerFailure.error;
			if (!reply.ok) throw reply.error;
			outcome = { value: restoreCompilerResult(reply.value, directory) };
		} catch (error) {
			outcome = { error };
		}
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch (error) {
			if (!("error" in outcome)) outcome = { error };
		}
		if ("error" in outcome) pending.reject(outcome.error);
		else pending.resolve(outcome.value);
	};
	const dispatch = () => {
		if (active !== undefined) return;
		while (queued.length > 0) {
			const next = queued.shift()!;
			if (next.signal?.aborted) {
				settle(next, { id: next.job.id, ok: false, error: next.signal.reason });
				continue;
			}
			active = next;
			try {
				worker!.postMessage(next.job);
				return;
			} catch (error) {
				active = undefined;
				settle(next, { id: next.job.id, ok: false, error });
			}
		}
		if (closing) {
			if (worker === undefined) resolveClosed?.();
			else worker.postMessage({ close: true });
		}
	};
	const start = () => {
		if (worker !== undefined) return;
		const current = new Worker(
			new URL("./node-compiler-service-worker.ts", import.meta.url),
		);
		worker = current;
		let failure: unknown;
		current.on("error", (error) => {
			failure = error;
		});
		current.on("message", (reply: NodeCompilationReply) => {
			if (active === undefined || reply.id !== active.job.id) return;
			if ("phase" in reply) {
				try {
					active.onPhase?.(reply.phase);
				} catch (error) {
					active.observerFailure ??= { error };
				}
				return;
			}
			const previous = active;
			active = undefined;
			settle(previous, reply);
			dispatch();
		});
		current.on("exit", (code) => {
			worker = undefined;
			const error = failure ?? new Error(`compiler worker exited with code ${code}`);
			if (active !== undefined) {
				settle(active, { id: active.job.id, ok: false, error });
				active = undefined;
			}
			for (const pending of queued.splice(0)) {
				settle(pending, { id: pending.job.id, ok: false, error });
			}
			if (closing) resolveClosed?.();
		});
	};
	return {
		parallelism: 1,
		async prepare(command, options = {}) {
			if (closing) throw new Error("compiler service is closed");
			options.signal?.throwIfAborted();
			if (queued.length >= 1) throw new RangeError("compiler queue is full");
			start();
			return new Promise((resolve, reject) => {
				const profileDirectory = mkdtempSync(join(tmpdir(), "mal-compiler-result-"));
				const cancellation = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
				const flag = new Int32Array(cancellation);
				const abort = () => {
					Atomics.store(flag, 0, 1);
				};
				options.signal?.addEventListener("abort", abort, { once: true });
				queued.push({
					job: {
						id: ++nextId,
						cancellation,
						phases: options.onPhase !== undefined,
						request: {
							command,
							profileDirectory,
							installation,
							dependencyWorker,
							compact: options.compact ?? false,
							invalidatedPaths: options.invalidatedPaths ?? [],
							invalidateAll: options.invalidateAll ?? false,
						},
					},
					signal: options.signal,
					abort,
					resolve,
					reject,
					onPhase: options.onPhase,
				});
				dispatch();
			});
		},
		close() {
			if (closed !== undefined) return closed;
			closing = true;
			closed = new Promise((resolve) => {
				resolveClosed = resolve;
			});
			// Accepted work drains so filesystem action locks reach their finally blocks.
			dispatch();
			return closed;
		},
	};
}
