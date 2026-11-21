// A host program that names no web or Node global. It links with the host entry but
// without the web globals, the ada C++ URL parser and `-lc++`; the core engine stays
// intact. `globalThis[name]` would count as naming every global, so the checks below
// read only the engine.
const results = [
	["core intact", [1, 2, 3].map((x) => x * 2).join(",") === "2,4,6"],
	["promises", typeof Promise.resolve === "function"],
	["json", JSON.stringify({ a: [1] }) === '{"a":[1]}'],
];

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
