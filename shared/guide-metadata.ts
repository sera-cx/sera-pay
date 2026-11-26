const guides = {
  accept: {
    title: "Accept stablecoin payments with Sera",
    description: "Create merchant payment links, let customers review payment terms, and track payments with the Sera API.",
  },
  swap: {
    title: "Swap stablecoins with Sera",
    description: "Use the Sera API to get a quote, review swap amounts, sign with a wallet, and track settlement.",
  },
  transfer: {
    title: "Transfer tokens with Sera",
    description: "Use the Sera API to prepare an ERC-20 transfer, review its network fee, sign with a wallet, and broadcast the transaction.",
  },
  "set-rate": {
    title: "Set a rate with Sera limit orders",
    description: "Use the Sera API to preview a limit order, sign at your chosen rate, and follow fills and cancellations.",
  },
} as const;

export function guideMetadata(originalUrl: string) {
  const path = originalUrl.split(/[?#]/, 1)[0];
  const match = /^\/(accept|swap|transfer|set-rate)\/guide\/?$/.exec(path);
  if (!match) return null;
  const flow = match[1] as keyof typeof guides;
  const { title, description } = guides[flow];
  return { title: title + " | Sera API guides", description, url: "https://pay.sera.cx/" + flow + "/guide" };
}

function guideTags(metadata: NonNullable<ReturnType<typeof guideMetadata>>) {
  const { title, description, url } = metadata;
  const image = "https://pay.sera.cx/icon-512.png";
  const article = { "@context": "https://schema.org", "@type": "TechArticle", headline: title, description, url, image };
  // All values come from the fixed guide catalog above. Only its canonical URL is shared.
  return `<title>${title}</title>
    <meta name="description" content="${description}" />
    <link rel="canonical" href="${url}" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:image" content="${image}" />
    <meta property="og:image:width" content="512" />
    <meta property="og:image:height" content="512" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    <meta name="twitter:image" content="${image}" />
    <script type="application/ld+json">${JSON.stringify(article)}</script>`;
}

export function renderGuideMetadata(html: string, metadata: NonNullable<ReturnType<typeof guideMetadata>>) {
  return html.replace(/(<!-- page-metadata:start -->)([\s\S]*?)(<!-- page-metadata:end -->)/,
    (_, start: string, original: string, end: string) => {
      // A direct guide visit can later navigate home without fetching another document.
      const saved = JSON.stringify(original).replace(/</g, "\\u003c");
      return start + guideTags(metadata) + end +
        '<script id="serapay-home-metadata" type="application/json">' + saved + '</script>';
    });
}

let originalTags: DocumentFragment | undefined;
let activeRoute: string | undefined;

export function syncGuideMetadata(path: string) {
  const metadata = guideMetadata(path);
  const route = metadata?.url ?? "";
  if (route === activeRoute) return;
  const comments = Array.from(document.head.childNodes).filter(node => node.nodeType === Node.COMMENT_NODE);
  const start = comments.find(node => node.textContent?.trim() === "page-metadata:start");
  const end = comments.find(node => node.textContent?.trim() === "page-metadata:end");
  if (!start || !end) return;
  const range = document.createRange();
  range.setStartAfter(start);
  range.setEndBefore(end);
  if (!originalTags) {
    const backup = document.getElementById("serapay-home-metadata")?.textContent;
    originalTags = backup ? range.createContextualFragment(JSON.parse(backup)) : range.cloneContents();
    // On the initial page the server already supplied the matching tags.
    if (document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href === metadata?.url) {
      activeRoute = route;
      return;
    }
  }
  const next = metadata ? range.createContextualFragment(guideTags(metadata)) : originalTags.cloneNode(true);
  range.deleteContents();
  range.insertNode(next);
  activeRoute = route;
}
