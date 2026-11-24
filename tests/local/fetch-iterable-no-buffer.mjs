async function* chunks() {
	yield process.env.MAL_TEST_FETCH_CHUNK ?? "é";
	yield new Uint16Array([0x141, 0x242]);
	yield new DataView(new Uint8Array([99]).buffer);
	yield new Uint8Array([67]).buffer;
	yield { length: 1, 0: 68 };
}
console.log(await new Response(chunks()).text());
