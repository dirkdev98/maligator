import assert from "node:assert/strict";
const fields = [
	["Connection", "x-internal-auth"],
	["X-Internal-Auth", "fictional"],
	["Accept-Encoding", "gzip"],
	["Cookie", "session=fictional"],
	["Host", "example.test"],
	["Sec-Fetch-Site", "same-origin"],
];
for (const mode of ["cors", "no-cors", "same-origin"]) {
	const original = new Request("http://example.test/", { mode, headers: fields });
	for (const request of [
		original,
		original.clone(),
		new Request(original),
		new Request(original, { mode }),
	]) {
		for (const [name, value] of fields) {
			assert.equal(request.headers.get(name), value);
			request.headers.set(name, value + "-set");
			assert.equal(request.headers.get(name), value + "-set");
			request.headers.delete(name);
			assert.equal(request.headers.get(name), null);
			request.headers.append(name, value);
			assert.equal(request.headers.get(name), value);
		}
		assert.throws(() => request.headers.set("bad name", "value"), TypeError);
		assert.throws(() => request.headers.append("x-invalid", "a\r\nb"), TypeError);
	}
	assert.throws(
		() =>
			new Request("http://example.test/", { mode, headers: [["x", "invalid\nvalue"]] }),
		TypeError,
	);
}
const immutable = Response.redirect("http://example.test/").headers;
for (const method of ["set", "append", "delete"])
	assert.throws(() => immutable[method]("cookie", "fictional"), TypeError);
console.log("REQUEST SERVER HEADERS PASS");
