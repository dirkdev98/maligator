// Matches record the legacy statics lazily and copy short captures straight from the
// subject; fast plans also cover greedy runs before a continuation that cannot fail.
// Every case here must match Node, across subject encodings and representations.
const statics = () => ({
	input: RegExp.input,
	lastMatch: RegExp.lastMatch,
	lastParen: RegExp.lastParen,
	leftContext: RegExp.leftContext,
	rightContext: RegExp.rightContext,
	parens: [
		RegExp.$1,
		RegExp.$2,
		RegExp.$3,
		RegExp.$4,
		RegExp.$5,
		RegExp.$6,
		RegExp.$7,
		RegExp.$8,
		RegExp.$9,
	],
});
const describe = (match) =>
	match === null
		? null
		: {
				index: match.index,
				values: [...match],
				input: match.input,
				groups: match.groups === undefined ? undefined : { ...match.groups },
				indices: match.indices === undefined ? undefined : [...match.indices],
			};
const wide = (text) => `${text}Ā`;
// A rope, a slice and a fresh flat copy of the same text.
const shapes = (text) => [
	text,
	`${text.slice(0, 3)}${text.slice(3)}`,
	` ${text}`.slice(1),
];

const results = {};

results.staticsAfterMatchesAndMisses = (() => {
	const steps = [];
	const route = /^\/users\/([^/]+)(\/)?$/i;
	for (const subject of ["/users/42", "/USERS/a%20b/", "/missing", "/users/x"]) {
		steps.push({ test: route.test(subject), statics: statics() });
	}
	steps.push({ exec: describe(/(z)(q)?/.exec("xyz!")), statics: statics() });
	steps.push({ miss: /nothing/.exec("xyz!"), statics: statics() });
	return steps;
})();

results.inputSetter = (() => {
	const steps = [];
	/b(c)/.test("abcd");
	RegExp.input = "set by hand";
	steps.push(statics());
	/q/.test("abcd");
	steps.push(statics());
	/(d)/.test("abcd");
	steps.push(statics());
	RegExp.$_ = 42;
	steps.push({ input: RegExp.input, $_: RegExp.$_, lastMatch: RegExp.lastMatch });
	return steps;
})();

results.manyGroups = (() => {
	const re = /(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)?(l)/;
	const steps = [describe(re.exec("xabcdefghijlz")), statics()];
	re.test("abcdefghijkl");
	steps.push(statics());
	/(a)(b)?/.test("a");
	steps.push(statics());
	/no groups/.test("has no groups here");
	steps.push(statics());
	return steps;
})();

results.captureLengths = (() => {
	const re = /(\d*)-(\w)-(\w+)-(\w+)/;
	const subjects = [
		"-x-ab-abcdefghijklmnop",
		"123-y-abcdefghijklmnop-abcdefghijklmnopq",
		"9-z-sixteen_chars_xx-a",
	];
	return subjects.flatMap((text) =>
		[...shapes(text), ...shapes(wide(text))].map((subject) => describe(re.exec(subject))),
	);
})();

results.wideCaptures = (() => {
	const re = /([^,]+),([^,]+)/;
	return ["Āb,cd", "ab,Ā", "aé,bé", "ĀĀĀĀĀĀĀĀĀĀĀĀĀĀĀĀĀĀ,x"].map((subject) => ({
		match: describe(re.exec(subject)),
		statics: statics(),
	}));
})();

results.contentTypes = (() => {
	const re = /^\s*([^;\s]*)(?:;|\s|$)/;
	const subjects = [
		"application/json; charset=utf-8",
		"text/html",
		"  text/plain ;q=1",
		"",
		"   ",
		";",
		"　image/png",
		"a b",
		"x\ny",
		"multipart/form-data;boundary=x",
	];
	return subjects.flatMap((text) =>
		[...shapes(text), wide(text)].map((subject) => ({
			match: describe(re.exec(subject)),
			test: re.test(subject),
			lastParen: RegExp.lastParen,
		})),
	);
})();

results.continuationPlans = (() => {
	const cases = [
		[/\s*([^,]*)(?:,|$)/, [" a, b", "a", ",", "  ", "x y,z"]],
		[/\s*([^;\s]*)(?:;|\s|$)/g, ["a b;c", " ; ", "x"]],
		[/^(?:GET|POST) (\/\S*)/, ["GET /users", "POST /", "PUT /x", "get /a"]],
		[/^(?:a|b)c/, ["ac", "bc", "cc", "abc"]],
		[/(?:x(?:ab|c))+d/, ["xabxcd", "xcxd", "xabd"]],
	];
	return cases.map(([re, subjects]) =>
		subjects.map((subject) => {
			re.lastIndex = 0;
			const first = describe(re.exec(subject));
			return { first, lastIndex: re.lastIndex, all: subject.match(re) };
		}),
	);
})();

results.namedAndIndices = (() => {
	const named = /^\/(?<kind>[a-z]+)\/(?<id>[0-9a-z%]+)(?<slash>\/)?$/d;
	return ["/users/a%20b", "/posts/42/", "/x/", "/users/abcdefghijklmnopq"].map(
		(subject) => ({
			match: describe(named.exec(subject)),
			statics: statics(),
		}),
	);
})();

results.stickyAndGlobal = (() => {
	const sticky = /([a-z]+)=([0-9]+);?/y;
	const global = /([a-z]+)=([0-9]+)/g;
	const subject = "ab=1;cd=22;x=;ef=333";
	const steps = [];
	for (let i = 0; i < 4; i++) {
		steps.push({ sticky: describe(sticky.exec(subject)), lastIndex: sticky.lastIndex });
	}
	for (let i = 0; i < 5; i++) {
		steps.push({ global: describe(global.exec(subject)), lastIndex: global.lastIndex });
	}
	steps.push(statics());
	return steps;
})();

results.replacePatterns = (() => {
	const subject = "key=value; other=thing";
	return [
		subject.replace(/(\w+)=(\w+)/, "$2=$1"),
		subject.replace(/(\w+)=(\w+)/g, "[$&|$`|$']"),
		subject.replace(/(?<k>\w+)=(?<v>\w+)/g, "$<v>:$<k>"),
		subject.replace(/(\w)(x)?/g, "<$1$2>"),
		wide(subject).replace(
			/(\w+)=(\w+)/g,
			(all, k, v, offset) => `${v.length}${k}${offset}`,
		),
		statics(),
	];
})();

results.subclass = (() => {
	class Route extends RegExp {}
	const re = new Route("^/(\\w+)/(\\d+)$");
	const steps = [describe(re.exec("/item/12")), re.test("/item/x"), statics()];
	steps.push(describe(re.exec("/thing/7")), statics());
	return steps;
})();

console.log(JSON.stringify(results));
