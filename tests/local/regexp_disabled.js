// Runtime fixture for `engine.regexp: false`. Built with regexpEnabled: false, so
// regress + builtin_regexp.c / regexp_object.c are compiled away. The RegExp global
// is not installed (typeof RegExp === "undefined"), and the String methods that
// coerce their argument to a RegExp (match / matchAll / search) throw. Pure string
// ops (split / replace / includes / startsWith with string args) still work — that
// is the point of the fixture (it avoids a bare `/…/` literal, which the CLI's
// compile-time check would reject; the native harness has no such check, so a
// literal would be a runtime throw). The binary linking at all — with no regress
// symbols — is the core assertion.

const results = [];
results.push(["RegExp undefined", typeof RegExp === "undefined"]);

// String regex methods throw (they need a RegExp).
function throws(name, fn) {
	try {
		fn();
		results.push([name, false]);
	} catch {
		results.push([name, true]);
	}
}
throws("match throws", () => "abc".match("b"));
throws("matchAll throws", () => [..."abc".matchAll("b")]);
throws("search throws", () => "abc".search("b"));

// Pure string ops still work with string arguments.
results.push(["split works", "a,b,c".split(",").join("|") === "a|b|c"]);
results.push(["replace works", "abc".replace("b", "X") === "aXc"]);
results.push(["includes works", "abc".includes("b") === true]);
results.push(["startsWith works", "abc".startsWith("ab") === true]);

const original = { text: "clone", bytes: new ArrayBuffer(4) };
original.self = original;
new Uint8Array(original.bytes)[0] = 42;
const cloned = structuredClone(original, { transfer: [original.bytes] });
results.push(["clone preserves cycles", cloned !== original && cloned.self === cloned]);
results.push(["clone preserves data", cloned.text === "clone"]);
results.push([
	"clone transfers bytes",
	original.bytes.byteLength === 0 && new Uint8Array(cloned.bytes)[0] === 42,
]);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
