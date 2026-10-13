# Zonos Dispute Researcher

A Tampermonkey userscript, also packaged as a Chrome extension, for the Zonos brokerage dashboard. On a duty dispute page it adds a **Research merchant** button. The button gathers the dispute's details, checks the merchant's website, looks up the HTS codes in the Entry Assistant API, and opens claude.ai with a research prompt ready to send.

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
4. Pin it: click the puzzle-piece icon in Chrome's toolbar, then the pin next to **Zonos Dispute Researcher**. On a dispute page, the **Research merchant** button appears as usual; the toolbar icon opens the panel too.

The extension keeps its own settings, so paste the Entry Assistant token under **Settings** again.

**Updates:** an extension loaded this way doesn't update itself. Download the new ZIP, replace the folder, and click the reload arrow on the extension's card in `chrome://extensions`. Automatic updates would need the extension published on the Chrome Web Store, for example as a private listing for zonos.com.

**Why it asks for access to all websites:** it checks whichever merchant site you enter, and those can be anywhere. It only fetches pages for the checks you start, and it never sends your cookies.

## Set up

1. Open a dispute (`brokerage.dashboard.zonos.com/duty-disputes/<id>`) and click **Research merchant** in the bottom-right corner.
2. In the panel, open **Settings**, paste the Entry Assistant token (ask the repo owner), click **Save**, then **Test**. It should say "Connected".
3. The first time the script contacts a site, Tampermonkey may ask for permission. Allow it.

## Use

- The panel shows the item, the merchant's claims, the HTS facts, matches on the merchant's site, and the documents to attach.
- **Open in Claude** opens claude.ai with the prompt and files filled in. Check it, then press Enter.
- **Copy prompt** copies the prompt if you'd rather paste it yourself.
- For Claude to run its own HTS lookups, add the entry-assistant skill in claude.ai and allow its code sandbox to reach `entry.kars3n.com`.

### Notes

- The **Notes** box at the top of the panel is a scratch pad for each dispute: links, reminders, anything you can't submit yet.
- **Add note** (or Ctrl+Enter) saves it with your name and the time. Set your name under **Settings**. Links are clickable, and you can edit or delete any note.
- What you're typing is kept as a draft, even if you close the panel or the tab.
- The launch button shows how many notes a dispute has, for example "Research merchant · 2 notes".
- For now, notes are saved only in your own Tampermonkey.

### Disputes with several lines

- Each line has a tick box. Only ticked lines, plus the order-level documents, go into the prompt. Claude answers in one block per line, each ending with its own verdict sentence.
- Lines not researched yet start ticked; lines already sent to Claude or answered start unticked.
- With more than 3 claims across several lines, the panel suggests splitting them over a few chats, because Claude digs deeper with fewer at a time.

### What it remembers

- Each line shows its status: **Not researched yet**, **Sent to Claude** (with the time), or the saved verdict (**Substantiated**, **Somewhat substantiated** or **Not substantiated**) with the verdict sentence and the saved answer.
- To save Claude's answer, click **Save answer to dispute** in the banner on claude.ai once Claude has finished. If it can't read the answer from the page, it asks you to paste it. You can also use **Paste Claude's answer** in the panel.
- This is stored in Tampermonkey on your computer, per dispute, and cleared after 120 days without changes. It isn't shared with coworkers.

## Troubleshooting

- **No button.** On a dispute page the Tampermonkey icon should show a number. No number: check **Allow User Scripts** and that the script is switched on in the dashboard. A number but no button: click the Tampermonkey icon, then **Open research panel**.
- **Is it running?** Press F12 and open the Console. It should show `[Dispute Researcher] v… running on …`.
- **HTS lookup failed.** The panel and the message after Copy or Open say why. **Settings → Test** checks the token.

## Privacy

- It reads the dispute page only. It sends product details, the merchant's reasons and the files you tick to claude.ai. It leaves out customer names, emails, tracking numbers, broker notes and claim decisions.
- Every document on the dispute, including invoices and receipts, is ticked to attach by default. Untick any you don't want sent.
- The Entry Assistant token is stored in Tampermonkey on your computer, never in this script.
