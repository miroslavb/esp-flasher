# ESP Flasher change controls

- Add an upstream firmware source only after verifying its official distribution,
  supported images, and intended lawful use.
- Do not proxy, mirror, distribute, or link from this flasher to firmware that
  advertises wireless disruption/jamming, unauthorized replay or access, payload
  delivery, credential/data exfiltration, or comparable harmful capabilities.
- Keep upstream catalog support constrained to the normalizer and same-origin
  binary proxy in `server/fwproxy.py`; preserve its host allow-list checks.
- Before deployment, run the focused UI/API checks and verify the live site plus
  `fw-proxy.service` health.
