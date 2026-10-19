import url from "node:url";

// Cases from Node's test-url-relative.js plus protocol, auth and host edge cases.
const cases = [
	["/foo/bar/baz", "quux"],
	["/foo/bar/baz", "quux/asdf"],
	["/foo/bar/baz", "quux/baz"],
	["/foo/bar/baz", "../quux/baz"],
	["/foo/bar/baz", "/bar"],
	["/foo/bar/baz/", "quux"],
	["/foo/bar/baz/", "quux/baz"],
	["/foo/bar/baz", "../../../../../../../../quux/baz"],
	["/foo/bar/baz", "../../../../../../../quux/baz"],
	["/foo", "."],
	["/foo", ".."],
	["/foo/", "."],
	["/foo/", ".."],
	["/foo/bar", "."],
	["/foo/bar", ".."],
	["/foo/bar/", "."],
	["/foo/bar/", ".."],
	["foo/bar", "../../../baz"],
	["foo/bar/", "../../../baz"],
	["http://example.com/b//c//d;p?q#blarg", "https:#hash2"],
	["http://example.com/b//c//d;p?q#blarg", "https:/p/a/t/h?s#hash2"],
	["http://example.com/b//c//d;p?q#blarg", "https://u:p@h.com/p/a/t/h?s#hash2"],
	["http://example.com/b//c//d;p?q#blarg", "https:/a/b/c/d"],
	["http://example.com/b//c//d;p?q#blarg", "http:#hash2"],
	["http://example.com/b//c//d;p?q#blarg", "http:/p/a/t/h?s#hash2"],
	["http://example.com/b//c//d;p?q#blarg", "http://u:p@h.com/p/a/t/h?s#hash2"],
	["http://example.com/b//c//d;p?q#blarg", "http:/a/b/c/d"],
	["/foo/bar/baz", "/../etc/passwd"],
	["http://localhost", "file:///Users/foo"],
	["http://localhost", "file://foo/Users"],
	["https://registry.npmjs.org", "@foo/bar"],
	["http://a/b/c/d;p?q", "g:h"],
	["http://a/b/c/d;p?q", "g"],
	["http://a/b/c/d;p?q", "./g"],
	["http://a/b/c/d;p?q", "g/"],
	["http://a/b/c/d;p?q", "/g"],
	["http://a/b/c/d;p?q", "//g"],
	["http://a/b/c/d;p?q", "?y"],
	["http://a/b/c/d;p?q", "g?y"],
	["http://a/b/c/d;p?q", "#s"],
	["http://a/b/c/d;p?q", "g#s"],
	["http://a/b/c/d;p?q", "g?y#s"],
	["http://a/b/c/d;p?q", ";x"],
	["http://a/b/c/d;p?q", "g;x"],
	["http://a/b/c/d;p?q", ""],
	["http://a/b/c/d;p?q", "."],
	["http://a/b/c/d;p?q", "./"],
	["http://a/b/c/d;p?q", ".."],
	["http://a/b/c/d;p?q", "../"],
	["http://a/b/c/d;p?q", "../g"],
	["http://a/b/c/d;p?q", "../.."],
	["http://a/b/c/d;p?q", "../../g"],
	["http://a/b/c/d;p?q", "../../../g"],
	["http://a/b/c/d;p?q", "/./g"],
	["http://a/b/c/d;p?q", "g.."],
	["http://a/b/c/d;p?q", "./../g"],
	["http://a/b/c/d;p?q", "g;x=1/../y"],
	["http://a/b/c/d;p?q", "http:g"],
	["http://user:pw@a.com/x", "//b.com/y"],
	["http://user:pw@a.com/x", "/y"],
	["http://user:pw@a.com/x", "http://other.com"],
	["mailto:local1@domain1", "local2@domain2"],
	["mailto:local1@domain1", "?subject=hi"],
	["mailto:a@b", "mailto:c@d"],
	["javascript:void(0)", "x"],
	["news:comp.lang", "other"],
	["http://example.com", "//cdn.example.com/lib.js"],
	["http://example.com", "ws://example.com/socket"],
	["http://example.com:8080/a/b", "../c?d=e#f"],
	["file:///a/b/c", "../d"],
	["file:///a/b/c", "file:z"],
	["", "relative"],
	["http://example.com/dir/", "x y"],
];
for (const [from, to] of cases) {
	console.log(JSON.stringify([from, to, url.resolve(from, to)]));
}
for (const input of [
	"http://a b/",
	"HTTP://User:P%40ss@ExAmple.COM:8080/p?q#h",
	"http://[::1]:3000/x",
	"javascript:alert(1)",
	"mailto:local1@domain1",
	"//foo/bar",
	"/simple/path?x=1",
	"x y",
	"http://a@b@c/",
	"http://a@b?@c",
	"http://xn--n3h.com/",
	"  http://a.com/ ",
	"http:\\\\a.com\\b?c\\d",
	"http://a.com:/x",
	"git+ssh://git@github.com:22/x.git",
	"ws://h.com",
	"file:///etc/passwd",
	"HTTP://H.com",
	"http://a.com/p\tq\nr",
	"https://a.com/?q='<>`",
	"http://a:b/",
	"http://[::1%25]/",
	"",
	"?only=query",
	"#only-hash",
]) {
	try {
		console.log(JSON.stringify(input), JSON.stringify(url.parse(input)));
	} catch (error) {
		console.log(
			JSON.stringify(input),
			error.name,
			error.code,
			error.message,
			error.input,
		);
	}
}
console.log(JSON.stringify(url.parse("http://a.com/?x=1&y=2", true).query));
console.log(
	Object.getPrototypeOf(url.parse("http://a.com/", true).query),
	url.parse("http://a.com/", true).search,
);
console.log(
	JSON.stringify(url.parse("//foo/bar", false, true)),
	JSON.stringify(url.parse("/p?a=b", true).query),
);
try {
	url.parse(1);
} catch (error) {
	console.log(error.code, error.message);
}
const target = new url.Url();
console.log(target.parse("http://z.com/a") === target, target.href);
const resolved = url.resolveObject("http://u@a.com/b/c?d#e", "../x?y");
console.log(JSON.stringify(Object.entries(resolved)));
console.log(
	resolved instanceof url.Url,
	url.resolveObject("", "x"),
	url.resolveObject(null, { a: 1 }).a,
);
const parsed = url.parse("http://a.com/b/c");
console.log(parsed.resolve("d"), parsed.resolveObject("/e").href, parsed.format());
console.log(
	url.resolve.length,
	url.resolveObject.length,
	url.Url.prototype.resolve.length,
);
try {
	url.resolve(1, "x");
} catch (error) {
	console.log(error.name);
}

const util = await import("node:util");
const extended = util._extend({ x: 0 }, { a: 1, b: 2 });
console.log(
	JSON.stringify(Object.keys(extended)),
	util._extend.name,
	util._extend.length,
);
console.log(
	util._extend({ k: 1 }, null).k,
	util._extend({ k: 1 }, () => {}).k,
	util._extend(7, "ab"),
);
try {
	util._extend(null, { a: 1 });
} catch (error) {
	console.log(error.name);
}
try {
	util.markPromiseAsHandled({});
} catch (error) {
	console.log(error.code, error.message);
}
console.log(
	util.markPromiseAsHandled(Promise.reject(new Error("handled"))),
	util.markPromiseAsHandled.length,
);
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("no unhandled rejection");

const { Buffer, transcode } = await import("node:buffer");
const hex = (value) => Buffer.from(value).toString("hex");
const text = Buffer.from("h€é\u{1f600}", "utf8");
const wide = Buffer.from("h€é\u{1f600}\ud800", "utf16le");
const bytes = Buffer.from([0x68, 0xe9, 0xff, 0x80]);
for (const [input, from, to] of [
	[text, "utf8", "ascii"],
	[text, "utf8", "latin1"],
	[text, "utf8", "ucs2"],
	[text, "UTF-8", "utf-16le"],
	[text, "utf8", "binary"],
	[text, "utf8", "utf8"],
	[bytes, "latin1", "utf8"],
	[bytes, "ascii", "utf8"],
	[bytes, "latin1", "ucs2"],
	[bytes, "ascii", "ucs2"],
	[bytes, "latin1", "ascii"],
	[wide, "ucs2", "latin1"],
	[wide, "ucs2", "utf8"],
	[Buffer.from([0x61, 0]), "ucs2", "ucs2"],
	[Buffer.from([0x61]), "ucs2", "utf8"],
	[Buffer.from([0xff]), "utf8", "ucs2"],
	[Buffer.from([0x61, 0xc3, 0x28, 0xe2, 0x82]), "utf8", "utf8"],
	[Buffer.from("a"), "utf8", "hex"],
	[Buffer.from("a"), "base64", "utf8"],
	[new Uint8Array([97]), "UTF8", "ASCII"],
	[Buffer.alloc(0), "nope", "nope"],
	["x", "utf8", "ascii"],
]) {
	try {
		const result = transcode(input, from, to);
		console.log(from, to, hex(result), result instanceof Buffer);
	} catch (error) {
		console.log(
			from,
			to,
			error.name,
			error.code,
			error.errno,
			error.message,
			JSON.stringify(Object.keys(error)),
		);
	}
}
console.log(transcode.length);
const { resolveObjectURL } = await import("node:buffer");
console.log(
	resolveObjectURL("blob:nodedata:unknown"),
	resolveObjectURL("not a url"),
	resolveObjectURL.length,
);
try {
	resolveObjectURL(Symbol("x"));
} catch (error) {
	console.log(error.name);
}

const net = await import("node:net");
console.log(
	net.getDefaultAutoSelectFamily(),
	net.getDefaultAutoSelectFamilyAttemptTimeout(),
);
for (const value of [undefined, 1, "x", false, true]) {
	try {
		net.setDefaultAutoSelectFamily(value);
		console.log("set", value, net.getDefaultAutoSelectFamily());
	} catch (error) {
		console.log(error.code, error.message);
	}
}
for (const value of [undefined, 5, 10, 750, 10.5, -1, "1", 2 ** 31, Number.NaN]) {
	try {
		net.setDefaultAutoSelectFamilyAttemptTimeout(value);
		console.log("set", value, net.getDefaultAutoSelectFamilyAttemptTimeout());
	} catch (error) {
		console.log(error.code, error.message);
	}
}
console.log(
	net.setDefaultAutoSelectFamily.length,
	net.getDefaultAutoSelectFamilyAttemptTimeout.length,
);

const { debounce } = util;
const debounceCalls = [];
const debounced = debounce(function (value) {
	debounceCalls.push([this === debounced, value]);
	return value * 2;
}, 20);
console.log(
	debounced.name,
	debounced.length,
	typeof debounced.cancel,
	debounced.pendingCount,
	debounced.pending,
);
console.log(JSON.stringify(Object.keys(debounced)));
const firstCall = debounced(1);
const secondCall = debounced(2);
console.log(debounced.pendingCount, debounced.pending === secondCall);
console.log(
	await firstCall,
	await secondCall,
	JSON.stringify(debounceCalls),
	debounced.pendingCount,
);
const leadingCall = debounce((value) => value, 10, { leading: true });
console.log(await leadingCall("now"));
const superseded = debounce((value) => value, 10, { rejectOnCancel: true });
const supersededFirst = superseded(1);
const supersededSecond = superseded(2);
console.log(
	JSON.stringify(
		await supersededFirst.catch((error) => [error.name, error.code, error.message]),
	),
	await supersededSecond,
);
const cancelled = debounce(() => 1, 10);
const cancelledCall = cancelled();
cancelled.cancel("why");
console.log(
	JSON.stringify(
		await cancelledCall.catch((error) => [
			error.name,
			error.code,
			error.message,
			error.cause,
		]),
	),
);
const flushed = debounce((value) => value + 1, 1000);
const flushedCall = flushed(1);
flushed.flush();
console.log(await flushedCall, flushed.pendingCount);
const controller = new AbortController();
const signalled = debounce(() => 1, 10, { signal: controller.signal });
const signalledCall = signalled();
controller.abort("stop");
console.log(
	JSON.stringify(await signalledCall.catch((error) => [error.name, error.cause])),
	await signalled().catch((error) => error.name),
);
const throwing = debounce(() => {
	throw new Error("boom");
}, 5);
console.log(await throwing().catch((error) => error.message));
console.log(debounced.ref() === debounced, debounced.unref() === debounced);
for (const args of [
	[1, 1],
	[() => {}, -1],
	[() => {}, 1.5],
	[() => {}, 1, null],
	[() => {}, 1, { leading: 1 }],
	[() => {}, 1, { signal: {} }],
	[() => {}, 1, { signal: AbortSignal.abort("early") }],
]) {
	try {
		debounce(...args);
		console.log("created");
	} catch (error) {
		console.log(error.name, error.code, error.message.split(". Received")[0]);
	}
}
