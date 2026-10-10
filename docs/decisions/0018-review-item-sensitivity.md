# ADR 0018: A Review Item is as restricted as what it was drawn from

- Status: Accepted
- Date: 2026-10-10
- Source: issue #122 (one Review Item factory), user decision of 2026-10-10
- Extends: ADR 0010 (`sensitivity` on the Object Envelope)

## Context

ADR 0010 restricts objects, but says nothing about the Review Items proposed from them. Before #122 only Adoption copied sensitivity onto an item, so a proposal drawn from a restricted meeting note or Source could show restricted content wherever pending items are listed. Accepting such an item then made a normal object out of restricted content.

## Decision

**A Review Item is restricted when anything it was drawn from is restricted:**

- a Source it cites (`source_ids`);
- a Source named in its field evidence;
- the meeting it came from, counted as a restricted meeting (the meeting or its note, ADR 0010 and #63);
- its target (the object a change, link or summary is for);
- any other object it reads (the two people of a merge suggestion);
- or the proposer marks it restricted (a draft's own `sensitivity`).

Otherwise it takes the proposer's sensitivity, normally none.

**The rule is applied when the item is written and again when a step revises its own pending item** (a newer meeting summary that adds Sources). A revision never makes a restricted item normal again. Both go through the one Review Item module (`proposeReviewItem`, `reviseReviewItem`).

**Accepting a restricted item creates or updates a restricted object**, whatever its proposed fields say. Nothing restricted turns normal by being accepted.

## Consequences

- Restricted proposals show the lock badge and stay out of everything ADR 0010 excludes, like the objects they came from.
- A user who restricts a Source after a proposal was raised does not change that proposal's flag until a step revises it; acceptance checks that stay strict on their own (a summary for a meeting restricted since, #63) are kept.
- An object can only become normal again by the user changing its sensitivity, never as a side effect of a proposal.
