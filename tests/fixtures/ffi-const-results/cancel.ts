import {
	callbackCancelAsync,
	immutable_callback_wait_started,
	a_make,
} from "maligator:ffi/const_values";
let ready!: () => void;
const first = new Promise<void>((resolve) => {
	ready = resolve;
});
void callbackCancelAsync((index) => {
	if (index !== 0) throw new Error("canceled const callback entered JavaScript");
	ready();
	return a_make(13);
});
await first;
immutable_callback_wait_started();
throw new Error("const shutdown requested");
