#!/usr/bin/env node
import assert from "node:assert/strict";
import exaSearchExtension, { runExaSearch } from "../extensions/exa-search/index.ts";

let requestUrl;
let requestInit;
const successFetch = async (url, init) => {
	requestUrl = url;
	requestInit = init;
	return new Response(JSON.stringify({
		requestId: "request-1",
		resolvedSearchType: "auto",
		results: [{
			title: "Official documentation",
			url: "https://example.com/docs",
			publishedDate: "2026-07-17T00:00:00.000Z",
			highlights: ["Relevant external evidence"],
		}],
		costDollars: { total: 0.007 },
	}), { status: 200, headers: { "Content-Type": "application/json" } });
};

const result = await runExaSearch({
	query: "current documentation",
	includeDomains: ["example.com"],
	maxAgeHours: 0,
}, "test-key", undefined, successFetch);
assert.equal(requestUrl, "https://api.exa.ai/search");
assert.equal(requestInit.method, "POST");
assert.equal(requestInit.headers["x-api-key"], "test-key");
const requestBody = JSON.parse(requestInit.body);
assert.deepEqual(requestBody, {
	query: "current documentation",
	type: "auto",
	numResults: 5,
	moderation: true,
	contents: { highlights: true, maxAgeHours: 0 },
	includeDomains: ["example.com"],
});
assert.match(result.text, /Official documentation/);
assert.match(result.text, /https:\/\/example\.com\/docs/);
assert.match(result.text, /Relevant external evidence/);
assert.match(result.text, /\$0\.0070/);
assert.deepEqual(result.details, {
	requestId: "request-1",
	searchType: "auto",
	resultCount: 1,
	costDollars: 0.007,
	truncated: false,
});

await assert.rejects(
	() => runExaSearch({ query: "test" }, "", undefined, successFetch),
	/EXA_API_KEY/,
);
await assert.rejects(
	() => runExaSearch({ query: "   " }, "test-key", undefined, successFetch),
	/non-empty query/,
);
await assert.rejects(
	() => runExaSearch(
		{ query: "test" },
		"test-key",
		undefined,
		async () => new Response(JSON.stringify({ error: "rate limit exceeded" }), { status: 429 }),
	),
	/Exa Search failed \(429\): rate limit exceeded/,
);
await assert.rejects(
	() => runExaSearch(
		{ query: "test" },
		"test-key",
		undefined,
		async () => new Response("not-json", { status: 200 }),
	),
	/invalid JSON/,
);

const tools = new Map();
exaSearchExtension({ registerTool(tool) { tools.set(tool.name, tool); } });
assert.equal(tools.has("exa_search"), true);
assert.match(tools.get("exa_search").description, /always runs locally/);

console.log("test:exa-search ok");
