import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { ResolvedBuildConfig } from "../build-config.ts";
import type { CommandContext } from "../cli-commands.ts";
import type { TestCommand } from "../cli.ts";
import { CommandProgress } from "../command-progress.ts";
import {
	compileProfiledTestImage,
	compileTestImage,
	TestCompilationSession,
} from "./cache.ts";
import type { CompiledTestImage, TestFrontendPhases } from "./cache.ts";
import { discoverTestFiles } from "./discovery.ts";
import {
	compileRelocatableTestImage,
	UnsupportedRelocatableTestImageError,
} from "./fragment-cache.ts";
import type { CompiledRelocatableTestImage } from "./fragment-cache.ts";
import type { TestEvent, TestFailure, TestRunResult } from "./protocol.ts";

interface TestRuntimeBridge {
	_runWire(wire: Uint8Array): unknown;
	_runWirePath?(path: string): unknown;
}

interface TestGlobals {
	__maligatorTestOptions?: {
		files?: Array<string>;
		nameFilter?: string;
		shuffleSeed?: number;
		repeat: number;
		bail: boolean;
		timeoutMs: number;
	};
	__maligatorTestResult?: TestRunResult;
	mal?: TestRuntimeBridge;
}

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
}

function output(message = ""): void {
	// eslint-disable-next-line no-console -- this is the product test reporter.
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

function reportFailures(file: string, events: Array<TestEvent>): void {
	const failures = events.filter(
		(event) => event.type === "test-fail" || event.type === "hook-fail",
	);
	if (failures.length === 0) return;
	output();
	output(`FAIL ${relative(file)}`);
	for (const event of failures) {
		const name = event.name.startsWith(`${file} > `)
			? event.name.slice(file.length + 3)
			: event.name === file
				? path.basename(file)
				: event.name;
		if (event.type === "test-fail") {
			output(`  ${name}`);
			for (const failure of event.failures) {
				for (const line of formatFailure(failure)) output(line);
			}
		} else {
			output(`  ${name} (${event.hook})`);
			for (const line of formatFailure(event.failure)) output(line);
		}
	}
}

interface CompiledGroup {
	files: Array<string>;
	compiled: CompiledTestImage | CompiledRelocatableTestImage;
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
			: { shuffleSeed: command.shuffle === true ? randomSeed() : command.shuffle }),
		repeat: command.repeat,
		bail: command.bail,
		timeoutMs: command.timeoutMs,
	};
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
	const nodeGlobalsSource = readFileSync(
		context.installation.testNodeGlobalsPath,
		"utf-8",
	);
	const frontendStartedAt = Date.now();
	const compiled = compileProfiledTestImage(
		{
			files,
			config,
			stripTypes: context.stripTypes,
			stripperIdentity: context.installation.frontendIdentity,
			testModuleSource: moduleSource,
			nodeGlobalsSource,
		},
		testConfig(command),
	);
	return { ...compiled, files, discoveryMs, frontendMs: Date.now() - frontendStartedAt };
}

export function reportProfiledTestResult(
	result: TestRunResult,
	timing: { files: number; discoveryMs: number; frontendMs: number; executionMs: number },
): TestCommandSummary {
	for (const fileResult of result.files) {
		const count =
			fileResult.passed + fileResult.failed + fileResult.skipped + fileResult.todo;
		output(
			`${fileResult.failed === 0 ? "✓" : "✗"} ${relative(fileResult.file)}       ${plural(count, "test")}   ${fileResult.durationMs}ms   production AOT`,
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
		`Timing: discovery ${timing.discoveryMs.toFixed(1)}ms, production frontend ${timing.frontendMs.toFixed(1)}ms, execution ${timing.executionMs.toFixed(1)}ms`,
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
		cacheHits: 0,
		cacheMisses: 1,
		artifactHits: 0,
		artifactMisses: 0,
	};
}

/** Discover, compile to cached VM wire, and interpret the selected test files. */
export async function executeTestCommand(
	command: TestCommand,
	context: CommandContext,
	config: ResolvedBuildConfig,
): Promise<TestCommandSummary> {
	const progress = new CommandProgress("test");
	progress.start("discover, compile, and execute selected tests");
	const globals = globalThis as typeof globalThis & TestGlobals;
	if (globals.mal?._runWire === undefined) {
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
	const moduleSource = readFileSync(context.installation.testModulePath, "utf-8");
	const nodeGlobalsSource =
		context.installation.testNodeGlobalsPath === undefined
			? undefined
			: readFileSync(context.installation.testNodeGlobalsPath, "utf-8");
	const runOptions = testConfig(command);
	if (runOptions.shuffleSeed !== undefined)
		output(`Shuffle seed: ${runOptions.shuffleSeed}`);
	if (command.compileConcurrency > 1) {
		output(
			`warning: frontend workers are not available yet; compile concurrency is 1 ` +
				`(requested ${command.compileConcurrency}), execution concurrency remains 1`,
		);
	}

	let passed = 0;
	let failed = 0;
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
	const session = new TestCompilationSession();
	const groups: Array<CompiledGroup> = [];
	const frontendFailures: Array<FrontendFailure> = [];
	progress.stage(2, 3, "compile test image");

	const recordCompilation = (
		entries: Array<string>,
		compiled: CompiledTestImage | CompiledRelocatableTestImage,
	): void => {
		frontendMs += compiled.frontendMs;
		addPhases(phases, compiled.phases);
		if (compiled.cache === "hit") cacheHits++;
		else cacheMisses++;
		if ("artifactHits" in compiled) {
			artifactHits += compiled.artifactHits;
			artifactMisses += compiled.artifactMisses;
		}
		groups.push({ files: entries, compiled });
	};

	const compileGroup = (entries: Array<string>, allowSupersetCache = true): void => {
		try {
			const options = {
				files: entries,
				config,
				stripTypes: context.stripTypes,
				stripperIdentity: context.installation.frontendIdentity,
				testModuleSource: moduleSource,
				nodeGlobalsSource,
				session,
				allowSupersetCache,
				dependencyWorker: context.dependencyWorker,
			};
			let compiled: CompiledTestImage | CompiledRelocatableTestImage;
			try {
				compiled = compileRelocatableTestImage(options);
			} catch (error) {
				if (!(error instanceof UnsupportedRelocatableTestImageError)) throw error;
				compiled = compileTestImage(options);
			}
			recordCompilation(entries, compiled);
		} catch (error) {
			if (entries.length > 1) {
				const middle = Math.floor(entries.length / 2);
				compileGroup(entries.slice(0, middle));
				if (!command.bail || frontendFailures.length === 0) {
					compileGroup(entries.slice(middle));
				}
			} else {
				frontendFailures.push({ file: entries[0]!, error });
			}
		}
	};
	compileGroup(files);
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
		failed++;
		output(`✗ ${relative(failure.file)}       frontend error`);
		output();
		output(`FAIL ${relative(failure.file)}`);
		output(
			`  ${failure.error instanceof SyntaxError ? "SyntaxError" : "ModuleLoadError"}: ${
				failure.error instanceof Error ? failure.error.message : String(failure.error)
			}`,
		);
	}
	if (command.bail && frontendFailures.length > 0) groups.length = 0;

	progress.stage(3, 3, "execute tests");
	for (const [groupIndex, group] of groups.entries()) {
		progress.progress(
			groupIndex + 1,
			groups.length,
			`execute ${plural(group.files.length, "file")}`,
		);
		const executionStartedAt = Date.now();
		globals.__maligatorTestOptions = { ...runOptions, files: group.files };
		delete globals.__maligatorTestResult;
		try {
			if ("wires" in group.compiled && globals.mal._runWirePath !== undefined) {
				for (const wire of group.compiled.wires) {
					await globals.mal._runWirePath(wire.path);
				}
			} else {
				const wires =
					"wires" in group.compiled
						? group.compiled.wires.map((wire) => wire.wire)
						: [group.compiled.wire];
				for (const wire of wires) await globals.mal._runWire(wire);
			}
		} catch (error) {
			if (!command.bail && group.files.length > 1) {
				const middle = Math.floor(group.files.length / 2);
				for (const entries of [group.files.slice(0, middle), group.files.slice(middle)]) {
					try {
						const compiled = compileTestImage({
							files: entries,
							config,
							stripTypes: context.stripTypes,
							stripperIdentity: context.installation.frontendIdentity,
							testModuleSource: moduleSource,
							nodeGlobalsSource,
							session,
							allowSupersetCache: false,
						});
						recordCompilation(entries, compiled);
					} catch (compileError) {
						for (const file of entries) {
							frontendFailures.push({ file, error: compileError });
							failed++;
							output(`✗ ${relative(file)}       frontend error`);
						}
					}
				}
				continue;
			}
			failed += group.files.length;
			const label =
				group.files.length === 1
					? relative(group.files[0]!)
					: `${group.files.length}-file test image`;
			output(`✗ ${label}       module-load error`);
			output();
			output(`FAIL ${label}`);
			output(
				`  ModuleLoadError: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (command.bail) break;
			continue;
		} finally {
			executionMs += Date.now() - executionStartedAt;
			delete globals.__maligatorTestOptions;
		}
		const result = Reflect.get(globals, "__maligatorTestResult");
		delete globals.__maligatorTestResult;
		if (result === undefined) {
			failed += group.files.length;
			output(`✗ ${group.files.length}-file test image       runner infrastructure error`);
			if (command.bail) break;
			continue;
		}
		passed += result.passed;
		failed += result.failed;
		skipped += result.skipped;
		todo += result.todo;
		for (const fileResult of result.files) {
			const status = fileResult.failed === 0 ? "✓" : "✗";
			const testCount =
				fileResult.passed + fileResult.failed + fileResult.skipped + fileResult.todo;
			output(
				`${status} ${relative(fileResult.file)}       ${plural(testCount, "test")}   ` +
					`${fileResult.durationMs}ms   image cache ${group.compiled.cache}`,
			);
			reportFailures(
				fileResult.file,
				result.events.filter(
					(event) => "file" in event && event.file === fileResult.file,
				),
			);
		}
		if (command.bail && result.failed > 0) break;
	}

	const durationMs = Date.now() - startedAt;
	output();
	output(
		`${passed} passed, ${failed} failed` +
			`${skipped > 0 ? `, ${skipped} skipped` : ""}` +
			`${todo > 0 ? `, ${todo} todo` : ""} in ${Math.round(durationMs)}ms`,
	);
	output(
		`Timing: discovery ${discoveryMs.toFixed(1)}ms, frontend ${frontendMs.toFixed(
			1,
		)}ms, execution ${executionMs.toFixed(1)}ms; cache ${cacheHits} hit/${cacheMisses} miss`,
	);
	if (artifactHits + artifactMisses > 0) {
		output(`Artifacts: ${artifactHits} hit/${artifactMisses} miss`);
	}
	output(
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
	return {
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
}
