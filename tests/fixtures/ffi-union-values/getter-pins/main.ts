/* oxlint-disable no-console -- The fixture reports its public FFI result. */
import { pins_new, pins_value, pins_array, pins_freed } from "maligator:ffi/pins";
const created = pins_new();
if (created === null) throw new Error("Missing native resource");
const owner = created;
function protect(): void {
	let refused = false;
	try {
		owner[Symbol.dispose]();
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		refused = true;
	}
	if (!refused) throw new Error("A union getter disposed a native argument");
}
if (
	pins_value(owner, {
		get amount() {
			protect();
			return 1;
		},
	}) !== 42
)
	throw new Error("Incorrect union record conversion");
const values: [number] = [2];
const array = new Proxy(values, {
	get(target, key): unknown {
		if (key === "0") protect();
		return Reflect.get(target, key);
	},
});
if (pins_array(owner, array) !== 44) throw new Error("Incorrect union array conversion");
if (pins_freed() !== 0) throw new Error("A resource was released during conversion");
owner[Symbol.dispose]();
if (pins_freed() !== 1) throw new Error("A resource pin escaped its call");
console.log("union getter pins passed");
