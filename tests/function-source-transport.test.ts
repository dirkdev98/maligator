import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { ModuleParseCache } from "../src/compiler/frontend/module-graph.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-program.ts";
import { compileSemanticProgramToRuntimeImage } from "../src/compiler/pipeline/compile-runtime-core.ts";
import {
	deserializeRuntimeImage,
	serializeRuntimeImage,
} from "../src/compiler/target/program-image-codec.ts";
import type { RuntimeImage } from "../src/compiler/target/runtime-image.ts";

const directories: Array<string> = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
function setup() {
	const directory = mkdtempSync(join(tmpdir(), "mal-function-source-transport-"));
	writeFileSync(join(directory, "package.json"), '{"type":"module"}');
	directories.push(directory);
	return directory;
}
function reflectedSource(runtime: RuntimeImage, name: string): string {
	const text = (index: number) => String.fromCharCode(...runtime.stringConstants[index]!);
	const fn = runtime.functions.find(
		(fn) => fn.nameStringIndex >= 0 && text(fn.nameStringIndex) === name,
	);
	expect(fn).toBeDefined();
	expect(fn!.sourceStringIndex).toBeGreaterThanOrEqual(0);
	return text(fn!.sourceStringIndex);
}

it("retains exact source through constant compaction and wire encoding without debug information", () => {
	const declaration =
		"function reflected /* kept */ (value) {\r\n\treturn value + '🦎';\r\n}";
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		`const marker = 'unused';\u2028${declaration}\nglobalThis.reflected = reflected;`,
		"reflection.js",
	);
	const runtime = compileSemanticProgramToRuntimeImage(semantic);
	const restored = deserializeRuntimeImage(
		serializeRuntimeImage(runtime, { debugInfo: false }),
	);
	expect(restored.sourcePositions).toEqual([]);
	expect(reflectedSource(restored, "reflected")).toBe(declaration);
});

it.each([-2, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
	"rejects invalid source string index %s before wire encoding",
	(sourceStringIndex) => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			"globalThis.value = 1;",
			"reflection.js",
		);
		const runtime = compileSemanticProgramToRuntimeImage(semantic);
		const invalid = {
			...runtime,
			functions: runtime.functions.map((fn, index) =>
				index === 0 ? { ...fn, sourceStringIndex } : fn,
			),
		};
		expect(() => serializeRuntimeImage(invalid)).toThrow(
			/invalid function source string index/,
		);
	},
);

it.each([false, true])(
	"reflects the prepared TypeScript entry with transform=%s",
	(transform) => {
		const directory = setup();
		const entry = join(directory, "entry.ts");
		const source =
			"export function reflected(value: number): number { return value; }\nglobalThis.reflected = reflected;";
		writeFileSync(entry, source);
		const semantic = loadEntrypointAndRunSemanticAnalysis(entry, {
			stripTypes: stripCompactTypes,
			entryPrelude: {
				specifier: "reflection:prelude",
				source: "globalThis.preloaded = true;",
			},
			...(transform
				? {
						transformSource: {
							files: new Set([entry]),
							transform: (text: string) =>
								`\n${text.replace("return value;", "return value + 1;")}`,
						},
					}
				: {}),
		});
		const runtime = compileSemanticProgramToRuntimeImage(semantic);
		const expected = source
			.slice("export ".length, source.indexOf("\n"))
			.replaceAll(": number", " ".repeat(": number".length));
		expect(reflectedSource(runtime, "reflected")).toBe(
			transform ? expected.replace("return value;", "return value + 1;") : expected,
		);
	},
);

it("reflects prepared dependency source from retained and persisted graph caches", () => {
	const directory = setup();
	const entry = join(directory, "entry.mjs");
	const source = "export function reflected(value: number): number { return value; }";
	writeFileSync(
		entry,
		'import { reflected } from "./dependency.ts"; globalThis.reflected = reflected;',
	);
	writeFileSync(join(directory, "dependency.ts"), source);
	const cache = new ModuleParseCache();
	cache.usePersisted({}, {});
	const expected = source
		.slice("export ".length)
		.replaceAll(": number", " ".repeat(": number".length));
	const check = (parseCache: ModuleParseCache) => {
		const semantic = loadEntrypointAndRunSemanticAnalysis(entry, {
			stripTypes: stripCompactTypes,
			parseCache,
		});
		expect(
			reflectedSource(compileSemanticProgramToRuntimeImage(semantic), "reflected"),
		).toBe(expected);
	};
	check(cache);
	check(cache);
	const saved = cache.takePersistedChanges()!;
	const restored = new ModuleParseCache();
	restored.usePersisted(saved.parses, saved.loads);
	check(restored);
});
