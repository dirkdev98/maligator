/**
 * A blank-in-place TypeScript stripper for the native front-end bootstrap.
 *
 * This follows Node's strip-only contract: syntax whose types can be erased
 * without changing runtime behavior is accepted, while constructs that require
 * JavaScript generation are rejected. Keeping this implementation independent
 * of the TypeScript compiler avoids carrying a multi-megabyte parser in every
 * native product.
 */
export function stripCompactTypes(source: string, filePath = "<typescript>"): string {
	const code = lexicalCodeMask(source, filePath);
	const output = source.split("");
	const words = scanWords(source, code);

	blankAmbientDeclarations(source, code, output, words, filePath);
	blankTypeOnlyNamespaces(source, code, output, words, filePath);
	rejectUnsupported(source, code, words, filePath);
	blankTopLevelTypeDeclarations(source, code, output, words, filePath);
	blankInlineTypeSpecifiers(source, code, output, words, filePath);
	blankClassSyntax(source, code, output, words, filePath);
	blankGenericSyntax(source, code, output, words, filePath);
	blankVariableAnnotations(source, code, output, words, filePath);
	blankFunctionAnnotations(source, code, output, words, filePath);
	blankArrowAnnotations(source, code, output, filePath);
	blankTypeAssertions(source, code, output, words, filePath);
	blankNonNullAssertions(source, code, output);

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
	const regexPrefixWords = new Set([
		"await",
		"case",
		"delete",
		"do",
		"else",
		"in",
		"instanceof",
		"new",
		"of",
		"return",
		"throw",
		"typeof",
		"void",
		"yield",
	]);
	const markComment = (start: number): number => {
		let i = start;
		code[i++] = false;
		code[i++] = false;
		if (source[start + 1] === "/") {
			while (i < source.length && source[i] !== "\n") code[i++] = false;
			return i;
		}
		while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
			code[i++] = false;
		}
		if (i >= source.length) fail(filePath, start, "unterminated block comments");
		code[i++] = false;
		code[i++] = false;
		return i;
	};
	const markQuoted = (start: number): number => {
		const quote = source[start]!;
		let i = start;
		code[i++] = false;
		while (i < source.length) {
			code[i] = false;
			if (source[i] === "\\") {
				i++;
				if (i < source.length) code[i++] = false;
				continue;
			}
			if (source[i++] === quote) return i;
		}
		fail(filePath, start, "unterminated strings");
	};
	const canStartRegex = (position: number): boolean => {
		let rawPrevious = position - 1;
		while (
			rawPrevious >= 0 &&
			(source[rawPrevious] === " " ||
				source[rawPrevious] === "\t" ||
				source[rawPrevious] === "\n" ||
				source[rawPrevious] === "\r")
		)
			rawPrevious--;
		if (
			rawPrevious >= 0 &&
			!code[rawPrevious] &&
			(source[rawPrevious] === '"' ||
				source[rawPrevious] === "'" ||
				source[rawPrevious] === "`")
		)
			return false;
		const previous = previousCodeIndex(source, code, position - 1);
		if (previous < 0) return true;
		if ("([{=,:;!?&|+-*%^~<>".includes(source[previous]!)) return true;
		const previousWord = wordAtPreviousCode(source, code, position);
		return previousWord !== undefined && regexPrefixWords.has(previousWord.text);
	};
	const markRegex = (start: number): number => {
		let i = start;
		let inClass = false;
		code[i++] = false;
		while (i < source.length) {
			code[i] = false;
			if (source[i] === "\\") {
				i++;
				if (i < source.length) code[i++] = false;
				continue;
			}
			if (source[i] === "[") inClass = true;
			else if (source[i] === "]") inClass = false;
			else if (source[i] === "/" && !inClass) {
				i++;
				while (i < source.length && isIdentifierPart(source[i])) code[i++] = false;
				return i;
			}
			if (source[i] === "\n" || source[i] === "\r")
				fail(filePath, start, "unterminated regular expressions");
			i++;
		}
		fail(filePath, start, "unterminated regular expressions");
	};
	const markTemplateExpression = (start: number): number => {
		let depth = 1;
		let i = start;
		while (i < source.length) {
			const char = source[i]!;
			const next = source[i + 1];
			if (char === "/" && (next === "/" || next === "*")) {
				i = markComment(i);
				continue;
			}
			if (char === "/" && canStartRegex(i)) {
				i = markRegex(i);
				continue;
			}
			if (char === '"' || char === "'") {
				i = markQuoted(i);
				continue;
			}
			if (char === "`") {
				i = markTemplate(i);
				continue;
			}
			if (char === "{") depth++;
			else if (char === "}" && --depth === 0) return i + 1;
			i++;
		}
		fail(filePath, start, "unterminated template expressions");
	};
	function markTemplate(start: number): number {
		let i = start;
		code[i++] = false;
		while (i < source.length) {
			code[i] = false;
			if (source[i] === "\\") {
				i++;
				if (i < source.length) code[i++] = false;
				continue;
			}
			if (source[i] === "`") {
				code[i] = false;
				return i + 1;
			}
			if (source[i] === "$" && source[i + 1] === "{") {
				code[i++] = true;
				code[i++] = true;
				i = markTemplateExpression(i);
				continue;
			}
			i++;
		}
		fail(filePath, start, "unterminated templates");
	}
	let i = 0;
	while (i < source.length) {
		const char = source[i]!;
		const next = source[i + 1];
		if (char === "/" && (next === "/" || next === "*")) {
			i = markComment(i);
		} else if (char === "/" && canStartRegex(i)) {
			i = markRegex(i);
		} else if (char === '"' || char === "'") {
			i = markQuoted(i);
		} else if (char === "`") {
			i = markTemplate(i);
		} else {
			i++;
		}
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
	for (let wi = 0; wi < words.length; wi++) {
		const word = words[wi]!;
		if (word.text === "enum" && isDeclarationPosition(source, code, word.start)) {
			const name = wordAt(source, code, nextCodeIndex(source, code, word.end));
			if (name && source[nextCodeIndex(source, code, name.end)] === "{") {
				fail(filePath, word.start, "enums");
			}
		}
		if (word.text === "import") {
			const binding = words[wi + 1];
			if (binding && source[nextCodeIndex(source, code, binding.end)] === "=") {
				fail(filePath, word.start, "import aliases");
			}
		}
		if (word.text === "export" && source[nextCodeIndex(source, code, word.end)] === "=") {
			fail(filePath, word.start, "export assignments");
		}
	}

	for (let i = 0; i < source.length; i++) {
		if (!code[i]) continue;
		if (source[i] === "@") fail(filePath, i, "decorators");
		if (source[i] === "?" && source[nextCodeIndex(source, code, i + 1)] === ":") continue;
	}
	rejectParameterProperties(source, code, words, filePath);
}

function blankAmbientDeclarations(
	source: string,
	code: Array<boolean>,
	output: Array<string>,
	words: Array<Word>,
	filePath: string,
): void {
	for (let wi = 0; wi < words.length; wi++) {
		const word = words[wi]!;
		if (word.text !== "declare" || !isDeclarationPosition(source, code, word.start))
			continue;
		const declaration = words[wi + 1];
		if (!declaration) fail(filePath, word.start, "malformed declare syntax");
		if (
			declaration.text === "class" ||
			declaration.text === "namespace" ||
			declaration.text === "module" ||
			declaration.text === "global"
		) {
			const open = findCodeChar(source, code, "{", declaration.end);
			if (open < 0) fail(filePath, word.start, "malformed ambient declarations");
			const close = matching(source, code, open, "{", "}", filePath);
			const semicolon = nextCodeIndex(source, code, close + 1);
			blank(
				output,
				source,
				declarationStart(source, code, word),
				source[semicolon] === ";" ? semicolon + 1 : close + 1,
			);
			continue;
		}
		blank(
			output,
			source,
			declarationStart(source, code, word),
			findStatementEnd(source, code, word.end, filePath),
		);
	}
}

function blankTypeOnlyNamespaces(
	source: string,
	code: Array<boolean>,
	output: Array<string>,
	words: Array<Word>,
	filePath: string,
): void {
	for (const word of words) {
		if (
			(word.text !== "namespace" && word.text !== "module") ||
			!isDeclarationPosition(source, code, word.start)
		)
			continue;
		const previous = wordAtPreviousCode(source, code, word.start);
		if (previous?.text === "declare") continue;
		const open = findCodeChar(source, code, "{", word.end);
		if (open < 0) fail(filePath, word.start, "malformed namespace declarations");
		const close = matching(source, code, open, "{", "}", filePath);
		const body = source.slice(open + 1, close);
		const strippedBody = stripCompactTypes(body, filePath);
		if (!onlyTriviaAndSemicolons(strippedBody)) {
			fail(filePath, word.start, "namespaces with runtime code");
		}
		const semicolon = nextCodeIndex(source, code, close + 1);
		blank(
			output,
			source,
			declarationStart(source, code, word),
			source[semicolon] === ";" ? semicolon + 1 : close + 1,
		);
	}
}

function declarationStart(source: string, code: Array<boolean>, word: Word): number {
	const previous = wordAtPreviousCode(source, code, word.start);
	return previous?.text === "export" ? previous.start : word.start;
}

function onlyTriviaAndSemicolons(source: string): boolean {
	for (let i = 0; i < source.length; i++) {
		const char = source[i]!;
		if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r" && char !== ";") {
			if (char === "/" && source[i + 1] === "/") {
				i += 2;
				while (i < source.length && source[i] !== "\n") i++;
				continue;
			}
			if (char === "/" && source[i + 1] === "*") {
				i += 2;
				while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
				i++;
				continue;
			}
			return false;
		}
	}
	return true;
}

function isDeclarationPosition(
	source: string,
	code: Array<boolean>,
	position: number,
): boolean {
	const previous = previousCodeIndex(source, code, position - 1);
	if (previous < 0) return true;
	if (source[previous] === ";" || source[previous] === "{" || source[previous] === "}")
		return true;
	const previousWord = wordAtPreviousCode(source, code, position);
	return previousWord?.text === "export" || previousWord?.text === "declare";
}

function rejectParameterProperties(
	source: string,
	code: Array<boolean>,
	words: Array<Word>,
	filePath: string,
): void {
	const modifiers = new Set(["public", "private", "protected", "readonly", "override"]);
	for (const word of words) {
		if (word.text !== "constructor") continue;
		const open = nextCodeIndex(source, code, word.end);
		if (source[open] !== "(") continue;
		const close = matching(source, code, open, "(", ")", filePath);
		for (const candidate of words) {
			if (
				candidate.start > open &&
				candidate.end < close &&
				modifiers.has(candidate.text)
			) {
				fail(filePath, candidate.start, "class parameter properties");
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
			const equals = name ? findCodeChar(source, code, "=", name.end) : -1;
			if (name && equals >= 0 && !hasStatementBoundary(source, code, name.end, equals)) {
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
			const open = findCodeChar(source, code, "{", name.end);
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
			const equals = name ? findCodeChar(source, code, "=", name.end) : -1;
			if (name && equals >= 0 && !hasStatementBoundary(source, code, name.end, equals)) {
				blank(output, source, start, findStatementEnd(source, code, name.end, filePath));
			}
			continue;
		}
		if (word.text === "interface") {
			const name = wordAt(source, code, nextCodeIndex(source, code, word.end));
			if (!name) continue;
			const open = findCodeChar(source, code, "{", name.end);
			if (source[open] !== "{") continue;
			const close = matching(source, code, open, "{", "}", filePath);
			const semicolon = nextCodeIndex(source, code, close + 1);
			blank(output, source, start, source[semicolon] === ";" ? semicolon + 1 : close + 1);
		}
	}
}

function hasStatementBoundary(
	source: string,
	code: Array<boolean>,
	start: number,
	end: number,
): boolean {
	for (let i = start; i < end; i++) {
		if (code[i] && (source[i] === ";" || source[i] === "{" || source[i] === "}"))
			return true;
	}
	return false;
}

function blankInlineTypeSpecifiers(
	source: string,
	code: Array<boolean>,
	output: Array<string>,
	words: Array<Word>,
	filePath: string,
): void {
	for (let wi = 0; wi < words.length; wi++) {
		const word = words[wi]!;
		if (word.text !== "import" && word.text !== "export") continue;
		const open = nextCodeIndex(source, code, word.end);
		if (source[open] !== "{") continue;
		const close = matching(source, code, open, "{", "}", filePath);
		let i = nextCodeIndex(source, code, open + 1);
		while (i < close) {
			const specifier = wordAt(source, code, i);
			if (!specifier) fail(filePath, i, "malformed named import or export specifiers");
			if (specifier.text === "type") {
				let end = nextCodeIndex(source, code, specifier.end);
				const imported = wordAt(source, code, end);
				if (!imported) {
					if (source[end] === "," || source[end] === "}") {
						i = source[end] === "," ? nextCodeIndex(source, code, end + 1) : end;
						continue;
					}
					fail(filePath, i, "malformed inline type specifiers");
				}
				end = nextCodeIndex(source, code, imported.end);
				const asWord = wordAt(source, code, end);
				if (asWord?.text === "as") {
					const alias = wordAt(source, code, nextCodeIndex(source, code, asWord.end));
					if (!alias) fail(filePath, end, "malformed inline type specifiers");
					end = nextCodeIndex(source, code, alias.end);
				}
				if (source[end] === ",") end++;
				blank(output, source, specifier.start, end);
				i = nextCodeIndex(source, code, end);
				continue;
			}
			i = nextCodeIndex(source, code, specifier.end);
			const asWord = wordAt(source, code, i);
			if (asWord?.text === "as") {
				const alias = wordAt(source, code, nextCodeIndex(source, code, asWord.end));
				if (!alias) fail(filePath, i, "malformed named import or export specifiers");
				i = nextCodeIndex(source, code, alias.end);
			}
			if (source[i] === ",") i = nextCodeIndex(source, code, i + 1);
			else if (i < close)
				fail(filePath, i, "malformed named import or export specifiers");
		}
	}
}

function blankClassSyntax(
	source: string,
	code: Array<boolean>,
	output: Array<string>,
	words: Array<Word>,
	filePath: string,
): void {
	const modifiers = new Set([
		"public",
		"private",
		"protected",
		"readonly",
		"abstract",
		"override",
	]);
	for (const classWord of words) {
		if (classWord.text !== "class") continue;
		const beforeClass = wordAtPreviousCode(source, code, classWord.start);
		if (beforeClass?.text === "abstract") {
			blank(output, source, beforeClass.start, beforeClass.end);
		}

		const name = wordAt(source, code, nextCodeIndex(source, code, classWord.end));
		if (!name) continue;
		let header = nextCodeIndex(source, code, name.end);
		if (source[header] === "<") {
			const close = matching(source, code, header, "<", ">", filePath);
			blank(output, source, header, close + 1);
			header = nextCodeIndex(source, code, close + 1);
		}
		const bodyOpen = findCodeChar(source, code, "{", header);
		if (bodyOpen < 0) fail(filePath, classWord.start, "malformed classes");
		const bodyClose = matching(source, code, bodyOpen, "{", "}", filePath);
		for (let open = header; open < bodyOpen; open++) {
			if (!code[open] || source[open] !== "<") continue;
			const close = matchingOrMinusOne(source, code, open, "<", ">");
			if (close < 0 || close >= bodyOpen) {
				fail(filePath, open, "malformed generic class heritage");
			}
			blank(output, source, open, close + 1);
			open = close;
		}
		const implementsWord = findWordInRange(source, code, header, bodyOpen, "implements");
		if (implementsWord) {
			blank(output, source, implementsWord.start, bodyOpen);
		}
		blankClassMembers(source, code, output, bodyOpen, bodyClose, modifiers, filePath);
	}
}

function blankClassMembers(
	source: string,
	code: Array<boolean>,
	output: Array<string>,
	bodyOpen: number,
	bodyClose: number,
	modifiers: Set<string>,
	filePath: string,
): void {
	let braces = 0;
	let parentheses = 0;
	let brackets = 0;
	for (let i = bodyOpen + 1; i < bodyClose; i++) {
		if (!code[i]) continue;
		const char = source[i]!;
		if (braces === 0 && parentheses === 0 && brackets === 0 && char === "(") {
			const close = matching(source, code, i, "(", ")", filePath);
			blankParameterAnnotations(source, code, output, i, close, filePath);
			const after = nextCodeIndex(source, code, close + 1);
			if (source[after] === ":") {
				const end = findTypeEnd(source, code, after + 1, ["{", ";"], filePath);
				blank(output, source, after, end);
			}
			i = close;
			continue;
		}
		if (char === "{") braces++;
		else if (char === "}" && braces > 0) braces--;
		else if (char === "(") parentheses++;
		else if (char === ")" && parentheses > 0) parentheses--;
		else if (char === "[") brackets++;
		else if (char === "]" && brackets > 0) brackets--;
		if (braces !== 0 || parentheses !== 0 || brackets !== 0) continue;

		if (isIdentifierStart(char)) {
			const word = wordAt(source, code, i)!;
			if (word.text === "abstract") {
				const end = findClassMemberSemicolon(source, code, word.start, bodyClose);
				if (end < 0) fail(filePath, word.start, "malformed abstract class members");
				blank(output, source, word.start, end + 1);
				i = end;
				continue;
			}
			if (modifiers.has(word.text)) blank(output, source, word.start, word.end);
			i = word.end - 1;
			continue;
		}
		if (char === "?" && source[nextCodeIndex(source, code, i + 1)] === ":") {
			blank(output, source, i, i + 1);
			continue;
		}
		if (char === "!" && source[nextCodeIndex(source, code, i + 1)] === ":") {
			blank(output, source, i, i + 1);
			continue;
		}
		if (char === ":") {
			const end = findTypeEnd(source, code, i + 1, ["=", ";", "{"], filePath);
			blank(output, source, i, end);
			i = end - 1;
			continue;
		}
	}
}

function findClassMemberSemicolon(
	source: string,
	code: Array<boolean>,
	start: number,
	bodyClose: number,
): number {
	let braces = 0;
	let parentheses = 0;
	let brackets = 0;
	for (let i = start; i < bodyClose; i++) {
		if (!code[i]) continue;
		const char = source[i]!;
		if (char === "{") braces++;
		else if (char === "}" && braces > 0) braces--;
		else if (char === "(") parentheses++;
		else if (char === ")" && parentheses > 0) parentheses--;
		else if (char === "[") brackets++;
		else if (char === "]" && brackets > 0) brackets--;
		else if (char === ";" && braces === 0 && parentheses === 0 && brackets === 0)
			return i;
	}
	return -1;
}

function findWordInRange(
	source: string,
	code: Array<boolean>,
	start: number,
	end: number,
	text: string,
): Word | undefined {
	for (let i = start; i < end; i++) {
		if (!code[i] || !isIdentifierStart(source[i])) continue;
		const word = wordAt(source, code, i)!;
		if (word.text === text) return word;
		i = word.end - 1;
	}
	return undefined;
}

function wordAtPreviousCode(
	source: string,
	code: Array<boolean>,
	position: number,
): Word | undefined {
	const end = previousCodeIndex(source, code, position - 1) + 1;
	if (end <= 0 || !isIdentifierPart(source[end - 1])) return undefined;
	let start = end - 1;
	while (start > 0 && code[start - 1] && isIdentifierPart(source[start - 1])) start--;
	return { text: source.slice(start, end), start, end };
}

function blankGenericSyntax(
	source: string,
	code: Array<boolean>,
	output: Array<string>,
	words: Array<Word>,
	filePath: string,
): void {
	for (let wi = 0; wi < words.length; wi++) {
		const word = words[wi]!;
		if (word.text !== "function") continue;
		let i = nextCodeIndex(source, code, word.end);
		if (source[i] === "*") i = nextCodeIndex(source, code, i + 1);
		const name = wordAt(source, code, i);
		if (!name) continue;
		i = nextCodeIndex(source, code, name.end);
		if (source[i] !== "<") continue;
		const close = matching(source, code, i, "<", ">", filePath);
		if (source[nextCodeIndex(source, code, close + 1)] !== "(") {
			fail(filePath, i, "malformed generic functions");
		}
		blank(output, source, i, close + 1);
	}

	for (let open = 0; open < source.length; open++) {
		if (!code[open] || source[open] !== "<") continue;
		const before = previousCodeIndex(source, code, open - 1);
		if (
			!isIdentifierPart(source[before]) &&
			source[before] !== ")" &&
			source[before] !== "]"
		)
			continue;
		const close = matchingOrMinusOne(source, code, open, "<", ">");
		if (close < 0) continue;
		const after = nextCodeIndex(source, code, close + 1);
		if (source[after] !== "(" && source[after] !== "`") continue;
		blank(output, source, open, close + 1);
		open = close;
	}

	for (let open = 0; open < source.length; open++) {
		if (!code[open] || source[open] !== "<") continue;
		const close = matchingOrMinusOne(source, code, open, "<", ">");
		if (close < 0) continue;
		const parametersOpen = nextCodeIndex(source, code, close + 1);
		if (source[parametersOpen] !== "(") continue;
		const parametersClose = matching(source, code, parametersOpen, "(", ")", filePath);
		const after = findArrowAfterParameters(source, code, parametersClose);
		if (after < 0) continue;
		blank(output, source, open, close + 1);
		open = close;
	}
}

function findArrowAfterParameters(
	source: string,
	code: Array<boolean>,
	parametersClose: number,
): number {
	let i = nextCodeIndex(source, code, parametersClose + 1);
	if (source[i] === "=" && source[i + 1] === ">") return i;
	if (source[i] !== ":") return -1;
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	let angles = 0;
	for (i++; i < source.length - 1; i++) {
		if (!code[i]) continue;
		const char = source[i]!;
		const topLevel = parentheses === 0 && brackets === 0 && braces === 0 && angles === 0;
		if (topLevel && char === "=" && source[i + 1] === ">") return i;
		if (topLevel && (char === ";" || char === "{")) return -1;
		if (char === "(") parentheses++;
		else if (char === ")" && parentheses > 0) parentheses--;
		else if (char === "[") brackets++;
		else if (char === "]" && brackets > 0) brackets--;
		else if (char === "{") braces++;
		else if (char === "}" && braces > 0) braces--;
		else if (char === "<") angles++;
		else if (char === ">" && angles > 0) angles--;
	}
	return -1;
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
		let angles = 0;
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
			if (char === "<") angles++;
			if (char === ">" && angles > 0) angles--;
			if (nested === 0 && angles === 0 && char === "=") initialized = true;
			if (nested === 0 && angles === 0 && char === ",") initialized = false;
			if (nested === 0 && angles === 0 && char === ":" && !initialized) {
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
		blankParameterAnnotations(source, code, output, open, close, filePath);
		const after = nextCodeIndex(source, code, close + 1);
		if (source[after] === ":") {
			const end = findTypeEnd(source, code, after + 1, ["{"], filePath);
			blank(output, source, after, end);
		}
	}
}

function blankTypeAssertions(
	source: string,
	code: Array<boolean>,
	output: Array<string>,
	words: Array<Word>,
	filePath: string,
): void {
	for (let wi = 0; wi < words.length; wi++) {
		const word = words[wi]!;
		if (
			(word.text !== "as" && word.text !== "satisfies") ||
			insideImportOrExportStatement(source, code, words, wi)
		)
			continue;
		const end = findAssertionEnd(source, code, word.end, filePath);
		blank(output, source, word.start, end);
	}
}

function findAssertionEnd(
	source: string,
	code: Array<boolean>,
	start: number,
	filePath: string,
): number {
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	let angles = 0;
	let sawType = false;
	for (let i = nextCodeIndex(source, code, start); i < source.length; i++) {
		if (!code[i]) continue;
		const char = source[i]!;
		const topLevel = parentheses === 0 && brackets === 0 && braces === 0 && angles === 0;
		if (
			topLevel &&
			(char === ";" ||
				char === "," ||
				char === ")" ||
				char === "]" ||
				char === "}" ||
				char === "+" ||
				char === "-" ||
				char === "*" ||
				char === "/" ||
				char === "%" ||
				char === "=" ||
				char === "?" ||
				char === ":")
		) {
			if (!sawType) fail(filePath, start, "empty type assertions");
			return i;
		}
		if (char === "(") parentheses++;
		else if (char === ")" && parentheses > 0) parentheses--;
		else if (char === "[") brackets++;
		else if (char === "]" && brackets > 0) brackets--;
		else if (char === "{") braces++;
		else if (char === "}" && braces > 0) braces--;
		else if (char === "<") angles++;
		else if (char === ">" && angles > 0) angles--;
		if (isIdentifierStart(char)) sawType = true;
	}
	if (sawType) return source.length;
	fail(filePath, start, "empty type assertions");
}

function blankNonNullAssertions(
	source: string,
	code: Array<boolean>,
	output: Array<string>,
): void {
	for (let i = 0; i < source.length; i++) {
		if (!code[i] || source[i] !== "!" || source[i + 1] === "=" || source[i - 1] === "!")
			continue;
		const before = previousCodeIndex(source, code, i - 1);
		if (
			isIdentifierPart(source[before]) ||
			source[before] === ")" ||
			source[before] === "]"
		) {
			blank(output, source, i, i + 1);
		}
	}
}

function blankArrowAnnotations(
	source: string,
	code: Array<boolean>,
	output: Array<string>,
	filePath: string,
): void {
	for (let arrow = 0; arrow < source.length - 1; arrow++) {
		if (!code[arrow] || source[arrow] !== "=" || source[arrow + 1] !== ">") continue;
		let before = previousCodeIndex(source, code, arrow - 1);
		let returnColon = before;
		while (returnColon >= 0 && source[returnColon] !== ":") {
			if (
				code[returnColon] &&
				(source[returnColon] === ";" ||
					source[returnColon] === "{" ||
					source[returnColon] === "}")
			)
				break;
			returnColon--;
		}
		if (returnColon >= 0 && source[returnColon] === ":") {
			const parametersClose = previousCodeIndex(source, code, returnColon - 1);
			if (source[parametersClose] === ")") {
				blank(output, source, returnColon, arrow);
				before = parametersClose;
			}
		}
		if (source[before] === ")") {
			const open = matchingBackward(source, code, before, "(", ")", filePath);
			blankParameterAnnotations(source, code, output, open, before, filePath);
			continue;
		}

		let colon = before;
		while (colon >= 0 && source[colon] !== ":") {
			if (
				code[colon] &&
				(source[colon] === "," ||
					source[colon] === ";" ||
					source[colon] === "{" ||
					source[colon] === "}")
			)
				break;
			colon--;
		}
		if (colon >= 0 && code[colon] && source[colon] === ":") {
			const optional = previousCodeIndex(source, code, colon - 1);
			if (source[optional] === "?") blank(output, source, optional, optional + 1);
			blank(output, source, colon, arrow);
		}
	}
}

function blankParameterAnnotations(
	source: string,
	code: Array<boolean>,
	output: Array<string>,
	open: number,
	close: number,
	filePath: string,
): void {
	let nested = 0;
	for (let i = open + 1; i < close; i++) {
		if (!code[i]) continue;
		const char = source[i]!;
		if (char === "(" || char === "[" || char === "{") nested++;
		if (char === ")" || char === "]" || char === "}") nested--;
		if (nested === 0 && char === "?") {
			const after = nextCodeIndex(source, code, i + 1);
			if (source[after] === ":") blank(output, source, i, i + 1);
		}
		if (nested === 0 && char === ":") {
			const end = findTypeEnd(source, code, i + 1, [",", ")", "="], filePath);
			blank(output, source, i, end);
			i = end - 1;
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
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	let angles = 0;
	for (let i = start; i < source.length; i++) {
		if (!code[i]) continue;
		const char = source[i]!;
		if (
			parentheses === 0 &&
			brackets === 0 &&
			braces === 0 &&
			angles === 0 &&
			delimiters.includes(char) &&
			!(char === "=" && source[i + 1] === ">")
		) {
			if (!sawType) fail(filePath, start, "empty type annotations");
			return i;
		}
		if (char === "(") parentheses++;
		else if (char === ")" && parentheses > 0) parentheses--;
		else if (char === "[") brackets++;
		else if (char === "]" && brackets > 0) brackets--;
		else if (char === "{") braces++;
		else if (char === "}" && braces > 0) braces--;
		else if (char === "<") angles++;
		else if (char === ">" && angles > 0) angles--;
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

function previousCodeIndex(source: string, code: Array<boolean>, start: number): number {
	let i = start;
	while (
		i >= 0 &&
		(!code[i] ||
			source[i] === " " ||
			source[i] === "\t" ||
			source[i] === "\n" ||
			source[i] === "\r")
	)
		i--;
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
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	let angles = 0;
	for (let i = start; i < source.length; i++) {
		if (!code[i]) continue;
		const char = source[i]!;
		if (char === "(") parentheses++;
		else if (char === ")" && parentheses > 0) parentheses--;
		else if (char === "[") brackets++;
		else if (char === "]" && brackets > 0) brackets--;
		else if (char === "{") braces++;
		else if (char === "}" && braces > 0) braces--;
		else if (char === "<") angles++;
		else if (char === ">" && angles > 0) angles--;
		else if (
			char === ";" &&
			parentheses === 0 &&
			brackets === 0 &&
			braces === 0 &&
			angles === 0
		) {
			return i + 1;
		}
	}
	fail(filePath, start, "semicolon-less type declarations");
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

function matchingOrMinusOne(
	source: string,
	code: Array<boolean>,
	start: number,
	open: string,
	close: string,
): number {
	let depth = 0;
	for (let i = start; i < source.length; i++) {
		if (!code[i]) continue;
		if (source[i] === open) depth++;
		if (source[i] === close && --depth === 0) return i;
	}
	return -1;
}

function matchingBackward(
	source: string,
	code: Array<boolean>,
	start: number,
	open: string,
	close: string,
	filePath: string,
): number {
	let depth = 0;
	for (let i = start; i >= 0; i--) {
		if (!code[i]) continue;
		if (source[i] === close) depth++;
		if (source[i] === open && --depth === 0) return i;
	}
	fail(filePath, start, `unbalanced '${close}' syntax`);
}
