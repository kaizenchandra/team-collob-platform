"""Initial baseline import. Do not rerun after evidence has been added."""
import json
from pathlib import Path
if Path("docs/requirements.json").exists():
    raise SystemExit("Register already exists; do not overwrite implementation evidence.")
# Each pipe-delimited row retains a primary baseline ID and its acceptance scope.
groups = {
'FE-FR': '''Authentication|identity|2|Sign in/out; enterprise SSO and MFA; local recovery if supported; expired sessions require reauthentication
Organization selection|identity|2|Switch only among authorized tenants; active tenant labeled; previous tenant state cleared
Profiles|directory|3|Edit allowed name/photo/job/timezone/status fields; forbidden fields rejected server-side
Presence|realtime|3|Available/busy/DND/away/offline shown to authorized users; manual override expires
Navigation|shell|2|Activity/chat/teams/channels/calendar/calls/files/settings and authorized deep links navigate
Teams|collaboration|3|Create/discover/join/leave/archive/manage teams under role checks
Membership|identity|3|Invite member/guest; list and change permitted roles; remove and revoke active access
Channels|collaboration|3|Create/edit standard/private/shared channels with descriptions and authorized membership
Conversations|messaging|3|Create direct/group chat; name group; show participants; enforce history policy
Composition|messaging|3|Formatting/links/emojis/attachments/mentions and durable drafts; untrusted HTML never executes
Message actions|messaging|3|Eligible edits/deletes; threads/reactions/links/saves/unread survive reload
Message status|realtime|3|Sending/sent/failed/read and retry states; typing expires; retry does not duplicate
Conversation organization|messaging|3|Search/pin/mute/hide/filter; correct unread counts and last-message previews
Channel discussions|messaging|3|Posts/announcements/thread replies/pins and authorized moderation persist
File sharing|files|3|Upload/download/preview/share with progress/validation; unauthorized access denied
File collaboration|documents|3|Version list and integrated editor open authorized files; concurrent edits converge
Search|search|3|Search messages/people/teams/channels/meetings/files with filters and authorized source links
Notifications|notifications|3|Activity/mentions/replies/invites/missed calls with browser preferences and quiet hours
Calendar|calendar|3|Calendar views/details/upcoming meetings/authorized availability rendered in user timezone
Scheduling|calendar|3|Create/update/cancel/respond with attendees/recurrence/timezones/join links
Meeting entry|media|5|Join by link/id; preview/select devices; display lobby; handle denial and unsupported APIs
Audio/video|media|5|Two independent participants exchange media; toggle/switch devices/layout; show connection state
Screen sharing|media|5|Share supported tab/window/screen; identify presenter; stop sharing releases track
Meeting collaboration|media|5|Meeting chat/reactions/hands/participant list synchronize among authorized participants
Meeting administration|media|5|Organizer admits/removes/mutes/assigns presenter/locks/ends; unauthorized control denied
Recording/transcription|artifacts|5|Consent/status/captions/transcript/authorized playback reflect real processing
Breakout rooms|media|5|Create/assign/broadcast/close and return participants; satisfy WEB-03
Calls|media|5|Start/receive/accept/reject/end real browser calls; missed calls and history persist
Tasks|work|3|Private-channel assignment/priority/due date/comments/attachments/completion persist with ACL
Integrations|integrations|3|Mandatory providers integrated with permission/configuration UI; marketplace optional
Settings|shell|3|Theme/language/accessibility/notification/privacy/device preferences persist
Administration|governance|6|Authorized users manage users/roles/policies/integrations/retention and search audit
Connection recovery|realtime|3|Offline/reconnecting visible; drafts preserved; pending distinguished from persisted operations
Help|shell|3|Contextual help/actionable errors/status/feedback submission work''',
'BE-FR': '''Identity|identity|2|Validate configured identity provider/MFA policies; expire/revoke sessions and tokens
Authorization|identity|2|Deny unauthorized tenant/team/channel/conversation/file/meeting requests and subscriptions
Tenants|identity|2|Manage organizations/domains/settings/entitlements and lifecycle with isolation
Directory|directory|3|Persist profiles/resolve users/account status; directory sync optional
Guests|identity|3|Issue/expire/revoke invites; enforce external policy and guest boundaries
Teams/channels|collaboration|3|Lifecycle/membership/ownership/visibility/archive/deletion rules enforced
Presence|realtime|3|Aggregate activity/connections; overrides and stale state expire; updates ACL-filtered
Conversations|messaging|3|Direct/group creation and participant changes enforce documented history policy
Messages|messaging|3|Persist validated messages/edits/deletes/threads/reactions/mentions/attachment references
Real-time delivery|realtime|3|Authenticated connections acknowledge durable acceptance and replay after reconnect
Message consistency|messaging|3|Stable IDs/monotonic conversation order; concurrent identical retries yield one message
Read state|messaging|3|Monotonic read positions/unread/delivery acknowledgments and privacy-aware receipts persist
Notifications|notifications|3|In-app/browser/email digests enforce preferences/quiet hours and deduplication
File storage|files|3|Upload/download/metadata/quotas/versions/controlled links/lifecycle enforced
File processing|files|3|Type validation/malware scan/quarantine/previews; E2EE handling explicit
Document collaboration|documents|3|Editor ACL/session/version conflicts handled and revoked editor access removed
Indexing|search|3|Eligible index entries update on edits/deletes/ACL changes without stale disclosure
Search authorization|search|3|Results/snippets/suggestions/facets never reveal unauthorized content
Calendar integration|calendar|3|Live provider sync covers availability/invites/responses/updates/cancellations
Meeting scheduling|calendar|3|IDs/links/recurrence/timezones/organizers/policies persist consistently
Meeting access|media|5|Validate participants/guest/lobby/roles and revoke active media access
Signaling|media|5|Setup/accept/reject/negotiation/reconnect/termination synchronize real calls
Media|media|5|SFU/TURN routing/adaptive quality/resource allocation work between independent endpoints
Meeting state|media|5|Participants/mute/presenters/reactions/hands/chat/breakouts synchronize
Recording|artifacts|5|Consent/permissions/processing/storage/expiry/retrieval follow encryption policy
Captions/transcripts|artifacts|5|Real captions/transcripts support language/ACL/retention/corrections
Call history|media|5|Outcome/times/participants/privacy-limited diagnostics stored under retention policy
Tasks|work|3|Tasks/assignment/status/deadline/comments/reminders with channel ACL
Integration platform|integrations|3|Mandatory provider boundaries implemented; marketplace/bots/webhook platform optional
Policies|governance|6|Messaging/meeting/guest/file/integration/org policies enforced server-side
Moderation|governance|6|Reports/posting restrictions/rate limits and authorized moderation enforced
Audit|governance|2|Relevant auth/admin/access/sharing/policy events include actor/tenant/target/time
Retention|governance|6|Retention/soft-delete/restore/permanent-delete/legal-hold rules executed
Export|governance|6|Authorized user/tenant exports complete without cross-tenant disclosure
Jobs|operations|3|Async jobs retry transient faults with bounded backoff/DLQ and expose status
Reporting|governance|6|Authorized usage/storage/meeting/service-quality administrative reports generated
Closure|governance|6|Account/tenant closure revokes access and executes transfer/export/retention/deletion''',
'FE-NFR': '''Initial performance|quality|7|LCP p75 <=2.5s under recorded desktop/mobile/network/dataset conditions
Interaction performance|quality|7|INP p75 <=200ms under recorded conditions; long operations show immediate feedback
Visual stability|quality|7|CLS p75 <=0.1 under recorded conditions
Large datasets|shell|3|Bounded pages/virtualization keep 100000-message histories and 10000-member lists responsive
Accessibility|quality|7|WCAG 2.2 AA audit including keyboard/screen reader/focus/contrast/media controls; record limitations
Responsiveness|shell|3|Core flows work at 360/768/1440px without inaccessible horizontal overflow
Compatibility|quality|7|Record actual Chrome/Edge/Safari/Firefox versions tested; unsupported capabilities explained
Usability|quality|7|Critical workflows tested with users; navigation/terminology/feedback consistent; issues recorded
Resilience|realtime|3|Disconnect/restart/retry does not lose drafts or duplicate accepted writes
Security|security|2|XSS/unsafe URL/CSRF/session exposure negative tests pass
Privacy|security|3|Contextual media/notification consent; minimal local data; logout clears sensitive state
Media experience|media|5|Constrained bandwidth/device tests show adaptation and useful quality feedback
Resource efficiency|quality|7|Measure idle/chat/meeting CPU/memory/network and battery; compare documented budgets
Localization|shell|3|Strings externalized; en and ar locale/timezone formats and RTL layout tested
Maintainability|shell|2|Modular typed components/design tokens/contracts documented and static checks pass
Testability|quality|7|Critical browser/accessibility/compatibility/recovery checks run automatically
Observability|operations|2|Privacy-conscious client error/performance events include release/correlation IDs
Release compatibility|operations|8|Old/new client mismatch triggers safe refresh after draft preservation; rolling release tested''',
'BE-NFR': '''Availability|operations|8|Core API 99.95% monthly SLO measured over month; media 99.9% and provider objectives separate
API latency|quality|7|p95 reads <=300ms/writes <=500ms at workload; external/upload/processing exclusions explicit
Message latency|quality|7|p95 acceptance-to-online-recipient <=1s at recorded workload
Search latency|search|7|p95 <=2s at 1000000 messages/100 concurrent searches
Capacity|operations|7|Validate 10000 users/2000 sockets/100 messages per second/100 meetings/50 participants before sign-off
Scalability|operations|8|Demonstrate independent scaling boundaries for API/realtime/jobs/storage/media/search as needed
Tenant isolation|security|2|Cross-tenant negative tests cover SQL/cache/files/search/events/logs/exports
Encryption|security|4|TLS/storage encryption/key rotation demonstrated; separate provider-blind E2EE tests
Access control|security|2|Least privilege/expiry/revocation enforced; active access removed within 5 seconds
Application security|security|7|Input/resource limits/dependency audit; critical 24h/high 7d remediation policy applied
Integrity|messaging|3|FK/orphan and concurrent idempotency tests pass
Consistency|messaging|3|Document and test transactional authoritative permissions and eventual derived state
Durability|operations|8|Acknowledgment follows committed write; replication/failover conforms to durable-ack contract
Fault tolerance|operations|7|Instance/dependency fault injection demonstrates timeouts/retries/isolation/redundancy
Disaster recovery|operations|8|Restore exercise meets RTO <=60min/RPO <=5min; acknowledged-loss tradeoff stated
Backups|operations|8|Encrypted restricted backups retained and restoration verified on schedule
Abuse resistance|security|3|User/tenant quotas/connection/rate/upload/traffic limits tested
Observability|operations|2|Structured redacted logs/metrics/traces/dashboards/alerts tested without sensitive content
Audit integrity|governance|6|Application role cannot alter/delete audit; protected archive retention enforced
Privacy/compliance|governance|6|Deployment privacy/residency/consent/retention/deletion obligations documented and tested; no certification claim
Lifecycle|governance|6|Delete propagates stores/cache/index/replicas; backups expire under policy/holds
Interoperability|integrations|3|Versioned documented APIs and supported OIDC/calendar/document/media protocols tested
Deployability|operations|8|Automated migration/health/rollback/compatible schema release exercised
Maintainability|operations|2|Owners/contracts/runbooks/dependency upgrade policy documented
Testability|quality|7|Authorization/isolation/concurrency/load/recovery/live-provider suites run with evidence
Cost|operations|8|Measure cost per active user/GB/meeting-minute and enforce spending/usage budgets
Media quality|media|7|Join success >=99%; setup p95 <=5s; latency <=300ms/jitter <=30ms/loss <=2% in recorded lab
Graceful degradation|operations|7|Preview/analytics/transcription outages preserve messaging and authorized reads''',
'GAP': '''Channel conversion|migration|4|Standard/private conversion requires actor/ACL preview and explicit historical-access diff; resumable/audited/no leaks
Shared-channel conversion|migration|4|Shared/other conversion previews grants/revokes/history; reconcile guests/external members; resumable/audited/no leaks
Channel relocation|migration|4|Same-tenant private channel team move preserves IDs/messages/threads/files/metadata; reconciles ACL/search/links/subscriptions/notifications atomically with recovery
Private-channel digests|notifications|3|Authorized private activity included only under preferences/quiet hours; recheck ACL at send; no plaintext from E2EE
Private-channel work management|work|3|Private task boards/forms include assignments/due dates/responses/channel ACL
Encrypted messaging|encryption|4|Provider-blind direct/group text using maintained protocol; verified devices/key rotation/recovery/revocation/history rules tested
Encrypted files|encryption|4|Only authorized endpoints decrypt files; key lifecycle tested; scanning/previews/search restrictions visible
Encrypted media|encryption|5|Independent group/channel participants use verified endpoint-only media keys; no silent downgrade
Encrypted artifacts|encryption|5|Consenting authorized endpoint creates/encrypts recordings/transcripts; only intended recipients decrypt
Expanded receipts|messaging|3|Per-recipient receipts tested with 32-person group; privacy settings honored; capacity documented''',
'WEB': '''Separate windows|shell|3|Popout conversations synchronize via backend; secure same-origin sessions; revoke/logout propagates
Larger galleries|media|5|Chrome/Edge >9 and Safari/Firefox >4 tiles measured on supported hardware; adaptive capacity controls
Breakout management|media|5|Create/manage/assign/announce/timer-close/return-to-main demonstrated with independent browsers
Browser E2EE|encryption|5|Browser meeting encryption verified with unsupported fail-closed state
Presentation|media|5|Presenter layouts and synchronized screen annotations work for authorized participants
Shared-content control|media|5|Explicit revocable give/take application control; clearly distinguish from OS remote control
Camera presentation|media|5|Select/permit camera as presentation source; denial/release handled
Video effects|media|5|Background/effects/green-screen with capability detection and measured performance controls
Immersive collaboration|media|5|Avatars/immersive space available with equivalent keyboard/screen-reader participation
Audio options|media|5|Spatial audio/voice isolation/music where supported; unsupported options explained
Speaker coach|media|5|Private opt-in pace/fillers/balance feedback measured locally with stated limits
Microphone adjustment|media|5|Automatic gain/sensitivity applied only with detected support; permission denial explicit
Second device|media|5|Companion/transfer uses authenticated handoff; duplicate audio prevented
Multiple organizations|identity|3|Simultaneous authorized tenant windows with labeled notifications and isolated state
Guest documents|files|3|Authorized guests add/delete files; forbidden actions denied by resource ACL
Large events|media|5|Browser organizer/presenter/moderation/attendee controls tested at defined 500-attendee target
Call queues|telephony|5|Queue/greeting/member/routing administration delegated with ACL and real routing tests
PSTN merging|telephony|5|Two ongoing real PSTN legs merged via provider; credentials/numbers/region/cost recorded
Diagnostics|media|5|Actual WebRTC bandwidth/loss/jitter/RTT stats and actionable feedback displayed'''
}
provider_modules = {'documents':'B-EDITOR', 'telephony':'B-PSTN', 'artifacts':'B-TRANSCRIPTION'}
entries=[]
for prefix,block in groups.items():
    for i,line in enumerate(block.splitlines(),1):
        title,owner,phase,criteria=line.split('|')
        rid=f'{prefix}-{i:02d}'
        deps={'api':[f'/v1/{owner}'], 'events':[f'{owner}.changed.v1'], 'data':[owner], 'providers':[]}
        blockers=[]
        if owner in provider_modules: blockers=[provider_modules[owner]]
        if rid in ['BE-FR-19']: blockers=['B-CALENDAR']
        entries.append(dict(id=rid,description=f'{title}: {criteria}',classification='Required',acceptance_criteria=criteria.split('; '),owner=f'core/{owner}' if owner not in ['shell','quality'] else owner,phase=int(phase),frontend_workflow=title,dependencies=deps,tests=[f'{rid}: positive, negative authorization, persistence/recovery and UI acceptance for every criterion'],evidence=[],status='Blocked' if blockers else 'Not started',blockers=blockers,optional_subscope=('General marketplace/bots/tabs' if rid in ['FE-FR-30','BE-FR-29'] else None)))
expected={f'{p}-{i:02d}' for p,n in [('FE-FR',34),('BE-FR',37),('FE-NFR',18),('BE-NFR',28),('GAP',10),('WEB',19)] for i in range(1,n+1)}
assert len(entries)==146 and {e['id'] for e in entries}==expected
Path('docs/requirements.json').write_text(json.dumps({'baseline':'User specification 2026-10-12; optional subfeatures retained, all primary entries have mandatory scope','requirements':entries},indent=2)+'\n')
