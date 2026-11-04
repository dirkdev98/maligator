// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	entry: "main.ts",
	surface: { webPlatform: true, node: true },
	ffi: { lifetime: { contract: "lifetime.ffi.ts" }, plain: { contract: "plain.ffi.ts" } },
};
