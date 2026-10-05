import { readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import type { ResolvedBuildConfig } from "../build-config.ts";
import type { CommandContext } from "../cli-commands.ts";
import type { TestCommand } from "../cli.ts";
import { CommandProgress } from "../command-progress.ts";
import { frontendDependencyUnchanged } from "../frontend-cache.ts";
import { hostExecutionTarget, resolveExecution } from "../platform/execution.ts";
import {
	compileIsolatedTestImage,
	compileProfiledTestImage,
	TestCompilationSession,
} from "./cache.ts";
import type { CompiledTestImage, TestFrontendPhases } from "./cache.ts";
import { discoverTestFiles } from "./discovery.ts";
import { executeTestApplication } from "./execute.ts";
import {
	compileRelocatableTestImage,
	UnsupportedRelocatableTestImageError,
} from "./fragment-cache.ts";
import type { CompiledRelocatableTestImage } from "./fragment-cache.ts";
import { prepareTestApplication } from "./prepare.ts";
import type { PreparedTestApplication, TestCompilationInput } from "./prepare.ts";
import type { TestEvent, TestFailure, TestRunResult } from "./protocol.ts";
import { scheduleTestJobs } from "./scheduler.ts";
import { TestApplicationSession, TestSourceChangedError } from "./session.ts";
import type { TestGenerationControls } from "./session.ts";

export interface TestCommandSummary {
	exitCode: number;
	files: number;
	passed: number;
	failed: number;
	skipped: number;
	todo: number;
	discoveryMs: number;
	frontendMs: number;
	executionMs: number;
	cacheHits: number;
	cacheMisses: number;
	artifactHits: number;
	artifactMisses: number;
	failedFiles?: Array<string>;
}

export const ISOLATED_TEST_RESULT_PREFIX = "__MALIGATOR_ISOLATED_TEST_RESULT__";

function output(message = ""): void {
	// oxlint-disable-next-line no-console -- this is the product test reporter.
	console.log(message);
}

function relative(file: string): string {
	const value = path.relative(process.cwd(), file);
	return value === "" ? path.basename(file) : value;
}

function plural(count: number, singular: string): string {
	return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function formatFailure(failure: TestFailure): Array<string> {
	const lines = [`      ${failure.name ?? "Error"}: ${failure.message}`];
	if (failure.diff) {
		for (const line of failure.diff.split("\n")) lines.push(`        ${line}`);
	}
	if (failure.stack) {
		const frames = failure.stack
			.split("\n")
			.slice(1)
			.filter((line) => line.trim().startsWith("at "));
		for (const frame of frames) lines.push(`      ${frame.trim()}`);
	}
	return lines;
}

function reportFailures(file: string, events: Array<TestEvent>, write = output): void {
	const failures = events.filter(
		(event) => event.type === "test-fail" || event.type === "hook-fail",
	);
	if (failures.length === 0) return;
	write();
	write(`FAIL ${relative(file)}`);
	for (const event of failures) {
		const name = event.name.startsWith(`${file} > `)
			? event.name.slice(file.length + 3)
			: event.name === file
				? path.basename(file)
				: event.name;
		if (event.type === "test-fail") {
			write(`  ${name}`);
			for (const failure of event.failures) {
				for (const line of formatFailure(failure)) write(line);
			}
		} else {
			write(`  ${name} (${event.hook})`);
			for (const line of formatFailure(event.failure)) write(line);
		}
	}
}

interface CompiledGroup {
	files: Array<string>;
	compiled: PreparedTestApplication;
}

interface FrontendFailure {
	file: string;
	error: unknown;
}

function emptyPhases(): TestFrontendPhases {
	return {
		validationMs: 0,
		graphMs: 0,
		semanticMs: 0,
		compileMs: 0,
		serializeMs: 0,
		workerMs: 0,
	};
}

function addPhases(target: TestFrontendPhases, value: TestFrontendPhases): void {
	target.validationMs += value.validationMs;
	target.graphMs += value.graphMs;
	target.semanticMs += value.semanticMs;
	target.compileMs += value.compileMs;
	target.serializeMs += value.serializeMs;
	target.workerMs += value.workerMs;
}

function randomSeed(): number {
	return Math.floor(Math.random() * 0xffffffff) + 1;
}

function testConfig(command: TestCommand) {
	return {
		...(command.nameFilter === undefined ? {} : { nameFilter: command.nameFilter }),
		...(command.shuffle === undefined
			? {}
			: {
					shuffleSeed: command.shuffle === true ? randomSeed() : command.shuffle,
				}),
		repeat: command.repeat,
		bail: command.bail,
		timeoutMs: command.timeoutMs,
	};
}

export function createTestApplicationSession(
	command: TestCommand,
	context: CommandContext,
): TestApplicationSession {
	return new TestApplicationSession(testConfig(command), context.frontendSession);
}

/** Compile the selected test graph once with the same full optimization pipeline
 * as a production application. This is intentionally separate from the fast
 * interpreted test cache used without `--profile`. */
export function prepareProfiledTestCommand(
	command: TestCommand,
	context: CommandContext,
	config: ResolvedBuildConfig,
) {
	const discoveryStartedAt = Date.now();
	const files = discoverTestFiles(command.paths);
	const discoveryMs = Date.now() - discoveryStartedAt;
	if (files.length === 0) throw new Error("no test files were discovered");
	const moduleSource = readFileSync(context.installation.testModulePath, "utf-8");
	const nodeGlobalsSource = readFileSync(context.installation.nodeGlobalsPath, "utf-8");
	const frontendStartedAt = Date.now();
	const runOptions = testConfig(command);
	const execution = resolveExecution(
		command,
		config,
		{
			compiled: command.profile,
			optimization: command.profile ? "full" : "development",
			target: hostExecutionTarget(process.platform, process.arch),
		},
		runOptions.shuffleSeed ?? null,
	);
	const compiled = compileProfiledTestImage(
		{
			files,
			config,
			execution,
			stripTypes: context.stripTypes,
			stripperIdentity: context.installation.frontendIdentity,
			testModuleSource: moduleSource,
			nodeGlobalsSource,
			platformSourceRoot:
				context.installation.platformSourceRoot ??
				path.dirname(context.installation.nodeGlobalsPath),
		},
		runOptions,
	);
	return {
		...compiled,
		files,
		discoveryMs,
		frontendMs: Date.now() - frontendStartedAt,
	};
}

/** Compile ordinary development-mode tests for a child runtime whose native
 * feature policy matches the project config. */
export function prepareIsolatedTestCommand(
	command: TestCommand,
	context: CommandContext,
	config: ResolvedBuildConfig,
) {
	const discoveryStartedAt = Date.now();
	const files = discoverTestFiles(command.paths);
	const discoveryMs = Date.now() - discoveryStartedAt;
	if (files.length === 0) throw new Error("no test files were discovered");
	const moduleSource = readFileSync(context.installation.testModulePath, "utf-8");
	const nodeGlobalsSource = readFileSync(context.installation.nodeGlobalsPath, "utf-8");
	const frontendStartedAt = Date.now();
	const runOptions = testConfig(command);
	const execution = resolveExecution(
		command,
		config,
		{
			compiled: command.profile,
			optimization: command.profile ? "full" : "development",
			target: hostExecutionTarget(process.platform, process.arch),
		},
		runOptions.shuffleSeed ?? null,
	);
	const options = {
		files,
		config,
		execution,
		stripTypes: context.stripTypes,
		stripperIdentity: context.installation.frontendIdentity,
		testModuleSource: moduleSource,
		nodeGlobalsSource,
		platformSourceRoot:
			context.installation.platformSourceRoot ??
			path.dirname(context.installation.nodeGlobalsPath),
		session: new TestCompilationSession(),
		dependencyWorker: context.dependencyWorker,
	};
	let compiled: CompiledTestImage | CompiledRelocatableTestImage;
	try {
		compiled = compileRelocatableTestImage({
			...options,
			runner: { kind: "process", runOptions, resultPrefix: ISOLATED_TEST_RESULT_PREFIX },
		});
	} catch (error) {
		if (!(error instanceof UnsupportedRelocatableTestImageError)) throw error;
		compiled = compileIsolatedTestImage(options, runOptions, ISOLATED_TEST_RESULT_PREFIX);
	}
	return {
		...compiled,
		files,
		discoveryMs,
		frontendMs: Date.now() - frontendStartedAt,
	};
}

function reportTestProcessResult(
	result: TestRunResult,
	timing: {
		files: number;
		discoveryMs: number;
		frontendMs: number;
		executionMs: number;
		cacheHits?: number;
		cacheMisses?: number;
		artifactHits?: number;
		artifactMisses?: number;
	},
	mode: string,
): TestCommandSummary {
	for (const fileResult of result.files) {
		const count =
			fileResult.passed + fileResult.failed + fileResult.skipped + fileResult.todo;
		output(
			`${fileResult.failed === 0 ? "✓" : "✗"} ${relative(fileResult.file)}       ${plural(count, "test")}   ${fileResult.durationMs}ms   ${mode}`,
		);
		reportFailures(
			fileResult.file,
			result.events.filter((event) => "file" in event && event.file === fileResult.file),
		);
	}
	output();
	output(
		`${result.passed} passed, ${result.failed} failed` +
			`${result.skipped > 0 ? `, ${result.skipped} skipped` : ""}` +
			`${result.todo > 0 ? `, ${result.todo} todo` : ""} in ${Math.round(result.durationMs)}ms`,
	);
	output(
		`Timing: discovery ${timing.discoveryMs.toFixed(1)}ms, frontend ${timing.frontendMs.toFixed(1)}ms, execution ${timing.executionMs.toFixed(1)}ms`,
	);
	return {
		exitCode: result.failed === 0 ? 0 : 1,
		files: timing.files,
		passed: result.passed,
		failed: result.failed,
		skipped: result.skipped,
		todo: result.todo,
		discoveryMs: timing.discoveryMs,
		frontendMs: timing.frontendMs,
		executionMs: timing.executionMs,
		cacheHits: timing.cacheHits ?? 0,
		cacheMisses: timing.cacheMisses ?? 1,
		artifactHits: timing.artifactHits ?? 0,
		artifactMisses: timing.artifactMisses ?? 0,
	};
}

export function reportIsolatedTestResult(
	result: TestRunResult,
	timing: Parameters<typeof reportTestProcessResult>[1],
): TestCommandSummary {
	return reportTestProcessResult(result, timing, "isolated interpreter");
}

export function reportProfiledTestResult(
	result: TestRunResult,
	timing: {
		files: number;
		discoveryMs: number;
		frontendMs: number;
		executionMs: number;
	},
): TestCommandSummary {
	return reportTestProcessResult(result, timing, "production AOT");
}

/** Discover, compile to cached VM wire, and interpret the selected test files. */
export async function executeTestCommand(
	command: TestCommand,
	context: CommandContext,
	config: ResolvedBuildConfig,
	retained?: TestApplicationSession,
	controls: TestGenerationControls = {},
): Promise<TestCommandSummary> {
	const reports: Array<string> = [];
	const selectedFiles = controls.selectedFiles?.map((file) => {
		try {
			return realpathSync(path.resolve(file));
		} catch {
			return path.resolve(file);
		}
	});
	const writeReport = (message = "") => {
		reports.push(message);
	};
	const progress = new CommandProgress(
		controls.generation === undefined ? "test" : `test generation ${controls.generation}`,
	);
	progress.start("discover, compile, and execute selected tests");
	const applications = context.applications;
	if (applications === undefined) {
		throw new Error(
			"`maligator test` execution requires the self-hosted Maligator executable; " +
				"the Node-hosted development compiler does not pretend to interpret tests",
		);
	}

	const discoveryStartedAt = Date.now();
	progress.stage(1, 3, "discover tests");
	const files = discoverTestFiles(command.paths);
	const discoveryMs = Date.now() - discoveryStartedAt;
	if (files.length === 0) {
		throw new Error("no test files were discovered");
	}
	progress.stagePassed(1, 3, "discover tests", plural(files.length, "file"));
	const applicationSession = retained ?? createTestApplicationSession(command, context);
	applicationSession.begin(controls);
	try {
		const retainedContext = {
			...context,
			frontendSession: applicationSession.frontend,
		};
		const runOptions = applicationSession.options;
		const execution = resolveExecution(
			{
				...command,
				nameFilter: runOptions.nameFilter,
				shuffle: runOptions.shuffleSeed,
				repeat: runOptions.repeat,
				bail: runOptions.bail,
				timeoutMs: runOptions.timeoutMs,
			},
			config,
			{
				compiled: command.profile,
				optimization: command.profile ? "full" : "development",
				target: hostExecutionTarget(process.platform, process.arch),
			},
			runOptions.shuffleSeed ?? null,
		);
		if (runOptions.shuffleSeed !== undefined)
			writeReport(`Shuffle seed: ${runOptions.shuffleSeed}`);
		const isolated = command.isolation === "file";
		const parallelism = context.compiler?.parallelism ?? 1;
		const compileConcurrency = isolated
			? Math.min(command.compileConcurrency, parallelism)
			: 1;
		const executionConcurrency = isolated
			? Math.min(command.executionConcurrency ?? 1, files.length, parallelism)
			: 1;
		writeReport(
			`Scheduling: ${compileConcurrency} compiler job${compileConcurrency === 1 ? "" : "s"}, ${executionConcurrency} application isolate${executionConcurrency === 1 ? "" : "s"}; ${isolated ? "file isolation" : "shared suite state"}`,
		);

		let passed = 0;
		let failed = 0;
		const failedFiles = new Set<string>();
		let skipped = 0;
		let todo = 0;
		let frontendMs = 0;
		let executionMs = 0;
		let cacheHits = 0;
		let cacheMisses = 0;
		let artifactHits = 0;
		let artifactMisses = 0;
		const startedAt = Date.now();
		const phases = emptyPhases();
		const groups: Array<CompiledGroup> = [];
		const frontendFailures: Array<FrontendFailure> = [];
		progress.stage(2, 3, "compile test image");

		const recordCompilation = (
			entries: Array<string>,
			compiled: PreparedTestApplication,
		): void => {
			controls.prepared?.(compiled);
			const changed = compiled.dependencyIdentities
				.filter((identity) => !frontendDependencyUnchanged(identity))
				.map((identity) => identity.path);
			if (changed.length > 0) throw new TestSourceChangedError(changed);
			frontendMs += compiled.frontendMs;
			addPhases(phases, compiled.phases);
			if (compiled.cache === "hit") cacheHits++;
			else cacheMisses++;
			artifactHits += compiled.artifactHits;
			artifactMisses += compiled.artifactMisses;
			groups.push({ files: entries, compiled });
		};

		const compile = async (input: TestCompilationInput) =>
			applicationSession.prepare(input, async (request) => {
				controls.signal?.throwIfAborted();
				const prepared =
					context.compiler?.prepareTests === undefined
						? prepareTestApplication(request, retainedContext)
						: await context.compiler.prepareTests(request, {
								concurrency: compileConcurrency,
								signal: controls.signal,
								invalidatedPaths: controls.invalidatedPaths,
								invalidateAll: controls.invalidateAll,
								onPhase: controls.onPhase,
							});
				return prepared;
			});
		const compileGroup = async (
			entries: Array<string>,
			allowSupersetCache = true,
			wholeImage = false,
		): Promise<void> => {
			try {
				controls.signal?.throwIfAborted();
				const compiled = await compile({
					files: entries,
					config,
					execution,
					allowSupersetCache,
					wholeImage,
				});
				recordCompilation(entries, compiled);
			} catch (error) {
				controls.signal?.throwIfAborted();
				if (error instanceof TestSourceChangedError) throw error;
				if (entries.length > 1) {
					const middle = Math.floor(entries.length / 2);
					await compileGroup(entries.slice(0, middle), allowSupersetCache, wholeImage);
					if (!command.bail || frontendFailures.length === 0) {
						await compileGroup(entries.slice(middle), allowSupersetCache, wholeImage);
					}
				} else {
					frontendFailures.push({ file: entries[0]!, error });
				}
			}
		};
		if (isolated) {
			await scheduleTestJobs(
				files,
				compileConcurrency,
				(file) => compileGroup([file]),
				() => !command.bail || frontendFailures.length === 0,
			);
			const order = new Map(files.map((file, index) => [file, index]));
			groups.sort(
				(left, right) => order.get(left.files[0]!)! - order.get(right.files[0]!)!,
			);
			frontendFailures.sort(
				(left, right) => order.get(left.file)! - order.get(right.file)!,
			);
		} else {
			await compileGroup(files);
		}
		if (frontendFailures.length === 0) {
			progress.stagePassed(
				2,
				3,
				"compile test image",
				`${cacheHits} cache hit/${cacheMisses} miss`,
			);
		} else {
			progress.stageFailed(2, 3, "compile test image");
		}

		for (const failure of frontendFailures) {
			failedFiles.add(failure.file);
			failed++;
			writeReport(`✗ ${relative(failure.file)}       frontend error`);
			writeReport();
			writeReport(`FAIL ${relative(failure.file)}`);
			writeReport(
				`  ${failure.error instanceof SyntaxError ? "SyntaxError" : "ModuleLoadError"}: ${
					failure.error instanceof Error ? failure.error.message : String(failure.error)
				}`,
			);
		}
		if (command.bail && frontendFailures.length > 0) groups.length = 0;
		const shouldExecute = (group: CompiledGroup) =>
			selectedFiles === undefined ||
			group.files.some((file) => selectedFiles.includes(file));

		progress.stage(3, 3, "execute tests");
		let executionFailed = false;
		const executionStageStartedAt = Date.now();
		const executed = isolated
			? await scheduleTestJobs(
					groups.filter(shouldExecute),
					executionConcurrency,
					async (group) => {
						try {
							const result = await executeTestApplication(
								applications,
								group.compiled,
								{
									...runOptions,
									...(selectedFiles === undefined
										? {}
										: {
												files: selectedFiles.filter((file) => group.files.includes(file)),
											}),
								},
								{
									image: applicationSession.image(applications, group.compiled),
									signal: controls.signal,
								},
							);
							executionFailed ||= result.failed > 0;
							return { ok: true as const, result };
						} catch (error) {
							executionFailed = true;
							return { ok: false as const, error };
						}
					},
					() => !command.bail || !executionFailed,
				)
			: undefined;
		if (executed !== undefined) executionMs = Date.now() - executionStageStartedAt;
		for (const [groupIndex, group] of groups.entries()) {
			if (!shouldExecute(group)) continue;
			if (executed !== undefined && !executed.has(group)) continue;
			progress.progress(
				groupIndex + 1,
				groups.length,
				`execute ${plural(group.files.length, "file")}`,
			);
			const executionStartedAt = Date.now();
			let result: TestRunResult;
			try {
				const outcome = executed?.get(group);
				if (outcome !== undefined) {
					if (!outcome.ok) throw outcome.error;
					result = outcome.result;
				} else {
					result = await executeTestApplication(
						applications,
						group.compiled,
						{
							...runOptions,
							...(selectedFiles === undefined
								? {}
								: {
										files: selectedFiles.filter((file) => group.files.includes(file)),
									}),
						},
						{
							image: applicationSession.image(applications, group.compiled),
							signal: controls.signal,
						},
					);
				}
			} catch (error) {
				controls.signal?.throwIfAborted();
				if (!command.bail && group.files.length > 1) {
					const middle = Math.floor(group.files.length / 2);
					for (const entries of [
						group.files.slice(0, middle),
						group.files.slice(middle),
					]) {
						try {
							const compiled = await compile({
								files: entries,
								config,
								execution,
								allowSupersetCache: false,
								wholeImage: true,
							});
							recordCompilation(entries, compiled);
						} catch (compileError) {
							for (const file of entries) {
								frontendFailures.push({ file, error: compileError });
								failed++;
								failedFiles.add(file);
								writeReport(`✗ ${relative(file)}       frontend error`);
							}
						}
					}
					continue;
				}
				for (const file of group.files) failedFiles.add(file);
				failed += group.files.length;
				const label =
					group.files.length === 1
						? relative(group.files[0]!)
						: `${group.files.length}-file test image`;
				writeReport(`✗ ${label}       module-load error`);
				writeReport();
				writeReport(`FAIL ${label}`);
				writeReport(
					`  ModuleLoadError: ${error instanceof Error ? error.message : String(error)}`,
				);
				if (command.bail && executed === undefined) break;
				continue;
			} finally {
				if (executed === undefined) executionMs += Date.now() - executionStartedAt;
			}
			passed += result.passed;
			failed += result.failed;
			skipped += result.skipped;
			todo += result.todo;
			for (const fileResult of result.files) {
				if (fileResult.failed > 0) failedFiles.add(fileResult.file);
				const status = fileResult.failed === 0 ? "✓" : "✗";
				const testCount =
					fileResult.passed + fileResult.failed + fileResult.skipped + fileResult.todo;
				writeReport(
					`${status} ${relative(fileResult.file)}       ${plural(testCount, "test")}   ` +
						`${fileResult.durationMs}ms   image cache ${group.compiled.cache}`,
				);
				reportFailures(
					fileResult.file,
					result.events.filter(
						(event) => "file" in event && event.file === fileResult.file,
					),
					writeReport,
				);
			}
			if (command.bail && result.failed > 0 && executed === undefined) break;
		}

		const durationMs = Date.now() - startedAt;
		controls.signal?.throwIfAborted();
		const changed = controls.validate?.() ?? [];
		if (changed.length > 0) throw new TestSourceChangedError(changed);
		writeReport();
		writeReport(
			`${passed} passed, ${failed} failed` +
				`${skipped > 0 ? `, ${skipped} skipped` : ""}` +
				`${todo > 0 ? `, ${todo} todo` : ""} in ${Math.round(durationMs)}ms`,
		);
		writeReport(
			`Timing: discovery ${discoveryMs.toFixed(1)}ms, frontend ${frontendMs.toFixed(
				1,
			)}ms, execution ${executionMs.toFixed(1)}ms; cache ${cacheHits} hit/${cacheMisses} miss`,
		);
		if (artifactHits + artifactMisses > 0) {
			writeReport(`Artifacts: ${artifactHits} hit/${artifactMisses} miss`);
		}
		writeReport(
			`Frontend: validation ${phases.validationMs.toFixed(1)}ms, graph ${phases.graphMs.toFixed(
				1,
			)}ms, semantic ${phases.semanticMs.toFixed(1)}ms, compile ${phases.compileMs.toFixed(
				1,
			)}ms, serialize ${phases.serializeMs.toFixed(1)}ms, workers ${phases.workerMs.toFixed(1)}ms`,
		);
		if (failed === 0) progress.stagePassed(3, 3, "execute tests", plural(passed, "test"));
		else progress.stageFailed(3, 3, "execute tests");
		if (failed === 0) progress.complete();
		else progress.failed();
		if (controls.isCurrent?.() !== false) for (const line of reports) output(line);
		return {
			failedFiles: [...failedFiles],
			exitCode: failed === 0 ? 0 : 1,
			files: files.length,
			passed,
			failed,
			skipped,
			todo,
			discoveryMs,
			frontendMs,
			executionMs,
			cacheHits,
			cacheMisses,
			artifactHits,
			artifactMisses,
		};
	} finally {
		try {
			applicationSession.finish();
		} finally {
			if (retained === undefined) applicationSession.close();
		}
	}
}
