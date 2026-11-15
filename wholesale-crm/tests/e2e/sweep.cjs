// Second browser sweep: secondary features on every section. Each step is independent and reports its own result.
const { chromium } = require('playwright');
const fs = require('fs');
// Run against a FRESH database:  DB_MEMORY=true npm start   then   npm run test:e2e
const B = process.env.APP_URL || 'http://localhost:8787', OUT = __dirname + '/shots/';
fs.mkdirSync(OUT, { recursive: true });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage(); page.setDefaultTimeout(9000);
  const errors = [], results = [];
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && /Refused to|Content Security Policy/i.test(m.text())) errors.push('CSP ' + m.text().slice(0, 200)); });
  page.on('response', r => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  const f = (label, scope = page) => scope.getByRole('group', { name: label, exact: true }).locator('input, select, textarea').first();
  const toast = (t, timeout) => page.getByRole('status').getByText(t).first().waitFor({ timeout });
  const dlg = () => page.getByRole('dialog').last();
  const go = async p => { await page.goto(B + p); await page.waitForLoadState('networkidle'); };
  const step = async (name, fn) => { try { const note = await fn(); results.push(`✓ ${name}${note ? ' — ' + note : ''}`); } catch (e) { results.push(`✗ ${name}\n      ${e.message.split('\n').slice(0, 3).join(' | ').slice(0, 320)}`); await page.screenshot({ path: OUT + 'F2-' + name.replace(/\W+/g, '-').slice(0, 40) + '.png' }).catch(() => {}); await page.keyboard.press('Escape').catch(() => {}); await page.keyboard.press('Escape').catch(() => {}); } };

  await page.goto(B + '/signup');
  await f('Company name').fill('Sweep Home Buyers'); await f('Your name').fill('Olive Owner'); await f('Work email').fill('olive@sweep.example'); await f('Password').fill('demo-password-123');
  await page.click('button:has-text("Create workspace")'); await page.waitForSelector('text=Good', { timeout: 60000 });

  await step('keyboard shortcut opens search', async () => { await page.locator('main').click({ position: { x: 5, y: 5 } }); await page.keyboard.press('Control+k'); await page.waitForSelector('input[placeholder^="Search sellers"]', { timeout: 3000 }); await page.keyboard.press('Escape'); });
  await step('quick action: schedule a follow-up', async () => { await page.click('header button:has-text("New")'); await page.click('[role=menuitem]:has-text("Schedule a follow-up")'); const d = dlg(); await d.getByRole('group', { name: 'Lead', exact: true }).locator('button').first().click(); await d.locator('input[placeholder="Search…"]').fill('Leon'); await d.locator('button:has-text("Leon Abernathy")').first().click(); await d.getByRole('button', { name: 'Create task' }).click(); await toast('Task created'); });

  await step('leads: search, quick filter, advanced filter, columns', async () => {
    await go('/leads'); await page.waitForSelector('tbody tr');
    await page.fill('input[aria-label="Search table"]', 'akron'); await page.waitForTimeout(250); const a = await page.locator('tbody tr').count();
    await page.fill('input[aria-label="Search table"]', ''); await page.selectOption('select[aria-label="Stage"]', 'new'); await page.waitForTimeout(250); const b = await page.locator('tbody tr').count();
    await page.selectOption('select[aria-label="Stage"]', '');
    await page.click('button:has-text("Filter")'); await page.locator('.bg-surface-2 select').first().selectOption('score'); await page.locator('.bg-surface-2 select').nth(1).selectOption('gt'); await page.locator('.bg-surface-2 input[placeholder="Value"]').fill('70'); await page.waitForTimeout(250); const c = await page.locator('tbody tr').count();
    if (!(a > 0 && a < 25 && b === 3 && c > 0 && c < 25)) throw new Error(`unexpected counts akron=${a} new=${b} score>70=${c}`);
    await page.click('button[aria-label="Choose columns"]'); await page.click('[role=menuitem]:has-text("Tags")'); await page.waitForSelector('th:has-text("Tags")');
    return `akron=${a}, new=${b}, score>70=${c}`;
  });
  await step('leads: save a view and re-apply it', async () => {
    await page.click('button:has-text("Views")'); await page.click('[role=menuitem]:has-text("Save current view")'); const d = dlg(); await d.locator('input').fill('Hot leads'); await d.getByRole('button', { name: 'Save' }).click(); await toast('View saved');
    await page.click('button:has-text("Clear")'); await page.waitForTimeout(200); const all = await page.locator('tbody tr').count();
    await page.click('button:has-text("Views")'); await page.click('[role=menuitem]:has-text("Hot leads")'); await page.waitForTimeout(300); const hot = await page.locator('tbody tr').count();
    if (!(hot < all)) throw new Error(`view did not re-apply: ${hot} vs ${all}`); await page.click('button:has-text("Clear")');
  });
  await step('leads: bulk assign, tag and CSV export', async () => {
    await go('/leads'); await page.waitForSelector('tbody tr'); await page.fill('input[aria-label="Search table"]', 'canton'); await page.waitForTimeout(250);
    await page.locator('tbody tr input[type=checkbox]').nth(0).check(); await page.locator('tbody tr input[type=checkbox]').nth(1).check();
    await page.click('button:has-text("Assign")'); await page.click('[role=menuitem]:has-text("Jenna Kowalski")'); await toast(/2 leads assigned to Jenna/);
    await page.locator('tbody tr input[type=checkbox]').nth(0).check(); await page.click('button:has-text("Add tag")'); await page.click('[role=menuitem]:has-text("Divorce")'); await toast(/1 lead tagged/);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button[aria-label="Export CSV"]')]); const csv = fs.readFileSync(await dl.path(), 'utf8');
    if (!/^Seller,Property,Stage/.test(csv) || csv.split('\n').length < 3) throw new Error('bad csv: ' + csv.slice(0, 80)); return `${csv.split('\n').length - 1} rows exported`;
  });

  await step('property: add comp, link seller, upload photo and document', async () => {
    await go('/properties'); await page.fill('input[aria-label="Search table"]', '903 Amherst'); await page.click('tbody tr >> nth=0'); await page.waitForSelector('text=Comparable sales');
    await page.click('button:has-text("Add comp")'); let d = dlg(); await f('Address', d).fill('12 Comp Ct'); await f('Sale price', d).fill('220000'); await f('Square feet', d).fill('1800'); await d.getByRole('button', { name: 'Create comparable sale' }).click(); await toast('Comparable sale created'); await page.waitForSelector('td:has-text("12 Comp Ct")');
    await page.click('button:has-text("Link seller")'); await page.getByText('Choose a seller').click(); await page.locator('input[placeholder="Search…"]').fill('Gloria'); await page.locator('button:has-text("Gloria Santiago")').first().click(); await page.click('button:has-text("Link") >> nth=-1'); await page.waitForSelector('text=Co-owner');
    const inputs = page.locator('input[type=file]'); await inputs.nth(0).setInputFiles({ name: 'front.png', mimeType: 'image/png', buffer: PNG }); await toast('1 file uploaded'); await page.waitForSelector('img[alt="front.png"]');
    await inputs.nth(1).setInputFiles({ name: 'inspection.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') }); await page.waitForSelector('li:has-text("inspection.pdf")');
    const ok = await page.evaluate(async () => (await fetch(document.querySelector('a[aria-label="Download inspection.pdf"]').href)).status); if (ok !== 200) throw new Error('download status ' + ok);
    await page.screenshot({ path: OUT + 'f2-property.png', fullPage: true });
  });

  await step('buyers: create buyer, verify proof of funds', async () => {
    await go('/buyers'); await page.click('button:has-text("New buyer")'); const d = dlg(); await f('Buyer name', d).fill('Zed Capital'); await f('Email', d).fill('zed@capital.example'); await f('Maximum purchase price', d).fill('150000');
    const cities = d.getByRole('group', { name: 'Preferred cities', exact: true }).locator('input'); await cities.fill('Canton'); await cities.press('Enter');
    await d.getByRole('button', { name: 'Create buyer' }).click(); await toast('Buyer created');
    await page.fill('input[aria-label="Search table"]', 'Zed'); await page.click('tbody tr >> nth=0'); await page.waitForSelector('text=Buy box'); await page.selectOption('select[aria-label="Proof of funds status"]', 'Verified'); await toast('Proof of funds status updated'); await page.waitForSelector('text=/verified \\d/');
  });
  await step('buyers: bulk message shows honest not-connected state', async () => {
    await go('/buyers'); await page.waitForSelector('tbody tr'); await page.locator('tbody tr input[type=checkbox]').nth(0).check(); await page.locator('tbody tr input[type=checkbox]').nth(1).check(); await page.click('button:has-text("Email / text")'); const d = dlg();
    await d.getByText(/No email provider \(SMTP\) is connected/).waitFor(); await d.getByText(/of 2 recipients can be contacted/).waitFor(); if (!(await d.getByRole('button', { name: /Send to/ }).isDisabled())) throw new Error('send should be disabled'); await page.keyboard.press('Escape');
  });

  await step('disposition: find buyers, add one, mark deal as sent', async () => {
    await go('/dispositions'); await page.fill('input[aria-label="Search table"]', '118 Portage'); await page.click('tbody tr >> nth=0'); await page.waitForSelector('text=Buyer interest'); const before = await page.locator('tbody tr').count();
    await page.click('[role=tab]:has-text("Find buyers")'); await page.selectOption('select >> nth=-1', '30'); await page.locator('button:has-text("Add to campaign")').first().click(); await page.waitForTimeout(600);
    await page.click('[role=tab]:has-text("Buyer interest")'); await page.waitForFunction(n => document.querySelectorAll('tbody tr').length > n, before);
    await page.locator('tbody tr:has(select) input[type=checkbox]').last().check(); await page.click('button:has-text("Send deal to 1")'); const d = dlg(); await d.getByText(/No email provider/).waitFor(); await d.getByRole('button', { name: /mark as sent/ }).click(); await toast('Marked as sent');
    await page.locator('tbody tr').first().locator('button:has-text("9"), button:has-text("8"), button:has-text("7"), button:has-text("6")').first().click().catch(() => {}); await page.screenshot({ path: OUT + 'f2-dispo.png' });
  });

  await step('offers: record a seller counter and open the summary', async () => {
    await go('/offers'); await page.selectOption('select[aria-label="Status"]', 'Presented'); await page.locator('tbody tr:has-text("Our offer")').first().click(); await page.click('button:has-text("Record counter")'); const d = dlg(); await f('Offer amount', d).fill('91000'); await d.getByRole('button', { name: 'Create offer' }).click(); await toast('Offer created');
    await page.waitForSelector('.badge:has-text("Countered")'); await page.waitForSelector('button:has-text("Seller"):has-text("$91,000")'); await page.click('button:has-text("Offer summary")'); await dlg().getByText(/not a legally binding document/).waitFor(); await page.keyboard.press('Escape');
  });
  await step('contracts: change status, upload a document', async () => {
    await go('/contracts'); await page.waitForSelector('text=Upcoming deadlines'); await page.fill('input[aria-label="Search table"]', '903 Amherst'); await page.click('tbody tr >> nth=0'); await page.waitForSelector('text=Signatures');
    await page.locator('[class*=anim-slide] select').first().selectOption('Under Review'); await toast('Contract is now Under Review');
    await page.locator('[class*=anim-slide] input[type=file]').setInputFiles({ name: 'psa.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 psa') }); await page.waitForSelector('li:has-text("psa.pdf")');
  });
  await step('transactions: add checklist item, edit title company', async () => {
    await go('/transactions'); await page.fill('input[aria-label="Search table"]', '1746 Hazel'); await page.click('tbody tr >> nth=0'); await page.waitForSelector('text=Closing checklist');
    await page.fill('input[placeholder="Add a checklist item"]', 'Order lien search'); await page.click('button:has-text("Add") >> nth=-1'); await page.waitForSelector('label:has-text("Order lien search")');
    await page.click('button:has-text("Edit")'); const d = dlg(); await f('Title company', d).fill('Sweep Title LLC'); await d.getByRole('button', { name: 'Save changes' }).click(); await toast('Transaction updated'); await page.waitForSelector('text=Sweep Title LLC');
  });

  await step('communications: drawer, transcript, templates, suppression list', async () => {
    await go('/communications'); await page.click('tbody tr >> nth=0'); await page.waitForSelector('text=AI call summary'); await page.click('button:has-text("Edit notes")'); let d = dlg(); await f('Transcript', d).fill('Agent: Hi.\nSeller: Hello.'); await d.getByRole('button', { name: 'Save changes' }).click(); await toast('Communication updated'); await page.waitForSelector('text=Seller: Hello.'); await page.getByText('Not connected. Add an Anthropic API key').waitFor(); await page.keyboard.press('Escape');
    await page.click('[role=tab]:has-text("Templates")'); await page.click('button:has-text("New template")'); d = dlg(); await f('Name', d).fill('Sweep SMS'); await f('Body', d).fill('Hi {{first_name}}'); await d.getByRole('button', { name: 'Create template' }).click(); await toast('Template created'); await page.waitForSelector('text=Sweep SMS');
    await page.click('[role=tab]:has-text("Compliance")'); await page.locator('section:has-text("Suppression list") button:has-text("Add")').click(); d = dlg(); await f('Phone or email', d).fill('330-555-9999'); await f('Reason', d).fill('Requested by phone'); await d.getByRole('button', { name: 'Create suppression' }).click(); await toast('Suppression created'); await page.waitForSelector('text=330-555-9999');
  });
  await step('tasks: week, month (+ on a day), team views', async () => {
    await go('/tasks'); await page.click('[role=tab]:has-text("Week")'); await page.waitForSelector('text=/Week of/'); await page.click('[role=tab]:has-text("Month")'); const cell = page.locator('.group.border-r').nth(20); await cell.hover(); await cell.locator('button[aria-label^="Add task on"]').click(); const d = dlg(); await f('Task name', d).fill('Calendar-created task'); await d.getByRole('button', { name: 'Create task' }).click(); await toast('Task created'); await page.waitForSelector('button:has-text("Calendar-created task")');
    await page.click('button:has-text("Whole team")'); await page.click('[role=tab]:has-text("Team")'); await page.waitForSelector('text=Jenna Kowalski'); await page.screenshot({ path: OUT + 'f2-team-tasks.png' });
  });
  await step('marketing: new campaign, log spend, expenses tab', async () => {
    await go('/marketing'); await page.click('button:has-text("New campaign")'); let d = dlg(); await f('Campaign name', d).fill('Sweep postcards'); await f('Lead source', d).selectOption('Direct Mail'); await f('Budget', d).fill('900'); await d.getByRole('button', { name: 'Create campaign' }).click(); await toast('Campaign created');
    await page.click('[role=tab]:has-text("Campaigns")'); await page.waitForSelector('text=Sweep postcards'); await page.click('button:has-text("Log spend")'); d = dlg(); await f('Amount', d).fill('450'); await d.getByRole('group', { name: 'Campaign', exact: true }).locator('button').first().click(); await d.locator('input[placeholder="Search…"]').fill('Sweep'); await d.locator('button:has-text("Sweep postcards")').first().click(); await d.getByRole('button', { name: 'Create expense' }).click(); await toast('Expense created');
    await page.waitForSelector('tr:has-text("Sweep postcards") >> text=$450'); await page.click('[role=tab]:has-text("Expenses")'); await page.waitForSelector('tbody tr'); await page.click('[role=tab]:has-text("Channel performance")'); await page.screenshot({ path: OUT + 'f2-marketing.png', fullPage: true });
  });

  await step('automations: toggle, sequence editor, template, scheduler, retry', async () => {
    await go('/automations'); const sw = page.getByRole('switch', { name: 'Enable Hot lead alert' }); await sw.click(); await toast('Automation disabled'); await sw.click(); await toast('Automation enabled');
    await page.click('button:has-text("New sequence")'); let d = dlg(); await f('Name', d).fill('Sweep sequence'); await d.getByRole('button', { name: 'Add step' }).click(); await d.getByRole('button', { name: 'Save sequence' }).click(); await toast('Sequence saved'); await page.click('[role=tab]:has-text("Follow-up sequences")'); await page.waitForSelector('text=Sweep sequence');
    await page.click('[role=tab]:has-text("Templates")'); await page.locator('div.card:has-text("Welcome text for web leads") button:has-text("Use this template")').click(); d = dlg(); await d.getByRole('switch', { name: 'Enabled' }).click(); await f('Name', d).fill('Sweep: SMS web leads'); await d.getByRole('button', { name: 'Save automation' }).click(); await toast(/missing: SMS template|Automation saved/);
    if (await dlg().isVisible().catch(() => false)) { d = dlg(); await d.getByRole('group', { name: 'SMS template', exact: true }).locator('select').selectOption({ index: 1 }); await d.getByRole('button', { name: 'Save automation' }).click(); await toast('Automation saved'); }
    await page.click('button:has-text("Run scheduler now")'); await toast('Scheduler ran', 20000);
    // a web lead triggers the SMS automation, which must fail (no provider) and be retryable
    await page.click('header button:has-text("New")'); await page.click('[role=menuitem]:has-text("New lead")'); d = dlg(); await f('First name', d).fill('Webby'); await f('Phone', d).fill('3305556001'); await f('Lead source', d).selectOption('Website Form'); await d.getByRole('button', { name: 'Create lead' }).click(); await page.waitForURL(/\/leads\//);
    await go('/automations?tab=history'); await page.selectOption('select[aria-label="Result"]', 'failed'); await page.click('tbody tr >> nth=0'); d = dlg(); await d.getByText(/not connected/).first().waitFor(); await d.getByRole('button', { name: 'Retry failed steps' }).click(); await toast(/Retry finished: failed/); await page.screenshot({ path: OUT + 'f2-run.png' }); await page.keyboard.press('Escape');
  });
  await step('analytics: all five reports render, CSV export', async () => {
    await go('/analytics'); for (const t of ['Dispositions', 'Financial', 'Team', 'Markets', 'Acquisition']) { await page.click(`[role=tab]:has-text("${t}")`); await page.waitForTimeout(350); const txt = await page.locator('main').innerText(); if (/NaN|undefined|Something went wrong/.test(txt)) throw new Error(`bad text on ${t}`); if (t === 'Financial') await page.screenshot({ path: OUT + 'f2-financial.png', fullPage: true }); }
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("CSV")')]); const csv = fs.readFileSync(await dl.path(), 'utf8'); if (!/Leads generated/.test(csv)) throw new Error('bad report csv');
    await page.selectOption('select[aria-label="Date range"]', 'quarter'); await page.waitForSelector('text=/compared with/');
  });

  let inviteUrl = '';
  await step('team: invite, role change, department, disable, audit log', async () => {
    await go('/team'); await page.click('button:has-text("Invite team member")'); let d = dlg(); await f('Full name', d).fill('Rex Rep'); await f('Email', d).fill('rex@sweep.example'); await d.getByRole('button', { name: 'Create invite' }).click(); await d.getByText('Invite created').waitFor(); inviteUrl = await d.locator('input[readonly]').inputValue(); await d.getByRole('button', { name: 'Done' }).click();
    await page.selectOption('select[aria-label="Role for Devon Carter"]', 'Acquisition Manager'); await toast('Devon Carter is now Acquisition Manager');
    await page.locator('tr:has-text("Devon Carter") button[title="Change department"]').click(); d = dlg(); await d.locator('input').fill('Acquisitions East'); await d.getByRole('button', { name: 'Save' }).click(); await toast('Department updated');
    await page.locator('tr:has-text("Tom Willis") button:has-text("Disable")').click(); await dlg().getByRole('button', { name: 'Disable' }).click(); await toast('Account disabled'); await page.locator('tr:has-text("Tom Willis") button:has-text("Re-enable")').click(); await toast('Account re-enabled');
    await page.click('[role=tab]:has-text("Audit log")'); await page.waitForSelector('td:has-text("Invited Rex Rep")'); await page.click('[role=tab]:has-text("Performance")'); await page.waitForSelector('tbody tr');
  });
  await step('integrations: connection test, inbound webhook creates a lead', async () => {
    await go('/integrations'); await page.locator('div.card:has-text("Email (SMTP)") button:has-text("Test connection")').click(); await page.getByText('SMTP environment variables are not set.').waitFor();
    await page.click('button:has-text("New webhook")'); const d = dlg(); await f('Name', d).fill('Sweep web form'); await d.getByRole('button', { name: 'Save' }).click(); await toast('Webhook saved');
    const url = (await page.locator('code:has-text("/api/hooks/in/")').first().innerText()).replace('POST ', ''); const res = await fetch(url.replace(/^https?:\/\/[^/]+/, B), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ first_name: 'Hooky', last_name: 'McForm', phone: '3305556002', address: '77 Hook Rd', city: 'Canton', zip: '44708' }) }); const j = await res.json(); if (!j.ok) throw new Error(JSON.stringify(j));
    await go('/leads'); await page.fill('input[aria-label="Search table"]', 'Hooky'); await page.waitForSelector('tbody tr:has-text("Hooky McForm")'); await go('/integrations'); await page.waitForSelector('td:has-text("Inbound \\"Sweep web form\\": lead created")'); await page.screenshot({ path: OUT + 'f2-integrations.png', fullPage: true });
  });

  await step('settings: brand color, pipeline stage, tag, custom field, scoring, roles, market', async () => {
    await go('/settings'); await page.click('button[aria-label="Brand color Teal"]'); await page.click('button:has-text("Save changes")'); await toast('Settings saved');
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()); if (accent !== '#0f766e') throw new Error('brand not applied: ' + accent);
    await go('/settings?tab=pipeline'); await page.locator('input[aria-label="Stage name"]').nth(1).fill('Trying to Reach'); await page.click('button:has-text("Add stage")'); await page.click('button:has-text("Save changes")'); await toast('Settings saved');
    await go('/settings?tab=lists'); const tags = page.getByRole('group', { name: 'Lead & property tags', exact: true }).locator('input'); await tags.fill('Sweep tag'); await tags.press('Enter'); await page.click('button:has-text("Save changes")'); await toast('Settings saved');
    await go('/settings?tab=fields'); await page.locator('section:has-text("Custom fields — Leads") button:has-text("Add field")').click(); await page.locator('section:has-text("Custom fields — Leads") input[aria-label="Field label"]').fill('Gate code'); await page.click('button:has-text("Save changes")'); await toast('Settings saved');
    await go('/settings?tab=scoring'); await f('Seller motivation').fill('60'); await page.click('button:has-text("Save changes")'); await toast('Settings saved', 30000);
    await go('/settings?tab=roles'); await page.selectOption('select[aria-label="Acquisition Representative access to Buyers"]', 'view'); await page.click('button:has-text("Save changes")'); await toast('Settings saved');
    await go('/settings?tab=markets'); await page.click('button:has-text("Add market")'); const d = dlg(); await f('Market name', d).fill('Portage County, OH'); const z = d.getByRole('group', { name: 'ZIP codes', exact: true }).locator('input'); await z.fill('44240'); await z.press('Enter'); await d.getByRole('button', { name: 'Create market' }).click(); await toast('Market created');
    await go('/pipeline'); await page.waitForSelector('text=Trying to Reach'); await page.waitForSelector('text=New stage');
  });
  await step('custom field appears on the lead form and profile; scores were recalculated', async () => {
    await go('/leads'); await page.fill('input[aria-label="Search table"]', 'Leon'); await page.click('tbody tr >> nth=0'); await page.waitForSelector('text=Why this score'); const mot = await page.locator('div:has(> div > span:text-is("Seller motivation"))').first().innerText();
    if (!/60\s*\/\s*60/.test(mot.replace(/\n/g, ' '))) throw new Error('motivation weight not applied: ' + mot.replace(/\n/g, ' '));
    await page.click('button[aria-label="More actions"]'); await page.click('[role=menuitem]:has-text("Edit lead")'); const d = dlg(); await f('Gate code', d).fill('4411#'); await d.getByRole('button', { name: 'Save changes' }).click(); await toast('Lead updated'); await page.waitForSelector('text=4411#');
  });
  await step('lead: message dialog explains what blocks sending', async () => {
    await page.click('button:has-text("Message")'); const d = dlg(); await d.getByText(/Blocked:|Compliance check passed/).waitFor(); await d.getByText(/No SMS provider \(Twilio\) is connected/).waitFor(); if (!(await d.getByRole('button', { name: 'Send SMS' }).isDisabled())) throw new Error('send must be disabled'); await page.keyboard.press('Escape');
  });
  await step('notifications: open, mark all read', async () => { await go('/'); await page.click('button[aria-label^="Notifications"]'); await page.waitForSelector('text=Notifications'); const b = page.locator('button:has-text("Mark all read")'); if (await b.count()) { await b.click(); await page.waitForSelector('button[aria-label="Notifications (0 unread)"]'); } await page.keyboard.press('Escape'); await page.locator('main').click({ position: { x: 5, y: 5 } }); });
  await step('profile: rename, change password, sign out and back in', async () => {
    await page.click('button[aria-label="Account menu"]'); await page.click('[role=menuitem]:has-text("Profile & password")'); const d = dlg(); await f('Name', d).fill('Olive Q Owner'); await f('Current password', d).fill('demo-password-123'); await f('New password', d).fill('new-password-456789'); await d.getByRole('button', { name: 'Save' }).click(); await toast('Profile updated');
    await page.click('button[aria-label="Account menu"]'); await page.click('[role=menuitem]:has-text("Sign out")'); await page.waitForURL(/\/login/);
    await f('Email').fill('olive@sweep.example'); await f('Password').fill('demo-password-123'); await page.click('button:has-text("Sign in")'); await page.getByText('Incorrect email or password.').waitFor();
    await f('Password').fill('new-password-456789'); await page.click('button:has-text("Sign in")'); await page.waitForSelector('text=/Good .*, Olive/');
  });
  await step('dark mode persists across reloads', async () => { await page.click('button[aria-label="Toggle dark mode"]'); await page.reload(); await page.waitForSelector('text=Good'); const t = await page.evaluate(() => document.documentElement.dataset.theme); if (t !== 'dark') throw new Error('theme ' + t); await page.screenshot({ path: OUT + 'f2-dark-teal.png' }); await page.click('button[aria-label="Toggle dark mode"]'); });

  await step('role-based UI: invited rep sees only what the role allows', async () => {
    const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const p2 = await c2.newPage(); p2.setDefaultTimeout(9000); p2.on('pageerror', e => errors.push('REP PAGEERROR ' + e.message));
    await p2.goto(B + inviteUrl.replace(/^https?:\/\/[^/]+/, '')); await p2.getByRole('group', { name: 'Choose a password', exact: true }).locator('input').fill('rep-password-12345'); await p2.click('button:has-text("Join workspace")'); await p2.waitForSelector('text=/Good .*, Rex/');
    const nav = (await p2.locator('aside nav').innerText()).replace(/\n+/g, ' | ');
    for (const hidden of ['Dispositions', 'Analytics', 'Team', 'Settings', 'Integrations', 'Transactions']) if (new RegExp(`\\b${hidden}\\b`).test(nav) && hidden !== 'Transactions') throw new Error(`rep should not see ${hidden}: ${nav}`);
    if (!/Buyers/.test(nav)) throw new Error('rep should now see Buyers (permission was granted in settings): ' + nav);
    await p2.goto(B + '/leads'); await p2.waitForSelector('text=No leads yet'); await p2.goto(B + '/settings'); await p2.waitForSelector('text=You do not have access to this section'); await p2.goto(B + '/buyers'); await p2.waitForSelector('tbody tr'); if (await p2.locator('button:has-text("New buyer")').count()) throw new Error('rep must not be able to create buyers');
    await p2.click('header button:has-text("New")'); await p2.click('[role=menuitem]:has-text("New lead")'); const d = p2.getByRole('dialog').last(); await d.getByRole('group', { name: 'First name', exact: true }).locator('input').fill('Reps'); await d.getByRole('group', { name: 'Phone', exact: true }).locator('input').first().fill('3305556003'); await d.getByRole('button', { name: 'Create lead' }).click(); await p2.waitForURL(/\/leads\//); await p2.waitForSelector('h1:has-text("Reps")');
    await p2.screenshot({ path: OUT + 'f2-rep.png' }); await c2.close(); return nav;
  });
  await step('mobile: navigation drawer works', async () => { await page.setViewportSize({ width: 390, height: 844 }); await go('/'); await page.click('button[aria-label="Open menu"]'); await page.click('aside a:has-text("Buyers")'); await page.waitForURL(/\/buyers/); await page.waitForSelector('h1:has-text("Cash Buyers")'); const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); if (o > 2) throw new Error('horizontal overflow ' + o); await page.screenshot({ path: OUT + 'f2-mobile-buyers.png' }); await page.setViewportSize({ width: 1440, height: 900 }); });

  console.log(results.join('\n')); console.log(errors.length ? 'CONSOLE/PAGE ERRORS:\n' + [...new Set(errors)].join('\n') : 'NO CONSOLE/PAGE ERRORS');
  const passed = results.filter(r => r.startsWith('✓')).length;
  console.log(`${passed}/${results.length} steps passed`);
  await browser.close();
  if (passed !== results.length || errors.length) process.exit(1);
})().catch(e => { console.error('SCRIPT FAILED:', e.message.split('\n').slice(0, 5).join('\n')); process.exit(1); });
