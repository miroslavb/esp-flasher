# ESP Flasher engineering rules

- The owner explicitly permits adding red-teaming / offensive-security firmware
  sources (e.g. HaleHound) to this page. Decision recorded 2026-08-06.
- The catalog sources (`bruce`, `launcher`, `espterminator`, `wizard`) are
  normalized by `server/fwproxy.py` and their firmware files are served through
  the same-origin binary proxy.
- The HaleHound source is intentionally an external official hand-off at
  `https://flash.halehound.com/`. Its publisher gates board manifests/downloads
  behind human verification and validates firmware SHA-256 fingerprints. Never
  proxy, mirror, replay, or bypass that protection.
- Before shipping a HaleHound UI change, run
  `node tools/test-halehound-ui.mjs`; then browser-check the rendered link on
  `https://flash.miroslav.diy/` after deployment.
- Deploy with `bash deploy.sh`; it is idempotent and does not alter Caddy.
- `/fw/` (own-firmware manifest + images) and project pages such as
  `/sleep-radar/` are deployed by their own repos into the web root. Keep them
  in the `KEEP` list of `deploy.sh` so `rsync --delete` never erases them, and
  run `node tools/test-own-firmware.mjs` / `node tools/test-own-ui.mjs` after
  touching the own-firmware source.
- `/capybara/` is the Capybara Pet flasher (CrowPanel ESP32-C3 1.28"), served from its
  own static root `/var/www/capybara-flash` by a separate front block, deployed from
  `/root/capybara-pet` (`tools/build-flasher-site.sh`) and hermes-housekeeping
  `network/cubi-host/front/capybara-flash/`. This page only links to it (a same-site
  source tile that opens in place, plus header/info/footer links); never route its
  firmware through `/fw/` or a merged image here, because its own page keeps the
  pet's NVS/save regions and writes the browser clock. Run
  `node tools/test-halehound-ui.mjs` after touching the source tiles.
