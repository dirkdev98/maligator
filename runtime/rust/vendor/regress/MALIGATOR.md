# Unicode data

The runtime uses the published Regress 0.12.0 sources with Unicode 18 tables.
The upstream generator comes from commit
`aae35dee1596cc9a9caaad2425b088081c09e5d5`; its local changes accept an input
directory and check formatting failures. Runtime matching code is unchanged.

Regress's published tables predate Unicode 18, including simple case-folding
equivalences used by ECMAScript regular expressions. Keep the backend's folding,
uppercase, character properties, scripts and string properties on the same Unicode
version as the runtime's string transforms.

Extract the official [Unicode 18 UCD archive](https://www.unicode.org/Public/18.0.0/ucd/UCD.zip)
and add the [emoji sequences](https://www.unicode.org/Public/18.0.0/emoji/emoji-sequences.txt)
and [emoji ZWJ sequences](https://www.unicode.org/Public/18.0.0/emoji/emoji-zwj-sequences.txt)
at its root. Regenerate with:

```sh
node scripts/generate-regress-unicode.ts /path/to/ucd-18.0.0
```

The command verifies the pinned input hashes before running the generator. Build
output uses a disposable directory outside the runtime's Rust source tree.
The upstream MIT and Apache licenses apply to the backend; Unicode data uses the
license in `runtime/vendor/unicode/LICENSE.txt`.
