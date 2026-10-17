import { getDb, all } from '@/lib/db.mjs';
import { pendingQuestions, systemStatus } from '@/lib/queries.mjs';
import { A, Badge, Card, PageHeader, Table, Td, fmtDateTime, gmailLink } from '../_ui/kit.jsx';

export const dynamic = 'force-dynamic';

export default async function Pending() {
  const db = await getDb();
  const [apps, appCount, review, unknown, upcoming, s, questions] = await Promise.all([
    all(db, `SELECT a.id, a.status, a.method, a.blocked_reason, j.title, j.company, j.url, j.score FROM applications a JOIN jobs j ON j.id = a.job_id
      WHERE a.status IN ('ready','blocked','failed') ORDER BY a.status = 'failed' DESC, j.score DESC LIMIT 100`),
    all(db, `SELECT count(*) n FROM applications WHERE status IN ('ready','blocked','failed')`),
    all(db, `SELECT * FROM emails WHERE needs_review = 1 AND reviewed = 0 ORDER BY received_at DESC LIMIT 50`),
    all(db, `SELECT o.id, o.subject, c.email FROM outreach o JOIN contacts c ON c.id = o.contact_id WHERE o.status = 'unknown'`),
    all(db, `SELECT * FROM emails WHERE category IN ('interview','assessment','offer') AND received_at >= ? ORDER BY received_at DESC`, [new Date(Date.now() - 14 * 864e5).toISOString()]),
    systemStatus(),
    pendingQuestions(),
  ]);
  const appTotal = Number(appCount[0].n);
  const problems = [
    s.gmail && !s.gmail.ok && ['Gmail authorization', s.gmail.error],
    ...Object.entries(s.runs).filter(([, r]) => r && !r.ok).map(([n, r]) => [`Stage “${n}” failed`, r.error]),
  ].filter(Boolean);
  return (
    <>
      <PageHeader title="Pending" sub="Everything that is waiting on you, most urgent first." />
      {problems.length > 0 && (
        <Card title="System problems" className="mb-4 border-bad">
          <ul className="space-y-1 text-sm">{problems.map(([t, e]) => <li key={t}><strong>{t}:</strong> <span className="text-ink-2">{e}</span></li>)}</ul>
        </Card>
      )}
      {questions.length > 0 && (
        <Card title="Questions blocking applications" className="mb-4">
          <p className="mb-2 text-sm text-ink-2">CareerPilot never guesses these. Each answer is given once and reused for every employer.</p>
          <ol className="space-y-1.5 text-sm">
            {questions.map((q) => (
              <li key={q.question} className="flex items-start justify-between gap-4">
                <span>{q.question}</span>
                <span className="shrink-0 text-xs text-ink-3">{q.applications} application{q.applications === 1 ? '' : 's'}</span>
              </li>
            ))}
          </ol>
        </Card>
      )}
      {unknown.length > 0 && (
        <Card title="Interrupted sends: check Gmail Sent before anything is retried" className="mb-4">
          <ul className="space-y-1 text-sm">{unknown.map((o) => <li key={o.id}><A to={`/outreach/${o.id}`}>{o.subject}</A> → {o.email}</li>)}</ul>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Interviews, assessments & offers (last 14 days): ${upcoming.length}`}>
          {upcoming.length ? (
            <ul className="space-y-2 text-sm">{upcoming.map((e) => {
              const x = JSON.parse(e.extracted ?? '{}');
              return (
                <li key={e.id}><Badge value={e.category} /> {e.application_id ? <A to={`/applications/${e.application_id}`}>{e.subject}</A> : e.subject}
                  <div className="text-xs text-ink-3">{fmtDateTime(e.received_at)}{x.dates?.length ? ` · mentions ${x.dates.join(', ')}` : ''}{x.deadline ? ` · ${x.deadline}` : ''} · <A to={gmailLink(e.thread_id)} external>Gmail</A></div></li>
              );
            })}</ul>
          ) : <p className="text-sm text-ink-3">Nothing scheduled.</p>}
        </Card>
        <Card title={`Emails needing review: ${review.length}`} action={<A to="/inbox?review=1">Open inbox</A>}>
          {review.length ? (
            <ul className="space-y-2 text-sm">{review.slice(0, 10).map((e) => <li key={e.id}><Badge value={e.category} /> {e.subject}<div className="text-xs text-ink-3">{e.from_addr}</div></li>)}</ul>
          ) : <p className="text-sm text-ink-3">All clear.</p>}
        </Card>
      </div>
      <h2 className="mb-2 mt-6 text-sm font-semibold text-ink-2">
        Applications waiting for you ({appTotal}){appTotal > apps.length && <> · showing the top {apps.length}, <A to="/applications?status=pending">see all</A></>}
      </h2>
      <Table head={['Role', 'Company', 'Status', 'What is needed', '']} empty="Nothing to submit right now.">
        {apps.map((a) => (
          <tr key={a.id} className="hover:bg-surface-2">
            <Td><A to={`/applications/${a.id}`}>{a.title}</A></Td>
            <Td>{a.company}</Td>
            <Td><Badge value={a.status} /></Td>
            <Td className="max-w-md text-xs text-ink-2">{a.blocked_reason}</Td>
            <Td><A to={a.url} external>Apply</A></Td>
          </tr>
        ))}
      </Table>
    </>
  );
}
