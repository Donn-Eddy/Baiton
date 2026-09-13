# Vendored webview libraries

This directory holds the checked-in, pure-JS browser builds that the Chat_View
webview loads. They are the authoritative source copies. A dev-only copy step
(`npm run copy:media`, see `scripts/copy-media-vendor.js`) copies these files
into `media/vendor/`, which is where `media/chat.html` loads them from and which
`localResourceRoots` admits.

The copy step is wired into `compile` (via `precompile`) and `package`, so a
clean checkout produces `media/vendor/` on build. `media/vendor/` is generated
and git-ignored; only the sources here are tracked.

The alternative considered and **not chosen** was a dev-only bundler (esbuild)
that would bundle a webview entry into a single `media/chat.js`. That adds a
build tool and dependency; hand-vendoring keeps the toolchain to `tsc` plus a
short copy script and keeps every byte the webview runs visible in the repo.

## Contents

| File            | Library | Version  | License | Source                                                       |
| --------------- | ------- | -------- | ------- | ------------------------------------------------------------ |
| `marked.min.js` | marked  | 12.0.2   | MIT     | `https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.umd.min.js` |

`marked` is the minimal pure-JS markdown renderer used to turn assistant text
into HTML. Its output is **never trusted alone**: `media/chat.js` always passes
it through the owned `sanitizeHtml` core before it touches the DOM.

marked is distributed under the MIT License, Copyright (c) 2018+ Christopher
Jeffrey and the marked contributors. See https://github.com/markedjs/marked.
