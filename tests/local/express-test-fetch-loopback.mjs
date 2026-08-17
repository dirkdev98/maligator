import express from "express";
import { MaligatorHeaders } from "../../src/node-globals.mjs";

const app = express();
app.use(express.json());
app.post("/echo", (request, response) => {
	response.json(request.body);
});

const server = app.listen(0, "127.0.0.1", async () => {
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("Expected an ephemeral listener");
	}

	try {
		const copiedHeaders = new MaligatorHeaders(
			new Headers({ "content-type": "application/json" }),
		);
		if (copiedHeaders.get("content-type") !== "application/json") {
			throw new Error("Native Headers values were not copied into the test fetch shim");
		}
		const response = await fetch(`http://127.0.0.1:${address.port}/echo`, {
			body: JSON.stringify({ value: "first" }),
			headers: new Headers({ "content-type": "application/json" }),
			method: "POST",
		});
		if (response.status !== 200) throw new Error(`Unexpected status ${response.status}`);
		if ((await response.text()) !== '{"value":"first"}') {
			throw new Error("Unexpected Express JSON response body");
		}
		console.log("EXPRESS TEST FETCH LOOPBACK PASS");
	} finally {
		server.close();
	}
});
