import * as c from "maligator:ffi/close";
const state = c.CloseState();
state.bytes = new Uint8Array(73).fill(71);
c.close_after_vm(state, () => {
	throw new Error("detached completion ran JavaScript");
});
throw new Error("close shutdown requested");
