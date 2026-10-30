# Zonos Dispute Researcher (Tools)

A Tampermonkey script for the Zonos broker portal (brokerage.dashboard.zonos.com). It adds a **Tools** panel to every portal page: research for disputes and Entry Writer Queue orders, Classify, Quote, Analytics and the Entry Assistant site. It also adds an optional rebuilt work queue.

**No keys are built in.** Each person adds their own under Settings, and every part is optional. Changes to the portal's own pages are **off** until you turn them on.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome.
2. Go to `chrome://extensions`, open Tampermonkey's **Details**, and turn on **Allow User Scripts**. On older Chrome versions, turn on **Developer mode** instead.
3. Open the install link and click **Install** (or **Update**, if you have the old Dispute Researcher):
   **https://gist.githubusercontent.com/kars3n-zonos/9dd13b6c4c3ea4d1d6a876d45002c0a3/raw/zonos-dispute-researcher.user.js**
   (A secret link: share it only with people who use Tools. This repo is private; the link keeps working for Tampermonkey.)
   (If you installed "Zonos Dispute Desk (Sheets)" from `zonos-dispute-desk-sheets.user.js`, keep it: since 7.17.0 it's the same script. Install only one of the two.)
4. When Tampermonkey asks to allow a connection, choose **Always allow domain**.
5. Under Settings (⚙) > Back up or move your setup, paste the setup block from Karsen and press **Import**. It connects you to the team's Google Sheet.

Updates install automatically: Tampermonkey checks this repo about once a day. To update right away, use Tampermonkey's **Check for userscript updates**.

Cases are tracked in the team's **Google Sheet** (since 7.17.0): one row per case, a Google Doc per case, and Comments, Prompts and Research tabs.

For the maintainer:
- Edit only `zonos-dispute-researcher.user.js`. On every push to `main`, a GitHub Action runs `build-sheets.ps1`, commits `zonos-dispute-desk-sheets.user.js` (the same script under its own name and update address), and publishes both to the secret gist Tampermonkey installs and updates from (needs the `GIST_TOKEN` secret, a token with only the "gist" scope).
- Raise `@version` with every change pushed to `main`, or Tampermonkey won't install it.
- The sheet's web app is `OctoberDisputes.gs` (kept outside this repo, since it holds the sheet's secret). After changing it: Deploy > Manage deployments > edit > Version: New version > Deploy.

## Opening Tools

- **The button:** an orange **Tools** button in the sidebar above References. On a window too narrow for the sidebar, press `\`.
- **Fresh install:** nothing else on the portal changes until you turn it on in Settings.
- **Quick research** (off until ticked under Settings > Panel and pages): on dispute and order pages, a **Research** button above Tools claims the order and starts research in one click: in Claude Code if it's set up for you, otherwise in claude.ai, with the chat opening in a new tab. Its progress shows above the button, and Tools opens once it's started.
- **Normal | Advanced** (off until ticked under Settings > Panel and pages): above Tools on dispute and order pages, flips between the usual pages and the At a glance order pages with the reorganized Research tab, in one click.
- **Research again:** if a case was already researched (by anyone; the Google Sheet's Research tab says), the Research buttons ask before starting another session, and bulk runs skip it.
- **`\` key:** opens and closes it.
- **Where it opens:** as an overlay beside the button. Drag the edge away from the button to resize it. The ◫ button docks it side by side with the page, and ⧉ floats it again.
- **Header:**
  - Tabs: **Research** (on dispute and order pages only), **Classify**, **Quote**, **Entry Assistant**.
  - Icons: **▤** Analytics and **⚙** Settings.
- **On order pages:** **◀ n of N ▶** steps through your queue as you last left it, plus **Queue** to go back.

## What's in it

- **Research:** builds a research prompt written for the dispute or the order's problem class.
  - **Reorganized** (Settings > Panel and pages; off to start with, the tab is as before), top to bottom: the case (who holds it, its sheet row, chat links), the order (its question, **What's wrong** with CBP's message and a plain-English line under it, the page's choices, and its HS codes, each opening in Entry Assistant), Claude's answer, then three folded extras: **Write the answer yourself**, **Links** (Front, Slack, AI chat) and **Comments** (open when there are some). Each fold says what's in it and stays open or shut as you left it.
  - **Open in claude.ai** fills a claude.ai chat with the prompt and attaches the order's documents and images. Nothing is sent until you press Enter.
  - **Copy prompt** copies it instead.
  - **Claude's answer** shows one plain sentence first ("It is out of scope because …"), then the latest full answer. Only the latest answer is kept.
- **Questionnaire disputes:** the prompt includes what each "Disputed program compliance_program_…" is (e.g. "USMCA certification of origin"), with the questionnaire's questions and the merchant's answers.
- **Classify / Quote:** the same requests as the portal's own Classify and Quote boxes, usable on every page:
  - **Classify** is filled in from the order (a line picker when a dispute has several) and gives the code in large type with a confidence meter, where it sits in the HTS (chapter, heading, subheading, tariff line), the customs description, a level-by-level check of a code you enter (fits / partly / doesn't fit), and the alternates, each with Copy, Open or Compare in Entry Assistant, and Duties for this code (with the duty calculator on).
  - **Quote** gives the additional Chapter 99 codes that apply.
  - Or, with **Quote tab: use my duty calculator** ticked under Settings > Panel and pages, the tab becomes **Duties**: the Entry Assistant duty calculator, laid out like the website's. It fills in from the order (each line's HTS code, origin and value, the currency, the order date, how it shipped and when it arrived, and what a dispute's order was charged), works out what the entry owes as you type, shows every duty with its Chapter 99 code, and lists the questions it can't settle, answered right there with Yes / No / Not sure. Its results may not be 100% correct: double-check them.
- **Analytics:** from every work order's own history in the portal: who resolved (and submitted) the most, who claimed, released, marked waiting, escalated and added notes, and the typical time from claim to resolve, for today, 7, 30 or 90 days or 12 months, by class. Also who holds how many right now (overdue and waiting), unclaimed orders, how orders were resolved, and new orders by company. **Export** gives every event as a CSV.
- **Entry Assistant:** the Entry Assistant site, for looking up and comparing codes, notes and rulings.
- **Advanced View** (optional; pick it under Settings > Panel and pages, or with the view picker on Portal+):
  - Search across everything, including a pasted list of tracking numbers.
  - Mine / Unclaimed / Waiting / Escalated / All open.
  - Filters, sorting, grouping, summary counts and saved views.
  - Bulk Claim, Release, Wait, Resume, Escalate, Note, Assign and Resolve (with the access code; without it you can still select and copy refs, links or a CSV). Each shows what will happen, and in which mode (LIVE / TEST), before anything is sent.
  - The view picker switches back to the portal's own queue, or to **Portal+**.
- **Queue views:** **Default Portal** (the portal's own queue, the default), **Portal+** and **Advanced View**. Pick one under Settings > Panel and pages, or with the picker on Portal+ and the Advanced View.
- **Search** in Portal+ and the Advanced View searches every work order, open, waiting and closed, whatever tab is open (closed ones load the first time you search). Filters you set still apply; the default "hide escalated" doesn't. Clear the search to see the tab again.
- **Status column** (Portal+ and the Advanced View): the status on its own line, with short flags under it: red **✕ Res. failed** (the dispute was submitted but the portal couldn't finish resolving it), orange **↑ Eng** / **↑ Broker** (escalated) and **✦** (you researched it). Compact rows show just the symbols; hover any flag for what it means.
- **Escalated orders** are hidden from the queue's tabs while **Hide escalated orders** is ticked under Settings > Panel and pages (on to start with); "N escalated hidden" above the list says so. The Escalated and All work orders tabs, and a search, always show them.
- **Only resolution failed** (a checkbox above the list) shows just the disputes whose resolution failed; it works on its own, and says when some are hidden because they're escalated.
- **Portal+** (optional): the portal's own queue as you know it, without its limits: one list that loads as you scroll, sortable columns that stay in view, search on anything, one-click Claim, details at once, select and bulk actions, and your place kept when you come back from an order. Also: one-click counts (overdue, due today, due in 7 days, waiting, escalated, new), grouping (customer, class, assignee, status or due), compact rows, and a ✦ beside the status of every order you started research on (Claude Code or claude.ai, kept 60 days; filled purple while Claude Code is still researching). The Advanced View shows it too.
  - **Claim & research** (bulk bar, with the access code): claims the selected orders nobody has and starts Claude Code research on each, in the same paced background run as Research all.
  - **Submit** (bulk bar, duty disputes): reads each selected dispute and submits only those whose every claim, on every line, has a saved decision (the same as its own Submit button), claiming unclaimed ones first. Each is read back afterwards, and a results list shows what was submitted, what wasn't and the portal's reason. **Resolve** skips duty disputes.
  - **Decide by reason** (bulk bar, duty disputes): offers each reason the selected merchants gave; picking one takes only the disputes that give exactly that reason on every claim of every line, and accepts (as proposed) or denies all their claims with one note, then can submit them.
  - **Re-send as filed** (bulk bar, Entry rejected): the page's Streams and Send as for every selected rejected entry.
- **Batch work** (behind an access code in Settings): claim every unclaimed order of one class, then decide identical orders together. Orders are only grouped within one company, and disputes only when every disputed line's HS code, description, origin, claims, merchant reasons and questionnaire answers match exactly.
  - **Research all shown** (a switch under Settings > Access code, off until ticked): a queue button that starts Claude Code research on every order the list shows, one per ×N stack, in background tabs: at most 28 an hour per routine, up to about 95 an hour with 4 routines (add copies of your routine under Settings > Claude Code research; starts are spread over all of them). Already researched ones are skipped.
  - **Stack identical disputes in the queue** (a switch under Settings > Access code, shown only once unlocked, and off until ticked): in Portal+ and the Advanced View, identical disputes with the same assignee and status show as one row with ×N. Claim or select that row and all N are claimed or selected; open it and it's worked as one. Claim, release, saved decisions and Submit on its page are done to all N (Submit after a 5-second countdown you can cancel).
  - **Work as one** opens one dispute of an identical group in the portal. Decisions you save there are copied to the rest, and when you press Submit you're asked whether to submit the rest too. Each copy is read again first and left alone if it no longer matches.

## Settings (⚙)

Every section folds open:

- **Panel and pages.** Everything that changes the portal's own pages is off until you tick it:
  - the Tools button (bubble or sidebar)
  - the Advanced View
  - easier-to-read order pages (labeled details, CBP messages in plain English)
  - order pages: on Entry Writer Queue orders (not dispute reviews), an **At a glance** card at the top (who holds it and when it's due, tracking, entry, master bill, route, port, carrier, arrival, declared value, parties, the items with their codes, and the answer saved in Tools), a **Jump to** bar that stays at the top (folded sections open when you jump to them), Parties, Status history, empty Handling units and an unassessed Landed cost folded when the order opens
  - the Research tab, reorganized (see Research above)
  - a **Normal | Advanced** switch above Tools on dispute and order pages: Advanced turns on the At a glance order pages and the reorganized Research tab together, Normal turns them off
  - hiding escalated orders in the work queue (on to start with)
  - hiding the portal's own Classify / Quote rail
  - denied-party "Listed on" links that open the official list (and copy the name) instead of a Google search
  - HS codes on the page opening in the Entry Assistant tab
  - questionnaire program ids replaced with what they are
  - keyboard shortcuts
- **Entry Assistant:** your own token, for the HTS facts in research prompts, including the duty calculator: each line's HTS code, origin and value are run through it, and the prompt lists every duty with its Chapter 99 code and the open questions (each naming the Chapter 99 code a yes brings) as research points. The reply answers each one from the research, and Tools runs the calculator again with those answers: the resulting Chapter 99 codes show in the Research tab and go in the case doc.
- **Google Sheet:** the team sheet's web app address and secret (from the setup block). Each case you claim gets a row and a Google Doc; the Research tab shows the case's comments, and you can post your own.
- **Prompts:** the research prompts' fixed text, editable by the team in the sheet's Prompts tab (**Set up Prompts** adds it).
- **Claude Code research** (optional): a "Research in Claude Code" button that puts the request in the sheet's Research tab and starts your cloud routine; the answer comes back to the panel and the case doc.
- **Access code:** unlocks Batch work for the people given the code.
- **Shared answers** (optional): a notes server address for sharing saved answers.
- **Back up or move your setup:** **Copy my setup** and **Import**. That text includes your keys, so keep it private.

The script changes nothing in the portal except bulk actions you confirm, and never sends anything on claude.ai.

See [PRIVACY.md](PRIVACY.md) for what it reads and where data goes.
