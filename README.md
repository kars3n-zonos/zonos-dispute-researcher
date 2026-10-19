# Zonos Dispute Researcher

A Tampermonkey script for the Zonos brokerage dashboard. On a duty dispute page it adds a **Research** button. The panel it opens sits beside the page and has two tabs:

- **Research:** gathers the dispute's details, checks the merchant's website, looks up the HTS codes in the Entry Assistant API, and opens claude.ai with a research prompt ready to send. Claude's answers are saved here and shared with everyone.
- **Entry Assistant:** the Entry Assistant site (entry.kars3n.com), for looking up and comparing codes, notes, rulings and the rest. Clicking a code on the dispute page opens it here.

It never changes anything on the dashboard, and it never sends a message on claude.ai. You review the prompt and press Enter.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome.
2. Go to `chrome://extensions`, open Tampermonkey's **Details**, and turn on **Allow User Scripts**. On older Chrome versions, turn on **Developer mode** at the top right of `chrome://extensions` instead.
3. Open the install link and click **Install** on the page Tampermonkey shows:
   **https://raw.githubusercontent.com/kars3n-zonos/zonos-dispute-researcher/main/zonos-dispute-researcher.user.js**

## Updates

Updates install automatically. Tampermonkey checks this repo about once a day. To get an update right away, click the Tampermonkey icon, then **Check for userscript updates**.

For the maintainer: Tampermonkey only installs an update when `@version` in the script header goes up, so raise it with every change you push to `main`.

## Set up

1. Open a dispute (`brokerage.dashboard.zonos.com/duty-disputes/<id>`) and click **Research** in the bottom-right corner. Sharing answers turns on by itself.
2. In the panel, open **Settings** (the ⚙ at the top), paste the Entry Assistant token (ask the repo owner), click **Save**, then **Test**. It should say "Connected". The token is only for the HTS lookups in Claude's prompt; the Entry Assistant tab works without it.
3. The first time the script contacts a site, Tampermonkey may ask for permission. Allow it. It contacts the merchant site you enter (which can be anywhere), the notes server and the Entry Assistant site and API, and never sends your cookies to merchant sites.

## Use

- **The panel sits beside the page.** While it's open the dispute page narrows to make room, so nothing is hidden under it. Drag the panel's left edge to make it wider or narrower (it remembers); double-click the edge to go back to the default width. It won't get so wide that the page is narrower than about 640 px, so it always stays beside the page. Only in a window too narrow for both does it cover the page.
- **Research** only shows what the dispute page doesn't: a card for each line to tick, the merchant website, the documents to attach, Claude's saved answers, and the Claude buttons. Everything else (claims, HTS facts, product numbers, matches on the merchant's site) still goes into the prompt.
- **Open in Claude** opens claude.ai with the prompt and files filled in. Check it, then press Enter. If Claude asks you to sign in first, the prompt fills in once you have.
- **Copy prompt** copies the prompt if you'd rather paste it yourself.
- For Claude to run its own HTS lookups, add the entry-assistant skill in claude.ai and allow its code sandbox to reach `entry.kars3n.com`.

### Entry Assistant tab

- The **Entry Assistant** tab shows the Entry Assistant site itself: search, compare, the manual, references and import checks all work there.
- **Clicking a code on the dispute page** (the underlined HS codes) opens it in this tab instead of the dashboard's small References window. When the merchant claims a different HS code, either code opens the comparison of the two: current against claimed, for the declared country of origin. Any other code opens on its own. To get the dashboard's References window instead, hold **Alt** while clicking. Until the Entry Assistant site allows being shown inside the dashboard, codes open the dashboard's window as they always have.
- Each line card also has a link: **Compare … in Entry Assistant**, or **Look up … in Entry Assistant** when only one code is on the line.
- The bar above the site says what's showing; **Open in a new tab** opens the same page full size.
- The site stays loaded while you switch tabs, so you can go back to the Research tab and return to where you were.

### Notes

Use the dashboard's own **Notes** section on the dispute page. The panel had a notes box before the dashboard did; it's gone now. Notes written in it are still on the notes server but aren't shown.

### Disputes with several lines

- Each line with claims gets a card showing what's claimed (HS code, Value…) and whether it's been researched. Click a card to tick it; ticked cards are outlined in orange. Only ticked lines, plus the order-level documents, go into the prompt. Claude answers in one block per line, each ending with its own verdict sentence.
- Lines not researched yet start ticked; lines you've already sent to Claude, or that anyone has saved an answer for, start unticked.
- With more than 3 claims across several lines, the panel suggests splitting them over a few chats, because Claude digs deeper with fewer at a time.

### What Claude's answer looks like

Claude's job is the fact-finding you'd otherwise do by hand. It finds out everything that matters about the item and the seller, catches what doesn't add up, and works out what proof is still missing. The merchant's claim is the starting point, not the outline. Claude follows the same rules a broker would:

- The merchant has to prove their claim, and every red flag is a reason to ask for more.
- Without proof, the higher duty stands, especially for tariffs like Section 232 and 301. For example, the Russia aluminum rate stays until documents show where the aluminum was smelted and cast.
- Every specific thing the merchant says gets checked against their own website, photos and documents.

Before answering, Claude does the research:

- **Documents.** It reads every attached document like an investigator: dates against the order date, where the goods ship from, which suppliers are named, and whether it covers this shipment.
- **The claim.** It reads the claim text critically, for example for an AI template with blanks left in.
- **Searches and the seller.** It runs the required searches for each line and researches the seller, plus any supplier or factory named in the documents.
- **HS code disputes.** It works out the right code within the heading, using essential character, what each statistical suffix covers, and the closest CBP rulings. The answer can be neither the current code nor the merchant's.

None of that research is listed in the answer. If web search is off in that chat, Claude says so instead of answering: turn it on and send again.

Every answer uses the same layout, one block per line:

- **Bottom line:** where it stands and the next step, in one line.
- **Dispute:** what the merchant wants changed, from what to what.
- **Red flags:** everything that doesn't add up, each with its source.
- **What we found:**
  - **Every dispute:** the product (what it is, specs, materials), how it's sold, the seller, the supplier or maker, the origin and its evidence, where it shipped from, and prices against the declared value.
  - **HS code disputes:** the code and the closest rulings.
  - **Section 232, tariff, value, weight or quantity disputes:** a line for that claim.
- **Ask the merchant for:** the specific documents that would settle what's unproven, and what each would prove.
- **Verdict:** "The merchant's claim is substantiated / somewhat substantiated / not substantiated because …", with the proof in the sentence itself.

Every answer ends with "Would you like me to draft an email?" Answer yes in the chat, and Claude writes a short, friendly email to the merchant with the requests listed.

### Claude's answers

- Nothing shows over claude.ai. When you come back to the dashboard, the panel's status says whether the prompt and files went in. If the message box couldn't be filled, the prompt is on your clipboard to paste.
- Once Claude has finished, come back to the dashboard: under **Claude's answers** the panel shows **Claude's answer is ready**, with the verdicts it found and a preview. Click **Save answer** to save and share it, or **Dismiss**. If Claude writes the email afterward, the research answer stays the one offered. You can also use **Paste Claude's answer** in the panel.
- Answers are saved as Markdown, so headings, bold, lists, links and tables are kept. Pasting works with either Claude's copy button or a selection copied from the chat.
- Saved answers are shared with everyone who uses the script, with nothing to set up. You're let in because you're signed in to the dashboard with a zonos.com account. Your name comes from your email; change it under **Settings**.
- Coworkers' answers show up within about 15 seconds while the panel is open. Answers are saved on your computer first, so nothing is lost if the notes server can't be reached; they're shared when it's back.
- If joining fails, the reason shows under **Claude's answers**. The repo owner can make a notes key by hand to paste under **Settings**.
- Answers are listed under **Claude's answers** in the panel, newest first, with who saved them and when. Open one to read it formatted, or click **Copy Markdown** to copy it, for example into a decision note. Only the person who saved an answer can delete it.
- Each line shows its status: **Not researched yet**, **Sent to Claude** (with the time, from your computer), or the verdict from the newest saved answer (**Substantiated**, **Somewhat substantiated** or **Not substantiated**). A coworker's verdict shows their name. Under the line are the verdict sentence and **Show answer**, which shows that line's part of the answer.
- Answers saved before answers were shared are uploaded the first time you open that dispute, with their original date.

## Troubleshooting

- **No button.** On a dispute page the Tampermonkey icon should show a number. No number: check **Allow User Scripts** and that the script is switched on in the dashboard. A number but no button: click the Tampermonkey icon, then **Open Research**.
- **Is it running?** Press F12 and open the Console. It should show `[Dispute Researcher] v… running on …`.
- **HTS lookup failed.** The panel and the message after Copy or Open say why. **Settings → Test** checks the token.
- **The Entry Assistant tab says the site doesn't allow being shown inside the dashboard.** The site has to allow it (its owner can switch that on). Until then, the button there opens the same page in a new tab, and codes on the page open the dashboard's own References window.

## Privacy

- It reads the dispute page only. It sends claude.ai:
  - the product details, the merchant's reasons and the files you tick;
  - the order number and date;
  - the merchant's website and email domain;
  - the country the parcel was posted in, read from the tracking number.

  It leaves out names, full email addresses, the tracking number itself, broker notes and claim decisions.
- Every document on the ticked lines and the order, including invoices and receipts, is attached by default. Open **Documents to attach** to untick any you don't want sent.
- The Entry Assistant tab loads the Entry Assistant site (entry.kars3n.com). Its address carries only the HS codes being looked up and the country of origin, never the dispute, the merchant or anything else from the page, and the dashboard's address isn't passed along.
- Saved Claude answers are kept on the notes server (notes.kars3n.com). Everyone who uses the script can read them.
- To join, the script sends the notes server (notes.kars3n.com) your dashboard sign-in token. It does this once, and again about once a month to renew. The token comes from the dashboard's login and lasts 60 seconds. The server checks it and keeps only your name, your zonos.com email and an id, never the token itself. You then get your own notes key, which lasts 30 days and renews while you use the dashboard.
- The Entry Assistant token is stored in Tampermonkey on your computer, never in this script.
