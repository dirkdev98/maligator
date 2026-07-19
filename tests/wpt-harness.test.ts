import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	classifyWptResults,
	createWptExecutionEnvironment,
	createWptProgram,
	loadPinnedWptSource,
	parseWptExpectations,
	parseWptManifest,
	parseWptOutput,
	WPT_REVISION,
} from "./wpt/harness.ts";

describe("curated WPT harness", () => {
	it("validates exact pinned manifest entries", () => {
		const manifest = parseWptManifest(
			JSON.stringify({
				schemaVersion: 1,
				repository: "https://example.test/wpt.git",
				revision: WPT_REVISION,
				tests: [{ path: "url/a.any.js", sha256: "a".repeat(64), gcStress: true }],
			}),
		);
		expect(manifest.tests[0]?.path).toBe("url/a.any.js");
		expect(() =>
			parseWptManifest(
				JSON.stringify({
					...manifest,
					tests: [{ ...manifest.tests[0], path: "url/*.js" }],
				}),
			),
		).toThrow("exact repository-relative path");
	});

	it("parses subtest records and rejects incomplete harness output", () => {
		const output = [
			'WPT_START {"path":"url/a.any.js","subtest":"one"}',
			'WPT_RESULT {"path":"url/a.any.js","subtest":"one","status":"PASS","message":null}',
			'WPT_START {"path":"url/a.any.js","subtest":"two"}',
			'WPT_RESULT {"path":"url/a.any.js","subtest":"two","status":"FAIL","message":"bad"}',
			'WPT_HARNESS {"path":"url/a.any.js","status":"OK","total":2}',
		].join("\n");
		expect(parseWptOutput(output, "url/a.any.js").subtests).toHaveLength(2);
		expect(() =>
			parseWptOutput(output.replace('"total":2', '"total":3'), "url/a.any.js"),
		).toThrow("incomplete WPT output");
		const unmatchedStart = output
			.replace(
				'WPT_RESULT {"path":"url/a.any.js","subtest":"two","status":"FAIL","message":"bad"}\n',
				"",
			)
			.replace('"total":2', '"total":1');
		expect(() => parseWptOutput(unmatchedStart, "url/a.any.js")).toThrow(
			"incomplete WPT output",
		);
	});

	it("allows empty failure messages", () => {
		const output = [
			'WPT_START {"path":"url/a.any.js","subtest":"empty"}',
			'WPT_RESULT {"path":"url/a.any.js","subtest":"empty","status":"FAIL","message":""}',
			'WPT_HARNESS {"path":"url/a.any.js","status":"OK","total":1}',
		].join("\n");
		expect(parseWptOutput(output, "url/a.any.js").subtests[0]?.message).toBe("");
	});

	it("attributes process termination only to the single active subtest", () => {
		const output = [
			'WPT_START {"path":"url/a.any.js","subtest":"finished"}',
			'WPT_RESULT {"path":"url/a.any.js","subtest":"finished","status":"PASS","message":null}',
			'WPT_START {"path":"url/a.any.js","subtest":"pending"}',
		].join("\n");
		const parsed = parseWptOutput(output, "url/a.any.js", "TIMEOUT");
		expect(parsed.subtests.map((result) => result.status)).toEqual(["PASS", "TIMEOUT"]);
		expect(() => parseWptOutput("", "url/a.any.js", "CRASH")).toThrow(
			"crash outside an active WPT subtest",
		);
		expect(() =>
			parseWptOutput(
				[
					'WPT_START {"path":"url/a.any.js","subtest":"one"}',
					'WPT_START {"path":"url/a.any.js","subtest":"two"}',
				].join("\n"),
				"url/a.any.js",
				"CRASH",
			),
		).toThrow("invalid or duplicate WPT subtest start");
		expect(() =>
			parseWptOutput(
				[
					'WPT_START {"path":"url/a.any.js","subtest":"done"}',
					'WPT_RESULT {"path":"url/a.any.js","subtest":"done","status":"PASS","message":null}',
				].join("\n"),
				"url/a.any.js",
				"CRASH",
			),
		).toThrow("crash outside an active WPT subtest");
	});

	it("treats unexpected passes and absent expectations as failures", () => {
		const expectations = parseWptExpectations(
			JSON.stringify({
				schemaVersion: 1,
				revision: WPT_REVISION,
				expectations: [
					{
						path: "url/a.any.js",
						subtest: "known defect",
						status: "FAIL",
						milestone: "W2",
						reason: "URL association is incomplete",
						revision: WPT_REVISION,
					},
					{
						path: "url/a.any.js",
						subtest: "not emitted",
						status: "FAIL",
						milestone: "W2",
						reason: "known missing behavior",
						revision: WPT_REVISION,
					},
				],
			}),
		);
		const classified = classifyWptResults(
			[
				{
					path: "url/a.any.js",
					subtest: "known defect",
					status: "PASS",
					message: null,
				},
			],
			expectations,
		);
		expect(classified.results[0]?.verdict).toBe("UNEXPECTED");
		expect(classified.missing.map((item) => item.subtest)).toEqual(["not emitted"]);
		const matchingFailure = {
			path: "url/a.any.js",
			subtest: "known defect",
			status: "FAIL" as const,
			message: "still broken",
		};
		expect(classifyWptResults([matchingFailure], expectations).results[0]?.verdict).toBe(
			"EXPECTED",
		);
		expect(
			classifyWptResults([{ ...matchingFailure, status: "TIMEOUT" }], expectations)
				.results[0]?.verdict,
		).toBe("UNEXPECTED");
		const stressClassified = classifyWptResults([], expectations);
		expect(stressClassified.missing.map((item) => item.subtest)).toEqual([
			"known defect",
			"not emitted",
		]);
	});

	it("builds isolated normal and GC-stress child environments", () => {
		const inherited = {
			PATH: "/bin",
			MAL_GC_STRESS: "inherited",
			MAL_GC_VERIFY: "inherited",
		};
		expect(createWptExecutionEnvironment(inherited, false)).toEqual({ PATH: "/bin" });
		expect(createWptExecutionEnvironment(inherited, true)).toEqual({
			PATH: "/bin",
			MAL_GC_STRESS: "1",
			MAL_GC_VERIFY: "1",
		});
	});

	it("hashes pinned source bytes before UTF-8 decoding", () => {
		const root = mkdtempSync(path.join(tmpdir(), "maligator-wpt-"));
		const bytes = Buffer.from([0x66, 0x80]);
		try {
			writeFileSync(path.join(root, "raw.any.js"), bytes);
			expect(
				loadPinnedWptSource(root, {
					path: "raw.any.js",
					sha256: createHash("sha256").update(bytes).digest("hex"),
					gcStress: false,
				}),
			).toBe(bytes.toString("utf8"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("generates deterministic programs with the selected path", () => {
		const first = createWptProgram("url/a.any.js", "test(function() {}, 'ok');");
		expect(first).toBe(createWptProgram("url/a.any.js", "test(function() {}, 'ok');"));
		expect(first).toContain('var __wpt_path = "url/a.any.js"');
		expect(first).toContain("WPT_RESULT");
	});

	it("runs promise tests sequentially and times out each active subtest with a timer", () => {
		const program = createWptProgram(
			"url/promises.any.js",
			String.raw`
var order = [];
promise_test(function() {
  order.push("first-start");
  return new Promise(function(resolve) {
    setTimeout(function() { order.push("first-end"); resolve(); }, 5);
  });
}, "first");
promise_test(function() {
  assert_array_equals(order, ["first-start", "first-end"]);
}, "second");
promise_test(function() { return new Promise(function() {}); }, "timeout");
promise_test(function() { assert_true(true); }, "after timeout");`,
			20,
		);
		const stdout = execFileSync("node", ["--input-type=commonjs", "--eval", program], {
			encoding: "utf8",
			timeout: 2_000,
		});
		const parsed = parseWptOutput(stdout, "url/promises.any.js");
		expect(parsed.subtests.map(({ subtest, status }) => [subtest, status])).toEqual([
			["first", "PASS"],
			["second", "PASS"],
			["timeout", "TIMEOUT"],
			["after timeout", "PASS"],
		]);
	});

	it("supports the async and assertion APIs used by the curated server-main tests", () => {
		const program = createWptProgram(
			"html/webappapis/timers/apis.any.js",
			String.raw`
test(function(t) {
  assert_throws_js(TypeError, function() { throw new TypeError("bad"); });
  var reason = {};
  assert_throws_exactly(reason, function() { throw reason; });
  t.step_func(function() { assert_true(true); })();
}, "sync context");
async_test(function(t) {
  t.step_timeout(t.step_func_done(function() { assert_true(true); }), 5);
}, "async context");
async_test(function(t) {
  setTimeout(t.step_func(function() { assert_unreached("callback failure"); }), 5);
}, "async failure");
done();`,
			50,
		);
		const stdout = execFileSync("node", ["--input-type=commonjs", "--eval", program], {
			encoding: "utf8",
			timeout: 2_000,
		});
		const parsed = parseWptOutput(stdout, "html/webappapis/timers/apis.any.js");
		expect(parsed.subtests.map(({ subtest, status }) => [subtest, status])).toEqual([
			["sync context", "PASS"],
			["async context", "PASS"],
			["async failure", "FAIL"],
		]);
	});
});
