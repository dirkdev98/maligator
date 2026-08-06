import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as runtime from "../src/testing/runtime.mjs";

const run = (
	options: Partial<Parameters<typeof runtime.__run>[0]> = {},
): ReturnType<typeof runtime.__run> =>
	runtime.__run({
		repeat: 1,
		bail: false,
		timeoutMs: 1000,
		...options,
	});

beforeEach(() => runtime.__reset());
afterEach(() => runtime.__reset());

describe("registration and lifecycle", () => {
	test("keeps implicit test-file hooks and results separate in a shared realm", async () => {
		const calls: Array<string> = [];
		runtime.__beginFile("a.test.ts");
		runtime.beforeEach(() => calls.push("a beforeEach"));
		runtime.test("first", () => calls.push("a test"));
		runtime.__endFile();
		runtime.__beginFile("b.test.ts");
		runtime.beforeEach(() => calls.push("b beforeEach"));
		runtime.test("second", () => calls.push("b test"));
		runtime.__endFile();

		const result = await run();
		expect(calls).toEqual(["a beforeEach", "a test", "b beforeEach", "b test"]);
		expect(result.files.map(({ durationMs: _durationMs, ...file }) => file)).toEqual([
			{
				file: "a.test.ts",
				passed: 1,
				failed: 0,
				skipped: 0,
				todo: 0,
			},
			{
				file: "b.test.ts",
				passed: 1,
				failed: 0,
				skipped: 0,
				todo: 0,
			},
		]);
		expect(result.files.every((file) => typeof file.durationMs === "number")).toBe(true);
		expect(
			result.events.find(
				(event) => event.type === "test-pass" && event.name?.endsWith("first") === true,
			),
		).toMatchObject({ file: "a.test.ts" });

		calls.length = 0;
		const selected = await run({ files: ["b.test.ts"] });
		expect(calls).toEqual(["b beforeEach", "b test"]);
		expect(selected.files.map((file) => file.file)).toEqual(["b.test.ts"]);
	});

	test("ignores focused tests outside a selected cached-image entry", async () => {
		const calls: Array<string> = [];
		runtime.__beginFile("focused.test.ts");
		runtime.test.only("focused elsewhere", () => calls.push("focused"));
		runtime.__endFile();
		runtime.__beginFile("selected.test.ts");
		runtime.test("selected", () => calls.push("selected"));
		runtime.__endFile();

		const result = await run({ files: ["selected.test.ts"] });
		expect(result.focused).toBe(false);
		expect(result.passed).toBe(1);
		expect(calls).toEqual(["selected"]);
	});

	test("registers nested names and orders hooks", async () => {
		const calls: Array<string> = [];
		runtime.beforeAll(() => calls.push("outer beforeAll"));
		runtime.afterAll(() => calls.push("outer afterAll"));
		runtime.beforeEach(() => calls.push("outer beforeEach"));
		runtime.afterEach(() => calls.push("outer afterEach"));
		runtime.describe("store", () => {
			runtime.beforeAll(() => calls.push("inner beforeAll"));
			runtime.afterAll(() => calls.push("inner afterAll"));
			runtime.beforeEach(() => calls.push("inner beforeEach"));
			runtime.afterEach(() => calls.push("inner afterEach"));
			runtime.test("works", () => calls.push("test"));
		});

		const result = await run();
		expect(result.failed).toBe(0);
		expect(result.passed).toBe(1);
		expect(
			result.events.some(
				(event) => event.type === "test-pass" && event.name === "store > works",
			),
		).toBe(true);
		expect(calls).toEqual([
			"outer beforeAll",
			"inner beforeAll",
			"outer beforeEach",
			"inner beforeEach",
			"test",
			"inner afterEach",
			"outer afterEach",
			"inner afterAll",
			"outer afterAll",
		]);
	});

	test("awaits tests and reports hook failures against the test", async () => {
		runtime.describe("async", () => {
			runtime.beforeEach(async () => Promise.resolve());
			runtime.afterEach(() => {
				throw new Error("cleanup failed");
			});
			runtime.test("settles", async () => Promise.resolve());
		});

		const result = await run();
		expect(result.failed).toBe(1);
		const failed = result.events.find((event) => event.type === "test-fail");
		expect(failed).toMatchObject({
			name: "async > settles",
			failures: [{ kind: "hook", message: "cleanup failed" }],
		});
	});

	test("supports skip, todo, only, filtering, repeat, and deterministic shuffle", async () => {
		const order: Array<string> = [];
		runtime.test("normal", () => order.push("normal"));
		runtime.test.skip("skipped", () => order.push("skipped"));
		runtime.test.todo("later");
		runtime.describe("focused", () => {
			runtime.test.only("one", () => order.push("one"));
			runtime.test.only("two", () => order.push("two"));
		});

		const first = await run({ repeat: 2, shuffleSeed: 18492 });
		const firstOrder = [...order];
		runtime.__reset();
		order.length = 0;
		runtime.test("normal", () => order.push("normal"));
		runtime.test.skip("skipped", () => order.push("skipped"));
		runtime.test.todo("later");
		runtime.describe("focused", () => {
			runtime.test.only("one", () => order.push("one"));
			runtime.test.only("two", () => order.push("two"));
		});
		const second = await run({ repeat: 2, shuffleSeed: 18492 });

		expect(first.focused).toBe(true);
		expect(first.passed).toBe(4);
		expect(first.skipped).toBe(0);
		expect(first.todo).toBe(0);
		const diagnostic = first.events.find((event) => event.type === "diagnostic");
		expect(diagnostic).toMatchObject({ type: "diagnostic", level: "warning" });
		expect(diagnostic?.message).toContain(".only");
		expect(firstOrder).toEqual(order);
		expect(first.events.map((event) => event.type)).toEqual(
			second.events.map((event) => event.type),
		);
	});

	test("filters skipped and todo tests by hierarchical name", async () => {
		runtime.describe("router", () => {
			runtime.test.skip("skipped", () => {});
			runtime.test.todo("later");
		});
		runtime.describe("store", () => {
			runtime.test.skip("skipped", () => {});
			runtime.test.todo("later");
		});

		const result = await run({ nameFilter: "router" });
		expect(result.skipped).toBe(1);
		expect(result.todo).toBe(1);
		expect(
			result.events
				.filter((event) => event.type === "test-skip" || event.type === "test-todo")
				.every((event) => event.name?.startsWith("router >") === true),
		).toBe(true);
	});

	test("classifies timeouts and suite hook failures", async () => {
		runtime.describe("broken setup", () => {
			runtime.beforeAll(() => {
				throw new Error("suite setup failed");
			});
			runtime.test("does not run", () => {
				throw new Error("unreachable");
			});
		});
		runtime.test("times out", () => new Promise(() => {}));

		const result = await run({ timeoutMs: 5 });
		expect(result.failed).toBe(2);
		const hookFailure = result.events.find((event) => event.type === "hook-fail");
		expect(hookFailure).toMatchObject({
			type: "hook-fail",
			name: "broken setup",
			hook: "beforeAll",
			failure: { kind: "hook" },
		});
		const timeoutFailure = result.events.find(
			(event) => event.type === "test-fail" && event.name === "times out",
		);
		expect(timeoutFailure).toMatchObject({
			type: "test-fail",
			name: "times out",
			failures: [{ kind: "timeout" }],
		});
	});
});

describe("matchers", () => {
	test("supports scalar, structural, negated, and asymmetric assertions", () => {
		void runtime.expect(1).toBe(1);
		void runtime.expect({ value: [1, 2] }).toEqual({ value: [1, 2] });
		void runtime.expect({ value: 1 }).not.toEqual({ value: 2 });
		void runtime
			.expect({ name: "router", nested: { value: 4 }, extra: true })
			.toMatchObject({
				name: runtime.expect.stringMatching(/^route/),
				nested: runtime.expect.objectContaining({ value: runtime.expect.any(Number) }),
			});
		void runtime
			.expect(["alpha", { id: 2 }, true])
			.toEqual([
				runtime.expect.any(String),
				runtime.expect.objectContaining({ id: 2 }),
				runtime.expect.anything(),
			]);
	});

	test("matches object properties recursively while preserving exact arrays", () => {
		void runtime
			.expect({ extra: true, value: { detail: "kept", score: 1 } })
			.toMatchObject({ value: { score: 1 } });
		void runtime
			.expect({ rows: [{ detail: "kept", score: 1 }] })
			.toMatchObject({ rows: [{ score: 1 }] });

		expect(() => {
			void runtime
				.expect({ rows: [{ score: 1 }, { score: 2 }] })
				.toMatchObject({ rows: [{ score: 1 }] });
		}).toThrow(/toMatchObject failed/);
		expect(() => {
			void runtime
				.expect({ value: { detail: "kept", score: 1 } })
				.toMatchObject({ value: { score: 2 } });
		}).toThrow(/toMatchObject failed/);
	});

	test("supports resolves, rejects, and throw matching", async () => {
		await runtime.expect(Promise.resolve({ answer: 42 })).resolves.toEqual({
			answer: 42,
		});
		await runtime
			.expect(Promise.reject(new TypeError("duplicate key")))
			.rejects.toThrow(TypeError);
		void runtime
			.expect(() => {
				throw new Error("bad route");
			})
			.toThrow(/route/);
	});

	test("returns owned assertion details and a structural diff", async () => {
		runtime.test("failure", () => {
			void runtime.expect({ status: 200, body: [1, 2] }).toEqual({
				status: 400,
				body: [1, 3],
			});
		});

		const result = await run();
		const failed = result.events.find((event) => event.type === "test-fail");
		expect(failed?.failures?.[0]).toMatchObject({
			kind: "assertion",
			matcher: "toEqual",
		});
		expect(failed?.failures?.[0]?.diff).toContain("- expected");
	});
});
