import { createRequire } from "node:module";
const load = createRequire(import.meta.url);
const request = process.argv[2];
const first = load(request);
const canonical = request.startsWith("node:") ? request : "node:" + request;
const alias =
	request === "node:sqlite"
		? request
		: request.startsWith("node:")
			? request.slice(5)
			: canonical;
const rejected = ["sqlite", "test", "node:fixture-missing-builtin"].map((id) => {
	try {
		load(id);
		return false;
	} catch {
		return true;
	}
});
console.log(
	JSON.stringify([
		typeof first,
		first === load(request),
		first === load(alias),
		first === process.getBuiltinModule(canonical),
		rejected,
	]),
);
