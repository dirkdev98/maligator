const { app } = require("../fixtures/express-5/app.js");

const checks = [];
const order = [];
let synchronous = true;

const server = app.listen(0, "127.0.0.1", () => {
	order.push("listen-callback");
	const address = server.address();
	checks.push(!synchronous);
	checks.push(address.address === "127.0.0.1");
	checks.push(address.family === "IPv4");
	checks.push(Number.isInteger(address.port) && address.port > 0);
});

const immediateAddress = server.address();
checks.push(immediateAddress !== null && immediateAddress.port > 0);
server.on("listening", () => {
	order.push("listening-event");
	const closeResult = server.close(() => {
		order.push("close-callback");
		checks.push(server.address() === null);

		const defaultHostServer = app.listen(0, () => {
			const address = defaultHostServer.address();
			checks.push(address.address === "0.0.0.0");
			checks.push(address.family === "IPv4" && address.port > 0);
			defaultHostServer.close(() => {
				checks.push(
					order.join(",") ===
						"listen-callback,listening-event,close-event,close-callback",
				);
				console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);
			});
		});
	});
	checks.push(closeResult === server);
	checks.push(server.address() === null);
});
server.on("close", () => {
	order.push("close-event");
});

synchronous = false;
