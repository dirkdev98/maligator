// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "main.ts",
	surface: { webPlatform: true },
	ffi: { fields: { contract: "fields.ffi.ts" } },
};
