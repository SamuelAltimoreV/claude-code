// Deal underwriting math. Pure functions, shared by the Deal Analyzer UI, the API and tests.
import type { AnalyzerConfig } from './settings';

export interface DealInputs {
  arv: number; repairs: number; asking?: number; offerPrice?: number;
  assignmentFee: number;
  strategy: 'percent' | 'cost';
  maoPct: number;               // percent-of-ARV rule
  buyerClosingPct: number;      // buyer's purchase closing costs, % of purchase
  sellingCostPct: number;       // buyer's resale costs (commissions + closing), % of ARV
  holdingMonthly: number; holdingMonths: number;
  investorMarginPct: number;    // buyer's required profit as % of ARV (cost strategy)
  loanPct: number; interestRate: number; points: number; // financing: % of purchase financed, annual rate %, points %
  additional: number;
}

export interface Comp { address?: string; sale_price: number; sqft?: number | null }

export type Rating = 'Excellent deal' | 'Potential deal' | 'Marginal deal' | 'Poor deal' | 'Incomplete';

export interface DealResults {
  buyerMaxPrice: number;        // most an end buyer should pay (what we can assign for)
  mao: number;                  // our max offer to the seller
  purchasePrice: number;        // price used for projections (offer, else asking, else MAO)
  purchaseBasis: 'offer' | 'asking' | 'mao';
  projectedFee: number;         // buyerMaxPrice - purchasePrice
  spreadVsAsking: number | null;// MAO - asking (negative = gap to negotiate)
  buyerCosts: { closing: number; selling: number; holding: number; financing: number; additional: number; total: number };
  investorProfit: number;       // buyer's profit if they pay buyerMaxPrice
  investorMarginPct: number;    // investor profit / ARV
  investorRoiPct: number;       // profit / cash invested
  pctOfArv: number;             // (purchasePrice + fee + repairs) / ARV
  rating: Rating; reasons: string[];
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
export const round = (v: number) => Math.round(v);

export function defaultInputs(cfg: AnalyzerConfig, over: Partial<DealInputs> = {}): DealInputs {
  return {
    arv: 0, repairs: 0, assignmentFee: cfg.assignmentFee, strategy: 'percent', maoPct: cfg.maoPct,
    buyerClosingPct: cfg.buyerClosingPct, sellingCostPct: cfg.sellingCostPct, holdingMonthly: cfg.holdingMonthly, holdingMonths: cfg.holdingMonths,
    investorMarginPct: cfg.investorMarginPct, loanPct: 0, interestRate: 12, points: 2, additional: 0, ...over,
  };
}

/** Costs an end buyer carries for a given purchase price. */
export function buyerCostsAt(i: DealInputs, price: number) {
  const closing = price * n(i.buyerClosingPct) / 100;
  const selling = n(i.arv) * n(i.sellingCostPct) / 100;
  const holding = n(i.holdingMonthly) * n(i.holdingMonths);
  const loan = (price + n(i.repairs)) * n(i.loanPct) / 100;
  const financing = loan * (n(i.points) / 100) + loan * (n(i.interestRate) / 100) * (n(i.holdingMonths) / 12);
  const additional = n(i.additional);
  return { closing, selling, holding, financing, additional, total: closing + selling + holding + financing + additional };
}

export function analyzeDeal(i: DealInputs, cfg: AnalyzerConfig['thresholds']): DealResults {
  const arv = n(i.arv), repairs = n(i.repairs), fee = n(i.assignmentFee);
  let buyerMaxPrice: number;
  if (i.strategy === 'percent') {
    // Classic rule: buyer pays up to ARV x % - repairs. MAO = that minus our fee.
    buyerMaxPrice = arv * n(i.maoPct) / 100 - repairs;
  } else {
    // Cost-based: solve price so that ARV - repairs - costs(price) - price = required profit.
    // costs(price) is linear in price: fixed + price * k.
    const k = n(i.buyerClosingPct) / 100 + (n(i.loanPct) / 100) * (n(i.points) / 100 + (n(i.interestRate) / 100) * (n(i.holdingMonths) / 12));
    const fixed = buyerCostsAt(i, 0).total;
    buyerMaxPrice = (arv - repairs - fixed - arv * n(i.investorMarginPct) / 100) / (1 + k);
  }
  const mao = buyerMaxPrice - fee;
  const basis: DealResults['purchaseBasis'] = n(i.offerPrice) > 0 ? 'offer' : n(i.asking) > 0 ? 'asking' : 'mao';
  const purchasePrice = basis === 'offer' ? n(i.offerPrice) : basis === 'asking' ? n(i.asking) : mao;
  const projectedFee = buyerMaxPrice - purchasePrice;
  const costs = buyerCostsAt(i, buyerMaxPrice);
  const investorProfit = arv - repairs - buyerMaxPrice - costs.total;
  const cash = buyerMaxPrice * (1 - n(i.loanPct) / 100) + repairs * (1 - n(i.loanPct) / 100) + costs.closing + costs.holding + costs.financing + costs.additional;
  const investorMarginPct = arv > 0 ? (investorProfit / arv) * 100 : 0;

  const reasons: string[] = [];
  let rating: Rating;
  if (arv <= 0) { rating = 'Incomplete'; reasons.push('Enter an ARV to analyze this deal.'); }
  else {
    if (projectedFee >= cfg.excellentFee) rating = 'Excellent deal';
    else if (projectedFee >= cfg.potentialFee) rating = 'Potential deal';
    else if (projectedFee >= cfg.marginalFee) rating = 'Marginal deal';
    else rating = 'Poor deal';
    const src = basis === 'offer' ? 'your offer price' : basis === 'asking' ? "the seller's asking price" : 'the MAO';
    reasons.push(`Projected assignment fee at ${src}: $${round(projectedFee).toLocaleString()} (thresholds: excellent ≥ $${cfg.excellentFee.toLocaleString()}, potential ≥ $${cfg.potentialFee.toLocaleString()}, marginal ≥ $${cfg.marginalFee.toLocaleString()}).`);
    if (investorMarginPct < cfg.minInvestorMarginPct) {
      reasons.push(`End-buyer margin is ${investorMarginPct.toFixed(1)}% of ARV, below the ${cfg.minInvestorMarginPct}% minimum — buyers may pass at this price.`);
      if (rating === 'Excellent deal') rating = 'Potential deal';
      else if (rating === 'Potential deal') rating = 'Marginal deal';
    }
    if (mao <= 0) { rating = 'Poor deal'; reasons.push('Maximum allowable offer is zero or negative: repairs and fee exceed what the ARV supports.'); }
  }
  return {
    buyerMaxPrice, mao, purchasePrice, purchaseBasis: basis, projectedFee,
    spreadVsAsking: n(i.asking) > 0 ? mao - n(i.asking) : null,
    buyerCosts: costs, investorProfit, investorMarginPct, investorRoiPct: cash > 0 ? (investorProfit / cash) * 100 : 0,
    pctOfArv: arv > 0 ? ((purchasePrice + Math.max(projectedFee, 0) + repairs) / arv) * 100 : 0,
    rating, reasons,
  };
}

/** Average price per square foot across comps that have both a price and square footage. */
export function compStats(comps: Comp[], subjectSqft?: number | null) {
  const usable = comps.filter(c => n(c.sale_price) > 0 && n(c.sqft) > 0);
  const avgPpsf = usable.length ? usable.reduce((s, c) => s + c.sale_price / (c.sqft as number), 0) / usable.length : null;
  const priced = comps.filter(c => n(c.sale_price) > 0);
  const avgPrice = priced.length ? priced.reduce((s, c) => s + c.sale_price, 0) / priced.length : null;
  return {
    count: comps.length, usable: usable.length, avgPpsf, avgPrice,
    impliedArv: avgPpsf && n(subjectSqft) > 0 ? avgPpsf * (subjectSqft as number) : null,
  };
}

export interface DealCheck { level: 'risk' | 'warn' | 'info'; text: string }

/** Rule-based underwriting checks (not AI): flags missing info and assumptions outside normal ranges. */
export function dealChecks(i: DealInputs, r: DealResults, ctx: { sqft?: number | null; compCount: number; impliedArv?: number | null; condition?: string | null; yearBuilt?: number | null }): DealCheck[] {
  const out: DealCheck[] = [];
  if (n(i.arv) <= 0) return [{ level: 'risk', text: 'No ARV entered.' }];
  if (ctx.compCount === 0) out.push({ level: 'warn', text: 'ARV is not supported by any comparable sales. Add at least 3 comps.' });
  else if (ctx.compCount < 3) out.push({ level: 'warn', text: `Only ${ctx.compCount} comp(s) entered — 3 or more gives a more defensible ARV.` });
  if (ctx.impliedArv && Math.abs(i.arv - ctx.impliedArv) / ctx.impliedArv > 0.1)
    out.push({ level: 'risk', text: `ARV ($${round(i.arv).toLocaleString()}) differs from the comp-implied value ($${round(ctx.impliedArv).toLocaleString()}) by more than 10%.` });
  if (n(i.repairs) <= 0) out.push({ level: 'risk', text: 'Repair estimate is $0. Even light rehabs usually need paint, flooring and cleanup.' });
  if (ctx.sqft && n(i.repairs) > 0) {
    const psf = i.repairs / ctx.sqft;
    if (psf < 10 && ['Poor', 'Distressed', 'Fair'].includes(ctx.condition ?? '')) out.push({ level: 'risk', text: `Repairs are only $${psf.toFixed(0)}/sq ft for a property in ${ctx.condition} condition — likely underestimated.` });
    if (psf > 90) out.push({ level: 'warn', text: `Repairs are $${psf.toFixed(0)}/sq ft, which is a full gut. Confirm scope with a contractor.` });
  }
  if (ctx.yearBuilt && ctx.yearBuilt < 1950 && n(i.repairs) > 0 && ctx.sqft && i.repairs / ctx.sqft < 20)
    out.push({ level: 'warn', text: `Built in ${ctx.yearBuilt}: budget for electrical, plumbing and foundation surprises.` });
  if (r.spreadVsAsking !== null && r.spreadVsAsking < 0)
    out.push({ level: 'warn', text: `Seller's asking price is $${round(-r.spreadVsAsking).toLocaleString()} above the MAO. Negotiation needed before this works.` });
  if (r.spreadVsAsking !== null && r.spreadVsAsking > 0)
    out.push({ level: 'info', text: `Asking price is $${round(r.spreadVsAsking).toLocaleString()} below the MAO — room to raise your fee or offer more to win the deal.` });
  if (i.strategy === 'percent' && i.maoPct > 80) out.push({ level: 'warn', text: `Offer percentage of ${i.maoPct}% leaves thin buyer margins. Verify buyer demand at this price.` });
  if (n(i.assignmentFee) > i.arv * 0.15) out.push({ level: 'warn', text: 'Desired assignment fee exceeds 15% of ARV; buyers often push back on fees this large.' });
  if (n(i.holdingMonths) < 3) out.push({ level: 'info', text: 'Holding period under 3 months is aggressive for a rehab and resale.' });
  return out;
}
