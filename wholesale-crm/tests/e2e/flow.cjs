const { chromium } = require('playwright');
const fs = require('fs');
// Browser end-to-end test of the full wholesale workflow.
// Run against a FRESH database:  DB_MEMORY=true npm start   then   npm run test:e2e
const B = process.env.APP_URL || 'http://localhost:8787', OUT = __dirname + '/shots/';
require('fs').mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log('✓', ...a);
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage(); global.PAGE = page;
  page.setDefaultTimeout(12000);
  const errors = []; process.on('exit', () => console.log(errors.length ? 'COLLECTED ERRORS:\n' + errors.join('\n') : 'NO CONSOLE/PAGE ERRORS'));
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && /Refused to|Content Security Policy/i.test(m.text())) errors.push('CSP ' + m.text().slice(0, 200)); });
  page.on('response', r => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  const f = (label, scope = page) => scope.getByRole('group', { name: label, exact: true }).locator('input, select, textarea').first();
  const toast = t => page.getByRole('status').getByText(t).first().waitFor();
  const dlg = () => page.getByRole('dialog').last();

  await page.goto(B + '/signup');
  await f('Company name').fill('Buckeye Home Buyers'); await f('Your name').fill('Sam Altimore'); await f('Work email').fill('sam@buckeye.example'); await f('Password').fill('demo-password-123');
  await page.click('button:has-text("Create workspace")'); await page.waitForSelector('text=Good', { timeout: 60000 });
  const rev0 = await page.locator('button:has-text("Revenue (period)") .tnum, div:has-text("Total revenue") >> .tnum').first().innerText();
  log('signed up with demo data; revenue card', rev0);

  // 1. New lead via quick action
  await page.click('header button:has-text("New")'); await page.click('[role=menuitem]:has-text("New lead")');
  let d = dlg();
  await f('First name', d).fill('Uma'); await f('Last name', d).fill('Testerson'); await f('Phone', d).fill('3305558801'); await f('Email', d).fill('uma@example.com');
  await f('Street address', d).fill('42 Flow Test Ln'); await f('City', d).fill('Canton'); await f('ZIP', d).fill('44708');
  await f('Property type', d).selectOption('Single Family'); await f('Condition', d).selectOption('Poor'); await f('Square feet', d).fill('1500'); await f('Estimated as-is value', d).fill('120000'); await f('Mortgage balance', d).fill('10000');
  await f('Lead source', d).selectOption('Referral'); await f('Motivation', d).selectOption('High'); await f('Expected timeline', d).selectOption('ASAP'); await f('Desired sale price', d).fill('85000');
  await d.getByRole('button', { name: 'Create lead' }).click();
  await page.waitForURL(/\/leads\/[0-9a-f-]{36}/); await page.waitForSelector('h1:has-text("Uma Testerson")');
  const leadUrl = page.url();
  await page.waitForSelector('text=Lead created from Referral');
  log('lead created via modal, timeline shows creation; score:', (await page.locator('text=Lead score').locator('..').innerText()).replace(/\n/g, ' '));
  // duplicate detection
  await page.click('header button:has-text("New")'); await page.click('[role=menuitem]:has-text("New lead")'); d = dlg();
  await f('First name', d).fill('Uma'); await f('Phone', d).fill('(330) 555-8801'); await d.getByRole('button', { name: 'Create lead' }).click();
  await d.getByText('Possible duplicate').waitFor(); log('duplicate seller detected in UI'); await page.keyboard.press('Escape');

  // 2. Log a call → auto-advance
  await page.click('button:has-text("Log call")'); d = dlg();
  await f('Outcome', d).selectOption('Interested'); await f('Notes / message', d).fill('Wants an offer. Roof leaks.'); await f('Duration (min)', d).fill('9');
  await d.getByRole('button', { name: 'Save to timeline' }).click(); await toast('Conversation logged');
  await page.waitForSelector('text=Outgoing call — Interested'); await page.waitForFunction(() => document.querySelector('select[aria-label="Pipeline stage"]')?.value === 'contacted');
  log('call logged; stage auto-advanced to Contacted');
  // 3. stage select → qualified (automation creates underwriting task)
  await page.selectOption('select[aria-label="Pipeline stage"]', 'qualified'); await toast('Moved to Qualified');
  await page.click('[role=tab]:has-text("Tasks")'); await page.waitForSelector('text=Underwrite 42 Flow Test Ln'); log('Qualified → underwriting task created by automation');
  // dead requires reason
  await page.selectOption('select[aria-label="Pipeline stage"]', 'dead'); await dlg().getByText('Reason (required)').waitFor(); await page.keyboard.press('Escape'); log('dead stage prompts for a reason');
  // 4. follow-up
  await page.click('button:has-text("Follow-up")'); d = dlg(); await d.getByRole('button', { name: 'Create task' }).click(); await toast('Task created'); log('follow-up scheduled');
  // note
  await page.click('[role=tab]:has-text("Timeline")'); await page.fill('textarea[placeholder^="Add an internal note"]', 'Seller mentioned a second lien.'); await page.click('button:has-text("Save note")'); await page.waitForSelector('text=Seller mentioned a second lien.'); log('note added to timeline');

  // 5. Analyzer
  await page.locator('main a:has-text("Analyze")').first().click(); await page.waitForURL(/analyzer\?property=/);
  await f('Estimated ARV').fill('190000'); await f('Estimated repairs').fill('40000');
  await page.waitForSelector('text=$83,000'); // 190000*.7 - 40000 - 10000
  log('analyzer MAO computed: $83,000 (70% rule)');
  await page.click('button:has-text("Hot market")'); await page.waitForSelector('text=$92,500'); await page.click('button:has-text("Standard (70%)")'); await page.waitForSelector('text=$83,000');
  await page.click('button:has-text("Cost-based")'); await page.waitForTimeout(200); const costMao = await page.locator('text=Maximum allowable offer').locator('..').locator('.text-3xl').innerText(); await page.click('button:has-text("% of ARV rule")');
  log('preset 75% → $92,500; cost-based MAO →', costMao);
  await f('Your offer (optional)').fill('80000');
  await page.click('button:has-text("Save analysis")'); d = dlg(); await d.getByRole('button', { name: 'Save' }).click(); await toast('Analysis saved'); log('analysis saved to property and lead');
  await page.screenshot({ path: OUT + 'flow-analyzer.png', fullPage: true });
  // 6. offer
  await page.click('button:has-text("Create offer")'); d = dlg(); await d.getByRole('button', { name: 'Create offer' }).click(); await toast('Offer created');
  await page.goto(B + '/offers'); await page.click('tr:has-text("42 Flow Test Ln")');
  await page.click('button:has-text("Mark presented")'); await toast('Offer marked Presented'); await page.click('button:has-text("Mark accepted")'); await toast('Offer marked Accepted'); log('offer presented → accepted');
  await page.screenshot({ path: OUT + 'flow-offer.png' });
  // 7. contract
  await page.click('button:has-text("Create contract")'); d = dlg(); await f('Title company', d).fill('Flow Title Co'); await d.getByRole('button', { name: 'Create contract' }).click(); await toast('Contract created');
  await page.goto(B + '/contracts'); await page.click('tr:has-text("42 Flow Test Ln")');
  await page.getByRole('switch', { name: /Seller/ }).click(); await page.waitForTimeout(500); await page.getByRole('switch', { name: 'Our company' }).click(); await toast('Contract is now Fully Executed'); log('signatures → contract Fully Executed');
  // 8. transaction + dispo
  await page.click('a:has-text("· Transaction")'); await page.waitForSelector('text=Closing checklist');
  await page.locator('label:has-text("Earnest money deposited") input').click(); await page.waitForSelector('text=1 of 11 done');
  await page.click('button:has-text("Start disposition")'); d = dlg(); await f('Asking assignment price', d).fill('96000'); await d.getByRole('button', { name: 'Create disposition' }).click(); await toast('Disposition created');
  await page.goto(B + '/dispositions'); await page.click('tr:has-text("42 Flow Test Ln")'); await page.waitForSelector('text=Buyer interest');
  const matched = await page.locator('tbody tr').count(); log('disposition opened; buyers auto-matched by automation:', matched);
  await page.locator('tbody tr').first().locator('button:has-text("Record offer")').click(); d = dlg(); await f('Offer amount', d).fill('94000'); await f('EMD', d).fill('3000'); await d.getByRole('button', { name: 'Save changes' }).click(); await toast('Buyer interest updated');
  await page.click('[role=tab]:has-text("Compare offers")'); await page.waitForSelector('text=$14,000'); await page.screenshot({ path: OUT + 'flow-compare.png' });
  await page.click('button:has-text("Select buyer")'); await dlg().getByRole('button', { name: 'Select buyer' }).click(); await toast('Buyer selected');
  await page.waitForURL(/contracts\?open=/); await page.waitForSelector('text=Assignment Agreement ·');
  await page.getByRole('switch', { name: /Buyer/ }).click(); await page.waitForTimeout(500); await page.getByRole('switch', { name: 'Our company' }).click(); await toast('Contract is now Fully Executed'); log('buyer selected → assignment agreement executed');
  await page.click('a:has-text("· Transaction")'); await page.waitForSelector('text=Closing checklist'); await page.waitForFunction(() => [...document.querySelectorAll('select')].some(s => s.value === 'Assigned')); await page.click('button:has-text("Close & record fee")'); await dlg().getByRole('button', { name: 'Close transaction' }).click(); await toast('Transaction closed and revenue recorded'); log('transaction closed, fee recorded');
  await page.goto(leadUrl); await page.waitForFunction(() => document.querySelector('select[aria-label="Pipeline stage"]')?.value === 'closed_won'); await page.waitForSelector('text=Deal closed — assignment fee $14,000 recorded'); log('lead is Closed Won; timeline shows the fee');
  await page.screenshot({ path: OUT + 'flow-lead-closed.png', fullPage: true });
  await page.goto(B + '/'); await page.waitForSelector('text=$56,000'); log('dashboard total revenue updated to $56,000 (was $42,000)');
  await page.click('button:has-text("Revenue (period)")'); await dlg().getByText('42 Flow Test Ln').waitFor(); log('metric drill-down lists the new deal'); await page.keyboard.press('Escape');

  // 9. pipeline drag & drop
  await page.goto(B + '/pipeline'); await page.waitForSelector('text=Russell Tran');
  const card = page.locator('[draggable=true]:has-text("Russell Tran")'), target = page.locator('div.w-\\[272px\\]:has-text("Attempting Contact")');
  await card.dragTo(target); await toast('Moved to Attempting Contact'); log('pipeline drag-and-drop moved a lead');
  // 10. tasks
  await page.goto(B + '/tasks'); await page.click('button:has-text("New task")'); d = dlg(); await f('Task name', d).fill('Flow test task'); await d.getByRole('button', { name: 'Create task' }).click(); await toast('Task created');
  await page.click('[role=tab]:has-text("Upcoming")'); await page.locator('li:has-text("Flow test task") input[type=checkbox]').click(); await page.waitForTimeout(800); await page.click('[role=tab]:has-text("Month")'); await page.waitForTimeout(400); await page.screenshot({ path: OUT + 'flow-calendar.png' }); log('task created, completed; calendar renders');
  // 11. automation builder
  await page.goto(B + '/automations'); await page.click('button:has-text("New automation")'); d = dlg(); await f('Name', d).fill('Flow: tag probate leads');
  await d.getByRole('button', { name: 'Add condition' }).click(); await d.locator('select').nth(2).selectOption('eq'); await d.locator('select').nth(3).selectOption('Probate List');
  await d.getByRole('button', { name: 'Add action' }).click(); await page.click('[role=menuitem]:has-text("Add tag")'); await f('Tag', d).fill('Probate'); await page.screenshot({ path: OUT + 'flow-builder.png' });
  await d.getByRole('button', { name: 'Save automation' }).click(); await toast('Automation saved'); log('automation built and saved');
  await page.click('[role=tab]:has-text("Execution history")'); await page.waitForSelector('tbody tr'); await page.locator('tbody tr').first().click(); await dlg().getByText('Automation run').waitFor(); await page.screenshot({ path: OUT + 'flow-run.png' }); await page.keyboard.press('Escape'); log('execution history opens a run');
  // 12. CSV import
  fs.writeFileSync(__dirname + '/import.csv', 'First Name,Last Name,Phone,Property Address,City,Zip\nCsv,Alpha,330-555-7711,9 Import Rd,Akron,44311\nCsv,Beta,330-555-7712,10 Import Rd,Akron,44311\n,NoName,330-555-7713,,,\n');
  await page.goto(B + '/leads'); await page.click('button:has-text("Import CSV")'); await page.setInputFiles('input[type=file]', __dirname + '/import.csv'); d = dlg(); await d.getByText('Map columns').waitFor();
  await d.getByRole('button', { name: /Import 3 rows/ }).click(); await d.getByText('Leads created').waitFor({ timeout: 30000 }); const res = (await d.innerText()).replace(/\n/g, ' ').slice(0, 120); log('CSV import result:', res); await d.getByRole('button', { name: 'Done' }).click();
  // 13. settings save + search
  await page.goto(B + '/settings?tab=analyzer'); await f('Default offer % of ARV').fill('68'); await page.click('button:has-text("Save changes")'); await toast('Settings saved'); log('settings saved');
  await page.click('text=Search or jump to'); await page.fill('input[placeholder^="Search sellers"]', 'testerson'); await page.waitForSelector('[role=dialog] button:has-text("Uma Testerson")'); log('global search finds the new seller'); await page.keyboard.press('Escape');
  // 14. remove demo data
  await page.goto(B + '/settings?tab=data'); await page.click('button:has-text("Remove all demo data")'); await dlg().getByRole('button', { name: 'Remove demo data' }).click(); await page.getByRole('status').getByText(/Removed \d+ demo records/).waitFor({ timeout: 30000 });
  await page.goto(B + '/leads'); await page.waitForSelector('text=Uma Testerson'); const n = await page.locator('tbody tr').count(); log('demo data removed; remaining real leads:', n, '| DEMO tags left:', await page.locator('text=DEMO').count());
  await page.goto(B + '/'); await page.waitForSelector('text=$14,000'); log('dashboard now reflects only real data ($14,000 revenue)');
  await browser.close();
})().catch(async e => { console.error('FLOW FAILED:', e.message.split('\n').slice(0, 6).join('\n')); try { await global.PAGE.screenshot({ path: OUT + 'FAIL.png' }); console.log('toasts:', await global.PAGE.getByRole('status').innerText()); } catch {} process.exit(1); });
