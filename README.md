# Zonos Dispute Researcher

A Tampermonkey userscript for the Zonos brokerage dashboard. On a duty dispute page it adds a **Research merchant** button. The button gathers the dispute's details, checks the merchant's website, looks up the HTS codes in the Entry Assistant API, and opens claude.ai with a research prompt ready to send.

It never clicks or changes anything on the dashboard, and it never sends a message on claude.ai. You review the prompt and press Enter.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome.
2. Go to `chrome://extensions`, open Tampermonkey's **Details**, and turn on **Allow User Scripts**. On older Chrome versions, turn on **Developer mode** at the top right of `chrome://extensions` instead.
3. Open the install link and click **Install** on the page Tampermonkey shows:
   **https://raw.githubusercontent.com/kars3n-zonos/zonos-dispute-researcher/main/zonos-dispute-researcher.user.js**

## Updates

Updates install automatically. Tampermonkey checks this repo about once a day. To get an update right away, click the Tampermonkey icon, then **Check for userscript updates**.

If you installed by pasting the script into Tampermonkey, paste this version once. From then on it updates itself.

For the maintainer: Tampermonkey only installs an update when `@version` in the script header goes up, so raise it with every change you push to `main`.

## Set up

1. Open a dispute (`brokerage.dashboard.zonos.com/duty-disputes/<id>`) and click **Research merchant** in the bottom-right corner.
2. In the panel, open **Settings**, paste the Entry Assistant token (ask the repo owner), click **Save**, then **Test**. It should say "Connected".
3. The first time the script contacts a site, Tampermonkey may ask for permission. Allow it.

## Use

- The panel shows the item, the merchant's claims, the HTS facts, matches on the merchant's site, and the documents to attach.
- **Open in Claude** opens claude.ai with the prompt and files filled in. Check it, then press Enter.
- **Copy prompt** copies the prompt if you'd rather paste it yourself.
- For Claude to run its own HTS lookups, add the entry-assistant skill in claude.ai and allow its code sandbox to reach `entry.kars3n.com`.

## Troubleshooting

- **No button.** On a dispute page the Tampermonkey icon should show a number. No number: check **Allow User Scripts** and that the script is switched on in the dashboard. A number but no button: click the Tampermonkey icon, then **Open research panel**.
- **Is it running?** Press F12 and open the Console. It should show `[Dispute Researcher] v… running on …`.
- **HTS lookup failed.** The panel and the message after Copy or Open say why. **Settings → Test** checks the token.

## Privacy

- It reads the dispute page only. It sends product details, the merchant's reasons and the files you tick to claude.ai. It leaves out customer names, emails, tracking numbers, broker notes and claim decisions.
- PDFs such as invoices and receipts aren't attached unless you tick them.
- The Entry Assistant token is stored in Tampermonkey on your computer, never in this script.
