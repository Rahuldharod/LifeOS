# LifeOS design system: decisions from the first grilling session

**Status:** Page-layout discovery and production specification are approved. Production implementation remains. Recorded 10 October 2026 on `codex/design-system-prototypes`. These are design decisions, not a production UI release.

## Purpose and experience

- Help the user make daily decisions quickly. The interface should feel calm, supportive, clean and modern.
- Improve the information architecture where needed; keep the product neutral rather than tied to an employer brand.
- Design for desktop first, with comfortable spacing and denser rows only for long lists.
- Use sans-serif type throughout. Target WCAG 2.2 AA, including keyboard focus, contrast and reflow at zoom.
- Build the light theme first, with named colour roles that can support a later dark theme.

## Chosen colour direction

Option A from `apps/web/palette-prototype-blue-accents.html?variant=A` is the approved palette comparison. The user found the earlier yellow and cream backgrounds too warm. Use a subtle warm-neutral canvas.

| Intended role shown in the mockup | Colour |
| --- | --- |
| Dark navigation and strongest text | `#201E43` |
| Primary buttons and links | `#134B70` |
| Selected navigation and focus accents | `#5473A1` |
| Quiet secondary surface | `#EEEEEE` |
| Supporting warm-neutral canvas | `#F8F6F4` |
| Content surface | `#FFFFFF` |

The first four colours are the selected palette. The final two are supporting neutrals from the comparison. Colour roles still need production contrast checks across all states. Do not rely on colour alone to communicate state.

## Navigation and workflows

- Use a dark, **text-only** sidebar. First section: Today, Calendar, Tasks, Notes and Inbox. Add a visible divider. Second section: Decisions, Open Points and Knowledge. Keep Settings at the bottom.
- Put Projects, Clients, Products and People in dedicated Settings sections. They are reference data, not frequent destinations. Keep direct contextual links to individual records from meetings, tasks and other relevant objects.
- Keep global Capture and Search easy to reach. Global search covers Tasks, Meetings and Notes.
- Today leads with priorities and makes the next meeting visible. Task rows support opening the task and quick completion.
- Tasks has My Tasks, Waiting on others and All views, with filters and sorting.
- On desktop, Tasks, People and Projects use list/detail interaction patterns. This does not decide their exact page layouts.
- Notes autosave. Structured forms use an explicit Save action.

## Layout decision boundary

The user liked the *feel* of the spacious Today example in prototype G and requested the expanded, text-labelled navigation seen in H. The later three-option comparison changed the accent blue while holding that example layout constant. **No page layout has been approved for production in this session.** The chosen prototype is a visual reference for the next round, not a template to copy across pages.

All prototype content is synthetic and non-persistent. The latest reference is `apps/web/palette-prototype-blue-accents.html?variant=A`. Earlier comparisons remain on the prototype branch as source material.

## Approved layout foundations

Approved in the second grilling session on 10 October 2026:

- **Overall structure:** use the task-led split direction (layout prototype A). List and context areas stay compact while the active working area gets more space. This is the starting grammar for list/detail workspaces, not a requirement that every page use two columns.
- **Today:** use the priority-first direction (Today prototype A). The Top 3 is dominant; the next meeting and Quick Capture remain visible beside it. Supporting counts and warnings stay secondary.
- **Settings:** use a grouped left section rail with the selected section opening in a right-hand workspace (Settings prototype A). The approved top-level groups are My LifeOS, Connections, Data & devices and Reference data.
- Projects, Clients, Products and People remain inside Settings under Reference data. They use a consistent browse-and-edit pattern and remain reachable through contextual links elsewhere.
- **Calendar and Notes:** keep a persistent, resizable list/detail split on desktop so day or note context remains visible while editing.
- **Tasks and reference data:** use a browseable list on the left and the selected record editor on the right. Do not expand full editing forms inside every list row.
- **Inbox:** use a review queue on the left and one focused proposal on the right, with its source, evidence and Accept/Reject controls kept together.
- **Decisions and Open Points:** lifecycle actions expand inside the selected record. Resolve, Supersede and Close should not hide the record and its evidence behind a modal.
- **Knowledge:** make the published knowledge list/detail workspace primary. Preserve Source opens a focused intake panel rather than permanently sharing equal page weight.
- **Global Capture and Search:** place persistent labelled actions directly below the LifeOS name in the expanded sidebar.
- **Collapsible navigation:** allow the dark sidebar to collapse. Expanded navigation remains text-only; collapsed navigation uses monochrome destination icons with accessible names and an explicit expand control.
- **Meeting proposals:** place proposals below the meeting editor. Notes remain the primary work area and proposals follow from them; do not add a permanent third column or hide them behind a mode tab.
- **Filters:** place common filters compactly above the list, with advanced filters collapsible. Do not reserve a permanent page column for filters.
- **Record creation:** New Task, New Decision and equivalent actions open a blank record in the right-hand workspace. Creation and editing use the same form rather than a quick-create row or modal.
- **State and error placement:** show app-wide states such as offline and read-only in a page banner. Show field and workflow errors beside the affected control. Temporary success feedback may remain lightweight, but must not be the only presentation of a persistent problem.
- **Narrow-screen list/detail:** show the list first, then navigate to a full-width detail screen with a visible Back action. Do not stack a long list above the detail or cover it with a drawer.
- **Destructive actions:** keep Delete, Close, Reverse and similar actions in a secondary More menu, followed by explicit confirmation. Permanent deletion and other irreversible operations require the strongest confirmation wording.
- **Structured-form actions:** use a sticky action bar at the bottom of the detail workspace for Save, Cancel and dirty-state feedback. Notes keep their separate autosave status.
- **Task completion:** show an always-visible checkbox in task lists. Clicking the rest of the row opens the task detail.
- **Unsaved structured forms:** block navigation with Save, Discard and Stay choices. Do not silently discard, silently retain, or autosave structured-form changes.
- **Notes editor default:** always open notes in Visual mode. Markdown and Preview remain explicit modes available from the editor.
- **Unpersisted calendar events:** selecting an event opens an unsaved meeting-note preview. Create the canonical meeting and note only on the first edit.
- **Settings save boundary:** each selected Settings section saves independently. Do not use a page-wide Save or immediate saving for every control.
- **Record utilities:** place History and Copy link in the More menu. Keep sensitivity visibly labelled near the record metadata because it changes downstream behaviour.
- **Global Search interaction:** open Search as an overlay command palette with grouped results. Preserve the current page behind it and support efficient keyboard use.
- **Global Capture interaction:** open Capture as a focused side panel over the current page. Provide room for optional context without navigating away.
- **Today row actions:** keep Complete and More visible on each Top 3 row. Put Pin, Replace and Dismiss inside More.
- **Conflict resolution:** show browser and disk versions side by side on desktop and stacked on narrow screens. Offer an optional diff mode for precise comparison without making the technical diff the default.
- **Save and workflow feedback:** keep a persistent inline Saved state near the relevant action and add a brief notification when a discrete workflow completes.
- **Empty and loading states:** use purpose-specific empty copy with one relevant action. Use skeleton rows while loading so the page layout remains stable.
- **Calendar date controls:** place Previous day, Today, Next day and a date picker above the timeline.
- **Capture panel content:** show one capture field and Save initially, with optional details expanding below. Do not begin with a full form or require object-type selection first.
- **Information density:** use one comfortable density throughout. Long lists use concise rows without adding a user-facing density preference.
- **Forms:** place labels above controls. Use two columns for related fields on wide screens and one column on narrow screens.
- **Surfaces:** use white content surfaces, thin borders and minimal shadow. Reserve stronger shadows for overlays such as Search and Capture.
- **Sidebar preference:** remember collapsed or expanded state on this device only. Do not sync it or vary it by page.
- **Keyboard shortcuts:** use `Cmd/Ctrl + K` for Search and `Cmd/Ctrl + Shift + C` for Capture.
- **Icon policy:** use icons only where they materially improve recognition. Action text remains visible; do not add icons to every button.
- **Filter allocation:** keep recurring controls visible and relationships or date ranges behind Advanced filters:
  - Calendar: day navigation, date and calendar always visible.
  - Tasks: My Tasks, Waiting on others and All views plus search and sort visible; status, priority, project and due period advanced.
  - Notes: search and note type visible; project, person and updated date range advanced.
  - Inbox: search and proposal type visible; source meeting and created period advanced.
  - Decisions and Open Points: search and status visible; project, client, product, person and date range advanced.
  - Knowledge: search and area visible; source type, published period, project and person advanced.
  - Settings and reference data: simple search only.

The review prototype for these decisions is `apps/web/layout-prototype.html`. It uses the approved palette and navigation, synthetic data and no persistence. A prototype wiring issue that initially prevented Settings sections from opening in the right-hand workspace was corrected after the decision.

## Remaining before production implementation

No further product-level page-layout decision is currently open. The production specification is [GitHub issue #127](https://github.com/Rahuldharod/LifeOS/issues/127). Its approved implementation sequence is:

1. [Design tokens and application shell — #129](https://github.com/Rahuldharod/LifeOS/issues/129)
2. [Tasks workspace and reusable list/detail foundation — #130](https://github.com/Rahuldharod/LifeOS/issues/130)
3. [Global Search and Capture — #131](https://github.com/Rahuldharod/LifeOS/issues/131)
4. [Priority-first Today — #132](https://github.com/Rahuldharod/LifeOS/issues/132)
5. [Calendar workspace — #133](https://github.com/Rahuldharod/LifeOS/issues/133)
6. [Notes workspace and conflict comparison — #134](https://github.com/Rahuldharod/LifeOS/issues/134)
7. [Inbox review workspace — #135](https://github.com/Rahuldharod/LifeOS/issues/135)
8. [Decisions and Open Points workspaces — #136](https://github.com/Rahuldharod/LifeOS/issues/136)
9. [Knowledge workspace — #137](https://github.com/Rahuldharod/LifeOS/issues/137)
10. [Grouped Settings workspace — #138](https://github.com/Rahuldharod/LifeOS/issues/138)
11. [Connections and Data & devices Settings — #139](https://github.com/Rahuldharod/LifeOS/issues/139)
12. [Reference data inside Settings — #140](https://github.com/Rahuldharod/LifeOS/issues/140)
13. [Accessibility, responsive and release validation — #142](https://github.com/Rahuldharod/LifeOS/issues/142)

GitHub's native blocking relationships define the implementation frontier. Start with issue #129, then work any unblocked `ready-for-agent` ticket. The remaining production work is:

1. Convert the approved direction into named typography, spacing, radius, border, focus and colour-role tokens. Confirm every interactive state meets WCAG 2.2 AA contrast requirements.
2. Specify reusable list rows, detail headers, sticky action bars, form controls, banners, empty states, skeletons, confirmations, Search and Capture overlays.
3. Validate the chosen list-to-detail narrow-screen behaviour on representative Calendar, Tasks, Notes, Inbox and Settings flows at reflow and zoom breakpoints.
4. Define the dark-theme mappings for the named colour roles without building a dark theme in this phase.
5. Rewrite the approved prototype patterns as production components. The prototype remains throwaway reference code and must not be promoted directly.
6. Run keyboard, screen-reader, focus-order, reduced-motion, reflow and production-build checks across every destination and state before release.

See `README.md`, `docs/product-design/LifeOS_Solution_Design_v0.8.md` and `docs/architecture/README.md` for the existing product and implementation boundaries.
