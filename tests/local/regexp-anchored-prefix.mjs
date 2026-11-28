// Searches that `^` or the sticky flag confine to one position test a pattern's
// mandatory leading units before matching. Every outcome, lastIndex and legacy
// static must equal ordinary matching, for Latin-1 and UTF-16 subjects alike.
const wide = (text) => `${text}\u0100`;
const describe = (match) =>
	match === null
		? null
		: { index: match.index, values: [...match], groups: match.groups ?? null };
const statics = () => [
	RegExp.lastMatch,
	RegExp.$1,
	RegExp.leftContext,
	RegExp.rightContext,
];

function run(source, flags, subjects, lastIndices) {
	const re = new RegExp(source, flags);
	return subjects.map((subject, index) => {
		if (lastIndices !== undefined) re.lastIndex = lastIndices[index];
		const match = describe(re.exec(subject));
		return [
			subject,
			match,
			re.lastIndex,
			new RegExp(source, flags).test(subject),
			statics(),
		];
	});
}

const route = String.raw`^(?:\/users\/([^\/]+))(?:\/$)?$`;
const routeSubjects = [
	"/users/a%20b",
	"/USERS/x/",
	"/middleware",
	"/user",
	"/users/",
	"",
	"/Users/\u00e9/",
	"/u\u00dfers/x",
	wide("/users/a"),
	wide("/middleware"),
	"/users/a/b",
];

const results = {
	routeIgnoreCase: run(route, "i", routeSubjects),
	routeCaseSensitive: run(route, "", routeSubjects),
	pathToRegexpV0: run(String.raw`^\/users\/(?:([^\/]+?))\/?$`, "i", routeSubjects),
	literalRoutes: ["/json", "/JSON/", "/form", "/jsox", wide("/json")].map((path) =>
		[/^(?:\/json)(?:\/$)?$/i, /^(?:\/form)(?:\/$)?$/i, /^\/cookie$/].map((re) =>
			describe(re.exec(path)),
		),
	),
	unanchored: run(String.raw`\/users\/(\d+)`, "i", [
		"/api/users/7",
		"/api/USERS/x",
		wide("/USERS/9"),
	]),
	stickyUnanchored: run(
		String.raw`users\/(\d+)`,
		"y",
		[
			"/v1/users/42",
			"/v1/users/42",
			"/v1/users/42",
			"/v1/USERS/42",
			wide("/v1/users/42"),
		],
		[0, 4, 5, 4, 4],
	),
	stickyIgnoreCase: run("ab+c", "iy", ["xABBC", "xabbc", "xabd", "xa"], [1, 0, 1, 1]),
	stickyAnchored: run("^ab", "y", ["abab", "abab", "xab"], [0, 2, 0]),
	globalAnchored: (() => {
		const re = /^\/a/g;
		return [0, 1, 2].map(() => [describe(re.exec("/a/a")), re.lastIndex]);
	})(),
	globalUnanchored: (() => {
		const re = /\/a/gi;
		return [0, 1, 2, 3].map(() => [describe(re.exec("/a/A")), re.lastIndex]);
	})(),
	globalMatchAll: [..."/a/b/a".matchAll(/\/a/g)].map(describe),
	optionalPrefix: run(String.raw`^(?:api\/)?users`, "", [
		"users",
		"api/users",
		"apx/users",
	]),
	alternation: run(String.raw`^\/(?:json|form)\/x`, "i", [
		"/json/x",
		"/FORM/X",
		"/jsox/x",
		"/x",
	]),
	repeatPrefix: run("^a{2,4}b", "", ["aab", "aaaab", "aaaaab", "ab", "b"]),
	plusPrefix: run("^x+y", "i", ["xxXy", "y", "Xy", "xz"]),
	fixedRepeat: run("^a{3}c", "", ["aaac", "aac", "aaaac"]),
	longPrefix: run("^abcdefghijkl", "i", [
		"abcdefghijkl",
		"ABCDEFGHIJKX",
		"abcdefgh",
		"abcdefghijklm",
	]),
	captureInPrefix: run(String.raw`^\/(users)\/(\d+)`, "i", [
		"/users/9",
		"/USERS/9",
		"/usera/9",
	]),
	namedCapture: run(String.raw`^\/(?<kind>users)\/(?<id>\d+)$`, "", [
		"/users/9",
		"/userz/9",
	]),
	terminalLookahead: run(String.raw`^\/assets(?=$|\/)`, "i", [
		"/assets",
		"/ASSETS/x",
		"/assetsx",
		"/asset",
	]),
	expressMount: run(String.raw`^(?:\/assets)(?:\/$)?(?=\/|$)`, "i", [
		"/assets/a.css",
		"/missing",
	]),
	bitFivePairs: run("^[@`]x", "", ["@x", "`x", "Px", "px"]),
	latin1Pair: run("^[\u00c0\u00e0]b", "", ["\u00c0b", "\u00e0b", "Ab", wide("\u00e0b")]),
	nonLetterUnderIgnoreCase: run(String.raw`^\[x`, "i", ["[x", "{x", "[X"]),
	nonAsciiLiteral: run("^\u00e9+x", "", ["\u00e9x", "\u00c9x", wide("\u00e9\u00e9x")]),
	kelvinWithoutUnicode: run("^k", "i", ["\u212a", "K", "k"]),
	longSWithoutUnicode: run(String.raw`^\/s`, "i", ["/\u017f", "/S"]),
	unicodeFlag: run(String.raw`^\/users\/(\d+)`, "u", [
		"/users/1",
		"/USERS/1",
		wide("/users/2"),
	]),
	unicodeIgnoreCase: run("^\u212a", "iu", ["k", "K", "x"]),
	stringMethods: [
		"/users/7".replace(/^\/users\//i, "/u/"),
		"/x/users".replace(/^\/users\//i, "/u/"),
		"/x".search(/^\/users/),
		"/USERS".search(/^\/users/i),
		"/users/1".match(/^\/users\/(\d)/)?.[1] ?? null,
		"/cookie".match(/^\/users\/(\d)/),
		"a,b".split(/^a/),
	],
	staticsAfterMisses: (() => {
		/^\/users\/(\d+)/.exec("/users/5");
		const after = [];
		for (const path of ["/middleware", "/json", "/USERS/6"]) {
			/^\/users\/(\d+)/.test(path);
			after.push(statics());
		}
		return after;
	})(),
};

let routeHits = 0;
const loop = [/^(?:\/users\/([^\/]+))(?:\/$)?$/i, /^(?:\/json)(?:\/$)?$/i];
for (let index = 0; index < 2000; index++) {
	const path = ["/users/a", "/json", "/form", "/JSON/"][index % 4];
	for (const re of loop) {
		if (re.exec(path) !== null) {
			routeHits++;
			break;
		}
	}
}
results.routeLoop = [routeHits, RegExp.lastMatch, RegExp.$1];

console.log(JSON.stringify(results));
