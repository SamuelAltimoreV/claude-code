// Single source of truth for the relational data model. The database DDL, API validation,
// permissions and generic UI forms/tables are all derived from these definitions.

export type FieldType =
  | 'text' | 'long' | 'int' | 'num' | 'money' | 'pct' | 'bool' | 'date' | 'datetime'
  | 'select' | 'multi' | 'ref' | 'json' | 'email' | 'phone';

export interface Field {
  k: string;
  label: string;
  t: FieldType;
  ref?: string;                 // target entity for 'ref'
  cascade?: boolean;            // delete children with parent
  opts?: readonly string[];     // static options
  optsKey?: string;             // options resolved from org settings (e.g. 'sources')
  req?: boolean;
  group?: string;               // form section
  system?: boolean;             // maintained by the server, hidden from forms
  idx?: boolean;
  def?: unknown;
  help?: string;
}

export interface Entity {
  name: string;
  label: string;
  plural: string;
  resource: string;             // permission resource
  ownerField?: string;          // used for "own" scoped access
  fields: Field[];
  audit?: boolean;
  noDemoFlag?: boolean;
}

const F = (t: FieldType) => (k: string, label: string, x: Partial<Field> = {}): Field => ({ k, label, t, ...x });
const text = F('text'), long = F('long'), int = F('int'), num = F('num'), money = F('money'), pct = F('pct'),
  bool = F('bool'), date = F('date'), datetime = F('datetime'), json = F('json'), email = F('email'), phone = F('phone'), multi = F('multi');
const select = (k: string, label: string, opts: readonly string[] | string, x: Partial<Field> = {}): Field =>
  typeof opts === 'string' ? { k, label, t: 'select', optsKey: opts, ...x } : { k, label, t: 'select', opts, ...x };
const ref = (k: string, label: string, target: string, x: Partial<Field> = {}): Field => ({ k, label, t: 'ref', ref: target, idx: true, ...x });

export const PROPERTY_TYPES = ['Single Family', 'Multi-Family (2-4)', 'Multi-Family (5+)', 'Condo', 'Townhouse', 'Mobile Home', 'Land', 'Commercial', 'Other'] as const;
export const CONDITIONS = ['Excellent', 'Good', 'Fair', 'Poor', 'Distressed', 'Unknown'] as const;
export const OCCUPANCY = ['Owner Occupied', 'Tenant Occupied', 'Vacant', 'Unknown'] as const;
export const MOTIVATION = ['High', 'Medium', 'Low', 'Unknown'] as const;
export const TIMELINES = ['ASAP', 'Within 30 days', '1-3 months', '3-6 months', '6+ months', 'Unknown'] as const;
export const OFFER_STATUSES = ['Draft', 'Pending Approval', 'Presented', 'Accepted', 'Rejected', 'Countered', 'Expired', 'Withdrawn'] as const;
export const CONTRACT_STATUSES = ['Draft', 'Sent', 'Awaiting Signature', 'Fully Executed', 'Under Review', 'Assigned', 'Closing Pending', 'Closed', 'Terminated'] as const;
export const TXN_STATUSES = ['Under Contract', 'Title Opened', 'Marketing to Buyers', 'Buyer Found', 'Assigned', 'Clear to Close', 'Closed', 'Cancelled'] as const;
export const DISPO_STATUSES = ['Draft', 'Active', 'Buyer Selected', 'Assigned', 'Closed', 'Cancelled'] as const;
export const INTEREST_STATUSES = ['Matched', 'Sent', 'Opened', 'Responded', 'Requested Info', 'Showing Requested', 'Offer Made', 'Accepted', 'Rejected', 'Passed'] as const;
export const TASK_STATUSES = ['Open', 'In Progress', 'Done', 'Cancelled'] as const;
export const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'] as const;
export const COMM_TYPES = ['Call', 'SMS', 'Email', 'Voicemail', 'In Person'] as const;
export const BUYER_CLASSES = ['Active Buyer', 'Verified Buyer', 'Cash Buyer', 'Investor', 'Landlord', 'Flipper', 'Institutional Buyer', 'Inactive Buyer'] as const;
export const BUYER_STRATEGIES = ['Fix & Flip', 'Buy & Hold', 'BRRRR', 'Wholesale', 'New Construction', 'Any'] as const;
export const ROLES = ['Owner', 'Administrator', 'Acquisition Manager', 'Acquisition Representative', 'Disposition Manager', 'Disposition Representative', 'Transaction Coordinator', 'Viewer'] as const;
export type Role = typeof ROLES[number];

const consent: Field[] = [
  bool('dnc', 'Do not contact', { group: 'Compliance', help: 'Blocks all calls, texts and emails, including automations.' }),
  bool('sms_opt_in', 'SMS consent given', { group: 'Compliance' }),
  datetime('sms_opt_in_at', 'SMS consent timestamp', { group: 'Compliance', system: true }),
  bool('email_opt_in', 'Email consent given', { group: 'Compliance' }),
  datetime('email_opt_in_at', 'Email consent timestamp', { group: 'Compliance', system: true }),
  text('consent_source', 'Consent source', { group: 'Compliance', help: 'How consent was obtained (web form, verbal on call, written, ...)' }),
  datetime('opted_out_at', 'Opted out at', { group: 'Compliance', system: true }),
];

export const ENTITIES: Entity[] = [
  {
    name: 'markets', label: 'Market', plural: 'Markets', resource: 'settings', fields: [
      text('name', 'Market name', { req: true }), text('state', 'State'),
      multi('counties', 'Counties'), multi('cities', 'Cities'), multi('zips', 'ZIP codes'), multi('neighborhoods', 'Neighborhoods'),
      pct('mao_pct', 'Default MAO %', { help: 'Overrides the company default offer percentage for this market.' }),
      bool('active', 'Active', { def: true }),
    ],
  },
  {
    name: 'contacts', label: 'Seller', plural: 'Sellers', resource: 'leads', audit: true, fields: [
      text('first_name', 'First name', { req: true, group: 'Contact' }), text('last_name', 'Last name', { group: 'Contact' }),
      phone('phone', 'Phone', { group: 'Contact', idx: true }), phone('phone2', 'Secondary phone', { group: 'Contact' }),
      email('email', 'Email', { group: 'Contact', idx: true }),
      text('mailing_address', 'Mailing address', { group: 'Contact' }), text('mailing_city', 'City', { group: 'Contact' }),
      text('mailing_state', 'State', { group: 'Contact' }), text('mailing_zip', 'ZIP', { group: 'Contact' }),
      select('preferred_contact', 'Preferred contact method', ['Phone', 'SMS', 'Email', 'Mail'], { group: 'Contact' }),
      text('best_time', 'Best time to contact', { group: 'Contact' }),
      ...consent, long('notes', 'Notes', { group: 'Notes' }),
    ],
  },
  {
    name: 'properties', label: 'Property', plural: 'Properties', resource: 'properties', audit: true, fields: [
      text('address', 'Street address', { req: true, group: 'Location', idx: true }), text('city', 'City', { group: 'Location' }),
      text('state', 'State', { group: 'Location' }), text('zip', 'ZIP', { group: 'Location', idx: true }),
      text('county', 'County', { group: 'Location' }), text('neighborhood', 'Neighborhood', { group: 'Location' }),
      ref('market_id', 'Market', 'markets', { group: 'Location' }), text('parcel_id', 'Parcel ID', { group: 'Location' }),
      select('property_type', 'Property type', PROPERTY_TYPES, { group: 'Details' }),
      int('beds', 'Bedrooms', { group: 'Details' }), num('baths', 'Bathrooms', { group: 'Details' }),
      int('sqft', 'Square feet', { group: 'Details' }), num('lot_size', 'Lot size (acres)', { group: 'Details' }),
      int('year_built', 'Year built', { group: 'Details' }),
      select('condition', 'Condition', CONDITIONS, { group: 'Details' }), select('occupancy', 'Occupancy', OCCUPANCY, { group: 'Details' }),
      select('listing_status', 'Listing status', ['Off Market', 'Listed', 'Pending', 'Expired Listing', 'FSBO', 'Unknown'], { group: 'Details' }),
      text('owner_name', 'Owner of record', { group: 'Ownership' }),
      select('ownership_status', 'Ownership status', ['Sole Owner', 'Joint Owners', 'Estate / Heirs', 'Trust', 'LLC / Entity', 'Unknown'], { group: 'Ownership' }),
      money('est_value', 'Estimated as-is value', { group: 'Financials' }), money('arv', 'Estimated ARV', { group: 'Financials' }),
      money('repair_cost', 'Estimated repairs', { group: 'Financials' }), money('mortgage_balance', 'Mortgage balance', { group: 'Financials' }),
      text('mortgage_notes', 'Mortgage notes', { group: 'Financials' }),
      bool('tax_delinquent', 'Tax delinquent', { group: 'Financials' }), money('tax_owed', 'Taxes owed', { group: 'Financials' }),
      multi('indicators', 'Motivation indicators', { optsKey: 'tags', group: 'Indicators' }),
      long('notes', 'Notes', { group: 'Notes' }),
      text('data_source', 'Data source', { system: true, def: 'Manual entry' }),
    ],
  },
  {
    name: 'property_contacts', label: 'Ownership record', plural: 'Ownership records', resource: 'properties', fields: [
      ref('property_id', 'Property', 'properties', { req: true, cascade: true }), ref('contact_id', 'Seller', 'contacts', { req: true, cascade: true }),
      select('role', 'Role', ['Owner', 'Co-owner', 'Heir', 'Executor', 'Power of Attorney', 'Tenant', 'Other'], { def: 'Owner' }),
      text('notes', 'Notes'),
    ],
  },
  {
    name: 'campaigns', label: 'Campaign', plural: 'Campaigns', resource: 'marketing', fields: [
      text('name', 'Campaign name', { req: true }), select('source', 'Lead source', 'sources', { req: true }),
      ref('market_id', 'Market', 'markets'), money('budget', 'Budget'),
      date('start_date', 'Start date'), date('end_date', 'End date'),
      select('status', 'Status', ['Planned', 'Active', 'Paused', 'Completed'], { def: 'Active' }), long('notes', 'Notes'),
    ],
  },
  {
    name: 'leads', label: 'Lead', plural: 'Leads', resource: 'leads', ownerField: 'owner_id', audit: true, fields: [
      ref('contact_id', 'Seller', 'contacts', { req: true, group: 'Lead' }), ref('property_id', 'Property', 'properties', { group: 'Lead' }),
      select('stage', 'Pipeline stage', 'stages', { group: 'Lead', idx: true }),
      select('classification', 'Classification', 'leadStatuses', { group: 'Lead' }),
      ref('owner_id', 'Assigned to', 'users', { group: 'Lead' }),
      select('source', 'Lead source', 'sources', { group: 'Attribution' }), ref('campaign_id', 'Campaign', 'campaigns', { group: 'Attribution' }),
      multi('tags', 'Tags', { optsKey: 'tags', group: 'Lead' }),
      select('motivation', 'Motivation', MOTIVATION, { group: 'Seller situation' }),
      text('reason', 'Reason for selling', { group: 'Seller situation' }),
      money('asking_price', 'Desired sale price', { group: 'Seller situation' }),
      select('timeline', 'Expected timeline', TIMELINES, { group: 'Seller situation' }),
      select('negotiation', 'Willingness to negotiate', ['Flexible', 'Somewhat flexible', 'Firm', 'Unknown'], { group: 'Seller situation' }),
      select('decision_authority', 'Decision-making authority', ['Sole decision maker', 'Shared decision', 'Needs approval', 'Unknown'], { group: 'Seller situation' }),
      text('other_decision_makers', 'Other decision-makers', { group: 'Seller situation' }),
      long('financial_situation', 'Financial situation', { group: 'Seller situation', help: 'Only what the seller volunteered and is relevant to the sale.' }),
      long('circumstances', 'Seller circumstances', { group: 'Seller situation' }),
      money('est_fee', 'Projected assignment fee', { group: 'Lead' }),
      datetime('next_follow_up', 'Next follow-up', { system: true }),
      text('dead_reason', 'Dead reason', { group: 'Lead' }),
      int('score', 'Score', { system: true }), json('score_detail', 'Score detail', { system: true }),
      datetime('stage_changed_at', 'Stage changed', { system: true }), datetime('last_contact_at', 'Last contact', { system: true }),
      datetime('first_contact_at', 'First contact', { system: true }), datetime('contacted_at', 'Contacted', { system: true }),
      datetime('qualified_at', 'Qualified', { system: true }), datetime('offer_at', 'Offer made', { system: true }),
      datetime('contract_at', 'Under contract', { system: true }), datetime('closed_at', 'Closed', { system: true }),
      datetime('dead_at', 'Marked dead', { system: true }),
    ],
  },
  {
    name: 'analyses', label: 'Deal analysis', plural: 'Deal analyses', resource: 'offers', fields: [
      text('name', 'Scenario name', { req: true }), ref('property_id', 'Property', 'properties', { cascade: true }), ref('lead_id', 'Lead', 'leads'),
      json('inputs', 'Inputs'), json('results', 'Results'), text('rating', 'Rating'), money('mao', 'MAO'), money('offer_price', 'Offer price'),
    ],
  },
  {
    name: 'comps', label: 'Comparable sale', plural: 'Comparable sales', resource: 'properties', fields: [
      ref('property_id', 'Subject property', 'properties', { req: true, cascade: true }),
      text('address', 'Address', { req: true }), money('sale_price', 'Sale price', { req: true }), date('sale_date', 'Sale date'),
      int('sqft', 'Square feet'), int('beds', 'Beds'), num('baths', 'Baths'), num('distance', 'Distance (mi)'), text('notes', 'Notes'),
      text('source', 'Source', { system: true, def: 'Manual entry' }),
    ],
  },
  {
    name: 'offers', label: 'Offer', plural: 'Offers', resource: 'offers', audit: true, fields: [
      ref('property_id', 'Property', 'properties', { req: true }), ref('lead_id', 'Lead', 'leads'), ref('contact_id', 'Seller', 'contacts'),
      ref('analysis_id', 'Deal analysis', 'analyses'), ref('parent_id', 'Counter to offer', 'offers'),
      select('from_party', 'Offer from', ['Us', 'Seller'], { def: 'Us' }),
      money('amount', 'Offer amount', { req: true }), date('offer_date', 'Offer date'), date('expires_on', 'Expires'),
      date('closing_date', 'Desired closing date'), money('emd', 'Earnest money deposit'), money('fee_target', 'Assignment fee target'),
      select('status', 'Status', OFFER_STATUSES, { def: 'Draft', idx: true }),
      select('method', 'Offer method', ['In person', 'Phone', 'Email', 'Text', 'Mail', 'E-signature']),
      long('notes', 'Internal / negotiation notes'), ref('owner_id', 'Owner', 'users'),
    ],
  },
  {
    name: 'buyers', label: 'Buyer', plural: 'Buyers', resource: 'buyers', audit: true, fields: [
      text('name', 'Buyer name', { req: true, group: 'Contact' }), text('company', 'Company', { group: 'Contact' }),
      phone('phone', 'Phone', { group: 'Contact' }), email('email', 'Email', { group: 'Contact' }),
      select('preferred_contact', 'Preferred communication', ['Phone', 'SMS', 'Email'], { group: 'Contact' }),
      text('website', 'Website', { group: 'Contact' }), ref('rep_id', 'Buyer representative', 'users', { group: 'Contact' }),
      multi('classifications', 'Classification', { opts: BUYER_CLASSES, group: 'Profile' }),
      multi('groups', 'Buyer lists / groups', { optsKey: 'buyerGroups', group: 'Profile' }),
      select('strategy', 'Investment strategy', BUYER_STRATEGIES, { group: 'Criteria' }),
      multi('cities', 'Preferred cities', { group: 'Criteria' }), multi('zips', 'Preferred ZIP codes', { group: 'Criteria' }),
      multi('counties', 'Counties', { group: 'Criteria' }), multi('property_types', 'Property types', { opts: PROPERTY_TYPES, group: 'Criteria' }),
      int('min_beds', 'Minimum bedrooms', { group: 'Criteria' }),
      money('min_price', 'Minimum purchase price', { group: 'Criteria' }), money('max_price', 'Maximum purchase price', { group: 'Criteria' }),
      money('min_arv', 'Preferred ARV (min)', { group: 'Criteria' }), money('max_arv', 'Preferred ARV (max)', { group: 'Criteria' }),
      money('max_repairs', 'Maximum repair budget', { group: 'Criteria' }),
      money('fee_min', 'Assignment fee range (min)', { group: 'Criteria' }), money('fee_max', 'Assignment fee range (max)', { group: 'Criteria' }),
      select('financing', 'Financing type', ['Cash', 'Hard Money', 'Private Money', 'Conventional', 'Other'], { group: 'Criteria' }),
      select('pof_status', 'Proof of funds', ['Not Requested', 'Requested', 'Received', 'Verified', 'Expired'], { def: 'Not Requested', group: 'Profile' }),
      date('pof_verified_on', 'POF verified on', { group: 'Profile' }),
      ...consent, long('notes', 'Notes', { group: 'Notes' }),
    ],
  },
  {
    name: 'transactions', label: 'Transaction', plural: 'Transactions', resource: 'transactions', ownerField: 'coordinator_id', audit: true, fields: [
      ref('property_id', 'Property', 'properties', { req: true }), ref('lead_id', 'Lead', 'leads'), ref('contact_id', 'Seller', 'contacts'),
      ref('buyer_id', 'End buyer', 'buyers'), ref('coordinator_id', 'Transaction coordinator', 'users'),
      select('status', 'Status', TXN_STATUSES, { def: 'Under Contract', idx: true }),
      money('purchase_price', 'Contract purchase price'), money('assignment_price', 'Buyer price'), money('assignment_fee', 'Assignment fee'),
      text('title_company', 'Title company'), text('title_contact', 'Title contact'),
      date('closing_date', 'Scheduled closing'), date('closed_on', 'Closed on'),
      bool('emd_deposited', 'Our EMD deposited'), bool('buyer_emd_received', 'Buyer EMD received'),
      json('checklist', 'Checklist', { system: true }), long('notes', 'Notes'),
    ],
  },
  {
    name: 'contracts', label: 'Contract', plural: 'Contracts', resource: 'contracts', audit: true, fields: [
      select('type', 'Contract type', ['Purchase Agreement', 'Assignment Agreement', 'Double Close (B-C)', 'Other'], { req: true, def: 'Purchase Agreement' }),
      ref('property_id', 'Property', 'properties', { req: true }), ref('lead_id', 'Lead', 'leads'), ref('contact_id', 'Seller', 'contacts'),
      ref('buyer_id', 'Buyer', 'buyers'), ref('offer_id', 'From offer', 'offers'), ref('transaction_id', 'Transaction', 'transactions'),
      money('purchase_price', 'Purchase price'), money('assignment_price', 'Assignment price'), money('assignment_fee', 'Assignment fee'),
      money('emd', 'Earnest money deposit'),
      date('effective_date', 'Effective date'), date('inspection_end', 'Inspection period ends'), date('closing_date', 'Closing date'),
      text('title_company', 'Title company'),
      select('status', 'Status', CONTRACT_STATUSES, { def: 'Draft', idx: true }),
      bool('seller_signed', 'Seller signed'), bool('buyer_signed', 'Buyer signed'), bool('company_signed', 'Company signed'),
      long('contingencies', 'Important contingencies'), long('notes', 'Internal notes'),
    ],
  },
  {
    name: 'dispositions', label: 'Disposition', plural: 'Dispositions', resource: 'dispositions', audit: true, fields: [
      ref('property_id', 'Property', 'properties', { req: true }), ref('lead_id', 'Lead', 'leads'),
      ref('contract_id', 'Purchase contract', 'contracts'), ref('transaction_id', 'Transaction', 'transactions'),
      money('purchase_price', 'Contract purchase price'), money('asking_price', 'Asking assignment price', { req: true }),
      money('fee_target', 'Desired assignment fee'), long('summary', 'Deal summary'),
      select('status', 'Status', DISPO_STATUSES, { def: 'Active', idx: true }),
      ref('selected_buyer_id', 'Selected buyer', 'buyers'), ref('owner_id', 'Disposition owner', 'users'),
      date('started_on', 'Started'), date('ended_on', 'Ended', { system: true }),
    ],
  },
  {
    name: 'buyer_interests', label: 'Buyer interest', plural: 'Buyer interest', resource: 'dispositions', fields: [
      ref('disposition_id', 'Disposition', 'dispositions', { req: true, cascade: true }), ref('buyer_id', 'Buyer', 'buyers', { req: true, cascade: true }),
      select('status', 'Status', INTEREST_STATUSES, { def: 'Matched' }), int('match_score', 'Match score'),
      money('offer_amount', 'Offer amount'), money('emd', 'EMD'), date('proposed_close', 'Proposed closing'),
      long('feedback', 'Feedback'), text('channel', 'Channel'),
      datetime('sent_at', 'Sent at'), datetime('responded_at', 'Responded at'),
    ],
  },
  {
    name: 'revenue', label: 'Revenue record', plural: 'Revenue', resource: 'finance', audit: true, fields: [
      ref('transaction_id', 'Transaction', 'transactions'), money('amount', 'Amount', { req: true }), date('date', 'Date', { req: true }),
      select('type', 'Type', ['Assignment Fee', 'Double Close Profit', 'Other'], { def: 'Assignment Fee' }), text('notes', 'Notes'),
    ],
  },
  {
    name: 'expenses', label: 'Expense', plural: 'Expenses', resource: 'finance', audit: true, fields: [
      select('category', 'Category', ['Marketing', 'Operating'], { req: true, def: 'Operating' }), text('subcategory', 'Type'),
      ref('campaign_id', 'Campaign', 'campaigns'), money('amount', 'Amount', { req: true }), date('date', 'Date', { req: true }),
      text('vendor', 'Vendor'), text('notes', 'Notes'),
    ],
  },
  {
    name: 'communications', label: 'Communication', plural: 'Communications', resource: 'communications', ownerField: 'user_id', fields: [
      select('type', 'Type', COMM_TYPES, { req: true, def: 'Call' }), select('direction', 'Direction', ['Outbound', 'Inbound', 'Missed'], { def: 'Outbound' }),
      ref('contact_id', 'Seller', 'contacts'), ref('buyer_id', 'Buyer', 'buyers'), ref('lead_id', 'Lead', 'leads'), ref('property_id', 'Property', 'properties'),
      select('outcome', 'Outcome', 'callOutcomes'), int('duration_min', 'Duration (min)'),
      text('subject', 'Subject'), long('body', 'Notes / message'), datetime('at', 'Date & time', { idx: true }),
      ref('user_id', 'Team member', 'users'), text('next_action', 'Next action'), datetime('follow_up_at', 'Follow-up date'),
      select('status', 'Delivery', ['Logged', 'Queued', 'Sent', 'Failed'], { def: 'Logged', system: true }), text('provider', 'Provider', { system: true }),
    ],
  },
  {
    name: 'sequences', label: 'Follow-up sequence', plural: 'Follow-up sequences', resource: 'automations', fields: [
      text('name', 'Name', { req: true }), text('description', 'Description'), bool('active', 'Active', { def: true }), json('steps', 'Steps'),
    ],
  },
  {
    name: 'enrollments', label: 'Sequence enrollment', plural: 'Sequence enrollments', resource: 'leads', fields: [
      ref('sequence_id', 'Sequence', 'sequences', { req: true, cascade: true }), ref('lead_id', 'Lead', 'leads', { req: true, cascade: true }),
      select('status', 'Status', ['Active', 'Paused', 'Completed', 'Stopped'], { def: 'Active' }), int('step_index', 'Step', { def: 0 }),
      datetime('started_at', 'Started'), datetime('next_run_at', 'Next step at'), text('stop_reason', 'Reason'),
    ],
  },
  {
    name: 'tasks', label: 'Task', plural: 'Tasks', resource: 'tasks', ownerField: 'assignee_id', fields: [
      text('title', 'Task name', { req: true }), long('description', 'Description'),
      datetime('due_at', 'Due', { idx: true }), select('priority', 'Priority', PRIORITIES, { def: 'Normal' }),
      ref('assignee_id', 'Assigned to', 'users'), select('category', 'Category', 'taskCategories'),
      select('status', 'Status', TASK_STATUSES, { def: 'Open', idx: true }),
      ref('lead_id', 'Lead', 'leads', { group: 'Related record' }), ref('property_id', 'Property', 'properties', { group: 'Related record' }),
      ref('buyer_id', 'Buyer', 'buyers', { group: 'Related record' }), ref('offer_id', 'Offer', 'offers', { group: 'Related record' }),
      ref('contract_id', 'Contract', 'contracts', { group: 'Related record' }), ref('transaction_id', 'Transaction', 'transactions', { group: 'Related record' }),
      int('reminder_min', 'Remind before (minutes)'), datetime('completed_at', 'Completed', { system: true }),
      ref('enrollment_id', 'Sequence enrollment', 'enrollments', { system: true }), text('origin', 'Origin', { system: true }),
      bool('reminded', 'Reminded', { system: true }),
    ],
  },
  {
    name: 'activities', label: 'Activity', plural: 'Activities', resource: 'leads', noDemoFlag: false, fields: [
      text('type', 'Type', { req: true }), text('summary', 'Summary', { req: true }), long('body', 'Body'), json('data', 'Data'),
      ref('lead_id', 'Lead', 'leads', { cascade: true }), ref('property_id', 'Property', 'properties', { cascade: true }),
      ref('contact_id', 'Seller', 'contacts'), ref('buyer_id', 'Buyer', 'buyers', { cascade: true }),
      ref('transaction_id', 'Transaction', 'transactions', { cascade: true }), ref('disposition_id', 'Disposition', 'dispositions', { cascade: true }),
      ref('user_id', 'User', 'users'), datetime('at', 'At', { idx: true }),
    ],
  },
  {
    name: 'attachments', label: 'Attachment', plural: 'Attachments', resource: 'properties', fields: [
      text('name', 'File name', { req: true }), text('mime', 'Type'), int('size', 'Size'),
      select('category', 'Category', ['Photo', 'Contract', 'Proof of Funds', 'Title', 'Inspection', 'Other'], { def: 'Other' }),
      ref('lead_id', 'Lead', 'leads', { cascade: true }), ref('property_id', 'Property', 'properties', { cascade: true }),
      ref('contract_id', 'Contract', 'contracts', { cascade: true }), ref('transaction_id', 'Transaction', 'transactions', { cascade: true }),
      ref('buyer_id', 'Buyer', 'buyers', { cascade: true }),
    ],
  },
  {
    name: 'templates', label: 'Template', plural: 'Templates', resource: 'communications', fields: [
      text('name', 'Name', { req: true }), select('channel', 'Channel', ['SMS', 'Email', 'Call Script', 'Offer'], { req: true, def: 'SMS' }),
      text('subject', 'Subject'), long('body', 'Body', { req: true, help: 'Merge fields: {{first_name}} {{last_name}} {{property_address}} {{property_city}} {{agent_name}} {{company_name}} {{offer_amount}}' }),
    ],
  },
  {
    name: 'automations', label: 'Automation', plural: 'Automations', resource: 'automations', audit: true, fields: [
      text('name', 'Name', { req: true }), text('description', 'Description'), bool('enabled', 'Enabled', { def: true }),
      text('trigger', 'Trigger', { req: true }), json('trigger_config', 'Trigger config'), json('conditions', 'Conditions'), json('actions', 'Actions'),
    ],
  },
  {
    name: 'automation_runs', label: 'Automation run', plural: 'Automation runs', resource: 'automations', fields: [
      ref('automation_id', 'Automation', 'automations', { req: true, cascade: true }),
      text('status', 'Status'), text('trigger', 'Trigger'), text('subject', 'Subject'), json('context', 'Context'), json('steps', 'Steps'),
      text('error', 'Error'), text('dedupe', 'Dedupe key', { idx: true }), ref('retry_of', 'Retry of', 'automation_runs'),
      datetime('started_at', 'Started', { idx: true }), datetime('finished_at', 'Finished'),
    ],
  },
  {
    name: 'notifications', label: 'Notification', plural: 'Notifications', resource: 'self', ownerField: 'user_id', fields: [
      ref('user_id', 'User', 'users', { req: true, cascade: true }), text('title', 'Title', { req: true }), text('body', 'Body'),
      text('link', 'Link'), bool('read', 'Read'), text('dedupe', 'Dedupe key', { idx: true }),
    ],
  },
  {
    name: 'saved_views', label: 'Saved view', plural: 'Saved views', resource: 'self', ownerField: 'user_id', fields: [
      text('entity', 'Entity', { req: true }), text('name', 'Name', { req: true }), json('config', 'Config'), ref('user_id', 'User', 'users', { cascade: true }),
      bool('shared', 'Shared with team'),
    ],
  },
  {
    name: 'suppressions', label: 'Suppression', plural: 'Suppression list', resource: 'communications', audit: true, fields: [
      select('kind', 'Kind', ['Phone', 'Email'], { req: true, def: 'Phone' }), text('value', 'Phone or email', { req: true, idx: true }),
      text('reason', 'Reason'), text('source', 'Source', { def: 'Manual' }),
    ],
  },
  {
    name: 'webhooks', label: 'Webhook', plural: 'Webhooks', resource: 'integrations', audit: true, fields: [
      text('name', 'Name', { req: true }), select('direction', 'Direction', ['Outbound', 'Inbound'], { req: true, def: 'Outbound' }),
      text('url', 'Destination URL', { help: 'Outbound only' }), multi('events', 'Events'), text('token', 'Token', { system: true }),
      select('default_source', 'Lead source for inbound leads', 'sources'), bool('active', 'Active', { def: true }),
    ],
  },
  {
    name: 'integration_logs', label: 'Integration log', plural: 'Integration logs', resource: 'integrations', fields: [
      text('integration', 'Integration', { req: true, idx: true }), text('level', 'Level'), text('message', 'Message'), json('data', 'Data'),
    ],
  },
  {
    name: 'audit_logs', label: 'Audit log', plural: 'Audit log', resource: 'team', fields: [
      ref('user_id', 'User', 'users'), text('action', 'Action'), text('entity', 'Entity', { idx: true }), text('entity_id', 'Record'),
      text('summary', 'Summary'), json('changes', 'Changes'),
    ],
  },
];

export const ENTITY: Record<string, Entity> = Object.fromEntries(ENTITIES.map(e => [e.name, e]));

/** Custom field definition stored in org settings. */
export interface CustomField { key: string; label: string; type: 'text' | 'num' | 'date' | 'bool' | 'select'; options?: string[] }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizePhone(v: string): string {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

/** Validates & coerces a payload for an entity. Unknown keys are dropped. Returns errors keyed by field. */
export function validate(entity: Entity, input: Record<string, unknown>, opts: { partial?: boolean; includeSystem?: boolean } = {}) {
  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of entity.fields) {
    if (f.system && !opts.includeSystem) continue;
    let v = input[f.k];
    if (v === undefined) {
      if (!opts.partial) {
        if (f.req) errors[f.k] = `${f.label} is required`;
        else if (f.def !== undefined) out[f.k] = f.def;
        else if (f.t === 'multi') out[f.k] = [];
      }
      continue;
    }
    if (v === '' || v === null) {
      if (f.req) errors[f.k] = `${f.label} is required`;
      else out[f.k] = f.t === 'multi' ? [] : f.t === 'bool' ? false : null;
      continue;
    }
    switch (f.t) {
      case 'int': case 'num': case 'money': case 'pct': {
        const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
        if (!Number.isFinite(n)) { errors[f.k] = `${f.label} must be a number`; break; }
        if (f.t === 'money' && n < 0) { errors[f.k] = `${f.label} cannot be negative`; break; }
        v = f.t === 'int' ? Math.round(n) : n; out[f.k] = v; break;
      }
      case 'bool': out[f.k] = v === true || v === 'true' || v === 1; break;
      case 'email': {
        const s = String(v).trim().toLowerCase();
        if (!EMAIL_RE.test(s)) errors[f.k] = 'Enter a valid email address'; else out[f.k] = s; break;
      }
      case 'phone': {
        const s = String(v).trim();
        const d = normalizePhone(s);
        if (d.length < 10 || d.length > 15) errors[f.k] = 'Enter a valid phone number (10 digits)'; else out[f.k] = d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : s;
        break;
      }
      case 'date': {
        const s = String(v).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) errors[f.k] = `${f.label} must be a date`; else out[f.k] = s; break;
      }
      case 'datetime': {
        const t = Date.parse(String(v));
        if (isNaN(t)) errors[f.k] = `${f.label} must be a date and time`; else out[f.k] = new Date(t).toISOString(); break;
      }
      case 'multi': {
        const arr = Array.isArray(v) ? v : String(v).split(',');
        out[f.k] = [...new Set(arr.map(x => String(x).trim()).filter(Boolean))]; break;
      }
      case 'select':
        if (f.opts && !f.opts.includes(String(v))) errors[f.k] = `${f.label}: "${v}" is not a valid option`; else out[f.k] = String(v);
        break;
      case 'ref':
        if (!/^[0-9a-f-]{36}$/i.test(String(v))) errors[f.k] = `${f.label} is invalid`; else out[f.k] = String(v);
        break;
      case 'json': out[f.k] = v; break;
      default: {
        const s = String(v).trim();
        if (s.length > (f.t === 'long' ? 20000 : 500)) errors[f.k] = `${f.label} is too long`; else out[f.k] = s;
      }
    }
  }
  if (input.custom && typeof input.custom === 'object') out.custom = input.custom;
  return { data: out, errors, ok: Object.keys(errors).length === 0 };
}
