// Automation builder vocabulary: triggers, condition fields and actions. The server engine executes these;
// the client builder renders its forms from the same definitions.

export interface ParamDef { k: string; label: string; type: 'text' | 'long' | 'number' | 'select' | 'stage' | 'user' | 'assignee' | 'template_sms' | 'template_email' | 'sequence' | 'tag' | 'classification' | 'category' | 'priority'; options?: string[]; optional?: boolean; def?: unknown; help?: string }
export interface TriggerDef { id: string; label: string; group: 'Leads' | 'Tasks' | 'Deals' | 'Time-based'; config?: ParamDef[]; timed?: boolean; describe: string }
export interface ActionDef { id: string; label: string; params: ParamDef[]; needs?: string; external?: 'sms' | 'email' }

export const TRIGGERS: TriggerDef[] = [
  { id: 'lead.created', label: 'New lead created', group: 'Leads', describe: 'Runs when a lead is added manually, by import or by an inbound webhook.' },
  { id: 'lead.stage_changed', label: 'Lead stage changed', group: 'Leads', config: [{ k: 'to', label: 'Moves to stage', type: 'stage', optional: true }, { k: 'from', label: 'Moves from stage', type: 'stage', optional: true }], describe: 'Runs when a lead moves between pipeline stages.' },
  { id: 'lead.assigned', label: 'Lead assigned', group: 'Leads', describe: 'Runs when a lead gets a new owner.' },
  { id: 'lead.score_updated', label: 'Lead score updated', group: 'Leads', config: [{ k: 'crosses', label: 'Score rises to at least', type: 'number', optional: true }], describe: 'Runs when a lead score changes; optionally only when it crosses a threshold.' },
  { id: 'task.completed', label: 'Task completed', group: 'Tasks', config: [{ k: 'category', label: 'Task category', type: 'category', optional: true }], describe: 'Runs when a task is marked done.' },
  { id: 'task.overdue', label: 'Task overdue', group: 'Time-based', timed: true, config: [{ k: 'hours', label: 'Overdue by at least (hours)', type: 'number', def: 1 }], describe: 'Checked every minute. Runs once per overdue task.' },
  { id: 'offer.submitted', label: 'Offer submitted', group: 'Deals', describe: 'Runs when an offer is marked Presented.' },
  { id: 'offer.accepted', label: 'Offer accepted', group: 'Deals', describe: 'Runs when an offer is marked Accepted.' },
  { id: 'contract.signed', label: 'Contract signed', group: 'Deals', describe: 'Runs when a purchase agreement becomes Fully Executed.' },
  { id: 'buyer.matched', label: 'Buyer matched', group: 'Deals', describe: 'Runs when buyers are matched to a disposition campaign.' },
  { id: 'dispo.created', label: 'Disposition campaign created', group: 'Deals', describe: 'Runs when a property enters disposition.' },
  { id: 'closing.approaching', label: 'Closing date approaching', group: 'Time-based', timed: true, config: [{ k: 'days', label: 'Days before closing', type: 'number', def: 3 }], describe: 'Checked every minute. Runs once per transaction when the closing date is within the window.' },
  { id: 'lead.inactive', label: 'Lead inactive for a period', group: 'Time-based', timed: true, config: [{ k: 'days', label: 'Days without activity', type: 'number', def: 7 }], describe: 'Checked every minute. Runs once per period of inactivity for active leads.' },
];

export interface ConditionField { id: string; label: string; type: 'select' | 'number' | 'text' | 'user' | 'stage' | 'bool'; optsKey?: string; options?: string[] }
export const CONDITION_FIELDS: ConditionField[] = [
  { id: 'source', label: 'Lead source', type: 'select', optsKey: 'sources' },
  { id: 'score', label: 'Lead score', type: 'number' },
  { id: 'property_type', label: 'Property type', type: 'text' },
  { id: 'city', label: 'City', type: 'text' }, { id: 'zip', label: 'ZIP code', type: 'text' }, { id: 'county', label: 'County', type: 'text' },
  { id: 'owner_id', label: 'Assigned user', type: 'user' },
  { id: 'stage', label: 'Pipeline stage', type: 'stage' },
  { id: 'classification', label: 'Lead status', type: 'select', optsKey: 'leadStatuses' },
  { id: 'deal_value', label: 'Deal value (projected fee)', type: 'number' },
  { id: 'motivation', label: 'Seller motivation', type: 'select', options: ['High', 'Medium', 'Low', 'Unknown'] },
  { id: 'has_follow_up', label: 'Has a follow-up scheduled', type: 'bool' },
  { id: 'tags', label: 'Tags include', type: 'select', optsKey: 'tags' },
];
export const OPERATORS: Record<string, { label: string; types: string[] }> = {
  eq: { label: 'is', types: ['select', 'number', 'text', 'user', 'stage', 'bool'] },
  neq: { label: 'is not', types: ['select', 'number', 'text', 'user', 'stage'] },
  gte: { label: 'is at least', types: ['number'] }, lte: { label: 'is at most', types: ['number'] },
  contains: { label: 'contains', types: ['text'] },
  empty: { label: 'is empty', types: ['select', 'text', 'user', 'number'] },
};
export interface Condition { field: string; op: string; value?: unknown }
export interface ActionStep { type: string; params: Record<string, any> }

const assignee: ParamDef = { k: 'assign', label: 'Assign to', type: 'assignee', def: 'owner' };
export const ACTIONS: ActionDef[] = [
  { id: 'create_task', label: 'Create task', params: [{ k: 'title', label: 'Task title', type: 'text', help: 'Merge fields allowed, e.g. Underwrite {{property_address}}' }, { k: 'category', label: 'Category', type: 'category', optional: true }, { k: 'dueInDays', label: 'Due in (days)', type: 'number', def: 1 }, { k: 'priority', label: 'Priority', type: 'priority', def: 'Normal' }, assignee] },
  { id: 'assign_lead', label: 'Assign lead', needs: 'lead', params: [{ k: 'assign', label: 'Assign to', type: 'assignee', def: 'round_robin:Acquisition Representative', help: 'Round robin picks the active team member with the fewest open leads.' }] },
  { id: 'update_lead', label: 'Update lead status', needs: 'lead', params: [{ k: 'stage', label: 'Move to stage', type: 'stage', optional: true }, { k: 'classification', label: 'Set lead status', type: 'classification', optional: true }] },
  { id: 'add_tag', label: 'Add tag', needs: 'lead', params: [{ k: 'tag', label: 'Tag', type: 'tag' }] },
  { id: 'notify', label: 'Notify team member', params: [{ ...assignee, label: 'Notify' }, { k: 'message', label: 'Message', type: 'text' }] },
  { id: 'create_transaction', label: 'Create transaction', needs: 'lead', params: [] },
  { id: 'add_note', label: 'Add internal note', needs: 'lead', params: [{ k: 'text', label: 'Note', type: 'long' }] },
  { id: 'schedule_followup', label: 'Schedule follow-up', needs: 'lead', params: [{ k: 'inDays', label: 'In (days)', type: 'number', def: 2 }, { k: 'onlyIfNone', label: 'Only if none is scheduled', type: 'select', options: ['yes', 'no'], def: 'yes' }] },
  { id: 'enroll_sequence', label: 'Start follow-up sequence', needs: 'lead', params: [{ k: 'sequenceId', label: 'Sequence', type: 'sequence' }] },
  { id: 'send_email', label: 'Send email (authorized integration)', needs: 'lead', external: 'email', params: [{ k: 'templateId', label: 'Email template', type: 'template_email' }] },
  { id: 'send_sms', label: 'Send SMS (authorized integration)', needs: 'lead', external: 'sms', params: [{ k: 'templateId', label: 'SMS template', type: 'template_sms' }] },
  { id: 'add_buyers_to_campaign', label: 'Add matching buyers to campaign', needs: 'disposition', params: [{ k: 'minScore', label: 'Minimum match score', type: 'number', def: 60 }] },
];

export interface SequenceStep { day: number; channel: 'Call' | 'SMS' | 'Email' | 'Task'; templateId?: string | null; note?: string }

export const WEBHOOK_EVENTS = ['lead.created', 'lead.stage_changed', 'lead.assigned', 'offer.submitted', 'offer.accepted', 'contract.signed', 'dispo.created', 'transaction.closed'];

export interface AutomationTemplate { name: string; description: string; trigger: string; trigger_config?: Record<string, any>; conditions?: Condition[]; actions: ActionStep[]; enabled?: boolean }
export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  { name: 'Speed to lead: call new leads within the hour', description: 'Creates an urgent call task for the owner the moment a lead arrives.', trigger: 'lead.created', enabled: true,
    actions: [{ type: 'create_task', params: { title: 'Call new lead: {{first_name}} {{last_name}}', category: 'Call seller', dueInDays: 0, priority: 'Urgent', assign: 'owner' } }] },
  { name: 'Round-robin unassigned leads', description: 'Assigns leads that arrive without an owner to the acquisition rep with the lightest workload.', trigger: 'lead.created', enabled: true,
    conditions: [{ field: 'owner_id', op: 'empty' }], actions: [{ type: 'assign_lead', params: { assign: 'round_robin:Acquisition Representative' } }] },
  { name: 'Qualified → underwriting kickoff', description: 'When a lead is qualified: create an underwriting task, notify the owner and make sure a follow-up exists.', trigger: 'lead.stage_changed', trigger_config: { to: 'qualified' }, enabled: true,
    actions: [
      { type: 'create_task', params: { title: 'Underwrite {{property_address}}', category: 'Underwrite property', dueInDays: 1, priority: 'High', assign: 'owner' } },
      { type: 'notify', params: { assign: 'owner', message: '{{first_name}} {{last_name}} is qualified — underwriting task created.' } },
      { type: 'schedule_followup', params: { inDays: 2, onlyIfNone: 'yes' } },
    ] },
  { name: 'Under contract → hand off to dispositions', description: 'Creates the transaction with its contract checklist, alerts the disposition team and queues title work.', trigger: 'lead.stage_changed', trigger_config: { to: 'under_contract' }, enabled: true,
    actions: [
      { type: 'create_transaction', params: {} },
      { type: 'notify', params: { assign: 'role:Disposition Manager', message: 'New deal under contract: {{property_address}}. Start a disposition campaign.' } },
      { type: 'create_task', params: { title: 'Open title for {{property_address}}', category: 'Coordinate closing', dueInDays: 1, priority: 'High', assign: 'role:Transaction Coordinator' } },
    ] },
  { name: 'Offer accepted → prepare contract', description: 'Creates a contract-preparation task as soon as the seller accepts.', trigger: 'offer.accepted', enabled: true,
    actions: [{ type: 'create_task', params: { title: 'Prepare and send purchase agreement for {{property_address}}', category: 'Review contract', dueInDays: 0, priority: 'Urgent', assign: 'owner' } }] },
  { name: 'New disposition → match buyers', description: 'Adds every buyer scoring 60+ against the deal to the campaign.', trigger: 'dispo.created', enabled: true,
    actions: [{ type: 'add_buyers_to_campaign', params: { minScore: 60 } }, { type: 'notify', params: { assign: 'role:Disposition Manager', message: 'Buyers matched for {{property_address}} — review and send the deal.' } }] },
  { name: 'Rescue stale leads', description: 'High-potential leads that go 7 days without activity get a follow-up task.', trigger: 'lead.inactive', trigger_config: { days: 7 }, enabled: true,
    conditions: [{ field: 'score', op: 'gte', value: 50 }], actions: [{ type: 'create_task', params: { title: 'Re-engage {{first_name}} — no activity in 7 days', category: 'Follow up', dueInDays: 0, priority: 'High', assign: 'owner' } }] },
  { name: 'Overdue task escalation', description: 'Tells acquisition managers when a task is more than a day overdue.', trigger: 'task.overdue', trigger_config: { hours: 24 }, enabled: true,
    actions: [{ type: 'notify', params: { assign: 'role:Acquisition Manager', message: 'Task overdue by 24h+: {{task_title}}' } }] },
  { name: 'Closing in 3 days checklist', description: 'Reminds the transaction coordinator to confirm title, funds and parties.', trigger: 'closing.approaching', trigger_config: { days: 3 }, enabled: true,
    actions: [{ type: 'create_task', params: { title: 'Confirm closing details for {{property_address}}', category: 'Coordinate closing', dueInDays: 0, priority: 'Urgent', assign: 'role:Transaction Coordinator' } }] },
  { name: 'Hot lead alert', description: 'Alerts acquisition managers when a lead score reaches 75+.', trigger: 'lead.score_updated', trigger_config: { crosses: 75 }, enabled: true,
    actions: [{ type: 'notify', params: { assign: 'role:Acquisition Manager', message: 'Hot lead: {{first_name}} {{last_name}} at {{property_address}} just scored 75+.' } }, { type: 'add_tag', params: { tag: 'Hot lead' } }] },
  { name: 'Welcome text for web leads (requires SMS integration + consent)', description: 'Sends the intro SMS template to website leads who opted in. Disabled until an SMS provider is connected.', trigger: 'lead.created', enabled: false,
    conditions: [{ field: 'source', op: 'eq', value: 'Website Form' }], actions: [{ type: 'send_sms', params: { templateId: null } }] },
];
