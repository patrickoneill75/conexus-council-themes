# Working preferences

## Always finish with a pull request

Every time you make edits, end by preparing a PR. Commit, push, and open it
automatically, without waiting to be asked. This applies every time, not just when
it was requested in the moment, and it applies to a one-line fix as much as to a
batch of work.

Before opening it, check the state of any existing PR for the branch:

1. **No PR for this branch** -- open one.
2. **An open PR exists** -- push to the branch; the commits join that PR. Update its
   title and body if the scope has changed.
3. **The PR is already merged or closed** -- open a NEW one. A merged PR cannot pick
   up new commits. Editing its body does not create a PR, and the work sits unmerged
   on the branch looking finished when it is not. This has happened; do not repeat it.

If the branch was merged and `main` has moved on, rebase the unmerged commits onto the
current `main` before opening the new PR. Keep those commits -- do not reset the branch
and discard them.

Finish by stating the PR number and URL. If you did not open one, say so and why.

# Standing decisions

Decisions already made and settled. Act on these rather than re-asking.

## Deliverables

1. Employer-facing documents ship as **.docx**, not PDF. Word gives native tracked
   changes, so a redline arrives as something the reader can Accept or Reject per
   change; a PDF can only show a picture of a strikethrough. The Worker has no PDF
   library and a .docx is a ZIP of XML, so Word is also less code.
2. `src/docx.js` is the writer. It takes a flat block/run model and produces the file
   in the Worker, no npm dependency. Extend it rather than adding a library.
3. When a document is needed in both marked-up and clean form, generate the **redline
   once** and derive the clean copy from it (`cleanCopy`). Generating both doubles the
   output tokens of the most expensive call and lets the two drift apart.
4. Prefer fewer, better outputs. The Job Description Updater went from eight
   deliverables to four because the extra five were not being read.

## Claude API usage

1. `claude-opus-5` is the default. Do not downgrade for cost without being asked.
   `claude-sonnet-5` and `claude-haiku-4-5` are the current cheaper tiers where a
   guide or the user calls for one.
2. Budget **two Claude calls per user session** as the target. Everything between them
   should be the user confirming what an earlier call already extracted.
3. Set `strict: true` on tool definitions, with `additionalProperties: false` and a
   complete `required` at every object level. This constrains generation to the schema
   instead of merely asking for it.
4. **No prompt caching on low-volume employer flows.** A cache write costs 1.25x and a
   read 0.1x against a five-minute TTL. Sessions here are minutes to days apart, so a
   cached prefix is paid for and never read -- caching raises the bill.
5. Before large prompts, narrow the input **deterministically** in code. Handing the
   model a catalogue and asking it to choose produces padded answers; handing it a
   scored shortlist of eight produces a decision. Cheap step thorough, expensive step
   small.
6. Worker code calls the Messages API with raw `fetch()`. Python pipelines use the
   `anthropic` SDK. Do not mix them.

## Credential recommendations

1. `src/data/credentials.json` is generated. Rebuild it with
   `python3 scripts/build_credentials.py <credential_competency_matrix.xlsx>` when the
   workbook changes; never hand-edit the JSON.
2. Recommend **1-5 credentials, precision over recall**. If only two genuinely align,
   return two. A merely plausible credential is worse than none, because a training
   provider builds curriculum against whatever gets named.
3. The tokenizer in `scripts/build_credentials.py` and the one in `src/credentials.js`
   must stay identical. A test enforces it; if you change one, change both.
4. Scoring is TF-IDF, not raw overlap. Without the IDF half, "safety", "quality" and
   "process" decide every comparison and MSSC/OSHA win regardless of the role.
5. Two domain rules are encoded and should stay: OSHA **General Industry** outranks the
   Construction cards (this is an Advanced Manufacturing and Logistics tool), and no
   single credential family may monopolise the shortlist (NIMS publishes fourteen
   machining cards and would otherwise fill it).

## The Job Description Toolkit

1. The app mirrors the toolkit's five parts. Keep that mapping; it is the product.
2. Two steps are **not** optimisations to remove, however tempting:
   - the pre-read confirmation, because the whole method depends on the employer
     confirming before anything counts as fact;
   - the second-respondent invite, because the toolkit is explicit that an incumbent
     and a supervisor should read it separately.
3. Streamline by **collapsing what is already fine**, not by asking less. The Part 2
   audit still covers all ten categories; only the drifted ones open by default.

## Worker constraints

1. Zero npm runtime dependencies in `src/`. Everything is built on platform APIs
   (`fetch`, `crypto.subtle`, `DecompressionStream`, `FormData`).
2. Look a key up in an object that came from a request with `Object.create(null)` or an
   own-property guard. A plain `{}` inherits `Object.prototype`, so `"constructor"` and
   `"toString"` resolve to functions and slip past `if (!x)` guards.
3. Box uploads upsert by name: look the file up first and PUT a new version if it
   exists. Always creating a new file 409s on the second run.

# Tests

`./tests/run_all.sh` runs both suites and must stay green.

1. `tests/test_pipelines.py` -- the Python pipelines, via `unittest`.
2. `tests/worker_test.mjs` -- the Worker's real route handlers against an in-memory KV
   stub and a stubbed `fetch`. It mirrors `src/` to a temp directory and adds the
   `with { type: "json" }` import attribute Node requires and Wrangler does not.

Write a regression test for every bug fixed, and name the bug in the test. A test that
does not fail against the unfixed code is not a regression test -- check it does.
