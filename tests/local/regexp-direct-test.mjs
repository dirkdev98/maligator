// RegExp test() and null-tested exec() on literals that never escape and on reused
// RegExp objects. Prints one line per observation, which Node must reproduce.

const lines = [];
const log = (...values) => lines.push(values.map((value) => String(value)).join(" "));
const thrown = (callback) => {
	try {
		return `ok ${callback()}`;
	} catch (error) {
		return error.constructor.name;
	}
};
const words = ["views", "123", "id", "9", "0", "42x"];

function literalTest(subject) {
	return /^[1-9]\d*$/.test(subject);
}

function literalExecMatches(subject) {
	return /(\d+)-(\d+)?/.exec(subject) !== null;
}

function literalExecMisses(subject) {
	return /^[a-z]+$/g.exec(subject) === null;
}

function constructedTest(subject) {
	return new RegExp("^i", "g").test(subject);
}

let matches = 0;
for (let round = 0; round < 200; round++)
	for (const word of words) {
		if (literalTest(word)) matches++;
		if (literalExecMatches(`${word}-7`)) matches++;
		if (literalExecMisses(word)) matches++;
		if (constructedTest(word)) matches++;
	}
log("loop matches", matches);

// A fresh object starts at lastIndex 0, so a literal's g and y flags start every
// evaluation at the beginning.
for (let round = 0; round < 3; round++)
	log("fresh flags", /a/g.test("xa"), /a/y.test("ba"), /a/y.test("ab"), /x/gy.test("x"));
log(
	"flags",
	/A/i.test("xa"),
	/^b/m.test("a\nb"),
	/a.b/s.test("a\nb"),
	/\u{1F600}/u.test("x😀"),
	/^.$/u.test("😀"),
	/^.$/.test("😀"),
	/(?<x>a)/d.test("ba"),
	/[\p{L}]/v.test("é"),
);
log(
	"non-Latin-1",
	/中/.test("中文"),
	/^\w+$/.test("中文"),
	/é/.test("café"),
	/STRASSE/i.test("strasse"),
	/\uD83D/.test("😀"),
	/\uD83D/u.test("😀"),
);

/(\d+)-(\d+)/.test("x 12-34 y");
log("statics", RegExp.$1, RegExp.$2, RegExp.lastMatch, RegExp["$`"], RegExp["$'"]);
log("statics", RegExp.input, RegExp.lastParen, RegExp.$3 === "");
/zzz/.test("no match");
log("statics after a miss", RegExp.$1, RegExp.lastMatch);
/(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)(m)(n)(o)(p)(q)(r)(s)(t)(u)(v)(w)(x)(y)(z)(A)(B)(C)(D)(E)(F)(G)(H)/.test(
	"-abcdefghijklmnopqrstuvwxyzABCDEFGH-",
);
log(
	"statics of many groups",
	RegExp.$1,
	RegExp.$9,
	RegExp.lastParen,
	RegExp.lastMatch.length,
);
/(\d)/.exec("ab3") !== null;
log("statics after exec", RegExp.$1, RegExp["$`"]);

let conversions = 0;
const counted = {
	toString() {
		conversions++;
		return "123";
	},
};
log(
	"toString",
	/^\d+$/.test(counted),
	conversions,
	/^\d+$/.exec(counted) !== null,
	conversions,
);
log(
	"primitives",
	/^\d+$/.test(42),
	/^4/.test(4.5),
	/^undefined$/.test(),
	/null/.test(null),
);
log(
	"symbol",
	thrown(() => /a/.test(Symbol("a"))),
	thrown(() => /a/.exec(Symbol("a")) === null),
);
log(
	"throwing toString",
	thrown(() =>
		/a/.test({
			toString() {
				throw new RangeError("subject");
			},
		}),
	),
);

const hoisted = /^[1-9]\d*$/;
let hoistedMatches = 0;
for (let round = 0; round < 200; round++)
	for (const word of words) if (hoisted.test(word)) hoistedMatches++;
log("hoisted matches", hoistedMatches, hoisted.lastIndex);

const global = /a/g;
const progress = [];
for (let round = 0; round < 5; round++)
	progress.push(`${global.test("aaxa")}:${global.lastIndex}`);
log("hoisted g", progress.join(" "));
const sticky = /a/y;
const stickyProgress = [];
for (let round = 0; round < 4; round++)
	stickyProgress.push(`${sticky.test("aab")}:${sticky.lastIndex}`);
log("hoisted y", stickyProgress.join(" "));
global.lastIndex = 2.5;
log("fractional lastIndex", global.test("aaxa"), global.lastIndex);
global.lastIndex = "1";
log("string lastIndex", global.test("aaxa"), global.lastIndex);
global.lastIndex = {
	valueOf() {
		log("lastIndex valueOf");
		return 3;
	},
};
log("object lastIndex", global.test("aaxa"), global.lastIndex);
const plain = /b/;
plain.lastIndex = {
	valueOf() {
		log("plain lastIndex valueOf");
		return 9;
	},
};
log("plain object lastIndex", plain.test("abc"), typeof plain.lastIndex);
global.lastIndex = 99;
log("past the end", global.test("aaxa"), global.lastIndex);

const escaped = /a/g;
log("escaped literal", escaped.test("a"), escaped.lastIndex);

class TracingRegExp extends RegExp {
	exec(subject) {
		log("subclass exec", subject, this.lastIndex);
		return super.exec(subject);
	}
}
const traced = new TracingRegExp("b", "g");
log("subclass", traced.test("abc"), traced.lastIndex, traced.test("abc"));

const own = /c/;
own.exec = function (subject) {
	log("own exec", subject);
	return null;
};
log("own exec result", own.test("c"));

const borrowed = { test: RegExp.prototype.test, exec: () => ({}) };
log("borrowed test", borrowed.test("x"));
log(
	"incompatible receiver",
	thrown(() => RegExp.prototype.test.call(1, "x")),
);
const testMethod = /q/.test;
log(
	"detached call",
	thrown(() => testMethod("q")),
);
log(
	"call",
	RegExp.prototype.test.call(/q/, "q"),
	Reflect.apply(RegExp.prototype.test, /r/, ["r"]),
);

let caught = "none";
try {
	if (/a/.test(Symbol("in try"))) caught = "matched";
} catch (error) {
	caught = error.constructor.name;
}
log("in try", caught);

console.log(lines.join("\n"));
