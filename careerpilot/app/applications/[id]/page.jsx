import { notFound } from 'next/navigation';
import { getApplication } from '@/lib/queries.mjs';
import { A, Badge, Card, KV, PageHeader, Table, Td, Timeline, fmtDateTime, gmailLink } from '../../_ui/kit.jsx';
import { setApplicationStatus } from '../../actions.js';

export const dynamic = 'force-dynamic';

const NEXT = ['submitted', 'confirmed', 'assessment', 'interview', 'offer', 'rejected', 'withdrawn'];

export default async function ApplicationPage({ params }) {
  const data = await getApplication((await params).id);
  if (!data) notFound();
  const { app, emails, outreach, events } = data;
  const evidence = JSON.parse(app.evidence ?? '[]');
  const answers = JSON.parse(app.answers ?? '{}');
  return (
    <>
      <PageHeader title={`${app.title}`} sub={<><A to={`/companies/${encodeURIComponent(app.company)}`}>{app.company}</A> · <A to={`/jobs/${app.job_id}`}>job details</A></>}>
        <a href={app.url} target="_blank" rel="noopener noreferrer" className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white">Open posting ↗</a>
      </PageHeader>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Status">
            <div className="flex flex-wrap items-center gap-3">
              <Badge value={app.status} />
              {app.blocked_reason && <span className="text-sm text-ink-2">{app.blocked_reason}</span>}
            </div>
            <form action={setApplicationStatus} className="mt-4 flex flex-wrap items-end gap-2">
              <input type="hidden" name="id" value={app.id} />
              <label className="flex flex-col gap-1 text-xs text-ink-2">Update status
                <select name="status" className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink">
                  {NEXT.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="flex flex-1 flex-col gap-1 text-xs text-ink-2">Note / proof (e.g. “submitted on portal, ref #123”)
                <input name="note" className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink" />
              </label>
              <button className="rounded-md border border-line px-3 py-1.5 text-sm hover:border-accent">Save</button>
            </form>
          </Card>
          <Card title="Evidence">
            {evidence.length ? (
              <ul className="space-y-2 text-sm">{evidence.map((e, i) => (
                <li key={i} className="rounded-md bg-surface-2 px-3 py-2">
                  <Badge value={e.to} /> <span className="text-ink-2">{fmtDateTime(e.at)} · {e.type?.replace('_', ' ')}</span>
                  {e.subject && <div>“{e.subject}” from {e.from}</div>}
                  {e.recipient && <div>Sent to {e.recipient}</div>}
                  {e.url && <div><A to={e.url} external>confirmation page</A>{e.text && ` · “${e.text}”`}</div>}
                  {e.note && <div>{e.note}</div>}
                  {e.threadId && <A to={gmailLink(e.threadId)} external>Open in Gmail</A>}
                </li>
              ))}</ul>
            ) : <p className="text-sm text-ink-3">No submission evidence yet, so this is not counted as applied.</p>}
          </Card>
          <Card title="Emails" className="scroll-mt-20" >
            <div id="emails" />
            <Table head={['Received', 'From', 'Subject', 'Category', '']} empty="No emails linked yet.">
              {emails.map((e) => (
                <tr key={e.id}>
                  <Td className="whitespace-nowrap text-xs">{fmtDateTime(e.received_at)}</Td>
                  <Td className="text-xs">{e.from_name || e.from_addr}</Td>
                  <Td>{e.subject}<div className="text-xs text-ink-3">{e.snippet}</div></Td>
                  <Td><Badge value={e.category} /></Td>
                  <Td>{e.thread_id && <A to={gmailLink(e.thread_id)} external>Gmail</A>}</Td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card title="Outreach for this job">
            <Table head={['Date', 'To', 'Kind', 'Status', 'Replied']} empty="None.">
              {outreach.map((o) => (
                <tr key={o.id}><Td className="text-xs">{fmtDateTime(o.sent_at ?? o.created_at)}</Td><Td><A to={`/outreach/${o.id}`}>{o.name ?? o.email}</A></Td>
                  <Td>{o.kind}</Td><Td><Badge value={o.status} /></Td><Td className="text-xs">{fmtDateTime(o.replied_at)}</Td></tr>
              ))}
            </Table>
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Details">
            <KV items={[
              ['Method', app.method], ['Resume used', app.resume_version], ['Created', fmtDateTime(app.created_at)],
              ['Submitted', fmtDateTime(app.submitted_at)], ['Confirmed', fmtDateTime(app.confirmed_at)], ['Updated', fmtDateTime(app.updated_at)],
            ]} />
          </Card>
          {Object.keys(answers).length > 0 && (
            <Card title="Answer pack (verified facts only)">
              <KV items={Object.entries(answers).map(([k, v]) => [k.replace(/_/g, ' '), String(v)])} />
            </Card>
          )}
          <Card title="Audit trail"><Timeline events={events} /></Card>
        </div>
      </div>
    </>
  );
}
