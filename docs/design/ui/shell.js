/*
 * The frame every screen sits in: the sidebar and the top bar, from one
 * definition, so the ten screens cannot drift apart the way the six in
 * ../stitch/ did.
 *
 * A screen says which page it is with `<body data-route="/exams">`, and this
 * writes the sidebar and top bar into `[data-shell="sidebar"]` and
 * `[data-shell="topbar"]`, marking that route as the page you are on.
 *
 * It mirrors App.jsx (HomeSidebar, HomeTopBar): the same three tiers, the same
 * nav icons, the same connection pill, account link and session chip. In the
 * app React draws this and the values come from the server; here they are the
 * demo values below, so a screen opens straight from the file system.
 *
 * `<body data-bare>` leaves the frame off, for Sign in.
 */

// ── The sections, exactly as App.jsx's `allSections` orders them ──
// `tier` is who can open it, per Documentation.md Part 5 "Who can open what".
const SECTIONS = [
  { path: '/',          label: 'Home',          icon: 'grid_view',  tier: 'user' },
  { path: '/progress',  label: 'My progress',   icon: 'insights',   tier: 'user' },
  { path: '/speech',    label: 'Voice & words', icon: 'tune',       tier: 'user' },
  { path: '/students',  label: 'Users',         icon: 'groups',     tier: 'helper' },
  { path: '/exams',     label: 'Exams',         icon: 'assignment', tier: 'helper' },
  { path: '/test',      label: 'Test console',  icon: 'forum',      tier: 'admin' },
  { path: '/developer', label: 'Developer Hub', icon: 'terminal',   tier: 'admin' },
  { path: '/settings',  label: 'Settings',      icon: 'settings',   tier: 'admin' },
];

// Where each screen's file lives, so the sidebar works from the file system.
const FILES = {
  '/': '01-home.html',
  '/progress': '02-my-progress.html',
  '/speech': '03-voice-and-words.html',
  '/sign-in': '04-sign-in.html',
  '/students': '05-users.html',
  '/exams': '06-exams.html',
  '/exam': '07-exam-screen.html',
  '/test': '08-test-console.html',
  '/developer': '09-developer-hub.html',
  '/settings': '10-settings.html',
};

/*
 * The demo values. Every one is a real field the app reads from the server —
 * the names are kept so the port is obvious. A teacher's own name is never
 * shown: the app has no signed-in staff member, so it shows this computer's
 * name instead (DESIGN.md, "Real data in every element").
 */
const DEMO = {
  connected: true,
  adminRole: 'admin',       // null · 'helper' · 'admin'
  byAccount: false,         // an admin Windows account, so no PIN and no Lock
  account: { signedIn: true, email: 'a.kamau@school.ac.ke' },
  student: { name: 'Amina Kamau', signedIn: true },
  computer: 'LAB-03',
  listening: { sensitivity: 'standard', pauseSeconds: 1.2 },
  voiceNotice: null,        // 'Dictating' · 'Asleep' · 'Screen privacy on' · 'Voice bar hidden'
  overlayShown: true,
};

const SENSITIVITY_SHORT = { standard: 'Standard', quiet: 'Quiet Voice', noisy: 'Noisy Room' };

/** "Amina Kamau" → "AK" */
function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function navLink(section, route, locked) {
  const here = section.path === route;
  return `
    <a href="${FILES[section.path]}" class="as-nav-link"${here ? ' aria-current="page"' : ''}${
      locked ? ` aria-label="${esc(section.label)} (locked, PIN needed)"` : ''}>
      <span class="material-symbols-outlined" aria-hidden="true">${section.icon}</span>
      <span class="as-nav-label">${esc(section.label)}</span>
      ${locked ? '<span class="material-symbols-outlined as-nav-lock" aria-hidden="true">lock</span>' : ''}
    </a>`;
}

function navGroup(title, note) {
  return `
    <p class="as-nav-group">
      <span class="as-nav-group-name">${esc(title)}</span>
      <span>${esc(note)}</span>
    </p>`;
}

function sidebar(route) {
  const { connected, adminRole, byAccount, account, student, computer } = DEMO;
  const user = SECTIONS.filter(s => s.tier === 'user');
  const helper = SECTIONS.filter(s => s.tier === 'helper');
  const admin = SECTIONS.filter(s => s.tier === 'admin');
  const who = student ? student.name : computer;

  return `
  <aside class="as-sidebar">
    <div style="display:flex;flex-direction:column;gap:16px;min-height:0">
      <div class="as-brand">
        <span class="as-logo" aria-hidden="true"><span class="material-symbols-outlined">record_voice_over</span></span>
        <span class="as-brand-name">AbleSpeak</span>
      </div>

      <nav class="as-nav" aria-label="Main navigation">
        ${user.map(s => navLink(s, route, false)).join('')}
        ${navGroup('Helper', adminRole ? 'Open' : 'Helper PIN')}
        ${helper.map(s => navLink(s, route, !adminRole)).join('')}
        ${navGroup('Admin', adminRole === 'admin' ? 'Open' : 'Admin PIN')}
        ${admin.map(s => navLink(s, route, adminRole !== 'admin')).join('')}
      </nav>
    </div>

    <div class="as-sidebar-foot">
      <div class="as-conn">
        <div class="as-row" style="gap:6px" role="status">
          ${connected
            ? '<span class="as-pulse" aria-hidden="true"><i></i><b></b></span>'
            : '<span class="as-dot as-bad" aria-hidden="true"></span>'}
          <span class="as-label-sm">${connected ? 'Connected' : 'Offline'}</span>
        </div>
        ${adminRole && !byAccount ? `
          <button type="button" class="as-row-action" style="min-height:28px;padding:0 8px">
            <span class="material-symbols-outlined" style="font-size:16px" aria-hidden="true">lock</span>
            <span class="as-label-sm">Lock</span>
          </button>` : ''}
      </div>

      <a href="${FILES['/sign-in']}" class="as-account-link">
        <span class="material-symbols-outlined" aria-hidden="true">account_circle</span>
        <span class="as-account-email" data-private>${esc(account.signedIn ? account.email : 'Sign in to your account')}</span>
      </a>

      <div class="as-whois">
        <span class="as-avatar" aria-hidden="true">${student ? esc(initials(student.name)) : '<span class="material-symbols-outlined" style="font-size:18px">person</span>'}</span>
        <span class="as-whois-text">
          <span class="as-label-md" data-private>${esc(who)}</span>
          <span class="as-whois-sub">
            ${student ? 'On this computer' : 'No user signed in'}
            ${adminRole ? ` · <span class="as-role">${byAccount ? 'Admin account' : adminRole === 'admin' ? 'Admin pages open' : 'Helper pages open'}</span>` : ''}
          </span>
        </span>
      </div>
    </div>
  </aside>`;
}

function topbar() {
  const { student, listening, voiceNotice, overlayShown } = DEMO;

  return `
  <header class="as-topbar" aria-label="Session">
    <div class="as-topbar-inner">
      <div class="as-topbar-left">
        <a href="${FILES['/progress']}" class="as-session">
          <span class="material-symbols-outlined" aria-hidden="true">account_box</span>
          <span class="as-row" style="gap:6px;min-width:0">
            <span class="as-label-md as-session-name" data-private>${esc(student ? student.name : 'No user signed in')}</span>
            <span class="as-label-sm" style="color:var(--as-ink-warm)" aria-hidden="true">•</span>
            <span class="as-session-state${student ? '' : ' is-none'}">${student ? 'Signed in' : 'Sign in to Windows to start'}</span>
          </span>
        </a>
        ${listening ? `
          <div class="as-hearing as-label-sm as-hide-lg">
            <span class="material-symbols-outlined" aria-hidden="true">hearing</span>
            <span>${SENSITIVITY_SHORT[listening.sensitivity] || 'Standard'} · ${listening.pauseSeconds.toFixed(1)} s pause</span>
          </div>` : ''}
        ${voiceNotice ? `<span role="status" class="as-voice-notice as-label-sm">${esc(voiceNotice)}</span>` : ''}
      </div>

      <div class="as-topbar-right">
        <button type="button" class="as-switch" role="switch" aria-checked="${overlayShown}" aria-label="User overlay shown">
          <span class="as-label-sm" style="color:var(--as-ink-warm)">Overlay</span>
          <span class="as-switch-track" aria-hidden="true"><span class="as-switch-knob"></span></span>
          <span class="as-label-sm">${overlayShown ? 'Shown' : 'Hidden'}</span>
        </button>
        <span class="as-avatar" title="Facilitator console" aria-hidden="true">
          <span class="material-symbols-outlined" style="font-size:18px">person</span>
        </span>
      </div>
    </div>
  </header>`;
}

// ── Draw it ──
(function () {
  const body = document.body;
  if (body.hasAttribute('data-bare')) return; // Sign in has no frame

  const route = body.dataset.route || '/';
  const slot = sel => document.querySelector(`[data-shell="${sel}"]`);

  const side = slot('sidebar');
  if (side) side.outerHTML = sidebar(route);

  const top = slot('topbar');
  if (top) top.outerHTML = topbar();
})();
