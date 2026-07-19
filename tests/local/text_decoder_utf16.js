const results = [];

function check(name, condition) {
	results.push([name, !!condition]);
}

function throwsTypeError(fn) {
	try {
		fn();
	} catch (error) {
		return error instanceof TypeError;
	}
	return false;
}

const le = new TextDecoder("utf-16le");
const be = new TextDecoder("UTF-16BE");
check(
	"canonical encoding names",
	le.encoding === "utf-16le" && be.encoding === "utf-16be",
);
check(
	"recognized labels",
	new TextDecoder(" utf-16 ").encoding === "utf-16le" &&
		new TextDecoder("ucs-2").encoding === "utf-16le" &&
		new TextDecoder("unicodefffe").encoding === "utf-16be",
);
check(
	"little and big endian BMP decoding",
	le.decode(new Uint8Array([0x61, 0x00, 0xac, 0x20])) === "a€" &&
		be.decode(new Uint8Array([0x00, 0x61, 0x20, 0xac])) === "a€",
);
check("NUL code unit", le.decode(new Uint8Array([0x00, 0x00, 0x61, 0x00])) === "\0a");
check(
	"surrogate pair decoding",
	le.decode(new Uint8Array([0x3d, 0xd8, 0x00, 0xde])) === "😀" &&
		be.decode(new Uint8Array([0xd8, 0x3d, 0xde, 0x00])) === "😀",
);

const leBom = new Uint8Array([0xff, 0xfe, 0x61, 0x00]);
const beBom = new Uint8Array([0xfe, 0xff, 0x00, 0x61]);
check(
	"default strips matching BOM",
	le.decode(leBom) === "a" && be.decode(beBom) === "a",
);
check(
	"ignoreBOM preserves matching BOM",
	new TextDecoder("utf-16le", { ignoreBOM: true }).decode(leBom) === "\uFEFFa" &&
		new TextDecoder("utf-16be", { ignoreBOM: true }).decode(beBom) === "\uFEFFa",
);
check(
	"opposite-endian BOM is data",
	le.decode(beBom) === "\uFFFE\u6100" && be.decode(leBom) === "\uFFFE\u6100",
);

check("odd trailing byte is replacement", le.decode(new Uint8Array([0x61])) === "\uFFFD");
check(
	"odd byte follows complete units",
	be.decode(new Uint8Array([0x00, 0x61, 0xff])) === "a\uFFFD",
);
check(
	"lone surrogates are replacement",
	le.decode(new Uint8Array([0x00, 0xd8])) === "\uFFFD" &&
		le.decode(new Uint8Array([0x00, 0xdc])) === "\uFFFD",
);
check(
	"mismatched surrogate does not consume following unit",
	le.decode(new Uint8Array([0x00, 0xd8, 0x61, 0x00])) === "\uFFFDa" &&
		le.decode(new Uint8Array([0x00, 0xd8, 0x01, 0xd8])) === "\uFFFD\uFFFD",
);
check(
	"replacement continues after malformed input",
	le.decode(new Uint8Array([0x00, 0xdc, 0x61, 0x00, 0x00, 0xd8])) === "\uFFFDa\uFFFD",
);

const fatalLe = new TextDecoder("utf-16le", { fatal: true });
check(
	"fatal rejects odd byte",
	throwsTypeError(() => fatalLe.decode(new Uint8Array([0x00]))),
);
check(
	"fatal rejects lone lead surrogate",
	throwsTypeError(() => fatalLe.decode(new Uint8Array([0x00, 0xd8]))),
);
check(
	"fatal rejects lone trail surrogate",
	throwsTypeError(() => fatalLe.decode(new Uint8Array([0x00, 0xdc]))),
);
check(
	"fatal rejects mismatched surrogate",
	throwsTypeError(() => fatalLe.decode(new Uint8Array([0x00, 0xd8, 0x61, 0x00]))),
);
check(
	"fatal decoder remains reusable",
	fatalLe.decode(new Uint8Array([0x61, 0x00])) === "a",
);
check(
	"DataView subrange uses selected encoding",
	be.decode(new DataView(new Uint8Array([0xff, 0x00, 0x61, 0xff]).buffer, 1, 2)) === "a",
);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
