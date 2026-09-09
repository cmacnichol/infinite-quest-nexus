# Task 7B Web Awesome CSS review

## Decision

**Accepted after source, local geometry, fresh Web Awesome42, screenshot
review, and Controller D's final E2E review.** The initial source acceptance
was superseded by a mobile browser probe, then restored after the final
selector fix. This document keeps both stages as evidence and closes the
Task 7 CSS/browser acceptance path.

The initial review covered only the frozen Web Awesome CSS amendment and its
focused cleanup unit test:

- `apps/web-next/src/story/ui/composer.css`
- `apps/web-next/src/story/ui/turn-length.css`
- `apps/web-next/src/story/ui/secondary-controls.css`
- `apps/web-next/src/story-player.css`
- `tests/unit/web-next-quiet-leaf-composer.test.ts`

## Findings

The original container-query direction was insufficient for the desktop
failure: `.quiet-leaf-footer` spans the prose and artwork columns, so its
inline size does not represent the squeezed composer group. The amended grid
now explicitly assigns the composer DOM order as `retry primary history`.
This gives the primary controls the flexible center column rather than letting
History take it through implicit placement. The primary group can wrap when
constrained, while the footer-sized container query supplies the narrow,
two-row footer arrangement.

The initial source review incorrectly concluded that the mobile Web Awesome
Details override won the cascade. The failed browser probe measured the
select at only `38.1px` wide while Details consumed `225.9px`, confirming
that the duplicated mobile label squeezed the selector. The cause was selector specificity across loaded stylesheets:
`secondary-controls.css` has a `:is()` selector whose highest-specificity
argument, `.quiet-leaf .story-reader-toolbar button`, gives the whole selector
specificity `0,3,2`; the initial mobile Details override was `0,3,1`. Source
order did not overcome that difference.

The final mobile selector is
`main[data-ui-implementation="web-awesome"] .quiet-leaf-footer .quiet-leaf-composer-footer button.story-turn-length__details`
in `turn-length.css`. Its `0,4,2` specificity exceeds the generic `0,3,2`
rule across the loaded stylesheets, so it restores the intended `font-size: 0`
for the original trigger text. The `::after` label remains the visible compact
text.

The dialog's staged `wa-select` remains outside the Details trigger selector,
and the obsolete confirmation selectors were removed from `composer.css`,
`secondary-controls.css`, and `story-player.css`. The fourth stylesheet,
`turn-length.css`, supplies the mobile correction. The focused cleanup unit
test checks that retired selectors do not return.

## Evidence and remaining gate

Root's final focused source run reported **192/192** tests across 12 files at
the final 29-file source freeze
`84fa8072a1505e651dbca4e623b6abc9c8910adae203e5330741bd11c53e57fd`.
The final cascade-only selector was also reviewed against the competing loaded
rule and passed `git diff --check`; root repeated the full 192/192 run after
the correction.

After A's local rebuild `aa9cf0`, the mobile probe is green: the select is
`185.83px × 71.19px`, Details is `78.17px × 44px`, the original text range is
`0px × 0px`, and the pseudo-label font is `11.52px`. Both controls are within
the viewport and do not overlap. Desktop is also green with select
`511.66px` wide and Details `176.72px` wide. These values are local rendered
geometry evidence. The subsequent Web Awesome42 aggregate passed 42 cases in
1.4 minutes against the final asset, and root verified the desktop/mobile
opening captures and mobile visible-profile capture. The latter visibly shows
saved Story Direction. This evidence does not establish live-provider quality.
