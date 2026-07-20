import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	classifyWptResults,
	createWptExecutionEnvironment,
	createWptProgram,
	loadPinnedWptTest,
	parseWptExpectations,
	parseWptManifest,
	parseWptMetadata,
	parseWptOutput,
	resolveWptScriptPath,
	selectWptExecutionDimensions,
	selectWptManifestEntries,
	WPT_REVISION,
} from "./wpt/harness.ts";
import type {
	WptExecutionKey,
	WptManifestEntry,
	WptPinnedTest,
	WptSubtestResult,
} from "./wpt/harness.ts";

const defaultExecution: WptExecutionKey = {
	path: "url/a.any.js",
	variant: "",
	backend: "compiled",
	mode: "normal",
};

function hash(source: string | Buffer): string {
	return createHash("sha256").update(source).digest("hex");
}

function testEntry(
	source: string,
	overrides: Partial<WptManifestEntry> = {},
): WptManifestEntry {
	return {
		path: "url/a.any.js",
		sha256: hash(source),
		target: "server-main",
		modes: ["normal", "gc-stress"],
		metadata: parseWptMetadata(source).declarations,
		includes: [],
		...overrides,
	};
}

function pinnedTest(
	source: string,
	includes: WptPinnedTest["includes"] = [],
): WptPinnedTest {
	return { source, metadata: parseWptMetadata(source), includes };
}

function runProgram(
	source: string,
	options: {
		entry?: WptManifestEntry;
		includes?: WptPinnedTest["includes"];
		variant?: string;
		timeout?: number;
	} = {},
) {
	const entry = options.entry ?? testEntry(source);
	const variant = options.variant ?? parseWptMetadata(source).variants[0] ?? "";
	const execution = { ...defaultExecution, path: entry.path, variant };
	const program = createWptProgram(
		entry,
		pinnedTest(source, options.includes),
		variant,
		options.timeout,
	);
	const stdout = execFileSync("node", ["--input-type=commonjs", "--eval", program], {
		encoding: "utf8",
		timeout: 2_000,
	});
	return { program, ...parseWptOutput(stdout, execution) };
}

function result(overrides: Partial<WptSubtestResult> = {}): WptSubtestResult {
	return {
		...defaultExecution,
		id: 1,
		subtest: "known defect",
		occurrence: 1,
		status: "FAIL",
		message: "still broken",
		...overrides,
	};
}

describe("curated WPT harness", () => {
	it("requires schema 2 and an explicit server-main target and modes", () => {
		const source = "test(function() {}, 'ok');";
		const entry = testEntry(source);
		const manifest = parseWptManifest(
			JSON.stringify({
				schemaVersion: 2,
				repository: "https://example.test/wpt.git",
				revision: WPT_REVISION,
				tests: [entry],
			}),
		);
		expect(manifest.tests[0]).toMatchObject({
			path: "url/a.any.js",
			target: "server-main",
			modes: ["normal", "gc-stress"],
		});
		expect(() =>
			parseWptManifest(JSON.stringify({ ...manifest, schemaVersion: 1 })),
		).toThrow("schema 2");
		expect(() =>
			parseWptManifest(
				JSON.stringify({ ...manifest, tests: [{ ...entry, target: "window" }] }),
			),
		).toThrow("target must be server-main");
		expect(() =>
			parseWptManifest(
				JSON.stringify({ ...manifest, tests: [{ ...entry, path: "url/*.js" }] }),
			),
		).toThrow("exact repository-relative path");
		expect(() =>
			parseWptManifest(
				JSON.stringify({
					...manifest,
					tests: [{ ...entry, modes: ["gc-stress", "normal"] }],
				}),
			),
		).toThrow("unique and ordered");
	});

	it("parses only the initial contiguous META block and preserves declaration order", () => {
		const metadata = parseWptMetadata(
			[
				"// META: title=Initial title",
				"// META: global=window,worker",
				"// META: variant=?first#hash",
				"// META: script=../support/first.js",
				"// META: variant=#second",
				"// META: script=/common/second.js",
				"",
				"// META: title=Too late",
			].join("\n"),
		);
		expect(metadata.title).toBe("Initial title");
		expect(metadata.globals).toEqual(["window", "worker"]);
		expect(metadata.variants).toEqual(["?first#hash", "#second"]);
		expect(metadata.scripts).toEqual(["../support/first.js", "/common/second.js"]);
		expect(metadata.declarations.map((item) => item.name)).toEqual([
			"title",
			"global",
			"variant",
			"script",
			"variant",
			"script",
		]);
		expect(parseWptMetadata("\n// META: title=Not initial").declarations).toEqual([]);
		expect(parseWptMetadata("test(() => {});\n// META: variant=?late").variants).toEqual([
			"",
		]);
	});

	it("validates variants and repeated metadata contracts", () => {
		expect(() => parseWptMetadata("// META: variant=plain")).toThrow("query/fragment");
		expect(() => parseWptMetadata("// META: variant=?a b")).toThrow("query/fragment");
		expect(() =>
			parseWptMetadata("// META: variant=?same\n// META: variant=?same"),
		).toThrow("duplicate variant");
		expect(() => parseWptMetadata("// META: title=one\n// META: title=two")).toThrow(
			"repeated title",
		);
		expect(() => parseWptMetadata("// META: timeout=long")).toThrow(
			"unsupported WPT metadata",
		);
	});

	it("resolves root-relative and relative scripts without permitting escapes", () => {
		expect(resolveWptScriptPath("test.any.js", "helper.js")).toBe("helper.js");
		expect(resolveWptScriptPath("a/b/test.any.js", "helper.js")).toBe("a/b/helper.js");
		expect(() =>
			resolveWptScriptPath("a/b/test.any.js", "../support/helper.js?x=1"),
		).toThrow("unsafe");
		expect(resolveWptScriptPath("a/b/test.any.js", "/common/helper.js")).toBe(
			"common/helper.js",
		);
		expect(() => resolveWptScriptPath("a/test.any.js", "../../outside.js")).toThrow(
			"escapes the root",
		);
		expect(() =>
			resolveWptScriptPath("a/test.any.js", "https://example.test/a.js"),
		).toThrow("unsafe");
		expect(() => resolveWptScriptPath("a/test.any.js", "//example.test/a.js")).toThrow(
			"unsafe",
		);
		expect(() => resolveWptScriptPath("a/test.any.js", "?query-only")).toThrow("unsafe");
		expect(() => resolveWptScriptPath("a/test.any.js", "helper.js#fragment")).toThrow(
			"unsafe",
		);
		expect(() => resolveWptScriptPath("a/test.any.js", "helper.sub.js")).toThrow(
			"dynamic",
		);
		expect(() => resolveWptScriptPath("a/test.any.js", "generate.py")).toThrow("dynamic");
		expect(() => resolveWptScriptPath("a/test.any.js", "raw.asis")).toThrow("dynamic");
		expect(() => resolveWptScriptPath("a/test.any.js", "%2e%2e/%2e%2e/a.js")).toThrow(
			"escapes the root",
		);
	});

	it("byte-pins source and support scripts and verifies exact metadata", () => {
		const root = mkdtempSync(path.join(tmpdir(), "maligator-wpt-"));
		const source = [
			"// META: script=helper.js",
			"// META: script=/common/root.js",
			"test(function() {}, 'loaded');",
		].join("\n");
		const helper = "globalThis.loaded = ['helper'];";
		const common = "globalThis.loaded.push('root');";
		try {
			mkdirSync(path.join(root, "url"));
			mkdirSync(path.join(root, "common"));
			writeFileSync(path.join(root, "url/a.any.js"), source);
			writeFileSync(path.join(root, "url/helper.js"), helper);
			writeFileSync(path.join(root, "common/root.js"), common);
			const entry = testEntry(source, {
				includes: [
					{ path: "url/helper.js", sha256: hash(helper) },
					{ path: "common/root.js", sha256: hash(common) },
				],
			});
			const loaded = loadPinnedWptTest(root, entry);
			expect(loaded.includes.map((item) => item.path)).toEqual([
				"url/helper.js",
				"common/root.js",
			]);
			expect(() =>
				loadPinnedWptTest(root, {
					...entry,
					metadata: [{ name: "script", value: "/common/root.js" }],
				}),
			).toThrow("metadata differs");
			expect(() =>
				loadPinnedWptTest(root, {
					...entry,
					includes: [
						{ ...entry.includes[0]!, sha256: "0".repeat(64) },
						entry.includes[1]!,
					],
				}),
			).toThrow("SHA-256");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("loads every curated fixture against its schema-2 metadata pins", () => {
		const manifest = parseWptManifest(
			readFileSync(path.join(import.meta.dirname, "wpt/curated.json"), "utf8"),
		);
		const fixtureRoot = path.join(import.meta.dirname, "wpt/fixtures/wpt");
		for (const entry of manifest.tests) {
			expect(loadPinnedWptTest(fixtureRoot, entry).source.length).toBeGreaterThan(0);
		}
	});

	it("generates adapter, includes, and test source in declaration order", () => {
		const source = [
			"// META: script=first.js",
			"// META: script=second.js",
			"test(function() { assert_array_equals(order, ['first', 'second']); }, 'order');",
		].join("\n");
		const entry = testEntry(source, {
			includes: [
				{ path: "url/first.js", sha256: "a".repeat(64) },
				{ path: "url/second.js", sha256: "b".repeat(64) },
			],
		});
		const includes = [
			{ path: "url/first.js", source: "var order = ['first'];" },
			{ path: "url/second.js", source: "order.push('second');" },
		];
		const parsed = runProgram(source, { entry, includes });
		expect(parsed.subtests[0]?.status).toBe("PASS");
		expect(parsed.program.indexOf("var __wpt_path")).toBeLessThan(
			parsed.program.indexOf("var order = ['first']"),
		);
		expect(parsed.program.indexOf("var order = ['first']")).toBeLessThan(
			parsed.program.indexOf("order.push('second')"),
		);
		expect(parsed.program.indexOf("order.push('second')")).toBeLessThan(
			parsed.program.indexOf("test(function() { assert_array_equals(order"),
		);
	});

	it("expands declared variants with deterministic location and self globals", () => {
		const source = [
			"// META: variant=?query=yes#fragment",
			"// META: variant=#only-hash",
			"test(function() {",
			"  assert_equals(self, globalThis);",
			"  assert_equals(location.pathname, '/url/a.any.js');",
			"  assert_equals(location.search, __expectedSearch);",
			"  assert_equals(location.hash, __expectedHash);",
			"}, 'location');",
		].join("\n");
		const entry = testEntry(source);
		for (const [variant, search, fragment] of [
			["?query=yes#fragment", "?query=yes", "#fragment"],
			["#only-hash", "", "#only-hash"],
		] as const) {
			const include = {
				path: "synthetic.js",
				source: `var __expectedSearch = ${JSON.stringify(search)}; var __expectedHash = ${JSON.stringify(fragment)};`,
			};
			expect(
				runProgram(source, { entry, includes: [include], variant }).subtests[0]?.status,
			).toBe("PASS");
		}
		expect(parseWptMetadata("test(function() {}, 'default');").variants).toEqual([""]);
		expect(parseWptMetadata("test(function() {}, 'default');").globals).toEqual([
			"window",
			"dedicatedworker",
		]);
	});

	it("uses numeric IDs, pinned unnamed suffixes, and explicit-name occurrences", () => {
		const source = [
			"// META: title=Fallback title",
			"test(function() {});",
			"test(function() {});",
			"test(function() {}, 'duplicate');",
			"test(function() {}, 'duplicate');",
		].join("\n");
		const parsed = runProgram(source);
		expect(
			parsed.subtests.map(({ id, subtest, occurrence }) => [id, subtest, occurrence]),
		).toEqual([
			[1, "Fallback title", 1],
			[2, "Fallback title 1", 1],
			[3, "duplicate", 1],
			[4, "duplicate", 2],
		]);
		expect(parsed.harness).toMatchObject({
			status: "ERROR",
			total: 4,
			message: '1 duplicate test name: "duplicate"',
		});
	});

	it("preserves an existing harness error when test names are duplicated", () => {
		const source = [
			"setup(function() { throw new Error('setup failed'); });",
			"test(function() {}, 'duplicate');",
			"test(function() {}, 'duplicate');",
		].join("\n");
		expect(runProgram(source).harness).toMatchObject({
			status: "ERROR",
			message: "setup failed",
		});
	});

	it("matches START and RESULT by numeric ID and attributes crashes to that ID", () => {
		const duplicateOutput = [
			'WPT_START {"path":"url/a.any.js","id":8,"subtest":"same","occurrence":1}',
			'WPT_RESULT {"path":"url/a.any.js","id":8,"subtest":"same","occurrence":1,"status":"PASS","message":null}',
			'WPT_START {"path":"url/a.any.js","id":9,"subtest":"same","occurrence":2}',
			'WPT_RESULT {"path":"url/a.any.js","id":9,"subtest":"same","occurrence":2,"status":"FAIL","message":"bad"}',
			'WPT_HARNESS {"path":"url/a.any.js","status":"ERROR","total":2,"message":"1 duplicate test name: \\"same\\""}',
		].join("\n");
		expect(parseWptOutput(duplicateOutput, defaultExecution).subtests).toHaveLength(2);
		expect(() =>
			parseWptOutput(
				duplicateOutput.replace('"id":9,"subtest":"same"', '"id":8,"subtest":"same"'),
				defaultExecution,
			),
		).toThrow("duplicate WPT subtest start");

		const crash = parseWptOutput(
			'WPT_START {"path":"url/a.any.js","id":42,"subtest":"pending","occurrence":1}',
			defaultExecution,
			"CRASH",
		);
		expect(crash.subtests[0]).toMatchObject({
			id: 42,
			subtest: "pending",
			status: "CRASH",
		});
		expect(crash.harness).toMatchObject({
			status: "ERROR",
			message: "process crash during subtest id 42",
		});
		const outside = parseWptOutput("diagnostic output", defaultExecution, "CRASH");
		expect(outside.subtests).toEqual([]);
		expect(outside.harness.message).toContain("outside an active");
	});

	it("returns setup exceptions as harness ERROR diagnostics", () => {
		const parsed = runProgram(
			"setup(function() { throw new Error('setup failed'); });\ntest(function() {}, 'still ran');",
		);
		expect(parsed.subtests[0]?.status).toBe("PASS");
		expect(parsed.harness).toEqual({
			path: "url/a.any.js",
			status: "ERROR",
			total: 1,
			message: "setup failed",
		});
	});

	it("retains synchronous step_func failures when the caller swallows the throw", () => {
		const parsed = runProgram(String.raw`
test(function(t) {
  var listener = t.step_func(function() { assert_true(false, "listener failed"); });
  try { listener(); } catch (error) {}
}, "swallowed listener failure");`);
		expect(parsed.subtests[0]).toMatchObject({
			subtest: "swallowed listener failure",
			status: "FAIL",
			message: "listener failed",
		});
		expect(parsed.harness.status).toBe("OK");
	});

	it("passes promise_test context and supports promise_rejects_exactly", () => {
		const source = String.raw`
var reason = {};
promise_test(function(t) {
  assert_true(typeof t.step_func === "function");
  return promise_rejects_exactly(t, reason, Promise.reject(reason), "exact reason");
}, "exact rejection");
promise_test(function(t) {
  return promise_rejects_exactly(t, reason, Promise.reject({}), "wrong reason");
}, "wrong rejection");`;
		const parsed = runProgram(source);
		expect(parsed.subtests.map(({ subtest, status }) => [subtest, status])).toEqual([
			["exact rejection", "PASS"],
			["wrong rejection", "FAIL"],
		]);
	});

	it("starts async_test callbacks immediately without serializing them", () => {
		const source = String.raw`
var order = [];
async_test(function(t) {
  order.push("async");
  t.step_timeout(t.step_func_done(function() {}), 5);
}, "async context");
test(function() {
  assert_array_equals(order, ["async"]);
}, "sync observes async setup");`;
		const parsed = runProgram(source, { timeout: 50 });
		expect(parsed.subtests).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ subtest: "async context", status: "PASS" }),
				expect.objectContaining({ subtest: "sync observes async setup", status: "PASS" }),
			]),
		);
	});

	it("rejects invalid sync, async, and promise test return contracts", () => {
		const source = String.raw`
test(function() { return 1; }, "sync return");
async_test(function(t) { t.done(); return 2; }, "async return");
promise_test(function() {}, "missing promise");
promise_test(function() { return {}; }, "non-thenable");`;
		const parsed = runProgram(source);
		expect(parsed.subtests.map(({ subtest, status }) => [subtest, status])).toEqual([
			["sync return", "PASS"],
			["async return", "PASS"],
			["missing promise", "FAIL"],
			["non-thenable", "FAIL"],
		]);
		expect(parsed.harness).toMatchObject({
			status: "ERROR",
			message:
				'Test named "sync return" passed a function to `test` that returned a value.',
		});
	});

	it("keeps existing sync, async, promise, and assertion APIs green", () => {
		const source = String.raw`
test(function(t) {
  assert_not_equals({}, {});
  assert_throws_js(TypeError, function() { throw new TypeError("bad"); });
  var reason = {};
  assert_throws_exactly(reason, function() { throw reason; });
  t.step_func(function() { assert_true(true); })();
}, "sync context");
async_test(function(t) {
  t.step_timeout(t.step_func_done(function() { assert_false(false); }), 5);
}, "async context");
promise_test(function(t) {
  return Promise.resolve().then(t.step_func(function() { assert_array_equals([1], [1]); }));
}, "promise context");`;
		const parsed = runProgram(source, { timeout: 50 });
		expect(parsed.subtests.map((item) => item.status)).toEqual(["PASS", "PASS", "PASS"]);
	});

	it("selects exact paths and repeatable mode/backend dimensions deterministically", () => {
		const source = "test(function() {}, 'ok');";
		const first = testEntry(source);
		const second = testEntry(source, {
			path: "url/b.any.js",
			modes: ["normal"],
		});
		const entries = [first, second];
		expect(selectWptManifestEntries(entries, [])).toBe(entries);
		expect(selectWptManifestEntries(entries, [second.path, first.path])).toEqual(entries);
		expect(() => selectWptManifestEntries(entries, ["url/missing.any.js"])).toThrow(
			"not in the curated manifest",
		);
		expect(selectWptExecutionDimensions(first, [], [])).toEqual([
			{ mode: "normal", backend: "compiled" },
			{ mode: "gc-stress", backend: "compiled" },
		]);
		expect(
			selectWptExecutionDimensions(
				first,
				["gc-stress", "normal"],
				["interpreted", "compiled"],
			),
		).toEqual([
			{ mode: "normal", backend: "compiled" },
			{ mode: "normal", backend: "interpreted" },
			{ mode: "gc-stress", backend: "compiled" },
			{ mode: "gc-stress", backend: "interpreted" },
		]);
		expect(() => selectWptExecutionDimensions(second, ["gc-stress"], [])).toThrow(
			"does not support mode gc-stress",
		);
		expect(() => selectWptExecutionDimensions(first, [], ["jit"])).toThrow(
			"compiled or interpreted",
		);
	});

	it("builds isolated normal and GC-stress child environments", () => {
		const inherited = {
			PATH: "/bin",
			MAL_GC_STRESS: "inherited",
			MAL_GC_VERIFY: "inherited",
		};
		expect(createWptExecutionEnvironment(inherited, "normal")).toEqual({ PATH: "/bin" });
		expect(createWptExecutionEnvironment(inherited, "gc-stress")).toEqual({
			PATH: "/bin",
			MAL_GC_STRESS: "1",
			MAL_GC_VERIFY: "1",
		});
	});

	it("isolates expectations by every final execution key", () => {
		const base = {
			path: "url/a.any.js",
			variant: "",
			backend: "compiled" as const,
			mode: "normal" as const,
			subtest: "known defect",
			occurrence: 1,
			status: "FAIL" as const,
			milestone: "W2",
			reason: "known defect",
			revision: WPT_REVISION,
		};
		const expectations = parseWptExpectations(
			JSON.stringify({
				schemaVersion: 2,
				revision: WPT_REVISION,
				expectations: [
					base,
					{ ...base, mode: "gc-stress" },
					{ ...base, backend: "interpreted" },
					{ ...base, variant: "?other" },
					{ ...base, occurrence: 2 },
					{ ...base, subtest: "other" },
				],
			}),
		);
		const classified = classifyWptResults([result()], expectations);
		expect(classified.results[0]?.verdict).toBe("EXPECTED");
		expect(classified.missing).toHaveLength(5);
		expect(
			classifyWptResults([result({ status: "PASS" })], [expectations[0]!]).results[0]
				?.verdict,
		).toBe("UNEXPECTED");
		expect(
			classifyWptResults([result({ occurrence: 2 })], [expectations[0]!]).results[0]
				?.verdict,
		).toBe("UNEXPECTED");
		expect(() =>
			parseWptExpectations(
				JSON.stringify({ schemaVersion: 1, revision: WPT_REVISION, expectations: [] }),
			),
		).toThrow("schema 2");
	});
});
