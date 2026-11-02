// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "main.ts",
	engine: { eval: false, realms: false },
	surface: { webPlatform: true, node: true, maligator: true },
	ffi: {
		thin: { contract: "thin.ffi.ts" },
		values: { contract: "values.ffi.ts" },
		work: { contract: "work.ffi.ts" },
	},
};
