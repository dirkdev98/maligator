import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";

export const WPT_REVISION = "f0b30d60daf6a64a3b087d66732c54c8e5273dbd";

export type WptStatus = "PASS" | "FAIL" | "TIMEOUT" | "CRASH";

export interface WptManifestEntry {
	path: string;
	sha256: string;
	gcStress: boolean;
}

export interface WptManifest {
	schemaVersion: 1;
	repository: string;
	revision: string;
	tests: Array<WptManifestEntry>;
}

export interface WptExpectation {
	path: string;
	subtest: string;
	status: Exclude<WptStatus, "PASS">;
	milestone: string;
	reason: string;
	revision: string;
}

export interface WptSubtestResult {
	path: string;
	subtest: string;
	status: WptStatus;
	message: string | null;
}

export interface WptHarnessResult {
	path: string;
	status: "OK" | "ERROR";
	total: number;
}

export interface WptClassification extends WptSubtestResult {
	verdict: "EXPECTED" | "UNEXPECTED";
	expectation: WptExpectation | null;
}

export function createWptExecutionEnvironment(
	environment: NodeJS.ProcessEnv,
	gcStress: boolean,
): NodeJS.ProcessEnv {
	const result = { ...environment };
	delete result.MAL_GC_STRESS;
	delete result.MAL_GC_VERIFY;
	if (gcStress) {
		result.MAL_GC_STRESS = "1";
		result.MAL_GC_VERIFY = "1";
	}
	return result;
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function exactString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

function nullableString(value: unknown, label: string): string | null {
	if (value !== null && typeof value !== "string") {
		throw new Error(`${label} must be a string or null`);
	}
	return value;
}

function exactPath(value: unknown, label: string): string {
	const result = exactString(value, label);
	if (
		result.startsWith("/") ||
		result.includes("..") ||
		result.includes("*") ||
		result.includes("\\")
	) {
		throw new Error(`${label} must be an exact repository-relative path`);
	}
	return result;
}

export function parseWptManifest(source: string): WptManifest {
	const root = object(JSON.parse(source) as unknown, "manifest");
	if (root.schemaVersion !== 1 || root.revision !== WPT_REVISION) {
		throw new Error(`manifest must use schema 1 and revision ${WPT_REVISION}`);
	}
	if (!Array.isArray(root.tests) || root.tests.length === 0) {
		throw new Error("manifest tests must be a non-empty array");
	}
	const seen = new Set<string>();
	const tests = root.tests.map((value, index) => {
		const entry = object(value, `tests[${index}]`);
		const testPath = exactPath(entry.path, `tests[${index}].path`);
		if (seen.has(testPath)) throw new Error(`duplicate manifest path: ${testPath}`);
		seen.add(testPath);
		const sha256 = exactString(entry.sha256, `tests[${index}].sha256`);
		if (!/^[a-f\d]{64}$/.test(sha256)) throw new Error(`invalid SHA-256 for ${testPath}`);
		if (typeof entry.gcStress !== "boolean")
			throw new Error(`gcStress must be boolean for ${testPath}`);
		return { path: testPath, sha256, gcStress: entry.gcStress };
	});
	return {
		schemaVersion: 1,
		repository: exactString(root.repository, "manifest.repository"),
		revision: WPT_REVISION,
		tests,
	};
}

export function parseWptExpectations(source: string): Array<WptExpectation> {
	const root = object(JSON.parse(source) as unknown, "expectations");
	if (
		root.schemaVersion !== 1 ||
		root.revision !== WPT_REVISION ||
		!Array.isArray(root.expectations)
	) {
		throw new Error(`expectations must use schema 1 and revision ${WPT_REVISION}`);
	}
	const seen = new Set<string>();
	return root.expectations.map((value, index) => {
		const entry = object(value, `expectations[${index}]`);
		const testPath = exactPath(entry.path, `expectations[${index}].path`);
		const subtest = exactString(entry.subtest, `expectations[${index}].subtest`);
		if (subtest.includes("*"))
			throw new Error(`expectation subtest must be exact: ${subtest}`);
		if (
			entry.status !== "FAIL" &&
			entry.status !== "TIMEOUT" &&
			entry.status !== "CRASH"
		) {
			throw new Error(`invalid expected status for ${testPath}: ${String(entry.status)}`);
		}
		const key = `${testPath}\0${subtest}`;
		if (seen.has(key)) throw new Error(`duplicate expectation: ${testPath} / ${subtest}`);
		seen.add(key);
		if (entry.revision !== WPT_REVISION) {
			throw new Error(
				`expectation revision must be ${WPT_REVISION}: ${testPath} / ${subtest}`,
			);
		}
		return {
			path: testPath,
			subtest,
			status: entry.status,
			milestone: exactString(entry.milestone, `expectations[${index}].milestone`),
			reason: exactString(entry.reason, `expectations[${index}].reason`),
			revision: exactString(entry.revision, `expectations[${index}].revision`),
		};
	});
}

export function verifyWptCheckout(root: string, external: boolean): void {
	if (external) {
		const revision = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
		}).trim();
		if (revision !== WPT_REVISION) {
			throw new Error(`WPT checkout is ${revision}; expected ${WPT_REVISION}`);
		}
	}
}

export function loadPinnedWptSource(root: string, entry: WptManifestEntry): string {
	const source = readFileSync(path.join(root, entry.path));
	const digest = createHash("sha256").update(source).digest("hex");
	if (digest !== entry.sha256) {
		throw new Error(`${entry.path} SHA-256 is ${digest}; expected ${entry.sha256}`);
	}
	return source.toString("utf8");
}

const TESTHARNESS_ADAPTER = String.raw`
var __wpt_path = __WPT_PATH__;
var __wpt_queue = Promise.resolve();
var __wpt_count = 0;
var __wpt_timeout = __WPT_TIMEOUT__;
function __wpt_message(error) {
  if (error && error.message !== undefined) return String(error.message);
  return String(error);
}
function __wpt_emit(name, status, message) {
  __wpt_count++;
  console.log("WPT_RESULT " + JSON.stringify({path: __wpt_path, subtest: name, status: status, message: message}));
}
function __wpt_context(finish, isSettled) {
  var context = {};
  context.done = function() { finish("PASS", null); };
  context.step_func = function(callback) {
    return function() {
      if (isSettled()) return;
      try { return callback.apply(this, arguments); }
      catch (error) { finish("FAIL", __wpt_message(error)); }
    };
  };
  context.step_func_done = function(callback) {
    return context.step_func(function() {
      if (callback) callback.apply(this, arguments);
      context.done();
    });
  };
  context.step_timeout = function(callback, timeout) {
    return setTimeout(context.step_func(callback), timeout);
  };
  context.unreached_func = function(message) {
    return context.step_func(function() { assert_unreached(message); });
  };
  return context;
}
function test(callback, name) {
  console.log("WPT_START " + JSON.stringify({path: __wpt_path, subtest: String(name)}));
  try {
    var settled = false;
    var finish = function(status, message) {
      if (settled) return;
      settled = true;
      if (status !== "PASS") throw new Error(message);
    };
    callback(__wpt_context(finish, function() { return settled; }));
    __wpt_emit(String(name), "PASS", null);
  }
  catch (error) { __wpt_emit(String(name), "FAIL", __wpt_message(error)); }
}
function async_test(callback, name) {
  name = String(name);
	__wpt_queue = __wpt_queue.then(function() {
		console.log("WPT_START " + JSON.stringify({path: __wpt_path, subtest: name}));
		return new Promise(function(resolve) {
			var settled = false;
			var timer;
			function finish(status, message) {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				__wpt_emit(name, status, message);
				resolve();
			}
			var context = __wpt_context(finish, function() { return settled; });
			timer = setTimeout(function() {
				finish("TIMEOUT", "subtest timed out after " + __wpt_timeout + "ms");
			}, __wpt_timeout);
			try { callback(context); }
			catch (error) { finish("FAIL", __wpt_message(error)); }
		});
	});
}
function promise_test(callback, name) {
	name = String(name);
	__wpt_queue = __wpt_queue.then(function() {
		console.log("WPT_START " + JSON.stringify({path: __wpt_path, subtest: name}));
		return new Promise(function(resolve) {
			var settled = false;
			var timer = setTimeout(function() {
				if (settled) return;
				settled = true;
				__wpt_emit(name, "TIMEOUT", "subtest timed out after " + __wpt_timeout + "ms");
				resolve();
			}, __wpt_timeout);
			var pending;
			try { pending = Promise.resolve(callback()); }
			catch (error) { pending = Promise.reject(error); }
			pending.then(
				function() {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					__wpt_emit(name, "PASS", null);
					resolve();
				},
				function(error) {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					__wpt_emit(name, "FAIL", __wpt_message(error));
					resolve();
				}
			);
		});
	});
}
function __wpt_fail(message) { throw new Error(message); }
function assert_true(actual, message) { if (actual !== true) __wpt_fail(message || "expected true but got " + String(actual)); }
function assert_false(actual, message) { if (actual !== false) __wpt_fail(message || "expected false but got " + String(actual)); }
function assert_equals(actual, expected, message) {
  if (!Object.is(actual, expected)) __wpt_fail((message ? message + ": " : "") + "expected " + String(expected) + " but got " + String(actual));
}
function assert_array_equals(actual, expected, message) {
  if (actual.length !== expected.length) __wpt_fail((message ? message + ": " : "") + "array lengths differ");
  for (var i = 0; i < expected.length; i++) assert_equals(actual[i], expected[i], message || "array item " + i);
}
function assert_throws_js(constructor, callback, message) {
  var error = null;
  try { callback(); } catch (caught) { error = caught; }
  if (!(error instanceof constructor)) __wpt_fail((message ? message + ": " : "") + "expected " + constructor.name);
}
function assert_throws_dom(name, callback, message) {
  var error = null;
  try { callback(); } catch (caught) { error = caught; }
  if (error === null || error.name !== name) __wpt_fail((message ? message + ": " : "") + "expected " + name);
}
function assert_throws_exactly(expected, callback, message) {
  var error = null;
  try { callback(); } catch (caught) { error = caught; }
  if (error !== expected) __wpt_fail((message ? message + ": " : "") + "expected exact thrown value");
}
function assert_unreached(message) { __wpt_fail(message || "reached unreachable code"); }
function done() {}
function format_value(value) { return JSON.stringify(value); }
function generate_tests(callback, cases) {
  cases.forEach(function(item) { test(function() { callback.apply(null, item.slice(1)); }, item[0]); });
}
`;

export function createWptProgram(
	testPath: string,
	source: string,
	timeoutMs = 10_000,
): string {
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error("WPT subtest timeout must be a positive integer");
	}
	const adapter = TESTHARNESS_ADAPTER.replace(
		"__WPT_PATH__",
		JSON.stringify(testPath),
	).replace("__WPT_TIMEOUT__", String(timeoutMs));
	return `${adapter}\n${source}\n__wpt_queue.then(function() {\n  console.log("WPT_HARNESS " + JSON.stringify({path: __wpt_path, status: "OK", total: __wpt_count}));\n});\n`;
}

export function parseWptOutput(
	stdout: string,
	expectedPath: string,
	terminalStatus?: "TIMEOUT" | "CRASH",
): {
	subtests: Array<WptSubtestResult>;
	harness: WptHarnessResult;
} {
	const subtests: Array<WptSubtestResult> = [];
	let harness: WptHarnessResult | null = null;
	const names = new Set<string>();
	const started = new Set<string>();
	let active: string | null = null;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("WPT_START ")) {
			const record = object(JSON.parse(line.slice(10)) as unknown, "WPT_START");
			const subtest = exactString(record.subtest, "WPT_START.subtest");
			if (record.path !== expectedPath || started.has(subtest) || active !== null) {
				throw new Error(`invalid or duplicate WPT subtest start: ${subtest}`);
			}
			started.add(subtest);
			active = subtest;
		} else if (line.startsWith("WPT_RESULT ")) {
			const record = object(JSON.parse(line.slice(11)) as unknown, "WPT_RESULT");
			const subtest = exactString(record.subtest, "WPT_RESULT.subtest");
			if (active !== subtest || names.has(subtest)) {
				throw new Error(`missing start or duplicate WPT subtest result: ${subtest}`);
			}
			names.add(subtest);
			active = null;
			if (
				record.path !== expectedPath ||
				(record.status !== "PASS" &&
					record.status !== "FAIL" &&
					record.status !== "TIMEOUT")
			) {
				throw new Error(`invalid WPT result record for ${expectedPath}`);
			}
			subtests.push({
				path: expectedPath,
				subtest,
				status: record.status,
				message: nullableString(record.message, "WPT_RESULT.message"),
			});
		} else if (line.startsWith("WPT_HARNESS ")) {
			if (harness !== null)
				throw new Error(`duplicate WPT harness record for ${expectedPath}`);
			const record = object(JSON.parse(line.slice(12)) as unknown, "WPT_HARNESS");
			if (
				record.path !== expectedPath ||
				record.status !== "OK" ||
				!Number.isInteger(record.total)
			) {
				throw new Error(`invalid WPT harness record for ${expectedPath}`);
			}
			harness = { path: expectedPath, status: "OK", total: record.total as number };
		}
	}
	if (terminalStatus !== undefined) {
		if (active === null) {
			throw new Error(
				`${terminalStatus.toLowerCase()} outside an active WPT subtest: ${expectedPath}`,
			);
		}
		subtests.push({
			path: expectedPath,
			subtest: active,
			status: terminalStatus,
			message: `process ${terminalStatus.toLowerCase()}`,
		});
		return {
			subtests,
			harness: { path: expectedPath, status: "ERROR", total: subtests.length },
		};
	}
	if (
		harness === null ||
		harness.total !== subtests.length ||
		started.size !== names.size ||
		active !== null ||
		subtests.length === 0
	) {
		throw new Error(`incomplete WPT output for ${expectedPath}`);
	}
	return { subtests, harness };
}

export function classifyWptResults(
	results: Array<WptSubtestResult>,
	expectations: Array<WptExpectation>,
): { results: Array<WptClassification>; missing: Array<WptExpectation> } {
	const remaining = new Map(
		expectations.map((item) => [`${item.path}\0${item.subtest}`, item]),
	);
	const classified = results.map((result) => {
		const key = `${result.path}\0${result.subtest}`;
		const expectation = remaining.get(key) ?? null;
		remaining.delete(key);
		const expected =
			expectation === null
				? result.status === "PASS"
				: result.status === expectation.status;
		const verdict: WptClassification["verdict"] = expected ? "EXPECTED" : "UNEXPECTED";
		return { ...result, verdict, expectation };
	});
	return { results: classified, missing: [...remaining.values()] };
}
