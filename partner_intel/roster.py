"""The partner roster as the Worker hands it over (the admin panel owns it; this module only
reads it). One record per organization:

  {id, name, industry, status, program, participationId, contacts: [names], aliases: [names]}

status is "Active" for a current member. Anything else (Inactive, Non-member) is kept so
notes about a partner who has since left still attach to the right company.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Roster:
    partners: list[dict] = field(default_factory=list)
    aliases: dict[str, str] = field(default_factory=dict)  # alias text -> company id
    staff: list[str] = field(default_factory=list)
    updated_at: str = ""

    @classmethod
    def from_payload(cls, payload: dict | None) -> "Roster":
        payload = payload or {}
        partners = []
        for p in payload.get("partners") or []:
            if not isinstance(p, dict) or not p.get("id") or not str(p.get("name") or "").strip():
                continue
            partners.append({
                "id": str(p["id"]),
                "name": str(p["name"]).strip(),
                "industry": str(p.get("industry") or "").strip(),
                "status": str(p.get("status") or "Active").strip(),
                "program": str(p.get("program") or "").strip(),
                "participationId": str(p.get("participationId") or "").strip(),
                "contacts": [str(c).strip() for c in (p.get("contacts") or []) if str(c).strip()],
                "aliases": [str(a).strip() for a in (p.get("aliases") or []) if str(a).strip()],
            })
        aliases = {str(k): str(v) for k, v in (payload.get("aliases") or {}).items() if k and v}
        staff = [str(s).strip() for s in (payload.get("staff") or []) if str(s).strip()]
        return cls(partners, aliases, staff, str(payload.get("updatedAt") or ""))

    def by_id(self) -> dict[str, dict]:
        return {p["id"]: p for p in self.partners}
