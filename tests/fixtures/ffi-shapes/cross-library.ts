/* oxlint-disable no-console -- The fixture reports callback and pinning behavior. */
import { bridge_checksum } from "maligator:ffi/bridge";
import { shapes_set_error_handler } from "maligator:ffi/shapes";

const buffer = new ArrayBuffer(3);
new Uint8Array(buffer).set([1, 2, 3]);
let transferred: ArrayBuffer | undefined;
let status: string | undefined;
shapes_set_error_handler(() => {
	try {
		transferred = buffer.transfer();
		status = "allowed";
	} catch (error) {
		status = (error as Error).name;
	}
});
const sum = bridge_checksum(buffer);
shapes_set_error_handler(null);
console.log(
	`bridge pin ${sum} ${status} ${buffer.byteLength} ${transferred !== undefined}`,
);
console.log(`bridge released ${buffer.transfer().byteLength} ${buffer.byteLength}`);

shapes_set_error_handler(() => {
	throw new Error("bridge failed");
});
try {
	bridge_checksum(new Uint8Array([4, 5]));
} catch (error) {
	console.log(`bridge threw ${(error as Error).message}`);
}
shapes_set_error_handler(null);
