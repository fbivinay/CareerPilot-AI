import { listContacts, listOutreach } from '@/lib/queries.mjs';
import { A, Badge, Card, Filters, PageHeader, Pager, Table, Td, fmtDateTime, href } from '../_ui/kit.jsx';
import { addContact } from '../actions.js';

export const dynamic = 'force-dynamic';

export default async function Outreach({ searchParams }) {
  const params = await searchParams;
  const tab = params.tab === 'contacts' ? 'contacts' : 'messages';
  const tabs = (
    <div className="flex gap-1 text-sm">
      {['messages', 'contacts'].map((t) => (
        <a key={t} href={href('/outreach', {}, { tab: t === 'messages' ? null : t })}
          className={`rounded-md px-3 py-1.5 ${tab === t ? 'bg-accent-soft text-accent font-medium' : 'text-ink-2 hover:text-ink'}`}>{t === 'messages' ? 'Messages' : 'Contacts'}</a>
      ))}
    </div>
  );

  if (tab === 'contacts') {
    const contacts = await listContacts();
    return (
      <>
        <PageHeader title="Outreach" sub="Contacts come only from addresses printed in job postings, people who emailed you, or ones you add.">{tabs}</PageHeader>
        <Card title="Add a contact you met or were introduced to" className="mb-4">
          <form action={addContact} className="flex flex-wrap items-end gap-2">
            {[['email', 'Email', 'name@company.com'], ['name', 'Name', ''], ['company', 'Company', '']].map(([n, l, p]) => (
              <label key={n} className="flex flex-col gap-1 text-xs text-ink-2">{l}
                <input name={n} required={n === 'email'} placeholder={p} className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink" /></label>
            ))}
            <button className="rounded-md border border-line px-3 py-1.5 text-sm hover:border-accent">Add</button>
          </form>
        </Card>
        <Table head={['Contact', 'Company', 'Source', 'Domain verified', 'Emails sent', 'Status']}>
          {contacts.map((c) => (
            <tr key={c.id}>
              <Td>{c.name ?? '—'}<div className="text-xs text-ink-3">{c.email}</div></Td>
              <Td>{c.company ? <A to={`/companies/${encodeURIComponent(c.company)}`}>{c.company}</A> : '—'}</Td>
              <Td className="text-xs">{c.source_type.replace('_', ' ')}{c.source_type === 'jd' && c.source_ref && <> · <A to={`/jobs/${c.source_ref}`}>posting</A></>}</Td>
              <Td className="text-xs">{c.domain_match ? 'yes' : 'no'}</Td>
              <Td>{c.sent > 0 ? <A to={href('/outreach', { company: c.company })}>{c.sent}</A> : 0}</Td>
              <Td>{c.opted_out ? <Badge value="rejected">opted out</Badge> : ''}</Td>
            </tr>
          ))}
        </Table>
      </>
    );
  }

  const { rows, total, page } = await listOutreach(params);
  return (
    <>
      <PageHeader title="Outreach" sub="Every email sent on your behalf, its delivery result, replies and follow-ups.">{tabs}</PageHeader>
      <Filters base="/outreach" params={params} fields={[
        { name: 'status', label: 'Status', options: [['', 'All'], ['sent', 'Sent'], ['failed', 'Failed'], ['unknown', 'Interrupted (check Gmail)'], ['skipped', 'Skipped']] },
        { name: 'kind', label: 'Kind', options: [['', 'All'], ['application', 'Email application'], ['initial', 'Introduction'], ['followup', 'Follow-up']] },
        { name: 'replied', label: 'Replies', options: [['', 'All'], ['1', 'Replied']] },
      ]} />
      <Table head={['Date', 'To', 'Company', 'Job', 'Kind', 'Status', 'Replied']}>
        {rows.map((o) => (
          <tr key={o.id} className="hover:bg-surface-2">
            <Td className="whitespace-nowrap text-xs">{fmtDateTime(o.sent_at ?? o.created_at)}</Td>
            <Td><A to={`/outreach/${o.id}`}>{o.name ?? o.email}</A></Td>
            <Td>{o.company ? <A to={`/companies/${encodeURIComponent(o.company)}`}>{o.company}</A> : '—'}</Td>
            <Td className="max-w-xs">{o.job_id ? <A to={`/jobs/${o.job_id}`}>{o.title}</A> : '—'}</Td>
            <Td className="text-xs">{o.kind}</Td>
            <Td><Badge value={o.status} />{o.error && <div className="text-xs text-bad">{o.error}</div>}</Td>
            <Td className="text-xs">{fmtDateTime(o.replied_at)}</Td>
          </tr>
        ))}
      </Table>
      <Pager base="/outreach" params={params} total={total} page={page} />
    </>
  );
}
