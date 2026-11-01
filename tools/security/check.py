"""Check tracked/staged source only; never read ignored local credential stores."""

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
patterns = [
    re.compile(rb"gh[pousr]_[A-Za-z0-9]{30,}"),
    re.compile(rb"github_pat_[A-Za-z0-9_]{40,}"),
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(rb"AKIA[A-Z0-9]{16}"),
    re.compile(rb"https?://[^/\s:'\"]+:[^/@\s'\"]+@"),
]
paths = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
violations = []
for name in filter(None, paths):
    path = ROOT / name
    if not path.is_file():
        continue
    if (
        (path.name.startswith(".env") and path.name != ".env.example")
        or name.startswith(".local/")
        or path.name == "keycloak-test-realm.json"
    ):
        violations.append((name, "private local file tracked"))
        continue
    if path.suffix in {".png", ".pdf", ".jpg"}:
        continue
    content = path.read_bytes()
    if any(pattern.search(content) for pattern in patterns):
        violations.append((name, "possible credential pattern"))
if violations:
    # Print paths only; never echo matched secrets.
    for name, reason in violations:
        print(name, reason)
    raise SystemExit(1)
print(
    f"Tracked source credential-pattern check passed ({len(paths) - 1} files). Not a proof of absence of all secrets."
)
