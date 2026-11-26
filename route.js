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

function validLocalTime(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value || "");
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59) return false;
  const date = new Date(`${match[1]}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === match[1];
}

function scheduleContext(timetable, groupId, localTime) {
  if (!validLocalTime(localTime)) {
    throw new Error("Укажите дату и местное время корпуса");
  }
  if (!groupId) throw new Error("Укажите учебную группу");

  const lessons = timetable
    .filter(lesson => lesson.group_id === groupId)
    .sort((a, b) => `${a.date}T${a.start}`.localeCompare(`${b.date}T${b.start}`));
  const current = lessons.find(lesson => (
    `${lesson.date}T${lesson.start}` <= localTime && localTime < `${lesson.date}T${lesson.end}`
  )) || null;
  const next = lessons.find(lesson => `${lesson.date}T${lesson.start}` > localTime) || null;
  const previous = lessons.filter(lesson => `${lesson.date}T${lesson.end}` <= localTime).at(-1) || null;
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

function nextLesson(timetable, groupId, localTime) {
  return scheduleContext(timetable, groupId, localTime).lesson;
}

function haversineKm(firstLatitude, firstLongitude, secondLatitude, secondLongitude) {
  const values = [firstLatitude, firstLongitude, secondLatitude, secondLongitude];
  if (!values.every(Number.isFinite)) throw new Error("Координаты должны быть конечными числами");
  const radians = value => value * Math.PI / 180;
  const latitudeDelta = radians(secondLatitude - firstLatitude);
  const longitudeDelta = radians(secondLongitude - firstLongitude);
  const first = radians(firstLatitude);
  const second = radians(secondLatitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(first) * Math.cos(second) * Math.sin(longitudeDelta / 2) ** 2;
  const normalized = Math.max(0, Math.min(1, haversine));
  return 6371 * 2 * Math.atan2(Math.sqrt(normalized), Math.sqrt(1 - normalized));
}

function nearestCampus(campuses, latitude, longitude) {
  if (!Array.isArray(campuses) || !campuses.length) return null;
  let nearest = null;
  for (const campus of campuses) {
    const coordinates = campus?.coordinates;
    if (!Number.isFinite(coordinates?.latitude) || !Number.isFinite(coordinates?.longitude)) continue;
    const distanceKm = haversineKm(latitude, longitude, coordinates.latitude, coordinates.longitude);
    if (!nearest || distanceKm < nearest.distance_km) nearest = {campus, distance_km: distanceKm};
  }
  return nearest;
}

function interpolatePoints(points, ratio) {
  if (points.length === 1) return {x: points[0][0], y: points[0][1]};
  const segments = points.slice(1).map((point, index) => {
    const before = points[index];
    return Math.hypot(point[0] - before[0], point[1] - before[1]);
  });
  const total = segments.reduce((sum, length) => sum + length, 0);
  if (!total) return {x: points[0][0], y: points[0][1]};
  let remaining = Math.max(0, Math.min(1, ratio)) * total;
  for (let index = 0; index < segments.length; index += 1) {
    if (remaining <= segments[index] || index === segments.length - 1) {
      const localRatio = segments[index] ? remaining / segments[index] : 0;
      return {
        x: points[index][0] + (points[index + 1][0] - points[index][0]) * localRatio,
        y: points[index][1] + (points[index + 1][1] - points[index][1]) * localRatio
      };
    }
    remaining -= segments[index];
  }
  return {x: points.at(-1)[0], y: points.at(-1)[1]};
}

/**
 * Преобразовать пройденное расстояние в координату на схеме. Межэтажный
 * переход переключает этаж в середине ребра, а коридоры интерполируются по
 * их нарисованной полилинии.
 */
function routePosition(graph, result, distanceM) {
  if (!result?.nodes?.length || !Array.isArray(result.edges)) throw new Error("Маршрут не задан");
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const edges = new Map(graph.edges.map(edge => [edge.id, edge]));
  const total = result.edges.reduce((sum, edgeId) => sum + (edges.get(edgeId)?.length_m || 0), 0);
  const distance = Math.max(0, Math.min(Number.isFinite(distanceM) ? distanceM : 0, total));

  if (!result.edges.length || distance >= total) {
    const node = nodes.get(result.nodes.at(-1));
    return {x: node.x, y: node.y, floor: node.floor, edge_id: null, progress: 1, distance_m: distance, arrived: true, node_id: node.id};
  }

  let passed = 0;
  for (let index = 0; index < result.edges.length; index += 1) {
    const edge = edges.get(result.edges[index]);
    const from = nodes.get(result.nodes[index]);
    const to = nodes.get(result.nodes[index + 1]);
    if (!edge || !from || !to) throw new Error("Маршрут ссылается на неизвестный узел или проход");
    const edgeEnd = passed + edge.length_m;
    if (distance <= edgeEnd || index === result.edges.length - 1) {
      const ratio = edge.length_m ? (distance - passed) / edge.length_m : 1;
      if (from.floor !== to.floor) {
        const node = ratio < .5 ? from : to;
        return {x: node.x, y: node.y, floor: node.floor, edge_id: edge.id, progress: ratio, distance_m: distance, arrived: false, node_id: node.id};
      }
      let points = edge.path && Object.hasOwn(edge.path, from.floor)
        ? edge.path[from.floor]
        : [[from.x, from.y], [to.x, to.y]];
      if (edge.from !== from.id) points = [...points].reverse();
      const point = interpolatePoints(points, ratio);
      return {...point, floor: from.floor, edge_id: edge.id, progress: ratio, distance_m: distance, arrived: false, node_id: null};
    }
    passed = edgeEnd;
  }
  throw new Error("Не удалось определить положение на маршруте");
}

const api = {route, scheduleContext, nextLesson, haversineKm, nearestCampus, routePosition};
if (typeof module !== "undefined" && module.exports) module.exports = api;
else window.NavigatorGraph = api;
