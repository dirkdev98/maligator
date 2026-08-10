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

function byteStream(...chunks) {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
			controller.close();
		},
	});
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

	const passthroughStream = new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array([115, 116, 114]));
			controller.enqueue(new Uint8Array([101, 97, 109]));
			controller.close();
		},
	});
	const streamResponse = new Response(passthroughStream);
	check(
		"Response accepts an undisturbed ReadableStream BodyInit",
		streamResponse.body === passthroughStream &&
			streamResponse.headers.get("content-type") === null &&
			!streamResponse.bodyUsed,
	);
	const streamingText = streamResponse.text();
	check(
		"streaming Body conversion disturbs and locks synchronously",
		streamResponse.bodyUsed && passthroughStream.locked,
	);
	check("streaming Body collects ordered chunks", (await streamingText) === "stream");
	check(
		"streaming Body rejects repeated consumption",
		await rejectsTypeError(streamResponse.bytes()),
	);
	const streamedBytes = await new Response(byteStream([1], [2, 3])).bytes();
	check(
		"streaming Body bytes conversion",
		streamedBytes instanceof Uint8Array &&
			streamedBytes.length === 3 &&
			streamedBytes[0] === 1 &&
			streamedBytes[2] === 3,
	);
	const streamedBuffer = await new Response(byteStream([4, 5], [6])).arrayBuffer();
	const streamedBufferBytes = new Uint8Array(streamedBuffer);
	check(
		"streaming Body arrayBuffer conversion",
		streamedBuffer instanceof ArrayBuffer &&
			streamedBufferBytes[0] === 4 &&
			streamedBufferBytes[2] === 6,
	);
	const streamedJson = await new Response(
		byteStream([123, 34, 111, 107, 34], [58, 116, 114, 117, 101, 125]),
	).json();
	check("streaming Body JSON conversion", streamedJson.ok === true);
	const streamedBlob = await new Response(byteStream([98], [108, 111, 98]), {
		headers: { "Content-Type": "text/plain" },
	}).blob();
	check(
		"streaming Body Blob conversion",
		streamedBlob instanceof Blob &&
			streamedBlob.type === "text/plain" &&
			(await streamedBlob.text()) === "blob",
	);
	const streamedForm = await new Response(byteStream([120, 61, 49, 38], [121, 61, 50]), {
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
	}).formData();
	check(
		"streaming Body formData conversion",
		streamedForm.get("x") === "1" && streamedForm.get("y") === "2",
	);
	let pullCount = 0;
	const pulledBody = new Response(
		new ReadableStream({
			pull(controller) {
				pullCount++;
				if (pullCount === 1) controller.enqueue(new Uint8Array([112, 117, 108, 108]));
				else controller.close();
			},
		}),
	);
	check(
		"streaming Body drives pull through queued promise reactions",
		(await pulledBody.text()) === "pull" && pullCount === 2,
	);
	const patchedStream = byteStream([105, 110, 116, 101, 114, 110, 97, 108]);
	patchedStream.getReader = () => {
		throw new Error("observable getReader called");
	};
	check(
		"streaming Body uses internal reader algorithms",
		(await new Response(patchedStream).text()) === "internal",
	);
	const requestStream = byteStream([114, 101], [113, 117, 101, 115, 116]);
	const streamingRequest = new Request("https://example.com/upload", {
		method: "POST",
		body: requestStream,
		duplex: "half",
	});
	check(
		"Request accepts a ReadableStream body with duplex half",
		streamingRequest.body === requestStream &&
			streamingRequest.duplex === "half" &&
			!streamingRequest.bodyUsed,
	);
	check(
		"Request consumes a streaming body",
		(await streamingRequest.text()) === "request" && streamingRequest.bodyUsed,
	);
	let missingDuplexThrows = false;
	try {
		new Request("https://example.com/upload", {
			method: "POST",
			body: byteStream([1]),
		});
	} catch (error) {
		missingDuplexThrows = error instanceof TypeError;
	}
	check("Request stream body requires duplex", missingDuplexThrows);
	let invalidDuplexThrows = false;
	try {
		new Request("https://example.com/upload", {
			method: "POST",
			body: "data",
			duplex: "full",
		});
	} catch (error) {
		invalidDuplexThrows = error instanceof TypeError;
	}
	check("Request validates the duplex enum", invalidDuplexThrows);
	let streamGetThrows = false;
	try {
		new Request("https://example.com/upload", {
			body: byteStream([1]),
			duplex: "half",
		});
	} catch (error) {
		streamGetThrows = error instanceof TypeError;
	}
	check("Request rejects a stream body for GET", streamGetThrows);
	let streamNoCorsThrows = false;
	try {
		new Request("https://example.com/upload", {
			method: "POST",
			mode: "no-cors",
			body: byteStream([1]),
			duplex: "half",
		});
	} catch (error) {
		streamNoCorsThrows = error instanceof TypeError;
	}
	check("Request rejects stream bodies in no-cors mode", streamNoCorsThrows);
	const proxySource = new Request("https://example.com/upload", {
		method: "POST",
		body: byteStream([112, 114, 111], [120, 121]),
		duplex: "half",
	});
	const proxiedRequest = new Request(proxySource);
	check(
		"Request copy creates a distinct proxy for a streaming body",
		proxiedRequest.body !== proxySource.body && proxySource.body.locked,
	);
	check(
		"Request streaming body proxy forwards ordered chunks",
		(await proxiedRequest.text()) === "proxy" && proxiedRequest.bodyUsed,
	);
	const teeSource = new Request("https://example.com/upload", {
		method: "POST",
		body: byteStream([116, 101], [101]),
		duplex: "half",
	});
	const teeClone = teeSource.clone();
	check(
		"Request clone tees a streaming body into distinct branches",
		teeSource.body !== teeClone.body && !teeSource.bodyUsed && !teeClone.bodyUsed,
	);
	check(
		"Request clone branches consume independently",
		(await teeClone.text()) === "tee" &&
			(await teeSource.text()) === "tee" &&
			teeClone.bodyUsed &&
			teeSource.bodyUsed,
	);
	let teeCancelReason;
	const cancelSource = new Request("https://example.com/upload", {
		method: "POST",
		body: new ReadableStream({
			pull() {
				return new Promise(() => {});
			},
			cancel(reason) {
				teeCancelReason = reason;
			},
		}),
		duplex: "half",
	});
	const cancelClone = cancelSource.clone();
	let firstCancelSettled = false;
	const firstCancel = cancelSource.body.cancel("first").then(() => {
		firstCancelSettled = true;
	});
	await Promise.resolve();
	check("one tee branch does not cancel the source", !firstCancelSettled);
	const secondCancel = cancelClone.body.cancel("second");
	await Promise.all([firstCancel, secondCancel]);
	check(
		"both tee cancellations reach the source as ordered reasons",
		Array.isArray(teeCancelReason) &&
			teeCancelReason[0] === "first" &&
			teeCancelReason[1] === "second",
	);

	const streamError = new Error("stream failure");
	const erroredBody = new Response(
		new ReadableStream({
			start(controller) {
				controller.error(streamError);
			},
		}),
	);
	let preservedStreamError = false;
	try {
		await erroredBody.text();
	} catch (error) {
		preservedStreamError = error === streamError;
	}
	check("streaming Body preserves stream errors", preservedStreamError);
	check(
		"streaming Body rejects non-byte chunks",
		await rejectsTypeError(
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue("not bytes");
						controller.close();
					},
				}),
			).text(),
		),
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
