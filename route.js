"use strict";

// Один и тот же алгоритм используется в браузере и в Node-тестах.
function route(graph, from, to, closed = [], accessible = false) {
  const ids = new Set(graph.nodes.map(node => node.id));
  if (!ids.has(from) || !ids.has(to)) throw new Error("Неизвестная точка старта или назначения");

  const closedSet = new Set(closed);
  const knownEdges = new Set(graph.edges.map(edge => edge.id));
  if (closed.some(id => !knownEdges.has(id))) throw new Error("Неизвестный закрытый проход");

  const neighbors = new Map([...ids].map(id => [id, []]));
  for (const edge of graph.edges) {
    // Постоянно закрытые рёбра приходят из данных корпуса, временные — из интерфейса.
    if (edge.closed === true || closedSet.has(edge.id) || (accessible && !edge.accessible)) continue;
    neighbors.get(edge.from).push([edge.to, edge]);
    neighbors.get(edge.to).push([edge.from, edge]);
  }

  const distance = new Map([...ids].map(id => [id, Infinity]));
  const remaining = new Set(ids);
  const previous = new Map();
  distance.set(from, 0);

  while (remaining.size) {
    let best = null;
    for (const id of remaining) {
      if (best === null || distance.get(id) < distance.get(best)) best = id;
    }
    if (!Number.isFinite(distance.get(best))) break;
    remaining.delete(best);
    if (best === to) break;

    for (const [next, edge] of neighbors.get(best)) {
      const candidate = distance.get(best) + edge.length_m;
      if (candidate < distance.get(next)) {
        distance.set(next, candidate);
        previous.set(next, [best, edge.id]);
      }
    }
  }

  if (!Number.isFinite(distance.get(to))) return null;
  const nodes = [to];
  const edges = [];
  while (nodes[0] !== from) {
    const [before, edge] = previous.get(nodes[0]);
    nodes.unshift(before);
    edges.unshift(edge);
  }
  return {nodes, edges, length_m: distance.get(to)};
}

function nextLesson(timetable, groupId, localTime) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localTime)) {
    throw new Error("Укажите дату и местное время корпуса");
  }
  return timetable
    .filter(lesson => lesson.group_id === groupId && `${lesson.date}T${lesson.end}` > localTime)
    .sort((a, b) => `${a.date}T${a.start}`.localeCompare(`${b.date}T${b.start}`))[0] || null;
}

if (typeof module !== "undefined" && module.exports) module.exports = {route, nextLesson};
else window.NavigatorGraph = {route, nextLesson};
