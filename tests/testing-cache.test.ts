import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { stripCompactTypes } from "../src/compact-type-strip.ts";
import { deserializeVmDefinition } from "../src/serialize-vm.ts";
import {
	compileIsolatedTestImage,
	compileTestFile,
	compileTestImage,
	TestCompilationSession,
} from "../src/testing/cache.ts";
import { discoverTestFiles } from "../src/testing/discovery.ts";

const temporaryDirectories: Array<string> = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "maligator-testing-"));
	temporaryDirectories.push(directory);
	return directory;
}

function write(file: string, contents: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, contents);
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("test discovery", () => {
	test("discovers conventions stably and accepts explicit nonconventional files", () => {
		const root = temporaryDirectory();
		write(path.join(root, "z.spec.mts"), "");
		write(path.join(root, "src/a.test.ts"), "");
		write(path.join(root, "src/helper.ts"), "");
		write(path.join(root, "node_modules/ignored.test.js"), "");
		write(path.join(root, ".cache/ignored.test.js"), "");
		const realRoot = realpathSync(root);

		expect(discoverTestFiles([root])).toEqual([
			path.join(realRoot, "src/a.test.ts"),
			path.join(realRoot, "z.spec.mts"),
		]);
		expect(discoverTestFiles([path.join(root, "src/helper.ts")])).toEqual([
			path.join(realRoot, "src/helper.ts"),
		]);
	});
});

describe("test frontend artifact cache", () => {
	test("bakes options and a machine-readable result into isolated test images", () => {
		const root = temporaryDirectory();
		const entry = path.join(root, "isolated.test.mjs");
		write(
			entry,
			`import { expect, test } from "maligator:test"; test("ok", () => expect(1).toBe(1));\n`,
		);
		const prefix = "__ISOLATED_RESULT__";
		const compiled = compileIsolatedTestImage(
			{
				files: [entry],
				config: resolveBuildConfig({}),
				stripTypes: stripCompactTypes,
				stripperIdentity: "isolated-test-type-strip",
				testModuleSource: readFileSync(path.resolve("src/testing/runtime.mjs"), "utf-8"),
			},
			{ repeat: 1, bail: false, timeoutMs: 1000 },
			prefix,
		);
		const definition = deserializeVmDefinition(compiled.wire);
		const strings = definition.stringConstants.map((units) =>
			String.fromCharCode(...units),
		);

		expect(compiled.entries).toEqual([entry]);
		expect(compiled.dependencies).toEqual([entry]);
		expect(strings).toContain(prefix);
	});

	test("reuses unchanged wire and invalidates a changed transitive dependency", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const dependency = path.join(root, "store.ts");
		const entry = path.join(root, "store.test.ts");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(dependency, `export function answer(): number { return 42; }\n`);
		write(
			entry,
			`import { expect, test } from "maligator:test";
import { answer } from "./store.ts";
interface Model { value: number }
test("answer", () => {
	const model: Model = { value: answer() };
	expect(model.value).toBe(42);
});
`,
		);
		const testModuleSource = readFileSync(
			path.resolve("src/testing/runtime.mjs"),
			"utf-8",
		);
		const options = {
			file: entry,
			config: resolveBuildConfig({ engine: { regexp: false } }),
			stripTypes: stripCompactTypes,
			stripperIdentity: "test-type-strip",
			testModuleSource,
			cacheDirectory,
		};

		const cold = compileTestFile(options);
		const warm = compileTestFile(options);
		expect(cold.cache).toBe("miss");
		expect(warm.cache).toBe("hit");
		expect(warm.wire).toEqual(cold.wire);
		expect(warm.dependencies).toEqual([dependency, entry].sort());

		const originalTimes = statSync(dependency);
		write(dependency, `export function answer(): number { return 43; }\n`);
		utimesSync(dependency, originalTimes.atime, originalTimes.mtime);
		const changed = compileTestFile(options);
		expect(changed.cache).toBe("miss");
		expect(changed.wire).not.toEqual(cold.wire);
	});

	test("compiles several entries as one image and exposes watcher invalidation", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const dependency = path.join(root, "shared.ts");
		const first = path.join(root, "a.test.ts");
		const second = path.join(root, "b.test.ts");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(dependency, `export const answer: number = 42;\n`);
		for (const [file, name] of [
			[first, "a"],
			[second, "b"],
		] as const) {
			write(
				file,
				`import { expect, test } from "maligator:test";
import { answer } from "./shared.ts";
test(${JSON.stringify(name)}, () => expect(answer).toBe(42));
`,
			);
		}
		const session = new TestCompilationSession();
		const options = {
			files: [second, first],
			config: resolveBuildConfig({ engine: { regexp: false } }),
			stripTypes: stripCompactTypes,
			stripperIdentity: "test-type-strip",
			testModuleSource: readFileSync(path.resolve("src/testing/runtime.mjs"), "utf-8"),
			cacheDirectory,
			session,
		};

		const cold = compileTestImage(options);
		const coldParses = session.moduleParses.statistics();
		const warm = compileTestImage(options);
		expect(cold.cache).toBe("miss");
		expect(warm.cache).toBe("hit");
		expect(cold.entries).toEqual([first, second]);
		expect(cold.dependencies).toEqual([first, second, dependency].sort());
		const selected = compileTestImage({ ...options, files: [first] });
		expect(selected.cache).toBe("hit");
		expect(selected.entries).toEqual([first, second]);

		const originalTimes = statSync(dependency);
		write(dependency, `export const answer: number = 43;\n`);
		utimesSync(dependency, originalTimes.atime, originalTimes.mtime);
		session.invalidate(dependency);
		const changed = compileTestImage(options);
		expect(changed.cache).toBe("miss");
		expect(changed.wire).not.toEqual(cold.wire);
		const changedParses = session.moduleParses.statistics();
		expect(changedParses.hits).toBeGreaterThan(coldParses.hits);
		expect(changedParses.misses - coldParses.misses).toBe(1);
	});
});
