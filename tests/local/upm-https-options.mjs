import https from "node:https";
const constraints = [
	"ca",
	"servername",
	"rejectUnauthorized",
	"checkServerIdentity",
	"cert",
	"key",
	"pfx",
	"passphrase",
	"minVersion",
	"maxVersion",
	"ciphers",
	"secureContext",
	"secureOptions",
	"ALPNProtocols",
	"createConnection",
	"lookup",
	"psk",
	"pskCallback",
	"sessionIdContext",
];
let passed = 0,
	total = 0;
for (const name of constraints) {
	for (const agent of [false, true]) {
		total++;
		try {
			if (agent) new https.Agent({ [name]: "unsupported" });
			else https.request({ hostname: "localhost", [name]: "unsupported" });
			console.log("FAIL: ignored " + name);
		} catch (error) {
			if (error.message.includes(name)) {
				passed++;
			} else console.log("FAIL: unexpected " + error.message);
		}
	}
}
for (const agent of [{}, new https.Agent()]) {
	total++;
	try {
		https.request({ hostname: "localhost", agent });
		console.log("FAIL: custom agent ignored");
	} catch (error) {
		if (error.message.includes("agents")) passed++;
	}
}
const original = https.globalAgent;
https.globalAgent = { ca: "unsupported" };
total++;
try {
	https.request({ hostname: "localhost", agent: https.globalAgent });
	console.log("FAIL: mutable globalAgent accepted");
} catch (error) {
	if (error.message.includes("agents")) passed++;
} finally {
	https.globalAgent = original;
}
for (const options of [
	{ hostname: "localhost", agent: false },
	{ hostname: "localhost", agent: original },
]) {
	total++;
	try {
		https.request(options).destroy();
		passed++;
	} catch (error) {
		console.log("FAIL: default agent rejected " + error.message);
	}
}
console.log("RESULT " + passed + "/" + total);
