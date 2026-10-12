import util from "node:util";

const original = util.types;
let touched = false;
Object.defineProperty(util, "types", {
	get() {
		touched = true;
		throw new Error("unexpected read");
	},
});
const alias = process.getBuiltinModule("node:util/types");
console.log(
	JSON.stringify([alias === original, touched, alias.isTypedArray(new Uint8Array(1))]),
);
