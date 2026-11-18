"""Локальный мультикампусный сервер навигатора без внешних API и трекинга."""

import argparse
import copy
import csv
import datetime as dt
import json
import math
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


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

    # Изолированный участок делает физическую QR-метку бесполезной.
    reached = set()
    pending = [next(iter(nodes))]
    while pending:
        current = pending.pop()
        if current in reached:
            continue
        reached.add(current)
        pending.extend(neighbors[current] - reached)
    if reached != set(nodes):
        missing = ", ".join(sorted(set(nodes) - reached))
        raise ValueError(f"Граф кампуса {campus_id} несвязный, недоступны узлы: {missing}")
    if any(node.get("qr", False) and not neighbors[node["id"]] for node in nodes.values()):
        raise ValueError("QR-точка не может быть изолированным узлом")

    entrance = campus.get("entrance_node_id", "entrance")
    if entrance not in nodes:
        raise ValueError(f"Неизвестный главный вход кампуса {campus_id}")
    dangling = [
        node["id"]
        for node in nodes.values()
        if not node["room"]
        and node["id"] != entrance
        and not node.get("terminal", False)
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


def load_data(folder: Path):
    """Прочитать и полностью проверить каталог кампусов и оба CSV."""
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
        graph["demo"] = bool(catalog["demo"] or source.get("demo", False))
        validate_campus(graph)

        campus_real = [row for row in real_rows if row["campus_id"] == graph["id"]]
        campus_demo = [row for row in demo_rows if row["campus_id"] == graph["id"]]
        if campus_real:
            timetable = campus_real
            schedule = {"source": "real", "filename": "timetable.csv", "demo": False}
        elif campus_demo:
            timetable = campus_demo
            schedule = {"source": "demo", "filename": "timetable.demo.csv", "demo": True}
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
        signature = self.signature()
        with self._lock:
            if self._data is None or signature != self._signature:
                loaded = load_data(self.folder)
                self._data = loaded
                self._signature = self.signature()
            return self._data


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
    assets = {
        "/": ("index.html", "text/html; charset=utf-8"),
        "/index.html": ("index.html", "text/html; charset=utf-8"),
        "/styles.css": ("styles.css", "text/css; charset=utf-8"),
        "/route.js": ("route.js", "text/javascript; charset=utf-8"),
        "/app.js": ("app.js", "text/javascript; charset=utf-8"),
        "/vendor/jsQR.js": ("vendor/jsQR.js", "text/javascript; charset=utf-8"),
    }

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
                body = (ROOT / filename).read_bytes()
                self.send_body(body, content_type)
                return
            self.send_error(404)

        def log_message(self, *_args):
            pass

    return ThreadingHTTPServer((host, port), Handler)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Мультикампусный навигатор — локальный прототип")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--data", type=Path, default=ROOT / "data")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

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
        print(
            f'NAV_READY http://{args.host}:{server.server_port}/ '
            f'version={data_version(args.data)}',
            flush=True,
        )
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
