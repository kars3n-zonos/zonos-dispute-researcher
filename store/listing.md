# Chrome Web Store listing text

Copy each part into the matching field in the developer console.

## Store listing

**Name** (from the manifest): Zonos Dispute Researcher

**Summary** (from the manifest): Adds a Notes and Research panel to Zonos duty dispute pages: shared notes, saved Claude answers, and merchant research via Claude.

**Category:** Workflow & Planning

**Language:** English

**Description:**

> For Zonos brokerage staff working duty disputes on brokerage.dashboard.zonos.com.
>
> On every duty dispute page, the Notes and Research button opens a side panel with:
>
> • Shared notes for the dispute: links, reminders, anything you can't submit yet. Coworkers see them within seconds, and you join automatically through your dashboard sign-in.
> • Claude's saved answers, shared with everyone on the dispute and shown with their formatting, plus the verdict for each line.
> • A card for each disputed line to tick for research, the merchant's website, and the documents to attach.
> • Open in Claude: opens claude.ai with a research prompt and the dispute's documents filled in. Claude checks the merchant's claim against product listings, prices, materials, origin, Section 232 and CBP rulings. Nothing is sent until you press Enter.
> • Save answer to dispute: saves Claude's answer back to the dispute in one click.
>
> It only reads the dashboard. It never clicks or changes anything there, and it never sends a message on claude.ai by itself.

## Privacy practices tab

**Single purpose:**

> Helps Zonos brokerage staff work duty disputes on the Zonos brokerage dashboard. It keeps shared notes and saved research answers for each dispute, and hands a research prompt with the dispute's documents to Claude.

**Permission justifications:**

- **storage:** Keeps the user's settings (name, Entry Assistant token, notes key), an offline copy of each dispute's notes and answers, and the research prompt and documents handed from the dashboard tab to the claude.ai tab.
- **unlimitedStorage:** The documents handed to the claude.ai tab (product photos, invoices) can add up to several megabytes, more than the default storage quota.
- **clipboardWrite:** The Copy prompt and Copy Markdown buttons, and a fallback that puts the prompt on the clipboard if it can't be typed into claude.ai.
- **Host permissions (https://\*/\* and http://\*/\*):**
  - **Merchant sites.** The merchant website check fetches public pages and product search results from the merchant's site, which the user enters and which can be any domain. It never sends cookies.
  - **Other requests.** It also downloads the dispute's documents from the dashboard's file storage, looks up HTS codes in the Entry Assistant API, and syncs notes with the notes server.
  - **Where it runs.** Content scripts only run on brokerage.dashboard.zonos.com and claude.ai.

**Remote code:** No, I am not using remote code. All code ships in the package.

**Data usage**, the boxes to tick:

- **Personally identifiable information:** yes. The user's name and zonos.com email, kept on the notes server to show who wrote each note.
- **Authentication information:** yes. The dashboard sign-in token, checked once by the notes server and not stored, and the user's notes key and Entry Assistant token, kept in extension storage.
- **Website content:** yes. Dispute details and documents, sent to claude.ai when the user clicks Open in Claude. Notes and answers are kept on the notes server.
- Everything else (health, financial, location, web history, user activity, personal communications): no.

**Certify all three:** not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.

**Privacy policy URL:** https://github.com/kars3n-zonos/zonos-dispute-researcher/blob/main/PRIVACY.md
