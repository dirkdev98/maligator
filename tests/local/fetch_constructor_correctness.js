const results = [];

function check(name, condition) {
	results.push([name, !!condition]);
}

function throws(errorConstructor, callback) {
	try {
		callback();
		return false;
	} catch (error) {
		return error instanceof errorConstructor;
	}
}

function rejectsHeaderMutations(headers) {
	return (
		throws(TypeError, () => headers.append("x-guard", "append")) &&
		throws(TypeError, () => headers.delete("location")) &&
		throws(TypeError, () => headers.set("x-guard", "set"))
	);
}

function mutatesHeaders(headers) {
	headers.append("x-mutable", "append");
	headers.set("x-mutable", "set");
	const setWorked = headers.get("x-mutable") === "set";
	headers.delete("x-mutable");
	return setWorked && !headers.has("x-mutable");
}

async function run() {
	const defaults = new Response();
	check(
		"Response metadata defaults",
		defaults.status === 200 &&
			defaults.statusText === "" &&
			defaults.type === "default" &&
			defaults.url === "" &&
			defaults.redirected === false,
	);
	check(
		"Response status uses Web IDL unsigned short conversion",
		new Response(null, { status: 65736.9 }).status === 200 &&
			new Response(null, { status: -65336.9 }).status === 200 &&
			Response.json({}, { status: 65737.9 }).status === 201 &&
			throws(RangeError, () => new Response(null, { status: 65536 })) &&
			throws(RangeError, () => new Response(null, { status: Infinity })) &&
			throws(RangeError, () => new Response(null, { status: NaN })),
	);

	class DerivedResponse extends Response {}
	const derived = new DerivedResponse("derived", { status: 201 });
	check(
		"Response derives its prototype from newTarget",
		derived instanceof DerivedResponse &&
			derived instanceof Response &&
			Object.getPrototypeOf(derived) === DerivedResponse.prototype,
	);

	const responseGetterNames = [
		"body",
		"bodyUsed",
		"status",
		"ok",
		"statusText",
		"type",
		"url",
		"redirected",
		"headers",
	];
	check(
		"Web IDL getters are enumerable",
		responseGetterNames.every((name) => {
			const descriptor = Object.getOwnPropertyDescriptor(Response.prototype, name);
			return (
				descriptor.enumerable === true &&
				descriptor.configurable === true &&
				typeof descriptor.get === "function" &&
				descriptor.set === undefined
			);
		}) &&
			["body", "bodyUsed"].every(
				(name) =>
					Object.getOwnPropertyDescriptor(Request.prototype, name).enumerable === true,
			),
	);
	const headersGetter = Object.getOwnPropertyDescriptor(
		Response.prototype,
		"headers",
	).get;
	check(
		"Response headers getter validates its receiver",
		throws(TypeError, () => headersGetter.call({})) &&
			throws(TypeError, () => headersGetter.call(new Request("https://example.com/"))),
	);

	const customStatus = new Response(null, { status: 299, statusText: "Fine\t\x80" });
	check("Response honors statusText", customStatus.statusText === "Fine\t\x80");
	check(
		"Response validates statusText reason phrase",
		throws(TypeError, () => new Response(null, { statusText: "bad\nphrase" })) &&
			throws(TypeError, () => new Response(null, { statusText: "bad\u20ac" })),
	);
	check(
		"Response.json honors statusText",
		Response.json({}, { status: 201, statusText: "Made" }).statusText === "Made",
	);

	const errorResponse = Response.error();
	check(
		"Response.error invariants",
		errorResponse.type === "error" &&
			errorResponse.status === 0 &&
			errorResponse.statusText === "" &&
			errorResponse.ok === false &&
			errorResponse.url === "" &&
			errorResponse.redirected === false &&
			errorResponse.body === null &&
			errorResponse.bodyUsed === false &&
			errorResponse.headers instanceof Headers &&
			errorResponse.headers.get("content-type") === null,
	);
	check(
		"Response.error headers are immutable",
		rejectsHeaderMutations(errorResponse.headers) &&
			errorResponse.headers.get("x-guard") === null &&
			[...errorResponse.headers].length === 0,
	);
	const errorHeadersCopy = new Headers(errorResponse.headers);
	check(
		"copying immutable empty headers produces mutable headers",
		mutatesHeaders(errorHeadersCopy),
	);

	check(
		"Response and Request constructor headers are mutable",
		mutatesHeaders(new Response().headers) &&
			mutatesHeaders(new Request("https://example.com/").headers),
	);

	check(
		"Response string Content-Type",
		new Response("body").headers.get("content-type") === "text/plain;charset=UTF-8",
	);
	check(
		"Response URLSearchParams Content-Type",
		new Response(new URLSearchParams("a=1")).headers.get("content-type") ===
			"application/x-www-form-urlencoded;charset=UTF-8",
	);
	check(
		"Response explicit Content-Type wins",
		new Response("body", {
			headers: { "content-type": "application/custom" },
		}).headers.get("content-type") === "application/custom",
	);

	check(
		"Request string Content-Type",
		new Request("https://example.com/", { method: "POST", body: "body" }).headers.get(
			"content-type",
		) === "text/plain;charset=UTF-8",
	);
	check(
		"Request URLSearchParams Content-Type",
		new Request("https://example.com/", {
			method: "POST",
			body: new URLSearchParams("a=1"),
		}).headers.get("content-type") === "application/x-www-form-urlencoded;charset=UTF-8",
	);
	check(
		"Request explicit Content-Type wins",
		new Request("https://example.com/", {
			method: "POST",
			body: "body",
			headers: { "content-type": "application/custom" },
		}).headers.get("content-type") === "application/custom",
	);

	const responseBuffer = new ArrayBuffer(6);
	new Uint8Array(responseBuffer).set([10, 11, 12, 13, 14, 15]);
	const responseView = new DataView(responseBuffer, 2, 3);
	Object.defineProperty(responseView, "byteOffset", { value: 0 });
	Object.defineProperty(responseView, "byteLength", { value: 6 });
	const responseViewBytes = await new Response(responseView).bytes();
	check(
		"Response accepts DataView offset",
		responseViewBytes.length === 3 &&
			responseViewBytes[0] === 12 &&
			responseViewBytes[2] === 14,
	);

	const requestBuffer = new ArrayBuffer(7);
	new Uint8Array(requestBuffer).set([20, 21, 22, 23, 24, 25, 26]);
	const requestViewBytes = await new Request("https://example.com/", {
		method: "POST",
		body: new DataView(requestBuffer, 3, 2),
	}).bytes();
	check(
		"Request accepts DataView offset",
		requestViewBytes.length === 2 &&
			requestViewBytes[0] === 23 &&
			requestViewBytes[1] === 24,
	);

	const emptyTypedBytes = await new Response(new Uint8Array(new ArrayBuffer(0))).bytes();
	const endOffsetBuffer = new ArrayBuffer(4);
	const emptyDataViewBytes = await new Request("https://example.com/", {
		method: "POST",
		body: new DataView(endOffsetBuffer, 4, 0),
	}).bytes();
	check(
		"zero-length body views avoid null pointer arithmetic",
		emptyTypedBytes.length === 0 && emptyDataViewBytes.length === 0,
	);

	const detachedDataViewBuffer = new ArrayBuffer(4);
	const detachedDataView = new DataView(detachedDataViewBuffer, 1, 2);
	detachedDataViewBuffer.transfer();
	const detachedTypedArrayBuffer = new ArrayBuffer(4);
	const detachedTypedArray = new Uint8Array(detachedTypedArrayBuffer, 1, 2);
	detachedTypedArrayBuffer.transfer();
	const detachedArrayBuffer = new ArrayBuffer(4);
	detachedArrayBuffer.transfer();
	check(
		"detached body sources are rejected",
		throws(TypeError, () => new Response(detachedDataView)) &&
			throws(TypeError, () => new Response(detachedArrayBuffer)) &&
			throws(
				TypeError,
				() =>
					new Request("https://example.com/", {
						method: "POST",
						body: detachedTypedArray,
					}),
			),
	);

	const resizableBuffer = new ArrayBuffer(8, { maxByteLength: 8 });
	const outOfBoundsTypedArray = new Uint8Array(resizableBuffer, 4, 4);
	const outOfBoundsDataView = new DataView(resizableBuffer, 4, 4);
	resizableBuffer.resize(2);
	check(
		"out-of-bounds body views are rejected",
		throws(TypeError, () => new Response(outOfBoundsTypedArray)) &&
			throws(
				TypeError,
				() =>
					new Request("https://example.com/", {
						method: "POST",
						body: outOfBoundsDataView,
					}),
			),
	);
	const trackingBodyBuffer = new ArrayBuffer(5, { maxByteLength: 8 });
	new Uint8Array(trackingBodyBuffer).set([30, 31, 32, 33, 34]);
	const trackingBodyView = new DataView(trackingBodyBuffer, 1);
	trackingBodyBuffer.resize(3);
	const trackingBodyBytes = await new Response(trackingBodyView).bytes();
	check(
		"length-tracking DataView body uses its resized window",
		trackingBodyBytes.length === 2 &&
			trackingBodyBytes[0] === 31 &&
			trackingBodyBytes[1] === 32,
	);

	check(
		"Request normalizes standard methods",
		new Request("https://example.com/", { method: "post" }).method === "POST" &&
			new Request("https://example.com/", { method: "deLETe" }).method === "DELETE",
	);
	check(
		"Request preserves extension method case",
		new Request("https://example.com/", { method: "patch" }).method === "patch",
	);
	check(
		"Request rejects invalid and forbidden methods",
		throws(
			TypeError,
			() => new Request("https://example.com/", { method: "bad method" }),
		) &&
			throws(
				TypeError,
				() => new Request("https://example.com/", { method: "CONNECT" }),
			) &&
			throws(TypeError, () => new Request("https://example.com/", { method: "trace" })) &&
			throws(TypeError, () => new Request("https://example.com/", { method: "TRACK" })) &&
			throws(TypeError, () => new Request("https://example.com/", { method: "x\u20ac" })),
	);

	const redirect = Response.redirect("https://example.com/a/../b", "303");
	check(
		"Response.redirect validates and serializes URL",
		redirect.status === 303 &&
			redirect.statusText === "" &&
			redirect.type === "default" &&
			redirect.url === "" &&
			redirect.redirected === false &&
			redirect.headers.get("location") === "https://example.com/b",
	);
	check(
		"Response.redirect headers are immutable",
		rejectsHeaderMutations(redirect.headers) &&
			redirect.headers.get("location") === "https://example.com/b" &&
			[...redirect.headers].length === 1 &&
			[...redirect.headers][0].join("=") === "location=https://example.com/b",
	);
	const redirectHeadersCopy = new Headers(redirect.headers);
	redirectHeadersCopy.set("location", "https://example.org/");
	check(
		"copying immutable populated headers preserves entries without the guard",
		redirectHeadersCopy.get("location") === "https://example.org/" &&
			redirect.headers.get("location") === "https://example.com/b",
	);
	check(
		"Response.redirect allows only redirect statuses",
		[301, 302, 303, 307, 308].every(
			(status) => Response.redirect("https://example.com/", status).status === status,
		) &&
			Response.redirect("https://example.com/", undefined).status === 302 &&
			throws(RangeError, () => Response.redirect("https://example.com/", 300)),
	);
	check(
		"Response.redirect rejects invalid URLs",
		throws(TypeError, () => Response.redirect("http://[")),
	);
}

run().then(
	() => {
		let passed = 0;
		for (const [name, result] of results) {
			if (result) passed++;
			else console.log("FAIL: " + name);
		}
		console.log("RESULT " + passed + "/" + results.length);
	},
	(error) => {
		console.log("FAIL: unexpected " + error);
		console.log("RESULT 0/1");
	},
);
