import { useMemo } from "react";

/**
 * Renders markdown body content from a concept page.
 * Converts teamem://concept/<uuid> links to internal react-router Links
 * by transforming them to standard /concept/<uuid> <a> tags with a
 * data-teamem-href attribute for the global click handler to intercept.
 *
 * Two link forms are supported (both produced by the F1 compiler):
 * 1. Bare URL: teamem://concept/<uuid>
 * 2. Markdown link: [text](teamem://concept/<uuid>)
 *
 * This is NOT a general-purpose markdown renderer — it handles the
 * specific patterns produced by the teamem compiler pipeline.
 */
export function MarkdownBody({ body }: { body: string }) {
  const html = useMemo(() => markdownToHtml(body), [body]);

  return (
    <div
      className="md"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** UUID regex for concept links. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const TEAMEM_LINK_RE = new RegExp(
  `teamem:\\/\\/concept\\/(${UUID_RE.source})`,
  "g",
);

/**
 * Convert markdown to HTML.
 *
 * Processing order matters:
 * 1. First handle `[text](teamem://concept/<uuid>)` — the standard markdown link form.
 *    Convert to `<a href="/concept/<uuid>" data-teamem-href="...">text</a>`.
 * 2. Then handle bare `teamem://concept/<uuid>` — convert similarly.
 * 3. Then handle other markdown constructs (bold, inline code, etc).
 * 4. Then handle structure (headings, lists, paragraphs).
 */
function markdownToHtml(md: string): string {
  // Step 1: Extract teamem:// links into placeholders BEFORE any other
  // processing, so later steps (HTML escaping, bare-URL matching) cannot
  // mangle them. Both forms are produced by the F1 compiler:
  //   [text](teamem://concept/<uuid>)   — standard markdown link
  //   teamem://concept/<uuid>           — bare URL
  const anchors: string[] = [];
  const pushAnchor = (text: string, uuid: string): string => {
    anchors.push(
      `<a href="/concept/${uuid}" class="ilink" data-teamem-href="teamem://concept/${uuid}">${text}</a>`,
    );
    return `\u0000TEAMEM${anchors.length - 1}\u0000`;
  };

  let html = md;

  // 1a. Markdown link form: [text](teamem://concept/<uuid>)
  html = html.replace(
    new RegExp(
      `\\[([^\\]]+)\\]\\(teamem:\\/\\/concept\\/(${UUID_RE.source})\\)`,
      "g",
    ),
    (_m: string, text: string, uuid: string) => pushAnchor(text, uuid),
  );

  // 1b. Bare teamem://concept/<uuid> URLs (markdown links already extracted)
  html = html.replace(TEAMEM_LINK_RE, (match: string) => {
    const uuid = match.split("/").pop()!;
    return pushAnchor(match, uuid);
  });

  // Step 2: Escape remaining HTML (placeholders contain no HTML chars).
  html = html
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Step 3: Restore the anchor placeholders.
  html = html.replace(/\u0000TEAMEM(\d+)\u0000/g, (_m: string, i: string) => anchors[Number(i)]!);

  // Step 4: URLs in plain text (not already in tags, not teamem://)
  html = html.replace(
    /(?<!href=")(?<!>)(https?:\/\/[^\s<>"]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" class="ilink">$1</a>',
  );

  // Step 5: Bold: **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // Step 6: Inline code: `text`
  html = html.replace(/`([^`]+)`/g, "<code class=\"mono\">$1</code>");

  // Step 7: Structural elements (headings, lists, paragraphs)
  const lines = html.split("\n");
  const result: string[] = [];
  let inList = false;
  let inOrderedList = false;

  for (const line of lines) {
    // Blank line
    if (/^\s*$/.test(line)) {
      if (inList) { result.push("</ul>"); inList = false; }
      if (inOrderedList) { result.push("</ol>"); inOrderedList = false; }
      continue;
    }

    // Heading ####, ###, ##
    const h4 = line.match(/^#### (.+)/);
    if (h4) {
      if (inList) { result.push("</ul>"); inList = false; }
      if (inOrderedList) { result.push("</ol>"); inOrderedList = false; }
      result.push(`<h4>${h4[1]}</h4>`);
      continue;
    }
    const h3 = line.match(/^### (.+)/);
    if (h3) {
      if (inList) { result.push("</ul>"); inList = false; }
      if (inOrderedList) { result.push("</ol>"); inOrderedList = false; }
      result.push(`<h3>${h3[1]}</h3>`);
      continue;
    }
    const h2 = line.match(/^## (.+)/);
    if (h2) {
      if (inList) { result.push("</ul>"); inList = false; }
      if (inOrderedList) { result.push("</ol>"); inOrderedList = false; }
      result.push(`<h2>${h2[1]}</h2>`);
      continue;
    }

    // Unordered list item
    const ulItem = line.match(/^[-*] (.+)/);
    if (ulItem) {
      if (inOrderedList) { result.push("</ol>"); inOrderedList = false; }
      if (!inList) { result.push("<ul>"); inList = true; }
      result.push(`<li>${ulItem[1]}</li>`);
      continue;
    }

    // Ordered list item
    const olItem = line.match(/^\d+\. (.+)/);
    if (olItem) {
      if (inList) { result.push("</ul>"); inList = false; }
      if (!inOrderedList) { result.push("<ol>"); inOrderedList = true; }
      result.push(`<li>${olItem[1]}</li>`);
      continue;
    }

    // Paragraph
    if (inList) { result.push("</ul>"); inList = false; }
    if (inOrderedList) { result.push("</ol>"); inOrderedList = false; }
    result.push(`<p>${line}</p>`);
  }

  if (inList) result.push("</ul>");
  if (inOrderedList) result.push("</ol>");

  return result.join("\n");
}
