import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { buildModuleGraph } from "../src/compiler/frontend/module-graph.ts";

function fixture(files: Record<string, string>, run: (root: string) => void): void {
	const root = mkdtempSync(path.join(tmpdir(), "maligator-worker-graph-"));
	try {
		for (const [name, source] of Object.entries(files))
			writeFileSync(path.join(root, name), source);
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const config = resolveBuildConfig({ surface: { node: true } });

test("a library worker bootstrap is bundled without entering the parent evaluation order", () => {
	fixture(
		{
			"main.mjs": 'import { launch } from "./library.mjs"; launch();',
			"library.mjs":
				'import { Worker as Thread } from "./exports.mjs"; import { fileURLToPath } from "node:url"; export function launch() { return new Thread(fileURLToPath(import.meta.url + "/../worker.mjs")); }',
			"exports.mjs": 'export { Worker } from "node:worker_threads";',
			"worker.mjs": 'import "./dependency.mjs"; globalThis.started = true;',
			"dependency.mjs": "globalThis.dependency = true;",
		},
		(root) => {
			const graph = buildModuleGraph(path.join(root, "main.mjs"), {
				buildConfig: config,
			});
			const worker = path.join(root, "worker.mjs");
			expect(graph.workerEntries?.map((entry) => entry.href)).toEqual([
				pathToFileURL(worker).href,
			]);
			expect(graph.modules.has(path.join(root, "dependency.mjs"))).toBe(true);
			expect(graph.evaluationOrder).not.toContain(worker);
			expect(graph.evaluationOrder).not.toContain(path.join(root, "dependency.mjs"));
			expect(graph.dynamicImportCandidates).toContain(worker);
		},
	);
});

test("a shadowed Worker parameter does not declare a native worker entry", () => {
	fixture(
		{
			"main.mjs":
				'import { Worker } from "node:worker_threads"; export function construct(Worker) { return new Worker(new URL("./missing.mjs", import.meta.url)); }',
		},
		(root) => {
			const graph = buildModuleGraph(path.join(root, "main.mjs"), {
				buildConfig: config,
			});
			expect(graph.workerEntries).toEqual([]);
		},
	);
});

test("explicit computed-import candidates are available outside the importing entry", () => {
	fixture(
		{
			"main.mjs": 'import { load } from "./loader.mjs"; globalThis.load = load;',
			"loader.mjs": "export function load(file) { return import(file); }",
			"task.mjs": "export default function task() { return 42; }",
		},
		(root) => {
			const task = path.join(root, "task.mjs");
			const graph = buildModuleGraph(path.join(root, "main.mjs"), {
				dynamicImportCandidates: [task],
			});
			expect(graph.dynamicImportCandidates).toEqual([task]);
			expect(graph.evaluationOrder).not.toContain(task);
		},
	);
});

test("constant and object aliases retain a library worker bootstrap", () => {
	fixture(
		{
			"main.mjs": 'import { launch } from "./library.mjs"; launch();',
			"library.mjs":
				'import * as threads from "node:worker_threads"; import { fileURLToPath as pathname } from "node:url"; const api = { Thread: threads.Worker }; const Constructor = api.Thread; export function launch() { const location = { entry: new URL("./worker.mjs", import.meta.url) }; const workerPath = pathname(location.entry); return new Constructor(workerPath); }',
			"worker.mjs": "globalThis.workerStarted = true;",
		},
		(root) => {
			const graph = buildModuleGraph(path.join(root, "main.mjs"), {
				buildConfig: config,
			});
			expect(graph.workerEntries?.map((entry) => entry.path)).toEqual([
				path.join(root, "worker.mjs"),
			]);
		},
	);
});

test("a function parameter shadows an outer constant worker URL", () => {
	fixture(
		{
			"main.mjs":
				'import { Worker } from "node:worker_threads"; const location = "./missing.mjs"; export function launch(location) { return new Worker(location); }',
		},
		(root) => {
			expect(
				buildModuleGraph(path.join(root, "main.mjs"), { buildConfig: config })
					.workerEntries,
			).toEqual([]);
		},
	);
});

test("platform worker declarations through reexports add deferred roots and one source identity", () => {
	fixture(
		{
			"main.mjs":
				'import { declare } from "./library.mjs"; export const worker = declare("./task.mjs", import.meta.url);',
			"library.mjs": 'export { createWorkerUrl as declare } from "maligator:workers";',
			"task.mjs": 'import "maligator:workers"; export default () => 42;',
		},
		(root) => {
			const graph = buildModuleGraph(path.join(root, "main.mjs"), {
				buildConfig: config,
				stripTypes: stripCompactTypes,
			});
			const task = path.join(root, "task.mjs");
			expect(graph.workerEntries?.some((entry) => entry.path === task)).toBe(true);
			expect(graph.evaluationOrder).not.toContain(task);
			const platformSources = [...graph.modules.values()].filter((record) =>
				record.sourcePath?.endsWith("/workers/runtime.ts"),
			);
			expect(platformSources).toHaveLength(1);
			expect(
				graph.workerEntries?.some(
					(entry) => entry.workerSource === "workers/pool-worker.ts",
				),
			).toBe(true);
		},
	);
});

test("configured aliases cannot expose internal platform modules", () => {
	fixture(
		{
			"main.mjs": 'import { Worker } from "private-workers"; globalThis.Worker = Worker;',
		},
		(root) => {
			const privateConfig = resolveBuildConfig({
				surface: { node: true },
				modules: { aliases: { "private-workers": "maligator:internal/workers" } },
			});
			expect(() =>
				buildModuleGraph(path.join(root, "main.mjs"), { buildConfig: privateConfig }),
			).toThrow(/reserved for platform sources/);
		},
	);
});
