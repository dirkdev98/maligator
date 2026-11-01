import * as c from "maligator:ffi/results";

let firstDone!: () => void;
const first = new Promise<void>((resolve) => {
	firstDone = resolve;
});
void c.result_cancel_async((index) => {
	if (index !== 0) throw new Error("cancelled callback entered JavaScript");
	firstDone();
	return "kept";
});
await first;
await new Promise<void>((resolve) => {
	setTimeout(resolve, 0);
});
c.result_cancel_wait_started();
throw new Error("pointer shutdown requested");
