async function* chunks() {
	yield process.env.MAL_TEST_FETCH_CHUNK ?? "A";
}
const { value } = await new Response(chunks()).body.getReader().read();
console.log(`${value.constructor.name}:${value.toString()}`);
