export interface Test262CorpusComposition {
	revision: string;
	tree: string;
	base: { repository: string; revision: string };
	generated: { repository: string; revision: string };
	overlays: Array<{ source: string; target: string; tree: string }>;
	epoch: number;
	message: string;
}

// The Test262 Unicode 18 casing update retains Unicode 17 property expectations.
// Overlay the matching upstream generator output while preserving historical tests.
export const UNICODE18_CORPUS: Test262CorpusComposition = {
	revision: "225d9c898829cd4e88a38c3605c05eba2d3730b6",
	tree: "f79e2179f88d43e02f266805994fef8ad5f88138",
	base: {
		repository: "https://github.com/tc39/test262",
		revision: "7a5918564666f0911ce790b77c9d692a848f27cd",
	},
	generated: {
		repository: "https://github.com/mathiasbynens/unicode-property-escapes-tests",
		revision: "ce3f614ae7976518fd14195071513286b64b0747",
	},
	overlays: [
		{
			source: "output/property-escapes/generated",
			target: "test/built-ins/RegExp/property-escapes/generated",
			tree: "953ad02d89eb0c18fb48eaf983b2cd3b0d541ede",
		},
		{
			source: "output/unicodeSets/generated",
			target: "test/built-ins/RegExp/unicodeSets/generated",
			tree: "585ec9826644aea5c372494af86d1db5d84f578a",
		},
	],
	epoch: 1793720821,
	message: "test: compose Unicode 18 RegExp conformance data",
};
