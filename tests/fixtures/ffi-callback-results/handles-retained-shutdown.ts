import * as c from "maligator:ffi/results";

const resource = c.result_resource_borrow(77)!;
await c.result_keep_resource_async(() => resource);
c.result_kept_resource_call(0);
c.result_resource_own(resource);
await c.result_keep_state_async(() => {
	const state = c.ResultState();
	state.bytes = new Uint8Array([5, 0, 7]);
	state.text = "Grü\0";
	return state;
});
c.result_kept_state_call(0);
c.result_keep_manual(() => c.result_manual_new()!);
c.result_kept_manual_call();
c.result_kept_handles_after_vm();
throw new Error("pointer shutdown requested");
