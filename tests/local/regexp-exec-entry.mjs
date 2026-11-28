// RegExp exec skips rooting and conversion when its subject is a string and its
// lastIndex a plain integer. Every other receiver state takes the ordinary path, so
// each case here must match Node: lastIndex reads and writes, legacy statics,
// replaced methods, subclasses and conversions that run code.
const statics = () => [
	RegExp.lastMatch,
	RegExp.$1,
	RegExp.leftContext,
	RegExp.rightContext,
];
const describe = (match) =>
	match === null ? null : { index: match.index, values: [...match], input: match.input };
const outcome = (run) => {
	try {
		return { value: run() };
	} catch (error) {
		return { threw: error.constructor.name };
	}
};
const wide = (text) => `${text}Ā`;
// A rope, a slice and a fresh flat copy of the same text.
const shapes = (text) => [
	text,
	`${text.slice(0, 3)}${text.slice(3)}`,
	` ${text}`.slice(1),
];

function execTrace(re, subjects, lastIndices) {
	return subjects.map((subject, index) => {
		if (lastIndices !== undefined) re.lastIndex = lastIndices[index];
		const match = outcome(() => describe(re.exec(subject)));
		return [match, re.lastIndex, statics()];
	});
}

function projected(re, subjects) {
	const found = [];
	for (const subject of subjects) {
		const match = re.exec(subject);
		if (match) found.push(match[1], match.index, re.lastIndex);
		else found.push(null, re.lastIndex);
	}
	return found;
}

function nullTested(re, subjects) {
	return subjects.map((subject) => (re.exec(subject) ? re.lastIndex : -1 - re.lastIndex));
}

function tested(re, subjects) {
	return subjects.map((subject) => [re.test(subject), re.lastIndex, RegExp.lastMatch]);
}

const route = String.raw`^(?:\/users\/([^\/]+))(?:\/$)?$`;
const routeSubjects = [
	...shapes("/users/a%20b"),
	...shapes("/middleware"),
	"/USERS/x/",
	"",
	wide("/users/a"),
	wide("/middleware"),
	"/users/é",
];
const word = String.raw`([a-z]+)`;
const wordSubjects = ["ab cd", "  xy", "", wide("q r"), ...shapes("hello world")];

const valueOfCalls = [];
const results = {
	routeExec: execTrace(new RegExp(route, "i"), routeSubjects),
	routeProjected: projected(new RegExp(route, "i"), routeSubjects),
	routeTested: tested(new RegExp(route, "i"), routeSubjects),
	globalExec: execTrace(new RegExp(word, "g"), [...wordSubjects, ...wordSubjects]),
	globalProjected: projected(new RegExp(word, "g"), [...wordSubjects, ...wordSubjects]),
	globalNullTested: nullTested(new RegExp(word, "g"), [...wordSubjects, ...wordSubjects]),
	routeNullTested: nullTested(new RegExp(route, "i"), routeSubjects),
	convertedLastIndexForms: (() => {
		const lastIndex = () => ({ valueOf: () => 3 });
		const re = new RegExp(word, "g");
		re.lastIndex = lastIndex();
		const projection = projected(re, ["ab cd"]);
		re.lastIndex = lastIndex();
		return [projection, nullTested(re, ["ab cd", "ab cd"]), statics()];
	})(),
	stickyExec: execTrace(new RegExp(word, "y"), wordSubjects, [0, 2, 0, 2, 3, 0, 5]),
	stickyTested: (() => {
		const re = new RegExp(word, "y");
		return wordSubjects.map((subject, index) => {
			re.lastIndex = index % 3;
			return [re.test(subject), re.lastIndex];
		});
	})(),
	unusualLastIndex: [1.5, -1, Number.NaN, 2 ** 53, "2", null, true, 1e10].map((value) => {
		const sticky = new RegExp(word, "y");
		const plain = new RegExp(word);
		sticky.lastIndex = value;
		plain.lastIndex = value;
		return [
			describe(sticky.exec("ab cd")),
			sticky.lastIndex,
			describe(plain.exec("ab cd")),
			plain.lastIndex,
		];
	}),
	// ToLength runs valueOf even without g or y, and its code can recompile R.
	valueOfLastIndex: [word, route].map((source) => {
		const re = new RegExp(source);
		re.lastIndex = {
			valueOf() {
				valueOfCalls.push(source);
				return 2;
			},
		};
		return [describe(re.exec("ab cd")), typeof re.lastIndex, valueOfCalls.length];
	}),
	recompilingLastIndex: (() => {
		const re = /x/;
		re.lastIndex = {
			valueOf() {
				re.compile("([a-z])", "g");
				return 3;
			},
		};
		return [describe(re.exec("ab cd")), re.lastIndex, re.flags];
	})(),
	throwingLastIndex: [
		Symbol("i"),
		1n,
		{
			valueOf: () => {
				throw new RangeError("no");
			},
		},
	].map((value) => {
		const re = new RegExp(word);
		re.lastIndex = value;
		return outcome(() => describe(re.exec("ab")));
	}),
	accessorLastIndex: outcome(() =>
		Object.defineProperty(new RegExp(word), "lastIndex", { get: () => 0 }),
	),
	readonlyLastIndex: ["", "g", "y"].map((flags) => {
		const re = new RegExp(word, flags);
		Object.defineProperty(re, "lastIndex", { value: 0, writable: false });
		return [
			outcome(() => describe(re.exec("ab"))),
			outcome(() => describe(re.exec("12"))),
		];
	}),
	// An added and deleted property returns the instance to its original shape.
	reshapedInstance: (() => {
		const re = new RegExp(word, "g");
		re.extra = 1;
		re.lastIndex = 3;
		delete re.extra;
		return [execTrace(re, ["ab cd", "ab cd", "ab cd"]), Object.keys(re)];
	})(),
	staticsAfterMiss: (() => {
		/(b)(c)/.exec("abcd");
		const before = statics();
		new RegExp(route).exec("/missing");
		return [before, statics(), RegExp.$2];
	})(),
	convertedSubject: (() => {
		const re = new RegExp(word, "g");
		const subject = {
			toString() {
				const garbage = [];
				for (let i = 0; i < 2000; i++) garbage.push({ i, text: `x${i}` });
				return `ab${garbage.length}cd`;
			},
		};
		return [
			execTrace(re, [subject, subject, 42, undefined]),
			projected(new RegExp(word), [subject, 7]),
		];
	})(),
	ownExec: (() => {
		const re = new RegExp(word);
		re.exec = (subject) => ({ replaced: subject });
		return [re.exec("ab"), re.test("ab"), RegExp.prototype.exec.call(re, "ab").index];
	})(),
	subclass: (() => {
		class Counting extends RegExp {
			exec(subject) {
				this.calls = (this.calls ?? 0) + 1;
				return super.exec(subject);
			}
		}
		class Plain extends RegExp {}
		const counting = new Counting(word, "g");
		const plain = new Plain(word, "g");
		return [
			execTrace(counting, ["ab cd", "ab cd", "ab cd"]),
			counting.test("xy"),
			counting.calls,
			execTrace(plain, ["ab cd", "ab cd", "ab cd"]),
			"a,b".split(new Plain(",")),
		];
	})(),
	species: (() => {
		const constructed = [];
		class Species extends RegExp {
			static get [Symbol.species]() {
				return function (source, flags) {
					constructed.push(flags);
					return new RegExp(source, flags);
				};
			}
		}
		return ["a1b2c".split(new Species(String.raw`\d`)), constructed];
	})(),
	// More groups than the exec's inline capture buffer holds.
	wideMatches: (() => {
		const source = `${"(a)".repeat(39)}(b)?`;
		const subject = `${"a".repeat(39)}b`.repeat(2);
		const sticky = new RegExp(source, "y");
		const trace = [0, 40, 1].map((lastIndex) => {
			sticky.lastIndex = lastIndex;
			const match = sticky.exec(subject);
			return [match?.length, match?.[40], sticky.lastIndex, RegExp.lastParen, RegExp.$9];
		});
		const re = new RegExp(source, "g");
		const projection = [];
		for (let i = 0; i < 3; i++) {
			const match = re.exec(subject);
			projection.push(match ? match[39] + match[40] : null, re.lastIndex);
		}
		return [trace, projection];
	})(),
	replacedPrototypeExec: (() => {
		const original = RegExp.prototype.exec;
		const seen = [];
		RegExp.prototype.exec = function (subject) {
			seen.push(subject);
			return original.call(this, subject);
		};
		try {
			const re = new RegExp(word);
			return [describe(re.exec("ab")), re.test("cd"), "ef".replace(re, "[$1]"), seen];
		} finally {
			RegExp.prototype.exec = original;
		}
	})(),
};

console.log(JSON.stringify(results));
