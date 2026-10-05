import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { it as test } from "vitest";
import { BuildConfigError, resolveBuildConfig } from "../src/build-config.ts";
import { CoreIrVerificationError } from "../src/compiler/core/core-ir-verifier.ts";
import { CoreOptimizationBudgetError } from "../src/compiler/core/core-pass.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { buildModuleGraph } from "../src/compiler/frontend/module-graph.ts";
import type { ModuleGraph } from "../src/compiler/frontend/module-graph.ts";
import { SyntaxDiagnostic } from "../src/compiler/frontend/syntax-diagnostic.ts";
import { compileWorkerImages } from "../src/compiler/pipeline/compile-worker-images.ts";
import {
	RootInputChangedError,
	captureRootInputs,
	captureRootPackageAbsences,
	deserializeRootFailure,
	serializeRootFailure,
	validateRootInputs,
	validateRootPackageAbsences,
} from "../src/compiler/root-compilation.ts";
import { serializeCompilerArtifact } from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitWorkerImageTranslationUnits } from "../src/compiler/target/emit-worker-images.ts";
import { nativeSourcePath } from "../src/native-source-path.ts";
import { startNodeRootCompilation } from "../src/node-root-compiler.ts";

const config = resolveBuildConfig({
	engine: { eval: false, regexp: false },
	surface: { node: false, webPlatform: false },
});
const options = {
	stripTypes: stripCompactTypes,
	buildConfig: config,
	optimization: "full" as const,
};
function graphFor(files: ReadonlyArray<string>): ModuleGraph {
	return {
		entry: files[0]!,
		modules: new Map(),
		nodeEnabled: false,
		evaluationOrder: [],
		cycles: [],
		workerEntries: files.map((file) => ({
			path: file,
			href: pathToFileURL(file).href,
			importer: files[0]!,
		})),
	};
}
async function temporary<T>(run: (directory: string) => T | Promise<T>): Promise<T> {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-node-root-protocol-"));
	try {
		return await run(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("compiler errors retain class, fields, original message, stack and nested causes", () => {
	const cause = Object.assign(new TypeError("input rejected"), { code: "EINVAL" });
	const errors = [
		new SyntaxDiagnostic("parse", "bad syntax", { cause }),
		new CoreIrVerificationError("invalid edge", {
			stage: "construction",
			functionIndex: 3,
		}),
		new CoreOptimizationBudgetError("budget exhausted"),
		new BuildConfigError("eval disabled"),
	];
	for (const original of errors) {
		const restored = deserializeRootFailure(
			structuredClone(serializeRootFailure(original)),
		);
		assert.ok(restored instanceof original.constructor);
		assert.ok(restored instanceof Error);
		assert.equal(restored.message, original.message);
		assert.equal(restored.stack, original.stack);
		if (restored instanceof SyntaxDiagnostic) {
			assert.equal(restored.phase, "parse");
			assert.ok(restored.cause instanceof TypeError);
			assert.equal((restored.cause as TypeError & { code: string }).code, "EINVAL");
		}
		if (restored instanceof CoreIrVerificationError)
			assert.deepEqual(restored.context, { stage: "construction", functionIndex: 3 });
	}
	assert.equal(deserializeRootFailure(serializeRootFailure(undefined)), undefined);
	assert.equal(deserializeRootFailure(serializeRootFailure(null)), null);
	const circular = new Error("circular");
	circular.cause = circular;
	const restored = deserializeRootFailure(
		structuredClone(serializeRootFailure(circular)),
	);
	assert.ok(restored instanceof Error);
	assert.equal(restored.cause, restored);
});

test("source snapshots describe consumed source and reject later revisions", async () => {
	await temporary((directory) => {
		const file = path.join(directory, "entry.mts");
		writeFileSync(file, "export const value = 1;\n");
		const graph = buildModuleGraph(file, options);
		const inputs = captureRootInputs(graph);
		writeFileSync(file, "export const value = 2;\n");
		assert.throws(() => validateRootInputs(inputs), RootInputChangedError);
		assert.throws(() => captureRootInputs(graph), RootInputChangedError);
	});
});

test("unsupported stripper is rejected before worker admission", () => {
	assert.throws(
		() =>
			startNodeRootCompilation(
				graphFor(["/unused.mts"]),
				{
					...options,
					stripTypes: (source) => source,
				},
				[],
				{ concurrency: 2, workerUrl: new URL("file:///missing-worker.ts") },
			),
		TypeError,
	);
});

test("a new formerly absent package boundary rejects the consumed graph", async () => {
	await temporary((directory) => {
		const file = path.join(directory, "entry.mts");
		writeFileSync(file, "export const value = 1;\n");
		const graph = buildModuleGraph(file, options);
		const missing = captureRootPackageAbsences(graph);
		assert.ok(missing.includes(path.join(directory, "package.json")));
		writeFileSync(path.join(directory, "package.json"), '{"type":"commonjs"}\n');
		assert.throws(() => validateRootPackageAbsences(missing), RootInputChangedError);
	});
});

test("graceful premature exit and startup failure settle and join", async () => {
	for (const workerUrl of [
		new URL("data:text/javascript,process.exit(0)"),
		new URL("file:///missing-node-root-worker.ts"),
	]) {
		const task = startNodeRootCompilation(graphFor(["/unused.mts"]), options, [], {
			concurrency: 1,
			workerUrl,
		});
		await assert.rejects(task.result, Error);
		await task.close();
	}
});

test("earliest declared root failure wins despite later root finishing first", async () => {
	const task = startNodeRootCompilation(
		graphFor(["/first.mts", "/second.mts"]),
		options,
		[],
		{
			concurrency: 2,
			workerUrl: new URL(
				"./fixtures/root-compiler/failure-order-worker.mts",
				import.meta.url,
			),
		},
	);
	await assert.rejects(
		task.result,
		(error: unknown) =>
			error instanceof SyntaxDiagnostic &&
			error.phase === "resolution" &&
			error.message === "root 0" &&
			error.cause instanceof TypeError,
	);
	await task.close();
});

test("cancellation retains explicit null and undefined reasons and still drains", async () => {
	for (const reason of [null, undefined, new TypeError("owner failed")]) {
		const task = startNodeRootCompilation(graphFor(["/unused.mts"]), options, [], {
			concurrency: 1,
			workerUrl: new URL(
				"./fixtures/root-compiler/failure-order-worker.mts",
				import.meta.url,
			),
		});
		task.cancel(reason);
		let caught = false;
		try {
			await task.result;
		} catch (error) {
			caught = true;
			assert.equal(error, reason);
		}
		assert.equal(caught, true);
		await task.close();
	}
});

test("worker policy rejection retains BuildConfigError identity", async () => {
	await temporary(async (directory) => {
		const file = path.join(directory, "eval.mts");
		writeFileSync(file, "export const value = eval(globalThis.input);\n");
		const policyOptions = {
			...options,
			buildConfig: {
				...config,
				engine: { ...config.engine, eval: "compile-check" as const },
			},
		};
		const graph = buildModuleGraph(file, policyOptions);
		graph.workerEntries = graphFor([file]).workerEntries;
		const task = startNodeRootCompilation(
			graph,
			policyOptions,
			captureRootInputs(graph),
			{ concurrency: 1 },
		);
		await assert.rejects(task.result, BuildConfigError);
		await task.close();
	});
});

test("an admitted root rejects an edit before compilation instead of publishing a mixed generation", async () => {
	await temporary(async (directory) => {
		const file = path.join(directory, "entry.mts");
		writeFileSync(file, "export const value = 1;\n");
		const graph = buildModuleGraph(file, options);
		graph.workerEntries = graphFor([file]).workerEntries;
		const task = startNodeRootCompilation(graph, options, captureRootInputs(graph), {
			concurrency: 1,
		});
		writeFileSync(file, "export const value = 2;\n");
		await assert.rejects(task.result, RootInputChangedError);
		await task.close();
	});
});

test("an admitted root rejects a newly created nearer package target", async () => {
	await temporary(async (directory) => {
		const root = path.join(directory, "sub", "root.mts");
		const main = path.join(directory, "main.mts");
		const oldPackage = path.join(directory, "node_modules", "local-target");
		mkdirSync(oldPackage, { recursive: true });
		mkdirSync(path.dirname(root));
		writeFileSync(
			path.join(oldPackage, "package.json"),
			'{"type":"module","exports":"./index.mjs"}\n',
		);
		writeFileSync(path.join(oldPackage, "index.mjs"), "export const value = 1;\n");
		writeFileSync(root, 'export {value} from "local-target";\n');
		writeFileSync(main, 'import "./sub/root.mts";\n');
		const graph = buildModuleGraph(main, options);
		graph.workerEntries = graphFor([root]).workerEntries;
		const task = startNodeRootCompilation(graph, options, captureRootInputs(graph), {
			concurrency: 1,
		});
		const nearer = path.join(directory, "sub", "node_modules", "local-target");
		mkdirSync(nearer, { recursive: true });
		writeFileSync(
			path.join(nearer, "package.json"),
			'{"type":"module","exports":"./index.mjs"}\n',
		);
		writeFileSync(path.join(nearer, "index.mjs"), "export const value = 2;\n");
		await assert.rejects(
			task.result,
			(error: unknown) =>
				error instanceof RootInputChangedError &&
				error.path === path.join(nearer, "index.mjs"),
		);
		await task.close();
	});
});

test("an admitted root rejects a newly preferred extensionless file", async () => {
	await temporary(async (directory) => {
		const root = path.join(directory, "root.mts");
		const preferred = path.join(directory, "foo");
		writeFileSync(`${preferred}.js`, "exports.value = 1;\n");
		writeFileSync(root, 'import "./foo";\n');
		const graph = buildModuleGraph(root, options);
		graph.workerEntries = graphFor([root]).workerEntries;
		const task = startNodeRootCompilation(graph, options, captureRootInputs(graph), {
			concurrency: 1,
		});
		writeFileSync(preferred, "exports.value = 2;\n");
		await assert.rejects(
			task.result,
			(error: unknown) =>
				error instanceof RootInputChangedError && error.path === preferred,
		);
		await task.close();
	});
});

test("ordered root results preserve full compiler, wire, diagnostic and C artifacts", async () => {
	await temporary(async (directory) => {
		const files = [path.join(directory, "first.mts"), path.join(directory, "second.mts")];
		for (const [index, file] of files.entries())
			writeFileSync(
				file,
				`${index === 0 ? 'import "./second.mts";\n' : ""}export const value = ${index + 1};\n`,
			);
		const graph = buildModuleGraph(files[0]!, options);
		graph.workerEntries = graphFor(files).workerEntries;
		const diagnostics: Array<unknown> = [];
		const serial = compileWorkerImages(graph, {
			...options,
			onDiagnostic: (value) => diagnostics.push(value),
		});
		const task = startNodeRootCompilation(graph, options, captureRootInputs(graph), {
			concurrency: 2,
		});
		try {
			const parallel = await task.result;
			assert.deepEqual(
				parallel.workers.map((worker) => worker.entry.href),
				serial.map((worker) => worker.entry.href),
			);
			assert.deepEqual(parallel.diagnostics, diagnostics);
			for (const [index, worker] of serial.entries()) {
				assert.deepEqual(
					serializeCompilerArtifact(parallel.workers[index]!.image),
					serializeCompilerArtifact(worker.image),
				);
				assert.deepEqual(parallel.workers[index]!.wire, worker.wire);
			}
			const emission = {
				sourcePath: nativeSourcePath,
				compiled: true,
				maligatorSurface: config.surface.maligator,
			};
			assert.deepEqual(
				emitWorkerImageTranslationUnits(parallel.workers, emission),
				emitWorkerImageTranslationUnits(serial, emission),
			);
			for (const file of files)
				assert.ok(parallel.dependencies.some((input) => input.path === file));
			validateRootInputs(parallel.dependencies);
		} finally {
			await task.close();
		}
	});
});
