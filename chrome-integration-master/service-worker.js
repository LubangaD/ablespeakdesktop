let webSocket = null;
let reconnectIntervalId = null;
let keepAliveIntervalId = null;
let enabled = false;
let contextUpdaters = [defaultContextUpdater];
let contextUpdaterMessageId = 0;

const updaterStats = new Map(); // { updater: { count, totalTime } }
setInterval(async () => {
    if (webSocket && webSocket.readyState === WebSocket.OPEN) {
        const updaterPromises = contextUpdaters.map(async (updater, index) => {
            const startTime = performance.now();
            try {
                const result = await updater();
                const endTime = performance.now();

                if (!updaterStats.has(index)) {
                    updaterStats.set(index, { count: 0, totalTime: 0 });
                }
                const stats = updaterStats.get(index);
                stats.count += 1;
                stats.totalTime += (endTime - startTime);

                return {
                    ...result,
                    debug: {
                        ...result.debug,
                        ...stats
                    }
                };
            } catch (err) {
                console.error("Error in updater:", err);
                return null;
            }
        });

        const results = await Promise.all(updaterPromises);
        results.forEach(result => {
            if (result !== null) {
                //console.log("Sending context update:", result);
                webSocket.send(JSON.stringify(result));
            }
        });
    }
}, 1000);


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
        };
    });
    browserInfo['activeTab'] = browserInfo['tabs'].find(tab => tab.active);

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

chrome.runtime.onStartup.addListener(function () {
    console.log('open');
    chrome.storage.local.get("enabled", (data) => {
        enabled = data.enabled || false;
        if (enabled) {
            startReconnectionLoop();
        }
    });
})

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
    if (webSocket && (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING)) {
        console.log("WebSocket is already connected or connecting. Skipping connect.");
        return;
    }

    //console.log('Connecting to WebSocket server...');
    // Try AbleSpeak gateway first, fall back to direct Voqal
    const gatewayUrl = 'ws://localhost:3001/ws/extension';
    const directUrl = 'ws://localhost:22171/integration/chrome';

    chrome.storage.local.get('wsUrl', (data) => {
        const url = data.wsUrl || gatewayUrl;
        _doConnect(url, directUrl);
    });
}

function _doConnect(primaryUrl, fallbackUrl) {
    console.log('Connecting to:', primaryUrl);
    webSocket = new WebSocket(primaryUrl);

    webSocket.onopen = () => {
        chrome.action.setIcon({path: 'icons/socket-active.png'});
        console.log('WebSocket connection established to:', primaryUrl);
        clearReconnectInterval();
        startKeepAlive();
    };

    webSocket.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        //console.log("Event type: ", data.type);

        if (data.type === 'open_url') {
            const url = data.payload.url;
            await chrome.tabs.update({url});

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
            await chrome.tabs.update(tabIdNum, {active: true});

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
            chrome.tabs.sendMessage(tabId, execFunc, (response) => {
                if (chrome.runtime.lastError) {
                    console.error("Error:", chrome.runtime.lastError.message);
                    // Content script not ready — fallback to chrome.scripting.executeScript
                    chrome.scripting.executeScript({
                        target: { tabId },
                        func: (code) => { return eval(code); },
                        args: [data.payload]
                    }).then(([result]) => {
                        webSocket.send(JSON.stringify({
                            result: { status: 'success', value: result?.result },
                            replyTo: data.replyTo
                        }));
                    }).catch(err => {
                        webSocket.send(JSON.stringify({
                            result: { status: 'error', message: err.message },
                            replyTo: data.replyTo
                        }));
                    });
                } else {
                    const resp = {
                        result: response.result,
                        replyTo: data.replyTo
                    };

                    //console.log("Sending resp: ", resp);
                    webSocket.send(JSON.stringify(resp));
                }
            });
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

                await chrome.scripting.executeScript({
                    target: { tabId: activeTab.id },
                    func: (scrollX, scrollY) => { window.scrollBy({ left: scrollX, top: scrollY, behavior: 'smooth' }); },
                    args: [x, y]
                });
                webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
            }
        } else if (data.type === 'scroll_to_top') {
            const activeTab = await getActiveTab();
            if (activeTab) {
                await chrome.scripting.executeScript({
                    target: { tabId: activeTab.id },
                    func: () => { window.scrollTo({ top: 0, behavior: 'smooth' }); }
                });
            }
            webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
        } else if (data.type === 'scroll_to_bottom') {
            const activeTab = await getActiveTab();
            if (activeTab) {
                await chrome.scripting.executeScript({
                    target: { tabId: activeTab.id },
                    func: () => { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); }
                });
            }
            webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
        } else if (data.type === 'close_tab') {
            const tabId = parseInt(data.payload.tab_id);
            await chrome.tabs.remove(tabId);
            webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
        } else if (data.type === 'reload_tab') {
            const tabId = data.payload.tab_id ? parseInt(data.payload.tab_id) : (await getActiveTab()).id;
            await chrome.tabs.reload(tabId);
            webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
        } else if (data.type === 'duplicate_tab') {
            const tabId = data.payload.tab_id ? parseInt(data.payload.tab_id) : (await getActiveTab()).id;
            const newTab = await chrome.tabs.duplicate(tabId);
            webSocket.send(JSON.stringify({ result: { status: 'success', tab: newTab }, replyTo: data.replyTo }));
        } else if (data.type === 'go_back') {
            const tabId = data.payload.tab_id ? parseInt(data.payload.tab_id) : (await getActiveTab()).id;
            await chrome.tabs.goBack(tabId);
            webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
        } else if (data.type === 'go_forward') {
            const tabId = data.payload.tab_id ? parseInt(data.payload.tab_id) : (await getActiveTab()).id;
            await chrome.tabs.goForward(tabId);
            webSocket.send(JSON.stringify({ result: { status: 'success' }, replyTo: data.replyTo }));
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
            const activeTab = await getActiveTab();
            if (!activeTab) {
                webSocket.send(JSON.stringify({ result: { status: 'error', message: 'No active tab' }, replyTo: data.replyTo }));
            } else {
                const [result] = await chrome.scripting.executeScript({
                    target: { tabId: activeTab.id },
                    func: (action, value, xpath) => {
                        function getByXPath(xp) {
                            return document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                        }
                        const media = (xpath ? getByXPath(xpath) : null)
                            || document.querySelector('video')
                            || document.querySelector('audio');
                        if (!media) return { status: 'error', message: 'No media element found on page' };
                        if (action === 'play')        media.play();
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
                webSocket.send(JSON.stringify({ result: result?.result ?? result, replyTo: data.replyTo }));
            }
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

    webSocket.onclose = () => {
        //console.log('WebSocket connection closed');
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

async function getActiveTab() {
    const tabs = await chrome.tabs.query({active: true, currentWindow: true});
    return tabs[0];
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

function startReconnectionLoop() {
    console.log('Starting reconnection loop...');
    chrome.action.setIcon({path: 'icons/socket-inactive.png'});
    contextUpdaters = [defaultContextUpdater];

    connect();
    reconnectIntervalId = setInterval(() => {
        //console.log('Attempting to reconnect...');
        connect();
    }, 5000);
}

function stopReconnectionLoop() {
    console.log('Stopping reconnection loop...');
    chrome.action.setIcon({path: 'icons/socket-disabled.png'});
    clearInterval(reconnectIntervalId);
    reconnectIntervalId = null;
    disconnect();
}

function clearReconnectInterval() {
    console.log('Clearing reconnect interval...');
    if (reconnectIntervalId) {
        clearInterval(reconnectIntervalId);
        reconnectIntervalId = null;
    }
}
