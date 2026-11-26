import copy
import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import urlopen

from app import ROOT, editor_campus, load_data, make_server, schedule_context
from prepare_qr import urls


DEMO_DATE = "2026-11-18"


class AppTests(unittest.TestCase):
    def test_chemk_uses_real_plan_and_keeps_it_in_editor(self):
        data = load_data(ROOT / "data")
        chemk = data["campus_data"]["cheboksary-chemk"]
        graph = chemk["graph"]
        self.assertFalse(graph["demo"])
        self.assertEqual(chemk["schedule"]["source"], "none")
        self.assertEqual([floor["id"] for floor in graph["floors"]], ["4"])
        floor = graph["floors"][0]
        self.assertNotIn("image", floor)
        self.assertEqual(len(floor["zones"]), 18)
        self.assertEqual(editor_campus(copy.deepcopy(graph), graph)["floors"][0], floor)
        changed = copy.deepcopy(graph)
        changed["floors"][0]["image"] = "/arbitrary.png"
        with self.assertRaises(ValueError):
            editor_campus(changed, graph)
        legacy = copy.deepcopy(graph)
        image = "/assets/floors/chemk-4.png"
        legacy["floors"][0]["image"] = image
        self.assertEqual(editor_campus(copy.deepcopy(legacy), legacy)["floors"][0]["image"], image)

    def test_multicampus_data_and_qr_ids(self):
        data = load_data(ROOT / "data")
        self.assertEqual(data["default_campus_id"], "moscow-main")
        self.assertEqual(
            {campus["id"] for campus in data["campuses"]},
            {
                "moscow-main",
                "kazan-tech",
                "astrakhan-campus",
                "voronezh-campus",
                "yekaterinburg-campus",
                "krasnodar-campus",
                "krasnoyarsk-campus",
                "nizhny-novgorod-campus",
                "novocheboksarsk-campus",
                "sochi-campus",
                "tyumen-campus",
                "cheboksary-campus",
                "cheboksary-ddyut",
                "cheboksary-chemk",
            },
        )
        cheboksary = [campus for campus in data["campuses"] if campus["city"] == "Чебоксары"]
        self.assertEqual({campus["short_name"]: campus["temporarily_closed"] for campus in cheboksary},
                         {"ЦУМ": False, "ДДЮТ": True, "ЧЭМК": False})
        self.assertEqual(len(data["graph"]["nodes"]), 26)
        self.assertEqual(len(data["timetable"]), 15)
        self.assertEqual(sum(len(item["timetable"]) for item in data["campus_data"].values()), 70)
        self.assertEqual(data["schedule"]["source"], "demo")
        self.assertTrue(data["schedule"]["demo"])

        yekaterinburg = data["campus_data"]["yekaterinburg-campus"]
        self.assertEqual(yekaterinburg["graph"]["city"], "Екатеринбург")
        self.assertEqual(yekaterinburg["graph"]["timezone"], "Asia/Yekaterinburg")
        self.assertEqual(len(yekaterinburg["graph"]["floors"]), 2)
        self.assertNotIn("template", yekaterinburg["graph"])
        self.assertEqual(len(yekaterinburg["timetable"]), 5)
        self.assertEqual(yekaterinburg["timetable"][0]["group_id"], "ЕКБ-21")

        links = urls(data["graph"], "http://192.168.1.50:8080")
        self.assertEqual(
            links["entrance"],
            "http://192.168.1.50:8080/?campus_id=moscow-main&start_node=entrance",
        )
        self.assertNotIn("lab1", links)
        self.assertNotIn("coworking1", links)

        moscow_rooms = {node["label"] for node in data["graph"]["nodes"] if node["room"]}
        self.assertEqual(
            moscow_rooms,
            {
                "Аудитория А-101",
                "Аудитория А-201",
                "Аудитория А-301",
                "Коворкинг",
                "А-103",
                "А-105",
                "Гардероб",
                "WC",
                "А-207",
                "А-205",
                "А-203",
                "Зона отдыха",
                "А-307",
                "А-305",
                "А-303",
                "Читальная зона",
            },
        )
        city_rooms = {node["id"] for node in yekaterinburg["graph"]["nodes"] if node["room"]}
        self.assertEqual(
            city_rooms,
            {"room1", "room2", "coworking", "library", "reception", "wc1", "laboratory", "project", "lounge", "wc2"},
        )
        with self.assertRaises(ValueError):
            urls(data["graph"], "http://host/?token=abc")

    def invalid(self, mutate_graph=None, mutate_catalog=None, timetable=None):
        catalog = json.loads((ROOT / "data/graph.json").read_text(encoding="utf-8"))
        if mutate_graph:
            mutate_graph(catalog["campuses"][0])
        if mutate_catalog:
            mutate_catalog(catalog)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            (path / "graph.json").write_text(json.dumps(catalog), encoding="utf-8")
            source = timetable if timetable is not None else (ROOT / "data/timetable.csv").read_text(encoding="utf-8")
            (path / "timetable.csv").write_text(source, encoding="utf-8")
            (path / "timetable.demo.csv").write_text(
                (ROOT / "data/timetable.demo.csv").read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            with self.assertRaises((ValueError, KeyError, TypeError)):
                load_data(path)

    def test_real_timetable_has_priority_per_campus(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            (path / "graph.json").write_text((ROOT / "data/graph.json").read_text(encoding="utf-8"), encoding="utf-8")
            (path / "timetable.demo.csv").write_text(
                (ROOT / "data/timetable.demo.csv").read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            (path / "timetable.csv").write_text(
                "campus_id,group_id,date,start,end,room_id,title\n"
                "moscow-main,REAL-1,2026-11-18,09:00,09:40,lab1,Реальное занятие\n",
                encoding="utf-8",
            )
            data = load_data(path)
            self.assertEqual(data["campus_data"]["moscow-main"]["schedule"]["source"], "real")
            self.assertEqual([lesson["title"] for lesson in data["timetable"]], ["Реальное занятие"])
            self.assertEqual(data["campus_data"]["kazan-tech"]["schedule"]["source"], "demo")

    def test_schedule_context_routes_between_lessons(self):
        timetable = load_data(ROOT / "data")["timetable"]
        during = schedule_context(timetable, "ИСП-21", f"{DEMO_DATE}T08:55")
        self.assertEqual(during["current"]["room_id"], "lab1")
        self.assertEqual(during["next"]["room_id"], "lab2")
        self.assertEqual((during["route_from"], during["route_to"]), ("lab1", "lab2"))

        break_time = schedule_context(timetable, "ИСП-21", f"{DEMO_DATE}T09:45")
        self.assertIsNone(break_time["current"])
        self.assertEqual(break_time["previous"]["room_id"], "lab1")
        self.assertEqual((break_time["route_from"], break_time["route_to"]), ("lab1", "lab2"))

        before = schedule_context(timetable, "ИСП-21", f"{DEMO_DATE}T08:00")
        self.assertIsNone(before["route_from"])
        self.assertEqual(before["route_to"], "lab1")

    def test_duplicate_node(self):
        self.invalid(lambda graph: graph["nodes"].append(copy.deepcopy(graph["nodes"][0])))

    def test_negative_length(self):
        self.invalid(lambda graph: graph["edges"][0].update(length_m=-1))

    def test_invalid_heading(self):
        self.invalid(lambda graph: graph["nodes"][0].update(heading=360))

    def test_unknown_room(self):
        self.invalid(
            timetable=(
                "campus_id,group_id,date,start,end,room_id,title\n"
                "moscow-main,D,2026-11-18,09:00,09:40,missing,Test\n"
            )
        )

    def test_unknown_campus_in_timetable(self):
        self.invalid(
            timetable=(
                "campus_id,group_id,date,start,end,room_id,title\n"
                "unknown,D,2026-11-18,09:00,09:40,lab1,Test\n"
            )
        )

    def test_disconnected_graph(self):
        self.invalid(lambda graph: graph.update(edges=[edge for edge in graph["edges"] if "lab3" not in (edge["from"], edge["to"])]))

    def test_dangling_navigation_node(self):
        self.invalid(lambda graph: graph.update(edges=[edge for edge in graph["edges"] if edge["id"] != "hall-stairs"]))

    def test_invalid_closed_flag(self):
        self.invalid(lambda graph: graph["edges"][0].update(closed="yes"))

    def test_duplicate_campus(self):
        self.invalid(mutate_catalog=lambda catalog: catalog["campuses"].append(copy.deepcopy(catalog["campuses"][0])))

    def test_http_boundary_and_campus_selection(self):
        server = make_server(port=0)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            routes = [
                ("/api/campuses", "application/json"),
                ("/api/health?campus_id=kazan-tech", "application/json"),
                ("/api/data?campus_id=kazan-tech", "application/json"),
                ("/api/timetable?" + urlencode({"campus_id": "moscow-main", "group_id": "ИСП-21", "at": f"{DEMO_DATE}T09:45"}), "application/json"),
                ("/?campus_id=moscow-main&start_node=entrance", "text/html"),
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

            with urlopen(base + "/api/campuses", timeout=3) as response:
                catalog = json.load(response)
            self.assertEqual(len(catalog["campuses"]), 14)

            with urlopen(base + "/api/health?campus_id=kazan-tech", timeout=3) as response:
                health = json.load(response)
            self.assertEqual(health["status"], "ok")
            self.assertEqual(health["campus_id"], "kazan-tech")
            self.assertEqual(health["campus_count"], 14)

            with urlopen(base + "/api/data?campus_id=kazan-tech", timeout=3) as response:
                kazan = json.load(response)
            self.assertEqual(kazan["graph"]["city"], "Казань")
            self.assertTrue(all(row["campus_id"] == "kazan-tech" for row in kazan["timetable"]))

            with urlopen(base + "/api/data?campus_id=yekaterinburg-campus", timeout=3) as response:
                yekaterinburg = json.load(response)
            self.assertEqual(yekaterinburg["graph"]["city"], "Екатеринбург")
            self.assertEqual(yekaterinburg["graph"]["timezone"], "Asia/Yekaterinburg")
            self.assertEqual(len(yekaterinburg["graph"]["nodes"]), 16)
            self.assertEqual(len(yekaterinburg["timetable"]), 5)

            timetable_url = base + "/api/timetable?" + urlencode(
                {"campus_id": "moscow-main", "group_id": "ИСП-21", "at": f"{DEMO_DATE}T09:45"}
            )
            with urlopen(timetable_url, timeout=3) as response:
                context = json.load(response)
            self.assertEqual(context["lesson"]["room_id"], "lab2")
            self.assertEqual((context["route_from"], context["route_to"]), ("lab1", "lab2"))

            for private_path in ("/data/timetable.csv", "/api/data?campus_id=unknown"):
                with self.assertRaises(HTTPError) as context_error:
                    urlopen(base + private_path, timeout=3)
                self.assertIn(context_error.exception.code, (400, 404))
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)

    def test_timetable_reloads_without_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            data_dir = Path(folder)
            for filename in ("graph.json", "timetable.csv", "timetable.demo.csv"):
                (data_dir / filename).write_text((ROOT / "data" / filename).read_text(encoding="utf-8"), encoding="utf-8")
            demo_path = data_dir / "timetable.demo.csv"
            source = demo_path.read_text(encoding="utf-8")
            server = make_server(port=0, data_dir=data_dir)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            endpoint = (
                f"http://127.0.0.1:{server.server_port}/api/timetable?"
                + urlencode({"campus_id": "moscow-main", "group_id": "ИСП-21", "at": f"{DEMO_DATE}T09:45"})
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
