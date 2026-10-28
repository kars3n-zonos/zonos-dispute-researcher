# Privacy policy: Zonos Dispute Researcher (Tools)

This is a Tampermonkey script for Zonos brokerage staff, on brokerage.dashboard.zonos.com. This note explains what it reads, where that goes, and what is kept.

It has no ads and no analytics. It never sells data, and it uses data only for the features described here. **No keys are built in.** Everything optional below stays off until you set it up under Settings.

## What it reads

- **The portal pages you open, and the portal's own data.** It uses your existing sign-in, the same way the portal does: the work queue, orders, disputes, questionnaire sessions, screening details, and company names.
- **A merchant's website**, only the one you enter in the Research tab. It fetches public pages and never sends your cookies.
- **claude.ai**, only in the tab that **Open in claude.ai** opens. It fills the message box there, and keeps Claude's finished answer on your computer until you save or dismiss it.

## Where data goes

- **The portal itself.** Classify, Quote, Analytics, the Tools queue and its bulk actions call the portal's own API, in the mode the portal is in. Bulk actions change orders only after you confirm them.
- **claude.ai**, only when you click Open in claude.ai: the research prompt and the documents you leave ticked. They go into your own chat and are not sent until you press Enter.
- **Entry Assistant** (entry.kars3n.com):
  - HS codes and countries of origin, for the HTS facts in research prompts. This uses your own token and only happens once you save one.
  - In the Entry Assistant tab, the codes being looked up.
- **Notion (api.notion.com)**, only if you add a Notion key. It sends the case details for the disputes and orders you work, research requests and saved answers, all to your own Notion workspace.
- **Claude Code (api.anthropic.com)**, only if you set up a cloud routine. It sends the research request's Notion task id to start your routine.
- **A notes server**, only if you enter its address. It sends saved answers, with your name, to share them with coworkers who use the same server. To join, it sends your dashboard sign-in token once; the server checks it and keeps your name and zonos.com email.
- **Official screening lists.** "Listed on" links open the list's own site in a new tab. Nothing is sent to them except that the page opens.

Nothing else leaves your browser.

## What is kept on your computer

Tampermonkey's storage for this script keeps:
- **Your settings and keys.** These are never shown again once saved. Copy my setup puts them on your clipboard only when you click it.
- **Panel and queue preferences:** layout, saved views, the bubble's position.
- **Research records and answers.** For each dispute, the latest saved answer and when each line was sent to Claude.
- **Company names** the portal returns, cached to load the queue faster.

Removing the script from Tampermonkey removes all of it.

## Contact

Questions or requests: open an issue at https://github.com/kars3n-zonos/zonos-dispute-researcher/issues, or contact the maintainer.
