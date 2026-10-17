import './globals.css';
import { Nav } from './_ui/nav.jsx';

export const metadata = {
  title: 'CareerPilot',
  description: 'Personal job-search pipeline',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <Nav />
        <main className="mx-auto w-full max-w-7xl px-4 pb-16 pt-6 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
