import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const names = [
	"utf8",
	"utf-8",
	"ucs2",
	"ucs-2",
	"utf16le",
	"utf-16le",
	"latin1",
	"binary",
	"ascii",
	"hex",
	"base64",
	"base64url",
];
const inputs = names.flatMap((name) => [
	name,
	name.toUpperCase(),
	name.slice(0, 2) + name[2].toUpperCase() + name.slice(3),
]);
inputs.push("base65", "utf8 ", "utF\0", "Ŭtf8", "base64urlx", undefined);

const text = "e9f0 café!";
const bytes = Buffer.from([0x61, 0, 0xc3, 0xa9, 0x80, 0xff]);

function observe(operation) {
	try {
		const result = operation();
		return Buffer.isBuffer(result) ? { bytes: result.toString("hex") } : result;
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		return { error: error.name };
	}
}

for (const encoding of inputs) {
	const written = Buffer.alloc(32);
	console.log(
		JSON.stringify({
			encoding: encoding ?? null,
			known: Buffer.isEncoding(encoding),
			from: observe(() => Buffer.from(text, encoding)),
			toString: observe(() => bytes.toString(encoding)),
			byteLength: Buffer.byteLength("e9f0", encoding),
			write: observe(() => written.subarray(0, written.write(text, 0, 32, encoding))),
			fill: observe(() => Buffer.alloc(16, text, encoding)),
			hashUpdate: createHash("sha1").update(text, encoding).digest("hex"),
			hashDigest: observe(() => createHash("sha1").update(text).digest(encoding)),
			stringDecoder: observe(() => {
				const decoder = new StringDecoder(encoding);
				return { name: decoder.encoding, value: decoder.end(bytes) };
			}),
		}),
	);
}
