/**
 * A web answer's sources and Google's Search Suggestions
 * (server/src/web-answer.js), shown with the answer: Google's terms for
 * answers grounded in Google Search ask for both. Google's chip is its own
 * HTML, so it sits in a sandboxed frame; its links open in the browser.
 */
import { LABEL } from '../lib/ui';

/** The successful web answer among a reply's tool calls, or null. */
export function webAnswerOf(calls = []) {
  return calls.find(c => (c.tool || c.name) === 'web_answer' && c.result?.status === 'success')?.result || null;
}

export default function WebSources({ result }) {
  if (!result || (!result.sources?.length && !result.suggestions?.html)) return null;
  return (
    <div className="flex flex-col gap-2 mb-2.5">
      {result.sources?.length > 0 && (
        <p className={LABEL}>
          From a Google search · Sources:{' '}
          {result.sources.map((source, i) => (
            <span key={source.url}>
              {i > 0 && ', '}
              <a href={source.url} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-[var(--ink)]">{source.title}</a>
            </span>
          ))}
        </p>
      )}
      {result.suggestions?.html && (
        <iframe
          title="Google Search suggestions"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          srcDoc={`<!doctype html><base target="_blank"><body style="margin:0">${result.suggestions.html}</body>`}
          className="w-full h-[52px] border-0 rounded-md"
        />
      )}
    </div>
  );
}
