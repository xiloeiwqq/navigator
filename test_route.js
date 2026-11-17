"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const {route, nextLesson} = require("./route.js");
const graph = JSON.parse(fs.readFileSync(__dirname + "/data/graph.json", "utf8"));
let count = 0;

function check(name, action) {
  action();
  count += 1;
  console.log("PASS", name);
}

check("same node", () => assert.deepEqual(route(graph, "lab1", "lab1"), {nodes: ["lab1"], edges: [], length_m: 0}));
check("entry to A-101 is 14m", () => assert.equal(route(graph, "entrance", "lab1").length_m, 14));
check("stairs to A-201 is 25m", () => {
  const result = route(graph, "entrance", "lab2");
  assert.equal(result.length_m, 25);
  assert(result.edges.includes("stairs-between-floors"));
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

const lessons = [
  {group_id: "D", date: "2026-11-16", start: "08:10", end: "09:40", room_id: "lab1"},
  {group_id: "D", date: "2026-11-16", start: "09:50", end: "11:20", room_id: "lab2"}
];
check("before first lesson", () => assert.equal(nextLesson(lessons, "D", "2026-11-16T08:00").room_id, "lab1"));
check("current lesson retained", () => assert.equal(nextLesson(lessons, "D", "2026-11-16T08:55").room_id, "lab1"));
check("break selects following lesson", () => assert.equal(nextLesson(lessons, "D", "2026-11-16T09:45").room_id, "lab2"));
check("shown lesson can advance to following lesson", () => {
  const shown = nextLesson(lessons, "D", "2026-11-16T08:00");
  const following = nextLesson(lessons, "D", `${shown.date}T${shown.end}`);
  assert.equal(following.room_id, "lab2");
});
check("no invented lesson after timetable", () => assert.equal(nextLesson(lessons, "D", "2026-11-16T11:20"), null));

const demoRows = fs.readFileSync(__dirname + "/data/timetable.demo.csv", "utf8").trim().split(/\r?\n/).slice(1).map(line => {
  const [group_id, date, start, end, room_id, title] = line.split(",");
  return {group_id, date, start, end, room_id, title};
});
const minutes = value => {
  const [hours, mins] = value.split(":").map(Number);
  return hours * 60 + mins;
};

check("every demo group has five different 90-minute lessons through 17:00", () => {
  for (const groupId of ["ИСП-21", "АРХ-11", "DEMO-1"]) {
    const lessons = demoRows.filter(row => row.group_id === groupId);
    assert.equal(lessons.length, 5, `${groupId}: ожидается 5 занятий`);
    assert(lessons.every(lesson => minutes(lesson.end) - minutes(lesson.start) === 90), `${groupId}: каждая пара должна длиться 90 минут`);
    assert.equal(lessons.at(-1).end, "17:00", `${groupId}: последняя пара должна заканчиваться в 17:00`);
    assert.equal(new Set(lessons.map(lesson => lesson.title)).size, 5, `${groupId}: названия пар не должны повторяться`);
    assert.deepEqual([...new Set(lessons.map(lesson => lesson.room_id))].sort(), ["lab1", "lab2", "lab3"], `${groupId}: пары должны проходить на всех трёх этажах`);
  }
});

check("demo groups do not share rooms at the same time", () => {
  const bookings = new Set();
  for (const lesson of demoRows) {
    const key = `${lesson.date}|${lesson.start}|${lesson.end}|${lesson.room_id}`;
    assert(!bookings.has(key), `двойное бронирование аудитории: ${key}`);
    bookings.add(key);
  }
});
console.log("ROUTE_CHECK_OK", count);
