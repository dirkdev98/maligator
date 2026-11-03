/* oxlint-disable no-console -- The fixture reports the selected count getter. */
import { getRetainedCount } from "maligator:ffi/globals";
if (getRetainedCount() !== 3)
	throw new Error("count getter must work without pointer accessors");
console.log("retained count passed");
