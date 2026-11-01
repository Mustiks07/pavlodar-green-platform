"""Server-side decimal line arithmetic. Does not approve rates or select quotations."""

from copy import deepcopy
from decimal import ROUND_HALF_UP, Decimal

from packages.domain.contracts import validate
from packages.domain.errors import gap


def calculate_cost(lines, data_gaps=()):
    result_lines, gaps = deepcopy(lines), deepcopy(list(data_gaps))
    known = Decimal("0.00")
    for line in result_lines:
        validate("CostLine", line)
        quantity_basis = line["formula"]
        if line["unit_price"] is None:
            line["subtotal"] = None
            gaps.append(
                gap("missing_rate", "Нет применимой расценки: " + line["description"], line["id"])
            )
        else:
            amount = (Decimal(str(line["quantity"])) * Decimal(line["unit_price"])).quantize(
                Decimal("0.01"), rounding=ROUND_HALF_UP
            )
            line["subtotal"] = str(amount)
            known += amount
        arithmetic = "subtotal = quantity * unit_price; per-line ROUND_HALF_UP to 0.01 KZT"
        line["formula"] = (
            arithmetic
            if quantity_basis == "pending server calculation"
            else quantity_basis + "; " + arithmetic
        )
    result = {
        "currency": "KZT",
        "status": "incomplete" if gaps else "complete",
        "known_subtotal": str(known),
        "total": None if gaps else str(known),
        "lines": result_lines,
        "data_gaps": gaps,
    }
    validate("CostResult", result)
    return result
