"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const http = require("node:http");
const net = require("node:net");

const storage = new AsyncLocalStorage();
let passed = 0;
let total = 0;

function check(condition, name) {
	total++;
	if (condition) passed++;
	else console.log("FAIL: " + name);
}

const server = http.createServer((request, response) => {
	response.setHeader("Connection", "close");
	response.end("ok");
});

server.listen(0, "127.0.0.1", () => {
	const port = server.address().port;
	storage.run("socket", () => {
		const socket = net.createConnection(port, "127.0.0.1");
		socket.on("connect", () => {
			check(storage.getStore() === "socket", "connect event context");
			storage.run("write", () => {
				socket.write(
					"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
					() => {
						check(storage.getStore() === "write", "write callback context");
					},
				);
			});
		});
		socket.on("data", () => {
			check(storage.getStore() === "socket", "data event context");
		});
		socket.on("end", () => {
			check(storage.getStore() === "socket", "end event context");
		});
		socket.on("close", () => {
			check(storage.getStore() === "socket", "close event context");
			server.close(() => {
				check(storage.getStore() === "socket", "server close callback context");
				console.log("RESULT " + passed + "/" + total);
			});
		});
	});
});
