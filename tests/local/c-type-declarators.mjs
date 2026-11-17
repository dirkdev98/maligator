import { parseCType, formatCDeclaration } from "../../src/ffi/c-type.ts";

for (const spelling of [
	"int[2][3]",
	"int[][4]",
	"int[0]",
	"int (*[2])(char)",
	"int (*(*)(double))[3]",
	"void (*(*)(int (*)(const char *)))(double)",
	"char (*[4])(int, ...)",
]) {
	const type = parseCType(spelling);
	console.log(JSON.stringify({ type, declaration: formatCDeclaration(type, "value") }));
}
