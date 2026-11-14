// RegExp test() and null-tested exec() while a program replaces the realm's RegExp
// methods: before a loop, in the middle of one, and during the subject's ToString.

const lines = [];
const log = (...values) => lines.push(values.map((value) => String(value)).join(" "));
const originalExec = RegExp.prototype.exec;
const originalTest = RegExp.prototype.test;
const hoisted = /^\d+$/;

function literal(subject) {
	return /^\d+$/.test(subject);
}

function literalSticky(subject) {
	return /\d/y.test(subject);
}

function literalExec(subject) {
	return /^\d+$/.exec(subject) !== null;
}

function replaceExecMidLoop() {
	const seen = [];
	for (let round = 0; round < 4; round++) {
		if (round === 2)
			RegExp.prototype.exec = function (subject) {
				seen.push(`exec(${subject}) lastIndex=${this.lastIndex} source=${this.source}`);
				return round === 2 ? {} : null;
			};
		seen.push(
			literal(String(round)),
			literalSticky(`${round}`),
			hoisted.test(String(round)),
		);
		seen.push(literalExec(String(round)));
	}
	RegExp.prototype.exec = originalExec;
	return seen.join(" ");
}

function replaceTestMidLoop() {
	const seen = [];
	for (let round = 0; round < 4; round++) {
		if (round === 2)
			RegExp.prototype.test = function (subject) {
				return `custom(${subject}) ${this instanceof RegExp} ${this.lastIndex}`;
			};
		seen.push(literal(`${round}`), hoisted.test(`${round}`));
	}
	RegExp.prototype.test = originalTest;
	return seen.join(" ");
}

for (let round = 0; round < 50; round++) literal(String(round));
log("before", literal("12"), literal("x"), hoisted.test("12"), literalExec("12"));
log("exec mid-loop", replaceExecMidLoop());
log("after exec restore", literal("12"), hoisted.test("x"), literalExec("x"));
log("test mid-loop", replaceTestMidLoop());
log("after test restore", literal("12"), hoisted.test("12"));

RegExp.prototype.exec = function (subject) {
	log("replaced before", subject, this.flags);
	return null;
};
log(
	"exec replaced before",
	literal("1"),
	literalSticky("1"),
	hoisted.test("1"),
	literalExec("1"),
);
RegExp.prototype.exec = originalExec;

const swapping = {
	toString() {
		RegExp.prototype.exec = function (subject) {
			log("swapped in ToString", subject, this.lastIndex);
			return {};
		};
		return "no digits";
	},
};
log("exec swapped during ToString", literal(swapping), hoisted.test(swapping));
RegExp.prototype.exec = originalExec;
log("exec swapped during ToString for exec", literalExec(swapping));
RegExp.prototype.exec = originalExec;

Object.defineProperty(RegExp.prototype, "test", {
	configurable: true,
	writable: true,
	value: originalTest,
});
let observed;
Object.defineProperty(RegExp.prototype, "test", {
	configurable: true,
	get() {
		observed = this;
		return originalTest;
	},
});
log("test getter", literal("5"), observed instanceof RegExp, observed?.source);
Object.defineProperty(RegExp.prototype, "test", {
	configurable: true,
	writable: true,
	value: originalTest,
});
log("after getter", literal("6"), hoisted.test("x"));

console.log(lines.join("\n"));
