// A tls.Server and tls.connect client over loopback. Server and client events are
// logged to separate lists so the interleaving of the two peers cannot reorder output.
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";

const CA = `-----BEGIN CERTIFICATE-----
MIIDHzCCAgegAwIBAgIULVaV44pPF1s2X4nIQVnkQ4gncQwwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcyNzIwMTQwNVoXDTM2MDcy
NDIwMTQwNVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAugrG62LEZPIE0jvdNCQ1ewHN//t5XP1N8Nf9Bgepdbme
KUi/GbyQsMFYWaPPjLB4iEYPYFfBJ+HL4F3bYB37623e7027OYapo5hMiGwGHBGY
+HeFWaii1dMQWZ4FG+UZ0BXik+xR/InI/4vVCsU3c203WIGS89TrQ//6cnOmAsVZ
NXMBBIEA4sQybe7Np9BF6cnBirSqVySZm2sQv9X5l46lmGP3fgN9qdkj8hHmFms4
7NroYeuMonSkVbYKBiSCLNX6eU/P28mnWrX0tA+CNVnl6+mEAjlRJWye3dHlaPZa
hix9ygVOI39yHP/JvsCbT+Lf/QFHq/w2uhrb1By/EQIDAQABo2kwZzAdBgNVHQ4E
FgQUTmWkC3KciaaTX/Ixp1nQ1h71T1MwHwYDVR0jBBgwFoAUTmWkC3KciaaTX/Ix
p1nQ1h71T1MwDwYDVR0TAQH/BAUwAwEB/zAUBgNVHREEDTALgglsb2NhbGhvc3Qw
DQYJKoZIhvcNAQELBQADggEBAJvXM3BD+2roJIkg92dS3OzvtH1Y66ELLOsILjiT
Ezbx5bV5nc1yjybIhLU3eMuyarvXN/iwwKXbx6I4YrrIr7W35ZqlKWCiFJS4nivz
8M3t/RFX47gg6iclZs1DuvueWvwdrNU03UHxZ+gQYY6E86eTgpAXYSgJS2nGZqA2
QYSmRKz42+wFRwP1BftXt09ir5FmYbf4txAZDk7gj3XeiYk3g4+gNDHlCnYOMU6X
rpnz81gR4MniuDNqNTI+o6G0E7pPoCrMg9gxvztk62aecuNiM+sAh1FZeOgWcSuQ
pDa8gW5gZetuCUL0n2D7cqbUBMXAQhhzrXMTAHHTXawHiNs=
-----END CERTIFICATE-----
`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIDPTCCAiWgAwIBAgIUAKMihiwk4GFZURFNOuv3qe1ercswDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcyNzIwMjExNloXDTM2MDcy
NDIwMjExNlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA0C5Nflog96InamL2eDzDqN7nwP+t/RXYmYaHMyteqfQ9
3XQthDJV83CVyOeKKZVdk33Xvz6iAJemAFX1A5O+tUqVSwHnzm485Vl9ft+7zjaf
mZW+Lzl/jELfyzRfgt1BfoRn4cXHW15OWmIxBHYdPp4F22dXYNTeJAkpJrqbA4Xh
3MnLP9VjNKrR2EQoO8lfzRrfAM1edJvA/JJ3K/Fz6GE75MqU/ledAZse6loMuD+F
B3kETySVFbwweEa3zkDnCaSI26YLDP155Dhnrz0E0O0RFmq5nhAZqrINa319eyp/
h4MrMpxgk/4OtK2oF4SvbjhUNhSlqZPd/QCDI2O0XQIDAQABo4GGMIGDMBQGA1Ud
EQQNMAuCCWxvY2FsaG9zdDAJBgNVHRMEAjAAMAsGA1UdDwQEAwIFoDATBgNVHSUE
DDAKBggrBgEFBQcDATAdBgNVHQ4EFgQU2k6PyDIyt5yUfedSSssAZ3eJb9owHwYD
VR0jBBgwFoAUTmWkC3KciaaTX/Ixp1nQ1h71T1MwDQYJKoZIhvcNAQELBQADggEB
ALPzLUWd9J7f86BOo3GI1j+E38rKZ+YDPLFjs7TdHwCfc12yLHfnybvr+0N8WLpI
qodjDGwti/qkDe5ury8dfzrrDK+gtjWyY3e4rLTnARbrHgVvNsU7W8l9Z/Ym6RxJ
tvV4iYTf+s5JxFG5SjDi9AemnB+v9FPlTJtOla2PY3jdSShEZ16h3FfvVffzFnuh
EJ5JoUudcwMdL7Q5zJs9a4uSegyNDbC3EoyvJtu8Fiho5F1YuPg5kcDbsHFqP7vR
pCkYDc5++7/RNlsknlCo5aTDChq8Wg/WsM//3lVsIsDd4nvQsKEzR+j0Hk1Z4062
hcwKmXmF37fwjB2/JO/0WU8=
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDQLk1+WiD3oidq
YvZ4PMOo3ufA/639FdiZhoczK16p9D3ddC2EMlXzcJXI54oplV2Tfde/PqIAl6YA
VfUDk761SpVLAefObjzlWX1+37vONp+Zlb4vOX+MQt/LNF+C3UF+hGfhxcdbXk5a
YjEEdh0+ngXbZ1dg1N4kCSkmupsDheHcycs/1WM0qtHYRCg7yV/NGt8AzV50m8D8
kncr8XPoYTvkypT+V50Bmx7qWgy4P4UHeQRPJJUVvDB4RrfOQOcJpIjbpgsM/Xnk
OGevPQTQ7REWarmeEBmqsg1rfX17Kn+HgysynGCT/g60ragXhK9uOFQ2FKWpk939
AIMjY7RdAgMBAAECggEALu2FG/qqrE/CBVYWG7AM5hQLV4L7QE4Mo70C3JrF7ddI
G9PMz9w96lDCfwWMrEeGjtEjEXIHuEz3B2PZBauoJXtQ0JX3IF5SvVuRMciy7+75
xrgN5VzXfvFzO74MWrZQBXpI5Yi9IgBN9stkI86RVJRwGw9+T65kfeiPvXJ6r431
qI0P3J7XGorDP3xaSpQG98C6pFA6/rxHbQGdAfsQhpfyYCIAs3kWmeutiluc8jCi
1m5FFhBnnTeOeOo0kf6knxMhv+67q6X6usl/fkGo9lZaDdLvq1scwx/3cENMsYZg
oGnnQ9De9CSx/PFjkRNwASJLp9cURAKbMlYyN2rH0QKBgQD/hOIvaV/PAJWJvcoT
tU2gAnL8f1+kA80Lmldt4acTjxhXcJHSs7H63D0iVnvrbw9s39EJxOql8xDKRy7z
GX1YRBJl6bNfljNi16LxPAt3Guj1f9gk9soJ3jlXjvJNfwhb9sZLQoBghev7hXhD
ebl6GKUeVmYMAGIQy5huPsADbQKBgQDQkpw594TPrEf0RIF1Ff5VH/K7tdznQePK
UyHjTMajx8SlL5J59l1AHimJtKEN65TiwovQpqDI+KuwxBajUJIKBsUL9AgwrOz9
8sgrh5UV2Vf5z8h+lJI7YEa+ArkikSHazl7u5/MXYiRjljh9h/1vFt3B6aIc9m9K
+mPbWfrusQKBgQCj5WODz85ho9lHWdJlo9SfvxJsfXMmbD24pI5R7/zQIegWJiGT
CiouY9hezyR7VmiJiGK4JnPwcCGj7dbincX1uOwoLKgetuRNEU31+HLOOheVaSSG
STo87CrRy+IF7Wa6Pmbg3U4lG6HLWshSV6Ct/WLkO70HE7PTXBRxGpTlXQKBgGqI
F+e7t0hjlLT9MKpfO3K7SL373AL6sqCq6YoxstwAsz40GDrXTTXssga2DfUQORHB
kKxYD5PW/8rfvThZdN5OKuM6F9zU1o+3K+qf69QnGTptmNiehjpxqHBw76LqQkKC
Whbovk9ZP4DmP6BOj3HoWggrjzP/40SGs+5b/UFhAoGBAJXCBc5UmpvVUJPT/m63
ktYxaqcxn0QiVpnsM/Zug7Gc0PHU4EalsrOEfjXf4b4aHPbXLIvS3/9F2+ej5wwy
jHkmY8jH2C/sOc+wbUincCUcOfHQDn6Dr8iKenKiSSEBLtfcrBdLDvpcz0KbwRTk
Z29mJJ2qyw8fQwtM1g8cNba/
-----END PRIVATE KEY-----
`;

// tests/fixtures/tls/client-*.pem: a client CA and a clientAuth certificate it issued.
const CLIENT_CA = `-----BEGIN CERTIFICATE-----
MIIBiTCCATCgAwIBAgIUQLwqiBdHdiSby3Qyn390Z9IfYkAwCgYIKoZIzj0EAwIw
IzEhMB8GA1UEAwwYTWFsaWdhdG9yIFRlc3QgQ2xpZW50IENBMB4XDTI2MTAxOTIx
MzIzOFoXDTM2MTAxNjIxMzIzOFowIzEhMB8GA1UEAwwYTWFsaWdhdG9yIFRlc3Qg
Q2xpZW50IENBMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAElNIKnQsLqX/iebzk
1f/0KrZkKrKoXaxLu8c0RIH4wrvJkGqBZQ6yNb87KoMXolrK/UtO53yLxsTThyte
5SvLcaNCMEAwHQYDVR0OBBYEFJ7eCy2LkQ2SbmIZth1pnd6TadRxMA8GA1UdEwEB
/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMCA0cAMEQCIGV+d8+C
4K/ugzhkeRmNgXqtD015EkxETzorqqV3g42LAiAUNU0CEPUeBUPWDMBoNR9Bo30L
/nWgYqmdoiIqFyaEqQ==
-----END CERTIFICATE-----
`;
const CLIENT_CERT = `-----BEGIN CERTIFICATE-----
MIIBczCCARigAwIBAgIULLg5xQM7FRSQvUdDFaoCsHVxShAwCgYIKoZIzj0EAwIw
IzEhMB8GA1UEAwwYTWFsaWdhdG9yIFRlc3QgQ2xpZW50IENBMB4XDTI2MTAxOTIx
MzIzOFoXDTM2MTAxNjIxMzIzOFowGzEZMBcGA1UEAwwQbWFsaWdhdG9yLWNsaWVu
dDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABNBSLNLfAcPTBP0CCXkYA5Cr0lwx
DLm3O95uOfYnVuulZdYAArfDPXiYgO+r4gMLDOua8YNoQn2WzkHNZI95H9SjMjAw
MAkGA1UdEwQCMAAwDgYDVR0PAQH/BAQDAgeAMBMGA1UdJQQMMAoGCCsGAQUFBwMC
MAoGCCqGSM49BAMCA0kAMEYCIQDNVaWwfVumDCMyDd1alM6D6tMkAozVhKcVlf8k
C7I5eAIhAPuiJTnxR2UUpfIx1H4dkUysB1Yyk6lCwnMwAFcnMEJY
-----END CERTIFICATE-----
`;
const CLIENT_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgU3sYBCOMc+MLG1DY
5o6BUYzyPSiDQAI+3LZmsKXtmH+hRANCAATQUizS3wHD0wT9Agl5GAOQq9JcMQy5
tzvebjn2J1brpWXWAAK3wz14mIDvq+IDCwzrmvGDaEJ9ls5BzWSPeR/U
-----END PRIVATE KEY-----
`;

// tests/fixtures/tls/self-signed-*.pem: a self-signed localhost certificate and its key.
const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIBhDCCASqgAwIBAgIUeVQgAJ0bzz1ip7maR02X0THez4cwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAxOTIyNTU0MloXDTM2MTAxNjIy
NTU0MlowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEsf3edBgpTJgeOZ1Z+UdO6CXXyBjtovDtU1IA1uhWYzws76T/z02c0Txi
B156PcvIonTJMBUVcpO+n6FzK6W6IqNaMFgwHQYDVR0OBBYEFLLdaXYQ1TALqXio
5dviIF5aCiFEMBQGA1UdEQQNMAuCCWxvY2FsaG9zdDAMBgNVHRMBAf8EAjAAMBMG
A1UdJQQMMAoGCCsGAQUFBwMBMAoGCCqGSM49BAMCA0gAMEUCIAKGc9W/0OC3ajJY
fV4QT8ejO/0sdElRY4lqudsfxr9uAiEA5ijwyAPGzomCDYrBioFRzpAqVEdlYHE4
SAvzHaCxU6c=
-----END CERTIFICATE-----
`;
const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgKRJ3U/8nqymWuSlu
hJBdutA3varC6N5Wc/LF4vnpuBmhRANCAASx/d50GClMmB45nVn5R07oJdfIGO2i
8O1TUgDW6FZjPCzvpP/PTZzRPGIHXno9y8iidMkwFRVyk76foXMrpboi
-----END PRIVATE KEY-----
`;

function connectClient(port, options) {
	return new Promise((resolve) => {
		const raw = net.connect(port, "127.0.0.1", () => {
			resolve(tls.connect({ socket: raw, servername: "localhost", ...options }));
		});
	});
}

async function echo(label, serverOptions, clientOptions) {
	const serverEvents = [];
	const clientEvents = [];
	const server = tls.createServer(serverOptions, (socket) => {
		serverEvents.push(
			`secureConnection encrypted=${socket.encrypted} authorized=${socket.authorized} ` +
				`alpn=${socket.alpnProtocol} servername=${socket.servername} protocol=${socket.getProtocol()}`,
		);
		socket.on("data", (chunk) => {
			serverEvents.push(`data ${chunk}`);
			socket.end(`echo:${chunk}`);
		});
		socket.on("close", () => {
			serverEvents.push("close");
			server.close();
		});
	});
	server.on("close", () => serverEvents.push("server close"));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const client = await connectClient(server.address().port, clientOptions);
	await new Promise((resolve) => {
		client.on("secureConnect", () => {
			clientEvents.push(
				`secureConnect alpn=${client.alpnProtocol} protocol=${client.getProtocol()}`,
			);
			client.write("hello");
		});
		client.on("data", (chunk) => clientEvents.push(`data ${chunk}`));
		client.on("end", () => clientEvents.push("end"));
		client.on("close", resolve);
	});
	await new Promise((resolve) =>
		serverEvents.includes("server close") ? resolve() : server.on("close", resolve),
	);
	console.log(label, "server", JSON.stringify(serverEvents));
	console.log(label, "client", JSON.stringify(clientEvents));
}

{
	const server = tls.createServer({ cert: CERT, key: KEY });
	const accepted = new Promise((resolve) => server.on("secureConnection", resolve));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const client = await connectClient(server.address().port, { ca: CA });
	const socket = await accepted;
	console.log(
		"TLSSocket",
		client instanceof tls.TLSSocket,
		socket instanceof tls.TLSSocket,
		socket instanceof net.Socket,
		Object.getPrototypeOf(tls.TLSSocket) === net.Socket,
		Object.getPrototypeOf(tls.TLSSocket.prototype) === net.Socket.prototype,
		server.listenerCount("connection"),
	);
	client.destroy();
	socket.destroy();
	server.close();
	const roots = tls.rootCertificates;
	console.log(
		"rootCertificates",
		Array.isArray(roots),
		Object.isFrozen(roots),
		roots === tls.rootCertificates,
		roots.length > 0 &&
			roots.every((pem) =>
				/^-----BEGIN CERTIFICATE-----\n[^]*\n-----END CERTIFICATE-----$/.test(pem),
			),
		Array.isArray(tls.getCertificateCompressionAlgorithms()),
	);
}

await echo("plain", { cert: CERT, key: KEY }, { ca: CA });
await echo(
	"alpn",
	{ cert: CERT, key: KEY, ALPNProtocols: ["h2", "http/1.1"] },
	{ ca: CA, ALPNProtocols: ["http/1.1"] },
);

await echo(
	"client cert",
	{ cert: CERT, key: KEY, ca: CLIENT_CA, requestCert: true, rejectUnauthorized: true },
	{ ca: CA, cert: CLIENT_CERT, key: Buffer.from(CLIENT_KEY) },
);

function describePeer(certificate) {
	const { subject, issuer, subjectaltname, valid_from, valid_to, serialNumber, raw } =
		certificate;
	return JSON.stringify({
		subject,
		issuer,
		subjectaltname,
		valid_from,
		valid_to,
		serialNumber,
		fingerprint: certificate.fingerprint,
		fingerprint256: certificate.fingerprint256,
		fingerprint512: certificate.fingerprint512,
		raw: raw && raw.length,
	});
}

for (const [label, serverCa, clientOptions] of [
	["peer certificate", CLIENT_CA, { ca: CA, cert: CLIENT_CERT, key: CLIENT_KEY }],
	["no peer certificate", CLIENT_CA, { ca: CA }],
	["untrusted peer certificate", CA, { ca: CA, cert: CLIENT_CERT, key: CLIENT_KEY }],
]) {
	let serverSees;
	let clientSees;
	const server = tls.createServer(
		{ cert: CERT, key: KEY, ca: serverCa, requestCert: true, rejectUnauthorized: false },
		(socket) => {
			serverSees = `authorized=${socket.authorized} ${describePeer(socket.getPeerCertificate())}`;
			socket.end();
		},
	);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const client = await connectClient(server.address().port, clientOptions);
	client.on(
		"secureConnect",
		() => (clientSees = describePeer(client.getPeerCertificate())),
	);
	client.resume();
	await new Promise((resolve) => client.on("close", resolve));
	console.log(label, "server sees", serverSees);
	console.log(label, "client sees", clientSees);
	server.close();
}

for (const [label, serverOptions, clientOptions] of [
	["verdict untrusted server", {}, { rejectUnauthorized: false }],
	[
		"verdict self-signed server",
		{ cert: SELF_SIGNED_CERT, key: SELF_SIGNED_KEY },
		{ rejectUnauthorized: false },
	],
	[
		"verdict wrong name",
		{},
		{ rejectUnauthorized: false, ca: CA, servername: "example.com" },
	],
	["verdict trusted", {}, { rejectUnauthorized: false, ca: CA }],
	[
		"verdict missing client cert",
		{ requestCert: true, rejectUnauthorized: false, ca: CLIENT_CA },
		{ ca: CA },
	],
	[
		"verdict untrusted client cert",
		{ requestCert: true, rejectUnauthorized: false, ca: CA },
		{ ca: CA, cert: CLIENT_CERT, key: CLIENT_KEY },
	],
]) {
	let serverVerdict;
	let clientVerdict;
	const server = tls.createServer(
		{ cert: CERT, key: KEY, ...serverOptions },
		(socket) => {
			serverVerdict = `${socket.authorized} ${socket.authorizationError}`;
			socket.end();
		},
	);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const client = await connectClient(server.address().port, clientOptions);
	client.on(
		"secureConnect",
		() => (clientVerdict = `${client.authorized} ${client.authorizationError}`),
	);
	client.on("error", (error) => (clientVerdict = `error ${error.code}`));
	client.resume();
	await new Promise((resolve) => client.on("close", resolve));
	console.log(label, "server", serverVerdict, "client", clientVerdict);
	server.close();
}

const context = tls.createSecureContext({ cert: Buffer.from(CERT), key: KEY, ca: CA });
console.log("context", context instanceof tls.SecureContext, typeof context.context);
await echo("context", { cert: CERT, key: KEY }, { secureContext: context });

for (const [name, options] of [
	["bad cert", { cert: "not a certificate", key: KEY }],
	["bad key", { cert: CERT, key: "not a key" }],
]) {
	try {
		tls.createSecureContext(options);
		console.log(name, "accepted");
	} catch (error) {
		console.log(name, error.code, error.message);
	}
}

{
	const server = tls.createServer({});
	console.log("server", server instanceof tls.Server, server instanceof net.Server);
	const clientError = new Promise((resolve) =>
		server.on("tlsClientError", (error, socket) => {
			console.log("tlsClientError", error.code, socket instanceof net.Socket);
			resolve();
		}),
	);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const client = await connectClient(server.address().port, { ca: CA });
	const failed = new Promise((resolve) => client.on("close", resolve));
	client.on("error", () => console.log("client error"));
	await clientError;
	await failed;
	server.close();
}

{
	const server = tls.createServer({}, (socket) => socket.end("rotated"));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	server.setSecureContext({ cert: CERT, key: KEY });
	const client = await connectClient(server.address().port, { ca: CA });
	const chunks = [];
	client.on("data", (chunk) => chunks.push(chunk));
	await new Promise((resolve) => client.on("close", resolve));
	console.log("setSecureContext", Buffer.concat(chunks).toString());
	server.close();
}

async function sniCase(label, server, servername) {
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const client = await connectClient(server.address().port, { ca: CA, servername });
	const events = [];
	client.on("secureConnect", () => events.push("secureConnect"));
	client.on("data", (chunk) => events.push(`data ${chunk}`));
	client.on("error", () => events.push("error"));
	await new Promise((resolve) => client.on("close", resolve));
	console.log(label, JSON.stringify(events));
	server.close();
}

{
	const server = tls.createServer({}, (socket) => socket.end(`sni:${socket.servername}`));
	server.addContext("*.example", context);
	server.addContext("LOCAL*", { cert: CERT, key: KEY });
	await sniCase("addContext", server, "localhost");
}

{
	const names = [];
	const server = tls.createServer(
		{
			SNICallback(servername, callback) {
				names.push(servername);
				setTimeout(
					() => callback(null, tls.createSecureContext({ cert: CERT, key: KEY })),
					1,
				);
			},
		},
		(socket) => socket.end("callback"),
	);
	await sniCase("SNICallback", server, "localhost");
	console.log("SNICallback names", JSON.stringify(names));
}

{
	const server = tls.createServer({
		SNICallback(servername, callback) {
			callback(new Error(`no context for ${servername}`));
		},
	});
	server.on("tlsClientError", (error, socket) =>
		console.log(
			"SNICallback tlsClientError",
			error.message,
			socket instanceof net.Socket,
		),
	);
	await sniCase("SNICallback error", server, "localhost");
}

async function clientErrorCode(label, serverOptions, connect) {
	const server = tls.createServer(serverOptions);
	const reported = new Promise((resolve) =>
		server.on("tlsClientError", (error) => {
			console.log(label, "tlsClientError", error.code);
			resolve();
		}),
	);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const client = await connect(server.address().port);
	client.on("error", () => {});
	await Promise.all([reported, new Promise((resolve) => client.on("close", resolve))]);
	server.close();
}

await clientErrorCode("plaintext", { cert: CERT, key: KEY }, (port) => {
	const raw = net.connect(port, "127.0.0.1", () => raw.write("GET / HTTP/1.1\r\n\r\n"));
	raw.resume();
	return raw;
});
await clientErrorCode(
	"missing client cert",
	{ cert: CERT, key: KEY, ca: CLIENT_CA, requestCert: true, rejectUnauthorized: true },
	(port) => connectClient(port, { ca: CA }),
);

{
	const serverEvents = [];
	let secureSocket;
	const server = https.createServer({ cert: CERT, key: KEY }, (request, response) => {
		serverEvents.push(
			`request same=${request.socket === secureSocket} encrypted=${request.socket.encrypted}`,
		);
		response.setHeader("content-type", "text/plain");
		response.end(`hello ${request.method} ${request.url}`);
	});
	server.on("secureConnection", (socket) => {
		secureSocket = socket;
		serverEvents.push(`secureConnection encrypted=${socket.encrypted}`);
	});
	const hangUp = new Promise((resolve) =>
		server.once("tlsClientError", (error, socket) => {
			serverEvents.push(`tlsClientError ${error.code} ${error.message} ${typeof socket}`);
			resolve();
		}),
	);
	console.log("https server", server instanceof https.Server);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	await new Promise((resolve) => {
		const raw = net.connect(server.address().port, "127.0.0.1", () => raw.end());
		raw.on("close", resolve);
	});
	await hangUp;
	const plaintext = new Promise((resolve) =>
		server.once("tlsClientError", (error) => {
			serverEvents.push(`tlsClientError ${error.code}`);
			resolve();
		}),
	);
	await new Promise((resolve) => {
		const raw = net.connect(server.address().port, "127.0.0.1", () =>
			raw.write("POST / HTTP/1.1\r\n\r\n"),
		);
		raw.resume();
		raw.on("close", resolve);
	});
	await plaintext;
	const { status, body } = await new Promise((resolve, reject) => {
		const request = https.get(
			{
				hostname: "localhost",
				port: server.address().port,
				path: "/path?q=1",
				ca: CA,
				agent: false,
			},
			(response) => {
				const chunks = [];
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () =>
					resolve({
						status: response.statusCode,
						body: Buffer.concat(chunks).toString(),
					}),
				);
			},
		);
		request.on("error", reject);
	});
	console.log("https", status, body);
	console.log("https server events", JSON.stringify(serverEvents));
	server.close();
}

{
	const server = https.createServer(
		{ cert: CERT, key: KEY, ca: CLIENT_CA, requestCert: true, rejectUnauthorized: true },
		(request, response) => response.end("client certified"),
	);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const body = await new Promise((resolve, reject) => {
		const request = https.get(
			{
				hostname: "localhost",
				port: server.address().port,
				ca: CA,
				cert: CLIENT_CERT,
				key: CLIENT_KEY,
				agent: false,
			},
			(response) => {
				const chunks = [];
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () => resolve(Buffer.concat(chunks).toString()));
			},
		);
		request.on("error", reject);
	});
	console.log("https client cert", body);
	server.close();
}

async function httpsSni(label, server) {
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const body = await new Promise((resolve, reject) => {
		const request = https.get(
			{ hostname: "localhost", port: server.address().port, ca: CA, agent: false },
			(response) => {
				const chunks = [];
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () => resolve(Buffer.concat(chunks).toString()));
			},
		);
		request.on("error", reject);
	});
	console.log(label, body);
	server.close();
}

{
	const server = https.createServer({}, (request, response) =>
		response.end("https addContext"),
	);
	server.addContext("*.example", { cert: SELF_SIGNED_CERT, key: SELF_SIGNED_KEY });
	server.addContext("LOCALHOST", { cert: CERT, key: KEY });
	await httpsSni("https sni", server);
}

{
	const names = [];
	const server = https.createServer(
		{
			SNICallback(servername, callback) {
				names.push(servername);
				setTimeout(
					() => callback(null, tls.createSecureContext({ cert: CERT, key: KEY })),
					1,
				);
			},
		},
		(request, response) => response.end("https SNICallback"),
	);
	await httpsSni("https sni", server);
	console.log("https SNICallback names", JSON.stringify(names));
}
