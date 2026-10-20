// Regenerates the forged-*.pem fixtures with Node: node tests/fixtures/tls/make-forged-certs.mjs
// The names hold bytes that OpenSSL-based tooling refuses to write, so the DER is built by hand.
import crypto from "node:crypto";
import fs from "node:fs";

/** @type {(tag: number, ...parts: Buffer[]) => Buffer} */
const tlv = (tag, ...parts) => {
	const body = Buffer.concat(parts);
	const length =
		body.length < 0x80
			? Buffer.from([body.length])
			: body.length < 0x100
				? Buffer.from([0x81, body.length])
				: Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
	return Buffer.concat([Buffer.from([tag]), length, body]);
};
/** @type {(...parts: Buffer[]) => Buffer} */
const seq = (...parts) => tlv(0x30, ...parts);
/** @type {(...bytes: number[]) => Buffer} */
const oid = (...bytes) => tlv(0x06, Buffer.from(bytes));
const CN = [0x55, 0x04, 0x03];
const OU = [0x55, 0x04, 0x0b];
/** @type {(type: number[], tag: number, value: string | Buffer) => Buffer} */
const attribute = (type, tag, value) =>
	tlv(0x31, seq(oid(...type), tlv(tag, Buffer.from(value))));
/** @type {(...rdns: Buffer[]) => Buffer} */
const name = (...rdns) => seq(...rdns);
/** @type {(date: Date) => Buffer} */
const utcTime = (date) =>
	tlv(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));

/** @type {(file: string, subject: Buffer, sanNames?: Buffer[]) => void} */
function certificate(file, subject, sanNames) {
	const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
		namedCurve: "P-256",
	});
	const algorithm = seq(oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02));
	const extensions =
		sanNames === undefined
			? []
			: [tlv(0xa3, seq(seq(oid(0x55, 0x1d, 0x11), tlv(0x04, seq(...sanNames)))))];
	const tbs = seq(
		tlv(0xa0, tlv(0x02, Buffer.from([2]))),
		tlv(0x02, Buffer.from([0x01, 0x23])),
		algorithm,
		subject,
		seq(
			utcTime(new Date("2026-01-01T00:00:00Z")),
			utcTime(new Date("2046-01-01T00:00:00Z")),
		),
		subject,
		publicKey.export({ type: "spki", format: "der" }),
		...extensions,
	);
	const signature = crypto.sign("sha256", tbs, privateKey);
	const der = seq(tbs, algorithm, tlv(0x03, Buffer.from([0]), signature));
	const pem = `-----BEGIN CERTIFICATE-----\n${der
		.toString("base64")
		.match(/.{1,64}/g)
		.join("\n")}\n-----END CERTIFICATE-----\n`;
	fs.writeFileSync(new URL(`${file}-cert.pem`, import.meta.url), pem);
	fs.writeFileSync(
		new URL(`${file}-key.pem`, import.meta.url),
		privateKey.export({ type: "pkcs8", format: "pem" }),
	);
}

/** @type {(tag: number, text: string) => Buffer} */
const general = (tag, text) => tlv(tag, Buffer.from(text, "latin1"));
certificate(
	"forged-name",
	name(
		attribute(CN, 0x0c, "guest\0SCN\0admin"),
		attribute(OU, 0x1e, Buffer.from([0x00, 0x41, 0x04, 0x14])),
		attribute(OU, 0x14, Buffer.from([0x23, 0xe4, 0x2c, 0x20])),
		attribute(OU, 0x1c, Buffer.from([0x00, 0x01, 0xf6, 0x00])),
	),
	[general(0x82, "x.test")],
);
certificate("forged-san", name(attribute(CN, 0x0c, "x.test")), [
	general(0x86, "https://x.test, DNS:victim.example"),
	general(0x82, "exämple.test"),
	general(0x81, '"quoted"@x.test'),
	tlv(0x87, Buffer.from("20010db8000000000000000000000001", "hex")),
	tlv(0x87, Buffer.from([1, 2, 3])),
	tlv(0x88, Buffer.from([0x2a, 0x03, 0x04])),
	tlv(0xa4, name(attribute(CN, 0x0c, "dir, name"))),
]);
