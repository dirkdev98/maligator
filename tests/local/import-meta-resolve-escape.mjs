const meta = import.meta;

export function escaped() {
	return JSON.stringify([
		Object.keys(meta),
		meta
			.resolve("./node-import-meta-resolve.mjs")
			.endsWith("/node-import-meta-resolve.mjs"),
		meta.resolve("node:fs"),
	]);
}
