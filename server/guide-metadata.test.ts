import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { guideMetadata, renderGuideMetadata } from "../shared/guide-metadata";

const template = readFileSync(new URL("../client/index.html", import.meta.url), "utf8");

it.each(["accept", "swap", "transfer", "set-rate"])("serves shareable metadata on the %s guide", (flow) => {
  const path = "/" + flow + "/guide";
  const metadata = guideMetadata(path + "/?network=sepolia&reference=private-reference")!;
  expect(metadata).toEqual(guideMetadata(path));
  const html = renderGuideMetadata(template, metadata);
  const canonical = "https://pay.sera.cx" + path;
  expect(html.match(/<title>/g)).toHaveLength(1);
  expect(html).toContain('<link rel="canonical" href="' + canonical + '"');
  expect(html).toContain('<meta property="og:url" content="' + canonical + '"');
  expect(html).toContain('<meta name="twitter:title" content="' + metadata.title + '"');
  expect(html).toContain('<meta name="description" content="' + metadata.description + '"');
  expect(html).toContain('"@type":"TechArticle"');
  expect(html).not.toContain('"@type": "WebApplication"');
  expect(html).not.toContain("private-reference");
  expect(html).toContain('rel="manifest"');
});

it.each(["/", "/?network=live", "/accept", "/pay/example", "/swap/guidebook", "/transfer/guide/extra"])(
  "keeps the regular page template for %s",
  (path) => { expect(guideMetadata(path)).toBeNull(); },
);
