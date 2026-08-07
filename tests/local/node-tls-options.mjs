// tls.connect's option validation, which runs entirely before any socket work,
// so a plain object stands in for the socket.
//
// Every check here is a refusal. The property under test is that an option this
// connector does not implement is an error rather than a silent omission: a
// caller that passes a client certificate, pins a minimum version, or asks for a
// protocol over ALPN must not get a connection that quietly did none of those.
import { connect } from "node:tls";

const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}

function refusal(options) {
	try {
		connect({ socket: {}, servername: "localhost", ...options });
		return null;
	} catch (error) {
		return String(error && error.message);
	}
}

// A credential, a trust decision, and a negotiation constraint: none are wired
// through, so all three have to be refused.
for (const option of ["cert", "key", "minVersion", "checkServerIdentity", "ciphers"]) {
	const message = refusal({ [option]: "x" });
	check(`${option} is refused`, message !== null && message.includes(option));
}

// ALPN is passed through for the one shape the host ABI can carry, and refused
// for the shapes it cannot — rather than collapsed onto a hardcoded protocol.
check(
	"a multi-protocol ALPN list is refused",
	(refusal({ ALPNProtocols: ["h2", "http/1.1"] }) ?? "").includes("ALPNProtocols"),
);
check(
	"a non-string ALPN entry is refused",
	(refusal({ ALPNProtocols: [42] }) ?? "").includes("ALPNProtocols"),
);
check(
	"an empty ALPN entry is refused",
	(refusal({ ALPNProtocols: [""] }) ?? "").includes("ALPNProtocols"),
);
check(
	"an ALPN buffer is refused",
	(refusal({ ALPNProtocols: new Uint8Array([1, 2]) }) ?? "").includes("ALPNProtocols"),
);

// A non-boolean rejectUnauthorized must not be read as a decision either way.
check(
	"a non-boolean rejectUnauthorized is refused",
	(refusal({ rejectUnauthorized: "yes" }) ?? "").includes("rejectUnauthorized"),
);

// The supported PostgreSQL shape still gets past validation: it fails later, at
// the socket, which is a different message from any refusal above.
const postgres = refusal({ ALPNProtocols: ["postgresql"], rejectUnauthorized: false });
check(
	"the postgresql ALPN shape passes validation",
	postgres !== null && postgres.includes("Failed to start TLS"),
);
// And so does a plain verified connection with no ALPN at all.
const plain = refusal({ ca: "-----BEGIN CERTIFICATE-----\n" });
check(
	"a verified connection with a ca passes validation",
	plain !== null && plain.includes("Failed to start TLS"),
);

const passed = results.filter(([, ok]) => ok).length;
for (const [name, ok] of results) if (!ok) console.log(`FAIL ${name}`);
console.log(`RESULT ${passed}/${results.length}`);
