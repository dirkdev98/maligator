import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";

export const WPT_REVISION = "f0b30d60daf6a64a3b087d66732c54c8e5273dbd";

export type WptMode = "normal" | "gc-stress";
export type WptBackend = "compiled" | "interpreted";
export type WptPolicy = "bail" | "complete";
export type WptStatus = "PASS" | "FAIL" | "TIMEOUT" | "CRASH";
export type WptMetadataName = "title" | "global" | "variant" | "script" | "timeout";

export interface WptMetadataDeclaration {
	name: WptMetadataName;
	value: string;
}

export interface WptPinnedInclude {
	path: string;
	sha256: string;
}

export interface WptManifestEntry {
	path: string;
	sha256: string;
	target: "server-main";
	modes: Array<WptMode>;
	metadata: Array<WptMetadataDeclaration>;
	includes: Array<WptPinnedInclude>;
}

export interface WptManifest {
	schemaVersion: 2;
	repository: string;
	revision: string;
	tests: Array<WptManifestEntry>;
}

export interface WptExecutionKey {
	path: string;
	variant: string;
	backend: WptBackend;
	mode: WptMode;
}

export interface WptExpectation extends WptExecutionKey {
	subtest: string;
	occurrence: number;
	status: Exclude<WptStatus, "PASS">;
	milestone: string;
	reason: string;
	revision: string;
}

export interface WptSubtestResult extends WptExecutionKey {
	id: number;
	subtest: string;
	occurrence: number;
	status: WptStatus;
	message: string | null;
}

export interface WptHarnessResult {
	path: string;
	status: "OK" | "ERROR";
	total: number;
	message: string | null;
}

export interface WptClassification extends WptSubtestResult {
	verdict: "EXPECTED" | "UNEXPECTED";
	expectation: WptExpectation | null;
}

export interface WptParsedMetadata {
	declarations: Array<WptMetadataDeclaration>;
	title: string | null;
	globals: Array<string>;
	variants: Array<string>;
	scripts: Array<string>;
	timeout: "long" | null;
}

export interface WptPinnedTest {
	source: string;
	metadata: WptParsedMetadata;
	includes: Array<{ path: string; source: string }>;
}

const MODES: Array<WptMode> = ["normal", "gc-stress"];
const BACKENDS: Array<WptBackend> = ["compiled", "interpreted"];

export function parseWptPolicy(value: string | undefined): WptPolicy {
	if (value === undefined || value === "complete") return "complete";
	if (value === "bail") return "bail";
	throw new Error("--policy must be bail or complete");
}

export function shouldAbortWptRun(
	policy: WptPolicy,
	outcome: {
		harness: WptHarnessResult;
		verdicts: Array<WptClassification>;
		missingExpectations: Array<WptExpectation>;
		terminalStatus?: "TIMEOUT" | "CRASH";
	},
): boolean {
	return (
		policy === "bail" &&
		(outcome.harness.status === "ERROR" ||
			outcome.terminalStatus !== undefined ||
			outcome.missingExpectations.length > 0 ||
			outcome.verdicts.some((result) => result.verdict === "UNEXPECTED"))
	);
}

export function createWptExecutionEnvironment(
	environment: NodeJS.ProcessEnv,
	mode: WptMode,
): NodeJS.ProcessEnv {
	const result = { ...environment };
	delete result.MAL_GC_STRESS;
	delete result.MAL_GC_VERIFY;
	if (mode === "gc-stress") {
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

function positiveInteger(value: unknown, label: string): number {
	if (!Number.isInteger(value) || (value as number) < 1) {
		throw new Error(`${label} must be a positive integer`);
	}
	return value as number;
}

function exactPath(value: unknown, label: string): string {
	const result = exactString(value, label);
	if (
		result.startsWith("/") ||
		result.split("/").some((part) => part === "" || part === "." || part === "..") ||
		result.includes("*") ||
		result.includes("\\")
	) {
		throw new Error(`${label} must be an exact repository-relative path`);
	}
	return result;
}

function sha256(value: unknown, label: string): string {
	const result = exactString(value, label);
	if (!/^[a-f\d]{64}$/.test(result)) throw new Error(`${label} must be a SHA-256`);
	return result;
}

function parseMode(value: unknown, label: string): WptMode {
	if (value !== "normal" && value !== "gc-stress") {
		throw new Error(`${label} must be normal or gc-stress`);
	}
	return value;
}

function parseBackend(value: unknown, label: string): WptBackend {
	if (value !== "compiled" && value !== "interpreted") {
		throw new Error(`${label} must be compiled or interpreted`);
	}
	return value;
}

function containsCodePointAtMost(value: string, maximum: number): boolean {
	for (let index = 0; index < value.length; index++) {
		if (value.charCodeAt(index) <= maximum) return true;
	}
	return false;
}

function validateVariant(value: string, label: string): string {
	if (
		(value[0] !== "?" && value[0] !== "#") ||
		value.includes("\\") ||
		containsCodePointAtMost(value, 0x20)
	) {
		throw new Error(`${label} must be a URL query/fragment suffix`);
	}
	const url = new URL(value, "https://web-platform.test/");
	if (`${url.search}${url.hash}` !== value) {
		throw new Error(`${label} must be a canonical URL query/fragment suffix`);
	}
	return value;
}

function parseMetadataDeclarations(
	value: unknown,
	label: string,
): Array<WptMetadataDeclaration> {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	let hasTitle = false;
	let hasGlobal = false;
	let hasTimeout = false;
	const variants = new Set<string>();
	return value.map((item, index) => {
		const declaration = object(item, `${label}[${index}]`);
		const name = exactString(declaration.name, `${label}[${index}].name`);
		if (
			name !== "title" &&
			name !== "global" &&
			name !== "variant" &&
			name !== "script" &&
			name !== "timeout"
		) {
			throw new Error(`unsupported WPT metadata: ${name}`);
		}
		const declarationValue = exactString(declaration.value, `${label}[${index}].value`);
		if (name === "title") {
			if (hasTitle) throw new Error(`${label} has repeated title metadata`);
			hasTitle = true;
		} else if (name === "global") {
			if (hasGlobal) throw new Error(`${label} has repeated global metadata`);
			if (
				!declarationValue.split(",").every((global) => /^[a-z][a-z0-9-]*$/.test(global))
			) {
				throw new Error(`${label}[${index}].value has invalid globals`);
			}
			hasGlobal = true;
		} else if (name === "variant") {
			validateVariant(declarationValue, `${label}[${index}].value`);
			if (variants.has(declarationValue)) {
				throw new Error(`${label} has duplicate variant ${declarationValue}`);
			}
			variants.add(declarationValue);
		} else if (name === "timeout") {
			if (hasTimeout) throw new Error(`${label} has repeated timeout metadata`);
			if (declarationValue !== "long") {
				throw new Error(`${label}[${index}].value has unsupported timeout metadata`);
			}
			hasTimeout = true;
		}
		return { name, value: declarationValue };
	});
}

export function parseWptMetadata(source: string): WptParsedMetadata {
	const declarations: Array<WptMetadataDeclaration> = [];
	const lines = source.split(/\r?\n/);
	for (const line of lines) {
		const match = /^\/\/ META: ([a-z]+)=(.*)$/.exec(line);
		if (match === null) break;
		declarations.push({ name: match[1] as WptMetadataName, value: match[2] as string });
	}
	const validated = parseMetadataDeclarations(declarations, "metadata");
	const title = validated.find((item) => item.name === "title")?.value ?? null;
	const global = validated.find((item) => item.name === "global")?.value;
	const variants = validated
		.filter((item) => item.name === "variant")
		.map((item) => item.value);
	return {
		declarations: validated,
		title,
		globals: global === undefined ? ["window", "dedicatedworker"] : global.split(","),
		variants: variants.length === 0 ? [""] : variants,
		scripts: validated.filter((item) => item.name === "script").map((item) => item.value),
		timeout:
			validated.find((item) => item.name === "timeout")?.value === "long" ? "long" : null,
	};
}

export function resolveWptScriptPath(testPath: string, declaration: string): string {
	exactPath(testPath, "test path");
	if (
		declaration.length === 0 ||
		declaration.startsWith("//") ||
		/^[a-z][a-z\d+.-]*:/i.test(declaration) ||
		declaration.includes("\\") ||
		declaration.includes("?") ||
		declaration.includes("#") ||
		containsCodePointAtMost(declaration, 0x1f)
	) {
		throw new Error(`unsafe WPT script include: ${declaration}`);
	}
	const directory = path.posix.dirname(testPath);
	const base =
		declaration.startsWith("/") || directory === "." ? [] : directory.split("/");
	for (const rawPart of declaration.split("/")) {
		if (rawPart === "" || rawPart === ".") continue;
		let part: string;
		try {
			part = decodeURIComponent(rawPart);
		} catch {
			throw new Error(`unsafe WPT script include: ${declaration}`);
		}
		if (part === "..") {
			if (base.length === 0)
				throw new Error(`WPT script include escapes the root: ${declaration}`);
			base.pop();
		} else {
			if (part === "." || part.includes("/") || part.includes("\\")) {
				throw new Error(`unsafe WPT script include: ${declaration}`);
			}
			base.push(part);
		}
	}
	const resolved = exactPath(base.join("/"), "resolved WPT script include");
	if (/(?:^|\/)[^/]*\.sub\.[^/]+$/.test(resolved) || /\.(?:py|asis)$/.test(resolved)) {
		throw new Error(`dynamic WPT script include is unsupported: ${declaration}`);
	}
	return resolved;
}

export function parseWptManifest(source: string): WptManifest {
	const root = object(JSON.parse(source) as unknown, "manifest");
	if (root.schemaVersion !== 2 || root.revision !== WPT_REVISION) {
		throw new Error(`manifest must use schema 2 and revision ${WPT_REVISION}`);
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
		if (entry.target !== "server-main") {
			throw new Error(`target must be server-main for ${testPath}`);
		}
		if (!Array.isArray(entry.modes) || entry.modes.length === 0) {
			throw new Error(`modes must be a non-empty array for ${testPath}`);
		}
		const modes = entry.modes.map((mode, modeIndex) =>
			parseMode(mode, `tests[${index}].modes[${modeIndex}]`),
		);
		if (
			new Set(modes).size !== modes.length ||
			JSON.stringify(modes) !==
				JSON.stringify(MODES.filter((mode) => modes.includes(mode)))
		) {
			throw new Error(`modes must be unique and ordered for ${testPath}`);
		}
		const metadata = parseMetadataDeclarations(
			entry.metadata,
			`tests[${index}].metadata`,
		);
		if (!Array.isArray(entry.includes))
			throw new Error(`includes must be an array for ${testPath}`);
		const includes = entry.includes.map((item, includeIndex) => {
			const include = object(item, `tests[${index}].includes[${includeIndex}]`);
			return {
				path: exactPath(include.path, `tests[${index}].includes[${includeIndex}].path`),
				sha256: sha256(
					include.sha256,
					`tests[${index}].includes[${includeIndex}].sha256`,
				),
			};
		});
		const declaredIncludes = metadata
			.filter((item) => item.name === "script")
			.map((item) => resolveWptScriptPath(testPath, item.value));
		if (
			JSON.stringify(declaredIncludes) !==
			JSON.stringify(includes.map((item) => item.path))
		) {
			throw new Error(`metadata scripts and pinned includes differ for ${testPath}`);
		}
		return {
			path: testPath,
			sha256: sha256(entry.sha256, `tests[${index}].sha256`),
			target: "server-main" as const,
			modes,
			metadata,
			includes,
		};
	});
	return {
		schemaVersion: 2,
		repository: exactString(root.repository, "manifest.repository"),
		revision: WPT_REVISION,
		tests,
	};
}

export function selectWptManifestEntries(
	entries: Array<WptManifestEntry>,
	paths: Array<string>,
): Array<WptManifestEntry> {
	if (paths.length === 0) return entries;
	const selected = new Set(paths);
	const result = entries.filter((entry) => selected.delete(entry.path));
	if (selected.size > 0) {
		throw new Error(
			`WPT path is not in the curated manifest: ${[...selected].join(", ")}`,
		);
	}
	return result;
}

export function selectWptExecutionDimensions(
	entry: WptManifestEntry,
	requestedModes: Array<string>,
	requestedBackends: Array<string>,
): Array<{ mode: WptMode; backend: WptBackend }> {
	const modeFilter = requestedModes.map((mode, index) =>
		parseMode(mode, `--mode[${index}]`),
	);
	const backendFilter = requestedBackends.map((backend, index) =>
		parseBackend(backend, `--backend[${index}]`),
	);
	for (const mode of modeFilter) {
		if (!entry.modes.includes(mode)) {
			throw new Error(`${entry.path} does not support mode ${mode}`);
		}
	}
	const modes =
		modeFilter.length === 0
			? entry.modes
			: MODES.filter((mode) => modeFilter.includes(mode));
	const backends =
		backendFilter.length === 0
			? (["compiled"] as Array<WptBackend>)
			: BACKENDS.filter((backend) => backendFilter.includes(backend));
	return modes.flatMap((mode) => backends.map((backend) => ({ mode, backend })));
}

export function parseWptExpectations(source: string): Array<WptExpectation> {
	const root = object(JSON.parse(source) as unknown, "expectations");
	if (
		root.schemaVersion !== 2 ||
		root.revision !== WPT_REVISION ||
		!Array.isArray(root.expectations)
	) {
		throw new Error(`expectations must use schema 2 and revision ${WPT_REVISION}`);
	}
	const seen = new Set<string>();
	return root.expectations.map((value, index) => {
		const entry = object(value, `expectations[${index}]`);
		const testPath = exactPath(entry.path, `expectations[${index}].path`);
		const variant =
			entry.variant === ""
				? ""
				: validateVariant(
						exactString(entry.variant, `expectations[${index}].variant`),
						`expectations[${index}].variant`,
					);
		const backend = parseBackend(entry.backend, `expectations[${index}].backend`);
		const mode = parseMode(entry.mode, `expectations[${index}].mode`);
		const subtest = exactString(entry.subtest, `expectations[${index}].subtest`);
		const occurrence = positiveInteger(
			entry.occurrence,
			`expectations[${index}].occurrence`,
		);
		if (subtest.includes("*"))
			throw new Error(`expectation subtest must be exact: ${subtest}`);
		if (
			entry.status !== "FAIL" &&
			entry.status !== "TIMEOUT" &&
			entry.status !== "CRASH"
		) {
			throw new Error(`invalid expected status for ${testPath}: ${String(entry.status)}`);
		}
		const key = expectationKey({ testPath, variant, backend, mode, subtest, occurrence });
		if (seen.has(key)) throw new Error(`duplicate expectation: ${testPath} / ${subtest}`);
		seen.add(key);
		if (entry.revision !== WPT_REVISION) {
			throw new Error(
				`expectation revision must be ${WPT_REVISION}: ${testPath} / ${subtest}`,
			);
		}
		return {
			path: testPath,
			variant,
			backend,
			mode,
			subtest,
			occurrence,
			status: entry.status,
			milestone: exactString(entry.milestone, `expectations[${index}].milestone`),
			reason: exactString(entry.reason, `expectations[${index}].reason`),
			revision: WPT_REVISION,
		};
	});
}

export function validateWptExpectations(
	expectations: ReadonlyArray<WptExpectation>,
	entries: ReadonlyArray<WptManifestEntry>,
): void {
	const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
	for (const expectation of expectations) {
		const entry = entriesByPath.get(expectation.path);
		if (entry === undefined) {
			throw new Error(`expectation path is not curated: ${expectation.path}`);
		}
		const declaredVariants = entry.metadata
			.filter((item) => item.name === "variant")
			.map((item) => item.value);
		const variants = declaredVariants.length === 0 ? [""] : declaredVariants;
		if (!variants.includes(expectation.variant)) {
			throw new Error(
				`expectation variant is not declared for ${expectation.path}: ${expectation.variant}`,
			);
		}
		if (!entry.modes.includes(expectation.mode)) {
			throw new Error(
				`expectation mode is not enabled for ${expectation.path}: ${expectation.mode}`,
			);
		}
	}
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

function loadPinnedFile(root: string, filePath: string, expectedHash: string): string {
	const bytes = readFileSync(path.join(root, filePath));
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (digest !== expectedHash) {
		throw new Error(`${filePath} SHA-256 is ${digest}; expected ${expectedHash}`);
	}
	return bytes.toString("utf8");
}

export function loadPinnedWptTest(root: string, entry: WptManifestEntry): WptPinnedTest {
	const source = loadPinnedFile(root, entry.path, entry.sha256);
	const metadata = parseWptMetadata(source);
	if (JSON.stringify(metadata.declarations) !== JSON.stringify(entry.metadata)) {
		throw new Error(`${entry.path} metadata differs from the curated manifest`);
	}
	const includes = entry.includes.map((include) => ({
		path: include.path,
		source: loadPinnedFile(root, include.path, include.sha256),
	}));
	return { source, metadata, includes };
}

const TESTHARNESS_ADAPTER = String.raw`
var __wpt_path = __WPT_PATH__;
var __wpt_variant = __WPT_VARIANT__;
var __wpt_title = __WPT_TITLE__;
var __wpt_queue = Promise.resolve();
var __wpt_async = [];
var __wpt_count = 0;
var __wpt_next_id = 0;
var __wpt_default_name_count = 0;
var __wpt_occurrences = Object.create(null);
var __wpt_duplicate_names = [];
var __wpt_timeout = __WPT_TIMEOUT__;
var __wpt_harness_error = null;
var __wpt_single_test = null;
var __wpt_intervals = [];
var __wpt_timeouts = [];
var __wpt_native_set_interval = globalThis.setInterval;
var __wpt_native_clear_interval = globalThis.clearInterval;
var __wpt_native_set_timeout = globalThis.setTimeout;
var __wpt_native_clear_timeout = globalThis.clearTimeout;
var self = globalThis;
var location = Object.freeze(__WPT_LOCATION__);
globalThis.location = location;
globalThis.setInterval = function() {
  var handle = __wpt_native_set_interval.apply(globalThis, arguments);
  __wpt_intervals.push(handle);
  return handle;
};
globalThis.clearInterval = function(handle) {
  __wpt_native_clear_interval.call(globalThis, handle);
};
globalThis.setTimeout = function() {
  var handle = __wpt_native_set_timeout.apply(globalThis, arguments);
  __wpt_timeouts.push(handle);
  return handle;
};
globalThis.clearTimeout = function(handle) {
  __wpt_native_clear_timeout.call(globalThis, handle);
};
function __wpt_cleanup_timers() {
  for (var i = 0; i < __wpt_intervals.length; i++) {
    __wpt_native_clear_interval.call(globalThis, __wpt_intervals[i]);
  }
  for (var i = 0; i < __wpt_timeouts.length; i++) {
    __wpt_native_clear_timeout.call(globalThis, __wpt_timeouts[i]);
  }
  __wpt_intervals.length = 0;
  __wpt_timeouts.length = 0;
  globalThis.setInterval = __wpt_native_set_interval;
  globalThis.clearInterval = __wpt_native_clear_interval;
  globalThis.setTimeout = __wpt_native_set_timeout;
  globalThis.clearTimeout = __wpt_native_clear_timeout;
}
function __wpt_message(error) {
  if (error && error.message !== undefined) return String(error.message);
  return String(error);
}
function __wpt_set_harness_error(error) {
  if (__wpt_harness_error === null) __wpt_harness_error = __wpt_message(error);
}
function __wpt_register(callback, name) {
  var resolved;
  if (name) resolved = String(name);
  else {
    resolved = __wpt_title || __wpt_path;
    if (__wpt_default_name_count > 0) resolved += " " + __wpt_default_name_count;
    __wpt_default_name_count++;
  }
  var occurrence = (__wpt_occurrences[resolved] || 0) + 1;
  __wpt_occurrences[resolved] = occurrence;
  if (occurrence === 2) __wpt_duplicate_names.push(resolved);
  return {id: ++__wpt_next_id, subtest: resolved, occurrence: occurrence};
}
function __wpt_check_duplicate_names() {
  if (__wpt_duplicate_names.length === 0 || __wpt_harness_error !== null) return;
  var prefix = __wpt_duplicate_names.length === 1
    ? "1 duplicate test name: "
    : String(__wpt_duplicate_names.length) + " duplicate test names: ";
  __wpt_set_harness_error(prefix + __wpt_duplicate_names.map(JSON.stringify).join(", "));
}
function __wpt_check_return_value(kind, test, value) {
  if (value === undefined) return;
  var tick = String.fromCharCode(96);
  var message = "Test named \"" + test.subtest + "\" passed a function to " + tick + kind + tick + " that returned a value.";
  try {
    if (value && typeof value.then === "function") {
      message += " Consider using " + tick + "promise_test" + tick + " instead when using Promises or async/await.";
    }
  } catch (error) {}
  __wpt_set_harness_error(message);
}
function __wpt_start(test) {
  console.log("WPT_START " + JSON.stringify({path: __wpt_path, id: test.id, subtest: test.subtest, occurrence: test.occurrence}));
}
function __wpt_emit(test, status, message) {
  __wpt_count++;
  console.log("WPT_RESULT " + JSON.stringify({path: __wpt_path, id: test.id, subtest: test.subtest, occurrence: test.occurrence, status: status, message: message}));
}
function __wpt_context(finish, isSettled) {
  var context = {};
  context.__wpt_cleanups = [];
  context.add_cleanup = function(callback) {
    context.__wpt_cleanups.push(callback);
  };
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
    return setTimeout(context.step_func(function() {
      return callback.apply(context, arguments);
    }), timeout);
  };
  context.unreached_func = function(message) {
    return context.step_func(function() { assert_unreached(message); });
  };
  return context;
}
function __wpt_run_cleanups(context, allowThenables) {
  var pending = [];
  for (var i = 0; i < context.__wpt_cleanups.length; i++) {
    try {
      var result = context.__wpt_cleanups[i]();
      if (result !== undefined) {
        if (allowThenables && result && typeof result.then === "function") {
          pending.push(Promise.resolve(result).catch(__wpt_set_harness_error));
        } else {
          __wpt_set_harness_error("cleanup callback returned a non-undefined value");
        }
      }
    } catch (error) {
      __wpt_set_harness_error(error);
    }
  }
  return Promise.all(pending);
}
function step_timeout(callback, timeout) {
  var args = Array.prototype.slice.call(arguments, 2);
  var receiver = this;
  return setTimeout(function() { callback.apply(receiver, args); }, timeout);
}
function setup(callback) {
  if (callback && typeof callback === "object") {
    if (callback.single_test === true) {
      if (__wpt_single_test !== null) {
        __wpt_set_harness_error("setup({single_test: true}) called more than once");
      } else {
        __wpt_single_test = async_test(null);
      }
    }
    return;
  }
  if (typeof callback !== "function") return;
  try { callback(); }
  catch (error) { __wpt_set_harness_error(error); }
}
function test(callback, name) {
  var testRecord = __wpt_register(callback, name);
  __wpt_start(testRecord);
  var context;
  try {
    var settled = false;
    var stepStatus = null;
    var stepMessage = null;
    var finish = function(status, message) {
      if (settled) return;
      settled = true;
      stepStatus = status;
      stepMessage = message;
      if (status !== "PASS") throw new Error(message);
    };
    context = __wpt_context(finish, function() { return settled; });
    var value = callback(context);
    __wpt_check_return_value("test", testRecord, value);
    __wpt_run_cleanups(context, false);
    __wpt_emit(testRecord, stepStatus === null ? "PASS" : stepStatus, stepMessage);
  }
  catch (error) {
    if (context !== undefined) __wpt_run_cleanups(context, false);
    __wpt_emit(testRecord, "FAIL", __wpt_message(error));
  }
}
function async_test(callback, name) {
  if (typeof callback !== "function") {
    name = callback;
    callback = null;
  }
  var testRecord = __wpt_register(callback, name);
  __wpt_start(testRecord);
  var context;
  var pending = new Promise(function(resolve) {
    var settled = false;
    var timer;
    function finish(status, message) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      __wpt_run_cleanups(context, false);
      __wpt_emit(testRecord, status, message);
      resolve();
    }
    context = __wpt_context(finish, function() { return settled; });
    timer = setTimeout(function() {
      finish("TIMEOUT", "subtest timed out after " + __wpt_timeout + "ms");
    }, __wpt_timeout);
    try {
      if (callback !== null) {
        var value = callback.call(context, context);
        __wpt_check_return_value("async_test", testRecord, value);
      }
    }
    catch (error) { finish("FAIL", __wpt_message(error)); }
  });
  __wpt_async.push(pending);
  return context;
}
function promise_test(callback, name) {
  var testRecord = __wpt_register(callback, name);
  __wpt_queue = __wpt_queue.then(function() {
    __wpt_start(testRecord);
    return new Promise(function(resolve) {
      var settled = false;
      var timer;
      function finish(status, message) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        __wpt_emit(testRecord, status, message);
        resolve();
      }
      var context = __wpt_context(finish, function() { return settled; });
      timer = setTimeout(function() {
        finish("TIMEOUT", "subtest timed out after " + __wpt_timeout + "ms");
      }, __wpt_timeout);
      var pending;
      try {
        pending = callback(context);
        if (!pending || typeof pending.then !== "function") {
          throw new Error("promise_test body must return a thenable");
        }
        pending = Promise.resolve(pending);
      }
      catch (error) { pending = Promise.reject(error); }
      pending.then(
        function() {
          return __wpt_run_cleanups(context, true).then(function() { finish("PASS", null); });
        },
        function(error) {
          return __wpt_run_cleanups(context, true).then(function() { finish("FAIL", __wpt_message(error)); });
        }
      );
    });
  });
}
function promise_rejects_exactly(test, expected, promise, description) {
  return Promise.resolve(promise).then(
    test.unreached_func("Should have rejected: " + description),
    function(error) {
      if (error !== expected) __wpt_fail((description ? description + ": " : "") + "expected exact rejection value");
    }
  );
}
function promise_rejects_js(test, constructor, promise, description) {
  return Promise.resolve(promise).then(
    test.unreached_func("Should have rejected: " + description),
    function(error) {
      if (!(error instanceof constructor)) __wpt_fail((description ? description + ": " : "") + "expected " + constructor.name);
    }
  );
}
function __wpt_fail(message) { throw new Error(message); }
function assert_true(actual, message) { if (actual !== true) __wpt_fail(message || "expected true but got " + String(actual)); }
function assert_false(actual, message) { if (actual !== false) __wpt_fail(message || "expected false but got " + String(actual)); }
function assert_equals(actual, expected, message) {
  if (!Object.is(actual, expected)) __wpt_fail((message ? message + ": " : "") + "expected " + String(expected) + " but got " + String(actual));
}
function assert_not_equals(actual, expected, message) {
  if (Object.is(actual, expected)) __wpt_fail((message ? message + ": " : "") + "expected values to differ");
}
function assert_approx_equals(actual, expected, epsilon, message) {
  if (typeof actual !== "number" || typeof expected !== "number" || typeof epsilon !== "number" ||
      Math.abs(actual - expected) > epsilon) {
    __wpt_fail((message ? message + ": " : "") + "expected " + String(actual) + " to be within " + String(epsilon) + " of " + String(expected));
  }
}
function assert_greater_than(actual, expected, message) {
  if (typeof actual !== "number" || typeof expected !== "number" || !(actual > expected)) {
    __wpt_fail((message ? message + ": " : "") + "expected " + String(actual) + " to be greater than " + String(expected));
  }
}
function assert_array_equals(actual, expected, message) {
  if (actual.length !== expected.length) __wpt_fail((message ? message + ": " : "") + "array lengths differ");
  for (var i = 0; i < expected.length; i++) assert_equals(actual[i], expected[i], message || "array item " + i);
}
function assert_object_equals(actual, expected, message) {
  if (typeof actual !== "object" || actual === null) {
    __wpt_fail((message ? message + ": " : "") + "expected an object");
  }
  function check_equal(actualObject, expectedObject, stack) {
    stack.push(actualObject);
    var property;
    for (property in actualObject) {
      if (!Object.prototype.hasOwnProperty.call(expectedObject, property)) {
        __wpt_fail((message ? message + ": " : "") + "unexpected property " + property);
      }
      if (typeof actualObject[property] === "object" && actualObject[property] !== null) {
        if (stack.indexOf(actualObject[property]) === -1) {
          check_equal(actualObject[property], expectedObject[property], stack);
        }
      } else if (!Object.is(actualObject[property], expectedObject[property])) {
        __wpt_fail((message ? message + ": " : "") + "property " + property + " differs");
      }
    }
    for (property in expectedObject) {
      if (!Object.prototype.hasOwnProperty.call(actualObject, property)) {
        __wpt_fail((message ? message + ": " : "") + "expected property " + property + " missing");
      }
    }
    stack.pop();
  }
  check_equal(actual, expected, []);
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
function done() {
  if (__wpt_single_test !== null) __wpt_single_test.done();
}
function format_value(value) { return JSON.stringify(value); }
function generate_tests(callback, cases) {
  cases.forEach(function(item) { test(function() { callback.apply(null, item.slice(1)); }, item[0]); });
}
`;

export function createWptProgram(
	entry: WptManifestEntry,
	pinned: WptPinnedTest,
	variant: string,
	timeoutMs = pinned.metadata.timeout === "long" ? 60_000 : 10_000,
): string {
	if (!pinned.metadata.variants.includes(variant)) {
		throw new Error(`variant ${variant} is not declared by ${entry.path}`);
	}
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error("WPT subtest timeout must be a positive integer");
	}
	const url = new URL(variant, `https://web-platform.test/${entry.path}`);
	const location = {
		href: url.href,
		origin: url.origin,
		protocol: url.protocol,
		host: url.host,
		hostname: url.hostname,
		port: url.port,
		pathname: url.pathname,
		search: url.search,
		hash: url.hash,
	};
	const adapter = TESTHARNESS_ADAPTER.replace("__WPT_PATH__", JSON.stringify(entry.path))
		.replace("__WPT_VARIANT__", JSON.stringify(variant))
		.replace("__WPT_TITLE__", JSON.stringify(pinned.metadata.title))
		.replace("__WPT_LOCATION__", JSON.stringify(location))
		.replace("__WPT_TIMEOUT__", String(timeoutMs));
	const includes = pinned.includes.map((include) => include.source).join("\n");
	return `${adapter}\n${includes}\n${pinned.source}\nPromise.all([__wpt_queue, Promise.all(__wpt_async)]).then(function() {\n  __wpt_cleanup_timers();\n  __wpt_check_duplicate_names();\n  console.log("WPT_HARNESS " + JSON.stringify({path: __wpt_path, status: __wpt_harness_error === null ? "OK" : "ERROR", total: __wpt_count, message: __wpt_harness_error}));\n});\n`;
}

interface WptTransportTest {
	id: number;
	subtest: string;
	occurrence: number;
}

function parseTransportTest(
	record: Record<string, unknown>,
	label: string,
): WptTransportTest {
	return {
		id: positiveInteger(record.id, `${label}.id`),
		subtest: exactString(record.subtest, `${label}.subtest`),
		occurrence: positiveInteger(record.occurrence, `${label}.occurrence`),
	};
}

export function parseWptOutput(
	stdout: string,
	execution: WptExecutionKey,
	terminalStatus?: "TIMEOUT" | "CRASH",
): { subtests: Array<WptSubtestResult>; harness: WptHarnessResult } {
	const subtests: Array<WptSubtestResult> = [];
	let harness: WptHarnessResult | null = null;
	const started = new Map<number, WptTransportTest>();
	const finished = new Set<number>();
	const occurrences = new Set<string>();
	const active = new Map<number, WptTransportTest>();
	for (const line of stdout.split("\n")) {
		if (line.startsWith("WPT_START ")) {
			const record = object(JSON.parse(line.slice(10)) as unknown, "WPT_START");
			const test = parseTransportTest(record, "WPT_START");
			const occurrenceKey = `${test.subtest}\0${test.occurrence}`;
			if (
				record.path !== execution.path ||
				started.has(test.id) ||
				occurrences.has(occurrenceKey)
			) {
				throw new Error(`invalid or duplicate WPT subtest start: ${test.id}`);
			}
			occurrences.add(occurrenceKey);
			started.set(test.id, test);
			active.set(test.id, test);
		} else if (line.startsWith("WPT_RESULT ")) {
			const record = object(JSON.parse(line.slice(11)) as unknown, "WPT_RESULT");
			const test = parseTransportTest(record, "WPT_RESULT");
			const activeTest = active.get(test.id);
			if (
				activeTest?.subtest !== test.subtest ||
				activeTest.occurrence !== test.occurrence ||
				finished.has(test.id)
			) {
				throw new Error(`missing start or duplicate WPT subtest result: ${test.id}`);
			}
			finished.add(test.id);
			active.delete(test.id);
			if (
				record.path !== execution.path ||
				(record.status !== "PASS" &&
					record.status !== "FAIL" &&
					record.status !== "TIMEOUT")
			) {
				throw new Error(`invalid WPT result record for ${execution.path}`);
			}
			subtests.push({
				...execution,
				...test,
				status: record.status,
				message: nullableString(record.message, "WPT_RESULT.message"),
			});
		} else if (line.startsWith("WPT_HARNESS ")) {
			if (harness !== null)
				throw new Error(`duplicate WPT harness record for ${execution.path}`);
			const record = object(JSON.parse(line.slice(12)) as unknown, "WPT_HARNESS");
			if (
				record.path !== execution.path ||
				(record.status !== "OK" && record.status !== "ERROR") ||
				!Number.isInteger(record.total) ||
				(record.total as number) < 0
			) {
				throw new Error(`invalid WPT harness record for ${execution.path}`);
			}
			harness = {
				path: execution.path,
				status: record.status,
				total: record.total as number,
				message: nullableString(record.message, "WPT_HARNESS.message"),
			};
		}
	}
	if (terminalStatus !== undefined) {
		for (const test of active.values()) {
			subtests.push({
				...execution,
				...test,
				status: terminalStatus,
				message: `process ${terminalStatus.toLowerCase()}`,
			});
		}
		const activeIds = [...active.keys()];
		return {
			subtests,
			harness: {
				path: execution.path,
				status: "ERROR",
				total: subtests.length,
				message:
					activeIds.length === 0
						? `process ${terminalStatus.toLowerCase()} outside an active WPT subtest`
						: activeIds.length === 1
							? `process ${terminalStatus.toLowerCase()} during subtest id ${activeIds[0]}`
							: `process ${terminalStatus.toLowerCase()} during subtest ids ${activeIds.join(", ")}`,
			},
		};
	}
	if (
		harness === null ||
		harness.total !== subtests.length ||
		started.size !== finished.size ||
		active.size !== 0 ||
		(harness.status === "OK" && subtests.length === 0)
	) {
		throw new Error(`incomplete WPT output for ${execution.path}`);
	}
	return { subtests, harness };
}

function expectationKey(value: {
	testPath?: string;
	path?: string;
	variant: string;
	backend: WptBackend;
	mode: WptMode;
	subtest: string;
	occurrence: number;
}): string {
	return [
		value.testPath ?? value.path,
		value.variant,
		value.backend,
		value.mode,
		value.subtest,
		value.occurrence,
	].join("\0");
}

export function classifyWptResults(
	results: Array<WptSubtestResult>,
	expectations: Array<WptExpectation>,
): { results: Array<WptClassification>; missing: Array<WptExpectation> } {
	const remaining = new Map(expectations.map((item) => [expectationKey(item), item]));
	const classified = results.map((result) => {
		const key = expectationKey(result);
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
