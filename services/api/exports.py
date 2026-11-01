"""Snapshot-bound PDF/XLSX exports and authorized short-lived downloads."""

import base64
import hashlib
import hmac
import html
import io
import os
import re
import tempfile
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from urllib.parse import quote
from uuid import NAMESPACE_URL, uuid5

import xlsxwriter
from fastapi import Request
from fastapi.responses import FileResponse
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    CondPageBreak,
    Flowable,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from sqlalchemy import select

from packages.domain.contracts import validate
from packages.domain.errors import DomainError
from services.api.config import settings
from services.api.models import (
    CalculationSnapshotRecord,
    City,
    Dataset,
    DatasetVersion,
    ExportArtifactRecord,
    Job,
    Principal,
    Program,
    ProgramRevisionCalculation,
    ProgramRevisionRecord,
    Scenario,
    ScenarioRevision,
    ZoneVersion,
)

PDF_TYPE = "application/pdf"
XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
DOWNLOAD_TTL = timedelta(minutes=15)


def _artifact_id(job_id):
    return str(uuid5(NAMESPACE_URL, f"pavlodar-export:{job_id}"))


def _export_path(storage_key):
    root = Path(settings().export_root).resolve()
    path = (root / storage_key).resolve()
    if root not in path.parents:
        raise DomainError(503, "export_artifact_corrupt", "Export storage key is invalid")
    return path


def _target(db, access, target_kind, target_id):
    if target_kind == "calculation":
        from services.api.calculations import authorized_snapshot

        snapshot = authorized_snapshot(db, access, target_id)
        revision = db.get(ScenarioRevision, snapshot.scenario_revision_id)
        scenario = db.get(Scenario, revision.scenario_id)
        return snapshot, scenario.city_id
    if target_kind == "program_revision":
        from services.api.programs import program_revision_access
        from services.api.use_cases import found

        revision = found(db.get(ProgramRevisionRecord, target_id))
        program_revision_access(db, access, revision)
        program = found(db.get(Program, revision.program_id))
        return revision, program.city_id
    raise DomainError(422, "export_target_invalid", "Unsupported export target")


def authorize_artifact(db, access, artifact):
    access.city(artifact.city_id)
    _target(db, access, artifact.target_kind, artifact.target_id)
    return artifact


def _source_rows(db, snapshots):
    refs = []
    seen = set()
    for snapshot in snapshots:
        for ref in snapshot.manifest.get("source_refs", []):
            key = (ref["dataset_version_id"], ref.get("source_record_id"))
            if key not in seen:
                refs.append(ref)
                seen.add(key)
    rows = []
    for ref in refs:
        version = db.get(DatasetVersion, ref["dataset_version_id"])
        dataset = db.get(Dataset, version.dataset_id) if version else None
        rows.append(
            {
                "dataset_version_id": ref["dataset_version_id"],
                "source_record_id": ref.get("source_record_id"),
                "name": dataset.payload.get("name") if dataset else ref.get("label"),
                "owner": dataset.payload.get("owner") if dataset else None,
                "license": dataset.payload.get("license") if dataset else None,
                "source_uri": dataset.payload.get("source_uri") if dataset else ref.get("uri"),
                "method": version.payload.get("method") if version else None,
                "observed_at": version.payload.get("observed_at") if version else None,
                "synthetic": version.synthetic if version else None,
            }
        )
    return rows


def _scenario_context(db, snapshot):
    revision = db.get(ScenarioRevision, snapshot.scenario_revision_id)
    scenario = db.get(Scenario, revision.scenario_id)
    zone = db.get(ZoneVersion, revision.zone_version_id)
    return {
        "scenario": scenario.payload,
        "revision": revision.payload,
        "zone": zone.payload,
        "snapshot": snapshot.payload,
        "manifest": snapshot.manifest,
    }


def build_context(db, access, target_kind, target_id):
    target, city_id = _target(db, access, target_kind, target_id)
    city = db.get(City, city_id)
    if target_kind == "calculation":
        snapshots = [target]
        scenarios = [_scenario_context(db, target)]
        author = db.get(Principal, target.actor_id)
        program = None
        created_at = target.created_at
    else:
        links = db.scalars(
            select(ProgramRevisionCalculation).where(
                ProgramRevisionCalculation.program_revision_id == target.id
            )
        )
        all_snapshots = [
            db.get(CalculationSnapshotRecord, row.calculation_snapshot_id) for row in links
        ]
        all_snapshots.sort(key=lambda row: row.id)
        selected = set(target.payload["selected_scenario_revision_ids"])
        snapshots = [row for row in all_snapshots if row.scenario_revision_id in selected]
        scenarios = [_scenario_context(db, snapshot) for snapshot in snapshots]
        program_row = db.get(Program, target.program_id)
        job = db.get(Job, target.job_id) if target.job_id else None
        author = db.get(Principal, job.owner_id if job else program_row.owner_id)
        program = {"program": program_row.payload, "revision": target.payload}
        created_at = target.created_at
    return {
        "target_kind": target_kind,
        "target_id": target_id,
        "city": city.payload,
        "author": author.display_name if author else "Неизвестно",
        "created_at": created_at.isoformat().replace("+00:00", "Z"),
        "program": program,
        "scenarios": scenarios,
        "sources": _source_rows(
            db, all_snapshots if target_kind == "program_revision" else snapshots
        ),
    }


def _font_paths():
    candidates = []
    configured = os.getenv("PAVLODAR_PDF_FONT_DIR")
    if configured:
        candidates.append(Path(configured))
    candidates.extend(
        [
            Path("C:/Windows/Fonts"),
            Path("/usr/share/fonts/truetype/dejavu"),
        ]
    )
    for directory in candidates:
        regular = directory / "DejaVuSans.ttf"
        bold = directory / "DejaVuSans-Bold.ttf"
        if regular.is_file() and bold.is_file():
            return regular, bold
    raise DomainError(503, "export_generation_failed", "Cyrillic PDF fonts are unavailable")


def _register_fonts():
    if "PavlodarSans" not in pdfmetrics.getRegisteredFontNames():
        regular, bold = _font_paths()
        pdfmetrics.registerFont(TTFont("PavlodarSans", str(regular)))
        pdfmetrics.registerFont(TTFont("PavlodarSans-Bold", str(bold)))


def _p(value):
    return html.escape("—" if value is None or value == "" else str(value))


class ZoneSketch(Flowable):
    def __init__(self, geometry, placements, width=170 * mm, height=70 * mm):
        super().__init__()
        self.geometry = geometry
        self.placements = placements
        self.width = width
        self.height = height

    def draw(self):
        polygons = (
            [self.geometry["coordinates"]]
            if self.geometry.get("type") == "Polygon"
            else self.geometry.get("coordinates", [])
        )
        rings = [polygon[0] for polygon in polygons if polygon and polygon[0]]
        points = [point for ring in rings for point in ring]
        if not points:
            return
        xs, ys = [p[0] for p in points], [p[1] for p in points]
        dx, dy = max(max(xs) - min(xs), 1e-9), max(max(ys) - min(ys), 1e-9)
        scale = min((self.width - 12) / dx, (self.height - 12) / dy)
        ox = (self.width - dx * scale) / 2
        oy = (self.height - dy * scale) / 2

        def xy(point):
            return ox + (point[0] - min(xs)) * scale, oy + (point[1] - min(ys)) * scale

        self.canv.setStrokeColor(colors.HexColor("#166534"))
        self.canv.setFillColor(colors.HexColor("#DCFCE7"))
        self.canv.setLineWidth(1)
        for ring in rings:
            path = self.canv.beginPath()
            x, y = xy(ring[0])
            path.moveTo(x, y)
            for point in ring[1:]:
                x, y = xy(point)
                path.lineTo(x, y)
            path.close()
            self.canv.drawPath(path, fill=1, stroke=1)
        self.canv.setFillColor(colors.HexColor("#B45309"))
        for placement in self.placements:
            point = placement.get("position", {}).get("coordinates")
            if point and min(xs) <= point[0] <= max(xs) and min(ys) <= point[1] <= max(ys):
                x, y = xy(point)
                self.canv.circle(x, y, 2, fill=1, stroke=0)


def _table(rows, widths=None, repeat_rows=1):
    cell = ParagraphStyle(
        "ExportCell", fontName="PavlodarSans", fontSize=7.5, leading=9,
        textColor=colors.HexColor("#1F2937"),
    )
    head = ParagraphStyle(
        "ExportHead", parent=cell, fontName="PavlodarSans-Bold", textColor=colors.white,
    )
    prepared = [
        [Paragraph(item, head if row_index == 0 else cell) if isinstance(item, str) else item for item in row]
        for row_index, row in enumerate(rows)
    ]
    value = Table(prepared, colWidths=widths, repeatRows=repeat_rows, hAlign="LEFT")
    value.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (-1, -1), "PavlodarSans"),
                ("FONTNAME", (0, 0), (-1, 0), "PavlodarSans-Bold"),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#14532D")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTSIZE", (0, 0), (-1, -1), 7.5),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("GRID", (0, 0), (-1, 0), 0.25, colors.white),
                ("LINEBELOW", (0, 1), (-1, -1), 0.25, colors.HexColor("#D1D5DB")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F8FAFC")]),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    return value


def render_pdf(context):
    _register_fonts()
    output = io.BytesIO()
    styles = getSampleStyleSheet()
    title = ParagraphStyle(
        "TitleRu", parent=styles["Title"], fontName="PavlodarSans-Bold", fontSize=19,
        leading=23, textColor=colors.HexColor("#14532D"), alignment=TA_CENTER,
    )
    heading = ParagraphStyle(
        "HeadingRu", parent=styles["Heading2"], fontName="PavlodarSans-Bold", fontSize=12,
        leading=15, textColor=colors.HexColor("#14532D"), spaceBefore=8, spaceAfter=5,
    )
    body = ParagraphStyle(
        "BodyRu", parent=styles["BodyText"], fontName="PavlodarSans", fontSize=9,
        leading=12, textColor=colors.HexColor("#1F2937"),
    )
    doc = SimpleDocTemplate(
        output, pagesize=landscape(A4), leftMargin=16 * mm, rightMargin=16 * mm,
        topMargin=16 * mm, bottomMargin=15 * mm, title="Отчёт по озеленению",
        author=context["author"], subject=context["target_id"],
    )

    def footer(canvas, document):
        canvas.saveState()
        canvas.setFont("PavlodarSans", 7)
        canvas.setFillColor(colors.HexColor("#64748B"))
        canvas.drawString(16 * mm, 8 * mm, f"Версия: {context['target_id']}")
        canvas.drawRightString(281 * mm, 8 * mm, f"Страница {document.page}")
        canvas.restoreState()

    story = [
        Paragraph(
            "Городская программа озеленения" if context["program"] else "Отчёт по варианту озеленения",
            title,
        ),
        Spacer(1, 4 * mm),
        _table(
            [
                ["Город", "Версия", "Дата расчёта", "Автор"],
                [
                    _p(context["city"]["name"]), _p(context["target_id"]),
                    _p(context["created_at"]), _p(context["author"]),
                ],
            ],
            [48 * mm, 82 * mm, 48 * mm, 68 * mm],
        ),
    ]
    if context["program"]:
        revision = context["program"]["revision"]
        story.extend(
            [
                Paragraph("Сводка программы", heading),
                _table(
                    [
                        ["Статус решения", "Целевая функция", "Капитальные затраты, KZT", "Выбрано вариантов"],
                        [
                            _p(revision["solver_status"]), _p(revision["objective"]),
                            _p(revision["capital_total"]), len(revision["selected_scenario_revision_ids"]),
                        ],
                    ],
                    [55 * mm, 55 * mm, 70 * mm, 55 * mm],
                ),
            ]
        )
    for index, item in enumerate(context["scenarios"], 1):
        if index > 1 or context["program"]:
            story.append(PageBreak())
        snapshot, revision, zone = item["snapshot"], item["revision"], item["zone"]
        story.extend(
            [
                Paragraph(f"Вариант {index}: {_p(item['scenario']['name'])}", heading),
                _table(
                    [
                        ["Зона", "Версия сценария", "Расчёт", "Статус", "Синтетические входы"],
                        [
                            _p(zone["name"]), _p(snapshot["scenario_revision_id"]), _p(snapshot["id"]),
                            _p(snapshot["status"]), "да" if snapshot["synthetic_inputs"] else "нет",
                        ],
                    ],
                    [48 * mm, 65 * mm, 65 * mm, 35 * mm, 35 * mm],
                ),
                Paragraph("Схема участка", heading),
                Paragraph("Контур и точки посадки из зафиксированной версии сценария. Подложка не используется.", body),
                ZoneSketch(zone["geometry"], revision["placements"]),
                Paragraph("Состав", heading),
                _table(
                    [["Placement", "Plant", "Количество", "Дата посадки"]]
                    + [
                        [_p(p["id"]), _p(p["plant_id"]), p["quantity"], _p(p["planting_date"])]
                        for p in revision["placements"]
                    ],
                    [70 * mm, 70 * mm, 35 * mm, 45 * mm],
                ),
                CondPageBreak(35 * mm),
                Paragraph("Смета", heading),
                _table(
                    [["Категория", "Описание", "Количество", "Ед.", "Цена", "Сумма", "Год"]]
                    + [
                        [
                            _p(line["category"]), _p(line["description"]), line["quantity"],
                            _p(line["unit"]), _p(line["unit_price"]), _p(line["subtotal"]), line["year"],
                        ]
                        for line in snapshot["cost"]["lines"]
                    ]
                    + [["", "Известный итог", "", "", "", snapshot["cost"]["known_subtotal"], ""]],
                    [27 * mm, 66 * mm, 25 * mm, 20 * mm, 30 * mm, 30 * mm, 14 * mm],
                ),
                Paragraph("Выживаемость 1/2/3 года", heading),
                _table(
                    [["Placement", "Модель", "Калибровка", "Год 1", "Год 2", "Год 3"]]
                    + [
                        [
                            _p(s["placement_id"]), _p(s["model_kind"]), _p(s["calibration_status"]),
                            *[_p(point["probability"]) for point in s["points"][:3]],
                        ]
                        for s in snapshot["survival"]
                    ],
                    [62 * mm, 34 * mm, 38 * mm, 28 * mm, 28 * mm, 28 * mm],
                ),
                Paragraph("Уход и экологические показатели", heading),
                Paragraph(
                    f"Операций ухода: {len(snapshot['care'])}. Экологических показателей: {len(snapshot['ecosystem'])}.",
                    body,
                ),
                Paragraph("Качество и ограничения", heading),
                _table(
                    [["Код", "Описание", "Блокирует"]]
                    + [
                        [_p(g["code"]), _p(g["message"]), "да" if g["blocking"] else "нет"]
                        for g in snapshot["warnings"] + snapshot["cost"]["data_gaps"]
                    ],
                    [55 * mm, 150 * mm, 30 * mm],
                ),
            ]
        )
    story.extend(
        [
            PageBreak(),
            Paragraph("Источники", heading),
            _table(
                [["Версия данных", "Набор", "Владелец", "Лицензия", "Метод", "Наблюдение"]]
                + [
                    [
                        _p(row["dataset_version_id"]), _p(row["name"]), _p(row["owner"]),
                        _p(row["license"]), _p(row["method"]), _p(row["observed_at"]),
                    ]
                    for row in context["sources"]
                ],
                [55 * mm, 48 * mm, 40 * mm, 35 * mm, 45 * mm, 35 * mm],
            ),
        ]
    )
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return output.getvalue()


def _safe_text(value):
    if value is None:
        return ""
    text = str(value)
    # Explicitly neutralize CSV/Excel formula prefixes even though write_string is used.
    return "'" + text if text[:1] in {"=", "+", "-", "@", "\t", "\r"} else text


def render_xlsx(context):
    output = io.BytesIO()
    workbook = xlsxwriter.Workbook(
        output,
        {
            "in_memory": True,
            "strings_to_formulas": False,
            "strings_to_urls": False,
            "strings_to_numbers": False,
        },
    )
    title = workbook.add_format({"bold": True, "font_size": 15, "font_color": "#14532D"})
    header = workbook.add_format(
        {"bold": True, "font_color": "#FFFFFF", "bg_color": "#14532D", "align": "center", "valign": "vcenter"}
    )
    text_fmt = workbook.add_format({"font_color": "#1F2937", "valign": "top"})
    int_fmt = workbook.add_format({"num_format": "#,##0", "valign": "top"})
    num_fmt = workbook.add_format({"num_format": "#,##0.00", "valign": "top"})
    pct_fmt = workbook.add_format({"num_format": "0.0%", "valign": "top"})
    date_fmt = workbook.add_format({"num_format": "yyyy-mm-dd", "valign": "top"})

    def sheet(name, columns):
        ws = workbook.add_worksheet(name)
        ws.hide_gridlines(2)
        ws.freeze_panes(1, 0)
        ws.write_row(0, 0, columns, header)
        return ws

    def put(ws, row, col, value, kind="text"):
        if value is None:
            ws.write_blank(row, col, None, text_fmt)
        elif kind == "int":
            ws.write_number(row, col, int(value), int_fmt)
        elif kind == "num":
            ws.write_number(row, col, float(Decimal(str(value))), num_fmt)
        elif kind == "pct":
            ws.write_number(row, col, float(value), pct_fmt)
        elif kind == "date":
            ws.write_datetime(row, col, datetime.fromisoformat(str(value)), date_fmt)
        else:
            ws.write_string(row, col, _safe_text(value), text_fmt)

    summary = workbook.add_worksheet("summary")
    summary.hide_gridlines(2)
    summary.set_column("A:A", 30)
    summary.set_column("B:B", 70)
    summary.write("A2", "Отчёт по городской программе" if context["program"] else "Отчёт по варианту озеленения", title)
    summary_rows = [
        ("Город", context["city"]["name"]),
        ("Тип", context["target_kind"]),
        ("Версия", context["target_id"]),
        ("Дата расчёта", context["created_at"]),
        ("Автор", context["author"]),
        ("Вариантов", len(context["scenarios"])),
    ]
    if context["program"]:
        rev = context["program"]["revision"]
        summary_rows.extend(
            [
                ("Статус решения", rev["solver_status"]),
                ("Целевая функция", rev["objective"]),
                ("Капитальные затраты, KZT", rev["capital_total"]),
            ]
        )
    for index, item in enumerate(context["scenarios"], 1):
        snapshot = item["snapshot"]
        summary_rows.extend(
            [
                (f"Расчёт {index}", snapshot["id"]),
                (f"Версия сценария {index}", snapshot["scenario_revision_id"]),
                (f"Статус расчёта {index}", snapshot["status"]),
                (f"Синтетические входы {index}", "да" if snapshot["synthetic_inputs"] else "нет"),
                (f"Известная сумма {index}, KZT", snapshot["cost"]["known_subtotal"]),
                (f"Полная сумма {index}, KZT", snapshot["cost"].get("total")),
                (
                    f"Ограничения {index}",
                    ", ".join(
                        value["code"]
                        for value in snapshot["warnings"] + snapshot["cost"]["data_gaps"]
                    )
                    or "нет",
                ),
            ]
        )
    for row, (label, value) in enumerate(summary_rows, 3):
        summary.write_string(row, 0, label, header)
        numeric = label in {"Целевая функция", "Капитальные затраты, KZT"} or label.startswith(
            ("Известная сумма ", "Полная сумма ")
        )
        put(summary, row, 1, value, "num" if numeric and value is not None else "text")

    quantities = sheet("quantities", ["scenario_revision_id", "zone_version_id", "placement_id", "plant_id", "quantity", "unit", "planting_date"])
    rates = sheet("rates", ["calculation_id", "rate_version_id", "category", "unit", "unit_price_kzt"])
    costs = sheet("costs", ["calculation_id", "line_id", "category", "description", "quantity", "unit", "unit_price_kzt", "subtotal_kzt", "year", "rate_version_id", "formula_text"])
    care = sheet("care", ["scenario_revision_id", "operation_id", "placement_ids", "month", "year_offset", "operation", "quantity", "unit", "water_m3", "crew_minutes", "visits", "rate_version_id", "rule_version_id"])
    survival = sheet("survival", ["calculation_id", "placement_id", "model_kind", "calibration_status", "year", "probability", "lower", "upper"])
    ecosystem = sheet("ecosystem", ["calculation_id", "key", "value", "unit", "horizon_year", "status", "lower", "upper", "method_version"])
    sources = sheet("sources", ["dataset_version_id", "source_record_id", "name", "owner", "license", "source_uri", "method", "observed_at", "synthetic"])
    widths = {
        quantities: [39, 39, 39, 39, 12, 12, 14],
        costs: [39, 39, 18, 38, 12, 14, 16, 16, 10, 39, 38],
        rates: [39, 39, 18, 14, 16],
        care: [39, 39, 45, 10, 12, 28, 12, 14, 14, 16, 10, 39, 39],
        survival: [39, 39, 18, 20, 10, 14, 14, 14],
        ecosystem: [39, 24, 14, 12, 12, 16, 14, 14, 24],
        sources: [39, 24, 30, 25, 20, 45, 25, 20, 12],
    }
    for ws, values in widths.items():
        for col, width in enumerate(values):
            ws.set_column(col, col, width)

    qr = cr = rr = car = sr = er = 1
    rate_seen = set()
    for item in context["scenarios"]:
        revision, snapshot = item["revision"], item["snapshot"]
        for placement in revision["placements"]:
            values = [revision["id"], revision["zone_version_id"], placement["id"], placement["plant_id"]]
            for col, value in enumerate(values): put(quantities, qr, col, value)
            put(quantities, qr, 4, placement["quantity"], "int")
            put(quantities, qr, 5, "piece")
            put(quantities, qr, 6, placement["planting_date"], "date")
            qr += 1
        for line in snapshot["cost"]["lines"]:
            values = [snapshot["id"], line["id"], line["category"], line["description"]]
            for col, value in enumerate(values): put(costs, cr, col, value)
            put(costs, cr, 4, line["quantity"], "num")
            put(costs, cr, 5, line["unit"])
            put(costs, cr, 6, line["unit_price"], "num")
            put(costs, cr, 7, line["subtotal"], "num")
            put(costs, cr, 8, line["year"], "int")
            put(costs, cr, 9, line["rate_version_id"])
            put(costs, cr, 10, line["formula"])
            cr += 1
            rate_key = (snapshot["id"], line["rate_version_id"])
            if line["rate_version_id"] and rate_key not in rate_seen:
                for col, value in enumerate([snapshot["id"], line["rate_version_id"], line["category"], line["unit"]]): put(rates, rr, col, value)
                put(rates, rr, 4, line["unit_price"], "num")
                rr += 1
                rate_seen.add(rate_key)
        for op in snapshot["care"]:
            values = [revision["id"], op["id"], ",".join(op["placement_ids"])]
            for col, value in enumerate(values): put(care, car, col, value)
            for col, key, kind in [(3,"month","int"),(4,"year_offset","int"),(5,"operation","text"),(6,"quantity","num"),(7,"unit","text"),(8,"water_m3","num"),(9,"crew_minutes","int"),(10,"visits","int"),(11,"rate_version_id","text"),(12,"rule_version_id","text")]: put(care, car, col, op[key], kind)
            car += 1
        for result in snapshot["survival"]:
            for point in result["points"]:
                for col, value in enumerate([snapshot["id"], result["placement_id"], result["model_kind"], result["calibration_status"]]): put(survival, sr, col, value)
                put(survival, sr, 4, point["year"], "int")
                put(survival, sr, 5, point["probability"], "pct")
                put(survival, sr, 6, point["lower"], "pct")
                put(survival, sr, 7, point["upper"], "pct")
                sr += 1
        for metric in snapshot["ecosystem"]:
            for col, value in enumerate([snapshot["id"], metric["key"]]): put(ecosystem, er, col, value)
            put(ecosystem, er, 2, metric["value"], "num")
            put(ecosystem, er, 3, metric["unit"])
            put(ecosystem, er, 4, metric["horizon_year"], "int")
            put(ecosystem, er, 5, metric["status"])
            put(ecosystem, er, 6, metric["lower"], "num")
            put(ecosystem, er, 7, metric["upper"], "num")
            put(ecosystem, er, 8, metric["method_version"])
            er += 1
    for row_index, row in enumerate(context["sources"], 1):
        for col, key in enumerate(["dataset_version_id", "source_record_id", "name", "owner", "license", "source_uri", "method", "observed_at", "synthetic"]):
            put(sources, row_index, col, row[key])
    workbook.close()
    return output.getvalue()


def persist_export(db, job):
    from services.api.security import Access
    from services.api.use_cases import audit

    user = db.get(Principal, job.owner_id)
    if not user or not job.request_payload:
        raise DomainError(500, "export_target_invalid", "Export job input is missing")
    access = Access(db, user, None)
    request = job.request_payload
    context = build_context(db, access, request["target_kind"], request["target_id"])
    try:
        data = render_pdf(context) if request["format"] == "pdf" else render_xlsx(context)
    except DomainError:
        raise
    except Exception as error:
        raise DomainError(503, "export_generation_failed", "Export rendering failed") from error
    if not data or len(data) > settings().export_max_bytes:
        raise DomainError(503, "export_artifact_too_large", "Generated export exceeds its limit")
    artifact_id = _artifact_id(job.id)
    suffix = request["format"]
    storage_key = f"{artifact_id[:2]}/{artifact_id}.{suffix}"
    path = _export_path(storage_key)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=artifact_id + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    media_type = PDF_TYPE if suffix == "pdf" else XLSX_TYPE
    artifact = ExportArtifactRecord(
        id=artifact_id,
        job_id=job.id,
        owner_id=job.owner_id,
        city_id=job.city_id,
        target_kind=request["target_kind"],
        target_id=request["target_id"],
        format=suffix,
        storage_key=storage_key,
        sha256=hashlib.sha256(data).hexdigest(),
        byte_size=len(data),
        media_type=media_type,
        filename=f"pavlodar_{request['target_kind']}_{request['target_id']}.{suffix}",
        created_at=datetime.now(UTC),
    )
    db.add(artifact)
    audit(db, access, "export.created", artifact_id, "ExportArtifact")
    return artifact_id


def _token(artifact_id, expires_at):
    expires = int(expires_at.timestamp())
    message = f"{artifact_id}:{expires}".encode()
    signature = hmac.new(
        settings().token_encryption_key.get_secret_value().encode(), message, hashlib.sha256
    ).digest()
    return f"{expires}." + base64.urlsafe_b64encode(signature).decode().rstrip("=")


def artifact_payload(artifact):
    expires_at = datetime.now(UTC) + DOWNLOAD_TTL
    token = quote(_token(artifact.id, expires_at), safe="")
    value = {
        "id": artifact.id,
        "target_kind": artifact.target_kind,
        "target_id": artifact.target_id,
        "format": artifact.format,
        "download_url": f"/v1/exports/{artifact.id}/download?token={token}",
        "expires_at": expires_at.isoformat().replace("+00:00", "Z"),
        "sha256": artifact.sha256,
        "byte_size": artifact.byte_size,
        "media_type": artifact.media_type,
        "created_at": artifact.created_at.isoformat().replace("+00:00", "Z"),
    }
    validate("ExportArtifact", value)
    return value


def validate_download_token(artifact_id, token):
    match = re.fullmatch(r"([0-9]{10})\.([A-Za-z0-9_-]{43})", token or "")
    if not match:
        raise DomainError(403, "export_download_invalid", "Export download token is invalid")
    expires = int(match.group(1))
    if datetime.now(UTC).timestamp() > expires:
        raise DomainError(410, "export_download_expired", "Export download token has expired")
    expected = _token(artifact_id, datetime.fromtimestamp(expires, UTC))
    if not hmac.compare_digest(expected, token):
        raise DomainError(403, "export_download_invalid", "Export download token is invalid")


async def download_export(request: Request):
    from services.api.db import session
    from services.api.security import authenticate
    from services.api.use_cases import found

    with session() as db, db.begin():
        access = authenticate(db, request)
        access.role("viewer")
        artifact = found(db.get(ExportArtifactRecord, request.path_params["export_id"]))
        authorize_artifact(db, access, artifact)
        validate_download_token(artifact.id, request.query_params.get("token"))
        path = _export_path(artifact.storage_key)
        if not path.is_file() or path.stat().st_size != artifact.byte_size:
            raise DomainError(503, "export_artifact_corrupt", "Export bytes are unavailable")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != artifact.sha256:
            raise DomainError(503, "export_artifact_corrupt", "Export checksum changed")
        filename, media_type, sha256 = artifact.filename, artifact.media_type, artifact.sha256
    return FileResponse(
        path,
        media_type=media_type,
        filename=filename,
        headers={"ETag": f'"{sha256}"', "Cache-Control": "private, no-store"},
    )
