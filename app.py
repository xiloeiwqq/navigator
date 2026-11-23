"""Локальный мультикампусный сервер навигатора без внешних API и трекинга."""

import argparse
import base64
import copy
import csv
import datetime as dt
import json
import math
import os
import re
import secrets
import socket
import ssl
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit


ROOT = Path(__file__).resolve().parent
LOCAL_TIME_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")
SAFE_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
TIMETABLE_FIELDS = ("campus_id", "group_id", "date", "start", "end", "room_id", "title")


def read_timetable(path: Path):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if not reader.fieldnames or any(field not in reader.fieldnames for field in TIMETABLE_FIELDS):
            raise ValueError(f"Некорректные столбцы расписания: {path.name}")
        rows = []
        for source in reader:
            row = {field: (source.get(field) or "").strip() for field in TIMETABLE_FIELDS}
            if any(row.values()):
                rows.append(row)
        return rows


def _finite_number(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def validate_campus(campus):
    """Проверить один изолированный граф корпуса."""
    campus_id = campus.get("id")
    if not isinstance(campus_id, str) or not SAFE_ID_RE.fullmatch(campus_id):
        raise ValueError("ID кампуса: буквы ASCII, цифры, дефис или подчёркивание")
    for field in ("city", "name", "short_name", "timezone"):
        if not isinstance(campus.get(field), str) or not campus[field].strip():
            raise ValueError(f"У кампуса {campus_id} не заполнено поле {field}")

    coordinates = campus.get("coordinates", {})
    latitude = coordinates.get("latitude")
    longitude = coordinates.get("longitude")
    if not _finite_number(latitude) or not -90 <= latitude <= 90:
        raise ValueError(f"Некорректная широта кампуса {campus_id}")
    if not _finite_number(longitude) or not -180 <= longitude <= 180:
        raise ValueError(f"Некорректная долгота кампуса {campus_id}")

    floor_rows = campus.get("floors", [])
    if not isinstance(floor_rows, list) or any(not isinstance(floor, dict) for floor in floor_rows):
        raise ValueError(f"Некорректные этажи кампуса {campus_id}")
    floors = {floor.get("id") for floor in floor_rows}
    if None in floors or not floors or len(floors) != len(floor_rows):
        raise ValueError(f"Этажи кампуса {campus_id} должны иметь уникальные ID")

    node_rows = campus.get("nodes", [])
    if not isinstance(node_rows, list) or any(not isinstance(node, dict) for node in node_rows):
        raise ValueError(f"Некорректные узлы кампуса {campus_id}")
    nodes = {node.get("id"): node for node in node_rows}
    if None in nodes or len(nodes) != len(node_rows) or not nodes:
        raise ValueError(f"Повторяющийся или пустой ID узла в кампусе {campus_id}")

    for node in nodes.values():
        if not isinstance(node["id"], str) or not SAFE_ID_RE.fullmatch(node["id"]):
            raise ValueError("ID узла: буквы ASCII, цифры, дефис или подчёркивание")
        if node.get("floor") not in floors or not isinstance(node.get("room"), bool):
            raise ValueError(f"Неизвестный этаж или некорректный room в кампусе {campus_id}")
        if "qr" in node and not isinstance(node["qr"], bool):
            raise ValueError("qr должен быть true или false")
        if "terminal" in node and not isinstance(node["terminal"], bool):
            raise ValueError("terminal должен быть true или false")
        if "standalone" in node and not isinstance(node["standalone"], bool):
            raise ValueError("standalone должен быть true или false")
        if "heading" in node and (
            not _finite_number(node["heading"]) or not 0 <= node["heading"] < 360
        ):
            raise ValueError("heading должен быть числом от 0 включительно до 360")
        for axis, maximum in (("x", 440), ("y", 290)):
            value = node.get(axis)
            if not _finite_number(value) or not 0 <= value <= maximum:
                raise ValueError("Координаты должны быть конечными числами в пределах схемы")

    edge_rows = campus.get("edges", [])
    if not isinstance(edge_rows, list) or any(not isinstance(edge, dict) for edge in edge_rows):
        raise ValueError(f"Некорректные проходы кампуса {campus_id}")
    seen_edges = set()
    neighbors = {node_id: set() for node_id in nodes}
    for edge in edge_rows:
        edge_id = edge.get("id")
        if (
            not isinstance(edge_id, str)
            or not SAFE_ID_RE.fullmatch(edge_id)
            or edge_id in seen_edges
            or edge.get("from") not in nodes
            or edge.get("to") not in nodes
        ):
            raise ValueError(f"Повторяющийся проход или неизвестная конечная точка в кампусе {campus_id}")
        if edge["from"] == edge["to"]:
            raise ValueError("Проход не может вести из узла в него же")
        seen_edges.add(edge_id)
        length = edge.get("length_m")
        if not _finite_number(length) or length <= 0:
            raise ValueError("Длина прохода должна быть конечной и больше нуля")
        if not isinstance(edge.get("accessible"), bool):
            raise ValueError("accessible должен быть true или false")
        if "closed" in edge and not isinstance(edge["closed"], bool):
            raise ValueError("closed должен быть true или false")
        neighbors[edge["from"]].add(edge["to"])
        neighbors[edge["to"]].add(edge["from"])

    entrance = campus.get("entrance_node_id", "entrance")
    if entrance not in nodes:
        raise ValueError(f"Неизвестный главный вход кампуса {campus_id}")
    standalone = {node_id for node_id, node in nodes.items() if node.get("standalone") and not neighbors[node_id]}
    reached = set()
    pending = [entrance]
    while pending:
        current = pending.pop()
        if current in reached:
            continue
        reached.add(current)
        pending.extend(neighbors[current] - reached)
    missing_nodes = set(nodes) - reached - standalone
    if missing_nodes and not campus.get("editor_created"):
        missing = ", ".join(sorted(missing_nodes))
        raise ValueError(f"Граф кампуса {campus_id} несвязный, недоступны узлы: {missing}")
    if not campus.get("editor_created") and any(
        node.get("qr") and not neighbors[node_id] and node_id not in standalone for node_id, node in nodes.items()
    ):
        raise ValueError("QR-точка не может быть изолированным узлом")

    dangling = [
        node["id"]
        for node in nodes.values()
        if not node["room"]
        and node["id"] != entrance
        and not node.get("terminal", False)
        and not campus.get("editor_created")
        and node["id"] not in standalone
        and len(neighbors[node["id"]]) < 2
    ]
    if dangling:
        raise ValueError(f"Висячие навигационные узлы: {', '.join(sorted(dangling))}")


def validate_timetable(campus, timetable):
    nodes = {node["id"]: node for node in campus["nodes"]}
    lessons_by_group = {}
    for row in timetable:
        if row.get("campus_id") != campus["id"]:
            raise ValueError("Строка расписания попала не в тот кампус")
        if not row.get("group_id") or row.get("room_id") not in nodes or not nodes[row["room_id"]]["room"]:
            raise ValueError(f"Группа или аудитория расписания кампуса {campus['id']} неизвестна")
        if not row.get("title"):
            raise ValueError("У занятия должно быть название")
        dt.date.fromisoformat(row["date"])
        if not re.fullmatch(r"\d{2}:\d{2}", row["start"]) or not re.fullmatch(r"\d{2}:\d{2}", row["end"]):
            raise ValueError("Время расписания должно быть в формате HH:MM")
        start = dt.time.fromisoformat(row["start"])
        end = dt.time.fromisoformat(row["end"])
        if end <= start:
            raise ValueError("Конец занятия должен быть позже начала в тот же день")
        lessons_by_group.setdefault((row["group_id"], row["date"]), []).append(row)

    for (group_id, date), lessons in lessons_by_group.items():
        ordered = sorted(lessons, key=lambda row: row["start"])
        if any(current["start"] < previous["end"] for previous, current in zip(ordered, ordered[1:])):
            raise ValueError(f"Занятия группы {group_id} пересекаются {date}")


def campus_summary(graph):
    return {
        "id": graph["id"],
        "city": graph["city"],
        "name": graph["name"],
        "short_name": graph["short_name"],
        "timezone": graph["timezone"],
        "coordinates": graph["coordinates"],
        "floor_count": len(graph["floors"]),
        "temporarily_closed": graph.get("temporarily_closed") is True,
        "auto_select": graph.get("auto_select") is not False,
    }


def materialize_campus(source, templates):
    """Развернуть корпус из общей схемы здания, если задан template."""
    template_id = source.get("template")
    if template_id is None:
        return dict(source)
    if not isinstance(template_id, str) or not SAFE_ID_RE.fullmatch(template_id):
        raise ValueError(f"Некорректный template кампуса {source.get('id')}")
    template = templates.get(template_id)
    if not isinstance(template, dict):
        raise ValueError(f"Неизвестный template кампуса {source.get('id')}: {template_id}")

    graph = dict(source)
    graph.pop("template", None)
    for field in ("floors", "nodes", "edges"):
        if field in source:
            raise ValueError(f"Кампус с template не должен переопределять {field}")
        if not isinstance(template.get(field), list) or not template[field]:
            raise ValueError(f"В template {template_id} отсутствует {field}")
        graph[field] = copy.deepcopy(template[field])
    if "entrance_node_id" not in graph and "entrance_node_id" in template:
        graph["entrance_node_id"] = template["entrance_node_id"]
    return graph


def load_data(folder: Path, catalog=None):
    """Прочитать и полностью проверить каталог кампусов и оба CSV."""
    if catalog is None:
        catalog = json.loads((folder / "graph.json").read_text(encoding="utf-8"))
    if not isinstance(catalog.get("demo"), bool) or not catalog.get("version"):
        raise ValueError("В каталоге нужны demo и version")
    campus_rows = catalog.get("campuses", [])
    if not isinstance(campus_rows, list) or not campus_rows:
        raise ValueError("Каталог кампусов пуст")
    templates = catalog.get("templates", {})
    if not isinstance(templates, dict):
        raise ValueError("templates должен быть объектом")
    campus_ids = [campus.get("id") for campus in campus_rows if isinstance(campus, dict)]
    if len(campus_ids) != len(campus_rows) or len(set(campus_ids)) != len(campus_ids):
        raise ValueError("Кампусы должны иметь уникальные ID")
    default_campus_id = catalog.get("default_campus_id")
    if default_campus_id not in campus_ids:
        raise ValueError("Неизвестный default_campus_id")

    real_rows = read_timetable(folder / "timetable.csv")
    demo_rows = read_timetable(folder / "timetable.demo.csv")
    known_campuses = set(campus_ids)
    unknown = {row["campus_id"] for row in real_rows + demo_rows} - known_campuses
    if unknown:
        raise ValueError(f"Расписание содержит неизвестные кампусы: {', '.join(sorted(unknown))}")

    records = {}
    summaries = []
    for source in campus_rows:
        graph = materialize_campus(source, templates)
        graph["version"] = catalog["version"]
        graph["demo"] = bool(source.get("demo", catalog["demo"]))
        validate_campus(graph)

        campus_real = [row for row in real_rows if row["campus_id"] == graph["id"]]
        campus_demo = [row for row in demo_rows if row["campus_id"] == graph["id"]]
        if campus_real:
            timetable = campus_real
            schedule = {"source": "real", "filename": "timetable.csv", "demo": False}
        elif campus_demo:
            timetable = campus_demo
            schedule = {"source": "demo", "filename": "timetable.demo.csv", "demo": True}
        elif graph.get("editor_created") or graph.get("schedule_optional") is True:
            timetable = []
            schedule = {"source": "none", "filename": None, "demo": False}
        else:
            raise ValueError(f"Расписание кампуса {graph['id']} пусто")
        validate_timetable(graph, timetable)
        records[graph["id"]] = {"graph": graph, "timetable": timetable, "schedule": schedule}
        summaries.append(campus_summary(graph))

    default = records[default_campus_id]
    return {
        "version": catalog["version"],
        "demo": catalog["demo"],
        "default_campus_id": default_campus_id,
        "campuses": summaries,
        "campus_data": records,
        # Совместимый с однокампусными утилитами вид по умолчанию.
        "graph": default["graph"],
        "timetable": default["timetable"],
        "schedule": default["schedule"],
    }


class DataStore:
    """Перечитывает валидные данные после атомарного обновления CSV/JSON."""

    def __init__(self, folder: Path):
        self.folder = Path(folder)
        self._lock = threading.RLock()
        self._signature = None
        self._data = None

    def signature(self):
        return tuple(
            (name, (self.folder / name).stat().st_mtime_ns, (self.folder / name).stat().st_size)
            for name in ("graph.json", "timetable.csv", "timetable.demo.csv")
        )

    def get(self):
        with self._lock:
            signature = self.signature()
            if self._data is None or signature != self._signature:
                loaded = load_data(self.folder)
                if signature != self.signature():
                    raise OSError("Файлы данных обновляются. Повторите загрузку.")
                self._data = loaded
                self._signature = signature
            return self._data

    def publish(self, draft, version, creating):
        with self._lock:
            path = self.folder / "graph.json"
            original = path.read_bytes()
            catalog = json.loads(original)
            if version != catalog["version"]:
                return None
            if not isinstance(draft, dict) or not isinstance(creating, bool):
                raise ValueError("Некорректные данные кампуса")
            index = next((i for i, campus in enumerate(catalog["campuses"]) if campus["id"] == draft.get("id")), None)
            if creating != (index is None):
                raise ValueError("ID нового кампуса уже занят или редактируемый кампус удалён")
            existing = materialize_campus(catalog["campuses"][index], catalog.get("templates", {})) if index is not None else {}
            campus = editor_campus(draft, existing)
            if index is None:
                catalog["campuses"].append(campus)
            else:
                catalog["campuses"][index] = campus
            catalog["version"] = "editor-" + uuid.uuid4().hex
            load_data(self.folder, catalog)
            temp = path.with_name(f".graph-{uuid.uuid4().hex}.tmp")
            try:
                temp.write_text(json.dumps(catalog, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
                if original != path.read_bytes():
                    return None
                temp.replace(path)
            finally:
                temp.unlink(missing_ok=True)
            return catalog["version"]


def editor_campus(draft, existing):
    """Сохранить редактируемые поля и переиспользовать зоны исходного плана."""
    campus = {**existing, **{key: draft.get(key) for key in (
        "id", "city", "name", "short_name", "timezone", "coordinates",
    )}}
    campus["entrance_node_id"] = draft.get("entrance_node_id", existing.get("entrance_node_id", "entrance"))
    if not existing:
        campus["editor_created"] = True
    if not isinstance(campus["coordinates"], dict):
        raise ValueError("Укажите координаты кампуса")
    for key, limit in (("floors", 24), ("nodes", 800), ("edges", 1600)):
        rows = draft.get(key)
        if not isinstance(rows, list) or len(rows) > limit or not all(isinstance(row, dict) for row in rows):
            raise ValueError(f"Некорректный список {key}")
        campus[key] = rows
    for key in ("city", "name", "short_name", "timezone"):
        if not isinstance(campus[key], str) or len(campus[key]) > 120:
            raise ValueError(f"Некорректное поле {key}")
    original_floors = {floor["id"]: floor for floor in existing.get("floors", [])}
    floors = {}
    for index, floor in enumerate(campus["floors"]):
        floor_id = floor.get("id")
        if not isinstance(floor_id, str) or not SAFE_ID_RE.fullmatch(floor_id) or not valid_editor_label(floor.get("label")):
            raise ValueError("У каждого этажа должны быть ID и название")
        image = floor.get("image")
        floor = {**original_floors.get(floor_id, {"zones": []}), "id": floor_id, "label": floor["label"]}
        if image is not None:
            if image != floor.get("image"):
                if not isinstance(image, str) or len(image) > 1_600_000 or not image.startswith("data:image/jpeg;base64,"):
                    raise ValueError("Некорректная или слишком большая схема этажа")
                binary = base64.b64decode(image.split(",", 1)[1], validate=True)
                if not binary.startswith(b"\xff\xd8\xff") or not binary.endswith(b"\xff\xd9"):
                    raise ValueError("Схема этажа должна быть изображением JPEG")
            floor["image"] = image
        else:
            floor.pop("image", None)
        if not floor.get("zones") and not floor.get("image"):
            raise ValueError("Загрузите схему для каждого этажа")
        floors[floor_id] = floor
        campus["floors"][index] = floor
    for node in campus["nodes"]:
        if not valid_editor_label(node.get("label")):
            raise ValueError("У каждой точки должно быть название")
    for edge in campus["edges"]:
        if not valid_editor_label(edge.get("name")) or edge.get("kind") not in ("corridor", "stairs", "lift"):
            raise ValueError("У каждого прохода должны быть название и тип")
        for key in ("path", "instructions"):
            if key in edge and not isinstance(edge[key], dict):
                raise ValueError("Некорректная геометрия или инструкция прохода")
        for floor, points in edge.get("path", {}).items():
            if floor not in floors or not isinstance(points, list) or not 2 <= len(points) <= 200 or any(
                not isinstance(point, list) or len(point) != 2 or
                any(not _finite_number(value) or not 0 <= value <= bound for value, bound in zip(point, (440, 290)))
                for point in points
            ):
                raise ValueError("Некорректная линия прохода")
        if any(not valid_editor_label(value, 500) for value in edge.get("instructions", {}).values()):
            raise ValueError("Некорректная инструкция прохода")
    return campus


def valid_editor_label(value, limit=160):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= limit


def selected_campus(data, campus_id=None):
    selected_id = campus_id or data["default_campus_id"]
    try:
        return selected_id, data["campus_data"][selected_id]
    except KeyError as error:
        raise ValueError(f"Неизвестный campus_id: {selected_id}") from error


def campus_payload(data, campus_id=None):
    selected_id, record = selected_campus(data, campus_id)
    return {
        "campus_id": selected_id,
        "default_campus_id": data["default_campus_id"],
        "campuses": data["campuses"],
        "graph": record["graph"],
        "timetable": record["timetable"],
        "schedule": record["schedule"],
    }


def _validate_local_time(local_time):
    if not LOCAL_TIME_RE.fullmatch(local_time or ""):
        raise ValueError("Параметр at должен иметь формат YYYY-MM-DDTHH:MM")
    dt.datetime.fromisoformat(local_time)


def schedule_context(timetable, group_id, local_time):
    """Вернуть текущую, следующую и предыдущую пару относительно времени клиента."""
    if not group_id:
        raise ValueError("Укажите group_id")
    _validate_local_time(local_time)
    lessons = sorted(
        (row for row in timetable if row["group_id"] == group_id),
        key=lambda row: f'{row["date"]}T{row["start"]}',
    )
    current = next(
        (
            row
            for row in lessons
            if f'{row["date"]}T{row["start"]}' <= local_time < f'{row["date"]}T{row["end"]}'
        ),
        None,
    )
    upcoming = [row for row in lessons if f'{row["date"]}T{row["start"]}' > local_time]
    following = upcoming[0] if upcoming else None
    finished = [row for row in lessons if f'{row["date"]}T{row["end"]}' <= local_time]
    previous = finished[-1] if finished else None
    previous_on_same_day = previous if previous and following and previous["date"] == following["date"] else None
    route_from = (current or previous_on_same_day or {}).get("room_id")
    route_to = (following or {}).get("room_id")
    return {
        "current": current,
        "next": following,
        "previous": previous,
        "lesson": current or following,
        "route_from": route_from,
        "route_to": route_to,
    }


def next_lesson(timetable, group_id, local_time):
    """Совместимый помощник: текущая пара либо ближайшая будущая."""
    return schedule_context(timetable, group_id, local_time)["lesson"]


def health_payload(data, campus_id=None):
    selected_id, record = selected_campus(data, campus_id)
    graph = record["graph"]
    schedule = record["schedule"]
    demo = graph["demo"] or schedule["demo"]
    return {
        "ok": True,
        "status": "ok",
        "version": graph["version"],
        "graph_version": graph["version"],
        "mode": "DEMO" if demo else "Production",
        "demo": demo,
        "graph_demo": graph["demo"],
        "schedule_source": schedule["source"],
        "schedule_demo": schedule["demo"],
        "schedule_filename": schedule["filename"],
        "campus_id": selected_id,
        "campus_count": len(data["campuses"]),
    }


def data_version(data_dir: Path):
    return load_data(data_dir)["version"]


def make_server(host="0.0.0.0", port=8080, data_dir=None):
    store = DataStore(data_dir or ROOT / "data")
    store.get()
    editor_password = os.environ.get("NAVIGATOR_EDITOR_PASSWORD", "dattebayo").encode("utf-8")
    assets = {
        "/": ("index.html", "text/html; charset=utf-8"),
        "/index.html": ("index.html", "text/html; charset=utf-8"),
        "/styles.css": ("styles.css", "text/css; charset=utf-8"),
        "/theme.js": ("theme.js", "text/javascript; charset=utf-8"),
        "/assets/floors/chemk-4.png": ("assets/floors/chemk-4.png", "image/png"),
        "/mobile.css": ("mobile.css", "text/css; charset=utf-8"),
        "/mobile.js": ("mobile.js", "text/javascript; charset=utf-8"),
        "/route.js": ("route.js", "text/javascript; charset=utf-8"),
        "/app.js": ("app.js", "text/javascript; charset=utf-8"),
        "/editor": ("editor.html", "text/html; charset=utf-8"),
        "/editor.js": ("editor.js", "text/javascript; charset=utf-8"),
        "/map-plan.js": ("map-plan.js", "text/javascript; charset=utf-8"),
        "/vendor/jsQR.js": ("vendor/jsQR.js", "text/javascript; charset=utf-8"),
    }
    mobile_types = {".svg": "image/svg+xml", ".png": "image/png", ".ttf": "font/ttf"}
    for asset in (ROOT / "assets" / "mobile").iterdir():
        if asset.is_file() and asset.suffix in mobile_types:
            relative = f"assets/mobile/{asset.name}"
            assets[f"/{relative}"] = (relative, mobile_types[asset.suffix])
    if (ROOT / "certs" / "ca.crt").exists():
        assets["/ca.crt"] = ("certs/ca.crt", "application/x-x509-ca-cert")

    class Handler(BaseHTTPRequestHandler):
        def send_body(self, body, content_type, status=200):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def send_json(self, payload, status=200):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_body(body, "application/json; charset=utf-8", status)

        def do_POST(self):
            path = urlsplit(self.path).path
            if path not in ("/api/editor/login", "/api/editor/publish"):
                self.send_error(404)
                return
            supplied = unquote(self.headers.get("X-Editor-Password", "")).encode("utf-8")
            if not editor_password or not secrets.compare_digest(supplied, editor_password):
                self.send_json({"error": "Неверный пароль редактора"}, 401)
                return
            if path == "/api/editor/login":
                self.send_json({"ok": True})
                return
            if self.headers.get_content_type() != "application/json":
                self.send_json({"error": "Ожидаются данные JSON"}, 415)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 16 * 1024 * 1024:
                    self.send_json({"error": "Слишком большой или пустой запрос"}, 413)
                    return
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict):
                    raise ValueError("Некорректные данные кампуса")
                version = store.publish(payload.get("campus"), payload.get("version"), payload.get("creating"))
                if version is None:
                    self.send_json({"error": "Каталог обновился. Загрузите свежие данные перед публикацией."}, 409)
                    return
                self.send_json({"version": version})
            except (ValueError, TypeError, KeyError, OverflowError, RecursionError) as error:
                self.send_json({"error": str(error)}, 400)
            except OSError:
                self.send_json({"error": "Сервер не смог сохранить карту кампуса"}, 503)

        def do_GET(self):
            parsed = urlsplit(self.path)
            path = parsed.path
            if path.startswith("/api/"):
                try:
                    data = store.get()
                except (ValueError, OSError, KeyError, TypeError) as error:
                    self.send_json({"ok": False, "status": "error", "error": str(error)}, 503)
                    return
                try:
                    query = parse_qs(parsed.query)
                    campus_id = query.get("campus_id", [""])[0] or None
                    if path == "/api/campuses":
                        self.send_json({
                            "version": data["version"],
                            "demo": data["demo"],
                            "default_campus_id": data["default_campus_id"],
                            "campuses": data["campuses"],
                        })
                        return
                    if path == "/api/data":
                        self.send_json(campus_payload(data, campus_id))
                        return
                    if path == "/api/health":
                        self.send_json(health_payload(data, campus_id))
                        return
                    if path == "/api/timetable":
                        selected_id, record = selected_campus(data, campus_id)
                        group_id = query.get("group_id", [""])[0]
                        local_time = query.get("at", [""])[0]
                        context = schedule_context(record["timetable"], group_id, local_time)
                        self.send_json({
                            **context,
                            "group_id": group_id,
                            "campus_id": selected_id,
                            "at": local_time,
                            "version": record["graph"]["version"],
                            "schedule_source": record["schedule"]["source"],
                            "schedule_demo": record["schedule"]["demo"],
                        })
                        return
                    self.send_error(404)
                    return
                except ValueError as error:
                    self.send_json({"ok": False, "status": "error", "error": str(error)}, 400)
                    return

            if path in assets:
                filename, content_type = assets[path]
                try:
                    body = (ROOT / filename).read_bytes()
                except OSError:
                    self.send_error(404)
                    return
                self.send_body(body, content_type)
                return
            self.send_error(404)

        def log_message(self, *_args):
            pass

    return ThreadingHTTPServer((host, port), Handler)


def enable_tls(server, certfile, keyfile=None):
    """Обернуть готовый сервер в TLS; нужен для камеры и датчиков на телефоне."""
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile, keyfile)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    return server


def lan_urls(scheme, port):
    """Адреса компьютера в локальной сети для проверки с телефона."""
    try:
        addresses = socket.gethostbyname_ex(socket.gethostname())[2]
    except OSError:
        addresses = []
    return [f"{scheme}://{address}:{port}/" for address in sorted(set(addresses))]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Мультикампусный навигатор — локальный прототип")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--data", type=Path, default=ROOT / "data")
    parser.add_argument("--cert", type=Path, help="PEM-сертификат, включает HTTPS")
    parser.add_argument("--key", type=Path, help="PEM-ключ к сертификату")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    if args.key and not args.cert:
        parser.error("--key используется только вместе с --cert")

    if args.check:
        loaded = load_data(args.data)
        records = loaded["campus_data"].values()
        print(
            "DATA_OK",
            loaded["version"],
            f'campuses={len(loaded["campuses"])}',
            f'nodes={sum(len(record["graph"]["nodes"]) for record in records)}',
            f'edges={sum(len(record["graph"]["edges"]) for record in records)}',
            f'lessons={sum(len(record["timetable"]) for record in records)}',
        )
    else:
        server = make_server(args.host, args.port, args.data)
        if args.cert:
            enable_tls(server, args.cert, args.key)
        scheme = "https" if args.cert else "http"
        print(
            f'NAV_READY {scheme}://{args.host}:{server.server_port}/ '
            f'version={data_version(args.data)}',
            flush=True,
        )
        for address in lan_urls(scheme, server.server_port):
            print(f"NETWORK_URL {address}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
