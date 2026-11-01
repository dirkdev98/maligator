/* oxlint-disable no-console -- The fixture reports observable native behavior. */
import * as uv from "maligator:ffi/uv";
function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
const loop = uv.uv_loop_t();
const timer = uv.uv_timer_t();
check(uv.uv_loop_init(loop) === 0, "libuv initializes caller loop storage");
check(uv.uv_timer_init(loop, timer) === 0, "libuv initializes caller timer storage");
let fired = false;
let closed = false;
check(
	uv.uv_timer_start(
		timer,
		(active) => {
			check(active === timer, "timer callbacks preserve canonical identity");
			fired = true;
			uv.uv_close(timer, (completed) => {
				check(completed === timer, "close callbacks preserve identity across base views");
				timer[Symbol.dispose]();
				closed = true;
			});
		},
		0n,
		0n,
	) === 0,
	"libuv starts a timer",
);
check(uv.uv_run(loop, uv.UV_RUN_DEFAULT) === 0, "libuv drains timer and close callbacks");
check(fired && closed, "libuv completes asynchronous timer destruction");
check(uv.uv_loop_close(loop) === 0, "libuv releases loop resources");
loop[Symbol.dispose]();
console.log("libuv close passed");
