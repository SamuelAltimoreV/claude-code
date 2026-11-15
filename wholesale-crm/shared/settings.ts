import type { CustomField, Role } from './schema';
import { ROLES } from './schema';

export type Milestone = 'lead' | 'contacted' | 'qualified' | 'offer' | 'contract' | 'closed' | 'dead';
export const MILESTONE_ORDER: Milestone[] = ['lead', 'contacted', 'qualified', 'offer', 'contract', 'closed'];

export interface Stage {
  id: string; name: string; color: string;
  /** Funnel milestone this stage represents; drives conversion metrics. */
  milestone: Milestone;
  /** Lead fields that must be filled before a lead can enter this stage. */
  requires?: string[];
  /** Stage ids a lead may move to from here. Empty/undefined = any. */
  allowedNext?: string[];
}

export type Access = 'none' | 'own' | 'all';
export interface Perm { read: Access; write: Access; delete: boolean }
export const RESOURCES = ['leads', 'properties', 'offers', 'contracts', 'buyers', 'dispositions', 'transactions', 'communications', 'tasks', 'marketing', 'finance', 'automations', 'analytics', 'team', 'integrations', 'settings'] as const;
export type Resource = typeof RESOURCES[number];
export const RESOURCE_LABELS: Record<Resource, string> = {
  leads: 'Leads & sellers', properties: 'Properties', offers: 'Offers & deal analysis', contracts: 'Contracts', buyers: 'Buyers', dispositions: 'Dispositions',
  transactions: 'Transactions', communications: 'Communications', tasks: 'Tasks', marketing: 'Marketing campaigns', finance: 'Revenue & expenses',
  automations: 'Automations & sequences', analytics: 'Analytics & reports', team: 'Team & audit log', integrations: 'Integrations', settings: 'Settings',
};

export interface ScoringConfig {
  weights: { motivation: number; timeline: number; equity: number; condition: number; price: number; engagement: number; negotiation: number; source: number; followup: number };
  sourceQuality: Record<string, number>; // 0..1
  hot: number; warm: number;
}

export interface AnalyzerConfig {
  maoPct: number; assignmentFee: number;
  buyerClosingPct: number; sellingCostPct: number; holdingMonthly: number; holdingMonths: number; investorMarginPct: number;
  thresholds: { excellentFee: number; potentialFee: number; marginalFee: number; minInvestorMarginPct: number };
  presets: { name: string; maoPct: number; note?: string }[];
}

export interface OrgSettings {
  company: { name: string; phone: string; email: string; address: string; website: string; brandColor: string; timezone: string };
  formats: { currency: string; dateFormat: 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' };
  stages: Stage[];
  leadStatuses: string[];
  sources: string[];
  tags: string[];
  buyerGroups: string[];
  taskCategories: string[];
  callOutcomes: string[];
  customFields: { leads: CustomField[]; properties: CustomField[]; buyers: CustomField[] };
  scoring: ScoringConfig;
  analyzer: AnalyzerConfig;
  permissions: Record<Role, Record<Resource, Perm>>;
  comms: { quietStart: number; quietEnd: number; requireSmsConsent: boolean; requireEmailConsent: boolean; emailFooter: string };
  notifications: { taskReminders: boolean; stageChanges: boolean; newLeadAssigned: boolean; contractDeadlines: boolean; deadlineDays: number };
  automation: { maxChainDepth: number; pauseAll: boolean };
  transactionChecklist: string[];
}

const P = (read: Access, write: Access, del = false): Perm => ({ read, write, delete: del });
const all = (): Record<Resource, Perm> => Object.fromEntries(RESOURCES.map(r => [r, P('all', 'all', true)])) as Record<Resource, Perm>;
const viewer = (): Record<Resource, Perm> => Object.fromEntries(RESOURCES.map(r => [r, P(['team', 'integrations', 'settings'].includes(r) ? 'none' : 'all', 'none')])) as Record<Resource, Perm>;
const withP = (base: Record<Resource, Perm>, over: Partial<Record<Resource, Perm>>) => ({ ...base, ...over });

export function defaultPermissions(): Record<Role, Record<Resource, Perm>> {
  const v = viewer;
  return {
    'Owner': all(),
    'Administrator': all(),
    'Acquisition Manager': withP(v(), {
      leads: P('all', 'all', true), properties: P('all', 'all', true), offers: P('all', 'all', true), contracts: P('all', 'all'),
      communications: P('all', 'all'), tasks: P('all', 'all', true), marketing: P('all', 'all'), automations: P('all', 'all'), team: P('all', 'none'),
    }),
    'Acquisition Representative': withP(v(), {
      leads: P('own', 'own'), properties: P('all', 'all'), offers: P('all', 'all'), contracts: P('all', 'none'), buyers: P('none', 'none'),
      dispositions: P('none', 'none'), communications: P('own', 'own'), tasks: P('own', 'own'), finance: P('none', 'none'), marketing: P('all', 'none'),
      automations: P('all', 'none'), analytics: P('none', 'none'),
    }),
    'Disposition Manager': withP(v(), {
      buyers: P('all', 'all', true), dispositions: P('all', 'all', true), contracts: P('all', 'all'), transactions: P('all', 'all'),
      communications: P('all', 'all'), tasks: P('all', 'all', true), properties: P('all', 'all'), team: P('all', 'none'),
    }),
    'Disposition Representative': withP(v(), {
      leads: P('none', 'none'), buyers: P('all', 'all'), dispositions: P('all', 'all'), communications: P('own', 'own'), tasks: P('own', 'own'),
      finance: P('none', 'none'), marketing: P('none', 'none'), analytics: P('none', 'none'), automations: P('all', 'none'),
    }),
    'Transaction Coordinator': withP(v(), {
      contracts: P('all', 'all'), transactions: P('all', 'all'), tasks: P('all', 'all'), communications: P('all', 'all'), properties: P('all', 'all'),
      marketing: P('none', 'none'), analytics: P('none', 'none'),
    }),
    'Viewer': v(),
  };
}

export const DEFAULT_STAGES: Stage[] = [
  { id: 'new', name: 'New Lead', color: '#64748b', milestone: 'lead' },
  { id: 'attempting', name: 'Attempting Contact', color: '#64748b', milestone: 'lead' },
  { id: 'contacted', name: 'Contacted', color: '#2a78d6', milestone: 'contacted' },
  { id: 'interested', name: 'Interested', color: '#2a78d6', milestone: 'contacted' },
  { id: 'qualified', name: 'Qualified', color: '#6250d6', milestone: 'qualified', requires: ['motivation'] },
  { id: 'appt_set', name: 'Appointment Scheduled', color: '#6250d6', milestone: 'qualified' },
  { id: 'appt_done', name: 'Appointment Completed', color: '#6250d6', milestone: 'qualified' },
  { id: 'underwriting', name: 'Underwriting', color: '#eda100', milestone: 'qualified', requires: ['property_id'] },
  { id: 'offer_prep', name: 'Offer Preparation', color: '#eda100', milestone: 'qualified', requires: ['property_id'] },
  { id: 'offer_presented', name: 'Offer Presented', color: '#eb6834', milestone: 'offer', requires: ['property_id'] },
  { id: 'negotiating', name: 'Negotiating', color: '#eb6834', milestone: 'offer' },
  { id: 'contract_sent', name: 'Contract Sent', color: '#eb6834', milestone: 'offer', requires: ['property_id'] },
  { id: 'under_contract', name: 'Under Contract', color: '#1baf7a', milestone: 'contract', requires: ['property_id'] },
  { id: 'disposition', name: 'Disposition', color: '#1baf7a', milestone: 'contract' },
  { id: 'closing', name: 'Closing', color: '#1baf7a', milestone: 'contract' },
  { id: 'closed_won', name: 'Closed Won', color: '#008300', milestone: 'closed' },
  { id: 'dead', name: 'Dead Lead', color: '#d03b3b', milestone: 'dead', requires: ['dead_reason'] },
];

export function defaultSettings(companyName = 'My Wholesaling Company'): OrgSettings {
  return {
    company: { name: companyName, phone: '', email: '', address: '', website: '', brandColor: '#3b5bdb', timezone: 'America/New_York' },
    formats: { currency: 'USD', dateFormat: 'MM/DD/YYYY' },
    stages: DEFAULT_STAGES,
    leadStatuses: ['High motivation', 'Medium motivation', 'Low motivation', 'Unqualified', 'Follow-up required', 'Do not contact', 'Under contract', 'Closed'],
    sources: ['Cold Calling', 'Direct Mail', 'Driving for Dollars', 'Facebook Ads', 'Google Ads', 'Website Form', 'Referral', 'Networking', 'Real Estate Agent', 'Wholesaler Referral', 'Probate List', 'Foreclosure List', 'Tax Delinquent List', 'Public Records', 'Other'],
    tags: ['Probate', 'Inherited property', 'Foreclosure', 'Pre-foreclosure', 'Tax delinquent', 'Vacant property', 'Absentee owner', 'Landlord fatigue', 'Code violations', 'Fire damage', 'Divorce'],
    buyerGroups: ['VIP Buyers', 'Stark County Flippers', 'Summit County Landlords'],
    taskCategories: ['Call seller', 'Send offer', 'Follow up', 'Underwrite property', 'Research comps', 'Contact buyer', 'Schedule appointment', 'Review contract', 'Coordinate closing', 'Other'],
    callOutcomes: ['No answer', 'Left voicemail', 'Interested', 'Not interested', 'Call back later', 'Negotiating', 'Appointment set', 'Wrong number', 'Do not contact'],
    customFields: { leads: [], properties: [], buyers: [] },
    scoring: {
      weights: { motivation: 25, timeline: 15, equity: 15, condition: 10, price: 10, engagement: 10, negotiation: 5, source: 5, followup: 5 },
      sourceQuality: { 'Referral': 1, 'Probate List': 0.9, 'Foreclosure List': 0.9, 'Tax Delinquent List': 0.8, 'Website Form': 0.8, 'Driving for Dollars': 0.7, 'Direct Mail': 0.7, 'Google Ads': 0.7, 'Facebook Ads': 0.5, 'Cold Calling': 0.5 },
      hot: 70, warm: 45,
    },
    analyzer: {
      maoPct: 70, assignmentFee: 10000, buyerClosingPct: 2, sellingCostPct: 7, holdingMonthly: 1200, holdingMonths: 4, investorMarginPct: 15,
      thresholds: { excellentFee: 15000, potentialFee: 8000, marginalFee: 3000, minInvestorMarginPct: 12 },
      presets: [
        { name: 'Standard (70%)', maoPct: 70 },
        { name: 'Hot market / light rehab (75%)', maoPct: 75, note: 'Competitive ZIPs where buyers accept thinner margins' },
        { name: 'Heavy rehab / higher risk (65%)', maoPct: 65, note: 'Major repairs, fire damage, slow-moving areas' },
        { name: 'Rental / landlord buyer (80%)', maoPct: 80, note: 'Turnkey-ish rentals sold to buy-and-hold investors' },
      ],
    },
    permissions: defaultPermissions(),
    comms: { quietStart: 8, quietEnd: 21, requireSmsConsent: true, requireEmailConsent: true, emailFooter: '' },
    notifications: { taskReminders: true, stageChanges: true, newLeadAssigned: true, contractDeadlines: true, deadlineDays: 3 },
    automation: { maxChainDepth: 4, pauseAll: false },
    transactionChecklist: [
      'Fully executed purchase agreement received', 'Earnest money deposited', 'Open title & order title search', 'Send contract to title company',
      'Confirm seller access for buyer walkthroughs', 'Assignment agreement signed by buyer', 'Buyer EMD / assignment deposit received',
      'Title clear & payoffs confirmed', 'Closing scheduled with all parties', 'Final walkthrough', 'Closing completed & fee received',
    ],
  };
}

/** Deep-merge stored settings over defaults so new keys appear for older orgs. */
export function mergeSettings(stored: any, companyName?: string): OrgSettings {
  const d: any = defaultSettings(companyName);
  const merge = (a: any, b: any): any => {
    if (b === undefined || b === null) return a;
    if (Array.isArray(a) || Array.isArray(b) || typeof a !== 'object' || typeof b !== 'object' || a === null) return b;
    const o: any = { ...a };
    for (const k of Object.keys(b)) o[k] = merge(a[k], b[k]);
    return o;
  };
  const s = merge(d, stored ?? {});
  for (const r of ROLES) s.permissions[r] = { ...d.permissions[r], ...(s.permissions[r] ?? {}) };
  return s;
}

export const stageById = (s: OrgSettings, id?: string | null) => s.stages.find(x => x.id === id);
export const milestoneRank = (m: Milestone) => (m === 'dead' ? -1 : MILESTONE_ORDER.indexOf(m));
export const isTerminal = (s: OrgSettings, id?: string | null) => { const st = stageById(s, id); return st?.milestone === 'closed' || st?.milestone === 'dead'; };
export const firstStageOf = (s: OrgSettings, m: Milestone) => s.stages.find(x => x.milestone === m);
