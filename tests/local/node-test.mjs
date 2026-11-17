import assertions from "node:assert";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { test as namedTest, describe, beforeEach, afterEach } from "node:test";

const require = createRequire(import.meta.url);
assert.equal(require("node:test"), test);
assert.equal(namedTest, test);
assert.equal((await import("node:test")).default, test);
assert.equal(require("../fixtures/node-test/require-override.mjs").answer, 42);
const mode = process.argv[2] ?? "pass";

if (mode === "pass") {
	const equal = assertions.equal;
	assertions.equal = function (...values) {
		return { receiver: this, values };
	};
	test("forwards an assertion's receiver and return value", (t) => {
		t.plan(1);
		t.after(() => {
			assertions.equal = equal;
		});
		const result = t.assert.equal(7, "7");
		assert.equal(result.receiver, assertions);
		assert.deepEqual(result.values, [7, "7"]);
	});
	const order = [];
	describe("synchronous suite collection", () => {
		order.push("collected");
		beforeEach(() => order.push("before"));
		afterEach(() => order.push("after"));
		test("awaits async bodies and counts context assertions", async (t) => {
			t.plan(2);
			await Promise.resolve();
			t.assert.strictEqual(order.join(","), "collected,before");
			t.assert.ok(true);
			t.after(() => {
				assert.equal(t.signal.aborted, false);
				order.push("cleanup");
			});
		});
	});
	assert.deepEqual(order, ["collected"]);
	test("keeps a detached assertion's original method", (t) => {
		t.plan(1);
		const ok = t.assert.ok;
		const original = assertions.ok;
		try {
			assertions.ok = () => {
				throw new Error("replacement assertion ran");
			};
			ok(true);
		} finally {
			assertions.ok = original;
		}
	});
	test("returns promises from detached assertions", async (t) => {
		t.plan(1);
		const rejects = t.assert.rejects;
		await rejects(Promise.reject(new Error("fixture rejection")), /fixture rejection/);
	});
	test("counts a caught assertion failure", (t) => {
		t.plan(1);
		assert.throws(() => t.assert.strictEqual(1, 2), assert.AssertionError);
	});
	test.skip("skipped body", () => {
		throw new Error("skip executed");
	});
	test.todo("todo body runs", () => {
		console.log("TODO EXECUTED");
		throw new Error("expected todo failure");
	});
	test("finishes earlier cleanup before the next test", (t) => {
		t.assert.deepStrictEqual(order, ["collected", "before", "after", "cleanup"]);
		console.log("NODE TEST PASS");
	});
	test(
		"uses a callback and assertion plan supplied through options",
		{
			plan: 1,
			fn(t) {
				t.assert.equal(1, "1");
				console.log("OPTIONS CALLBACK PASS");
			},
		},
		() => {
			throw new Error("positional callback took precedence");
		},
	);
} else if (mode === "plan") {
	test("detects a missing assertion", (t) => {
		t.plan(2);
		t.assert.ok(true);
		t.after(() => console.log("CLEANUP RAN"));
	});
} else if (mode === "options-plan") {
	test("enforces an assertion plan supplied through options", { plan: 1 }, (t) => {
		t.after(() => console.log("CLEANUP RAN"));
	});
} else if (mode === "options-fn") {
	test({
		fn(t) {
			t.after(() => console.log("CLEANUP RAN"));
			throw new Error("options callback failed");
		},
	});
} else if (mode === "body") {
	test("runs cleanup after body failure", (t) => {
		t.after(() => console.log("CLEANUP RAN"));
		throw new Error("body failed");
	});
} else if (mode === "cleanup") {
	test("reports cleanup failure and stops that hook group", (t) => {
		t.after(() => console.log("CLEANUP RAN"));
		t.after(() => {
			throw new Error("cleanup failed");
		});
		t.after(() => console.log("UNEXPECTED LATER CLEANUP"));
	});
} else if (mode === "idle") {
	test("cancels unresolved work at host idle", (t) => {
		t.after(() => console.log("CLEANUP RAN"));
		return new Promise(() => {});
	});
} else if (mode === "timeout") {
	test(
		"honors an explicit deadline while other work is referenced",
		{ timeout: 10 },
		(t) => {
			const timer = setTimeout(() => {}, 30_000);
			t.after(() => {
				clearTimeout(timer);
				console.log("CLEANUP RAN");
			});
			return new Promise(() => {});
		},
	);
} else if (mode === "undefined") {
	test("reports a thrown undefined value", (t) => {
		t.after(() => console.log("CLEANUP RAN"));
		throw undefined;
	});
} else throw new Error("Unknown fixture mode");
