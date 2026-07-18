"use strict";

/* eslint-disable -- This fixture executes the pinned, unmodified CommonJS packages. */

const net = require("net");
const canonicalNet = require("node:net");
const http = require("http");
const canonicalHttp = require("node:http");
const querystring = require("querystring");
const canonicalQuerystring = require("node:querystring");
const url = require("url");
const canonicalUrl = require("node:url");
const parseUrl = require("parseurl");
const { app } = require("./app.js");
const server = http.createServer(app);

const request = { url: "/users/42?name=mal+igator&tag=a&tag=b" };
const parsed = parseUrl(request);
const query = app.get("query parser fn")(parsed.query);
parsed.path = null;
parsed.pathname += "/";

const checks = [
	net === canonicalNet,
	http === canonicalHttp,
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
	server instanceof http.Server,
	server.listeners("request")[0] === app,
];

console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);
