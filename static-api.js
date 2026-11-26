"use strict";

async function navigatorFetch(input, options) {
  const url = new URL(input, location.origin);
  const snapshot = name => fetch(new URL("snapshot/" + name + ".json", document.baseURI), options);
  if (url.pathname === "/api/campuses") return snapshot("campuses");

  const campus = url.searchParams.get("campus_id") || "moscow-main";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(campus)) {
    return Response.json({error: "Неизвестный кампус"}, {status: 400});
  }
  const response = await snapshot(campus);
  if (!response.ok) return Response.json({error: "Данные кампуса недоступны"}, {status: response.status});
  if (url.pathname === "/api/data") return response;
  if (url.pathname !== "/api/timetable") return Response.json({error: "Страница не найдена"}, {status: 404});

  const {timetable, graph, schedule} = await response.json();
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
