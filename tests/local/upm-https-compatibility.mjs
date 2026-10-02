import http from "node:http";
import https from "node:https";
import { maligatorFetch as fetch } from "../../src/node-globals.mjs";

const port = Number(process.env.MAL_HTTPS_PORT);
const base = "https://localhost:" + port;
const expected = "verified-body-".repeat(24000);
function check(condition, message) {
	if (!condition) throw new Error(message);
}
async function run() {
	if (process.env.MAL_HTTPS_EXPECT_FAIL) {
		const address =
			process.env.MAL_HTTPS_EXPECT_FAIL === "hostname"
				? "https://127.0.0.1:" + port
				: base;
		let rejected = false;
		try {
			await fetch(address + "/stream");
		} catch {
			rejected = true;
		}
		check(rejected, "untrusted or mismatched certificate accepted");
		console.log("HTTPS REJECTION PASS");
		return;
	}
	let mismatch = false;
	try {
		http.request(base);
	} catch {
		mismatch = true;
	}
	check(mismatch, "node:http accepted https protocol");
	mismatch = false;
	try {
		https.request("http://localhost:" + port);
	} catch {
		mismatch = true;
	}
	check(mismatch, "node:https accepted http protocol");
	mismatch = false;
	try {
		https.request({ hostname: "localhost\0ignored", port });
	} catch {
		mismatch = true;
	}
	check(mismatch, "embedded NUL hostname accepted");
	const resolvingController = new AbortController();
	const resolvingReason = new Error("cancel lookup");
	const resolving = fetch(base + "/never", { signal: resolvingController.signal });
	resolvingController.abort(resolvingReason);
	let lookupCancelled = false;
	try {
		await resolving;
	} catch (error) {
		lookupCancelled = error === resolvingReason;
	}
	check(lookupCancelled, "hostname lookup abort identity");
	const response = await fetch(base + "/stream", { signal: AbortSignal.timeout(3000) });
	check(response.status === 200, "HTTPS status");
	const reader = response.body.getReader();
	let text = "",
		chunks = 0;
	while (true) {
		const next = await reader.read();
		if (next.done) break;
		text += new TextDecoder().decode(next.value);
		chunks++;
	}
	check(text === expected && chunks > 1, "HTTPS bounded streamed content");
	const direct = await new Promise((resolve, reject) => {
		const request = https.get(
			{ hostname: "localhost", port, path: "/options" },
			(incoming) => {
				let body = "";
				incoming.on("data", (chunk) => {
					body += chunk.toString();
				});
				incoming.on("error", reject);
				incoming.on("end", () => resolve(body));
			},
		);
		request.on("error", reject);
	});
	check(direct === "options-ok", "HTTPS options/get contract");
	const controller = new AbortController();
	const slow = await fetch(base + "/slow", { signal: controller.signal });
	const slowReader = slow.body.getReader();
	await slowReader.read();
	controller.abort();
	let aborted = false;
	try {
		await slowReader.read();
	} catch (error) {
		aborted = error.name === "AbortError";
	}
	check(aborted, "HTTPS body abort failed");
	const early = fetch(base + "/never", { signal: AbortSignal.timeout(30) });
	aborted = false;
	try {
		await early;
	} catch (error) {
		aborted = error.name === "TimeoutError";
	}
	check(aborted, "HTTPS pending response timeout failed");
	console.log("HTTPS STREAM ABORT PASS");
}
run().catch((error) => {
	console.log("FAIL: " + error.stack);
	process.exitCode = 1;
});
