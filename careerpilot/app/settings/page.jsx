import { getDb } from '@/lib/db.mjs';
import { getSettings } from '@/lib/settings.mjs';
import { systemStatus } from '@/lib/queries.mjs';
import { Card, KV, PageHeader, fmtDateTime } from '../_ui/kit.jsx';
import { updateSettings } from '../actions.js';
import { CONNECT_ERRORS, connectionStatus } from '@/lib/gmail-oauth.mjs';
import { GmailPanel } from './gmail-panel.jsx';

export const dynamic = 'force-dynamic';

function Field({ name, label, value, hint, type = 'number', step }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-ink-2">{label}</span>
      <input name={name} type={type} step={step} defaultValue={value} required={type === 'number'} className="field" />
      {hint && <span className="text-xs text-ink-3">{hint}</span>}
    </label>
  );
}

function Toggle({ name, label, checked, hint }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" name={name} defaultChecked={checked} className="mt-0.5 size-[17px] shrink-0 cursor-pointer accent-pink" />
      <span>{label}{hint && <span className="block text-xs text-ink-3">{hint}</span>}</span>
    </label>
  );
}

export default async function Settings({ searchParams }) {
  const { saved, gmail: gmailNotice, gmail_error: gmailError } = await searchParams;
  const s = await getSettings(await getDb());
  const status = await systemStatus();
  const readOnly = process.env.DASHBOARD_READONLY === '1';
  return (
    <>
      <PageHeader title="Settings" sub="Changes apply on the next scheduled run; stored jobs are re-scored automatically when rules change." />
      <div id="gmail" className="mb-8 scroll-mt-24">
        <Card title="Gmail">
          <GmailPanel status={await connectionStatus(await getDb())} notice={gmailNotice} error={Object.hasOwn(CONNECT_ERRORS, gmailError ?? '') ? CONNECT_ERRORS[gmailError] : null} />
        </Card>
      </div>
      {saved && <p className="tile mb-8 bg-teal px-4 py-2.5 text-sm font-semibold">Saved.</p>}
      {readOnly && <p className="tile mb-8 bg-yellow px-4 py-2.5 text-sm font-semibold">This deployment is read-only. Change settings from your local dashboard.</p>}
      <form action={updateSettings} className="grid gap-6 lg:grid-cols-2">
        <Card title="Compensation (applied only when the posting discloses pay)">
          <div className="grid grid-cols-2 gap-3">
            <Field name="fullTimeMinLpa" label="Full-time minimum (LPA)" value={s.compensation.fullTimeMinLpa} step="0.5" />
            <Field name="internshipMinMonthly" label="Internship minimum (₹/month)" value={s.compensation.internshipMinMonthly} step="1000" />
          </div>
        </Card>
        <Card title="Matching">
          <div className="grid grid-cols-3 gap-3">
            <Field name="qualifyScore" label="Qualify at score" value={s.matching.qualifyScore} />
            <Field name="autoActionScore" label="Automate at score" value={s.matching.autoActionScore} hint="Email applications/outreach" />
            <Field name="maxExperienceYears" label="Max years required" value={s.matching.maxExperienceYears} step="0.5" />
          </div>
          <div className="mt-3"><Toggle name="includeInternships" label="Include internships" checked={s.matching.includeInternships} /></div>
        </Card>
        <Card title="Locations">
          <Field type="text" name="primary" label="Preferred city names (comma separated)" value={s.locations.primary.join(', ')} />
          <div className="mt-3"><Field type="text" name="india" label="Other accepted Indian locations" value={s.locations.india.join(', ')} hint="Anything outside these and India is excluded." /></div>
        </Card>
        <Card title="Automation">
          <div className="space-y-2">
            <Toggle name="emailApplications" label="Send applications to employer-published application emails" checked={s.automation.emailApplications} />
            <Toggle name="portalApplications" label="Submit applications on employer Workday sites" checked={s.automation.portalApplications} hint="Questions your profile does not answer stop that application and are listed for you." />
            <Toggle name="outreach" label="Email verified recruiting contacts from postings" checked={s.automation.outreach} />
            <Toggle name="followUps" label="Send follow-ups when there is no reply" checked={s.automation.followUps} />
            <Toggle name="actOnUndisclosedComp" label="Act on jobs whose pay is not disclosed" checked={s.automation.actOnUndisclosedComp} hint="Off = only jobs with verified pay get automatic emails." />
          </div>
        </Card>
        <Card title="Safety limits">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field name="outreachPerDay" label="Outreach per day" value={s.limits.outreachPerDay} />
            <Field name="emailApplicationsPerDay" label="Email applications per day" value={s.limits.emailApplicationsPerDay} />
            <Field name="portalApplicationsPerDay" label="Portal applications per day" value={s.limits.portalApplicationsPerDay} />
            <Field name="perCompanyCooldownDays" label="Company cooldown (days)" value={s.limits.perCompanyCooldownDays} />
            <Field name="maxContactsPerCompany" label="Contacts per company" value={s.limits.maxContactsPerCompany} />
            <Field name="followUpAfterDays" label="Follow up after (days)" value={s.limits.followUpAfterDays} />
            <Field name="maxFollowUps" label="Max follow-ups" value={s.limits.maxFollowUps} />
            <Field name="startHour" label="Send from (IST hour)" value={s.limits.sendWindow.startHour} step="0.5" />
            <Field name="endHour" label="Send until (IST hour)" value={s.limits.sendWindow.endHour} step="0.5" />
          </div>
          <p className="mt-2 text-xs text-ink-3">Sends happen Monday–Friday. Raise volumes gradually (for example +5/day per week) while replies and bounces stay healthy.</p>
        </Card>
        <Card title="AI providers (free tiers only)">
          <Field type="text" name="aiOrder" label="Fallback order" value={s.ai.order.join(', ')} hint="groq, gemini, openrouter" />
          <div className="mt-3"><Field name="maxCallsPerHour" label="Max AI calls per hour" value={s.ai.maxCallsPerHour} /></div>
          <div className="mt-3">
            <KV items={Object.entries(status.ai).map(([id, p]) => [id, `${p.configured ? 'key set' : 'no key'} · ${p.model} · ${p.trainsOnData ? 'may train on prompts: public job data only' : 'no training: may see resume facts and emails'}${p.lastError ? ` · last error: ${p.lastError}` : ''}`])} />
          </div>
        </Card>
        <Card title="Schedule">
          <KV items={[
            ['GitHub Actions', 'Every 3 hours (may start late or be skipped under load)'],
            ['Last run', fmtDateTime(status.last?.at)],
            ['Aggregator sweep', 'Once a day'],
          ]} />
        </Card>
        <div className="lg:col-span-2">
          <button disabled={readOnly} className="btn-primary px-6 py-2.5">Save settings</button>
        </div>
      </form>
    </>
  );
}
