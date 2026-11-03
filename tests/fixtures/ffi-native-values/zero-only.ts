/* oxlint-disable no-console -- The fixture checks a constructor-only import. */
import { NativeUnsigned } from "maligator:ffi/native_values";
const value = NativeUnsigned();
if (Object.prototype.toString.call(value) !== "[object NativeUnsigned]")
	throw new Error("native constructor export");
value[Symbol.dispose]();
console.log("native zero passed");
