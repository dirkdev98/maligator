const results = [];

function check(name, condition) {
	results.push([name, !!condition]);
}

async function rejectsTypeError(promise) {
	try {
		await promise;
		return false;
	} catch (error) {
		return error instanceof TypeError;
	}
}

async function rejectsSyntaxError(promise) {
	try {
		await promise;
		return false;
	} catch (error) {
		return error instanceof SyntaxError;
	}
}

async function run() {
	const response = new Response(new Uint8Array([1, 2, 255]));
	const responseBody = response.body;
	check(
		"Response body identity",
		responseBody instanceof ReadableStream && response.body === responseBody,
	);
	check("Response initially unused", response.bodyUsed === false);
	const responseReader = responseBody.getReader();
	const responseChunk = await responseReader.read();
	check(
		"Response body byte chunk",
		responseChunk.done === false &&
			responseChunk.value instanceof Uint8Array &&
			responseChunk.value.length === 3 &&
			responseChunk.value[0] === 1 &&
			responseChunk.value[1] === 2 &&
			responseChunk.value[2] === 255,
	);
	check("reader read disturbs Response", response.bodyUsed === true);
	check("memory stream closes after chunk", (await responseReader.read()).done === true);
	responseReader.releaseLock();
	check("stream read blocks Response method", await rejectsTypeError(response.text()));

	const sourceBytes = new Uint8Array([41, 42]);
	let retainedStream = new Response(sourceBytes).body;
	sourceBytes[0] = 99;
	for (let i = 0; i < 20; i++) new Response("pressure-" + i).body;
	const retainedChunk = await retainedStream.getReader().read();
	check(
		"body stream owns its byte view",
		retainedChunk.value[0] === 41 && retainedChunk.value[1] === 42,
	);
	retainedStream = null;

	const locked = new Response("locked");
	const lockedBody = locked.body;
	const lockedReader = lockedBody.getReader();
	check("locking alone does not disturb", locked.bodyUsed === false && lockedBody.locked);
	check("locked body method rejects", await rejectsTypeError(locked.text()));
	check("lock rejection leaves body unused", locked.bodyUsed === false);
	lockedReader.releaseLock();
	check("released lock permits consumption", (await locked.text()) === "locked");
	check("method consumption disturbs and locks", locked.bodyUsed && lockedBody.locked);
	check("repeated method rejects", await rejectsTypeError(locked.bytes()));

	const json = new Response('{"ok":true,"n":4}');
	const parsed = await json.json();
	check("json consumes once", parsed.ok === true && parsed.n === 4 && json.bodyUsed);
	check("json cannot be repeated", await rejectsTypeError(json.json()));

	const malformed = new Response("{bad");
	check("malformed JSON rejects SyntaxError", await rejectsSyntaxError(malformed.json()));
	check("JSON error still consumes body", malformed.bodyUsed);
	check("JSON error cannot be retried", await rejectsTypeError(malformed.text()));

	check(
		"text strips a UTF-8 BOM and replaces malformed input",
		(await new Response(new Uint8Array([0xef, 0xbb, 0xbf, 0xe1, 0x80, 0x41])).text()) ===
			"�A",
	);
	const originalJsonParse = JSON.parse;
	JSON.parse = () => ({ replaced: true });
	const intrinsicJson = await new Response('\ufeff{"intrinsic":true}').json();
	JSON.parse = originalJsonParse;
	check("json uses the intrinsic parser", intrinsicJson.intrinsic === true);

	const arrayBufferResponse = new Response(new Uint8Array([7, 8]));
	const arrayBuffer = await arrayBufferResponse.arrayBuffer();
	const arrayBufferBytes = new Uint8Array(arrayBuffer);
	check(
		"arrayBuffer consumes bytes",
		arrayBuffer.byteLength === 2 &&
			arrayBufferBytes[0] === 7 &&
			arrayBufferBytes[1] === 8 &&
			arrayBufferResponse.bodyUsed,
	);

	const bytesResponse = new Response("AZ");
	const bytes = await bytesResponse.bytes();
	check(
		"bytes consumes UTF-8",
		bytes instanceof Uint8Array &&
			bytes.length === 2 &&
			bytes[0] === 65 &&
			bytes[1] === 90 &&
			bytesResponse.bodyUsed,
	);

	const blobResponse = new Response("blob text", {
		headers: { "Content-Type": "text/custom" },
	});
	const blob = await blobResponse.blob();
	check(
		"blob snapshots MIME and text",
		blob.type === "text/custom" &&
			(await blob.text()) === "blob text" &&
			blobResponse.bodyUsed,
	);
	check("blob consumption is one-shot", await rejectsTypeError(blobResponse.blob()));

	const nativeBlob = new Blob(["A", new Uint8Array([66]), new Blob(["C"])], {
		type: "TEXT/PLAIN",
	});
	check(
		"Blob owns parts and normalizes type",
		nativeBlob instanceof Blob &&
			nativeBlob.size === 3 &&
			nativeBlob.type === "text/plain" &&
			(await nativeBlob.text()) === "ABC",
	);
	const blobBytes = await nativeBlob.bytes();
	check(
		"Blob exposes copied bytes",
		blobBytes instanceof Uint8Array &&
			blobBytes[0] === 65 &&
			blobBytes[1] === 66 &&
			blobBytes[2] === 67,
	);
	const blobInitResponse = new Response(nativeBlob);
	check(
		"Response accepts Blob BodyInit",
		blobInitResponse.headers.get("content-type") === "text/plain" &&
			(await blobInitResponse.text()) === "ABC",
	);
	const blobInitRequest = new Request("https://example.com/", {
		method: "POST",
		body: nativeBlob,
	});
	check(
		"Request accepts Blob BodyInit",
		blobInitRequest.headers.get("content-type") === "text/plain" &&
			(await blobInitRequest.text()) === "ABC",
	);
	check(
		"Blob methods enforce their brand",
		await rejectsTypeError(Blob.prototype.text.call({})),
	);

	const formData = new FormData();
	formData.append("name", "first");
	formData.append("name", "second");
	formData.append("file", new Blob(["payload"], { type: "text/custom" }), "x.txt");
	check(
		"FormData preserves ordered entries",
		formData instanceof FormData &&
			formData.get("name") === "first" &&
			formData.getAll("name").join(",") === "first,second" &&
			formData.has("file") &&
			Array.from(formData.keys()).join(",") === "name,name,file" &&
			Array.from(formData.values())[2] instanceof Blob,
	);
	formData.set("name", "replacement");
	formData.delete("file");
	check(
		"FormData set and delete retain position",
		JSON.stringify(Array.from(formData)) === JSON.stringify([["name", "replacement"]]),
	);
	const multipart = new FormData();
	multipart.append("name", "value");
	const multipartResponse = new Response(multipart);
	check(
		"Response serializes FormData BodyInit",
		multipartResponse.headers.get("content-type").startsWith("multipart/form-data;") &&
			(await multipartResponse.text()).includes('name="name"\r\n\r\nvalue'),
	);
	const multipartRequest = new Request("https://example.com/", {
		method: "POST",
		body: multipart,
	});
	check(
		"Request serializes FormData BodyInit",
		multipartRequest.headers.get("content-type").startsWith("multipart/form-data;") &&
			(await multipartRequest.text()).includes('name="name"\r\n\r\nvalue'),
	);
	check(
		"empty FormData retains an empty byte body",
		(await new Response(new FormData()).text()) === "",
	);
	const parsedRequest = await new Request("https://example.com/", {
		method: "POST",
		body: "a=1&a=two+words",
		headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
	}).formData();
	check(
		"Request formData parses URL-encoded entries",
		parsedRequest instanceof FormData &&
			JSON.stringify(Array.from(parsedRequest)) ===
				JSON.stringify([
					["a", "1"],
					["a", "two words"],
				]),
	);
	const parsedResponse = await new Response("x=%E2%80%A0", {
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
	}).formData();
	check("Response formData uses UTF-8", parsedResponse.get("x") === "†");
	const nullFormBody = new Response(null, {
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
	});
	check(
		"null URL-encoded body resolves empty FormData without disturbance",
		(await nullFormBody.formData()) instanceof FormData && !nullFormBody.bodyUsed,
	);
	check(
		"unsupported formData MIME rejects",
		await rejectsTypeError(new Response(null).formData()),
	);

	const passthroughStream = new ReadableStream();
	const streamResponse = new Response(passthroughStream);
	check(
		"Response accepts an undisturbed ReadableStream BodyInit",
		streamResponse.body === passthroughStream &&
			streamResponse.headers.get("content-type") === null &&
			!streamResponse.bodyUsed,
	);
	check(
		"streaming Body conversion fails asynchronously until stream reads land",
		(await rejectsTypeError(streamResponse.text())) && !streamResponse.bodyUsed,
	);
	const lockedStream = new ReadableStream();
	const lockedStreamReader = lockedStream.getReader();
	let lockedBodyThrows = false;
	try {
		new Response(lockedStream);
	} catch (error) {
		lockedBodyThrows = error instanceof TypeError;
	}
	lockedStreamReader.releaseLock();
	check("Response rejects a locked ReadableStream BodyInit", lockedBodyThrows);

	const canceled = new Response("cancel me");
	await canceled.body.cancel("unused");
	check("stream cancel disturbs body", canceled.bodyUsed);
	check("stream cancel blocks body method", await rejectsTypeError(canceled.text()));

	const readerCanceled = new Response("reader cancel");
	const cancelReader = readerCanceled.body.getReader();
	await cancelReader.cancel();
	check("reader cancel disturbs body", readerCanceled.bodyUsed);

	const empty = new Response("");
	const emptyBody = empty.body;
	const emptyReader = emptyBody.getReader();
	const emptyChunk = await emptyReader.read();
	check(
		"empty present body closes without a chunk",
		emptyChunk.done === true && emptyChunk.value === undefined,
	);
	check("empty present body is disturbed", empty.bodyUsed);

	const nullBody = new Response();
	check("Response null body", nullBody.body === null && nullBody.bodyUsed === false);
	check(
		"null body consumption remains repeatable",
		(await nullBody.text()) === "" &&
			(await nullBody.text()) === "" &&
			(await nullBody.arrayBuffer()).byteLength === 0 &&
			nullBody.bodyUsed === false,
	);
	const emptyBlob = await nullBody.blob();
	check(
		"null body blob remains repeatable",
		emptyBlob.type === "" &&
			(await emptyBlob.text()) === "" &&
			(await nullBody.blob()).type === "" &&
			!nullBody.bodyUsed,
	);
	check(
		"null JSON rejects without disturbance",
		await rejectsSyntaxError(nullBody.json()),
	);
	check(
		"null JSON can reject repeatedly",
		(await rejectsSyntaxError(nullBody.json())) && nullBody.bodyUsed === false,
	);

	const request = new Request("https://example.com/", {
		method: "POST",
		body: new Uint8Array([9, 10]),
	});
	check(
		"Request body identity",
		request.body instanceof ReadableStream &&
			request.body === request.body &&
			!request.bodyUsed,
	);
	const requestBytes = await request.bytes();
	check(
		"Request bytes consume once",
		requestBytes[0] === 9 && requestBytes[1] === 10 && request.bodyUsed,
	);
	check("repeated Request consumption rejects", await rejectsTypeError(request.text()));

	const cloneSource = new Request("https://example.com/", {
		method: "POST",
		body: "clone",
	});
	const clone = new Request(cloneSource);
	check(
		"Request cloning transfers the source body",
		cloneSource.bodyUsed && cloneSource.body.locked && (await clone.text()) === "clone",
	);
	let usedCloneThrows = false;
	try {
		new Request(cloneSource);
	} catch (error) {
		usedCloneThrows = error instanceof TypeError;
	}
	check("Request cloning rejects a used source", usedCloneThrows);
	const overrideSource = new Request("https://example.com/", {
		method: "POST",
		body: "source",
	});
	const overridden = new Request(overrideSource, { body: "override" });
	check(
		"init body does not disturb the source",
		!overrideSource.bodyUsed && (await overridden.text()) === "override",
	);
	const dictionarySource = new Request("https://example.com/", {
		method: "POST",
		body: "dictionary",
	});
	const dictionaryCopy = new Request("https://example.com/", dictionarySource);
	check(
		"RequestInit copies a Request byte stream",
		!dictionarySource.bodyUsed && (await dictionaryCopy.text()) === "dictionary",
	);
	check(
		"Response methods reject Request receivers",
		await rejectsTypeError(
			Response.prototype.text.call(new Request("https://example.com/")),
		),
	);
	check(
		"Request methods reject Response receivers",
		await rejectsTypeError(Request.prototype.text.call(new Response("cross-brand"))),
	);
	let crossBrandGetterThrows = false;
	try {
		Object.getOwnPropertyDescriptor(Response.prototype, "body").get.call(request);
	} catch (error) {
		crossBrandGetterThrows = error instanceof TypeError;
	}
	check("Body getters reject cross-brand receivers", crossBrandGetterThrows);

	const requestRead = new Request("https://example.com/", { method: "POST", body: "rq" });
	const requestReader = requestRead.body.getReader();
	const requestChunk = await requestReader.read();
	check(
		"Request stream read disturbs",
		requestRead.bodyUsed &&
			requestChunk.value[0] === 114 &&
			requestChunk.value[1] === 113,
	);
	check("Request stream read blocks method", await rejectsTypeError(requestRead.json()));

	const nullRequest = new Request("https://example.com/");
	check(
		"Request null body",
		nullRequest.body === null &&
			nullRequest.bodyUsed === false &&
			(await nullRequest.text()) === "" &&
			(await nullRequest.text()) === "",
	);
	let getBodyThrows = false;
	let nullStatusBodyThrows = false;
	try {
		new Request("https://example.com/", { method: "GET", body: "invalid" });
	} catch (error) {
		getBodyThrows = error instanceof TypeError;
	}
	try {
		new Response("invalid", { status: 204 });
	} catch (error) {
		nullStatusBodyThrows = error instanceof TypeError;
	}
	check("GET bodies are rejected", getBodyThrows);
	check("null-body Response statuses reject bodies", nullStatusBodyThrows);

	const retainedHeaders = new Response(
		{
			toString() {
				for (let i = 0; i < 100; i++) new Uint8Array(256);
				return "rooted";
			},
		},
		{
			get headers() {
				return { "x-rooted": "yes" };
			},
		},
	);
	check(
		"Response roots init headers across BodyInit coercion",
		retainedHeaders.headers.get("x-rooted") === "yes",
	);
	let invalidStatusThrows = false;
	try {
		new Response(null, { status: NaN });
	} catch (error) {
		invalidStatusThrows = error instanceof RangeError;
	}
	check("Response rejects non-finite status before conversion", invalidStatusThrows);
	const abruptSource = new Request("https://example.com/", {
		method: "POST",
		body: "preserved",
	});
	const abrupt = new Error("headers getter");
	let preservedAbrupt = false;
	try {
		new Request(abruptSource, {
			get headers() {
				throw abrupt;
			},
		});
	} catch (error) {
		preservedAbrupt = error === abrupt;
	}
	check(
		"Request preserves abrupt completion before body transfer",
		preservedAbrupt && !abruptSource.bodyUsed && !abruptSource.body.locked,
	);

	for (let i = 0; i < 40; i++) {
		const teardown = new Response(new Uint8Array([i, i + 1]));
		if (i % 2 === 0) await teardown.bytes();
		else await teardown.body.cancel();
	}
	check("body teardown pressure completes", true);
}

run().then(
	() => {
		let passed = 0;
		for (const result of results) {
			if (result[1]) passed++;
			else console.log("FAIL: " + result[0]);
		}
		console.log("RESULT " + passed + "/" + results.length);
	},
	(error) => {
		console.log("FAIL: unexpected " + error);
		console.log("RESULT 0/1");
	},
);
