import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";

function check(value, message) {
	if (!value) throw new Error(message);
}

function thrown(callback) {
	try {
		callback();
	} catch (error) {
		return error;
	}
	return undefined;
}

function encodeName(name) {
	const parts = [];
	for (const label of name.split(".")) {
		parts.push(label.length, ...Buffer.from(label, "latin1"));
	}
	parts.push(0);
	return parts;
}

function u16(value) {
	return [value >> 8, value & 0xff];
}

function u32(value) {
	return [
		(value >>> 24) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 8) & 0xff,
		value & 0xff,
	];
}

function characterStrings(...texts) {
	return texts.flatMap((text) => [text.length, ...Buffer.from(text, "latin1")]);
}

const TYPES = {
	NS: 2,
	CNAME: 5,
	SOA: 6,
	PTR: 12,
	MX: 15,
	TXT: 16,
	SRV: 33,
	NAPTR: 35,
	TLSA: 52,
	CAA: 257,
};

// Record data served for each type; every answer's owner name points back at the question.
const ANSWERS = {
	[TYPES.SRV]: [
		[...u16(0), ...u16(5), ...u16(27017), ...encodeName("a.cluster.test")],
		[...u16(1), ...u16(0), ...u16(27018), ...encodeName("b.cluster.test")],
	],
	[TYPES.TXT]: [
		characterStrings("authSource=admin", "replicaSet=rs0"),
		characterStrings("caf\xe9"),
	],
	[TYPES.MX]: [[...u16(10), ...encodeName("mx1.mail.test")]],
	[TYPES.CNAME]: [encodeName("target.test")],
	[TYPES.NS]: [encodeName("ns1.test"), encodeName("ns2.test")],
	[TYPES.PTR]: [encodeName("host.test")],
	[TYPES.NAPTR]: [
		[
			...u16(100),
			...u16(10),
			...characterStrings("s", "SIP+D2U", ""),
			...encodeName("_sip._udp.test"),
		],
	],
	[TYPES.SOA]: [
		[
			...encodeName("ns1.test"),
			...encodeName("hostmaster.test"),
			...u32(4000000000),
			...u32(7200),
			...u32(3600),
			...u32(1209600),
			...u32(300),
		],
	],
	[TYPES.CAA]: [
		[0, 5, ...Buffer.from("issue"), ...Buffer.from("letsencrypt.org")],
		[128, 5, ...Buffer.from("iodef"), ...Buffer.from("mailto:x@test")],
	],
	[TYPES.TLSA]: [[3, 1, 1, 0xde, 0xad, 0xbe, 0xef]],
};

const RCODES = { "nxdomain.test": 3, "servfail.test": 2, "refused.test": 5 };

function respond(query) {
	let offset = 12;
	const labels = [];
	while (query[offset] !== 0) {
		labels.push(
			query.subarray(offset + 1, offset + 1 + query[offset]).toString("latin1"),
		);
		offset += query[offset] + 1;
	}
	const questionEnd = offset + 5;
	const name = labels.join(".").toLowerCase();
	const type = query.readUInt16BE(offset + 1);
	const rcode = RCODES[name] ?? 0;
	const records = rcode === 0 && name !== "nodata.test" ? (ANSWERS[type] ?? []) : [];
	const header = [
		...query.subarray(0, 2),
		0x81,
		0x80 | rcode,
		...u16(1),
		...u16(records.length),
		0,
		0,
		0,
		0,
	];
	const answers = records.flatMap((rdata) => [
		0xc0,
		0x0c,
		...u16(type),
		...u16(1),
		...u32(60),
		...u16(rdata.length),
		...rdata,
	]);
	return Buffer.from([...header, ...query.subarray(12, questionEnd), ...answers]);
}

function plain(value) {
	return JSON.stringify(value, (key, item) =>
		item instanceof ArrayBuffer
			? Buffer.from(item).toString("hex")
			: item === undefined
				? "<undefined>"
				: item,
	);
}

function errorShape(error) {
	return plain({
		keys: Object.keys(error),
		errno: error.errno,
		code: error.code,
		syscall: error.syscall,
		hostname: error.hostname,
		message: error.message,
	});
}

const server = dgram.createSocket("udp4");
server.on("message", (message, remote) =>
	server.send(respond(message), remote.port, remote.address),
);
await new Promise((resolve) => server.bind(0, "127.0.0.1", resolve));
const address = `127.0.0.1:${server.address().port}`;
dns.setServers([address]);
dnsPromises.setServers([address]);
check(dns.getServers()[0] === address, `getServers keeps the port: ${dns.getServers()}`);

const callbackResolve = (method, name) =>
	new Promise((resolve) =>
		dns[method](name, (error, result) => resolve(error ?? result)),
	);

const expected = {
	resolveSrv:
		'[{"name":"a.cluster.test","port":27017,"priority":0,"weight":5,"type":"SRV"},{"name":"b.cluster.test","port":27018,"priority":1,"weight":0,"type":"SRV"}]',
	resolveTxt: '[["authSource=admin","replicaSet=rs0"],["café"]]',
	resolveMx: '[{"exchange":"mx1.mail.test","priority":10,"type":"MX"}]',
	resolveCname: '["target.test"]',
	resolveNs: '["ns1.test","ns2.test"]',
	resolvePtr: '["host.test"]',
	resolveNaptr:
		'[{"flags":"s","service":"SIP+D2U","regexp":"","replacement":"_sip._udp.test","order":100,"preference":10,"type":"<undefined>"}]',
	resolveSoa:
		'{"nsname":"ns1.test","hostmaster":"hostmaster.test","serial":4000000000,"refresh":7200,"retry":3600,"expire":1209600,"minttl":300,"type":"<undefined>"}',
	resolveCaa:
		'[{"critical":0,"type":"CAA","issue":"letsencrypt.org"},{"critical":128,"type":"CAA","iodef":"mailto:x@test"}]',
	resolveTlsa: '[{"certUsage":3,"selector":1,"match":1,"data":"deadbeef"}]',
};
for (const [method, shape] of Object.entries(expected)) {
	const viaCallback = plain(await callbackResolve(method, "records.test"));
	check(viaCallback === shape, `${method}: ${viaCallback}`);
	const viaPromise = plain(await dnsPromises[method]("records.test"));
	check(viaPromise === shape, `promises.${method}: ${viaPromise}`);
}
const rrtype = plain(
	await new Promise((resolve) =>
		dns.resolve("records.test", "MX", (e, r) => resolve(e ?? r)),
	),
);
check(rrtype === expected.resolveMx, `resolve MX: ${rrtype}`);
check(
	plain(await dnsPromises.resolve("records.test", "SRV")) === expected.resolveSrv,
	"promises.resolve SRV",
);

const errors = [
	[
		"resolveSrv",
		"nxdomain.test",
		'{"keys":["errno","code","syscall","hostname"],"errno":"<undefined>","code":"ENOTFOUND","syscall":"querySrv","hostname":"nxdomain.test","message":"querySrv ENOTFOUND nxdomain.test"}',
	],
	[
		"resolveTxt",
		"nodata.test",
		'{"keys":["errno","code","syscall","hostname"],"errno":"<undefined>","code":"ENODATA","syscall":"queryTxt","hostname":"nodata.test","message":"queryTxt ENODATA nodata.test"}',
	],
	[
		"resolveMx",
		"servfail.test",
		'{"keys":["errno","code","syscall","hostname"],"errno":"<undefined>","code":"ESERVFAIL","syscall":"queryMx","hostname":"servfail.test","message":"queryMx ESERVFAIL servfail.test"}',
	],
	[
		"resolveNaptr",
		"refused.test",
		'{"keys":["errno","code","syscall","hostname"],"errno":"<undefined>","code":"EREFUSED","syscall":"queryNaptr","hostname":"refused.test","message":"queryNaptr EREFUSED refused.test"}',
	],
	[
		"resolveSoa",
		"nodata.test",
		'{"keys":["errno","code","syscall","hostname"],"errno":"<undefined>","code":"ENODATA","syscall":"querySoa","hostname":"nodata.test","message":"querySoa ENODATA nodata.test"}',
	],
];
for (const [method, name, shape] of errors) {
	const viaCallback = errorShape(await callbackResolve(method, name));
	check(viaCallback === shape, `${method} ${name}: ${viaCallback}`);
	const viaPromise = await dnsPromises[method](name).then(
		() => "resolved",
		(error) => errorShape(error),
	);
	check(viaPromise === shape, `promises.${method} ${name}: ${viaPromise}`);
}

const resolver = new dns.Resolver();
check(
	typeof resolver.resolveSrv === "function" &&
		typeof new dnsPromises.Resolver().resolveCaa === "function",
	"Resolver methods",
);

const nameType = thrown(() => dns.resolveSrv(1, () => {}));
check(
	nameType?.code === "ERR_INVALID_ARG_TYPE" &&
		nameType.message.startsWith('The "name" argument'),
	"name type",
);
check(
	thrown(() => dns.resolveTxt("x"))?.code === "ERR_INVALID_ARG_TYPE",
	"missing callback",
);
const rrtypeType = thrown(() => dns.resolve("x", 5, () => {}));
check(
	rrtypeType?.message ===
		'The "rrtype" argument must be of type string. Received type number (5)',
	"rrtype type",
);
check(
	thrown(() => dns.resolve("x", undefined, () => {}))?.code === "ERR_INVALID_ARG_TYPE",
	"undefined rrtype",
);
check(
	thrown(() => dnsPromises.resolve("x", 5))?.code === "ERR_INVALID_ARG_TYPE",
	"promise rrtype type",
);
check(
	thrown(() => dns.resolve("x", "BOGUS", () => {}))?.code === "ERR_INVALID_ARG_VALUE",
	"unknown rrtype",
);

server.close();

// A name holding U+0000 must not resolve as the text before it.
function nullByteError(run, code, message) {
	let thrown;
	try {
		run();
	} catch (error) {
		thrown = error;
	}
	check(
		thrown?.code === code && (message === undefined || thrown.message === message),
		`${code}: ${thrown?.message}`,
	);
}
nullByteError(
	() => dns.lookup("localhost\0.example.invalid", () => {}),
	"ERR_INVALID_ARG_VALUE",
	"The argument 'hostname' must be a string without null bytes. Received 'localhost\\x00.example.invalid'",
);
nullByteError(
	() => dnsPromises.lookup("localhost\0.example.invalid"),
	"ERR_INVALID_ARG_VALUE",
	"The argument 'hostname' must be a string without null bytes. Received 'localhost\\x00.example.invalid'",
);
nullByteError(
	() => dns.lookupService("127.0.0.1\0x", 80, () => {}),
	"ERR_INVALID_ARG_VALUE",
	"The argument 'address' is invalid. Received '127.0.0.1\\x00x'",
);
nullByteError(
	() => dns.lookup(`${"a'b\"c".repeat(30)}\0\n\u0085\ud800`, () => {}),
	"ERR_INVALID_ARG_VALUE",
	`The argument 'hostname' must be a string without null bytes. Received \`${"a'b\"c".repeat(25)}a'...`,
);
nullByteError(() => dns.setServers(["127.0.0.1\0x"]), "ERR_INVALID_IP_ADDRESS");

console.log("node-dns-records PASS");
