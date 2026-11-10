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
import type { Test262CorpusComposition } from "../src/test262/corpus-compositions.ts";
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
	git(repository, "init", "--quiet", "--object-format=sha1");
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

function compositionFixture() {
	const options = fixture();
	const generated = path.join(options.directory, "generated");
	const put = (repository: string, file: string, content: string) => {
		mkdirSync(path.dirname(path.join(repository, file)), { recursive: true });
		writeFileSync(path.join(repository, file), content);
	};
	const commit = (repository: string) => {
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
			"inputs",
		);
		return git(repository, "rev-parse", "HEAD");
	};
	const targets = ["property-escapes", "unicodeSets"];
	for (const target of targets) {
		put(options.repository, `test/${target}/generated/current.js`, "old();\n");
		put(
			options.repository,
			`test/${target}/generated/strings/historical.js`,
			"historical();\n",
		);
		put(options.repository, `test/${target}/handwritten.js`, "handwritten();\n");
		put(
			generated,
			`output/${target}/generated/current.js`,
			"/*---\nincludes: [assert.js]\n---*/\nupdated();\n",
		);
		put(generated, `output/${target}/generated/strings/added.js`, "added();\n");
		put(generated, `output/${target}/handwritten.js`, "unrelated();\n");
	}
	put(generated, "harness/assert.js", "unrelated harness\n");
	options.revision = commit(options.repository);
	const original = test262PrepareCheckout(options);
	git(generated, "init", "--quiet", "--object-format=sha1");
	const generatedRevision = commit(generated);
	git(options.repository, "fetch", generated, generatedRevision);
	const overlays = targets.map((target) => ({
		source: `output/${target}/generated`,
		target: `test/${target}/generated`,
		tree: git(generated, "rev-parse", `HEAD:output/${target}/generated`),
	}));
	for (const overlay of overlays)
		cpSync(
			path.join(generated, overlay.source),
			path.join(options.repository, overlay.target),
			{ recursive: true },
		);
	git(options.repository, "add", ".");
	const tree = git(options.repository, "write-tree");
	const epoch = 1700000000;
	const message = "test: composed inputs";
	const revision = execFileSync(
		"git",
		["commit-tree", tree, "-p", options.revision, "-p", generatedRevision],
		{
			cwd: options.repository,
			encoding: "utf8",
			input: `${message}\n`,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "Corpus preparation",
				GIT_AUTHOR_EMAIL: "corpus@example.invalid",
				GIT_COMMITTER_NAME: "Corpus preparation",
				GIT_COMMITTER_EMAIL: "corpus@example.invalid",
				GIT_AUTHOR_DATE: `@${epoch} +0000`,
				GIT_COMMITTER_DATE: `@${epoch} +0000`,
			},
		},
	).trim();
	const composition: Test262CorpusComposition = {
		revision,
		tree,
		base: { repository: options.repository, revision: options.revision },
		generated: { repository: generated, revision: generatedRevision },
		overlays,
		epoch,
		message,
	};
	return {
		options,
		original,
		composedOptions: { cacheDirectory: options.cacheDirectory, revision, composition },
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
	it("prepares reproducible composed inputs without changing historical tests or existing snapshots", () => {
		const { options, original, composedOptions } = compositionFixture();
		const corpus = test262PrepareCheckout(composedOptions);
		const index = test262LoadInputIndex(corpus, options.cacheDirectory);
		const loaded = test262LoadInputs(corpus.path, index.files);
		for (const target of ["property-escapes", "unicodeSets"]) {
			expect(
				loaded.find((file) => file.path === `test/${target}/generated/current.js`)!
					.content,
			).toContain("updated();");
			expect(
				loaded.find((file) => file.path === `test/${target}/generated/strings/added.js`)!
					.content,
			).toBe("added();\n");
			expect(
				loaded.find(
					(file) => file.path === `test/${target}/generated/strings/historical.js`,
				)!.content,
			).toBe("historical();\n");
			expect(
				loaded.find((file) => file.path === `test/${target}/handwritten.js`)!.content,
			).toBe("handwritten();\n");
			expect(
				readFileSync(
					path.join(original.path, `test/${target}/generated/current.js`),
					"utf8",
				),
			).toBe("old();\n");
		}
		expect(readFileSync(path.join(corpus.path, "harness/assert.js"), "utf8")).toBe(
			readFileSync(path.join(original.path, "harness/assert.js"), "utf8"),
		);
		expect(test262Checkout(options).tree).toBe(original.tree);
		expect(git(corpus.path, "status", "--porcelain=v1", "--ignored")).toBe("");
		expect(corpus.path).not.toBe(original.path);
		const missing = path.join(options.directory, "unavailable");
		expect(
			test262PrepareCheckout({
				...composedOptions,
				composition: {
					...composedOptions.composition,
					base: { ...composedOptions.composition.base, repository: missing },
					generated: { ...composedOptions.composition.generated, repository: missing },
				},
			}),
		).toEqual(corpus);
	});

	it.each(["source tree", "tree", "commit"] as const)(
		"rejects a composition with the wrong pinned %s before publication",
		(pin) => {
			const { options, composedOptions } = compositionFixture();
			const composition = structuredClone(composedOptions.composition);
			if (pin === "source tree") composition.overlays[0]!.tree = "0".repeat(40);
			else if (pin === "tree") composition.tree = "0".repeat(40);
			else composition.revision = "0".repeat(40);
			expect(() =>
				test262PrepareCheckout({
					...composedOptions,
					revision: composition.revision,
					composition,
				}),
			).toThrow(/differs/);
			expect(readdirSync(path.join(options.cacheDirectory, "test262-corpora"))).toEqual([
				options.revision,
			]);
		},
	);

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
			pruneMaligatorCache({
				cacheRoot: options.cacheDirectory,
				maxBytes: 0,
				minAgeMs: 0,
			});
			expect(test262Checkout(options).files).toEqual(corpus.files);
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
