import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Bell, Building2, Calculator, CalendarCheck, CheckSquare, FileSignature, FileText, HandCoins, Home, KanbanSquare, LayoutDashboard, LogOut, Megaphone, Menu as MenuIcon, MessageSquare, Moon, Phone, Plug, Plus, Search, Settings as SettingsIcon, Sparkles, Sun, Target, UserPlus, Users, UsersRound, Workflow, X } from 'lucide-react';
import { api, ApiError, BootProvider, useBoot, useBootQuery, useData, usePerms, useWrite, type R } from '@/lib/app';
import { ago, configureFormats } from '@/lib/format';
import { Avatar, cx, DialogHost, Empty, ErrorBox, Field, Menu, Modal, Spinner, toast, Toaster } from '@/ui/core';
import { ActionHost, newTask, openAction } from '@/ui/actions';
import Dashboard from '@/pages/Dashboard';
import { LeadsPage, LeadDetail } from '@/pages/Leads';
import { PropertiesPage, PropertyDetail } from '@/pages/Properties';
import Pipeline from '@/pages/Pipeline';
import Analyzer from '@/pages/Analyzer';
import { OffersPage, ContractsPage, TransactionsPage } from '@/pages/Deals';
import { BuyersPage, BuyerDetail, DispositionsPage, DispositionDetail } from '@/pages/Dispo';
import { CommunicationsPage, TasksPage } from '@/pages/Work';
import Marketing from '@/pages/Marketing';
import Automations from '@/pages/Automations';
import Analytics from '@/pages/Analytics';
import { TeamPage, IntegrationsPage } from '@/pages/Admin';
import SettingsPage from '@/pages/Settings';
import { Assistant } from '@/pages/Assistant';

const qc = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: true, retry: (n, e) => !(e instanceof ApiError && [401, 403, 404].includes(e.status)) && n < 2 } } });

interface NavItem { to: string; label: string; icon: any; res?: string }
const NAV: { group: string; items: NavItem[] }[] = [
  { group: '', items: [{ to: '/', label: 'Overview', icon: LayoutDashboard }] },
  { group: 'Acquisitions', items: [{ to: '/leads', label: 'Leads', icon: Users, res: 'leads' }, { to: '/properties', label: 'Properties', icon: Home, res: 'properties' }, { to: '/pipeline', label: 'Acquisition Pipeline', icon: KanbanSquare, res: 'leads' }, { to: '/analyzer', label: 'Deal Analyzer', icon: Calculator, res: 'offers' }, { to: '/offers', label: 'Offers', icon: HandCoins, res: 'offers' }] },
  { group: 'Deals', items: [{ to: '/contracts', label: 'Contracts', icon: FileSignature, res: 'contracts' }, { to: '/buyers', label: 'Buyers', icon: Building2, res: 'buyers' }, { to: '/dispositions', label: 'Dispositions', icon: Megaphone, res: 'dispositions' }, { to: '/transactions', label: 'Transactions', icon: FileText, res: 'transactions' }] },
  { group: 'Work', items: [{ to: '/communications', label: 'Communications', icon: MessageSquare, res: 'communications' }, { to: '/tasks', label: 'Tasks & Calendar', icon: CalendarCheck, res: 'tasks' }] },
  { group: 'Growth', items: [{ to: '/marketing', label: 'Marketing', icon: Target, res: 'marketing' }, { to: '/automations', label: 'Automations', icon: Workflow, res: 'automations' }, { to: '/analytics', label: 'Analytics & Reports', icon: BarChart3, res: 'analytics' }] },
  { group: 'Admin', items: [{ to: '/team', label: 'Team', icon: UsersRound, res: 'team' }, { to: '/integrations', label: 'Integrations', icon: Plug, res: 'integrations' }, { to: '/settings', label: 'Settings', icon: SettingsIcon, res: 'settings' }] },
];

function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'light');
  const toggle = () => { const t = theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; try { localStorage.setItem('theme', t); } catch { /* storage unavailable */ } setTheme(t); };
  return { theme, toggle };
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { org, settings } = useBoot();
  const perms = usePerms();
  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={onClose} />}
      <aside className={cx('fixed lg:static z-40 inset-y-0 left-0 w-[224px] shrink-0 bg-surface border-r border-line flex flex-col transition-transform lg:translate-x-0', open ? 'translate-x-0' : '-translate-x-full')}>
        <div className="h-12 px-3.5 flex items-center gap-2.5 border-b border-line shrink-0">
          <span className="w-6 h-6 rounded-md flex items-center justify-center text-white" style={{ background: 'var(--brand)' }}><Home size={13} strokeWidth={2.5} /></span>
          <span className="font-semibold truncate">{settings.company.name || org.name}</span>
        </div>
        <nav className="flex-1 overflow-y-auto scroll-thin px-2 py-2" aria-label="Main">
          {NAV.map(g => { const items = g.items.filter(i => !i.res || perms.read(i.res)); if (!items.length) return null; return (
            <div key={g.group} className="mb-3">{g.group && <div className="px-2 mb-1 section-t">{g.group}</div>}
              {items.map(i => <NavLink key={i.to} to={i.to} end={i.to === '/'} onClick={onClose} className={({ isActive }) => cx('flex items-center gap-2.5 h-[30px] px-2 rounded-md text-[13px] transition-colors', isActive ? 'bg-surface-2 text-fg font-medium' : 'text-fg-2 hover:bg-surface-2 hover:text-fg')}><i.icon size={15} strokeWidth={1.75} className="shrink-0" /><span className="truncate">{i.label}</span></NavLink>)}
            </div>); })}
        </nav>
      </aside>
    </>
  );
}

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate(), perms = usePerms();
  const [text, setText] = useState(''), [idx, setIdx] = useState(0);
  useEffect(() => { if (open) { setText(''); setIdx(0); } }, [open]);
  const { data: results = [], isFetching } = useQuery({ queryKey: ['x', 'search', text], queryFn: () => api<R[]>('GET', `/api/search?q=${encodeURIComponent(text)}`), enabled: open && text.trim().length >= 2, staleTime: 5000 });
  const items = useMemo(() => {
    const go = (to: string) => () => nav(to);
    const actions: { label: string; sub: string; icon: any; run: () => void; show?: boolean }[] = [
      { label: 'Add a new lead', sub: 'Quick action', icon: UserPlus, run: () => openAction({ type: 'lead' }), show: perms.write('leads') },
      { label: 'Add a property', sub: 'Quick action', icon: Home, run: () => openAction({ type: 'record', entity: 'properties' }), show: perms.write('properties') },
      { label: 'Calculate an offer', sub: 'Quick action', icon: Calculator, run: go('/analyzer'), show: perms.read('offers') },
      { label: 'Create a deal (offer)', sub: 'Quick action', icon: HandCoins, run: () => openAction({ type: 'record', entity: 'offers', exclude: ['parent_id', 'analysis_id', 'contact_id'] }), show: perms.write('offers') },
      { label: 'Add a cash buyer', sub: 'Quick action', icon: Building2, run: () => openAction({ type: 'record', entity: 'buyers' }), show: perms.write('buyers') },
      { label: 'Create a task', sub: 'Quick action', icon: CheckSquare, run: () => newTask(), show: perms.write('tasks') },
      { label: 'Log a call', sub: 'Quick action', icon: Phone, run: () => openAction({ type: 'call' }), show: perms.write('communications') },
      { label: 'Schedule a follow-up', sub: 'Quick action', icon: CalendarCheck, run: () => openAction({ type: 'record', entity: 'tasks', title: 'Schedule a follow-up', fields: ['lead_id', 'title', 'due_at', 'priority', 'assignee_id', 'description'], defaults: { title: 'Follow up with seller', category: 'Follow up', status: 'Open', priority: 'Normal', due_at: new Date(Date.now() + 2 * 864e5).toISOString() } }), show: perms.write('tasks') },
      { label: 'Ask the AI analyst', sub: 'Quick action', icon: Sparkles, run: go('/assistant'), show: perms.read('analytics') },
      ...NAV.flatMap(g => g.items).filter(i => !i.res || perms.read(i.res)).map(i => ({ label: i.label, sub: 'Go to', icon: i.icon, run: go(i.to) })),
    ].filter(a => (a as any).show !== false);
    const t = text.trim().toLowerCase();
    const ICONS: Record<string, any> = { contacts: Users, properties: Home, buyers: Building2, transactions: FileText, contracts: FileSignature, tasks: CheckSquare, activities: MessageSquare };
    return [...(t ? actions.filter(a => a.label.toLowerCase().includes(t)) : actions), ...results.map(r => ({ label: r.label, sub: `${r.entity === 'contacts' ? 'Seller' : r.entity === 'activities' ? 'Note / activity' : r.entity.replace(/s$/, '')}${r.sub ? ` · ${r.sub}` : ''}`, icon: ICONS[r.entity] ?? Search, run: go(r.link) }))];
  }, [text, results, perms, nav]);
  useEffect(() => { setIdx(0); }, [text, results.length]);
  if (!open) return null;
  const run = (i: number) => { const it = items[i]; if (it) { onClose(); it.run(); } };
  return (
    <div className="fixed inset-0 z-[60] bg-black/40 anim-fade flex items-start justify-center pt-[12vh] px-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card w-full max-w-xl shadow-[var(--shadow-lg)] anim-pop overflow-hidden" role="dialog" aria-label="Search and quick actions">
        <div className="flex items-center gap-2.5 px-4 h-12 border-b border-line"><Search size={16} className="text-fg-3" />
          <input autoFocus className="flex-1 bg-transparent outline-none text-sm" placeholder="Search sellers, properties, buyers, deals, notes… or run an action" value={text} onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, items.length - 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); } else if (e.key === 'Enter') run(idx); else if (e.key === 'Escape') onClose(); }} />
          {isFetching && <Spinner />}<span className="kbd">esc</span></div>
        <div className="max-h-[52vh] overflow-y-auto scroll-thin py-1.5">
          {items.length === 0 ? <div className="px-4 py-8 text-center text-fg-3">{text.trim().length >= 2 && !isFetching ? `Nothing found for "${text}"` : 'Type at least 2 characters to search records'}</div>
            : items.map((it, i) => <button key={i} onMouseEnter={() => setIdx(i)} onClick={() => run(i)} className={cx('w-full flex items-center gap-3 px-4 h-9 text-left', i === idx && 'bg-surface-2')}><it.icon size={15} className="text-fg-3 shrink-0" /><span className="truncate">{it.label}</span><span className="ml-auto text-xs text-fg-3 truncate max-w-[45%]">{it.sub}</span></button>)}
        </div>
      </div>
    </div>
  );
}

function Notifications() {
  const { notifications } = useData('notifications');
  const w = useWrite(), nav = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) return; const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, [open]);
  const unread = notifications.filter(n => !n.read).length;
  return (
    <div className="relative" ref={ref}>
      <button className="btn btn-ghost btn-icon relative" aria-label={`Notifications (${unread} unread)`} onClick={() => setOpen(o => !o)}><Bell size={15} />{unread > 0 && <span className="absolute top-1 right-1 min-w-[14px] h-[14px] px-0.5 rounded-full bg-critical text-white text-[9px] font-bold flex items-center justify-center">{unread > 9 ? '9+' : unread}</span>}</button>
      {open && <div className="absolute right-0 top-full mt-1 z-30 w-[340px] max-w-[92vw] card shadow-[var(--shadow)] anim-pop">
        <div className="card-h"><span className="card-t">Notifications</span>{unread > 0 && <button className="btn btn-ghost btn-sm" onClick={() => w.post('/api/notifications/read-all').catch(toast.error)}>Mark all read</button>}</div>
        <div className="max-h-[60vh] overflow-y-auto scroll-thin">
          {notifications.length === 0 ? <Empty icon={<Bell size={18} />} title="You're all caught up" body="Assignments, reminders, deadlines and automation alerts show up here." />
            : notifications.slice(0, 40).map(n => <button key={n.id} className="w-full text-left px-4 py-2.5 border-b border-line hover:bg-surface-2 flex gap-2.5" onClick={() => { setOpen(false); if (!n.read) w.patch('notifications', n.id, { read: true }).catch(() => {}); if (n.link) nav(n.link); }}>
              <span className={cx('mt-1.5 w-1.5 h-1.5 rounded-full shrink-0', n.read ? 'bg-transparent' : 'bg-accent')} /><span className="min-w-0 flex-1"><span className="block font-medium truncate">{n.title}</span><span className="block text-fg-2 line-clamp-2">{n.body}</span><span className="block text-[11px] text-fg-3 mt-0.5">{ago(n.created_at)}</span></span></button>)}
        </div>
      </div>}
    </div>
  );
}

function ProfileModal({ onClose }: { onClose: () => void }) {
  const { user } = useBoot();
  const w = useWrite();
  const [name, setName] = useState(user.name), [cur, setCur] = useState(''), [next, setNext] = useState(''), [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { if (name.trim() && name !== user.name) { await w.call('PATCH', `/api/users/${user.id}`, { name }); await w.refreshBoot(); } if (next) { await w.post('/api/auth/password', { current: cur, next }); } toast.success('Profile updated'); onClose(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  return <Modal open onClose={onClose} size="sm" title="Your profile" footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={save}>{busy && <Spinner />}Save</button></>}>
    <div className="space-y-3"><Field label="Name"><input className="input" value={name} onChange={e => setName(e.target.value)} /></Field><Field label="Email"><input className="input" value={user.email} disabled /></Field><Field label="Role"><input className="input" value={user.role} disabled /></Field>
      <div className="pt-2 border-t border-line section-t">Change password</div><Field label="Current password"><input type="password" className="input" autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} /></Field><Field label="New password" help="At least 10 characters"><input type="password" className="input" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} /></Field></div>
  </Modal>;
}

function Shell() {
  const boot = useBoot();
  const perms = usePerms(), nav = useNavigate(), loc = useLocation(), qcl = useQueryClient();
  const { theme, toggle } = useTheme();
  const [side, setSide] = useState(false), [palette, setPalette] = useState(false), [profile, setProfile] = useState(false);
  useEffect(() => { const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(p => !p); } }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, []);
  useEffect(() => { document.querySelector('main')?.scrollTo(0, 0); }, [loc.pathname]);
  const logout = async () => { await api('POST', '/api/auth/logout').catch(() => {}); qcl.clear(); window.location.href = '/login'; };
  const quick = [
    perms.write('leads') && { label: 'New lead', icon: <UserPlus size={14} />, onClick: () => openAction({ type: 'lead' }) },
    perms.write('properties') && { label: 'New property', icon: <Home size={14} />, onClick: () => openAction({ type: 'record', entity: 'properties' }) },
    perms.write('offers') && { label: 'New offer / deal', icon: <HandCoins size={14} />, onClick: () => openAction({ type: 'record', entity: 'offers', exclude: ['parent_id', 'analysis_id', 'contact_id'] }) },
    perms.read('offers') && { label: 'Calculate an offer', icon: <Calculator size={14} />, onClick: () => nav('/analyzer') },
    perms.write('buyers') && { label: 'New cash buyer', icon: <Building2 size={14} />, onClick: () => openAction({ type: 'record', entity: 'buyers' }) },
    perms.write('tasks') && { label: 'New task', icon: <CheckSquare size={14} />, onClick: () => newTask() },
    perms.write('communications') && { label: 'Log a call', icon: <Phone size={14} />, onClick: () => openAction({ type: 'call' }) },
    perms.write('tasks') && { label: 'Schedule a follow-up', icon: <CalendarCheck size={14} />, onClick: () => openAction({ type: 'record', entity: 'tasks', title: 'Schedule a follow-up', fields: ['lead_id', 'title', 'due_at', 'priority', 'assignee_id', 'description'], defaults: { title: 'Follow up with seller', category: 'Follow up', status: 'Open', priority: 'Normal', due_at: new Date(Date.now() + 2 * 864e5).toISOString() } }) },
  ].filter(Boolean) as any[];
  return (
    <div className="h-full flex">
      <Sidebar open={side} onClose={() => setSide(false)} />
      <div className="flex-1 min-w-0 flex flex-col">
        {boot.demoCount > 0 && <div className="no-print h-7 shrink-0 flex items-center justify-center gap-2 text-[11px] font-medium border-b border-dashed border-line-strong bg-surface-2 text-fg-2 px-3"><span className="font-bold tracking-wider whitespace-nowrap">DEMO DATA</span><span className="truncate">This workspace contains fictional sample records.</span>{perms.admin('settings') && <Link to="/settings?tab=data" className="link whitespace-nowrap">Remove demo data</Link>}</div>}
        <header className="h-12 shrink-0 bg-surface border-b border-line flex items-center gap-2 px-3">
          <button className="btn btn-ghost btn-icon lg:hidden" aria-label="Open menu" onClick={() => setSide(true)}><MenuIcon size={16} /></button>
          <button className="flex items-center gap-2 h-8 px-2.5 rounded-md border border-line bg-surface-2 text-fg-3 hover:border-line-strong w-full max-w-sm text-left" onClick={() => setPalette(true)}><Search size={14} /><span className="flex-1 truncate">Search or jump to…</span><span className="kbd hidden sm:inline-flex">⌘K</span></button>
          <div className="flex-1" />
          {perms.read('analytics') && <button className="btn btn-ghost hidden md:inline-flex" onClick={() => nav('/assistant')}><Sparkles size={14} />Ask AI</button>}
          {quick.length > 0 && <Menu width={210} trigger={<button className="btn btn-primary"><Plus size={14} /><span className="hidden sm:inline">New</span></button>} items={quick} />}
          <Notifications />
          <button className="btn btn-ghost btn-icon" aria-label="Toggle dark mode" onClick={toggle}>{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}</button>
          <Menu width={220} trigger={<button className="flex items-center" aria-label="Account menu"><Avatar name={boot.user.name} size={28} /></button>} items={[{ label: `${boot.user.name} · ${boot.user.role}`, disabled: true }, { label: 'Profile & password', onClick: () => setProfile(true) }, { label: '', divider: true }, { label: 'Sign out', icon: <LogOut size={14} />, onClick: logout }]} />
        </header>
        <main className="flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto max-w-[1440px] p-4 sm:p-6">
            <PageBoundary at={loc.pathname}><Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/leads" element={<Guard res="leads"><LeadsPage /></Guard>} /><Route path="/leads/:id" element={<Guard res="leads"><LeadDetail /></Guard>} />
              <Route path="/properties" element={<Guard res="properties"><PropertiesPage /></Guard>} /><Route path="/properties/:id" element={<Guard res="properties"><PropertyDetail /></Guard>} />
              <Route path="/pipeline" element={<Guard res="leads"><Pipeline /></Guard>} />
              <Route path="/analyzer" element={<Guard res="offers"><Analyzer /></Guard>} />
              <Route path="/offers" element={<Guard res="offers"><OffersPage /></Guard>} />
              <Route path="/contracts" element={<Guard res="contracts"><ContractsPage /></Guard>} />
              <Route path="/transactions" element={<Guard res="transactions"><TransactionsPage /></Guard>} />
              <Route path="/buyers" element={<Guard res="buyers"><BuyersPage /></Guard>} /><Route path="/buyers/:id" element={<Guard res="buyers"><BuyerDetail /></Guard>} />
              <Route path="/dispositions" element={<Guard res="dispositions"><DispositionsPage /></Guard>} /><Route path="/dispositions/:id" element={<Guard res="dispositions"><DispositionDetail /></Guard>} />
              <Route path="/communications" element={<Guard res="communications"><CommunicationsPage /></Guard>} />
              <Route path="/tasks" element={<Guard res="tasks"><TasksPage /></Guard>} />
              <Route path="/marketing" element={<Guard res="marketing"><Marketing /></Guard>} />
              <Route path="/automations" element={<Guard res="automations"><Automations /></Guard>} />
              <Route path="/analytics" element={<Guard res="analytics"><Analytics /></Guard>} />
              <Route path="/assistant" element={<Guard res="analytics"><Assistant /></Guard>} />
              <Route path="/team" element={<Guard res="team"><TeamPage /></Guard>} />
              <Route path="/integrations" element={<Guard res="integrations"><IntegrationsPage /></Guard>} />
              <Route path="/settings" element={<Guard res="settings"><SettingsPage /></Guard>} />
              <Route path="*" element={<Empty title="Page not found" body="That page does not exist." action={<Link className="btn" to="/">Back to overview</Link>} />} />
            </Routes></PageBoundary>
          </div>
        </main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      {profile && <ProfileModal onClose={() => setProfile(false)} />}
      <ActionHost />
    </div>
  );
}
/** Keeps the shell usable if a page throws while rendering; resets when the route changes. */
class PageBoundary extends Component<{ at: string; children: ReactNode }, { error: Error | null; at: string }> {
  state = { error: null as Error | null, at: this.props.at };
  static getDerivedStateFromError(error: Error) { return { error }; }
  static getDerivedStateFromProps(p: { at: string }, s: { at: string }) { return p.at !== s.at ? { error: null, at: p.at } : null; }
  componentDidCatch(error: Error) { console.error(error); }
  render() { return this.state.error ? <Empty title="This page hit an unexpected error" body={<>Your data is safe. Try reloading the page; if it keeps happening, note what you clicked and this message: <code className="text-xs">{this.state.error.message}</code></>} action={<button className="btn" onClick={() => window.location.reload()}>Reload</button>} /> : this.props.children; }
}
function Guard({ res, children }: { res: string; children: ReactNode }) {
  const perms = usePerms();
  return perms.read(res) ? <>{children}</> : <Empty title="You do not have access to this section" body="Ask an owner or administrator to update your role's permissions in Settings → Roles." />;
}

// ---------- Auth screens ----------
function AuthFrame({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer?: ReactNode }) {
  return <div className="min-h-full flex items-center justify-center p-4"><div className="w-full max-w-sm">
    <div className="flex items-center gap-2.5 mb-6"><span className="w-8 h-8 rounded-lg flex items-center justify-center text-white" style={{ background: 'var(--accent)' }}><Home size={16} strokeWidth={2.5} /></span><span className="text-base font-semibold">Wholesale CRM</span></div>
    <h1 className="text-xl font-semibold tracking-tight">{title}</h1><p className="text-fg-2 mt-1 mb-5">{subtitle}</p>
    <div className="card p-5">{children}</div>{footer && <div className="mt-4 text-center text-fg-2">{footer}</div>}
  </div></div>;
}
function useAuthSubmit(path: string, payload: () => R) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setError(''); try { await api('POST', path, payload()); window.location.href = '/'; } catch (x) { setError(x instanceof Error ? x.message : 'Failed'); setBusy(false); } };
  return { busy, error, submit };
}
function Login() {
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const { busy, error, submit } = useAuthSubmit('/api/auth/login', () => ({ email, password }));
  return <AuthFrame title="Sign in" subtitle="Welcome back." footer={<>New here? <Link className="link" to="/signup">Create a workspace</Link></>}>
    <form onSubmit={submit} className="space-y-3"><Field label="Email"><input className="input" type="email" autoComplete="email" required autoFocus value={email} onChange={e => setEmail(e.target.value)} /></Field>
      <Field label="Password"><input className="input" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></Field>
      {error && <div className="text-t-red" role="alert">{error}</div>}<button className="btn btn-primary w-full" disabled={busy}>{busy && <Spinner />}Sign in</button></form></AuthFrame>;
}
function Signup() {
  const [f, setF] = useState({ company: '', name: '', email: '', password: '', demo: true });
  const { busy, error, submit } = useAuthSubmit('/api/auth/signup', () => f);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF(s => ({ ...s, [k]: e.target.value }));
  return <AuthFrame title="Create your workspace" subtitle="You will be the owner. Invite your team afterwards." footer={<>Already have an account? <Link className="link" to="/login">Sign in</Link></>}>
    <form onSubmit={submit} className="space-y-3"><Field label="Company name"><input className="input" required autoFocus value={f.company} onChange={set('company')} /></Field><Field label="Your name"><input className="input" required autoComplete="name" value={f.name} onChange={set('name')} /></Field>
      <Field label="Work email"><input className="input" type="email" required autoComplete="email" value={f.email} onChange={set('email')} /></Field><Field label="Password" help="At least 10 characters"><input className="input" type="password" required minLength={10} autoComplete="new-password" value={f.password} onChange={set('password')} /></Field>
      <label className="flex items-start gap-2 text-fg-2"><input type="checkbox" className="mt-0.5" checked={f.demo} onChange={e => setF(s => ({ ...s, demo: e.target.checked }))} /><span>Load Ohio demo data (25 leads, 15 buyers, sample deals). Clearly labeled and removable in one click.</span></label>
      {error && <div className="text-t-red" role="alert">{error}</div>}<button className="btn btn-primary w-full" disabled={busy}>{busy && <Spinner />}{busy ? 'Setting up your workspace…' : 'Create workspace'}</button></form></AuthFrame>;
}
function AcceptInvite() {
  const { token } = useParams();
  const { data, error: loadErr, isLoading } = useQuery({ queryKey: ['invite', token], queryFn: () => api<R>('GET', `/api/auth/invite/${token}`), retry: false });
  const [name, setName] = useState(''), [password, setPassword] = useState('');
  useEffect(() => { if (data) setName(data.name); }, [data]);
  const { busy, error, submit } = useAuthSubmit('/api/auth/accept-invite', () => ({ token, name, password }));
  if (isLoading) return <div className="p-10 flex justify-center"><Spinner size={20} /></div>;
  if (loadErr || !data) return <AuthFrame title="Invite not valid" subtitle="This invite link is invalid or has already been used."><Link className="btn w-full" to="/login">Go to sign in</Link></AuthFrame>;
  return <AuthFrame title={`Join ${data.company}`} subtitle={`You were invited as ${data.role}.`}>
    <form onSubmit={submit} className="space-y-3"><Field label="Email"><input className="input" value={data.email} disabled /></Field><Field label="Your name"><input className="input" required value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="Choose a password" help="At least 10 characters"><input className="input" type="password" required minLength={10} autoComplete="new-password" autoFocus value={password} onChange={e => setPassword(e.target.value)} /></Field>
      {error && <div className="text-t-red" role="alert">{error}</div>}<button className="btn btn-primary w-full" disabled={busy}>{busy && <Spinner />}Join workspace</button></form></AuthFrame>;
}

function Root() {
  const loc = useLocation();
  const publicRoute = /^\/(login|signup|accept-invite)/.test(loc.pathname);
  const boot = useBootQuery();
  useEffect(() => { if (boot.data) { configureFormats(boot.data.settings); if (/^#[0-9a-f]{6}$/i.test(boot.data.settings.company.brandColor ?? '')) document.documentElement.style.setProperty('--brand', boot.data.settings.company.brandColor); document.title = `${boot.data.settings.company.name || 'Wholesale CRM'} · CRM`; } }, [boot.data]);
  if (publicRoute) return <Routes><Route path="/login" element={<Login />} /><Route path="/signup" element={<Signup />} /><Route path="/accept-invite/:token" element={<AcceptInvite />} /></Routes>;
  if (boot.isLoading) return <div className="h-full flex items-center justify-center text-fg-3 gap-2"><Spinner size={18} />Loading workspace…</div>;
  if (boot.error) return boot.error instanceof ApiError && boot.error.status === 401 ? <Navigate to="/login" replace /> : <div className="h-full flex items-center justify-center"><ErrorBox error={boot.error} retry={() => boot.refetch()} /></div>;
  configureFormats(boot.data!.settings);
  return <BootProvider value={boot.data!}><Shell /></BootProvider>;
}

export default function App() {
  return <QueryClientProvider client={qc}><BrowserRouter><Root /><Toaster /><DialogHost /></BrowserRouter></QueryClientProvider>;
}
