import { analytics } from '@/lib/queries.mjs';
import { A, Bars, Card, PageHeader, ROLE_LABELS, Table, Td, fmtNum, href, pct } from '../_ui/kit.jsx';

export const dynamic = 'force-dynamic';

function Breakdown({ rows, label, link }) {
  return (
    <Table head={[label, 'Qualified', 'Applied', 'Heard back', 'Response rate', 'Interviews', 'Interview rate']} empty="No data yet.">
      {rows.map((r) => (
        <tr key={r.k ?? 'none'} className="hover:bg-surface-2">
          <Td>{r.k ? <A to={link(r.k)}>{label === 'Role' ? ROLE_LABELS[r.k] ?? r.k : r.k}</A> : '—'}</Td>
          <Td className="tabular-nums">{fmtNum(r.qualified)}</Td>
          <Td className="tabular-nums">{fmtNum(r.applied)}</Td>
          <Td className="tabular-nums">{fmtNum(r.responded)}</Td>
          <Td className="tabular-nums">{pct(r.responded, r.applied)}</Td>
          <Td className="tabular-nums">{fmtNum(r.interviews)}</Td>
          <Td className="tabular-nums">{pct(r.interviews, r.applied)}</Td>
        </tr>
      ))}
    </Table>
  );
}

export default async function Analytics() {
  const a = await analytics();
  const f = a.funnel;
  const n = (v) => Number(v ?? 0);
  return (
    <>
      <PageHeader title="Analytics" sub="Response rate = applications with a human decision (assessment, interview, offer or rejection) ÷ applications submitted." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Funnel">
          <Bars rows={[
            { label: 'Discovered', value: n(f.discovered), to: '/jobs?status=all' },
            { label: 'Qualified', value: n(f.qualified), to: '/jobs?status=qualified', note: pct(n(f.qualified), n(f.discovered)) },
            { label: 'Prepared', value: n(f.prepared), to: '/applications' },
            { label: 'Applied', value: n(f.applied), to: '/applications?status=applied' },
            { label: 'Heard back', value: n(f.responded), to: '/applications?status=responded', note: pct(n(f.responded), n(f.applied)) },
            { label: 'Interviewed', value: n(f.interviewed), to: '/applications?status=interviewed', note: pct(n(f.interviewed), n(f.applied)) },
            { label: 'Offers', value: n(f.offers), to: '/applications?status=offer' },
          ]} />
        </Card>
        <Card title="Rates">
          <div className="grid grid-cols-2 gap-4">
            {[
              ['Response rate', pct(n(f.responded), n(f.applied)), '/applications?status=responded'],
              ['Interview rate', pct(n(f.interviewed), n(f.applied)), '/applications?status=interviewed'],
              ['Offer rate', pct(n(f.offers), n(f.applied)), '/applications?status=offer'],
              ['Outreach reply rate', pct(n(a.outreach.replied), n(a.outreach.sent)), '/outreach?replied=1'],
            ].map(([l, v, to]) => (
              <a key={l} href={to} className="tile tile-hover p-3">
                <div className="text-[12px] font-bold uppercase tracking-[0.08em]">{l}</div><div className="figure mt-1.5 text-[28px] leading-none">{v}</div>
              </a>
            ))}
          </div>
          <h3 className="kicker mb-2 mt-6 text-ink-2">Applications submitted per day (last 28 days)</h3>
          <Bars rows={a.weekly.map((w) => ({ label: w.d, value: n(w.n), to: '/applications?status=applied&sort=submitted' }))} />
          {!a.weekly.length && <p className="text-sm text-ink-3">None yet.</p>}
        </Card>
      </div>
      <h2 className="kicker mb-3 mt-10">By source</h2>
      <Breakdown rows={a.bySource} label="Source" link={(k) => href('/applications', { source: k, status: 'applied' })} />
      <h2 className="kicker mb-3 mt-10">By role</h2>
      <Breakdown rows={a.byRole} label="Role" link={(k) => href('/applications', { category: k, status: 'applied' })} />
      <h2 className="kicker mb-3 mt-10">By resume version</h2>
      <Table head={['Resume', 'Applied', 'Heard back', 'Response rate', 'Interviews']} empty="No submitted applications yet.">
        {a.byResume.map((r) => (
          <tr key={r.k}><Td><A to={href('/applications', { resume: r.k, status: 'applied' })}>{r.k}</A></Td><Td>{fmtNum(r.applied)}</Td><Td>{fmtNum(r.responded)}</Td>
            <Td>{pct(n(r.responded), n(r.applied))}</Td><Td>{fmtNum(r.interviews)}</Td></tr>
        ))}
      </Table>
    </>
  );
}
