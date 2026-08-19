import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { stripCompactTypes } from "../src/compact-type-strip.ts";
import { buildModuleGraph, ModuleParseCache } from "../src/module-graph.ts";
import type { ModuleGraph } from "../src/module-graph.ts";

/** A resolved config with the node host surface enabled. */
const nodeOn = resolveBuildConfig({ surface: { node: true } });

let root: string;

function write(relativePath: string, contents: string) {
	const full = path.join(root, relativePath);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, contents);
}

beforeAll(() => {
	// A hermetic fixture tree in a temp dir: relative imports, a re-export, a
	// dynamic import, a node_modules package with an `exports` map, and a cycle.
	root = mkdtempSync(path.join(tmpdir(), "maligator-graph-"));

	write(
		"entry.mjs",
		`import { a } from "./a.mjs";
import { b } from "./b.mjs";
import { dep } from "pkg";
export { a as reA } from "./a.mjs";
async function load() {
	return (await import("./dynamic.mjs")).value;
}
globalThis.sink = [a, b, dep, load];
`,
	);
	write(
		"a.mjs",
		`import { b } from "./b.mjs";
import { cycleA } from "./cycle-a.mjs";
export const a = b + cycleA;
`,
	);
	write("b.mjs", `export const b = 1;\n`);
	write("dynamic.mjs", `export const value = 42;\n`);
	write(
		"cycle-a.mjs",
		`import { cycleB } from "./cycle-b.mjs";
export const cycleA = cycleB + 1;
`,
	);
	write(
		"cycle-b.mjs",
		`import { cycleA } from "./cycle-a.mjs";
export const cycleB = 2;
`,
	);
	write(
		"node_modules/pkg/package.json",
		JSON.stringify({ name: "pkg", type: "module", exports: { ".": "./index.mjs" } }),
	);
	write("node_modules/pkg/index.mjs", `export const dep = "dep";\n`);

	// A small CommonJS tree: a top-level require, a nested (in-function) require,
	// and a computed require (statically unresolvable).
	write(
		"cjs-entry.cjs",
		`const b = require("./cjs-b.cjs");
function lazy(name) {
	return require("./cjs-c.cjs");
}
const dyn = require(name);
module.exports = [b, lazy, dyn];
`,
	);
	write("cjs-b.cjs", `exports.b = 1;\n`);
	write("cjs-c.cjs", `module.exports = function () { return 2; };\n`);
});

afterAll(() => {
	if (root) {
		rmSync(root, { recursive: true, force: true });
	}
});

const rel = (absolute: string) => path.relative(root, absolute);
const pkgIndex = path.join("node_modules", "pkg", "index.mjs");

function depSummary(graph: ModuleGraph, modulePath: string) {
	return graph.modules
		.get(path.join(root, modulePath))!
		.dependencies.map((dependency) => ({
			specifier: dependency.specifier,
			kind: dependency.kind,
			resolved: dependency.resolvedPath ? rel(dependency.resolvedPath) : null,
		}));
}

test("discovers every reachable module, including dynamic + node_modules targets", () => {
	const graph = buildModuleGraph(path.join(root, "entry.mjs"));

	const discovered = new Set([...graph.modules.keys()].map(rel));
	expect(discovered).toEqual(
		new Set([
			"entry.mjs",
			"a.mjs",
			"b.mjs",
			"dynamic.mjs",
			"cycle-a.mjs",
			"cycle-b.mjs",
			pkgIndex,
		]),
	);
});

test("detects goals by extension (.mjs => module)", () => {
	const graph = buildModuleGraph(path.join(root, "entry.mjs"));

	expect(graph.modules.get(graph.entry)!.goal).toBe("module");
	expect(graph.modules.get(path.join(root, pkgIndex))!.goal).toBe("module");
});

test("detects .js entry goals from the nearest package type", () => {
	write("commonjs-package/package.json", JSON.stringify({ type: "commonjs" }));
	write("commonjs-package/entry.js", `module.exports = require("./dependency.js");\n`);
	write("commonjs-package/dependency.js", `module.exports = 42;\n`);
	write("module-ancestor/package.json", JSON.stringify({ type: "module" }));
	write(
		"module-ancestor/default-package/package.json",
		JSON.stringify({ name: "default-package" }),
	);
	write("module-ancestor/default-package/entry.js", `module.exports = 42;\n`);
	write("module-package/package.json", JSON.stringify({ type: "module" }));
	write("module-package/entry.js", `export const value = 42;\n`);

	const commonjs = buildModuleGraph(path.join(root, "commonjs-package/entry.js"));
	const defaultCommonjs = buildModuleGraph(
		path.join(root, "module-ancestor/default-package/entry.js"),
	);
	const module = buildModuleGraph(path.join(root, "module-package/entry.js"));

	expect(commonjs.modules.get(commonjs.entry)!.goal).toBe("cjs");
	expect(
		commonjs.modules.get(path.join(root, "commonjs-package/dependency.js"))!.goal,
	).toBe("cjs");
	expect(commonjs.modules.size).toBe(2);
	expect(defaultCommonjs.modules.get(defaultCommonjs.entry)!.goal).toBe("cjs");
	expect(module.modules.get(module.entry)!.goal).toBe("module");
});

test("explicit entry goals and goal-specific extensions take precedence over package type", () => {
	write("goal-precedence/package.json", JSON.stringify({ type: "module" }));
	write("goal-precedence/entry.js", `globalThis.value = 1;\n`);
	write("goal-precedence/explicit-module.js", `export const value = 1;\n`);
	write("goal-precedence/forced.cjs", `module.exports = 1;\n`);
	write("goal-precedence/forced.mjs", `export const value = 1;\n`);

	const explicitScript = buildModuleGraph(path.join(root, "goal-precedence/entry.js"), {
		entryGoal: "script",
	});
	const override = buildModuleGraph(
		path.join(root, "goal-precedence/explicit-module.js"),
		{
			entryGoal: "script",
			goalOverride: "module",
		},
	);
	const cjs = buildModuleGraph(path.join(root, "goal-precedence/forced.cjs"));
	const module = buildModuleGraph(path.join(root, "goal-precedence/forced.mjs"));

	expect(explicitScript.modules.get(explicitScript.entry)!.goal).toBe("script");
	expect(override.modules.get(override.entry)!.goal).toBe("module");
	expect(cjs.modules.get(cjs.entry)!.goal).toBe("cjs");
	expect(module.modules.get(module.entry)!.goal).toBe("module");
});

test("traverses the complete pinned Express initialization graph", () => {
	const entry = path.resolve("tests/fixtures/express-5/app.js");
	const graph = buildModuleGraph(entry, { buildConfig: nodeOn });

	expect(graph.modules.has("node:http")).toBe(true);
	expect(graph.modules.get("node:url")?.host?.named).toEqual([
		"URL",
		"Url",
		"fileURLToPath",
		"format",
		"parse",
		"pathToFileURL",
		"urlToHttpOptions",
	]);
	expect(graph.modules.get("node:querystring")?.host?.named).toEqual(["parse"]);
	expect(graph.modules.get("node:net")?.host?.named).toEqual([
		"Socket",
		"connect",
		"createConnection",
		"isIP",
	]);
	expect(graph.modules.get("node:os")?.host?.named).toEqual([
		"EOL",
		"arch",
		"availableParallelism",
		"cpus",
		"devNull",
		"endianness",
		"freemem",
		"homedir",
		"hostname",
		"loadavg",
		"machine",
		"platform",
		"release",
		"tmpdir",
		"totalmem",
		"type",
		"uptime",
		"userInfo",
		"version",
	]);
});

test("requires an explicit stripper for TypeScript and applies it across the graph", () => {
	write("typed-entry.mts", `import { value } from "./typed-dep.ts";\nvalue;\n`);
	write("typed-dep.ts", `export const value: number = 1;\n`);

	expect(() => buildModuleGraph(path.join(root, "typed-entry.mts"))).toThrow(
		/BuildModuleGraphOptions\.stripTypes/,
	);
	const seen: Array<string> = [];
	const graph = buildModuleGraph(path.join(root, "typed-entry.mts"), {
		dependencyGoalOverride: "module",
		stripTypes(source, filePath) {
			seen.push(path.basename(filePath));
			return stripCompactTypes(source, filePath);
		},
	});
	expect(seen).toEqual(["typed-entry.mts", "typed-dep.ts"]);
	expect(
		graph.modules.get(path.join(root, "typed-dep.ts"))!.parsed.ast.body,
	).toHaveLength(1);
});

test("parses Node-compatible erasable TypeScript through the compact product path", () => {
	write(
		"compact-entry.mts",
		`import { value, type Value } from "./compact-dep.ts";
interface Dependencies {
	readonly value: Value;
}
const select = <Selected,>({ value }: Dependencies): Selected =>
	value as Selected;
select<Value>({ value });
`,
	);
	write(
		"compact-dep.ts",
		`export type Value = { readonly name: string };
export const value: Value = { name: "compact" };
`,
	);

	const graph = buildModuleGraph(path.join(root, "compact-entry.mts"), {
		dependencyGoalOverride: "module",
		stripTypes: stripCompactTypes,
	});
	expect(graph.modules.size).toBe(2);
});

test("records dependency specifiers, kinds, and resolutions", () => {
	const graph = buildModuleGraph(path.join(root, "entry.mjs"));

	expect(depSummary(graph, "entry.mjs")).toEqual([
		{ specifier: "./a.mjs", kind: "import", resolved: "a.mjs" },
		{ specifier: "./b.mjs", kind: "import", resolved: "b.mjs" },
		{ specifier: "pkg", kind: "import", resolved: pkgIndex },
		{ specifier: "./a.mjs", kind: "export", resolved: "a.mjs" },
		{ specifier: "./dynamic.mjs", kind: "dynamic", resolved: "dynamic.mjs" },
	]);
});

test("evaluation order puts static dependencies before dependents, entry last", () => {
	const graph = buildModuleGraph(path.join(root, "entry.mjs"));
	const order = graph.evaluationOrder.map(rel);

	expect(order.at(-1)).toBe("entry.mjs");

	const before = (earlier: string, later: string) =>
		order.indexOf(earlier) < order.indexOf(later);
	expect(before("b.mjs", "a.mjs")).toBe(true);
	expect(before("a.mjs", "entry.mjs")).toBe(true);
	expect(before("b.mjs", "entry.mjs")).toBe(true);
	expect(before(pkgIndex, "entry.mjs")).toBe(true);

	// A dynamically imported module is evaluated when import() runs, not as part
	// of the static evaluation order.
	expect(order).not.toContain("dynamic.mjs");
});

test("detects the cycle as a strongly-connected component", () => {
	const graph = buildModuleGraph(path.join(root, "entry.mjs"));

	const cycleSets = graph.cycles.map((component) => new Set(component.map(rel)));
	expect(cycleSets).toContainEqual(new Set(["cycle-a.mjs", "cycle-b.mjs"]));
});

test("extracts require() dependencies from a CommonJS module", () => {
	const graph = buildModuleGraph(path.join(root, "cjs-entry.cjs"));

	expect(graph.modules.get(graph.entry)!.goal).toBe("cjs");
	expect(depSummary(graph, "cjs-entry.cjs")).toEqual([
		{ specifier: "./cjs-b.cjs", kind: "require", resolved: "cjs-b.cjs" },
		// Nested in a function body, still discovered by the whole-tree walk.
		{ specifier: "./cjs-c.cjs", kind: "require", resolved: "cjs-c.cjs" },
		// Computed `require(name)` — unresolvable statically.
		{ specifier: null, kind: "require", resolved: null },
	]);

	// Resolved require edges are static, so they order dependencies before the
	// entry; the computed one does not participate.
	const order = graph.evaluationOrder.map(rel);
	expect(order.at(-1)).toBe("cjs-entry.cjs");
	expect(order.indexOf("cjs-b.cjs")).toBeLessThan(order.indexOf("cjs-entry.cjs"));
});

test("retains a missing literal require caught in the same execution context", () => {
	write(
		"optional-require.cjs",
		`function probe() {
	try {
		return require("missing-optional-package");
	} catch (error) {
		return error;
	}
}
module.exports = probe();
`,
	);
	const graph = buildModuleGraph(path.join(root, "optional-require.cjs"));
	expect(graph.modules.get(graph.entry)!.dependencies).toContainEqual({
		specifier: "missing-optional-package",
		kind: "require",
		resolvedPath: null,
		catchableMissing: true,
	});
});

test("rejects missing requires not dynamically protected by a catch", () => {
	write(
		"optional-nested-function.cjs",
		`try {
	const later = () => require("missing-from-nested-function");
	globalThis.later = later;
} catch {}
`,
	);
	expect(() => buildModuleGraph(path.join(root, "optional-nested-function.cjs"))).toThrow(
		/Cannot resolve 'missing-from-nested-function'/,
	);

	write(
		"optional-finally.cjs",
		`try {
	require("missing-from-try-finally");
} finally {}
`,
	);
	expect(() => buildModuleGraph(path.join(root, "optional-finally.cjs"))).toThrow(
		/Cannot resolve 'missing-from-try-finally'/,
	);
});

test("resolves node: CommonJS built-ins to their canonical host identity", () => {
	write("cjs-node.cjs", `module.exports = require("node:path");\n`);
	const graph = buildModuleGraph(path.join(root, "cjs-node.cjs"), {
		buildConfig: nodeOn,
	});
	expect(graph.modules.get(graph.entry)!.dependencies[0]!.resolvedPath).toBe("node:path");
	expect(graph.modules.get("node:path")?.host?.id).toBe("node:path");
});

test("canonicalizes bare CommonJS built-ins to the same node: host module", () => {
	write("cjs-bare-path.cjs", `module.exports = require("path");\n`);
	const graph = buildModuleGraph(path.join(root, "cjs-bare-path.cjs"), {
		buildConfig: nodeOn,
	});
	expect(graph.modules.get(graph.entry)!.dependencies[0]!.resolvedPath).toBe("node:path");
	expect(
		[...graph.modules.keys()].filter((modulePath) => modulePath === "node:path"),
	).toHaveLength(1);
});

test("canonicalizes bare tty to the node:tty host module", () => {
	write("cjs-bare-tty.cjs", `module.exports = require("tty");\n`);
	const graph = buildModuleGraph(path.join(root, "cjs-bare-tty.cjs"), {
		buildConfig: nodeOn,
	});
	expect(graph.modules.get(graph.entry)!.dependencies[0]!.resolvedPath).toBe("node:tty");
	expect(graph.modules.get("node:tty")?.host?.named).toEqual([
		"ReadStream",
		"WriteStream",
		"isatty",
	]);
});

test("loads JSON dependencies as CommonJS modules", () => {
	write("cjs-json.cjs", `module.exports = require("./data.json");\n`);
	write("data.json", `{"answer":42,"__proto__":{"own":true}}\n`);
	const graph = buildModuleGraph(path.join(root, "cjs-json.cjs"));
	const jsonPath = path.join(root, "data.json");

	expect(graph.modules.get(jsonPath)?.goal).toBe("cjs");
	expect(graph.modules.get(jsonPath)?.source).toBe(
		`{"answer":42,"__proto__":{"own":true}}\n`,
	);
	expect(graph.modules.get(jsonPath)?.parsed.ast.body).toHaveLength(1);
});

test("does not treat require() as a dependency in ESM/script modules", () => {
	const graph = buildModuleGraph(path.join(root, "entry.mjs"));
	for (const record of graph.modules.values()) {
		expect(record.dependencies.every((dependency) => dependency.kind !== "require")).toBe(
			true,
		);
	}
});

test("records unresolved dynamic imports without adding graph nodes", () => {
	write(
		"unresolved-dynamic.mjs",
		`import("./missing.mjs");\nconst name = "./also-missing.mjs";\nimport(name);\n`,
	);
	const graph = buildModuleGraph(path.join(root, "unresolved-dynamic.mjs"));

	expect(depSummary(graph, "unresolved-dynamic.mjs")).toEqual([
		{ specifier: "./missing.mjs", kind: "dynamic", resolved: null },
		{ specifier: null, kind: "dynamic", resolved: null },
	]);
	expect([...graph.modules.keys()].map(rel)).toEqual(["unresolved-dynamic.mjs"]);
});

test("still rejects an unresolved static import", () => {
	write("unresolved-static.mjs", `import "./missing.mjs";\n`);
	expect(() => buildModuleGraph(path.join(root, "unresolved-static.mjs"))).toThrow(
		SyntaxError,
	);
});

test("the node export condition is gated on surface.node", () => {
	// Declaration order lists `node` before `import`, so `node` wins WHEN active.
	write(
		"node_modules/ordered/package.json",
		JSON.stringify({
			type: "module",
			exports: { node: "./node.mjs", import: "./import.mjs" },
		}),
	);
	write("node_modules/ordered/node.mjs", `export const selected = "node";\n`);
	write("node_modules/ordered/import.mjs", `export const selected = "import";\n`);
	write("ordered-entry.mjs", `import { selected } from "ordered";\n`);

	// Default (surface.node off): the `node` condition is inactive, so `import` wins.
	expect(
		depSummary(
			buildModuleGraph(path.join(root, "ordered-entry.mjs")),
			"ordered-entry.mjs",
		),
	).toEqual([
		{
			specifier: "ordered",
			kind: "import",
			resolved: path.join("node_modules", "ordered", "import.mjs"),
		},
	]);

	// surface.node on: the `node` condition is active and wins by declaration order.
	const graph = buildModuleGraph(path.join(root, "ordered-entry.mjs"), {
		buildConfig: nodeOn,
	});
	expect(depSummary(graph, "ordered-entry.mjs")).toEqual([
		{
			specifier: "ordered",
			kind: "import",
			resolved: path.join("node_modules", "ordered", "node.mjs"),
		},
	]);
});

test("selects package export conditions by dependency kind", () => {
	write(
		"node_modules/dual/package.json",
		JSON.stringify({
			type: "module",
			exports: { import: "./import.mjs", require: "./require.cjs" },
		}),
	);
	write("node_modules/dual/import.mjs", `export default "import";\n`);
	write("node_modules/dual/require.cjs", `module.exports = "require";\n`);
	write("dual-import.mjs", `import value from "dual";\nglobalThis.sink = value;\n`);
	write("dual-require.cjs", `module.exports = require("dual");\n`);

	expect(
		depSummary(buildModuleGraph(path.join(root, "dual-import.mjs")), "dual-import.mjs"),
	).toEqual([
		{
			specifier: "dual",
			kind: "import",
			resolved: path.join("node_modules", "dual", "import.mjs"),
		},
	]);
	expect(
		depSummary(buildModuleGraph(path.join(root, "dual-require.cjs")), "dual-require.cjs"),
	).toEqual([
		{
			specifier: "dual",
			kind: "require",
			resolved: path.join("node_modules", "dual", "require.cjs"),
		},
	]);
});

test("does not fall back to main when package exports blocks the root", () => {
	write(
		"node_modules/blocked/package.json",
		JSON.stringify({
			type: "module",
			exports: { "./feature": "./feature.mjs" },
			main: "./main.mjs",
		}),
	);
	write("node_modules/blocked/feature.mjs", `export const feature = 1;\n`);
	write("node_modules/blocked/main.mjs", `export const fallback = 1;\n`);
	write("blocked-entry.mjs", `import "blocked";\n`);

	expect(() => buildModuleGraph(path.join(root, "blocked-entry.mjs"))).toThrow(
		/not exported by blocked/,
	);
});

test("resolves wildcard package exports", () => {
	write(
		"node_modules/pattern/package.json",
		JSON.stringify({ type: "module", exports: { "./dist/*": "./dist/*.js" } }),
	);
	write("node_modules/pattern/dist/feature.js", `export const value = 42;\n`);
	write("pattern.mjs", `import { value } from "pattern/dist/feature";\nvalue;\n`);

	const graph = buildModuleGraph(path.join(root, "pattern.mjs"));
	expect(graph.modules.get(graph.entry)!.dependencies[0]!.resolvedPath).toBe(
		path.join(root, "node_modules/pattern/dist/feature.js"),
	);
});

test("resolves supported node:* imports to virtual host modules (no disk read) when surface.node is on", () => {
	write(
		"node-host.mjs",
		`import { join } from "node:path";\nimport { readFileSync } from "node:fs";\nglobalThis.sink = [join, readFileSync];\n`,
	);
	const graph = buildModuleGraph(path.join(root, "node-host.mjs"), {
		buildConfig: nodeOn,
	});

	// The importer's edges carry the canonical specifier as the resolved identity.
	const entry = graph.modules.get(path.join(root, "node-host.mjs"))!;
	expect(entry.dependencies).toEqual([
		{ specifier: "node:path", kind: "import", resolvedPath: "node:path" },
		{ specifier: "node:fs", kind: "import", resolvedPath: "node:fs" },
	]);

	// Virtual records keyed by specifier, marked host, with no on-disk source.
	const pathMod = graph.modules.get("node:path")!;
	expect(pathMod.host?.id).toBe("node:path");
	expect(pathMod.goal).toBe("module");
	expect(pathMod.source).toBe("");
	expect(pathMod.dependencies).toEqual([]);

	// Static host imports still order before their dependent (entry last).
	expect(graph.evaluationOrder).toContain("node:path");
	expect(graph.evaluationOrder.indexOf("node:path")).toBeLessThan(
		graph.evaluationOrder.indexOf(path.join(root, "node-host.mjs")),
	);
});

test("host catalog includes path and postgres.js loading companions", () => {
	write(
		"catalog.mjs",
		`import "node:path";\nimport "node:crypto";\nimport "node:perf_hooks";\nimport "node:tls";\n`,
	);
	const graph = buildModuleGraph(path.join(root, "catalog.mjs"), {
		buildConfig: nodeOn,
	});

	const pathSpec = graph.modules.get("node:path")!.host!;
	expect(pathSpec.named).toContain("normalize");
	expect(pathSpec.named).toContain("relative");
	expect(pathSpec.hasDefault).toBe(true);

	const cryptoSpec = graph.modules.get("node:crypto")!.host!;
	expect(cryptoSpec.named).toEqual([
		"X509Certificate",
		"argon2",
		"argon2Sync",
		"createHash",
		"createHmac",
		"createSign",
		"createVerify",
		"generateKeyPairSync",
		"hash",
		"pbkdf2Sync",
		"publicEncrypt",
		"randomBytes",
		"randomInt",
		"randomUUID",
		"timingSafeEqual",
	]);
	expect(cryptoSpec.hasDefault).toBe(true);
	expect(graph.modules.get("node:perf_hooks")!.host).toMatchObject({
		named: ["monitorEventLoopDelay", "performance"],
		hasDefault: true,
	});
	expect(graph.modules.get("node:tls")!.host).toMatchObject({
		named: ["connect"],
		hasDefault: true,
	});
});

test("canonicalizes bare buffer and exposes the node:buffer constructor", () => {
	write("buffer.cjs", `module.exports = require("buffer");\n`);
	const graph = buildModuleGraph(path.join(root, "buffer.cjs"), {
		buildConfig: nodeOn,
	});
	const dependency = graph.modules.get(graph.entry)!.dependencies[0]!;
	expect(dependency.resolvedPath).toBe("node:buffer");
	expect(graph.modules.get("node:buffer")?.host).toMatchObject({
		named: ["Buffer", "constants"],
		hasDefault: true,
	});
});

test("canonicalizes bare ESM buffer to node:buffer", () => {
	write("buffer.mjs", `import { Buffer } from "buffer";\nBuffer;\n`);
	const graph = buildModuleGraph(path.join(root, "buffer.mjs"), {
		buildConfig: nodeOn,
	});
	expect(graph.modules.get(graph.entry)!.dependencies[0]!.resolvedPath).toBe(
		"node:buffer",
	);
});

test("canonicalizes the promise-based filesystem submodule", () => {
	write(
		"fs-promises.mjs",
		`import fsPromises, { readdir } from "fs/promises";\n` +
			`globalThis.sink = [fsPromises, readdir];\n`,
	);
	const graph = buildModuleGraph(path.join(root, "fs-promises.mjs"), {
		buildConfig: nodeOn,
	});
	expect(graph.modules.get(graph.entry)!.dependencies[0]!.resolvedPath).toBe(
		"node:fs/promises",
	);
	expect(graph.modules.get("node:fs/promises")?.host).toMatchObject({
		named: [
			"appendFile",
			"copyFile",
			"lstat",
			"mkdir",
			"readFile",
			"readdir",
			"rename",
			"rm",
			"stat",
			"unlink",
			"writeFile",
		],
		hasDefault: true,
		installer: "mal_host_install_node_fs_promises",
	});
});

test("resolves curated V8 and VM context helpers", () => {
	write(
		"node-vm.mjs",
		`import { setFlagsFromString } from "node:v8";\n` +
			`import { runInNewContext } from "node:vm";\n` +
			`globalThis.sink = [setFlagsFromString, runInNewContext];\n`,
	);
	const graph = buildModuleGraph(path.join(root, "node-vm.mjs"), {
		buildConfig: nodeOn,
	});
	expect(graph.modules.get("node:v8")?.host).toMatchObject({
		named: ["setFlagsFromString"],
		hasDefault: true,
	});
	expect(graph.modules.get("node:vm")?.host).toMatchObject({
		named: ["runInNewContext"],
		hasDefault: true,
	});
});

test("resolves the diagnostics tracing channel", () => {
	write(
		"diagnostics.cjs",
		`module.exports = require("node:diagnostics_channel").tracingChannel;\n`,
	);
	const graph = buildModuleGraph(path.join(root, "diagnostics.cjs"), {
		buildConfig: nodeOn,
	});
	expect(graph.modules.get("node:diagnostics_channel")?.host).toMatchObject({
		named: ["channel", "hasSubscribers", "subscribe", "tracingChannel", "unsubscribe"],
		hasDefault: true,
		installer: "mal_host_install_node_diagnostics_channel",
	});
});

test("canonicalizes the worker_threads main-thread identity", () => {
	write("worker.cjs", `module.exports = require("worker_threads").isMainThread;\n`);
	const graph = buildModuleGraph(path.join(root, "worker.cjs"), {
		buildConfig: nodeOn,
	});
	expect(graph.modules.get(graph.entry)!.dependencies[0]!.resolvedPath).toBe(
		"node:worker_threads",
	);
	expect(graph.modules.get("node:worker_threads")?.host).toMatchObject({
		named: [
			"MessageChannel",
			"SHARE_ENV",
			"Worker",
			"isMainThread",
			"markAsUncloneable",
			"parentPort",
			"receiveMessageOnPort",
			"threadId",
			"workerData",
		],
		hasDefault: true,
		installer: "mal_host_install_node_worker_threads",
	});
});

test("canonicalizes the CommonJS module API", () => {
	write("module-api.cjs", `module.exports = require("module").createRequire;\n`);
	const graph = buildModuleGraph(path.join(root, "module-api.cjs"), {
		buildConfig: nodeOn,
	});
	expect(graph.modules.get(graph.entry)!.dependencies[0]!.resolvedPath).toBe(
		"node:module",
	);
	expect(graph.modules.get("node:module")?.host).toMatchObject({
		named: ["builtinModules", "createRequire", "isBuiltin"],
		hasDefault: true,
		installer: "mal_host_install_node_module",
	});
});

test("resolves asynchronous child process entrypoints", () => {
	write(
		"child-process.mjs",
		`import { exec, spawn } from "node:child_process";\n` +
			`globalThis.sink = [exec, spawn];\n`,
	);
	const graph = buildModuleGraph(path.join(root, "child-process.mjs"), {
		buildConfig: nodeOn,
	});
	expect(graph.modules.get("node:child_process")?.host).toMatchObject({
		named: ["exec", "execFile", "execFileSync", "spawn"],
		installer: "mal_host_install_node_child_process",
	});
});

test("rejects a node:* import clearly when surface.node is off (the default)", () => {
	write("node-off.mjs", `import { join } from "node:path";\n`);
	expect(() => buildModuleGraph(path.join(root, "node-off.mjs"))).toThrow(
		/node built-in modules are disabled/,
	);
});

test("canonicalizes bare zlib and exposes compression adapters", () => {
	write("zlib.cjs", `module.exports = [require("zlib"), require("node:zlib")];\n`);
	const graph = buildModuleGraph(path.join(root, "zlib.cjs"), {
		buildConfig: nodeOn,
	});
	const dependencies = graph.modules.get(graph.entry)!.dependencies;
	expect(dependencies.map((dependency) => dependency.resolvedPath)).toEqual([
		"node:zlib",
		"node:zlib",
	]);
	expect(graph.modules.get("node:zlib")?.host).toMatchObject({
		named: [
			"constants",
			"createBrotliDecompress",
			"createGunzip",
			"createGzip",
			"createInflate",
			"deflate",
		],
		hasDefault: true,
	});
});

test("canonicalizes bare and node: HTTP specifiers to one host module", () => {
	write("http.cjs", `module.exports = [require("http"), require("node:http")];\n`);
	const graph = buildModuleGraph(path.join(root, "http.cjs"), {
		buildConfig: nodeOn,
	});
	const dependencies = graph.modules.get(graph.entry)!.dependencies;
	expect(dependencies.map((dependency) => dependency.resolvedPath)).toEqual([
		"node:http",
		"node:http",
	]);
	expect(graph.modules.get("node:http")?.host).toMatchObject({
		named: [
			"Agent",
			"METHODS",
			"STATUS_CODES",
			"IncomingMessage",
			"ServerResponse",
			"Server",
			"ClientRequest",
			"createServer",
			"get",
			"globalAgent",
			"request",
			"validateHeaderName",
			"validateHeaderValue",
		],
		hasDefault: true,
	});
});

test("canonicalizes strict assert and exposes the smoke-runner assertions", () => {
	write(
		"assert-strict.cjs",
		`module.exports = [require("assert/strict"), require("node:assert/strict")];\n`,
	);
	const graph = buildModuleGraph(path.join(root, "assert-strict.cjs"), {
		buildConfig: nodeOn,
	});
	const dependencies = graph.modules.get(graph.entry)!.dependencies;
	expect(dependencies.map((dependency) => dependency.resolvedPath)).toEqual([
		"node:assert/strict",
		"node:assert/strict",
	]);
	expect(graph.modules.get("node:assert/strict")?.host).toMatchObject({
		named: [
			"deepEqual",
			"deepStrictEqual",
			"doesNotMatch",
			"equal",
			"fail",
			"ifError",
			"match",
			"notDeepEqual",
			"notDeepStrictEqual",
			"notEqual",
			"notStrictEqual",
			"ok",
			"strictEqual",
		],
		hasDefault: true,
	});
});

test("resolves a toolchain-owned virtual ESM module", () => {
	write(
		"virtual-entry.mts",
		`import { test } from "maligator:test"; test("ok", () => {});`,
	);
	const graph = buildModuleGraph(path.join(root, "virtual-entry.mts"), {
		stripTypes: (source) => source,
		virtualModules: new Map([
			[
				"maligator:test",
				{
					source: `export function test(name, callback) { callback(name); }\n`,
				},
			],
		]),
	});

	expect(graph.evaluationOrder).toEqual(["maligator:test", graph.entry]);
	expect(graph.modules.get("maligator:test")).toMatchObject({
		path: "maligator:test",
		goal: "module",
		virtual: true,
		dependencies: [],
	});
});

test("evaluates a toolchain entry prelude before ESM and CommonJS entries", () => {
	const prelude = {
		specifier: "maligator:node-globals",
		source: `globalThis.fetch = () => "ok";\n`,
	};
	for (const entryName of ["prelude-entry.mjs", "prelude-entry.cjs"]) {
		write(entryName, `globalThis.result = fetch();\n`);
		const graph = buildModuleGraph(path.join(root, entryName), {
			entryPrelude: prelude,
		});

		expect(graph.evaluationOrder).toEqual([prelude.specifier, graph.entry]);
		expect(graph.modules.get(graph.entry)?.source).toBe(`globalThis.result = fetch();\n`);
		expect(graph.modules.get(prelude.specifier)).toMatchObject({
			goal: "module",
			virtual: true,
		});
		expect(graph.modules.get(graph.entry)?.dependencies).toEqual([
			expect.objectContaining({
				specifier: prelude.specifier,
				resolvedPath: prelude.specifier,
			}),
		]);
	}
});

test("toolchain source transforms preserve original module identities", () => {
	const entry = path.join(root, "transformed-entry.mjs");
	write("transformed-entry.mjs", `globalThis.events.push("body");\n`);
	const graph = buildModuleGraph(entry, {
		transformSource(source, filePath) {
			return filePath === entry ? `globalThis.events.push("before");${source}` : source;
		},
	});
	const record = graph.modules.get(entry)!;
	expect(record.source).toBe(`globalThis.events.push("body");\n`);
	expect(record.parsed.ast.body).toHaveLength(2);
});

test("parse caches distinguish transformed source from the on-disk module", () => {
	const entry = path.join(root, "cached-transformed-entry.mjs");
	write("cached-transformed-entry.mjs", `globalThis.events.push("body");\n`);
	const parseCache = new ModuleParseCache();
	const plain = buildModuleGraph(entry, { parseCache });
	const transformed = buildModuleGraph(entry, {
		parseCache,
		transformSource(source, filePath) {
			return filePath === entry ? `globalThis.events.push("before");${source}` : source;
		},
	});

	expect(plain.modules.get(entry)!.parsed.ast.body).toHaveLength(1);
	expect(transformed.modules.get(entry)!.parsed.ast.body).toHaveLength(2);
	expect(parseCache.statistics()).toEqual({ hits: 0, misses: 2 });
});

test("rejects an unknown node:* built-in clearly even when surface.node is on", () => {
	write("node-unknown.mjs", `import "node:dgram";\n`);
	expect(() =>
		buildModuleGraph(path.join(root, "node-unknown.mjs"), { buildConfig: nodeOn }),
	).toThrow(/unknown node built-in module 'node:dgram'/);
});

test("canonicalizes a bare ESM path specifier to the host built-in", () => {
	write("bare-path.mjs", `import { join } from "path";\njoin;\n`);
	const graph = buildModuleGraph(path.join(root, "bare-path.mjs"), {
		buildConfig: nodeOn,
	});
	expect(graph.modules.get(graph.entry)!.dependencies[0]!.resolvedPath).toBe("node:path");
});

test("applies an exact module alias before resolution", () => {
	write("aliased.mjs", `export const answer = 42;\n`);
	write("alias-entry.mjs", `import { answer } from "package-entry";\nanswer;\n`);
	const graph = buildModuleGraph(path.join(root, "alias-entry.mjs"), {
		buildConfig: resolveBuildConfig({
			modules: { aliases: { "package-entry": "./aliased.mjs" } },
		}),
	});
	expect(graph.modules.get(graph.entry)?.dependencies[0]?.resolvedPath).toBe(
		path.join(root, "aliased.mjs"),
	);
});

test("gives supported bare assert precedence over npm packages", () => {
	write("node_modules/assert/package.json", `{"main":"index.js"}\n`);
	write("node_modules/assert/index.js", `module.exports = "npm-shadow";\n`);
	write("bare-assert.cjs", `module.exports = require("assert");\n`);
	const graph = buildModuleGraph(path.join(root, "bare-assert.cjs"), {
		buildConfig: nodeOn,
	});
	expect(graph.modules.get(graph.entry)!.dependencies[0]!.resolvedPath).toBe(
		"node:assert",
	);
	expect(graph.modules.get("node:assert")?.host).toMatchObject({
		named: [
			"AssertionError",
			"deepEqual",
			"deepStrictEqual",
			"doesNotMatch",
			"equal",
			"fail",
			"ifError",
			"match",
			"notDeepEqual",
			"notDeepStrictEqual",
			"notEqual",
			"notStrictEqual",
			"ok",
			"strictEqual",
		],
		hasDefault: true,
	});
});

test("recognizes inspector as a bare core module", () => {
	write("bare-inspector.cjs", `module.exports = require("inspector");\n`);
	const graph = buildModuleGraph(path.join(root, "bare-inspector.cjs"), {
		buildConfig: nodeOn,
	});
	expect(graph.modules.get(graph.entry)!.dependencies[0]!.resolvedPath).toBe(
		"node:inspector",
	);
	expect(graph.modules.get("node:inspector")?.host).toMatchObject({
		named: ["Session", "close", "open", "url"],
		hasDefault: true,
	});
});

test("does not treat prefix-only node:test as a bare core module", () => {
	write("bare-test.cjs", `module.exports = require("test");\n`);
	expect(() =>
		buildModuleGraph(path.join(root, "bare-test.cjs"), { buildConfig: nodeOn }),
	).toThrow(/Cannot resolve 'test'/);
});

test("resolves prefix-only node:sqlite without treating bare sqlite as core", () => {
	write(
		"node-sqlite.mjs",
		`import { DatabaseSync, StatementSync } from "node:sqlite";\n` +
			`globalThis.sink = [DatabaseSync, StatementSync];\n`,
	);
	const graph = buildModuleGraph(path.join(root, "node-sqlite.mjs"), {
		buildConfig: nodeOn,
	});
	expect(graph.modules.get("node:sqlite")?.host?.named).toEqual([
		"DatabaseSync",
		"StatementSync",
	]);

	write("bare-sqlite.cjs", `module.exports = require("sqlite");\n`);
	expect(() =>
		buildModuleGraph(path.join(root, "bare-sqlite.cjs"), {
			buildConfig: nodeOn,
		}),
	).toThrow(/Cannot resolve 'sqlite'/);
});

test("canonicalizes node:process and bare process to the shared host module", () => {
	write(
		"node-process.mjs",
		`import process, { emitWarning, env } from "node:process";\n` +
			`globalThis.sink = [process, emitWarning, env];\n`,
	);
	const graph = buildModuleGraph(path.join(root, "node-process.mjs"), {
		buildConfig: nodeOn,
	});
	expect(graph.modules.get("node:process")?.host).toEqual(
		expect.objectContaining({
			hasDefault: true,
			installer: "mal_host_install_process",
		}),
	);

	write("bare-process.cjs", `module.exports = require("process");\n`);
	const bareGraph = buildModuleGraph(path.join(root, "bare-process.cjs"), {
		buildConfig: nodeOn,
	});
	expect(bareGraph.modules.get(bareGraph.entry)!.dependencies[0]!.resolvedPath).toBe(
		"node:process",
	);
});

test("canonicalizes bare string_decoder instead of resolving an ancestor shim", () => {
	write("bare-decoder.cjs", `module.exports = require("string_decoder");\n`);
	const graph = buildModuleGraph(path.join(root, "bare-decoder.cjs"), {
		buildConfig: nodeOn,
	});
	expect(graph.modules.get(graph.entry)!.dependencies[0]!.resolvedPath).toBe(
		"node:string_decoder",
	);
});

test("a literal dynamic import of a supported node:* resolves to its host module", () => {
	write(
		"dyn-node.mjs",
		`async function f() {\n\treturn import("node:crypto");\n}\nglobalThis.sink = f;\n`,
	);
	const graph = buildModuleGraph(path.join(root, "dyn-node.mjs"), {
		buildConfig: nodeOn,
	});
	expect(graph.modules.get(graph.entry)?.dependencies).toEqual([
		expect.objectContaining({
			specifier: "node:crypto",
			kind: "dynamic",
			resolvedPath: "node:crypto",
		}),
	]);
	expect(graph.modules.get("node:crypto")?.host?.id).toBe("node:crypto");
});

test("a literal dynamic import of an unknown node:* is rejected, not deferred", () => {
	write("dyn-unknown.mjs", `import("node:dgram");\n`);
	expect(() =>
		buildModuleGraph(path.join(root, "dyn-unknown.mjs"), { buildConfig: nodeOn }),
	).toThrow(/unknown node built-in module 'node:dgram'/);
});

test("a literal dynamic import of node:* is rejected when surface.node is off", () => {
	write("dyn-off.mjs", `import("node:path");\n`);
	expect(() => buildModuleGraph(path.join(root, "dyn-off.mjs"))).toThrow(
		/node built-in modules are disabled/,
	);
});

test("a computed dynamic import of a node: string is deferred (only literals are checked)", () => {
	write("dyn-computed.mjs", `const m = "node:zlib";\nimport(m);\n`);
	const graph = buildModuleGraph(path.join(root, "dyn-computed.mjs"), {
		buildConfig: nodeOn,
	});
	const entry = graph.modules.get(path.join(root, "dyn-computed.mjs"))!;
	expect(entry.dependencies).toEqual([
		{ specifier: null, kind: "dynamic", resolvedPath: null },
	]);
});
