"use strict";

const field = id => document.getElementById(id);
const map = field("editor-map");
const workspace = field("editor-workspace");
const content = field("editor-content");
const campusPicker = field("editor-campus");
const floorPicker = field("editor-floor");
const nodePicker = field("editor-node");
const campusFields = {
  "campus-id": "id",
  "campus-name": "name",
  "campus-short": "short_name",
  "campus-city": "city",
  "campus-timezone": "timezone"
};
let catalog;
let graph;
let editingId = "";
let floorId = "";
let selectedId = "";
let moving = false;
let dirty = false;

function status(message = "", error = false) {
  const element = field("editor-status");
  element.textContent = message;
  element.classList.toggle("editor-status--error", error);
}

async function request(path, options) {
  const response = await navigatorFetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Ошибка сервера (${response.status})`);
  return payload;
}

function fillSelect(select, items, current, placeholder) {
  select.replaceChildren();
  if (placeholder) select.add(new Option(placeholder, ""));
  for (const [id, label] of items) select.add(new Option(label, id));
  if (Array.from(select.options).some(option => option.value === current)) select.value = current;
}

function navigationLink(campusId, nodeId) {
  const query = new URLSearchParams({campus_id: campusId});
  if (nodeId) query.set("start_node", nodeId);
  return `./?${query}`;
}

function selectedFloor() {
  return graph.floors.find(floor => floor.id === floorId);
}

function selectedNode() {
  return graph.nodes.find(node => node.id === selectedId);
}

function renderCampusPicker() {
  const campuses = [...catalog.campuses].sort((a, b) => a.city.localeCompare(b.city, "ru"));
  fillSelect(campusPicker, campuses.map(campus => [campus.id, `${campus.city} — ${campus.name}`]), editingId, "Новый кампус");
}

async function openCampus(id) {
  content.disabled = true;
  try {
    if (id) {
      const payload = await request(`/api/data?${new URLSearchParams({campus_id: id})}`);
      graph = payload.graph;
      catalog.campuses = payload.campuses;
      catalog.version = graph.version;
    } else {
      catalog = await request("/api/campuses");
      graph = {
        id: "", name: "", short_name: "", city: "", timezone: "Europe/Moscow",
        coordinates: {latitude: null, longitude: null},
        floors: [{id: "1", label: "1 этаж", zones: []}], nodes: [], edges: []
      };
    }
      editingId = id;
    floorId = graph.floors[0].id;
    selectedId = "";
    moving = false;
    dirty = false;
    field("editor-info").open = !id;
    for (const [inputId, key] of Object.entries(campusFields)) field(inputId).value = graph[key];
    field("campus-id").readOnly = Boolean(id);
    field("campus-latitude").value = graph.coordinates.latitude ?? "";
    field("campus-longitude").value = graph.coordinates.longitude ?? "";
    field("editor-image").value = "";
    field("editor-edge-length").value = "";
    renderCampusPicker();
    renderFloor();
    status();
  } finally {
    content.disabled = false;
  }
}

function edgePlan(edge, nodes) {
  if (edge.path && Object.hasOwn(edge.path, floorId)) return edge.path[floorId];
  const from = nodes.get(edge.from);
  const to = nodes.get(edge.to);
  if (from.floor === floorId && to.floor === floorId) return [[from.x, from.y], [to.x, to.y]];
  return null;
}

function renderMap() {
  const floor = selectedFloor();
  const node = selectedNode();
  const hasPlan = Boolean(floor.image || floor.zones?.length);
  const hint = field("editor-map-hint");
  hint.textContent = !hasPlan ? "Загрузите PNG, JPEG или WebP, чтобы начать расстановку точек."
    : moving ? "Нажмите на новое место выбранной точки."
    : "Нажмите на план, чтобы поставить контрольную точку.";
  field("editor-add-point").disabled = !hasPlan;
  map.classList.toggle("editor-map--ready", hasPlan);
  map.replaceChildren();
  if (!hasPlan) {
    map.append(svgElement("text", {x: 220, y: 150, class: "editor-map-empty"}, "Загрузите схему этажа"));
    return;
  }
  drawPlan(map, floor);
  const nodes = new Map(graph.nodes.map(item => [item.id, item]));
  for (const edge of graph.edges) {
    const points = edgePlan(edge, nodes);
    if (points) map.append(svgElement("polyline", {points: points.map(point => point.join(",")).join(" "), class: "editor-edge-line"}));
  }
  for (const item of graph.nodes.filter(item => item.floor === floorId)) {
    const marker = svgElement("g", {
      class: `editor-marker${node === item ? " editor-marker--selected" : ""}`,
      "aria-label": item.label, role: "button", tabindex: 0
    });
    marker.append(svgElement("title", {}, item.label));
    marker.append(svgElement("circle", {cx: item.x, cy: item.y, r: item.qr ? 6 : 4}));
    if (node === item) {
      const x = Math.min(425, Math.max(15, item.x));
      marker.append(svgElement("text", {
        x, y: item.y < 18 ? item.y + 17 : item.y - 10,
        "text-anchor": x < 100 ? "start" : x > 340 ? "end" : "middle"
      }, item.label));
    }
    const select = () => {
      selectedId = item.id;
      moving = false;
      renderFloor({focusPoint: true});
    };
    marker.addEventListener("click", event => {
      if (moving) return;
      event.stopPropagation();
      select();
    });
    marker.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select();
      }
    });
    map.append(marker);
  }
}

function renderFloor({focusPoint = false} = {}) {
  const floor = selectedFloor();
  fillSelect(floorPicker, graph.floors.map(({id, label}) => [id, label]), floorId);
  field("editor-floor-name").value = floor.label;
  const floorNodes = graph.nodes.filter(node => node.floor === floorId);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  field("editor-remove-floor").disabled = graph.floors.length < 2 || floorNodes.length > 0;
  field("editor-add-floor").disabled = graph.floors.length >= 24;
  fillSelect(nodePicker, floorNodes.map(({id, label}) => [id, label]), selectedId, "Выберите точку");
  const node = selectedNode();
  field("editor-node-fields").hidden = !node;
  if (node) {
    field("editor-node-name").value = node.label;
    field("editor-node-qr").checked = Boolean(node.qr);
    field("editor-node-room").checked = node.room;
    field("editor-node-heading").value = node.heading ?? "";
    const entrance = (graph.entrance_node_id || "entrance") === node.id;
    field("editor-set-entrance").disabled = entrance;
    field("editor-set-entrance").textContent = entrance ? "Главный вход" : "Сделать входом";
    field("editor-move-node").setAttribute("aria-pressed", String(moving));
    if (focusPoint) nodePicker.focus();
  }
  const preview = field("editor-preview");
  preview.hidden = !editingId;
  if (editingId) preview.href = navigationLink(editingId);
  const nodeLink = field("editor-node-link");
  nodeLink.hidden = !editingId || !node?.qr || dirty;
  if (!nodeLink.hidden) nodeLink.href = navigationLink(editingId, node.id);

  const nodeOption = item => [item.id, `${item.label} · ${graph.floors.find(floor => floor.id === item.floor).label}`];
  const from = field("editor-edge-from");
  const to = field("editor-edge-to");
  fillSelect(from, floorNodes.map(nodeOption), from.value || selectedId, "Выберите начало");
  fillSelect(to, graph.nodes.map(nodeOption), to.value, "Выберите конец");
  const edges = field("editor-edge");
  const floorEdges = graph.edges.filter(edge => nodes.get(edge.from).floor === floorId || nodes.get(edge.to).floor === floorId);
  fillSelect(edges, floorEdges.map(({id, name}) => [id, name]), edges.value, "Выберите проход");
  field("editor-remove-edge").disabled = !floorEdges.length;
  field("editor-add-edge").disabled = !floorNodes.length || graph.nodes.length < 2;
  renderMap();
}

function markDirty() {
  dirty = true;
  field("editor-node-link").hidden = true;
  field("editor-submission").hidden = true;
  status();
}

function newId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return prefix + Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function addPoint(x, y, {focusName = false} = {}) {
  if (graph.nodes.length >= 800) {
    status("В кампусе достигнут лимит в 800 точек.", true);
    return;
  }
  const id = newId("point-");
  const existingEntrance = graph.nodes.find(node => node.id === (graph.entrance_node_id || "entrance"));
  graph.nodes.push({
    id, floor: floorId, x, y, label: existingEntrance ? `Точка ${graph.nodes.length + 1}` : "Вход",
    qr: true, room: false, terminal: true, standalone: true
  });
  if (!existingEntrance) graph.entrance_node_id = id;
  selectedId = id;
  moving = false;
  markDirty();
  renderFloor();
  if (focusName) {
    field("editor-node-name").focus();
    field("editor-node-name").select();
  }
}

function movePoint(x, y) {
  const node = selectedNode();
  for (const edge of graph.edges) {
    if (edge.from !== node.id && edge.to !== node.id) continue;
    const points = edge.path && Object.hasOwn(edge.path, floorId) ? edge.path[floorId] : null;
    if (!points) continue;
    for (const index of [0, points.length - 1]) {
      if (points[index][0] === node.x && points[index][1] === node.y) points[index] = [x, y];
    }
  }
  Object.assign(node, {x, y});
  moving = false;
  markDirty();
  renderFloor();
}

async function imageForPlan(file) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 20 * 1024 * 1024) {
    throw new Error("Выберите PNG, JPEG или WebP размером до 20 МБ.");
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 1760;
    canvas.height = 1160;
    const context = canvas.getContext("2d");
    const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    const plan = canvas.toDataURL("image/jpeg", 0.86);
    if (plan.length > 1_600_000) throw new Error("Схема получилась слишком большой. Выберите изображение меньшего размера.");
    return plan;
  } finally {
    URL.revokeObjectURL(url);
  }
}

openCampus("").then(() => {
  workspace.hidden = false;
}).catch(error => status(error.message, true));

workspace.addEventListener("input", event => {
  if (Object.hasOwn(campusFields, event.target.id) || ["campus-latitude", "campus-longitude"].includes(event.target.id)) markDirty();
});

floorPicker.addEventListener("change", () => {
  floorId = floorPicker.value;
  selectedId = "";
  moving = false;
  renderFloor();
});

field("editor-add-floor").addEventListener("click", () => {
  let number = 1;
  while (graph.floors.some(floor => floor.label === `${number} этаж`)) number++;
  floorId = newId("floor-");
  graph.floors.push({id: floorId, label: `${number} этаж`, zones: []});
  selectedId = "";
  moving = false;
  markDirty();
  renderFloor();
});

field("editor-remove-floor").addEventListener("click", () => {
  graph.floors = graph.floors.filter(floor => floor.id !== floorId);
  for (const edge of graph.edges) {
    if (edge.path) delete edge.path[floorId];
  }
  floorId = graph.floors[0].id;
  markDirty();
  renderFloor();
});

field("editor-floor-name").addEventListener("change", event => {
  selectedFloor().label = event.target.value.trim() || selectedFloor().label;
  markDirty();
  renderFloor();
});

field("editor-image").addEventListener("change", async event => {
  const [file] = event.target.files;
  event.target.value = "";
  if (!file) return;
  content.disabled = true;
  try {
    selectedFloor().image = await imageForPlan(file);
    markDirty();
    renderFloor();
  } catch (error) {
    status(error.message, true);
  } finally {
    content.disabled = false;
  }
});

map.addEventListener("click", event => {
  if (!map.classList.contains("editor-map--ready") || content.disabled) return;
  const matrix = map.getScreenCTM();
  if (!matrix) return;
  const {x, y} = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  const clamp = (value, max) => Math.min(max, Math.max(0, Math.round(value * 10) / 10));
  const point = [clamp(x, 440), clamp(y, 290)];
  if (moving) movePoint(...point);
  else addPoint(...point);
});

field("editor-add-point").addEventListener("click", () => addPoint(220, 145, {focusName: true}));

nodePicker.addEventListener("change", () => {
  selectedId = nodePicker.value;
  moving = false;
  renderFloor();
});

const nodeName = field("editor-node-name");
nodeName.addEventListener("input", () => {
  const name = nodeName.value.trim();
  if (!name) return;
  const node = selectedNode();
  node.label = name;
  for (const [select, label] of [
    [nodePicker, name],
    [field("editor-edge-from"), `${name} · ${selectedFloor().label}`],
    [field("editor-edge-to"), `${name} · ${selectedFloor().label}`]
  ]) {
    const option = Array.from(select.options).find(item => item.value === node.id);
    if (option) option.text = label;
  }
  markDirty();
  renderMap();
});
nodeName.addEventListener("change", () => { nodeName.value = selectedNode().label; });

for (const [inputId, key] of [["editor-node-qr", "qr"], ["editor-node-room", "room"], ["editor-node-heading", "heading"]]) {
  field(inputId).addEventListener("change", event => {
    const node = selectedNode();
    const input = event.target;
    if (!input.checkValidity()) {
      input.reportValidity();
      return;
    }
    if (input.type === "checkbox") node[key] = input.checked;
    else {
      if (input.value) node.heading = input.valueAsNumber;
      else delete node.heading;
    }
    markDirty();
    renderFloor();
  });
}

field("editor-move-node").addEventListener("click", () => {
  moving = !moving;
  renderFloor();
});

field("editor-set-entrance").addEventListener("click", () => {
  graph.entrance_node_id = selectedId;
  markDirty();
  renderFloor();
});

field("editor-remove-node").addEventListener("click", () => {
  graph.nodes = graph.nodes.filter(node => node.id !== selectedId);
  graph.edges = graph.edges.filter(edge => edge.from !== selectedId && edge.to !== selectedId);
  if (selectedId === (graph.entrance_node_id || "entrance")) graph.entrance_node_id = graph.nodes[0]?.id;
  selectedId = "";
  moving = false;
  markDirty();
  renderFloor();
});

field("editor-edge-kind").addEventListener("change", ({target}) => {
  field("editor-edge-accessible").checked = target.value !== "stairs";
});

field("editor-add-edge").addEventListener("click", () => {
  const from = graph.nodes.find(node => node.id === field("editor-edge-from").value);
  const to = graph.nodes.find(node => node.id === field("editor-edge-to").value);
  const length = field("editor-edge-length");
  const kind = field("editor-edge-kind").value;
  if (!from || !to || from === to || !length.value || !length.checkValidity()) {
    status("Выберите две разные точки и укажите длину прохода в метрах.", true);
    return;
  }
  if (from.floor !== to.floor && kind === "corridor") {
    status("Для перехода между этажами выберите лестницу или лифт.", true);
    return;
  }
  if (graph.edges.some(edge => (edge.from === from.id && edge.to === to.id) || (edge.from === to.id && edge.to === from.id))) {
    status("Эти точки уже соединены.", true);
    return;
  }
  const id = newId("edge-");
  graph.edges.push({
    id, name: `${from.label} — ${to.label}`.slice(0, 160), from: from.id, to: to.id,
    length_m: length.valueAsNumber, kind, accessible: field("editor-edge-accessible").checked
  });
  markDirty();
  renderFloor();
  field("editor-edge").value = id;
});

field("editor-remove-edge").addEventListener("click", () => {
  const id = field("editor-edge").value;
  if (!id) return;
  graph.edges = graph.edges.filter(edge => edge.id !== id);
  markDirty();
  renderFloor();
});

workspace.noValidate = true;
workspace.addEventListener("submit", async event => {
  event.preventDefault();
  if (content.disabled) return;
  try {
    for (const [inputId, key] of Object.entries(campusFields)) {
      const input = field(inputId);
      input.value = input.value.trim();
      if (!input.checkValidity()) {
        field("editor-info").open = true;
        input.reportValidity();
        return;
      }
      graph[key] = input.value;
    }
    const latitude = field("campus-latitude");
    const longitude = field("campus-longitude");
    for (const input of [latitude, longitude]) {
      if (!input.checkValidity()) {
        field("editor-info").open = true;
        input.reportValidity();
        return;
      }
    }
    const heading = field("editor-node-heading");
    if (selectedNode() && !heading.checkValidity()) {
      heading.reportValidity();
      return;
    }
    try {
      new Intl.DateTimeFormat("ru", {timeZone: graph.timezone});
    } catch {
      field("editor-info").open = true;
      field("campus-timezone").focus();
      throw new Error("Укажите часовой пояс в формате Europe/Moscow.");
    }
    if (!graph.nodes.length) throw new Error("Поставьте хотя бы одну точку на плане.");
    graph.coordinates = {latitude: latitude.valueAsNumber, longitude: longitude.valueAsNumber};
    const campus = {...graph, short_name: graph.short_name || graph.name, entrance_node_id: graph.entrance_node_id || "entrance"};
    if (["index", "campuses"].includes(campus.id) || catalog.campuses.some(item => item.id === campus.id)) {
      throw new Error("Этот ID кампуса уже используется. Выберите другой ID.");
    }
    const missingPlan = campus.floors.find(floor => !floor.image);
    if (missingPlan) throw new Error(`Загрузите схему для этажа «${missingPlan.label}».`);
    const file = new Blob([JSON.stringify({format: "navigator-campus-v1", campus})], {type: "application/json"});
    if (file.size > 16 * 1024 * 1024) throw new Error("Файл кампуса превышает 16 МБ. Уменьшите размер схем.");
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(file);
    anchor.download = `navigator-campus-${campus.id}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 60000);

    const issue = new URL("https://github.com/xiloeiwqq/navigator/issues/new");
    issue.searchParams.set("title", `[Кампус] ${campus.city} — ${campus.name}`);
    issue.searchParams.set("body", "Прикрепите скачанный файл кампуса и нажмите Create. Результат проверки появится в этой заявке.\n\n");
    field("editor-github-submit").href = issue.href;
    field("editor-submission").hidden = false;
    dirty = false;
    status("Файл скачан. Откройте заявку на GitHub, прикрепите файл и отправьте её.");
  } catch (error) {
    status(error.message, true);
  } finally {
    content.disabled = false;
  }
});

window.addEventListener("beforeunload", event => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
