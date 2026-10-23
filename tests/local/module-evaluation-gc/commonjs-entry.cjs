globalThis.moduleGcStages = [];
const { probe } = require("./commonjs-probe.cjs");

probe("cjs-entry");
const child = require("./commonjs-child.cjs");
probe("cjs-after-child");
if (child.value !== 45) throw new Error("required exports did not survive collection");
if (globalThis.moduleGcStages.join(",") !== "cjs-entry,cjs-child,cjs-after-child")
	throw new Error(`unexpected evaluation order: ${globalThis.moduleGcStages}`);
globalThis.moduleGcFinished = true;
