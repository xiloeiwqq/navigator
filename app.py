"""Локальный сервер навигатора без внешних API и трекинга."""

import argparse
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
TIMETABLE_FIELDS = ("group_id", "date", "start", "end", "room_id", "title")


def read_timetable(path: Path):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if not reader.fieldnames or any(field not in reader.fieldnames for field in TIMETABLE_FIELDS):
            raise ValueError(f"Некорректные столбцы расписания: {path.name}")
        return [row for row in reader if any((row.get(field) or "").strip() for field in TIMETABLE_FIELDS)]


def load_timetable(folder: Path):
    """Выбрать реальное расписание или тестовый файл-запасной вариант."""
    real_timetable = read_timetable(folder / "timetable.csv")
    if real_timetable:
        return real_timetable, {"source": "real", "filename": "timetable.csv", "demo": False}

    demo_timetable = read_timetable(folder / "timetable.demo.csv")
    if not demo_timetable:
        raise ValueError("Расписание пусто: заполните timetable.csv или timetable.demo.csv")
    return demo_timetable, {"source": "demo", "filename": "timetable.demo.csv", "demo": True}


def load_data(folder: Path):
    """Прочитать и полностью проверить граф и расписание."""
    graph = json.loads((folder / "graph.json").read_text(encoding="utf-8"))
    if not isinstance(graph.get("demo"), bool) or not graph.get("version") or not graph.get("timezone"):
        raise ValueError("Нужны demo, version и timezone")

    floor_rows = graph.get("floors", [])
    floors = {floor["id"] for floor in floor_rows}
    if not floors or len(floors) != len(floor_rows):
        raise ValueError("Этажи должны иметь уникальные ID")

    node_rows = graph.get("nodes", [])
    nodes = {node["id"]: node for node in node_rows}
    if len(nodes) != len(node_rows) or not nodes:
        raise ValueError("Повторяющийся или пустой ID узла")

    for node in nodes.values():
        if not isinstance(node["id"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", node["id"]):
            raise ValueError("ID узла: буквы ASCII, цифры, дефис или подчёркивание")
        if node["floor"] not in floors or not isinstance(node["room"], bool):
            raise ValueError("Неизвестный этаж или некорректный room")
        if "qr" in node and not isinstance(node["qr"], bool):
            raise ValueError("qr должен быть true или false")
        for axis, maximum in (("x", 440), ("y", 290)):
            value = node[axis]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= maximum:
                raise ValueError("Координаты должны быть конечными числами в пределах схемы")

    edge_rows = graph.get("edges", [])
    seen_edges = set()
    neighbors = {node_id: set() for node_id in nodes}
    for edge in edge_rows:
        if edge["id"] in seen_edges or edge["from"] not in nodes or edge["to"] not in nodes:
            raise ValueError("Повторяющийся проход или неизвестная конечная точка")
        if edge["from"] == edge["to"]:
            raise ValueError("Проход не может вести из узла в него же")
        seen_edges.add(edge["id"])
        length = edge["length_m"]
        if isinstance(length, bool) or not isinstance(length, (int, float)) or not math.isfinite(length) or length <= 0:
            raise ValueError("Длина прохода должна быть конечной и больше нуля")
        if not isinstance(edge["accessible"], bool):
            raise ValueError("accessible должен быть true или false")
        if "closed" in edge and not isinstance(edge["closed"], bool):
            raise ValueError("closed должен быть true или false")
        neighbors[edge["from"]].add(edge["to"])
        neighbors[edge["to"]].add(edge["from"])

    # Изолированный или оторванный участок делает физическую QR-метку бесполезной.
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
        raise ValueError(f"Граф несвязный, недоступны узлы: {missing}")
    if any(node.get("qr", False) and not neighbors[node["id"]] for node in nodes.values()):
        raise ValueError("QR-точка не может быть изолированным узлом")
    dangling = [
        node["id"] for node in nodes.values()
        if not node["room"]
        and node["id"] != "entrance"
        and not node.get("terminal", False)
        and len(neighbors[node["id"]]) < 2
    ]
    if dangling:
        raise ValueError(f"Висячие навигационные узлы: {', '.join(sorted(dangling))}")

    timetable, schedule = load_timetable(folder)
    for row in timetable:
        if not row.get("group_id") or row.get("room_id") not in nodes or not nodes[row["room_id"]]["room"]:
            raise ValueError("Группа или аудитория расписания неизвестна")
        if not row.get("title"):
            raise ValueError("У занятия должно быть название")
        dt.date.fromisoformat(row["date"])
        if not re.fullmatch(r"\d{2}:\d{2}", row["start"]) or not re.fullmatch(r"\d{2}:\d{2}", row["end"]):
            raise ValueError("Время расписания должно быть в формате HH:MM")
        start = dt.time.fromisoformat(row["start"])
        end = dt.time.fromisoformat(row["end"])
        if end <= start:
            raise ValueError("Конец занятия должен быть позже начала в тот же день")

    return {"graph": graph, "timetable": timetable, "schedule": schedule}


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
                # Сигнатура запоминается только после успешной валидации.
                self._data = loaded
                self._signature = self.signature()
            return self._data


def next_lesson(timetable, group_id, local_time):
    if not group_id:
        raise ValueError("Укажите group_id")
    if not LOCAL_TIME_RE.fullmatch(local_time):
        raise ValueError("Параметр at должен иметь формат YYYY-MM-DDTHH:MM")
    dt.datetime.fromisoformat(local_time)
    candidates = [
        row for row in timetable
        if row["group_id"] == group_id and f'{row["date"]}T{row["end"]}' > local_time
    ]
    return min(candidates, key=lambda row: f'{row["date"]}T{row["start"]}', default=None)


def health_payload(data):
    graph = data["graph"]
    demo = graph["demo"] or data["schedule"]["demo"]
    mode = "DEMO" if demo else "Production"
    return {
        "ok": True,
        "status": "ok",
        "version": graph["version"],
        "graph_version": graph["version"],
        "mode": mode,
        "demo": demo,
        "graph_demo": graph["demo"],
        "schedule_source": data["schedule"]["source"],
        "schedule_demo": data["schedule"]["demo"],
        "schedule_filename": data["schedule"]["filename"],
    }


def data_version(data_dir: Path):
    """Версия данных для сообщения запуска."""
    return load_data(data_dir)["graph"]["version"]


def make_server(host="0.0.0.0", port=8080, data_dir=None):
    store = DataStore(data_dir or ROOT / "data")
    store.get()  # Не запускаем сервер с невалидными исходными данными.
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
                    if path == "/api/data":
                        self.send_json(data)
                        return
                    if path == "/api/health":
                        self.send_json(health_payload(data))
                        return
                    if path == "/api/timetable":
                        query = parse_qs(parsed.query)
                        group_id = query.get("group_id", [""])[0]
                        local_time = query.get("at", [""])[0]
                        lesson = next_lesson(data["timetable"], group_id, local_time)
                        self.send_json({
                            "lesson": lesson,
                            "group_id": group_id,
                            "at": local_time,
                            "version": data["graph"]["version"],
                            "schedule_source": data["schedule"]["source"],
                            "schedule_demo": data["schedule"]["demo"],
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
    parser = argparse.ArgumentParser(description="Навигатор кампуса — локальный прототип")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--data", type=Path, default=ROOT / "data")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    if args.check:
        loaded = load_data(args.data)
        print(
            "DATA_OK",
            loaded["graph"]["version"],
            f'nodes={len(loaded["graph"]["nodes"])}',
            f'edges={len(loaded["graph"]["edges"])}',
            f'lessons={len(loaded["timetable"])}',
            f'schedule={loaded["schedule"]["source"]}',
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
