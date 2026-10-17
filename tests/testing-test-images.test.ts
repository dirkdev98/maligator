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
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import {
	BuildCompilationSession,
	compileBuildFrontend,
} from "../src/build-frontend-cache.ts";
import { parseCliArgs } from "../src/cli.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import * as executionLowering from "../src/compiler/target/lower-execution.ts";
import { UnsupportedLinkedImagesError } from "../src/linked-images.ts";
import { hostExecutionTarget, resolveExecution } from "../src/platform/execution.ts";
import { TestCompilationSession } from "../src/testing/cache.ts";
import { compileLinkedTestImage } from "../src/testing/test-images.ts";

const temporaryDirectories: Array<string> = [];
const testModuleSource = readFileSync(path.resolve("src/testing/runtime.mjs"), "utf-8");

/** The execution snapshot of `maligator test <file> --run <filter>`. */
function testExecution(file: string, filter: string) {
	const command = parseCliArgs(["test", file, "--run", filter]);
	if (command.kind !== "test") throw new Error("expected test command");
	return resolveExecution(command, resolveBuildConfig({}), {
		compiled: false,
		optimization: "development",
		target: hostExecutionTarget(process.platform, process.arch),
	});
}

function temporaryDirectory(): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "maligator-test-images-"));
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

describe("linked test images", () => {
	test("recompiles only the runner when isolated runner options change", () => {
		const root = temporaryDirectory();
		const entry = path.join(root, "isolated.test.mts");
		write(entry, 'import { test } from "maligator:test";\ntest("isolated", () => {});\n');
		const shared = {
			files: [entry],
			config: resolveBuildConfig({}),
			stripTypes: stripCompactTypes,
			stripperIdentity: "isolated-test-image-strip",
			testModuleSource,
			cacheDirectory: path.join(root, "cache"),
		};
		const runner = (repeat: number) => ({
			kind: "process" as const,
			runOptions: { repeat, bail: false, timeoutMs: 1000 },
			resultPrefix: "__ISOLATED_RESULT__",
		});
		const first = compileLinkedTestImage({ ...shared, runner: runner(1) });
		const changedOptions = compileLinkedTestImage({ ...shared, runner: runner(2) });
		const restored = compileLinkedTestImage({ ...shared, runner: runner(1) });

		expect(first.wires.map((wire) => wire.kind)).toEqual(["runtime", "entry", "runner"]);
		expect(first.artifactMisses).toBe(3);
		expect(changedOptions.artifactHits).toBe(2);
		expect(changedOptions.artifactMisses).toBe(1);
		expect(restored.cache).toBe("hit");
		expect(restored.artifactHits).toBe(3);
	});

	test("installs Node-compatible globals in the runtime image", () => {
		const root = temporaryDirectory();
		const compiled = compileLinkedTestImage({
			files: [
				path.resolve("tests/fixtures/node-headers.test.ts"),
				path.resolve("tests/fixtures/node-fetch.test.ts"),
			],
			config: resolveBuildConfig({ surface: { node: true } }),
			stripTypes: stripCompactTypes,
			stripperIdentity: "node-globals-regression",
			testModuleSource,
			nodeGlobalsSource: readFileSync(path.resolve("src/node-globals.mjs"), "utf-8"),
			cacheDirectory: path.join(root, "cache"),
		});

		expect(compiled.cache).toBe("miss");
		expect(compiled.wires.map((wire) => wire.kind)).toEqual([
			"runtime",
			"entry",
			"entry",
			"runner",
		]);
	});

	test("keeps a cold Drizzle table graph on the linear development path", () => {
		const root = temporaryDirectory();
		const lowering = vi.spyOn(
			executionLowering,
			"lowerCoreCompilationToRuntimeExecution",
		);
		onTestFinished(() => lowering.mockRestore());
		const compiled = compileLinkedTestImage({
			files: [path.resolve("tests/fixtures/drizzle-simple-table.test.ts")],
			config: resolveBuildConfig({ surface: { node: true } }),
			stripTypes: stripCompactTypes,
			stripperIdentity: "drizzle-cold-regression",
			testModuleSource,
			cacheDirectory: path.join(root, "cache"),
		});

		expect(compiled.cache).toBe("miss");
		expect(compiled.wires.map((wire) => wire.kind)).toEqual([
			"runtime",
			"dependency",
			"entry",
			"runner",
		]);
		expect(compiled.artifactMisses).toBe(4);
		expect(lowering).toHaveBeenCalled();
		for (const [, options] of lowering.mock.calls) {
			expect(options).toMatchObject({ reuseRegisters: false });
		}
	}, 15_000);

	test("reuses dependency images produced by a normal run build", () => {
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
			interpreted: true,
		});
		expect(build.fragmentArtifacts).toEqual({ hits: 0, misses: 2 });

		const compiledTest = compileLinkedTestImage({
			files: [testEntry],
			config,
			stripTypes: stripCompactTypes,
			stripperIdentity: "cross-command-dependency-test",
			testModuleSource,
			cacheDirectory,
		});
		expect(compiledTest.wires.map((wire) => wire.kind)).toEqual([
			"runtime",
			"dependency",
			"entry",
			"runner",
		]);
		expect(compiledTest.wires[1]!.path).toBe(build.runtimeArtifacts[0]!.path);
		expect(compiledTest.artifactHits).toBe(1);
		expect(compiledTest.artifactMisses).toBe(3);
	});

	test("recompiles only the edited test file or application image", () => {
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
			stripperIdentity: "test-image-stripper",
			testModuleSource,
			cacheDirectory,
			session,
		};

		const cold = compileLinkedTestImage(options);
		const coldParses = session.moduleParses.statistics();
		const warm = compileLinkedTestImage(options);
		expect(cold.cache).toBe("miss");
		expect(cold.wires.map((wire) => wire.kind)).toEqual([
			"runtime",
			"application",
			"entry",
			"entry",
			"runner",
		]);
		expect(cold.artifactMisses).toBe(5);
		expect(coldParses.hits).toBeGreaterThan(0);
		expect(coldParses.misses).toBeGreaterThan(0);
		expect(warm.cache).toBe("hit");
		expect(warm.artifactHits).toBe(5);
		expect(warm.dependencies).toEqual(cold.dependencies);
		for (const wire of warm.wires) {
			expect(existsSync(wire.path)).toBe(true);
			expect(wire.size).toBeGreaterThan(0);
			expect(Object.getOwnPropertyDescriptor(wire, "wire")).toHaveProperty("get");
		}

		write(first, testSource("a", 1));
		session.invalidate(first);
		const changedEntry = compileLinkedTestImage(options);
		expect(changedEntry.cache).toBe("miss");
		expect(changedEntry.artifactHits).toBe(4);
		expect(changedEntry.artifactMisses).toBe(1);

		const originalTimes = statSync(shared);
		write(shared, `export const answer: number = 42;\n// changed dependency\n`);
		utimesSync(shared, originalTimes.atime, originalTimes.mtime);
		session.invalidate(shared);
		const changedApplication = compileLinkedTestImage(options);
		expect(changedApplication.cache).toBe("miss");
		expect(changedApplication.artifactHits).toBe(4);
		expect(changedApplication.artifactMisses).toBe(1);

		write(first, testSource("a", 2));
		session.invalidate(first);
		const singleFile = compileLinkedTestImage({ ...options, files: [first] });
		expect(singleFile.wires.map((wire) => wire.kind)).toEqual([
			"runtime",
			"application",
			"entry",
			"runner",
		]);
		expect(singleFile.artifactHits).toBe(3);
		expect(singleFile.artifactMisses).toBe(1);
	});

	test("links namespace imports and re-exports of application modules", () => {
		const root = temporaryDirectory();
		const entry = path.join(root, "namespace.test.ts");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(path.join(root, "shared.ts"), `export const answer = 42;\n`);
		write(path.join(root, "barrel.ts"), `export * from "./shared.ts";\n`);
		write(
			entry,
			`import { test } from "maligator:test";
import * as shared from "./barrel.ts";
test("namespace", () => shared.answer);
`,
		);

		const compiled = compileLinkedTestImage({
			files: [entry],
			config: resolveBuildConfig({}),
			stripTypes: stripCompactTypes,
			stripperIdentity: "test-image-stripper",
			testModuleSource,
			cacheDirectory: path.join(root, "cache"),
		});
		expect(compiled.wires.map((wire) => wire.kind)).toEqual([
			"runtime",
			"application",
			"application",
			"entry",
			"runner",
		]);
	});

	test("routes a test file imported by another to the whole-image fallback", () => {
		const root = temporaryDirectory();
		const helper = path.join(root, "helper.test.ts");
		const entry = path.join(root, "importer.test.ts");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(helper, `export const answer = 42;\n`);
		write(
			entry,
			`import { test } from "maligator:test";
import { answer } from "./helper.test.ts";
test("imports a test file", () => answer);
`,
		);

		expect(() =>
			compileLinkedTestImage({
				files: [entry, helper],
				config: resolveBuildConfig({}),
				stripTypes: stripCompactTypes,
				stripperIdentity: "test-image-stripper",
				testModuleSource,
				cacheDirectory: path.join(root, "cache"),
			}),
		).toThrow(UnsupportedLinkedImagesError);
	});

	test("rejects an import the application image does not export", () => {
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
			compileLinkedTestImage({
				files: [entry],
				config: resolveBuildConfig({}),
				stripTypes: stripCompactTypes,
				stripperIdentity: "test-image-stripper",
				testModuleSource,
				cacheDirectory: path.join(root, "cache"),
			}),
		).toThrow(/does not export 'answer'/);
	});
});

describe("linked test images across test options", () => {
	function project(entrySource: string) {
		const root = temporaryDirectory();
		const entry = path.join(root, "options.test.ts");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(path.join(root, "shared.ts"), `export const answer: number = 42;\n`);
		write(entry, entrySource);
		return (filter: string) =>
			compileLinkedTestImage({
				files: [entry],
				config: resolveBuildConfig({}),
				execution: testExecution(entry, filter),
				stripTypes: stripCompactTypes,
				stripperIdentity: "test-options-stripper",
				testModuleSource,
				cacheDirectory: path.join(root, "cache"),
			});
	}

	test("reuses every image when only a runtime test option changes", () => {
		const compile = project(testSource("options"));
		expect(compile("first").cache).toBe("miss");
		const filtered = compile("second");
		expect(filtered.cache).toBe("hit");
		expect(filtered.artifactMisses).toBe(0);
	});

	test("recompiles a test file that reads the execution snapshot", () => {
		const compile = project(`import { expect, test } from "maligator:test";
import { execution } from "maligator:process";
import { answer } from "./shared.ts";
test("reads its filter", () => expect([answer, execution.command]).toEqual([42, "test"]));
`);
		expect(compile("first").cache).toBe("miss");
		const filtered = compile("second");
		expect(filtered.cache).toBe("miss");
		expect(filtered.artifactMisses).toBe(1);
		expect(filtered.artifactHits).toBe(filtered.wires.length - 1);
	});
});

test("compiles a cold test runtime beside a cold dependency island", () => {
	const root = temporaryDirectory();
	const packageDirectory = path.join(root, "node_modules/example-package");
	const entry = path.join(root, "package.test.mts");
	write(path.join(root, "package.json"), `{"type":"module"}\n`);
	write(
		path.join(packageDirectory, "package.json"),
		`{"type":"module","exports":"./index.mjs"}\n`,
	);
	write(path.join(packageDirectory, "index.mjs"), `export const answer = 42;\n`);
	write(
		entry,
		`import { test } from "maligator:test";\nimport { answer } from "example-package";\ntest("answer", () => answer);\n`,
	);

	const compiled = compileLinkedTestImage({
		files: [entry],
		config: resolveBuildConfig({}),
		stripTypes: stripCompactTypes,
		stripperIdentity: "parallel-runtime-stripper",
		testModuleSource,
		cacheDirectory: path.join(root, "cache"),
		dependencyWorker: { tool: process.execPath, args: [path.resolve("src/index.ts")] },
	});
	expect(compiled.wires.map((wire) => wire.kind)).toEqual([
		"runtime",
		"dependency",
		"entry",
		"runner",
	]);
	expect(compiled.phases.workerMs).toBeGreaterThan(0);
	expect(compiled.artifactMisses).toBe(4);
}, 60_000);
