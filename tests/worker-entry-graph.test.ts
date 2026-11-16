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

test("namespace reexport cycles retain a worker API origin", () => {
	fixture(
		{
			"main.mjs":
				'import * as threads from "./exports.mjs"; new threads.Worker(new URL("./worker.mjs", import.meta.url));',
			"exports.mjs":
				'export * from "./cycle.mjs"; export { Worker } from "node:worker_threads";',
			"cycle.mjs": 'export * from "./exports.mjs";',
			"worker.mjs": "globalThis.started = true;",
		},
		(root) => {
			const graph = buildModuleGraph(path.join(root, "main.mjs"), {
				buildConfig: config,
			});
			const worker = path.join(root, "worker.mjs");
			expect(graph.workerEntries?.map((entry) => entry.path)).toEqual([worker]);
			expect(graph.modules.has(worker)).toBe(true);
			expect(graph.evaluationOrder).not.toContain(worker);
		},
	);
});

test("a module URL helper declares a worker entry without importing a worker API", () => {
	fixture(
		{
			"main.mjs":
				'import { Worker } from "node:worker_threads"; import { location } from "./location.mjs"; new Worker(location);',
			"location.mjs": 'export const location = new URL("./worker.mjs", import.meta.url);',
			"worker.mjs": "globalThis.started = true;",
		},
		(root) => {
			const graph = buildModuleGraph(path.join(root, "main.mjs"), {
				buildConfig: config,
			});
			const worker = path.join(root, "worker.mjs");
			expect(graph.workerEntries?.map((entry) => entry.path)).toEqual([worker]);
			expect(graph.modules.has(worker)).toBe(true);
			expect(graph.evaluationOrder).not.toContain(worker);
		},
	);
});

test("ordinary URL constructor aliases do not declare worker entries", () => {
	fixture(
		{
			"main.mjs":
				'import { URL } from "node:url"; const api = { Worker: URL }; new api.Worker("./missing.mjs", import.meta.url);',
		},
		(root) => {
			const graph = buildModuleGraph(path.join(root, "main.mjs"), {
				buildConfig: config,
			});
			expect(graph.workerEntries).toEqual([]);
			expect(graph.dynamicImportCandidates).toEqual([]);
		},
	);
});

test.each([
	'for (const createWorkerUrl of [(value) => value]) createWorkerUrl("ordinary call");',
	'for (let createWorkerUrl = (value) => value; false;) createWorkerUrl("ordinary call");',
	'for (const createWorkerUrl in {}) createWorkerUrl("ordinary call");',
	'for (const { callback: createWorkerUrl } of []) createWorkerUrl("ordinary call");',
])("loop bindings do not invoke a shadowed worker declaration: %s", (statement) => {
	fixture(
		{
			"main.mjs": `import { createWorkerUrl } from "maligator:workers"; ${statement}`,
		},
		(root) => {
			const graph = buildModuleGraph(path.join(root, "main.mjs"), {
				buildConfig: config,
				stripTypes: stripCompactTypes,
			});
			expect(
				graph.workerEntries?.filter((entry) => entry.workerSource === undefined),
			).toEqual([]);
		},
	);
});

test.each([
	'try { throw 0; } catch (declare) { declare("ordinary call"); }',
	'{ const { callback: declare } = source; declare("ordinary call"); }',
	'{ function declare(value) { return value; } declare("ordinary call"); }',
	'(function declare() { declare("ordinary call"); });',
	'const C = class declare { static value = declare("ordinary call"); };',
	'switch (0) { case 0: const declare = value => value; declare("ordinary call"); }',
	'function launch() { if (false) { var declare; } declare("ordinary call"); }',
	'function launch() { class C { static { if (false) { var declare; } declare("ordinary call"); } } }',
])("keeps a shadowed const worker alias ordinary: %s", (statement) => {
	fixture(
		{
			"main.mjs": `import { createWorkerUrl } from "maligator:workers"; const declare = createWorkerUrl; ${statement}`,
		},
		(root) => {
			const graph = buildModuleGraph(path.join(root, "main.mjs"), {
				buildConfig: config,
				stripTypes: stripCompactTypes,
			});
			expect(
				graph.workerEntries?.filter((entry) => entry.workerSource === undefined),
			).toEqual([]);
		},
	);
});

test.each([
	'try { throw 0; } catch (declare) { declare("ordinary call"); }',
	'switch (0) { case 0: let declare; declare("ordinary call"); }',
	'function launch() { if (false) { var declare; } declare("ordinary call"); }',
])("keeps a shadowed imported worker alias ordinary: %s", (statement) => {
	fixture(
		{
			"main.mjs": `import { createWorkerUrl as declare } from "maligator:workers"; ${statement}`,
		},
		(root) => {
			const graph = buildModuleGraph(path.join(root, "main.mjs"), {
				buildConfig: config,
				stripTypes: stripCompactTypes,
			});
			expect(
				graph.workerEntries?.filter((entry) => entry.workerSource === undefined),
			).toEqual([]);
		},
	);
});

test.each([
	'function launch() { const local = createWorkerUrl; return local("./task.mjs", import.meta.url); }',
	'export const declare = createWorkerUrl; declare("./task.mjs", import.meta.url);',
	'const declare = createWorkerUrl; function launch(value = declare("./task.mjs", import.meta.url)) { var declare; }',
	'const declare = createWorkerUrl; switch (declare("./task.mjs", import.meta.url)) { case 0: let declare; }',
	'const declare = createWorkerUrl; function launch() { class C { static { var declare; } } return declare("./task.mjs", import.meta.url); }',
	'const declare = createWorkerUrl; function launch() { function nested() { var declare; } return declare("./task.mjs", import.meta.url); }',
	'const declare = createWorkerUrl; try { throw 0; } catch (declare) { declare("ordinary call"); } declare("./task.mjs", import.meta.url);',
])(
	"retains a worker declaration outside a distinct binding environment: %s",
	(statement) => {
		fixture(
			{
				"main.mjs": `import { createWorkerUrl } from "maligator:workers"; ${statement}`,
				"task.mjs": "export default () => 42;",
			},
			(root) => {
				const graph = buildModuleGraph(path.join(root, "main.mjs"), {
					buildConfig: config,
					stripTypes: stripCompactTypes,
				});
				expect(
					graph.workerEntries?.some(
						(entry) => entry.path === path.join(root, "task.mjs"),
					),
				).toBe(true);
			},
		);
	},
);

test.each([
	['import { URL } from "node:url";', true],
	['import { URL } from "./ordinary-url.mjs";', false],
] as const)("distinguishes URL import origin for %s", (source, expected) => {
	fixture(
		{
			"main.mjs": `import { Worker } from "node:worker_threads"; ${source} new URL("./task.mjs", import.meta.url); globalThis.Worker = Worker;`,
			"ordinary-url.mjs": "export class URL {}",
			"task.mjs": "export default () => 42;",
		},
		(root) => {
			const graph = buildModuleGraph(path.join(root, "main.mjs"), {
				buildConfig: config,
			});
			expect(
				graph.workerEntries?.some((entry) => entry.path === path.join(root, "task.mjs")),
			).toBe(expected);
		},
	);
});

test.each([
	"api.declare = (value) => value;",
	"const alias = api; alias.declare = (value) => value;",
	"({ declare: api.declare } = { declare: (value) => value });",
	'Object.defineProperty(api, "declare", { value: (value) => value });',
	"function replace(value) { value.declare = (value) => value; } replace(api);",
])("mutated or escaped aggregate fields are not static declarations: %s", (mutation) => {
	fixture(
		{
			"main.mjs": `import { createWorkerUrl } from "maligator:workers"; const api = { declare: createWorkerUrl }; ${mutation} api.declare("ordinary call");`,
		},
		(root) => {
			const graph = buildModuleGraph(path.join(root, "main.mjs"), {
				buildConfig: config,
				stripTypes: stripCompactTypes,
			});
			expect(
				graph.workerEntries?.filter((entry) => entry.workerSource === undefined),
			).toEqual([]);
		},
	);
});

test("stable aggregate aliases still declare deferred worker roots", () => {
	fixture(
		{
			"main.mjs":
				'import { createWorkerUrl } from "maligator:workers"; const api = { declare: createWorkerUrl }; const alias = api; alias.declare("./task.mjs", import.meta.url);',
			"task.mjs": "export default () => 42;",
		},
		(root) => {
			const graph = buildModuleGraph(path.join(root, "main.mjs"), {
				buildConfig: config,
				stripTypes: stripCompactTypes,
			});
			const target = path.join(root, "task.mjs");
			expect(graph.workerEntries?.some((entry) => entry.path === target)).toBe(true);
			expect(graph.evaluationOrder).not.toContain(target);
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
