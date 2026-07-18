"use strict";

/* eslint-disable -- This compatibility fixture intentionally executes pinned CommonJS. */

const etag = require("etag");
const signature = require("cookie-signature");
const crypto = require("crypto");
const canonicalCrypto = require("node:crypto");

const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}

const signed = signature.sign("session=maligator", "secret-key");
const tampered = signed.slice(0, -1) + (signed.endsWith("A") ? "B" : "A");
check("bare and canonical crypto identity", crypto === canonicalCrypto);
check(
	"etag string invokes SHA-1",
	etag("hello express") === '"d-WrS4wYWu7UhwRQb1Uiz84doLuyY"',
);
check(
	"etag Buffer invokes SHA-1 over bytes",
	etag(Buffer.from([0, 1, 2, 253, 254, 255])) === '"6-MnE5OMqVDfhPeNCKWXCs/hOkeJY"',
);
check(
	"cookie-signature invokes HMAC-SHA256",
	signed === "session=maligator.kpHI3xrUFJDNxq6ygBxXjpmB4wtYkiiBqc5+98efnZc",
);
check(
	"cookie-signature valid compare",
	signature.unsign(signed, "secret-key") === "session=maligator",
);
check(
	"cookie-signature tampered compare",
	signature.unsign(tampered, "secret-key") === false,
);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
