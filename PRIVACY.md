# Privacy policy: Zonos Dispute Researcher

Zonos Dispute Researcher is a Tampermonkey script for Zonos brokerage staff. It adds a Research panel to duty dispute pages on brokerage.dashboard.zonos.com. This policy explains what it reads, where that goes, and what is kept.

It has no ads and no analytics. It never sells data, and it never uses data for anything other than the features described here.

## What it reads

- **The dispute or Entry Writer Queue order you have open** on brokerage.dashboard.zonos.com: the items, the merchant's claims and the dispute's documents, or what the order page shows. When you click an HS code on the page, it reads that code to open it in the Entry Assistant tab.
- **The merchant's website**, but only the site you enter in the panel. It fetches public pages and product search results, and never sends your cookies.
- **claude.ai**, only in the tab that Open in Claude opens. It fills the message box there and keeps a copy of Claude's finished answer on your computer, so the panel can offer to save it. Nothing is shared until you click Save answer.

## Where data goes

- **claude.ai.** Only when you click Open in Claude: the research prompt and the documents you leave ticked. They go into your own Claude chat and are not sent until you press Enter.
  - For an Entry Writer Queue order, the prompt carries what the order page shows, except tracking numbers, the consignee, the activity log and staff names; the shipper only by company name, country and email domain. For a denied-party review that includes the screened party's name and address, since that's what is being checked.
- **The Entry Assistant API** (entry.kars3n.com). For HTS lookups, it sends the HS codes and countries of origin on the dispute, using the token you enter under Settings.
- **The Entry Assistant site** (entry.kars3n.com), shown in the panel's Entry Assistant tab. Its address carries the HS codes being looked up and the country of origin, and nothing else from the dispute. The dashboard's address isn't sent with it. To know whether the site can be shown inside the dashboard, the script also loads the site's home page once and reads its headers.
- **The notes server** (notes.kars3n.com), which keeps the saved Claude answers for each dispute so coworkers can see them (and the notes written in the panel before it dropped its notes box):
  - **Answers.** Their text, the dispute they belong to, the lines they cover, your name and the time.
  - **Joining.** To join, the script sends the server your dashboard sign-in token, issued by the dashboard's login and valid for 60 seconds. It does this once, then about once a month to renew. The server checks the token's signature and that the email is a zonos.com address, and then throws the token away. It keeps your name, your zonos.com email and your login's user id, so it knows who wrote what.
  - **Your key.** You get a notes key that lasts 30 days. The server stores only a hash of it.
- **Dispute documents.** These are downloaded from the dashboard's own storage only to attach them to the Claude message.

Nothing else leaves your browser.

## What is kept on your computer

Tampermonkey's storage for the script keeps:

- your settings: your name, the Entry Assistant token, your notes key and the panel's width;
- a copy of each dispute's answers (and any notes from before), so nothing is lost while offline;
- when each line was sent to Claude;
- how filling Claude's message box went, and Claude's latest answer for a dispute, until the panel has shown them or you save or dismiss the answer (a week at most).

Research records and copies of answers are removed after 120 days without changes. Removing the script from Tampermonkey removes all of it.

## What is kept on the notes server

Answers, and notes from before, stay until their author deletes them or asks the maintainer to. Anyone who uses the script with a zonos.com dashboard sign-in can read them. Access can be revoked, and anyone who loses dashboard access drops out within 30 days.

## Contact

Questions or requests, including deleting your answers, your old notes or your account on the notes server: open an issue at https://github.com/kars3n-zonos/zonos-dispute-researcher/issues, or contact the maintainer.
