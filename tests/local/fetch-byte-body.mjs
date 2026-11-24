const response = new Response(new Uint8Array([65, 66]));
const unused = response.bodyUsed;
const text = await response.text();
const used = response.bodyUsed;
let secondRead;
try {
	await response.text();
} catch (error) {
	secondRead = error.name;
}
console.log(`${unused},${text},${used},${secondRead}`);
