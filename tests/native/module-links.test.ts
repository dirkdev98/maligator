import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDerivationFromConfig, resolveBuildConfig } from "../../src/build-config.ts";
import { runSemanticAnalysisForGraph } from "../../src/compiler/frontend/analyze-module-graph.ts";
import { stripCompactTypes } from "../../src/compiler/frontend/compact-type-strip.ts";
import { buildModuleGraph } from "../../src/compiler/frontend/module-graph.ts";
import type { ExternalModuleInterface } from "../../src/compiler/frontend/module-graph.ts";
import { compileSemanticProgramToProgramImage } from "../../src/compiler/pipeline/compile-core.ts";
import { serializeRuntimeImage } from "../../src/compiler/target/program-image-codec.ts";
import { buildDevelopmentRunner } from "../../src/local-build.ts";
import { resolveNativeBuildContext } from "../../src/native-build-context.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "mal-module-links-"));
const config = resolveBuildConfig({ surface: { webPlatform: true } });
let runner: string;

function write(relativePath: string, source: string): string {
	const file = path.join(root, relativePath);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, source);
	return file;
}

type Interfaces = Map<string, ExternalModuleInterface>;

/** Compile one image of a linked program, publishing all its modules when asked. */
function compileImage(
	name: string,
	source: string,
	external: Interfaces,
	publish: boolean,
): { wire: string; interfaces: Interfaces } {
	const entry = path.join(root, `${name}.mjs`);
	const graph = buildModuleGraph(entry, {
		entryGoal: "module",
		entrySource: source,
		stripTypes: stripCompactTypes,
		buildConfig: config,
		externalModules: external,
	});
	const image = compileSemanticProgramToProgramImage(runSemanticAnalysisForGraph(graph), {
		optimization: "development",
		...(publish ? { semanticLowering: { moduleExports: "all" as const } } : {}),
	});
	const wire = path.join(root, `${name}.malw`);
	writeFileSync(wire, serializeRuntimeImage(image.runtime));
	return {
		wire,
		interfaces: new Map(
			(image.moduleInterfaces ?? []).map(({ module, ...surface }) => [module, surface]),
		),
	};
}

function run(wires: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) {
	const result = spawnSync(
		runner,
		["--maligator-internal-run-wires", String(wires.length), wires.at(-1)!, ...wires],
		{ encoding: "utf-8", env: { ...process.env, MAL_GC_AT_EXIT: "1", ...env } },
	);
	return { ...result, lines: result.stdout.trim().split("\n") };
}

const COUNTER = `export let count = 0;
export function increment() { count++; }
export default "counter default";
export const answer = 42;
`;

beforeAll(() => {
	write("lib/counter.mjs", COUNTER);
	write("lib/star.mjs", `export const starred = "starred";\n`);
	write(
		"lib/reexport.mjs",
		`export { answer as renamed, default as counterDefault } from "./counter.mjs";
export * from "./star.mjs";
`,
	);
	write("lib/legacy.cjs", `module.exports = { legacy: 1, nested: { value: 2 } };\n`);
	const derivation = buildDerivationFromConfig(config);
	runner = buildDevelopmentRunner(
		resolveNativeBuildContext({ features: derivation.features }),
		false,
		derivation.cacheSuffix,
	).binaryPath;
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("cross-image module links", () => {
	function linkedProgram() {
		const library = compileImage(
			"library",
			`import "./lib/counter.mjs";
import "./lib/reexport.mjs";
import "./lib/legacy.cjs";
`,
			new Map(),
			true,
		);
		const consumer = compileImage(
			"consumer",
			`import counterDefault, { count, increment } from "./lib/counter.mjs";
import * as counter from "./lib/counter.mjs";
import { renamed, starred, counterDefault as viaReexport } from "./lib/reexport.mjs";
import legacy, { legacy as legacyName } from "./lib/legacy.cjs";
console.log("before", count, counter.count);
increment();
console.log("after", count, counter.count);
console.log("default", counterDefault, viaReexport === counterDefault);
console.log("reexports", renamed, starred);
console.log("commonjs", legacy.nested.value, legacyName);
globalThis.firstNamespace = counter;
`,
			library.interfaces,
			false,
		);
		const observer = compileImage(
			"observer",
			`import * as counter from "./lib/counter.mjs";
import { count } from "./lib/counter.mjs";
console.log("shared namespace", counter === globalThis.firstNamespace, count);
`,
			library.interfaces,
			false,
		);
		return [library.wire, consumer.wire, observer.wire];
	}

	it("aliases imported bindings to the live slots an earlier image publishes", () => {
		const wires = linkedProgram();
		for (const env of [{}, { MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1" }]) {
			const result = run(wires, env);
			expect(result.status, result.stderr).toBe(0);
			expect(result.lines).toEqual([
				"before 0 0",
				"after 1 1",
				"default counter default true",
				"reexports 42 starred",
				"commonjs 2 1",
				"shared namespace true 1",
			]);
		}
	});

	it("evaluates an image only after an earlier image's top-level await settles", () => {
		write(
			"lib/settled.mjs",
			`export let settled = false;
await new Promise((resolve) => setTimeout(resolve, 10));
settled = true;
`,
		);
		const library = compileImage(
			"awaiting-library",
			`import "./lib/settled.mjs";\n`,
			new Map(),
			true,
		);
		const consumer = compileImage(
			"awaiting-consumer",
			`import { settled } from "./lib/settled.mjs";\nconsole.log("settled", settled);\n`,
			library.interfaces,
			false,
		);
		const result = run([library.wire, consumer.wire]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.lines).toEqual(["settled true"]);
	});

	it("rejects an image whose interface names an export the loaded image lacks", () => {
		const stale = compileImage(
			"stale",
			`import { removed } from "./lib/counter.mjs";
console.log(removed);
`,
			new Map([
				[path.join(root, "lib/counter.mjs"), { goal: "module", exports: ["removed"] }],
			]),
			false,
		);
		const library = compileImage(
			"library-only",
			`import "./lib/counter.mjs";\n`,
			new Map(),
			true,
		);
		const result = run([library.wire, stale.wire]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("does not provide an export named 'removed'");
	});

	it("reports a missing export of an earlier image while compiling the importer", () => {
		const library = compileImage(
			"library-for-missing",
			`import "./lib/counter.mjs";\n`,
			new Map(),
			true,
		);
		expect(() =>
			compileImage(
				"missing",
				`import { absent } from "./lib/counter.mjs";\nconsole.log(absent);\n`,
				library.interfaces,
				false,
			),
		).toThrow(/does not export 'absent'/);
	});
});
