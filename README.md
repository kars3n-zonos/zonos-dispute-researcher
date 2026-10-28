# Zonos Dispute Researcher (Tools)

A Tampermonkey script for the Zonos broker portal (brokerage.dashboard.zonos.com). It adds a **Tools** panel to every portal page: research for disputes and Entry Writer Queue orders, Classify, Quote, Analytics and the Entry Assistant site. It also adds an optional rebuilt work queue.

**No keys are built in.** Each person adds their own under Settings, and every part is optional. Changes to the portal's own pages are **off** until you turn them on.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome.
2. Go to `chrome://extensions`, open Tampermonkey's **Details**, and turn on **Allow User Scripts**. On older Chrome versions, turn on **Developer mode** instead.
3. Open the install link and click **Install** (or **Update**, if you have the old Dispute Researcher):
   **https://raw.githubusercontent.com/kars3n-zonos/zonos-dispute-researcher/main/zonos-dispute-researcher.user.js**
4. When Tampermonkey asks to allow a connection, choose **Always allow domain**.

Updates install automatically: Tampermonkey checks this repo about once a day. To update right away, use Tampermonkey's **Check for userscript updates**.

For the maintainer: raise `@version` with every change pushed to `main`, or Tampermonkey won't install it.

## Opening Tools

- **The button:** an orange **⚒ Tools** bubble you can drag anywhere, or an orange **Tools** button in the sidebar above References. Pick one in Settings.
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
  - **Portal view** switches back.

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
- **Notion case tracking** (optional): tracks each dispute and order you work as a row in your Notion database.
- **Claude Code research** (optional): a "Research in Claude Code" button that files the request in Notion Tasks and starts your cloud routine. It needs Notion with a Tasks database.
- **Shared answers** (optional): a notes server address for sharing saved answers.
- **Back up or move your setup:** **Copy my setup** and **Import**. That text includes your keys, so keep it private.

The script changes nothing in the portal except bulk actions you confirm, and never sends anything on claude.ai.

See [PRIVACY.md](PRIVACY.md) for what it reads and where data goes.
