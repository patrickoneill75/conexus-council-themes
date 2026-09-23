/**
 * A minimal .docx writer, with real Word tracked changes.
 *
 * The Job Description Updater hands an employer three Word files: a redlined version,
 * a clean final version, and a career-fair one-pager. This builds all three, in the
 * Worker, with no npm dependency -- consistent with the rest of this repo's Worker code
 * (see src/consensus.js's module docstring on why that constraint exists).
 *
 * WHY WORD RATHER THAN PDF. A .docx is a ZIP of XML, which is a few hundred lines to
 * write; a PDF needs font metrics and an embedded font program to do properly. More to
 * the point, Word has native revision markup, so the redline arrives as something the
 * employer can actually Accept or Reject per change in their own copy -- a PDF could
 * only ever show a picture of a strikethrough. src/job_description.js already READS
 * .docx (it unzips an uploaded one); this is the other direction.
 *
 * DOCUMENT MODEL. A document is a flat list of blocks:
 *   { type: "heading1" | "heading2" | "paragraph" | "bullet", runs: [run] }
 * and a run is:
 *   { text, bold?, italic?, change?: "none" | "ins" | "del" }
 * A run marked "ins" renders inside <w:ins>, "del" inside <w:del> with <w:delText>.
 *
 * That one model produces both documents. Claude returns the redline ONCE, with every
 * run marked, and the clean version is derived from it by dropping the deletions --
 * see cleanCopy() below. Asking for the document twice would have doubled the output
 * tokens of the most expensive call in the app and left the two free to disagree with
 * each other; deriving one from the other makes that impossible by construction.
 *
 * ZIP. Entries are STORED (uncompressed). These documents are a few KB of XML, so
 * compression would save little, and a stored entry needs no CompressionStream plumbing
 * and no streaming -- the whole archive is assembled in memory in one pass.
 */

const encoder = new TextEncoder();

/* ------------------------------------------------------------------------ ZIP ---- */

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

  for (const { name, text } of files) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    const crc = crc32(data);
    // Version 20, no flags, method 0 (stored), zeroed DOS timestamp. A zero timestamp
    // is legal and keeps the output byte-identical for identical input, which is what
    // makes this testable.
    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0),
    ];
    chunks.push(new Uint8Array(local), nameBytes, data);
    central.push([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(offset), ...Array.from(nameBytes),
    ]);
    offset += local.length + nameBytes.length + data.length;
  }

  const centralBytes = new Uint8Array(central.flat());
  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(centralBytes.length), ...u32(offset), ...u16(0),
  ]);

  const total = chunks.reduce((n, c) => n + c.length, 0) + centralBytes.length + eocd.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) { out.set(chunk, cursor); cursor += chunk.length; }
  out.set(centralBytes, cursor); cursor += centralBytes.length;
  out.set(eocd, cursor);
  return out;
}

/* ------------------------------------------------------------------- XML parts ---- */

function xmlEscape(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    // Characters XML 1.0 simply cannot carry. Word rejects the whole file if one gets
    // through, and a stray control character in a pasted job description is exactly the
    // kind of thing that would otherwise surface as "Word found unreadable content".
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

// One bulleted list definition. Word needs a numbering part for real bullets; the
// alternative (a literal "-" at the start of each paragraph) does not survive the
// employer editing the document afterwards, which is the whole point of shipping Word.
const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0">
<w:multiLevelType w:val="hybridMultilevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:lvlJc w:val="left"/>
<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

// Aptos with a Segoe UI / Arial fallback chain, per the Conexus Indiana brand; navy
// (#07214E) headings, #16202B body.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:cs="Aptos"/>
<w:color w:val="16202B"/><w:sz w:val="22"/><w:szCs w:val="22"/>
</w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:before="0" w:after="240"/></w:pPr>
<w:rPr><w:b/><w:color w:val="07214E"/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
<w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="320" w:after="120"/></w:pPr>
<w:rPr><w:b/><w:color w:val="07214E"/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>
<w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="260" w:after="100"/></w:pPr>
<w:rPr><w:b/><w:color w:val="325EAE"/><w:sz w:val="25"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>
<w:pPr><w:ind w:left="720"/><w:contextualSpacing/><w:spacing w:after="60"/></w:pPr></w:style>
</w:styles>`;

/* ----------------------------------------------------------------- the document --- */

const STYLE_FOR = Object.assign(Object.create(null), {
  title: "Title", heading1: "Heading1", heading2: "Heading2",
  paragraph: null, bullet: "ListParagraph",
});

function runXml(run) {
  const properties = [];
  if (run.bold) properties.push("<w:b/>");
  if (run.italic) properties.push("<w:i/>");
  const rPr = properties.length ? `<w:rPr>${properties.join("")}</w:rPr>` : "";
  // xml:space="preserve" throughout: without it Word collapses the leading and trailing
  // spaces that separate one run from the next, so an inserted phrase runs into the
  // word before it.
  if (run.change === "del") {
    return `<w:r>${rPr}<w:delText xml:space="preserve">${xmlEscape(run.text)}</w:delText></w:r>`;
  }
  return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(run.text)}</w:t></w:r>`;
}

function blockXml(block, state) {
  const style = STYLE_FOR[block.type] || null;
  const parts = [];
  if (style) parts.push(`<w:pStyle w:val="${style}"/>`);
  if (block.type === "bullet") parts.push('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
  const pPr = parts.length ? `<w:pPr>${parts.join("")}</w:pPr>` : "";

  const body = (block.runs || []).filter((r) => r && r.text).map((run) => {
    const xml = runXml(run);
    if (run.change === "ins") {
      return `<w:ins w:id="${state.revisionId++}" w:author="${state.author}" w:date="${state.date}">${xml}</w:ins>`;
    }
    if (run.change === "del") {
      return `<w:del w:id="${state.revisionId++}" w:author="${state.author}" w:date="${state.date}">${xml}</w:del>`;
    }
    return xml;
  }).join("");

  return `<w:p>${pPr}${body}</w:p>`;
}

/**
 * Build a .docx. Returns a Uint8Array ready to serve as
 * application/vnd.openxmlformats-officedocument.wordprocessingml.document.
 *
 * `author` and `date` label every tracked change; they only matter for a document that
 * actually carries revisions (the redline).
 */
export function buildDocx({ blocks = [], author = "Job Description Updater", date = null } = {}) {
  const state = {
    revisionId: 1,
    author: xmlEscape(author),
    // Word wants a full ISO-8601 instant with a timezone designator.
    date: (date || new Date().toISOString()).replace(/\.\d+Z$/, "Z"),
  };
  const body = blocks.map((block) => blockXml(block, state)).join("");
  // Letter portrait with 1in margins.
  const sectPr = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
    + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720"/></w:sectPr>';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}${sectPr}</w:body></w:document>`;

  return zip([
    { name: "[Content_Types].xml", text: CONTENT_TYPES },
    { name: "_rels/.rels", text: ROOT_RELS },
    { name: "word/_rels/document.xml.rels", text: DOCUMENT_RELS },
    { name: "word/document.xml", text: document },
    { name: "word/styles.xml", text: STYLES },
    { name: "word/numbering.xml", text: NUMBERING },
  ]);
}

/**
 * The clean version of a redlined document: deletions dropped, insertions accepted.
 *
 * This is how the final description is produced, rather than asking Claude for the
 * document a second time. One generation, two files, and they cannot disagree.
 */
export function cleanCopy(blocks) {
  return (blocks || []).map((block) => ({
    type: block.type,
    runs: (block.runs || [])
      .filter((run) => run && run.text && run.change !== "del")
      .map(({ change, ...rest }) => rest),
  })).filter((block) => block.runs.length);
}

/** Plain text of a document model, for a preview or a smoke test. */
export function toPlainText(blocks) {
  return (blocks || []).map((block) => {
    const text = (block.runs || []).filter((r) => r && r.change !== "del")
      .map((r) => r.text).join("");
    return block.type === "bullet" ? `• ${text}` : text;
  }).join("\n");
}
