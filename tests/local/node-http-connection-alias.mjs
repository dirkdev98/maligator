import assert from "node:assert/strict";
import { IncomingMessage, createServer, get } from "node:http";

function checkAlias(message, socket) {
	assert.equal(message.socket, socket);
	assert.equal(message.connection, socket);
	assert.equal(Object.hasOwn(message, "connection"), false);
	message.socket = null;
	assert.equal(message.connection, null);
	message.connection = socket;
	assert.equal(message.socket, socket);
}

const socket = { name: "fictional socket" };
checkAlias(new IncomingMessage(socket), socket);
const descriptor = Object.getOwnPropertyDescriptor(
	IncomingMessage.prototype,
	"connection",
);
let current = socket;
const custom = {
	get socket() {
		return current;
	},
	set socket(value) {
		current = value;
	},
};
assert.equal(descriptor.get.call(custom), socket);
descriptor.set.call(custom, null);
assert.equal(current, null);

const server = createServer((request, response) => {
	checkAlias(request, request.socket);
	response.end("alias works");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
	const body = await new Promise((resolve, reject) => {
		get(`http://127.0.0.1:${server.address().port}`, (response) => {
			checkAlias(response, response.socket);
			let text = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => {
				text += chunk;
			});
			response.once("end", () => resolve(text));
			response.once("error", reject);
		}).once("error", reject);
	});
	assert.equal(body, "alias works");
} finally {
	await new Promise((resolve) => server.close(resolve));
}
console.log("HTTP CONNECTION ALIAS PASS");
