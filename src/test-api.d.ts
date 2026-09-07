// Generated from src/platform/catalog.ts; edit the catalog and regenerate.
/**
 * Test authoring and assertions. Importing this module does not register tests or
 * install runner globals. Registration and assertions are ordinary effectful calls;
 * the test command initializes its internal runner explicitly. Unused imports can be
 * eliminated.
 */
declare module "maligator:test" {
	/**
	 * A test or hook body. Maligator waits for a returned promise or thenable before
	 * advancing the lifecycle.
	 */
	export type TestCallback = () => unknown;

	/**
	 * A lifecycle hook body, with the same async completion contract as a test.
	 */
	export type HookCallback = TestCallback;

	/**
	 * A constructable value accepted by {@link expect.any}.
	 */
	export type Constructor = abstract new (...args: Array<never>) => unknown;

	/**
	 * Opaque partial-match value produced by helpers such as {@link
	 * expect.objectContaining}. It may be nested inside `toEqual`, `toStrictEqual`, and
	 * `toMatchObject` expectations.
	 */
	export type AsymmetricMatcher = {
		readonly __maligator_asymmetric__: string;
	};

	/**
	 * Matchers for a synchronously received value.
	 */
	export type Matchers = {
		/** Negate the following matcher. */
		readonly not: Matchers;
		/** Wait for the received promise to fulfill, then match its value. */
		readonly resolves: AsyncMatchers;
		/** Wait for the received promise to reject, then match its reason. */
		readonly rejects: AsyncMatchers;
		/** Require ECMAScript `Object.is` identity. */
		toBe(expected: unknown): void;
		/** Recursively compare enumerable object properties and array elements. */
		toEqual(expected: unknown): void;
		/**
		 * Recursively compare values while also requiring matching prototypes and
		 * matching sparse-array holes.
		 */
		toStrictEqual(expected: unknown): void;
		/** Require a value other than `undefined`. */
		toBeDefined(): void;
		/** Require `undefined`. */
		toBeUndefined(): void;
		/** Require `null`. */
		toBeNull(): void;
		/** Require a truthy value. */
		toBeTruthy(): void;
		/** Require a falsy value. */
		toBeFalsy(): void;
		/** Require a string substring or an array element matched by identity. */
		toContain(expected: unknown): void;
		/** Require a numeric `.length` equal to `expected`. */
		toHaveLength(expected: number): void;
		/** Match a string against a substring or regular expression. */
		toMatch(expected: string | RegExp): void;
		/** Recursively require the enumerable properties present in `expected`. */
		toMatchObject(expected: object): void;
		/**
		 * Invoke the received function and require it to throw. The optional
		 * expectation may be a message substring, regular expression, error
		 * constructor, or error instance.
		 */
		toThrow(
			expected?:
				| string
				| RegExp
				| Error
				| (abstract new (...args: Array<never>) => Error),
		): void;
	};

	/**
	 * Promise-returning matcher surface exposed by {@link Matchers.resolves} and {@link
	 * Matchers.rejects}. Await these calls so the test cannot finish before the
	 * assertion.
	 */
	export type AsyncMatchers = {
		/** Negate the following asynchronous matcher. */
		readonly not: AsyncMatchers;
		toBe(expected: unknown): Promise<void>;
		toEqual(expected: unknown): Promise<void>;
		toStrictEqual(expected: unknown): Promise<void>;
		toBeDefined(): Promise<void>;
		toBeUndefined(): Promise<void>;
		toBeNull(): Promise<void>;
		toBeTruthy(): Promise<void>;
		toBeFalsy(): Promise<void>;
		toContain(expected: unknown): Promise<void>;
		toHaveLength(expected: number): Promise<void>;
		toMatch(expected: string | RegExp): Promise<void>;
		toMatchObject(expected: object): Promise<void>;
		toThrow(
			expected?:
				| string
				| RegExp
				| Error
				| (abstract new (...args: Array<never>) => Error),
		): Promise<void>;
	};

	/**
	 * Assertion entrypoint and Maligator-owned asymmetric matcher factories.
	 */
	export type ExpectFunction = {
		/** Create matchers for `received`. The assertion position is captured here. */
		(received: unknown): Matchers;
		/** Match a primitive of the corresponding built-in kind or an instance. */
		any(constructorValue: Constructor): AsymmetricMatcher;
		/** Match any value except `null` and `undefined`. */
		anything(): AsymmetricMatcher;
		/** Match a string containing `pattern` or satisfying the regular expression. */
		stringMatching(pattern: string | RegExp): AsymmetricMatcher;
		/** Match an object containing all recursively matched properties in `value`. */
		objectContaining(value: object): AsymmetricMatcher;
		/** Match an array containing a match for every element in `value`. */
		arrayContaining(value: Array<unknown>): AsymmetricMatcher;
	};

	/**
	 * Register tests in the current suite during module evaluation.
	 */
	export type TestFunction = {
		/** Register a test. Returned promises are awaited by the runner. */
		(name: string, callback: TestCallback): void;
		/** Register a skipped test without invoking its callback. */
		skip(name: string, callback: TestCallback): void;
		/** Register a named placeholder with no callback. */
		todo(name: string): void;
		/**
		 * Register a focused test. When any `.only` exists, non-focused tests are
		 * skipped and the runner emits a warning.
		 */
		only(name: string, callback: TestCallback): void;
		/**
		 * Register one test for each row. Use `%#` in `name` for the zero-based row
		 * index. Array rows are spread into callback parameters.
		 */
		each<const Row extends ReadonlyArray<unknown>>(
			rows: ReadonlyArray<Row>,
		): (name: string, callback: (...values: [...Row]) => unknown) => void;
	};

	/**
	 * Register nested suites synchronously during module evaluation.
	 */
	export type DescribeFunction = {
		/** Register a suite. Suite callbacks must not return a promise. */
		(name: string, callback: () => void): void;
		/** Register a suite whose descendants are skipped. */
		skip(name: string, callback: () => void): void;
		/** Register a focused suite and emit the runner's focused-test warning. */
		only(name: string, callback: () => void): void;
	};

	/**
	 * Register a test in the current suite.
	 */
	export const test: TestFunction;
	/**
	 * Register a nested suite in the current suite.
	 */
	export const describe: DescribeFunction;
	/**
	 * Create fluent matchers for a received value.
	 */
	export const expect: ExpectFunction;
	/**
	 * Run once before tests in the current suite.
	 */
	export const beforeAll: (callback: HookCallback) => void;
	/**
	 * Run once after tests in the current suite, including after test failures.
	 */
	export const afterAll: (callback: HookCallback) => void;
	/**
	 * Run before every selected descendant test. Ancestor hooks run before hooks
	 * declared by a nested suite.
	 */
	export const beforeEach: (callback: HookCallback) => void;
	/**
	 * Run after every selected descendant test. Nested-suite hooks run before ancestor
	 * hooks.
	 */
	export const afterEach: (callback: HookCallback) => void;
}
