# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close an issue**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`; `gh` does this automatically when run inside this clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** Set this to `yes` if the repository later treats external pull requests as feature requests.

When set to `yes`, pull requests run through the same labels and states as issues:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>`
- **List external PRs**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`, retaining only `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, and `NONE`
- **Comment, label, or close**: use `gh pr comment`, `gh pr edit`, and `gh pr close`

GitHub shares one number space across issues and pull requests. Resolve an ambiguous number with `gh pr view <number>`, falling back to `gh issue view <number>`.

## Skill operations

When a skill says “publish to the issue tracker,” create a GitHub issue.

When a skill says “fetch the relevant ticket,” run:

`gh issue view <number> --comments`

## Wayfinding operations

The map is one issue with child issues as tickets.

- **Map**: an issue labelled `wayfinder:map` containing Notes, Decisions-so-far, and Fog.
- **Child ticket**: a GitHub sub-issue linked to the map. Where sub-issues are unavailable, add it to a task list in the map and add `Part of #<map>` to the child. Use a `wayfinder:<type>` label: `research`, `prototype`, `grilling`, or `task`.
- **Blocking**: use GitHub’s native issue dependencies. Where unavailable, add `Blocked by: #<number>` to the child.
- **Frontier query**: inspect the map’s open children, excluding assigned tickets and tickets with open blockers. The first remaining ticket in map order wins.
- **Claim**: `gh issue edit <number> --add-assignee @me`
- **Resolve**: comment with the answer, close the child, and append a context pointer to the map’s Decisions-so-far section.
