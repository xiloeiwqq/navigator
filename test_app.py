import copy
import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import urlopen

from app import ROOT, load_data, make_server
from prepare_qr import urls


class AppTests(unittest.TestCase):
    def test_data_and_qr_ids(self):
        data = load_data(ROOT / "data")
        self.assertEqual(len(data["graph"]["nodes"]), 11)
        self.assertEqual(len(data["timetable"]), 15)
        self.assertEqual(data["schedule"]["source"], "demo")
        self.assertEqual(data["schedule"]["filename"], "timetable.demo.csv")
        self.assertTrue(data["schedule"]["demo"])
        links = urls(data["graph"], "http://192.168.1.50:8080")
        self.assertEqual(links["entrance"], "http://192.168.1.50:8080/?start_node=entrance")
        self.assertNotIn("lab1", links)
        with self.assertRaises(ValueError):
            urls(data["graph"], "http://host/?token=abc")

    def invalid(self, mutate_graph=None, timetable=None):
        graph = load_data(ROOT / "data")["graph"]
        if mutate_graph:
            mutate_graph(graph)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            (path / "graph.json").write_text(json.dumps(graph), encoding="utf-8")
            source = timetable if timetable is not None else (ROOT / "data/timetable.csv").read_text(encoding="utf-8")
            (path / "timetable.csv").write_text(source, encoding="utf-8")
            (path / "timetable.demo.csv").write_text(
                (ROOT / "data/timetable.demo.csv").read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            with self.assertRaises(ValueError):
                load_data(path)

    def test_real_timetable_has_priority(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            (path / "graph.json").write_text((ROOT / "data/graph.json").read_text(encoding="utf-8"), encoding="utf-8")
            (path / "timetable.demo.csv").write_text(
                (ROOT / "data/timetable.demo.csv").read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            (path / "timetable.csv").write_text(
                "group_id,date,start,end,room_id,title\nREAL-1,2026-11-16,09:00,09:40,lab1,Реальное занятие\n",
                encoding="utf-8",
            )
            data = load_data(path)
            self.assertEqual(data["schedule"]["source"], "real")
            self.assertFalse(data["schedule"]["demo"])
            self.assertEqual([lesson["title"] for lesson in data["timetable"]], ["Реальное занятие"])

    def test_duplicate_node(self):
        self.invalid(lambda graph: graph["nodes"].append(copy.deepcopy(graph["nodes"][0])))

    def test_negative_length(self):
        self.invalid(lambda graph: graph["edges"][0].update(length_m=-1))

    def test_unknown_room(self):
        self.invalid(timetable="group_id,date,start,end,room_id,title\nD,2026-11-16,09:00,09:40,missing,Test\n")

    def test_disconnected_graph(self):
        self.invalid(lambda graph: graph.update(edges=[edge for edge in graph["edges"] if "lab3" not in (edge["from"], edge["to"])]))

    def test_dangling_navigation_node(self):
        self.invalid(lambda graph: graph.update(edges=[edge for edge in graph["edges"] if edge["id"] != "hall-stairs"]))

    def test_invalid_closed_flag(self):
        self.invalid(lambda graph: graph["edges"][0].update(closed="yes"))

    def test_http_boundary(self):
        server = make_server(port=0)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            routes = [
                ("/api/health", "application/json"),
                ("/api/data", "application/json"),
                ("/api/timetable?" + urlencode({"group_id": "ИСП-21", "at": "2026-11-16T09:45"}), "application/json"),
                ("/?start_node=entrance", "text/html"),
                ("/styles.css", "text/css"),
                ("/app.js", "text/javascript"),
                ("/vendor/jsQR.js", "text/javascript"),
            ]
            for route, expected in routes:
                with urlopen(base + route, timeout=3) as response:
                    self.assertEqual(response.status, 200)
                    self.assertIn(expected, response.headers["Content-Type"])
                    self.assertIn("no-store", response.headers["Cache-Control"])
                    self.assertTrue(response.read())
            with urlopen(base + "/api/health", timeout=3) as response:
                health = json.load(response)
            self.assertEqual(health["status"], "ok")
            self.assertEqual(health["mode"], "DEMO")
            self.assertEqual(health["graph_version"], health["version"])
            self.assertEqual(health["schedule_source"], "demo")
            self.assertTrue(health["schedule_demo"])
            timetable_url = base + "/api/timetable?" + urlencode({"group_id": "ИСП-21", "at": "2026-11-16T09:45"})
            with urlopen(timetable_url, timeout=3) as response:
                lesson = json.load(response)["lesson"]
            self.assertEqual(lesson["room_id"], "lab2")
            with self.assertRaises(HTTPError) as context:
                urlopen(base + "/data/timetable.csv", timeout=3)
            self.assertEqual(context.exception.code, 404)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)

    def test_timetable_reloads_without_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            data_dir = Path(folder)
            (data_dir / "graph.json").write_text((ROOT / "data/graph.json").read_text(encoding="utf-8"), encoding="utf-8")
            timetable_path = data_dir / "timetable.csv"
            timetable_path.write_text((ROOT / "data/timetable.csv").read_text(encoding="utf-8"), encoding="utf-8")
            demo_path = data_dir / "timetable.demo.csv"
            source = (ROOT / "data/timetable.demo.csv").read_text(encoding="utf-8")
            demo_path.write_text(source, encoding="utf-8")
            server = make_server(port=0, data_dir=data_dir)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            endpoint = (
                f"http://127.0.0.1:{server.server_port}/api/timetable?"
                + urlencode({"group_id": "ИСП-21", "at": "2026-11-16T09:45"})
            )
            try:
                with urlopen(endpoint, timeout=3) as response:
                    first = json.load(response)["lesson"]
                self.assertEqual(first["title"], "Объектно-ориентированное программирование")
                demo_path.write_text(source.replace("Объектно-ориентированное программирование", "Обновлённое занятие"), encoding="utf-8")
                with urlopen(endpoint, timeout=3) as response:
                    updated = json.load(response)["lesson"]
                self.assertEqual(updated["title"], "Обновлённое занятие")
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
