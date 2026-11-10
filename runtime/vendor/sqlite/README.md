# SQLite amalgamation

- Version: 3.54.1
- Release number: 3540100
- Upstream archive: https://sqlite.org/2026/sqlite-amalgamation-3540100.zip
- Archive SHA3-256: `92281c86e2957f9b9305890f9ac04204caa7b677cc868dc326d942689df28e30`
- `sqlite3.c` SHA-256: `0c657666d819f261cc4007526ad57e1669de9949df7a8ea847aa284a2bf0ee52`
- `sqlite3.h` SHA-256: `d6c84557261893439b341d2e6c35187ae3ea24fbfd843ad94616f72d89242b8c`
- Retrieved: 2026-11-10

Only the official `sqlite3.c` and `sqlite3.h` deliverables are vendored. SQLite
has dedicated both files to the public domain:
https://sqlite.org/copyright.html

Do not add the archive's shell or build-system sources here. The compiler embeds
this directory as a build asset and compiles `sqlite3.c` into the host archive;
generated applications never depend on a system-installed SQLite library.
