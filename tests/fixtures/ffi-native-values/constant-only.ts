/* oxlint-disable no-console -- The fixture checks native constant-only imports. */
import { NATIVE_MAX, NATIVE_ONE } from "maligator:ffi/native_values";
if (
	Object.prototype.toString.call(NATIVE_MAX) !== "[object NativeUnsigned]" ||
	Object.prototype.toString.call(NATIVE_ONE) !== "[object NativeExtended]"
)
	throw new Error("native constant exports");
NATIVE_MAX[Symbol.dispose]();
NATIVE_ONE[Symbol.dispose]();
console.log("native constants passed");
