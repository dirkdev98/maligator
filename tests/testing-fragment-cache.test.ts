import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { TestCompilationSession } from "../src/testing/cache.ts";
import {
	compileRelocatableTestImage,
	UnsupportedRelocatableTestImageError,
} from "../src/testing/fragment-cache.ts";
import { stripTypesWithTypeScript } from "../src/typescript-strip.ts";

const temporaryDirectories: Array<string> = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "maligator-fragments-"));
	temporaryDirectories.push(directory);
	return directory;
}

function write(file: string, source: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, source);
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function testSource(name: string, revision = 0): string {
	return `import { expect, test } from "maligator:test";
import { answer } from "./shared.ts";
test(${JSON.stringify(name)}, () => expect(answer).toBe(42));
// revision ${revision}
`;
}

describe("relocatable test fragment cache", () => {
	test("keeps a cold Drizzle table graph on the linear development path", () => {
		const root = temporaryDirectory();
		const compiled = compileRelocatableTestImage({
			files: [path.resolve("tests/fixtures/drizzle-simple-table.test.ts")],
			config: resolveBuildConfig({ surface: { node: true } }),
			stripTypes: stripTypesWithTypeScript,
			stripperIdentity: "drizzle-cold-regression",
			testModuleSource: readFileSync(path.resolve("src/testing/runtime.mjs"), "utf-8"),
			cacheDirectory: path.join(root, "cache"),
		});

		expect(compiled.cache).toBe("miss");
		expect(compiled.artifactMisses).toBe(3);
		// The production allocator made this one-table graph take roughly 44 seconds.
		// Ten seconds is a deliberately loose smoke fuse for loaded CI hosts while
		// still proving interpreted tests use the linear development allocator.
		expect(compiled.phases.compileMs).toBeLessThan(10_000);
	});

	test("reuses base and unchanged entry fragments independently", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const shared = path.join(root, "shared.ts");
		const first = path.join(root, "a.test.ts");
		const second = path.join(root, "b.test.ts");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(shared, `export const answer: number = 42;\n`);
		write(first, testSource("a"));
		write(second, testSource("b"));
		const session = new TestCompilationSession();
		const options = {
			files: [second, first],
			config: resolveBuildConfig({ engine: { regexp: false } }),
			stripTypes: stripTypesWithTypeScript,
			stripperIdentity: "fragment-test-stripper",
			testModuleSource: readFileSync(path.resolve("src/testing/runtime.mjs"), "utf-8"),
			cacheDirectory,
			session,
		};

		const cold = compileRelocatableTestImage(options);
		const coldParses = session.moduleParses.statistics();
		const warm = compileRelocatableTestImage(options);
		expect(cold.cache).toBe("miss");
		expect(cold.wires.map((wire) => wire.kind)).toEqual([
			"base",
			"entry",
			"entry",
			"runner",
		]);
		expect(cold.artifactMisses).toBe(4);
		expect(coldParses.hits).toBeGreaterThan(0);
		expect(coldParses.misses).toBeGreaterThan(0);
		expect(warm.cache).toBe("hit");
		expect(warm.artifactHits).toBe(4);

		write(first, testSource("a", 1));
		session.invalidate(first);
		const changedEntry = compileRelocatableTestImage(options);
		expect(changedEntry.cache).toBe("miss");
		expect(changedEntry.artifactHits).toBe(3);
		expect(changedEntry.artifactMisses).toBe(1);

		const originalTimes = statSync(shared);
		write(shared, `export const answer: number = 42;\n// changed dependency\n`);
		utimesSync(shared, originalTimes.atime, originalTimes.mtime);
		session.invalidate(shared);
		const changedDependency = compileRelocatableTestImage(options);
		expect(changedDependency.cache).toBe("miss");
		expect(changedDependency.artifactHits).toBe(3);
		expect(changedDependency.artifactMisses).toBe(1);
	});

	test("routes unsupported namespace imports to the whole-image fallback", () => {
		const root = temporaryDirectory();
		const entry = path.join(root, "namespace.test.ts");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(path.join(root, "shared.ts"), `export const answer = 42;\n`);
		write(
			entry,
			`import { test } from "maligator:test";
import * as shared from "./shared.ts";
test("namespace", () => shared.answer);
`,
		);

		expect(() =>
			compileRelocatableTestImage({
				files: [entry],
				config: resolveBuildConfig({}),
				stripTypes: stripTypesWithTypeScript,
				stripperIdentity: "fragment-test-stripper",
				testModuleSource: readFileSync(path.resolve("src/testing/runtime.mjs"), "utf-8"),
				cacheDirectory: path.join(root, "cache"),
			}),
		).toThrow(UnsupportedRelocatableTestImageError);
	});

	test("validates real dependency exports before generating facades", () => {
		const root = temporaryDirectory();
		const entry = path.join(root, "missing-export.test.ts");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(path.join(root, "shared.ts"), `export const other = 42;\n`);
		write(
			entry,
			`import { test } from "maligator:test";
import { answer } from "./shared.ts";
test("missing", () => answer);
`,
		);

		expect(() =>
			compileRelocatableTestImage({
				files: [entry],
				config: resolveBuildConfig({}),
				stripTypes: stripTypesWithTypeScript,
				stripperIdentity: "fragment-test-stripper",
				testModuleSource: readFileSync(path.resolve("src/testing/runtime.mjs"), "utf-8"),
				cacheDirectory: path.join(root, "cache"),
			}),
		).toThrow(/does not export 'answer'/);
	});
});
