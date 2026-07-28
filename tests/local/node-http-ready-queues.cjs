const http = require("node:http");

const HELD_COUNT = 48;
const CLOSE_COUNT = 24;
const held = [];
const heldFinishOrder = [];
const closing = [];
const closeOrder = [];
let writeErrorStarted = 0;
let writeErrorCloses = 0;

function finishHeld(index) {
	const entry = held[index];
	entry.response.once("finish", () => {
		heldFinishOrder.push(entry.id);
		if (index + 1 < held.length) finishHeld(index + 1);
	});
	entry.response.end(entry.id);
}

const server = http.createServer((request, response) => {
	if (request.url.startsWith("/held/")) {
		held.push({ id: request.url.slice(6), response });
		if (held.length === HELD_COUNT) finishHeld(0);
		return;
	}

	if (request.url === "/held-status") {
		const ordered =
			heldFinishOrder.length === HELD_COUNT &&
			heldFinishOrder.every((id, index) => id === held[index].id);
		response.end(`${held.length}:${heldFinishOrder.length}:${ordered}`);
		return;
	}

	if (request.url === "/write-error") {
		writeErrorStarted++;
		response.once("close", () => writeErrorCloses++);
		setTimeout(() => {
			if (!response.destroyed) response.end("x".repeat(2 * 1024 * 1024));
		}, 30);
		return;
	}

	if (request.url === "/write-error-status") {
		response.end(`${writeErrorStarted}:${writeErrorCloses}`);
		return;
	}

	if (request.url.startsWith("/churn/")) {
		setTimeout(() => response.end(request.url.slice(7)), 0);
		return;
	}

	if (request.url.startsWith("/close-queued/")) {
		const id = request.url.slice(14);
		response.once("finish", () => closeOrder.push(`finish:${id}`));
		closing.push({ id, response });
		if (closing.length === CLOSE_COUNT) {
			for (const entry of closing) entry.response.end(entry.id);
			server.close(() => {
				closeOrder.push("close");
				console.log(`ORDER ${closeOrder.join(",")}`);
			});
		}
		return;
	}

	response.statusCode = 404;
	response.end("missing");
});

server.listen(0, "127.0.0.1", () => {
	console.log(`PORT ${server.address().port}`);
});
