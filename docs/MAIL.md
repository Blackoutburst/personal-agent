# Mail connector (#50)

One dedicated mailbox per owner, handled by that owner's companion only. First use: studio@blackoutburst.com for Swarm
Dev Studio (Board project "Swarm Dev Studio", ticket #3). Board agents never get mail access: they @mention the
companion on the Board with the target and draft, and the companion sends, then answers on the Board with a status.

Code: `src/mail.mjs` (reading, limits, MIME, SMTP client), tools `mail_*` in `src/scheduler-mcp.mjs`, the Me › Connectors
entry in `src/connectors.mjs`, the companion's rules in the "Mail" section of `src/companion.mjs`.

## What the companion can do

| Tool | What it does |
| --- | --- |
| `mail_status` | Address, sender name, purpose, limits and usage, unhandled count, opt-outs, each contacted company. |
| `mail_inbox` / `mail_read` | Received mail (unhandled by default). Text is untrusted data. |
| `mail_send` | `first` (new company), `follow_up` (the one later reminder), `reply` (to someone who wrote). |
| `mail_mark_handled` | Takes a received mail off the to-do list. |
| `mail_opt_out` | Records a "don't contact me" by hand (mails that say stop are recorded automatically). |

New mail queues a `connector` wake ("App notice: N new emails…"), once per batch.

## Limits enforced in code

- `limits.companies` (default 30) distinct companies may get a `first` mail. A company is the recipient's domain, or
  the full address for personal providers (gmail.com, orange.fr…).
- One `first` per company; `limits.followUps` (default 1) `follow_up`s per company, at least 3 days after the last mail,
  and only while the company has not written back (then it is `reply`).
- `limits.perDay` (default 15) mails of any kind in a rolling 24 hours.
- Opt-out list: a received mail whose subject or first lines ask to stop (STOP, unsubscribe, désinscrire, « ne plus
  recevoir »…) blocks its sender and company at once; nothing is ever sent to them again, by any kind.
- Every mail gets the signature, the opt-out line and a `List-Unsubscribe` header. Bounces and out-of-office mail are
  never answered.
- A send is recorded before it leaves. A refused send can be retried with the same `requestId`; a send whose outcome is
  unknown stays `pending`, counts against the limits and is never resent.

## Server setup (admin, done for studio@ on 2026-11-04)

Receiving — Postfix delivers into a Maildir the companion service can read (it runs as `ubuntu`, `ProtectHome=read-only`
with `/home/ubuntu/personal-agent-data` writable):

- `/etc/postfix/bb-virtual`: `studio@blackoutburst.com bbstudio@mail.blackoutburst.com`; `bbstudio OK` in
  `bb-local-recipients` (system user `bbstudio`, nologin, only reserves the name).
- `/etc/postfix/studio/aliases` (directory and files owned by `ubuntu`, so delivery runs as ubuntu):
  `bbstudio: /home/ubuntu/personal-agent-data/mail/studio/Maildir/`; built with `sudo -u ubuntu postalias` and listed
  second in `alias_maps`.
- DNS: MX `10 mail.blackoutburst.com.`; SPF, DMARC, DKIM (selector `bb20261014`) and PTR already covered the domain.

Sending — a separate loopback submission service, so the account-mail service on 587 is unchanged:

- `master.cf`: `127.0.0.1:588` smtpd (`syslog_name=postfix/studio`, TLS required, SASL required) with cleanup
  `bb_studio_cleanup`. Envelope sender must be studio@ (`bb-studio-envelope`); headers allow one `From:` with studio@ and an
  optional display name only (`bb-studio-headers`); no `Sender:`/`Resent-`. OpenDKIM signs it like the account mail.
- SASL login `studio` in `/etc/dovecot/bb-smtp-users` (SHA512-CRYPT); `bb-sender-login` maps studio@ to it only. The
  password is in `~/.config/personal-agent/mail/studio.password` (0600, never in the database, logs, Board or chat).

The owner's entry in `owners.json`:

```json
"mail": {
  "address": "studio@blackoutburst.com",
  "displayName": "Thomas Huyghues des etages — Swarm Dev Studio",
  "maildir": "/home/ubuntu/personal-agent-data/mail/studio/Maildir",
  "smtp": { "port": 588, "user": "studio", "passwordFile": "/home/ubuntu/.config/personal-agent/mail/studio.password", "servername": "mail.blackoutburst.com" },
  "signature": "…", "purpose": "…",
  "limits": { "companies": 30, "followUps": 1, "perDay": 10 }
}
```

Restart the service after editing. The owner can switch Mail off and on in Me › Connectors.

To check by hand: `sudo grep postfix/studio /var/log/mail.log | tail` (addresses only; never copy mail text out).

## Private Studio contact view (#52)

The authenticated web app's **Studio** tab (`#studio`) is a read-only view of the dedicated business mailbox's
contacts and sent/received exchanges. It cannot send, mark handled, change opposition or adjust limits. Those
operations remain companion-only. Account validation runs on every `/api/studio` request; a client cannot select
another owner or mailbox. Nothing from companion conversations, memories or provider settings is returned.

Enable it explicitly in the dedicated mailbox owner's `mail` configuration:

```json
"studioViewers": ["<existing-owner-label>", "<other-authorized-owner-label>"]
```

Use the exact labels from the runtime's existing `owners` entries. Every viewer must be a configured owner and may
be assigned to only one Studio mailbox. There is no implicit sharing, including for the mailbox owner. The server
admin adds only this field for the authorized Studio humans, preserving the other settings, then restarts the
service. A viewer needs an existing companion identity; the mailbox owner must already have signed in. Never
publish the runtime file or mail bodies to the Board. Account-only access is still required; this option does not
make a public page.

`mail_archive` keeps the composed outgoing body (including the actual signature and opt-out line) alongside the
pre-transport pending record. Unknown outcomes stay visibly uncertain and are never reported as sent. Received
bodies are retained by the normal connector scan, including handled messages whose Maildir file is still present.
Backfilling those bodies does not reclassify old messages, mark them handled/notified or recreate suppressions.
There is no invented reconstruction of old sent bodies: old metadata remains visible with an explicit unavailable
body notice. Missing old inbound files are counted in the provenance note. The view itself never scans the mailbox,
changes sending counters or wakes the companion. Detail pages contain at most 50 messages; the contact view shows
at most the 200 most recent companies and discloses that limit. Mail text is rendered as plain text, with no HTML,
remote images or active links.

Deployment uses the normal release procedure. The additive archive table is retained on rollback; older code
ignores it. No other mail table schema or limits change. To roll back to a version that predates the viewer field,
remove only `studioViewers` from the runtime configuration as well (older parsers reject unknown keys).
