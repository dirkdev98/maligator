"use strict";

/* eslint-disable -- This fixture executes the pinned, unmodified CommonJS packages. */

const net = require("net");
const canonicalNet = require("node:net");
const querystring = require("querystring");
const canonicalQuerystring = require("node:querystring");
const url = require("url");
const canonicalUrl = require("node:url");
const parseUrl = require("parseurl");
const { app } = require("./app.js");

const request = { url: "/users/42?name=mal+igator&tag=a&tag=b" };
const parsed = parseUrl(request);
const query = app.get("query parser fn")(parsed.query);
parsed.path = null;
parsed.pathname += "/";

const checks = [
	net === canonicalNet,
	querystring === canonicalQuerystring,
	url === canonicalUrl,
	parsed instanceof url.Url,
	parsed.pathname === "/users/42/",
	url.format(parsed) === "/users/42/?name=mal+igator&tag=a&tag=b",
	query.name === "mal igator",
	query.tag.join(",") === "a,b",
	Object.getPrototypeOf(query) === null,
	net.isIP("127.0.0.1") === 4,
	net.isIP("2001:db8::1") === 6,
	net.isIP("example.com") === 0,
	typeof app === "function",
];

console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);
