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