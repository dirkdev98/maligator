import { Buffer } from "node:buffer";
import { createHash, hash } from "node:crypto";
import querystring from "node:querystring";
import { StringDecoder } from "node:string_decoder";

const results = [];

function check(name, value) {
	results.push([name, !!value]);
}

function throws(name, constructor, fn) {
	let error;
	try {
		fn();
	} catch (caught) {
		error = caught;
	}
	check(name, error instanceof constructor);
}

function bytesEqual(actual, expected) {
	if (actual.length !== expected.length) return false;
	for (let i = 0; i < expected.length; i++) {
		if (actual[i] !== expected[i]) return false;
	}
	return true;
}

function binaryString(bytes) {
	let output = "";
	for (let i = 0; i < bytes.length; i++) output += String.fromCharCode(bytes[i]);
	return output;
}

const vectors = [
	[[], "", ""],
	[[0xfb], "+w==", "-w=="],
	[[0xfb, 0xff], "+/8=", "-_8="],
	[[0xfb, 0xff, 0xef], "+//v", "-__v"],
	[[0xfb, 0xff, 0xef, 0x01], "+//vAQ==", "-__vAQ=="],
	[[0xfb, 0xff, 0xef, 0x01, 0x02], "+//vAQI=", "-__vAQI="],
	[[0xfb, 0xff, 0xef, 0x01, 0x02, 0x03], "+//vAQID", "-__vAQID"],
];

for (let i = 0; i < vectors.length; i++) {
	const input = new Uint8Array(vectors[i][0]);
	const standard = vectors[i][1];
	const url = vectors[i][2];
	const unpaddedStandard = standard.replace(/=+$/, "");
	const unpaddedUrl = url.replace(/=+$/, "");
	const suffix = " length " + input.length;

	check(
		"standard encoders agree" + suffix,
		input.toBase64() === standard &&
			Buffer.from(input).toString("base64") === standard &&
			btoa(binaryString(input)) === standard &&
			new StringDecoder("base64").end(Buffer.from(input)) === standard,
	);
	check(
		"URL encoders agree" + suffix,
		input.toBase64({ alphabet: "base64url" }) === url &&
			input.toBase64({ alphabet: "base64url", omitPadding: true }) === unpaddedUrl &&
			input.toBase64({ omitPadding: true }) === unpaddedStandard &&
			Buffer.from(input).toString("base64url") === unpaddedUrl &&
			new StringDecoder("base64url").end(Buffer.from(input)) === unpaddedUrl,
	);
	check(
		"strict decoders agree" + suffix,
		bytesEqual(Uint8Array.fromBase64(standard, { lastChunkHandling: "strict" }), input) &&
			bytesEqual(
				Uint8Array.fromBase64(url, {
					alphabet: "base64url",
					lastChunkHandling: "strict",
				}),
				input,
			) &&
			bytesEqual(Buffer.from(standard, "base64"), input) &&
			bytesEqual(Buffer.from(url, "base64url"), input) &&
			atob(standard) === binaryString(input),
	);
}

check(
	"Uint8Array alphabet policy is exact",
	bytesEqual(Uint8Array.fromBase64("-_8", { alphabet: "base64url" }), [0xfb, 0xff]),
);
throws("standard alphabet rejects URL digits", SyntaxError, () =>
	Uint8Array.fromBase64("-_8"),
);
throws("URL alphabet rejects standard digits", SyntaxError, () =>
	Uint8Array.fromBase64("+/8=", { alphabet: "base64url" }),
);

check(
	"Uint8Array loose padding and whitespace",
	bytesEqual(Uint8Array.fromBase64(" Z g = \t= \n"), [102]) &&
		bytesEqual(Uint8Array.fromBase64("Zg"), [102]),
);
throws("Uint8Array rejects partial padding", SyntaxError, () =>
	Uint8Array.fromBase64("Zg="),
);
throws("Uint8Array strict requires partial padding", SyntaxError, () =>
	Uint8Array.fromBase64("Zg", { lastChunkHandling: "strict" }),
);
throws("Uint8Array strict rejects nonzero extra bits", SyntaxError, () =>
	Uint8Array.fromBase64("Zh==", { lastChunkHandling: "strict" }),
);
check(
	"Uint8Array loose permits nonzero extra bits",
	bytesEqual(Uint8Array.fromBase64("Zh=="), [102]),
);
check(
	"Uint8Array stop-before-partial",
	bytesEqual(
		Uint8Array.fromBase64("Zm9v Zg", {
			lastChunkHandling: "stop-before-partial",
		}),
		[102, 111, 111],
	),
);

const bounded = new Uint8Array(4);
const boundedResult = bounded.setFromBase64("Zm9vYmFy");
check(
	"setFromBase64 stops before an overflowing block",
	boundedResult.read === 4 &&
		boundedResult.written === 3 &&
		bytesEqual(bounded, [102, 111, 111, 0]),
);
const tooSmall = new Uint8Array(2);
const tooSmallResult = tooSmall.setFromBase64("Zm9v");
check(
	"setFromBase64 does not partially write a full block",
	tooSmallResult.read === 0 &&
		tooSmallResult.written === 0 &&
		bytesEqual(tooSmall, [0, 0]),
);
const tailTarget = new Uint8Array(1);
const tailResult = tailTarget.setFromBase64("Zg= =");
check(
	"setFromBase64 reads a padded tail including whitespace",
	tailResult.read === 5 && tailResult.written === 1 && tailTarget[0] === 102,
);
const stoppedTarget = new Uint8Array(6);
const stoppedResult = stoppedTarget.setFromBase64("Zm9v Zg", {
	lastChunkHandling: "stop-before-partial",
});
check(
	"setFromBase64 leaves a stopped partial chunk unread",
	stoppedResult.read === 4 &&
		stoppedResult.written === 3 &&
		bytesEqual(stoppedTarget, [102, 111, 111, 0, 0, 0]),
);
const committed = new Uint8Array(4);
throws("setFromBase64 preserves SyntaxError after committed blocks", SyntaxError, () =>
	committed.setFromBase64("Zm9v!"),
);
check("setFromBase64 commits before error", bytesEqual(committed, [102, 111, 111, 0]));

check(
	"Node Buffer retains forgiving Base64 policy",
	Buffer.from("-_8= unrelated", "base64").toString("hex") === "fbff" &&
		Buffer.from("+/8=", "base64url").toString("hex") === "fbff" &&
		Buffer.from("A!A A", "base64").toString("hex") === "0000" &&
		Buffer.from("A", "base64").length === 0 &&
		Buffer.from("AAA", "base64").toString("hex") === "0000" &&
		Buffer.from("Zh==", "base64").toString() === "f",
);
check(
	"atob retains forgiving HTML policy",
	atob(" Z g = = \n") === "f" && atob("Zg") === "f" && atob("Zh==") === "f",
);
throws("atob rejects URL alphabet", DOMException, () => atob("-_8"));
throws("atob rejects invalid characters", DOMException, () => atob("AA!A"));
throws("atob rejects partial padding", DOMException, () => atob("Zg="));
throws("btoa retains Latin-1 exception", DOMException, () => btoa("\u0100"));
check("btoa accepts all Latin-1 bytes", btoa("\u0000\u00ff") === "AP8=");

const streamingStandard = new StringDecoder("base64");
let streamingOutput = "";
streamingOutput += streamingStandard.write(Buffer.from([0xfb]));
streamingOutput += streamingStandard.write(Buffer.from([0xff, 0xef, 1]));
streamingOutput += streamingStandard.write(Buffer.from([2]));
streamingOutput += streamingStandard.end(Buffer.from([3]));
const streamingUrl = new StringDecoder("base64url");
let streamingUrlOutput = "";
streamingUrlOutput += streamingUrl.write(Buffer.from([0xfb, 0xff]));
streamingUrlOutput += streamingUrl.write(Buffer.from([0xef]));
streamingUrlOutput += streamingUrl.end(Buffer.from([1, 2]));
check(
	"StringDecoder preserves streaming triple boundaries",
	streamingOutput === "+//vAQID" && streamingUrlOutput === "-__vAQI",
);

const hexBytes = new Uint8Array([0x00, 0x0f, 0xa5, 0xff]);
check(
	"lowercase hex encoders agree",
	hexBytes.toHex() === "000fa5ff" &&
		Buffer.from(hexBytes).toString("hex") === "000fa5ff" &&
		new StringDecoder("hex").write(Buffer.from(hexBytes)) === "000fa5ff",
);
check(
	"strict hex decode accepts both cases",
	bytesEqual(Uint8Array.fromHex("000FA5ff"), hexBytes),
);
throws("Uint8Array hex rejects odd input", SyntaxError, () => Uint8Array.fromHex("0"));
throws("Uint8Array hex rejects invalid input", SyntaxError, () =>
	Uint8Array.fromHex("00gg"),
);
check(
	"Node Buffer hex truncates odd and invalid tails",
	Buffer.from("000fa5f", "hex").toString("hex") === "000fa5" &&
		Buffer.from("000fgg", "hex").toString("hex") === "000f",
);
const boundedHex = new Uint8Array(2);
const boundedHexResult = boundedHex.setFromHex("000fa5ff");
check(
	"setFromHex is bounded with exact counts",
	boundedHexResult.read === 4 &&
		boundedHexResult.written === 2 &&
		bytesEqual(boundedHex, [0, 15]),
);
const committedHex = new Uint8Array(2);
throws("setFromHex preserves SyntaxError after committed bytes", SyntaxError, () =>
	committedHex.setFromHex("00gg"),
);
check("setFromHex commits before error", bytesEqual(committedHex, [0, 0]));
const oddHex = new Uint8Array([9]);
throws("setFromHex validates odd length before writing", SyntaxError, () =>
	oddHex.setFromHex("00f"),
);
check("setFromHex leaves odd input uncommitted", oddHex[0] === 9);

check(
	"crypto output uses shared standard Base64 and lowercase hex",
	createHash("sha1").update("abc").digest("base64") === "qZk+NkcGgWq6PiVxeFDCbJzQ2J0=" &&
		hash("sha256", "abc", "hex") ===
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
);

check(
	"URI percent hex remains uppercase and case-insensitive",
	encodeURIComponent("ÿ") === "%C3%BF" && decodeURIComponent("%66%6F%6f") === "foo",
);
check(
	"URI unchanged and reserved fast paths preserve semantics",
	encodeURI("https://example.com/a?b=c#d") === "https://example.com/a?b=c#d" &&
		encodeURIComponent("alpha-_.!~*'()") === "alpha-_.!~*'()" &&
		decodeURIComponent("plain-text_123") === "plain-text_123" &&
		decodeURI("%2f%3F%23%41") === "%2f%3F%23A",
);
check(
	"URI scalar encoding and decoding",
	encodeURIComponent("Málaga/東京 😀") ===
		"M%C3%A1laga%2F%E6%9D%B1%E4%BA%AC%20%F0%9F%98%80" &&
		decodeURIComponent("M%C3%A1laga%2F%E6%9D%B1%E4%BA%AC%20%F0%9F%98%80") ===
			"Málaga/東京 😀",
);
for (const [name, malformed] of [
	["truncated", "%"],
	["bad continuation", "%E2%28%A1"],
	["overlong", "%C0%AF"],
	["surrogate", "%ED%A0%80"],
	["out of range", "%F4%90%80%80"],
]) {
	throws("decodeURIComponent rejects " + name, URIError, () =>
		decodeURIComponent(malformed),
	);
}
let uriCoercions = 0;
check(
	"URI coercion occurs once before the native kernel",
	encodeURIComponent({
		toString() {
			uriCoercions++;
			return "a b";
		},
	}) === "a%20b" && uriCoercions === 1,
);
check(
	"legacy URI globals use exact escape forms",
	escape("safe/@+ 東") === "safe/@+%20%u6771" &&
		unescape("safe/@+%20%u6771") === "safe/@+ 東" &&
		unescape("%u12xz%QZ") === "%u12xz%QZ",
);
check(
	"query decoders share only percent hex semantics",
	querystring.parse("x=%66%6F%6f&bad=%GG").x === "foo" &&
		querystring.parse("x=%66%6F%6f&bad=%GG").bad === "%GG" &&
		new URLSearchParams("x=%66%6F%6f&bad=%GG").get("x") === "foo" &&
		new URLSearchParams("x=%66%6F%6f&bad=%GG").get("bad") === "%GG" &&
		new URLSearchParams({ x: "ÿ" }).toString() === "x=%C3%BF",
);

const large = new Uint8Array(2049);
for (let i = 0; i < large.length; i++) large[i] = (i * 29 + 17) & 0xff;
const largeStandard = large.toBase64();
const largeUrl = large.toBase64({ alphabet: "base64url", omitPadding: true });
check(
	"large Base64 inputs agree and round trip",
	largeStandard === Buffer.from(large).toString("base64") &&
		largeUrl === Buffer.from(large).toString("base64url") &&
		bytesEqual(Uint8Array.fromBase64(largeStandard), large) &&
		bytesEqual(Uint8Array.fromBase64(largeUrl, { alphabet: "base64url" }), large),
);
check(
	"large lowercase hex inputs agree and round trip",
	large.toHex() === Buffer.from(large).toString("hex") &&
		bytesEqual(Uint8Array.fromHex(large.toHex()), large),
);

let passed = 0;
for (let i = 0; i < results.length; i++) {
	if (results[i][1]) {
		passed++;
	} else {
		console.log("FAIL: " + results[i][0]);
	}
}
console.log("RESULT " + passed + "/" + results.length);
