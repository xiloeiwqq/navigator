"use strict";

// HTTP-проверки альтернативного Node.js-сервера на эфемерном порту.
const assert = require("node:assert/strict");
const path = require("node:path");
const {spawn} = require("node:child_process");

const ROOT = __dirname;
const START_TIMEOUT = 10000;
let count = 0;

function check(name, action) {
  action();
  count += 1;
  console.log("PASS", name);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "server.js"), "--host", "127.0.0.1", "--port", "0"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Сервер не запустился за ${START_TIMEOUT} мс. stderr: ${stderr}`));
    }, START_TIMEOUT);

    const onData = chunk => {
      stdout += chunk.toString();
      const match = /NAV_READY (http:\/\/\S+)/.exec(stdout);
      if (!match) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      resolve({child, baseUrl: match[1].replace(/\/$/, ""), stderr: () => stderr});
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", code => {
      if (stdout.includes("NAV_READY")) return;
      clearTimeout(timer);
      reject(new Error(`Сервер завершился с кодом ${code}. stderr: ${stderr}`));
    });
  });
}

function stopServer(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

async function main() {
  const server = await startServer();
  const {child, baseUrl} = server;
  try {
    const get = async (route, expectedType = "application/json") => {
      const response = await fetch(baseUrl + route);
      const body = await response.text();
      assert.equal(response.headers.get("cache-control"), "no-store, no-cache, must-revalidate");
      if (expectedType) assert(response.headers.get("content-type").includes(expectedType));
      assert(body);
      return {response, body};
    };

    const catalogResponse = await get("/api/campuses");
    check("catalog endpoint lists every campus", () => {
      assert.equal(catalogResponse.response.status, 200);
      const catalog = JSON.parse(catalogResponse.body);
      assert.equal(catalog.campuses.length, 14);
      assert.equal(catalog.default_campus_id, "moscow-main");
      assert(catalog.campuses.some(campus => campus.city === "Нижний Новгород"));
      assert.deepEqual(Object.fromEntries(catalog.campuses.filter(campus => campus.city === "Чебоксары")
        .map(campus => [campus.short_name, campus.temporarily_closed])), {"ЦУМ": false, "ДДЮТ": true, "ЧЭМК": false});
    });

    const dataResponse = await get("/api/data?campus_id=kazan-tech");
    check("campus data is isolated by campus_id", () => {
      assert.equal(dataResponse.response.status, 200);
      const data = JSON.parse(dataResponse.body);
      assert.equal(data.campus_id, "kazan-tech");
      assert.equal(data.graph.city, "Казань");
      assert(data.timetable.length > 0);
      assert(data.timetable.every(lesson => lesson.campus_id === "kazan-tech"));
    });

    const healthResponse = await get("/api/health?campus_id=kazan-tech");
    check("health endpoint reports selected campus", () => {
      const health = JSON.parse(healthResponse.body);
      assert.equal(health.status, "ok");
      assert.equal(health.campus_id, "kazan-tech");
      assert.equal(health.campus_count, 14);
    });

    const chemkResponse = await get("/api/data?campus_id=cheboksary-chemk");
    const chemk = JSON.parse(chemkResponse.body);
    check("ЧЭМК отдаёт векторный план без демонстрационного расписания", () => {
      assert.equal(chemkResponse.response.status, 200);
      assert.equal(chemk.graph.demo, false);
      assert.equal(chemk.schedule.source, "none");
      assert.equal(chemk.campuses.find(campus => campus.id === chemk.campus_id).auto_select, false);
      assert.deepEqual(chemk.graph.floors.map(floor => floor.id), ["4"]);
      assert(chemk.graph.floors[0].outline);
      assert.equal(chemk.graph.floors[0].zones.length, 18);
    });

    const templateResponse = await get("/api/data?campus_id=yekaterinburg-campus");
    check("templated campus is expanded in API", () => {
      const data = JSON.parse(templateResponse.body);
      assert.equal(data.graph.city, "Екатеринбург");
      assert.equal(data.graph.timezone, "Asia/Yekaterinburg");
      assert.equal(data.graph.floors.length, 2);
      assert.equal(data.graph.nodes.length, 16);
      assert(data.graph.nodes.some(node => node.id === "coworking" && node.room));
      assert(data.graph.nodes.some(node => node.id === "library" && node.room));
      assert(data.timetable.every(lesson => lesson.campus_id === "yekaterinburg-campus"));
    });

    const timetableResponse = await get(
      "/api/timetable?campus_id=moscow-main&group_id=%D0%98%D0%A1%D0%9F-21&at=2026-11-18T09:45"
    );
    check("timetable links previous room to next room", () => {
      const context = JSON.parse(timetableResponse.body);
      assert.equal(context.lesson.room_id, "lab2");
      assert.equal(context.route_from, "lab1");
      assert.equal(context.route_to, "lab2");
    });

    const unknownCampusResponse = await get("/api/data?campus_id=unknown");
    check("unknown campus returns 400 JSON", () => {
      assert.equal(unknownCampusResponse.response.status, 400);
      const payload = JSON.parse(unknownCampusResponse.body);
      assert.equal(payload.ok, false);
      assert.match(payload.error, /Неизвестный campus_id/);
    });

    const invalidTimeResponse = await get(
      "/api/timetable?campus_id=moscow-main&group_id=%D0%98%D0%A1%D0%9F-21&at=2026-11-18T25:90"
    );
    check("invalid schedule time returns 400 JSON", () => {
      assert.equal(invalidTimeResponse.response.status, 400);
      assert.equal(JSON.parse(invalidTimeResponse.body).ok, false);
    });

    await get("/app.js", "text/javascript");

    const privateResponse = await fetch(baseUrl + "/data/timetable.csv");
    check("raw timetable stays private", () => {
      assert.equal(privateResponse.status, 404);
    });

    const missingResponse = await fetch(baseUrl + "/missing");
    check("unknown route returns 404", () => {
      assert.equal(missingResponse.status, 404);
    });
  } finally {
    await stopServer(child);
    if (server.stderr()) console.error(server.stderr().trim());
  }
  console.log("NODE_SERVER_CHECK_OK", count);
}

main().catch(error => {
  console.error("NODE_SERVER_CHECK_FAILED", error);
  process.exitCode = 1;
});
