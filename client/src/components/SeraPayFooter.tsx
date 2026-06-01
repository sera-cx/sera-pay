import { Link } from "wouter";
import { SeraLogo } from "@/components/SeraPayHeader";

type FooterSection = {
  title: string;
  links: Array<{ href: string; label: string }>;
};

export function SeraPayFooter({ sections = [], compact = false }: { sections?: FooterSection[]; compact?: boolean }) {
  return (
    <footer className="border-t border-[#4ECE9A]/20 bg-[#EAF7F0] px-6 py-8 text-[#3D5A4F]">
      <div className="mx-auto w-full max-w-[1240px]">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <Link href="/" className="inline-flex w-fit items-center no-underline">
            <SeraLogo size={compact ? 24 : 30} />
          </Link>
          <p className="m-0 text-xs leading-relaxed">
            Accept stablecoins globally with self-custody settlement.
          </p>
        </div>

        {sections.length > 0 && !compact ? (
          <div className="mt-7 grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
            {sections.map((section) => (
              <div key={section.title}>
                <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-[#006B28]">{section.title}</p>
                {section.links.map((link) => (
                  <Link key={link.href} href={link.href} className="mb-1.5 block text-xs leading-relaxed text-[#3D5A4F] no-underline hover:text-[#00C853]">
                    {link.label}
                  </Link>
                ))}
              </div>
            ))}
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-[#4ECE9A]/20 pt-4 text-[11px]">
          <p className="m-0">© {new Date().getFullYear()} SeraPay</p>
          <Link href="/" className="text-[#3D5A4F] no-underline hover:text-[#00C853]">Home</Link>
        </div>
      </div>
    </footer>
  );
}
