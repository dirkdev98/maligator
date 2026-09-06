function equal(actual, expected) {
	if (!Object.is(actual, expected)) throw new Error(`${actual} != ${expected}`);
}

function small(value) {
	switch (value) {
		case "yes":
			return 1;
		case "no":
			return 2;
		default:
			return 3;
	}
}

function lengths(value) {
	switch (value) {
		case "":
			return 1;
		case "a":
			return 2;
		case "bb":
			return 3;
		case "ccc":
			return 4;
		case "dddd":
			return 5;
		case "eeeee":
			return 6;
		default:
			return 7;
	}
}

function tags(value) {
	switch (value) {
		case "":
			return 10;
		case "load":
			return 11;
		case "save":
			return 12;
		case "move":
			return 13;
		case "jump":
			return 14;
		case "call":
			return 15;
		case "stop":
			return 16;
		case "a\0b":
			return 17;
		case "é":
			return 18;
		case "漢字":
			return 19;
		case "😀":
			return 20;
		case "\ud800":
			return 21;
		case "\udc00":
			return 22;
		case "\ud800x":
			return 23;
		case "x\udc00":
			return 24;
		case "load":
			return 99;
		default:
			return -1;
	}
}

function fallthrough(value) {
	let result = 0;
	switch (value) {
		case "go":
			result += 1;
		default:
			result += 10;
		case "end":
			result += 100;
			break;
		case "stop":
			result += 1000;
	}
	return result;
}

const cases = [
	"",
	"load",
	"save",
	"move",
	"jump",
	"call",
	"stop",
	"a\0b",
	"é",
	"漢字",
	"😀",
	"\ud800",
	"\udc00",
	"\ud800x",
	"x\udc00",
];
for (let index = 0; index < cases.length; index++) {
	const value = cases[index];
	equal(tags(value), index + 10);
	equal(tags(("prefix" + value).slice(6)), index + 10);
	equal(tags(value.split("").join("")), index + 10);
	equal(tags(new String(value)), -1);
}
for (const value of [null, undefined, 1, true, 0n, Symbol("load"), {}, []]) {
	equal(tags(value), -1);
	equal(small(value), 3);
	equal(lengths(value), 7);
}
const coercive = {
	[Symbol.toPrimitive]() {
		throw new Error("switch coerced an object");
	},
};
equal(tags(coercive), -1);
equal(tags("missing"), -1);
equal(tags("prefix".repeat(1000)), -1);
equal(small("yes"), 1);
equal(small("no"), 2);
for (let index = 0; index < 6; index++)
	equal(lengths(["", "a", "bb", "ccc", "dddd", "eeeee"][index]), index + 1);
equal(fallthrough("go"), 111);
equal(fallthrough("end"), 100);
equal(fallthrough("stop"), 1000);
equal(fallthrough("missing"), 110);

const events = [];
function effectful(value) {
	switch (value) {
		case (events.push("first"), "first"):
			return 1;
		default:
			events.push("default");
		case (events.push("second"), "second"):
			return 2;
		case 3:
			return 3;
	}
}
equal(effectful("first"), 1);
equal(events.join(","), "first");
events.length = 0;
equal(effectful("missing"), 2);
equal(events.join(","), "first,second,default");
events.length = 0;
equal(effectful(3), 3);
equal(events.join(","), "first,second");

let total = 0;
const loopTags = ["skip", "add", "double"];
for (let index = 0; index < 60; index++) {
	const retained = { values: [index, 1] };
	switch (loopTags[index % 3]) {
		case "skip":
			continue;
		case "add":
			total += retained.values[0];
			break;
		case "double":
			total += 2 * retained.values[0];
			break;
		default:
			throw new Error("unexpected loop tag");
	}
	total += retained.values[1];
}
equal(total, 1850);
function earlyExit(value) {
	let count = 0;
	outer: for (let index = 0; index < 5; index++) {
		switch (value) {
			case "stop":
				break outer;
			case "skip":
				continue outer;
			case "add":
				count++;
		}
		count++;
	}
	return count;
}
equal(earlyExit("stop"), 0);
equal(earlyExit("skip"), 0);
equal(earlyExit("add"), 10);
function collidingHashCases(value) {
	switch (value) {
		case "Kq-v14C2OZ":
			return 1;
		case "NDtRq_vQTq":
			return 2;
		case "aaaaaaaaaa":
			return 3;
		case "bbbbbbbbbb":
			return 4;
		case "cccccccccc":
			return 5;
		case "dddddddddd":
			return 6;
		case "eeeeeeeeee":
			return 7;
		case "ffffffffff":
			return 8;
		case "Kq-v14C2OZ":
			return 99;
		default:
			return -1;
	}
}
function collidingHashMiss(value) {
	switch (value) {
		case "Kq-v14C2OZ":
			return 1;
		case "aaaaaaaaaa":
			return 3;
		case "bbbbbbbbbb":
			return 4;
		case "cccccccccc":
			return 5;
		case "dddddddddd":
			return 6;
		case "eeeeeeeeee":
			return 7;
		case "ffffffffff":
			return 8;
		case "gggggggggg":
			return 9;
		default:
			return -1;
	}
}
equal(collidingHashCases("Kq-v14C2OZ"), 1);
equal(collidingHashCases("NDtRq_vQTq"), 2);
equal(collidingHashMiss("NDtRq_vQTq"), -1);
function typeTag(value) {
	const type = typeof value;
	switch (type) {
		case "number":
			return 1;
		case "string":
			return 2;
		case "boolean":
			return 3;
		default:
			return 4;
	}
}
equal(typeTag(42), 1);
equal(typeTag("x"), 2);
equal(typeTag(false), 3);
equal(typeTag({}), 4);
function lexicalFallthrough(value) {
	switch (value) {
		case "init":
			let local = 2;
		case "use":
			return local;
		default:
			return 0;
	}
}
equal(lexicalFallthrough("init"), 2);
let tdz = false;
try {
	lexicalFallthrough("use");
} catch (error) {
	tdz = error instanceof ReferenceError;
}
equal(tdz, true);
let finalized = 0;
const thrown = {};
function abrupt(value) {
	try {
		switch (value) {
			case "throw":
				throw thrown;
			case "return":
				return 5;
			default:
				return 6;
		}
	} finally {
		finalized++;
	}
}
let caught;
try {
	abrupt("throw");
} catch (error) {
	caught = error;
}
equal(caught, thrown);
equal(abrupt("return"), 5);
equal(abrupt("missing"), 6);
equal(finalized, 3);
function nestedSwitch(value, index) {
	let result = 0;
	switch (value) {
		case "left":
			switch (index) {
				case 1:
					result = 1;
					break;
				case 2:
					result = 2;
					break;
				case 3:
					result = 3;
					break;
				case 4:
					result = 4;
					break;
				default:
					result = 5;
			}
		case "right":
			result += 10;
	}
	switch (value) {
		case "left":
			return result;
		case "right":
			return result + 1;
		default:
			return 0;
	}
}
for (let index = 1; index <= 5; index++) {
	equal(nestedSwitch("left", index), index + 10);
	equal(nestedSwitch("right", index), 11);
	equal(nestedSwitch("missing", index), 0);
}
function* suspended(value) {
	switch (yield value) {
		case "load":
			return 1;
		case "save":
			return 2;
		default:
			return 3;
	}
}
const generator = suspended("ready");
equal(generator.next().value, "ready");
const finished = generator.next("save");
equal(finished.value, 2);
equal(finished.done, true);
globalThis.compiledTags = tags;
const dynamicDispatch = (0, eval)(`(function(value) {
  switch (value) {
    case "load": return globalThis.compiledTags(value);
    case "save": return globalThis.compiledTags(value);
    default: return -1;
  }
})`);
equal(dynamicDispatch("load"), 11);
equal(dynamicDispatch("save"), 12);
equal(dynamicDispatch(new String("load")), -1);
delete globalThis.compiledTags;
console.log("string-switch-dispatch PASS");
