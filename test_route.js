"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const {route, scheduleContext, nextLesson, nearestCampus, routePosition} = require("./route.js");
const catalog = JSON.parse(fs.readFileSync(__dirname + "/data/graph.json", "utf8"));
const graph = catalog.campuses.find(campus => campus.id === catalog.default_campus_id);
let count = 0;

function check(name, action) {
  action();
  count += 1;
  console.log("PASS", name);
}

check("same node", () => assert.deepEqual(route(graph, "lab1", "lab1"), {nodes: ["lab1"], edges: [], length_m: 0}));
check("every room is reachable from the entrance", () => {
  for (const room of graph.nodes.filter(node => node.room)) {
    const result = route(graph, "entrance", room.id);
    assert(result && result.length_m > 0, `нет маршрута к ${room.id}`);
    assert(result.nodes.at(-1) === room.id, `маршрут не заканчивается в ${room.id}`);
  }
  assert(route(graph, "entrance", "coworking1").edges.includes("hall1-coworking1"));
  assert(route(graph, "hall1", "wc1").edges.includes("lift1-wc1"));
});
check("entry to A-101 is 14m", () => assert.equal(route(graph, "entrance", "lab1").length_m, 14));
check("ЧЭМК: обе лестницы соединены со всеми опубликованными точками 4-го этажа", () => {
  const chemk = catalog.campuses.find(campus => campus.id === "cheboksary-chemk");
  assert.deepEqual(chemk.floors.map(floor => floor.id), ["4"]);
  assert.equal(chemk.entrance_node_id, "stairs-1");
  for (const start of ["stairs-1", "stairs-6"]) {
    for (const target of chemk.nodes.filter(node => node.room && node.id !== start)) {
      assert(route(chemk, start, target.id), `нет маршрута из ${start} в ${target.id}`);
    }
  }
  const corridor = chemk.nodes.filter(node => node.waypoint);
  assert(corridor.every(node => node.y === corridor[0].y));
  assert.equal(route(chemk, "stairs-1", "psychologist", [], true), null);
});
check("stairs to A-201 is 25m", () => {
  const result = route(graph, "entrance", "lab2");
  assert.equal(result.length_m, 25);
  assert(result.edges.includes("stairs-between-floors"));
});
check("ЦУМ: все зоны доступны по лестнице в обе стороны", () => {
  const tsum = catalog.campuses.find(campus => campus.id === "cheboksary-campus");
  assert.equal(tsum.entrance_node_id, "stairs-4");
  assert.equal(tsum.start_at_entrance, true);
  const zones = tsum.floors.flatMap(floor => floor.zones);
  assert.equal(zones.length, 15);
  assert.deepEqual(
    tsum.nodes.filter(node => node.qr).map(node => node.id).sort(),
    zones.map(zone => zone.node_id).sort()
  );
  for (const [floor, otherFloor] of [["3", "4"], ["4", "3"]]) {
    const start = "stairs-" + floor;
    const targets = tsum.nodes.filter(node => node.floor === otherFloor && node.room);
    assert(targets.length > 1);
    for (const target of targets) {
      const result = route(tsum, start, target.id);
      assert.equal(result.edges[0], "stairs-3-4");
      assert.equal(routePosition(tsum, result, 0).floor, floor);
      assert.equal(routePosition(tsum, result, result.length_m).floor, otherFloor);
      assert.equal(route(tsum, start, target.id, [], true), null);
    }
  }
});
check("closed stairs choose 29m lift route", () => {
  const result = route(graph, "entrance", "lab2", ["stairs-between-floors"]);
  assert.equal(result.length_m, 29);
  assert(result.edges.includes("lift-between-floors"));
});
check("accessible route excludes stairs", () => assert.equal(route(graph, "entrance", "lab2", [], true).length_m, 29));
check("second to third floor offers stairs and lift", () => {
  const fastest = route(graph, "stairs2", "lab3");
  const accessible = route(graph, "stairs2", "lab3", [], true);
  assert.equal(fastest.length_m, 13);
  assert(fastest.edges.includes("stairs-between-floors-2-3"));
  assert.equal(accessible.length_m, 19);
  assert(accessible.edges.includes("lift-between-floors-2-3"));
});
check("edge closed in graph is always excluded", () => {
  const copy = JSON.parse(JSON.stringify(graph));
  copy.edges.find(edge => edge.id === "stairs-between-floors").closed = true;
  const result = route(copy, "entrance", "lab2");
  assert.equal(result.length_m, 29);
  assert(result.edges.includes("lift-between-floors"));
});
check("closed entrance has no route", () => assert.equal(route(graph, "entrance", "lab1", ["entrance-hall"]), null));
check("unknown node refuses", () => assert.throws(() => route(graph, "missing", "lab1"), /Неизвестная точка/));
check("unknown closed edge refuses", () => assert.throws(() => route(graph, "entrance", "lab1", ["missing"]), /Неизвестный закрытый/));

check("nearest campus uses geographic distance", () => {
  const nearest = nearestCampus(catalog.campuses, 55.79, 49.12);
  assert.equal(nearest.campus.id, "kazan-tech");
  assert(nearest.distance_km < 2);
});

check("route position moves smoothly and changes floors", () => {
  const result = route(graph, "entrance", "lab2");
  const firstFloor = routePosition(graph, result, 13);
  const secondFloor = routePosition(graph, result, 16);
  const finish = routePosition(graph, result, result.length_m);
  assert.equal(firstFloor.floor, "1");
  assert.equal(secondFloor.floor, "2");
  assert.equal(finish.node_id, "lab2");
  assert.equal(finish.arrived, true);
});

const lessons = [
  {group_id: "D", date: "2026-11-18", start: "08:10", end: "09:40", room_id: "lab1"},
  {group_id: "D", date: "2026-11-18", start: "09:50", end: "11:20", room_id: "lab2"}
];
check("before first lesson", () => assert.equal(nextLesson(lessons, "D", "2026-11-18T08:00").room_id, "lab1"));
check("current lesson retained", () => assert.equal(nextLesson(lessons, "D", "2026-11-18T08:55").room_id, "lab1"));
check("break selects following lesson", () => assert.equal(nextLesson(lessons, "D", "2026-11-18T09:45").room_id, "lab2"));
check("schedule context connects current room to next room", () => {
  const context = scheduleContext(lessons, "D", "2026-11-18T08:55");
  assert.equal(context.current.room_id, "lab1");
  assert.equal(context.next.room_id, "lab2");
  assert.equal(context.route_from, "lab1");
  assert.equal(context.route_to, "lab2");
});
check("shown lesson can advance to following lesson", () => {
  const shown = nextLesson(lessons, "D", "2026-11-18T08:00");
  const following = nextLesson(lessons, "D", `${shown.date}T${shown.end}`);
  assert.equal(following.room_id, "lab2");
});
check("no invented lesson after timetable", () => assert.equal(nextLesson(lessons, "D", "2026-11-18T11:20"), null));
check("invalid system time refuses", () => assert.throws(() => scheduleContext(lessons, "D", "2026-11-18T25:90"), /дату и местное время/));

const demoRows = fs.readFileSync(__dirname + "/data/timetable.demo.csv", "utf8").trim().split(/\r?\n/).slice(1).map(line => {
  const [campus_id, group_id, date, start, end, room_id, title] = line.split(",");
  return {campus_id, group_id, date, start, end, room_id, title};
});
const minutes = value => {
  const [hours, mins] = value.split(":").map(Number);
  return hours * 60 + mins;
};

check("every demo group has five different 90-minute lessons through 17:00", () => {
  for (const groupId of ["ИСП-21", "АРХ-11", "DEMO-1"]) {
    const lessons = demoRows.filter(row => row.campus_id === "moscow-main" && row.group_id === groupId);
    assert.equal(lessons.length, 5, `${groupId}: ожидается 5 занятий`);
    assert(lessons.every(lesson => minutes(lesson.end) - minutes(lesson.start) === 90), `${groupId}: каждая пара должна длиться 90 минут`);
    assert.equal(lessons.at(-1).end, "17:00", `${groupId}: последняя пара должна заканчиваться в 17:00`);
    assert.equal(new Set(lessons.map(lesson => lesson.title)).size, 5, `${groupId}: названия пар не должны повторяться`);
    assert.deepEqual([...new Set(lessons.map(lesson => lesson.room_id))].sort(), ["lab1", "lab2", "lab3"], `${groupId}: пары должны проходить на всех трёх этажах`);
  }
});

check("every city demo group uses the two-floor template", () => {
  const cityRows = demoRows.filter(row => !["moscow-main", "kazan-tech"].includes(row.campus_id));
  const groups = new Set(cityRows.map(row => row.group_id));
  assert.equal(groups.size, 9);
  for (const groupId of groups) {
    const lessons = cityRows.filter(row => row.group_id === groupId);
    assert.equal(lessons.length, 5, `${groupId}: ожидается 5 занятий`);
    assert(lessons.every(lesson => minutes(lesson.end) - minutes(lesson.start) === 90), `${groupId}: каждая пара должна длиться 90 минут`);
    assert.equal(lessons.at(-1).end, "17:10", `${groupId}: последняя пара должна заканчиваться в 17:10`);
    assert.equal(new Set(lessons.map(lesson => lesson.title)).size, 5, `${groupId}: названия пар не должны повторяться`);
    assert.deepEqual([...new Set(lessons.map(lesson => lesson.room_id))].sort(), ["room1", "room2"], `${groupId}: пары должны проходить на двух этажах`);
  }
});
check("demo groups do not share rooms at the same time", () => {
  const bookings = new Set();
  for (const lesson of demoRows) {
    const key = `${lesson.campus_id}|${lesson.date}|${lesson.start}|${lesson.end}|${lesson.room_id}`;
    assert(!bookings.has(key), `двойное бронирование аудитории: ${key}`);
    bookings.add(key);
  }
});
console.log("ROUTE_CHECK_OK", count);
