// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "main.ts",
	surface: { node: true, webPlatform: true },
	ffi: { reentry: { contract: "reentry.ffi.ts" } },
};
