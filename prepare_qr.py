"""Генерация печатных QR-ссылок для каждой навигационной точки."""

import argparse
import json
from pathlib import Path
from urllib.parse import urlencode, urlsplit


def urls(graph, base_url):
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
    return {
        node["id"]: base_url.rstrip("/") + "/?" + urlencode({"start_node": node["id"]})
        for node in graph["nodes"]
        if node.get("qr", False)
    }


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

    graph = load_data(ROOT / "data")["graph"]
    links = urls(graph, args.base_url)
    args.output.mkdir(parents=True, exist_ok=True)
    for node_id, link in links.items():
        code = segno.make_qr(link, error="m")
        code.save(args.output / f"{node_id}.svg", scale=6, border=4)
        code.save(args.output / f"{node_id}.png", scale=6, border=4)
    (args.output / "urls.json").write_text(json.dumps(links, ensure_ascii=False, indent=2), encoding="utf-8")
    nodes = {node["id"]: node for node in graph["nodes"]}
    manifest = [
        {
            "node_id": node_id,
            "label": nodes[node_id]["label"],
            "floor": nodes[node_id]["floor"],
            "url": link,
            "svg": f"{node_id}.svg",
            "png": f"{node_id}.png",
        }
        for node_id, link in links.items()
    ]
    (args.output / "locations.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("QR_READY", len(links), "base=", args.base_url)
