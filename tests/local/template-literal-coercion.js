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

const originalConcat = String.prototype.concat;
String.prototype.concat = () => {
	throw new Error("String.prototype.concat called");
};
assert(
	`a${ordinary}b${ordinary}c` === "aordinarybordinaryc",
	"construction is intrinsic",
);
String.prototype.concat = originalConcat;

const collect = globalThis.__mal_collect_garbage;
assert(typeof collect === "function", "collection hook installed");
function freshText(character) {
	return {
		toString() {
			collect();
			return character.repeat(2000);
		},
	};
}
assert(
	`<${freshText("é")}\0${freshText("界")}>` ===
		"<" + "é".repeat(2000) + "\0" + "界".repeat(2000) + ">",
	"retained converted strings survive later coercion and final allocation",
);
const wideBacking = "界" + "a".repeat(4000) + "界";
const narrowSlice = wideBacking.slice(1, -1);
let rope = "";
for (let index = 0; index < 50; index++) rope += index % 2 ? "界" : "a";
assert(
	`${narrowSlice}\0${rope}${"\ud800"}` === narrowSlice + "\0" + rope + "\ud800",
	"dependent slices, ropes, NUL and lone surrogates",
);

function* suspendedTemplate() {
	return `start${freshText("é")}/${yield "paused"}/${freshText("界")}end`;
}
const suspended = suspendedTemplate();
assert(suspended.next().value === "paused", "template suspends");
collect();
const resumed = suspended.next("middle");
assert(
	resumed.done &&
		resumed.value === "start" + "é".repeat(2000) + "/middle/" + "界".repeat(2000) + "end",
	"retained strings and prefix length survive suspension",
);

function assertLengthError(action, message) {
	let error;
	try {
		action();
	} catch (caughtError) {
		error = caughtError;
	}
	assert(
		error instanceof RangeError && error.message === "Invalid string length",
		message,
	);
}
function checkLengthOrder() {
	const long = "x".repeat(9 * 1024 * 1024);
	let later = 0;
	assertLengthError(
		() => `${long}${long}${++later}`,
		"overflow precedes later expression",
	);
	assertLengthError(() => {
		`${long}${long}${++later}`;
	}, "discarded construction preserves overflow");
	const almost = "x".repeat(16 * 1024 * 1024 - 1);
	assert(`${almost}x`.length === 16 * 1024 * 1024, "exact engine length limit");
	assertLengthError(() => `${almost}xx${++later}`, "quasi overflow precedes expression");
	assert(later === 0, "overflow suppresses all later effects");
}
checkLengthOrder();
console.log("template-literal-coercion PASS");
