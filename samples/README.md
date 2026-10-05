# Sample files

Mail files with nothing personal in them, free to use: for trying the app, for
the tests in this repository, and for anyone testing a mail tool of their own.
Drop any of them on the app to open it.

This is the only place in the repository where mail files are committed. Every
file here is either made up by this project or is synthetic test data
published under an open license, and a test
(`tests/unit/samples.test.ts`) fails if anything else appears.

## What is here

### `made-up/`: written for this project

Built by `tests/support/fixtures.mjs`; fictional people at example.com. Same
license as the rest of this repository (MIT).

| File | What it is |
| --- | --- |
| `mail.eml` | An ordinary message with a picture attached |
| `forwarded.eml` | A message with another message attached, which has a file attached |
| `spoof-sender.eml` | A message that tries to pass off a different address as its sender |
| `hostile-html.eml` | An HTML message that tries script, a form, a frame, a tracking pixel and remote content. Harmless: everything points at the reserved name `tracker.example`. Useful for checking what a mail viewer lets through |
| `mail.msg` | A minimal Outlook `.msg` |
| `batch.zip` | A zip holding `mail.eml` and `mail.msg` |

To rebuild them after changing the fixture code: `npm run fixtures -- samples/made-up`.

### `pst-extractor/`: Outlook mailboxes

From the test data of [pst-extractor](https://github.com/HiraokaHyperTools/pst-extractor)
(commit `238a905`), unmodified. MIT license; see `pst-extractor/LICENSE`.
Test addresses only (`example.com`, `xmailserver.test`).

| File | What it is |
| --- | --- |
| `alpha-beta-gamma-delta.pst` | One message kept in the top folder itself, with a picture and a message attached |
| `contacts.pst` | A contact with a Japanese name, in the current (Unicode) format |
| `contacts97-2002.pst` | The same contact in the old Outlook 97-2002 format |

### `msgreader/`: Outlook `.msg` files

From the test data of [msgreader](https://github.com/HiraokaHyperTools/msgreader)
(commit `3a5a935`), unmodified. Apache License 2.0; see `msgreader/LICENSE`.
Test addresses only (`xmailserver.test`, `hmailserver.test`, `example.com`).

Plain messages, messages with attached and inline files, a message inside a
message (and one inside that), contacts in Unicode and in 8-bit text, a
message in a Japanese code page, and a recurring appointment.

## What is not here, and why

The tests also use three larger mailboxes and one more `.msg`
(`npm run mailboxes` downloads them into `fixtures/public/`, which is
git-ignored). They are public, but they hold real people's mail or name a real
person, so they are not kept in this repository:

- `enron.pst`: mail from the Enron corpus, released by a US regulator.
- `mtnman1965@outlook.com.ost` and `pstextractortest@outlook.com.ost`: real
  Outlook.com accounts used by the pst-extractor authors for testing.
- `A schedule.msg`: an appointment that names its author.

There is no large mailbox here that is entirely made up, because a `.pst` can
only be written by Outlook. If you have Outlook and can export one built from
made-up mail, it would be welcome.

## Adding a file

Only made-up mail, or synthetic test data whose license allows it to be
redistributed and which names no real person. List it in
`tests/public-mailboxes.json` with its source, size and SHA-256, add its
baseline with `npm run baselines`, and say where it came from in the pull
request.
