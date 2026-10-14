const http = require("node:http");
let nextSocketId = 0;
let retained;

const server = http.createServer((request, response) => {
	if (request.url === "/gc") {
		const collect = globalThis.__mal_collect_garbage ?? globalThis.gc;
		if (collect) collect();
		response.end("gc");
		return;
	}
	if (request.url === "/retained") {
		const marker = retained.applicationMarker;
		response.end(`${marker.id}:${marker.requests}:${marker.events}`);
		return;
	}
	if (request.url === "/close") {
		response.end("closed");
		server.close();
		return;
	}
	const socket = request.socket;
	if (!socket.applicationMarker) {
		const marker = {
			id: ++nextSocketId,
			requests: 0,
			events: 0,
			address: socket.address,
		};
		socket.applicationMarker = marker;
		socket.on("application-probe", () => marker.events++);
	}
	const marker = socket.applicationMarker;
	marker.requests++;
	socket.emit("application-probe");
	if (request.url === "/retain") retained = socket;
	const address = socket.address();
	response.end(
		JSON.stringify({
			id: marker.id,
			requests: marker.requests,
			events: marker.events,
			aliases: request.connection === socket,
			method: marker.address === socket.address,
			address:
				address.address === socket.localAddress &&
				address.port === socket.localPort &&
				address.family === socket.localFamily,
		}),
	);
});
server.listen(0, "127.0.0.1", () => console.log(`PORT ${server.address().port}`));
