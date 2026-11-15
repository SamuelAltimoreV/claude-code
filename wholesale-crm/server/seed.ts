// Starter configuration (templates, sequences, automations) and clearly-flagged DEMO DATA.
// Every demo row is stored with is_demo = true so it can be removed in one step without touching real records.
import { AUTOMATION_TEMPLATES } from '../shared/automation';
import { analyzeDeal, defaultInputs } from '../shared/calc';
import { q, savepoint } from './db';
import * as repo from './repo';
import { rescoreLead, syncFollowUp, type Ctx } from './service';

type R = Record<string, any>;
const DAY = 864e5;
const ago = (d: number, h = 10) => { const t = new Date(Date.now() - d * DAY); t.setHours(h, (d * 7) % 60, 0, 0); return t.toISOString(); };
const dateAgo = (d: number) => new Date(Date.now() - d * DAY).toISOString().slice(0, 10);

/** Non-demo starter config every new workspace gets. */
export async function seedStarterConfig(ctx: Ctx) {
  const t = (name: string, channel: string, body: string, subject?: string) => repo.insert(ctx.org, 'templates', { name, channel, body, subject: subject ?? null });
  const intro = await t('Intro text', 'SMS', 'Hi {{first_name}}, this is {{agent_name}} with {{company_name}}. You asked about selling {{property_address}} — is now a good time for a quick call? Reply STOP to opt out.');
  const checkin = await t('Check-in text', 'SMS', 'Hi {{first_name}}, {{agent_name}} here. Still open to an offer on {{property_address}}? Happy to work around your schedule. Reply STOP to opt out.');
  const email = await t('Follow-up email', 'Email', 'Hi {{first_name}},\n\nI wanted to follow up on our conversation about {{property_address}}. We buy as-is, cover closing costs and can close on your timeline.\n\nIs there a good time this week to talk?\n\n{{agent_name}}\n{{company_name}}', 'Following up on {{property_address}}');
  const script = await t('First call script', 'Call Script', 'Hi, is this {{first_name}}? This is {{agent_name}} with {{company_name}}. I\'m calling about {{property_address}}.\n\n1. What has you thinking about selling?\n2. How soon would you like to be done with it?\n3. What condition is it in — anything that needs work?\n4. If we paid cash and closed on your date, what number would you need?\n5. Is anyone else involved in the decision?');
  await t('Cash offer summary', 'Offer', 'Offer for {{property_address}}: {{offer_amount}} cash, as-is, no commissions, buyer pays closing costs. Offer prepared by {{agent_name}}, {{company_name}}. This summary is not a contract.');
  await t('Deal blast to buyers', 'Email', 'New off-market deal in {{property_city}}: {{property_address}}.\n\nReply to this email for the full package, photos and access.\n\n{{agent_name}}\n{{company_name}}', 'New deal: {{property_address}}');
  const seq = (name: string, description: string, steps: R[]) => repo.insert(ctx.org, 'sequences', { name, description, active: true, steps });
  await seq('New lead — 30 day follow-up', 'Persistent outreach for new motivated-seller leads. Texts and emails only go out with consent on file.', [
    { day: 0, channel: 'Call', templateId: script.id, note: 'Initial call' }, { day: 1, channel: 'Call', note: 'Follow-up call' }, { day: 3, channel: 'SMS', templateId: intro.id },
    { day: 5, channel: 'Call', note: 'Follow-up call' }, { day: 7, channel: 'Email', templateId: email.id }, { day: 14, channel: 'Call', note: 'Follow-up call' }, { day: 30, channel: 'Call', note: 'Long-term follow-up' },
  ]);
  await seq('Post-offer follow-up', 'Keeps a presented offer alive until the seller decides.', [
    { day: 1, channel: 'Call', note: 'Check in on the offer' }, { day: 3, channel: 'SMS', templateId: checkin.id }, { day: 7, channel: 'Call', note: 'Ask about objections' }, { day: 14, channel: 'Email', templateId: email.id },
  ]);
  await seq('Long-term nurture (quarterly)', 'For sellers who are not ready yet.', [
    { day: 30, channel: 'Call', note: 'Monthly check-in' }, { day: 90, channel: 'SMS', templateId: checkin.id }, { day: 180, channel: 'Call', note: 'Has anything changed?' },
  ]);
  for (const a of AUTOMATION_TEMPLATES) {
    const actions = a.actions.map(s => (s.type === 'send_sms' ? { ...s, params: { templateId: intro.id } } : s));
    await repo.insert(ctx.org, 'automations', { name: a.name, description: a.description, enabled: a.enabled ?? true, trigger: a.trigger, trigger_config: a.trigger_config ?? {}, conditions: a.conditions ?? [], actions });
  }
}

// [first, last, street, city, zip, type, beds, baths, sqft, year, condition, occupancy, value, arv, repairs, mortgage, taxDelinquent, motivation, timeline, asking, source, tags, stage, ownerIdx, createdDaysAgo, reason]
type LeadRow = [string, string, string, string, string, string, number, number, number, number, string, string, number, number, number, number, boolean, string, string, number | null, string, string[], string, number, number, string];
const LEADS: LeadRow[] = [
  ['Harold', 'Bennett', '1412 Maple Grove Ave NW', 'Canton', '44708', 'Single Family', 3, 1.5, 1380, 1954, 'Poor', 'Vacant', 98000, 165000, 42000, 0, true, 'High', 'ASAP', 70000, 'Tax Delinquent List', ['Tax delinquent', 'Vacant property'], 'closed_won', 1, 210, 'Behind on taxes, moved in with daughter'],
  ['Denise', 'Okafor', '827 Wertz Ave SW', 'Canton', '44710', 'Single Family', 2, 1, 960, 1948, 'Fair', 'Tenant Occupied', 72000, 118000, 24000, 18000, false, 'High', 'Within 30 days', 55000, 'Direct Mail', ['Landlord fatigue'], 'closed_won', 2, 165, 'Tired of managing tenants'],
  ['Raymond', 'Castillo', '315 Lincoln Way E', 'Massillon', '44646', 'Multi-Family (2-4)', 4, 2, 2100, 1925, 'Poor', 'Vacant', 110000, 189000, 55000, 32000, false, 'High', 'ASAP', 85000, 'Driving for Dollars', ['Vacant property', 'Code violations'], 'closed_won', 1, 120, 'Code violations piling up on vacant duplex'],
  ['Lorraine', 'Whitfield', '2209 Glenmont Rd NW', 'Canton', '44708', 'Single Family', 3, 2, 1560, 1962, 'Fair', 'Owner Occupied', 135000, 198000, 30000, 61000, false, 'High', 'Within 30 days', 105000, 'Probate List', ['Probate', 'Inherited property'], 'closing', 1, 62, 'Executor of mother\'s estate, lives out of state'],
  ['Marcus', 'Delgado', '564 Brown St', 'Akron', '44311', 'Single Family', 3, 1, 1240, 1931, 'Distressed', 'Vacant', 61000, 142000, 58000, 0, true, 'High', 'ASAP', 45000, 'Tax Delinquent List', ['Tax delinquent', 'Fire damage', 'Vacant property'], 'disposition', 2, 48, 'Kitchen fire, no insurance, owes back taxes'],
  ['Evelyn', 'Hartman', '118 Portage Trail Ext W', 'Cuyahoga Falls', '44223', 'Single Family', 3, 1.5, 1420, 1958, 'Fair', 'Owner Occupied', 168000, 232000, 28000, 74000, false, 'Medium', '1-3 months', 150000, 'Website Form', ['Divorce'], 'disposition', 1, 41, 'Divorce — needs to split proceeds'],
  ['Thomas', 'Brzezinski', '903 Amherst Rd NE', 'Massillon', '44646', 'Single Family', 4, 2, 1820, 1971, 'Fair', 'Owner Occupied', 152000, 215000, 26000, 88000, false, 'High', 'Within 30 days', 130000, 'Referral', ['Pre-foreclosure'], 'under_contract', 2, 30, 'Two payments behind, wants out before foreclosure'],
  ['Gloria', 'Santiago', '1746 Hazel St', 'Akron', '44305', 'Single Family', 2, 1, 880, 1924, 'Poor', 'Tenant Occupied', 54000, 109000, 31000, 0, false, 'High', 'ASAP', 42000, 'Cold Calling', ['Landlord fatigue', 'Absentee owner'], 'under_contract', 1, 26, 'Out-of-state landlord, tenant stopped paying'],
  ['Walter', 'Nguyen', '420 Applegrove St NW', 'North Canton', '44720', 'Single Family', 3, 2, 1650, 1978, 'Good', 'Owner Occupied', 205000, 258000, 15000, 120000, false, 'Medium', '1-3 months', 198000, 'Google Ads', [], 'negotiating', 2, 21, 'Relocating for work'],
  ['Patricia', 'Mills', '77 E Tallmadge Ave', 'Akron', '44310', 'Multi-Family (2-4)', 5, 2, 2380, 1919, 'Poor', 'Tenant Occupied', 96000, 176000, 48000, 22000, false, 'High', 'Within 30 days', 82000, 'Direct Mail', ['Landlord fatigue', 'Code violations'], 'offer_presented', 1, 18, 'Failing rental inspection, cannot afford repairs'],
  ['Calvin', 'Rhodes', '2931 Cleveland Ave S', 'Canton', '44707', 'Single Family', 3, 1, 1180, 1946, 'Fair', 'Vacant', 68000, 124000, 27000, 0, false, 'Medium', '1-3 months', 62000, 'Driving for Dollars', ['Vacant property', 'Absentee owner'], 'offer_presented', 2, 16, 'Inherited, sitting empty for a year'],
  ['Sharon', 'Kowalczyk', '1308 Rockwood Ave SW', 'Massillon', '44647', 'Single Family', 3, 1.5, 1340, 1965, 'Fair', 'Owner Occupied', 139000, 194000, 22000, 67000, false, 'Medium', '1-3 months', 135000, 'Facebook Ads', [], 'underwriting', 1, 14, 'Downsizing after retirement'],
  ['Andre', 'Jefferson', '615 Noble Ave', 'Akron', '44320', 'Single Family', 4, 2, 1710, 1928, 'Poor', 'Vacant', 79000, 158000, 46000, 15000, true, 'High', 'ASAP', 60000, 'Foreclosure List', ['Foreclosure', 'Vacant property'], 'appt_set', 2, 12, 'Sheriff sale scheduled in 6 weeks'],
  ['Marianne', 'Fischer', '2284 Easton St NE', 'North Canton', '44721', 'Single Family', 3, 2, 1490, 1984, 'Good', 'Owner Occupied', 189000, 236000, 12000, 96000, false, 'Medium', '3-6 months', 185000, 'Website Form', [], 'qualified', 1, 11, 'Moving closer to grandkids'],
  ['Leon', 'Abernathy', '511 S Arch Ave', 'Alliance', '44601', 'Single Family', 3, 1, 1260, 1938, 'Poor', 'Vacant', 58000, 112000, 33000, 0, true, 'High', 'Within 30 days', 40000, 'Tax Delinquent List', ['Tax delinquent', 'Inherited property'], 'qualified', 2, 9, 'Inherited from uncle, cannot keep up with taxes'],
  ['Brenda', 'Holloway', '1620 Sackett Ave', 'Cuyahoga Falls', '44223', 'Single Family', 3, 1, 1110, 1952, 'Fair', 'Owner Occupied', 148000, 199000, 21000, 92000, false, 'Medium', '1-3 months', 150000, 'Real Estate Agent', [], 'interested', 1, 8, 'Listing expired, open to a cash offer'],
  ['Victor', 'Marsh', '349 Wooster Rd N', 'Barberton', '44203', 'Single Family', 2, 1, 920, 1941, 'Poor', 'Vacant', 52000, 104000, 29000, 0, false, 'Medium', '3-6 months', 55000, 'Driving for Dollars', ['Vacant property'], 'interested', 2, 7, 'Rental he never fixed up'],
  ['Angela', 'Price', '1055 Fulton Rd NW', 'Canton', '44703', 'Single Family', 4, 1.5, 1640, 1922, 'Fair', 'Tenant Occupied', 84000, 139000, 25000, 30000, false, 'Low', '6+ months', 95000, 'Cold Calling', ['Landlord fatigue'], 'contacted', 1, 6, 'Might sell if the price is right'],
  ['Douglas', 'Ferraro', '208 Chestnut St', 'Louisville', '44641', 'Single Family', 3, 2, 1530, 1969, 'Good', 'Owner Occupied', 176000, 221000, 14000, 105000, false, 'Low', '6+ months', 180000, 'Facebook Ads', [], 'contacted', 2, 5, 'Curious what an investor would pay'],
  ['Yolanda', 'Grant', '742 Lovers Ln', 'Akron', '44306', 'Single Family', 3, 1, 1090, 1950, 'Fair', 'Owner Occupied', 71000, 121000, 23000, 41000, false, 'Unknown', 'Unknown', null, 'Direct Mail', ['Pre-foreclosure'], 'attempting', 1, 4, ''],
  ['Russell', 'Tran', '1903 Harrisburg Rd NE', 'Canton', '44705', 'Single Family', 2, 1, 840, 1949, 'Unknown', 'Unknown', 59000, 98000, 0, 0, false, 'Unknown', 'Unknown', null, 'Probate List', ['Probate'], 'new', 2, 2, ''],
  ['Joyce', 'McAllister', '88 N Canal St', 'Canal Fulton', '44614', 'Single Family', 3, 1.5, 1410, 1960, 'Unknown', 'Owner Occupied', 164000, 205000, 0, 0, false, 'Unknown', 'Unknown', null, 'Website Form', [], 'new', 1, 1, 'Submitted web form: "need to sell fast"'],
  ['Isaac', 'Coleman', '2416 Copley Rd', 'Akron', '44320', 'Single Family', 3, 1, 1200, 1935, 'Unknown', 'Vacant', 66000, 119000, 0, 0, true, 'Unknown', 'Unknown', null, 'Tax Delinquent List', ['Tax delinquent', 'Vacant property'], 'new', 0, 0, ''],
  ['Pamela', 'Stroud', '1337 Tuscarawas St W', 'Canton', '44702', 'Commercial', 0, 2, 3200, 1915, 'Poor', 'Vacant', 120000, 210000, 90000, 45000, false, 'Low', '6+ months', 190000, 'Networking', [], 'dead', 1, 75, 'Wanted retail price for a distressed building'],
  ['Kenneth', 'Ostrowski', '590 Stow St', 'Stow', '44224', 'Single Family', 4, 2.5, 2240, 1992, 'Excellent', 'Owner Occupied', 312000, 330000, 5000, 240000, false, 'Low', '6+ months', 325000, 'Google Ads', [], 'dead', 2, 54, 'No equity and no urgency'],
];

const STAGE_ORDER = ['new', 'attempting', 'contacted', 'interested', 'qualified', 'appt_set', 'appt_done', 'underwriting', 'offer_prep', 'offer_presented', 'negotiating', 'contract_sent', 'under_contract', 'disposition', 'closing', 'closed_won'];

// [name, company, strategy, cities, counties, types, minBeds, minPrice, maxPrice, maxRepairs, financing, pof, classes, groups]
const BUYERS: [string, string, string, string[], string[], string[], number, number, number, number, string, string, string[], string[]][] = [
  ['Derek Lawson', 'Lawson Home Solutions LLC', 'Fix & Flip', ['Canton', 'North Canton', 'Massillon'], ['Stark'], ['Single Family'], 3, 50000, 160000, 60000, 'Cash', 'Verified', ['Active Buyer', 'Verified Buyer', 'Cash Buyer', 'Flipper'], ['VIP Buyers', 'Stark County Flippers']],
  ['Nina Patel', 'Rubber City Rentals', 'Buy & Hold', ['Akron', 'Barberton', 'Cuyahoga Falls'], ['Summit'], ['Single Family', 'Multi-Family (2-4)'], 2, 30000, 110000, 30000, 'Cash', 'Verified', ['Active Buyer', 'Verified Buyer', 'Cash Buyer', 'Landlord'], ['VIP Buyers', 'Summit County Landlords']],
  ['Greg Thornton', 'Thornton Capital Group', 'Fix & Flip', ['Akron', 'Cuyahoga Falls', 'Stow'], ['Summit'], ['Single Family'], 3, 80000, 220000, 70000, 'Hard Money', 'Verified', ['Active Buyer', 'Verified Buyer', 'Flipper'], ['VIP Buyers']],
  ['Alicia Romero', 'Hall of Fame Properties', 'BRRRR', ['Canton', 'Massillon', 'Alliance'], ['Stark'], ['Single Family', 'Multi-Family (2-4)'], 2, 30000, 120000, 55000, 'Private Money', 'Received', ['Active Buyer', 'Investor', 'Landlord'], ['Stark County Flippers']],
  ['Sam Whitaker', 'Whitaker & Sons Renovations', 'Fix & Flip', ['Massillon', 'Canal Fulton', 'North Canton'], ['Stark'], ['Single Family'], 3, 60000, 180000, 50000, 'Cash', 'Verified', ['Active Buyer', 'Verified Buyer', 'Cash Buyer', 'Flipper'], ['Stark County Flippers']],
  ['Monique Adams', 'Summit Door Holdings', 'Buy & Hold', ['Akron'], ['Summit'], ['Multi-Family (2-4)', 'Multi-Family (5+)'], 4, 70000, 260000, 60000, 'Conventional', 'Received', ['Active Buyer', 'Landlord', 'Investor'], ['Summit County Landlords']],
  ['Brian Kessler', 'Kessler Equity Partners', 'Fix & Flip', ['Canton', 'Akron', 'Massillon', 'North Canton', 'Cuyahoga Falls'], ['Stark', 'Summit'], ['Single Family'], 3, 60000, 200000, 80000, 'Cash', 'Verified', ['Active Buyer', 'Verified Buyer', 'Cash Buyer', 'Flipper', 'Investor'], ['VIP Buyers']],
  ['Tasha Greene', 'Greene Street Homes', 'Buy & Hold', ['Canton', 'Louisville', 'Alliance'], ['Stark'], ['Single Family'], 2, 25000, 90000, 30000, 'Cash', 'Requested', ['Active Buyer', 'Landlord'], []],
  ['Paul Jankowski', 'Midwest Residential Fund I', 'Buy & Hold', [], ['Stark', 'Summit'], ['Single Family', 'Multi-Family (2-4)'], 3, 90000, 250000, 35000, 'Cash', 'Verified', ['Active Buyer', 'Verified Buyer', 'Institutional Buyer'], ['VIP Buyers']],
  ['Carmen Ortiz', 'Ortiz Rehab Co', 'Fix & Flip', ['Akron', 'Barberton'], ['Summit'], ['Single Family'], 2, 30000, 100000, 65000, 'Hard Money', 'Received', ['Active Buyer', 'Flipper'], []],
  ['Elliot Park', 'Park Avenue Investments', 'BRRRR', ['Cuyahoga Falls', 'Stow', 'Akron'], ['Summit'], ['Single Family'], 3, 90000, 210000, 45000, 'Private Money', 'Verified', ['Active Buyer', 'Verified Buyer', 'Investor'], ['Summit County Landlords']],
  ['Rita Maddox', 'Maddox Family Rentals', 'Buy & Hold', ['North Canton', 'Canton'], ['Stark'], ['Single Family', 'Condo', 'Townhouse'], 2, 80000, 190000, 20000, 'Conventional', 'Not Requested', ['Landlord'], []],
  ['Jerome Banks', 'JB Wholesale Network', 'Wholesale', ['Canton', 'Akron'], ['Stark', 'Summit'], ['Single Family', 'Multi-Family (2-4)'], 2, 20000, 120000, 70000, 'Cash', 'Requested', ['Investor'], []],
  ['Helen Vasquez', 'Lakeview Builders', 'New Construction', ['Green', 'North Canton'], ['Stark', 'Summit'], ['Land'], 0, 15000, 90000, 0, 'Cash', 'Received', ['Active Buyer', 'Investor'], []],
  ['Owen Fletcher', 'Fletcher Holdings', 'Fix & Flip', ['Canton'], ['Stark'], ['Single Family'], 3, 40000, 130000, 50000, 'Cash', 'Expired', ['Inactive Buyer'], []],
];

export async function seedDemo(ctx: Ctx, ownerId: string) {
  const org = ctx.org;
  const tag = org.slice(0, 8);
  const ins = (name: string, data: R, daysAgo?: number) => repo.insert(org, name, data, { demo: true, userId: ownerId, createdAt: daysAgo === undefined ? undefined : ago(daysAgo) });
  const mkUser = async (name: string, role: string, department: string) => (await q(
    `insert into users (org_id, email, name, role, department, status, is_demo) values ($1, $2, $3, $4, $5, 'active', true) returning id, name`,
    [org, `${name.toLowerCase().replace(/\s+/g, '.')}+${tag}@demo.invalid`, name, role, department])).rows[0];
  const team = [{ id: ownerId }, await mkUser('Jenna Kowalski', 'Acquisition Representative', 'Acquisitions'), await mkUser('Devon Carter', 'Acquisition Representative', 'Acquisitions')];
  const mgr = await mkUser('Marcus Reed', 'Acquisition Manager', 'Acquisitions');
  const dispo = await mkUser('Priya Shah', 'Disposition Manager', 'Dispositions');
  const tc = await mkUser('Tom Willis', 'Transaction Coordinator', 'Transactions');

  const stark = await ins('markets', { name: 'Stark County, OH', state: 'OH', counties: ['Stark'], cities: ['Canton', 'Massillon', 'North Canton', 'Alliance', 'Louisville', 'Canal Fulton'], zips: ['44702', '44703', '44705', '44707', '44708', '44710', '44646', '44647', '44720', '44721', '44601', '44641', '44614'], neighborhoods: ['Ridgewood', 'Vassar Park', 'Crystal Park'], mao_pct: 70, active: true });
  const summit = await ins('markets', { name: 'Summit County, OH', state: 'OH', counties: ['Summit'], cities: ['Akron', 'Cuyahoga Falls', 'Barberton', 'Stow', 'Green'], zips: ['44305', '44306', '44310', '44311', '44320', '44223', '44203', '44224'], neighborhoods: ['Highland Square', 'Goodyear Heights', 'Kenmore'], mao_pct: 72, active: true });
  const summitCities = new Set(summit.cities as string[]);

  const camp: Record<string, R> = {};
  for (const [name, source, budget, start, market] of [
    ['Stark County tax-delinquent mailers', 'Tax Delinquent List', 3600, 220, stark.id], ['Probate letters — Q3', 'Probate List', 1800, 150, stark.id], ['Absentee owner postcards', 'Direct Mail', 4200, 180, null],
    ['Akron cold calling', 'Cold Calling', 2400, 120, summit.id], ['"Sell my house fast" search ads', 'Google Ads', 3000, 90, null], ['Facebook motivated seller ads', 'Facebook Ads', 1500, 60, null],
  ] as [string, string, number, number, string | null][]) {
    camp[source] = await ins('campaigns', { name, source, budget, start_date: dateAgo(start), status: 'Active', market_id: market }, start);
    const months = Math.max(1, Math.round(start / 30));
    for (let m = 0; m < months; m++) await ins('expenses', { category: 'Marketing', subcategory: source, campaign_id: camp[source].id, amount: Math.round((budget / months) * (0.85 + ((m * 37) % 30) / 100)), date: dateAgo(start - m * 30 - 2), vendor: source.includes('Ads') ? source.split(' ')[0] : source === 'Cold Calling' ? 'Dialer + VA hours' : 'Mail house' }, start - m * 30);
  }
  for (let m = 0; m < 7; m++) {
    await ins('expenses', { category: 'Operating', subcategory: 'Software', amount: 420, date: dateAgo(m * 30 + 3), vendor: 'CRM, dialer, e-sign' }, m * 30 + 3);
    await ins('expenses', { category: 'Operating', subcategory: 'Payroll & contractors', amount: 3800 + (m % 3) * 250, date: dateAgo(m * 30 + 1), vendor: 'Team' }, m * 30 + 1);
  }

  const buyers: R[] = [];
  for (let i = 0; i < BUYERS.length; i++) {
    const [name, company, strategy, cities, counties, types, minBeds, min, max, maxRep, financing, pof, classes, groups] = BUYERS[i];
    buyers.push(await ins('buyers', { name, company, strategy, cities, counties, property_types: types, min_beds: minBeds || null, min_price: min, max_price: max, max_repairs: maxRep || null, financing, pof_status: pof,
      pof_verified_on: pof === 'Verified' ? dateAgo(40 + i * 9) : null, classifications: classes, groups, phone: `(330) 555-02${String(i + 10)}`, email: `${name.split(' ')[0].toLowerCase()}@${company.toLowerCase().replace(/[^a-z]/g, '').slice(0, 14)}.example`,
      preferred_contact: i % 3 === 0 ? 'Phone' : 'Email', rep_id: dispo.id, email_opt_in: i !== 12, email_opt_in_at: i !== 12 ? ago(200 - i * 5) : null, sms_opt_in: i % 2 === 0, sms_opt_in_at: i % 2 === 0 ? ago(200 - i * 5) : null,
      consent_source: 'Buyer list sign-up form', fee_min: 5000, fee_max: 20000, min_arv: null, max_arv: null }, 230 - i * 8));
  }
  const buyerBy = (n: string) => buyers.find(b => b.name === n)!;

  const cfg = ctx.settings.analyzer;
  const leads: R[] = [];
  for (let i = 0; i < LEADS.length; i++) {
    const [first, last, street, city, zip, type, beds, baths, sqft, year, condition, occupancy, value, arv, repairs, mortgage, taxDel, motivation, timeline, asking, source, tags, stage, ownerIdx, created, reason] = LEADS[i];
    const inSummit = summitCities.has(city);
    const hasConsent = ['Website Form', 'Google Ads', 'Facebook Ads', 'Referral'].includes(source);
    const contact = await ins('contacts', { first_name: first, last_name: last, phone: `(330) 555-01${String(i + 10)}`, email: i % 4 === 3 ? null : `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
      mailing_address: occupancy === 'Owner Occupied' ? street : `PO Box ${1200 + i * 13}`, mailing_city: occupancy === 'Owner Occupied' ? city : 'Columbus', mailing_state: 'OH', mailing_zip: occupancy === 'Owner Occupied' ? zip : '43215',
      preferred_contact: hasConsent ? 'SMS' : 'Phone', best_time: ['Mornings', 'After 5pm', 'Weekends', 'Lunch hour'][i % 4], sms_opt_in: hasConsent, sms_opt_in_at: hasConsent ? ago(created) : null,
      email_opt_in: hasConsent, email_opt_in_at: hasConsent ? ago(created) : null, consent_source: hasConsent ? 'Web lead form checkbox' : null, dnc: false }, created);
    const property = await ins('properties', { address: street, city, state: 'OH', zip, county: inSummit ? 'Summit' : 'Stark', market_id: inSummit ? summit.id : stark.id, property_type: type, beds: beds || null, baths, sqft, year_built: year,
      lot_size: Math.round((0.12 + (i % 5) * 0.04) * 100) / 100, condition, occupancy, listing_status: 'Off Market', owner_name: `${first} ${last}`, ownership_status: tags.includes('Probate') || tags.includes('Inherited property') ? 'Estate / Heirs' : 'Sole Owner',
      est_value: value, arv, repair_cost: repairs || null, mortgage_balance: mortgage, tax_delinquent: taxDel, tax_owed: taxDel ? 2400 + i * 310 : null, indicators: tags, parcel_id: `DEMO-${10000 + i * 137}`, data_source: 'Demo data' }, created);
    const idx = STAGE_ORDER.indexOf(stage), dead = stage === 'dead';
    const reached = (s: string) => !dead ? idx >= STAGE_ORDER.indexOf(s) : (i === 23 ? STAGE_ORDER.indexOf('offer_presented') : STAGE_ORDER.indexOf('contacted')) >= STAGE_ORDER.indexOf(s);
    const at = (offset: number) => ago(Math.max(created - offset, 0.2));
    const fee = reached('underwriting') ? Math.round((arv * 0.7 - repairs - (asking ?? arv * 0.5)) / 500) * 500 : null;
    const lead = await ins('leads', { contact_id: contact.id, property_id: property.id, stage, owner_id: team[ownerIdx].id, source, campaign_id: camp[source]?.id ?? null, tags,
      classification: dead ? 'Unqualified' : stage === 'closed_won' ? 'Closed' : idx >= STAGE_ORDER.indexOf('under_contract') ? 'Under contract' : motivation === 'Unknown' ? null : `${motivation} motivation`,
      motivation, reason: reason || null, asking_price: asking, timeline, negotiation: motivation === 'High' ? 'Flexible' : motivation === 'Medium' ? 'Somewhat flexible' : motivation === 'Low' ? 'Firm' : 'Unknown',
      decision_authority: tags.includes('Probate') ? 'Shared decision' : motivation === 'Unknown' ? 'Unknown' : 'Sole decision maker', other_decision_makers: tags.includes('Probate') ? 'Sibling (co-heir)' : null,
      circumstances: reason || null, est_fee: fee && fee > 0 ? Math.max(fee, 6000) : null, dead_reason: dead ? reason : null,
      stage_changed_at: at(dead ? 20 : Math.min(created, 3 + idx * 2)), first_contact_at: reached('attempting') ? at(0.1) : null, last_contact_at: reached('attempting') ? ago(Math.min(created, Math.max(0.5, (i * 3) % 9))) : null,
      contacted_at: reached('contacted') ? at(1) : null, qualified_at: reached('qualified') ? at(4) : null, offer_at: reached('offer_presented') ? at(8) : null,
      contract_at: reached('under_contract') ? at(13) : null, closed_at: stage === 'closed_won' ? at(42) : null, dead_at: dead ? at(20) : null }, created);
    leads.push({ ...lead, _c: contact, _p: property, _row: LEADS[i] });

    const act = (type: string, summary: string, offset: number, body?: string, user = team[ownerIdx].id) => repo.insert(org, 'activities', { type, summary, body: body ?? null, lead_id: lead.id, property_id: property.id, contact_id: contact.id, user_id: user, at: at(offset) }, { demo: true });
    await act('created', `Lead created from ${source}`, 0);
    const call = async (offset: number, outcome: string, body: string, direction = 'Outbound', type = 'Call') => {
      const c = await repo.insert(org, 'communications', { type, direction, contact_id: contact.id, lead_id: lead.id, property_id: property.id, outcome, duration_min: outcome === 'No answer' ? 0 : 4 + (i % 9), body, at: at(offset), user_id: team[ownerIdx].id, status: 'Logged' }, { demo: true, createdAt: at(offset) });
      await act('comm', `${direction === 'Inbound' ? 'Incoming' : 'Outgoing'} ${type.toLowerCase()} — ${outcome}`, offset, body); return c;
    };
    if (reached('attempting')) await call(0.1, 'No answer', 'No answer, no voicemail set up.');
    if (reached('contacted')) { await call(1, 'Interested', `Spoke with ${first}. ${reason || 'Open to hearing an offer.'}`); await act('stage', 'Stage: Attempting Contact → Contacted', 1); }
    if (reached('interested') && i % 2 === 0) await call(2.5, 'Call back later', `${first} called back asking how the process works.`, 'Inbound');
    if (reached('qualified')) { await call(4, 'Interested', `Qualified: ${motivation.toLowerCase()} motivation, timeline ${timeline.toLowerCase()}, asking $${(asking ?? 0).toLocaleString()}.`); await act('stage', 'Stage: Interested → Qualified', 4); }
    if (reached('appt_set')) await act('note', 'Note', 5, `Walkthrough notes: ${condition.toLowerCase()} condition. Roof ${year < 1950 ? 'needs replacement' : 'looks serviceable'}, mechanicals dated.`);
    if (dead) await act('stage', `Stage: ${i === 23 ? 'Offer Presented' : 'Contacted'} → Dead Lead`, 20, `Reason: ${reason}`);

    // Underwriting, comps and offers
    if (reached('underwriting')) {
      for (let k = 0; k < 3; k++) await ins('comps', { property_id: property.id, address: `${300 + k * 211 + i * 7} ${['Oakwood', 'Fairmount', 'Harrison'][k]} ${['Ave', 'St', 'Blvd'][k]}`, sale_price: Math.round(arv * (0.96 + k * 0.035) / 500) * 500, sale_date: dateAgo(30 + k * 28 + i),
        sqft: sqft + (k - 1) * 90, beds: beds || 3, baths, distance: 0.3 + k * 0.25, notes: ['Fully renovated', 'Updated kitchen and baths', 'Renovated, similar lot'][k], source: 'Demo data (manual)' }, created - 6);
      const inputs = defaultInputs(cfg, { arv, repairs, asking: asking ?? undefined, maoPct: inSummit ? 72 : 70 });
      const results = analyzeDeal(inputs, cfg.thresholds);
      const an = await ins('analyses', { name: 'Initial underwriting', property_id: property.id, lead_id: lead.id, inputs, results, rating: results.rating, mao: Math.round(results.mao), offer_price: null }, created - 6);
      await act('analysis', `Deal analysis saved: Initial underwriting — ${results.rating}, MAO $${Math.round(results.mao).toLocaleString()}`, 6);
      if (reached('offer_presented')) {
        const accepted = idx >= STAGE_ORDER.indexOf('under_contract');
        const amount = Math.round(Math.min(results.mao, (asking ?? results.mao) * (accepted ? 0.95 : 0.88)) / 500) * 500;
        const offer = await ins('offers', { property_id: property.id, lead_id: lead.id, contact_id: contact.id, analysis_id: an.id, from_party: 'Us', amount, offer_date: dateAgo(Math.max(created - 8, 0)), expires_on: dateAgo(Math.max(created - 8, 0) - 7),
          closing_date: dateAgo(Math.max(created - 8, 0) - 30), emd: 1000, fee_target: 10000, status: accepted ? 'Accepted' : stage === 'negotiating' ? 'Countered' : dead ? 'Rejected' : 'Presented', method: i % 2 ? 'In person' : 'Phone', owner_id: team[ownerIdx].id,
          notes: accepted ? 'Seller accepted after walkthrough.' : 'Presented with comps and repair list.' }, created - 8);
        await act('offer', `Offer $${amount.toLocaleString()} recorded (Presented)`, 8);
        leads[leads.length - 1]._offer = offer;
        if (stage === 'negotiating') { await ins('offers', { property_id: property.id, lead_id: lead.id, contact_id: contact.id, parent_id: offer.id, from_party: 'Seller', amount: amount + 14000, offer_date: dateAgo(Math.max(created - 10, 0)), status: 'Presented', method: 'Phone', notes: 'Seller says he needs enough to cover the move.', owner_id: team[ownerIdx].id }, created - 10); await act('offer', `Seller counteroffer $${(amount + 14000).toLocaleString()} recorded`, 10); }
        if (accepted) await act('offer', `Offer $${amount.toLocaleString()}: Presented → Accepted`, 11);
      }
    }
  }

  // Contracts, transactions, dispositions, revenue
  const checklist = (done: number) => ctx.settings.transactionChecklist.map((label, i) => ({ label, done: i < done, done_at: i < done ? ago(3) : null }));
  const deals: [number, string, string | null, number | null, number][] = [ // [lead index, txn status, buyer, assignment price premium, checklist done]
    [0, 'Closed', 'Derek Lawson', 14500, 11], [1, 'Closed', 'Alicia Romero', 9000, 11], [2, 'Closed', 'Brian Kessler', 18500, 11],
    [3, 'Assigned', 'Sam Whitaker', 12000, 8], [4, 'Buyer Found', 'Carmen Ortiz', 11000, 5], [5, 'Marketing to Buyers', null, null, 4], [6, 'Title Opened', null, null, 3], [7, 'Under Contract', null, null, 1],
  ];
  for (const [li, status, buyerName, premium, done] of deals) {
    const l = leads[li], offer = l._offer as R, created = l._row[24] as number, buyer = buyerName ? buyerBy(buyerName) : null;
    const contractDay = Math.max(created - 13, 0), closed = status === 'Closed', closedDay = Math.max(created - 42, 1);
    const price = offer.amount as number, aPrice = premium ? price + premium : null;
    const txn = await ins('transactions', { property_id: l.property_id, lead_id: l.id, contact_id: l.contact_id, buyer_id: buyer?.id ?? null, coordinator_id: tc.id, status, purchase_price: price, assignment_price: aPrice, assignment_fee: premium,
      title_company: li % 2 ? 'Stark County Title Agency' : 'Buckeye Land Title', title_contact: li % 2 ? 'Rachel M.' : 'Dan P.', closing_date: closed ? dateAgo(closedDay) : dateAgo(-(6 + li * 4)), closed_on: closed ? dateAgo(closedDay) : null,
      emd_deposited: done >= 2, buyer_emd_received: done >= 7, checklist: checklist(done) }, contractDay);
    const pc = await ins('contracts', { type: 'Purchase Agreement', property_id: l.property_id, lead_id: l.id, contact_id: l.contact_id, offer_id: offer.id, transaction_id: txn.id, purchase_price: price, emd: 1000, effective_date: dateAgo(contractDay),
      inspection_end: dateAgo(contractDay - 10), closing_date: txn.closing_date, title_company: txn.title_company, status: closed ? 'Closed' : status === 'Assigned' ? 'Assigned' : 'Fully Executed', seller_signed: true, company_signed: true,
      contingencies: 'Inspection period 10 days. Buyer may assign. Clear and marketable title.' }, contractDay);
    const act = (type: string, summary: string, daysAgo: number, extra: R = {}) => repo.insert(org, 'activities', { type, summary, lead_id: l.id, property_id: l.property_id, transaction_id: txn.id, user_id: tc.id, at: ago(daysAgo), ...extra }, { demo: true });
    await act('contract', 'Purchase Agreement: Awaiting Signature → Fully Executed', contractDay);
    await act('transaction', 'Transaction opened', contractDay);
    if (status !== 'Under Contract' && status !== 'Title Opened') {
      const dStatus = closed ? 'Closed' : status === 'Assigned' ? 'Assigned' : status === 'Buyer Found' ? 'Buyer Selected' : 'Active';
      const d = await ins('dispositions', { property_id: l.property_id, lead_id: l.id, contract_id: pc.id, transaction_id: txn.id, purchase_price: price, asking_price: price + (premium ?? 13000) + 2500, fee_target: (premium ?? 13000) + 2500,
        summary: `${l._p.beds || ''} bed ${l._p.property_type} in ${l._p.city}. ARV $${l._p.arv.toLocaleString()}, repairs ≈ $${(l._p.repair_cost ?? 0).toLocaleString()}. ${l._p.occupancy}. Access by appointment.`,
        status: dStatus, selected_buyer_id: buyer?.id ?? null, owner_id: dispo.id, started_on: dateAgo(Math.max(contractDay - 2, 0)), ended_on: closed || status === 'Assigned' ? dateAgo(Math.max(contractDay - 9, 0)) : null }, Math.max(contractDay - 2, 0));
      await act('dispo', `Disposition campaign started — asking $${d.asking_price.toLocaleString()}`, Math.max(contractDay - 2, 0), { disposition_id: d.id, user_id: dispo.id });
      const pool = buyers.filter(b => (b.cities as string[]).includes(l._p.city) || (b.counties as string[]).includes(l._p.county)).slice(0, 6);
      for (let k = 0; k < pool.length; k++) {
        const b = pool[k], isWinner = buyer?.id === b.id;
        const st = isWinner ? 'Accepted' : ['Offer Made', 'Requested Info', 'Sent', 'Passed', 'Showing Requested', 'Opened'][k % 6];
        const sent = Math.max(contractDay - 2.5, 0.3);
        await ins('buyer_interests', { disposition_id: d.id, buyer_id: b.id, status: st, match_score: 92 - k * 7, offer_amount: isWinner ? aPrice : st === 'Offer Made' ? price + (premium ?? 12000) - 3500 : null,
          feedback: st === 'Passed' ? 'Too much rehab for us right now.' : st === 'Offer Made' ? 'Can close in 10 days, cash.' : null, channel: 'Email', sent_at: ago(sent), responded_at: ['Sent', 'Opened'].includes(st) ? null : ago(Math.max(sent - 0.2 - k * 0.3, 0.1)) }, sent);
      }
      if (buyer && (closed || status === 'Assigned' || status === 'Buyer Found'))
        await ins('contracts', { type: 'Assignment Agreement', property_id: l.property_id, lead_id: l.id, contact_id: l.contact_id, buyer_id: buyer.id, transaction_id: txn.id, purchase_price: price, assignment_price: aPrice, assignment_fee: premium, emd: 3000,
          effective_date: status === 'Buyer Found' ? null : dateAgo(Math.max(contractDay - 9, 0)), closing_date: txn.closing_date, title_company: txn.title_company, status: closed ? 'Closed' : status === 'Assigned' ? 'Fully Executed' : 'Awaiting Signature', buyer_signed: status !== 'Buyer Found', company_signed: true }, Math.max(contractDay - 8, 0));
    }
    if (closed) { await ins('revenue', { transaction_id: txn.id, amount: premium, date: dateAgo(closedDay), type: 'Assignment Fee' }, closedDay); await act('revenue', `Deal closed — assignment fee $${premium!.toLocaleString()} recorded`, closedDay); }
  }

  // Tasks: overdue, today and upcoming
  const due = (days: number, hour = 10) => { const t = new Date(Date.now() + days * DAY); t.setHours(hour, 0, 0, 0); return t.toISOString(); };
  const T = (title: string, category: string, days: number, li: number | null, assignee: string, priority = 'Normal', extra: R = {}) => ins('tasks', { title, category, due_at: due(days, 9 + (Math.abs(days) % 7)), priority, assignee_id: assignee, status: 'Open', lead_id: li === null ? null : leads[li].id, property_id: li === null ? null : leads[li].property_id, ...extra }, 3);
  await T('Call back Yolanda Grant — third attempt', 'Call seller', -2, 19, team[1].id, 'High');
  await T('Follow up with Angela Price on price expectations', 'Follow up', -1, 17, team[1].id);
  await T('Call new web lead: Joyce McAllister', 'Call seller', 0, 21, team[1].id, 'Urgent');
  await T('First call: Russell Tran (probate)', 'Call seller', 0, 20, team[2].id, 'High');
  await T('Research comps for 1308 Rockwood Ave SW', 'Research comps', 0, 11, team[1].id, 'High');
  await T('Walkthrough at 615 Noble Ave', 'Schedule appointment', 1, 12, team[2].id, 'High');
  await T('Respond to seller counter — Walter Nguyen', 'Send offer', 1, 8, team[2].id, 'Urgent');
  await T('Follow up on presented offer — Patricia Mills', 'Follow up', 1, 9, team[1].id, 'High');
  await T('Follow up on presented offer — Calvin Rhodes', 'Follow up', 2, 10, team[2].id);
  await T('Underwrite 2284 Easton St NE', 'Underwrite property', 2, 13, team[1].id);
  await T('Send deal package to matched buyers — 118 Portage Trail', 'Contact buyer', 0, 5, dispo.id, 'High');
  await T('Collect buyer EMD — 564 Brown St', 'Coordinate closing', 1, 4, tc.id, 'High');
  await T('Confirm clear to close — 2209 Glenmont Rd NW', 'Coordinate closing', 3, 3, tc.id, 'High');
  await T('Open title — 1746 Hazel St', 'Coordinate closing', 0, 7, tc.id, 'Urgent');
  await T('Review weekly KPIs with acquisitions team', 'Other', 4, null, mgr.id);
  await ins('tasks', { title: 'Initial call — Leon Abernathy', category: 'Call seller', due_at: ago(8), priority: 'Normal', assignee_id: team[2].id, status: 'Done', completed_at: ago(8), lead_id: leads[14].id }, 9);
  await ins('tasks', { title: 'Follow up — Marianne Fischer', category: 'Follow up', due_at: ago(5), priority: 'Normal', assignee_id: team[1].id, status: 'Done', completed_at: ago(5), lead_id: leads[13].id }, 6);
  await ins('tasks', { title: 'Follow up — Brenda Holloway', category: 'Follow up', due_at: ago(3), priority: 'Normal', assignee_id: team[1].id, status: 'Done', completed_at: ago(2.8), lead_id: leads[15].id }, 4);

  // Sequence enrollments on early-stage leads
  const seqs = await repo.list(org, 'sequences', {}, { order: 'created_at asc' });
  if (seqs[0]) for (const li of [19, 20, 22]) await ins('enrollments', { sequence_id: seqs[0].id, lead_id: leads[li].id, status: 'Active', step_index: 1, started_at: ago(1), next_run_at: due(0.02) }, 1);
  if (seqs[1]) await ins('enrollments', { sequence_id: seqs[1].id, lead_id: leads[9].id, status: 'Active', step_index: 1, started_at: ago(2), next_run_at: due(1) }, 2);

  const demoCtx: Ctx = { ...ctx, demo: true, events: [] };
  for (const l of leads) { await syncFollowUp(demoCtx, l.id); await rescoreLead(demoCtx, l.id); }
  return { leads: leads.length, buyers: buyers.length };
}

/** Deletes every demo record (children first). Real records are never touched. */
export async function removeDemo(org: string, keepUserId: string) {
  const order = ['automation_runs', 'notifications', 'audit_logs', 'integration_logs', 'attachments', 'activities', 'tasks', 'enrollments', 'communications', 'revenue', 'expenses', 'buyer_interests', 'dispositions', 'contracts', 'transactions',
    'offers', 'comps', 'analyses', 'leads', 'property_contacts', 'properties', 'contacts', 'buyers', 'campaigns', 'markets', 'suppressions', 'saved_views', 'webhooks', 'templates', 'sequences', 'automations'];
  let removed = 0; const kept: string[] = [];
  for (const t of order) {
    try { removed += (await savepoint(() => q(`delete from ${t} where org_id = $1 and is_demo = true returning id`, [org]))).rows.length; }
    catch (e: any) {
      if (String(e?.code) !== '23503') throw e;
      // A real record references a demo record: delete what we can, row by row.
      for (const r of (await q(`select id from ${t} where org_id = $1 and is_demo = true`, [org])).rows) {
        try { await savepoint(() => q(`delete from ${t} where id = $1`, [r.id])); removed++; } catch { if (!kept.includes(t)) kept.push(t); }
      }
    }
  }
  const users = (await q(`select id from users where org_id = $1 and is_demo = true and id <> $2`, [org, keepUserId])).rows;
  for (const u of users) { try { await savepoint(() => q('delete from users where id = $1', [u.id])); removed++; } catch { await q(`update users set status = 'disabled' where id = $1`, [u.id]); kept.push('users'); } }
  return { removed, kept };
}
