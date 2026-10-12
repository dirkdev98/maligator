import { Buffer } from "node:buffer";

let coerced = false;
const values = [
	"utf8",
	"UTF-8",
	"utf16le",
	"utf-16le",
	"ucs2",
	"ucs-2",
	"latin1",
	"binary",
	"ascii",
	"hex",
	"base64",
	"base64url",
	"",
	"buffer",
	"utf_8",
	" utf8",
	undefined,
	null,
	7,
	1n,
	Symbol("s"),
	new String("utf8"),
	new Proxy(
		{},
		{
			get() {
				coerced = true;
				throw new Error("read");
			},
		},
	),
];
const results = values.map((value) => Buffer.isEncoding(value));
const instance = new Buffer.isEncoding("utf8");
const prototype = {};
const observations = [];
const target = new Proxy(function Target() {}, {
	get(object, key) {
		observations.push(String(key));
		return key === "prototype" ? prototype : Reflect.get(object, key);
	},
});
const derived = Reflect.construct(Buffer.isEncoding, ["bad"], target);
console.log(
	JSON.stringify({
		results,
		coerced,
		metadata: [Buffer.isEncoding.name, Buffer.isEncoding.length],
		construct: instance instanceof Buffer.isEncoding,
		derived: Object.getPrototypeOf(derived) === prototype,
		observations,
	}),
);
