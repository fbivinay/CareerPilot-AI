import { notFound } from 'next/navigation';
import { getOutreach } from '@/lib/queries.mjs';
import { A, Badge, Card, KV, PageHeader, Timeline, fmtDateTime, gmailLink } from '../../_ui/kit.jsx';

export const dynamic = 'force-dynamic';

export default async function OutreachPage({ params }) {
  const data = await getOutreach((await params).id);
  if (!data) notFound();
  const { o, followups, events } = data;
  const messages = [o, ...followups];
  return (
    <>
      <PageHeader title={o.subject} sub={<>To {o.name ? `${o.name} <${o.email}>` : o.email}{o.company && <> · <A to={`/companies/${encodeURIComponent(o.company)}`}>{o.company}</A></>}</>}>
        {o.gmail_thread_id && <a href={gmailLink(o.gmail_thread_id)} target="_blank" rel="noopener noreferrer" className="btn-primary px-4 py-1.5 text-sm">Open thread in Gmail ↗</a>}
      </PageHeader>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {messages.map((m) => (
            <Card key={m.id} title={`${m.kind === 'followup' ? 'Follow-up' : m.kind === 'application' ? 'Email application' : 'Introduction'} · ${fmtDateTime(m.sent_at ?? m.created_at)}`} action={<Badge value={m.status} />}>
              {m.error && <p className="mb-2 text-sm text-bad">{m.error}</p>}
              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink-2">{m.body}</pre>
            </Card>
          ))}
        </div>
        <div className="space-y-6">
          <Card title="Details">
            <KV items={[
              ['Job', o.job_id && <A key="j" to={`/jobs/${o.job_id}`}>{o.title}</A>],
              ['Contact source', o.source_type?.replace('_', ' ')],
              ['Delivery', o.status === 'sent' ? 'Accepted by Gmail' : o.status],
              ['Replied', fmtDateTime(o.replied_at)],
              ['Follow-ups', followups.length],
            ]} />
          </Card>
          <Card title="Audit trail"><Timeline events={events} /></Card>
        </div>
      </div>
    </>
  );
}
