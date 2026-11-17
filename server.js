"use strict";

// Сервер без зависимостей для быстрого запуска, если Python не установлен.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ROOT = __dirname;
const TIMETABLE_FIELDS = ["group_id", "date", "start", "end", "room_id", "title"];

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

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
  const lines = fs.readFileSync(path.join(ROOT, "data", filename), "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter(line => line.trim());
  if (!lines.length) throw new Error(`Пустой CSV-файл: ${filename}`);

  const headers = parseCsvLine(lines.shift());
  if (TIMETABLE_FIELDS.some(field => !headers.includes(field))) {
    throw new Error(`Некорректные столбцы расписания: ${filename}`);
  }
  return lines.map(line => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  }).filter(row => TIMETABLE_FIELDS.some(field => row[field].trim()));
}

function validTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return Boolean(match && Number(match[1]) < 24 && Number(match[2]) < 60);
}

function validateTimetable(graph, timetable) {
  const rooms = new Set(graph.nodes.filter(node => node.room).map(node => node.id));
  for (const lesson of timetable) {
    if (!lesson.group_id || !rooms.has(lesson.room_id)) throw new Error("Группа или аудитория расписания неизвестна");
    if (!lesson.title) throw new Error("У занятия должно быть название");
    const date = new Date(`${lesson.date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(lesson.date) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== lesson.date) {
      throw new Error("Дата расписания должна быть в формате YYYY-MM-DD");
    }
    if (!validTime(lesson.start) || !validTime(lesson.end) || lesson.end <= lesson.start) {
      throw new Error("Время расписания некорректно");
    }
  }
}

function loadData() {
  const graph = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "graph.json"), "utf8"));
  const realTimetable = readTimetable("timetable.csv");
  const timetable = realTimetable.length ? realTimetable : readTimetable("timetable.demo.csv");
  if (!timetable.length) throw new Error("Расписание пусто: заполните timetable.csv или timetable.demo.csv");
  const schedule = realTimetable.length
    ? {source: "real", filename: "timetable.csv", demo: false}
    : {source: "demo", filename: "timetable.demo.csv", demo: true};
  validateTimetable(graph, timetable);
  return {graph, timetable, schedule};
}

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/route.js", ["route.js", "text/javascript; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/vendor/jsQR.js", ["vendor/jsQR.js", "text/javascript; charset=utf-8"]]
]);

const host = argument("--host", "0.0.0.0");
const port = Number(argument("--port", "8080"));

function nextLesson(timetable, groupId, at) {
  if (!groupId || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at)) throw new Error("Нужны group_id и at в формате YYYY-MM-DDTHH:MM");
  return timetable
    .filter(lesson => lesson.group_id === groupId && `${lesson.date}T${lesson.end}` > at)
    .sort((a, b) => `${a.date}T${a.start}`.localeCompare(`${b.date}T${b.start}`))[0] || null;
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;
  let body;
  let contentType;

  try {
    if (pathname === "/api/data") {
      body = Buffer.from(JSON.stringify(loadData()));
      contentType = "application/json; charset=utf-8";
    } else if (pathname === "/api/health") {
      const data = loadData();
      const demo = data.graph.demo || data.schedule.demo;
      const mode = demo ? "DEMO" : "Production";
      body = Buffer.from(JSON.stringify({
        ok: true,
        status: "ok",
        version: data.graph.version,
        graph_version: data.graph.version,
        mode,
        demo,
        graph_demo: data.graph.demo,
        schedule_source: data.schedule.source,
        schedule_demo: data.schedule.demo,
        schedule_filename: data.schedule.filename
      }));
      contentType = "application/json; charset=utf-8";
    } else if (pathname === "/api/timetable") {
      const data = loadData();
      const groupId = requestUrl.searchParams.get("group_id") || "";
      const at = requestUrl.searchParams.get("at") || "";
      body = Buffer.from(JSON.stringify({
        lesson: nextLesson(data.timetable, groupId, at),
        group_id: groupId,
        at,
        version: data.graph.version,
        schedule_source: data.schedule.source,
        schedule_demo: data.schedule.demo
      }));
      contentType = "application/json; charset=utf-8";
    } else if (assets.has(pathname)) {
      const [filename, type] = assets.get(pathname);
      body = fs.readFileSync(path.join(ROOT, filename));
      contentType = type;
    } else {
      response.writeHead(404, {"Content-Type": "text/plain; charset=utf-8"});
      response.end("Not found");
      return;
    }
  } catch (error) {
    body = Buffer.from(JSON.stringify({ok: false, status: "error", error: error.message}));
    response.writeHead(400, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store, no-cache, must-revalidate"
    });
    response.end(body);
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
});

server.listen(port, host, () => {
  const data = loadData();
  console.log(`NAV_READY http://${host}:${port}/ version=${data.graph.version} schedule=${data.schedule.source}`);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) console.log(`NETWORK_URL http://${address.address}:${port}/`);
    }
  }
});
