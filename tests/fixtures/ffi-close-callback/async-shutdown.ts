import * as c from "maligator:ffi/close";

c.close_expect_worker();
const queued = process.argv[2] === "queued";
if (queued) {
	for (let index = 0; index < 64; index++) void c.close_block_async();
	c.close_wait_blocked();
}
const state = c.CloseState();
state.bytes = new Uint8Array(73).fill(71);
void c.close_worker_after_vm_async(state, () => {
	throw new Error("detached completion ran JavaScript");
});
if (!queued) c.close_worker_wait_started();
c.close_unblock_later();
throw new Error("close shutdown requested");
