import assert from "node:assert/strict";

const selection = process.env.MAL_TEST_MULTIPART_CASE;
const boundary = "multipart:fixture";
const headers = { "Content-Type": `Multipart/Form-Data; boundary="${boundary}";` };
const encode = (text) => new TextEncoder().encode(text);
function body(parts) {
	const chunks = [];
	for (const part of parts) {
		chunks.push(encode(`--${boundary}\r\n${part.headers}\r\n\r\n`));
		chunks.push(typeof part.value === "string" ? encode(part.value) : part.value);
		chunks.push(encode("\r\n"));
	}
	chunks.push(encode(`--${boundary}--\r\n`));
	let size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes;
}
const field = (name, value) => ({
	headers: `Content-Disposition: form-data; name="${name}"`,
	value,
});

if (selection === "fields") {
	const bytes = body([
		field("name", "one"),
		field("name", "two"),
		field("号楼", "数据"),
		field("bom", "\uFEFFvalue"),
		field("quote%22name", "escaped"),
	]);
	for (const response of [
		new Response(bytes, { headers }),
		new Request("https://example.test/", { method: "POST", headers, body: bytes }),
	]) {
		const form = await response.formData();
		assert.deepEqual(form.getAll("name"), ["one", "two"]);
		assert.equal(form.get("号楼"), "数据");
		assert.equal(form.get("bom"), "\uFEFFvalue");
		assert.equal(form.get('quote"name'), "escaped");
		assert.deepEqual(Array.from(form.keys()), [
			"name",
			"name",
			"号楼",
			"bom",
			'quote"name',
		]);
		assert.equal(response.bodyUsed, true);
		await assert.rejects(response.formData(), TypeError);
	}
} else if (selection === "files") {
	const binary = new Uint8Array([0, 255, 13, 10, 1]);
	const bytes = body([
		{
			headers:
				'Content-Disposition: form-data; name="file"; filename="fallback.bin"; filename*=UTF-8\'\'caf%C3%A9.bin\r\nContent-Type: Application/Octet-Stream',
			value: binary,
		},
		{ headers: 'Content-Disposition: form-data; name="empty"; filename=""', value: "" },
		{
			headers:
				'Content-Disposition: form-data; name="encoded"; filename="base64.bin"\r\nContent-Transfer-Encoding: base64',
			value: "AP8=",
		},
		{
			headers:
				'Content-Disposition: form-data; name="text"\r\nContent-Transfer-Encoding: base64',
			value: "Y2hlY2s=",
		},
	]);
	const form = await new Response(bytes, { headers }).formData();
	const file = form.get("file");
	assert.ok(file instanceof File);
	assert.equal(file.name, "café.bin");
	assert.equal(file.type, "application/octet-stream");
	assert.deepEqual(new Uint8Array(await file.arrayBuffer()), binary);
	assert.equal(form.get("empty").name, "");
	assert.equal(form.get("empty").type, "text/plain");
	assert.deepEqual(
		new Uint8Array(await form.get("encoded").arrayBuffer()),
		new Uint8Array([0, 255]),
	);
	assert.equal(form.get("text"), "check");
} else if (selection === "stream") {
	const bytes = body([
		field("name", "streamed"),
		{
			headers: 'Content-Disposition: form-data; name="file"; filename="stream.txt"',
			value: "file body",
		},
	]);
	for (const request of [false, true]) {
		const stream = new ReadableStream({
			start(controller) {
				for (let i = 0; i < bytes.length; i += 3)
					controller.enqueue(bytes.slice(i, i + 3));
				controller.close();
			},
		});
		const response = request
			? new Request("https://example.test/", {
					method: "POST",
					body: stream,
					headers,
					duplex: "half",
				})
			: new Response(stream, { headers });
		const form = await response.formData();
		assert.equal(form.get("name"), "streamed");
		assert.equal(await form.get("file").text(), "file body");
		assert.equal(form.get("file").name, "stream.txt");
		assert.equal(response.bodyUsed, true);
	}
} else if (selection === "empty") {
	for (const response of [
		new Response(new FormData()),
		new Request("https://example.test/", { method: "POST", body: new FormData() }),
		new Response(encode(`--${boundary}--`), { headers }),
	]) {
		assert.deepEqual(Array.from(await response.formData()), []);
	}
	const form = new FormData();
	form.append("field", "value");
	form.append("file", new File(["body"], "named.txt", { type: "text/plain" }));
	form.append("path\\name", "backslash field");
	form.append("path-file", new File(["path body"], "dir\\file\\"));
	const parsed = await new Response(form).formData();
	assert.equal(parsed.get("field"), "value");
	assert.equal(parsed.get("path\\name"), "backslash field");
	assert.equal(parsed.get("path-file").name, "dir\\file\\");
	assert.equal(parsed.get("file").name, "named.txt");
	assert.equal(await parsed.get("file").text(), "body");
} else if (selection === "invalid") {
	for (const [contentType, value] of [
		["multipart/form-data", "body"],
		[`multipart/form-data-extra; boundary="${boundary}"`, "body"],
		[
			`multipart/form-data; boundary="${boundary}"`,
			`--${boundary}\r\nContent-Disposition: form-data\r\n\r\nvalue\r\n--${boundary}--`,
		],
		[
			`multipart/form-data; boundary="${boundary}"`,
			`--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\nvalue`,
		],
		[
			`multipart/form-data; boundary="${boundary}"`,
			`--${boundary}\r\nBad Header\r\n\r\nvalue\r\n--${boundary}--`,
		],
		["application/x-www-form-urlencoded-extra", "a=1"],
	]) {
		const response = new Response(value, { headers: { "Content-Type": contentType } });
		await assert.rejects(response.formData(), TypeError);
		assert.equal(response.bodyUsed, true);
	}
} else if (selection === "boundary-data") {
	const binary = encode(`prefix ${boundary} inside\r\n--${boundary}X\r\nstill file data`);
	const bytes = body([
		{
			headers: 'Content-Disposition: form-data; name="file"; filename="boundary.bin"',
			value: binary,
		},
	]);
	const parsed = await new Response(bytes, { headers }).formData();
	assert.deepEqual(new Uint8Array(await parsed.get("file").arrayBuffer()), binary);
	const form = new FormData();
	const first = new Response(form);
	const previousBoundary = first.headers.get("content-type").split("boundary=")[1];
	const boundaryText = `\r\n--${previousBoundary}--\r\nstill data`;
	form.append("previous-boundary", boundaryText);
	const roundTrip = await new Response(form).formData();
	assert.equal(roundTrip.get("previous-boundary"), boundaryText);
} else {
	throw new Error(`Unknown case: ${selection}`);
}
console.log("MULTIPART PASS");
