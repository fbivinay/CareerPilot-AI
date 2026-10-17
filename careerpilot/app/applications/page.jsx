import { listApplications } from '@/lib/queries.mjs';
import { A, Badge, Filters, PageHeader, Pager, ROLE_LABELS, Table, Td, fmtDate } from '../_ui/kit.jsx';

export const dynamic = 'force-dynamic';

const STATUS_OPTIONS = [['', 'All'], ['applied', 'Applied (any outcome)'], ['pending', 'Needs you (ready/blocked/failed)'], ['ready', 'Ready to apply'],
  ['blocked', 'Blocked'], ['failed', 'Failed'], ['submitted', 'Submitted'], ['confirmed', 'Confirmed'], ['responded', 'Heard back'],
  ['assessment', 'Assessment'], ['interview', 'Interview'], ['interviewed', 'Ever interviewed'], ['expired', 'Posting closed'], ['offer', 'Offer'], ['rejected', 'Rejected'], ['withdrawn', 'Withdrawn']];

export default async function Applications({ searchParams }) {
  const params = await searchParams;
  const { rows, total, page } = await listApplications(params);
  return (
    <>
      <PageHeader title="Applications" sub="“Applied” counts only submissions with proof: a sent Gmail message, a confirmation page or an employer email." />
      <Filters base="/applications" params={params} fields={[
        { name: 'q', label: 'Search', placeholder: 'Company or role' },
        { name: 'status', label: 'Status', options: STATUS_OPTIONS },
        { name: 'method', label: 'Method', options: [['', 'All'], ['email', 'Email application'], ['portal', 'Employer portal'], ['platform', 'Job board'], ['external', 'Found from email'], ['manual', 'Added by you']] },
        { name: 'category', label: 'Role', options: [['', 'All roles'], ...Object.entries(ROLE_LABELS)] },
        { name: 'sort', label: 'Sort', options: [['updated', 'Recently updated'], ['submitted', 'Submission date'], ['score', 'Best match'], ['company', 'Company']] },
      ]} />
      <Table head={['Company', 'Role', 'Status', 'Method', 'Submitted', 'Resume', 'Evidence', 'Emails']}>
        {rows.map((a) => (
          <tr key={a.id} className="hover:bg-surface-2">
            <Td><A to={`/companies/${encodeURIComponent(a.company)}`}>{a.company}</A></Td>
            <Td className="max-w-xs"><A to={`/applications/${a.id}`}>{a.title}</A>{a.blocked_reason && <div className="text-xs text-ink-3">{a.blocked_reason}</div>}</Td>
            <Td><Badge value={a.status} /></Td>
            <Td className="text-xs text-ink-2">{a.method}</Td>
            <Td className="whitespace-nowrap text-xs">{fmtDate(a.submitted_at)}</Td>
            <Td className="text-xs text-ink-2">{a.resume_version ?? '—'}</Td>
            <Td className="text-xs">{JSON.parse(a.evidence ?? '[]').length || '—'}</Td>
            <Td className="text-xs">{a.email_count > 0 ? <A to={`/applications/${a.id}#emails`}>{a.email_count}</A> : '—'}</Td>
          </tr>
        ))}
      </Table>
      <Pager base="/applications" params={params} total={total} page={page} />
    </>
  );
}
