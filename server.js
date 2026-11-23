"use strict";

// Альтернативный мультикампусный сервер без внешних зависимостей.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {randomUUID, timingSafeEqual} = require("node:crypto");

const ROOT = __dirname;
const TIMETABLE_FIELDS = ["campus_id", "group_id", "date", "start", "end", "room_id", "title"];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dataDirectory = path.resolve(argument("--data", path.join(ROOT, "data")));

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') { value += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { values.push(value); value = ""; }
    else value += char;
  }
  values.push(value);
  return values;
}

function readTimetable(filename) {
  const lines = fs.readFileSync(path.join(dataDirectory, filename), "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter(line => line.trim());
  if (!lines.length) throw new Error(`Пустой CSV-файл: ${filename}`);

  const headers = parseCsvLine(lines.shift()).map(value => value.trim());
  if (TIMETABLE_FIELDS.some(field => !headers.includes(field))) {
    throw new Error(`Некорректные столбцы расписания: ${filename}`);
  }
  return lines.map(line => {
    const values = parseCsvLine(line);
    return Object.fromEntries(TIMETABLE_FIELDS.map(field => {
      const index = headers.indexOf(field);
      return [field, (values[index] || "").trim()];
    }));
  }).filter(row => TIMETABLE_FIELDS.some(field => row[field]));
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return Boolean(match && Number(match[1]) < 24 && Number(match[2]) < 60);
}

function validateCampus(graph) {
  if (typeof graph.id !== "string" || !SAFE_ID.test(graph.id)) throw new Error("Некорректный ID кампуса");
  for (const field of ["city", "name", "short_name", "timezone"]) {
    if (typeof graph[field] !== "string" || !graph[field].trim()) throw new Error(`У кампуса ${graph.id} не заполнено поле ${field}`);
  }
  const latitude = graph.coordinates?.latitude;
  const longitude = graph.coordinates?.longitude;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new Error(`Некорректная широта кампуса ${graph.id}`);
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error(`Некорректная долгота кампуса ${graph.id}`);

  if (!Array.isArray(graph.floors) || !graph.floors.length) throw new Error(`У кампуса ${graph.id} нет этажей`);
  const floors = new Set(graph.floors.map(floor => floor.id));
  if (floors.has(undefined) || floors.size !== graph.floors.length) throw new Error(`Этажи кампуса ${graph.id} должны иметь уникальные ID`);
  if (!Array.isArray(graph.nodes) || !graph.nodes.length) throw new Error(`У кампуса ${graph.id} нет точек`);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  if (nodes.has(undefined) || nodes.size !== graph.nodes.length) throw new Error(`Повторяющийся ID точки в кампусе ${graph.id}`);

  for (const node of graph.nodes) {
    if (typeof node.id !== "string" || !SAFE_ID.test(node.id) || !floors.has(node.floor) || typeof node.room !== "boolean") {
      throw new Error(`Некорректная точка ${node.id || "без ID"} кампуса ${graph.id}`);
    }
    if ("qr" in node && typeof node.qr !== "boolean") throw new Error(`Некорректный qr у точки ${node.id}`);
    if ("terminal" in node && typeof node.terminal !== "boolean") throw new Error(`Некорректный terminal у точки ${node.id}`);
    if ("standalone" in node && typeof node.standalone !== "boolean") throw new Error(`Некорректный standalone у точки ${node.id}`);
    if ("heading" in node && (!Number.isFinite(node.heading) || node.heading < 0 || node.heading >= 360)) {
      throw new Error(`Некорректный heading у точки ${node.id}`);
    }
    if (!Number.isFinite(node.x) || node.x < 0 || node.x > 440 || !Number.isFinite(node.y) || node.y < 0 || node.y > 290) {
      throw new Error(`Некорректные координаты точки ${node.id}`);
    }
  }

  if (!Array.isArray(graph.edges)) throw new Error(`Некорректные проходы кампуса ${graph.id}`);
  const edgeIds = new Set();
  const neighbors = new Map(graph.nodes.map(node => [node.id, new Set()]));
  for (const edge of graph.edges) {
    if (typeof edge.id !== "string" || !SAFE_ID.test(edge.id) || edgeIds.has(edge.id) || !nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to) {
      throw new Error(`Некорректный проход ${edge.id || "без ID"} кампуса ${graph.id}`);
    }
    if (!Number.isFinite(edge.length_m) || edge.length_m <= 0 || typeof edge.accessible !== "boolean") {
      throw new Error(`Некорректные параметры прохода ${edge.id}`);
    }
    if ("closed" in edge && typeof edge.closed !== "boolean") throw new Error(`Некорректный closed у прохода ${edge.id}`);
    edgeIds.add(edge.id);
    neighbors.get(edge.from).add(edge.to);
    neighbors.get(edge.to).add(edge.from);
  }

  const entrance = graph.entrance_node_id || "entrance";
  if (!nodes.has(entrance)) throw new Error(`Неизвестный главный вход кампуса ${graph.id}`);
  const reached = new Set();
  const pending = [entrance];
  while (pending.length) {
    const current = pending.pop();
    if (reached.has(current)) continue;
    reached.add(current);
    pending.push(...[...neighbors.get(current)].filter(id => !reached.has(id)));
  }
  if (!graph.editor_created) {
    for (const node of nodes.values()) {
      const degree = neighbors.get(node.id).size;
      if (node.standalone && !degree) continue;
      if (!reached.has(node.id)) throw new Error(`Граф кампуса ${graph.id} несвязный`);
      if ((node.qr && !degree) || (!node.room && node.id !== entrance && !node.terminal && degree < 2)) {
        throw new Error(`Висячий или изолированный навигационный узел: ${node.id}`);
      }
    }
  }
}

function validateTimetable(graph, timetable) {
  const rooms = new Set(graph.nodes.filter(node => node.room).map(node => node.id));
  const groups = new Map();
  for (const lesson of timetable) {
    if (lesson.campus_id !== graph.id) throw new Error("Строка расписания попала не в тот кампус");
    if (!lesson.group_id || !rooms.has(lesson.room_id)) throw new Error(`Группа или аудитория кампуса ${graph.id} неизвестна`);
    if (!lesson.title) throw new Error("У занятия должно быть название");
    if (!validDate(lesson.date)) throw new Error("Дата расписания должна быть в формате YYYY-MM-DD");
    if (!validTime(lesson.start) || !validTime(lesson.end) || lesson.end <= lesson.start) throw new Error("Время расписания некорректно");
    const key = `${lesson.group_id}|${lesson.date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(lesson);
  }
  for (const lessons of groups.values()) {
    lessons.sort((a, b) => a.start.localeCompare(b.start));
    for (let index = 1; index < lessons.length; index += 1) {
      if (lessons[index].start < lessons[index - 1].end) throw new Error("Занятия одной группы пересекаются");
    }
  }
}

function materializeCampus(source, templates) {
  const templateId = source.template;
  if (templateId === undefined) return {...source};
  if (typeof templateId !== "string" || !SAFE_ID.test(templateId) || !Object.hasOwn(templates, templateId)) {
    throw new Error(`Неизвестный или некорректный template кампуса ${source.id}`);
  }
  const template = templates[templateId];
  const graph = {...source};
  delete graph.template;
  for (const field of ["floors", "nodes", "edges"]) {
    if (Object.hasOwn(source, field)) throw new Error(`Кампус с template не должен переопределять ${field}`);
    if (!Array.isArray(template[field]) || !template[field].length) throw new Error(`В template ${templateId} отсутствует ${field}`);
    graph[field] = structuredClone(template[field]);
  }
  if (!("entrance_node_id" in graph) && "entrance_node_id" in template) {
    graph.entrance_node_id = template.entrance_node_id;
  }
  return graph;
}

const graphFile = path.join(dataDirectory, "graph.json");

function loadData(catalog = JSON.parse(fs.readFileSync(graphFile, "utf8"))) {
  if (typeof catalog.demo !== "boolean" || !catalog.version || !Array.isArray(catalog.campuses) || !catalog.campuses.length) {
    throw new Error("Некорректный каталог кампусов");
  }
  const templates = catalog.templates ?? {};
  if (!templates || typeof templates !== "object" || Array.isArray(templates)) {
    throw new Error("templates должен быть объектом");
  }
  const campusIds = catalog.campuses.map(campus => campus.id);
  if (new Set(campusIds).size !== campusIds.length || !campusIds.includes(catalog.default_campus_id)) {
    throw new Error("Некорректные ID кампусов или default_campus_id");
  }

  const realRows = readTimetable("timetable.csv");
  const demoRows = readTimetable("timetable.demo.csv");
  const unknown = [...new Set([...realRows, ...demoRows].map(row => row.campus_id).filter(id => !campusIds.includes(id)))];
  if (unknown.length) throw new Error(`Расписание содержит неизвестные кампусы: ${unknown.join(", ")}`);

  const campusData = Object.create(null);
  const campuses = [];
  for (const source of catalog.campuses) {
    const graph = materializeCampus(source, templates);
    graph.version = catalog.version;
    graph.demo = Boolean(catalog.demo || source.demo);
    validateCampus(graph);
    const campusReal = realRows.filter(row => row.campus_id === graph.id);
    const campusDemo = demoRows.filter(row => row.campus_id === graph.id);
    const timetable = campusReal.length ? campusReal : campusDemo;
    if (!timetable.length && !graph.editor_created) throw new Error(`Расписание кампуса ${graph.id} пусто`);
    const schedule = campusReal.length
      ? {source: "real", filename: "timetable.csv", demo: false}
      : campusDemo.length
        ? {source: "demo", filename: "timetable.demo.csv", demo: true}
        : {source: "none", filename: null, demo: false};
    validateTimetable(graph, timetable);
    campusData[graph.id] = {graph, timetable, schedule};
    campuses.push({
      id: graph.id,
      city: graph.city,
      name: graph.name,
      short_name: graph.short_name,
      timezone: graph.timezone,
      coordinates: graph.coordinates,
      floor_count: graph.floors.length
    });
  }
  return {version: catalog.version, demo: catalog.demo, default_campus_id: catalog.default_campus_id, campuses, campus_data: campusData};
}

function editorLabel(value, limit = 160) {
  return typeof value === "string" && value.length <= limit && Boolean(value.trim());
}

function editorCampus(draft, existing) {
  const campus = {...existing};
  if (!existing) campus.editor_created = true;
  for (const key of ["id", "city", "name", "short_name", "timezone", "coordinates"]) {
    campus[key] = draft[key];
  }
  campus.entrance_node_id = Object.hasOwn(draft, "entrance_node_id")
    ? draft.entrance_node_id : existing?.entrance_node_id ?? "entrance";
  for (const key of ["city", "name", "short_name", "timezone"]) {
    if (!editorLabel(campus[key], 120)) throw new Error(`Некорректное поле ${key}`);
  }
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  for (const [key, limit] of [["floors", 24], ["nodes", 800], ["edges", 1600]]) {
    if (!Array.isArray(draft[key]) || draft[key].length > limit || !draft[key].every(object)) {
      throw new Error(`Некорректный список ${key}`);
    }
    campus[key] = draft[key];
  }
  const originalFloors = new Map(existing?.floors.map(floor => [floor.id, floor]));
  campus.floors = campus.floors.map(({id, label, image}) => {
    if (typeof id !== "string" || !SAFE_ID.test(id) || !editorLabel(label)) throw new Error("У каждого этажа должны быть ID и название");
    const floor = {...(originalFloors.get(id) || {zones: []}), id, label};
    delete floor.image;
    if (image != null) {
      const prefix = "data:image/jpeg;base64,";
      if (typeof image !== "string" || image.length > 1_600_000 || !image.startsWith(prefix)) {
        throw new Error("Некорректная или слишком большая схема этажа");
      }
      const encoded = image.slice(prefix.length);
      const binary = Buffer.from(encoded, "base64");
      if (binary.toString("base64") !== encoded || binary.subarray(0, 3).toString("hex") !== "ffd8ff" ||
          binary.subarray(-2).toString("hex") !== "ffd9") {
        throw new Error("Схема этажа должна быть изображением JPEG");
      }
      floor.image = image;
    }
    if (!floor.zones?.length && !floor.image) throw new Error("Загрузите схему для каждого этажа");
    return floor;
  });
  const floors = new Set(campus.floors.map(floor => floor.id));
  if (!campus.nodes.every(node => editorLabel(node.label))) throw new Error("У каждой точки должно быть название");
  for (const edge of campus.edges) {
    if (!editorLabel(edge.name) || !["corridor", "stairs", "lift"].includes(edge.kind)) {
      throw new Error("У каждого прохода должны быть название и тип");
    }
    for (const key of ["path", "instructions"]) {
      if (Object.hasOwn(edge, key) && !object(edge[key])) throw new Error("Некорректная геометрия или инструкция прохода");
    }
    for (const [floor, points] of Object.entries(edge.path || {})) {
      if (!floors.has(floor) || !Array.isArray(points) || points.length < 2 || points.length > 200 ||
          points.some(point => !Array.isArray(point) || point.length !== 2 ||
            point.some((value, axis) => !Number.isFinite(value) || value < 0 || value > [440, 290][axis]))) {
        throw new Error("Некорректная линия прохода");
      }
    }
    if (!Object.values(edge.instructions || {}).every(value => editorLabel(value, 500))) {
      throw new Error("Некорректная инструкция прохода");
    }
  }
  return campus;
}

function publishCampus({campus: draft, version, creating}) {
  const original = fs.readFileSync(graphFile, "utf8");
  const catalog = JSON.parse(original);
  if (version !== catalog.version) return null;
  if (!draft || typeof draft !== "object" || typeof creating !== "boolean") throw new Error("Некорректные данные кампуса");
  const index = catalog.campuses.findIndex(campus => campus.id === draft.id);
  if (creating !== (index === -1)) throw new Error("ID нового кампуса уже занят или редактируемый кампус удалён");
  const existing = creating ? undefined : materializeCampus(catalog.campuses[index], catalog.templates || {});
  const campus = editorCampus(draft, existing);
  catalog.campuses[creating ? catalog.campuses.length : index] = campus;
  catalog.version = `editor-${randomUUID()}`;
  loadData(catalog);
  const temporary = path.join(dataDirectory, `.graph-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(catalog, null, 2) + "\n", {encoding: "utf8", flag: "wx"});
    if (fs.readFileSync(graphFile, "utf8") !== original) return null;
    fs.renameSync(temporary, graphFile);
  } finally {
    fs.rmSync(temporary, {force: true});
  }
  return catalog.version;
}

function selectedCampus(data, campusId) {
  const selectedId = campusId || data.default_campus_id;
  const record = data.campus_data[selectedId];
  if (!record) throw new Error(`Неизвестный campus_id: ${selectedId}`);
  return [selectedId, record];
}

function campusPayload(data, campusId) {
  const [selectedId, record] = selectedCampus(data, campusId);
  return {
    campus_id: selectedId,
    default_campus_id: data.default_campus_id,
    campuses: data.campuses,
    graph: record.graph,
    timetable: record.timetable,
    schedule: record.schedule
  };
}

function scheduleContext(timetable, groupId, at) {
  const [date = "", time = ""] = String(at || "").split("T");
  if (!groupId || !validDate(date) || !validTime(time)) throw new Error("Нужны group_id и at в формате YYYY-MM-DDTHH:MM");
  const lessons = timetable
    .filter(lesson => lesson.group_id === groupId)
    .sort((a, b) => `${a.date}T${a.start}`.localeCompare(`${b.date}T${b.start}`));
  const current = lessons.find(lesson => `${lesson.date}T${lesson.start}` <= at && at < `${lesson.date}T${lesson.end}`) || null;
  const next = lessons.find(lesson => `${lesson.date}T${lesson.start}` > at) || null;
  const previous = lessons.filter(lesson => `${lesson.date}T${lesson.end}` <= at).at(-1) || null;
  const previousOnSameDay = previous && next && previous.date === next.date ? previous : null;
  return {
    current,
    next,
    previous,
    lesson: current || next,
    route_from: (current || previousOnSameDay)?.room_id || null,
    route_to: next?.room_id || null
  };
}

function healthPayload(data, campusId) {
  const [selectedId, record] = selectedCampus(data, campusId);
  const demo = record.graph.demo || record.schedule.demo;
  return {
    ok: true,
    status: "ok",
    version: record.graph.version,
    graph_version: record.graph.version,
    mode: demo ? "DEMO" : "Production",
    demo,
    graph_demo: record.graph.demo,
    schedule_source: record.schedule.source,
    schedule_demo: record.schedule.demo,
    schedule_filename: record.schedule.filename,
    campus_id: selectedId,
    campus_count: data.campuses.length
  };
}

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/route.js", ["route.js", "text/javascript; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/editor", ["editor.html", "text/html; charset=utf-8"]],
  ["/editor.js", ["editor.js", "text/javascript; charset=utf-8"]],
  ["/map-plan.js", ["map-plan.js", "text/javascript; charset=utf-8"]],
  ["/vendor/jsQR.js", ["vendor/jsQR.js", "text/javascript; charset=utf-8"]]
]);

function send(response, status, body, contentType) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

const host = argument("--host", "0.0.0.0");
const port = Number(argument("--port", "8080"));
const editorPassword = Buffer.from(process.env.NAVIGATOR_EDITOR_PASSWORD ?? "dattebayo");
const maxEditorRequest = 16 * 1024 * 1024;

function sendJson(response, status, payload) {
  send(response, status, Buffer.from(JSON.stringify(payload)), "application/json; charset=utf-8");
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;
  try {
    if (request.method === "POST" && ["/api/editor/login", "/api/editor/publish"].includes(pathname)) {
      const supplied = Buffer.from(decodeURIComponent(request.headers["x-editor-password"] || ""));
      if (!editorPassword.length || supplied.length !== editorPassword.length || !timingSafeEqual(supplied, editorPassword)) {
        sendJson(response, 401, {error: "Неверный пароль редактора"});
        return;
      }
      if (pathname === "/api/editor/login") {
        sendJson(response, 200, {ok: true});
        return;
      }
      if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
        sendJson(response, 415, {error: "Ожидаются данные JSON"});
        return;
      }
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > maxEditorRequest) {
          sendJson(response, 413, {error: "Слишком большой запрос"});
          return;
        }
        chunks.push(chunk);
      }
      const version = publishCampus(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (version === null) {
        sendJson(response, 409, {error: "Каталог обновился. Загрузите свежие данные перед публикацией."});
        return;
      }
      sendJson(response, 200, {version});
      return;
    }
    if (pathname.startsWith("/api/")) {
      const data = loadData();
      const campusId = requestUrl.searchParams.get("campus_id") || undefined;
      let payload;
      if (pathname === "/api/campuses") {
        payload = {version: data.version, demo: data.demo, default_campus_id: data.default_campus_id, campuses: data.campuses};
      } else if (pathname === "/api/data") {
        payload = campusPayload(data, campusId);
      } else if (pathname === "/api/health") {
        payload = healthPayload(data, campusId);
      } else if (pathname === "/api/timetable") {
        const [selectedId, record] = selectedCampus(data, campusId);
        const groupId = requestUrl.searchParams.get("group_id") || "";
        const at = requestUrl.searchParams.get("at") || "";
        payload = {
          ...scheduleContext(record.timetable, groupId, at),
          group_id: groupId,
          campus_id: selectedId,
          at,
          version: record.graph.version,
          schedule_source: record.schedule.source,
          schedule_demo: record.schedule.demo
        };
      } else {
        send(response, 404, Buffer.from("Not found"), "text/plain; charset=utf-8");
        return;
      }
      send(response, 200, Buffer.from(JSON.stringify(payload)), "application/json; charset=utf-8");
      return;
    }

    if (assets.has(pathname)) {
      const [filename, contentType] = assets.get(pathname);
      send(response, 200, fs.readFileSync(path.join(ROOT, filename)), contentType);
      return;
    }
    send(response, 404, Buffer.from("Not found"), "text/plain; charset=utf-8");
  } catch (error) {
    send(response, 400, Buffer.from(JSON.stringify({ok: false, status: "error", error: error.message})), "application/json; charset=utf-8");
  }
});

server.listen(port, host, () => {
  const data = loadData();
  const actualPort = server.address().port;
  console.log(`NAV_READY http://${host}:${actualPort}/ version=${data.version} campuses=${data.campuses.length}`);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) console.log(`NETWORK_URL http://${address.address}:${actualPort}/`);
    }
  }
});
