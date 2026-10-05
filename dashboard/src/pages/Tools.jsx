/**
 * Developer hub › Tools — every tool the AI can call, read live from the
 * server's tool registry (GET /api/tools), grouped by category. Built from
 * the Stitch "Developer hub" screen (docs/design/stitch/developer-hub.html):
 * category chips, a searchable list, the chosen tool's description,
 * parameters and function schema, and a short live view of the log below.
 * Only what the registry says is shown.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { LogPanel } from './Logs';
import { SECTION, MUTED, BODY, CARD, WELL, DIVIDER, QUIET, FIELD, DOT, INK } from '../lib/ui';

// When the safety layer stops for a spoken "yes" before a tool runs
// (server/src/safety.js, classifyConsequential). The tool catalogue doesn't
// carry this, so it is mirrored here: keep the two in step.
const DELETE_WORDS = ['delete', 'remove', 'trash', 'destroy'];
const SEND_WORDS = ['send', 'submit', 'post', 'publish', 'email', 'share', 'purchase', 'buy', 'pay', 'order'];
const KEY_TOOLS = new Set(['send_system_keys', 'send_keys', 'press_key_combination']);
const LABEL_TOOLS = new Set(['click_element', 'click_desktop_element', 'select_option', 'uia_act']);

/** { short, note }: when the student is asked to say "yes" before the tool runs. */
function safetyRule(name) {
  const words = String(name).toLowerCase().split(/[_\s-]+/);
  const always = note => ({ short: 'Always asks for “yes”', note });
  const sometimes = note => ({ short: 'Asks for “yes” when risky', note });
  if (name === 'close_application') return always('Always asks the user to say “yes” before it closes an app.');
  if (words.some(w => DELETE_WORDS.includes(w)) || (!KEY_TOOLS.has(name) && words.some(w => SEND_WORDS.includes(w)))) {
    return always('Always asks the user to say “yes” before it runs.');
  }
  if (name === 'send_system_keys') return sometimes('Asks the user to say “yes” first when the keys close a window (Alt+F4) or delete for good (Shift+Del).');
  if (name === 'press_key_combination') return sometimes('Asks the user to say “yes” first when the keys close a window (Alt+F4).');
  if (LABEL_TOOLS.has(name)) return sometimes('Asks the user to say “yes” first when the control it presses is labelled delete, remove, send, submit, buy, pay or similar.');
  if (name === 'execute_javascript') return sometimes('Asks the user to say “yes” first when the code submits a form, or clicks something to delete or send.');
  return { short: 'Runs without asking', note: null };
}

function Icon({ name, className = '', style }) {
  return <span className={`material-symbols-outlined ${className}`} style={style} aria-hidden="true">{name}</span>;
}

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
// Values coloured by the key they belong to, as the Stitch schema block does
const VALUE_COLOUR = { name: 'text-[#ffc880]', description: 'text-[#c9b8a5]' };

/** Pretty-printed JSON: keys in soft teal, names amber, descriptions muted, other values sand. */
export function JsonText({ text }) {
  const parts = [];
  const re = new RegExp(JSON_TOKEN.source, 'g');
  let last = 0;
  let key = null;
  let match;
  while ((match = re.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const k = parts.length;
    if (match[1] && match[2]) {
      key = match[1].slice(1, -1);
      parts.push(<span key={k} className="text-[#8fd3c4]">{match[1]}</span>, match[2]);
    } else {
      parts.push(<span key={k} className={VALUE_COLOUR[key] || 'text-[#e3c9a0]'}>{match[0]}</span>);
      key = null;
    }
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** A parameter's type as written in its schema, e.g. "string" or "string[]". */
function typeLabel(schema) {
  if (Array.isArray(schema?.type)) return schema.type.join(' | ');
  if (schema?.type === 'array' && schema.items?.type) return `${schema.items.type}[]`;
  return schema?.type || 'any';
}

/** The description, with the tool's own parameter names (tab_id, …) set as code. */
function DescriptionText({ text, params }) {
  const names = params.filter(n => n.includes('_')).sort((a, b) => b.length - a.length);
  if (!names.length) return text;
  const re = new RegExp(`\\b(${names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g');
  return text.split(re).map((part, i) => (i % 2
    ? <code key={i} className="font-mono text-[#ffc880] bg-white/[0.04] px-1 py-0.5 rounded text-[13px]">{part}</code>
    : part));
}

function CategoryChip({ selected, count, onClick, children }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`min-h-[36px] px-3 rounded-md text-[13px] flex items-center gap-1.5 shrink-0 whitespace-nowrap transition-colors ${selected
        ? 'bg-[#222a37] text-[#ffc880] font-semibold'
        : 'text-[#c9b8a5] hover:text-[#dae3f4] hover:bg-[#18202d]'}`}
    >
      <span>{children}</span>
      <span className="text-[12px] font-normal text-[#8b95a7] tabular-nums">{count}</span>
    </button>
  );
}

export default function Tools() {
  const { data: catalog, isLoading, isError } = useQuery({ queryKey: ['tools'], queryFn: api.getTools, staleTime: 30000 });
  const [selectedCat, setSelectedCat] = useState(null);
  const [selectedTool, setSelectedTool] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef(null);

  const categories = useMemo(() => catalog?.categories || [], [catalog]);
  // Every tool, with the category it sits in
  const allTools = useMemo(
    () => categories.flatMap(cat => cat.tools.map(tool => ({ ...tool, category: cat.name }))),
    [categories],
  );

  const q = searchQuery.trim().toLowerCase();
  const displayed = allTools.filter(t =>
    (!selectedCat || t.category === selectedCat) &&
    (!q || t.name.toLowerCase().includes(q) || (t.description || t.jsonSchema?.description || '').toLowerCase().includes(q)),
  );
  const groups = categories
    .map(cat => ({ name: cat.name, tools: displayed.filter(t => t.category === cat.name) }))
    .filter(group => group.tools.length);
  // The first tool shown is open until another is chosen.
  const shownTool = displayed.some(t => t.name === selectedTool) ? selectedTool : displayed[0]?.name ?? null;
  const activeTool = shownTool ? allTools.find(t => t.name === shownTool) : null;

  const chooseCategory = name => {
    setSelectedCat(name);
    setSelectedTool(null);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        {/* Category filter: scrolls sideways when the options don't fit */}
        <div role="group" aria-label="Filter by category" className="flex gap-1 p-1 rounded-lg bg-[#0f1724] border border-white/[0.06] overflow-x-auto self-start max-w-full select-none">
          <CategoryChip selected={!selectedCat} count={allTools.length} onClick={() => chooseCategory(null)}>All</CategoryChip>
          {categories.map(cat => (
            <CategoryChip key={cat.name} selected={selectedCat === cat.name} count={cat.tools.length} onClick={() => chooseCategory(cat.name)}>
              {cat.name}
            </CategoryChip>
          ))}
        </div>

        <div className={`${CARD} overflow-hidden flex flex-col lg:flex-row min-h-[580px]`}>
          {/* Tool list */}
          <div className={`w-full lg:w-[300px] border-b lg:border-b-0 lg:border-r ${DIVIDER} flex flex-col shrink-0`}>
            <div className={`p-3 border-b ${DIVIDER}`}>
              <label htmlFor="tools-search" className="sr-only">Search tools</label>
              <div className="relative flex items-center">
                <Icon name="search" className="text-[#8b95a7] absolute left-3 text-[18px] pointer-events-none" />
                <input
                  ref={searchRef}
                  id="tools-search"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Search tools"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Escape' && searchQuery) { e.preventDefault(); setSearchQuery(''); }
                  }}
                  className={`${FIELD} pl-10 pr-11`}
                />
                {searchQuery && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => { setSearchQuery(''); searchRef.current?.focus(); }}
                    className="size-9 absolute right-1 flex items-center justify-center text-[#8b95a7] hover:text-[#dae3f4] hover:bg-[#222a37] rounded-md transition-colors"
                  >
                    <Icon name="close" className="text-[18px]" />
                  </button>
                )}
              </div>
              <p className="sr-only" aria-live="polite">
                {q ? `${displayed.length} ${displayed.length === 1 ? 'tool matches' : 'tools match'}` : ''}
              </p>
            </div>

            {/* Beside the details the list fills the pane's height and scrolls */}
            <div className="relative flex-1 min-h-0">
              <div className="overflow-y-auto p-3 space-y-4 max-h-[520px] lg:max-h-none lg:absolute lg:inset-0">
                {groups.map((group, i) => {
                  const labelId = `tools-group-${i}`;
                  const holdsSelected = group.tools.some(t => t.name === shownTool);
                  return (
                    <div key={group.name}>
                      <div id={labelId} className={`px-3 py-1.5 text-[12px] leading-4 ${holdsSelected ? 'text-[#dae3f4]' : 'text-[#c9b8a5]'}`}>
                        {group.name} ({group.tools.length})
                      </div>
                      <ul aria-labelledby={labelId} className="flex flex-col gap-0.5 mt-1">
                        {group.tools.map(tool => {
                          const on = tool.name === shownTool;
                          const where = tool.needsExtension ? 'Chrome' : 'Desktop';
                          return (
                            <li key={tool.name} className="flex flex-col">
                              <button
                                type="button"
                                onClick={() => setSelectedTool(tool.name)}
                                aria-current={on ? 'true' : undefined}
                                className={`min-h-[44px] px-3 rounded-lg font-mono text-[13px] flex items-center justify-between gap-2 text-left transition-colors ${on
                                  ? 'bg-[#18202d] text-[#ffc880] font-medium'
                                  : 'text-[#dae3f4] hover:bg-[#18202d]'}`}
                              >
                                <span className="truncate">{tool.name}</span>
                                <span className="sr-only">
                                  , {tool.needsExtension ? 'needs the Chrome extension' : 'works without the Chrome extension'}
                                </span>
                                <span className="text-[12px] font-sans font-normal text-[#8b95a7] shrink-0" aria-hidden="true">{where}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
                {displayed.length === 0 && (
                  <p className="px-3 py-6 text-[13px] leading-5 text-[#8b95a7]">
                    {isLoading ? 'Loading tools…'
                      : isError ? "Couldn't load the tools. Check the AbleSpeak server is running, then reload."
                      : allTools.length === 0 ? 'No tools are registered.'
                      : 'No tools match your filter.'}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Tool detail */}
          <section aria-label="Tool details" className="flex-1 min-w-0 p-5 lg:p-6 flex flex-col">
            {activeTool ? (
              <ToolDetail key={activeTool.name} tool={activeTool} />
            ) : (
              <div className="flex-1 flex items-center justify-center text-center">
                <p className="text-[13px] leading-5 text-[#8b95a7]">Choose a tool to see what it does.</p>
              </div>
            )}
          </section>
        </div>
      </div>

      {/* The newest lines of the Logs tab, live */}
      <section aria-labelledby="logs-preview-heading">
        <LogPanel preview headingId="logs-preview-heading" />
      </section>
    </div>
  );
}

function ToolDetail({ tool }) {
  const [copyState, setCopyState] = useState(null); // 'copied' | 'failed'
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.getStatus, refetchInterval: 5000 });
  const { data: ai } = useQuery({ queryKey: ['aiStatus'], queryFn: api.getAiStatus, refetchInterval: 10000 });
  useEffect(() => {
    if (!copyState) return undefined;
    const timer = setTimeout(() => setCopyState(null), 1600);
    return () => clearTimeout(timer);
  }, [copyState]);

  const schema = tool.jsonSchema || { name: tool.name };
  const schemaText = JSON.stringify(schema, null, 2);
  const description = tool.description || schema.description || '';
  const params = Object.entries(schema.parameters?.properties || {});
  const required = schema.parameters?.required || [];
  const safety = safetyRule(tool.name);

  const copySchema = async () => {
    try {
      await navigator.clipboard.writeText(schemaText);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  const extTone = tool.needsExtension ? 'warn' : 'ok';

  return (
    <div className="flex-1 flex flex-col justify-between gap-6">
      <div className="flex flex-col gap-6">
        {/* Name, category, what it needs */}
        <div className={`flex items-start justify-between flex-wrap gap-4 pb-4 border-b ${DIVIDER}`}>
          <div className="min-w-0 flex flex-col gap-1">
            <div className="flex items-baseline gap-2 flex-wrap">
              <h2 className="font-mono text-[15px] leading-6 font-semibold text-[#dae3f4] break-all">{tool.name}</h2>
              <span className={MUTED}>{tool.category}</span>
            </div>
            <div className="flex items-center gap-x-2 gap-y-1 flex-wrap text-[13px] leading-5">
              <span className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full shrink-0 ${DOT[extTone]}`} aria-hidden="true" />
                <span className={INK[extTone]}>{tool.needsExtension ? 'Needs the Chrome extension' : 'Works without the Chrome extension'}</span>
              </span>
              {status?.version && (
                <>
                  <span className="text-[#4a5466]" aria-hidden="true">·</span>
                  <span className="text-[#c9b8a5]">v{status.version} Gateway</span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Tools run from what the student says; the Test console is where to try one */}
            <Link to="/test" className={QUIET}>
              <Icon name="play_arrow" className="text-[18px] text-[#c9b8a5]" />
              <span>Try in Test console</span>
            </Link>
            <button type="button" onClick={copySchema} className={QUIET}>
              <Icon name={copyState === 'copied' ? 'check' : 'content_copy'} className={`text-[18px] ${copyState === 'copied' ? INK.ok : 'text-[#c9b8a5]'}`} />
              <span>{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? "Couldn't copy" : 'Copy schema'}</span>
            </button>
            <span className="sr-only" role="status">
              {copyState === 'copied' ? 'Schema copied' : copyState === 'failed' ? "Couldn't copy the schema" : ''}
            </span>
          </div>
        </div>

        {/* Section: Description */}
        {description && (
          <div className="flex flex-col gap-2">
            <h3 className={SECTION}>Description</h3>
            <p className={`${BODY} ${WELL} p-4`}>
              <DescriptionText text={description} params={params.map(([name]) => name)} />
            </p>
          </div>
        )}

        {/* Section: Parameters */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className={SECTION}>Parameters</h3>
            <span className={`${MUTED} tabular-nums`}>
              {params.length === 0 ? 'No arguments' : `${params.length} argument ${params.length === 1 ? 'definition' : 'definitions'}`}
            </span>
          </div>
          {params.length === 0 ? (
            <p className={`${WELL} p-4 text-[13px] leading-5 text-[#8b95a7]`}>This tool takes no arguments.</p>
          ) : (
            <ul className={`${WELL} divide-y divide-white/[0.06]`}>
              {params.map(([name, prop]) => {
                const isRequired = required.includes(name);
                const hasDefault = prop && Object.prototype.hasOwnProperty.call(prop, 'default');
                return (
                  <li key={name} className="px-4 py-3 flex flex-col sm:flex-row sm:items-start justify-between gap-2 sm:gap-4">
                    <div className="flex flex-col gap-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-[13px] font-medium text-[#dae3f4] break-all">{name}</span>
                        <span className="text-[#4a5466]" aria-hidden="true">·</span>
                        <span className="font-mono text-[12px] text-[#8fd3c4]">{typeLabel(prop)}</span>
                        <span className="text-[#4a5466]" aria-hidden="true">·</span>
                        {isRequired ? (
                          <span className="text-[12px] text-[#ffc880]">required</span>
                        ) : (
                          <span className="text-[12px] text-[#c9b8a5]">optional</span>
                        )}
                      </div>
                      {prop?.description && <p className="text-[13px] leading-5 text-[#c9b8a5]">{prop.description}</p>}
                      {Array.isArray(prop?.enum) && prop.enum.length > 0 && (
                        <p className="text-[13px] leading-5 text-[#c9b8a5]">
                          One of:{' '}
                          {prop.enum.map((v, i) => (
                            <span key={String(v)}>
                              {i > 0 && ', '}
                              <code className="font-mono text-[12px] text-[#dae3f4]">{String(v)}</code>
                            </span>
                          ))}
                        </p>
                      )}
                    </div>
                    <div className="text-[12px] leading-5 text-[#8b95a7] shrink-0">
                      Default: <span className="font-mono text-[#c9b8a5]">{hasDefault ? JSON.stringify(prop.default) : 'none'}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Section: Function schema */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className={SECTION}>Function schema</h3>
            {ai?.providerName && (
              <span className={`text-[13px] leading-5 flex items-center gap-1.5 ${INK.ok}`}>
                <span className={`w-2 h-2 rounded-full ${DOT.ok}`} aria-hidden="true" />
                Sent to {ai.providerName}
              </span>
            )}
          </div>
          <div className="bg-[#0f1724] border border-white/[0.06] rounded-lg p-4 overflow-x-auto" tabIndex={0} aria-label={`Function schema for ${tool.name}`}>
            <pre className="font-mono text-[12px] leading-5 text-[#dae3f4]"><code className="block"><JsonText text={schemaText} /></code></pre>
          </div>
        </div>
      </div>

      {/* Where the tool comes from, and when it asks first */}
      <div className={`pt-4 border-t ${DIVIDER} flex flex-col gap-2 text-[12px] leading-5 text-[#c9b8a5]`}>
        <div className="flex items-center justify-between flex-wrap gap-x-4 gap-y-1">
          <span>Registered in: <code className="font-mono text-[#dae3f4]">server/src/tool-registry.js</code></span>
          <span>Safety: <strong className="font-normal text-[#dae3f4]">{safety.short}</strong></span>
        </div>
        {safety.note && <p className="text-[13px] text-[#c9b8a5]">{safety.note}</p>}
      </div>
      <p className="sr-only" aria-live="polite">Showing {tool.name}</p>
    </div>
  );
}
