import util, { toUSVString } from "node:util";

const results = [
	["export", util.toUSVString === toUSVString],
	["metadata", toUSVString.name, toUSVString.length],
];
for (const value of [
	undefined,
	null,
	true,
	42,
	123n,
	"",
	"ascii",
	"\ud800",
	"\udc00",
	"\ud800A\udc00",
	"\ud800\ud800\udc00\udc00",
	"\ud83d\ude00",
	new String("\udfff"),
]) {
	results.push(["value", toUSVString(value)]);
}
const observations = [];
const input = {
	[Symbol.toPrimitive](hint) {
		observations.push(hint);
		return "\ud800converted";
	},
};
results.push(["coercion", toUSVString(input), observations]);
const sentinel = {};
for (const value of [
	Symbol("invalid"),
	{
		toString() {
			throw sentinel;
		},
	},
]) {
	try {
		toUSVString(value);
	} catch (error) {
		results.push(["error", error === sentinel ? "sentinel" : error.name]);
	}
}
try {
	new toUSVString("x");
} catch (error) {
	results.push(["construct", error.name]);
}
const original = String.prototype.toWellFormed;
String.prototype.toWellFormed = () => "overridden";
results.push(["intrinsic", toUSVString("\ud800")]);
String.prototype.toWellFormed = original;
console.log(JSON.stringify(results));
