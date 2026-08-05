export type TestCallback = () => unknown | PromiseLike<unknown>;
export type HookCallback = TestCallback;

export interface TestFunction {
	(name: string, callback: TestCallback): void;
	skip(name: string, callback: TestCallback): void;
	todo(name: string): void;
	only(name: string, callback: TestCallback): void;
	each(
		rows: Array<unknown | Array<unknown>>,
	): (name: string, callback: (...values: Array<unknown>) => unknown) => void;
}

export interface DescribeFunction {
	(name: string, callback: () => void): void;
	skip(name: string, callback: () => void): void;
	only(name: string, callback: () => void): void;
}

export interface AsymmetricMatcher {
	readonly __maligator_asymmetric__: string;
}

export interface Matchers {
	readonly not: Matchers;
	readonly resolves: Matchers;
	readonly rejects: Matchers;
	toBe(expected: unknown): void | Promise<void>;
	toEqual(expected: unknown): void | Promise<void>;
	toStrictEqual(expected: unknown): void | Promise<void>;
	toBeDefined(): void | Promise<void>;
	toBeUndefined(): void | Promise<void>;
	toBeNull(): void | Promise<void>;
	toBeTruthy(): void | Promise<void>;
	toBeFalsy(): void | Promise<void>;
	toContain(expected: unknown): void | Promise<void>;
	toHaveLength(expected: number): void | Promise<void>;
	toMatch(expected: string | RegExp): void | Promise<void>;
	toMatchObject(expected: object): void | Promise<void>;
	toThrow(
		expected?: string | RegExp | Error | (new (...args: never[]) => Error),
	): void | Promise<void>;
}

export interface ExpectFunction {
	(received: unknown): Matchers;
	any(constructorValue: Function): AsymmetricMatcher;
	anything(): AsymmetricMatcher;
	stringMatching(pattern: string | RegExp): AsymmetricMatcher;
	objectContaining(value: object): AsymmetricMatcher;
	arrayContaining(value: Array<unknown>): AsymmetricMatcher;
}

export const test: TestFunction;
export const describe: DescribeFunction;
export const expect: ExpectFunction;
export function beforeAll(callback: HookCallback): void;
export function afterAll(callback: HookCallback): void;
export function beforeEach(callback: HookCallback): void;
export function afterEach(callback: HookCallback): void;

export interface RuntimeRunOptions {
	nameFilter?: string;
	shuffleSeed?: number;
	repeat: number;
	bail: boolean;
	timeoutMs: number;
}

export interface RuntimeTestFailure {
	kind: string;
	name?: string;
	message: string;
	stack?: string;
	matcher?: string;
	expected?: string;
	received?: string;
	diff?: string;
}

export type RuntimeTestEvent = {
	type: string;
	sequence: number;
	name?: string;
	message?: string;
	failures?: Array<RuntimeTestFailure>;
};

export interface RuntimeRunResult {
	events: Array<RuntimeTestEvent>;
	passed: number;
	failed: number;
	skipped: number;
	todo: number;
	durationMs: number;
	focused: boolean;
}

export function __run(options: RuntimeRunOptions): Promise<RuntimeRunResult>;
export function __reset(): void;
