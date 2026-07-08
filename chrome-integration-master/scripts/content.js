const createIframe = () => {
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('sandbox.html');
    iframe.id = 'extension-sandbox-iframe';
    iframe.style.display = 'none';
    iframe.style.position = 'absolute';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    return iframe;
};
let iframe = createIframe();

const body = document.getElementsByTagName('body')[0];
body.appendChild(iframe);

const handlers = new Map();
let emailCache = {}; // {html, lastUpdated}

window.addEventListener("message", async (event) => {
    if (event.source === iframe.contentWindow && event.data.voqal_resp_id) {
        const pair = handlers.get(event.data.voqal_resp_id);
        const handler = pair ? pair[0] : null;
        const time = pair ? pair[1] : null;
        if (handler) {
            const timeTaken = Date.now() - time;
            handler({
                ...event.data,
                debug: {
                    ...event.data.debug,
                    messageDuration: timeTaken
                }
            });
        } else {
            console.warn(`No handler found for message ID: ${event.data.voqal_resp_id}`);
        }
    }
});

function extractDiff(oldHtml, newHtml) {
    const diff = [];
    let i = 0;
    let j = 0;

    while (i < oldHtml.length || j < newHtml.length) {
        if (oldHtml[i] === newHtml[j]) {
            i++;
            j++;
        } else {
            // Find the start of the difference
            const start = i;
            const newStart = j;

            // Find the end of the difference
            while (i < oldHtml.length && oldHtml[i] !== newHtml[j]) i++;
            while (j < newHtml.length && newHtml[j] !== oldHtml[i]) j++;

            // Record the difference
            diff.push({
                start,
                newStart,
                oldContent: oldHtml.slice(start, i),
                newContent: newHtml.slice(newStart, j),
            });
        }
    }

    return diff;
}

function applyDiff(oldHtml, diff) {
    let result = '';
    let lastIndex = 0;

    diff.forEach(({start, oldContent, newContent}) => {
        // Append unchanged content
        result += oldHtml.slice(lastIndex, start);
        // Replace with new content
        result += newContent;
        // Update the last processed index
        lastIndex = start + oldContent.length;
    });

    // Append remaining unchanged content
    result += oldHtml.slice(lastIndex);

    return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "evaluate") {
        const handler = (event) => {
            const data = event.result;

            function getElementByXPath(xpath) {
                const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                return result.singleNodeValue;
            }

            // Generic scroll-container detection. window.scrollBy() silently no-ops
            // on SPA-heavy sites (Gmail, Docs, Drive) where the page itself does not
            // scroll but an inner panel does. Returns the element that should scroll,
            // or null to mean "scroll the window". Not site-specific.
            function getScrollTarget() {
                const de = document.scrollingElement || document.documentElement;
                const pageScrolls = de && (de.scrollHeight - de.clientHeight) > 4;
                let best = null, bestArea = 0;
                const els = document.querySelectorAll('div, main, section, ul, ol, article, [role="main"]');
                for (const el of els) {
                    const style = getComputedStyle(el);
                    const oy = style.overflowY;
                    if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
                    if ((el.scrollHeight - el.clientHeight) <= 4 || el.clientHeight < 120) continue;
                    const r = el.getBoundingClientRect();
                    const vis = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) *
                                Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
                    if (vis > bestArea) { bestArea = vis; best = el; }
                }
                // Prefer the window when the document itself scrolls and no inner
                // panel dominates the viewport.
                if (pageScrolls && bestArea < (innerWidth * innerHeight * 0.5)) return null;
                return best; // may be null → caller falls back to window
            }

            function triggerComplexClick(element) {
                if (!element) {
                    console.error("Element not found.");
                    return;
                }
                if (element.tabIndex >= 0) {
                    element.focus();
                    console.log("Element focused.");
                }
                const mouseDownEvent = new MouseEvent("mousedown", {bubbles: true, cancelable: true, view: window});
                element.dispatchEvent(mouseDownEvent);
                console.log("Mousedown event dispatched.");
                const mouseUpEvent = new MouseEvent("mouseup", {bubbles: true, cancelable: true, view: window});
                element.dispatchEvent(mouseUpEvent);
                console.log("Mouseup event dispatched.");
                const clickEvent = new MouseEvent("click", {bubbles: true, cancelable: true, view: window});
                element.dispatchEvent(clickEvent);
                console.log("Click event dispatched.");
                if (!element.onclick && element.tabIndex >= 0) {
                    const keyEvent = new KeyboardEvent("keydown", {
                        bubbles: true,
                        cancelable: true,
                        key: "Enter",
                        code: "Enter"
                    });
                    element.dispatchEvent(keyEvent);
                    console.log("Enter key event dispatched.");
                }
            }

            function clickAndReevaluate(iframe, message) {
                console.log("doing click");
                const element = getElementByXPath(data.xpath);
                if (element) {
                    triggerComplexClick(element);
                } else {
                    console.error('Element not found. XPath:', data.xpath);
                }
                setTimeout(() => {
                    console.log("Reevaluating");
                    iframe.contentWindow.postMessage({
                        html: document.body.innerHTML,
                        code: message.code,
                        action: 'reevaluate',
                        voqal_resp_id: message.voqal_resp_id
                    }, "*");
                }, 1000);
            }

            function writeText(iframe, message) {
                console.log("writing text");
                const element = getElementByXPath(data.xpath);
                if (element) {
                    element.innerText = data.text;
                } else {
                    console.error('Element not found');
                }
            }

            function click(iframe, message) {
                let toClick = [];
                if (data.xpath) {
                    toClick = [getElementByXPath(data.xpath)];
                } else if (data.xpaths) {
                    toClick = data.xpaths.map(getElementByXPath);
                } else {
                    console.error('No xpath(s) provided');
                }
                toClick.forEach(element => {
                    if (element) {
                        console.log("clicking", element);
                        // Smart click: detect radio/checkbox inputs and handle them properly
                        const handled = smartToggleInput(element);
                        if (!handled) {
                            triggerComplexClick(element);
                        }
                    } else {
                        console.error('Element not found');
                    }
                });
            }

            // Find and toggle the nearest radio/checkbox input for an element.
            // Returns true if an input was found and toggled, false otherwise.
            function smartToggleInput(element) {
                let input = null;
                let label = null;

                // Case 1: Element IS the input
                if (element.tagName === 'INPUT' && (element.type === 'radio' || element.type === 'checkbox')) {
                    input = element;
                }

                // Case 2: Element is a <label>
                if (!input && element.tagName === 'LABEL') {
                    label = element;
                    if (element.htmlFor) {
                        input = document.getElementById(element.htmlFor);
                    } else {
                        input = element.querySelector('input[type="radio"], input[type="checkbox"]');
                    }
                }

                // Case 3: Element is inside a <label> that wraps or references an input
                if (!input) {
                    label = element.closest('label');
                    if (label) {
                        input = label.querySelector('input[type="radio"], input[type="checkbox"]');
                        if (!input && label.htmlFor) {
                            input = document.getElementById(label.htmlFor);
                        }
                    }
                }

                // Case 4: Walk up to find the nearest container with a single input
                if (!input) {
                    for (let el = element.parentElement; el && el !== document.body; el = el.parentElement) {
                        const inputs = el.querySelectorAll('input[type="radio"], input[type="checkbox"]');
                        if (inputs.length === 1) {
                            input = inputs[0];
                            break;
                        }
                        if (el.tagName === 'FIELDSET') break;
                    }
                }

                if (!input && !label) return false;

                console.log("Smart toggle: found", input ? `input[${input.type}] name=${input.name} value=${input.value}` : 'label only');

                // Strategy 1: Inject a <script> into the page's MAIN WORLD.
                // Content scripts run in an isolated world — page JS event handlers
                // may not see events dispatched from the content script context.
                // By injecting a script tag, we execute in the page's own JS context.
                try {
                    if (input && input.id) {
                        const script = document.createElement('script');
                        script.textContent = `(function(){
                            var el = document.getElementById(${JSON.stringify(input.id)});
                            if(el){ el.click(); }
                        })();`;
                        document.documentElement.appendChild(script);
                        script.remove();
                        console.log("Smart toggle: main-world click via #id");
                        return true;
                    }

                    // Input has no ID — use a CSS selector
                    if (input) {
                        const name = input.getAttribute('name');
                        const value = input.getAttribute('value');
                        if (name && value) {
                            const selector = `input[name=${JSON.stringify(name)}][value=${JSON.stringify(value)}]`;
                            const script = document.createElement('script');
                            script.textContent = `(function(){
                                var el = document.querySelector(${JSON.stringify(selector)});
                                if(el){ el.click(); }
                            })();`;
                            document.documentElement.appendChild(script);
                            script.remove();
                            console.log("Smart toggle: main-world click via selector", selector);
                            return true;
                        }
                    }
                } catch (e) {
                    console.warn("Smart toggle: main-world injection failed:", e.message);
                }

                // Strategy 2: Native .click() on the label (triggers browser's
                // built-in label→input association which IS a trusted pathway)
                if (label) {
                    label.click();
                    console.log("Smart toggle: label.click() fallback");
                    return true;
                }

                // Strategy 3: Direct .click() on the input (content script context)
                if (input) {
                    input.click();
                    console.log("Smart toggle: input.click() fallback");
                    return true;
                }

                return false;
            }

            // ── select_option: find a radio/checkbox/option by label and activate it ──
            // Ported from the new version's forms.js plugin. This discovers form
            // elements by their visible label text rather than relying on xpaths.
            if (data.action === 'select_option') {
                const query = (data.label || data.text || '').toLowerCase().trim();
                if (!query) {
                    sendResponse({ result: { status: 'error', message: 'No label/text provided' } });
                    handlers.delete(event.voqal_resp_id);
                    return;
                }

                const found = findAndSelectOption(query);
                sendResponse({
                    result: { status: found ? 'success' : 'not_found', label: query },
                    debug: event.debug
                });
                handlers.delete(event.voqal_resp_id);
                return;
            }

            // Discover and select a form option by label text
            function findAndSelectOption(query) {
                const candidates = [];
                const seen = new Set();

                // 1. Standard radio buttons & checkboxes
                document.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach(el => {
                    if (!isElVisible(el)) return;
                    const label = getInputLabel(el);
                    if (label && !seen.has(label.toLowerCase())) {
                        seen.add(label.toLowerCase());
                        candidates.push({ el, label, type: el.type });
                    }
                });

                // 2. ARIA role elements: role="radio", role="checkbox", role="tab", role="option"
                document.querySelectorAll('[role="radio"],[role="checkbox"],[role="tab"],[role="option"],[role="menuitemradio"]').forEach(el => {
                    if (!isElVisible(el)) return;
                    const label = (el.getAttribute('aria-label') || el.innerText || '').trim();
                    if (label && !seen.has(label.toLowerCase())) {
                        seen.add(label.toLowerCase());
                        candidates.push({ el, label, type: el.getAttribute('role') });
                    }
                });

                // 3. <select> options
                document.querySelectorAll('select').forEach(sel => {
                    if (!isElVisible(sel)) return;
                    Array.from(sel.options).forEach(opt => {
                        const label = opt.text.trim();
                        if (label && !seen.has(label.toLowerCase())) {
                            seen.add(label.toLowerCase());
                            candidates.push({ el: opt, label, type: 'option', parent: sel });
                        }
                    });
                });

                // 4. Buttons and labels (visual radio-like elements)
                document.querySelectorAll('button, label').forEach(el => {
                    if (!isElVisible(el)) return;
                    const txt = (el.innerText || '').trim();
                    if (txt && txt.length < 60 && !seen.has(txt.toLowerCase())) {
                        seen.add(txt.toLowerCase());
                        candidates.push({ el, label: txt, type: 'button' });
                    }
                });

                if (!candidates.length) return false;

                // Fuzzy match
                let bestMatch = null;
                let bestScore = 0;
                for (const c of candidates) {
                    const score = fuzzyScore(query, c.label.toLowerCase());
                    if (score > bestScore) {
                        bestScore = score;
                        bestMatch = c;
                    }
                }

                if (!bestMatch || bestScore < 0.4) return false;

                console.log(`[AbleSpeak] select_option: matched "${bestMatch.label}" (score: ${bestScore.toFixed(2)}, type: ${bestMatch.type})`);

                // Activate the element based on type
                const { el, type, parent } = bestMatch;

                if (type === 'option' && parent) {
                    // <select> option
                    parent.value = el.value;
                    parent.dispatchEvent(new Event('change', { bubbles: true }));
                } else if (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox')) {
                    // Standard radio/checkbox — use main-world injection for max compatibility
                    activateInputMainWorld(el);
                } else {
                    // Custom widget — complexClick
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    triggerComplexClick(el);
                }

                return true;
            }

            // Activate a radio/checkbox input via main-world script injection
            function activateInputMainWorld(input) {
                try {
                    if (input.id) {
                        const script = document.createElement('script');
                        script.textContent = `(function(){
                            var el = document.getElementById(${JSON.stringify(input.id)});
                            if(el){ el.checked = true; el.dispatchEvent(new Event('change',{bubbles:true})); el.dispatchEvent(new Event('input',{bubbles:true})); }
                        })();`;
                        document.documentElement.appendChild(script);
                        script.remove();
                        return;
                    }
                    const name = input.getAttribute('name');
                    const value = input.getAttribute('value');
                    if (name && value) {
                        const sel = `input[name=${JSON.stringify(name)}][value=${JSON.stringify(value)}]`;
                        const script = document.createElement('script');
                        script.textContent = `(function(){
                            var el = document.querySelector(${JSON.stringify(sel)});
                            if(el){ el.checked = true; el.dispatchEvent(new Event('change',{bubbles:true})); el.dispatchEvent(new Event('input',{bubbles:true})); }
                        })();`;
                        document.documentElement.appendChild(script);
                        script.remove();
                        return;
                    }
                } catch (e) { /* fall through */ }
                // Fallback: content-script context
                input.checked = true;
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }

            function getInputLabel(el) {
                if (el.id) {
                    const lbl = document.querySelector(`label[for="${el.id}"]`);
                    if (lbl) return (lbl.innerText || lbl.textContent || '').trim();
                }
                const parent = el.closest('label');
                if (parent) return (parent.innerText || parent.textContent || '').replace(el.value || '', '').trim();
                const ariaLbl = el.getAttribute('aria-label');
                if (ariaLbl) return ariaLbl;
                const ariaRef = el.getAttribute('aria-labelledby');
                if (ariaRef) {
                    const ref = document.getElementById(ariaRef);
                    if (ref) return (ref.innerText || '').trim();
                }
                return el.getAttribute('value') || el.getAttribute('name') || '';
            }

            function isElVisible(el) {
                try {
                    const r = el.getBoundingClientRect();
                    if (!r.width || !r.height) return false;
                    const style = window.getComputedStyle(el);
                    return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0;
                } catch { return false; }
            }

            function fuzzyScore(a, b) {
                a = a.toLowerCase().trim();
                b = b.toLowerCase().trim();
                if (a === b) return 1;
                // Check substring containment
                if (b.includes(a) || a.includes(b)) return 0.85;
                // Levenshtein distance
                const mx = Math.max(a.length, b.length);
                if (!mx) return 1;
                const m = a.length, n = b.length;
                const d = Array.from({length: m+1}, (_, i) => Array.from({length: n+1}, (_, j) => i === 0 ? j : j === 0 ? i : 0));
                for (let i = 1; i <= m; i++)
                    for (let j = 1; j <= n; j++)
                        d[i][j] = a[i-1] === b[j-1] ? d[i-1][j-1] : 1 + Math.min(d[i-1][j], d[i][j-1], d[i-1][j-1]);
                return 1 - d[m][n] / mx;
            }

            // ── search_page: find search bar, clear it, type query, press Enter ──
            if (data.action === 'search_page') {
                const query = (data.query || data.text || '').trim();
                if (!query) {
                    sendResponse({ result: { status: 'error', message: 'No query provided' } });
                    handlers.delete(event.voqal_resp_id);
                    return;
                }

                const searchEl = findSearchInput();
                if (!searchEl) {
                    sendResponse({ result: { status: 'not_found', message: 'No search bar found on this page' } });
                    handlers.delete(event.voqal_resp_id);
                    return;
                }

                // Clear, type, and submit
                searchEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                searchEl.focus();
                searchEl.click();

                // Clear existing text using native setter
                setTimeout(() => {
                    try {
                        const proto = searchEl.tagName === 'TEXTAREA'
                            ? window.HTMLTextAreaElement.prototype
                            : window.HTMLInputElement.prototype;
                        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
                        if (setter && setter.set) {
                            setter.set.call(searchEl, '');
                        } else {
                            searchEl.value = '';
                        }
                    } catch (_) {
                        searchEl.value = '';
                    }
                    searchEl.dispatchEvent(new Event('input', { bubbles: true }));

                    // Type the new query
                    setTimeout(() => {
                        try {
                            const proto = searchEl.tagName === 'TEXTAREA'
                                ? window.HTMLTextAreaElement.prototype
                                : window.HTMLInputElement.prototype;
                            const setter = Object.getOwnPropertyDescriptor(proto, 'value');
                            if (setter && setter.set) {
                                setter.set.call(searchEl, query);
                            } else {
                                searchEl.value = query;
                            }
                        } catch (_) {
                            searchEl.value = query;
                        }
                        searchEl.dispatchEvent(new Event('input', { bubbles: true }));
                        searchEl.dispatchEvent(new Event('change', { bubbles: true }));

                        // Submit after a brief delay (let autocomplete settle)
                        if (data.submit !== false) {
                            setTimeout(() => {
                                // Try form submit first
                                const form = searchEl.closest('form');
                                if (form) {
                                    form.submit();
                                } else {
                                    // Press Enter
                                    searchEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                                    searchEl.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                                    searchEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                                }
                            }, 200);
                        }
                    }, 100);
                }, 100);

                sendResponse({ result: { status: 'success', query, element: searchEl.tagName } });
                handlers.delete(event.voqal_resp_id);
                return;
            }

            // ── clear_field: clear the focused or specified input ──
            if (data.action === 'clear_field') {
                const element = data.xpath ? getElementByXPath(data.xpath)
                    : (data.query_selector ? document.querySelector(data.query_selector) : null)
                    || document.activeElement;

                if (element && element !== document.body) {
                    element.focus();
                    try {
                        const proto = element.tagName === 'TEXTAREA'
                            ? window.HTMLTextAreaElement.prototype
                            : window.HTMLInputElement.prototype;
                        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
                        if (setter && setter.set) {
                            setter.set.call(element, '');
                        } else {
                            element.value = '';
                        }
                    } catch (_) {
                        element.value = '';
                    }
                    element.dispatchEvent(new Event('input', { bubbles: true }));
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                    sendResponse({ result: { status: 'success', message: 'Field cleared' } });
                } else {
                    sendResponse({ result: { status: 'error', message: 'No active input field' } });
                }
                handlers.delete(event.voqal_resp_id);
                return;
            }

            // Find the search input on the current page
            function findSearchInput() {
                const url = window.location.href;

                // Google Search — uses a <textarea> now
                if (url.includes('google.com')) {
                    return document.querySelector('textarea[name="q"]')
                        || document.querySelector('input[name="q"]')
                        || document.querySelector('textarea[aria-label*="Search"]')
                        || document.querySelector('input[aria-label*="Search"]');
                }

                // YouTube
                if (url.includes('youtube.com')) {
                    return document.querySelector('input#search')
                        || document.querySelector('input[name="search_query"]');
                }

                // Wikipedia
                if (url.includes('wikipedia.org')) {
                    return document.querySelector('input#searchInput')
                        || document.querySelector('input[name="search"]');
                }

                // Generic strategies
                return document.querySelector('input[type="search"]')
                    || document.querySelector('[role="searchbox"]')
                    || document.querySelector('input[name*="search" i]')
                    || document.querySelector('input[name*="query" i]')
                    || document.querySelector('input[name="q"]')
                    || document.querySelector('input[placeholder*="search" i]')
                    || document.querySelector('input[aria-label*="search" i]');
            }

            if (data.action === 'get_variable') {
                const element = document.querySelector(data.query_selector);
                if (element) {
                    sendResponse({
                        result: element[data.variable_name],
                        debug: event.debug
                    });
                } else {
                    console.error('Element not found');
                    sendResponse({
                        result: null,
                        debug: event.debug
                    });
                }
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'update_variable') {
                const element = document.querySelector(data.query_selector);
                if (element) {
                    let value = parseFloat(data.variable_value);
                    if (data.variable_operation === 'add') {
                        value += parseFloat(element[data.variable_name]);
                    }
                    element[data.variable_name] = value;
                } else {
                    console.error('Element not found');
                }

                sendResponse({
                    result: data,
                    debug: event.debug
                });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'update_window') {
                //split variable_name by '.' and set the value
                const variableNameParts = data.variable_name.split('.');
                let variable = window;
                for (let i = 0; i < variableNameParts.length - 1; i++) {
                    variable = variable[variableNameParts[i]];
                }
                variable[variableNameParts[variableNameParts.length - 1]] = data.variable_value;
                sendResponse({
                    result: data,
                    debug: event.debug
                });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'click') {
                click(iframe, message);
                sendResponse({
                    result: data,
                    debug: event.debug
                });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'click_and_reevaluate') {
                clickAndReevaluate(iframe, message);
            } else if (data.action === 'write_text') {
                writeText(iframe, message);
                sendResponse({
                    result: data,
                    debug: event.debug
                });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'fill_input') {
                const element = getElementByXPath(data.xpath) || document.querySelector(data.query_selector);
                if (element) {
                    element.focus();
                    // Try native setter (works on most sites), fall back to direct assignment
                    // Google Search's textarea throws "Illegal invocation" with the native setter
                    let filled = false;
                    try {
                        const proto = element.tagName === 'TEXTAREA'
                            ? window.HTMLTextAreaElement.prototype
                            : window.HTMLInputElement.prototype;
                        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
                        if (setter && setter.set) {
                            setter.set.call(element, data.text);
                            filled = true;
                        }
                    } catch (_) {
                        // Illegal invocation — fall through to direct assignment
                    }
                    if (!filled) {
                        element.value = data.text;
                    }
                    element.dispatchEvent(new Event('input', { bubbles: true }));
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                }
                sendResponse({ result: data, debug: event.debug });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'type_text') {
                const element = getElementByXPath(data.xpath) || document.querySelector(data.query_selector) || document.activeElement;
                if (element) {
                    element.focus();
                    for (const char of data.text) {
                        element.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
                        element.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
                        if (element.isContentEditable) {
                            const sel = window.getSelection();
                            if (sel && sel.rangeCount > 0) {
                                const range = sel.getRangeAt(0);
                                range.deleteContents();
                                range.insertNode(document.createTextNode(char));
                                range.collapse(false);
                                sel.removeAllRanges();
                                sel.addRange(range);
                            }
                            element.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }));
                        } else {
                            element.value = (element.value || '') + char;
                            element.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                        element.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
                    }
                }
                sendResponse({ result: data, debug: event.debug });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'select_option') {
                const element = getElementByXPath(data.xpath) || document.querySelector(data.query_selector);
                if (element) {
                    element.value = data.value;
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                }
                sendResponse({ result: data, debug: event.debug });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'clear_input') {
                const element = getElementByXPath(data.xpath) || document.querySelector(data.query_selector);
                if (element) {
                    element.focus();
                    element.value = '';
                    element.dispatchEvent(new Event('input', { bubbles: true }));
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                }
                sendResponse({ result: data, debug: event.debug });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'check_checkbox') {
                const element = getElementByXPath(data.xpath) || document.querySelector(data.query_selector);
                if (element && !element.checked) {
                    element.checked = true;
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                }
                sendResponse({ result: data, debug: event.debug });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'uncheck_checkbox') {
                const element = getElementByXPath(data.xpath) || document.querySelector(data.query_selector);
                if (element && element.checked) {
                    element.checked = false;
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                }
                sendResponse({ result: data, debug: event.debug });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'submit_form') {
                const element = getElementByXPath(data.xpath) || document.querySelector(data.query_selector);
                if (element) {
                    const form = element.closest('form') || element;
                    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                    if (form.submit) form.submit();
                }
                sendResponse({ result: data, debug: event.debug });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'scroll_to') {
                if (data.xpath || data.query_selector) {
                    const element = getElementByXPath(data.xpath) || document.querySelector(data.query_selector);
                    if (element) element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                } else {
                    const target = getScrollTarget();
                    if (target) target.scrollTo({ top: data.y || 0, left: data.x || 0, behavior: 'smooth' });
                    else window.scrollTo({ top: data.y || 0, left: data.x || 0, behavior: 'smooth' });
                }
                sendResponse({ result: data, debug: event.debug });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'scroll_by') {
                const target = getScrollTarget();
                if (target) target.scrollBy({ top: data.y || 0, left: data.x || 0, behavior: 'smooth' });
                else window.scrollBy({ top: data.y || 0, left: data.x || 0, behavior: 'smooth' });
                sendResponse({ result: data, debug: event.debug });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'press_key') {
                const target = (data.xpath ? getElementByXPath(data.xpath) : null) || document.activeElement || document.body;
                const keyInit = { key: data.key, code: data.code || data.key, bubbles: true, cancelable: true };
                target.dispatchEvent(new KeyboardEvent('keydown', keyInit));
                target.dispatchEvent(new KeyboardEvent('keyup', keyInit));
                sendResponse({ result: data, debug: event.debug });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'get_text') {
                const element = getElementByXPath(data.xpath) || document.querySelector(data.query_selector);
                sendResponse({ result: element ? element.innerText : null, debug: event.debug });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'get_attribute') {
                const element = getElementByXPath(data.xpath) || document.querySelector(data.query_selector);
                sendResponse({ result: element ? element.getAttribute(data.attribute) : null, debug: event.debug });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'set_attribute') {
                const element = getElementByXPath(data.xpath) || document.querySelector(data.query_selector);
                if (element) element.setAttribute(data.attribute, data.value);
                sendResponse({ result: data, debug: event.debug });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'get_page_title') {
                sendResponse({ result: document.title, debug: event.debug });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'get_selection') {
                sendResponse({ result: window.getSelection().toString(), debug: event.debug });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'focus_element') {
                const element = getElementByXPath(data.xpath) || document.querySelector(data.query_selector);
                if (element) element.focus();
                sendResponse({ result: data, debug: event.debug });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'hover') {
                const element = getElementByXPath(data.xpath) || document.querySelector(data.query_selector);
                if (element) {
                    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
                    element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
                }
                sendResponse({ result: data, debug: event.debug });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'gdocs_key') {
                // Dispatches a keyboard shortcut into the Google Docs event-capture iframe
                const iframe = document.querySelector('.docs-texteventtarget-iframe');
                const target = (iframe && iframe.contentDocument)
                    ? (iframe.contentDocument.querySelector('[contenteditable]') || iframe.contentDocument.body)
                    : (document.activeElement || document.body);
                target.focus();
                const keyInit = {
                    key: data.key,
                    code: data.code || ('Key' + data.key.toUpperCase()),
                    ctrlKey: !!data.ctrl,
                    shiftKey: !!data.shift,
                    altKey: !!data.alt,
                    bubbles: true,
                    cancelable: true
                };
                target.dispatchEvent(new KeyboardEvent('keydown', keyInit));
                target.dispatchEvent(new KeyboardEvent('keyup', keyInit));
                sendResponse({ result: { status: 'success' }, debug: event.debug });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'gdocs_type') {
                // Inserts text into the Google Docs editor
                const iframe = document.querySelector('.docs-texteventtarget-iframe');
                if (iframe && iframe.contentDocument) {
                    const editable = iframe.contentDocument.querySelector('[contenteditable="true"]') || iframe.contentDocument.body;
                    editable.focus();
                    // insertText via the iframe document is the most reliable method for Google Docs
                    iframe.contentDocument.execCommand('insertText', false, data.text);
                } else {
                    // Fallback: dispatch InputEvent to active element
                    const target = document.activeElement || document.body;
                    target.dispatchEvent(new InputEvent('textInput', { data: data.text, bubbles: true }));
                }
                sendResponse({ result: { status: 'success' }, debug: event.debug });
                handlers.delete(event.voqal_resp_id);
            } else if (data.action === 'wait_for_element') {
                const selector = data.query_selector;
                const timeout = data.timeout || 5000;
                const existing = document.querySelector(selector);
                if (existing) {
                    sendResponse({ result: { found: true }, debug: event.debug });
                    handlers.delete(event.voqal_resp_id);
                } else {
                    const observer = new MutationObserver(() => {
                        const el = document.querySelector(selector);
                        if (el) {
                            observer.disconnect();
                            clearTimeout(timer);
                            sendResponse({ result: { found: true }, debug: event.debug });
                            handlers.delete(event.voqal_resp_id);
                        }
                    });
                    observer.observe(document.body, { childList: true, subtree: true });
                    const timer = setTimeout(() => {
                        observer.disconnect();
                        sendResponse({ result: { found: false }, debug: event.debug });
                        handlers.delete(event.voqal_resp_id);
                    }, timeout);
                }
            } else {
                sendResponse({
                    result: data,
                    debug: event.debug
                });
                handlers.delete(event.voqal_resp_id);
            }
        };

        function simpleHash(input) {
            let hash = 0;
            for (let i = 0; i < input.length; i++) {
                const char = input.charCodeAt(i);
                hash = (hash << 5) - hash + char;
                hash |= 0;
            }
            return hash;
        }

        let htmlPostData = {};
        if (!emailCache.html || Date.now() - emailCache.lastUpdated > 1000) {
            const innerHTML = document.body.innerHTML
            const htmlHash = simpleHash(innerHTML);

            if (!emailCache.hash || emailCache.hash !== htmlHash) {
                if (emailCache.html) {
                    const diff = extractDiff(emailCache.html, innerHTML);

                    const diffSize = JSON.stringify(diff).length / 1024;
                    const htmlSize = innerHTML.length / 1024;
                    if (diffSize < htmlSize) {
                        htmlPostData = {
                            diff: diff,
                            hash: htmlHash
                        };

                        const appliedDiff = applyDiff(emailCache.html, diff);
                        const appliedHash = simpleHash(appliedDiff);
                        //console.log("Sending diff. Applied hash: " + appliedHash);
                    } else {
                        //console.log("Bad diff. Diff size: " + diffSize + " - Html size: " + htmlSize);
                        htmlPostData = {
                            html: innerHTML,
                            hash: htmlHash
                        };
                        //console.log("Sending full html. Hash: " + htmlHash);
                    }
                } else {
                    htmlPostData = {
                        html: innerHTML,
                        hash: htmlHash
                    };
                    //console.log("Sending full html. Hash: " + htmlHash);
                }
                emailCache = {
                    html: innerHTML,
                    hash: htmlHash,
                    lastUpdated: Date.now()
                };
            }
        }

        handlers.set(message.voqal_resp_id, [handler, Date.now()]);
        const postData = {
            ...htmlPostData,
            code: message.code,
            voqal_resp_id: message.voqal_resp_id,
            sentAt: Date.now()
        };
        const postDataJson = JSON.stringify(postData);
        const size = (postDataJson.length / 1024);
        if (size > 10) {
            console.log("Post data size in kb: " + size + " - Hash: " + simpleHash(emailCache.html));
        }
        iframe.contentWindow.postMessage(postData, "*");

        return true;
    }
});
