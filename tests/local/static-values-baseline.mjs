function included(x, from) {
	return ["foo", "bar"].includes(x, from);
}
function discarded(x, from) {
	["foo", "bar"].includes(x, from);
}
function absent(x, from) {
	return ["foo", "bar"].includex(x(), from());
}
function absentDiscarded(x, from) {
	["foo", "bar"].includex(x(), from());
}
let trace = "";
const from = {
	valueOf() {
		trace += "coerce;";
		return 0;
	},
};
console.log(included("bar", from), trace);
discarded("foo", from);
console.log(trace);
for (const fn of [absent, absentDiscarded]) {
	trace = "";
	try {
		fn(
			() => {
				trace += "x;";
				return "foo";
			},
			() => {
				trace += "from;";
				return 0;
			},
		);
	} catch (error) {
		console.log(error instanceof TypeError, trace);
	}
}
globalThis.staticValueBaseline = { included, discarded, absent, absentDiscarded };
