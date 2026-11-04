import * as c from "maligator:ffi/scalar";
export { early } from "./namespace-cycle-b.ts";

export function readEarly(): number {
	return c.scalar_i32(21);
}
