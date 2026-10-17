import { applicationPlaces, overview, systemStatus } from '@/lib/queries.mjs';
import { Badge, Card, KV, PageHeader, Stat, fmtDateTime, pct } from './_ui/kit.jsx';
import { logout } from './actions.js';
import { PlacesDonut, TopCompanies } from './_ui/places.jsx';

export const dynamic = 'force-dynamic';

export default async function Overview() {
  const [o, s, where] = await Promise.all([overview(), systemStatus(), applicationPlaces()]);
  return (
    <>
      <PageHeader title="Overview" sub="Every number opens the list it counts.">
        <form action={logout}><button className="text-sm text-ink-2 hover:text-ink">Sign out</button></form>
      </PageHeader>

      {o.pending > 0 && (
        <a href="/pending" className="mb-5 flex items-center justify-between rounded-xl border border-warn bg-warn-soft px-4 py-3 text-sm text-warn">
          <span><strong>{o.pending}</strong> items need your attention (applications to submit, emails to review).</span>
          <span>Open pending →</span>
        </a>
      )}

      <h2 className="mb-2 text-sm font-semibold text-ink-2">Pipeline</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Jobs tracked" value={o.discovered} to="/jobs?status=all" hint="All sources, duplicates merged" />
        <Stat label="Qualified" value={o.qualified} to="/jobs?status=qualified" hint={`${o.qualifiedHigh} with verified pay`} />
        <Stat label="Ready to apply" value={o.ready} to="/applications?status=ready" hint="Waiting for your submit" />
        <Stat label="Blocked" value={o.blocked} to="/applications?status=blocked" tone={o.blocked ? 'warn' : undefined} hint="Missing answers" />
        <Stat label="Applied" value={o.applied} to="/applications?status=applied" hint="Submission proven" />
        <Stat label="Confirmed" value={o.confirmed} to="/applications?status=confirmed" hint="Employer acknowledged" />
      </div>

      <h2 className="mb-2 text-sm font-semibold text-ink-2">Outcomes</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Assessments" value={o.assessment} to="/applications?status=assessment" />
        <Stat label="Interviews" value={o.interview} to="/applications?status=interview" tone={o.interview ? 'good' : undefined} />
        <Stat label="Offers" value={o.offer} to="/applications?status=offer" tone={o.offer ? 'good' : undefined} />
        <Stat label="Rejections" value={o.rejected} to="/applications?status=rejected" />
        <Stat label="Outreach sent" value={o.outreachSent} to="/outreach?status=sent" hint={`${pct(o.replies, o.outreachSent)} replied`} />
        <Stat label="Emails to review" value={o.review} to="/inbox?review=1" tone={o.review ? 'warn' : undefined} />
      </div>

      {where.total > 0 && (
        <>
          <h2 className="mb-2 text-sm font-semibold text-ink-2">Where your applications go</h2>
          <div className="mb-6 grid gap-4 lg:grid-cols-2">
            <Card title="By site"><PlacesDonut total={where.total} places={where.places} /></Card>
            <Card title="Top companies"><TopCompanies total={where.total} companies={where.companies} /></Card>
          </div>
        </>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Automation runs">
          <KV items={[
            ['Last run', s.last ? `${fmtDateTime(s.last.at)}${s.last.failed ? ' (with errors)' : ''}` : 'Never'],
            ...Object.entries(s.runs).map(([name, r]) => {
              const skipped = typeof r?.result?.skipped === 'string' ? r.result.skipped : null; // a stage's reason for not running
              return [name, r ? <span key={name}><Badge value={!r.ok ? 'failed' : skipped ? 'blocked' : 'qualified'}>{!r.ok ? 'failed' : skipped ? 'skipped' : 'ok'}</Badge> <span className="text-ink-3">{fmtDateTime(r.at)}</span>{skipped && <span className="text-ink-3"> · {skipped}</span>}{r.error && <span className="text-bad"> · {r.error}</span>}</span> : 'not run yet'];
            }),
          ]} />
        </Card>
        <Card title="Connections">
          <KV items={[
            ['Gmail', s.gmail ? (s.gmail.ok ? `Connected · synced ${fmtDateTime(s.gmailLastSync)}` : <span className="text-bad">{s.gmail.error}</span>) : 'Not authorized yet'],
            ['Job boards', `${s.boards?.enabled ?? 0} active (${s.boards?.discovered ?? 0} auto-discovered), ${s.boards?.failing ?? 0} failing`],
            ['Aggregator sweep', fmtDateTime(s.aggregator)],
            ...Object.entries(s.ai).map(([id, p]) => [`AI: ${id}`, !p.configured ? 'No key (optional)'
              : p.cooldownUntil && new Date(p.cooldownUntil) > new Date() ? <span className="text-warn">Paused until {fmtDateTime(p.cooldownUntil)} ({p.lastError})</span>
              : `Ready · ${p.model}${p.trainsOnData ? ' · public data only' : ''}`]),
          ]} />
        </Card>
      </div>
    </>
  );
}
