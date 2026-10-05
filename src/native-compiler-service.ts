import {
	capabilities,
	createPool,
	createWorkerUrl,
	MessageChannel,
	receiveMessageOnPort,
} from "maligator:workers";
import type { WorkerPool } from "maligator:workers";
import type { CompilerInstallation } from "./cli-commands.ts";
import type { CompilerProducerStage } from "./compiler-cache-identity.ts";
import type { prepare, prepareTests } from "./compiler-service-worker.ts";
import type { CompilationPhase, CompilerService } from "./compiler-service.ts";

type CompilerWorker = { prepare: typeof prepare; prepareTests: typeof prepareTests };

const compilerEntry = createWorkerUrl<CompilerWorker>(
	"./compiler-service-worker.ts",
	import.meta.url,
);

function cooperativeCancellation(signal: AbortSignal | undefined) {
	const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
	const flag = new Int32Array(buffer);
	const abort = () => {
		Atomics.store(flag, 0, 1);
	};
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	return {
		buffer,
		check: () => signal?.throwIfAborted(),
		close: () => signal?.removeEventListener("abort", abort),
	};
}

function observePhases(onPhase: ((phase: CompilationPhase) => void) | undefined) {
	if (onPhase === undefined) return undefined;
	const channel = new MessageChannel();
	let failure: { error: unknown } | undefined;
	const deliver = (phase: CompilationPhase) => {
		try {
			onPhase(phase);
		} catch (error) {
			failure ??= { error };
		}
	};
	channel.port1.addEventListener("message", (event) =>
		deliver((event as MessageEvent<CompilationPhase>).data),
	);
	channel.port1.start();
	return {
		port: channel.port2,
		drain() {
			// Task replies use a different port; drain all phases published before that reply.
			for (;;) {
				const envelope = receiveMessageOnPort(channel.port1);
				if (envelope === undefined) break;
				deliver(envelope.message as CompilationPhase);
			}
			return failure;
		},
		close() {
			channel.port1.close();
			channel.port2.close();
		},
	};
}

export function createNativeCompilerService(
	installation: CompilerInstallation,
	producerDigests: Record<CompilerProducerStage, string>,
): CompilerService {
	let pool: WorkerPool<CompilerWorker> | undefined;
	const parallelism = capabilities().parallelism;
	let closing = false;
	let poolSize: number | undefined;
	const ready = async (size = 1) => {
		if (closing) throw new Error("compiler service is closed");
		if (!Number.isSafeInteger(size) || size < 1 || size > parallelism) {
			throw new RangeError(`compiler concurrency must be between 1 and ${parallelism}`);
		}
		if (poolSize !== undefined && size !== poolSize) {
			throw new Error("compiler concurrency cannot change within a session");
		}
		poolSize = size;
		pool ??= createPool(compilerEntry, {
			size,
			maxQueuedTasks: size,
			name: "compiler",
		});
		await pool.ready;
		if (closing) throw new Error("compiler service is closed");
		return pool;
	};
	return {
		parallelism,
		async prepare(command, options = {}) {
			options.signal?.throwIfAborted();
			const workers = await ready();
			const cancellation = cooperativeCancellation(options.signal);
			const progress = observePhases(options.onPhase);
			try {
				const result = await workers.run(
					"prepare",
					[
						{
							command,
							installation,
							producerDigests,
							compact: options.compact ?? false,
							invalidatedPaths: options.invalidatedPaths ?? [],
							invalidateAll: options.invalidateAll ?? false,
							cancellation: cancellation.buffer,
							progress: progress?.port,
						},
					],
					{
						// Pool cancellation rejects before task cleanup; this service settles after drain.
						transfer: progress === undefined ? [] : [progress.port],
					},
				);
				const failure = progress?.drain();
				cancellation.check();
				if (failure !== undefined) throw failure.error;
				return result;
			} catch (error) {
				progress?.drain();
				cancellation.check();
				throw error;
			} finally {
				progress?.close();
				cancellation.close();
			}
		},
		async prepareTests(input, options = {}) {
			options.signal?.throwIfAborted();
			const workers = await ready(options.concurrency ?? 1);
			const cancellation = cooperativeCancellation(options.signal);
			const progress = observePhases(options.onPhase);
			try {
				const result = await workers.run(
					"prepareTests",
					[
						{
							input,
							installation,
							producerDigests,
							invalidatedPaths: options.invalidatedPaths ?? [],
							invalidateAll: options.invalidateAll ?? false,
							cancellation: cancellation.buffer,
							progress: progress?.port,
						},
					],
					{
						transfer: progress === undefined ? [] : [progress.port],
					},
				);
				const failure = progress?.drain();
				cancellation.check();
				if (failure !== undefined) throw failure.error;
				return result;
			} catch (error) {
				progress?.drain();
				cancellation.check();
				throw error;
			} finally {
				progress?.close();
				cancellation.close();
			}
		},
		async close() {
			closing = true;
			// Draining preserves the finally blocks that release filesystem build locks.
			await pool?.close();
		},
	};
}
