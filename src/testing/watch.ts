import { readdirSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import type { ResolvedBuildConfig } from "../build-config.ts";
import type { CommandContext } from "../cli-commands.ts";
import { BUILD_CONFIG_NAME } from "../cli-init.ts";
import type { TestCommand } from "../cli.ts";
import type { CompilationPhase } from "../compiler-service.ts";
import type { FrontendDependencyIdentity } from "../frontend-cache.ts";
import { frontendDependencyUnchanged } from "../frontend-cache.ts";
import { createTestApplicationSession, executeTestCommand } from "./command.ts";
import type { TestCommandSummary } from "./command.ts";
import type { PreparedTestApplication } from "./prepare.ts";
import { TestSourceChangedError } from "./session.ts";
import type { TestGenerationControls } from "./session.ts";

export interface TestWatchEvent {
	generation: number;
	phase:
		| "queued"
		| "running"
		| "superseded"
		| "passed"
		| "failed"
		| "stopping"
		| "stopped";
	at: number;
	message?: string;
	compilation?: CompilationPhase;
}

export function createTestWatchSession(
	run: (
		controls: TestGenerationControls,
		failedOnly: boolean,
	) => Promise<TestCommandSummary>,
	host: {
		publish(summary: TestCommandSummary, generation: number): void;
		failed(error: unknown, generation: number): void;
		close(): void | Promise<void>;
		event?(event: TestWatchEvent): void;
	},
) {
	let generation = 0;
	let completedGeneration: number | undefined;
	let pending: { generation: number; failedOnly: boolean } | undefined;
	let running: { generation: number; controller: AbortController } | undefined;
	let draining: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	let stopping = false;
	let invalidateAll = false;
	const invalidatedPaths = new Set<string>();
	const events: Array<TestWatchEvent> = [];
	const record = (
		current: number,
		phase: TestWatchEvent["phase"],
		message?: string,
		compilation?: CompilationPhase,
	) => {
		const event = {
			generation: current,
			phase,
			at: Date.now(),
			...(message === undefined ? {} : { message }),
			...(compilation === undefined ? {} : { compilation: { ...compilation } }),
		};
		events.push(event);
		if (events.length > 32) events.shift();
		host.event?.(event);
	};
	const drain = async () => {
		while (!stopping && pending !== undefined) {
			const next = pending;
			pending = undefined;
			const controller = new AbortController();
			running = { generation: next.generation, controller };
			const isCurrent = () => !stopping && generation === next.generation;
			record(next.generation, "running");
			try {
				const summary = await run(
					{
						generation: next.generation,
						signal: controller.signal,
						invalidatedPaths: [...invalidatedPaths],
						invalidateAll,
						isCurrent,
						onPhase(event) {
							if (isCurrent()) record(next.generation, "running", undefined, event);
						},
					},
					next.failedOnly,
				);
				if (!isCurrent()) continue;
				completedGeneration = next.generation;
				invalidatedPaths.clear();
				invalidateAll = false;
				record(next.generation, summary.failed === 0 ? "passed" : "failed");
				if (!isCurrent()) continue;
				host.publish(summary, next.generation);
			} catch (error) {
				if (!isCurrent()) continue;
				record(
					next.generation,
					"failed",
					error instanceof Error ? error.message : String(error),
				);
				if (!isCurrent()) continue;
				host.failed(error, next.generation);
			} finally {
				running = undefined;
			}
		}
	};
	const start = () => {
		draining = Promise.resolve()
			.then(drain)
			.finally(() => {
				draining = undefined;
				if (!stopping && pending !== undefined) start();
			});
	};
	return {
		request(paths: Array<string> = [], all = false, failedOnly = false): number {
			if (stopping) throw new Error("test watch session is stopping");
			for (const file of paths) invalidatedPaths.add(file);
			invalidateAll ||= all;
			generation++;
			if (pending !== undefined) record(pending.generation, "superseded");
			if (running !== undefined && !running.controller.signal.aborted) {
				record(running.generation, "superseded");
				running.controller.abort();
			}
			pending = {
				generation,
				failedOnly: failedOnly && invalidatedPaths.size === 0 && !invalidateAll,
			};
			record(generation, "queued");
			if (draining === undefined) start();
			return generation;
		},
		snapshot() {
			return {
				generation,
				completedGeneration,
				runningGeneration: running?.generation,
				queuedGeneration: pending?.generation,
				events: events.map((event) => ({ ...event })),
			};
		},
		async settled() {
			while (draining !== undefined) await draining;
		},
		close(): Promise<void> {
			return (closing ??= (async () => {
				stopping = true;
				pending = undefined;
				running?.controller.abort();
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
					await host.close();
					record(generation, "stopped");
				} catch (error) {
					failures.push(error);
				}
				if (failures.length === 1) throw failures[0];
				if (failures.length > 1)
					throw new AggregateError(failures, "test watch shutdown failed");
			})());
		},
	};
}

function identity(file: string): string | undefined {
	try {
		const stats = statSync(file);
		return [stats.size, stats.mtimeMs, stats.ctimeMs, stats.ino, stats.dev].join(":");
	} catch {
		return undefined;
	}
}

function collectDirectories(
	target: string,
	result: Set<string>,
	omitInternals: boolean,
	visited = new Set<string>(),
): void {
	try {
		if (!statSync(target).isDirectory()) return;
		const real = realpathSync(target);
		if (visited.has(real)) return;
		visited.add(real);
		result.add(target);
		for (const name of readdirSync(target)) {
			if (omitInternals && [".git", "node_modules", ".cache"].includes(name)) continue;
			const child = path.join(target, name);
			if (statSync(child).isDirectory())
				collectDirectories(child, result, omitInternals, visited);
		}
	} catch {
		return;
	}
}

export async function watchTestCommand(
	command: TestCommand,
	context: CommandContext,
	loadConfig: () => ResolvedBuildConfig,
): Promise<void> {
	const applicationSession = createTestApplicationSession(command, context);
	const configPath = path.resolve(command.configPath ?? BUILD_CONFIG_NAME);
	const dependencies = new Map<string, FrontendDependencyIdentity>();
	let currentDependencies = new Map<string, FrontendDependencyIdentity>();
	let config: ResolvedBuildConfig | undefined;
	try {
		config = loadConfig();
	} catch {
		config = undefined;
	}
	let states = new Map<string, string | undefined>();
	let directories = new Set<string>();
	let failedFiles: Array<string> = [];
	let stopping = false;
	const watch = context.developmentWatcher;
	const collect = (keepPrevious = true) => {
		const roots =
			command.paths.length === 0
				? [process.cwd()]
				: command.paths.map((file) => path.resolve(file));
		const dirs = new Set<string>();
		for (const root of roots) collectDirectories(root, dirs, true);
		for (const asset of Object.values(config?.assets ?? {}))
			if (asset.type === "directory")
				collectDirectories(path.resolve(asset.path), dirs, false);
		const files = new Set([
			configPath,
			...roots,
			...dependencies.keys(),
			...Object.values(config?.assets ?? {}).map((asset) => path.resolve(asset.path)),
			...dirs,
			...(keepPrevious ? states.keys() : []),
		]);
		return { dirs, states: new Map([...files].map((file) => [file, identity(file)])) };
	};
	const refresh = (keepPrevious = true) => {
		const collected = collect(keepPrevious);
		states = collected.states;
		directories = collected.dirs;
	};
	refresh();
	const watchFiles = () => [
		...states.keys(),
		...[...directories].map((directory) =>
			path.join(directory, ".maligator-watch-directory"),
		),
	];
	const handle = watch?.create(watchFiles());
	const changed = () => {
		const current = collect();
		return [...new Set([...states.keys(), ...current.states.keys()])].filter(
			(file) =>
				states.get(file) !== current.states.get(file) ||
				states.has(file) !== current.states.has(file),
		);
	};
	const requestChanges = (paths: Array<string>) => {
		const all = paths.includes(configPath) || paths.some((file) => directories.has(file));
		refresh();
		watch?.update(handle, watchFiles());
		session.request(paths, all);
	};
	const prepared = (application: PreparedTestApplication) => {
		for (const dependency of application.dependencyIdentities) {
			dependencies.set(dependency.path, dependency);
			currentDependencies.set(dependency.path, dependency);
		}
		for (const dependency of application.dependencyIdentities)
			states.set(
				dependency.path,
				[
					dependency.size,
					dependency.mtimeMs,
					dependency.ctimeMs,
					dependency.ino,
					dependency.dev,
				].join(":"),
			);
		watch?.update(handle, watchFiles());
	};
	const validate = () => [
		...new Set([
			...changed(),
			...[...currentDependencies.values()]
				.filter((dependency) => !frontendDependencyUnchanged(dependency))
				.map((dependency) => dependency.path),
		]),
	];
	const session = createTestWatchSession(
		async (controls, failedOnly) => {
			const beforeConfig = identity(configPath);
			config = loadConfig();
			if (beforeConfig !== identity(configPath)) {
				requestChanges([configPath]);
				throw new TestSourceChangedError([configPath]);
			}
			currentDependencies = new Map();
			refresh();
			watch?.update(handle, watchFiles());
			try {
				return await executeTestCommand(command, context, config, applicationSession, {
					...controls,
					prepared,
					validate,
					...(failedOnly ? { selectedFiles: failedFiles } : {}),
				});
			} catch (error) {
				if (error instanceof TestSourceChangedError && !stopping)
					requestChanges(error.paths);
				throw error;
			}
		},
		{
			publish(summary, generation) {
				failedFiles = summary.failedFiles ?? [];
				if (summary.failed === 0) dependencies.clear();
				for (const [file, dependency] of currentDependencies)
					dependencies.set(file, dependency);
				refresh(false);
				watch?.update(handle, watchFiles());
				process.stderr.write(
					`Test watch generation ${generation}: ${summary.failed} failed; seed ${applicationSession.options.shuffleSeed ?? "none"}; failed files ${JSON.stringify(failedFiles)}\n`,
				);
			},
			failed(error, generation) {
				process.stderr.write(
					`Test watch generation ${generation} failed: ${error instanceof Error ? error.message : String(error)}; waiting for changes\n`,
				);
			},
			close() {
				return applicationSession.close();
			},
			event(event) {
				if (command.status) {
					const resources = context.applications?.resources?.();
					process.stderr.write(
						`Test session ${JSON.stringify({ ...session.snapshot(), seed: applicationSession.options.shuffleSeed ?? null, failedFiles, ...(resources === undefined ? {} : { resources }) })}\n`,
					);
				}
				process.stderr.write(
					`Test watch generation ${event.generation}: ${event.phase}\n`,
				);
			},
		},
	);
	const stop = () => {
		stopping = true;
		void session.close().catch(() => {});
	};
	const rerun = () => {
		if (!stopping) session.request([], false, command.watchFailed === true);
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	if (process.platform !== "win32") process.on("SIGHUP", rerun);
	let loopFailure: { error: unknown } | undefined;
	const failures: Array<unknown> = [];
	try {
		process.stderr.write(
			`Watching tests in process ${process.pid}; ${process.platform === "win32" ? "" : "SIGHUP reruns a fresh application; "}Ctrl+C stops. ${command.watchFailed ? "Unchanged reruns select failed files while the original shared graph stays loaded." : ""}\n`,
		);
		session.request();
		while (!stopping) {
			if (watch === undefined)
				await new Promise((resolve) => {
					setTimeout(resolve, 75);
				});
			else await watch.wait(handle, 75);
			if (stopping) break;
			const paths = changed();
			if (paths.length > 0) requestChanges(paths);
		}
	} catch (error) {
		loopFailure = { error };
	} finally {
		stopping = true;
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		if (process.platform !== "win32") process.removeListener("SIGHUP", rerun);
		if (loopFailure !== undefined) failures.push(loopFailure.error);
		try {
			watch?.close(handle);
		} catch (error) {
			failures.push(error);
		}
		try {
			await session.close();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1)
		throw new AggregateError(failures, "test watch shutdown failed");
}
