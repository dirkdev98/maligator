let count = 0;
let hash = 2166136261;
function observe(value) {
	const text = JSON.stringify(value);
	for (let i = 0; i < text.length; i++)
		hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
	count++;
}
const patterns = [
	"^(?=$|/)",
	"^/([^\\/]+?)(?=$|/)",
	"(a+?)(?=$|[bc])",
	"(?<word>[^\\/]+)(?=$|/)",
	"a+?(?=$|a)",
	"a(?=$|b)c",
];
const subjects = [
	"",
	"/",
	"/posts/p499",
	"/POSTS/",
	"/posts\n",
	"/a\u2028b/x",
	"xaaab",
	"aaac",
	"aa",
	"/é/",
	"/中/",
	"/😀/",
	"/\ud800/",
];
function check(pattern, flags, subject, start) {
	const re = new RegExp(pattern, flags);
	re.lastIndex = start;
	const result = re.exec(subject);
	observe([
		result && [...result],
		result?.index,
		result?.groups,
		result?.indices,
		re.lastIndex,
	]);
	re.lastIndex = start;
	observe([re.test(subject), re.lastIndex]);
	re.lastIndex = start;
	observe([subject.match(re), re.lastIndex]);
}
for (const flags of [
	"",
	"i",
	"d",
	"g",
	"y",
	"gi",
	"gy",
	"dg",
	"dy",
	"m",
	"s",
	"u",
	"v",
]) {
	for (const subject of ["/posts/p499", "/POSTS", "/中/", "/😀/"]) {
		for (const start of [0, 1]) check(patterns[1], flags, subject, start);
	}
}
for (const pattern of patterns) {
	for (const subject of subjects) check(pattern, "", subject, 0);
}
for (const subject of ["k", "K", "s", "ſ"]) check("^(?=$|[a-z])", "i", subject, 0);
const route = /^\/([^/]+?)(?=$|\/)/;
const first = route.exec("/posts/p499");
observe([first[0], first[1], RegExp.$1, RegExp.lastMatch, RegExp["$'"]]);
observe([route.exec("no route"), RegExp.$1, RegExp.lastMatch]);
let conversions = 0;
route.lastIndex = {
	valueOf() {
		conversions++;
		return 7;
	},
};
observe([route.test("/posts/p499"), conversions, typeof route.lastIndex]);
let calls = 0;
route.exec = () => {
	calls++;
	return null;
};
observe([route.test("/posts/p499"), "/posts/p499".match(route), calls]);
class Route extends RegExp {
	exec(subject) {
		calls++;
		return super.exec(subject);
	}
}
const subclass = new Route("^/([^\\/]+?)(?=$|/)");
observe([subclass.test("/posts/p499"), subclass.exec("/posts/p499")[1], calls]);
for (const flags of ["g", "y"]) {
	const frozen = new RegExp("^/([^\\/]+?)(?=$|/)", flags);
	Object.defineProperty(frozen, "lastIndex", { writable: false });
	try {
		frozen.test("/posts/p499");
		observe("missing throw");
	} catch (error) {
		observe(error.constructor.name);
	}
}
console.log(count, hash >>> 0);
