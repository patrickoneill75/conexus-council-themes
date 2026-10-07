"""Partner Intelligence: turns the meeting notes in one Box folder tree into a searchable
record of what Conexus partners are struggling with, what they have solved, and who can
help whom.

The pipeline runs in GitHub Actions (daily, and on demand from the admin panel) and talks
to the Worker only through its relay routes, so no Box credential ever leaves the Worker
(see src/partner_intel.js). Stages, in order:

  text.py     Box file bytes to plain text (docx, txt, md, vtt, srt, text PDF, html).
  shape.py    Recognize the note format and split it into units a model can read whole.
  dates.py    Meeting date: text first, then file name, then Box upload date.
  roster.py   Roster rows and alias generation.
  resolve.py  Match company and person names to the roster, in code, before any model.
  extract.py  One Claude call per unit, strict tool schema, quotes verified against source.
  build.py    Merge, de-duplicate and publish the dataset the Worker reads.
  run.py      Walk Box, skip what has not changed, call the stages above.

Every Claude output is stored with its metadata and reused (see extract.cache_key), so a
re-scan, a roster change or a rebuild costs nothing for text that has not changed.
"""
