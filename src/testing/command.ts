import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { ResolvedBuildConfig } from "../build-config.ts";
import type { CommandContext } from "../cli-commands.ts";
import type { TestCommand } from "../cli.ts";
import { compileTestFile } from "./cache.ts";
import { discoverTestFiles } from "./discovery.ts";
import type { TestEvent, TestFailure, TestRunResult } from "./protocol.ts";

interface TestRuntimeBridge {
	_runWire(wire: Uint8Array): unknown;
}

interface TestGlobals {
	__maligatorTestOptions?: {
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
		if (event.type === "test-fail") {
			output(`  ${event.name}`);
			for (const failure of event.failures) {
				for (const line of formatFailure(failure)) output(line);
			}
		} else {
			output(`  ${event.name} (${event.hook})`);
			for (const line of formatFailure(event.failure)) output(line);
		}
	}
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

/** Discover, compile to cached VM wire, and interpret the selected test files. */
export async function executeTestCommand(
	command: TestCommand,
	context: CommandContext,
	config: ResolvedBuildConfig,
): Promise<TestCommandSummary> {
	const globals = globalThis as typeof globalThis & TestGlobals;
	if (globals.mal?._runWire === undefined) {
		throw new Error(
			"`maligator test` execution requires the self-hosted Maligator executable; " +
				"the Node-hosted development compiler does not pretend to interpret tests",
		);
	}

	const discoveryStartedAt = Date.now();
	const files = discoverTestFiles(command.paths);
	const discoveryMs = Date.now() - discoveryStartedAt;
	if (files.length === 0) {
		throw new Error("no test files were discovered");
	}
	const moduleSource = readFileSync(context.installation.testModulePath, "utf-8");
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
	const startedAt = Date.now();

	for (const file of files) {
		let compiled: ReturnType<typeof compileTestFile>;
		try {
			compiled = compileTestFile({
				file,
				config,
				stripTypes: context.stripTypes,
				stripperIdentity: context.installation.frontendIdentity,
				testModuleSource: moduleSource,
			});
			frontendMs += compiled.frontendMs;
			if (compiled.cache === "hit") cacheHits++;
			else cacheMisses++;
		} catch (error) {
			failed++;
			output(`✗ ${relative(file)}       frontend error`);
			output();
			output(`FAIL ${relative(file)}`);
			output(
				`  ${error instanceof SyntaxError ? "SyntaxError" : "ModuleLoadError"}: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (command.bail) break;
			continue;
		}

		const executionStartedAt = Date.now();
		globals.__maligatorTestOptions = runOptions;
		delete globals.__maligatorTestResult;
		try {
			await globals.mal._runWire(compiled.wire);
		} catch (error) {
			failed++;
			output(`✗ ${relative(file)}       module-load error`);
			output();
			output(`FAIL ${relative(file)}`);
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
			failed++;
			output(`✗ ${relative(file)}       runner infrastructure error`);
			if (command.bail) break;
			continue;
		}
		passed += result.passed;
		failed += result.failed;
		skipped += result.skipped;
		todo += result.todo;
		const status = result.failed === 0 ? "✓" : "✗";
		const testCount = result.passed + result.failed + result.skipped + result.todo;
		output(
			`${status} ${relative(file)}       ${plural(testCount, "test")}   ` +
				`${result.durationMs}ms   cache ${compiled.cache}`,
		);
		reportFailures(file, result.events);
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
	};
}
