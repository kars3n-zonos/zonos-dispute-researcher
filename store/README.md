# Publishing to the Chrome Web Store

A Web Store listing is the easiest install there is. People click **Add to Chrome** once, and Chrome updates the extension by itself after that. This folder has everything the store asks for.

## One-time setup

1. **Pick the Google account to publish from.** Use your zonos.com Google account. Then the listing can be limited to zonos.com people, and the publisher matches the "Zonos" in the name. If Zonos has a team that owns Chrome extensions, check with them first.
2. **Register as a Chrome Web Store developer** at https://chrome.google.com/webstore/devconsole. There's a one-time US$5 fee.

## Publishing

1. **Get the ZIP:** download `zonos-dispute-researcher-extension.zip` from the [latest release](https://github.com/kars3n-zonos/zonos-dispute-researcher/releases/latest). GitHub builds it on every update.
2. **Upload it:** in the developer console, click **New item** and upload the ZIP.
3. **Store listing tab:** copy the text from [listing.md](listing.md). Upload `screenshot-light.png` and `screenshot-dark.png` from this folder (1280×800), and pick the category **Workflow & Planning**.
4. **Privacy tab:**
   - Copy the single purpose, the permission justifications and the data answers from [listing.md](listing.md).
   - Privacy policy URL: https://github.com/kars3n-zonos/zonos-dispute-researcher/blob/main/PRIVACY.md
5. **Distribution tab, Visibility:**
   - **Private** with **zonos.com** if the console offers it. Only people signed in to Chrome with a zonos.com account can install it.
   - Otherwise **Unlisted**: anyone with the link can install it, but nobody finds it by searching. The notes server still only lets in zonos.com dashboard accounts.
6. **Submit for review.** Reviews usually take a few days. Extensions that can reach any website, which this one needs for merchant sites, sometimes take longer.

When it's approved, share the listing link. That's the whole install for everyone else.

## Updating

Raise the version (`@version` in the script and `version` in `manifest.json`, kept the same), then push. GitHub builds a new ZIP in the [releases](https://github.com/kars3n-zonos/zonos-dispute-researcher/releases). Upload it under **Package** in the developer console and submit. Installed copies update by themselves once it's approved.

## Even easier, for the whole company

A Google Workspace admin can install the extension for everyone at Zonos automatically: Admin console → Devices → Chrome → Apps & extensions → add it by its Web Store ID and set it to **Force install**. Nobody has to click anything.
