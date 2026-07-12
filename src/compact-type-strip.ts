/**
 * A deliberately small, blank-in-place TypeScript stripper for the native
 * front-end bootstrap. It accepts only the syntax needed by the first fixture
 * slice and throws for constructs that would require TypeScript transforms or
 * ambiguous parsing.
 */
export function stripCompactTypes(source: string, filePath = "<typescript>"): string {
	const code = lexicalCodeMask(source, filePath);
	const output = source.split("");
	const words = scanWords(source, code);

	rejectUnsupported(source, code, words, filePath);
	blankTopLevelTypeDeclarations(source, code, output, words, filePath);
	blankVariableAnnotations(source, code, output, words, filePath);
	blankFunctionAnnotations(source, code, output, words, filePath);

	return output.join("");
}

interface Word {
	text: string;
	start: number;
	end: number;
}

function fail(filePath: string, offset: number, syntax: string): never {
	throw new SyntaxError(
		`Compact TypeScript stripper does not support ${syntax} in ${filePath} at offset ${offset}`,
	);
}

function isIdentifierStart(char: string | undefined): boolean {
	return (
		char !== undefined &&
		((char >= "a" && char <= "z") ||
			(char >= "A" && char <= "Z") ||
			char === "_" ||
			char === "$")
	);
}

function isIdentifierPart(char: string | undefined): boolean {
	return isIdentifierStart(char) || (char !== undefined && char >= "0" && char <= "9");
}

function lexicalCodeMask(source: string, filePath: string): Array<boolean> {
	const code = new Array<boolean>(source.length).fill(true);
	let i = 0;
	while (i < source.length) {
		const char = source[i]!;
		const next = source[i + 1];
		if (char === "/" && next === "/") {
			code[i++] = false;
			code[i++] = false;
			while (i < source.length && source[i] !== "\n") code[i++] = false;
			continue;
		}
		if (char === "/" && next === "*") {
			const start = i;
			code[i++] = false;
			code[i++] = false;
			while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
				code[i++] = false;
			}
			if (i >= source.length) fail(filePath, start, "unterminated block comments");
			code[i++] = false;
			code[i++] = false;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			const quote = char;
			const start = i;
			code[i++] = false;
			let closed = false;
			while (i < source.length) {
				code[i] = false;
				if (source[i] === "\\") {
					i++;
					if (i < source.length) code[i++] = false;
					continue;
				}
				if (source[i++] === quote) {
					closed = true;
					break;
				}
			}
			if (!closed)
				fail(filePath, start, `unterminated ${quote === "`" ? "templates" : "strings"}`);
			continue;
		}
		i++;
	}
	return code;
}

function scanWords(source: string, code: Array<boolean>): Array<Word> {
	const words: Array<Word> = [];
	let i = 0;
	while (i < source.length) {
		if (!code[i] || !isIdentifierStart(source[i])) {
			i++;
			continue;
		}
		const start = i++;
		while (i < source.length && code[i] && isIdentifierPart(source[i])) i++;
		words.push({ text: source.slice(start, i), start, end: i });
	}
	return words;
}

function rejectUnsupported(
	source: string,
	code: Array<boolean>,
	words: Array<Word>,
	filePath: string,
): void {
	const alwaysRejected: Record<string, string> = {
		enum: "enums",
		namespace: "namespaces",
		module: "namespace declarations",
		satisfies: "satisfies expressions",
		declare: "declare syntax",
		abstract: "abstract syntax",
		implements: "class implements clauses",
		public: "class parameter properties",
		private: "class parameter properties",
		protected: "class parameter properties",
		readonly: "readonly class syntax",
	};
	for (let wi = 0; wi < words.length; wi++) {
		const word = words[wi]!;
		const description = alwaysRejected[word.text];
		if (description) fail(filePath, word.start, description);
		if (word.text === "function") {
			const name = words[wi + 1];
			if (name && source[nextCodeIndex(source, code, name.end)] === "<") {
				fail(filePath, name.end, "generic functions");
			}
		}
		if (word.text === "class") {
			const name = words[wi + 1];
			if (name && source[nextCodeIndex(source, code, name.end)] === "<") {
				fail(filePath, name.end, "generic classes");
			}
			const open = findCodeChar(source, code, "{", word.end);
			if (open >= 0) {
				const close = matching(source, code, open, "{", "}", filePath);
				for (let i = open + 1; i < close; i++) {
					if (code[i] && source[i] === ":") {
						fail(filePath, i, "class TypeScript syntax");
					}
				}
			}
		}
		if (word.text === "as" && !insideImportOrExportStatement(source, code, words, wi)) {
			fail(filePath, word.start, "type assertions");
		}
		if (word.text === "interface" || word.text === "type") {
			const next = nextCodeIndex(source, code, word.end);
			const name = wordAt(source, code, next);
			if (name && source[nextCodeIndex(source, code, name.end)] === "<") {
				fail(filePath, word.start, "generic declarations");
			}
		}
	}

	for (let i = 0; i < source.length; i++) {
		if (!code[i]) continue;
		if (source[i] === "@") fail(filePath, i, "decorators");
		if (source[i] === "?" && source[nextCodeIndex(source, code, i + 1)] === ":") {
			fail(filePath, i, "optional parameters or properties");
		}
		if (source[i] === "!" && source[i + 1] !== "=" && source[i - 1] !== "!") {
			const next = source[nextCodeIndex(source, code, i + 1)];
			if (next === "." || next === "," || next === ";" || next === ")" || next === "]") {
				fail(filePath, i, "non-null assertions");
			}
		}
	}
}

function insideImportOrExportStatement(
	source: string,
	code: Array<boolean>,
	words: Array<Word>,
	wordIndex: number,
): boolean {
	const position = words[wordIndex]!.start;
	let statementStart = 0;
	for (let i = position - 1; i >= 0; i--) {
		if (code[i] && (source[i] === ";" || source[i] === "}")) {
			statementStart = i + 1;
			break;
		}
	}
	for (let i = wordIndex - 1; i >= 0 && words[i]!.start >= statementStart; i--) {
		if (words[i]!.text === "import" || words[i]!.text === "export") return true;
	}
	return false;
}

function blankTopLevelTypeDeclarations(
	source: string,
	code: Array<boolean>,
	output: Array<string>,
	words: Array<Word>,
	filePath: string,
): void {
	let depth = 0;
	for (let wi = 0; wi < words.length; wi++) {
		const word = words[wi]!;
		for (let i = wi === 0 ? 0 : words[wi - 1]!.end; i < word.start; i++) {
			if (!code[i]) continue;
			if (source[i] === "{" || source[i] === "(" || source[i] === "[") depth++;
			if (source[i] === "}" || source[i] === ")" || source[i] === "]") depth--;
		}
		if (depth !== 0) continue;

		const start = word.start;
		const next = words[wi + 1];
		if (
			word.text === "import" &&
			next?.text === "type" &&
			nextCodeIndex(source, code, word.end) === next.start
		) {
			const afterType = nextCodeIndex(source, code, next.end);
			if (source[afterType] === "{") {
				const close = matching(source, code, afterType, "{", "}", filePath);
				validateNamedTypeSpecifiers(source, code, afterType, close, filePath);
				const from = wordAt(source, code, nextCodeIndex(source, code, close + 1));
				if (from?.text !== "from") {
					fail(filePath, word.start, "import type declarations without 'from'");
				}
				const end = moduleSpecifierStatementEnd(source, code, from.end, filePath);
				blank(output, source, start, end);
				continue;
			}
			const afterTypeWord = wordAt(source, code, afterType);
			if (afterTypeWord?.text !== "from") {
				fail(filePath, word.start, "non-braced import type declarations");
			}
			// `import type from "..."` is an ordinary default import whose binding is
			// named `type`; it must reach the JavaScript parser unchanged.
			continue;
		}

		if (
			word.text === "export" &&
			next?.text === "type" &&
			nextCodeIndex(source, code, word.end) === next.start
		) {
			const afterType = nextCodeIndex(source, code, next.end);
			if (source[afterType] === "{") {
				const close = matching(source, code, afterType, "{", "}", filePath);
				validateNamedTypeSpecifiers(source, code, afterType, close, filePath);
				const afterClose = nextCodeIndex(source, code, close + 1);
				let end: number;
				if (source[afterClose] === ";") {
					end = afterClose + 1;
				} else {
					const from = wordAt(source, code, afterClose);
					if (from?.text !== "from") {
						fail(filePath, word.start, "malformed export type declarations");
					}
					end = moduleSpecifierStatementEnd(source, code, from.end, filePath);
				}
				blank(output, source, start, end);
				continue;
			}
			const name = wordAt(source, code, afterType);
			if (name && source[nextCodeIndex(source, code, name.end)] === "=") {
				blank(output, source, start, findStatementEnd(source, code, name.end, filePath));
				continue;
			}
			fail(filePath, word.start, "malformed export type declarations");
		}
		if (
			word.text === "export" &&
			next?.text === "interface" &&
			nextCodeIndex(source, code, word.end) === next.start
		) {
			const name = wordAt(source, code, nextCodeIndex(source, code, next.end));
			if (!name) fail(filePath, word.start, "malformed interface declarations");
			const open = nextCodeIndex(source, code, name.end);
			if (source[open] !== "{") {
				fail(filePath, word.start, "malformed interface declarations");
			}
			const close = matching(source, code, open, "{", "}", filePath);
			const semicolon = nextCodeIndex(source, code, close + 1);
			blank(output, source, start, source[semicolon] === ";" ? semicolon + 1 : close + 1);
			continue;
		}

		if (word.text === "type") {
			const name = wordAt(source, code, nextCodeIndex(source, code, word.end));
			if (name && source[nextCodeIndex(source, code, name.end)] === "=") {
				blank(output, source, start, findStatementEnd(source, code, name.end, filePath));
			}
			continue;
		}
		if (word.text === "interface") {
			const name = wordAt(source, code, nextCodeIndex(source, code, word.end));
			if (!name) continue;
			const open = nextCodeIndex(source, code, name.end);
			if (source[open] !== "{") continue;
			const close = matching(source, code, open, "{", "}", filePath);
			const semicolon = nextCodeIndex(source, code, close + 1);
			blank(output, source, start, source[semicolon] === ";" ? semicolon + 1 : close + 1);
		}
	}
}

function wordAt(source: string, code: Array<boolean>, start: number): Word | undefined {
	if (!code[start] || !isIdentifierStart(source[start])) return undefined;
	let end = start + 1;
	while (end < source.length && code[end] && isIdentifierPart(source[end])) end++;
	return { text: source.slice(start, end), start, end };
}

function validateNamedTypeSpecifiers(
	source: string,
	code: Array<boolean>,
	open: number,
	close: number,
	filePath: string,
): void {
	let i = nextCodeIndex(source, code, open + 1);
	let expectName = true;
	let sawAlias = false;
	while (i < close) {
		if (expectName) {
			const name = wordAt(source, code, i);
			if (!name) fail(filePath, i, "malformed named type specifiers");
			i = nextCodeIndex(source, code, name.end);
			expectName = false;
			continue;
		}
		if (source[i] === ",") {
			i = nextCodeIndex(source, code, i + 1);
			expectName = true;
			sawAlias = false;
			continue;
		}
		const asWord = wordAt(source, code, i);
		if (asWord?.text === "as" && !sawAlias) {
			const alias = wordAt(source, code, nextCodeIndex(source, code, asWord.end));
			if (!alias) fail(filePath, i, "malformed named type specifiers");
			i = nextCodeIndex(source, code, alias.end);
			sawAlias = true;
			continue;
		}
		fail(filePath, i, "malformed named type specifiers");
	}
	if (expectName && i !== nextCodeIndex(source, code, open + 1)) {
		// A trailing comma is valid; an empty list is also valid.
		return;
	}
}

function moduleSpecifierStatementEnd(
	source: string,
	code: Array<boolean>,
	start: number,
	filePath: string,
): number {
	const specifier = nextSyntaxIndex(source, code, start);
	const quote = source[specifier];
	if (quote !== '"' && quote !== "'") {
		fail(filePath, start, "type declarations without a string specifier");
	}
	let end = specifier + 1;
	while (end < source.length) {
		if (source[end] === "\\") end++;
		else if (source[end] === quote) break;
		end++;
	}
	const semicolon = nextCodeIndex(source, code, end + 1);
	if (source[semicolon] !== ";") {
		fail(filePath, start, "type declarations without a terminating semicolon");
	}
	return semicolon + 1;
}

function blankVariableAnnotations(
	source: string,
	code: Array<boolean>,
	output: Array<string>,
	words: Array<Word>,
	filePath: string,
): void {
	for (const word of words) {
		if (word.text !== "const" && word.text !== "let" && word.text !== "var") continue;
		let i = word.end;
		let nested = 0;
		let initialized = false;
		while (i < source.length) {
			if (!code[i]) {
				i++;
				continue;
			}
			const char = source[i]!;
			if (nested === 0 && char === ";") break;
			if (char === "(" || char === "[" || char === "{") nested++;
			if (char === ")" || char === "]" || char === "}") nested--;
			if (nested === 0 && char === "=") initialized = true;
			if (nested === 0 && char === ",") initialized = false;
			if (nested === 0 && char === ":" && !initialized) {
				const end = findTypeEnd(source, code, i + 1, ["=", ",", ";"], filePath);
				blank(output, source, i, end);
				i = end;
				continue;
			}
			i++;
		}
	}
}

function blankFunctionAnnotations(
	source: string,
	code: Array<boolean>,
	output: Array<string>,
	words: Array<Word>,
	filePath: string,
): void {
	for (const word of words) {
		if (word.text !== "function") continue;
		const open = findCodeChar(source, code, "(", word.end);
		if (open < 0) fail(filePath, word.start, "generic or malformed functions");
		const close = matching(source, code, open, "(", ")", filePath);
		let nested = 0;
		for (let i = open + 1; i < close; i++) {
			if (!code[i]) continue;
			const char = source[i]!;
			if (char === "(" || char === "[") nested++;
			if (char === ")" || char === "]") nested--;
			if (nested === 0 && char === ":") {
				const end = findTypeEnd(source, code, i + 1, [",", ")", "="], filePath);
				blank(output, source, i, end);
				i = end - 1;
			}
		}
		const after = nextCodeIndex(source, code, close + 1);
		if (source[after] === ":") {
			const end = findTypeEnd(source, code, after + 1, ["{"], filePath);
			blank(output, source, after, end);
		}
	}
}

function findTypeEnd(
	source: string,
	code: Array<boolean>,
	start: number,
	delimiters: Array<string>,
	filePath: string,
): number {
	let sawType = false;
	for (let i = start; i < source.length; i++) {
		if (!code[i]) continue;
		const char = source[i]!;
		if (delimiters.includes(char)) {
			if (!sawType) fail(filePath, start, "empty type annotations");
			return i;
		}
		if (char === "<" || char === ">") fail(filePath, i, "generic types");
		if (char === "{" || char === "[" || char === "(" || char === "|") {
			fail(filePath, i, "compound type annotations");
		}
		if (isIdentifierStart(char)) sawType = true;
	}
	fail(filePath, start, "unterminated type annotations");
}

function blank(output: Array<string>, source: string, start: number, end: number): void {
	for (let i = start; i < end; i++) {
		if (source[i] !== "\n" && source[i] !== "\r") output[i] = " ";
	}
}

function nextCodeIndex(source: string, code: Array<boolean>, start: number): number {
	let i = start;
	while (
		i < source.length &&
		(!code[i] ||
			source[i] === " " ||
			source[i] === "\t" ||
			source[i] === "\n" ||
			source[i] === "\r")
	)
		i++;
	return i;
}

function nextSyntaxIndex(source: string, code: Array<boolean>, start: number): number {
	let i = start;
	while (i < source.length) {
		const char = source[i];
		if (char === " " || char === "\t" || char === "\n" || char === "\r") {
			i++;
			continue;
		}
		if (char === '"' || char === "'" || code[i]) return i;
		while (i < source.length && !code[i]) i++;
	}
	return i;
}

function findCodeChar(
	source: string,
	code: Array<boolean>,
	char: string,
	start: number,
): number {
	for (let i = start; i < source.length; i++) if (code[i] && source[i] === char) return i;
	return -1;
}

function findStatementEnd(
	source: string,
	code: Array<boolean>,
	start: number,
	filePath: string,
): number {
	const end = findCodeChar(source, code, ";", start);
	if (end < 0) fail(filePath, start, "semicolon-less type declarations");
	return end + 1;
}

function matching(
	source: string,
	code: Array<boolean>,
	start: number,
	open: string,
	close: string,
	filePath: string,
): number {
	let depth = 0;
	for (let i = start; i < source.length; i++) {
		if (!code[i]) continue;
		if (source[i] === open) depth++;
		if (source[i] === close && --depth === 0) return i;
	}
	fail(filePath, start, `unbalanced '${open}' syntax`);
}
