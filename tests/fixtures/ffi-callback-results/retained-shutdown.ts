import * as c from "maligator:ffi/results";

await c.result_retain_async((index) => (index === 0 ? "late-first" : "late-second"));
c.result_retained_call(0);
c.result_retained_call(1);
await c.result_retain_bytes_async((index) =>
	index === 0 ? new Uint8Array([5, 0, 7]) : new Uint8Array([9]),
);
c.result_retained_bytes_call(0);
c.result_retained_bytes_call(1);
c.result_retained_after_vm();
throw new Error("pointer shutdown requested");
