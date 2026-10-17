import Link from 'next/link';

export const metadata = { title: 'Privacy policy · CareerPilot' };

const Section = ({ title, children }) => (
  <section className="space-y-2">
    <h2 className="text-lg font-semibold">{title}</h2>
    {children}
  </section>
);

// Public (no sign-in): linked from Google's OAuth consent screen. Keep it in step with what the code does.
export default function PrivacyPage() {
  return (
    <article className="mx-auto mt-16 max-w-2xl space-y-6 leading-relaxed">
      <div>
        <h1 className="text-2xl font-semibold">Privacy policy</h1>
        <p className="mt-1 text-sm text-ink-2">Last updated 17 October 2026</p>
      </div>
      <p>
        <Link href="/about" className="text-accent underline">CareerPilot</Link> is used only by its owner.
        This policy explains what it does with the owner&apos;s Google data and with the job-search
        information it handles.
      </p>
      <Section title="Google data it accesses">
        <ul className="list-disc space-y-1 pl-5">
          <li><b>Read Gmail</b> (gmail.readonly): to recognise job-search email such as application
            confirmations, assessment and interview invitations, rejections and recruiter replies, and link
            each one to the right application.</li>
          <li><b>Send email</b> (gmail.send): to send job applications, recruiter introductions and
            follow-ups within limits the owner sets, and a daily summary to the owner.</li>
        </ul>
      </Section>
      <Section title="What is stored">
        <p>
          For each job-related message: the sender, subject, date, an excerpt of at most 240 characters and
          how it was classified. Full message bodies are not stored. The Google access token is stored
          encrypted (AES-256-GCM) with a key that only the owner holds.
        </p>
      </Section>
      <Section title="Where it is processed">
        <p>
          The database is hosted by Turso (AWS, Mumbai region). Scheduled processing runs on GitHub Actions,
          and this dashboard is hosted on Vercel. When its rules cannot classify an email, CareerPilot may
          send the email&apos;s text to Groq&apos;s API for classification; Groq does not use API data to train
          its models. Email content is never sent to AI providers that may train on it.
        </p>
      </Section>
      <Section title="Sharing">
        <p>
          Google user data is not sold, not used for advertising, not used to train AI models, and not shared
          with anyone except the service providers named above.
        </p>
        <p>
          CareerPilot&apos;s use and transfer of information received from Google APIs to any other app will
          adhere to the{' '}
          <a href="https://developers.google.com/terms/api-services-user-data-policy" className="text-accent underline">
            Google API Services User Data Policy</a>, including the Limited Use requirements.
        </p>
      </Section>
      <Section title="Other people's information">
        <p>
          Job postings, company names and publicly listed recruiting contacts come from public sources and
          from email the owner receives, and are used only for the owner&apos;s job search. Anyone who replies
          &ldquo;unsubscribe&rdquo; to an email sent by CareerPilot is never contacted again.
        </p>
      </Section>
      <Section title="Keeping and deleting data">
        <p>
          Data is kept while the owner uses CareerPilot. Disconnecting Gmail in the dashboard revokes
          Google access and deletes the stored token; access can also be revoked at any time at{' '}
          <a href="https://myaccount.google.com/permissions" className="text-accent underline">myaccount.google.com/permissions</a>.
          Deleting the database removes everything else.
        </p>
      </Section>
      <Section title="Contact">
        <p>Questions about this policy: write to the support address shown on CareerPilot&apos;s Google sign-in screen.</p>
      </Section>
    </article>
  );
}
