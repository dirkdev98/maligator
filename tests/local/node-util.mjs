import util, {
	deprecate,
	format,
	formatWithOptions,
	inherits,
	inspect,
	promisify,
} from "node:util";

let passed = 0;
let total = 0;

function check(condition, name) {
	total++;
	if (condition) passed++;
	else console.log("FAIL: " + name);
}

check(util.inspect === inspect, "default/named inspect identity");
check(util.inherits === inherits, "default/named inherits identity");
check(util.promisify === promisify, "default/named promisify identity");
function callbackValue(value, callback) {
	callback(null, value * 2);
}
check((await promisify(callbackValue)(21)) === 42, "promisify fulfillment");
let rejection = "";
try {
	await promisify((callback) => callback(new Error("rejected")))();
} catch (error) {
	rejection = error.message;
}
check(rejection === "rejected", "promisify rejection");
check(format("hello %s %d %%", "world", 4) === "hello world 4 %", "format tokens");
check(format("extra", { value: 1 }) === "extra { value: 1 }", "format extras");
check(
	formatWithOptions({ depth: 0 }, "%O", { nested: { value: 1 } }) ===
		"{ nested: [Object] }",
	"format options depth",
);
check(inspect([1, "two"]) === "[ 1, 'two' ]", "array inspection");
check(inspect("quoted") === "'quoted'" && inspect({}) === "{}", "scalar inspection");
const circular = {};
circular.self = circular;
check(inspect(circular) === "{ self: [Circular] }", "cycle inspection");

function Parent() {}
Parent.prototype.value = function () {
	return 7;
};
function Child() {}
inherits(Child, Parent);
const child = new Child();
check(child instanceof Child && child instanceof Parent, "inherits prototype chain");
check(Child.super_ === Parent && child.value() === 7, "inherits metadata and methods");

let calls = 0;
const wrapped = deprecate(function (value) {
	calls++;
	return this.base + value;
}, "test warning");
check(wrapped.call({ base: 2 }, 3) === 5, "deprecate forwards this and arguments");
check(wrapped.call({ base: 3 }, 4) === 7 && calls === 2, "deprecate remains callable");

function Legacy(value) {
	this.value = value;
}
const DeprecatedLegacy = deprecate(Legacy, "legacy warning");
const legacy = new DeprecatedLegacy(9);
check(
	legacy instanceof Legacy && legacy instanceof DeprecatedLegacy && legacy.value === 9,
	"deprecate preserves construction",
);

console.log("RESULT " + passed + "/" + total);
