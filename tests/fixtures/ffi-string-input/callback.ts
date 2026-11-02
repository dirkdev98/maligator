/* oxlint-disable no-console -- The fixture reports observable C behavior. */
import { input_callback, input_length } from "maligator:ffi/input";

const text = new TextDecoder().decode(new Uint8Array(65535).fill(120));
if (input_length(text) !== 65535) throw new Error("initial string length");
let calls = 0;
const result = input_callback(text, () => {
	calls++;
	// oxlint-disable-next-line typescript/no-deprecated -- This wrapper forces the runtime's UTF16 bridge.
	if (text.bold().length !== 65542) throw new Error("callback widening");
});
if (calls !== 1 || result !== 65535) throw new Error("callback invalidated string input");
console.log("callback string inputs passed");
