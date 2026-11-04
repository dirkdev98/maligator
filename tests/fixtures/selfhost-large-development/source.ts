export function largeDevelopmentSource(): string {
	const functions = Array.from({ length: 4000 }, (_, index) => {
		const body = Array.from(
			{ length: 64 },
			(_, step) => `value = (value + ${step + 1}) ^ ${index + step};`,
		).join("\n");
		return `function operation${index}(value: number) {\n${body}\nreturn value;\n}`;
	});
	return [
		...functions,
		`const operations = [${functions.map((_, index) => `operation${index}`).join(",")}];`,
		"export const operationCount = operations.length;",
		"export function calculate(index: number) { return operations[index % operations.length]?.(1); }",
	].join("\n");
}
