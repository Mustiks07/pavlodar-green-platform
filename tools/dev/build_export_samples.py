"""Build clearly synthetic WP-10 PDF/XLSX evidence from the tested export fixture."""

import hashlib
import json
from pathlib import Path

from services.api.exports import render_pdf, render_xlsx
from tests.test_exports import sample_context

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "docs/evidence/wp10"


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    context = sample_context()
    files = {
        "sample_calculation_synthetic.pdf": render_pdf(context),
        "sample_calculation_synthetic.xlsx": render_xlsx(context),
    }
    manifest = {
        "fixture": "tests.test_exports.sample_context",
        "classification": "SYNTHETIC TEST EVIDENCE",
        "files": {},
    }
    for name, data in files.items():
        path = OUTPUT / name
        path.write_bytes(data)
        manifest["files"][name] = {
            "byte_size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
    (OUTPUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
