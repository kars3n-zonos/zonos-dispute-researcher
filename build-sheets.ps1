# Builds the Sheets edition of the Tools script, zonos-dispute-desk-sheets.user.js, from zonos-dispute-researcher.user.js
# (the Notion edition, the only one to edit): the same script with cases tracked in the team's Google Sheet (one row per
# case, a Google Doc per case) instead of Notion. It holds no keys, so it can be published; it updates itself from the
# public repo.
#
# The GitHub Action (.github/workflows/build-sheets.yml) runs this on every push to main, so nobody has to run it by
# hand. It reads and writes only the two scripts in this folder, so it runs the same anywhere (pwsh on Mac/Linux too).
# Teammates' setup blocks come from the script itself: Tools > Settings > Copy my setup on a set-up browser.
#
#   pwsh -File build-sheets.ps1        (or: powershell -ExecutionPolicy Bypass -File build-sheets.ps1)
param([string]$Here = $PSScriptRoot)

$src = Join-Path $Here 'zonos-dispute-researcher.user.js'
$out = Join-Path $Here 'zonos-dispute-desk-sheets.user.js'
$raw = 'https://raw.githubusercontent.com/kars3n-zonos/zonos-dispute-researcher/main/zonos-dispute-desk-sheets.user.js'

$code = [IO.File]::ReadAllText($src, [Text.Encoding]::UTF8)
if ($code -notmatch "(?m)^  const EDITION = 'notion';") { throw "Couldn't find the EDITION line in the script." }
if ($code -notmatch "(?m)^// @updateURL ") { throw "Couldn't find the @updateURL line in the script." }
$code = $code -replace "(?m)^  const EDITION = 'notion';", "  const EDITION = 'sheets';"
$code = $code -replace "(?m)^// @name(\s+).*$", "// @name`$1Zonos Dispute Desk (Sheets)"
$code = $code -replace "(?m)^// @namespace(\s+).*$", "// @namespace`$1zonos-brokerage-sheets"
$code = $code -replace "(?m)^// @(update|download)URL(\s+).*$", "// @`$1URL`$2$raw"
$code = $code -replace "(?m)^(// @description\s+)Tools for the Zonos broker portal:", '$1Sheets edition: cases go to the team Google Sheet, each with a Google Doc of its answers and decisions. Tools for the Zonos broker portal:'
if ($code -match 'ntn_[A-Za-z0-9]{20,}|sk-ant-') { throw 'A key ended up in the Sheets edition. Not written.' }
[IO.File]::WriteAllText($out, $code, (New-Object Text.UTF8Encoding($false)))
Write-Host "Wrote $out"
