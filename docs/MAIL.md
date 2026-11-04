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
