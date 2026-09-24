---
name: userscript-dev
description: Userscript development workflow (Tampermonkey/Violentmonkey/Greasemonkey `.user.js` files with `// ==UserScript==` metadata blocks). Use ONLY when writing, modifying, or testing a browser userscript from scratch or against an existing `.user.js` file, or when the user mentions Tampermonkey, Violentmonkey, Greasemonkey, `@match`, `@grant`, `unsafeWindow`, or GM_* APIs. Do NOT use for regular web app development (SPA, backend, full site) — see the general browser-verification workflow for that.
---

# Userscript Development

Scope: this skill is specific to browser userscripts (`.user.js` files with a
`// ==UserScript==` metadata block, intended for Tampermonkey/Violentmonkey/
Greasemonkey). It does not apply to regular web apps, SPAs, or backend
projects — for those, drive the browser directly with `playwright` and
`chrome-devtools` without any of the injection scaffolding described here.

## Why this differs from normal web dev

A userscript is not running code — it is a source file that a userscript
manager would normally inject into matching pages. `playwright` and
`chrome-devtools` do not have Tampermonkey installed by default, and
installing a real extension inside their isolated/managed browser profiles is
unnecessary ceremony for iterating on a script. Instead, simulate what the
userscript manager does: read the file and execute its body in the page.

## Level 1 — default, zero setup (use this first)

For any userscript project, regardless of what MCP browser tool is already
running:

1. Read the `.user.js` file with the file-read tool.
2. Strip the `// ==UserScript== ... ==/UserScript==` metadata block — it is
   not valid JS and browser tools' script evaluation does not parse it.
3. Note any `@grant` values in the metadata:
   - `@grant unsafeWindow`: in a real userscript sandbox, `unsafeWindow` gives
     access to the page's real `window`. When evaluating directly in the
     page (no sandbox exists), `unsafeWindow` does not exist as a global —
     patch it before running the body, e.g. prepend
     `const unsafeWindow = window;` (this matches the common
     `typeof unsafeWindow !== 'undefined' ? unsafeWindow : window` fallback
     pattern many userscripts already use, so often no patch is needed at
     all).
   - `@grant GM_*` (`GM_getValue`, `GM_setValue`, `GM_xmlhttpRequest`, etc.):
     these are NOT available via direct evaluation. If the script uses them,
     either stub them out for the test session, or fall back to Level 2 with
     a real userscript manager extension installed in the browser profile.
     Flag this limitation to the user rather than silently no-op'ing.
4. Navigate to the target page with `playwright` (or `chrome-devtools` if
   already on that page), then run the stripped script body via
   `evaluate_script`/`browser_evaluate`.
5. Iterate: edit the `.user.js` file, reload the page, re-run the same
   evaluate step. No extension reload, no file server, no extra process.
6. Use `chrome-devtools` (console, network, DOM) on the same page/URL to
   diagnose failures found while driving the flow with `playwright`.

This works from a cold repo with no prior userscript-specific setup, and is
the right default for occasional edits or first-time exploration of a script.

## Level 2 — optional, project-scoped persistent dev loop

Only worth setting up when Level 1's login friction becomes real (e.g. a
site with a manual login step you don't want to repeat every session) or the
script depends on `GM_*` APIs that Level 1 cannot provide. This is
configured **per project**, never in the global config — it must not affect
unrelated projects.

Add a project-local MCP override for the `playwright` server (in that
project's `opencode.json`/`opencode.jsonc`, not the global one) with:

- `--user-data-dir <path>`: a persistent Chromium profile scoped to that
  project (e.g. `.playwright-profile/` inside the repo), so logins and
  cookies survive across sessions.
- `--init-script <path-to-file>`: a small bootstrap script, NOT the
  userscript itself inlined. `--init-script` runs before `document.body`
  exists (equivalent to `document_start`), so any userscript that touches
  `document.body` synchronously at load time will throw if injected
  directly at this stage.

The bootstrap script should defer execution until the DOM is ready, then
inject the real `.user.js` source (fetched or read at runtime) into the
page, applying the same `@grant`/metadata handling as Level 1:

```js
// bootstrap.js — passed via --init-script, NOT the userscript itself
function run() {
  // Fetch or otherwise obtain the current .user.js source, strip the
  // ==UserScript== block, then execute it. Re-reading the source on every
  // page load (rather than hardcoding it here) keeps edits to the real
  // .user.js file picked up automatically on reload.
  // ... inject stripped source into the page here ...
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', run, { once: true });
} else {
  run();
}
```

Document this override in the project's own `AGENTS.md` so it is obvious
this is project-specific, not a global default.

## Output

When finishing a userscript task, report:

- which level was used (1 or 2) and why
- any `@grant`/GM_* limitations hit and how they were handled
- what was verified in the live page (via `playwright` and/or
  `chrome-devtools`) and what still needs manual confirmation in a real
  userscript manager
