// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "main.ts",
	surface: { webPlatform: true },
	ffi: { uv: { contract: "uv.ffi.ts", link: "shared" } },
};
