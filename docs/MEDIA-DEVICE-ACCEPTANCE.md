# Independent-device calling acceptance

Status: not executed in this environment. Synthetic-device SFU, local TURN and API results are recorded separately in CALLING-IMPLEMENTATION.md. Keep independentDevicesVerified false until actual hardware/network results are reviewed.

Use two physical devices on different networks, three eligible user accounts for the group check, headphones, and current supported browsers. The loopback compose overlay cannot serve those devices. Supply existing infrastructure with trusted application HTTPS, API HTTPS and media WSS; configure the server-only variables in .env.example and adapt infra/livekit/server.production.example.yaml. Set WEB_ORIGIN to the exact application origin and build the frontend with NEXT_PUBLIC_API_URL pointing to the HTTPS API. Configure cookie/OIDC settings consistently with the existing identity deployment; local development passwords are not a production identity configuration.

Provider prerequisites: room.auto_create=false, enable_remote_unmute=false, a dedicated cc-UUID namespace, private authenticated Redis, matching API/worker signing configuration, signed callbacks to /v1/media/webhook, routable SFU UDP7882/TCP7881, and authenticated TURN UDP3478/TLS443 with the configured relay range. Use a separate TURN hostname/IP for TLS443 when application/signaling already use443, or a verified compatible ingress. Install trusted certificates on the provider/reverse proxy, forward WebSocket upgrades, disable SSE buffering, and preserve request limits. Do not expose the checked-in development keys or alter global certificate trust to bypass this gate.

Run each check with independent signed-in accounts. Record pass/fail, browser/OS/device, network pair, UTC timestamp and sanitized downloaded Call diagnostics. Never include tokens, device identifiers, candidate addresses or private chat content in shared evidence.

| Check | Procedure | Result/evidence |
|---|---|---|
| A | Alice calls Bob with audio; both people confirm speech is audible in both directions | Pending |
| B | Enable both cameras; verify movement on the other device | Pending |
| C | Invite/join a third eligible user; verify all three audio/video paths | Pending |
| D | Mute/unmute and camera off/on; confirm actual remote reception changes | Pending |
| E | Explicitly share a screen/window/tab; verify remote content. Stop in app, then repeat and stop via browser/OS. Check shared audio where supported | Pending |
| F | Raise hands in known order; temporarily disconnect/reconnect; verify queue and host lowering | Pending |
| G | Exchange chat, temporarily lose network, retry and refresh/rejoin; verify one persisted message and authorized history | Pending |
| H | One participant leaves; other group participants continue | Pending |
| I | Host mutes another participant; verify remote audio stops. User consents to unmute. Remove user; verify removal and access denial | Pending |
| J | Participant attempts End API:403. Host confirms End: everyone disconnects | Pending |
| K | Unrelated tenant/nonmember follows copied link; API, chat and token access denied | Pending |
| L | Removed user refreshes/reconnects with prior session credentials; no media access | Pending |
| M | Disconnect a device, end meeting from host, reconnect device; meeting stays ended | Pending |
| N | Cancel preview and leave/end; verify browser device/capture indicators stop and connections close | Pending |
| TURN | Restrict direct UDP on one test network; verify audio/video and relay transport via TURN/TLS, rather than merely allocation | Pending |
| Browser | Repeat permission-denied, busy/disconnected devices, output selection, autoplay recovery, keyboard focus, mobile layout and screen-reader controls on supported Chrome/Edge, Firefox and Safari targets | Pending |

Sharing release currently retires a physical room generation; expect a brief reconnection and require a new explicit click for the next capture. During provider control-plane failure the app returns an actionable error and cannot guarantee immediate media teardown; do not count an acknowledged UI click alone as successful remote termination.

No endpoint-only encryption claim is made. This document provisions nothing, purchases nothing and contains no assertion of successful public deployment. Required remaining inputs are reachable deployment URLs, trusted certificates/routable ICE and TURN, independent devices/accounts/networks, and human observers for audibility and OS capture behavior.
