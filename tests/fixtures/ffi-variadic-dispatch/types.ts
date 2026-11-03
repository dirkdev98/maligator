import { invoke } from "maligator:ffi/variadic_dispatch";
export function verifyVariadicTypes(request: Parameters<typeof invoke>) {
	invoke(...request);
	// @ts-expect-error -- Selectors must name one of the declared signatures.
	invoke("missing", 1);
	// @ts-expect-error -- Narrow numeric arguments belong to the selected signature.
	invoke("small", "wrong", 1, 0);
	// @ts-expect-error -- A 64-bit C integer uses BigInt.
	invoke("mixed", "text", 0.5, 1);
	// @ts-expect-error -- The array count is hidden by its contract.
	invoke("array", [1, 2], 2n);
	// @ts-expect-error -- An output-only signature takes no payload arguments.
	invoke("output", 1);
}
