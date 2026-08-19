import {
	existsSync,
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
import {
	BuildCompilationSession,
	compileBuildFrontend,
} from "../src/build-frontend-cache.ts";
import { stripCompactTypes } from "../src/compact-type-strip.ts";
import { TestCompilationSession } from "../src/testing/cache.ts";
import {
	compileRelocatableTestImage,
	UnsupportedRelocatableTestImageError,
} from "../src/testing/fragment-cache.ts";

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
	test("installs Node-compatible globals in interpreted test images", () => {
		const root = temporaryDirectory();
		const compiled = compileRelocatableTestImage({
			files: [
				path.resolve("tests/fixtures/node-headers.test.ts"),
				path.resolve("tests/fixtures/node-fetch.test.ts"),
			],
			config: resolveBuildConfig({ surface: { node: true } }),
			stripTypes: stripCompactTypes,
			stripperIdentity: "node-globals-regression",
			testModuleSource: readFileSync(path.resolve("src/testing/runtime.mjs"), "utf-8"),
			nodeGlobalsSource: readFileSync(path.resolve("src/node-globals.mjs"), "utf-8"),
			cacheDirectory: path.join(root, "cache"),
		});

		expect(compiled.cache).toBe("miss");
		expect(compiled.wires.map((wire) => wire.kind)).toEqual([
			"base",
			"entry",
			"entry",
			"runner",
		]);
	});

	test("keeps a cold Drizzle table graph on the linear development path", () => {
		const root = temporaryDirectory();
		const compiled = compileRelocatableTestImage({
			files: [path.resolve("tests/fixtures/drizzle-simple-table.test.ts")],
			config: resolveBuildConfig({ surface: { node: true } }),
			stripTypes: stripCompactTypes,
			stripperIdentity: "drizzle-cold-regression",
			testModuleSource: readFileSync(path.resolve("src/testing/runtime.mjs"), "utf-8"),
			cacheDirectory: path.join(root, "cache"),
		});

		expect(compiled.cache).toBe("miss");
		expect(compiled.wires[0]?.kind).toBe("dependency");
		expect(compiled.artifactMisses).toBe(4);
		// The production allocator made this one-table graph take roughly 44 seconds.
		// Ten seconds is a deliberately loose smoke fuse for loaded CI hosts while
		// still proving interpreted tests use the linear development allocator.
		expect(compiled.phases.compileMs).toBeLessThan(10_000);
	}, 15_000);

	test("reuses dependency artifacts produced by a normal run build", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const packageDirectory = path.join(root, "node_modules/example-package");
		const application = path.join(root, "app.mjs");
		const testEntry = path.join(root, "app.test.mts");
		const config = resolveBuildConfig({});
		mkdirSync(packageDirectory, { recursive: true });
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(
			path.join(packageDirectory, "package.json"),
			`{"type":"module","exports":"./index.mjs"}\n`,
		);
		write(path.join(packageDirectory, "index.mjs"), `export const answer = 42;\n`);
		write(application, `import { answer } from "example-package";\nvoid answer;\n`);
		write(
			testEntry,
			`import { test } from "maligator:test";\nimport { answer } from "example-package";\ntest("answer", () => answer);\n`,
		);
		const build = compileBuildFrontend({
			entrypoint: application,
			config,
			stripTypes: stripCompactTypes,
			stripperIdentity: "cross-command-dependency-test",
			cacheDirectory,
			session: new BuildCompilationSession(),
			optimization: "development",
			relocatable: true,
		});
		expect(build.fragmentArtifacts).toEqual({ hits: 0, misses: 2 });

		const compiledTest = compileRelocatableTestImage({
			files: [testEntry],
			config,
			stripTypes: stripCompactTypes,
			stripperIdentity: "cross-command-dependency-test",
			testModuleSource: readFileSync(path.resolve("src/testing/runtime.mjs"), "utf-8"),
			cacheDirectory,
		});
		expect(compiledTest.wires.map((wire) => wire.kind)).toEqual([
			"dependency",
			"base",
			"entry",
			"runner",
		]);
		expect(compiledTest.wires[0]!.path).toBe(build.artifacts[0]!.path);
		expect(compiledTest.artifactHits).toBe(1);
		expect(compiledTest.artifactMisses).toBe(3);
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
			stripTypes: stripCompactTypes,
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
		for (const wire of warm.wires) {
			expect(existsSync(wire.path)).toBe(true);
			expect(wire.size).toBeGreaterThan(0);
			expect(Object.getOwnPropertyDescriptor(wire, "wire")).toHaveProperty("get");
		}

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
				stripTypes: stripCompactTypes,
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
				stripTypes: stripCompactTypes,
				stripperIdentity: "fragment-test-stripper",
				testModuleSource: readFileSync(path.resolve("src/testing/runtime.mjs"), "utf-8"),
				cacheDirectory: path.join(root, "cache"),
			}),
		).toThrow(/does not export 'answer'/);
	});
});
