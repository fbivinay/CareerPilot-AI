import { listJobs } from '@/lib/queries.mjs';
import { A, Badge, DropButton, Filters, PageHeader, Pager, ROLE_LABELS, Table, Td, fmtComp, fmtDate, href } from '../_ui/kit.jsx';
import { dropJobAction } from '../actions.js';

export const dynamic = 'force-dynamic';

export default async function Jobs({ searchParams }) {
  const params = await searchParams;
  const { rows, total, page, sources } = await listJobs(params);
  const status = params.status ?? 'qualified';
  return (
    <>
      <PageHeader title="Jobs" sub="Qualified jobs passed every rule; “Needs review” means pay or experience is not stated in the posting." />
      <Filters base="/jobs" params={params} fields={[
        { name: 'q', label: 'Search', placeholder: 'Title, company, city' },
        { name: 'status', label: 'Status', default: 'qualified', options: [['qualified', 'Qualified'], ['all', 'All tracked'], ['excluded', 'Excluded'], ['duplicate', 'Duplicates']] },
        { name: 'category', label: 'Role', options: [['', 'All roles'], ...Object.entries(ROLE_LABELS)] },
        { name: 'type', label: 'Type', options: [['', 'All'], ['full_time', 'Full-time'], ['internship', 'Internship'], ['contract', 'Contract']] },
        { name: 'location', label: 'Location', options: [['', 'All India'], ['bengaluru', 'Bengaluru'], ['remote', 'Remote']] },
        { name: 'confidence', label: 'Confidence', options: [['', 'All'], ['high', 'Verified'], ['low', 'Needs review']] },
        { name: 'comp', label: 'Pay', options: [['', 'Any'], ['disclosed', 'Disclosed'], ['undisclosed', 'Not disclosed']] },
        { name: 'source', label: 'Source', options: [['', 'All sources'], ['alerts', 'Email alerts'], ...sources.map((s) => [s, s])] },
        { name: 'sort', label: 'Sort', options: [['score', 'Best match'], ['newest', 'Newest found'], ['posted', 'Recently posted'], ['comp', 'Highest pay'], ['company', 'Company']] },
      ]} />
      <Table head={['Role', 'Company', 'Location', 'Pay', 'Match', 'Status', 'Source', 'Found', '']}>
        {rows.map((j) => (
          <tr key={j.id} className="hover:bg-surface-2">
            <Td className="max-w-xs">
              <A to={`/jobs/${j.id}`}>{j.title}</A>
              <div className="text-xs text-ink-3">{ROLE_LABELS[j.role_category] ?? ''}{j.employment_type === 'internship' ? ' · Internship' : ''}</div>
            </Td>
            <Td><A to={`/companies/${encodeURIComponent(j.company)}`}>{j.company}</A></Td>
            <Td className="max-w-[12rem] text-ink-2">{j.location || '—'}</Td>
            <Td className="whitespace-nowrap">{fmtComp(j) ?? <span className="text-ink-3">Not disclosed</span>}</Td>
            <Td className="tabular-nums">{j.score ?? '—'}{j.ai_score != null && <span className="text-xs text-ink-3"> · AI {j.ai_score}</span>}</Td>
            <Td>
              <div className="flex flex-col items-start gap-1">
                {status === 'qualified' ? <Badge value={j.confidence} /> : <Badge value={j.status} />}
                {j.app_id && <a href={`/applications/${j.app_id}`}><Badge value={j.app_status} /></a>}
                {j.exclusion_reason && status !== 'qualified' && <span className="text-xs text-ink-3">{j.exclusion_reason}</span>}
              </div>
            </Td>
            <Td className="text-xs text-ink-2">{j.source}</Td>
            <Td className="whitespace-nowrap text-xs text-ink-2">{fmtDate(j.first_seen)}</Td>
            <Td>
              <A to={j.url} external>Posting</A>
              {j.status !== 'duplicate' && (!j.app_status || ['ready', 'blocked', 'failed'].includes(j.app_status)) && <DropButton jobId={j.id} action={dropJobAction} />}
            </Td>
          </tr>
        ))}
      </Table>
      <Pager base="/jobs" params={params} total={total} page={page} />
      {status === 'qualified' && <p className="mt-2 text-xs text-ink-3">See also <a className="underline" href={href('/jobs', params, { status: 'excluded', page: null })}>excluded jobs and their reasons</a>.</p>}
    </>
  );
}
