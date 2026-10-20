const http = require("node:http");
const net = require("node:net");

const checks = [];

function check(name, ok) {
	checks.push(Boolean(ok));
	if (!ok) console.log("FAIL: " + name);
}

function rejects(name, fn) {
	try {
		fn();
		check(name, false);
	} catch {
		check(name, true);
	}
}

// One chunk's extensions are capped at 16 KiB and answered with 413 instead of read forever.
function checkChunkExtensions(done) {
	const server = http.createServer((request, response) => {
		request.resume();
		request.on("end", () => response.end("ok"));
	});
	const head =
		"POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
	const statusOf = (body, next) => {
		let seen = "";
		const socket = net.connect(server.address().port, "127.0.0.1", () =>
			socket.write(head + body),
		);
		socket.on("data", (chunk) => {
			seen += chunk.toString("latin1");
		});
		socket.on("error", () => {});
		socket.on("close", () => next(seen.split("\r\n")[0]));
	};
	server.listen(0, "127.0.0.1", () => {
		statusOf("1;" + "a".repeat(100) + "\r\nx\r\n0\r\n\r\n", (small) => {
			check("small chunk extension accepted", small === "HTTP/1.1 200 OK");
			statusOf("1;" + "a".repeat(20000), (large) => {
				check(
					"oversized chunk extensions rejected",
					large === "HTTP/1.1 413 Payload Too Large",
				);
				server.close(done);
			});
		});
	});
}

rejects("negative headersTimeout", () => http.createServer({ headersTimeout: -1 }));
rejects("fractional requestTimeout", () => http.createServer({ requestTimeout: 1.5 }));
rejects("string keepAliveTimeout", () => http.createServer({ keepAliveTimeout: "100" }));
rejects("NaN maxConnections", () => http.createServer({ maxConnections: Number.NaN }));
rejects("out-of-range headersTimeout", () =>
	http.createServer({ headersTimeout: 2147483648 }),
);

const defaults = http.createServer(() => {});
check("default headersTimeout", defaults.headersTimeout === 60000);
check("default requestTimeout", defaults.requestTimeout === 300000);
check("default keepAliveTimeout", defaults.keepAliveTimeout === 5000);
// Zero selects the engine default rather than Node's "unlimited".
check("default maxConnections", defaults.maxConnections === 0);

const server = http.createServer(
	{
		headersTimeout: 400,
		requestTimeout: 400,
		keepAliveTimeout: 400,
		maxConnections: 1,
	},
	(request, response) => {
		response.end("ok");
	},
);
check("constructed headersTimeout", server.headersTimeout === 400);
server.requestTimeout = 500;
check("assigned requestTimeout", server.requestTimeout === 500);

server.listen(0, "127.0.0.1", () => {
	check("latched requestTimeout", server.requestTimeout === 500);
	check("latched keepAliveTimeout", server.keepAliveTimeout === 400);
	check("latched maxConnections", server.maxConnections === 1);

	// A running server still accepts a retune, and still refuses a nonsense one.
	server.headersTimeout = 900;
	check("live headersTimeout", server.headersTimeout === 900);
	rejects("live invalid keepAliveTimeout", () => {
		server.keepAliveTimeout = -5;
	});
	check("live keepAliveTimeout unchanged", server.keepAliveTimeout === 400);

	const port = server.address().port;
	let seen = "";
	let refusedEmpty = false;
	const held = net.connect(port, "127.0.0.1", () => {
		held.write("GET /held HTTP/1.1\r\nHost: x\r\n\r\n");
	});
	held.on("error", () => {});
	held.on("data", (chunk) => {
		seen += chunk.toString("latin1");
		if (refusedEmpty || seen.indexOf("\r\n\r\n") < 0) return;
		// maxConnections: 1 — the slot is held, so this socket is dropped unread.
		let extraSeen = "";
		const extra = net.connect(port, "127.0.0.1", () => {
			extra.write("GET /extra HTTP/1.1\r\nHost: x\r\n\r\n");
		});
		refusedEmpty = true;
		extra.on("error", () => {});
		extra.on("data", (chunk) => {
			extraSeen += chunk.toString("latin1");
		});
		extra.on("close", () => {
			check("second connection refused", extraSeen === "");
		});
	});
	// keepAliveTimeout: 400 — an idle reusable connection is reaped well before the
	// 5s engine default would have fired.
	held.on("close", () => {
		check("served the held request", seen.indexOf("HTTP/1.1 200") === 0);
		server.close(() => {
			checkChunkExtensions(() => {
				console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);
			});
		});
	});
});
