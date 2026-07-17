let passed = 0;
let total = 0;

function check(condition, name) {
	total++;
	if (condition) passed++;
	else console.log("FAIL: " + name);
}

const util = require("util");
const canonical = require("node:util");
check(util === canonical, "bare/canonical identity");
check(util.format("%s:%i", "port", 42.8) === "port:42", "CommonJS format");
check(util.inspect({ ok: true }) === "{ ok: true }", "CommonJS inspect");

function Base() {}
function Derived() {}
util.inherits(Derived, Base);
check(new Derived() instanceof Base, "CommonJS inherits");

console.log("RESULT " + passed + "/" + total);
