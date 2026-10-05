import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, test, vi } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import {
	compileBuildFrontend,
	compileBuildFrontendAsync,
} from "../src/build-frontend-cache.ts";
import type {
	BuildRootCompiler,
	CompileBuildFrontendOptions,
} from "../src/build-frontend-cache.ts";
import {
	prepareCommandAsync,
	developmentCompilerInstallation,
} from "../src/cli-commands.ts";
import type { BuildCommand } from "../src/cli.ts";
import { parseCliArgs } from "../src/cli.ts";
import { compilerProducerImplementationDigestForRoot } from "../src/compiler-cache-identity.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { compileWorkerImages } from "../src/compiler/pipeline/compile-worker-images.ts";
import {
	validateRootInputs,
	captureRootPackageAbsences,
} from "../src/compiler/root-compilation.ts";
import type { RootCompilationResult } from "../src/compiler/root-compilation.ts";
import { serializeCompilerArtifact } from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramTranslationUnits } from "../src/compiler/target/emit-program-image.ts";

const directories: Array<string> = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
function fixture(workers = true): CompileBuildFrontendOptions {
	const root = mkdtempSync(path.join(tmpdir(), "mal-root-common-"));
	directories.push(root);
	writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
	writeFileSync(
		path.join(root, "entry.mts"),
		workers
			? 'import {createWorkerUrl} from "maligator:workers"; console.log(createWorkerUrl("./first.mts", import.meta.url), createWorkerUrl("./second.mts", import.meta.url));\n'
			: 'console.log("zero roots");\n',
	);
	writeFileSync(path.join(root, "first.mts"), 'console.log("first");\n');
	writeFileSync(path.join(root, "second.mts"), 'console.log("second");\n');
	return {
		entrypoint: path.join(root, "entry.mts"),
		cacheDirectory: path.join(root, "cache"),
		config: resolveBuildConfig({
			surface: { node: false, webPlatform: false, maligator: true },
			engine: { eval: false, regexp: false, intl: { enabled: false } },
		}),
		optimization: "full",
		stripTypes: stripCompactTypes,
		stripperIdentity: "common-flow",
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function immediateCompiler(): BuildRootCompiler {
	return {
		validateInputs: validateRootInputs,
		start(graph, options, inputs) {
			const diagnostics: RootCompilationResult["diagnostics"] = [];
			const workers = compileWorkerImages(graph, {
				...options,
				onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
			});
			return {
				result: Promise.resolve({
					workers,
					diagnostics,
					dependencies: [...inputs],
					packageAbsences: captureRootPackageAbsences(graph),
				}),
				cancel() {},
				close: async () => {},
			};
		},
	};
}

test("serial and async shared flow retain complete compiler/runtime/C outputs and root order", async () => {
	const options = fixture();
	const serial = compileBuildFrontend({ ...options, forceCompile: true });
	const asyncResult = await compileBuildFrontendAsync(
		{ ...options, forceCompile: true },
		immediateCompiler(),
		{ concurrency: 3 },
	);
	assert.deepEqual(
		serializeCompilerArtifact(asyncResult.programImage),
		serializeCompilerArtifact(serial.programImage),
	);
	assert.deepEqual(asyncResult.wire, serial.wire);
	assert.deepEqual(
		emitProgramTranslationUnits(asyncResult.programImage),
		emitProgramTranslationUnits(serial.programImage),
	);
	assert.deepEqual(asyncResult.diagnostics, serial.diagnostics);
	assert.deepEqual(
		serial.workerImages
			.filter((worker) => worker.entry.workerSource === undefined)
			.map((worker) => path.basename(worker.entry.path)),
		["first.mts", "second.mts"],
	);
	assert.equal(
		serial.workerImages.filter((worker) => worker.entry.workerSource !== undefined)
			.length,
		1,
	);
	assert.deepEqual(
		asyncResult.workerImages.map((worker) => ({
			entry: worker.entry,
			wire: worker.wire,
			c: emitProgramTranslationUnits(worker.image),
		})),
		serial.workerImages.map((worker) => ({
			entry: worker.entry,
			wire: worker.wire,
			c: emitProgramTranslationUnits(worker.image),
		})),
	);
});

test("cache hits and graphs without roots admit no transport jobs", async () => {
	const options = fixture();
	compileBuildFrontend(options);
	const compiler: BuildRootCompiler = {
		validateInputs: validateRootInputs,
		start() {
			throw new Error("unexpected admission");
		},
	};
	assert.equal(
		(await compileBuildFrontendAsync(options, compiler, { concurrency: 3 })).cache,
		"hit",
	);
	const noRoots = await compileBuildFrontendAsync(fixture(false), compiler, {
		concurrency: 3,
	});
	assert.equal(noRoots.workerImages.length, 0);
});

for (const mode of ["serial", "custom-strip"] as const)
	for (const cached of [false, true])
		test(`precancelled ${mode} fallback rejects before ${cached ? "warm cache return" : "compilation or cache publication"}`, async () => {
			let strips = 0;
			let phases = 0;
			let admissions = 0;
			const options = fixture();
			if (mode === "custom-strip")
				options.stripTypes = (...args: Parameters<typeof stripCompactTypes>) => {
					strips++;
					return stripCompactTypes(...args);
				};
			options.onCompilePhase = () => {
				phases++;
			};
			if (cached) assert.equal(compileBuildFrontend(options).cache, "miss");
			strips = 0;
			phases = 0;
			const compiler: BuildRootCompiler = {
				validateInputs: validateRootInputs,
				start() {
					admissions++;
					assert.fail("precancelled compilation admitted root helpers");
				},
			};
			const controller = new AbortController();
			const reason = Object.freeze({ cancelled: mode, cached });
			controller.abort(reason);
			await assert.rejects(
				compileBuildFrontendAsync(options, compiler, {
					concurrency: mode === "serial" ? 1 : 3,
					signal: controller.signal,
				}),
				(error: unknown) => {
					assert.equal(error, reason);
					return true;
				},
			);
			assert.equal(strips, 0);
			assert.equal(phases, 0);
			assert.equal(admissions, 0);
			assert.equal(existsSync(options.cacheDirectory!), cached);
		});

for (const error of [new Error("owner failed"), undefined])
	test(`owner failure ${String(error)} wins after result and close drain`, async () => {
		const options = fixture();
		const result = deferred<RootCompilationResult>();
		const close = deferred<void>();
		const cancelled: Array<unknown> = [];
		let settled = false;
		let closing = false;
		const compiler: BuildRootCompiler = {
			validateInputs: validateRootInputs,
			start() {
				return {
					result: result.promise,
					cancel(reason) {
						cancelled.push(reason);
					},
					close: async () => {
						closing = true;
						await close.promise;
					},
				};
			},
		};
		const pending = compileBuildFrontendAsync(
			{
				...options,
				afterCoreOptimization() {
					// eslint-disable-next-line typescript/only-throw-error -- An undefined throw must survive asynchronous error precedence.
					throw error;
				},
			},
			compiler,
			{ concurrency: 3 },
		);
		const observed = pending.then(
			() => assert.fail("owner failure was lost"),
			(reason) => {
				assert.equal(reason, error);
				settled = true;
			},
		);
		assert.deepEqual(cancelled, [error]);
		result.reject(new Error("worker failed later"));
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(closing, true);
		assert.equal(settled, false);
		close.resolve();
		await observed;
		assert.equal(settled, true);
	});

test("worker errors are delivered only after joined cleanup", async () => {
	const options = fixture();
	const close = deferred<void>();
	const failure = new SyntaxError("worker syntax");
	let settled = false;
	const compiler: BuildRootCompiler = {
		validateInputs: validateRootInputs,
		start() {
			return { result: Promise.reject(failure), cancel() {}, close: () => close.promise };
		},
	};
	const pending = compileBuildFrontendAsync(options, compiler, { concurrency: 3 });
	const observed = pending.then(
		() => assert.fail("worker error was lost"),
		(error) => {
			assert.equal(error, failure);
			settled = true;
		},
	);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(settled, false);
	close.resolve();
	await observed;
});

test("an edit during root join prevents frontend publication", async () => {
	const options = fixture();
	const result = deferred<RootCompilationResult>();
	let accepted: RootCompilationResult | undefined;
	const base = immediateCompiler();
	const compiler: BuildRootCompiler = {
		validateInputs: validateRootInputs,
		start(graph, workerOptions, inputs, controls) {
			const prepared = base.start(graph, workerOptions, inputs, controls);
			void prepared.result.then((value) => {
				accepted = value;
			});
			return { result: result.promise, cancel() {}, close: async () => {} };
		},
	};
	const pending = compileBuildFrontendAsync(options, compiler, { concurrency: 3 });
	await Promise.resolve();
	writeFileSync(
		path.join(path.dirname(options.entrypoint), "first.mts"),
		'console.log("changed");\n',
	);
	result.resolve(accepted!);
	await assert.rejects(pending, /input changed before publication/);
	const retry = compileBuildFrontend(options);
	assert.equal(retry.cache, "miss");
});

test("additional worker dependencies participate in the published cache identity", async () => {
	const options = fixture();
	const extra = path.join(path.dirname(options.entrypoint), "extra.txt");
	writeFileSync(extra, "first");
	const base = immediateCompiler();
	const { FrontendCompilationSession } = await import("../src/frontend-cache.ts");
	const identity = new FrontendCompilationSession().snapshot(extra);
	const withExtra: BuildRootCompiler = {
		validateInputs: validateRootInputs,
		start(graph, workerOptions, inputs, controls) {
			const handle = base.start(graph, workerOptions, inputs, controls);
			return {
				...handle,
				result: handle.result.then((value) => ({
					...value,
					dependencies: [...value.dependencies, identity],
				})),
			};
		},
	};
	const first = await compileBuildFrontendAsync(options, withExtra, { concurrency: 3 });
	assert.ok(first.dependencies.includes(extra));
	assert.equal(compileBuildFrontend(options).cache, "hit");
	writeFileSync(extra, "second");
	assert.equal(compileBuildFrontend(options).cache, "miss");
});

test("the worker entry and transitive worker imports invalidate the build producer", () => {
	const root = mkdtempSync(path.join(tmpdir(), "mal-root-producer-"));
	directories.push(root);
	const sourceRoot = path.join(root, "src");
	mkdirSync(sourceRoot);
	writeFileSync(path.join(root, "package.json"), "{}");
	writeFileSync(
		path.join(sourceRoot, "build-frontend-cache.ts"),
		"export const frontend=1;",
	);
	writeFileSync(
		path.join(sourceRoot, "node-root-compiler-worker.ts"),
		'import "./root-kernel.ts";',
	);
	writeFileSync(
		path.join(sourceRoot, "native-root-compiler-worker.ts"),
		'import "./native-kernel.ts";',
	);
	writeFileSync(path.join(sourceRoot, "native-kernel.ts"), "export const kernel=1;");
	writeFileSync(path.join(sourceRoot, "root-kernel.ts"), "export const kernel=1;");
	const digest = () =>
		compilerProducerImplementationDigestForRoot(
			"build-frontend",
			sourceRoot,
			path.join(root, "cache"),
		);
	const first = digest();
	writeFileSync(path.join(sourceRoot, "root-kernel.ts"), "export const kernel=2;");
	assert.notEqual(digest(), first);
	const second = digest();
	writeFileSync(path.join(sourceRoot, "native-kernel.ts"), "export const kernel=2;");
	assert.notEqual(digest(), second);
});

test("build concurrency counts owner jobs and requires the supported production route", () => {
	assert.equal(
		(
			parseCliArgs([
				"build",
				"entry.mjs",
				"--production",
				"--compile-concurrency",
				"3",
			]) as { compileConcurrency: number }
		).compileConcurrency,
		3,
	);
	assert.throws(
		() => parseCliArgs(["build", "entry.mjs", "--compile-concurrency", "3"]),
		/requires --production/,
	);
	assert.throws(
		() =>
			parseCliArgs([
				"build",
				"entry.mjs",
				"--production",
				"--profile",
				"--compile-concurrency",
				"3",
			]),
		/without --profile/,
	);
	assert.throws(
		() =>
			parseCliArgs(["build", "entry.mjs", "--production", "--compile-concurrency", "4"]),
		/1 through 3/,
	);
});

test("adding an absent package selection input during join rejects, then invalidates warm cache", async () => {
	const options = fixture();
	const root = path.dirname(options.entrypoint);
	const nested = path.join(root, "nested");
	mkdirSync(nested);
	writeFileSync(path.join(nested, "first.mts"), 'console.log("first");');
	writeFileSync(
		options.entrypoint,
		'import {createWorkerUrl} from "maligator:workers"; console.log(createWorkerUrl("./nested/first.mts",import.meta.url));',
	);
	const negative = path.join(nested, "package.json");
	const base = immediateCompiler();
	const result = deferred<RootCompilationResult>();
	let accepted: RootCompilationResult | undefined;
	const compiler: BuildRootCompiler = {
		validateInputs: validateRootInputs,
		start(graph, workerOptions, inputs, controls) {
			const handle = base.start(graph, workerOptions, inputs, controls);
			void handle.result.then((value) => {
				accepted = value;
			});
			return { ...handle, result: result.promise };
		},
	};
	const pending = compileBuildFrontendAsync(options, compiler, { concurrency: 3 });
	await Promise.resolve();
	assert.ok(accepted!.packageAbsences.includes(negative));
	writeFileSync(negative, '{"type":"module"}');
	result.resolve(accepted!);
	await assert.rejects(pending, /package.*changed|input changed|appeared/);
	rmSync(negative);
	assert.equal(compileBuildFrontend(options).cache, "miss");
	assert.equal(compileBuildFrontend(options).cache, "hit");
	writeFileSync(negative, '{"type":"module"}');
	assert.equal(compileBuildFrontend(options).cache, "miss");
});

for (const automatic of [false, true])
	test(`configuration ${automatic ? "absent-to-created" : "edit"} across async join cannot publish a command result`, async () => {
		const options = fixture();
		const root = path.dirname(options.entrypoint);
		const config = path.join(root, "maligator.build.ts");
		const output = path.join(root, "output.malw");
		if (!automatic)
			writeFileSync(
				config,
				"export default {surface:{node:false,webPlatform:false,maligator:true},engine:{eval:false,regexp:false,intl:{enabled:false}}};",
			);
		const base = immediateCompiler();
		const result = deferred<RootCompilationResult>();
		let accepted: RootCompilationResult | undefined;
		const rootCompiler: BuildRootCompiler = {
			validateInputs: validateRootInputs,
			start(graph, workerOptions, inputs, controls) {
				const handle = base.start(graph, workerOptions, inputs, controls);
				void handle.result.then((value) => {
					accepted = value;
				});
				return { ...handle, result: result.promise };
			},
		};
		const command = parseCliArgs([
			"build",
			options.entrypoint,
			"--production",
			"--compile-concurrency",
			"3",
			"--serialize",
			output,
			...(automatic ? [] : ["--config", config]),
		]) as BuildCommand;
		const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
		try {
			const pending = prepareCommandAsync(command, {
				stripTypes: stripCompactTypes,
				installation: developmentCompilerInstallation(
					path.resolve(import.meta.dirname, "../src"),
				),
				rootCompiler,
				availableCompileConcurrency: 3,
			});
			await Promise.resolve();
			assert.ok(accepted);
			writeFileSync(
				config,
				"export default {surface:{node:false,webPlatform:false,maligator:true},engine:{eval:false,regexp:true,intl:{enabled:false}}};",
			);
			result.resolve(accepted);
			await assert.rejects(pending, /configuration changed before build publication/);
			assert.equal(existsSync(output), false);
		} finally {
			cwd.mockRestore();
		}
	});

test("cancellation after owner compilation waits for root cleanup and publishes nothing", async () => {
	const options = fixture();
	const base = immediateCompiler();
	const close = deferred<void>();
	const controller = new AbortController();
	const reason = new Error("cancelled generation");
	let settled = false;
	const compiler: BuildRootCompiler = {
		validateInputs: validateRootInputs,
		start(graph, workerOptions, inputs, controls) {
			const handle = base.start(graph, workerOptions, inputs, controls);
			return { ...handle, close: () => close.promise };
		},
	};
	const pending = compileBuildFrontendAsync(
		{
			...options,
			afterCoreOptimization() {
				controller.abort(reason);
			},
		},
		compiler,
		{ concurrency: 3, signal: controller.signal },
	);
	const observed = pending.then(
		() => assert.fail("cancelled generation published"),
		(error) => {
			assert.equal(error, reason);
			settled = true;
		},
	);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(settled, false);
	close.resolve();
	await observed;
	assert.equal(compileBuildFrontend(options).cache, "miss");
});

test("a consumed asset edit across root join drains helpers and prevents native publication", async () => {
	const options = fixture();
	const root = path.dirname(options.entrypoint);
	const asset = path.join(root, "data.bin");
	const config = path.join(root, "assets.build.mts");
	writeFileSync(asset, new Uint8Array([0, 128, 255]));
	writeFileSync(
		config,
		'export default {outputName:"asset-guard",assets:{data:{type:"file",path:"data.bin"}},surface:{node:false,webPlatform:false,maligator:true},engine:{eval:false,regexp:false,intl:{enabled:false}}};',
	);
	const result = deferred<RootCompilationResult>();
	const base = immediateCompiler();
	let accepted: RootCompilationResult | undefined;
	let closed = false;
	const phases: Array<string> = [];
	const rootCompiler: BuildRootCompiler = {
		validateInputs: validateRootInputs,
		start(graph, workerOptions, inputs, controls) {
			const handle = base.start(graph, workerOptions, inputs, controls);
			void handle.result.then((value) => {
				accepted = value;
			});
			return {
				...handle,
				result: result.promise,
				close() {
					closed = true;
					return Promise.resolve();
				},
			};
		},
	};
	const command = parseCliArgs([
		"build",
		options.entrypoint,
		"--production",
		"--compile-concurrency",
		"3",
		"--config",
		config,
	]) as BuildCommand;
	const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
	try {
		const pending = prepareCommandAsync(command, {
			stripTypes: stripCompactTypes,
			installation: developmentCompilerInstallation(
				path.resolve(import.meta.dirname, "../src"),
			),
			rootCompiler,
			availableCompileConcurrency: 3,
			onCompilationPhase: (phase) => {
				phases.push(phase.label);
			},
		});
		await Promise.resolve();
		assert.ok(accepted);
		writeFileSync(asset, new Uint8Array([0, 129, 255]));
		result.resolve(accepted);
		await assert.rejects(pending, /asset changed before build publication/);
		assert.equal(closed, true);
		assert.equal(phases.includes("Generate native code"), false);
		assert.equal(phases.includes("Build native binary"), false);
	} finally {
		cwd.mockRestore();
	}
});
