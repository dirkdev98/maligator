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
