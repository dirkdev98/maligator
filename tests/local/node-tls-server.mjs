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

await echo("plain", { cert: CERT, key: KEY }, { ca: CA });
await echo(
	"alpn",
	{ cert: CERT, key: KEY, ALPNProtocols: ["h2", "http/1.1"] },
	{ ca: CA, ALPNProtocols: ["http/1.1"] },
);

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
	const server = https.createServer({ cert: CERT, key: KEY }, (request, response) => {
		response.setHeader("content-type", "text/plain");
		response.end(`hello ${request.method} ${request.url}`);
	});
	console.log("https server", server instanceof https.Server);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
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
	server.close();
}
