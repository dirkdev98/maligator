import tls, { checkServerIdentity, getCACertificates, getCiphers } from "node:tls";

const lines = [];
const show = (label, value) => lines.push(`${label} ${JSON.stringify(value)}`);
const cert = {
	subject: { CN: "example.com" },
	subjectaltname:
		"DNS:example.com, DNS:*.example.org, IP Address:10.0.0.1, IP Address:::1",
};
for (const host of [
	"example.com",
	"a.example.org",
	"b.c.example.org",
	"10.0.0.1",
	"10.0.0.2",
	"0:0:0:0:0:0:0:1",
	"EXAMPLE.COM.",
	"other.com",
]) {
	const error = checkServerIdentity(host, cert);
	show(
		host,
		error === undefined
			? "ok"
			: [
					error.name,
					error.code,
					error.message,
					error.reason,
					error.host,
					error.cert === cert,
				],
	);
}
show("cn only", [
	checkServerIdentity("api.example.net", { subject: { CN: "*.example.net" } }) ?? "ok",
	checkServerIdentity("x.com", { subject: { CN: "y.com" } })?.reason,
]);
show(
	"cn list",
	checkServerIdentity("b.com", { subject: { CN: ["a.com", "b.com"] } }) ?? "ok",
);
show(
	"tld wildcard",
	checkServerIdentity("a.com", { subjectaltname: "DNS:*.com" })?.reason,
);
show("no names", checkServerIdentity("x.com", { subject: {} })?.message);
show("constants", [
	tls.DEFAULT_MIN_VERSION,
	tls.DEFAULT_MAX_VERSION,
	tls.DEFAULT_ECDH_CURVE,
	tls.CLIENT_RENEG_LIMIT,
	tls.CLIENT_RENEG_WINDOW,
	typeof tls.DEFAULT_CIPHERS,
]);
const ciphers = getCiphers();
show("ciphers", [
	Array.isArray(ciphers),
	ciphers.every((name) => name === name.toLowerCase()),
	ciphers.includes("tls_aes_128_gcm_sha256"),
]);
const roots = tls.rootCertificates;
show("rootCertificates", [
	Object.isFrozen(roots),
	roots.length > 0,
	roots.every(
		(pem) =>
			pem.startsWith("-----BEGIN CERTIFICATE-----") &&
			pem.endsWith("-----END CERTIFICATE-----"),
	),
	tls.rootCertificates === roots,
]);
show("getCACertificates", [
	Array.isArray(getCACertificates()),
	Array.isArray(getCACertificates("system")),
]);
try {
	getCACertificates("bogus");
} catch (error) {
	show("bad type", [error.code, error.message]);
}
console.log(lines.join("\n"));
