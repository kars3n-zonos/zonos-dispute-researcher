# Zonos Dispute Researcher

A Tampermonkey userscript, also packaged as a Chrome extension, for the Zonos brokerage dashboard. On a duty dispute page it adds a **Notes and Research** button. The panel it opens holds the dispute's shared notes and saved Claude answers. It also gathers the dispute's details, checks the merchant's website, looks up the HTS codes in the Entry Assistant API, and opens claude.ai with a research prompt ready to send.

It never clicks or changes anything on the dashboard, and it never sends a message on claude.ai. You review the prompt and press Enter.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome.
2. Go to `chrome://extensions`, open Tampermonkey's **Details**, and turn on **Allow User Scripts**. On older Chrome versions, turn on **Developer mode** at the top right of `chrome://extensions` instead.
3. Open the install link and click **Install** on the page Tampermonkey shows:
   **https://raw.githubusercontent.com/kars3n-zonos/zonos-dispute-researcher/main/zonos-dispute-researcher.user.js**

## Updates

Updates install automatically. Tampermonkey checks this repo about once a day. To get an update right away, click the Tampermonkey icon, then **Check for userscript updates**.

If you installed by pasting the script into Tampermonkey, paste this version once. From then on it updates itself.

For the maintainer: Tampermonkey only installs an update when `@version` in the script header goes up, so raise it with every change you push to `main`. Raise `version` in `manifest.json` to match.

## Chrome extension (alternative to Tampermonkey)

This repo is also a Chrome extension. It runs the same script file, so it works the same way. Use either the extension or the Tampermonkey script, not both, or you'll get two buttons.

1. On this page, click **Code → Download ZIP** and unzip it.
2. Go to `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unzipped folder (the one containing `manifest.json`).
4. Pin it: click the puzzle-piece icon in Chrome's toolbar, then the pin next to **Zonos Dispute Researcher**. On a dispute page, the **Notes and Research** button appears as usual; the toolbar icon opens the panel too.

The extension keeps its own settings, so paste the Entry Assistant token under **Settings** again.

**Updates:** an extension loaded this way doesn't update itself. Download the new ZIP, replace the folder, and click the reload arrow on the extension's card in `chrome://extensions`. Automatic updates would need the extension published on the Chrome Web Store, for example as a private listing for zonos.com.

**Why it asks for access to all websites:** it checks whichever merchant site you enter, and those can be anywhere. It only fetches pages for the checks you start, and it never sends your cookies.

## Set up

1. Open a dispute (`brokerage.dashboard.zonos.com/duty-disputes/<id>`) and click **Notes and Research** in the bottom-right corner.
2. In the panel, open **Settings**, paste the Entry Assistant token (ask the repo owner), click **Save**, then **Test**. It should say "Connected".
3. The first time the script contacts a site, Tampermonkey may ask for permission. Allow it.

## Use

- The panel only shows what the dispute page doesn't: your notes, a card for each line to tick, the merchant website, the documents to attach, Claude's saved answers, and the Claude buttons. Everything else (claims, HTS facts, product numbers, matches on the merchant's site) still goes into the prompt.
- **Open in Claude** opens the Claude desktop app with the prompt filled in, and copies it to your clipboard too. The first time, Chrome asks whether to open Claude: tick **Always allow** so it stops asking. Check the prompt, then press Enter.
  - The app can't take files from the dashboard. Drag the documents in yourself, or use **Open in browser**, which opens claude.ai with the prompt and the documents attached.
  - A long prompt (several lines at once) doesn't fit in the app's link, so the app opens empty. Paste the prompt from your clipboard.
  - To save Claude's answer from the app, copy it with Claude's copy button and use **Paste Claude's answer** in the panel. The **Save answer to dispute** button only exists on claude.ai in the browser.
  - If the app doesn't open within a few seconds, for example because it isn't installed, claude.ai opens in the browser instead. The app isn't tried again for a day, or for 30 days if it has never opened. Under **Settings** you can make the browser the default.
- **Copy prompt** copies the prompt if you'd rather paste it yourself.
- For Claude to run its own HTS lookups, add the entry-assistant skill in claude.ai and allow its code sandbox to reach `entry.kars3n.com`.

### Notes

- The **Notes** box at the top of the panel is a scratch pad for each dispute: links, reminders, anything you can't submit yet.
- **Add note** (or Ctrl+Enter) saves it with your name and the time. Set your name under **Settings**. Links are clickable, and you can edit or delete any note.
- What you're typing is kept as a draft, even if you close the panel or the tab.
- The launch button shows how many notes a dispute has, for example "Notes and Research · 2 notes".
- **Shared notes:** everyone using the script shares notes automatically, with nothing to set up. You're let in because you're signed in to the dashboard with a zonos.com account. Your name comes from your email; change it under **Settings** and your notes, old ones included, show the new name.
- Coworkers' notes appear within about 15 seconds while the panel is open, marked with a colored bar. Only the person who wrote a note can edit or delete it.
- Notes are saved on your computer first, so nothing is lost if the notes server can't be reached; they sync when it's back. Notes you wrote before shared notes existed are shared the first time they sync.
- If joining fails, the reason shows under the notes. The repo owner can still make a notes key by hand; paste it under **Settings**.

### Disputes with several lines

- Each line with claims gets a card showing what's claimed (HS code, Value…) and whether it's been researched. Click a card to tick it; ticked cards are outlined in orange. Only ticked lines, plus the order-level documents, go into the prompt. Claude answers in one block per line, each ending with its own verdict sentence.
- Lines not researched yet start ticked; lines you've already sent to Claude, or that anyone has saved an answer for, start unticked.
- With more than 3 claims across several lines, the panel suggests splitting them over a few chats, because Claude digs deeper with fewer at a time.

### What Claude's answer looks like

Every answer uses the same template, one block per line, so answers are quick to scan and compare:

- **Dispute:** what the merchant wants changed, from what to what.
- **At a glance:**
  - Code it should be (HS code disputes only), Description it should be, Prices found (low and high, with links, against the declared value), and Marketed use.
  - Made of and Origin, with the evidence for each.
  - Section 232 for 232 disputes: the metal, how much of the item it is, where it was melted or smelted, and the Chapter 99 heading.
  - Value, weight or quantity checks for those claims.
  - Discrepancies between what was found and what the merchant says, and Missing info.
- **More details:** a line per claim, the item found, what the photos show, the closest CBP rulings (CROSS), and the Entry Assistant lookups.
- **Verdict:** "The merchant's claim is substantiated / somewhat substantiated / not substantiated because …", with the proof in the sentence itself: what shows it, where it comes from, and which rule it meets or fails. Then the evidence for and against.

### Claude's answers

- To save Claude's answer, click **Save answer to dispute** in the banner on claude.ai once Claude has finished. If it can't read the answer from the page, it asks you to paste it. You can also use **Paste Claude's answer** in the panel.
- Answers are saved as Markdown, so headings, bold, lists, links and tables are kept. Pasting works with either Claude's copy button or a selection copied from the chat.
- Saved answers are shared with everyone, like notes. They're listed under **Claude's answers** in the panel, newest first, with who saved them and when. Open one to read it formatted, or click **Copy Markdown** to copy it, for example into a decision note. Only the person who saved an answer can delete it.
- Each line shows its status: **Not researched yet**, **Sent to Claude** (with the time, from your computer), or the verdict from the newest saved answer (**Substantiated**, **Somewhat substantiated** or **Not substantiated**). A coworker's verdict shows their name. Under the line are the verdict sentence and **Show answer**, which shows that line's part of the answer.
- Answers saved before answers were shared are uploaded the first time you open that dispute, with their original date.

## Troubleshooting

- **No button.** On a dispute page the Tampermonkey icon should show a number. No number: check **Allow User Scripts** and that the script is switched on in the dashboard. A number but no button: click the Tampermonkey icon, then **Open Notes and Research**.
- **Is it running?** Press F12 and open the Console. It should show `[Dispute Researcher] v… running on …`.
- **HTS lookup failed.** The panel and the message after Copy or Open say why. **Settings → Test** checks the token.

## Privacy

- It reads the dispute page only. It sends product details, the merchant's reasons and the files you tick to claude.ai. It leaves out customer names, emails, tracking numbers, broker notes and claim decisions.
- Every document on the ticked lines and the order, including invoices and receipts, is attached by default. Open **Documents to attach** to untick any you don't want sent.
- Notes and saved Claude answers are kept on the notes server (notes.kars3n.com). Everyone who uses the script can read them.
- To join shared notes, the script sends the notes server (notes.kars3n.com) your dashboard sign-in token. It does this once, and again about once a month to renew. The token comes from the dashboard's login and lasts 60 seconds. The server checks it and keeps only your name, your zonos.com email and an id, never the token itself. You then get your own notes key, which lasts 30 days and renews while you use the dashboard.
- The Entry Assistant token is stored in Tampermonkey on your computer, never in this script.
