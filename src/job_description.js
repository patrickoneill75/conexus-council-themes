/**
 * Job Description Updater: an employer uploads a job description (PDF or Word), and a
 * Claude-powered flow walks them through updating it with the Conexus Job Description
 * Toolkit -- a 60-90 minute manual exercise (the toolkit's own estimate), compressed to
 * about ten minutes by having Claude do all the reading and the employer only confirm,
 * correct, or supply what the document cannot know. Mounted under /api/job-description/*.
 *
 * SOURCE MATERIAL. Built against the toolkit PDF itself. Its five parts map onto this
 * app one for one: Part 1 role evolution (the four drivers), Part 2 the ten-category
 * audit with an Aligned / Minor Drift / Significant Gap status each, Part 3 the
 * requirements test ("if a candidate did not have this, could they still learn to do
 * the job well within a reasonable onboarding or apprenticeship period?") tied to a
 * named credential, Part 4 the five-question New Role Decision Matrix and its 0-1 / 2 /
 * 3+ scoring bands, Part 5 communicating the update. PART2_CATEGORIES and DRIVERS below
 * are the toolkit's own category and driver names.
 *
 * WHAT THE EMPLOYER GETS. Four things, per the toolkit's Part 5 and Next Steps:
 *   1. a short plain-English summary of the biggest changes, shown in the browser;
 *   2. a REDLINED job description, as a Word file with real tracked changes;
 *   3. the same description clean, with the redlines accepted;
 *   4. a career-fair one-pager.
 * The last three download as .docx -- see src/docx.js for why Word rather than PDF, and
 * for why the clean version is derived from the redline rather than generated twice.
 *
 * CREDENTIALS. Part 3 asks for a real, portable credential rather than "technical
 * background preferred". Which one is chosen deterministically first: src/credentials.js
 * scores all 30 credentials in the reference matrix against this role's own duties, with
 * no API call, and only the closest handful reach the model. See that file.
 *
 * TWO CLAUDE CALLS, TOTAL. The pre-read on upload, and the outputs at the end. Steps in
 * between never call Claude: they are the employer confirming or correcting what the
 * pre-read already extracted, which is what keeps the whole flow to minutes rather than
 * a wait at every screen. Both calls run synchronously in the Worker, as raw fetch()
 * against the Messages API with no SDK -- the same way src/consensus.js's live call
 * does, and for the same reason (this repo's Worker code carries no npm runtime
 * dependency by design).
 *
 * No prompt caching on either call, deliberately. A cache write costs 1.25x and a read
 * 0.1x, against a five-minute TTL; employer sessions here are minutes to days apart, so
 * a cached prefix would almost always be paid for and never read -- caching this
 * workload would raise the bill, not lower it.
 *
 * PDF is handed to Claude directly as a native "document" content block (no separate
 * parsing needed -- Claude reads it). Word (.docx) has no equivalent native support in
 * the Messages API, so DOCX text is extracted right here with a small, dependency-free
 * ZIP + DEFLATE reader (Cloudflare Workers' built-in DecompressionStream('deflate-raw')
 * does the actual inflating) that pulls word/document.xml out of the archive and strips
 * it to plain text. It covers the standard case (Word/Office-written .docx); a .docx
 * that uses ZIP64 or an unusual writer could fail to parse -- the upload route returns a
 * clear error rather than a silent wrong extraction if that happens.
 *
 * Storage: BOX_KV under a "jobdesc:" prefix, same shared KV namespace and Box connection
 * every other mini app here uses.
 *   jobdesc:folder        -> JSON { id, name } -- the Box folder holding every uploaded
 *     source file and every session's generated outputs, in a per-session subfolder.
 *   jobdesc:session:<id>  -> JSON, the full session record -- source file info, the
 *     pre-read, the credential shortlist, every step's answers, the second respondent's
 *     answers if any, and the generated outputs once produced. This is what makes a
 *     session resumable: the client only ever needs the session id back.
 *   jobdesc:invite:<token> -> JSON { sessionId, createdAt } -- the shareable
 *     supervisor/incumbent link's lookup, kept separate from the session record so the
 *     link itself carries no session id an outsider could guess or reuse elsewhere.
 */

import { requireBetaAuth } from "./beta_auth.js";
import { shortlistCredentials, formatShortlist } from "./credentials.js";
import { buildDocx, cleanCopy } from "./docx.js";

const SESSION_PREFIX = "jobdesc:session:";
const INVITE_PREFIX = "jobdesc:invite:";
const FOLDER_KEY = "jobdesc:folder";
const MODEL = "claude-opus-5"; // both calls here do real structured extraction/drafting,
                                // not a one-sentence follow-up -- see module docstring.
const MAX_TOKENS_PREREAD = 16000;
const MAX_TOKENS_OUTPUTS = 16000;
// How many of the 30 credentials in the reference matrix reach the model. See
// src/credentials.js for why the shortlist is scored here rather than sent whole.
const CREDENTIAL_SHORTLIST_SIZE = 8;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function newId() { return crypto.randomUUID(); }

/* ==================================================================================
 * Toolkit structure -- see the module docstring's note on source material.
 * ================================================================================== */

const PART2_CATEGORIES = [
  { key: "job_title", label: "Job Title" },
  { key: "role_summary", label: "Role Summary" },
  { key: "essential_duties", label: "Essential Duties" },
  { key: "technology_systems", label: "Technology and Systems" },
  { key: "education", label: "Education" },
  { key: "experience", label: "Experience" },
  { key: "certifications_licenses", label: "Certifications and Licenses" },
  { key: "skills_competencies", label: "Skills and Competencies" },
  { key: "physical_demands_environment", label: "Physical Demands and Environment" },
  { key: "compensation_pathway", label: "Compensation and Pathway" },
];
const PART2_CATEGORY_KEYS = PART2_CATEGORIES.map((c) => c.key);

const DRIVERS = [
  { key: "automation_robotics", label: "Automation and Robotics" },
  { key: "digitization_data", label: "Digitization and Data" },
  { key: "decision_authority_quality", label: "Decision Authority and Quality" },
  { key: "cross_training_convergence", label: "Cross-Training and Role Convergence" },
];
const DRIVER_KEYS = DRIVERS.map((d) => d.key);


/* ==================================================================================
 * Box (same shape every other mini app here duplicates)
 * ================================================================================== */

const BOX_API = "https://api.box.com/2.0";
const BOX_UPLOAD_API = "https://upload.box.com/api/2.0";

async function boxAccessToken(env) {
  const tokens = env.BOX_KV ? await env.BOX_KV.get("box:tokens") : null;
  if (!tokens) return null;
  const parsed = JSON.parse(tokens);
  const age = Math.floor(Date.now() / 1000) - parsed.obtained_at;
  const remaining = parsed.expires_in - age;
  if (remaining > 120) return parsed.access_token;
  const response = await fetch("https://api.box.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.BOX_CLIENT_ID, client_secret: env.BOX_CLIENT_SECRET,
      grant_type: "refresh_token", refresh_token: parsed.refresh_token,
    }),
  });
  if (!response.ok) return null;
  const body = await response.json();
  const fresh = {
    access_token: body.access_token, refresh_token: body.refresh_token,
    obtained_at: Math.floor(Date.now() / 1000), expires_in: body.expires_in || 3600,
  };
  await env.BOX_KV.put("box:tokens", JSON.stringify(fresh));
  return fresh.access_token;
}

async function getFolder(env) {
  const raw = await env.BOX_KV.get(FOLDER_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function boxCreateSubfolder(headers, parentId, name) {
  const response = await fetch(`${BOX_API}/folders`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name, parent: { id: parentId } }),
  });
  if (response.ok) return response.json();
  // 409 means a folder with this name already exists under the parent -- look it up
  // instead of failing (a session's subfolder can be created once and reused across
  // every route that saves something into it).
  if (response.status === 409) {
    const detail = await response.json().catch(() => null);
    const conflict = detail && detail.context_info && detail.context_info.conflicts;
    const existing = Array.isArray(conflict) ? conflict[0] : conflict;
    if (existing && existing.id) return existing;
  }
  throw new Error(`Box folder create failed (${response.status})`);
}

async function boxFindFile(headers, folderId, name) {
  const response = await fetch(
    `${BOX_API}/folders/${folderId}/items?fields=name,type&limit=1000`, { headers }
  );
  if (!response.ok) return null;
  const items = await response.json();
  return (items.entries || []).find((e) => e.type === "file" && e.name === name) || null;
}

/* Upserts by name: uploads a NEW VERSION when a file of this name is already in the
 * folder, rather than always creating one. Without that, re-running generate-outputs
 * for a session hits Box's 409 name conflict on every one of its eight output files,
 * so the outputs were generated (and paid for) but never saved -- the second run could
 * only ever report box.saved = false. */
async function boxUploadFile(headers, folderId, name, blob) {
  const existing = await boxFindFile(headers, folderId, name);
  const outgoing = new FormData();
  if (!existing) {
    outgoing.append("attributes", JSON.stringify({ name, parent: { id: folderId } }));
  }
  outgoing.append("file", blob, name);
  const uploadUrl = existing
    ? `${BOX_UPLOAD_API}/files/${existing.id}/content`
    : `${BOX_UPLOAD_API}/files/content`;
  const response = await fetch(uploadUrl, { method: "POST", headers, body: outgoing });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Box upload failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  const body = await response.json();
  return (body.entries || [])[0];
}

/* ==================================================================================
 * DOCX text extraction -- a small, dependency-free ZIP + DEFLATE reader. Only reads
 * word/document.xml; everything else in the archive (styles, media, headers/footers)
 * is ignored. See the module docstring for what this doesn't handle.
 * ================================================================================== */

function findEndOfCentralDirectory(bytes) {
  // EOCD signature 0x06054b50, little-endian -> bytes [0x50,0x4b,0x05,0x06]. It's a
  // fixed 22-byte record at the very end of the file, unless a trailing comment was
  // added (rare for a machine-written .docx) -- search backward from the end, capped
  // at a generous window rather than the whole file.
  const maxCommentLen = 4096;
  const searchStart = Math.max(0, bytes.length - 22 - maxCommentLen);
  for (let i = bytes.length - 22; i >= searchStart; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      return i;
    }
  }
  return -1;
}

function readUint16LE(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8); }
function readUint32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function extractZipEntry(arrayBuffer, entryName) {
  const bytes = new Uint8Array(arrayBuffer);
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd === -1) throw new Error("Not a valid .docx file (no ZIP end-of-central-directory record found).");
  const centralDirOffset = readUint32LE(bytes, eocd + 16);
  const centralDirCount = readUint16LE(bytes, eocd + 10);

  const decoder = new TextDecoder("utf-8");
  let cursor = centralDirOffset;
  for (let i = 0; i < centralDirCount; i++) {
    if (readUint32LE(bytes, cursor) !== 0x02014b50) {
      throw new Error("Not a valid .docx file (malformed central directory).");
    }
    const method = readUint16LE(bytes, cursor + 10);
    const compressedSize = readUint32LE(bytes, cursor + 20);
    const nameLen = readUint16LE(bytes, cursor + 28);
    const extraLen = readUint16LE(bytes, cursor + 30);
    const commentLen = readUint16LE(bytes, cursor + 32);
    const localHeaderOffset = readUint32LE(bytes, cursor + 42);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));

    if (name === entryName) {
      // Local file header has its own (sometimes different) name/extra field lengths --
      // read those to find where the actual compressed data starts.
      if (readUint32LE(bytes, localHeaderOffset) !== 0x04034b50) {
        throw new Error("Not a valid .docx file (malformed local file header).");
      }
      const localNameLen = readUint16LE(bytes, localHeaderOffset + 26);
      const localExtraLen = readUint16LE(bytes, localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return compressed; // stored, no compression
      if (method === 8) return inflateRaw(compressed); // deflate
      throw new Error(`Unsupported .docx compression method (${method}).`);
    }
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`"${entryName}" was not found in this .docx file.`);
}

// The five named entities Word writes, plus numeric character references (Word uses
// them for curly quotes, dashes and the like -- left undecoded, they reached Claude as
// a literal "&#8217;"). &amp; is decoded LAST: decoding it first turns the document's
// own literal "&amp;lt;" into "&lt;", which the next replace then turns into "<" -- a
// double-decode that silently rewrites the employer's text.
function codePoint(value, original) {
  // Out of Unicode range, or a surrogate half: String.fromCodePoint would throw a
  // RangeError, and one malformed reference must not take the whole document with it.
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff
      || (value >= 0xd800 && value <= 0xdfff)) {
    return original;
  }
  return String.fromCodePoint(value);
}

function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (whole, code) => codePoint(Number(code), whole))
    .replace(/&#x([0-9a-f]+);/gi, (whole, code) => codePoint(parseInt(code, 16), whole))
    .replace(/&amp;/g, "&");
}

// Walks each paragraph's run content in document order, keeping <w:t> text, <w:br>
// line breaks and <w:tab> tabs. The previous version converted breaks to newlines in
// the tag soup and then rebuilt each paragraph from its <w:t> contents alone, so
// nothing BETWEEN two runs survived -- every manual line break was silently dropped,
// running an address block or a break-separated duty list together into one line.
const DOCX_RUN_TOKEN = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\b[^>]*>|<w:tab\b[^>]*>/g;

function docxXmlToText(xml) {
  const paragraphs = xml.split(/<\/w:p>/).map((chunk) => {
    let text = "";
    for (const match of chunk.matchAll(DOCX_RUN_TOKEN)) {
      if (match[1] !== undefined) text += match[1];
      else if (match[0].startsWith("<w:br")) text += "\n";
      else text += "\t";
    }
    return decodeXmlEntities(text).trim();
  });
  return paragraphs.filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function extractDocxText(arrayBuffer) {
  const xmlBytes = await extractZipEntry(arrayBuffer, "word/document.xml");
  const xml = new TextDecoder("utf-8").decode(xmlBytes);
  return docxXmlToText(xml);
}

/* ==================================================================================
 * Claude (both live calls -- see module docstring)
 * ================================================================================== */

function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function callClaude(env, { system, content, tool }) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.job_description_claude_api,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: tool.name === "submit_outputs" ? MAX_TOKENS_OUTPUTS : MAX_TOKENS_PREREAD,
      system,
      messages: [{ role: "user", content }],
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Claude API error (${response.status}): ${detail.slice(0, 400)}`);
  }
  const body = await response.json();
  const toolUse = (body.content || []).find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("Claude did not return the expected structured result.");
  return toolUse.input;
}

const PRE_READ_TOOL = {
  name: "submit_pre_read",
  description: "Submit the structured pre-read analysis of this job description.",
  input_schema: {
    type: "object",
    properties: {
      jobTitle: { type: "string", description: "The job title as currently written." },
      categories: {
        type: "array",
        description: "Exactly one entry per Part 2 category, in the given order.",
        items: {
          type: "object",
          properties: {
            key: { type: "string", enum: PART2_CATEGORY_KEYS },
            extractedText: {
              type: "string",
              description: "What the document actually says for this category, condensed but faithful. Empty string if the document says nothing here.",
            },
            status: { type: "string", enum: ["aligned", "minor_drift", "significant_gap"] },
            statusReasoning: { type: "string", description: "One sentence: why this tentative status." },
            // The employer's actual question on this screen is "what's wrong and what
            // would you do about it". A status pill and a sentence of reasoning answered
            // the first half and left the second to them, which is the part the toolkit
            // says takes an hour by hand.
            potentialProblem: {
              type: "string",
              description: "The specific problem with this category as the document has "
                + "it -- name the exact wording at fault. If nothing is wrong, say so in "
                + "a few words rather than inventing a problem.",
            },
            potentialFix: {
              type: "string",
              description: "The concrete change you would make, specific enough to act "
                + "on: proposed replacement wording, or the exact thing to add. If there "
                + "is no problem, say what could still be sharpened, or that nothing "
                + "needs changing.",
            },
          },
          required: ["key", "extractedText", "status", "statusReasoning",
                     "potentialProblem", "potentialFix"],
          additionalProperties: false,
        },
      },
      duties: {
        type: "array",
        description: "Every essential duty listed, split into individual items.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "A short stable slug, e.g. \"duty-1\"." },
            text: { type: "string" },
            drivers: {
              type: "array", items: { type: "string", enum: DRIVER_KEYS },
              description: "Which of the four drivers this duty relates to, if any -- can be empty.",
            },
            vague: { type: "boolean", description: "True for a placeholder duty like \"support operations\" or \"other duties as assigned\"." },
            // Flagging a duty vague and stopping there leaves the employer to work out
            // both why and what to write instead. The suggestion is prefilled into an
            // editable box on the duties screen, so fixing it is a read and a tweak.
            vagueReason: {
              type: "string",
              description: "If vague: one sentence on why this wording tells a candidate "
                + "nothing. Empty string if not vague.",
            },
            vagueFix: {
              type: "string",
              description: "If vague: a concrete rewrite of this duty, in the same voice "
                + "as the rest of the document, specific about what is done and to what. "
                + "Base it on what the rest of the document implies rather than inventing "
                + "work. Empty string if not vague.",
            },
          },
          required: ["id", "text", "drivers", "vague", "vagueReason", "vagueFix"],
          additionalProperties: false,
        },
      },
      driverGuesses: {
        type: "object",
        description: "Your best guess, from the document alone, at each driver question the employer will be asked in Step 3 -- prefilled text the employer confirms or corrects, not a final answer.",
        properties: {
          systems: { type: "string", description: "Guess at systems used on a typical shift (MES, ERP, quality, maintenance)." },
          automation: { type: "string", description: "Guess at whether this person loads, tends, or recovers automated equipment." },
          decisionAuthority: { type: "string", description: "Guess at whether they can stop a line, run inspections, or disposition suspect parts." },
          crossTraining: { type: "string", description: "Guess at whether they regularly cover or rotate into other jobs." },
        },
        required: ["systems", "automation", "decisionAuthority", "crossTraining"],
        additionalProperties: false,
      },
      systemGaps: {
        type: "array",
        description: "Any system, software, or equipment mentioned in the duties but never mentioned in the requirements -- the toolkit's single most common gap.",
        items: { type: "string" },
      },
      technologySummary: {
        type: "string",
        description: "Every system, machine, control, software package and piece of equipment named anywhere in the document, as a plain comma-separated list. Used to match this role against credential competencies, so name the specific thing (\"CNC lathe\", \"hydraulics\", \"MES\") rather than a category.",
      },
      requirements: {
        type: "array",
        description: "Every listed requirement (education, experience, certifications, skills), split into individual items.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "A short stable slug, e.g. \"req-1\"." },
            text: { type: "string" },
            kind: {
              type: "string", enum: ["education", "experience", "certification", "skill", "other"],
              description: "Which Part 2 requirement category this belongs to.",
            },
          },
          required: ["id", "text", "kind"],
          additionalProperties: false,
        },
      },
      onetMatch: {
        type: "object",
        description: "The O*NET-SOC occupation that most closely matches what the duties actually describe.",
        properties: {
          code: { type: "string" }, title: { type: "string" }, reasoning: { type: "string" },
        },
        required: ["code", "title", "reasoning"],
        additionalProperties: false,
      },
      currentTitleOnetGuess: {
        type: "object",
        description: "The O*NET-SOC occupation the CURRENT job title alone would suggest, independent of the duties -- used later to check whether the title itself has drifted from what the role actually is.",
        properties: { code: { type: "string" }, title: { type: "string" } },
        required: ["code", "title"],
        additionalProperties: false,
      },
    },
    required: [
      "jobTitle", "categories", "duties", "driverGuesses", "systemGaps",
      "technologySummary", "requirements", "onetMatch", "currentTitleOnetGuess",
    ],
    additionalProperties: false,
  },
  // Constrains generation to the schema itself rather than merely asking for it, so an
  // out-of-enum status or a missing field cannot come back at all. Requires
  // additionalProperties:false and a complete `required` at every object level, which is
  // why every property above is listed.
  strict: true,
};

function preReadSystemPrompt() {
  return "You are doing the \"pre-read\" step of the Conexus Job Description Toolkit -- " +
    "a manufacturing/industrial job-description update process. Your job is to do ALL " +
    "the reading so the employer only has to confirm or correct your work, never write " +
    "it from scratch. Be thorough and literal: extract what the document actually says, " +
    "don't invent content it doesn't have. Every Part 2 category must be covered even if " +
    "the document says nothing for it (extractedText: \"\", status: \"significant_gap\"). " +
    "Split duties and requirements into individual atomic items rather than leaving " +
    "multi-clause sentences bundled together. The four drivers of role evolution you're " +
    "tagging duties against are: Automation and Robotics, Digitization and Data, " +
    "Decision Authority and Quality, and Cross-Training and Role Convergence. Flag any " +
    "system/software/equipment named in a duty but absent from the requirements -- the " +
    "toolkit calls this the single most common gap in manufacturing job descriptions. " +
    "For every category, give a potential problem and a potential fix -- the fix has to " +
    "be concrete enough for the employer to paste in, not advice to \"consider revising\". " +
    "For every duty you mark vague, say why in one sentence and write the specific " +
    "rewrite you would use. " +
    "Everything you produce here is explicitly labeled as your inference and will be " +
    "shown to the employer to confirm, correct, or reject before it's treated as fact.";
}

async function runPreRead(env, { text, pdfBase64 }) {
  const instruction = "Read this job description and produce the full pre-read analysis " +
    "via the submit_pre_read tool.";
  const content = pdfBase64
    ? [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
        { type: "text", text: instruction },
      ]
    : [{ type: "text", text: `${instruction}\n\n---\n\n${text}` }];
  return callClaude(env, { system: preReadSystemPrompt(), content, tool: PRE_READ_TOOL });
}

/* A document block, shared by the redlined description and the one-pager. Matches
 * src/docx.js's own model exactly, so what Claude returns renders straight to Word with
 * no translation layer in between. */
function documentBlockSchema({ tracked }) {
  // No `bold`: strict mode wants every property in `required`, so an optional formatting
  // flag would cost a field on every single run of the document for something the block
  // styles already handle. src/docx.js still supports bold; the tool just never asks
  // for it.
  const run = {
    type: "object",
    properties: {
      text: { type: "string" },
      ...(tracked ? {
        change: {
          type: "string", enum: ["none", "ins", "del"],
          description: "\"none\" for text carried over from the original unchanged, "
            + "\"ins\" for text you are adding, \"del\" for original text you are removing. "
            + "Split a sentence into several runs so an edit marks only the words that "
            + "actually change, not the whole sentence.",
        },
      } : {}),
    },
    required: tracked ? ["text", "change"] : ["text"],
    additionalProperties: false,
  };
  return {
    type: "array",
    items: {
      type: "object",
      properties: {
        type: {
          type: "string", enum: ["title", "heading1", "heading2", "paragraph", "bullet"],
          description: "One title at the very top; heading1 per major section; bullet for list items.",
        },
        runs: { type: "array", items: run },
      },
      required: ["type", "runs"],
      additionalProperties: false,
    },
  };
}

const OUTPUTS_TOOL = {
  name: "submit_outputs",
  description: "Submit the four deliverables for this job description update.",
  input_schema: {
    type: "object",
    properties: {
      // Read on screen by someone who has just spent fifteen minutes answering
      // questions. Paragraphs went unread; a line and a list of what moved does not.
      summaryHeadline: {
        type: "string",
        description: "One sentence: the single biggest change and why it matters for "
          + "hiring. No preamble, no description of the process.",
      },
      summaryBullets: {
        type: "array",
        description: "Four to eight bullets, the biggest change first. One line each, "
          + "under about twenty words, naming the specific duty, requirement or title "
          + "that moved and what it became -- not \"duties were updated\". If the New "
          + "Role Decision Matrix scored 3 or higher, one bullet says plainly that this "
          + "now reads as a different job.",
        items: { type: "string" },
      },
      documentTitle: {
        type: "string",
        description: "The revised job title. If the title itself is changing, this is the new one.",
      },
      document: {
        ...documentBlockSchema({ tracked: true }),
        description: "The complete revised job description AS A REDLINE against the "
          + "original: every run marked \"none\", \"ins\" or \"del\". Organize it under the "
          + "ten Part 2 categories. Carry unchanged original wording through as \"none\" "
          + "runs rather than rewriting it -- a redline in which everything is new is "
          + "useless to a reviewer. Every change must trace to something the employer "
          + "actually told you.",
      },
      oneSheet: {
        ...documentBlockSchema({ tracked: false }),
        description: "A one-page career-fair handout for this role, per Part 5's talent "
          + "pipeline row: plain-language day in the life, what you will train versus "
          + "what they need on day one, pay range if given, and where the role leads. "
          + "Written for a job seeker or a school counselor, not for HR. No jargon, no "
          + "internal acronyms. Must fit on one page.",
      },
      credentials: {
        type: "array",
        description: "The credentials worth naming in this description, chosen ONLY from "
          + "the shortlist given to you. One to five, fewest first -- if only one "
          + "genuinely fits, return one. Do not pad the list: a credential that is merely "
          + "plausible is worse than no credential, because a school will teach toward it.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Copied exactly from the shortlist." },
            tier: {
              type: "string", enum: ["required", "preferred", "we-provide"],
              description: "Per Part 3: required only if the job genuinely cannot be done "
                + "without it, we-provide when you would rather train or pay for it than "
                + "screen on it.",
            },
            whyItFits: {
              type: "string",
              description: "One sentence tying it to a specific duty or requirement of "
                + "THIS role. If you cannot name one, the credential does not belong here.",
            },
          },
          required: ["name", "tier", "whyItFits"],
          additionalProperties: false,
        },
      },
    },
    required: ["summaryHeadline", "summaryBullets", "documentTitle", "document",
               "oneSheet", "credentials"],
    additionalProperties: false,
  },
  strict: true,
};

function outputsSystemPrompt() {
  return "You are producing the final outputs of a Conexus Job Description Toolkit "
    + "update. No further questions -- generate everything now from what the employer "
    + "has already confirmed.\n\n"
    + "GROUNDING. Every change in the redline must trace to something the employer "
    + "actually told you: a duty they marked changed or no longer done, a requirement "
    + "they moved to preferred or on-the-job, a fact they supplied, or a decision they "
    + "made. Never introduce a change you were not given grounds for, and never invent a "
    + "duty, a system, a pay figure or a credential. Where the employer skipped "
    + "something, leave the original wording alone rather than filling the gap.\n\n"
    + "THE REDLINE IS A REDLINE. Most of the document should come through as unchanged "
    + "runs. Mark an insertion or a deletion only where the employer's answers actually "
    + "move the text, and split sentences so the marks land on the words that change "
    + "rather than on whole paragraphs. A reviewer has to be able to see, at a glance, "
    + "what is different.\n\n"
    + "NEW ROLE VS WRONG TITLE. If the New Role Decision Matrix scored 3 or higher, the "
    + "revised description should read as a genuinely new title, anchored to the O*NET-SOC "
    + "occupation the duties actually match, to apprenticeship.gov, or to an AML ITA "
    + "competency framework -- not a reshuffle of the old one. Below 3 it is the same job "
    + "described better. The toolkit is explicit that a mismatched title is a naming "
    + "problem and a new role is not; do not blur them.\n\n"
    + "REQUIREMENTS. Anything the employer moved out of required must read as preferred, "
    + "or as something you will train, and must not reappear as a screen elsewhere in the "
    + "document. This is the single change with the largest effect on who applies.\n\n"
    + "CREDENTIALS. Choose only from the shortlist you are given, and only what genuinely "
    + "fits this role's duties. One well-matched credential beats four plausible ones: a "
    + "school builds curriculum against what you name here.\n\n"
    + "Plain language throughout, suited to HR leaders, plant supervisors, job seekers "
    + "and school counselors. No consulting register.";
}

function formatConfirmedInputs(session) {
  const lines = [];
  lines.push(`Original job title: ${session.preRead.jobTitle}`);
  if (session.respondent) {
    const r = session.respondent;
    lines.push(`Answered by: ${r.role || "(not given)"}`
      + `${r.hardToFill ? " -- they report this is a HARD-TO-FILL position" : ""}`
      + `${r.lastUpdated ? `. Description last updated: ${r.lastUpdated}` : ""}`);
  }
  lines.push(`\nOriginal document, by Part 2 category:`);
  for (const cat of session.preRead.categories || []) {
    // .find() can miss: the tool schema's enum constrains the key, but nothing
    // guarantees it, and an unmatched key used to throw here -- turning the final
    // (already paid for) generate-outputs call into a 500 with the session's work
    // stranded. Fall back to the raw key instead.
    const known = PART2_CATEGORIES.find((c) => c.key === cat.key);
    lines.push(`- ${(known && known.label) || cat.key}: `
               + `${cat.extractedText || "(nothing in the original)"}`);
  }
  lines.push(`\nStep 3 -- duty-by-duty answers:`);
  for (const duty of session.preRead.duties || []) {
    const a = (session.step3 && session.step3.dutyAnswers && session.step3.dutyAnswers[duty.id]) || {};
    lines.push(`- "${duty.text}" -> ${a.answer || "(unanswered)"}${a.note ? ` (${a.note})` : ""}`);
  }
  if (session.step3 && session.step3.driverAnswers) {
    lines.push(`\nStep 3 -- what's missing (four drivers):`);
    const d = session.step3.driverAnswers;
    lines.push(`- Systems used on a typical shift: ${d.systems || "(none given)"}`);
    lines.push(`- Automated equipment loaded/tended/recovered: ${d.automation || "(none given)"}`);
    lines.push(`- Stop-line/inspection/disposition authority: ${d.decisionAuthority || "(none given)"}`);
    lines.push(`- Cross-training / rotation into other jobs: ${d.crossTraining || "(none given)"}`);
  }
  lines.push(`\nStep 4 -- requirement-by-requirement answers:`);
  for (const req of session.preRead.requirements || []) {
    const a = (session.step4 && session.step4.requirementAnswers && session.step4.requirementAnswers[req.id]) || {};
    lines.push(`- "${req.text}" -> ${a.tier || "(unanswered)"}, incumbents meet it: ${a.incumbentMeets == null ? "(unanswered)" : (a.incumbentMeets ? "yes" : "no")}`);
  }
  if (session.step5) {
    lines.push(`\nStep 5 -- facts the description was missing:`);
    lines.push(`- Pay range: ${session.step5.payRange || "(skipped)"}`);
    lines.push(`- Physical demand frequency: ${session.step5.physicalFrequency || "(skipped)"}`);
    lines.push(`- Pathway (where this leads, how long): ${session.step5.pathway || "(skipped)"}`);
  }
  if (session.step6) {
    lines.push(`\nStep 6 -- New Role Decision Matrix score: ${session.step6.score} of 5.`);
    for (const item of session.step6.matrix) {
      lines.push(`- ${item.label}: ${item.value ? "yes" : "no"}${item.overridden ? " (employer override)" : ""} -- ${item.reasoning}`);
    }
    lines.push(`Recommendation: ${session.step6.recommendation}`);
  }
  if (session.secondRespondent && session.secondRespondent.step3Answers) {
    lines.push(`\nA second respondent (${session.secondRespondent.role}) also reviewed the duties; any disagreements were resolved by the primary respondent above.`);
  }

  // The shortlist, already narrowed from all 30 credentials in the reference matrix by
  // src/credentials.js against this role's own duties. Presented as candidates, not as
  // an answer: the instruction is still to drop any that do not genuinely fit.
  lines.push(`\nCredential shortlist for this role -- the closest ${(session.credentialShortlist || []).length} `
    + `of the reference matrix, scored against the duties above. Choose ONLY from these, `
    + `and only the ones that genuinely fit:\n`);
  lines.push(formatShortlist(session.credentialShortlist || []));
  return lines.join("\n");
}

/**
 * One plain-text rendering of the on-screen summary, for the Box copy and for anything
 * that only wants a string. Sessions generated before the summary became a headline plus
 * bullets still carry a single `summary` paragraph, so that is honoured as a fallback
 * rather than being lost when an old session is re-opened.
 */
function composeSummary(outputs) {
  const bullets = Array.isArray(outputs.summaryBullets) ? outputs.summaryBullets : [];
  if (!outputs.summaryHeadline && !bullets.length) return String(outputs.summary || "");
  return [
    String(outputs.summaryHeadline || "").trim(),
    ...bullets.map((b) => `- ${String(b).trim()}`),
  ].filter(Boolean).join("\n");
}

async function runOutputs(env, session) {
  const content = [{ type: "text", text: formatConfirmedInputs(session) }];
  const outputs = await callClaude(env, { system: outputsSystemPrompt(), content, tool: OUTPUTS_TOOL });
  outputs.summary = composeSummary(outputs);
  return outputs;
}

/* ==================================================================================
 * Session helpers
 * ================================================================================== */

function sessionKey(id) { return `${SESSION_PREFIX}${id}`; }

async function getSession(env, id) {
  const raw = await env.BOX_KV.get(sessionKey(id));
  return raw ? JSON.parse(raw) : null;
}
async function saveSession(env, session) {
  session.updatedAt = new Date().toISOString();
  await env.BOX_KV.put(sessionKey(session.id), JSON.stringify(session));
}

function publicSession(session) {
  // Everything -- there's no admin-private guidance to strip here, unlike Consensus's
  // survey objective/context. The whole session belongs to the employer using it.
  return session;
}

/* ==================================================================================
 * Step 6 matrix
 * ================================================================================== */

function computeMatrix(session, { screenDifferently, compChanges, overrides }) {
  overrides = overrides || {};
  const duties = session.preRead.duties || [];
  const answers = (session.step3 && session.step3.dutyAnswers) || {};
  const changedOrGone = duties.filter((d) => {
    const a = answers[d.id];
    return a && (a.answer === "changed" || a.answer === "no_longer_done");
  }).length;
  const majorityChanged = duties.length > 0 && changedOrGone / duties.length > 0.5;

  // "A distinct technical competency set the original title does not imply", per the
  // toolkit's Part 4. It used to be read off a per-requirement credential guess the
  // pre-read made before the employer had answered anything; now it comes from two
  // things that are actually known by this point -- the employer keeping a technical
  // requirement as must-have, and the credential scorer finding a specific credential
  // (a named NIMS, MSSC or Ivy Tech program, not a general pathway) that matches the
  // duties closely. Both together are what "distinct competency set" means.
  const requirements = session.preRead.requirements || [];
  const reqAnswers = (session.step4 && session.step4.requirementAnswers) || {};
  const keptTechnicalRequirement = requirements.some((r) => {
    const a = reqAnswers[r.id];
    return a && a.tier === "must_have"
      && (r.kind === "certification" || r.kind === "skill" || r.kind === "experience");
  });
  const shortlist = session.credentialShortlist || [];
  const namedCredentialFits = shortlist.length > 0
    && shortlist[0].family !== "Pathway" && shortlist[0].score >= 0.12;
  const distinctCompetency = keptTechnicalRequirement && namedCredentialFits;

  const differentOnet = session.preRead.onetMatch && session.preRead.currentTitleOnetGuess
    && session.preRead.onetMatch.code !== session.preRead.currentTitleOnetGuess.code;

  const items = [
    {
      id: "duties_changed", label: "More than half of daily duties differ from the description",
      computed: true, value: overrides.duties_changed != null ? overrides.duties_changed : majorityChanged,
      overridden: overrides.duties_changed != null,
      reasoning: `${changedOrGone} of ${duties.length} duties were marked changed or no longer done in Step 3.`,
    },
    {
      id: "distinct_competency", label: "A distinct technical competency set the original title doesn't imply",
      computed: true, value: overrides.distinct_competency != null ? overrides.distinct_competency : distinctCompetency,
      overridden: overrides.distinct_competency != null,
      reasoning: distinctCompetency
        ? `A must-have technical requirement was kept, and the duties map closely to ${shortlist[0].name}.`
        : (keptTechnicalRequirement
          ? "A must-have technical requirement was kept, but the duties do not map closely to any one named credential."
          : "No technical requirement was kept as must-have."),
    },
    {
      id: "screen_differently", label: "Would screen and interview differently",
      computed: false, value: !!screenDifferently, overridden: false,
      reasoning: "Employer answer.",
    },
    {
      id: "different_onet", label: "Maps more closely to a different O*NET-SOC than the current title",
      computed: true, value: overrides.different_onet != null ? overrides.different_onet : !!differentOnet,
      overridden: overrides.different_onet != null,
      reasoning: differentOnet
        ? `Duties match ${session.preRead.onetMatch.code} (${session.preRead.onetMatch.title}), while the current title suggests ${session.preRead.currentTitleOnetGuess.code} (${session.preRead.currentTitleOnetGuess.title}).`
        : "Duties still match the O*NET-SOC occupation the current title suggests.",
    },
    {
      id: "comp_changes", label: "Compensation, progression, or reporting would change",
      computed: false, value: !!compChanges, overridden: false,
      reasoning: "Employer answer.",
    },
  ];
  const score = items.filter((i) => i.value).length;
  const recommendation = score <= 1
    ? "Update the existing description."
    : score === 2
    ? "Revise thoroughly and monitor."
    : "Create a new title, anchored to an O*NET-SOC code, apprenticeship.gov, or an AML ITA competency framework.";
  return { matrix: items, score, recommendation };
}

/* ==================================================================================
 * routes
 * ================================================================================== */

export async function handleJobDescriptionApi(route, request, env) {
  const method = request.method.toUpperCase();
  const parts = route.split("/").filter(Boolean);

  if (!env.BOX_KV) return json({ error: "BOX_KV binding is missing -- see SETUP.md." }, 500);

  /* ==================== Public (the employer's own flow -- no login, same as
     Consensus's respondent chat) ==================== */

  // POST upload (multipart: file) -> parses the document, runs the pre-read, creates
  // the session, and (if a data folder is configured) saves the source file to Box.
  if (route === "upload" && method === "POST") {
    if (!env.job_description_claude_api) {
      return json({ error: "The Job Description Updater's Claude key isn't set up yet "
        + "(job_description_claude_api) -- see SETUP.md." }, 500);
    }
    let incoming;
    try { incoming = await request.formData(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const file = incoming.get("file");
    if (!(file instanceof File)) return json({ error: "Choose a job description file (PDF or .docx) first." }, 400);
    const lowerName = file.name.toLowerCase();
    const isPdf = lowerName.endsWith(".pdf") || file.type === "application/pdf";
    const isDocx = lowerName.endsWith(".docx");
    if (!isPdf && !isDocx) return json({ error: "Only PDF and .docx files are supported." }, 400);

    const arrayBuffer = await file.arrayBuffer();
    let preRead;
    try {
      if (isPdf) {
        preRead = await runPreRead(env, { pdfBase64: bytesToBase64(new Uint8Array(arrayBuffer)) });
      } else {
        const text = await extractDocxText(arrayBuffer);
        if (!text.trim()) return json({ error: "Couldn't find any text in that .docx file." }, 400);
        preRead = await runPreRead(env, { text });
      }
    } catch (e) {
      return json({ error: e.message || "Could not read that file." }, 502);
    }
    preRead.confirmed = false;

    const id = newId();
    const session = {
      id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      status: "pre_read", sourceFile: { name: file.name, mimeType: file.type || "", boxFileId: null },
      preRead,
      // Collected on the upload screen rather than on one of its own: three fields the
      // employer can answer while the pre-read is still running, which removes a whole
      // screen from the flow without losing the toolkit's "who is answering" context.
      respondent: {
        role: String(incoming.get("role") || "").trim(),
        hardToFill: String(incoming.get("hardToFill") || "") === "true",
        lastUpdated: String(incoming.get("lastUpdated") || "").trim(),
      },
      // Scored once, here, from the pre-read's own extraction -- no API call. Stored on
      // the session so the requirements screen can show it and the outputs call can
      // choose from it without recomputing.
      credentialShortlist: shortlistCredentials({
        title: preRead.jobTitle,
        duties: (preRead.duties || []).map((d) => d.text),
        requirements: (preRead.requirements || []).map((r) => r.text),
        technology: preRead.technologySummary || "",
      }, CREDENTIAL_SHORTLIST_SIZE),
      supervisorInvite: null, secondRespondent: null,
      step3: null, step4: null, step5: null, step6: null, outputs: null,
    };

    const folder = await getFolder(env);
    const token = await boxAccessToken(env);
    if (folder && token) {
      try {
        const headers = { authorization: `Bearer ${token}` };
        const subfolder = await boxCreateSubfolder(headers, folder.id, `${id} - ${file.name}`);
        const uploaded = await boxUploadFile(headers, subfolder.id, file.name, file);
        session.sourceFile.boxFileId = uploaded.id;
        session.boxSubfolderId = subfolder.id;
      } catch (e) { /* not fatal -- the session still works, just isn't backed by Box yet */ }
    }

    await saveSession(env, session);
    return json({ ok: true, session: publicSession(session) });
  }

  // GET session/<id> -> the full session, for resuming.
  if (parts[0] === "session" && parts.length === 2 && method === "GET") {
    const session = await getSession(env, parts[1]);
    if (!session) return json({ error: "Session not found" }, 404);
    return json(publicSession(session));
  }

  // POST session/<id>/confirm-pre-read { edits? } -> merges any corrections the
  // employer made into the pre-read, then marks it confirmed.
  if (parts[0] === "session" && parts.length === 3 && parts[2] === "confirm-pre-read" && method === "POST") {
    const session = await getSession(env, parts[1]);
    if (!session) return json({ error: "Session not found" }, 404);
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    // This route is public (the employer's own flow has no login), so the edits are
    // untrusted. Blindly Object.assign-ing them used to let any caller replace
    // preRead.duties / .requirements / .categories with a non-array, which then threw
    // deep inside computeMatrix()/findConflicts()/generate-outputs as a 500 several
    // steps later. Only the one field the UI actually edits is taken, and it's merged
    // onto the stored categories by key rather than replacing the array wholesale.
    const edits = (body.edits && typeof body.edits === "object") ? body.edits : {};
    if (Array.isArray(edits.categories) && Array.isArray(session.preRead.categories)) {
      const editedText = new Map();
      for (const c of edits.categories) {
        if (c && typeof c === "object" && typeof c.key === "string") {
          editedText.set(c.key, String(c.extractedText == null ? "" : c.extractedText));
        }
      }
      for (const cat of session.preRead.categories) {
        if (editedText.has(cat.key)) cat.extractedText = editedText.get(cat.key);
      }
    }
    session.preRead.confirmed = true;
    await saveSession(env, session);
    return json({ ok: true, session: publicSession(session) });
  }

  // POST session/<id>/invite-supervisor -> creates a shareable link for Steps 3-4.
  if (parts[0] === "session" && parts.length === 3 && parts[2] === "invite-supervisor" && method === "POST") {
    const session = await getSession(env, parts[1]);
    if (!session) return json({ error: "Session not found" }, 404);
    const token = newId();
    await env.BOX_KV.put(`${INVITE_PREFIX}${token}`, JSON.stringify({ sessionId: session.id, createdAt: new Date().toISOString() }));
    session.supervisorInvite = { token, status: "sent", sentAt: new Date().toISOString(), respondedAt: null };
    await saveSession(env, session);
    const url = new URL(request.url);
    return json({ ok: true, url: `${url.origin}/job-description/respond.html?token=${token}` });
  }

  // POST session/<id>/step3 { dutyAnswers, driverAnswers, dutyEdits } -> the primary
  // respondent's reality-check on duties + what's missing. If a second respondent already
  // answered, returns any duties where the two disagree for the primary to resolve.
  if (parts[0] === "session" && parts.length === 3 && parts[2] === "step3" && method === "POST") {
    const session = await getSession(env, parts[1]);
    if (!session) return json({ error: "Session not found" }, 404);
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    // A duty flagged vague can be rewritten right there on the duties screen, so the
    // fix lands in the source of truth every later step reads rather than in a note
    // nobody acts on. This route is public, so the edits are matched against the duty
    // ids already in the pre-read -- an unknown id adds nothing, and a non-string is
    // ignored rather than replacing a duty's text with an object.
    const dutyEdits = (body.dutyEdits && typeof body.dutyEdits === "object") ? body.dutyEdits : {};
    for (const duty of (session.preRead.duties || [])) {
      if (!Object.prototype.hasOwnProperty.call(dutyEdits, duty.id)) continue;
      const edited = dutyEdits[duty.id];
      if (typeof edited !== "string") continue;
      const trimmed = edited.trim().slice(0, 1000);
      if (!trimmed || trimmed === duty.text) continue;
      duty.originalText = duty.originalText || duty.text;
      duty.text = trimmed;
      // The employer has just replaced the placeholder wording, so the flag (and the
      // suggestion that went with it) no longer describes what is there.
      duty.vague = false;
      duty.vagueReason = "";
      duty.vagueFix = "";
    }
    session.step3 = {
      dutyAnswers: body.dutyAnswers && typeof body.dutyAnswers === "object" ? body.dutyAnswers : {},
      driverAnswers: body.driverAnswers && typeof body.driverAnswers === "object" ? body.driverAnswers : {},
    };
    session.status = "requirements";
    const conflicts = findConflicts(session);
    await saveSession(env, session);
    return json({ ok: true, session: publicSession(session), conflicts });
  }

  // POST session/<id>/resolve-conflicts { resolutions: { dutyId: answer } }
  if (parts[0] === "session" && parts.length === 3 && parts[2] === "resolve-conflicts" && method === "POST") {
    const session = await getSession(env, parts[1]);
    if (!session || !session.step3) return json({ error: "Session not found" }, 404);
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const resolutions = (body.resolutions && typeof body.resolutions === "object") ? body.resolutions : {};
    for (const [dutyId, answer] of Object.entries(resolutions)) {
      if (session.step3.dutyAnswers[dutyId]) session.step3.dutyAnswers[dutyId].answer = answer;
    }
    await saveSession(env, session);
    return json({ ok: true, session: publicSession(session) });
  }

  // POST session/<id>/step4 { requirementAnswers }
  if (parts[0] === "session" && parts.length === 3 && parts[2] === "step4" && method === "POST") {
    const session = await getSession(env, parts[1]);
    if (!session) return json({ error: "Session not found" }, 404);
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    session.step4 = { requirementAnswers: body.requirementAnswers && typeof body.requirementAnswers === "object" ? body.requirementAnswers : {} };
    session.status = "finalize";
    await saveSession(env, session);
    return json({ ok: true, session: publicSession(session) });
  }

  // GET session/<id>/matrix -> the New Role Decision Matrix as it currently stands.
  // Three of its five questions are computed from answers already given, so the screen
  // can show a live score while the employer answers the other two.
  if (parts[0] === "session" && parts.length === 3 && parts[2] === "matrix" && method === "GET") {
    const session = await getSession(env, parts[1]);
    if (!session) return json({ error: "Session not found" }, 404);
    return json(computeMatrix(session, {}));
  }

  // POST session/<id>/finalize { payRange, physicalFrequency, pathway,
  //                              screenDifferently, compChanges, overrides }
  // The toolkit's Part 3 missing facts and its Part 4 decision, answered together.
  // They used to be two screens; they are five short questions between them, and asking
  // them on one screen is what lets the employer see the matrix score move as they
  // answer rather than after.
  if (parts[0] === "session" && parts.length === 3 && parts[2] === "finalize" && method === "POST") {
    const session = await getSession(env, parts[1]);
    if (!session) return json({ error: "Session not found" }, 404);
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    session.step5 = {
      payRange: String(body.payRange || "").trim(),
      physicalFrequency: String(body.physicalFrequency || "").trim(),
      pathway: String(body.pathway || "").trim(),
    };
    session.step6 = computeMatrix(session, {
      screenDifferently: body.screenDifferently, compChanges: body.compChanges,
      overrides: body.overrides,
    });
    session.status = "outputs";
    await saveSession(env, session);
    return json({ ok: true, session: publicSession(session) });
  }

  // POST session/<id>/generate-outputs -> the final Claude call. Builds the three Word
  // files and saves them to Box alongside the source document.
  if (parts[0] === "session" && parts.length === 3 && parts[2] === "generate-outputs" && method === "POST") {
    if (!env.job_description_claude_api) {
      return json({ error: "The Job Description Updater's Claude key isn't set up yet "
        + "(job_description_claude_api) -- see SETUP.md." }, 500);
    }
    const session = await getSession(env, parts[1]);
    if (!session) return json({ error: "Session not found" }, 404);
    if (!session.step6) {
      return json({ error: "Answer the last few questions first." }, 409);
    }
    let outputs;
    try {
      outputs = await runOutputs(env, session);
    } catch (e) {
      return json({ error: e.message || "Could not generate the outputs." }, 502);
    }
    outputs.generatedAt = new Date().toISOString();
    outputs.box = { saved: false };
    session.outputs = outputs;

    const token = await boxAccessToken(env);
    if (token && session.boxSubfolderId) {
      try {
        const headers = { authorization: `Bearer ${token}` };
        // Same three files the employer downloads, so Box holds the deliverables rather
        // than only the source document.
        await Promise.all(DOWNLOADS.map(({ kind }) => {
          const { filename, bytes } = renderDownload(session, kind);
          return boxUploadFile(headers, session.boxSubfolderId, filename,
            new Blob([bytes], { type: DOCX_MIME }));
        }).concat([
          boxUploadFile(headers, session.boxSubfolderId, "summary-of-changes.txt",
            new Blob([outputs.summary || ""], { type: "text/plain" })),
        ]));
        outputs.box = { saved: true };
      } catch (e) {
        outputs.box = { saved: false, error: e.message };
      }
    }

    session.status = "complete";
    await saveSession(env, session);
    return json({ ok: true, session: publicSession(session) });
  }

  // GET session/<id>/download/<kind> -> one of the three Word files.
  //
  // Rebuilt from the stored document model on each request rather than kept as bytes in
  // KV: the model is a fraction of the size, and it means a fix to src/docx.js applies
  // to sessions that were generated before it.
  if (parts[0] === "session" && parts.length === 4 && parts[2] === "download" && method === "GET") {
    const session = await getSession(env, parts[1]);
    if (!session) return json({ error: "Session not found" }, 404);
    if (!session.outputs) return json({ error: "Nothing has been generated for this session yet." }, 409);
    if (!DOWNLOAD_KINDS.has(parts[3])) return json({ error: "Unknown download." }, 404);
    const { filename, bytes } = renderDownload(session, parts[3]);
    return new Response(bytes, {
      headers: {
        "content-type": DOCX_MIME,
        // The quoted filename is what the browser saves it as. No user-controlled text
        // reaches this header unescaped -- see slugify() in renderDownload.
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  }

  /* ==================== Public (supervisor/incumbent shareable link) ==================== */

  // GET invite/<token> -> the duties/requirements this second respondent needs to see.
  if (parts[0] === "invite" && parts.length === 2 && method === "GET") {
    const raw = await env.BOX_KV.get(`${INVITE_PREFIX}${parts[1]}`);
    if (!raw) return json({ error: "This link isn't valid, or has expired." }, 404);
    const { sessionId } = JSON.parse(raw);
    const session = await getSession(env, sessionId);
    if (!session) return json({ error: "This link isn't valid any more." }, 404);
    return json({
      jobTitle: session.preRead.jobTitle,
      duties: session.preRead.duties.map((d) => ({ id: d.id, text: d.text })),
      alreadyResponded: session.secondRespondent != null,
    });
  }

  // POST invite/<token>/step3 { role, dutyAnswers } -> records the second respondent's
  // own duty-by-duty answers (comparison happens on the primary's own step3, or here if
  // the primary already answered).
  if (parts[0] === "invite" && parts.length === 3 && parts[2] === "step3" && method === "POST") {
    const raw = await env.BOX_KV.get(`${INVITE_PREFIX}${parts[1]}`);
    if (!raw) return json({ error: "This link isn't valid, or has expired." }, 404);
    const { sessionId } = JSON.parse(raw);
    const session = await getSession(env, sessionId);
    if (!session) return json({ error: "This link isn't valid any more." }, 404);
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    session.secondRespondent = {
      role: String(body.role || "").trim() || "supervisor",
      step3Answers: body.dutyAnswers && typeof body.dutyAnswers === "object" ? body.dutyAnswers : {},
    };
    if (session.supervisorInvite) {
      session.supervisorInvite.status = "responded";
      session.supervisorInvite.respondedAt = new Date().toISOString();
    }
    await saveSession(env, session);
    return json({ ok: true });
  }

  /* ==================== Admin (beta account required) ==================== */

  const auth = await requireBetaAuth(request, env);
  if (!auth) return json({ error: "Not signed in" }, 401);

  // GET box/folders?id=0 -- same folder-picker copy every other mini app here has.
  if (route === "box/folders" && method === "GET") {
    const token = await boxAccessToken(env);
    if (!token) return json({ error: "Box is not connected yet." }, 409);
    const id = new URL(request.url).searchParams.get("id") || "0";
    const headers = { authorization: `Bearer ${token}` };
    const [infoRes, itemsRes] = await Promise.all([
      fetch(`${BOX_API}/folders/${id}?fields=name,path_collection`, { headers }),
      fetch(`${BOX_API}/folders/${id}/items?fields=name,type&limit=1000`, { headers }),
    ]);
    if (!infoRes.ok || !itemsRes.ok) {
      return json({ error: `Box API error (${infoRes.status}/${itemsRes.status})` }, 502);
    }
    const info = await infoRes.json();
    const items = await itemsRes.json();
    const breadcrumb = [...((info.path_collection && info.path_collection.entries) || [])
      .map((e) => ({ id: e.id, name: e.name })), { id, name: info.name }];
    const folders = (items.entries || []).filter((e) => e.type === "folder")
      .map((e) => ({ id: e.id, name: e.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return json({ id, name: info.name, breadcrumb, folders });
  }

  if (route === "box/status" && method === "GET") {
    const token = await boxAccessToken(env);
    const folder = await getFolder(env);
    return json({ connected: !!token, folder: folder || null });
  }

  if (route === "box/select-folder" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    if (!body.folderId) return json({ error: "folderId is required" }, 400);
    await env.BOX_KV.put(FOLDER_KEY, JSON.stringify({ id: String(body.folderId), name: String(body.folderName || "") }));
    return json({ ok: true });
  }

  if (route === "box/test" && method === "POST") {
    const token = await boxAccessToken(env);
    if (!token) return json({ error: "Box is not connected yet -- open the control panel and log in with Box." }, 409);
    const folder = await getFolder(env);
    if (!folder) return json({ error: "Pick a data folder first." }, 409);
    try {
      const headers = { authorization: `Bearer ${token}` };
      const payload = { ok: true, writtenAt: new Date().toISOString(), by: auth.email };
      const uploaded = await boxUploadFile(headers, folder.id, "jobdesc-connection-test.json", new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
      const readBackRes = await fetch(`${BOX_API}/files/${uploaded.id}/content`, { headers });
      return json({ ok: true, wrote: payload, readBack: readBackRes.ok ? await readBackRes.json() : null });
    } catch (e) {
      return json({ error: e.message || "Box round-trip failed." }, 502);
    }
  }

  if (route === "status" && method === "GET") {
    const folder = await getFolder(env);
    return json({
      folder: folder || null,
      claudeKeyConfigured: !!env.job_description_claude_api,
    });
  }

  // GET sessions -> summaries, for the control panel's oversight list.
  if (route === "sessions" && method === "GET") {
    const list = await env.BOX_KV.list({ prefix: SESSION_PREFIX });
    const sessions = await Promise.all(list.keys.map(async (k) => {
      const raw = await env.BOX_KV.get(k.name);
      return raw ? JSON.parse(raw) : null;
    }));
    const summaries = sessions.filter(Boolean).map((s) => ({
      id: s.id, createdAt: s.createdAt, updatedAt: s.updatedAt, status: s.status,
      jobTitle: s.preRead && s.preRead.jobTitle, sourceFileName: s.sourceFile && s.sourceFile.name,
      hasSecondRespondent: !!s.secondRespondent, outputsSaved: !!(s.outputs && s.outputs.box && s.outputs.box.saved),
    })).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return json({ sessions: summaries });
  }

  return json({ error: "Not found" }, 404);
}

function findConflicts(session) {
  if (!session.secondRespondent || !session.secondRespondent.step3Answers) return [];
  const primary = session.step3.dutyAnswers || {};
  const secondary = session.secondRespondent.step3Answers || {};
  const conflicts = [];
  for (const duty of session.preRead.duties || []) {
    const p = primary[duty.id], s = secondary[duty.id];
    if (p && s && p.answer && s.answer && p.answer !== s.answer) {
      conflicts.push({ dutyId: duty.id, text: duty.text, primaryAnswer: p.answer, secondaryAnswer: s.answer });
    }
  }
  return conflicts;
}

/* ==================================================================================
 * The three Word downloads
 * ================================================================================== */

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// The redline is generated; the final version is the redline with its deletions dropped
// and its insertions accepted (see src/docx.js's cleanCopy). Generating the description
// twice would have doubled the output tokens of the most expensive call in the app and
// let the two documents drift apart; deriving one from the other makes that impossible.
const DOWNLOADS = [
  { kind: "redline", suffix: "redline", tracked: true },
  { kind: "final", suffix: "final", tracked: false },
  { kind: "one-pager", suffix: "career-fair-one-pager", tracked: false },
];
const DOWNLOAD_KINDS = new Set(DOWNLOADS.map((d) => d.kind));

/* A filename-safe slug. Also what keeps the Content-Disposition header free of
   user-controlled quotes, newlines or semicolons -- the job title reaches it. */
function slugify(title) {
  return String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 60) || "job-description";
}

function renderDownload(session, kind) {
  const outputs = session.outputs || {};
  const slug = slugify(outputs.documentTitle || (session.preRead && session.preRead.jobTitle));
  const document = Array.isArray(outputs.document) ? outputs.document : [];
  const spec = DOWNLOADS.find((d) => d.kind === kind);

  if (kind === "one-pager") {
    const oneSheet = Array.isArray(outputs.oneSheet) ? outputs.oneSheet : [];
    return {
      filename: `${slug}-${spec.suffix}.docx`,
      bytes: buildDocx({ blocks: oneSheet }),
    };
  }
  return {
    filename: `${slug}-${spec.suffix}.docx`,
    bytes: buildDocx({
      blocks: spec.tracked ? document : cleanCopy(document),
      author: "Conexus Job Description Updater",
      date: outputs.generatedAt || null,
    }),
  };
}
