import { expect, it } from "vitest";
import { clangRecordLayouts } from "../src/ffi/record-layout.ts";

function dump(name: string, size = "64", alignment = "32", offsets = "0, 32"): string {
	return `*** Dumping AST Record Layout
Type: ${name}

Layout: <ASTRecordLayout
  Size:${size}
  DataSize:${size}
  Alignment:${alignment}
  FieldOffsets: [${offsets}]>
`;
}

it("retains a shared layout when scoped tags have identical layouts", () => {
	expect(
		clangRecordLayouts(dump("struct Shared") + dump("struct Shared")).get(
			"struct Shared",
		),
	).toEqual({
		sizeBits: 64,
		alignmentBits: 32,
		fieldOffsetsBits: [0, 32],
	});
});

it("keeps conflicting scoped tags ambiguous after later matching duplicates", () => {
	expect(
		clangRecordLayouts(
			dump("struct Shared") + dump("struct Shared", "128") + dump("struct Shared"),
		).get("struct Shared"),
	).toBeNull();
});

it("identifies nested anonymous records by their declaration location", () => {
	expect(
		clangRecordLayouts(dump("union Outer::(anonymous at /include/shape.h:4:9)")).has(
			"union (unnamed at /include/shape.h:4:9)",
		),
	).toBe(true);
});

it.each([
	["9007199254740992", "32", "0"],
	["64", "0", "0"],
	["64", "32", "65"],
])(
	"rejects an invalid layout size=%s alignment=%s offsets=%s",
	(size, alignment, offsets) => {
		expect(() =>
			clangRecordLayouts(dump("struct Invalid", size, alignment, offsets)),
		).toThrow("invalid C record layout");
	},
);

it("rejects an unrecognized Clang layout instead of accepting partial metadata", () => {
	expect(() =>
		clangRecordLayouts("*** Dumping AST Record Layout\nType: struct Invalid\n"),
	).toThrow("cannot decode");
});
