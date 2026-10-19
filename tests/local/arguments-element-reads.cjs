"use strict";
// Dynamic `arguments[key]` reads beside uses that observe the object.

const lines = [];

function copy() {
	var args = new Array(arguments.length);
	for (var i = 0; i < args.length; i++) args[i] = arguments[i];
	return args;
}
let copied = 0;
for (let round = 0; round < 2000; round++)
	copied += copy(round, { round }, `r${round}`).length;
lines.push(`copied ${copied} ${copy("a", "b").join(",")}`);

function tail(fn, obj) {
	var props = new Array(arguments.length - 2);
	for (var i = 0; i < props.length; i++) props[i] = arguments[i + 2];
	return `${props.join(",")} ${typeof fn} ${typeof obj}`;
}
lines.push(tail(() => 0, {}, "baseUrl", "next", "params"));

function keys(k) {
	return [
		arguments[k],
		arguments[String(k)],
		arguments["length"],
		arguments[1.5],
		arguments[-0],
		arguments[k + 10],
		arguments[NaN],
	]
		.map(String)
		.join("|");
}
lines.push(keys(0, "one"), keys(1, "one"));

function calleeKey(k) {
	let callee;
	try {
		callee = arguments["callee"];
	} catch (error) {
		callee = error.name;
	}
	return `${arguments[k]} ${callee}`;
}
lines.push(calleeKey(0));

function writtenFormal(a) {
	a = "changed";
	var i = 0;
	return `${arguments[i]} ${a}`;
}
lines.push(`written ${writtenFormal("original")}`);

function aliasedObject(a) {
	var saved = arguments;
	var i = 0;
	saved[0] = "mutated";
	return `${arguments[i]} ${a}`;
}
lines.push(`aliased ${aliasedObject("original")}`);

const sloppy = (0, eval)(`(function () {
	function writtenFormal(a) {
		a = "changed";
		var i = 0;
		return arguments[i];
	}
	function aliased(a) {
		var saved = arguments;
		var i = 0;
		saved[0] = "mutated";
		return arguments[i] + " " + a;
	}
	function unwritten(a, b) {
		var out = [];
		for (var i = 0; i < arguments.length; i++) out.push(arguments[i]);
		return out.join(",") + " " + (typeof arguments["callee"]);
	}
	return [writtenFormal("original"), aliased("original"), unwritten(1, 2, 3)].join(" ");
})`);
lines.push(`sloppy ${sloppy()}`);

function keyMaterializes() {
	var i = 0;
	return arguments[
		(function (list) {
			list[0] = "inner";
			return i;
		})(arguments)
	];
}
lines.push(`key ${keyMaterializes("outer")}`);

function pastTheEnd() {
	var out = [];
	for (var i = 0; i < arguments.length + 2; i++) out.push(arguments[i]);
	return out.map(String).join(",");
}
lines.push(`past ${pastTheEnd(1, 2)}`);

function objectKey() {
	var key = {
		toString() {
			return "1";
		},
	};
	return arguments[key];
}
lines.push(`object ${objectKey("zero", "one")}`);

function afterMaterialize() {
	var i = 1;
	var list = arguments;
	list[1] = "replaced";
	return arguments[i];
}
lines.push(`after ${afterMaterialize("a", "b")}`);

function defaults(a, b = arguments.length) {
	var i = 0;
	return `${arguments[i]} ${b}`;
}
lines.push(`defaults ${defaults("x")} ${defaults("x", "y")}`);

function recurse(n) {
	if (n === 0) return 0;
	var i = 0;
	return arguments[i] + recurse(n - 1);
}
lines.push(`recurse ${recurse(10)}`);

function collect() {
	var out = "";
	for (var i = 0; i < arguments.length; i++) {
		var padding = [i, i + 1].map((value) => ({ value }));
		out += arguments[i].name + padding.length;
	}
	return out;
}
let collected = 0;
for (let round = 0; round < 500; round++)
	collected += collect(
		{ name: `a${round}` },
		{ name: `b${round}` },
		{ name: `c${round}` },
	).length;
lines.push(`collected ${collected}`);

console.log(lines.join("\n"));
