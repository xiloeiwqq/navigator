"use strict";

const communityFeed = new URL("https://raw.githubusercontent.com/xiloeiwqq/navigator/refs/heads/codex/navigator-data/");
let previousCommunity = {version: "", campuses: []};

async function readCommunity() {
  try {
    const response = await fetch(new URL("index.json", communityFeed), {signal: AbortSignal.timeout(3500)});
    if (response.ok) {
      const feed = await response.json();
      if (Array.isArray(feed.campuses) && typeof feed.version === "string") previousCommunity = feed;
    }
  } catch (_error) {
    // Keep the last catalog available when the community feed is offline.
  }
  return previousCommunity;
}

async function navigatorFetch(input, options) {
  const url = new URL(input, location.origin);
  const snapshot = name => fetch(new URL("snapshot/" + name + ".json", document.baseURI), options);
  const [catalogResponse, community] = await Promise.all([snapshot("campuses"), readCommunity()]);
  if (!catalogResponse.ok) return catalogResponse;
  const catalog = await catalogResponse.json();
  const builtIn = new Set(catalog.campuses.map(campus => campus.id));
  const additions = community.campuses.filter(campus => !builtIn.has(campus.id));
  const campuses = [...catalog.campuses, ...additions];
  const version = community.version ? catalog.version + "+" + community.version : catalog.version;
  if (url.pathname === "/api/campuses") return Response.json({...catalog, version, campuses});

  const campus = url.searchParams.get("campus_id") || catalog.default_campus_id;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(campus)) {
    return Response.json({error: "Неизвестный кампус"}, {status: 400});
  }
  const isCommunity = additions.some(item => item.id === campus);
  const response = isCommunity ? await fetch(new URL(campus + ".json", communityFeed), options) : await snapshot(campus);
  if (!response.ok) return Response.json({error: "Данные кампуса недоступны"}, {status: response.status});
  const data = await response.json();
  if (url.pathname === "/api/data") {
    return Response.json({...data, campus_id: campus, default_campus_id: catalog.default_campus_id, campuses});
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
