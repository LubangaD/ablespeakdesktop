let webSocket = null;
let reconnectIntervalId = null;
let keepAliveIntervalId = null;
let enabled = false;
let contextUpdaters = [defaultContextUpdater];
let contextUpdaterMessageId = 0;
let connecting = false; // connect() is reading settings or fetching the token

const UPDATER_TIMEOUT_MS = 2500;
const updaterStats = new Map(); // { updater: { count, totalTime } }
let contextTickRunning = false;

// Every second AbleSpeak is told what the person is looking at. A slow or
// broken updater no longer holds up the others (Promise.all used to stall the
// whole loop on one that never answered), and a tick never overlaps the last.
setInterval(async () => {
    if (contextTickRunning || !webSocket || webSocket.readyState !== WebSocket.OPEN) return;
    contextTickRunning = true;
    try { await sendContextUpdates(); } finally { contextTickRunning = false; }
}, 1000);

async function sendContextUpdates() {
    const socket = webSocket;
    const inTime = promise => Promise.race([promise, new Promise((_, reject) =>
        setTimeout(() => reject(new Error('context updater timed out')), UPDATER_TIMEOUT_MS))]);
    const results = await Promise.allSettled(contextUpdaters.map(async (updater, index) => {
        const startTime = performance.now();
        const result = await inTime(updater());
        if (!updaterStats.has(index)) updaterStats.set(index, { count: 0, totalTime: 0 });
        const stats = updaterStats.get(index);
        stats.count += 1;
        stats.totalTime += performance.now() - startTime;
        return { ...result, debug: { ...result?.debug, ...stats } };
    }));
    for (const outcome of results) {
        if (outcome.status === 'rejected') console.warn('Context updater failed:', outcome.reason?.message || outcome.reason);
        else if (outcome.value && socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(outcome.value));
    }
}

// Tell AbleSpeak at once when the person switches tab or window, or a page
// loads, instead of up to a second later (commands used to act on the old tab).
let pushTimer = null;
function pushContextSoon() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
        const socket = webSocket;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        try { socket.send(JSON.stringify(await defaultContextUpdater())); }
        catch (err) { console.warn('Context push failed:', err.message); }
    }, 150);
}
chrome.tabs.onActivated.addListener(() => pushContextSoon());
chrome.windows.onFocusChanged.addListener(() => pushContextSoon());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === 'complete') pushContextSoon();
});

// Tabs opened before the extension was installed or reloaded have no content
// script, so page commands there failed. Give them one now.
chrome.runtime.onInstalled.addListener(async () => {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const tab of tabs) {
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['scripts/content.js'] }).catch(() => {});
    }
});


async function defaultContextUpdater() {
    const tabs = await chrome.tabs.query({});
    const browserInfo = {};
    browserInfo['tabs'] = tabs.map(tab => {
        let urlParams = {};
        try {
            const parsed = new URLSearchParams(new URL(tab.url).search);
            for (const [key, value] of parsed) { urlParams[key] = value; }
        } catch (_) {}
        return {
            id: tab.id,
            url: tab.url,
            urlParams,
            host: (() => { try { return new URL(tab.url).host; } catch (_) { return ''; } })(),
            title: tab.title,
            active: tab.active,
            windowId: tab.windowId,
        };
    });
    // The tab commands act on (getActiveTab: the last window the person used),
    // not the first "active" tab of any window. With two windows those
    // differed, so AbleSpeak planned for one page and acted on another.
    const focused = await getActiveTab();
    browserInfo['activeTab'] = (focused && browserInfo['tabs'].find(tab => tab.id === focused.id))
        || browserInfo['tabs'].find(tab => tab.active);
    browserInfo['updatedAt'] = Date.now();

    const activeTab = browserInfo['activeTab'];
    if (activeTab && activeTab.id) {
        try {
            const [injectionResult] = await chrome.scripting.executeScript({
                target: { tabId: activeTab.id },
                func: () => {
                    const vh = window.innerHeight || document.documentElement.clientHeight || 1080;
                    const vw = window.innerWidth || document.documentElement.clientWidth || 1920;
                    const scrollY = window.scrollY;
                    const pageHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);

                    // Stable, iterative XPath — no recursion stack risk on deep DOMs
                    function getXPath(el) {
                        const parts = [];
                        let node = el;
                        while (node && node.nodeType === 1 && node !== document.body) {
                            const siblings = node.parentNode
                                ? Array.from(node.parentNode.children).filter(c => c.tagName === node.tagName)
                                : [];
                            const idx = siblings.length > 1 ? '[' + (siblings.indexOf(node) + 1) + ']' : '';
                            parts.unshift(node.tagName.toLowerCase() + idx);
                            node = node.parentNode;
                        }
                        return '/html/body/' + parts.join('/');
                    }

                    // Best human-readable label for voice matching
                    function getBestLabel(el) {
                        return (
                            el.getAttribute('aria-label') ||
                            el.getAttribute('title') ||
                            el.getAttribute('placeholder') ||
                            el.getAttribute('alt') ||
                            (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120) ||
                            el.value ||
                            el.getAttribute('name') ||
                            ''
                        ).trim();
                    }

                    function isVisible(el) {
                        const style = window.getComputedStyle(el);
                        return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0;
                    }

                    function isInViewport(rect) {
                        return rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
                    }

                    // Only elements the user can currently SEE and interact with
                    const interactiveSelectors = [
                        'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
                        '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
                        '[role="option"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
                        '[role="slider"]', '[role="combobox"]', '[contenteditable="true"]',
                        'video', 'audio', '[tabindex]:not([tabindex="-1"])'
                    ].join(', ');

                    const viewportElements = [];
                    for (const el of document.querySelectorAll(interactiveSelectors)) {
                        if (!isVisible(el)) continue;
                        const rect = el.getBoundingClientRect();
                        if (!isInViewport(rect)) continue;

                        const tag = el.tagName.toLowerCase();
                        const label = getBestLabel(el);
                        if (!label && tag !== 'input' && tag !== 'textarea' && tag !== 'select') continue;

                        viewportElements.push({
                            tag,
                            role: el.getAttribute('role') || el.type || null,
                            label: label.slice(0, 120),
                            xpath: getXPath(el),
                            focused: el === document.activeElement,
                            disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
                            checked: (el.type === 'checkbox' || el.type === 'radio') ? el.checked : null,
                            value: (tag === 'input' || tag === 'textarea' || tag === 'select') ? (el.value || '') : null,
                            position: {
                                top: Math.round(rect.top),
                                left: Math.round(rect.left),
                                width: Math.round(rect.width),
                                height: Math.round(rect.height)
                            }
                        });
                    }

                    // What the keyboard is currently focused on
                    const focused = document.activeElement;
                    const focusedElement = (focused && focused !== document.body && focused !== document.documentElement) ? {
                        tag: focused.tagName.toLowerCase(),
                        label: getBestLabel(focused).slice(0, 120),
                        value: focused.value || focused.innerText?.trim().slice(0, 300) || null,
                        xpath: getXPath(focused),
                        type: focused.type || focused.getAttribute('role') || null,
                        isEditable: focused.isContentEditable || focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA'
                    } : null;

                    // All media on the page — critical for voice control of video/audio
                    const mediaElements = Array.from(document.querySelectorAll('video, audio'))
                        .filter(m => m.readyState > 0 || m.src || m.currentSrc)
                        .map(m => ({
                            tag: m.tagName.toLowerCase(),
                            paused: m.paused,
                            ended: m.ended,
                            currentTime: Math.round(m.currentTime),
                            duration: isFinite(m.duration) ? Math.round(m.duration) : null,
                            volume: Math.round(m.volume * 100),
                            muted: m.muted,
                            playbackRate: m.playbackRate,
                            xpath: getXPath(m),
                            inViewport: isInViewport(m.getBoundingClientRect())
                        }));

                    // Where on the page we currently are — essential for scroll commands
                    const atBottom = (scrollY + vh) >= (pageHeight - 50);
                    const scroll = {
                        y: Math.round(scrollY),
                        x: Math.round(window.scrollX),
                        pageHeight: Math.round(pageHeight),
                        viewportHeight: vh,
                        percentScrolled: pageHeight > vh ? Math.round((scrollY / (pageHeight - vh)) * 100) : 100,
                        atTop: scrollY < 10,
                        atBottom,
                        canScrollMore: !atBottom
                    };

                    return {
                        pageTitle: document.title,
                        url: location.href,
                        viewportElements,   // only what's on screen right now
                        focusedElement,     // what keyboard/focus is on
                        mediaElements,      // video/audio state
                        scroll,             // where on the page + can we scroll more
                        selectedText: (window.getSelection()?.toString() || '').trim() || null
                    };
                }
            });
            if (injectionResult && injectionResult.result) {
                browserInfo['pageContext'] = injectionResult.result;
            }
        } catch (_) {
            // Tab may not be injectable (chrome://, pdf, etc.)
        }
    }

    return {
        result: browserInfo,
        type: 'context_update',
        context: 'integration'
    };
}

// ── Reliable wake-up after MV3 service-worker suspension ──
// Chrome suspends this service worker after ~30s of idle time, which wipes
// webSocket, every setTimeout/setInterval, and all other in-memory state.
// Previously, reconnection only re-armed on a full browser restart
// (onStartup) or the user manually clicking the extension icon — so once
// suspended mid-session, the WebSocket (and the 1s context-push loop that
// depends on it) stayed dead for the rest of the session, freezing
// active-tab/page-context tracking on the AI side at whatever it last saw.
//
// chrome.alarms is the Chrome-documented mechanism that CAN wake a
// suspended service worker (unlike timers), so a periodic alarm here
// guarantees we notice a dead connection and reconnect within ~1 minute
// instead of never. The top-level storage read below — not nested inside
// onStartup — runs on EVERY script evaluation, which happens on every wake
// (alarm fire, incoming message, full browser startup, etc.), so
// reconnection isn't gated behind onStartup alone anymore.
const HEARTBEAT_ALARM = 'ablespeak-heartbeat';

function ensureHeartbeatAlarm() {
    chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== HEARTBEAT_ALARM) return;
    chrome.storage.local.get('enabled', (data) => {
        enabled = data.enabled || false;
        if (enabled && (!webSocket || webSocket.readyState !== WebSocket.OPEN)) {
            console.log('[Heartbeat] Connection down — reconnecting');
            startReconnectionLoop();
        }
    });
});

chrome.storage.local.get('enabled', (data) => {
    enabled = data.enabled || false;
    ensureHeartbeatAlarm();
    if (enabled) {
        startReconnectionLoop();
    }
});

chrome.action.setIcon({path: 'icons/socket-disabled.png'});
chrome.action.onClicked.addListener(async () => {
    enabled = !enabled;
    chrome.storage.local.set({enabled});

    if (enabled) {
        startReconnectionLoop();
    } else {
        stopReconnectionLoop();
    }
});

function connect() {
    if (connecting || (webSocket && (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING))) {
        console.log("WebSocket is already connected or connecting. Skipping connect.");
        return;
    }
    // Reading settings and fetching the token take a moment; without this, the
    // wake-up and the heartbeat alarm could each open a socket.
    connecting = true;

    //console.log('Connecting to WebSocket server...');
    // Try AbleSpeak gateway first, fall back to direct Voqal
    const gatewayUrl = 'ws://localhost:3001/ws/extension';
    const directUrl = 'ws://localhost:22171/integration/chrome';

    chrome.storage.local.get(['wsUrl', 'wsToken'], async (data) => {
      try {
        let url = data.wsUrl || gatewayUrl;
        let token = data.wsToken;

        // EXT-2: the gateway now requires a token by default (auto-generated on
        // first run — no manual pairing step). Bootstrap it once from the same
        // host the WS connection is going to, then cache it. This fetch is
        // itself loopback-only on the server side, matching the trust model the
        // rest of the local control plane already relies on.
        if (!token) {
            try {
                const tokenUrl = url.replace(/^ws/, 'http').replace(/\/ws\/extension.*$/, '/api/ws-token');
                const res = await fetch(tokenUrl, { signal: AbortSignal.timeout(3000) });
                if (res.ok) {
                    const body = await res.json();
                    if (body.token) {
                        token = body.token;
                        chrome.storage.local.set({ wsToken: token });
                    }
                }
            } catch (err) {
                // Gateway may not be up yet — connect() gets retried by the
                // reconnect loop below, which will fetch the token again then.
                console.warn('Could not fetch WS token yet:', err.message);
            }
        }

        if (token) {
            url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
        }
        _doConnect(url, directUrl);
      } catch (err) {
        console.warn('Could not connect:', err.message);
      } finally {
        connecting = false;
      }
    });
}

function _doConnect(primaryUrl, fallbackUrl) {
    console.log('Connecting to:', primaryUrl);
    const ws = new WebSocket(primaryUrl);
    webSocket = ws;

    ws.onopen = () => {
        if (webSocket !== ws) { ws.close(); return; } // replaced while connecting
        chrome.action.setIcon({path: 'icons/socket-active.png'});
        console.log('WebSocket connection established to:', primaryUrl);
        reconnectAttempt = 0; // Reset backoff on successful connection
        clearReconnectInterval();
        startKeepAlive();

        // Tell the server which browser we are so it can focus the right window
        const ua = navigator.userAgent || '';
        let browserName = 'Chrome'; // default
        if (ua.includes('Brave')) browserName = 'Brave';
        else if (ua.includes('Edg/') || ua.includes('Edge')) browserName = 'Edge';
        else if (ua.includes('OPR') || ua.includes('Opera')) browserName = 'Opera';
        else if (ua.includes('Chrome')) browserName = 'Chrome';

        ws.send(JSON.stringify({
            type: 'browser_identify',
            browserName,
            userAgent: ua
        }));
        console.log('Identified as:', browserName);
        pushContextSoon(); // AbleSpeak learns the page straight away, not a second later
    };

    ws.onmessage = async (event) => {
        // Answers go back on the connection the request came on, even if a
        // newer one has opened since
        const webSocket = ws;
        const data = JSON.parse(event.data);
        //console.log("Event type: ", data.type);

        if (data.type === 'open_url') {
            const url = data.payload.url;
            // The tab the person is on, not whichever window Chrome focused last
            // (that could be AbleSpeak's own dashboard)
            const target = await getActiveTab();
            if (target) await chrome.tabs.update(target.id, {url});
            else await chrome.tabs.create({url});

            const resp = {
                result: {
                    status: 'success'
                },
                replyTo: data.replyTo
            }
            webSocket.send(JSON.stringify(resp));
        } else if (data.type === 'create_tab') {
            console.log(JSON.stringify(data));
            const url = data.payload.url;
            await chrome.tabs.create({url});

            //todo: sync with context update?
            const resp = {
                result: {
                    status: 'success'
                },
                replyTo: data.replyTo
            };
            webSocket.send(JSON.stringify(resp));
        } else if (data.type === 'make_tab_active') {
            console.log(JSON.stringify(data));
            const tabId = data.payload.tab_id
            const tabIdNum = parseInt(tabId);
            const tab = await chrome.tabs.update(tabIdNum, {active: true});
            // Bring its window forward too, so the person sees it and commands land there
            if (tab && tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
            pushContextSoon();

            //todo: sync with context update?
            const resp = {
                result: {
                    status: 'success'
                },
                replyTo: data.replyTo
            };
            webSocket.send(JSON.stringify(resp));
        } else if (data.type === 'javascript') {
            let tabId = null;
            //todo: selector is on backend context. this is more like "specifier"
            //const selector = data.metadata.selector;
            // if (selector) {
            //     if (selector.host) {
            //         const tabs = await getTabsByHost(selector.host);
            //         if (tabs.length > 0) {
            //             if (tabs.length > 1) {
            //                 console.log('Found multiple tabs by host', tabs);
            //
            //                 const activeTab = await getActiveTab();
            //                 if (activeTab) {
            //                     const url = new URL(activeTab.url);
            //                     if (url.host === selector.host) {
            //                         console.log("Using active tab");
            //                         tabId = activeTab.id;
            //                     } else {
            //                         console.log("Defaulting to first tab by host");
            //                         tabId = tabs[0].id;
            //                     }
            //                 } else {
            //                     console.log("Defaulting to first tab by host");
            //                     tabId = tabs[0].id;
            //                 }
            //             } else {
            //                 tabId = tabs[0].id;
            //             }
            //         } else {
            //             console.error('No tabs found by host:', selector.host);
            //             const resp = {
            //                 'result': {
            //                     'status': 'error',
            //                     'message': 'No tabs found by host: ' + selector.host,
            //                     'info': 'Tell the user to open a tab'
            //                 },
            //                 'replyTo': data.replyTo
            //             }
            //             webSocket.send(JSON.stringify(resp));
            //             return;
            //         }
            //     } else {
            //         console.error('Invalid selector:', selector);
            //         const resp = {
            //             'result': {
            //                 'status': 'error',
            //                 'message': 'Invalid selector: ' + selector,
            //                 'info': 'Tell the user to check the selector'
            //             },
            //             'replyTo': data.replyTo
            //         }
            //         webSocket.send(JSON.stringify(resp));
            //         return;
            //     }
            // } else {
                const activeTab = await getActiveTab();
                if (!activeTab) {
                    console.log('No active tab found');
                    const resp = {
                        'result': {
                            'status': 'error',
                            'message': 'No active tab found',
                            'info': 'Tell the user to open a tab'
                        },
                        'replyTo': data.replyTo
                    }
                    webSocket.send(JSON.stringify(resp));
                    return;
                }
                tabId = activeTab.id;
            // }

            const execFunc = {
                type: "evaluate",
                code: data.payload,
                voqal_resp_id: data.replyTo
            }
            const ask = () => new Promise(resolve => chrome.tabs.sendMessage(tabId, execFunc,
                response => resolve({ response, error: chrome.runtime.lastError?.message })));
            let answer = await ask();
            // A tab opened before the extension was installed or reloaded has no
            // content script: add it and ask again. (The old fallback ran the code
            // here instead, where it either did nothing or was blocked, and could
            // report success for an action that never happened.)
            if (answer.error && /Receiving end does not exist|Could not establish connection/i.test(answer.error)) {
                try {
                    await chrome.scripting.executeScript({ target: { tabId }, files: ['scripts/content.js'] });
                    answer = await ask();
                } catch (err) {
                    answer = { error: err.message };
                }
            }
            if (answer.error) {
                console.error('Page action failed:', answer.error);
                webSocket.send(JSON.stringify({ result: { status: 'error', message: answer.error }, replyTo: data.replyTo }));
            } else {
                webSocket.send(JSON.stringify({ result: answer.response?.result, replyTo: data.replyTo }));
            }
        } else if (data.type === 'execute_script') {
            // Direct chrome.scripting.executeScript — no content script needed
            const activeTab = await getActiveTab();
            if (!activeTab) {
                webSocket.send(JSON.stringify({ result: { status: 'error', message: 'No active tab' }, replyTo: data.replyTo }));
            } else {
                try {
                    const [injResult] = await chrome.scripting.executeScript({
                        target: { tabId: activeTab.id },
                        world: 'MAIN',
                        func: (code) => {
                            try { return eval(code); }
                            catch(e) { return 'Script error: ' + e.message; }
                        },
                        args: [data.payload]
                    });
                    webSocket.send(JSON.stringify({
                        result: { status: 'success', value: injResult?.result },
                        replyTo: data.replyTo
                    }));
                } catch (err) {
                    webSocket.send(JSON.stringify({
                        result: { status: 'error', message: err.message },
                        replyTo: data.replyTo
                    }));
                }
            }
        } else if (data.type === 'context_updater') {
            // A page reader to run every second. Without code it would fail every
            // second (and once held up every other update), so it isn't added.
            if (typeof data.payload !== 'string' || !data.payload.trim()) {
                webSocket.send(JSON.stringify({ result: { status: 'error', message: 'context_updater needs code' }, replyTo: data.replyTo }));
                return;
            }
            console.log("Adding context updater: " + JSON.stringify(data));
            const contextLibrary = data.library;
            const contextUpdaterName = data.name
            const contextUpdater = async function () {
                let tabId = null;
                const activeTab = await getActiveTab();
                if (!activeTab) {
                    console.log('No active tab found');
                    return {
                        result: null,
                        type: 'context_update',
                        context: 'library',
                        name: contextUpdaterName,
                        library: contextLibrary
                    }
                }
                tabId = activeTab.id;
                //console.log("executing context updater on tabId: ", tabId);

                const execFunc = {
                    type: "evaluate",
                    code: data.payload,
                    voqal_resp_id: "gen-" + contextUpdaterMessageId++
                }

                const response = await new Promise((resolve) => {
                    chrome.tabs.sendMessage(tabId, execFunc, (response) => {
                        if (chrome.runtime.lastError) {
                            console.error("Error:", chrome.runtime.lastError);
                            resolve(null);
                        } else {
                            //console.log("Context updater result:", response);
                            resolve(response);
                        }
                    });
                });
                //console.log("The response: " + JSON.stringify(response));

                return {
                    ...response,
                    type: 'context_update',
                    context: 'library',
                    name: contextUpdaterName,
                    library: contextLibrary
                };
            };
            contextUpdaters.push(contextUpdater);

            const resp = {
                result: {
                    status: 'success'
                },
                replyTo: data.replyTo
            };
            webSocket.send(JSON.stringify(resp));
        } else if (data.type === 'scroll') {
            const activeTab = await getActiveTab();
            if (!activeTab) {
                webSocket.send(JSON.stringify({ result: { status: 'error', message: 'No active tab' }, replyTo: data.replyTo }));
            } else {
                const direction = (data.payload.direction || 'down').toLowerCase();
                const amount = parseInt(data.payload.amount) || 400;
                const x = data.payload.x !== undefined ? parseInt(data.payload.x) : (direction === 'right' ? amount : direction === 'left' ? -amount : 0);
                const y = data.payload.y !== undefined ? parseInt(data.payload.y) : (direction === 'down' ? amount : direction === 'up' ? -amount : 0);

                const results = await chrome.scripting.executeScript({
                    target: { tabId: activeTab.id },
                    func: pageScroll,
                    args: ['by', x, y]
                });
                const why = y > 0 ? 'The page is already at the bottom.' : y < 0 ? 'The page is already at the top.' : 'This page can’t scroll that way.';
                webSocket.send(JSON.stringify({ result: scrollAnswer(results, why), replyTo: data.replyTo }));
            }
        } else if (data.type === 'scroll_to_top') {
            const activeTab = await getActiveTab();
            if (activeTab) {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: activeTab.id },
                    func: pageScroll,
                    args: ['top', 0, 0]
                });
                webSocket.send(JSON.stringify({ result: scrollAnswer(results, 'The page is already at the top.'), replyTo: data.replyTo }));
            } else {
                webSocket.send(JSON.stringify({ result: { status: 'error', message: 'No active tab' }, replyTo: data.replyTo }));
            }
        } else if (data.type === 'scroll_to_bottom') {
            const activeTab = await getActiveTab();
            if (activeTab) {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: activeTab.id },
                    func: pageScroll,
                    args: ['bottom', 0, 0]
                });
                webSocket.send(JSON.stringify({ result: scrollAnswer(results, 'The page is already at the bottom.'), replyTo: data.replyTo }));
            } else {
                webSocket.send(JSON.stringify({ result: { status: 'error', message: 'No active tab' }, replyTo: data.replyTo }));
            }
        } else if (data.type === 'close_tab') {
            try {
                const tabId = data.payload?.tab_id ? parseInt(data.payload.tab_id) : (await getActiveTab())?.id;
                if (tabId) {
                    await chrome.tabs.remove(tabId);
                    webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
                } else {
                    webSocket.send(JSON.stringify({ result: { status: 'error', message: 'No active tab found' }, replyTo: data.replyTo }));
                }
            } catch (err) {
                webSocket.send(JSON.stringify({ result: { status: 'error', message: err.message }, replyTo: data.replyTo }));
            }
        } else if (data.type === 'reload_tab') {
            const tabId = data.payload?.tab_id ? parseInt(data.payload.tab_id) : (await getActiveTab())?.id;
            await chrome.tabs.reload(tabId);
            webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
        } else if (data.type === 'duplicate_tab') {
            const tabId = data.payload?.tab_id ? parseInt(data.payload.tab_id) : (await getActiveTab())?.id;
            const newTab = await chrome.tabs.duplicate(tabId);
            webSocket.send(JSON.stringify({ result: { status: 'success', tab: newTab }, replyTo: data.replyTo }));
        } else if (data.type === 'go_back') {
            try {
                const tabId = data.payload?.tab_id ? parseInt(data.payload.tab_id) : (await getActiveTab())?.id;
                if (tabId) {
                    await chrome.tabs.goBack(tabId);
                    webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
                } else {
                    webSocket.send(JSON.stringify({ result: { status: 'error', message: 'No active tab found' }, replyTo: data.replyTo }));
                }
            } catch (err) {
                webSocket.send(JSON.stringify({ result: { status: 'error', message: err.message }, replyTo: data.replyTo }));
            }
        } else if (data.type === 'go_forward') {
            try {
                const tabId = data.payload?.tab_id ? parseInt(data.payload.tab_id) : (await getActiveTab())?.id;
                if (tabId) {
                    await chrome.tabs.goForward(tabId);
                    webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
                } else {
                    webSocket.send(JSON.stringify({ result: { status: 'error', message: 'No active tab found' }, replyTo: data.replyTo }));
                }
            } catch (err) {
                webSocket.send(JSON.stringify({ result: { status: 'error', message: err.message }, replyTo: data.replyTo }));
            }
        } else if (data.type === 'pin_tab') {
            const tabId = data.payload.tab_id ? parseInt(data.payload.tab_id) : (await getActiveTab()).id;
            await chrome.tabs.update(tabId, { pinned: true });
            webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
        } else if (data.type === 'unpin_tab') {
            const tabId = data.payload.tab_id ? parseInt(data.payload.tab_id) : (await getActiveTab()).id;
            await chrome.tabs.update(tabId, { pinned: false });
            webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
        } else if (data.type === 'mute_tab') {
            const tabId = data.payload.tab_id ? parseInt(data.payload.tab_id) : (await getActiveTab()).id;
            await chrome.tabs.update(tabId, { muted: true });
            webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
        } else if (data.type === 'unmute_tab') {
            const tabId = data.payload.tab_id ? parseInt(data.payload.tab_id) : (await getActiveTab()).id;
            await chrome.tabs.update(tabId, { muted: false });
            webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
        } else if (data.type === 'find_tab') {
            const tabs = await chrome.tabs.query({});
            const query = data.payload.query ? data.payload.query.toLowerCase() : '';
            const matches = tabs.filter(tab =>
                (tab.url && tab.url.toLowerCase().includes(query)) ||
                (tab.title && tab.title.toLowerCase().includes(query))
            ).map(tab => ({
                id: tab.id,
                url: tab.url,
                title: tab.title,
                active: tab.active
            }));
            webSocket.send(JSON.stringify({ result: { status: 'success', tabs: matches }, replyTo: data.replyTo }));
        } else if (data.type === 'take_screenshot') {
            const activeTab = await getActiveTab();
            if (!activeTab) {
                webSocket.send(JSON.stringify({ result: { status: 'error', message: 'No active tab' }, replyTo: data.replyTo }));
            } else {
                const dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: 'png' });
                webSocket.send(JSON.stringify({ result: { status: 'success', dataUrl }, replyTo: data.replyTo }));
            }
        } else if (data.type === 'zoom_tab') {
            const tabId = data.payload.tab_id ? parseInt(data.payload.tab_id) : (await getActiveTab()).id;
            await chrome.tabs.setZoom(tabId, parseFloat(data.payload.zoom_factor));
            webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
        } else if (data.type === 'press_key_combination') {
            // Essential for hands-free users: Ctrl+C, Ctrl+V, Ctrl+A, Escape, Tab, Arrow keys, etc.
            const activeTab = await getActiveTab();
            if (activeTab) {
                const key = data.payload.key;
                const ctrl = !!data.payload.ctrl;
                const shift = !!data.payload.shift;
                const alt = !!data.payload.alt;
                const meta = !!data.payload.meta;
                await chrome.scripting.executeScript({
                    target: { tabId: activeTab.id },
                    func: (key, ctrl, shift, alt, meta) => {
                        const target = document.activeElement || document.body;
                        const k = key.toLowerCase();
                        const init = { key, bubbles: true, cancelable: true, ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta };
                        target.dispatchEvent(new KeyboardEvent('keydown', init));
                        target.dispatchEvent(new KeyboardEvent('keyup', init));
                        // Modern API replacements for deprecated execCommand
                        if (ctrl && k === 'a') {
                            // Select all text in the focused element or entire page
                            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
                                target.select();
                            } else {
                                const range = document.createRange();
                                range.selectNodeContents(target.isContentEditable ? target : document.body);
                                const sel = window.getSelection();
                                sel.removeAllRanges();
                                sel.addRange(range);
                            }
                        } else if (ctrl && k === 'c') {
                            // Copy selected text to clipboard
                            const selected = window.getSelection()?.toString();
                            if (selected) navigator.clipboard.writeText(selected).catch(() => {});
                        } else if (ctrl && k === 'x') {
                            // Cut: copy then delete selection
                            const selected = window.getSelection()?.toString();
                            if (selected) {
                                navigator.clipboard.writeText(selected).catch(() => {});
                                if (target.isContentEditable) {
                                    const sel = window.getSelection();
                                    if (sel.rangeCount > 0) sel.getRangeAt(0).deleteContents();
                                } else if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
                                    const start = target.selectionStart;
                                    const end = target.selectionEnd;
                                    target.value = target.value.slice(0, start) + target.value.slice(end);
                                    target.setSelectionRange(start, start);
                                    target.dispatchEvent(new Event('input', { bubbles: true }));
                                }
                            }
                        } else if (ctrl && k === 'v') {
                            // Paste from clipboard into focused element
                            navigator.clipboard.readText().then(text => {
                                if (!text) return;
                                if (target.isContentEditable) {
                                    const sel = window.getSelection();
                                    if (sel.rangeCount > 0) {
                                        const range = sel.getRangeAt(0);
                                        range.deleteContents();
                                        range.insertNode(document.createTextNode(text));
                                        range.collapse(false);
                                    }
                                    target.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
                                } else if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
                                    const start = target.selectionStart ?? target.value.length;
                                    const end = target.selectionEnd ?? target.value.length;
                                    target.value = target.value.slice(0, start) + text + target.value.slice(end);
                                    target.setSelectionRange(start + text.length, start + text.length);
                                    target.dispatchEvent(new Event('input', { bubbles: true }));
                                    target.dispatchEvent(new Event('change', { bubbles: true }));
                                }
                            }).catch(() => {});
                        }
                        // undo/redo: no DOM API — KeyboardEvent dispatch above is the correct mechanism
                    },
                    args: [key, ctrl, shift, alt, meta]
                });
            }
            webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
        } else if (data.type === 'media_control') {
            // Direct voice control of video/audio: play, pause, seek, volume, mute, speed
            // IMPORTANT: Find the tab that actually has media playing, not just the active tab.
            // The user may be on the AbleSpeak dashboard while music plays on YouTube.
            // Candidates, best first: the tab the person is looking at, tabs
            // making sound, then other media sites. Only ordinary web pages
            // (Chrome's own pages and suspended tabs can't be scripted), and
            // if one can't be controlled, the next is tried.
            const MEDIA_URL = /youtube\.com\/(watch|shorts|embed)|youtu\.be|music\.youtube\.com|spotify\.com|soundcloud\.com|twitch\.tv|vimeo\.com|music\.apple\.com/i;
            const usable = t => t && /^https?:/i.test(t.url || '') && !t.discarded && !isAbleSpeakTab(t);
            const front = await getActiveTab();
            const audibleTabs = await chrome.tabs.query({ audible: true });
            const mediaTabs = (await chrome.tabs.query({})).filter(t => MEDIA_URL.test(t.url || ''));
            const candidates = [];
            for (const t of [front, ...audibleTabs, ...mediaTabs]) {
                if (usable(t) && !candidates.some(c => c.id === t.id)) candidates.push(t);
            }

            let answer = { status: 'error', message: 'No video or music is open in Chrome.' };
            for (const targetTab of candidates) {
                try {
                    console.log(`[Media] Trying tab ${targetTab.id}: ${(targetTab.url || '').slice(0, 60)} (audible: ${targetTab.audible})`);
                    const [result] = await chrome.scripting.executeScript({
                        target: { tabId: targetTab.id },
                        world: 'MAIN',
                        func: async (action, value, xpath) => {
                            function getByXPath(xp) {
                                return document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                            }
                            // An ad on YouTube: press its own Skip button. A script string is
                            // refused there (Trusted Types); this function runs as a script file.
                            if (action === 'skip_ad') {
                                const skip = [...document.querySelectorAll('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .videoAdUiSkipButton')]
                                    .find(b => b.offsetParent !== null);
                                if (skip) { skip.click(); return { status: 'success', message: 'Skipped the ad.' }; }
                                if (document.querySelector('.ad-showing, .ad-interrupting')) {
                                    return { status: 'error', adShowing: true, message: 'This ad can’t be skipped yet. Try again in a few seconds.' };
                                }
                                return { status: 'error', message: 'There’s no ad playing.' };
                            }
                            // YouTube-specific selector first, then generic
                            const media = (xpath ? getByXPath(xpath) : null)
                                || document.querySelector('.html5-video-player video')
                                || document.querySelector('video')
                                || document.querySelector('audio');
                            if (!media) return { status: 'error', message: 'No video or music on this page.' };
                            if (action === 'play') {
                                // play() can be refused (autoplay rules); say so instead of "done"
                                try { await media.play(); } catch (e) {
                                    return { status: 'error', message: 'The video wouldn’t start. Try “click play”.' };
                                }
                            }
                            else if (action === 'pause')  media.pause();
                            else if (action === 'toggle') { media.paused ? media.play() : media.pause(); }
                            else if (action === 'seek')   { media.currentTime = parseFloat(value); }
                            else if (action === 'seek_by') { media.currentTime = Math.max(0, media.currentTime + parseFloat(value)); }
                            else if (action === 'volume') { media.volume = Math.min(1, Math.max(0, parseFloat(value) / 100)); }
                            else if (action === 'mute')   { media.muted = true; }
                            else if (action === 'unmute') { media.muted = false; }
                            else if (action === 'rate')   { media.playbackRate = parseFloat(value); }
                            return {
                                status: 'success',
                                paused: media.paused,
                                currentTime: Math.round(media.currentTime),
                                volume: Math.round(media.volume * 100),
                                muted: media.muted
                            };
                        },
                        args: [data.payload.action, data.payload.value ?? null, data.payload.xpath ?? null]
                    });
                    answer = result?.result ?? result;
                    // Done (or the ad is in this tab, not skippable yet); otherwise try the next tab
                    if (answer?.status === 'success' || answer?.adShowing) break;
                } catch (err) {
                    console.warn(`[Media] Tab ${targetTab.id} can't be controlled: ${err.message}`);
                    answer = { status: 'error', message: 'AbleSpeak couldn’t control the video in Chrome.' };
                }
            }
            webSocket.send(JSON.stringify({ result: answer, replyTo: data.replyTo }));
        } else if (data.type === 'youtube') {
            // YouTube read and driven by its own page (after the Voqal library's
            // youtube/context and youtube/tools, Apache-2.0): what is playing, the
            // videos on screen with their IDs, and opening one by ID, not by a click.
            const { action, videoId, index, tabId, by, to } = data.payload || {};
            const onYouTube = t => t && /(^|\.)youtube\.com$/i.test(hostOf(t.url));
            let tab = tabId != null ? await chrome.tabs.get(Number(tabId)).catch(() => null) : null;
            if (!tab) {
                const front = await getActiveTab();
                const all = (await chrome.tabs.query({})).filter(onYouTube);
                tab = onYouTube(front) ? front : (all.find(t => t.audible) || all[0] || null);
            }
            let answer;
            if (!tab) {
                answer = { status: 'error', message: 'YouTube isn’t open in Chrome.' };
            } else {
                const read = async () => (await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => {
                        const idOf = href => { try { return new URL(href, location.origin).searchParams.get('v'); } catch { return null; } };
                        const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
                        // The videos on this page, in order: search results, up next, or the home grid
                        const boxes = location.pathname === '/results'
                            ? document.querySelectorAll('ytd-search ytd-video-renderer, ytd-search yt-lockup-view-model')
                            : location.pathname === '/watch'
                                ? document.querySelectorAll('#secondary ytd-compact-video-renderer, #secondary yt-lockup-view-model')
                                : document.querySelectorAll('ytd-rich-item-renderer, ytd-video-renderer');
                        const videos = [];
                        for (const box of boxes) {
                            const link = box.querySelector('a#video-title, a[href*="/watch?v="]');
                            const id = link && idOf(link.getAttribute('href'));
                            if (!id || videos.some(v => v.id === id)) continue;
                            const title = text(box.querySelector('#video-title, h3, .yt-lockup-metadata-view-model__title')) || link.getAttribute('title') || '';
                            const channel = text(box.querySelector('ytd-channel-name a, .yt-content-metadata-view-model__metadata-text'));
                            videos.push({ id, title: title.slice(0, 120), channel: channel.slice(0, 60) });
                            if (videos.length >= 12) break;
                        }
                        const player = document.querySelector('.html5-video-player');
                        const video = player?.querySelector('video') || document.querySelector('video');
                        return {
                            status: 'success',
                            page: location.pathname === '/watch' ? 'watch' : location.pathname === '/results' ? 'results' : 'other',
                            videoId: location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null,
                            title: location.pathname === '/watch' ? (text(document.querySelector('h1.ytd-watch-metadata, h1 yt-formatted-string')) || document.title.replace(/ - YouTube$/, '')) : null,
                            currentTime: video ? Math.round(video.currentTime) : null,
                            duration: video && Number.isFinite(video.duration) ? Math.round(video.duration) : null,
                            paused: video ? video.paused : null,
                            adShowing: !!player?.classList.contains('ad-showing'),
                            videos,
                        };
                    },
                }))[0]?.result;
                const open = async (id, title) => {
                    if (!/^[\w-]{6,20}$/.test(String(id || ''))) return { status: 'error', message: 'That isn’t a YouTube video.' };
                    await chrome.tabs.update(tab.id, { url: `https://www.youtube.com/watch?v=${id}` });
                    return { status: 'success', message: title ? `Playing “${title}”.` : 'Opening the video.' };
                };
                try {
                    if (action === 'state') {
                        answer = await read();
                    } else if (action === 'open') {
                        answer = await open(videoId);
                    } else if (action === 'open_index') {
                        const state = await read();
                        const pick = state?.videos?.[Number(index) - 1];
                        answer = pick ? await open(pick.id, pick.title)
                            : { status: 'error', message: state?.videos?.length ? `There are only ${state.videos.length} videos here.` : 'There are no videos on this page to pick from.' };
                    } else if (action === 'next' || action === 'previous') {
                        const [clicked] = await chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            func: which => {
                                const button = document.querySelector(which === 'next' ? '.ytp-next-button' : '.ytp-prev-button');
                                if (!button || button.offsetParent === null || button.getAttribute('aria-disabled') === 'true') return false;
                                button.click();
                                return true;
                            },
                            args: [action],
                        });
                        if (clicked?.result) answer = { status: 'success', message: action === 'next' ? 'Next video.' : 'Previous video.' };
                        else if (action === 'next') {
                            const state = await read();
                            answer = state?.videos?.[0] ? await open(state.videos[0].id, state.videos[0].title) : { status: 'error', message: 'There’s no next video here.' };
                        } else {
                            await chrome.tabs.goBack(tab.id);
                            answer = { status: 'success', message: 'Previous video.' };
                        }
                    } else if (action === 'seek') {
                        // `by` seconds forward (back when negative), or `to` a second of the video
                        const [moved] = await chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            func: (step, at) => {
                                const video = document.querySelector('.html5-video-player video') || document.querySelector('video');
                                if (!video || !Number.isFinite(video.duration)) return null;
                                const target = at == null ? video.currentTime + step : at;
                                video.currentTime = Math.max(0, Math.min(video.duration - 1, target));
                                return { at: Math.round(video.currentTime), duration: Math.round(video.duration) };
                            },
                            args: [Number(by) || 0, to == null || !Number.isFinite(Number(to)) ? null : Number(to)],
                        });
                        const clock = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
                        answer = moved?.result
                            ? { status: 'success', message: `Now at ${clock(moved.result.at)}.`, at: moved.result.at, duration: moved.result.duration }
                            : { status: 'error', message: 'No video is playing on this page.' };
                    } else {
                        answer = { status: 'error', message: `Unknown YouTube action: ${action}` };
                    }
                } catch (err) {
                    answer = { status: 'error', message: 'AbleSpeak couldn’t reach the YouTube page.' };
                }
            }
            webSocket.send(JSON.stringify({ result: answer, replyTo: data.replyTo }));
        } else if (data.type === 'gmail') {
            // Gmail read and driven by its own page (after the Voqal library's
            // gmail profile, Apache-2.0): the inbox or the open email, opening,
            // selecting, marking, deleting and drafting a reply. Never sends.
            const { action, tabId, ...args } = data.payload || {};
            const onGmail = t => t && /^mail\.google\.com$/i.test(hostOf(t.url));
            let tab = tabId != null ? await chrome.tabs.get(Number(tabId)).catch(() => null) : null;
            if (!tab) {
                const front = await getActiveTab();
                tab = onGmail(front) ? front : ((await chrome.tabs.query({})).find(onGmail) || null);
            }
            let answer;
            if (!tab) {
                answer = { status: 'error', message: 'Gmail isn’t open in Chrome.' };
            } else {
                try {
                    answer = (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: gmailPage, args: [action, args] }))[0]?.result
                        || { status: 'error', message: 'Gmail didn’t answer.' };
                } catch (err) {
                    answer = { status: 'error', message: 'AbleSpeak couldn’t reach the Gmail page.' };
                }
            }
            webSocket.send(JSON.stringify({ result: answer, replyTo: data.replyTo }));
        } else if (data.type === 'focus_next') {
            // Tab-forward through focusable elements — navigating a page without a mouse
            const activeTab = await getActiveTab();
            if (activeTab) {
                await chrome.scripting.executeScript({
                    target: { tabId: activeTab.id },
                    func: () => {
                        const focusable = Array.from(document.querySelectorAll(
                            'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'
                        )).filter(el => {
                            const s = window.getComputedStyle(el);
                            return s.display !== 'none' && s.visibility !== 'hidden';
                        });
                        const idx = focusable.indexOf(document.activeElement);
                        const next = focusable[(idx + 1) % focusable.length];
                        if (next) { next.focus(); next.scrollIntoView({ block: 'nearest' }); }
                    }
                });
            }
            webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
        } else if (data.type === 'focus_prev') {
            // Shift+Tab equivalent
            const activeTab = await getActiveTab();
            if (activeTab) {
                await chrome.scripting.executeScript({
                    target: { tabId: activeTab.id },
                    func: () => {
                        const focusable = Array.from(document.querySelectorAll(
                            'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'
                        )).filter(el => {
                            const s = window.getComputedStyle(el);
                            return s.display !== 'none' && s.visibility !== 'hidden';
                        });
                        const idx = focusable.indexOf(document.activeElement);
                        const prev = focusable[(idx - 1 + focusable.length) % focusable.length];
                        if (prev) { prev.focus(); prev.scrollIntoView({ block: 'nearest' }); }
                    }
                });
            }
            webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
        } else if (data.type === 'right_click') {
            // Open context menus — something you can't do without a mouse otherwise
            const activeTab = await getActiveTab();
            if (activeTab) {
                await chrome.scripting.executeScript({
                    target: { tabId: activeTab.id },
                    func: (xpath, selector) => {
                        function getByXPath(xp) {
                            return document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                        }
                        const el = (xpath ? getByXPath(xpath) : null)
                            || (selector ? document.querySelector(selector) : null)
                            || document.activeElement
                            || document.body;
                        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, buttons: 2, view: window }));
                    },
                    args: [data.payload?.xpath ?? null, data.payload?.query_selector ?? null]
                });
            }
            webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
        } else if (data.type === 'get_page_state') {
            // Force an immediate snapshot of what's on screen right now (don't wait for next 1s tick)
            const activeTab = await getActiveTab();
            if (!activeTab) {
                webSocket.send(JSON.stringify({ result: { status: 'error', message: 'No active tab' }, replyTo: data.replyTo }));
            } else {
                const updatedContext = await defaultContextUpdater();
                webSocket.send(JSON.stringify({ result: updatedContext.result, replyTo: data.replyTo }));
            }
        } else if (data.type === 'scroll_element') {
            // Scroll inside a specific scrollable container (chat panels, sidebars, etc.)
            const activeTab = await getActiveTab();
            if (activeTab) {
                await chrome.scripting.executeScript({
                    target: { tabId: activeTab.id },
                    func: (xpath, selector, direction, amount) => {
                        function getByXPath(xp) {
                            return document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                        }
                        const el = (xpath ? getByXPath(xpath) : null) || (selector ? document.querySelector(selector) : null);
                        if (!el) return;
                        const y = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
                        const x = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
                        el.scrollBy({ top: y, left: x, behavior: 'smooth' });
                    },
                    args: [data.payload?.xpath ?? null, data.payload?.query_selector ?? null, data.payload?.direction ?? 'down', parseInt(data.payload?.amount) || 300]
                });
            }
            webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
        } else if (data.type === 'pong') {
            //console.log('Received pong');
        } else {
            console.error('Unknown event type:', data.type);
        }
    };

    ws.onclose = () => {
        // An older connection closing must not drop the current one
        if (webSocket !== ws) return;
        webSocket = null;
        clearKeepAlive();

        if (enabled) {
            chrome.action.setIcon({path: 'icons/socket-inactive.png'});
            if (!reconnectIntervalId) {
                startReconnectionLoop();
            }
        }
    };
}

// AbleSpeak's own dashboard, when it is open in the browser
const isAbleSpeakTab = tab => /^https?:\/\/(localhost|127\.0\.0\.1):3001(\/|$)/.test(tab?.url || '');
// "https://www.youtube.com/watch?v=…" → "www.youtube.com"; '' for anything else
const hostOf = url => { try { return new URL(url).hostname; } catch { return ''; } };

/**
 * Runs in the Gmail page (the 'gmail' message): its long-standing page
 * structure (tr.zA rows, zE unread, span[email] senders, h2.hP subject,
 * div.adn messages, div.a3s bodies), after the Voqal library's gmail profile.
 * Gmail's buttons need real mouse events, not just click(). Never sends.
 */
async function gmailPage(action, args = {}) {
    const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
    const shown = el => !!el && el.offsetParent !== null;
    const press = el => {
        if (!el) return false;
        el.scrollIntoView?.({ block: 'center' });
        for (const type of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        return true;
    };
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (test, ms = 4000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { const value = test(); if (value) return value; await wait(100); }
        return test();
    };
    const rows = () => [...document.querySelectorAll('tr.zA')].filter(shown);
    const inEmail = () => shown(document.querySelector('h2.hP'));
    const rowInfo = row => {
        const sender = row.querySelector('span[email]');
        const date = row.querySelector('td.xW span[title], .xW span[title]');
        return {
            id: row.id,
            from: (sender?.getAttribute('name') || text(sender)).slice(0, 60),
            fromEmail: sender?.getAttribute('email') || '',
            subject: text(row.querySelector('span.bog, span[data-thread-id]')).slice(0, 120),
            snippet: text(row.querySelector('span.y2')).replace(/^[-–\s]+/, '').slice(0, 100),
            date: date?.getAttribute('title') || text(date),
            unread: row.classList.contains('zE'),
            starred: !!row.querySelector('[aria-label="Starred"]'),
            selected: row.querySelector('[role="checkbox"]')?.getAttribute('aria-checked') === 'true',
        };
    };
    const openEmail = () => ({
        subject: text(document.querySelector('h2.hP')),
        messages: [...document.querySelectorAll('div.adn')].map(message => {
            const sender = message.querySelector('span.gD[email], span[email]');
            const date = message.querySelector('span.g3');
            return {
                from: sender?.getAttribute('name') || text(sender),
                fromEmail: sender?.getAttribute('email') || '',
                date: date?.getAttribute('title') || text(date),
                text: (message.querySelector('div.a3s')?.innerText || '').trim().slice(0, 2500),
            };
        }).slice(-5),
    });
    const account = () => {
        const label = document.querySelector('a[aria-label^="Google Account"]')?.getAttribute('aria-label') || '';
        const email = label.match(/[\w.+-]+@[\w.-]+/)?.[0] || '';
        return { name: label.replace(/^Google Account:\s*/, '').replace(/\(?[\w.+-]+@[\w.-]+\)?/, '').trim(), email };
    };
    const button = label => [...document.querySelectorAll(`[role="button"][aria-label="${label}"], [role="button"][data-tooltip="${label}"]`)].find(shown);
    const findRow = id => rows().find(row => row.id === String(id) || row.id === `:${String(id).replace(/^:/, '')}`);
    // What the AI reads after opening an email: who wrote what
    const spoken = email => [`Opened “${email.subject}”.`, ...email.messages.map(m => `From ${m.from || m.fromEmail}${m.date ? ` (${m.date})` : ''}:\n${m.text}`)]
        .join('\n\n').slice(0, 6000);

    if (action === 'state') {
        if (inEmail()) return { status: 'success', view: 'email', account: account(), email: openEmail() };
        const list = rows();
        return { status: 'success', view: 'inbox', account: account(), unread: list.filter(r => r.classList.contains('zE')).length, emails: list.slice(0, 25).map(rowInfo) };
    }
    if (action === 'open') {
        const row = findRow(args.id);
        if (!row) return { status: 'error', message: 'That email isn’t in the list on screen.' };
        press(row.querySelector('span.bog, span[data-thread-id]') || row);
        if (!(await until(inEmail, 3000))) {
            // Gmail didn't take the click: open the thread by its address
            const legacy = row.querySelector('[data-legacy-thread-id]')?.getAttribute('data-legacy-thread-id');
            if (legacy) { location.hash = `#inbox/${legacy}`; await until(inEmail, 3000); }
        }
        if (!inEmail()) return { status: 'error', message: 'The email didn’t open.' };
        await until(() => openEmail().messages.some(m => m.text), 2000);
        const email = openEmail();
        return { status: 'success', message: spoken(email), email };
    }
    if (action === 'back') {
        if (!inEmail()) return { status: 'success', message: 'Already in the inbox.' };
        if (!press(button('Back to Inbox'))) location.hash = '#inbox';
        await until(() => !inEmail() && rows().length, 3000);
        return inEmail() ? { status: 'error', message: 'Gmail didn’t go back to the inbox.' } : { status: 'success', message: 'Back to the inbox.' };
    }
    if (action === 'select') {
        if (inEmail()) return { status: 'error', message: 'Go back to the inbox to select emails.' };
        const wanted = new Set((args.ids || []).map(id => String(id).replace(/^:/, '')));
        for (const row of rows()) {
            const box = row.querySelector('[role="checkbox"]');
            const on = box?.getAttribute('aria-checked') === 'true';
            if (box && on !== wanted.has(row.id.replace(/^:/, ''))) press(box);
        }
        await wait(150);
        const chosen = rows().filter(r => r.querySelector('[role="checkbox"]')?.getAttribute('aria-checked') === 'true').length;
        return chosen ? { status: 'success', message: `Selected ${chosen} ${chosen === 1 ? 'email' : 'emails'}.` }
            : { status: 'error', message: 'None of those emails are on screen.' };
    }
    if (action === 'mark') {
        const label = { read: 'Mark as read', unread: 'Mark as unread', archive: 'Archive', delete: 'Delete' }[args.as];
        if (!label) return { status: 'error', message: `Emails can be marked read or unread, archived or deleted, not "${args.as}".` };
        const count = inEmail() ? 1 : rows().filter(r => r.querySelector('[role="checkbox"]')?.getAttribute('aria-checked') === 'true').length;
        if (!count) return { status: 'error', message: 'Select the emails first.' };
        if (!press(button(label))) return { status: 'error', message: `Gmail’s “${label}” button isn’t on screen.` };
        const what = count === 1 ? 'the email' : `${count} emails`;
        const done = { read: `Marked ${what} as read.`, unread: `Marked ${what} as unread.`, archive: `Archived ${what}.`, delete: `Deleted ${what}.` };
        return { status: 'success', message: done[args.as] };
    }
    if (action === 'draft_reply') {
        if (!inEmail()) return { status: 'error', message: 'Open the email first.' };
        const reply = button('Reply') || [...document.querySelectorAll('span[role="link"]')].find(el => text(el) === 'Reply');
        let body = [...document.querySelectorAll('div[aria-label="Message Body"][contenteditable="true"]')].find(shown);
        if (!body) {
            if (!press(reply)) return { status: 'error', message: 'Gmail’s Reply button isn’t on screen.' };
            body = await until(() => [...document.querySelectorAll('div[aria-label="Message Body"][contenteditable="true"]')].find(shown), 3000);
        }
        if (!body) return { status: 'error', message: 'The reply box didn’t open.' };
        body.focus();
        const typed = document.execCommand('insertText', false, String(args.text || ''));
        if (!typed) body.textContent += String(args.text || '');
        return { status: 'success', message: 'Wrote the reply. It hasn’t been sent.' };
    }
    return { status: 'error', message: `Unknown Gmail action: ${action}` };
}

/**
 * The tab the person is looking at: the active tab of the last browser
 * window they used, never AbleSpeak's own dashboard. ("currentWindow" in a
 * service worker means whatever window was focused last, which can be the
 * dashboard, so voice commands used to land there.)
 */
async function getActiveTab() {
    try {
        const win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] });
        const tab = win?.tabs?.find(t => t.active && !isAbleSpeakTab(t));
        if (tab) return tab;
    } catch { /* no normal window focused yet */ }
    const active = await chrome.tabs.query({ active: true, windowType: 'normal' });
    return active.find(t => !isAbleSpeakTab(t)) || active[0];
}

/**
 * Runs in the page: scroll whatever actually scrolls there. Many sites
 * (LinkedIn, Gmail, chat apps) scroll an inner panel, not the window, so a
 * plain window.scrollBy did nothing while reporting success. Tries the page,
 * then the panel under the middle of the screen, then the biggest panel that
 * can move that way. Returns { moved, where } or { moved: false }.
 */
function pageScroll(mode, dx, dy) {
    const root = document.scrollingElement || document.documentElement;
    const scrolls = (el) => {
        if (!el || el === document.body || el === document.documentElement) return false;
        const st = getComputedStyle(el);
        return (/(auto|scroll|overlay)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 1)
            || (/(auto|scroll|overlay)/.test(st.overflowX) && el.scrollWidth > el.clientWidth + 1);
    };
    const canMove = (el, x, y) =>
        (y > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) || (y < 0 && el.scrollTop > 0)
        || (x > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1) || (x < 0 && el.scrollLeft > 0);
    // "top" and "bottom" are moves up or down as far as it goes
    const wantX = mode === 'by' ? dx : 0;
    const wantY = mode === 'by' ? dy : mode === 'top' ? -1 : 1;

    let target = null;
    if (canMove(root, wantX, wantY)) target = root;
    if (!target) {
        let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        while (el && !(scrolls(el) && canMove(el, wantX, wantY))) el = el.parentElement;
        target = el;
    }
    if (!target) {
        let best = null, bestArea = 0;
        const all = document.querySelectorAll('body *');
        for (let i = 0; i < all.length && i < 5000; i++) {
            const el = all[i];
            if (!scrolls(el) || !canMove(el, wantX, wantY)) continue;
            const r = el.getBoundingClientRect();
            const area = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
            if (area > bestArea) { best = el; bestArea = area; }
        }
        target = best;
    }
    if (!target) return { moved: false };

    const scroller = target === root ? window : target;
    if (mode === 'by') scroller.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
    else scroller.scrollTo({ top: mode === 'top' ? 0 : target.scrollHeight, behavior: 'smooth' });
    return { moved: true, where: target === root ? 'page' : (target.getAttribute('aria-label') || target.tagName.toLowerCase()) };
}

/** Tell AbleSpeak whether the page really moved. */
function scrollAnswer(results, why) {
    const r = results?.[0]?.result;
    if (r?.moved) return { status: 'success', scrolled: r.where };
    return { status: 'error', message: why };
}

async function getTabsByHost(host) {
    const tabs = await chrome.tabs.query({});
    return tabs.filter(tab => {
        const url = new URL(tab.url);
        return url.host === host;
    });
}

function disconnect() {
    console.log('Disconnecting from WebSocket server...');
    if (webSocket) {
        webSocket.close();
        webSocket = null;
    }
}

function startKeepAlive() {
    console.log('Starting keep alive interval...');
    clearKeepAlive();
    keepAliveIntervalId = setInterval(() => {
        if (webSocket && webSocket.readyState === WebSocket.OPEN) {
            webSocket.send(JSON.stringify({type: 'ping'}));
        } else {
            clearKeepAlive();
        }
    }, 20 * 1000);
}

function clearKeepAlive() {
    //console.log('Clearing keep alive interval...');
    if (keepAliveIntervalId) {
        clearInterval(keepAliveIntervalId);
        keepAliveIntervalId = null;
    }
}

let reconnectAttempt = 0;

function startReconnectionLoop() {
    console.log('Starting reconnection loop...');
    chrome.action.setIcon({path: 'icons/socket-inactive.png'});
    contextUpdaters = [defaultContextUpdater];

    connect();
    scheduleReconnect();
}

function scheduleReconnect() {
    clearReconnectInterval();
    // AbleSpeak runs on this computer, so trying again every 1.5–2 s costs
    // nothing, and after AbleSpeak restarts the browser is back within two
    // seconds. (Waiting up to 30 s left voice commands failing with "No Chrome
    // extension connected", and let Chrome put this worker to sleep in between;
    // the heartbeat alarm still wakes it once a minute.)
    const delay = 1500 + Math.random() * 500;
    reconnectAttempt++;
    if (reconnectAttempt % 20 === 1) console.log(`Reconnecting every 2 s (attempt ${reconnectAttempt})`);
    reconnectIntervalId = setTimeout(() => {
        reconnectIntervalId = null;
        if (enabled && (!webSocket || webSocket.readyState !== WebSocket.OPEN)) {
            connect();
            scheduleReconnect();
        }
    }, delay);
}

function stopReconnectionLoop() {
    console.log('Stopping reconnection loop...');
    chrome.action.setIcon({path: 'icons/socket-disabled.png'});
    clearReconnectInterval();
    reconnectAttempt = 0;
    disconnect();
}

function clearReconnectInterval() {
    console.log('Clearing reconnect interval...');
    if (reconnectIntervalId) {
        clearTimeout(reconnectIntervalId);
        reconnectIntervalId = null;
    }
}
