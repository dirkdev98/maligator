import querystring, {
	decode,
	encode,
	escape,
	parse,
	stringify,
	unescape,
	unescapeBuffer,
} from "node:querystring";

let passed = 0;
let total = 0;

function check(condition, name) {
	total++;
	if (condition) passed++;
	else console.log(`FAIL: ${name}`);
}

check(querystring.parse === parse && parse === decode, "parse aliases");
check(querystring.stringify === stringify && stringify === encode, "stringify aliases");
check(
	parse.length === 4 && stringify.length === 4 && escape.length === 1,
	"function metadata",
);

const parsed = parse("foo=bar&abc=xyz&abc=123");
check(Object.getPrototypeOf(parsed) === null, "parse returns null-prototype object");
check(parsed.foo === "bar" && parsed.abc.join(",") === "xyz,123", "parse pairs");
check(parse("a=>1&&b=>2", "&&", "=>").b === "2", "multi-code-unit separators");
check(parse("&=&=")[""].length === 2, "empty assignments");
check(Object.keys(parse("&&")).length === 0, "empty segments ignored");
check(
	Object.keys(parse("a=1&b=2", "&", "=", { maxKeys: 1 })).length === 1,
	"maxKeys limit",
);
check(
	Object.keys(parse("a=1&b=2", "&", "=", { maxKeys: 0 })).length === 2,
	"maxKeys unlimited",
);
const customDecoded = parse("a+b=c+d", null, null, {
	decodeURIComponent(value) {
		return `[${value}]`;
	},
});
check(customDecoded["[a%20b]"] === "[c%20d]", "custom decoder and plus handling");
check(parse("bad=%GG&utf8=%C3%A9").bad === "%GG", "malformed escape fallback");
check(parse("bad=%GG&utf8=%C3%A9").utf8 === "é", "UTF-8 decode");

check(escape("a b/é") === "a%20b%2F%C3%A9", "escape UTF-8");
check(unescape("a%20b+") === "a b+", "unescape leaves plus by default");
check(unescape("a+b", true) === "a b", "unescape optional space decoding");
const bytes = unescapeBuffer("a%20b+c", true);
check(Buffer.isBuffer(bytes) && bytes.toString() === "a b c", "unescapeBuffer bytes");

check(
	stringify({ foo: "bar", baz: ["qux", "quux"], nil: null }) ===
		"foo=bar&baz=qux&baz=quux&nil=",
	"stringify values and arrays",
);
check(
	stringify({ finite: 1.5, infinite: Infinity, bool: true, big: 2n }) ===
		"finite=1.5&infinite=&bool=true&big=2",
	"stringify primitive policy",
);
check(
	stringify({ a: "x y", b: [1, 2] }, ";;", "=>") === "a=>x%20y;;b=>1;;b=>2",
	"custom separators",
);
check(
	stringify({ a: "b c" }, "&", "=", {
		encodeURIComponent(value) {
			return `<${value}>`;
		},
	}) === "<a>=<b c>",
	"custom encoder",
);
let getterCalls = 0;
const getterObject = {
	get value() {
		getterCalls++;
		return "read";
	},
};
check(stringify(getterObject) === "value=read" && getterCalls === 1, "getter order");
check(stringify(null) === "" && stringify("text") === "", "non-object stringify");

let uriError = false;
try {
	escape("\ud800");
} catch (error) {
	uriError = error instanceof URIError;
}
check(uriError, "lone surrogate rejection");

console.log(`RESULT ${passed}/${total}`);
