"use strict";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgElement(name, attributes = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function drawPlan(svg, floor) {
  if (floor.image) {
    svg.append(svgElement("image", {href: floor.image, x: 0, y: 0, width: 440, height: 290}));
    return;
  }
  svg.append(svgElement("rect", {x: 18, y: 28, width: 404, height: 234, rx: 8, class: "floor-shell"}));
  for (const zone of floor.zones || []) {
    const className = zone.type === "corridor" ? "map-corridor" : `map-room${zone.type === "service" || zone.type === "stairs" || zone.type === "lift" ? " map-room--service" : ""}`;
    svg.append(svgElement("rect", {x: zone.x, y: zone.y, width: zone.width, height: zone.height, rx: zone.type === "corridor" ? 0 : 3, class: className}));
    if (zone.label) svg.append(svgElement("text", {x: zone.x + zone.width / 2, y: zone.y + zone.height / 2 + 3, class: "map-room-label"}, zone.label));
    if (zone.type === "stairs") {
      for (let offset = 11; offset < zone.width - 4; offset += 9) {
        svg.append(svgElement("line", {x1: zone.x + offset, y1: zone.y + 9, x2: zone.x + offset, y2: zone.y + zone.height - 9, class: "stairs-lines"}));
      }
    }
    if (zone.type === "lift") {
      const cx = zone.x + zone.width / 2;
      const cy = zone.y + zone.height / 2;
      svg.append(svgElement("path", {d: `M${cx} ${cy-13}v26M${cx-5} ${cy-8}l5-5 5 5M${cx-5} ${cy+8}l5 5 5-5`, class: "lift-glyph"}));
    }
  }
  svg.append(svgElement("text", {x: 385, y: 248, class: "map-floor-label", "text-anchor": "end"}, floor.id));
}
