<!--
This template appears automatically on every new PR. Fill in each section.
Delete sections that genuinely don't apply, but don't delete the whole template —
the structure helps future-you and your teammate review faster.
-->

## Issue

<!-- Link the Issue this delivers: `Closes #123` (the leaf issue) — auto-closes it and
     moves its Project card to Done on merge. A throwaway single-file fix can skip this;
     anything bigger should have an Issue first (see AGENTS.md → Task tracking). -->
Closes #

## What changed

<!-- Bullet list of the actual code/config changes. Keep it short. -->


## Why

<!-- The problem this PR solves, OR the requirement it implements.
     If it's a fix, link the failing run / Sentry issue / incident.
     If it's a feature, link the spec or describe the user-facing outcome. -->


## How tested

<!-- One or more of:
  - [ ] CI is sufficient (pnpm lint / build / test / test:e2e all pass)
  - [ ] Manually exercised via `make dev` at <route or scenario>
  - [ ] Tested against Oracle staging at <url>
  - [ ] Ran rollback drill via Actions -> "Rollback to a previous deploy"
  Add specific verification steps so reviewer can replay if curious. -->


## Risk / rollback plan

<!-- What can break in production, and how to recover.
     Skip if change is internal only (no prod behavior change).
     For prod-affecting changes:
       - What's the blast radius if this is wrong?
       - Is the change reversible by `git revert` + redeploy?
       - Does it require a data migration that can't be reversed? -->


<!--
Notes for the reviewer:
- Squash-merge is the default; this PR's description becomes the squash commit message.
- Slack will post the merge result; no need to monitor manually.
- If branch protection blocks you, see .github/BRANCH_PROTECTION.md for bypass rules.
-->
