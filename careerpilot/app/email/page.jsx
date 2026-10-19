import { sentEmails } from '@/lib/queries.mjs';
import { A, Badge, Filters, PageHeader, Pager, Stat, Table, Td, fmtDateTime, gmailLink, href, pct } from '../_ui/kit.jsx';

export const dynamic = 'force-dynamic';

// A reply in the colour of the application status it matches; any other reply is just "Replied".
const REPLY = { rejection: ['rejected', 'Rejected'], interview: ['interview', 'Interview'], assessment: ['assessment', 'Assessment'],
  offer: ['offer', 'Offer'], bounce: ['failed', 'Bounced'] };

export default async function Email({ searchParams }) {
  const params = await searchParams;
  const { rows, total, page, counts: c } = await sentEmails(params);
  const to = (patch) => href('/email', {}, patch);
  return (
    <>
      <PageHeader title="Email" sub="Job emails you and CareerPilot sent, and the replies they got. Every number opens the list it counts." />

      <h2 className="mb-2 text-sm font-semibold text-ink-2">Sent</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Job emails sent" value={c.all} to="/email" hint="One per conversation" />
        <Stat label="Sent by you" value={c.you} to={to({ by: 'you' })} />
        <Stat label="Sent by CareerPilot" value={c.careerpilot} to={to({ by: 'careerpilot' })} />
        <Stat label="Replied" value={c.replied} to={to({ reply: 'replied' })} hint={`${pct(c.replied, c.all)} of sent`} />
        <Stat label="No reply yet" value={c.none} to={to({ reply: 'none' })} />
        <Stat label="Bounced" value={c.bounce} to={to({ reply: 'bounce' })} tone={c.bounce ? 'bad' : undefined} hint="Address did not exist" />
      </div>

      <h2 className="mb-2 text-sm font-semibold text-ink-2">Replies</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Assessments" value={c.assessment} to={to({ reply: 'assessment' })} />
        <Stat label="Interviews" value={c.interview} to={to({ reply: 'interview' })} tone={c.interview ? 'good' : undefined} />
        <Stat label="Offers" value={c.offer} to={to({ reply: 'offer' })} tone={c.offer ? 'good' : undefined} />
        <Stat label="Rejections" value={c.rejection} to={to({ reply: 'rejection' })} />
        <Stat label="Other replies" value={c.other} to={to({ reply: 'other' })} hint="Answers and acknowledgements" />
      </div>

      <Filters base="/email" params={params} fields={[
        { name: 'by', label: 'Sent by', options: [['', 'Anyone'], ['you', 'You'], ['careerpilot', 'CareerPilot']] },
        { name: 'reply', label: 'Reply', options: [['', 'All'], ['replied', 'Replied'], ['none', 'No reply yet'], ['assessment', 'Assessment'],
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
