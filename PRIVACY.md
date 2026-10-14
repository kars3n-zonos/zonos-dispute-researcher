# Privacy policy: Zonos Dispute Researcher

Zonos Dispute Researcher is a Chrome extension and Tampermonkey script for Zonos brokerage staff. It adds a Notes and Research panel to duty dispute pages on brokerage.dashboard.zonos.com. This policy explains what it reads, where that goes, and what is kept.

It has no ads and no analytics. It never sells data, and it never uses data for anything other than the features described here.

## What it reads

- **The dispute page you have open** on brokerage.dashboard.zonos.com: the items, the merchant's claims, and the dispute's documents.
- **The merchant's website**, but only the site you enter in the panel. It fetches public pages and product search results, and never sends your cookies.
- **claude.ai**, only in the tab that Open in Claude opens. It fills the message box there, and reads Claude's reply when you click Save answer to dispute.

## Where data goes

- **claude.ai.** Only when you click Open in Claude: the research prompt and the documents you leave ticked. They go into your own Claude chat and are not sent until you press Enter.
- **The Entry Assistant API** (entry.kars3n.com). For HTS lookups, it sends the HS codes and countries of origin on the dispute, using the token you enter under Settings.
- **The notes server** (notes.kars3n.com), which keeps the shared notes and saved Claude answers for each dispute so coworkers can see them:
  - **Notes and answers.** Their text, the dispute they belong to, the lines they cover, your name and the time.
  - **Joining.** To join, the extension sends the server your dashboard sign-in token, issued by the dashboard's login and valid for 60 seconds. It does this once, then about once a month to renew. The server checks the token's signature and that the email is a zonos.com address, and then throws the token away. It keeps your name, your zonos.com email and your login's user id, so it knows who wrote what.
  - **Your key.** You get a notes key that lasts 30 days. The server stores only a hash of it.
- **Dispute documents.** These are downloaded from the dashboard's own storage only to attach them to the Claude message.

Nothing else leaves your browser.

## What is kept on your computer

Chrome's extension storage keeps:

- your settings: your name, the Entry Assistant token and your notes key;
- a draft of the note you're typing;
- a copy of each dispute's notes and answers, so nothing is lost while offline;
- when each line was sent to Claude.

Research records and copies of notes are removed after 120 days without changes. Removing the extension removes all of it.

## What is kept on the notes server

Notes and answers stay until their author deletes them. Anyone who uses the extension with a zonos.com dashboard sign-in can read them. Access can be revoked, and anyone who loses dashboard access drops out within 30 days.

## Contact

Questions or requests, including deleting your notes or your account on the notes server: open an issue at https://github.com/kars3n-zonos/zonos-dispute-researcher/issues, or contact the maintainer.
