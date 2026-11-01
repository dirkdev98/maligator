import * as c from "maligator:ffi/results";

void c.result_handles_shutdown_async(
	() => c.result_resource_new(77)!,
	() => {
		const state = c.ResultState();
		state.bytes = new Uint8Array([5, 0, 7]);
		state.text = "Grü\0";
		setTimeout(() => {
			throw new Error("pointer shutdown requested");
		}, 0);
		return state;
	},
);
