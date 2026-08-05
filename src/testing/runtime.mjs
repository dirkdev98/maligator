const ASYMMETRIC = "__maligator_asymmetric__";

class MaligatorAssertionError extends Error {
	constructor(details, captured) {
		super(details.message);
		this.name = "AssertionError";
		this.matcher = details.matcher;
		this.expected = details.expected;
		this.received = details.received;
		this.diff = details.diff;
		if (captured && typeof captured.stack === "string") {
			const firstNewline = captured.stack.indexOf("\n");
			const frames = firstNewline < 0 ? "" : captured.stack.slice(firstNewline);
			this.stack = `${this.name}: ${this.message}${frames}`;
		}
	}
}

function primitive(value) {
	return value === null || (typeof value !== "object" && typeof value !== "function");
}

function sameValue(left, right) {
	return Object.is(left, right);
}

function asymmetricMatch(pattern, received, seen) {
	if (!pattern || typeof pattern !== "object" || !(ASYMMETRIC in pattern)) {
		return null;
	}
	switch (pattern[ASYMMETRIC]) {
		case "any":
			if (pattern.constructorValue === String) return typeof received === "string";
			if (pattern.constructorValue === Number) return typeof received === "number";
			if (pattern.constructorValue === Boolean) return typeof received === "boolean";
			if (pattern.constructorValue === BigInt) return typeof received === "bigint";
			if (pattern.constructorValue === Symbol) return typeof received === "symbol";
			if (pattern.constructorValue === Function) return typeof received === "function";
			return received instanceof pattern.constructorValue;
		case "anything":
			return received !== null && received !== undefined;
		case "stringMatching":
			return (
				typeof received === "string" &&
				(typeof pattern.pattern === "string"
					? received.includes(pattern.pattern)
					: pattern.pattern.test(received))
			);
		case "objectContaining":
			return deepEqual(received, pattern.value, false, seen, true);
		case "arrayContaining":
			return (
				Array.isArray(received) &&
				pattern.value.every((expected) =>
					received.some((item) => deepEqual(item, expected, false, seen)),
				)
			);
		default:
			return false;
	}
}

function deepEqual(received, expected, strict, seen = new Map(), subset = false) {
	const asymmetric = asymmetricMatch(expected, received, seen);
	if (asymmetric !== null) return asymmetric;
	if (sameValue(received, expected)) return true;
	if (primitive(received) || primitive(expected)) return false;
	if (typeof received !== typeof expected) return false;

	const prior = seen.get(expected);
	if (prior !== undefined) return prior === received;
	seen.set(expected, received);

	if (received instanceof Date || expected instanceof Date) {
		return (
			received instanceof Date &&
			expected instanceof Date &&
			received.getTime() === expected.getTime()
		);
	}
	if (received instanceof RegExp || expected instanceof RegExp) {
		return (
			received instanceof RegExp &&
			expected instanceof RegExp &&
			received.source === expected.source &&
			received.flags === expected.flags
		);
	}
	if (Array.isArray(received) || Array.isArray(expected)) {
		if (!Array.isArray(received) || !Array.isArray(expected)) return false;
		if (!subset && received.length !== expected.length) return false;
		if (subset && received.length < expected.length) return false;
		for (let index = 0; index < expected.length; index++) {
			if (strict && index in received !== index in expected) return false;
			if (!deepEqual(received[index], expected[index], strict, seen)) return false;
		}
		return true;
	}
	if (strict && Object.getPrototypeOf(received) !== Object.getPrototypeOf(expected)) {
		return false;
	}
	const receivedKeys = Object.keys(received).sort();
	const expectedKeys = Object.keys(expected).sort();
	if (!subset && receivedKeys.length !== expectedKeys.length) return false;
	for (const key of expectedKeys) {
		if (!Object.prototype.hasOwnProperty.call(received, key)) return false;
		if (!deepEqual(received[key], expected[key], strict, seen)) return false;
	}
	return true;
}

function formatValue(value, seen = new Set(), depth = 0) {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (Object.is(value, -0)) return "-0";
		if (Number.isNaN(value)) return "NaN";
		return String(value);
	}
	if (
		value === null ||
		value === undefined ||
		typeof value === "boolean" ||
		typeof value === "bigint" ||
		typeof value === "symbol"
	) {
		return String(value);
	}
	if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
	const asymmetric = value && value[ASYMMETRIC];
	if (asymmetric) {
		if (asymmetric === "anything") return "expect.anything()";
		if (asymmetric === "any")
			return `expect.any(${value.constructorValue?.name || "unknown"})`;
		return `expect.${asymmetric}(${formatValue(value.value ?? value.pattern)})`;
	}
	if (seen.has(value)) return "[Circular]";
	if (depth >= 5) return Array.isArray(value) ? "[…]" : "{…}";
	seen.add(value);
	let result;
	if (Array.isArray(value)) {
		result = `[${value.map((item) => formatValue(item, seen, depth + 1)).join(", ")}]`;
	} else if (value instanceof Date) {
		result = `Date(${JSON.stringify(value.toISOString())})`;
	} else if (value instanceof RegExp) {
		result = String(value);
	} else if (value instanceof Error) {
		result = `${value.name}: ${value.message}`;
	} else {
		const entries = Object.keys(value)
			.sort()
			.map((key) => `${key}: ${formatValue(value[key], seen, depth + 1)}`);
		result = `{ ${entries.join(", ")} }`;
	}
	seen.delete(value);
	return result;
}

function structuralDiff(expected, received) {
	const expectedText = formatValue(expected);
	const receivedText = formatValue(received);
	if (expectedText === receivedText) return undefined;
	return `- expected\n+ received\n- ${expectedText}\n+ ${receivedText}`;
}

function failure(matcher, expected, received, captured, detail) {
	const expectedText = formatValue(expected);
	const receivedText = formatValue(received);
	const message =
		detail ?? `${matcher} failed\nexpected: ${expectedText}\nreceived: ${receivedText}`;
	throw new MaligatorAssertionError(
		{
			matcher,
			message,
			expected: expectedText,
			received: receivedText,
			diff: structuralDiff(expected, received),
		},
		captured,
	);
}

function thrownMatches(error, expected) {
	if (expected === undefined) return true;
	if (typeof expected === "string")
		return String(error?.message ?? error).includes(expected);
	if (expected instanceof RegExp) return expected.test(String(error?.message ?? error));
	if (typeof expected === "function") return error instanceof expected;
	if (expected instanceof Error) {
		return (
			error instanceof Error &&
			error.name === expected.name &&
			error.message === expected.message
		);
	}
	return false;
}

function applyMatcher(
	name,
	received,
	expected,
	negate,
	captured,
	rejectionValue = false,
) {
	let pass;
	switch (name) {
		case "toBe":
			pass = sameValue(received, expected);
			break;
		case "toEqual":
			pass = deepEqual(received, expected, false);
			break;
		case "toStrictEqual":
			pass = deepEqual(received, expected, true);
			break;
		case "toBeDefined":
			pass = received !== undefined;
			break;
		case "toBeUndefined":
			pass = received === undefined;
			break;
		case "toBeNull":
			pass = received === null;
			break;
		case "toBeTruthy":
			pass = Boolean(received);
			break;
		case "toBeFalsy":
			pass = !received;
			break;
		case "toContain":
			pass =
				typeof received === "string"
					? received.includes(expected)
					: Array.isArray(received) &&
						received.some((item) => deepEqual(item, expected, false));
			break;
		case "toHaveLength":
			pass = received != null && received.length === expected;
			break;
		case "toMatch":
			pass =
				typeof received === "string" &&
				(typeof expected === "string"
					? received.includes(expected)
					: expected instanceof RegExp && expected.test(received));
			break;
		case "toMatchObject":
			pass = deepEqual(received, expected, false, new Map(), true);
			break;
		case "toThrow": {
			let thrown = rejectionValue;
			let error = received;
			if (!rejectionValue) {
				if (typeof received !== "function") {
					failure(
						name,
						expected,
						received,
						captured,
						"toThrow requires a function, or a rejected promise through .rejects",
					);
				}
				try {
					received();
					thrown = false;
				} catch (caught) {
					thrown = true;
					error = caught;
				}
			}
			pass = thrown && thrownMatches(error, expected);
			received = thrown ? error : "function did not throw";
			break;
		}
		default:
			throw new Error(`Unknown matcher ${name}`);
	}
	if (negate ? pass : !pass) {
		failure(
			`${negate ? "not." : ""}${name}`,
			expected,
			received,
			captured,
			`${negate ? "negated " : ""}${name} failed\nexpected: ${formatValue(
				expected,
			)}\nreceived: ${formatValue(received)}`,
		);
	}
}

const MATCHERS = [
	"toBe",
	"toEqual",
	"toStrictEqual",
	"toBeDefined",
	"toBeUndefined",
	"toBeNull",
	"toBeTruthy",
	"toBeFalsy",
	"toContain",
	"toHaveLength",
	"toMatch",
	"toMatchObject",
	"toThrow",
];

function matcherObject(received, state, captured) {
	const object = {};
	for (const name of MATCHERS) {
		object[name] = (expected) => {
			if (state.promiseMode === undefined) {
				return applyMatcher(name, received, expected, state.negate, captured);
			}
			return Promise.resolve(received).then(
				(value) => {
					if (state.promiseMode === "rejects") {
						failure(
							"rejects",
							"a rejected promise",
							value,
							captured,
							"Expected the promise to reject, but it resolved",
						);
					}
					return applyMatcher(name, value, expected, state.negate, captured);
				},
				(error) => {
					if (state.promiseMode === "resolves") {
						failure(
							"resolves",
							"a resolved promise",
							error,
							captured,
							"Expected the promise to resolve, but it rejected",
						);
					}
					return applyMatcher(
						name,
						error,
						expected,
						state.negate,
						captured,
						name === "toThrow",
					);
				},
			);
		};
	}
	Object.defineProperty(object, "not", {
		enumerable: true,
		get() {
			return matcherObject(received, { ...state, negate: !state.negate }, captured);
		},
	});
	Object.defineProperty(object, "resolves", {
		enumerable: true,
		get() {
			return matcherObject(received, { ...state, promiseMode: "resolves" }, captured);
		},
	});
	Object.defineProperty(object, "rejects", {
		enumerable: true,
		get() {
			return matcherObject(received, { ...state, promiseMode: "rejects" }, captured);
		},
	});
	return object;
}

export function expect(received) {
	return matcherObject(received, { negate: false, promiseMode: undefined }, new Error());
}

expect.any = function any(constructorValue) {
	if (typeof constructorValue !== "function") {
		throw new TypeError("expect.any requires a constructor");
	}
	return { [ASYMMETRIC]: "any", constructorValue };
};
expect.anything = function anything() {
	return { [ASYMMETRIC]: "anything" };
};
expect.stringMatching = function stringMatching(pattern) {
	if (typeof pattern !== "string" && !(pattern instanceof RegExp)) {
		throw new TypeError("expect.stringMatching requires a string or RegExp");
	}
	return { [ASYMMETRIC]: "stringMatching", pattern };
};
expect.objectContaining = function objectContaining(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("expect.objectContaining requires an object");
	}
	return { [ASYMMETRIC]: "objectContaining", value };
};
expect.arrayContaining = function arrayContaining(value) {
	if (!Array.isArray(value)) {
		throw new TypeError("expect.arrayContaining requires an array");
	}
	return { [ASYMMETRIC]: "arrayContaining", value };
};

let registrationIndex = 0;

function createSuite(name, parent, mode = "normal") {
	return {
		name,
		parent,
		mode,
		index: registrationIndex++,
		suites: [],
		tests: [],
		hooks: { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] },
	};
}

let root = createSuite("", null);
let currentSuite = root;

function requireCallback(kind, callback) {
	if (typeof callback !== "function") throw new TypeError(`${kind} requires a callback`);
}

function registerTest(name, callback, mode) {
	if (typeof name !== "string" || name.length === 0) {
		throw new TypeError("test name must be a non-empty string");
	}
	if (mode !== "todo") requireCallback("test", callback);
	currentSuite.tests.push({
		name,
		callback,
		mode,
		index: registrationIndex++,
		suite: currentSuite,
	});
}

export function test(name, callback) {
	registerTest(name, callback, "normal");
}
test.skip = (name, callback) => registerTest(name, callback, "skip");
test.todo = (name) => registerTest(name, undefined, "todo");
test.only = (name, callback) => registerTest(name, callback, "only");
test.each = (rows) => {
	if (!Array.isArray(rows)) throw new TypeError("test.each requires an array");
	return (name, callback) => {
		requireCallback("test.each", callback);
		rows.forEach((row, index) => {
			const args = Array.isArray(row) ? row : [row];
			const rowName = name.replaceAll("%#", String(index));
			registerTest(rowName, () => callback(...args), "normal");
		});
	};
};

function registerSuite(name, callback, mode) {
	if (typeof name !== "string" || name.length === 0) {
		throw new TypeError("describe name must be a non-empty string");
	}
	requireCallback("describe", callback);
	const suite = createSuite(name, currentSuite, mode);
	currentSuite.suites.push(suite);
	const previous = currentSuite;
	currentSuite = suite;
	try {
		const result = callback();
		if (result && typeof result.then === "function") {
			throw new TypeError("describe callbacks must be synchronous");
		}
	} finally {
		currentSuite = previous;
	}
}

export function describe(name, callback) {
	registerSuite(name, callback, "normal");
}
describe.skip = (name, callback) => registerSuite(name, callback, "skip");
describe.only = (name, callback) => registerSuite(name, callback, "only");

function registerHook(name, callback) {
	requireCallback(name, callback);
	currentSuite.hooks[name].push({ callback, index: registrationIndex++ });
}

export const beforeAll = (callback) => registerHook("beforeAll", callback);
export const afterAll = (callback) => registerHook("afterAll", callback);
export const beforeEach = (callback) => registerHook("beforeEach", callback);
export const afterEach = (callback) => registerHook("afterEach", callback);

function fullSuiteName(suite) {
	const names = [];
	for (let at = suite; at && at.parent; at = at.parent) names.push(at.name);
	return names.reverse().join(" > ");
}

function fullTestName(testCase) {
	const suite = fullSuiteName(testCase.suite);
	return suite ? `${suite} > ${testCase.name}` : testCase.name;
}

function suiteOrAncestorMode(suite, mode) {
	for (let at = suite; at; at = at.parent) {
		if (at.mode === mode) return true;
	}
	return false;
}

function collectTests(suite, output = []) {
	output.push(...suite.tests);
	for (const child of suite.suites) collectTests(child, output);
	return output;
}

function hasOnly() {
	return collectTests(root).some(
		(testCase) => testCase.mode === "only" || suiteOrAncestorMode(testCase.suite, "only"),
	);
}

function selected(testCase, options, focused) {
	if (
		options.nameFilter !== undefined &&
		!fullTestName(testCase).includes(options.nameFilter)
	) {
		return false;
	}
	if (
		testCase.mode === "skip" ||
		testCase.mode === "todo" ||
		suiteOrAncestorMode(testCase.suite, "skip")
	) {
		return !focused || suiteOrAncestorMode(testCase.suite, "only");
	}
	if (
		focused &&
		testCase.mode !== "only" &&
		!suiteOrAncestorMode(testCase.suite, "only")
	) {
		return false;
	}
	return true;
}

function shuffled(values, random) {
	const result = [...values];
	if (!random) return result;
	for (let index = result.length - 1; index > 0; index--) {
		const selectedIndex = Math.floor(random() * (index + 1));
		[result[index], result[selectedIndex]] = [result[selectedIndex], result[index]];
	}
	return result;
}

function seededRandom(seed) {
	let state = seed >>> 0;
	if (state === 0) state = 0x9e3779b9;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 4294967296;
	};
}

function compactStack(stack) {
	if (typeof stack !== "string") return undefined;
	const lines = stack.split("\n");
	const kept = lines.filter(
		(line, index) =>
			index === 0 ||
			(!line.includes("maligator:test") && !line.includes("/testing/runtime.mjs")),
	);
	return kept.join("\n");
}

function serializeFailure(error, kind) {
	const value = error instanceof Error ? error : new Error(formatValue(error));
	return {
		kind: value instanceof MaligatorAssertionError ? "assertion" : kind,
		name: value.name,
		message: value.message,
		stack: compactStack(value.stack),
		...(value.matcher === undefined ? {} : { matcher: value.matcher }),
		...(value.expected === undefined ? {} : { expected: value.expected }),
		...(value.received === undefined ? {} : { received: value.received }),
		...(value.diff === undefined ? {} : { diff: value.diff }),
	};
}

async function callWithTimeout(callback, timeoutMs) {
	if (!(timeoutMs > 0) || typeof globalThis.setTimeout !== "function") {
		return await callback();
	}
	let timer;
	try {
		return await Promise.race([
			Promise.resolve().then(callback),
			new Promise((_, reject) => {
				timer = globalThis.setTimeout(() => {
					const error = new Error(`Timed out after ${timeoutMs}ms`);
					error.name = "TimeoutError";
					reject(error);
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined && typeof globalThis.clearTimeout === "function") {
			globalThis.clearTimeout(timer);
		}
	}
}

function hookChain(suite, name) {
	const suites = [];
	for (let at = suite; at; at = at.parent) suites.push(at);
	if (name === "beforeEach") suites.reverse();
	return suites.flatMap((item) => item.hooks[name]);
}

export async function __run(options) {
	const startedAt = Date.now();
	const events = [];
	let sequence = 0;
	const emit = (event) => events.push({ ...event, sequence: sequence++ });
	const result = {
		events,
		passed: 0,
		failed: 0,
		skipped: 0,
		todo: 0,
		durationMs: 0,
		focused: hasOnly(),
	};
	const random =
		options.shuffleSeed === undefined ? undefined : seededRandom(options.shuffleSeed);
	if (result.focused) {
		emit({
			type: "diagnostic",
			level: "warning",
			message: "Focused tests are active because .only was registered",
		});
	}

	const runHook = async (hook, hookName, ownerName) => {
		try {
			await callWithTimeout(hook.callback, options.timeoutMs);
			return undefined;
		} catch (error) {
			const failure = serializeFailure(
				error,
				error?.name === "TimeoutError" ? "timeout" : "hook",
			);
			emit({ type: "hook-fail", name: ownerName, hook: hookName, failure });
			return failure;
		}
	};

	const runTest = async (testCase) => {
		const name = fullTestName(testCase);
		if (testCase.mode === "todo") {
			result.todo++;
			emit({ type: "test-todo", name });
			return;
		}
		if (testCase.mode === "skip" || suiteOrAncestorMode(testCase.suite, "skip")) {
			result.skipped++;
			emit({ type: "test-skip", name });
			return;
		}
		const testStartedAt = Date.now();
		const failures = [];
		emit({ type: "test-start", name });
		for (const hook of hookChain(testCase.suite, "beforeEach")) {
			const hookFailure = await runHook(hook, "beforeEach", name);
			if (hookFailure) failures.push(hookFailure);
		}
		if (failures.length === 0) {
			try {
				await callWithTimeout(testCase.callback, options.timeoutMs);
			} catch (error) {
				failures.push(
					serializeFailure(error, error?.name === "TimeoutError" ? "timeout" : "test"),
				);
			}
		}
		for (const hook of hookChain(testCase.suite, "afterEach")) {
			const hookFailure = await runHook(hook, "afterEach", name);
			if (hookFailure) failures.push(hookFailure);
		}
		const durationMs = Date.now() - testStartedAt;
		if (failures.length === 0) {
			result.passed++;
			emit({ type: "test-pass", name, durationMs });
		} else {
			result.failed++;
			emit({ type: "test-fail", name, durationMs, failures });
		}
	};

	const runSuite = async (suite) => {
		const suiteName = fullSuiteName(suite);
		if (suite.parent) emit({ type: "suite-start", name: suiteName });
		let beforeAllFailed = false;
		for (const hook of suite.hooks.beforeAll) {
			if (await runHook(hook, "beforeAll", suiteName)) {
				beforeAllFailed = true;
				result.failed++;
			}
		}
		if (!beforeAllFailed) {
			const entries = [
				...suite.tests.map((value) => ({ kind: "test", value })),
				...suite.suites.map((value) => ({ kind: "suite", value })),
			].sort((left, right) => left.value.index - right.value.index);
			for (const entry of shuffled(entries, random)) {
				if (entry.kind === "test") {
					if (selected(entry.value, options, result.focused)) {
						await runTest(entry.value);
					}
				} else {
					const selectedDescendants = collectTests(entry.value).some((testCase) =>
						selected(testCase, options, result.focused),
					);
					if (selectedDescendants) await runSuite(entry.value);
				}
				if (options.bail && result.failed > 0) break;
			}
		}
		for (const hook of suite.hooks.afterAll) {
			if (await runHook(hook, "afterAll", suiteName)) result.failed++;
		}
		if (suite.parent) emit({ type: "suite-end", name: suiteName });
	};

	for (let repeat = 1; repeat <= options.repeat; repeat++) {
		emit({ type: "run-start", repeat });
		await runSuite(root);
		if (options.bail && result.failed > 0) break;
	}
	result.durationMs = Date.now() - startedAt;
	emit({
		type: "run-end",
		passed: result.passed,
		failed: result.failed,
		skipped: result.skipped,
		todo: result.todo,
		durationMs: result.durationMs,
	});
	return result;
}

export function __reset() {
	registrationIndex = 0;
	root = createSuite("", null);
	currentSuite = root;
}
