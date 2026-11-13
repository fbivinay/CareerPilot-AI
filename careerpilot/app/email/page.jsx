import { getDb, kvGet } from '@/lib/db.mjs';
import { dispatchWorkflow } from '@/lib/gmail-oauth.mjs';
import { resumeBulkIfDue } from '@/lib/outreach.mjs';
import { sentEmails } from '@/lib/queries.mjs';
import { BulkSend } from './bulk-send.jsx';
import { A, Badge, Filters, PageHeader, Pager, Stat, Table, Td, fmtDateTime, gmailLink, href, pct } from '../_ui/kit.jsx';

export const dynamic = 'force-dynamic';

// A reply in the colour of the application status it matches; any other reply is just "Replied".
const REPLY = { rejection: ['rejected', 'Rejected'], interview: ['interview', 'Interview'], assessment: ['assessment', 'Assessment'],
  offer: ['offer', 'Offer'], bounce: ['failed', 'Bounced'] };

export default async function Email({ searchParams }) {
  const params = await searchParams;
  const db = await getDb();
  const dispatch = async () => (process.env.GITHUB_DISPATCH_TOKEN ? dispatchWorkflow('careerpilot-bulk.yml') : null);
  const [{ rows, total, page, counts: c }, template, queue, last, assessments] = await Promise.all([sentEmails(params), kvGet(db, 'outreach:template'),
    kvGet(db, 'bulk:queue', []), resumeBulkIfDue(db, dispatch), kvGet(db, 'assessments')]);
  const to = (patch) => href('/email', {}, patch);
  return (
    <>
      <PageHeader title="Email" sub="Job emails you and CareerPilot sent, and the replies they got. Every number opens the list it counts." />

      <h2 className="kicker mb-3">Send your email</h2>
      <BulkSend subject={template?.subject} pending={queue.length} last={last} />

      <h2 className="kicker mb-3">Sent</h2>
      <div className="mb-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Job emails sent" value={c.all} to="/email" hint="One per conversation" />
        <Stat label="Actually reached" value={c.reached} to={to({ reply: 'reached' })} hint="Sent, not bounced" tone="good" />
        <Stat label="Sent today" value={c.today} to={to({ when: 'today' })} hint="Reached today" />
        <Stat label="Replied" value={c.replied} to={to({ reply: 'replied' })} hint={`${pct(c.replied, c.all)} of sent`} />
        <Stat label="No reply yet" value={c.none} to={to({ reply: 'none' })} />
        <Stat label="Bounced" value={c.bounce} to={to({ reply: 'bounce' })} tone={c.bounce ? 'bad' : undefined} hint="Address did not exist" />
      </div>

      <h2 className="kicker mb-3">Replies</h2>
      <div className="mb-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Assessments" value={(assessments?.items ?? []).filter((a) => a.tier === 'sure').length} to="#assessments"
          hint="From all of Gmail, not only replies" />
        <Stat label="Interviews" value={c.interview} to={to({ reply: 'interview' })} tone={c.interview ? 'good' : undefined} />
        <Stat label="Offers" value={c.offer} to={to({ reply: 'offer' })} tone={c.offer ? 'good' : undefined} />
        <Stat label="Rejections" value={c.rejection} to={to({ reply: 'rejection' })} />
        <Stat label="Other replies" value={c.other} to={to({ reply: 'other' })} hint="Answers and acknowledgements" />
      </div>

      <Assessments data={assessments} />

      <Filters base="/email" params={params} fields={[
        { name: 'by', label: 'Sent by', options: [['', 'Anyone'], ['you', 'You'], ['careerpilot', 'CareerPilot']] },
        { name: 'when', label: 'When', options: [['', 'Any time'], ['today', 'Today']] },
        { name: 'reply', label: 'Reply', options: [['', 'All'], ['reached', 'Actually reached'], ['replied', 'Replied'], ['none', 'No reply yet'], ['assessment', 'Assessment'],
          ['interview', 'Interview'], ['offer', 'Offer'], ['rejection', 'Rejection'], ['other', 'Other reply'], ['bounce', 'Bounced']] },
      ]} />
      <Table head={['Sent', 'By', 'To', 'Subject', 'Reply']} empty="No job emails yet.">
        {rows.map((r) => {
          const [tone, label] = REPLY[r.reply?.category] ?? ['confirmed', 'Replied'];
          return (
            <tr key={r.id} className="hover:bg-surface-2">
              <Td className="whitespace-nowrap text-xs">{fmtDateTime(r.sent_at)}</Td>
              <Td><Badge value={r.by === 'you' ? 'qualified' : 'sent'}>{r.by === 'you' ? 'You' : 'CareerPilot'}</Badge></Td>
              <Td>
                {r.to_name || r.to_addr}
                {r.to_name && <div className="text-xs text-ink-3">{r.to_addr}</div>}
                {r.company && <div className="text-xs text-ink-3">{r.company}</div>}
              </Td>
              <Td className="max-w-md">
                {r.by === 'careerpilot' ? <A to={`/outreach/${r.id}`}>{r.subject}</A> : r.subject}
                {r.followups > 0 && <span className="text-xs text-ink-3"> · {r.followups} follow-up{r.followups === 1 ? '' : 's'}</span>}
                {r.thread_id && <div className="text-xs"><A to={gmailLink(r.thread_id)} external>Open in Gmail</A></div>}
              </Td>
              <Td className="text-xs">
                {r.reply ? <>
                  <Badge value={tone}>{label}</Badge> {r.reply.at && <span className="text-ink-3">{fmtDateTime(r.reply.at)}</span>}
                  {r.reply.from && <div className="text-ink-3">{r.reply.from}</div>}
                  {r.reply.snippet && <div className="mt-1 max-w-xs text-ink-2 line-clamp-3" title={r.reply.snippet}>{r.reply.snippet}</div>}
                </> : <span className="text-ink-3">No reply yet</span>}
              </Td>
            </tr>
          );
        })}
      </Table>
      <Pager base="/email" params={params} total={total} page={page} />
    </>
  );
}

const KIND = { invitation: ['assessment', 'Invitation'], reminder: ['assessment', 'Reminder'], submitted: ['confirmed', 'Submitted'], result: ['interview', 'Result'] };

// Every assessment or test email anywhere in Gmail, one row per conversation (lib/gmail-sync.mjs, scanAssessments).
function Assessments({ data }) {
  const items = data?.items ?? [];
  const sure = items.filter((a) => a.tier === 'sure');
  const maybe = items.filter((a) => a.tier !== 'sure');
  const searched = data?.at ? `Searched all of Gmail, Spam and Trash included, ${fmtDateTime(data.at)}.` : 'The first search runs with the next Gmail sync.';
  return (
    <>
      <h2 id="assessments" className="kicker mb-3 scroll-mt-24">Assessments{sure.length > 0 && ` · ${sure.length}`}</h2>
      <p className="mb-3 text-sm text-ink-2">Test and assessment emails from any company or platform, newest first. {searched}</p>
      <div className="mb-10 space-y-3">
        <Table head={['Received', 'Company', 'Email', 'Status', 'Deadline']} empty="No assessment emails found.">
          {sure.map((a) => <AssessmentRow key={a.threadId} a={a} />)}
        </Table>
        {maybe.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-ink-2">{maybe.length} possible — they mention a test, but less clearly</summary>
            <div className="mt-2">
              <Table head={['Received', 'Company', 'Email', 'Status', 'Deadline']}>{maybe.map((a) => <AssessmentRow key={a.threadId} a={a} />)}</Table>
            </div>
          </details>
        )}
      </div>
    </>
  );
}

function AssessmentRow({ a }) {
  const [tone, label] = KIND[a.kind] ?? KIND.invitation;
  return (
    <tr className="hover:bg-surface-2">
      <Td className="whitespace-nowrap text-xs">{fmtDateTime(a.at)}{a.count > 1 && <div className="text-ink-3">{a.count} emails</div>}</Td>
      <Td>
        {a.company ?? <span className="text-ink-3">Not named</span>}
        {a.vendor && <div className="text-xs text-ink-3">on {a.vendor}</div>}
      </Td>
      <Td className="max-w-md">
        <A to={gmailLink(a.threadId)} external>{a.subject || '(no subject)'}</A>
        <div className="text-xs text-ink-3">{a.from}</div>
        {a.snippet && <div className="mt-1 text-xs text-ink-2 line-clamp-2" title={a.snippet}>{a.snippet}</div>}
      </Td>
      <Td className="text-xs">
        <Badge value={tone}>{label}</Badge>
        {a.folder && <div className="mt-1"><Badge value="failed">In {a.folder === 'spam' ? 'Spam' : 'Trash'}</Badge></div>}
      </Td>
      <Td className="max-w-xs text-xs text-ink-2">{a.deadline ?? '—'}</Td>
    </tr>
  );
}
