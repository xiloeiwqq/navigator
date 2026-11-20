"""Генерация печатных QR-ссылок для каждой навигационной точки."""

import argparse
import json
from pathlib import Path
from urllib.parse import urlencode, urlsplit


def urls(graph, base_url, campus_id=None):
    """Сформировать QR-ссылки, однозначные даже при одинаковых ID узлов."""
    parsed = urlsplit(base_url)
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.netloc
        or parsed.query
        or parsed.fragment
        or parsed.username
        or parsed.password
        or parsed.path not in ("", "/")
    ):
        raise ValueError("Нужен базовый HTTP(S) адрес без query, fragment и учётных данных")
    selected_campus = campus_id or graph.get("id")
    links = {}
    for node in graph["nodes"]:
        if not node.get("qr", False):
            continue
        query = {"start_node": node["id"]}
        if selected_campus:
            query = {"campus_id": selected_campus, **query}
        links[node["id"]] = base_url.rstrip("/") + "/?" + urlencode(query)
    return links


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--output", type=Path, default=Path("qr"))
    args = parser.parse_args()
    try:
        import segno
    except ImportError:
        raise SystemExit("Установите зависимости: python -m pip install -r requirements.txt")

    from app import ROOT, load_data

    data = load_data(ROOT / "data")
    args.output.mkdir(parents=True, exist_ok=True)
    all_links = {}
    manifest = []
    for campus_id, record in data["campus_data"].items():
        graph = record["graph"]
        links = urls(graph, args.base_url, campus_id)
        all_links[campus_id] = links
        campus_folder = args.output / campus_id
        campus_folder.mkdir(parents=True, exist_ok=True)
        nodes = {node["id"]: node for node in graph["nodes"]}
        for node_id, link in links.items():
            code = segno.make_qr(link, error="m")
            code.save(campus_folder / f"{node_id}.svg", scale=6, border=4)
            code.save(campus_folder / f"{node_id}.png", scale=6, border=4)
            manifest.append({
                "campus_id": campus_id,
                "city": graph["city"],
                "campus": graph["name"],
                "node_id": node_id,
                "label": nodes[node_id]["label"],
                "floor": nodes[node_id]["floor"],
                "heading": nodes[node_id].get("heading"),
                "url": link,
                "svg": f"{campus_id}/{node_id}.svg",
                "png": f"{campus_id}/{node_id}.png",
            })
    (args.output / "urls.json").write_text(
        json.dumps(all_links, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (args.output / "locations.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("QR_READY", len(manifest), f"campuses={len(all_links)}", "base=", args.base_url)
