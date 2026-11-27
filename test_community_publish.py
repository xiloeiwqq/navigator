import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from community_publish import ATTACHMENT_URL, FORMAT, add_campus, validate_submission, write_json


def example(campus_id="perm-campus"):
    return {
        "format": FORMAT,
        "campus": {
            "id": campus_id,
            "name": "Учебный центр",
            "short_name": "Учебный центр",
            "city": "Пермь",
            "timezone": "Asia/Yekaterinburg",
            "coordinates": {"latitude": 58.01, "longitude": 56.25},
            "entrance_node_id": "entrance",
            "floors": [{"id": "1", "label": "1 этаж", "image": "data:image/jpeg;base64,/9j/2Q=="}],
            "nodes": [
                {"id": "entrance", "label": "Вход", "floor": "1", "x": 45, "y": 125, "room": False, "qr": True},
                {"id": "classroom", "label": "Кабинет", "floor": "1", "x": 200, "y": 125, "room": True}
            ],
            "edges": [
                {"id": "entrance-classroom", "name": "Коридор", "from": "entrance", "to": "classroom",
                 "kind": "corridor", "accessible": True, "length_m": 8}
            ]
        }
    }


class CommunitySubmissionTests(unittest.TestCase):
    def test_accepts_github_attachment_links_only(self):
        url = "https://github.com/user-attachments/files/42/navigator-campus-perm.1.json"
        markdown = f"[План]({url}) [Сторонний файл](https://example.org/plan.json)"
        self.assertEqual(ATTACHMENT_URL.findall(markdown), [url])

    def test_new_city_and_duplicate_or_retried_submission(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            baseline = root / "baseline.json"
            index = root / "index.json"
            write_json(baseline, {"campuses": [{"id": "moscow-main"}]})
            write_json(index, {"version": "", "campuses": [], "submissions": {}})

            self.assertEqual(add_campus({"number": 42}, baseline, root, example()), ("published", "perm-campus"))
            result = json.loads((root / "perm-campus.json").read_text(encoding="utf-8"))
            self.assertEqual(result["graph"]["city"], "Пермь")
            self.assertEqual(result["graph"]["entrance_node_id"], "entrance")
            self.assertTrue(result["graph"]["community"])
            self.assertFalse(result["graph"]["auto_select"])
            self.assertEqual(add_campus({"number": 42}, baseline, root, example()), ("unchanged", "perm-campus"))

            for duplicate in ("moscow-main", "perm-campus", "index", "campuses"):
                with self.assertRaises(ValueError):
                    add_campus({"number": 43}, baseline, root, example(duplicate))
            self.assertEqual(len(json.loads(index.read_text(encoding="utf-8"))["campuses"]), 1)

    def test_unsafe_map_type_is_rejected(self):
        payload = example()
        payload["campus"]["floors"][0]["image"] = "https://example.com/picture.svg"
        with self.assertRaises(ValueError):
            validate_submission(payload)


if __name__ == "__main__":
    unittest.main()
