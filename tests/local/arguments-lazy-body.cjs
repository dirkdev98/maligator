// Body reads of `arguments` beside rarer uses that observe the object.

const slice = Array.prototype.slice;
const lines = [];

function setting(name, value) {
	"use strict";
	if (arguments.length === 1) return `get ${name}`;
	return `set ${name} ${slice.call(arguments, 1).join(",")}`;
}
lines.push(setting("etag"), setting("etag", 1, 2));

function shifted() {
	"use strict";
	const observed = arguments;
	Array.prototype.shift.call(observed);
	return `${arguments.length}:${arguments[0]}:${arguments[2]}`;
}
lines.push(shifted(1, 2, 3));

function mutatedByCallee(first) {
	"use strict";
	const before = `${arguments.length}:${arguments[0]}`;
	(function (list) {
		list[0] = "changed";
		list.length = 5;
	})(arguments);
	return `${before} ${arguments.length}:${arguments[0]}:${first}`;
}
lines.push(mutatedByCallee("original", 2));

function midLoop() {
	"use strict";
	let total = "";
	for (let round = 0; round < 3; round++) {
		total += `${arguments.length}/${arguments[1]} `;
		if (round === 1) Array.prototype.push.call(arguments, 9);
	}
	return total.trim();
}
lines.push(midLoop(4, 5));

function lengthWritten() {
	"use strict";
	arguments.length = 10;
	return arguments.length;
}
lines.push(`written ${lengthWritten(1)}`);

function sloppyMapped(value) {
	if (arguments.length > 5) return arguments;
	value = 7;
	return `${arguments[0]} ${arguments.length}`;
}
function sloppyObserved(value) {
	const observed = arguments;
	value = 8;
	observed[1] = "extra";
	return `${arguments[0]} ${arguments[1]} ${arguments.length}`;
}
lines.push(`sloppy ${sloppyMapped(1)} ${sloppyObserved(1)}`);

function outOfRange() {
	"use strict";
	if (arguments.length > 9) return slice.call(arguments);
	return `${arguments[3]} ${arguments[0]}`;
}
lines.push(`range ${outOfRange("a")}`);

function* generator() {
	"use strict";
	yield arguments.length;
	yield slice.call(arguments).join("+");
	yield `${arguments.length} ${arguments[1]}`;
}
lines.push(`generator ${[...generator(1, 2)].join(" | ")}`);

function typeis(value, types) {
	"use strict";
	if (types && !Array.isArray(types)) {
		types = new Array(arguments.length - 1);
		for (let index = 0; index < types.length; index++)
			types[index] = arguments[index + 1];
	}
	return `${value}:${types.join("/")}`;
}
let checksum = 0;
for (let round = 0; round < 1000; round++) {
	checksum += setting("x").length + typeis("v", ["a", "b"]).length;
}
lines.push(`${typeis("v", "a", "b")} ${typeis("w", ["c"])} ${checksum}`);
console.log(lines.join("\n"));
