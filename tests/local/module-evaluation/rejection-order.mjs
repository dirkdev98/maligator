globalThis.siblingFailure = { marker: "sibling rejection" };
let caught = false;
try {
	await import("./rejection-parent.mjs");
} catch (error) {
	caught = error === globalThis.siblingFailure;
}
if (!caught) throw new Error("dependency failure was not propagated");
console.log("RESULT 1/1");
