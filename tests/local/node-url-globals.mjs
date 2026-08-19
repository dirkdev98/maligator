const checks = [];

const query = new URLSearchParams();
query.append("label", "first");
query.append("label", "second");
checks.push(query.toString() === "label=first&label=second");

const url = new URL("https://example.com/search?" + query);
checks.push(
	url.hostname === "example.com",
	url.searchParams.getAll("label").join(",") === "first,second",
	typeof fetch === "undefined",
	typeof Response === "undefined",
	typeof EventTarget === "undefined",
);

const passed = checks.filter(Boolean).length;
console.log(`RESULT ${passed}/${checks.length}`);
