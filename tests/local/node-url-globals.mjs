const checks = [];

const encoded = new TextEncoder().encode("OK");
checks.push(
	encoded instanceof Uint8Array,
	encoded.length === 2 && encoded[0] === 79 && encoded[1] === 75,
	new TextDecoder().decode(encoded) === "OK",
);

const query = new URLSearchParams();
query.append("label", "first");
query.append("label", "second");
checks.push(query.toString() === "label=first&label=second");

const url = new URL("https://example.com/search?" + query);
const original = { imported: { type: "Identifier", name: "value" } };
const cloned = structuredClone(original);
checks.push(
	url.hostname === "example.com",
	url.searchParams.getAll("label").join(",") === "first,second",
	cloned !== original,
	cloned.imported !== original.imported,
	cloned.imported.type === "Identifier" && cloned.imported.name === "value",
	typeof fetch === "undefined",
	typeof Response === "undefined",
	typeof EventTarget === "undefined",
);

const passed = checks.filter(Boolean).length;
console.log(`RESULT ${passed}/${checks.length}`);
