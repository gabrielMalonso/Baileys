# Maintaining our Baileys SDK

This repository owns the modified SDK source, its tests and its compiled releases. Consumers install our validated package; they do not reconstruct upstream or maintain source patches themselves.

## Upstream updates

`upstream.json` pins the last integrated upstream npm release and Git commit. The daily **Update owned SDK from upstream** workflow checks npm's `latest`, fetches the old and new upstream commits, and applies their difference with Git's three-way merge. This preserves our modifications without depending on merge ancestry after squash merges. Fork-owned workflows, `maintenance/`, this guide and upstream metadata are excluded from the upstream delta.

Successful preparation opens or updates `automation/upstream-update`, explicitly targeting **gabrielMalonso/Baileys**. It never opens a PR in WhiskeySockets/Baileys. CI is explicitly dispatched with read permissions so bot-created PRs do not wait for workflow approval. Conflicts stop the workflow and remain visible for manual resolution; no force reset or silent patch skipping occurs. A branch changed by a human is preserved. Updates use manual squash merge after the required SDK and CLI checks pass.

## Checks and releases

Use Node 24.18.0 for maintenance and Yarn from `packageManager`:

```sh
corepack yarn install --immutable --mode=skip-build
corepack yarn lint
corepack yarn tsc -p maintenance/tsconfig.json
corepack yarn prettier --check 'maintenance/*' upstream.json OWNED_SDK.md '.github/workflows/*.yml'
node --test maintenance/*.test.ts
corepack yarn test --runInBand
corepack yarn build
node maintenance/sdk.ts pack
```

Tests are offline with fictional fixtures; no account/session is used. Bartender E2E is not configured as a gate. The CI preserves all upstream SDK tests plus our action, receipt and authenticated-edit regressions. The initial consolidation incorporates fixes previously used by What's CLI Next, including typed local echoes, listener isolation and broadcast receipt handling.

Every SDK candidate is also tested against the current `main` of the public CLI repository. The read-only **CLI compatibility** job downloads the exact tarball built by the SDK job, verifies its digest and installed provenance, and runs the CLI lint, formatting, types, full offline suite and final build verification. A disposable CLI checkout uses a local file dependency because this candidate has not been published; its release-pin check is replaced by candidate verification. The CLI revision is recorded in the job summary and release metadata. Both SDK and CLI checks are required before merging an SDK PR, and publication depends on both succeeding again on `main`.

After validation, a separate job publishes `baileys.tgz` and `sdk-release.json` in a GitHub Release tagged `sdk-FULL_COMMIT`. The package version includes the upstream version and our source commit. Its embedded `baileysFork` metadata identifies the source and upstream commits; the release manifest records SHA-512 integrity, the versioned download URL and `validatedCliCommit`. Existing release assets are never overwritten by the automation. Native GitHub immutable releases are not configured; integrity pinning protects consumers against changed bytes. This uses only this repository's GitHub token; it does not publish to npm or require upstream credentials.

The CLI pins that release URL and integrity through its lockfile and runs its own compatibility tests again on the dependency PR. Discovery by the CLI remains daily/manual, but candidate validation no longer waits for that discovery. A new SDK release does not automatically merge a CLI dependency update or deploy a runtime. A manual run of **Owned SDK CI** on `main` can retry an interrupted first publication. An incomplete or draft release requires manual inspection; retries deliberately preserve existing assets. Temporary package and merge outputs are retained in ignored `.tmp/` directories for diagnosis.
