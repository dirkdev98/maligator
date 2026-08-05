export type TestCallback = () => unknown;
export type HookCallback = TestCallback;
export type Constructor = abstract new (...args: Array<never>) => unknown;

export interface TestFunction {
	(name: string, callback: TestCallback): void;
	skip(name: string, callback: TestCallback): void;
	todo(name: string): void;
	only(name: string, callback: TestCallback): void;
	each<const Row extends ReadonlyArray<unknown>>(
		rows: ReadonlyArray<Row>,
	): (name: string, callback: (...values: [...Row]) => unknown) => void;
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
	readonly resolves: AsyncMatchers;
	readonly rejects: AsyncMatchers;
	toBe(expected: unknown): void;
	toEqual(expected: unknown): void;
	toStrictEqual(expected: unknown): void;
	toBeDefined(): void;
	toBeUndefined(): void;
	toBeNull(): void;
	toBeTruthy(): void;
	toBeFalsy(): void;
	toContain(expected: unknown): void;
	toHaveLength(expected: number): void;
	toMatch(expected: string | RegExp): void;
	toMatchObject(expected: object): void;
	toThrow(
		expected?: string | RegExp | Error | (abstract new (...args: Array<never>) => Error),
	): void;
}

export interface AsyncMatchers {
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
		expected?: string | RegExp | Error | (abstract new (...args: Array<never>) => Error),
	): Promise<void>;
}

export interface ExpectFunction {
	(received: unknown): Matchers;
	any(constructorValue: Constructor): AsymmetricMatcher;
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
