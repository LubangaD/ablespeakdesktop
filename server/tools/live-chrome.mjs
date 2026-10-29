/**
 * Live check of AbleSpeak's Chrome extension in a real browser: Chrome for
 * Testing with the extension (chrome-integration-master) loaded, driven
 * through AbleSpeak's own gateway code (WsProxy), and checked against what
 * the browser really shows. Approach from the Voqal Clone Lab
 * (app/test/live-chrome.mjs).
 *
 *   node tools/live-chrome.mjs
 *
 * It uses its own browser, profile and test pages on 127.0.0.1 — never the
 * person's Chrome or tabs. Its window opens off-screen. Browser: CHROME_TEST_EXECUTABLE, else the lab's
 * Chrome for Testing, else Playwright's own (npx playwright-core install chromium).
 * Writes tools/live-chrome-run/report.json and a screenshot.
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { WsProxy } from '../src/ws-proxy.js';
import { initDatabase, closeDatabase } from '../src/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const run = path.join(here, 'live-chrome-run');
// LIVE_CHROME_EXTENSION tests another copy, e.g. an older version to see the checks catch its bugs
const EXTENSION_DIR = process.env.LIVE_CHROME_EXTENSION || path.join(here, '..', '..', 'chrome-integration-master');
const LAB_CHROME = 'D:/Voqal-Clone-Lab/test-browsers/chromium-1248/chrome-win64/chrome.exe';
const TOKEN = 'live-test-token';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function browserPath() {
  if (process.env.CHROME_TEST_EXECUTABLE) return process.env.CHROME_TEST_EXECUTABLE;
  if (existsSync(LAB_CHROME)) return LAB_CHROME;
  return chromium.executablePath();
}

// ── Test pages ──
function startPages() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/strict-form') {
      // A strict security policy: page scripts only from this site, nothing inline
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'");
      res.setHeader('Content-Type', 'text/html');
      return res.end(`<!doctype html><title>Strict form</title>
        <h1>Strict form</h1>
        <label><input type="checkbox" id="agree"> I agree to the rules</label>
        <fieldset><label><input type="radio" name="theme" id="dark" value="dark"> Dark</label>
        <label><input type="radio" name="theme" id="light" value="light"> Light</label></fieldset>
        <p id="state">nothing changed</p>
        <script src="/form.js"></script>`);
    }
    // Shaped like YouTube's player during an ad, with a strict policy like YouTube's:
    // /ad has its Skip button showing, /ad-wait not yet
    if (url.pathname === '/ad' || url.pathname === '/ad-wait') {
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; require-trusted-types-for 'script'");
      res.setHeader('Content-Type', 'text/html');
      const button = url.pathname === '/ad' ? '<button class="ytp-skip-ad-button" id="skip">Skip</button>' : '';
      return res.end(`<!doctype html><title>Video</title>
        <div class="html5-video-player ad-showing"><video></video>${button}</div>
        <p id="state">ad playing</p><script src="/ad.js"></script>`);
    }
    // Shaped like YouTube's search results (its own element names)
    if (url.pathname === '/results') {
      res.setHeader('Content-Type', 'text/html');
      const video = (id, title, channel) => `<ytd-video-renderer><a id="video-title" href="/watch?v=${id}" title="${title}">${title}</a>
        <ytd-channel-name><a>${channel}</a></ytd-channel-name></ytd-video-renderer>`;
      return res.end(`<!doctype html><title>Results</title><ytd-search>
        ${video('AAAAAAAAAA1', 'Michael Jackson - Thriller', 'Michael Jackson')}
        ${video('BBBBBBBBBB2', 'Michael Jackson - Beat It', 'Michael Jackson')}
        ${video('CCCCCCCCCC3', 'Billie Jean (Live)', 'Fan channel')}</ytd-search>`);
    }
    // Shaped like Gmail (its own class names): an inbox of three, two unread,
    // that opens a thread, selects, marks read, goes back and opens a reply box.
    // It has a Send button the extension must never press (window.sent).
    if (url.pathname === '/gmail') {
      res.setHeader('Content-Type', 'text/html');
      const row = (id, unread, name, email, subject, snippet) => `<tr class="zA ${unread ? 'zE' : 'yO'}" id="${id}">
        <td><div role="checkbox" aria-checked="false"></div></td>
        <td><span email="${email}" name="${name}">${name}</span></td>
        <td><span class="bog">${subject}</span><span class="y2"> - ${snippet}</span></td>
        <td class="xW"><span title="Fri, Oct 17, 2026, 9:0${id.slice(-1)} AM">9:0${id.slice(-1)} AM</span></td></tr>`;
      return res.end(`<!doctype html><title>Inbox - Gmail</title>
        <a aria-label="Google Account: Test Student (student@example.com)" href="#">account</a>
        <div id="toolbar"><div role="button" aria-label="Mark as read">read</div><div role="button" aria-label="Archive">archive</div>
          <div role="button" aria-label="Delete">delete</div></div>
        <table id="list"><tbody>
          ${row(':r1', true, 'Ms Wanjiku', 'wanjiku@school.example', 'Exam timetable', 'The timetable is attached')}
          ${row(':r2', true, 'Library', 'library@school.example', 'Books due', 'Two books are due Monday')}
          ${row(':r3', false, 'Coach Otieno', 'otieno@school.example', 'Practice', 'Practice moves to 4 pm')}
        </tbody></table>
        <div id="thread" style="display:none">
          <div role="button" aria-label="Back to Inbox">back</div><h2 class="hP">Exam timetable</h2>
          <div class="adn"><span class="gD" email="wanjiku@school.example" name="Ms Wanjiku">Ms Wanjiku</span>
            <span class="g3" title="Fri, Oct 17, 2026, 9:01 AM">9:01 AM</span>
            <div class="a3s">Dear students, the exam timetable is attached. Exams start on Monday at 8 am.</div></div>
          <div role="button" aria-label="Reply">reply</div>
          <div id="compose" style="display:none"><div aria-label="Message Body" contenteditable="true"></div>
            <div role="button" aria-label="Send" id="send">send</div></div>
        </div>
        <script src="/gmail.js"></script>`);
    }
    if (url.pathname === '/gmail.js') {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end(`window.sent = false;
        const show = (id, on) => { document.getElementById(id).style.display = on ? '' : 'none'; };
        document.addEventListener('click', e => {
          const t = e.target;
          if (t.matches('[role="checkbox"]')) t.setAttribute('aria-checked', t.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
          else if (t.matches('span.bog')) { show('list', false); show('toolbar', false); show('thread', true); }
          else if (t.matches('[aria-label="Back to Inbox"]')) { show('thread', false); show('list', true); show('toolbar', true); }
          else if (t.matches('[aria-label="Reply"]')) show('compose', true);
          else if (t.matches('[aria-label="Mark as read"]')) document.querySelectorAll('tr.zA').forEach(r => {
            if (r.querySelector('[role="checkbox"]').getAttribute('aria-checked') === 'true') r.classList.remove('zE');
          });
          else if (t.id === 'send') window.sent = true;
        });`);
    }
    // A video a minute long (silent), for going forward and back in it
    if (url.pathname === '/video') {
      res.setHeader('Content-Type', 'text/html');
      return res.end('<!doctype html><title>Video</title><div class="html5-video-player"><video src="/minute.wav" preload="auto"></video></div>');
    }
    if (url.pathname === '/minute.wav') {
      const rate = 8000, samples = rate * 60;
      const wav = Buffer.alloc(44 + samples, 128); // 8-bit silence
      wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples, 4); wav.write('WAVEfmt ', 8);
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
      wav.write('data', 36); wav.writeUInt32LE(samples, 40);
      res.setHeader('Content-Type', 'audio/wav');
      // Chrome only seeks in media it can fetch in pieces
      res.setHeader('Accept-Ranges', 'bytes');
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${wav.length}`);
        return res.end(wav.subarray(start, end + 1));
      }
      return res.end(wav);
    }
    if (url.pathname === '/ad.js') {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end(`document.getElementById('skip')?.addEventListener('click', () => {
        document.getElementById('state').textContent = 'skipped';
      });`);
    }
    if (url.pathname === '/form.js') {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end(`document.addEventListener('change', e => {
        document.getElementById('state').textContent = e.target.id + ':' + e.target.checked;
      });`);
    }
    res.setHeader('Content-Type', 'text/html');
    const name = url.pathname.split('/').pop() || 'page';
    res.end(`<!doctype html><title>${name}</title><h1>Page ${name}</h1>${'<p>Text to scroll.</p>'.repeat(200)}`);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

// ── AbleSpeak's gateway (the real WsProxy) on a port of its own ──
async function startGateway(port = 0) {
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const proxy = new WsProxy({ server, aiEngine: null, wsToken: TOKEN });
  proxy._broadcastDashboard = () => {};
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { server, proxy, port: server.address().port };
}

async function stopGateway({ server, proxy }) {
  clearInterval(proxy._heartbeatInterval);
  for (const ws of proxy.extensionClients) { try { ws.terminate(); } catch {} }
  proxy.extensionWss?.close();
  proxy.dashboardWss?.close();
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
}

async function waitFor(what, test, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await test()) return; } catch {}
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const report = { started: new Date().toISOString(), browser: null, checks: [], ok: false };
async function check(name, body) {
  const started = Date.now();
  try {
    const detail = await body();
    report.checks.push({ name, ok: true, ...(detail ? { detail } : {}), ms: Date.now() - started });
    console.log(`  PASS  ${name}${detail ? ` (${detail})` : ''}`);
  } catch (err) {
    report.checks.push({ name, ok: false, detail: err.message, ms: Date.now() - started });
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}

await fs.rm(run, { recursive: true, force: true });
await fs.mkdir(path.join(run, 'data'), { recursive: true });
await initDatabase(path.join(run, 'data', 'ablespeak.db'));
const pages = await startPages();
const base = `http://127.0.0.1:${pages.address().port}`;
let gateway = await startGateway();
let browser;

try {
  // A copy of the extension with a test-only switch-on (instead of the toolbar click)
  const ext = path.join(run, 'extension');
  await fs.cp(EXTENSION_DIR, ext, { recursive: true });
  await fs.appendFile(path.join(ext, 'service-worker.js'), `
// Test only (tools/live-chrome.mjs): switched on without the toolbar click, aimed at the test gateway
globalThis.__ablespeakTest = (wsUrl, wsToken) => new Promise(resolve =>
    chrome.storage.local.set({ enabled: true, wsUrl, wsToken }, () => { enabled = true; startReconnectionLoop(); resolve(); }));
`);
  const exe = browserPath();
  report.browser = exe;
  console.log(`Chrome for Testing: ${exe}`);
  // A real window, placed off-screen: headless Chrome calls every window focused
  // and ignores chrome.windows.update({ focused }), so window checks can't pass there
  browser = await chromium.launchPersistentContext(path.join(run, 'profile'), {
    executablePath: exe,
    headless: false,
    args: ['--window-position=-2400,0', '--window-size=900,700', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker', { timeout: 15000 });
  const inWorker = (fn, arg) => worker.evaluate(fn, arg);
  const proxy = () => gateway.proxy;
  const activeUrl = () => proxy().browserContext?.activeTab?.url;

  const first = await browser.newPage();
  await first.goto(`${base}/page/first`);
  await first.bringToFront();
  await inWorker(([url, token]) => globalThis.__ablespeakTest(url, token), [`ws://127.0.0.1:${gateway.port}/ws/extension`, TOKEN]);

  await check('connects and tells AbleSpeak which page is open', async () => {
    const t = Date.now();
    await waitFor('the page in AbleSpeak', () => proxy().extensionClients.size > 0 && activeUrl() === `${base}/page/first`);
    return `${Date.now() - t} ms`;
  });

  await check('with two windows, the page is the one in the window used last', async () => {
    await inWorker(url => chrome.windows.create({ url, focused: true }), `${base}/page/second`);
    await waitFor('the second window', () => activeUrl() === `${base}/page/second`);
    await inWorker(async url => {
      const tab = (await chrome.tabs.query({})).find(t => t.url === url);
      await chrome.windows.update(tab.windowId, { focused: true });
    }, `${base}/page/first`);
    await waitFor('back to the first window', () => activeUrl() === `${base}/page/first`);
    return 'second window, then first window';
  });

  await check('"open a page" opens in the tab in use, not a new one', async () => {
    const before = browser.pages().length;
    const answer = await proxy().sendToolToExtension('open_url', { url: `${base}/page/third` });
    if (answer?.status !== 'success') throw new Error(JSON.stringify(answer));
    await waitFor('the page to open', () => browser.pages().some(p => p.url() === `${base}/page/third`));
    if (browser.pages().length !== before) throw new Error(`tabs went from ${before} to ${browser.pages().length}`);
    await waitFor('AbleSpeak to see it', () => activeUrl() === `${base}/page/third`);
  });

  await check('switching to a tab brings its window forward', async () => {
    const target = proxy().browserContext.tabs.find(t => t.url === `${base}/page/second`);
    if (!target) throw new Error('second tab not in the context');
    await proxy().sendToolToExtension('make_tab_active', { tab_id: String(target.id) });
    const focused = await inWorker(() => chrome.windows.getLastFocused().then(w => w.id));
    if (focused !== target.windowId) throw new Error(`window ${focused} in front, wanted ${target.windowId}`);
    await waitFor('AbleSpeak to see it', () => activeUrl() === `${base}/page/second`);
  });

  await check('scrolls the page it is told about', async () => {
    const answer = await proxy().sendToolToExtension('scroll', { direction: 'down', amount: '800' });
    if (answer?.status !== 'success') throw new Error(JSON.stringify(answer));
    const page = browser.pages().find(p => p.url() === `${base}/page/second`);
    if (!page) throw new Error('the second page is not open');
    await waitFor('the page to move', async () => (await page.evaluate(() => scrollY)) > 100, 5000);
    return `scrolled ${answer.scrolled}`;
  });

  await check('ticks a checkbox and picks a radio button on a strict page', async () => {
    await proxy().sendToolToExtension('open_url', { url: `${base}/strict-form` });
    const page = await (async () => {
      await waitFor('the form', () => browser.pages().some(p => p.url() === `${base}/strict-form`));
      return browser.pages().find(p => p.url() === `${base}/strict-form`);
    })();
    await page.waitForLoadState('load');
    await waitFor('AbleSpeak to see the form', () => activeUrl() === `${base}/strict-form`);
    const tick = await proxy().sendToolToExtension('javascript', `(${JSON.stringify({ action: 'select_option', label: 'I agree to the rules' })})`);
    await waitFor('the checkbox', () => page.locator('#agree').isChecked(), 5000)
      .catch(() => { throw new Error(`not ticked; extension said ${JSON.stringify(tick)}`); });
    await proxy().sendToolToExtension('javascript', `(${JSON.stringify({ action: 'select_option', label: 'Dark' })})`);
    await waitFor('the radio button', () => page.locator('#dark').isChecked(), 5000);
    const state = await page.locator('#state').textContent();
    if (!/^dark:true$/.test(state)) throw new Error(`the page's own script saw "${state}"`);
    await page.screenshot({ path: path.join(run, 'strict-form.png') });
    return `page saw "${state}"`;
  });

  await check('"skip the ad" presses the Skip button on a page that refuses scripts', async () => {
    await proxy().sendToolToExtension('open_url', { url: `${base}/ad` });
    await waitFor('the video page', () => browser.pages().some(p => p.url() === `${base}/ad`));
    const page = browser.pages().find(p => p.url() === `${base}/ad`);
    await page.waitForLoadState('load');
    const answer = await proxy().sendToolToExtension('media_control', { action: 'skip_ad' });
    if (answer?.status !== 'success') throw new Error(JSON.stringify(answer));
    await waitFor('the page to see it', async () => (await page.locator('#state').textContent()) === 'skipped', 5000);
    return answer.message;
  });

  await check('an ad that can\'t be skipped yet is said to be so', async () => {
    await proxy().sendToolToExtension('open_url', { url: `${base}/ad-wait` });
    await waitFor('the video page', () => browser.pages().some(p => p.url() === `${base}/ad-wait`));
    await browser.pages().find(p => p.url() === `${base}/ad-wait`).waitForLoadState('load');
    const answer = await proxy().sendToolToExtension('media_control', { action: 'skip_ad' });
    if (answer?.status !== 'error' || !/yet/.test(answer.message)) throw new Error(JSON.stringify(answer));
    return answer.message;
  });

  await check('YouTube results are read with their IDs, and "the second one" opens by ID', async () => {
    await proxy().sendToolToExtension('open_url', { url: `${base}/results` });
    await waitFor('the results page', () => browser.pages().some(p => p.url() === `${base}/results`));
    await browser.pages().find(p => p.url() === `${base}/results`).waitForLoadState('load');
    // Not youtube.com here, so the page is named (in use, the YouTube tab is found by itself)
    const tabId = await inWorker(url => chrome.tabs.query({}).then(tabs => tabs.find(t => t.url === url)?.id), `${base}/results`);
    const state = await proxy().sendToolToExtension('youtube', { action: 'state', tabId });
    const ids = (state?.videos || []).map(v => v.id).join(',');
    if (ids !== 'AAAAAAAAAA1,BBBBBBBBBB2,CCCCCCCCCC3') throw new Error(`read ${JSON.stringify(state).slice(0, 200)}`);
    const opened = await proxy().sendToolToExtension('youtube', { action: 'open_index', index: 2, tabId });
    if (opened?.status !== 'success') throw new Error(JSON.stringify(opened));
    const going = await inWorker(id => chrome.tabs.get(id).then(t => t.pendingUrl || t.url), tabId);
    if (!/youtube\.com\/watch\?v=BBBBBBBBBB2/.test(going)) throw new Error(`went to ${going}`);
    await inWorker(id => chrome.tabs.update(id, { url: 'about:blank' }), tabId); // not on to the real YouTube
    return opened.message;
  });

  // A tab of the page server's, by its address
  const openTab = async (pathname) => {
    await proxy().sendToolToExtension('open_url', { url: `${base}${pathname}` });
    await waitFor(pathname, () => browser.pages().some(p => p.url() === `${base}${pathname}`));
    const page = browser.pages().find(p => p.url() === `${base}${pathname}`);
    await page.waitForLoadState('load');
    const tabId = await inWorker(url => chrome.tabs.query({}).then(tabs => tabs.find(t => t.url === url)?.id), `${base}${pathname}`);
    return { page, tabId };
  };

  await check('Gmail: the inbox is read, emails selected and marked read, one opened, a reply drafted and never sent', async () => {
    const { page, tabId } = await openTab('/gmail');
    const gmail = (action, args = {}) => proxy().sendToolToExtension('gmail', { action, tabId, ...args });
    const inbox = await gmail('state');
    if (inbox?.view !== 'inbox' || inbox.emails?.length !== 3 || inbox.unread !== 2 || inbox.account?.email !== 'student@example.com'
        || inbox.emails[0].from !== 'Ms Wanjiku' || inbox.emails[0].subject !== 'Exam timetable') {
      throw new Error(`read ${JSON.stringify(inbox).slice(0, 300)}`);
    }
    const selected = await gmail('select', { ids: [':r2'] });
    const marked = await gmail('mark', { as: 'read' });
    const after = await gmail('state');
    if (after?.unread !== 1 || !after.emails[1].selected) throw new Error(`marking: ${selected?.message}; ${marked?.message}; unread ${after?.unread}`);
    const opened = await gmail('open', { id: ':r1' });
    if (opened?.status !== 'success' || !/exam timetable is attached/.test(opened.message)) throw new Error(`open: ${JSON.stringify(opened).slice(0, 300)}`);
    const drafted = await gmail('draft_reply', { text: 'Thank you, I will be there.' });
    const draft = await page.locator('div[aria-label="Message Body"]').innerText();
    if (drafted?.status !== 'success' || !draft.includes('Thank you, I will be there.')) throw new Error(`draft: ${drafted?.message} / "${draft}"`);
    if (await page.evaluate(() => window.sent)) throw new Error('the email was sent');
    const back = await gmail('back');
    if ((await gmail('state'))?.view !== 'inbox') throw new Error(`back: ${back?.message}`);
    return `${marked.message} ${drafted.message}`;
  });

  await check('YouTube: forward and back in a video, and back to its start', async () => {
    const { page, tabId } = await openTab('/video');
    await page.waitForFunction(() => Number.isFinite(document.querySelector('video')?.duration));
    const seek = args => proxy().sendToolToExtension('youtube', { action: 'seek', tabId, ...args });
    const forward = await seek({ by: 20 });
    const back = await seek({ by: -15 });
    const start = await seek({ to: 0 });
    if (forward?.at !== 20 || back?.at !== 5 || start?.at !== 0) throw new Error(JSON.stringify({ forward, back, start }));
    return `${forward.message} ${back.message} ${start.message}`;
  });

  await check('after AbleSpeak restarts, a command waits for the browser and runs', async () => {
    const port = gateway.port;
    await stopGateway(gateway);
    await sleep(500);
    gateway = await startGateway(port);
    const t = Date.now();
    const answer = await proxy().sendToolToExtension('get_page_state', {}); // sent while still reconnecting
    if (!Array.isArray(answer?.tabs)) throw new Error(JSON.stringify(answer).slice(0, 200));
    return `answered ${Date.now() - t} ms after the restart`;
  });

  report.ok = report.checks.every(c => c.ok);
} catch (err) {
  report.error = err.message;
  console.log(`ERROR ${err.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopGateway(gateway).catch(() => {});
  await new Promise(r => pages.close(r));
  closeDatabase();
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(`\n${report.checks.filter(c => c.ok).length}/${report.checks.length} checks passed — ${path.join(run, 'report.json')}`);
process.exitCode = report.ok ? 0 : 1;
