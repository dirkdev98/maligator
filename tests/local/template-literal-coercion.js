function assert(condition, message) {
	if (!condition) throw new Error(message);
}

const events = [];
const value = {
	[Symbol.toPrimitive](hint) {
		events.push(hint);
		return hint === "string" ? "text" : 42;
	},
};
assert(`a${value}b${(events.push("next"), value)}c` === "atextbtextc", "string hint");
assert(events.join(",") === "string,next,string", "conversion order");
assert("" + value === "42", "addition keeps the default hint");

const ordinary = {
	toString() {
		return "ordinary";
	},
	valueOf() {
		throw new Error("unexpected valueOf");
	},
};
assert(`${ordinary}` === "ordinary", "ordinary string conversion");
assert(
	`${undefined}/${null}/${true}/${17}/${23n}` === "undefined/null/true/17/23",
	"primitives",
);

let continued = false;
let symbolThrew = false;
try {
	`${Symbol("x")}${(continued = true)}`;
} catch (error) {
	symbolThrew = error instanceof TypeError;
}
assert(symbolThrew && !continued, "symbol conversion stops evaluation");

const sentinel = {};
let caught;
try {
	`${{
		toString() {
			throw sentinel;
		},
	}}${(continued = true)}`;
} catch (error) {
	caught = error;
}
assert(caught === sentinel && !continued, "throwing conversion stops evaluation");

function tag(strings, substitution) {
	assert(strings[0] === "" && substitution === value, "tag receives original value");
	return substitution;
}
assert(tag`${value}` === value, "tagged template");

const originalString = globalThis.String;
globalThis.String = () => {
	throw new Error("global String called");
};
assert(`${ordinary}` === "ordinary", "conversion is intrinsic");
globalThis.String = originalString;
console.log("template-literal-coercion PASS");
