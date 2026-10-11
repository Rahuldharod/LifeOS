# LifeOS design system: approved decisions

**Status:** The page-layout direction was approved on 10 October 2026. The visual-system and responsive-layout refinement was completed on 11 October 2026 and published as [GitHub issue #154](https://github.com/Rahuldharod/LifeOS/issues/154). The decisions below supersede the earlier palette and responsive assumptions.

## Purpose and experience

- Help the user make daily decisions quickly. The interface should feel calm, supportive, clean and modern.
- Improve the information architecture where needed; keep the product neutral rather than tied to an employer brand.
- Design for desktop first, with comfortable spacing and denser rows only for long lists.
- Use sans-serif type throughout. Target WCAG 2.2 AA, including keyboard focus, contrast and reflow at zoom.
- Build the light theme first, with named colour roles that can support a later dark theme.

## Chosen colour direction

The approved direction is **dark-blue ocean luxury**: warm, comfortable, calm and modern. This supersedes the earlier purple/blue Option A palette and its future dark-theme mapping.

| Settled palette role | Colour |
| --- | --- |
| Navigation / deepest blue | `#0B1F33` |
| Primary ocean blue | `#123E5A` |
| Supporting ocean teal | `#2E6F73` |
| Warm accent | `#8E522F` |
| Warm canvas | `#F6F1E8` |

The supporting neutral, focus and interaction-state roles are defined in the approved foundations below. Do not rely on colour alone to communicate state.

The approved semantic notification treatment is **Deep tint**:

| Meaning | Text | Fill | Border |
| --- | --- | --- | --- |
| Success | `#163C2D` | `#C9DED2` | `#4F8069` |
| Error | `#681F28` | `#EBCAC9` | `#A94D55` |
| Warning | `#583316` | `#E9D0B5` | `#A66A32` |
| Information | `#123E5A` | `#C9DDE2` | `#3E7480` |

The text/fill pairs measure approximately 7.4:1–8.7:1. Every semantic notification also has an icon and visible label. Reserve stronger solid semantic treatments for actions whose consequence has that meaning, such as final destructive confirmation.

### Production token contract (#129, remapped in #154)

The production UI defines these roles in `apps/web/src/design-tokens.css`. Components use role names rather than palette values; no production stylesheet carries a raw palette value.

| Token family | Named roles |
| --- | --- |
| Colour | canvas, surface, quiet and raised surface, text, muted and inverse text, border (decorative) and strong border (interactive), primary with hover and active, link, selection, accent and warm accent, focus and focus-on-dark, disabled surface/border/text, success/error/warning/information text, fill and border, danger, scrim, sidebar roles |
| Typography | system sans and mono families; xs (13px) to 2xl sizes plus an editor size; tight, body (1.55) and editor (1.65) line heights |
| Layout | seven spacing steps; small, medium, large and pill radii; thin and strong borders; minimum target; canvas cap; reading, form and editor measures; sidebar widths |
| Elevation and focus | surface, raised and overlay shadows; a focus ring for light surfaces and one for dark navigation |

The responsive bands, short-height threshold and list clamps live in `apps/web/src/workspaceLayout.ts`. The shell publishes the result as `data-band` and `data-height`, so CSS and the accessible `hidden` state of list and detail panes always agree.

Dark theme remains deliberately unshipped. The earlier purple dark mapping is removed; a later dark-theme ticket must derive a new ocean mapping and re-check every component state before exposing a theme preference.

### Implementation status (#154)

Implemented and covered by the Playwright browser seam (`tests/browser/`, `pnpm test:browser`) and focused component tests:

- Ocean light roles, Deep tint semantic roles, action hierarchy (filled primary, outlined secondary, text tertiary), explicit disabled colours, width-stable loading with `aria-busy`, and the solid final destructive confirmation.
- Workspace-width bands with the narrow top bar (Menu, Search, Capture) and navigation sheet, the short-height treatment, the 1,880px canvas cap and the reading, form and editor measures.
- Per-workspace list clamps with a keyboard-operable divider remembered per workspace on this device and reset on double-click or Enter; the Settings section rail stays fixed.
- Narrow list → detail with Back, focus on the detail heading after opening, and restored row focus and list scroll after Back. Knowledge Notes now have direct links like other records.
- Skip link, overlay focus containment and return, reduced-motion handling, wide internal rails for Inbox evidence, Decision and Open Point relationships and Knowledge sources, and Reference data list/detail only in the standard and wide bands.

Left to #142: manual Safari, Chrome and VoiceOver checks, actual 200% and 400% browser zoom, contrast review of every interactive state on real displays, and reduced-motion review.

### Approved visual and responsive foundations

Approved on 11 October 2026 during the refinement interview:

- **Surface hierarchy:** place white primary content surfaces on the warm canvas. Use warmer quiet surfaces, thin borders and restrained shadow for secondary separation rather than flattening everything onto the canvas.
- **Core colour responsibilities:** use the deepest blue for navigation and strongest text, ocean blue for primary actions and links, ocean teal for selection, focus and supporting emphasis, and warm brown sparingly for editorial emphasis. Warm brown is not the general action or warning colour.
- **Semantic strength:** use the Deep tint system for banners, inline errors and status treatments. Reserve solid semantic colour for actions whose consequence has that meaning, such as the final destructive confirmation. Keep icons and visible labels alongside colour.
- **Action hierarchy:** allow one filled primary action per action area, followed by outlined secondary actions and text-style tertiary actions. Show destructive emphasis only when the destructive choice is relevant. Loading keeps the control width and action context stable.
- **Responsive coordinates:** respond to usable workspace width after the sidebar, not named devices. Initial bands are narrow below 760px, compact from 760–1,199px, standard from 1,200–1,799px and wide from 1,800px. Apply an independent short-height treatment below 900px.
- **Wide-screen boundary:** cap the purposeful working canvas around 1,880px and use balanced outer margins beyond it. Add useful columns only where the content supports them; keep reading, form and editor measures roughly 900–1,200px.
- **Supporting neutral roles:** use `#FFFFFF` for primary surfaces, `#EAE4D8` for quiet surfaces, `#53636A` for muted text, `#D8D1C4` for decorative separation and `#7B8587` for interactive control borders. Use ocean teal for focus on light surfaces and white for focus on dark navigation.
- **Navigation reflow:** preserve the user's expanded-or-collapsed sidebar preference throughout compact, standard and wide bands; do not force laptop users to collapse it. In the narrow band, replace the sidebar with a top bar exposing Menu, Search and Capture; Menu opens the navigation sheet.
- **Short-height treatment:** below 900px, reduce header, padding and banner height while preserving text sizes and control targets. Let panes scroll independently, keep important actions sticky and retain visible actions on warnings.
- **Semantic placement:** use tinted banners for page-level conditions, place field and workflow errors beside the affected control, show routine save state as calm persistent inline text, and reserve brief notifications for discrete workflow completion.
- **Pane sizing:** use workspace-specific minimum and maximum widths for list panes rather than permanent percentages. Give the detail pane the remaining space; in the narrow band, navigate from list to full-width detail and back.
- **Compact toolbars:** wrap common controls before they clip. Keep search and the most frequent controls first, and move Advanced filters to their own line as space tightens.
- **Internal content measures:** allow the surrounding detail pane to grow while keeping reading content near `75ch`, structured forms near `900px` and rich editors near `1,200px` maximum width.
- **Button states:** primary actions use ocean blue by default, brighten to `#2A718E` with a subtle lift and shadow on hover, and deepen with a one-pixel press treatment when active. Focus adds the approved context-aware ring. Disabled controls use explicit readable colours rather than global opacity. Loading retains control width and action context. Final destructive confirmation uses the solid error treatment only after the destructive path is chosen.
- **Workspace list clamps:** use 460–640px for Tasks, 320–480px for Calendar, 360–520px for Notes, 380–520px for Inbox, 380–560px for Decisions and Open Points, 360–520px for Knowledge, 240–320px for the Settings section rail and 320–480px for Reference data lists.
- **Resizable panes:** primary list/detail workspaces share a bounded divider whose position is remembered per workspace on this device and resets on double-click. Keep the outer Settings section rail fixed; allow the nested Reference data list to resize.
- **Wide-screen columns:** preserve master/detail as the default grammar. Today may use three purposeful columns, and content-rich detail may add an internal evidence or relationships rail. Do not add a third column merely to fill available space.
- **Today reflow:** never stretch Top 3 to match taller neighbouring content. Keep priorities first on narrow screens; allow three purposeful columns on wide screens for Top 3, next meeting/Capture and supporting day context.
- **Tasks, Calendar and Notes reflow:** use the approved list clamps, independent pane scrolling and narrow list-to-detail navigation. Keep forms, editors and prose within their approved internal measures. Calendar proposals remain below the editor; Note conflict versions stack only in the narrow band.
- **Inbox, Decisions, Open Points and Knowledge reflow:** preserve a focused record workflow on narrow screens. On wide screens, supporting evidence, relationships or Sources may form an internal rail inside the record detail, never a universal app-level pane.
- **Settings reflow:** keep the outer section rail stable. Show nested Reference data list/detail only when it fits; compact and narrow layouts navigate through successive section-to-content and list-to-detail steps rather than squeezing three columns.
- **Zoom and reflow:** at 200% and 400% zoom, move naturally through the approved responsive bands without page-level horizontal scrolling. Only inherently two-dimensional content may scroll inside its own bounded region.
- **Keyboard movement:** provide a skip link past navigation. Opening detail moves focus to its heading; Back restores the originating list row and scroll position. Overlays trap focus and return it to their trigger.
- **Typography and targets:** use the system sans family with no separate font preference in this phase. Use 16px/1.55 for UI body text, 17px/1.65 for the long-form editor and never less than 13px for supporting text. Interactive targets are at least 40px on desktop and 44px for coarse pointers.
- **Assistive feedback and motion:** keep visible status and assistive announcements in the same state. Announce routine progress politely; treat errors immediately and identify their affected control. Reduced-motion removes non-essential movement without hiding state changes.
- **Surface geometry:** preserve the established 4, 8, 12, 16, 24, 32 and 48px spacing steps; 6px small, 8px control, 14px surface and pill radii; thin borders; restrained surface shadows; and stronger shadows only for overlays.
- **Theme scope:** complete and validate the light theme in this refinement. Keep role names theme-ready, but defer a new ocean dark mapping to a separate prototype and contrast-validation task rather than preserving or guessing from the superseded purple mapping.
- **Implementation route:** implement [issue #154](https://github.com/Rahuldharod/LifeOS/issues/154), the `ready-for-agent` child of #127. Keep closed issue #129 as historical evidence. Issue #154 blocks #142 release validation.
- **Highest automated test seam:** add one Playwright browser seam against the built LifeOS app, localhost API and synthetic data. Cover real CSS layout, responsive band boundaries, clipping, page-level overflow, keyboard movement, focus restoration and accessible states there. Preserve focused component tests for detailed behaviour; #142 retains manual Safari, Chrome, VoiceOver and actual 200%/400% zoom validation.

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

## Production implementation frontier

No further product-level visual or responsive decision is open for this phase. The active specification is [GitHub issue #154](https://github.com/Rahuldharod/LifeOS/issues/154), linked as a child of the parent design-system issue [#127](https://github.com/Rahuldharod/LifeOS/issues/127) and labelled `ready-for-agent`.

Implement and verify #154 before completing [accessibility, responsive and release validation — #142](https://github.com/Rahuldharod/LifeOS/issues/142). GitHub records #154 as a blocker for #142.

The dark ocean theme remains a separate future prototype and contrast-validation task. Production code must use theme-ready role names, but this phase ships only the validated light theme.

See `README.md`, `docs/product-design/LifeOS_Solution_Design_v0.8.md` and `docs/architecture/README.md` for the existing product and implementation boundaries.
