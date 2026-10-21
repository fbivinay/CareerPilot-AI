import { Archivo, Inter } from 'next/font/google';
import './globals.css';
import { Footer, Nav } from './_ui/nav.jsx';

// tristenobrien.ai's fonts: Archivo for headings and figures, Inter for text (both served from this app).
const archivo = Archivo({ subsets: ['latin'], variable: '--font-archivo', display: 'swap' });
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata = {
  title: 'CareerPilot',
  description: 'Personal job-search pipeline',
  robots: { index: false, follow: false },
};

export const viewport = { themeColor: '#0e9e88' };

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`h-full ${archivo.variable} ${inter.variable}`}>
      <body className="flex min-h-full flex-col font-sans antialiased">
        <Nav />
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-20 pt-10 sm:px-6">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
