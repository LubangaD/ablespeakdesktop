# Notice

AbleSpeak Browser Integration is derived from Voqal's Chrome integration,
https://github.com/voqal/chrome-integration (commit
7b306c597670cb823bc4ac346790cf76c4917e35), licensed under the Apache License,
Version 2.0. The original copyright and licence are kept in `LICENSE`.

AbleSpeak has modified these files. The main changes:

- `manifest.json`: renamed for AbleSpeak, with alarms and the AbleSpeak gateway
  connection (local WebSocket with a token).
- `service-worker.js`: connects to the AbleSpeak gateway, reconnects quickly
  and wakes with an alarm; reports the tab the person is using (the last
  focused window) and its visible page, immediately on tab or window changes;
  adds page actions (scrolling inner panels, clicking by words, tab, media,
  focus and context-menu commands, skipping a YouTube ad); adds the content
  script to tabs that lack it; refuses page readers without code; adds a
  YouTube reader (what plays, the ad, the listed videos with their IDs) and
  YouTube actions (open a video by ID or by its place in the list, next and
  previous video, moving forward and back in a video); adds a Gmail reader
  (the inbox or the open email) and Gmail actions (open, select, mark read or
  unread, archive, delete, draft a reply; it never sends).
- `scripts/content.js`: page actions for AbleSpeak (search, form controls,
  radio buttons and checkboxes by real clicks), and wrapped so it can be added
  to a tab more than once.

The YouTube and Gmail readers and actions are adapted from the Voqal
library's `youtube` and `gmail` profiles (https://github.com/voqal/voqal,
`library/youtube` and `library/gmail`, commit
49ffa7e751ef4c171e60fcdbc861aab0ffeab962, Apache License 2.0). AbleSpeak's
gateway also takes ideas from that library, rewritten: tools and instructions
offered per site or app (its Gmail and Notepad prompts, `library/notepad`),
sponsor segments from SponsorBlock (`library/youtube/youtube.md`), and an
"ignore" tool for speech not meant for the assistant
(`library/voqal/tools/ignore`).

No affiliation with or endorsement by Voqal is implied.
