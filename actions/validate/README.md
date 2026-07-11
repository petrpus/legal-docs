# `legal-docs validate` — GitHub Action

A composite action wrapping `legal-docs validate` (see the [CLI](../../README.md#cli)): lints a
`@petrpus/legal-docs` catalog and fails the check with GitHub annotations if anything doesn't resolve
(unregistered helper/derivation/Custom block, unresolved Clause ref, var-type mismatch, …).

## Usage

```yaml
name: Lint catalog
on: pull_request

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: petrpus/legal-docs/actions/validate@main
        with:
          catalog: legal-docs
          # config: registry.mjs   # only if your templates reference schemas/derivations/customBlocks
```

## Inputs

| Input          | Required | Default | Description                                                        |
|----------------|----------|---------|----------------------------------------------------------------------|
| `catalog`      | yes      | —       | Path to the catalog directory, relative to your workspace.           |
| `config`       | no       | —       | Path to a `--config` registry module (see the CLI docs for its shape). |
| `node-version` | no       | `20`    | Node version used to build `@petrpus/legal-docs`.                    |

## A caveat: this action currently rebuilds the library on every run

`@petrpus/legal-docs` is **not yet published to npm**, so `uses:
petrpus/legal-docs/actions/validate@main` checks out this whole repo and the action's first two steps
run `npm ci && npm run build` (~1–2 minutes) before validating your catalog. Once the package is
published, this collapses to:

```yaml
- run: npm i @petrpus/legal-docs
- run: npx legal-docs validate --catalog legal-docs
```

and this composite action becomes a thin, fast wrapper around that. No code change needed on your side
when that day comes — just drop the `uses:` line for the two commands above (or keep using the action,
which will be updated to match).

## Annotations are message-only

A finding's `path` (e.g. `templates/nda › body[1]`) is a **logical** location in the catalog, not a
file path — so annotations are emitted as `::error title=legal-docs::<path>: <message>` without a
`file=`/`line=` property (which would misplace or drop the annotation). They show up in the PR's Checks
summary rather than inline on a diff line.
