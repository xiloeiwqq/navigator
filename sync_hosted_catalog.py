"""Mirror the cloud navigator's public API for readers on GitHub Pages."""

from concurrent.futures import ThreadPoolExecutor
import json
from http.cookiejar import CookieJar
from pathlib import Path
import re
import sys
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen


ORIGIN = "https://navigator-singularity.bentshortbread2.chatgpt.site"
SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")


def read(path):
    request = Request(ORIGIN + path, headers={"Accept": "application/json", "User-Agent": "Navigator-Catalog-Sync"})
    with urlopen(request, timeout=20) as response:
        if response.headers.get_content_type() != "application/json":
            raise ValueError(f"{path} did not return JSON")
        return json.load(response)


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
    index = destination / "index.json"
    if index.exists() and json.loads(index.read_text(encoding="utf-8"))["version"] == version:
        print("PUBLIC_CATALOG_CURRENT", version, len(ids))
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
    print("PUBLIC_CATALOG_SYNCED", version, len(ids))


def check_editor():
    browser = build_opener(HTTPCookieProcessor(CookieJar()))
    with browser.open(ORIGIN + "/editor", timeout=20) as response:
        if b'id="editor-password"' not in response.read():
            raise ValueError("The hosted editor has no password field")
    probe = Request(ORIGIN + "/api/editor/login", data=b"{}", headers={
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Origin": ORIGIN,
        "Referer": ORIGIN + "/editor",
        "X-Editor-Password": "invalid-verification-password",
    })
    try:
        browser.open(probe, timeout=20).close()
    except HTTPError as error:
        if error.code == 401 and error.headers.get_content_type() == "application/json":
            print("HOSTED_EDITOR_REJECTS_INCORRECT_PASSWORD")
            return
        raise
    raise ValueError("The hosted editor did not reject an incorrect password")


if __name__ == "__main__":
    if sys.argv[1] == "--check-editor":
        check_editor()
    else:
        synchronize(Path(sys.argv[1]))
