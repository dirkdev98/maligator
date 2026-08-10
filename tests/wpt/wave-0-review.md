# Wave 0 candidate review

This file classifies every path in `wave-0.txt` that is not currently in the
curated server-main corpus. The review is pinned to WPT revision
`f0b30d60daf6a64a3b087d66732c54c8e5273dbd`. A deferred path becomes eligible
when its prerequisite lands; network-resource tests also require a deterministic
replacement for WPT server transforms without modifying the upstream source.

| Candidate                                          | Disposition | Next gate                                                                                                                         |
| -------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `dom/events/Event-constructors.any.js`             | Deferred    | Complete Event constructor Web IDL/null-state behavior and decide whether the file's `CustomEvent` case is in the server profile. |
| `html/webappapis/atob/base64.any.js`               | Deferred    | Provide its dynamically loaded JSON resource through the pinned runner and resolve the upstream duplicate test names.             |
| `encoding/api-invalid-label.any.js`                | Deferred    | Add the subset-test include contract and the broader Encoding label table.                                                        |
| `encoding/encodeInto.any.js`                       | Deferred    | Add `SharedArrayBuffer`; the ordinary `ArrayBuffer` cases already pass in discovery.                                              |
| `encoding/textdecoder-streaming.any.js`            | Deferred    | Add `SharedArrayBuffer`; the ordinary-buffer streaming cases already pass in discovery.                                           |
| `fetch/api/headers/header-values-normalize.any.js` | Deferred    | Implement outbound `fetch()` plus deterministic WPT server resources; its XHR branch is outside server-main.                      |
| `fetch/api/response/json.any.js`                   | Deferred    | Implement outbound `fetch()` and its WPT JSON resource.                                                                           |
| `url/url-origin.any.js`                            | Deferred    | Provide the pinned URL JSON resources through a deterministic resource loader or outbound `fetch()`.                              |
| `url/url-setters.any.js`                           | Deferred    | Support subset-by-key metadata and provide the pinned setter JSON resource.                                                       |
