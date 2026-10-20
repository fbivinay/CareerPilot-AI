import { notFound } from 'next/navigation';
import { getJob } from '@/lib/queries.mjs';
import { A, Badge, Card, DropButton, KV, PageHeader, ROLE_LABELS, Table, Td, Timeline, fmtComp, fmtDate, fmtDateTime, gmailLink } from '../../_ui/kit.jsx';
import { dropJobAction, setJobStatus, startApplication } from '../../actions.js';

export const dynamic = 'force-dynamic';

export default async function JobPage({ params }) {
  const data = await getJob((await params).id);
  if (!data) notFound();
  const { job, application, emails, outreach, events, duplicates, contacts } = data;
  const reasons = JSON.parse(job.match_reasons ?? '[]');
  return (
    <>
      <PageHeader title={job.title} sub={<><A to={`/companies/${encodeURIComponent(job.company)}`}>{job.company}</A> · {job.location || 'Location not stated'}</>}>
        <div className="flex flex-wrap items-start gap-3">
          <a href={job.url} target="_blank" rel="noopener noreferrer" className="btn-primary px-4 py-1.5 text-sm">Open original posting ↗</a>
          {application
            ? <a href={`/applications/${application.id}`} className="btn-ghost px-4 py-1.5 text-sm">Application: <Badge value={application.status} /></a>
            : <form action={startApplication}><input type="hidden" name="jobId" value={job.id} /><button className="btn-ghost px-4 py-1.5 text-sm">Track an application</button></form>}
          {job.status === 'qualified' && <form action={setJobStatus}><input type="hidden" name="id" value={job.id} /><input type="hidden" name="action" value="exclude" /><button className="btn-ghost px-4 py-1.5 text-sm hover:text-bad">Not interested</button></form>}
          {job.status !== 'duplicate' && (!application || ['ready', 'blocked', 'failed'].includes(application.status)) && <DropButton jobId={job.id} action={dropJobAction} />}
          {job.status === 'excluded' && <form action={setJobStatus}><input type="hidden" name="id" value={job.id} /><input type="hidden" name="action" value="reevaluate" /><button className="btn-ghost px-4 py-1.5 text-sm">Re-evaluate</button></form>}
        </div>
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Why this job">
            {job.exclusion_reason && <p className="mb-3 rounded-xl bg-surface-2 px-3 py-2 text-sm"><strong>Excluded:</strong> {job.exclusion_reason}</p>}
            <ul className="list-disc space-y-1 pl-5 text-sm">{reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            {job.ai_summary && <p className="mt-3 text-sm text-ink-2"><strong className="text-ink">AI fit {job.ai_score}/100:</strong> {job.ai_summary}</p>}
          </Card>
          <Card title="Job description">
            {job.description
              ? <div className="max-h-[32rem] overflow-auto whitespace-pre-wrap text-sm leading-relaxed text-ink-2">{job.description}</div>
              : <p className="text-sm text-ink-3">Not fetched yet. It arrives when the employer’s board is scanned; the original posting has it now.</p>}
          </Card>
          <Card title="Related emails">
            <Table head={['Received', 'Subject', 'Category', '']} empty="No emails linked to this job.">
              {emails.map((e) => (
                <tr key={e.id}><Td className="whitespace-nowrap text-xs">{fmtDateTime(e.received_at)}</Td><Td>{e.subject}</Td><Td><Badge value={e.category} /></Td>
                  <Td>{e.thread_id && <A to={gmailLink(e.thread_id)} external>Gmail</A>}</Td></tr>
              ))}
            </Table>
          </Card>
          <Card title="Outreach">
            <Table head={['Sent', 'To', 'Kind', 'Status']} empty="No outreach for this job.">
              {outreach.map((o) => (
                <tr key={o.id}><Td className="text-xs">{fmtDateTime(o.sent_at ?? o.created_at)}</Td><Td><A to={`/outreach/${o.id}`}>{o.name ?? o.email}</A></Td><Td>{o.kind}</Td><Td><Badge value={o.status} /></Td></tr>
              ))}
            </Table>
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="Details">
            <KV items={[
              ['Status', <Badge key="s" value={job.status} />],
              ['Confidence', <Badge key="c" value={job.confidence} />],
              ['Match score', job.score],
              ['Role', ROLE_LABELS[job.role_category]],
              ['Type', job.employment_type?.replace('_', '-')],
              ['Pay', fmtComp(job) ?? 'Not disclosed'],
              ['Experience', job.experience_min != null ? `${job.experience_min}${job.experience_max != null ? '–' + job.experience_max : '+'} years` : 'Not stated'],
              ['Posted', fmtDate(job.posted_at)],
              ['Deadline', job.deadline && fmtDate(job.deadline)],
              ['First seen', fmtDateTime(job.first_seen)],
              ['Last seen live', fmtDateTime(job.last_seen)],
              ['Closed', job.expired_at && fmtDateTime(job.expired_at)],
              ['Source', job.source],
              ['Duplicate of', job.duplicate_of && <A key="d" to={`/jobs/${job.duplicate_of}`}>canonical listing</A>],
              ['Repost of', job.repost_of && <A key="r" to={`/jobs/${job.repost_of}`}>earlier listing</A>],
            ]} />
            {duplicates.length > 0 && (
              <div className="mt-3 text-sm"><div className="text-ink-2">Also listed at</div>
                <ul className="mt-1 space-y-1">{duplicates.map((d) => <li key={d.id}><A to={d.url} external>{d.source}</A></li>)}</ul></div>
            )}
          </Card>
          <Card title="Contacts">
            {contacts.length ? (
              <ul className="space-y-2 text-sm">{contacts.map((c) => (
                <li key={c.id}>{c.name ?? c.email}<div className="text-xs text-ink-3">{c.email} · from {c.source_type.replace('_', ' ')}{c.opted_out ? ' · opted out' : ''}</div></li>
              ))}</ul>
            ) : <p className="text-sm text-ink-3">No published contact for this company yet. Outreach only uses addresses printed in postings or people who emailed you.</p>}
          </Card>
          <Card title="History"><Timeline events={events} /></Card>
        </div>
      </div>
    </>
  );
}
