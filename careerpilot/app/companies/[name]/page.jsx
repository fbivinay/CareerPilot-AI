import { companyView } from '@/lib/queries.mjs';
import { A, Badge, Card, PageHeader, Table, Td, fmtDate, fmtDateTime } from '../../_ui/kit.jsx';

export const dynamic = 'force-dynamic';

export default async function Company({ params }) {
  const name = decodeURIComponent((await params).name);
  const { jobs, apps, contacts, outreach } = await companyView(name);
  return (
    <>
      <PageHeader title={name} sub={`${jobs.length} tracked jobs · ${apps.length} applications · ${contacts.length} contacts`} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Jobs">
          <Table head={['Role', 'Status', 'Score', 'Found']} empty="No jobs.">
            {jobs.map((j) => <tr key={j.id}><Td><A to={`/jobs/${j.id}`}>{j.title}</A><div className="text-xs text-ink-3">{j.location}</div></Td><Td><Badge value={j.status} /></Td><Td>{j.score}</Td><Td className="text-xs">{fmtDate(j.first_seen)}</Td></tr>)}
          </Table>
        </Card>
        <div className="space-y-6">
          <Card title="Applications">
            <Table head={['Role', 'Status', 'Submitted']} empty="No applications.">
              {apps.map((a) => <tr key={a.id}><Td><A to={`/applications/${a.id}`}>{a.title}</A></Td><Td><Badge value={a.status} /></Td><Td className="text-xs">{fmtDate(a.submitted_at)}</Td></tr>)}
            </Table>
          </Card>
          <Card title="Contacts & outreach">
            <ul className="mb-3 space-y-1 text-sm">{contacts.map((c) => <li key={c.id}>{c.name ?? c.email} <span className="text-xs text-ink-3">{c.email} · {c.source_type.replace('_', ' ')}</span></li>)}</ul>
            <Table head={['Sent', 'Subject', 'Status']} empty="No outreach.">
              {outreach.map((o) => <tr key={o.id}><Td className="text-xs">{fmtDateTime(o.sent_at)}</Td><Td><A to={`/outreach/${o.id}`}>{o.subject}</A></Td><Td><Badge value={o.status} /></Td></tr>)}
            </Table>
          </Card>
        </div>
      </div>
    </>
  );
}
