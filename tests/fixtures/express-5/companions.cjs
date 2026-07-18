"use strict";

/* eslint-disable -- This fixture executes pinned, unmodified Express dependencies. */

const net = require("net");
const canonicalNet = require("node:net");
const os = require("os");
const canonicalOs = require("node:os");
const querystring = require("querystring");
const canonicalQuerystring = require("node:querystring");
const url = require("url");
const canonicalUrl = require("node:url");
const parseUrl = require("parseurl");
const utils = require("express/lib/utils.js");
const debug = require("debug");

const request = { url: "/users/42?name=mal+igator&tag=a&tag=b" };
const parsed = parseUrl(request);
const absolute = parseUrl({ url: "http://example.com:8080/a?x=1#h" });
const query = utils.compileQueryParser("simple")(parsed.query);
const relativeAuthority = url.parse("//example.com/a");
const emptyReduceInitial = [].reduce((value) => value, {});
const directInspectOpts = Object.keys(process.env)
	.filter((key) => /^debug_/i.test(key))
	.reduce((value) => value, {});
parsed.path = null;
parsed.pathname += "/";

const checks = [
	net === canonicalNet,
	os === canonicalOs,
	typeof os.release() === "string" && os.release().length > 0,
	querystring === canonicalQuerystring,
	url === canonicalUrl,
	parsed instanceof url.Url,
	absolute instanceof url.Url,
	absolute.protocol === "http:",
	absolute.hostname === "example.com",
	absolute.port === "8080",
	absolute.pathname === "/a",
	url.format(absolute) === "http://example.com:8080/a?x=1#h",
	relativeAuthority.host === null,
	relativeAuthority.pathname === "//example.com/a",
	parsed.pathname === "/users/42/",
	url.format(parsed) === "/users/42/?name=mal+igator&tag=a&tag=b",
	query.name === "mal igator",
	query.tag.join(",") === "a,b",
	Object.getPrototypeOf(query) === null,
	Object.keys(querystring.parse("")).length === 0,
	typeof emptyReduceInitial === "object" && emptyReduceInitial !== null,
	typeof directInspectOpts === "object" && directInspectOpts !== null,
	typeof debug.inspectOpts === "object" && debug.inspectOpts !== null,
	typeof debug.useColors() === "boolean",
	net.isIP("127.0.0.1") === 4,
	net.isIP("2001:db8::1") === 6,
	net.isIP("example.com") === 0,
];

console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);
