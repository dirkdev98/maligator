import assert, { AssertionError, Assert, strict } from "node:assert";
import strictModule from "node:assert/strict";

const show = (label, block) => {
	try {
		block();
		console.log(label, "passed");
	} catch (error) {
		console.log(
			label,
			JSON.stringify({
				name: error.name,
				code: error.code,
				message: error.message,
				operator: error.operator,
				generated: error.generatedMessage,
			}),
		);
	}
};

show("strictEqual numbers", () => assert.strictEqual(1, 2));
show("strictEqual strings", () => assert.strictEqual("a", "b"));
show("strictEqual long strings", () =>
	assert.strictEqual("hello world, this is long", "hello there, this is long"),
);
show("strictEqual custom", () => assert.strictEqual(1, 2, "custom"));
show("strictEqual objects", () => assert.strictEqual({ a: 1 }, { a: 1 }));
show("strictEqual NaN", () => assert.strictEqual(NaN, NaN));
show("equal", () => assert.equal(1, 2));
show("equal loose", () => assert.equal(1, "1"));
show("notEqual", () => assert.notEqual(1, "1"));
show("notStrictEqual", () => assert.notStrictEqual(1, 1));
show("ok message", () => assert.ok(false, "explicit"));
show("ok error", () => assert.ok(false, new TypeError("own")));
show("ok no args", () => assert.ok());
show("deepStrictEqual object", () =>
	assert.deepStrictEqual({ a: 1, b: [1, 2] }, { a: 2, b: [1, 2] }),
);
show("deepStrictEqual array", () => assert.deepStrictEqual([1, 2, 3], [1, 2, 4]));
show("deepStrictEqual long", () =>
	assert.deepStrictEqual(
		Array.from({ length: 20 }, (_, i) => i),
		Array.from({ length: 20 }, (_, i) => (i === 15 ? -1 : i)),
	),
);
show("deepEqual", () => assert.deepEqual({ a: 1 }, { a: 2 }));
show("deepEqual passes", () => assert.deepEqual({ a: 1 }, { a: "1" }));
show("notDeepStrictEqual", () => assert.notDeepStrictEqual({ a: 1 }, { a: 1 }));
show("notDeepEqual", () => assert.notDeepEqual([1], ["1"]));
show("partialDeepStrictEqual", () =>
	assert.partialDeepStrictEqual({ a: 1, b: 2 }, { a: 1 }),
);
show("partialDeepStrictEqual fails", () =>
	assert.partialDeepStrictEqual({ a: 1 }, { a: 2 }),
);
show("throws missing", () => assert.throws(() => {}));
show("throws missing class", () => assert.throws(() => {}, TypeError));
show("throws missing message", () => assert.throws(() => {}, "needed"));
show("throws regexp", () =>
	assert.throws(() => {
		throw new Error("x");
	}, /y/),
);
show("throws regexp passes", () =>
	assert.throws(() => {
		throw new Error("value x");
	}, /x/),
);
show("throws class", () =>
	assert.throws(() => {
		throw new Error("x");
	}, TypeError),
);
show("throws class passes", () =>
	assert.throws(() => {
		throw new TypeError("x");
	}, Error),
);
show("throws object", () =>
	assert.throws(
		() => {
			throw new Error("x");
		},
		{ message: "z" },
	),
);
show("throws object regexp", () =>
	assert.throws(
		() => {
			throw new Error("abc");
		},
		{ message: /b/, name: "Error" },
	),
);
show("throws validator", () =>
	assert.throws(
		() => {
			throw new Error("x");
		},
		function check() {
			return false;
		},
	),
);
show("throws primitive", () =>
	assert.throws(() => {
		throw 1;
	}, 2),
);
show("doesNotThrow", () =>
	assert.doesNotThrow(() => {
		throw new Error("boom");
	}),
);
show("doesNotThrow message", () =>
	assert.doesNotThrow(() => {
		throw new Error("boom");
	}, "context"),
);
show("doesNotThrow other", () =>
	assert.doesNotThrow(() => {
		throw new Error("boom");
	}, TypeError),
);
show("match", () => assert.match("abc", /x/));
show("match type", () => assert.match(123, /x/));
show("doesNotMatch", () => assert.doesNotMatch("abc", /b/));
show("fail", () => assert.fail());
show("fail message", () => assert.fail("boom"));
show("ifError", () => assert.ifError(new Error("e")));
show("ifError string", () => assert.ifError("str"));
show("ifError null", () => assert.ifError(null));
show("strict equal", () => strict.equal(1, "1"));
show("strict deepEqual", () => strict.deepEqual({ a: 1 }, { a: "1" }));
show("Assert strict", () => new Assert({ strict: true }).equal(1, "1"));
show("Assert default", () => new Assert().equal(1, "1"));
show("Assert loose", () => new Assert({ strict: false }).equal(1, "1"));
const error = new AssertionError({ actual: 1, expected: 2, operator: "strictEqual" });
console.log(
	error instanceof Error,
	error.name,
	error.code,
	error.message.split("\n")[0],
	Object.keys(error).join(","),
);
console.log(strictModule === strict, assert.strict === strict, strict.strict === strict);
await assert
	.rejects(Promise.reject(new Error("r")), /r/)
	.then(() => console.log("rejects passed"));
await assert
	.rejects(Promise.resolve(1))
	.catch((e) => console.log("rejects missing", e.message));
await assert
	.doesNotReject(Promise.reject(new Error("bad")))
	.catch((e) => console.log("doesNotReject", JSON.stringify(e.message)));
await assert.doesNotReject(async () => 1).then(() => console.log("doesNotReject passed"));
