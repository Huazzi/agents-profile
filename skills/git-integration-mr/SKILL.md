---
name: git-integration-mr
description: Commit a scoped fix, create and push a temporary integration branch, merge it into a specified target branch, and prepare a manual GitLab or GitHub MR link, title, and Chinese description. Use when a user asks to merge a fix through an integration branch but wants to create the MR themselves.
---

# Git Integration MR

Use this skill to bring a scoped source-branch fix into a user-specified target branch through a new `merge/...` integration branch. Complete the Git work that can be completed safely; **do not create the MR** in a browser, with an API, or with a hosting-provider CLI.

## Scope and terms

- **Source branch**: the branch containing the fix. If the user does not name it, use the current branch only when it has an `origin/<source>` remote-tracking branch. Otherwise, ask for the source branch.
- **Target branch**: the required user-specified branch that will receive the MR, such as `release/1.2`. Treat `origin/<target>` as authoritative.
- **Integration branch**: a newly created branch whose full name starts with `merge/`, based on the fresh target branch. If the user supplies only a suffix, prefix it with `merge/`. If no name is supplied, use `merge/<source>-to-<target>` unless it would be ambiguous or collide with an existing local or remote branch.
- **MR**: a merge request or pull request whose source is the integration branch and whose target is the target branch.

The **description portion** of every commit message created by this skill must be written in Chinese. The commit type and optional scope may follow the repository convention and may be English. For example: `fix(worker)：<中文问题概述>` and `merge：将<待合并分支>合并到<目标分支>`.

## Required inputs and preflight

1. Establish the source branch, target branch, integration-branch name, a concise Chinese description of the fix, and the validation command(s) appropriate to the affected component. Ask only for information that cannot be discovered safely.
2. Confirm this is a Git repository and that `origin`, `origin/<source>`, and `origin/<target>` exist. Run `git fetch origin --prune` before comparing branch state.
3. Inspect `git status --short` and the relevant diff before staging. Stage **only files that belong to this fix**; never use `git add .` or `git add -A` by default.
4. Do not overwrite, discard, stash, reset, rebase, force-push, or delete work to make progress. If unrelated changes, an unexpected dirty working tree, branch divergence, missing permissions, or an unfamiliar branch state makes the intended change unclear, stop and describe the smallest manual decision needed.
5. Before committing, verify the source branch is not behind or diverged from `origin/<source>`. If it is, do not guess how to reconcile it; hand off to the user. A source branch that is only ahead because of the current local fix may be pushed normally.

## Commit and publish the source fix

1. While on the source branch, inspect the final patch and run `git diff --check`.
2. Run the scoped validation available for the affected component. Record the exact command and result. Do not report a test as passed if it was not run.
3. Stage the reviewed fix files explicitly, then create a concise Chinese commit, for example:

   ```bash
   git add <本次修改文件>
   git commit -m "fix(worker)：<中文问题概述>"
   ```

4. Push the source branch. Use the existing upstream when present; otherwise set `origin` as the upstream. Verify the working tree and upstream state afterwards.

## Create and merge the integration branch

Use this sequence after the source fix is safely committed and published:

```bash
git fetch origin --prune

git switch <目标分支>
git pull --ff-only origin <目标分支>

git switch -c <集成分支> origin/<目标分支>
git merge --no-ff -m "merge：将<待合并分支>合并到<目标分支>" origin/<待合并分支>
```

- Verify the target update is a fast-forward. If it cannot be fast-forwarded, do not resolve the target branch's history locally; hand it off.
- Confirm the integration branch does not already exist locally or on `origin` before creating it. Never repurpose an existing integration branch without the user's explicit instruction.
- Merge `origin/<source>` rather than a potentially stale local source branch.
- Preserve the explicit merge commit (`--no-ff`).

## Conflicts

When a merge conflicts, resolve it only if the repository context makes the correct result clear. The default governing principle is:

> 在不破坏合并目标分支既有业务逻辑和规则的前提下，引入本次修改内容。

Work from the target branch's behavior as the baseline. Compare both sides, identify the behavior that each hunk contributes, retain the target's unrelated rules, and introduce only the source's needed fix. Inspect the resolved diff and run the same relevant validation before staging the resolved files.

Finish a confidently resolved merge with a Chinese commit message:

```bash
git add <冲突文件>
git commit -m "merge：将<待合并分支>合并到<目标分支>"
```

Hand the conflict to the user instead of guessing when any of these are true:

- the correct business rule is ambiguous or both sides intentionally changed the same rule;
- a resolution would alter target-branch behavior outside the stated fix;
- tests, compilation, or static checks fail and the cause cannot be established from the affected code; or
- required configuration, database, deployment, or product decisions are unknown.

For a handoff, state the conflicted files/hunks, the competing behaviors, the safest recommendation, and the exact decision the user needs to make. Leave the repository in its conflict state unless the user directs otherwise.

## Verify and push the integration branch

Before pushing, inspect the merge diff against `origin/<target>` and run at least:

```bash
git diff --check origin/<目标分支>...HEAD
```

Also run the component's relevant build and tests when available. State actual outcomes, including failures or tests that were not added/run. Push only after validation succeeds or the user explicitly accepts a known limitation:

```bash
git push -u origin <集成分支>
```

Confirm that the remote branch now points at the expected integration-branch commit.

## Manual MR handoff

After the integration branch is pushed, provide all of the following, in Chinese:

1. **MR link** — determine the creation route after the successful `git push`; do not assume one GitLab path from `origin` alone.
   - **GitLab, preferred:** inspect the remote output from `git push`. If it contains a “To create a merge request … visit:” URL, treat that URL's path as authoritative for this GitLab deployment. Preserve its existing query parameters. If it does not include `merge_request[target_branch]`, append `merge_request[target_branch]=<已编码目标分支>` using `&` (or `?` if the URL has no query string). This handles self-hosted or legacy GitLab instances whose valid route is `/merge_requests/new` rather than `/-/merge_requests/new`.
   - **GitLab, no push hint:** derive the repository web URL from `git remote get-url origin`, but do not present a version-specific MR creation URL as verified. State the source and target branches and say the instance did not expose an authoritative MR creation route; ask the user to create the MR from the repository UI.
   - **GitHub:** `<仓库网页地址>/compare/<已编码目标分支>...<已编码集成分支>?expand=1`.
   - **Other or unrecognized hosts:** provide the repository web URL when derivable, plus source and target branches; say that the MR creation URL could not be inferred reliably.

   Never replace a push-provided GitLab MR route with the generic `/-/merge_requests/new` variant. A redirect to sign-in is not enough evidence that a candidate route will work for an authenticated user.
2. **MR title** — a concise Chinese title, normally `合并：将<待合并分支>的<修复主题>合入<目标分支>`.
3. **MR description** — use this structure, filling it only with verified facts:

   ```markdown
   ## 需求/问题简述

   <中文描述问题和触发条件>

   ## 修改内容

   - <实际改动 1>
   - <实际改动 2>

   ## 影响范围

   - <受影响模块或服务>
   - 无数据库变更 / <实际数据库变更>
   - 无配置变更 / <实际配置变更>
   - 无前端接口变更 / <实际接口变更>

   ## 验证

   - `git diff --check`：通过
   - <实际构建命令>：<实际结果>
   - <实际专项测试命令>：<实际结果；未新增时明确“未新增专项自动化测试”>
   - 测试场景：<已执行且确认的业务场景>

   ## 回滚

   回滚本 MR 并重新部署上一版
   ```

Do not invent validation results, affected scope, URLs, or deployment claims. Clearly tell the user that creating and submitting the MR remains their manual operation.

## Completion report

Report the source commit SHA, integration commit SHA, pushed branch names, validations and their real outcomes, and the MR link/title/description. If work is handed off, report only completed steps and the concrete blocker; do not claim the merge or MR is ready.


