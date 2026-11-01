"""Generate DTOs deterministically; remove the unused untyped schema-root model."""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
target = ROOT / "packages/domain/generated.py"
subprocess.run(
    [
        sys.executable,
        "-m",
        "datamodel_code_generator",
        "--input",
        "contracts/domain.schema.json",
        "--input-file-type",
        "jsonschema",
        "--output",
        str(target),
        "--output-model-type",
        "pydantic_v2.BaseModel",
        "--target-python-version",
        "3.12",
        "--disable-timestamp",
        "--use-standard-collections",
        "--use-union-operator",
        "--use-annotated",
        "--field-constraints",
        "--formatters",
        "black",
        "isort",
    ],
    cwd=ROOT,
    check=True,
)
source = target.read_text(encoding="utf-8").replace("Annotated, Any, Literal", "Annotated, Literal")
source = source.replace("class Model(RootModel[Any]):\n    root: Any\n\n\n", "")
target.write_text(source, encoding="utf-8")
