"""Mirror the cloud navigator's public API for readers on GitHub Pages."""

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ORIGIN = "https://navigator-singularity.bentshortbread2.chatgpt.site"
SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")


def read(path):
    request = Request(ORIGIN + path, headers={"Accept": "application/json", "User-Agent": "Navigator-Catalog-Sync"})
    with urlopen(request, timeout=20) as response:
        if response.headers.get_content_type() != "application/json":
            raise ValueError(f"{path} did not return JSON")
        return json.load(response)


def verify_editor_requires_password():
    try:
        urlopen(Request(ORIGIN + "/api/editor/login", method="POST"), timeout=20).close()
    except HTTPError as error:
        if error.code == 401:
            return
        raise
    raise ValueError("The public editor accepted a request without a password")


def campus_payload(campus, version):
    result = read("/api/data?" + urlencode({"campus_id": campus}))
    if result["campus_id"] != campus or result["graph"]["version"] != version:
        raise ValueError("The cloud catalog changed during synchronization. Retry at the next run.")
    return result


def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def synchronize(destination):
    catalog = read("/api/campuses")
    version = catalog["version"]
    ids = [item["id"] for item in catalog["campuses"]]
    if not ids or not all(SAFE_ID.fullmatch(campus) for campus in ids):
        raise ValueError("Invalid campus IDs returned by the hosted catalog")
    verify_editor_requires_password()
    index = destination / "index.json"
    if index.exists() and json.loads(index.read_text(encoding="utf-8"))["version"] == version:
        print("CLOUD_PUBLIC_AND_EDITOR_PROTECTED", version, len(ids))
        return
    with ThreadPoolExecutor(max_workers=6) as workers:
        payloads = list(workers.map(lambda campus: campus_payload(campus, version), ids))
    if read("/api/campuses")["version"] != version:
        raise ValueError("The cloud catalog changed during synchronization. Retry at the next run.")
    campus_dir = destination / "campuses"
    campus_dir.mkdir(parents=True, exist_ok=True)
    current = set()
    for payload in payloads:
        filename = payload["campus_id"] + ".json"
        current.add(filename)
        write(campus_dir / filename, payload)
    for previous in campus_dir.glob("*.json"):
        if previous.name not in current:
            previous.unlink()
    write(index, catalog)
    print("CLOUD_PUBLIC_AND_EDITOR_PROTECTED", version, len(ids))


if __name__ == "__main__":
    synchronize(Path(sys.argv[1]))
