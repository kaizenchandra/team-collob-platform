# Concord — enterprise collaboration implementation

Next.js App Router / React / strict TypeScript frontend, a Node.js TypeScript modular API, PostgreSQL transactions and persistent event replay. **Limited local development release; the full 146-requirement specification is not complete.**

## Access the running local release

- Web (Docker release): **http://localhost:3101**
- API readiness: http://localhost:4100/ready
- Alice: `alice@acme.test` / `Development123!`
- Bob: `bob@acme.test` / `Development123!` (use a separate browser profile/private window for independent messaging)
- Eve: `eve@northstar.test` (other organization); Sam: `guest@partner.test` (guest). Same development password.

These synthetic accounts are forbidden in production mode. Local deployment uses loopback bindings and development identity. It is not externally deployed or production ready.

## Start from source

Requirements: Node 24 LTS, npm, Docker Compose, Chrome for browser tests.

```sh
npm ci
docker compose up -d postgres
npm run db:seed
docker compose -f compose.yaml -f compose.local.yaml up -d --build
```

For source development, run only Postgres in Docker, then `DEV_AUTH=true npm run api` and `npm run dev` in two terminals. For an optimized host build use `npm run build` then `npm run start`. Read [operations](docs/OPERATIONS.md) before changing deployment or data.

For real local provider sign-in, add the [SSO overlay](docs/OPERATIONS.md#local-sso-overlay-011) and run the explicit subject-provisioning command. The running local release is `0.1.12-local`. New messages support Markdown formatting, safe links and a preview; existing messages remain plain text. Structured mentions use channel-authorized recipients and appear in the recipient’s Mentions activity filter. Use the composer paperclip to send a scanned conversation file with your current message; recipients download through current permissions.

## Working scope

- Development sign-in, organization selection, resource authorization and independent tenant memberships; live local Keycloak OIDC/PKCE sign-in, durable single-use callbacks and signed-token assurance checks; password+OTP MFA, one-time recovery codes, signed provider logout and bounded provider-session reconciliation verified locally; tenant-scoped identity events and minimized authentication-failure auditing implemented; enterprise configuration, forgotten-password/lost-all-factors recovery and deployment validation remain unfinished.
- Teams and standard/private/shared channels; direct/group chats; channel access previews and transactional conversion/move APIs.
- Durable messages, replies, reactions, edits/deletion, saved flags, explicit read positions and per-recipient receipts; persistent server drafts, tab-scoped pending-send recovery across reload/navigation, typing, expiring presence, authorized search/activity, real event replay and popout windows.
- Private task boards and forms with responses/comments, local meeting scheduling/RSVP/cancellation, profiles/themes/privacy preferences, feedback.
- Manual single-use invitations, membership role/revocation controls, basic audit view.
- Private local uploads with real ClamAV scanning, durable scan jobs and authorized clean-file downloads, retry-safe uploads and conservative orphan cleanup. Previews, object storage, editor integration and versioning remain unfinished.
- Automated API/browser checks, Docker images and local deployment, CI definition, bounded latency and database restore smoke exercises.

The UI explains unavailable services. **No real media, E2EE, PSTN, collaborative editor, external calendar or email integration is currently implemented.** Enterprise governance, advanced browser features, production monitoring/HA/backups/TLS and large-scale verification remain incomplete. A production build passing is not full product acceptance.

## Verification

```sh
docker compose exec -T postgres createdb -U concord concord_test # first test run only
npm run requirements
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run build
```

Core integration tests use a separate test database. Browser tests use the running local deployment, create labeled test records, and include independent sessions. Reports are in `playwright-report`; screenshots in `test-results`. Full development dependency audit has an unresolved upstream braces advisory; production dependency audit is clean at the recorded check.

## Documentation and continuity

- [Architecture, runtime selection, diagrams, threat model and decisions](docs/ARCHITECTURE.md)
- [Machine-readable 146-entry requirements register](docs/requirements.json)
- [Readable traceability matrix](docs/TRACEABILITY.md)
- [Verification report](docs/VERIFICATION.md)
- [Operations, provider setup, backup and rollback](docs/OPERATIONS.md)
- [Durable progress checkpoint and next executable steps](docs/PROGRESS.md)

All mandatory requirements remain in scope. No mandatory feature has been silently deferred, and partial implementation does not count as verification of a whole requirement.

To enable the verified local scanner, add `-f compose.scanning.yaml` to the combined Compose command (see [scanner operations](docs/OPERATIONS.md#local-file-scanning-0110)). Without a worker, uploads remain quarantined.

If an upload response is lost, reselect the same file in the same tab after reload to retry without duplication. Only recovery identifiers/fingerprints are stored locally; the browser must ask you to select the bytes again.
