# Contributing

Anyone is welcome to open an issue or a pull request — a bug report, a fix, a test case, a
translation, a README correction. You do not need permission first, and small pull requests are
easier to review than big ones.

## Reporting something

Open an issue at https://github.com/situkangsayur/zotero-github-plugin/issues. What helps most:

- what you did, what you expected, what happened
- the Zotero version, your operating system, and the plugin version (Tools -> Add-ons)
- the relevant part of the Zotero debug output (Help -> Debug Output Logging -> View Output).
  **Remove your access token, API key and anything private before pasting it.**

Security issues: please write to the address in the repository's GitHub profile, or open an issue
that only describes the problem in general terms — not a working exploit — and we will take it
from there.

## Sending a pull request

```bash
git clone https://github.com/situkangsayur/zotero-github-plugin.git
cd zotero-github-plugin
npm install          # only eslint; the plugin itself has no dependencies
npm test              # pure logic, no Zotero and no network
npm run build        # writes build/zotero-github-sync-<version>.xpi
```

Install `build/zotero-github-sync-<version>.xpi` in Zotero with Tools -> Add-ons -> the gear -> Install Add-on From File.
`docs/DEVELOPMENT.md` has the rest: running from source, the headless test harnesses, and how a
release is made.

Then:

1. Fork the repository and branch off `main`.
2. Make the change, and add a test when the logic can be tested without Zotero (`test/` runs
   under plain Node).
3. Run `npm test` and, if it is set up here, `npm run lint`.
4. Describe in the pull request what the change does and how you checked it. Say so if you have
   not been able to run it in Zotero — that is fine, it just tells the reviewer what to try.

## House style

The code follows the Zotero codebase: tabs, `let` rather than `const` except for real constants,
`else` and `catch` on their own line, and two hyphens instead of an em dash. Comments explain
**why** something is done, not what the line does. Keep a change and its formatting separate:
please don't reformat code you are not otherwise touching.

## Licence

By contributing you agree that your contribution is published under this repository's MIT
licence.
