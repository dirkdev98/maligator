const assert = require("node:assert");

const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}

assert(true);
check("default assertion is callable", typeof assert === "function");
check("ok aliases the default", assert.ok === assert);
assert.strictEqual(42, 42);
assert.deepStrictEqual({ answer: 42 }, { answer: 42 });
assert.notEqual(1, 2);
assert.notStrictEqual("1", 1);
assert.notDeepEqual({ answer: 42 }, { answer: 43 });
assert.notDeepStrictEqual([1, 2], [1, 3]);
assert.match("maligator", /gator/);
assert.doesNotMatch("maligator", /node/);
assert.ifError(null);
assert.ifError(undefined);

for (const [name, invoke] of [
	["notEqual", () => assert.notEqual(1, 1)],
	["notStrictEqual", () => assert.notStrictEqual(1, 1)],
	["notDeepEqual", () => assert.notDeepEqual({ x: 1 }, { x: 1 })],
	["notDeepStrictEqual", () => assert.notDeepStrictEqual([1], [1])],
	["doesNotMatch", () => assert.doesNotMatch("abc", /b/)],
	["fail", () => assert.fail("deliberate")],
	["ifError", () => assert.ifError(new Error("boom"))],
]) {
	let threw = false;
	try { invoke(); } catch { threw = true; }
	check(`${name} rejects invalid input`, threw);
}

const strict = require("node:assert/strict");
check("strict default is callable", typeof strict === "function");
check("strict ok aliases default", strict.ok === strict);
strict.equal(3, 3);
strict.strictEqual(3, 3);
strict.deepEqual({ x: 1 }, { x: 1 });
strict.deepStrictEqual({ x: 1 }, { x: 1 });
strict.notEqual(3, 4);
strict.notStrictEqual(3, 4);
strict.notDeepEqual({ x: 1 }, { x: 2 });
strict.notDeepStrictEqual({ x: 1 }, { x: 2 });
strict.match("compatibility", /compat/);
strict.doesNotMatch("compatibility", /node/);
strict.ifError(null);

let message = "";
try {
	assert(false, "expected failure");
} catch (error) {
	message = error.message;
}
check("false assertion throws the provided message", message === "expected failure");

for (const [name, ok] of results) {
	if (!ok) console.log(`FAIL: ${name}`);
}
console.log(`RESULT ${results.filter(([, ok]) => ok).length}/${results.length}`);
