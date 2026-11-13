import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { Readable, pipeline } from "node:stream";
const selection = process.env.MAL_TEST_HTTP_PIPELINE_CASE;
const failure = new Error("fictional pipeline source failure");
let source;
let pipelineError;
let completions = 0;
let closes = 0;
let complete;
const completed = new Promise((resolve) => {
	complete = resolve;
});
const server = createServer((request, response) => {
	response.on("close", () => closes++);
	if (selection === "success")
		source = Readable.from([Buffer.from("first"), Buffer.from("second")]);
	else {
		let sent = false;
		source = new Readable({
			read() {
				if (!sent) {
					sent = true;
					this.push(Buffer.from("prefix"));
				}
			},
		});
	}
	pipeline(source, response, (error) => {
		completions++;
		pipelineError = error;
		complete();
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
	const body = await new Promise((resolve, reject) => {
		get(`http://127.0.0.1:${server.address().port}`, (response) => {
			let text = "";
			response.on("error", () => {});
			response.on("data", (chunk) => {
				text += chunk.toString();
				if (selection === "error") source.destroy(failure);
				else if (selection === "abort") response.destroy();
			});
			response.once("end", () => resolve(text));
			response.once("close", () => {
				if (selection !== "success") resolve(text);
			});
		}).once("error", reject);
	});
	await completed;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(completions, 1);
	assert.equal(closes, 1);
	if (selection === "success") {
		assert.equal(body, "firstsecond");
		assert.equal(pipelineError, undefined);
	} else {
		assert.equal(body, "prefix");
		assert.equal(source.destroyed, true);
		if (selection === "error") assert.equal(pipelineError, failure);
		else assert.ok(pipelineError instanceof Error);
	}
} finally {
	await new Promise((resolve) => server.close(resolve));
}
console.log("HTTP PIPELINE PASS");
