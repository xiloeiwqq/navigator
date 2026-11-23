"use strict";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgElement(name, attributes = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function floorUsesDetailedZoom(floor) {
  return Boolean(floor?.image || floor?.outline);
}

function drawZoneLabel(svg, zone, compact) {
  if (!zone.label) return;
  const x = zone.x + zone.width / 2;
  const center = zone.y + (compact && zone.type === "stairs" ? zone.height * .77 : zone.height / 2);
  const anchor = {x, "data-rotation-center": `${x} ${center}`};
  if (!compact) {
    svg.append(svgElement("text", {...anchor, y: center + 3, class: "map-room-label"}, zone.label));
    return;
  }
  const lines = (zone.map_label || zone.label).split("\n");
  const longest = Math.max(...lines.map(line => line.length));
  const size = Math.min(7.2, (zone.width - 4) * 1.85 / longest, (zone.height - 3) / (lines.length * 1.22));
  const text = svgElement("text", {...anchor, class: "map-room-label map-room-label--compact", style: `--map-label-size: ${size}px`});
  lines.forEach((line, index) => {
    const y = center + (index - (lines.length - 1) / 2) * size * 1.22 + size * .35;
    text.append(svgElement("tspan", {x, y}, line));
  });
  svg.append(text);
}

function drawPlan(svg, floor) {
  if (floor.image) {
    svg.append(svgElement("image", {href: floor.image, x: 0, y: 0, width: 440, height: 290}));
    return;
  }
  const compact = Boolean(floor.outline);
  const outline = floor.outline || {x: 18, y: 28, width: 404, height: 234};
  svg.append(svgElement("rect", {...outline, rx: 8, class: compact ? "floor-shell floor-shell--compact" : "floor-shell"}));
  for (const zone of floor.zones || []) {
    const corridor = zone.type === "corridor";
    const service = ["service", "stairs", "lift"].includes(zone.type);
    const inset = compact && !corridor ? 1.15 : 0;
    const classes = corridor ? ["map-corridor"] : ["map-room"];
    if (service) classes.push("map-room--service");
    if (compact) classes.push("map-room--compact");
    if (zone.uncertain) classes.push("map-room--uncertain");
    const room = svgElement("rect", {
      x: zone.x + inset, y: zone.y + inset,
      width: zone.width - inset * 2, height: zone.height - inset * 2,
      rx: corridor ? 0 : 3, class: classes.join(" ")
    });
    if (compact && zone.label) room.append(svgElement("title", {}, zone.label));
    svg.append(room);
    if (!compact) drawZoneLabel(svg, zone, false);
    if (zone.type === "stairs") {
      for (let offset = compact ? 7 : 11; offset < zone.width - (compact ? 6 : 4); offset += compact ? 5 : 9) {
        svg.append(svgElement("line", {
          x1: zone.x + offset, x2: zone.x + offset,
          y1: zone.y + (compact ? 4 : 9), y2: zone.y + zone.height - (compact ? 11 : 9),
          class: compact ? "stairs-lines stairs-lines--compact" : "stairs-lines"
        }));
      }
    }
    if (zone.type === "lift") {
      const cx = zone.x + zone.width / 2;
      const cy = zone.y + zone.height / 2;
      svg.append(svgElement("path", {d: `M${cx} ${cy-13}v26M${cx-5} ${cy-8}l5-5 5 5M${cx-5} ${cy+8}l5 5 5-5`, class: "lift-glyph"}));
    }
    if (compact) drawZoneLabel(svg, zone, true);
  }
  if (!compact) svg.append(svgElement("text", {x: 385, y: 248, class: "map-floor-label", "text-anchor": "end"}, floor.id));
}
