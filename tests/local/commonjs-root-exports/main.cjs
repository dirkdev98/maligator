const plain = require("./plain.cjs");
const withDefault = require("./with-default.cjs");
const leaf = require("./host-before-export.cjs");
const head = require("./cycle-head.cjs");
const double = require("./exported-first-head.cjs");
const replaced = require("./replaced.cjs");
const chosen = require("./chosen.cjs");
const maybe = require("./maybe.cjs");

const values = [1, {}, { then() {} }, null, Promise.resolve(1), () => {}];
function thenables(rounds) {
	let hits = 0;
	for (let round = 0; round < rounds; round++)
		for (let index = 0; index < values.length; index++) {
			if (plain(values[index])) hits++;
			if (withDefault(values[index])) hits++;
		}
	return hits;
}
console.log(
	"thenables",
	thenables(200),
	withDefault.default === withDefault,
	plain.name,
	withDefault.name,
);

function leaves(files) {
	let text = "";
	for (const file of files) text += leaf(file);
	return text;
}
console.log("host", leaves(["/a/b.js", "c/d", "e"]), leaf.original("/x/y.txt"));

console.log(
	"cycle",
	head.tailSaw,
	head.tailThrew,
	head.later(2),
	head(3),
	double.seen,
	double(4),
);

function replacedCalls(rounds) {
	let text = "";
	for (let round = 0; round < rounds; round++)
		text += require("./replaced.cjs")(round)[0];
	return text;
}
const before = replacedCalls(3);
replaced.replace();
console.log("replaced", before, replacedCalls(3), replaced(9));

function chosenCalls(rounds) {
	let text = "";
	for (let round = 0; round < rounds; round++) text += chosen(round);
	return text;
}
console.log("chosen", chosenCalls(3), typeof maybe, maybe.kind);

let failure;
try {
	require("./flaky.cjs");
} catch (error) {
	failure = error.message;
}
const count = require("./flaky.cjs");
const leaked = globalThis.leakedCount;
console.log("flaky", failure, leaked(), leaked(), count(), count(), count === leaked);
