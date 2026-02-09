import type { ESTree } from "meriyah";
import { parseScript as meriyahParseScript } from "meriyah";
import type { Realm } from "../execution-contexts/realm.ts";

// https://tc39.es/ecma262/multipage/ecmascript-language-scripts-and-modules.html#sec-script-records
type ScriptRecord = {
	realm: Realm;
	ECMAScriptCode: ESTree.Program;
	loadedModules: Array<unknown>;
	hostDefined?: unknown;
	isStrict: boolean;
};

// https://tc39.es/ecma262/multipage/ecmascript-language-scripts-and-modules.html#sec-parse-script
export function parseScript(sourceText: string, realm: Realm): ScriptRecord {
	const script = meriyahParseScript(sourceText, {
		impliedStrict: true,
		validateRegex: false,
		loc: true,
	});

	return {
		realm,
		ECMAScriptCode: script,
		loadedModules: [],
		isStrict: isStrictNode(script),
	};
}

export function isStrictNode(node: { body: Array<ESTree.Node> }) {
	return (
		!!node.body[0] &&
		"directive" in node.body[0] &&
		node.body[0].directive === "use strict"
	);
}
