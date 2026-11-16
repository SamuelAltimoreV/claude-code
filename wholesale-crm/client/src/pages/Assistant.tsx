import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Database, Send, Sparkles } from 'lucide-react';
import { api, useBoot, type R } from '@/lib/app';
import { Card, Collapse, cx, PageHeader, Spinner } from '@/ui/core';

const EXAMPLES = ['Which lead sources generated the most revenue this quarter?', 'Which acquisition representative has the highest conversion rate?', 'Show me all high-motivation sellers who have not been contacted in seven days.', 'Which properties have the largest estimated assignment spreads?', 'Which deals are most likely to close this month?', 'Where are we losing the most leads in the pipeline?'];
interface Msg { role: 'user' | 'assistant'; content: string; trace?: R[]; error?: boolean }

/** Minimal markdown: paragraphs, bullet lists, bold and pipe tables. Text is rendered as text, never as HTML. */
function Rich({ text }: { text: string }) {
  const bold = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : p));
  const blocks = text.split(/\n{2,}/);
  return <div className="space-y-2.5 leading-relaxed">{blocks.map((b, i) => {
    const lines = b.split('\n').filter(Boolean);
    if (lines.length > 1 && lines.every(l => l.trim().startsWith('|'))) { const rows = lines.filter(l => !/^\s*\|[\s:|-]+\|\s*$/.test(l)).map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())); return <div key={i} className="overflow-x-auto"><table className="w-full border border-line rounded"><thead><tr>{rows[0].map((c, j) => <th key={j} className="th">{bold(c)}</th>)}</tr></thead><tbody>{rows.slice(1).map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k} className="td !whitespace-normal">{bold(c)}</td>)}</tr>)}</tbody></table></div>; }
    if (lines.every(l => /^\s*([-*]|\d+\.)\s/.test(l))) return <ul key={i} className="list-disc ml-5 space-y-1">{lines.map((l, j) => <li key={j}>{bold(l.replace(/^\s*([-*]|\d+\.)\s/, ''))}</li>)}</ul>;
    return <p key={i} className={cx(/^#+\s/.test(b) && 'font-semibold')}>{bold(b.replace(/^#+\s/, ''))}</p>;
  })}</div>;
}

export function Assistant() {
  const { providers } = useBoot();
  const [msgs, setMsgs] = useState<Msg[]>([]), [text, setText] = useState(''), [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const ask = async (q: string) => {
    if (!q.trim() || busy) return;
    const history = msgs.filter(m => !m.error).map(m => ({ role: m.role, content: m.content }));
    setMsgs(m => [...m, { role: 'user', content: q }]); setText(''); setBusy(true);
    setTimeout(() => end.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    try { const r = await api('POST', '/api/ai/ask', { question: q, history }); setMsgs(m => [...m, { role: 'assistant', content: r.answer || 'No answer was returned.', trace: r.trace }]); }
    catch (e: any) { setMsgs(m => [...m, { role: 'assistant', content: e.message ?? 'The request failed.', error: true }]); }
    finally { setBusy(false); setTimeout(() => end.current?.scrollIntoView({ behavior: 'smooth' }), 50); }
  };
  return (
    <div className="max-w-3xl mx-auto">
      <PageHeader title={<span className="inline-flex items-center gap-2"><Sparkles size={18} />AI business analyst</span>} subtitle="Ask questions about your pipeline, revenue, team and buyers. Answers are computed from your CRM records, with the queries shown." />
      {!providers.ai ? (
        <Card><div className="font-semibold">The AI assistant is not connected</div>
          <p className="text-fg-2 mt-1 leading-relaxed">This feature uses Claude through the Anthropic API. Set <code className="text-xs px-1 py-0.5 rounded bg-surface-2 border border-line">ANTHROPIC_API_KEY</code> on the server and restart, then use the connection test under <Link className="link" to="/integrations">Integrations</Link>. Until then nothing here will generate an answer — the dashboards and Analytics reports cover the same data without AI.</p>
          <div className="mt-4 section-t mb-2">Questions it will answer once connected</div><ul className="space-y-1.5 text-fg-2">{EXAMPLES.map(e => <li key={e}>“{e}”</li>)}</ul>
          <p className="mt-4 text-[11px] text-fg-3 leading-relaxed">How it works: the model can only call two read-only tools — record lookup and the same metric calculations the dashboards use — limited to what your role is allowed to see. It cannot change data. Your question and the records needed to answer it are sent to Anthropic's API.</p></Card>
      ) : (
        <div className="card flex flex-col" style={{ minHeight: 'calc(100vh - 220px)' }}>
          <div className="flex-1 p-5 space-y-5 overflow-y-auto">
            {msgs.length === 0 && <div><p className="text-fg-2 mb-3">Try one of these:</p><div className="grid sm:grid-cols-2 gap-2">{EXAMPLES.map(e => <button key={e} className="text-left p-3 rounded-lg border border-line hover:border-line-strong hover:bg-surface-2" onClick={() => ask(e)}>{e}</button>)}</div></div>}
            {msgs.map((m, i) => m.role === 'user' ? <div key={i} className="flex justify-end"><div className="max-w-[85%] px-3.5 py-2 rounded-2xl rounded-br-md bg-accent-soft">{m.content}</div></div> : (
              <div key={i} className={cx('max-w-full', m.error && 'text-t-red')}><Rich text={m.content} />
                {m.trace && m.trace.length > 0 && <div className="mt-2.5"><Collapse title={<span className="inline-flex items-center gap-1.5"><Database size={12} />How this was calculated</span>} count={m.trace.length}><ol className="space-y-1.5 text-xs text-fg-2 border border-line rounded-md p-2.5">{m.trace.map((t, j) => <li key={j}><b>{t.tool === 'list_records' ? `Looked up ${t.input.entity}` : `Computed ${t.input.report} report`}</b>{t.rows !== undefined && ` — ${t.rows} matching record(s)`}{t.input.filters?.length ? <span className="block text-fg-3">Filters: {t.input.filters.map((f: R) => `${f.field} ${f.op} ${f.value ?? ''}`).join(', ')}</span> : null}{(t.input.from || t.input.to) && <span className="block text-fg-3">Dates: {t.input.from ?? 'start'} to {t.input.to ?? 'today'}</span>}</li>)}</ol></Collapse></div>}</div>))}
            {busy && <div className="flex items-center gap-2 text-fg-3"><Spinner />Querying your records…</div>}
            <div ref={end} />
          </div>
          <form className="p-3 border-t border-line flex gap-2" onSubmit={e => { e.preventDefault(); void ask(text); }}>
            <input className="input" placeholder="Ask about your leads, deals, revenue or team…" value={text} onChange={e => setText(e.target.value)} aria-label="Question" /><button className="btn btn-primary" disabled={busy || !text.trim()}><Send size={14} />Ask</button>
          </form>
          <p className="px-4 pb-3 text-[11px] text-fg-3">Read-only. AI answers can be wrong — check the calculation steps and the linked reports before acting on them.</p>
        </div>
      )}
    </div>
  );
}
