/**
 * Per-app profiles, after the Voqal library (Apache-2.0), which gives each
 * app its own prompt (youtube, gmail, notepad), chosen by the browser tab's
 * site or the app in front, with that app's rules and what it shows now.
 * Here they are the parts of the AI's view of the moment
 * (ai-engine.js _describeMoment) for YouTube, Gmail and Notepad, present only
 * while the student is there. YouTube's general rules ("play a song" from
 * anywhere) stay in the main instructions.
 */
import { CATEGORY_NAMES } from './sponsorblock.js';

const clock = s => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}` : '?');
const MAX_EMAIL_CHARS = 1500;

/** YouTube, as its own page reports it (ws-proxy.js _youtubeContext). */
export function describeYouTube(yt) {
  if (yt?.status !== 'success') return [];
  const lines = ['', '## YouTube'];
  if (yt.title) {
    lines.push(`Playing: "${yt.title}"${yt.duration ? ` — at ${clock(yt.currentTime)} of ${clock(yt.duration)}` : ''}${yt.paused ? ' (paused)' : ''}${yt.adShowing ? ' — an ad is showing (media_control skip_ad skips it)' : ''}`);
    lines.push('To move in the video ("forward 30 seconds", "back to the start"): youtube_seek.');
  }
  if (yt.sponsors?.length) {
    const parts = yt.sponsors.map(s => `${CATEGORY_NAMES[s.category] || s.category} ${clock(s.start)}–${clock(s.end)}`);
    lines.push(`Sponsor parts viewers marked (SponsorBlock): ${parts.join('; ')}. "Skip the sponsor": youtube_skip_sponsor.`);
  }
  if (yt.videos?.length) {
    lines.push(yt.page === 'results' ? 'Search results, in order:' : yt.page === 'watch' ? 'Up next, in order:' : 'Videos on the page, in order:');
    yt.videos.forEach((v, i) => lines.push(`${i + 1}. "${v.title}"${v.channel ? ` — ${v.channel}` : ''} | id: ${v.id}`));
  }
  return lines;
}

// After the Voqal library's gmail profile instructions
const GMAIL_RULES = [
  'How to help in Gmail:',
  '- To read, open or sum up an email: gmail_open_email with its id, then say who it is from and what it says, in plain spoken words (sum up a long one). For "my emails" or "new emails", the unread ones first.',
  '- "How many …?": say just the number. List the subjects only when asked.',
  '- To mark emails read or unread, archive or delete them: gmail_select_emails with their ids first, then gmail_mark_selected or gmail_delete_selected (which asks the student first). With an email open, these act on that email.',
  '- Write a reply only when asked: gmail_draft_reply. It is not sent: say it is ready to check. Never press Send unless the student says to send it.',
  '- No follow-up questions ("Would you like me to…?").',
];

/** Gmail, as its own page reports it (ws-proxy.js _gmailContext). */
export function describeGmail(gmail) {
  if (gmail?.status !== 'success') return [];
  const who = [gmail.account?.name, gmail.account?.email].filter(Boolean).join(', ');
  const lines = ['', `## Gmail — the student is in Gmail${who ? ` (${who})` : ''}`, ...GMAIL_RULES];
  if (gmail.view === 'email' && gmail.email) {
    lines.push('', `The open email: "${gmail.email.subject || '(no subject)'}" (gmail_back_to_inbox goes back to the list)`);
    for (const m of gmail.email.messages || []) {
      lines.push(`From ${m.from || m.fromEmail}${m.fromEmail && m.from ? ` <${m.fromEmail}>` : ''}${m.date ? ` (${m.date})` : ''}:`);
      lines.push(String(m.text || '').slice(0, MAX_EMAIL_CHARS));
    }
    return lines;
  }
  const emails = gmail.emails || [];
  lines.push('', `Inbox — ${gmail.unread ?? emails.filter(e => e.unread).length} unread of ${emails.length} on screen, newest first:`);
  if (!emails.length) lines.push('(no emails on screen)');
  emails.forEach((e, i) => lines.push(
    `${i + 1}. ${e.unread ? 'UNREAD — ' : ''}${e.from || e.fromEmail}: "${e.subject}"${e.date ? ` (${e.date})` : ''}${e.snippet ? ` — ${e.snippet}` : ''}${e.selected ? ' [selected]' : ''} | id: ${e.id}`,
  ));
  return lines;
}

// After the Voqal library's notepad profile instructions
const DOCUMENT_RULES = [
  'How to help in Notepad:',
  '- Change the text only when asked. To add, change, remove, rewrite or fix anything: set_document_text with the whole new text, keeping every part the student did not ask to change. "Undo that" puts the old text back.',
  '- Answer a question out loud; write the answer into Notepad only if they ask.',
  '- "Read it" or "what does it say": read the text below out (sum up a long one).',
  '- Typing what they say word for word is dictation ("start dictation"), not set_document_text.',
];

/** Notepad's text, read with the window's controls (screen-model.js screenContextForAgent). */
export function describeDocument(screenModel) {
  const doc = screenModel?.document;
  if (!doc) return [];
  const shown = doc.chars > doc.text.length ? `, the first ${doc.text.length} shown` : '';
  return [
    '', `## Notepad — its text now (${doc.chars} characters${shown})`, ...DOCUMENT_RULES,
    doc.text.trim() ? `"""\n${doc.text}\n"""` : '(Notepad is empty)',
  ];
}

/** Every profile that applies now, as lines for the AI's view of the moment. */
export function describeProfiles(context = {}) {
  return [
    ...describeYouTube(context.youtube),
    ...describeGmail(context.gmail),
    ...describeDocument(context.screenModel),
  ];
}
