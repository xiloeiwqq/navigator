"use strict";

const hostedFeed = new URL("https://raw.githubusercontent.com/xiloeiwqq/navigator/refs/heads/codex/navigator-data/hosted/");
let previousHostedCatalog = null;

async function readHostedCatalog() {
  try {
    const response = await fetch(new URL("index.json", hostedFeed), {signal: AbortSignal.timeout(3500)});
    if (response.ok) {
      const catalog = await response.json();
      if (catalog.campuses?.length && typeof catalog.version === "string") previousHostedCatalog = catalog;
    }
  } catch (_error) {
    // Keep the last catalog available when the hosted feed is offline.
  }
  return previousHostedCatalog;
}

async function navigatorFetch(input, options) {
  const url = new URL(input, location.origin);
  const snapshot = name => fetch(new URL("snapshot/" + name + ".json", document.baseURI), options);
  const hosted = await readHostedCatalog();
  const catalogResponse = hosted ? null : await snapshot("campuses");
  if (catalogResponse && !catalogResponse.ok) return catalogResponse;
  const catalog = hosted || await catalogResponse.json();
  if (url.pathname === "/api/campuses") return Response.json(catalog);

  const campus = url.searchParams.get("campus_id") || catalog.default_campus_id;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(campus)) {
    return Response.json({error: "Неизвестный кампус"}, {status: 400});
  }
  const response = hosted ? await fetch(new URL("campuses/" + campus + ".json", hostedFeed), options) : await snapshot(campus);
  if (!response.ok) return Response.json({error: "Данные кампуса недоступны"}, {status: response.status});
  const data = await response.json();
  if (url.pathname === "/api/data") {
    for (const floor of data.graph.floors) {
      if (floor.image?.startsWith("/assets/")) floor.image = "." + floor.image;
    }
    return Response.json(data);
  }
  if (url.pathname !== "/api/timetable") return Response.json({error: "Страница не найдена"}, {status: 404});

  const {timetable, graph, schedule} = data;
  const groupId = url.searchParams.get("group_id");
  const at = url.searchParams.get("at");
  try {
    return Response.json({
      ...window.NavigatorGraph.scheduleContext(timetable, groupId, at),
      group_id: groupId,
      campus_id: campus,
      at,
      version: graph.version,
      schedule_source: schedule.source,
      schedule_demo: schedule.demo
    });
  } catch (error) {
    return Response.json({error: error.message}, {status: 400});
  }
}
