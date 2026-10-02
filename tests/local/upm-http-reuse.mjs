import { writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const secure = process.env.MAL_REUSE_SECURE === "1";
const transport = secure ? https : http;
const origin =
	(secure ? "https://localhost:" : "http://127.0.0.1:") + process.env.MAL_REUSE_PORT;
let checks = 0;
function check(condition, message) {
	checks++;
	if (!condition) throw new Error(message);
}
function request(path, options = {}, body = undefined, target = origin) {
	return new Promise((resolve, reject) => {
		const req = transport.request(target + path, options, (response) => {
			let text = "";
			response.on("data", (chunk) => {
				text += chunk.toString();
			});
			response.on("error", reject);
			response.on("end", () => resolve(text));
		});
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}
async function run() {
	const first = await request("/fixed");
	if (process.env.MAL_REUSE_OTHER_PORT) {
		const other =
			(secure ? "https://localhost:" : "http://127.0.0.1:") +
			process.env.MAL_REUSE_OTHER_PORT;
		check(
			(await request("/fixed", {}, undefined, other)) !== first,
			"distinct origins have distinct transports",
		);
		check(
			(await request("/fixed")) === first,
			"another origin cannot consume this origin's pooled transport",
		);
	}
	check((await request("/fixed")) === first, "fixed responses reuse their connection");
	check(
		(await request("/chunked")) === first,
		"chunked responses reuse their connection",
	);
	check((await request("/head", { method: "HEAD" })) === "", "HEAD has no body");
	check(
		(await request("/fixed")) === first,
		"HEAD response keeps the transport reusable",
	);
	check(
		(await request("/upload", { method: "POST" }, "upload-body")) === first + ":11",
		"complete streamed uploads reuse their connection",
	);
	check(
		(await request("/fixed")) === first,
		"upload completion leaves a reusable transport",
	);
	const optOut = await request("/fixed", { agent: false });
	check(
		(await request("/connection", { agent: false })).endsWith(":close"),
		"agent:false sends close on the wire",
	);
	check(
		optOut !== first && (await request("/fixed", { agent: false })) !== optOut,
		"agent:false always uses a fresh connection",
	);
	const close = await request("/fixed", { headers: { Connection: "Keep-Alive, cLoSe" } });
	check(
		(
			await request("/connection", { headers: { Connection: "Keep-Alive, cLoSe" } })
		).endsWith(":close"),
		"explicit close reaches the wire",
	);
	check(
		close !== first && (await request("/fixed")) === first,
		"explicit close bypasses the pool",
	);
	check(
		(await request("/server-close")) === first,
		"a pooled socket can receive the peer's close response",
	);
	const afterClose = await request("/fixed");
	check(afterClose !== first, "peer close prevents reuse");
	check(
		(await request("/dirty")) === afterClose,
		"self-delimited response remains readable despite extra bytes",
	);
	const afterDirty = await request("/fixed");
	check(afterDirty !== afterClose, "unsolicited response bytes prevent reuse");
	check(
		(await request("/stale")) === afterDirty,
		"stale test starts with a pooled transport",
	);
	await new Promise((resolve) => setTimeout(resolve, 50));
	const afterStale = await request("/fixed");
	check(afterStale !== afterDirty, "closed idle sockets are pruned before checkout");
	check((await request("/eof")) === afterStale, "EOF-delimited body is delivered");
	const afterEof = await request("/fixed");
	check(afterEof !== afterStale, "EOF-delimited responses are never reused");
	await new Promise((resolve, reject) => {
		const req = transport.get(origin + "/abort", (response) => {
			response.once("data", () => {
				response.destroy();
				resolve();
			});
			response.on("error", () => {});
		});
		req.on("error", reject);
	});
	const beforeDestroy = await request("/fixed");
	check(beforeDestroy !== afterEof, "cancelled response discards its transport");
	transport.globalAgent.destroy();
	const afterDestroy = await request("/fixed");
	check(afterDestroy !== beforeDestroy, "Agent.destroy clears idle transports");
	if (process.env.MAL_REUSE_TTL === "1") {
		await new Promise((resolve) => setTimeout(resolve, 5100));
		check(
			(await request("/fixed")) !== afterDestroy,
			"expired idle sockets are discarded",
		);
	}
	if (secure && process.env.MAL_REUSE_POLICY === "1") {
		writeFileSync(process.env.NODE_EXTRA_CA_CERTS, "malformed changed CA input");
		let rejected = false;
		try {
			await request("/fixed");
		} catch {
			rejected = true;
		}
		check(rejected, "changed CA policy cannot borrow a trusted idle TLS connection");
	}
	console.log("RESULT " + checks + "/" + checks);
}
run().catch((error) => {
	console.log("FAIL: " + error.stack);
	process.exitCode = 1;
});
