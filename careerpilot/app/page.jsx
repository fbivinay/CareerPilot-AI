import { applicationPlaces, overview, systemStatus, unconfirmed } from '@/lib/queries.mjs';
import { A, Badge, Card, KV, PageHeader, Stat, fmtDate, fmtDateTime } from './_ui/kit.jsx';
import { logout } from './actions.js';
import { PlacesDonut, TopCompanies } from './_ui/places.jsx';

export const dynamic = 'force-dynamic';

export default async function Overview() {
  const [o, s, where, waiting] = await Promise.all([overview(), systemStatus(), applicationPlaces(), unconfirmed()]);
  return (
    <>
      <PageHeader title="Overview" sub="Every number opens the list it counts.">
        <form action={logout}><button className="btn-ghost px-4 py-1.5 text-sm">Sign out</button></form>
      </PageHeader>

      {o.pending > 0 && (
        <a href="/pending" className="tile tile-hover mb-10 flex flex-wrap items-center justify-between gap-3 bg-yellow px-5 py-4">
          <span className="font-medium">
            <span className="figure mr-2 inline-block -rotate-2 rounded-[12px] border-[3px] border-ink bg-cream px-2.5 py-0.5 text-[22px] shadow-[3px_3px_0_var(--ink)]">{o.pending}</span>
            items need your attention (applications to submit, emails to review).
          </span>
          <span className="font-display font-extrabold">Open pending →</span>
        </a>
      )}

      <h2 className="kicker mb-3">Pipeline</h2>
      <div className="mb-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Jobs tracked" value={o.discovered} to="/jobs?status=all" hint="All sources, duplicates merged" />
        <Stat label="Qualified" value={o.qualified} to="/jobs?status=qualified" hint={`${o.applied} applied · ${o.qualified - o.applied} to apply`} />
        <Stat label="Ready to apply" value={o.ready} to="/applications?status=ready" hint="CareerPilot submits these" />
        <Stat label="Blocked" value={o.blocked} to="/applications?status=blocked" tone={o.blocked ? 'warn' : undefined} hint="Need you: CAPTCHA forms, answers" />
        <Stat label="Applied" value={o.applied} to="/applications?status=applied" hint="Submission proven" />
        <Stat label="Acknowledged" value={o.acknowledged} to="/applications?status=acknowledged" hint={`Employer replied · ${o.applied - o.acknowledged} not yet`} />
      </div>

      <h2 className="kicker mb-3">Outcomes <span className="ml-1 font-sans text-[12.5px] font-medium normal-case tracking-normal">· applications CareerPilot sent, and blocked ones you marked done</span></h2>
      <div className="mb-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Assessments" value={o.assessment} to="/applications?status=assessment" />
        <Stat label="Interviews" value={o.interview} to="/applications?status=interview" tone={o.interview ? 'good' : undefined} />
        <Stat label="Offers" value={o.offer} to="/applications?status=offer" tone={o.offer ? 'good' : undefined} />
        <Stat label="Rejections" value={o.rejected} to="/applications?status=rejected" />
      </div>

      {waiting.length > 0 && (
        <>
          <h2 className="kicker mb-3">No confirmation</h2>
          <Card title={`${waiting.length} submitted, not acknowledged by the employer yet`} className="mb-10">
            <ul className="divide-y divide-line text-sm">
              {waiting.map((a) => (
                <li key={a.id} className="flex items-baseline justify-between gap-3 py-1.5">
                  <span><A to={`/applications/${a.id}`}>{a.company}</A> <span className="text-ink-3">· {a.title}</span></span>
                  <span className="whitespace-nowrap text-xs text-ink-3">sent {fmtDate(a.submitted_at)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}

      {where.total > 0 && (
        <>
          <h2 className="kicker mb-3">Where your applications go</h2>
          <div className="mb-10 grid gap-6 lg:grid-cols-2">
            <Card title="By site"><PlacesDonut total={where.total} places={where.places} /></Card>
            <Card title="Top companies"><TopCompanies total={where.total} companies={where.companies} /></Card>
          </div>
        </>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
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
            ['Instant Gmail sync', !s.gmailWatch ? 'Off: every 30 minutes (SETUP.md, “Instant Gmail sync”)'
              : s.gmailWatch.error ? <span className="text-bad">Gmail refused the watch: {s.gmailWatch.error}</span>
              : s.gmailPush && !s.gmailPush.ok ? <span className="text-bad">GitHub refused to start the sync ({s.gmailPush.status}): renew GITHUB_DISPATCH_TOKEN</span>
              : `On until ${fmtDateTime(s.gmailWatch.expiration)}${s.gmailPush ? ` · last new mail ${fmtDateTime(s.gmailPush.at)}` : ''}`],
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
