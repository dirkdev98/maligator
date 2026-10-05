import type { BuildCommandResult } from "./cli-commands.ts";
import type { DevCommand } from "./cli.ts";
import type { CompilationPhase, CompilerService } from "./compiler-service.ts";

export type DevelopmentGenerationPhase =
	| "queued"
	| "running"
	| "superseded"
	| "failed"
	| "active"
	| "stopping"
	| "stopped";

export interface DevelopmentGenerationEvent {
	generation: number;
	phase: DevelopmentGenerationPhase;
	at: number;
	message?: string;
	application?: DevelopmentApplicationState;
	compilation?: CompilationPhase;
}

export interface DevelopmentApplicationState {
	generation: number;
	backend: "thread" | "process";
	state: "started" | "evaluated" | "ready" | "closed";
	exitCode?: number;
	reason?: "completed" | "terminated" | "error";
	error?: string;
}

export interface DevelopmentSessionSnapshot {
	phase: DevelopmentGenerationPhase;
	generation: number;
	activeGeneration: number | undefined;
	compilingGeneration: number | undefined;
	queuedGeneration: number | undefined;
	application?: DevelopmentApplicationState;
	compilation?: CompilationPhase;
	events: ReadonlyArray<DevelopmentGenerationEvent>;
}

export interface DevelopmentApplicationHost {
	publish(
		result: BuildCommandResult,
		generation: number,
		isCurrent: () => boolean,
		signal: AbortSignal,
	): Promise<boolean>;
	failed(error: unknown, generation: number): void;
	stop(): Promise<void>;
	event?(event: DevelopmentGenerationEvent): void;
}

export function createDevelopmentSession(
	command: DevCommand,
	compiler: Pick<CompilerService, "prepare">,
	host: DevelopmentApplicationHost,
) {
	let generation = 0;
	let activeGeneration: number | undefined;
	let compiling: { generation: number; controller: AbortController } | undefined;
	let pending: number | undefined;
	let phase: DevelopmentGenerationPhase = "queued";
	let stopping = false;
	let draining: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	const invalidatedPaths = new Set<string>();
	let invalidateAll = false;
	const events: Array<DevelopmentGenerationEvent> = [];
	let application: DevelopmentApplicationState | undefined;
	let compilation: CompilationPhase | undefined;
	const record = (
		currentGeneration: number,
		currentPhase: DevelopmentGenerationPhase,
		message?: string,
		currentCompilation?: CompilationPhase,
	) => {
		phase = currentPhase;
		if (currentCompilation !== undefined) compilation = { ...currentCompilation };
		else if (currentPhase === "running") compilation = undefined;
		const event: DevelopmentGenerationEvent = {
			generation: currentGeneration,
			phase: currentPhase,
			at: Date.now(),
			...(message === undefined ? {} : { message }),
			...(currentCompilation === undefined
				? {}
				: { compilation: { ...currentCompilation } }),
		};
		events.push(event);
		if (events.length > 32) events.shift();
		host.event?.(event);
	};
	const drain = async () => {
		while (!stopping && pending !== undefined) {
			const currentGeneration = pending;
			pending = undefined;
			const controller = new AbortController();
			compiling = { generation: currentGeneration, controller };
			const isCurrent = () => !stopping && generation === currentGeneration;
			record(currentGeneration, "running");
			try {
				const result = await compiler.prepare(command, {
					compact: true,
					invalidatedPaths: [...invalidatedPaths],
					invalidateAll,
					signal: controller.signal,
					onPhase(event) {
						if (isCurrent()) record(currentGeneration, "running", undefined, event);
					},
				});
				if (!isCurrent()) continue;
				if (
					!(await host.publish(result, currentGeneration, isCurrent, controller.signal))
				)
					continue;
				if (!isCurrent()) continue;
				activeGeneration = currentGeneration;
				invalidatedPaths.clear();
				invalidateAll = false;
				record(currentGeneration, "active");
			} catch (error) {
				if (!isCurrent()) continue;
				record(
					currentGeneration,
					"failed",
					error instanceof Error ? error.message : String(error),
				);
				if (!isCurrent()) continue;
				host.failed(error, currentGeneration);
			} finally {
				compiling = undefined;
			}
		}
	};
	const startDrain = () => {
		draining = Promise.resolve()
			.then(drain)
			.finally(() => {
				draining = undefined;
				if (!stopping && pending !== undefined) startDrain();
			});
	};
	return {
		observeApplication(state: DevelopmentApplicationState): void {
			application = { ...state };
			const event: DevelopmentGenerationEvent = {
				generation: state.generation,
				phase,
				at: Date.now(),
				application: { ...state },
			};
			events.push(event);
			if (events.length > 32) events.shift();
			host.event?.(event);
		},
		request(paths: ReadonlyArray<string> = [], all = false): number {
			if (stopping) throw new Error("development session is stopping");
			for (const file of paths) invalidatedPaths.add(file);
			invalidateAll ||= all;
			generation++;
			if (pending !== undefined) record(pending, "superseded");
			if (compiling !== undefined && !compiling.controller.signal.aborted) {
				record(compiling.generation, "superseded");
				compiling.controller.abort();
			}
			pending = generation;
			record(generation, "queued");
			if (draining === undefined) startDrain();
			return generation;
		},
		snapshot(): DevelopmentSessionSnapshot {
			return {
				phase,
				generation,
				activeGeneration,
				compilingGeneration: compiling?.generation,
				queuedGeneration: pending,
				...(application === undefined ? {} : { application: { ...application } }),
				...(compilation === undefined ? {} : { compilation: { ...compilation } }),
				events: events.map((event) => ({ ...event })),
			};
		},
		async settled(): Promise<void> {
			while (draining !== undefined) await draining;
		},
		close(): Promise<void> {
			return (closing ??= (async () => {
				stopping = true;
				pending = undefined;
				compiling?.controller.abort();
				const failures: Array<unknown> = [];
				try {
					record(generation, "stopping");
				} catch (error) {
					failures.push(error);
				}
				try {
					await draining;
				} catch (error) {
					failures.push(error);
				}
				try {
					await host.stop();
					record(generation, "stopped");
				} catch (error) {
					failures.push(error);
				}
				if (failures.length === 1) throw failures[0];
				if (failures.length > 1) {
					throw new AggregateError(failures, "development shutdown failed");
				}
			})());
		},
	};
}
