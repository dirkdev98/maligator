if (false) await import("./dynamic-import-computed-target.mjs");

const target = import.meta.dirname + "/dynamic-import-computed-target.mjs";
const first = await import(target);
const second = await import(target);
let rejected = false;
try {
	await import(import.meta.dirname + "/missing-dynamic-module.mjs");
} catch (error) {
	rejected = error instanceof TypeError;
}

const passed =
	first.value === 42 &&
	second.value === 42 &&
	globalThis.dynamicImportInitCount === 1 &&
	rejected;
console.log(`RESULT ${passed ? 1 : 0}/1`);
