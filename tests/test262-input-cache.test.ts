import { execFile, execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	artifactActionKey,
	artifactOutput,
	publishArtifactAction,
	readArtifactAction,
} from "../src/artifact-store.ts";
import { createCacheLease, pruneMaligatorCache } from "../src/cache-management.ts";
import {
	test262InputProducer,
	test262LoadInputIndex,
	test262LoadInputs,
} from "../src/test262/cache.ts";
import { test262Checkout, test262PrepareCheckout } from "../src/test262/files.ts";

const root = path.resolve(import.meta.dirname, "..");
const directories: Array<string> = [];
const execute = promisify(execFile);

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function git(directory: string, ...args: Array<string>): string {
	return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
		cwd: directory,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function fixture() {
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-test262-input-"));
	directories.push(directory);
	const repository = path.join(directory, "repository");
	mkdirSync(path.join(repository, "test"), { recursive: true });
	mkdirSync(path.join(repository, "harness"));
	writeFileSync(
		path.join(repository, "test", "raw.js"),
		'#!"use strict"\r\n/*---\nflags: [raw]\n---*/\nwith ({}) {}',
	);
	writeFileSync(
		path.join(repository, "test", "module.js"),
		'/*---\nflags: [module]\nincludes: [assert.js]\n---*/\nimport "./dependency_FIXTURE.js";',
	);
	writeFileSync(
		path.join(repository, "test", "dependency_FIXTURE.js"),
		"export const value = 1;\n",
	);
	writeFileSync(
		path.join(repository, "harness", "assert.js"),
		"function assert(value) { if (!value) throw Error(); }\n",
	);
	git(repository, "init", "--quiet");
	git(repository, "add", ".");
	git(
		repository,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@localhost",
		"commit",
		"--quiet",
		"-m",
		"corpus",
	);
	return {
		directory,
		repository,
		cacheDirectory: path.join(directory, "cache"),
		revision: git(repository, "rev-parse", "HEAD"),
	};
}

function sourceCheckout(directory: string): string {
	mkdirSync(path.join(directory, "src/test262"), { recursive: true });
	for (const file of ["cache.ts", "frontmatter.ts", "types.ts"]) {
		cpSync(
			path.join(root, "src/test262", file),
			path.join(directory, "src/test262", file),
		);
	}
	cpSync(
		path.join(root, "node_modules/yaml"),
		path.join(directory, "node_modules/yaml"),
		{ recursive: true },
	);
	return directory;
}

describe("shared Test262 inputs", () => {
	it("reuses the same pinned corpus and metadata across source checkouts with fresh results", () => {
		const options = fixture();
		const firstSource = sourceCheckout(path.join(options.directory, "first"));
		const secondSource = sourceCheckout(path.join(options.directory, "second"));
		writeFileSync(path.join(secondSource, "README.md"), "an unrelated revision\n");
		const corpus = test262PrepareCheckout(options);
		const first = test262LoadInputIndex(
			corpus,
			options.cacheDirectory,
			test262InputProducer(firstSource),
		);
		expect(first.cache).toBe("miss");
		expect(corpus.files).toEqual(["test/module.js", "test/raw.js"]);
		expect(
			readFileSync(path.join(corpus.path, "test/dependency_FIXTURE.js"), "utf8"),
		).toContain("export const value");
		expect(readFileSync(path.join(corpus.path, "harness/assert.js"), "utf8")).toContain(
			"function assert",
		);
		const loaded = test262LoadInputs(corpus.path, first.files);
		loaded[0]!.result = "PASSED";
		const reusedCorpus = test262PrepareCheckout({
			...options,
			repository: path.join(options.directory, "missing-remote"),
		});
		const second = test262LoadInputIndex(
			reusedCorpus,
			options.cacheDirectory,
			test262InputProducer(secondSource),
		);
		expect(second.cache).toBe("hit");
		expect(reusedCorpus.path).toBe(corpus.path);
		expect(test262LoadInputs(corpus.path, second.files)).toEqual(
			loaded.map((file) => ({ ...file, result: "UNKNOWN" })),
		);
		expect(
			second.files.every((file) => !("result" in file) && !("content" in file)),
		).toBe(true);
		expect(readdirSync(path.join(options.cacheDirectory, "work/test262-index"))).toEqual(
			[],
		);
	});

	it("invalidates after parser, YAML dependency, or corpus changes", () => {
		const options = fixture();
		const source = sourceCheckout(path.join(options.directory, "source"));
		const corpus = test262PrepareCheckout(options);
		const load = () =>
			test262LoadInputIndex(corpus, options.cacheDirectory, test262InputProducer(source));
		expect(load().cache).toBe("miss");
		expect(load().cache).toBe("hit");
		writeFileSync(
			path.join(source, "src/test262/frontmatter.ts"),
			"export const parserRevision = 2;\n",
		);
		expect(load().cache).toBe("miss");
		writeFileSync(
			path.join(source, "node_modules/yaml/dist/index.js"),
			"exports.parse = () => ({});\n",
		);
		expect(load().cache).toBe("miss");
		writeFileSync(
			path.join(options.repository, "test/raw.js"),
			"/*---\nflags: [noStrict]\n---*/\n1 + 2;\n",
		);
		git(options.repository, "add", ".");
		git(
			options.repository,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@localhost",
			"commit",
			"--quiet",
			"-m",
			"new corpus",
		);
		const newer = test262PrepareCheckout({
			...options,
			revision: git(options.repository, "rev-parse", "HEAD"),
		});
		const next = test262LoadInputIndex(
			newer,
			options.cacheDirectory,
			test262InputProducer(source),
		);
		expect(next.cache).toBe("miss");
		expect(
			next.files.find((file) => file.path === "test/raw.js")!.frontmatter.flags,
		).toEqual(["noStrict"]);
		expect(newer.path).not.toBe(corpus.path);
		expect(test262Checkout(options).tree).toBe(corpus.tree);
	});

	it("rejects changed, missing, and untracked corpus inputs instead of accepting stale metadata", () => {
		const options = fixture();
		const corpus = test262PrepareCheckout(options);
		const index = test262LoadInputIndex(corpus, options.cacheDirectory);
		const raw = path.join(corpus.path, "test/raw.js");
		const original = readFileSync(raw);
		writeFileSync(raw, "changed source\n");
		expect(() => test262Checkout(options)).toThrow("modified");
		expect(() => test262LoadInputs(corpus.path, index.files)).toThrow("input changed");
		writeFileSync(raw, original);
		writeFileSync(path.join(corpus.path, "test/extra.js"), "extra\n");
		expect(() => test262PrepareCheckout(options)).toThrow("modified");
		rmSync(path.join(corpus.path, "test/extra.js"));
		rmSync(raw);
		expect(() => test262Checkout(options)).toThrow("modified");
	});

	it("loads only the selected source records", () => {
		const options = fixture();
		const corpus = test262PrepareCheckout(options);
		const index = test262LoadInputIndex(corpus, options.cacheDirectory);
		rmSync(path.join(corpus.path, "test/raw.js"));
		const selected = test262LoadInputs(
			corpus.path,
			index.files.filter((file) => file.path === "test/module.js"),
		);
		expect(selected).toHaveLength(1);
		expect(selected[0]!.content).toContain('import "./dependency_FIXTURE.js"');
	});

	it("rebuilds corrupt payloads and rejects obsolete index formats", () => {
		const options = fixture();
		const corpus = test262PrepareCheckout(options);
		const producer = test262InputProducer();
		const first = test262LoadInputIndex(corpus, options.cacheDirectory, producer);
		const key = artifactActionKey(producer, {
			revision: corpus.revision,
			tree: corpus.tree,
		});
		const stored = readArtifactAction(
			options.cacheDirectory,
			"test262-input-index",
			producer,
			key,
		)!;
		const output = artifactOutput(stored, "index.json");
		writeFileSync(output.path, Buffer.alloc(output.size, 120));
		const rebuilt = test262LoadInputIndex(corpus, options.cacheDirectory, producer);
		expect(rebuilt.cache).toBe("miss");
		expect(rebuilt.files).toEqual(first.files);
		const obsolete = path.join(options.directory, "obsolete.json");
		writeFileSync(
			obsolete,
			JSON.stringify({
				schema: 0,
				revision: corpus.revision,
				tree: corpus.tree,
				files: [],
			}),
		);
		publishArtifactAction(options.cacheDirectory, "test262-input-index", producer, key, [
			{ name: "index.json", file: obsolete },
		]);
		expect(test262LoadInputIndex(corpus, options.cacheDirectory, producer).cache).toBe(
			"miss",
		);
	});

	it("publishes one complete corpus and index when preparations race", async () => {
		const options = fixture();
		const script = path.join(options.directory, "prepare.mjs");
		writeFileSync(
			script,
			`
import { test262PrepareCheckout } from ${JSON.stringify(new URL("../src/test262/files.ts", import.meta.url).href)};
import { test262LoadInputIndex } from ${JSON.stringify(new URL("../src/test262/cache.ts", import.meta.url).href)};
const options = JSON.parse(process.argv[2]);
const corpus = test262PrepareCheckout(options);
const index = test262LoadInputIndex(corpus, options.cacheDirectory);
console.log(JSON.stringify({ path: corpus.path, cache: index.cache, count: index.files.length }));
`,
		);
		const results = await Promise.all(
			Array.from({ length: 2 }, () =>
				execute(process.execPath, [script, JSON.stringify(options)], { timeout: 30_000 }),
			),
		);
		const loaded = results.map(
			({ stdout }) =>
				JSON.parse(stdout.trim().split("\n").at(-1)!) as {
					path: string;
					cache: string;
					count: number;
				},
		);
		expect(loaded.map((item) => item.cache).sort()).toEqual(["hit", "miss"]);
		expect(new Set(loaded.map((item) => item.path)).size).toBe(1);
		expect(loaded.map((item) => item.count)).toEqual([2, 2]);
		expect(readdirSync(path.join(options.cacheDirectory, "test262-corpora"))).toEqual([
			options.revision,
		]);
	});

	it("protects corpus readers from pruning and permits rebuilding an evicted snapshot", () => {
		const options = fixture();
		const corpus = test262PrepareCheckout(options);
		const lease = createCacheLease("test262", options.cacheDirectory);
		try {
			expect(() =>
				pruneMaligatorCache({ cacheRoot: options.cacheDirectory, maxBytes: 0 }),
			).toThrow("command is active");
		} finally {
			lease.release();
		}
		rmSync(corpus.path, { recursive: true });
		expect(() => test262Checkout(options)).toThrow("test262:prepare");
		expect(test262PrepareCheckout(options).files).toEqual(corpus.files);
		expect(
			existsSync(path.join(options.cacheDirectory, "test262-corpora", options.revision)),
		).toBe(true);
	});
});
