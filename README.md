# DSH Market Index

An automatically rebuilt [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugin-market index (format 1) built from the GitHub topic
[`dsh-plugin`](https://github.com/topics/dsh-plugin).

The Harness 「发现」 (Discover) tab reads a **JSON document**, not a web page, which is
why a topic URL can never work there. This repository supplies that document:

```
https://<owner>.github.io/<repo>/index.json
```

Add it once in **插件 → 发现 → 添加索引源**, and plugins appear with a one-click install.

## What gets included

For the **top N repositories by stars** on the topic (default 50):

1. `package.json` at the repository root must declare `dsh.bundle` — that field is what
   makes a package installable as a bundle. Everything else on the topic is skipped.
2. The package must be published to npm **with that bundle field still present**, so
   the install is a plain `npm` install rather than a git checkout that needs a build.
   If npm is missing, the repository is pinned to a commit instead and marked in
   `report.json`.
3. `engines.dsh` (or the `@deepseek-ai/dsh*` peer ranges) must accept the running
   Harness version, otherwise the market would only offer an install that fails.

`report.json` records every candidate and why it was skipped, so a missing plugin is
explainable rather than mysterious.

## Rebuilding

- Weekly, Monday 03:17 UTC, via GitHub Actions.
- Manually: **Actions → rebuild index → Run workflow** (you can set `top_n` there).
- Locally: `npm install && GITHUB_TOKEN=... TOP_N=50 node scripts/build-index.mjs`

The workflow commits `index.json` and `report.json`; GitHub Pages serves them from the
`main` branch root. Nothing is ever installed by the build.

## Limits worth knowing

- The index is a **declaration**, not a guarantee: the installed `package.json` is what
  actually runs. Star counts are a popularity signal, not a security review — review a
  plugin's source before installing it.
- Git-sourced entries are not "one-click": pnpm refuses to run a git dependency's
  `prepare` script until its package key is allowlisted in the profile's
  `pnpm-workspace.yaml`. Prefer the npm entries.
- The Harness has no upgrade path for bundles; updating means uninstall + install.
- `TARGET_DSH` is pinned to the desktop build this index is verified against. Bump it
  when the desktop app is upgraded.
