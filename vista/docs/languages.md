# Languages in Vista

Every person picks **English**, **Español**, or **English + Español** (bilingual). The choice follows them everywhere: the app, text messages, notices sent by other people, and Vi.

## Choosing a language

| Where | How |
|---|---|
| App, any screen | The 🌐 button in the header (shows `EN`, `ES` or `EN·ES`) opens the language picker |
| App, sign-in | The same 🌐 button, before choosing who you are |
| Text | `ENGLISH`, `ESPAÑOL`, `BILINGUAL` / `BILINGUE` (or `AMBOS IDIOMAS`) at any time |

The picker labels are always in their own language ("English", "Español", "English + Español"), so anyone can find theirs.

**One setting per person.** Changing it in the app changes texts too, and the other way round. It is stored by the Vista API (`/me/prefs`), not in Salesforce. In fixture mode the app and the text simulator share it through the browser.

## Bilingual mode

For crews that share a phone or mix English and Spanish speakers.

- **App:** every label, button, status and message shows `English / Español`. The bottom bar stacks the two languages. Checklists and photo requirements show both.
- **Text:** every line comes in both languages, for example `In progress / En curso`. Bilingual texts are about twice as long, so they cost more to send.
- **Job text from Salesforce** shows the original with the translation under it (in texts, `original / translation`).

## Translation of free text

Some text is typed by people rather than written into Vista: job descriptions, line items and case subjects in Salesforce, and what installers and PMs type (work descriptions, what a draw covers).

| Who reads it | What they see |
|---|---|
| Someone in the other language | The translation, with **Show original** / **Ver original** one tap away (one toggle swaps everything on the screen). By text: a "Translated for you. Reply ORIGINAL 1" line, and `ORIGINAL 1` resends the job as written. |
| Bilingual | Original and translation together |
| Same language as written | Unchanged |

- **Salesforce always keeps the original.** Translations are never written back.
- Translations are made by **Vi** (Claude) in the Vista API, **once per text and language**, and cached. If a translation isn't ready yet, the app shows the original with "Translation on its way".
- Messages Vista itself sends to someone else (sent back, approved, reminders) are composed in the **receiver's** language, not the sender's.
- Machine translation of job notes is very good but not perfect; that is why the original is always one tap away.

In fixture mode the cache is `web/fixtures/translations.json`.

## Requesting another language

- **App:** the picker's "Need another language?" field → **Request**.
- **Text:** `LANGUAGE Português` / `IDIOMA Português` (`LANGUAGE` alone lists the options).

The request is saved on the person and sent to Matt with their name. Until that language is added, **Vi already answers that person's questions in the language they asked for**; the rest of Vista stays in English or Spanish.

Adding a full language later means translating `i18n/<code>.json` and the trade checklists (`web/content/checklists/*.json`). No code changes.
