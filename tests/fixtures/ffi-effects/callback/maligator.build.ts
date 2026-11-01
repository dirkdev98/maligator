// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "main.ts",
	surface: { webPlatform: true },
	ffi: { callbacks: { contract: "callback.ffi.ts" } },
};
