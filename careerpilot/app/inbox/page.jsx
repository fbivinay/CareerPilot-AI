import { listEmails } from '@/lib/queries.mjs';
import { A, Badge, Filters, PageHeader, Pager, Table, Td, fmtDateTime, gmailLink, host } from '../_ui/kit.jsx';
import { linkEmailToApplication, markEmailReviewed } from '../actions.js';

export const dynamic = 'force-dynamic';

const CATEGORIES = ['application_confirmation', 'sent_application', 'assessment', 'interview', 'offer', 'rejection', 'recruiter_reply', 'job_alert', 'ats_update', 'opt_out', 'bounce', 'other'];

export default async function Inbox({ searchParams }) {
  const params = await searchParams;
  const { rows, total, page, apps } = await listEmails(params);
  return (
    <>
      <PageHeader title="Inbox" sub="Job-related Gmail messages only. Only subject, sender and a short snippet are stored; the full email stays in Gmail." />
      <Filters base="/inbox" params={params} fields={[
        { name: 'category', label: 'Category', options: [['', 'All'], ...CATEGORIES.map((c) => [c, c.replace(/_/g, ' ')])] },
        { name: 'review', label: 'Review', options: [['', 'All'], ['1', 'Needs review']] },
        { name: 'linked', label: 'Linked', options: [['', 'All'], ['1', 'Linked to an application']] },
      ]} />
      <Table head={['Received', 'From', 'Subject', 'Category', 'Application', '']}>
        {rows.map((e) => {
          const x = JSON.parse(e.extracted ?? '{}');
          return (
            <tr key={e.id} className={e.needs_review && !e.reviewed ? 'bg-warn-soft/40' : ''}>
              <Td className="whitespace-nowrap text-xs">{fmtDateTime(e.received_at)}</Td>
              <Td className="max-w-[12rem] text-xs">{e.from_name || e.from_addr}<div className="truncate text-ink-3">{e.from_addr}</div></Td>
              <Td className="max-w-md">
                {e.subject}
                <div className="text-xs text-ink-3">{e.snippet}</div>
                {(x.dates?.length > 0 || x.deadline) && <div className="mt-1 text-xs text-warn">{[...(x.dates ?? []), x.deadline].filter(Boolean).join(' · ')}</div>}
                {[...(x.assessmentLinks ?? []), ...(x.meetingLinks ?? [])].map((l) => <div key={l} className="text-xs"><A to={l} external>{host(l)}</A></div>)}
              </Td>
              <Td><Badge value={e.category} />{e.classified_by?.startsWith('ai') && <div className="text-xs text-ink-3">{e.classified_by}</div>}</Td>
              <Td className="text-xs">
                {e.application_id ? <A to={`/applications/${e.application_id}`}>{e.job_company ?? 'application'}: {e.title}</A> : (
                  <form action={linkEmailToApplication} className="flex items-center gap-2">
                    <input type="hidden" name="id" value={e.id} />
                    <select name="applicationId" className="field max-w-[10rem] px-2 py-0.5 text-xs">
                      {apps.map((a) => <option key={a.id} value={a.id}>{a.company} – {a.title}</option>)}
                    </select>
                    <button className="btn-ghost btn-sm">Link</button>
                  </form>
                )}
              </Td>
              <Td className="whitespace-nowrap text-xs">
                {e.thread_id && <A to={gmailLink(e.thread_id)} external>Gmail</A>}
                {e.needs_review && !e.reviewed ? (
                  <form action={markEmailReviewed}><input type="hidden" name="id" value={e.id} /><button className="mt-1 font-semibold text-accent hover:underline">Mark reviewed</button></form>
                ) : null}
              </Td>
            </tr>
          );
        })}
      </Table>
      <Pager base="/inbox" params={params} total={total} page={page} />
    </>
  );
}
