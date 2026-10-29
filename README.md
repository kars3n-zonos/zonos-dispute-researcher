# Zonos Dispute Researcher (Tools)

A Tampermonkey script for the Zonos broker portal (brokerage.dashboard.zonos.com). It adds a **Tools** panel to every portal page: research for disputes and Entry Writer Queue orders, Classify, Quote, Analytics and the Entry Assistant site. It also adds an optional rebuilt work queue.

**No keys are built in.** Each person adds their own under Settings, and every part is optional. Changes to the portal's own pages are **off** until you turn them on.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome.
2. Go to `chrome://extensions`, open Tampermonkey's **Details**, and turn on **Allow User Scripts**. On older Chrome versions, turn on **Developer mode** instead.
3. Open the install link and click **Install** (or **Update**, if you have the old Dispute Researcher):
   **https://raw.githubusercontent.com/kars3n-zonos/zonos-dispute-researcher/main/zonos-dispute-researcher.user.js**
   (If you installed "Zonos Dispute Desk (Sheets)" from `zonos-dispute-desk-sheets.user.js`, keep it: since 7.17.0 it's the same script. Install only one of the two.)
4. When Tampermonkey asks to allow a connection, choose **Always allow domain**.
5. Under Settings (⚙) > Back up or move your setup, paste the setup block from Karsen and press **Import**. It connects you to the team's Google Sheet.

Updates install automatically: Tampermonkey checks this repo about once a day. To update right away, use Tampermonkey's **Check for userscript updates**.

Cases are tracked in the team's **Google Sheet** (since 7.17.0): one row per case, a Google Doc per case, and Comments, Prompts and Research tabs. Notion tracking is retired; its code is still in the script but off.

For the maintainer:
- Edit only `zonos-dispute-researcher.user.js`. On every push to `main`, a GitHub Action runs `build-sheets.ps1` and commits `zonos-dispute-desk-sheets.user.js`, the same script under its own name and update address.
- Raise `@version` with every change pushed to `main`, or Tampermonkey won't install it.
- The sheet's web app is `OctoberDisputes.gs` (kept outside this repo, since it holds the sheet's secret). After changing it: Deploy > Manage deployments > edit > Version: New version > Deploy.

## Opening Tools

- **The button:** an orange **Tools** button in the sidebar above References (the default), or an orange **⚒ Tools** bubble you can drag anywhere. Pick one in Settings.
- **`\` key:** opens and closes it.
- **Where it opens:** as an overlay beside the button. Drag the edge away from the button to resize it. The ◫ button docks it side by side with the page, and ⧉ floats it again.
- **Header:**
  - Tabs: **Research** (on dispute and order pages only), **Classify**, **Quote**, **Entry Assistant**.
  - Icons: **▤** Analytics and **⚙** Settings.
- **On order pages:** **◀ n of N ▶** steps through your queue as you last left it, plus **Queue** to go back.

## What's in it

- **Research:** builds a research prompt written for the dispute or the order's problem class.
  - **Open in claude.ai** fills a claude.ai chat with the prompt and attaches the order's documents and images. Nothing is sent until you press Enter.
  - **Copy prompt** copies it instead.
  - **Claude's answer** shows one plain sentence first ("It is out of scope because …"), then the latest full answer. Only the latest answer is kept.
- **Questionnaire disputes:** the prompt includes what each "Disputed program compliance_program_…" is (e.g. "USMCA certification of origin"), with the questionnaire's questions and the merchant's answers.
- **Classify / Quote:** the same requests as the portal's own Classify and Quote boxes, usable on every page:
  - **Classify** gives the code, its description, confidence, a check of a code you enter, and alternates.
  - **Quote** gives the additional Chapter 99 codes that apply.
- **Analytics:** every order the portal has for a period, closed ones included, broken down by company, class, status / resolution, item / problem and assignee. **Export CSV** gives a file for bookkeeping.
- **Entry Assistant:** the Entry Assistant site, for looking up and comparing codes, notes and rulings.
- **Tools queue** (optional; there's an orange **⚡ Tools queue** switch at the top right of the portal's queue):
  - Search across everything, including a pasted list of tracking numbers.
  - Mine / Unclaimed / Waiting / Escalated / All open.
  - Filters, sorting, grouping, summary counts and saved views.
  - Bulk Claim, Release, Wait, Resume, Escalate, Note, Assign and Resolve. Each shows what will happen, and in which mode (LIVE / TEST), before anything is sent.
  - The view picker switches back to the portal's own queue, or to **Portal+**.
- **Portal+** (optional): the portal's own queue as you know it, without its limits: one list that loads as you scroll, sortable columns, search on anything, one-click Claim, details at once, select and bulk actions, and your place kept when you come back from an order.
- **Batch work** (behind an access code in Settings): claim every unclaimed order of one class, then decide identical orders together.

## Settings (⚙)

Every section folds open:

- **Panel and pages.** Everything that changes the portal's own pages is off until you tick it:
  - the Tools button (bubble or sidebar)
  - the Tools queue
  - easier-to-read order pages (labeled details, CBP messages in plain English)
  - hiding the portal's own Classify / Quote rail
  - denied-party "Listed on" links that open the official list (and copy the name) instead of a Google search
  - HS codes on the page opening in the Entry Assistant tab
  - questionnaire program ids replaced with what they are
  - keyboard shortcuts
- **Entry Assistant:** your own token, for the HTS facts in research prompts.
- **Google Sheet:** the team sheet's web app address and secret (from the setup block). Each case you claim gets a row and a Google Doc; the Research tab shows the case's comments, and you can post your own.
- **Prompts:** the research prompts' fixed text, editable by the team in the sheet's Prompts tab (**Set up Prompts** adds it).
- **Claude Code research** (optional): a "Research in Claude Code" button that puts the request in the sheet's Research tab and starts your cloud routine; the answer comes back to the panel and the case doc.
- **Access code:** unlocks Batch work for the people given the code.
- **Shared answers** (optional): a notes server address for sharing saved answers.
- **Back up or move your setup:** **Copy my setup** and **Import**. That text includes your keys, so keep it private.

The script changes nothing in the portal except bulk actions you confirm, and never sends anything on claude.ai.

See [PRIVACY.md](PRIVACY.md) for what it reads and where data goes.
