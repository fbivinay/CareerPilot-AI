import Link from 'next/link';

export const metadata = { title: 'About · CareerPilot' };

// Public (no sign-in): Google's OAuth consent screen links here as the app's home page.
export default function AboutPage() {
  return (
    <article className="mx-auto mt-16 max-w-2xl space-y-4 leading-relaxed">
      <h1 className="text-2xl font-semibold">CareerPilot</h1>
      <p>
        CareerPilot is a private, single-user job-search assistant. Its owner runs it for their own job
        search; there is no sign-up and there are no other users.
      </p>
      <p>
        It finds job postings that match the owner&apos;s goals and keeps track of applications. With the
        owner&apos;s permission it uses the Gmail API to read job-related email (application confirmations,
        assessments, interview invitations, recruiter replies) and to send applications and follow-ups from
        the owner&apos;s own Gmail account.
      </p>
      <p>The dashboard is protected by the owner&apos;s password.</p>
      <p><Link href="/privacy" className="text-accent underline">Privacy policy</Link></p>
    </article>
  );
}
