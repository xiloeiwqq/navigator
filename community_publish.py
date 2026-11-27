"""Validate a campus submitted in a GitHub issue and update the public feed."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zoneinfo import ZoneInfo

from app import editor_campus, validate_campus


FORMAT = "navigator-campus-v1"
MAX_BYTES = 16 * 1024 * 1024
ATTACHMENT_URL = re.compile(
    r"https://github\.com/user-attachments/(?:"
    r"files/[0-9]+/navigator-campus-[A-Za-z0-9_-]+\.json"
    r"|assets/[a-f0-9-]{36})(?![A-Za-z0-9._/-])"
)
NODE_FIELDS = {
    "id", "label", "floor", "x", "y", "room", "qr", "heading", "terminal", "standalone",
}
EDGE_FIELDS = {
    "id", "name", "from", "to", "length_m", "accessible", "kind", "path", "instructions", "closed",
}


class GitHubAttachmentRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, location):
        target = urlsplit(location)
        host = target.hostname or ""
        github_asset = host.endswith(".githubusercontent.com") or host == "github-production-user-asset-6210df.s3.amazonaws.com"
        github_attachment = host == "github.com" and target.path.startswith("/user-attachments/")
        if target.scheme != "https" or not (github_asset or github_attachment):
            raise ValueError("GitHub перенаправил вложение на неподдерживаемый адрес")
        return super().redirect_request(request, fp, code, message, headers, location)


def fetch_attachment(body):
    links = list(dict.fromkeys(ATTACHMENT_URL.findall(body or "")))
    if len(links) != 1:
        raise ValueError("Прикрепите один файл navigator-campus-…json, скачанный в редакторе")
    request = Request(links[0], headers={"User-Agent": "College-Navigator-Campus-Intake"})
    try:
        with build_opener(GitHubAttachmentRedirect()).open(request, timeout=25) as response:
            data = response.read(MAX_BYTES + 1)
    except URLError as error:
        raise ValueError("GitHub не отдал вложение по ссылке") from error
    if len(data) > MAX_BYTES:
        raise ValueError("Файл кампуса превышает 16 МБ")
    return json.loads(data)


def clean_rows(value, fields, label):
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise ValueError(f"Некорректный список {label}")
    return [{key: field for key, field in item.items() if key in fields} for item in value]


def validate_submission(payload):
    if not isinstance(payload, dict) or payload.get("format") != FORMAT or not isinstance(payload.get("campus"), dict):
        raise ValueError("Нужен файл, созданный публичным редактором навигатора")
    draft = payload["campus"].copy()
    draft["nodes"] = clean_rows(draft.get("nodes"), NODE_FIELDS, "точек")
    draft["edges"] = clean_rows(draft.get("edges"), EDGE_FIELDS, "проходов")
    result = editor_campus(draft, {})
    ZoneInfo(result["timezone"])
    result.update(demo=False, auto_select=False, schedule_optional=True, community=True, start_at_entrance=True)
    result["route_note"] = "План добавлен участником. Сверяйте маршруты с указателями на месте."
    validate_campus(result)
    return result


def write_json(path, payload):
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def add_campus(issue, baseline_path, data_dir, payload=None):
    number = issue["number"]
    index_path = data_dir / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    previous = index["submissions"].get(str(number))
    if previous:
        return "unchanged", previous
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    if payload is None:
        payload = fetch_attachment(issue.get("body"))
    graph = validate_submission(payload)
    occupied = {"index", "campuses"} | {item["id"] for item in baseline["campuses"] + index["campuses"]}
    if graph["id"] in occupied:
        raise ValueError("Такой ID кампуса уже используется. Выберите другой ID в редакторе.")

    version = datetime.now(timezone.utc).strftime(f"community-{number}-%Y%m%d%H%M%S")
    graph["version"] = version
    short = {
        key: graph[key] for key in ("id", "name", "city", "short_name", "timezone", "coordinates", "auto_select")
    }
    short.update(floor_count=len(graph["floors"]), temporarily_closed=False, community=True)
    write_json(data_dir / f"{graph['id']}.json", {
        "graph": graph,
        "timetable": [],
        "schedule": {"source": "none", "filename": None, "demo": False},
    })
    index["campuses"].append(short)
    index["submissions"][str(number)] = graph["id"]
    index["version"] = version
    write_json(index_path, index)
    return "published", graph["id"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("event", type=Path)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("feed", type=Path)
    parser.add_argument("result", type=Path)
    args = parser.parse_args()
    event = json.loads(args.event.read_text(encoding="utf-8"))
    issue = event["issue"]
    try:
        state, detail = add_campus(issue, args.baseline, args.feed)
    except (AttributeError, KeyError, TypeError, ValueError) as error:
        state, detail = "invalid", str(error)
    write_json(args.result, {"state": state, "detail": detail})
    print("CAMPUS_SUBMISSION", state)


if __name__ == "__main__":
    main()
