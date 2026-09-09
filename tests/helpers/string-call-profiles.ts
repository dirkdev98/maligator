export const localeCaseTags = ["tr", "az", "lt", "en", "en-US", "und"] as const;

export const localeCaseText = "IİiıJ\u0301i\u0307Σ AΣ 😀\ud800";

export const constantStringCallCases: ReadonlyArray<readonly [string, string, string]> = [
	["String", "undefined", "false"],
	["String.fromCharCode", "undefined", "65537,-1,0xd800"],
	["String.fromCodePoint", "undefined", "128512,0xd800"],
	["String.prototype.at", "'A😀Z'", "-1"],
	["String.prototype.charAt", "'A😀Z'", "1"],
	["String.prototype.charCodeAt", "'A😀Z'", "2"],
	["String.prototype.codePointAt", "'A😀Z'", "1"],
	["String.prototype.valueOf", "'A😀Z'", ""],
	["String.prototype.toString", "'A😀Z'", ""],
	["String.prototype.includes", "'abc'", "'b',1"],
	["String.prototype.indexOf", "'aba'", "'a',1"],
	["String.prototype.lastIndexOf", "'aba'", "'a',1"],
	["String.prototype.startsWith", "'abc'", "'b',1"],
	["String.prototype.endsWith", "'abc'", "'b',2"],
	["String.prototype.slice", "'A😀Z'", "1,3"],
	["String.prototype.substring", "'A😀Z'", "3,1"],
	["String.prototype.substr", "'A😀Z'", "-3,2"],
	["String.prototype.concat", "'a'", "1,null,true,'😀'"],
	["String.prototype.repeat", "'ab'", "3"],
	["String.prototype.padStart", "'x'", "6,'ab'"],
	["String.prototype.padEnd", "'x'", "6,'ab'"],
	["String.prototype.trim", "'\\ufeff \\u2028A\\u2029 '", ""],
	["String.prototype.trimStart", "'\\ufeff A '", ""],
	["String.prototype.trimEnd", "' A\\u2029 '", ""],
	["String.prototype.trimLeft", "'\\ufeff A '", ""],
	["String.prototype.trimRight", "' A\\u2029 '", ""],
	["String.prototype.isWellFormed", "'😀\\ud800'", ""],
	["String.prototype.toWellFormed", "'😀\\ud800'", ""],
	["String.prototype.toLowerCase", JSON.stringify(localeCaseText), ""],
	["String.prototype.toUpperCase", JSON.stringify(localeCaseText), ""],
	["String.prototype.toLocaleLowerCase", JSON.stringify(localeCaseText), ""],
	["String.prototype.toLocaleUpperCase", JSON.stringify(localeCaseText), ""],
	...(["toLocaleLowerCase", "toLocaleUpperCase"] as const).flatMap((method) =>
		localeCaseTags.map((locale): readonly [string, string, string] => [
			`String.prototype.${method}`,
			JSON.stringify(localeCaseText),
			JSON.stringify(locale),
		]),
	),
	...(["NFC", "NFD", "NFKC", "NFKD"] as const).map(
		(form): readonly [string, string, string] => [
			"String.prototype.normalize",
			"'A\\u030a\\u212b\\ufb01\\ud800'",
			JSON.stringify(form),
		],
	),
	["String.prototype.replace", "'aba'", "'a','$$$&'"],
	["String.prototype.replaceAll", "'ab'", "'','-'"],
	["String.raw", "undefined", "{raw:['a','b','c']},'x',2"],
	["encodeURI", "undefined", "'a b?x=😀'"],
	["encodeURIComponent", "undefined", "'a/b😀'"],
	["decodeURI", "undefined", "'%20%2F'"],
	["decodeURIComponent", "undefined", "'%F0%9F%98%80'"],
	["escape", "undefined", "'😀'"],
	["unescape", "undefined", "'%uD800'"],
	...(
		[
			"anchor",
			"big",
			"blink",
			"bold",
			"fixed",
			"fontcolor",
			"fontsize",
			"italics",
			"link",
			"small",
			"strike",
			"sub",
			"sup",
		] as const
	).map((method): readonly [string, string, string] => [
		`String.prototype.${method}`,
		"'<😀>'",
		"'a\"b'",
	]),
];

export const dynamicStringCallCases: ReadonlyArray<
	readonly [string, string, string, string]
> = [
	["String", "undefined", "value", "String(x)"],
	["String.fromCharCode", "undefined", "value,65", "+x"],
	["String.fromCodePoint", "undefined", "value,65", "+x"],
	...constantStringCallCases
		.filter(
			([callee]) =>
				callee.startsWith("String.prototype.") &&
				!["String.prototype.replace", "String.prototype.replaceAll"].includes(callee),
		)
		.map(([callee, , args]): readonly [string, string, string, string] => [
			callee,
			"value",
			args,
			"String(x)",
		]),
	["String.prototype.replace", "value", "'a','$$$&'", "String(x)"],
	["String.prototype.replaceAll", "value", "'a','-'", "String(x)"],
	...[
		"encodeURI",
		"encodeURIComponent",
		"decodeURI",
		"decodeURIComponent",
		"escape",
		"unescape",
	].map((callee): readonly [string, string, string, string] => [
		callee,
		"undefined",
		"value",
		"String(x)",
	]),
	...["at", "charAt", "charCodeAt", "codePointAt", "slice", "substring", "substr"].map(
		(method): readonly [string, string, string, string] => [
			`String.prototype.${method}`,
			"'A😀abcZ'",
			"value",
			"+x",
		],
	),
	...["includes", "indexOf", "lastIndexOf", "startsWith", "endsWith"].flatMap(
		(method): ReadonlyArray<readonly [string, string, string, string]> => [
			[`String.prototype.${method}`, "'A😀abcZ'", "value,1", "String(x)"],
			[`String.prototype.${method}`, "'A😀abcZ'", "'a',value", "+x"],
		],
	),
];
