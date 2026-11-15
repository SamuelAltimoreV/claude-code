// Lead scoring, buyer matching, compliance gating and merge-field rendering. Pure functions.
import type { OrgSettings, ScoringConfig } from './settings';
import { normalizePhone } from './schema';

type R = Record<string, any>;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const lc = (v: unknown) => String(v ?? '').trim().toLowerCase();
const money = (v: number) => '$' + Math.round(v).toLocaleString('en-US');

export interface ScoreFactor { key: string; label: string; points: number; max: number; reason: string }
export interface LeadScore { score: number; band: 'Hot' | 'Warm' | 'Cold'; factors: ScoreFactor[] }

export interface ScoreContext { comms: number; inbound: number; lastContactAt?: string | null; hasFollowUp: boolean; overdueTasks: number; now?: number }

/** Transparent, configurable lead score. Each factor returns the points earned and the reason. */
export function scoreLead(lead: R, property: R | null, ctx: ScoreContext, cfg: ScoringConfig): LeadScore {
  const w = cfg.weights;
  const f: ScoreFactor[] = [];
  const add = (key: keyof typeof w, label: string, ratio: number, reason: string) =>
    f.push({ key, label, max: w[key], points: Math.round(w[key] * Math.max(0, Math.min(1, ratio))), reason });

  const mot = { High: 1, Medium: 0.55, Low: 0.15 }[lead.motivation as string];
  add('motivation', 'Seller motivation', mot ?? 0, lead.motivation && lead.motivation !== 'Unknown' ? `${lead.motivation} motivation${lead.reason ? ` — ${lead.reason}` : ''}` : 'Motivation not recorded yet');

  const tl = { 'ASAP': 1, 'Within 30 days': 0.9, '1-3 months': 0.65, '3-6 months': 0.35, '6+ months': 0.15 }[lead.timeline as string];
  add('timeline', 'Timeline', tl ?? 0, lead.timeline && lead.timeline !== 'Unknown' ? `Wants to sell: ${lead.timeline}` : 'Timeline unknown');

  const value = num(property?.est_value) ?? num(property?.arv);
  const mortgage = num(property?.mortgage_balance);
  if (value && value > 0 && mortgage !== null) {
    const eq = (value - mortgage) / value;
    add('equity', 'Equity position', eq <= 0 ? 0 : eq >= 0.5 ? 1 : eq / 0.5, `${Math.round(eq * 100)}% estimated equity (${money(value - mortgage)})`);
  } else add('equity', 'Equity position', 0, value ? 'Mortgage balance unknown' : 'Property value unknown');

  const cond = { Distressed: 1, Poor: 0.9, Fair: 0.6, Good: 0.3, Excellent: 0.1 }[property?.condition as string];
  add('condition', 'Property condition', cond ?? 0, property?.condition && property.condition !== 'Unknown' ? `${property.condition} condition (distress increases wholesale potential)` : 'Condition not recorded');

  const ask = num(lead.asking_price);
  if (ask && value) {
    const ratio = ask / value;
    add('price', 'Asking price vs. value', ratio <= 0.6 ? 1 : ratio >= 1 ? 0 : (1 - ratio) / 0.4, `Asking ${money(ask)} = ${Math.round(ratio * 100)}% of estimated value`);
  } else add('price', 'Asking price vs. value', 0, ask ? 'No property value to compare against' : 'No asking price yet');

  add('engagement', 'Communication engagement', ctx.comms === 0 ? 0 : Math.min(1, ctx.inbound * 0.4 + ctx.comms * 0.12),
    ctx.comms === 0 ? 'No conversations logged' : `${ctx.comms} logged touchpoint(s), ${ctx.inbound} initiated by the seller`);

  const neg = { 'Flexible': 1, 'Somewhat flexible': 0.6, 'Firm': 0.1 }[lead.negotiation as string];
  add('negotiation', 'Willingness to negotiate', neg ?? 0, lead.negotiation && lead.negotiation !== 'Unknown' ? `Seller is ${lc(lead.negotiation)} on price` : 'Not assessed');

  const sq = cfg.sourceQuality[lead.source as string];
  add('source', 'Lead source quality', sq ?? 0.5, lead.source ? `${lead.source}${sq === undefined ? ' (no quality rating set — using neutral)' : ` rated ${Math.round(sq * 100)}%`}` : 'No source recorded');

  const now = ctx.now ?? Date.now();
  const days = ctx.lastContactAt ? (now - Date.parse(ctx.lastContactAt)) / 864e5 : null;
  let fu = 0, fuReason = 'Never contacted';
  if (days !== null) {
    fu = days <= 7 ? 0.6 : days <= 21 ? 0.35 : 0.1; fuReason = `Last contact ${Math.round(days)} day(s) ago`;
    if (ctx.hasFollowUp) { fu += 0.4; fuReason += ', next follow-up scheduled'; } else fuReason += ', no follow-up scheduled';
    if (ctx.overdueTasks) { fu -= 0.3; fuReason += `, ${ctx.overdueTasks} overdue task(s)`; }
  }
  add('followup', 'Follow-up history', fu, fuReason);

  const max = f.reduce((s, x) => s + x.max, 0) || 1;
  const score = Math.round((f.reduce((s, x) => s + x.points, 0) / max) * 100);
  return { score, band: score >= cfg.hot ? 'Hot' : score >= cfg.warm ? 'Warm' : 'Cold', factors: f };
}

export interface MatchResult { score: number; reasons: { ok: boolean; text: string; points: number; max: number }[]; disqualified: string | null }
export interface DealForMatch { property: R; price: number; arv?: number | null; repairs?: number | null }
export interface BuyerHistory { presented: number; offers: number; closed: number }

/** Scores how well a buyer's buy box fits a deal, with a human-readable explanation per criterion. */
export function matchBuyer(buyer: R, deal: DealForMatch, hist: BuyerHistory = { presented: 0, offers: 0, closed: 0 }): MatchResult {
  const p = deal.property;
  const reasons: MatchResult['reasons'] = [];
  const add = (max: number, ratio: number | null, text: string) => { if (ratio === null) return; reasons.push({ ok: ratio >= 0.5, text, points: Math.round(max * ratio), max }); };
  const has = (arr: unknown, v: unknown) => Array.isArray(arr) && arr.some(x => lc(x) === lc(v));
  const any = (arr: unknown) => Array.isArray(arr) && arr.length > 0;

  if (buyer.dnc) return { score: 0, reasons: [], disqualified: 'Buyer is marked do-not-contact' };
  if (has(buyer.classifications, 'Inactive Buyer')) return { score: 0, reasons: [], disqualified: 'Buyer is inactive' };

  // Geography (30)
  if (any(buyer.zips) || any(buyer.cities) || any(buyer.counties)) {
    if (p.zip && has(buyer.zips, p.zip)) add(30, 1, `Buys in ZIP ${p.zip}`);
    else if (p.city && has(buyer.cities, p.city)) add(30, 0.9, `Buys in ${p.city}`);
    else if (p.county && has(buyer.counties, p.county)) add(30, 0.65, `Buys in ${p.county} County`);
    else add(30, 0, `${[p.city, p.zip].filter(Boolean).join(' ')} is outside their target areas`);
  } else add(30, 0.5, 'No geographic preference on file');

  // Price (25)
  const min = num(buyer.min_price), max = num(buyer.max_price);
  if (min !== null || max !== null) {
    if ((min === null || deal.price >= min) && (max === null || deal.price <= max)) add(25, 1, `Price ${money(deal.price)} is within their range`);
    else if (max !== null && deal.price > max) add(25, deal.price <= max * 1.1 ? 0.4 : 0, `Price ${money(deal.price)} is above their ${money(max)} maximum`);
    else add(25, 0.3, `Price ${money(deal.price)} is below their ${money(min as number)} minimum`);
  } else add(25, 0.5, 'No price range on file');

  // Property type (15)
  if (any(buyer.property_types)) add(15, has(buyer.property_types, p.property_type) ? 1 : 0, has(buyer.property_types, p.property_type) ? `Buys ${p.property_type}` : `Does not typically buy ${p.property_type ?? 'this property type'}`);
  else add(15, 0.5, 'No property type preference on file');

  // Repairs (10)
  const repairs = num(deal.repairs), maxRep = num(buyer.max_repairs);
  if (repairs !== null && maxRep !== null) add(10, repairs <= maxRep ? 1 : repairs <= maxRep * 1.25 ? 0.4 : 0, repairs <= maxRep ? `Repairs ${money(repairs)} within their ${money(maxRep)} budget` : `Repairs ${money(repairs)} exceed their ${money(maxRep)} budget`);

  // ARV (5) & beds (5)
  const arv = num(deal.arv), minArv = num(buyer.min_arv), maxArv = num(buyer.max_arv);
  if (arv !== null && (minArv !== null || maxArv !== null)) { const ok = (minArv === null || arv >= minArv) && (maxArv === null || arv <= maxArv); add(5, ok ? 1 : 0, ok ? `ARV ${money(arv)} fits their preference` : `ARV ${money(arv)} is outside their preferred range`); }
  const beds = num(p.beds), minBeds = num(buyer.min_beds);
  if (beds !== null && minBeds !== null) add(5, beds >= minBeds ? 1 : 0, beds >= minBeds ? `${beds} bedrooms meets their ${minBeds}+ minimum` : `${beds} bedrooms is below their ${minBeds}+ minimum`);

  // Strategy fit (5)
  if (buyer.strategy && buyer.strategy !== 'Any') {
    const heavy = repairs !== null && arv ? repairs / arv > 0.2 : null;
    if (heavy !== null) {
      const fit = buyer.strategy === 'Buy & Hold' ? !heavy : buyer.strategy === 'Fix & Flip' || buyer.strategy === 'BRRRR' ? true : true;
      add(5, fit ? 1 : 0.2, fit ? `${buyer.strategy} strategy suits this rehab level` : `Heavy rehab is a stretch for a ${buyer.strategy} buyer`);
    }
  }

  // History & verification (10)
  const pof = buyer.pof_status === 'Verified' ? 0.5 : buyer.pof_status === 'Received' ? 0.25 : 0;
  const track = hist.closed >= 3 ? 0.5 : hist.closed >= 1 ? 0.35 : hist.offers >= 1 ? 0.15 : 0;
  add(10, pof + track, [hist.closed ? `Closed ${hist.closed} deal(s) with us` : hist.offers ? `Has made ${hist.offers} offer(s), none closed yet` : 'No closed deals with us yet', buyer.pof_status === 'Verified' ? 'proof of funds verified' : 'proof of funds not verified'].join('; '));

  const total = reasons.reduce((s, r) => s + r.max, 0) || 1;
  return { score: Math.round((reasons.reduce((s, r) => s + r.points, 0) / total) * 100), reasons, disqualified: null };
}

export type Channel = 'Call' | 'SMS' | 'Email';
export interface SendCheck { allowed: boolean; reason: string }

/** Central compliance gate. Every outbound message and automated step must pass this. */
export function canContact(channel: Channel, person: R | null | undefined, settings: OrgSettings, suppressions: R[], opts: { automated?: boolean; now?: Date } = {}): SendCheck {
  if (!person) return { allowed: false, reason: 'No contact on this record' };
  if (person.dnc) return { allowed: false, reason: 'Contact is marked Do Not Contact' };
  const phone = normalizePhone(person.phone ?? ''), email = lc(person.email);
  const sup = suppressions.find(s => (s.kind === 'Phone' && phone && normalizePhone(s.value) === phone && channel !== 'Email') || (s.kind === 'Email' && email && lc(s.value) === email && channel === 'Email'));
  if (sup) return { allowed: false, reason: `On the suppression list${sup.reason ? ` (${sup.reason})` : ''}` };
  if (channel === 'Email') {
    if (!email) return { allowed: false, reason: 'No email address on file' };
    if (settings.comms.requireEmailConsent && !person.email_opt_in) return { allowed: false, reason: 'No email consent recorded' };
    if (!settings.company.address) return { allowed: false, reason: 'Add a company mailing address in Settings (required in commercial email by CAN-SPAM)' };
  } else {
    if (!phone) return { allowed: false, reason: 'No phone number on file' };
    if (channel === 'SMS' && settings.comms.requireSmsConsent && !person.sms_opt_in) return { allowed: false, reason: 'No SMS consent recorded (TCPA requires prior express consent for marketing texts)' };
    if (channel === 'SMS' || opts.automated) {
      const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: settings.company.timezone || 'America/New_York' }).format(opts.now ?? new Date())) % 24;
      if (hour < settings.comms.quietStart || hour >= settings.comms.quietEnd) return { allowed: false, reason: `Outside permitted contact hours (${settings.comms.quietStart}:00–${settings.comms.quietEnd}:00 ${settings.company.timezone})` };
    }
  }
  return { allowed: true, reason: 'OK' };
}

export function renderTemplate(body: string, ctx: { contact?: R | null; property?: R | null; user?: R | null; company?: string; offer?: R | null }): string {
  const map: Record<string, string> = {
    first_name: ctx.contact?.first_name ?? ctx.contact?.name?.split(' ')[0] ?? '', last_name: ctx.contact?.last_name ?? '',
    property_address: ctx.property?.address ?? '', property_city: ctx.property?.city ?? '',
    agent_name: ctx.user?.name ?? '', company_name: ctx.company ?? '',
    offer_amount: ctx.offer?.amount ? money(ctx.offer.amount) : '',
  };
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in map ? map[k] : m));
}

/** Finds likely duplicates of a seller/property among existing records. */
export function findDuplicates(input: { phone?: string; email?: string; address?: string; zip?: string }, contacts: R[], properties: R[]) {
  const phone = normalizePhone(input.phone ?? ''), email = lc(input.email);
  const addr = lc(input.address).replace(/[^a-z0-9]/g, '');
  return {
    contacts: contacts.filter(c => (phone.length >= 10 && [c.phone, c.phone2].some(p => normalizePhone(p ?? '') === phone)) || (email && lc(c.email) === email)),
    properties: addr.length > 5 ? properties.filter(p => lc(p.address).replace(/[^a-z0-9]/g, '') === addr && (!input.zip || !p.zip || p.zip === input.zip)) : [],
  };
}

export const contactName = (c?: R | null) => (c ? [c.first_name, c.last_name].filter(Boolean).join(' ') || c.name || 'Unnamed' : '—');
export const propertyLabel = (p?: R | null) => (p ? [p.address, p.city].filter(Boolean).join(', ') : '—');
