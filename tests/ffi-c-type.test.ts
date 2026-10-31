import { describe, expect, it } from "vitest";
import { formatCDeclaration, parseCType, unnamedTagKey } from "../src/ffi/c-type.ts";

describe("C type spellings", () => {
	it("round-trips the declarator shapes clang prints", () => {
		for (const spelling of [
			"const char *",
			"const char *const *",
			"unsigned long long",
			"void (*)(void *, int)",
			"char *(*)(int)",
			"int (*)[4]",
			"float[16]",
			"struct Color",
			"Vector2",
			"long double",
			"void (int, const char *, ...)",
		]) {
			expect(formatCDeclaration(parseCType(spelling))).toBe(spelling);
		}
	});

	it("places declaration names inside nested declarators", () => {
		expect(formatCDeclaration(parseCType("void (*)(void *)"), "callback")).toBe(
			"void (*callback)(void *)",
		);
		expect(formatCDeclaration(parseCType("char[32]"), "name")).toBe("char name[32]");
		expect(formatCDeclaration(parseCType("const char *"), "title")).toBe(
			"const char *title",
		);
	});

	it("normalizes integer specifiers in any order", () => {
		expect(parseCType("long unsigned int")).toEqual({
			kind: "integer",
			name: "unsigned long",
		});
		expect(parseCType("signed char")).toEqual({ kind: "integer", name: "signed char" });
		expect(parseCType("unsigned")).toEqual({ kind: "integer", name: "unsigned int" });
	});

	it("keys unnamed tags by the location clang prints", () => {
		expect(parseCType("struct (unnamed struct at /usr/include/x (1).h:3:9)")).toEqual({
			kind: "record",
			tag: "struct",
			name: unnamedTagKey("/usr/include/x (1).h", 3, 9),
		});
	});

	it("records pointer nullability and keeps pointer constness", () => {
		expect(parseCType("const char * _Nonnull const")).toEqual({
			kind: "pointer",
			to: { kind: "integer", name: "char", const: true },
			const: true,
			nullability: "nonnull",
		});
	});

	it("reports constructs it cannot map instead of guessing", () => {
		for (const spelling of [
			"_Atomic(int)",
			"typeof (x)",
			"_BitInt(12)",
			"__attribute__((__vector_size__(4 * sizeof(float)))) float",
		]) {
			expect(parseCType(spelling)).toEqual({ kind: "unsupported", spelling });
		}
	});
});
