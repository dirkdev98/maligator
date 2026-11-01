import * as c from "maligator:ffi/close";
const state = c.close_reused_open()!;
c.close_reused_set(state, () => {
	throw new Error("detached keyed callback ran JavaScript");
});
c.close_reused_after_vm(state, () => {
	throw new Error("detached close ran JavaScript");
});
throw new Error("close shutdown requested");
