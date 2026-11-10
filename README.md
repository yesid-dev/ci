# yesid-dev CI

Small, owned CI pieces. MIT. Node 24+ and GitHub CLI for rulesets; composite
consumers need Node 24+ and Bash (Git for Windows supplies Bash on Windows).
Run `npm run check` and `npm test`; there are no package dependencies.

Pin every external use to a reviewed commit SHA. `v1` identifies the first
verified release; use its resolved SHA in consumers.

- `actions/eta`: pass `token`, the exact unique `job-name` from the jobs API
  (include matrix values), and a Bash `command`. Grant `actions: read`. The
  command runs with errexit and pipefail and its exit code is preserved.
  The summary reports p50/p90 finish times measured from job start, using up to
  20 successful main jobs in the same workflow. Linear interpolated percentiles;
  failed, skipped and invalid samples are excluded. No history is reported as
  unavailable. While the command runs, the active step warns once if job
  elapsed time passes p90. Wrap the long part of the job in this action so the
  warning remains live; it cannot observe later, separate workflow steps.
- `actions/await-artifact`: grant `actions: read`; pass `token`, `name`, and
  `timeout-seconds` (default 120, maximum 3600). Polls only this run, across pages,
  excluding expired artifacts. Outputs `artifact-id` for a later download step.
  Missing artifacts, API failures and invalid bounds fail clearly. No download
  or retry of failed API requests is hidden inside the action.
- `.github/workflows/gitleaks.yml`: reusable Linux x64 job, named `gitleaks`,
  gitleaks 8.30.1 with its SHA256 checked. Call on `pull_request`, `merge_group`
  and main `push`; use `full-history: true` on schedules/manual runs. Always
  scans the current tree, then the event's commit range (new branches or missing
  push bases use full history). Optional `config` selects the consumer's config.
  The caller needs `contents: read`. Reusable workflows may display the caller
  job prefix in the check name. Consumers requiring exactly `gitleaks` should
  add a job with that name which asserts the reusable scan succeeded.

Rulesets are **not automatically applied**. `rulesets/repos.json` records live
main ruleset IDs, checks (including app bindings), and queue timeouts, read on
2026-11-10. Re-read before applying because other slices change them. Repositories
without a main ruleset are omitted. The template adds the standard queue and
turns strict up-to-date off; these are visible proposed changes in `diff`.

```sh
node scripts/rulesets.mjs diff yesid-dev/yesid.static-template
node scripts/rulesets.mjs apply yesid-dev/yesid.static-template
```

`diff` only reads. `apply` updates the configured main ruleset and verifies API
readback. It requires a separately authorized administration token. It does not
create rulesets or change tags, other repositories, or classic protections.
`plannedRequiredChecks` documents the static-template adoption's future
`gitleaks` requirement and is deliberately ignored by apply. After the adoption
is merged and the actual check context is verified, its owner can promote that
entry to `requiredChecks` in a separately reviewed change. No settings change
is part of this release.
