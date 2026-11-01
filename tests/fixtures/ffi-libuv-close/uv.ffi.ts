import type { MaligatorLibraryContract } from "../../../src/public-api.d.ts";

// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	headers: ["uv.h"],
	find: [{ pkgConfig: "libuv" }],
	types: {
		uv_loop_t: { handle: { storage: "caller" } },
		uv_handle_t: { handle: {} },
		uv_timer_t: { handle: { storage: "caller", views: ["uv_handle_t"] } },
	},
	functions: {
		uv_timer_start: { params: { cb: { callback: { replaced: true } } } },
		uv_close: { params: { close_cb: { callback: { closes: "handle" } } } },
	},
} satisfies MaligatorLibraryContract;
