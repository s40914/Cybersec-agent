"""Deterministyczne tworzenie Finding z wynikow RE/SAST (bez LLM)."""
from __future__ import annotations

import logging
import re
from uuid import uuid4

from finding_builder import FindingBuilder
from security_models import Evidence, EvidenceType

logger = logging.getLogger("orchestrator")

_SEMGREP_SEVERITY = {"ERROR": "high", "WARNING": "medium", "INFO": "low"}
_YARA_LINE = re.compile(r"^(\S+)\s*(\[.*?\])?\s+\S+$")
_LEVELS = ("critical", "high", "medium", "low")


def _yara_hits(result: dict) -> list[dict]:
    text = result.get("operations", {}).get("yara", {}).get("stdout", "")
    hits = []
    for line in text.splitlines():
        m = _YARA_LINE.match(line.strip())
        if not m:
            continue
        meta = m.group(2) or ""
        sev = re.search(r'severity="([^"]*)"', meta)
        desc = re.search(r'description="([^"]*)"', meta)
        hits.append({
            "rule": m.group(1),
            "severity": sev.group(1) if sev else "medium",
            "description": desc.group(1) if desc else "",
        })
    return hits


def _collect(artifact, result: dict, kind: str) -> list[tuple]:
    out = []
    name = artifact.filename
    if kind == "sast":
        for f in result.get("findings", []):
            rid = f.get("rule_id", "regula")
            label = "Możliwy SQL injection" if "sql" in rid.lower() else rid.split(".")[-1]
            out.append((
                "code",
                f"{label}: {name}:{f.get('line_start')}",
                f"{f.get('message', '')} (reguła {rid}, {f.get('cwe', '')})",
                _SEMGREP_SEVERITY.get(str(f.get("severity", "")).upper(), "medium"),
                0.7,
            ))
        return out

    hl = result.get("hash_lookup")
    if hl:
        sev = "critical" if hl.get("severity") in ("high", "critical") else "low"
        out.append((
            "malware",
            f"Znany malware: {hl.get('threat_name')} ({name})",
            f"SHA256 pliku jest w bazie znanych zagrożeń (źródło: {hl.get('source')}).",
            sev, 1.0,
        ))
    best: dict[str, tuple] = {}
    for m in result.get("fuzzy_matches", []):
        t, sim = m.get("threat_name"), m.get("similarity", 0)
        if sim > best.get(t, (0, ""))[0]:
            best[t] = (sim, m.get("source", ""))
    for t, (sim, src) in best.items():
        out.append((
            "malware",
            f"Podobieństwo {sim}% do {t} ({name})",
            f"Fuzzy hash (ssdeep) pliku jest podobny do znanego zagrożenia (źródło: {src}).",
            "high" if sim >= 80 else "medium", sim / 100,
        ))
    for h in _yara_hits(result):
        sev = h["severity"] if h["severity"] in _LEVELS else "medium"
        out.append((
            "malware",
            f"Reguła YARA {h['rule']} ({name})",
            h["description"] or "Trafienie reguły sygnaturowej YARA.",
            sev, 0.6,
        ))
    return out


def record_artifact_findings(store, artifact, result: dict, kind: str) -> int:
    try:
        builder = FindingBuilder(store)
        n = 0
        for category, title, description, severity, confidence in _collect(artifact, result, kind):
            ev = Evidence(
                id=str(uuid4()),
                target=artifact.target,
                evidence_type=EvidenceType.ARTIFACT_ANALYSIS,
                raw_result_id=None,
                observation_id=None,
                finding_id=None,
                title=title,
                content=description,
                metadata={
                    "artifact_id": artifact.id,
                    "sha256": artifact.sha256,
                    "thread_id": artifact.thread_id,
                },
            )
            store.save_evidence(ev)
            builder.create_finding(
                target=artifact.target,
                category=category,
                title=title,
                description=description,
                severity=severity,
                confidence=min(max(confidence, 0.0), 1.0),
                evidence=ev,
            )
            n += 1
        logger.info("ARTIFACT_FINDINGS: %d findingow (%s, %s)", n, kind, artifact.filename)
        return n
    except Exception:
        logger.exception("ARTIFACT_FINDINGS: nie udalo sie utworzyc findingow")
        return 0
