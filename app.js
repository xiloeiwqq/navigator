"use strict";

const $ = id => document.getElementById(id);
const state = {
  catalog: null,
  campusId: null,
  data: null,
  result: null,
  alternatives: {fastest: null, accessible: null},
  lesson: null,
  scheduleContext: null,
  activeFloor: "1",
  closed: new Set(),
  accessible: false,
  zoom: 1,
  mapCenter: null,
  mapAngle: 0,
  mapRouteFrame: null,
  manualMapView: false,
  locationSource: "manual",
  explicitTarget: false,
  lessonRequest: 0,
  campusRequest: 0,
  dataError: "",
  clockMinute: "",
  clockTimer: null,
  healthTimer: null,
  position: null,
  navigation: {routeKey: "", distanceM: 0, arrived: false},
  sensors: {
    enabled: false,
    orientationEvent: null,
    rawHeading: null,
    heading: 0,
    offset: 0,
    lastStepAt: 0,
    motionEnabled: false,
    calibrationNode: null
  }
};
const scanner = {
  stream: null,
  animationFrame: null,
  detector: null,
  active: false,
  processing: false,
  lastFrame: 0,
  requestId: 0
};
let toastTimer;
let mapAnimationFrame;

function icon(name, className = "") {
  const svg = svgElement("svg", {"aria-hidden": "true", class: className});
  svg.append(svgElement("use", {href: `#icon-${name}`}));
  return svg;
}

function option(select, value, label) {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  select.append(item);
}

function nodeById(id) {
  return state.data.graph.nodes.find(node => node.id === id);
}

function edgeById(id) {
  return state.data.graph.edges.find(edge => edge.id === id);
}

function floorById(id) {
  return state.data.graph.floors.find(floor => floor.id === id);
}

function showToast(message, type = "success") {
  const toast = $("toast");
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast toast--visible${type === "error" ? " toast--error" : ""}`;
  toastTimer = setTimeout(() => { toast.className = "toast"; }, 2800);
}

function openDialog(dialog) {
  if (dialog.open) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog(dialog) {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function stopCamera() {
  scanner.requestId += 1;
  scanner.active = false;
  scanner.processing = false;
  if (scanner.animationFrame) cancelAnimationFrame(scanner.animationFrame);
  scanner.animationFrame = null;
  if (scanner.stream) scanner.stream.getTracks().forEach(track => track.stop());
  scanner.stream = null;
  const video = $("cameraVideo");
  if (video) video.srcObject = null;
}

function resetScannerUi() {
  $("scannerView").className = "scanner-view";
  $("scanSuccess").hidden = true;
  $("cameraFallback").hidden = true;
  $("cameraPlaceholder").classList.remove("camera-placeholder--hidden");
  $("cameraPlaceholderTitle").textContent = "Подключаем камеру";
  $("cameraPlaceholderText").textContent = "Разрешите доступ во всплывающем окне браузера.";
  $("scannerStatus").textContent = "Наведите камеру на QR-код";
  $("scanSuccessKicker").textContent = "QR-код распознан";
  $("scanSuccessTitle").textContent = "Точка найдена";
  $("scanSuccessText").textContent = "Стартовая точка маршрута обновлена.";
  $("scannerContinueButton").hidden = false;
  $("scannerContinueButton").textContent = "Перейти в навигатор";
  $("scanSuccess").querySelector("use")?.setAttribute("href", "#icon-check");
  $("cameraCaptureInput").value = "";
}

function showCameraFallback(title, text, canRetry = true) {
  stopCamera();
  $("scannerView").className = "scanner-view scanner-view--blocked";
  $("cameraPlaceholder").classList.add("camera-placeholder--hidden");
  $("cameraFallbackTitle").textContent = title;
  $("cameraFallbackText").textContent = text;
  $("cameraRetryButton").hidden = !canRetry;
  $("cameraFallback").hidden = false;
  if (mobileViewport.matches) {
    closeDialog($("scannerDialog"));
    showMobileError("camera");
    $("mobileErrorRetry").hidden = !canRetry;
  }
}

function cameraError(error) {
  if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") {
    return ["Нет доступа к камере", "Разрешите доступ в браузере или отсканируйте QR-код по фото.", true];
  }
  if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
    return ["Камера не найдена", "На устройстве нет доступной камеры. Можно выбрать готовое изображение QR-кода.", false];
  }
  if (error?.name === "NotReadableError" || error?.name === "TrackStartError") {
    return ["Камера уже используется", "Закройте другое приложение с камерой и попробуйте ещё раз.", true];
  }
  return ["Не удалось включить камеру", "Попробуйте ещё раз или используйте системную камеру.", true];
}

function decodeCanvasSource(source, sourceWidth, sourceHeight) {
  if (typeof window.jsQR !== "function" || !sourceWidth || !sourceHeight) return null;
  const canvas = $("cameraCanvas");
  const maxWidth = 720;
  const scale = Math.min(1, maxWidth / sourceWidth);
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext("2d", {willReadFrequently: true});
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const result = window.jsQR(pixels.data, pixels.width, pixels.height, {inversionAttempts: "attemptBoth"});
  return result?.data || null;
}

function locationFromPayload(payload) {
  const value = String(payload || "").trim();
  if (!value) return null;
  if (state.data.graph.nodes.some(node => node.id === value)) {
    return {campusId: state.campusId, nodeId: value};
  }

  try {
    const parsed = JSON.parse(value);
    const candidate = parsed.start_node || parsed.node_id;
    const campusId = parsed.campus_id || state.campusId;
    if (candidate && state.catalog.campuses.some(campus => campus.id === campusId)) {
      return {campusId, nodeId: String(candidate)};
    }
  } catch (_error) {
    // Обычная QR-ссылка не является JSON — продолжаем разбор как URL.
  }

  try {
    const url = new URL(value, location.href);
    const candidate = url.searchParams.get("start_node") || url.searchParams.get("node_id");
    const campusId = url.searchParams.get("campus_id") || state.campusId;
    if (candidate && state.catalog.campuses.some(campus => campus.id === campusId)) {
      return {campusId, nodeId: candidate};
    }
  } catch (_error) {
    return null;
  }
  return null;
}

async function completeScan(payload) {
  stopCamera();
  const scanned = locationFromPayload(payload);
  let node = null;
  let loadError = null;
  if (scanned) {
    try {
      if (scanned.campusId !== state.campusId) {
        const switched = await switchCampus(scanned.campusId, {source: "qr", scannedNodeId: scanned.nodeId});
        if (switched) node = nodeById(scanned.nodeId);
      } else {
        node = nodeById(scanned.nodeId);
      }
    } catch (error) {
      loadError = error;
    }
  }
  $("cameraFallback").hidden = true;
  $("cameraPlaceholder").classList.add("camera-placeholder--hidden");
  $("scannerView").className = `scanner-view scanner-view--success${node ? "" : " scanner-view--invalid"}`;
  if (node) {
    applyCheckpoint(node, "qr");
    $("scanSuccessTitle").textContent = node.label;
    $("scanSuccessText").textContent = state.result
      ? "Маршрут перестроен от новой стартовой точки."
      : "Стартовая точка обновлена.";
  } else {
    $("scanSuccessKicker").textContent = "Неизвестная метка";
    $("scanSuccessTitle").textContent = "Точка не найдена";
    $("scanSuccessText").textContent = loadError
      ? `Не удалось загрузить корпус: ${loadError.message}`
      : "Выберите старт вручную или отсканируйте другую метку навигатора.";
    $("scannerContinueButton").textContent = "Выбрать старт вручную";
    $("scanSuccess").querySelector("use")?.setAttribute("href", "#icon-alert");
  }
  const scannedCampus = scanned && campusById(scanned.campusId);
  mobileFinishScan(node, scannedCampus?.temporarily_closed ? "campus" : "qr");
  $("scanSuccess").hidden = false;
  if ($("scannerDialog").open) $("scannerContinueButton").focus({preventScroll: true});
  if (navigator.vibrate) navigator.vibrate(node ? 80 : [60, 40, 60]);
}

async function scanVideoFrame(timestamp) {
  if (!scanner.active) return;
  scanner.animationFrame = requestAnimationFrame(scanVideoFrame);
  if (scanner.processing || timestamp - scanner.lastFrame < 180) return;
  const video = $("cameraVideo");
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return;

  scanner.processing = true;
  scanner.lastFrame = timestamp;
  try {
    let payload = null;
    if (scanner.detector) {
      const codes = await scanner.detector.detect(video);
      payload = codes[0]?.rawValue || null;
    } else {
      payload = decodeCanvasSource(video, video.videoWidth, video.videoHeight);
    }
    if (payload !== null) completeScan(payload);
  } catch (_error) {
    // Отдельный неудачный кадр не должен останавливать сканирование.
  } finally {
    scanner.processing = false;
  }
}

async function startCamera() {
  stopCamera();
  const requestId = scanner.requestId;
  $("cameraFallback").hidden = true;
  $("cameraPlaceholder").classList.remove("camera-placeholder--hidden");
  $("scannerView").className = "scanner-view";
  $("scannerStatus").textContent = "Запрашиваем доступ к камере…";

  if (!window.isSecureContext) {
    showCameraFallback(
      "Для прямой камеры нужен HTTPS",
      "На сетевом HTTP-адресе браузер блокирует видеопоток. Нажмите кнопку ниже — системная камера работает и без HTTPS.",
      false
    );
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showCameraFallback("Камера не поддерживается", "Откройте системную камеру или выберите изображение QR-кода.", false);
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: {ideal: "environment"},
        width: {ideal: 1280},
        height: {ideal: 1280}
      }
    });
    if (requestId !== scanner.requestId || !$("scannerDialog").open) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    scanner.stream = stream;
    const video = $("cameraVideo");
    video.srcObject = scanner.stream;
    await video.play();

    scanner.detector = null;
    if ("BarcodeDetector" in window) {
      try { scanner.detector = new window.BarcodeDetector({formats: ["qr_code"]}); }
      catch (_error) { scanner.detector = null; }
    }
    $("cameraPlaceholder").classList.add("camera-placeholder--hidden");
    $("scannerStatus").textContent = "Наведите камеру на QR-код";
    scanner.active = true;
    scanner.lastFrame = 0;
    scanner.animationFrame = requestAnimationFrame(scanVideoFrame);
  } catch (error) {
    if (requestId !== scanner.requestId || !$("scannerDialog").open) return;
    showCameraFallback(...cameraError(error));
  }
}

function showScanner() {
  if (!state.data) return;
  resetScannerUi();
  openDialog($("scannerDialog"));
  startCamera();
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Не удалось прочитать изображение")); };
    image.src = url;
  });
}

async function scanCapturedImage(file) {
  if (!file) return;
  stopCamera();
  const requestId = scanner.requestId;
  if ($("scannerDialog").open) {
    $("scannerView").className = "scanner-view";
    $("cameraFallback").hidden = true;
    $("cameraPlaceholder").classList.remove("camera-placeholder--hidden");
    $("cameraPlaceholderTitle").textContent = "Читаем QR-код";
    $("cameraPlaceholderText").textContent = "Обрабатываем снимок на устройстве.";
  }
  let payload = null;
  try {
    const image = await loadImageFile(file);
    if (requestId !== scanner.requestId) return;
    payload = decodeCanvasSource(image, image.naturalWidth, image.naturalHeight);
  } catch (_error) {
    // Ошибка чтения снимка обрабатывается так же, как нераспознанный код.
  }
  if (requestId === scanner.requestId) await completeScan(payload);
}

function formatFloor(id) {
  return floorById(id)?.label || `${id} этаж`;
}

function formatStepCount(count) {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${count} шагов`;
  if (mod10 === 1) return `${count} шаг`;
  if (mod10 >= 2 && mod10 <= 4) return `${count} шага`;
  return `${count} шагов`;
}

function currentLocalTime(timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("sv-SE", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
  } catch (_error) {
    const now = new Date();
    const pad = value => String(value).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }
}

function storageValue(key) {
  try { return localStorage.getItem(key) || ""; }
  catch (_error) { return ""; }
}

function saveValue(key, value) {
  try { localStorage.setItem(key, value); }
  catch (_error) { /* Хранилище может быть отключено политикой браузера. */ }
}

function savedGroup() {
  return storageValue(`navigator_group_${state.campusId}`);
}

function saveGroup(groupId) {
  saveValue(`navigator_group_${state.campusId}`, groupId);
}

function updateCampusQuery(campusId, {resetRoute = false} = {}) {
  const url = new URL(window.location.href);
  url.searchParams.set("campus_id", campusId);
  url.searchParams.delete("at");
  if (resetRoute) {
    for (const name of ["start_node", "node_id", "target", "group_id"]) url.searchParams.delete(name);
  }
  history.replaceState({}, "", url);
}

function updateQueryStart(id) {
  const url = new URL(window.location.href);
  url.searchParams.delete("node_id");
  url.searchParams.set("campus_id", state.campusId);
  if (id) url.searchParams.set("start_node", id);
  else url.searchParams.delete("start_node");
  url.searchParams.delete("at");
  history.replaceState({}, "", url);
}

function updateCurrentLocation() {
  const current = nodeById($("start").value);
  $("currentLocation").textContent = current ? `${current.label} · ${formatFloor(current.floor)}` : "Точка не выбрана";
}

function updateScheduleSource(schedule) {
  const source = $("scheduleSource");
  source.textContent = schedule.source === "none" ? "Расписание пока не добавлено"
    : schedule.demo ? "Тестовое расписание для проверки функционала" : "Актуальное расписание корпуса";
  source.classList.toggle("schedule-source--real", schedule.source === "real");
}

function dataMode(data) {
  return data.graph.demo || data.schedule?.demo ? "DEMO" : "Production";
}

function updateClock() {
  if (!state.data) return;
  const timeZone = state.data.graph.timezone;
  const now = new Date();
  let timeLabel;
  let dateLabel;
  try {
    timeLabel = new Intl.DateTimeFormat("ru-RU", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(now);
    dateLabel = new Intl.DateTimeFormat("ru-RU", {
      timeZone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric"
    }).format(now);
  } catch (_error) {
    timeLabel = now.toLocaleTimeString("ru-RU");
    dateLabel = now.toLocaleDateString("ru-RU");
  }
  $("currentClock").textContent = timeLabel;
  $("clockTimezone").textContent = `${dateLabel} · ${state.data.graph.city}`;
  $("headerClock").title = `Системное время: ${dateLabel}, ${timeLabel} · ${state.data.graph.city} (${timeZone})`;
  const minute = currentLocalTime(timeZone);
  if (state.clockMinute && minute !== state.clockMinute) {
    refreshSchedule({silent: true, updateTarget: false});
  }
  state.clockMinute = minute;
}

function startClock() {
  clearInterval(state.clockTimer);
  state.clockMinute = "";
  updateClock();
  state.clockTimer = setInterval(updateClock, 1000);
}

function populateControls({respectQuery = true, selection = null} = {}) {
  const {graph, timetable} = state.data;
  const start = $("start");
  const target = $("target");
  const group = $("group");
  start.replaceChildren();
  target.replaceChildren();
  group.replaceChildren();

  option(start, "", "Выберите стартовую точку");
  option(target, "", "Выберите помещение");
  const startNodes = graph.nodes.filter(node => !node.waypoint);
  for (const node of startNodes) option(start, node.id, `${node.label} · ${formatFloor(node.floor)}`);
  const destinations = graph.nodes.filter(node => node.room || node.id === (graph.entrance_node_id || "entrance"));
  for (const floor of graph.floors) {
    for (const node of destinations.filter(node => node.floor === floor.id)) {
      option(target, node.id, `${node.label} · ${formatFloor(node.floor)}`);
    }
  }
  for (const groupId of [...new Set(timetable.map(lesson => lesson.group_id))]) option(group, groupId, groupId);
  if (!timetable.length) option(group, "", "Нет расписания");
  group.disabled = !timetable.length;

  const query = new URLSearchParams(location.search);
  const linkedStart = respectQuery && (query.has("start_node") || query.has("node_id"));
  const queryStart = selection?.start ?? (linkedStart ? query.get("start_node") || query.get("node_id") || "" : null);
  const entrance = graph.start_at_entrance === true ? nodeById(graph.entrance_node_id || "entrance") : null;
  const startNode = startNodes.find(node => node.id === (queryStart ?? entrance?.id));
  start.value = startNode?.id ?? "";

  const queryTarget = selection?.target ?? (respectQuery ? query.get("target") : null);
  const knownTarget = destinations.some(node => node.id === queryTarget);
  target.value = knownTarget ? queryTarget : "";
  state.explicitTarget = knownTarget && (selection?.explicitTarget ?? true);

  const preferredGroup = selection?.group || (respectQuery ? query.get("group_id") : "") || savedGroup() || "ИСП-21";
  group.value = [...group.options].some(item => item.value === preferredGroup) ? preferredGroup : group.options[0]?.value;
  const mobileGroup = $("mobileGroup");
  mobileGroup.replaceChildren(...Array.from(group.options, item => item.cloneNode(true)));
  mobileGroup.value = group.value;
  mobileGroup.disabled = group.disabled;

  if (respectQuery) state.accessible = ["1", "true"].includes((query.get("accessible") || "").toLowerCase());
  state.locationSource = startNode && queryStart ? selection?.source || "qr" : "manual";
  state.activeFloor = startNode?.floor ?? entrance?.floor ?? graph.floors[0].id;
  state.position = startNode ? {x: startNode.x, y: startNode.y, floor: startNode.floor, nodeId: startNode.id} : null;
  state.navigation = {routeKey: "", distanceM: 0, arrived: false};
  updateCurrentLocation();

  if (queryStart && !startNode) {
    showToast(selection ? "Прежняя стартовая точка удалена. Выберите новую." : "Неизвестная QR-точка. Выберите старт вручную.", "error");
  }
}

function campusById(campusId) {
  return state.catalog?.campuses.find(campus => campus.id === campusId) || null;
}

function populateCampusPicker() {
  const select = $("campusSelect");
  select.replaceChildren();
  const campuses = [...state.catalog.campuses].sort((first, second) => first.city.localeCompare(second.city, "ru"));
  for (const campus of campuses) {
    const label = `${campus.city} — ${campus.short_name}`;
    option(select, campus.id, campus.temporarily_closed ? `${label} · временно не работает` : label);
    select.lastElementChild.disabled = campus.temporarily_closed;
  }
  renderMobileCampus();
}

function geolocationPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("геолокация не поддерживается браузером"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: mobileViewport.matches,
      timeout: 7000,
      maximumAge: mobileViewport.matches ? 60 * 1000 : 5 * 60 * 1000
    });
  });
}

function distanceLabel(distanceKm) {
  return distanceKm < 1 ? `${Math.round(distanceKm * 1000)} м` : `${distanceKm.toFixed(1)} км`;
}

async function detectNearestCampus({announce = true, switchCampusOnSuccess = true} = {}) {
  const button = $("detectCampusButton");
  button.disabled = true;
  $("campusDetection").textContent = "Определяем ближайший корпус…";
  try {
    const position = await geolocationPosition();
    const nearest = window.NavigatorGraph.nearestCampus(
      state.catalog.campuses.filter(campus => !campus.temporarily_closed && campus.auto_select !== false),
      position.coords.latitude,
      position.coords.longitude
    );
    if (!nearest) throw new Error("в каталоге нет координат корпусов");
    if (mobileViewport.matches && nearest.distance_km > 25) {
      $("campusDetection").textContent = "Поблизости нет кампусов · выберите вручную";
      if (announce) showToast("Поблизости нет кампусов. Выберите город вручную.");
      return null;
    }
    const label = `${nearest.campus.city} · ${distanceLabel(nearest.distance_km)}`;
    $("campusDetection").textContent = `Ближайший: ${label}`;
    if (switchCampusOnSuccess && nearest.campus.id !== state.campusId) {
      await switchCampus(nearest.campus.id, {source: "geolocation", respectQuery: false});
      $("campusDetection").textContent = `Ближайший: ${label}`;
    }
    if (announce) showToast(`Выбран ближайший корпус: ${nearest.campus.short_name}`);
    return nearest.campus.id;
  } catch (error) {
    const denied = error?.code === 1 || error?.name === "NotAllowedError";
    $("campusDetection").textContent = denied ? "Геолокация запрещена · выберите вручную" : "Выберите корпус вручную";
    if (announce) showToast(`Не удалось определить корпус: ${error.message || "нет геопозиции"}`, "error");
    return null;
  } finally {
    button.disabled = false;
  }
}

async function switchCampus(campusId, {source = "manual", respectQuery = false, scannedNodeId} = {}) {
  const campus = campusById(campusId);
  if (!campus) throw new Error(`Неизвестный кампус: ${campusId}`);
  if (campus.temporarily_closed) throw new Error(`${campus.short_name} временно не работает`);
  const requestId = ++state.campusRequest;
  $("campusSelect").disabled = true;
  try {
    const payload = await fetchCampusData(campusId);
    if (requestId !== state.campusRequest) return false;
    if (scannedNodeId && !payload.graph.nodes.some(node => node.id === scannedNodeId)) return false;

    state.campusId = campusId;
    mobile.campusChosen = source !== "default";
    mobile.city = mobile.campusChosen ? campus.city : "";
    mobile.routeRequested = respectQuery && new URLSearchParams(location.search).has("target");
    mobile.stepsOpen = false;
    if (source === "manual") saveValue("navigator_campus", campusId);
    updateCampusQuery(campusId, {resetRoute: !respectQuery});
    $("campusSelect").value = campusId;
    $("brandCampus").textContent = `${campus.city} · ${campus.short_name}`;
    if (source === "manual") $("campusDetection").textContent = "Выбран вручную";
    else if (source === "qr") $("campusDetection").textContent = "Корпус определён по QR";
    else if (source === "saved") $("campusDetection").textContent = "Сохранённый выбор";
    else if (source === "link") $("campusDetection").textContent = "Корпус из ссылки";

    applyCampusData(payload, {respectQuery, selection: null});
    renderMobileCampus();
    return true;
  } finally {
    if (requestId === state.campusRequest) $("campusSelect").disabled = false;
  }
}

async function fetchCampusData(campusId) {
  const query = new URLSearchParams({campus_id: campusId});
  const response = await navigatorFetch(`/api/data?${query}`, {cache: "no-store", signal: AbortSignal.timeout(8000)});
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  if (payload.campus_id !== campusId || !payload.graph?.floors?.length ||
      !payload.graph.nodes?.length || !Array.isArray(payload.graph.edges) ||
      !Array.isArray(payload.timetable)) throw new Error("Некорректные данные корпуса");
  return payload;
}

function applyCampusData(payload, {respectQuery = false, selection = null} = {}) {
  const localClosures = selection ? [...state.closed].filter(id => !edgeById(id)?.closed) : [];
  state.data = payload;
  $("campusEditorLink").href = "./editor.html";
  if (state.catalog && JSON.stringify(state.catalog.campuses) !== JSON.stringify(payload.campuses)) {
    state.catalog.campuses = payload.campuses;
    populateCampusPicker();
    $("campusSelect").value = payload.campus_id;
  }
  state.dataError = "";
  if (mobile.error === "offline") mobile.error = "";
  state.lesson = null;
  state.scheduleContext = null;
  populateControls({respectQuery, selection});
  populateSettings(localClosures);
  updateSettingsState();
  const mode = dataMode(payload);
  const scheduleDemo = Boolean(payload.schedule?.demo);
  updateScheduleSource(payload.schedule);
  $("modePill").lastChild.textContent = mode === "DEMO" ? " Демо-режим" : " Реальный план";
  $("prototypeNote").hidden = !payload.graph.demo;
  $("mapSourceNote").textContent = payload.graph.route_note || "";
  $("mapSourceNote").hidden = !payload.graph.route_note;
  const scheduleLabel = payload.schedule.source === "none" ? "без расписания"
    : scheduleDemo ? "тестовое расписание" : "расписание корпуса";
  $("dataVersion").textContent = `Версия ${payload.graph.version} · ${mode} · ${scheduleLabel}`;
  $("serverStatus").textContent = "Данные корпуса загружены";
  $("serverStatusDot").classList.remove("data-card__dot--error");
  startClock();
  findRoute();
  refreshSchedule({silent: true});
}

function populateSettings(localClosures = []) {
  const list = $("closedList");
  list.replaceChildren();
  state.closed = new Set(state.data.graph.edges.filter(edge => edge.closed || localClosures.includes(edge.id)).map(edge => edge.id));
  for (const edge of state.data.graph.edges) {
    const label = document.createElement("label");
    label.className = "closed-item";

    const copy = document.createElement("span");
    copy.className = "closed-item__copy";
    const title = document.createElement("strong");
    title.textContent = edge.name || edge.id;
    const detail = document.createElement("small");
    const accessLabel = edge.accessible ? "доступный проход" : "лестница";
    detail.textContent = `${edge.length_m} м · ${edge.closed ? "закрыт в данных корпуса" : accessLabel}`;
    copy.append(title, detail);

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = edge.id;
    input.checked = state.closed.has(edge.id);
    input.disabled = edge.closed === true;
    input.setAttribute("aria-label", `Закрыть проход: ${title.textContent}`);
    input.addEventListener("change", () => {
      if (input.checked) state.closed.add(edge.id);
      else state.closed.delete(edge.id);
      updateSettingsState();
      findRoute();
      showToast(input.checked ? "Проход закрыт — маршрут перестроен" : "Проход открыт — маршрут обновлён");
    });
    label.append(copy, input);
    list.append(label);
  }

}

function updateSettingsState() {
  $("closedCount").textContent = String(state.closed.size);
  $("settingsDot").hidden = state.closed.size === 0 && !state.accessible;
  $("accessible").checked = state.accessible;
  $("accessibleQuick").checked = state.accessible;
}

function renderLesson() {
  const card = $("lessonCard");
  const context = state.scheduleContext;
  const lesson = context?.current || context?.next || null;
  const shown = lesson || context?.previous || null;
  state.lesson = lesson;
  const button = $("nextLessonButton");
  const buttonLabel = button.querySelector("span");
  if (!shown) {
    card.hidden = true;
    button.disabled = true;
    buttonLabel.textContent = "Занятий нет";
    renderMobileLesson();
    return;
  }
  const room = nodeById(shown.room_id);
  const finished = !context.current && !context.next;
  $("lessonState").textContent = context.current ? "Идёт сейчас" : context.next ? "Следующая пара" : "Занятия завершены";
  $("lessonTime").textContent = `${shown.start}–${shown.end}`;
  $("lessonTitle").textContent = shown.title;
  $("lessonRoom").textContent = `${room.label} · ${formatFloor(room.floor)}`;
  if (context.current && context.next) {
    const nextRoom = nodeById(context.next.room_id);
    $("lessonNext").textContent = `Далее ${context.next.start}: ${context.next.title} · ${nextRoom.label}`;
  } else if (context.current) {
    $("lessonNext").textContent = "Это последняя пара в расписании";
  } else if (finished) {
    $("lessonNext").textContent = `Последняя пара завершилась в ${shown.end} · на сегодня всё`;
  } else {
    $("lessonNext").textContent = `Начало ${shown.date.split("-").reverse().join(".")} в ${shown.start}`;
  }
  button.disabled = !context.next;
  buttonLabel.textContent = context.next
    ? "К следующей паре"
    : context.current ? "Следующих пар нет" : "На сегодня всё";
  card.hidden = false;
  renderMobileLesson();
}

function moveStartToNode(node, source) {
  $("start").value = node.id;
  state.locationSource = source;
  state.activeFloor = node.floor;
  state.position = {x: node.x, y: node.y, floor: node.floor, nodeId: node.id};
  state.navigation = {routeKey: "", distanceM: 0, arrived: false};
  updateQueryStart(node.id);
  updateCurrentLocation();
}

function applyScheduleContext(context, {routeToNext = false, updateTarget = false, silent = false} = {}) {
  for (const lesson of [context.current, context.next, context.previous].filter(Boolean)) {
    if (!nodeById(lesson.room_id)) throw new Error(`Неизвестная аудитория в расписании: ${lesson.room_id}`);
  }
  state.scheduleContext = context;
  renderLesson();

  if (routeToNext) {
    if (!context.route_to) {
      if (!silent) showToast(context.current ? "После текущей пары занятий больше нет" : "Ближайших занятий нет", "error");
      return;
    }
    if (context.route_from) moveStartToNode(nodeById(context.route_from), "schedule");
    $("target").value = context.route_to;
    state.explicitTarget = false;
    findRoute();
    if (!silent) {
      const target = nodeById(context.route_to);
      const origin = nodeById($("start").value);
      showToast(origin ? `Маршрут к следующей паре: ${origin.label} → ${target.label}` : "Выберите стартовую точку.");
    }
    return;
  }

  if (updateTarget && state.lesson) {
    $("target").value = state.lesson.room_id;
    state.explicitTarget = false;
    findRoute();
  }
}

async function refreshSchedule({silent = false, routeToNext = false, updateTarget = false} = {}) {
  if (!state.data || state.dataError) return;
  const requestId = ++state.lessonRequest;
  const button = $("nextLessonButton");
  const groupId = $("group").value;
  if (!groupId) {
    button.disabled = true;
    button.removeAttribute("aria-busy");
    $("lessonCard").hidden = true;
    renderMobileLesson();
    return;
  }
  const lookupTime = currentLocalTime(state.data.graph.timezone);
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const query = new URLSearchParams({campus_id: state.campusId, group_id: groupId, at: lookupTime});
    const response = await navigatorFetch(`/api/timetable?${query}`, {cache: "no-store"});
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    if (requestId !== state.lessonRequest) return;
    applyScheduleContext(payload, {routeToNext, updateTarget, silent});
  } catch (error) {
    if (requestId !== state.lessonRequest) return;
    try {
      const fallback = window.NavigatorGraph.scheduleContext(state.data.timetable, groupId, lookupTime);
      applyScheduleContext(fallback, {routeToNext, updateTarget, silent});
    } catch (_fallbackError) {
      // Исходная ошибка API содержит более полезную диагностику.
    }
    if (!silent) showToast(`Расписание не обновлено: ${error.message}`, "error");
  } finally {
    if (requestId === state.lessonRequest) {
      button.removeAttribute("aria-busy");
      renderLesson();
    }
  }
}

function instructionFor(edge, from, to) {
  const directed = edge.instructions?.[`${from.id}>${to.id}`];
  if (directed) return directed;
  if (from.floor !== to.floor && edge.kind === "stairs") return `Поднимитесь по лестнице на ${formatFloor(to.floor).toLowerCase()}`;
  if (from.floor !== to.floor && edge.kind === "lift") return `Поднимитесь на лифте на ${formatFloor(to.floor).toLowerCase()}`;
  if (to.room) return `Войдите в ${to.label}`;
  return `Следуйте к точке «${to.label}»`;
}

function stepIcon(edge, from, to) {
  if (to.room) return "pin";
  if (from.floor !== to.floor && edge.kind === "stairs") return "stairs";
  if (from.floor !== to.floor && edge.kind === "lift") return "lift";
  return "walk";
}

function createRouteStep({title, subtitle, distance, floor, iconName, first = false, last = false}) {
  const item = document.createElement("li");
  item.className = "route-step";

  const mark = document.createElement("span");
  mark.className = "route-step__icon";
  mark.append(icon(first ? "route" : iconName));
  if (iconName === "walk" || iconName === "lift") {
    const image = document.createElement("img");
    image.alt = "";
    image.className = "mobile-only";
    image.src = `./assets/mobile/${iconName}.svg`;
    mark.append(image);
  }
  const copy = document.createElement("span");
  copy.className = "route-step__copy";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const detail = document.createElement("span");
  detail.textContent = subtitle;
  copy.append(heading, detail);
  const length = document.createElement("span");
  length.className = "route-step__distance";
  length.textContent = distance;
  item.append(mark, copy, length);

  if (last) item.dataset.last = "true";
  item.dataset.floor = floor;
  return item;
}

function sameRoute(first, second) {
  return Boolean(first && second && first.edges.join("|") === second.edges.join("|"));
}

function routeTransport(result) {
  if (!result) return {iconName: "alert", label: "маршрут недоступен"};
  const kinds = new Set(result.edges.map(edgeId => edgeById(edgeId).kind));
  if (kinds.has("stairs")) return {iconName: "stairs", label: "через лестницу"};
  if (kinds.has("lift")) return {iconName: "lift", label: "через лифт"};
  return {iconName: "walk", label: "по этажу"};
}

function setAccessibility(enabled) {
  state.accessible = Boolean(enabled);
  updateSettingsState();
  findRoute();
}

function renderRouteOptions(container) {
  const {fastest, accessible} = state.alternatives;
  if (!fastest || (accessible && sameRoute(fastest, accessible))) return;

  const section = document.createElement("section");
  section.className = "route-options";
  section.setAttribute("aria-label", "Варианты маршрута");
  const head = document.createElement("div");
  head.className = "route-options__head";
  const headCopy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = "Выберите способ";
  const hint = document.createElement("small");
  hint.textContent = "Можно идти быстрее или без лестниц";
  headCopy.append(title, hint);
  const badge = document.createElement("span");
  badge.className = "route-options__badge";
  badge.textContent = accessible ? "2 варианта" : "1 вариант";
  head.append(headCopy, badge);

  const list = document.createElement("div");
  list.className = "route-options__list";
  const options = [
    {result: fastest, accessible: false, title: "Самый быстрый"},
    {result: accessible, accessible: true, title: "Доступная среда"}
  ];
  for (const routeOption of options) {
    const transport = routeTransport(routeOption.result);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "route-option";
    button.disabled = !routeOption.result;
    button.setAttribute("aria-pressed", String(state.accessible === routeOption.accessible));
    const mark = document.createElement("span");
    mark.className = "route-option__icon";
    mark.append(icon(routeOption.accessible ? "accessible" : transport.iconName));
    const copy = document.createElement("span");
    copy.className = "route-option__copy";
    const strong = document.createElement("strong");
    strong.textContent = routeOption.title;
    const detail = document.createElement("small");
    if (routeOption.result) {
      const minutes = routeOption.result.length_m === 0 ? 0 : Math.max(1, Math.ceil(routeOption.result.length_m / 55));
      detail.textContent = `${routeOption.result.length_m} м · ~${minutes} мин · ${transport.label}`;
    } else {
      detail.textContent = "Нет безбарьерного пути";
    }
    copy.append(strong, detail);
    button.append(mark, copy);
    button.addEventListener("click", () => setAccessibility(routeOption.accessible));
    list.append(button);
  }
  section.append(head, list);
  container.append(section);
}

function renderRouteResult() {
  const container = $("routeResult");
  container.replaceChildren();
  const start = nodeById($("start").value);
  const target = nodeById($("target").value);
  if (state.dataError) {
    container.append(dataErrorMessage(state.dataError));
    return;
  }
  renderRouteOptions(container);

  if (!state.result) {
    const error = document.createElement("div");
    error.className = "route-error";
    error.append(icon("alert"));
    const copy = document.createElement("div");
    const title = document.createElement("h3");
    title.id = "routeResultTitle";
    title.textContent = start && target ? "Маршрут недоступен" : "Выберите маршрут";
    const text = document.createElement("p");
    text.textContent = !start ? "Выберите старт вручную или отсканируйте QR у входа."
      : !target ? "Выберите помещение назначения."
      : state.accessible && state.alternatives.fastest ? "Безбарьерного пути нет. Доступен маршрут с лестницей."
      : "Выберите другую стартовую точку или аудиторию либо обратитесь к сотруднику корпуса.";
    copy.append(title, text);
    error.append(copy);
    container.append(error);
    return;
  }

  const result = state.result;
  const summary = document.createElement("div");
  summary.className = "route-summary";
  const head = document.createElement("div");
  head.className = "route-summary__head";
  const headCopy = document.createElement("div");
  const status = document.createElement("span");
  status.className = "route-summary__state";
  const check = document.createElement("i");
  check.append(icon("check"));
  const readyLabel = state.accessible ? "Доступный маршрут готов" : "Маршрут готов";
  status.append(check, document.createTextNode(result.length_m === 0 ? "Вы на месте" : readyLabel));
  const title = document.createElement("h3");
  title.id = "routeResultTitle";
  title.textContent = target.label;
  headCopy.append(status, title);
  head.append(headCopy);
  summary.append(head);

  const routeFloors = new Set(result.nodes.map(id => nodeById(id).floor));
  const minutes = result.length_m === 0 ? 0 : Math.max(1, Math.ceil(result.length_m / 55));
  const metrics = document.createElement("div");
  metrics.className = "route-metrics";
  const metricValues = [[`${result.length_m} м`, "расстояние"], [`~${minutes} мин`, "пешком"], [String(routeFloors.size), routeFloors.size === 1 ? "этаж" : "этажа"]];
  for (const [index, [value, label]] of metricValues.entries()) {
    const metric = document.createElement("span");
    metric.className = "route-metric";
    const strong = document.createElement("strong");
    strong.textContent = value;
    const small = document.createElement("span");
    small.textContent = label;
    metric.append(strong, small);
    if (index === 1) {
      metric.classList.add("route-metric--time");
      const caption = document.createElement("span");
      caption.className = "mobile-only";
      caption.textContent = "в пути";
      metric.append(caption);
    } else if (index === 2) {
      metric.classList.add("route-metric--floors");
      const floor = document.createElement("strong");
      floor.className = "mobile-only";
      floor.textContent = formatFloor(target.floor).replace(/\s+этаж$/i, "");
      const caption = document.createElement("span");
      caption.className = "mobile-only";
      caption.textContent = "этаж";
      metric.append(floor, caption);
    }
    metrics.append(metric);
  }
  summary.append(metrics);
  container.append(summary);

  const stepsHead = document.createElement("div");
  stepsHead.className = "steps-head";
  const stepsTitle = document.createElement("h3");
  stepsTitle.textContent = "По шагам";
  const stepsCount = document.createElement("span");
  stepsHead.append(stepsTitle, stepsCount);
  container.append(stepsHead);

  const list = document.createElement("ol");
  list.className = "route-steps";
  list.append(createRouteStep({
    title: result.length_m === 0 ? "Вы уже в нужной точке" : "Начните движение",
    subtitle: `${start.label} · ${formatFloor(start.floor)}`,
    distance: "Старт",
    floor: start.floor,
    iconName: "route",
    first: true,
    last: result.edges.length === 0
  }));

  const steps = [];
  result.edges.forEach((edgeId, index) => {
    const edge = edgeById(edgeId);
    const from = nodeById(result.nodes[index]);
    const to = nodeById(result.nodes[index + 1]);
    const title = instructionFor(edge, from, to);
    const straight = from.waypoint && to.waypoint && from.floor === to.floor && edge.kind === "corridor";
    const previous = steps.at(-1);
    if (straight && previous?.straight && previous.title === title && previous.to.floor === to.floor) {
      previous.length += edge.length_m;
      previous.to = to;
    } else {
      steps.push({title, to, length: edge.length_m, straight, iconName: stepIcon(edge, from, to)});
    }
  });
  stepsCount.textContent = formatStepCount(steps.length + 1);
  steps.forEach(({title, to, length, iconName}, index) => list.append(createRouteStep({
    title,
    subtitle: `${to.label} · ${formatFloor(to.floor)}`,
    distance: `${length} м`,
    floor: to.floor,
    iconName,
    last: index === steps.length - 1
  })));
  container.append(list);
}

function edgePoints(edge, floorId) {
  if (edge.path && Object.hasOwn(edge.path, floorId)) return edge.path[floorId];
  const from = nodeById(edge.from);
  const to = nodeById(edge.to);
  if (from.floor === floorId && to.floor === floorId) return [[from.x, from.y], [to.x, to.y]];
  return null;
}

function normalizeHeading(value) {
  return (value % 360 + 360) % 360;
}

function setCompassStatus(message, stateName = "") {
  $("compassStatus").textContent = message;
  $("compassStatus").closest(".orientation-controls")?.setAttribute("data-state", stateName);
  $("mobileCompass").textContent = state.sensors.enabled ? message : "Включить компас";
}

function updateLiveArrow() {
  const marker = document.querySelector(".live-position");
  if (!marker || !state.position || state.position.floor !== state.activeFloor) return;
  marker.style.transform = `translate(${state.position.x}px, ${state.position.y}px)`;
  const arrow = marker.querySelector(".live-position__arrow");
  if (arrow) arrow.style.transform = `rotate(${state.sensors.heading}deg)`;
}

function advanceNavigation(distanceM = .75) {
  if (!state.result || !state.result.edges.length || state.navigation.arrived) return;
  state.navigation.distanceM = Math.min(state.result.length_m, state.navigation.distanceM + distanceM);
  const position = window.NavigatorGraph.routePosition(state.data.graph, state.result, state.navigation.distanceM);
  const floorChanged = position.floor !== state.activeFloor;
  state.position = {x: position.x, y: position.y, floor: position.floor, nodeId: position.node_id};
  state.navigation.arrived = position.arrived;
  if (floorChanged) {
    state.activeFloor = position.floor;
    renderMap();
  } else {
    updateLiveArrow();
  }
  $("currentLocation").textContent = position.arrived
    ? `${nodeById(state.result.nodes.at(-1)).label} · вы пришли`
    : `В пути · ${formatFloor(position.floor)} · ${Math.round(state.navigation.distanceM)} м`;
  if (position.arrived) {
    showToast("Вы прибыли в точку назначения");
    renderMap();
  }
}

function handleOrientation(event) {
  let rawHeading = null;
  if (Number.isFinite(event.webkitCompassHeading)) rawHeading = event.webkitCompassHeading;
  else if (Number.isFinite(event.alpha)) {
    const screenAngle = screen.orientation?.angle || window.orientation || 0;
    rawHeading = normalizeHeading(360 - event.alpha + screenAngle);
  }
  if (rawHeading === null) return;
  state.sensors.rawHeading = rawHeading;
  const corrected = normalizeHeading(rawHeading + state.sensors.offset);
  const delta = ((corrected - state.sensors.heading + 540) % 360) - 180;
  state.sensors.heading = normalizeHeading(state.sensors.heading + delta * .22);
  updateLiveArrow();
  const calibration = state.sensors.calibrationNode ? ` · ${state.sensors.calibrationNode}` : "";
  setCompassStatus(`Компас ${Math.round(state.sensors.heading)}°${calibration}`, "active");
}

function handleMotion(event) {
  const now = performance.now();
  if (now - state.sensors.lastStepAt < 320) return;
  const acceleration = event.acceleration;
  let impulse = 0;
  if ([acceleration?.x, acceleration?.y, acceleration?.z].every(Number.isFinite)) {
    impulse = Math.hypot(acceleration.x, acceleration.y, acceleration.z);
  } else {
    const gravity = event.accelerationIncludingGravity;
    if (![gravity?.x, gravity?.y, gravity?.z].every(Number.isFinite)) return;
    impulse = Math.abs(Math.hypot(gravity.x, gravity.y, gravity.z) - 9.81);
  }
  if (impulse < 1.7) return;
  state.sensors.lastStepAt = now;
  advanceNavigation(.75);
}

async function requestSensorPermission(constructor) {
  if (typeof constructor?.requestPermission !== "function") return true;
  return (await constructor.requestPermission()) === "granted";
}

async function enableSensors() {
  const orientationConstructor = window.DeviceOrientationEvent;
  const motionConstructor = window.DeviceMotionEvent;
  if (!orientationConstructor && !motionConstructor) {
    setCompassStatus("Датчики движения не поддерживаются", "error");
    showToast("На этом устройстве нет доступа к компасу и шагам", "error");
    return;
  }
  try {
    const orientationGranted = orientationConstructor
      ? await requestSensorPermission(orientationConstructor).catch(() => false)
      : false;
    const motionGranted = motionConstructor
      ? await requestSensorPermission(motionConstructor).catch(() => false)
      : false;
    if (!orientationGranted && !motionGranted) throw new Error("доступ к датчикам запрещён");
    if (!state.sensors.enabled) {
      state.sensors.orientationEvent = "ondeviceorientationabsolute" in window
        ? "deviceorientationabsolute"
        : "deviceorientation";
      if (orientationGranted) window.addEventListener(state.sensors.orientationEvent, handleOrientation, true);
      if (motionGranted) window.addEventListener("devicemotion", handleMotion, true);
    }
    state.sensors.enabled = true;
    state.sensors.motionEnabled = motionGranted;
    $("compassButton").textContent = orientationGranted ? "Компас активен" : "Шагомер активен";
    $("compassButton").disabled = true;
    setCompassStatus(orientationGranted ? "Ожидаем данные компаса…" : "Шагомер активен · без компаса", "pending");
    const enabledLabel = orientationGranted && motionGranted ? "компас и шаги" : orientationGranted ? "компас" : "шаги";
    showToast(`Живая навигация включена: данные «${enabledLabel}» обрабатываются на устройстве`);
  } catch (error) {
    setCompassStatus("Нет доступа к датчикам", "error");
    showToast(`Не удалось включить датчики: ${error.message}`, "error");
  }
}

function applyCheckpoint(node, source = "checkpoint") {
  moveStartToNode(node, source);
  state.sensors.calibrationNode = node.label;
  if (Number.isFinite(node.heading) && Number.isFinite(state.sensors.rawHeading)) {
    state.sensors.offset = normalizeHeading(node.heading - state.sensors.rawHeading);
    state.sensors.heading = node.heading;
    setCompassStatus(`Калибровка по точке · ${node.label}`, "active");
  } else {
    setCompassStatus(`Положение уточнено · ${node.label}`, "pending");
  }
  findRoute();
  if (source === "checkpoint") showToast(`Положение откалибровано: ${node.label}`);
}

function resetCalibration() {
  if (!state.data) return;
  const start = nodeById($("start").value);
  if (!start) return;
  state.sensors.offset = 0;
  state.sensors.calibrationNode = null;
  state.position = {x: start.x, y: start.y, floor: start.floor, nodeId: start.id};
  state.navigation = {routeKey: "", distanceM: 0, arrived: false};
  state.activeFloor = start.floor;
  setCompassStatus(state.sensors.enabled ? "Поправка сброшена · магнитный север" : "Поправка сброшена", "pending");
  findRoute();
  showToast("Положение возвращено к стартовой точке, поправка компаса сброшена");
}

function drawMarker(svg, node, imagePlan) {
  const size = imagePlan ? 19 : 30;
  svg.append(svgElement("image", {
    href: "./assets/mobile/flag.svg", x: node.x - size / 2, y: node.y - size, width: size, height: size,
    class: "navigator-map-icon map-flag", "data-rotation-center": `${node.x} ${node.y}`
  }));
  svg.append(svgElement("circle", {cx: node.x, cy: node.y, r: 12, class: "map-marker-end"}));
  svg.append(svgElement("text", {x: node.x, y: node.y + .5, class: "map-marker-letter map-marker-letter--end"}, "B"));
  const label = node.label.replace("Аудитория ", "");
  const width = Math.max(51, Math.min(105, label.length * 5.2 + 16));
  const labelY = Math.max(34, node.y - 34);
  svg.append(svgElement("rect", {x: node.x - width / 2, y: labelY - 13, width, height: 19, rx: 7, class: "map-node-label-bg"}));
  svg.append(svgElement("text", {x: node.x, y: labelY, class: "map-node-label"}, label));
}

function drawCheckpoint(svg, node, imagePlan) {
  const group = svgElement("g", {
    class: "map-checkpoint",
    role: "button",
    tabindex: "0",
    "aria-label": `Уточнить положение: ${node.label}`
  });
  group.append(svgElement("circle", {cx: node.x, cy: node.y, r: imagePlan ? 5.5 : 8, class: "map-checkpoint__ring"}));
  group.append(svgElement("circle", {cx: node.x, cy: node.y, r: imagePlan ? 2.5 : 3, class: "map-checkpoint__dot"}));
  group.addEventListener("click", () => applyCheckpoint(node));
  group.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      applyCheckpoint(node);
    }
  });
  svg.append(group);
}

function drawLivePosition(svg, position, imagePlan) {
  const group = svgElement("g", {class: "live-position", "aria-label": "Текущее положение"});
  group.style.transform = `translate(${position.x}px, ${position.y}px)`;
  group.append(svgElement("circle", {cx: 0, cy: 0, r: 21, class: "live-position__pulse"}));
  group.append(svgElement("circle", {cx: 0, cy: 0, r: 12, class: "live-position__disc"}));
  const arrow = svgElement("g", {class: "live-position__arrow"});
  arrow.style.transform = `rotate(${state.sensors.heading}deg)`;
  arrow.append(svgElement("path", {d: "M0 -11 L7.5 8 L0 5 L-7.5 8 Z"}));
  const size = imagePlan ? 19 : 30;
  arrow.append(svgElement("image", {href: "./assets/mobile/arrow.svg", x: -size / 2, y: -size / 2, width: size, height: size, class: "navigator-map-icon"}));
  group.append(arrow);
  group.append(svgElement("rect", {x: -28, y: -34, width: 56, height: 17, rx: 6, class: "map-node-label-bg"}));
  group.append(svgElement("text", {x: 0, y: -22.5, class: "map-node-label"}, "Вы здесь"));
  svg.append(group);
}

function renderFloorTabs() {
  const tabs = $("floorTabs");
  tabs.replaceChildren();
  tabs.style.setProperty("--floor-count", String(state.data.graph.floors.length));
  const routeFloors = new Set(state.result ? state.result.nodes.map(id => nodeById(id).floor) : []);
  const floors = [...state.data.graph.floors].reverse();
  for (const floor of floors) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "floor-tab";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(state.activeFloor === floor.id));
    const label = document.createElement("span");
    label.className = "floor-tab-label";
    label.textContent = floor.label;
    const mobileLabel = document.createElement("span");
    mobileLabel.className = "mobile-only mobile-floor-label";
    const number = document.createElement("strong");
    number.textContent = floor.label.replace(/\s+этаж$/i, "");
    mobileLabel.append(number, document.createTextNode("этаж"));
    button.append(label, mobileLabel);
    if (routeFloors.has(floor.id)) {
      const dot = document.createElement("i");
      dot.className = "floor-tab__route";
      button.append(dot);
    }
    button.addEventListener("click", () => {
      state.activeFloor = floor.id;
      state.manualMapView = false;
      state.mapAngle = 0;
      renderMap();
    });
    tabs.append(button);
  }
}

const mapWidth = 440;
const mapHeight = 290;

function mapMinZoom() {
  return Math.min(1, state.mapRouteFrame?.zoom ?? 1);
}

function mapZoomLimit(floor) {
  return mobileViewport.matches || floorUsesDetailedZoom(floor) ? 4 : 1.6;
}

function mobileFloorZoom(floor) {
  return floor.outline ? Math.min(2.4, Math.max(1, mapHeight / (floor.outline.height + 34))) : 1.45;
}

function setAutomaticMapView(floor) {
  state.mapRouteFrame = null;
  const outline = floor.outline;
  if (!mobileViewport.matches || !outline || outline.width < outline.height * 2.5) {
    state.zoom = 1;
    state.mapCenter = null;
    return;
  }
  const start = nodeById($("start").value);
  const target = nodeById($("target").value);
  const entrance = nodeById(state.data.graph.entrance_node_id);
  const onFloor = node => node?.floor === floor.id;
  const anchor = [start, target, entrance].find(onFloor);
  state.zoom = mobileFloorZoom(floor);
  const fitsRoute = onFloor(start) && onFloor(target) && Math.abs(start.x - target.x) + 36 <= mapWidth / state.zoom;
  state.mapCenter = {
    x: fitsRoute ? (start.x + target.x) / 2 : anchor?.x ?? outline.x + outline.width / 2,
    y: outline.y + outline.height / 2
  };
}

function mapAxisCenter(center, visible, total, start = 0, extent = total, frameCenter) {
  const min = Math.max(0, start - 14);
  const max = Math.min(total, start + extent + 14);
  const halfSpan = Math.min(visible, max - min) / 2;
  // Keep the fitted route center reachable near the edge of a rotated floor plan.
  const lower = Math.min(min + halfSpan, frameCenter ?? Infinity);
  const upper = Math.max(max - halfSpan, frameCenter ?? -Infinity);
  return Math.max(lower, Math.min(upper, center));
}

function rotateMapVector(x, y, angle) {
  const radians = angle * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {x: x * cosine - y * sine, y: x * sine + y * cosine};
}

function setMapViewBox(svg, floor) {
  const width = mapWidth / state.zoom;
  const height = mapHeight / state.zoom;
  const center = state.mapCenter || {x: mapWidth / 2, y: mapHeight / 2};
  const frame = state.mapRouteFrame;
  const axis = rotateMapVector(1, 0, state.mapAngle);
  const visibleX = Math.abs(axis.x) * width + Math.abs(axis.y) * height;
  const visibleY = Math.abs(axis.y) * width + Math.abs(axis.x) * height;
  const x = mapAxisCenter(center.x, visibleX, mapWidth, floor.outline?.x, floor.outline?.width, frame?.x);
  const y = mapAxisCenter(center.y, visibleY, mapHeight, floor.outline?.y, floor.outline?.height, frame?.y);
  state.mapCenter = {x, y};
  const left = x - width / 2;
  const top = y - height / 2;
  svg.setAttribute("viewBox", `${left} ${top} ${width} ${height}`);
  const scene = svg.firstElementChild;
  scene.setAttribute("transform", `rotate(${state.mapAngle} ${x} ${y})`);
  const counterAngle = String(-state.mapAngle);
  if (counterAngle !== (scene.dataset.counterAngle ?? "0")) {
    for (const item of scene.querySelectorAll("[data-rotation-center]")) {
      item.setAttribute("transform", `rotate(${counterAngle} ${item.dataset.rotationCenter})`);
    }
    scene.dataset.counterAngle = counterAngle;
  }
  const canPan = state.zoom > mapMinZoom();
  if (!svg.hasAttribute("aria-label") || svg.classList.contains("floor-map--pannable") !== canPan) {
    svg.classList.toggle("floor-map--pannable", canPan);
    if (canPan) svg.setAttribute("tabindex", "0");
    else svg.removeAttribute("tabindex");
    svg.setAttribute("aria-label", `${floor.label}, схема маршрута${canPan ? ". Для перемещения используйте клавиши со стрелками." : ""}`);
  }
  $("zoomIn").disabled = state.zoom >= mapZoomLimit(floor);
  $("zoomOut").disabled = !canPan;
}

function stopMapAnimation() {
  if (mapAnimationFrame != null) cancelAnimationFrame(mapAnimationFrame);
  mapAnimationFrame = null;
}

function animateMapView(target, angle, zoom) {
  const svg = $("mapCanvas").querySelector(".floor-map");
  const floor = floorById(state.activeFloor);
  if (!svg || !floor) return;
  stopMapAnimation();
  state.manualMapView = true;
  const from = {center: state.mapCenter, zoom: state.zoom, angle: state.mapAngle};
  const angleDelta = ((angle - from.angle + 540) % 360) - 180;
  const update = progress => {
    state.zoom = progress === 1 ? zoom : from.zoom + (zoom - from.zoom) * progress;
    state.mapAngle = from.angle + angleDelta * progress;
    state.mapCenter = {
      x: from.center.x + (target.x - from.center.x) * progress,
      y: from.center.y + (target.y - from.center.y) * progress
    };
    setMapViewBox(svg, floor);
  };
  if (reducedMobileMotion.matches) {
    update(1);
    return;
  }
  const started = performance.now();
  const frame = now => {
    const progress = Math.min(1, (now - started) / 440);
    update(1 - (1 - progress) ** 3);
    mapAnimationFrame = progress < 1 ? requestAnimationFrame(frame) : null;
  };
  mapAnimationFrame = requestAnimationFrame(frame);
}

function showMapDestination() {
  const target = nodeById($("target").value);
  if (!target || state.dataError) return;
  state.mapRouteFrame = null;
  if (state.activeFloor !== target.floor) {
    state.activeFloor = target.floor;
    renderMap();
  }
  animateMapView(target, 0, Math.max(state.zoom, mobileFloorZoom(floorById(target.floor))));
}

function frameMobileRoute() {
  const nodes = state.result.nodes.map(nodeById);
  const start = nodes[0];
  const floor = floorById(start.floor);
  const floorExit = nodes.findIndex(node => node.floor !== start.floor);
  const segment = floorExit === -1 ? nodes : nodes.slice(0, floorExit);
  const end = segment.at(-1);
  if (state.activeFloor !== start.floor) {
    state.activeFloor = start.floor;
    renderMap();
  }

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const angle = Math.hypot(dx, dy) > .5 ? -90 - Math.atan2(dy, dx) * 180 / Math.PI : 0;
  const points = segment.map(({x, y}) => [x, y]);
  for (const edgeId of state.result.edges.slice(0, segment.length)) {
    points.push(...(edgePoints(edgeById(edgeId), floor.id) || []));
  }
  const rotated = points.map(([x, y]) => rotateMapVector(x, y, angle));
  const xs = rotated.map(point => point.x);
  const ys = rotated.map(point => point.y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  const center = rotateMapVector((left + right) / 2, (top + bottom) / 2, -angle);
  const markerPadding = 34;
  const zoom = Math.min(
    Math.max(state.zoom, mobileFloorZoom(floor)),
    mapWidth / (right - left + 2 * markerPadding),
    mapHeight / (bottom - top + 2 * markerPadding)
  );
  state.mapRouteFrame = {...center, zoom};
  animateMapView(center, angle, zoom);
}

function bindMapGestures(canvas) {
  const pointers = new Map();
  let gesture;
  let suppressClick = false;
  const eventPoint = event => ({x: event.clientX, y: event.clientY});
  const describePointers = () => {
    const [first, second] = pointers.values();
    if (!second) return first;
    return {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
      distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y))
    };
  };
  const resetGesture = () => {
    gesture = null;
    const screenPoint = describePointers();
    const svg = canvas.querySelector(".floor-map");
    const matrix = svg?.firstElementChild?.getScreenCTM();
    const scale = matrix && Math.hypot(matrix.a, matrix.b);
    if (!screenPoint || !scale) return;
    const anchor = new DOMPoint(screenPoint.x, screenPoint.y).matrixTransform(matrix.inverse());
    gesture = {screenPoint, anchor, scale, center: state.mapCenter, zoom: state.zoom, angle: state.mapAngle};
  };
  const capturePointers = () => {
    for (const id of pointers.keys()) {
      if (!canvas.hasPointerCapture(id)) canvas.setPointerCapture(id);
    }
  };
  canvas.addEventListener("pointerdown", event => {
    if (event.button !== 0 || pointers.size >= 2 || (pointers.size && event.pointerType !== "touch")) return;
    if (!pointers.size) {
      stopMapAnimation();
      suppressClick = false;
    }
    pointers.set(event.pointerId, eventPoint(event));
    if (pointers.size === 2) {
      suppressClick = true;
      capturePointers();
    }
    resetGesture();
  });

  canvas.addEventListener("pointermove", event => {
    if (!pointers.has(event.pointerId) || !gesture) return;
    const svg = canvas.querySelector(".floor-map");
    const floor = state.data && floorById(state.activeFloor);
    if (!svg || !floor) return;
    pointers.set(event.pointerId, eventPoint(event));
    const point = describePointers();
    if (point.distance) {
      state.zoom = Math.max(mapMinZoom(), Math.min(mapZoomLimit(floor), gesture.zoom * point.distance / gesture.screenPoint.distance));
      const scale = gesture.scale * state.zoom / gesture.zoom;
      const rect = svg.getBoundingClientRect();
      const offset = rotateMapVector(
        (rect.left + rect.width / 2 - point.x) / scale,
        (rect.top + rect.height / 2 - point.y) / scale, -gesture.angle);
      state.mapCenter = {
        x: gesture.anchor.x + offset.x,
        y: gesture.anchor.y + offset.y
      };
    } else {
      if (state.zoom <= mapMinZoom()) return;
      const dx = point.x - gesture.screenPoint.x;
      const dy = point.y - gesture.screenPoint.y;
      if (!suppressClick && Math.hypot(dx, dy) < 5) return;
      if (!suppressClick) capturePointers();
      const offset = rotateMapVector(dx / gesture.scale, dy / gesture.scale, -gesture.angle);
      state.mapCenter = {x: gesture.center.x - offset.x, y: gesture.center.y - offset.y};
    }
    suppressClick = true;
    state.manualMapView = true;
    event.preventDefault();
    setMapViewBox(svg, floor);
  });

  const endPointer = event => {
    if (pointers.delete(event.pointerId)) resetGesture();
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", event => {
    if (event.pointerType === "mouse" && !canvas.hasPointerCapture(event.pointerId)) endPointer(event);
  });
  canvas.addEventListener("lostpointercapture", event => {
    // При переносе захвата с элемента SVG событие от него всплывает в контейнер.
    if (event.target === canvas) endPointer(event);
  });
  canvas.addEventListener("click", event => {
    if (suppressClick && event.detail !== 0) {
      suppressClick = false;
      event.stopImmediatePropagation();
    }
  }, true);

  const directions = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]};
  canvas.addEventListener("keydown", event => {
    const svg = canvas.querySelector(".floor-map");
    const direction = directions[event.key];
    if (event.target !== svg || !direction || state.zoom <= mapMinZoom()) return;
    event.preventDefault();
    stopMapAnimation();
    state.manualMapView = true;
    const offset = rotateMapVector(direction[0] * 65 / state.zoom, direction[1] * 65 / state.zoom, -state.mapAngle);
    state.mapCenter = {
      x: state.mapCenter.x + offset.x,
      y: state.mapCenter.y + offset.y
    };
    setMapViewBox(svg, floorById(state.activeFloor));
  });
}

function changeMapZoom(direction) {
  if (!state.data) return;
  stopMapAnimation();
  const floor = floorById(state.activeFloor);
  const detailed = floorUsesDetailedZoom(floor);
  const step = detailed || mobileViewport.matches ? .5 : .2;
  if (detailed && !state.mapRouteFrame && state.zoom === 1 && direction > 0) {
    state.mapCenter = state.position || nodeById($("target").value) || null;
  }
  state.manualMapView = true;
  state.zoom = Math.min(mapZoomLimit(floor), Math.max(mapMinZoom(), state.zoom + direction * step));
  setMapViewBox($("mapCanvas").querySelector(".floor-map"), floor);
}

function renderMap() {
  if (!state.data) return;
  stopMapAnimation();
  renderFloorTabs();
  const floor = floorById(state.activeFloor) || state.data.graph.floors[0];
  const canvas = $("mapCanvas");
  const floorKey = `${state.campusId}:${floor.id}`;
  const floorChanged = canvas.dataset.floorKey !== floorKey;
  if (floorChanged) {
    state.manualMapView = false;
    state.mapAngle = 0;
  }
  if (!state.manualMapView) setAutomaticMapView(floor);
  const mobileRouteKey = mobile.routeRequested && state.result ? state.navigation.routeKey : "";
  const drawMobileRoute = Boolean(mobileRouteKey) && (floorChanged || mobileRouteKey !== canvas.dataset.routeKey);
  canvas.dataset.floorKey = floorKey;
  canvas.dataset.routeKey = mobileRouteKey;
  canvas.replaceChildren();
  const detailed = floorUsesDetailedZoom(floor);
  const svg = svgElement("svg", {
    class: `floor-map${floorChanged ? " floor-map--changed" : ""}${detailed ? " floor-map--detailed" : ""}`,
    role: "group",
    preserveAspectRatio: "xMidYMid meet"
  });
  const scene = svgElement("g");
  svg.append(scene);
  drawPlan(scene, floor);

  for (const edge of state.data.graph.edges) {
    const points = edgePoints(edge, floor.id);
    if (!points) continue;
    scene.append(svgElement("polyline", {
      points: points.map(point => point.join(",")).join(" "),
      class: `network-path${edge.closed === true || state.closed.has(edge.id) ? " network-path--closed" : ""}`
    }));
  }

  const selectedEdges = new Set(state.result?.edges || []);
  const routeLines = [];
  for (const edgeId of selectedEdges) {
    const edge = edgeById(edgeId);
    const points = edgePoints(edge, floor.id);
    if (!points) continue;
    const serialized = points.map(point => point.join(",")).join(" ");
    scene.append(svgElement("polyline", {points: serialized, class: "active-path-shadow"}));
    routeLines.push(svgElement("polyline", {points: serialized, class: `active-path${drawMobileRoute ? " active-path--animate" : ""}`, pathLength: 1}));
  }
  scene.append(...routeLines);

  const selectedNodes = new Set(state.result?.nodes || []);
  for (const node of state.data.graph.nodes.filter(item => item.floor === floor.id && selectedNodes.has(item.id))) {
    scene.append(svgElement("circle", {cx: node.x, cy: node.y, r: 5, class: "map-node map-node--route"}));
  }

  for (const node of state.data.graph.nodes.filter(item => item.floor === floor.id && item.qr)) {
    drawCheckpoint(scene, node, detailed);
  }

  const target = nodeById($("target").value);
  if (!state.dataError && target?.floor === floor.id) drawMarker(scene, target, detailed);
  if (!state.dataError && state.position?.floor === floor.id) drawLivePosition(scene, state.position, detailed);
  drawMobilePickPoints(scene, floor);
  setMapViewBox(svg, floor);
  canvas.append(svg);

  const status = $("mapStatus");
  status.className = `map-status${state.result ? "" : " map-status--error"}`;
  const remaining = state.result ? Math.max(0, Math.round(state.result.length_m - state.navigation.distanceM)) : 0;
  const statusText = state.dataError ? " Данные недоступны"
    : !target || !$("start").value ? " Выберите старт и цель"
    : state.result && state.navigation.arrived
    ? " Вы на месте"
    : state.result ? ` Осталось · ${remaining} м` : " Путь не найден";
  status.replaceChildren(document.createElement("span"), document.createTextNode(statusText));
  renderMobile();
}

function findRoute() {
  if (!state.data) return;
  const startNode = nodeById($("start").value);
  const targetNode = nodeById($("target").value);
  if (state.dataError || !startNode || !targetNode) {
    state.result = null;
    state.alternatives = {fastest: null, accessible: null};
    state.navigation = {routeKey: "", distanceM: 0, arrived: false};
    state.position = startNode ? {x: startNode.x, y: startNode.y, floor: startNode.floor, nodeId: startNode.id} : null;
    renderRouteResult();
    renderMap();
    $("copyRouteButton").disabled = true;
    if (state.dataError) showMobileError("offline");
    return;
  }
  try {
    const start = $("start").value;
    const target = $("target").value;
    const closed = [...state.closed];
    const fastest = window.NavigatorGraph.route(state.data.graph, start, target, closed, false);
    const accessible = window.NavigatorGraph.route(state.data.graph, start, target, closed, true);
    state.alternatives = {fastest, accessible};
    state.result = state.accessible ? accessible : fastest;
    const currentFloor = nodeById(start).floor;
    const routeKey = [state.campusId, start, target, state.accessible, [...closed].sort().join(","), state.result?.edges.join(",") || "none"].join("|");
    if (state.navigation.routeKey !== routeKey) {
      const startNode = nodeById(start);
      state.navigation = {routeKey, distanceM: 0, arrived: false};
      state.position = {x: startNode.x, y: startNode.y, floor: startNode.floor, nodeId: startNode.id};
    }
    const routeFloors = new Set(state.result ? state.result.nodes.map(id => nodeById(id).floor) : [currentFloor]);
    if (!routeFloors.has(state.activeFloor)) state.activeFloor = currentFloor;
    renderRouteResult();
    renderMap();
    $("copyRouteButton").disabled = !state.result;
    if (!state.result && mobile.routeRequested) showMobileError("blocked");
  } catch (error) {
    state.result = null;
    state.alternatives = {fastest: null, accessible: null};
    renderRouteResult();
    renderMap();
    $("copyRouteButton").disabled = true;
    showToast(error.message, "error");
    if (mobile.routeRequested) showMobileError("blocked");
  }
}

async function copyRouteLink() {
  const url = new URL(location.href);
  url.searchParams.delete("node_id");
  url.searchParams.delete("at");
  url.searchParams.set("campus_id", state.campusId);
  url.searchParams.set("start_node", $("start").value);
  url.searchParams.set("target", $("target").value);
  url.searchParams.set("group_id", $("group").value);
  if (state.accessible) url.searchParams.set("accessible", "1");
  else url.searchParams.delete("accessible");
  const text = url.toString();
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    showToast("Ссылка на маршрут скопирована");
  } catch (_error) {
    showToast("Не удалось скопировать ссылку", "error");
  }
}

function dataErrorMessage(error) {
  const message = document.createElement("div");
  message.className = "route-error";
  message.setAttribute("role", "alert");
  message.append(icon("alert"));
  const copy = document.createElement("div");
  const title = document.createElement("h3");
  title.id = "routeResultTitle";
  title.textContent = "Не удалось загрузить данные корпуса";
  const text = document.createElement("p");
  text.textContent = error;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "text-button data-retry";
  retry.textContent = "Повторить загрузку";
  retry.addEventListener("click", async () => {
    retry.disabled = true;
    await (state.data ? refreshCampusData() : boot());
    retry.disabled = false;
  });
  copy.append(title, text, retry);
  message.append(copy);
  return message;
}

async function refreshCampusData({announce = true} = {}) {
  const button = $("healthButton");
  if (!state.data || button.disabled || $("campusSelect").disabled) return;
  const requestId = state.campusRequest;
  button.disabled = true;
  try {
    const payload = await fetchCampusData(state.campusId);
    if (requestId !== state.campusRequest) return;
    if (state.dataError || JSON.stringify(payload) !== JSON.stringify(state.data)) {
      applyCampusData(payload, {selection: {
        start: $("start").value,
        target: $("target").value,
        group: $("group").value,
        explicitTarget: state.explicitTarget,
        source: state.locationSource
      }});
    }
    if (announce) showToast("Данные корпуса актуальны");
  } catch (error) {
    if (requestId !== state.campusRequest) return;
    const changed = state.dataError !== error.message;
    state.dataError = error.message || "Сервер не ответил";
    state.lessonRequest++;
    $("nextLessonButton").disabled = true;
    $("nextLessonButton").removeAttribute("aria-busy");
    $("lessonCard").hidden = true;
    renderMobileLesson();
    $("serverStatus").textContent = "Данные недоступны";
    $("serverStatusDot").classList.add("data-card__dot--error");
    $("dataVersion").textContent = state.dataError;
    if (changed || announce) findRoute();
  } finally {
    button.disabled = false;
  }
}

function bindEvents() {
  $("routeForm").addEventListener("submit", event => {
    event.preventDefault();
    if (mobileViewport.matches) {
      if (!mobile.campusChosen || !$("start").value || !$("target").value) {
        showToast(!mobile.campusChosen ? "Выбери город и корпус" : "Выбери старт и пункт назначения", "error");
        return;
      }
      mobile.routeRequested = true;
      mobile.stepsOpen = false;
      mobileCloseMenu();
      mobile.picking = "";
    }
    state.explicitTarget = true;
    findRoute();
    if (mobileViewport.matches && state.result) frameMobileRoute();
  });
  $("nextLessonButton").addEventListener("click", () => refreshSchedule({routeToNext: true}));
  $("target").addEventListener("change", () => {
    state.explicitTarget = true;
    const focusTarget = mobileViewport.matches && $("target").value;
    if (focusTarget) state.manualMapView = true;
    findRoute();
    if (focusTarget) showMapDestination();
  });
  $("group").addEventListener("change", () => {
    $("mobileGroup").value = $("group").value;
    saveGroup($("group").value);
    state.explicitTarget = false;
    refreshSchedule({updateTarget: !mobileViewport.matches});
  });
  $("start").addEventListener("change", () => {
    const start = nodeById($("start").value);
    if (start) moveStartToNode(start, "manual");
    else {
      state.locationSource = "manual";
      updateQueryStart("");
      updateCurrentLocation();
    }
    findRoute();
  });
  $("campusSelect").addEventListener("change", async event => {
    try {
      await switchCampus(event.target.value, {source: "manual", respectQuery: false});
      showToast(`Корпус переключён: ${campusById(event.target.value).short_name}`);
    } catch (error) {
      showToast(`Не удалось переключить корпус: ${error.message}`, "error");
      if (state.campusId) $("campusSelect").value = state.campusId;
    }
  });
  $("detectCampusButton").addEventListener("click", () => {
    saveValue("navigator_campus", "");
    detectNearestCampus();
  });
  $("accessible").addEventListener("change", event => setAccessibility(event.target.checked));
  $("accessibleQuick").addEventListener("change", event => setAccessibility(event.target.checked));
  $("settingsButton").addEventListener("click", () => openDialog($("settingsDialog")));
  $("changeLocationButton").addEventListener("click", showScanner);
  $("compassButton").addEventListener("click", enableSensors);
  $("resetCalibrationButton").addEventListener("click", resetCalibration);
  $("copyRouteButton").addEventListener("click", copyRouteLink);
  $("healthButton").addEventListener("click", () => refreshCampusData());
  $("zoomIn").addEventListener("click", () => changeMapZoom(1));
  $("zoomOut").addEventListener("click", () => changeMapZoom(-1));
  bindMapGestures($("mapCanvas"));

  document.querySelectorAll(".dialog-close").forEach(button => {
    button.addEventListener("click", () => closeDialog(button.closest("dialog")));
  });
  document.querySelectorAll("dialog").forEach(dialog => {
    dialog.addEventListener("click", event => { if (event.target === dialog) closeDialog(dialog); });
  });

  $("scannerCloseButton").addEventListener("click", () => closeDialog($("scannerDialog")));
  $("continueWithoutScanButton").addEventListener("click", () => {
    closeDialog($("scannerDialog"));
    if (mobileViewport.matches) $("mobileManual").click();
    else $("start").focus();
  });
  $("scannerContinueButton").addEventListener("click", () => {
    closeDialog($("scannerDialog"));
    $($("scannerView").classList.contains("scanner-view--invalid") ? "start" : "target").focus();
  });
  $("cameraRetryButton").addEventListener("click", () => {
    resetScannerUi();
    startCamera();
  });
  $("scanAgainButton").addEventListener("click", () => {
    resetScannerUi();
    startCamera();
  });
  $("cameraCaptureButton").addEventListener("click", () => {
    const input = $("cameraCaptureInput");
    input.value = "";
    input.click();
  });
  $("cameraCaptureInput").addEventListener("change", event => scanCapturedImage(event.target.files?.[0]));
  $("scannerDialog").addEventListener("close", stopCamera);
  $("scannerDialog").addEventListener("cancel", stopCamera);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && $("scannerDialog").open) stopCamera();
  });
}

async function boot() {
  try {
    const response = await navigatorFetch("/api/campuses", {cache: "no-store", signal: AbortSignal.timeout(8000)});
    const catalog = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(catalog.error || `HTTP ${response.status}`);
    if (!Array.isArray(catalog.campuses) || !catalog.campuses.length) throw new Error("Каталог кампусов пуст");
    const firstCatalog = !state.catalog;
    state.catalog = catalog;
    populateCampusPicker();
    if (firstCatalog) bindEvents();
    $("campusSelect").disabled = true;

    const query = new URLSearchParams(location.search);
    const queryCampus = query.get("campus_id");
    const knownQueryCampus = campusById(queryCampus);
    const stored = campusById(storageValue("navigator_campus"));
    const storedCampus = stored?.temporarily_closed ? null : stored;
    const linkedCampus = knownQueryCampus || (!queryCampus && (query.has("start_node") || query.has("node_id"))
      ? campusById(catalog.default_campus_id) : null);
    if (linkedCampus && !linkedCampus.temporarily_closed) {
      mobile.screen = query.has("target") ? "map" : "welcome";
      await switchCampus(linkedCampus.id, {source: "link", respectQuery: true});
      if ($("start").value && !query.has("target")) mobile.screen = state.locationSource === "qr" ? "located" : "map";
      if (!$("start").value && (query.has("start_node") || query.has("node_id"))) showMobileError("qr");
    } else if (storedCampus && !mobileViewport.matches) {
      await switchCampus(storedCampus.id, {source: "saved", respectQuery: false});
    } else {
      const detected = await detectNearestCampus({announce: false});
      if (!detected) {
        await switchCampus(storedCampus?.id || catalog.default_campus_id, {
          source: storedCampus ? "saved" : "default",
          respectQuery: false
        });
      }
      if (mobileViewport.matches) mobile.screen = "map";
    }
    if (queryCampus && !knownQueryCampus) showToast("Неизвестный кампус в QR. Выберите корпус и старт вручную.", "error");
    if (knownQueryCampus?.temporarily_closed) showToast(`${knownQueryCampus.short_name} временно не работает`, "error");
    if (queryCampus && (!knownQueryCampus || knownQueryCampus.temporarily_closed)) {
      showMobileError(knownQueryCampus?.temporarily_closed ? "campus" : "qr");
    }
    if (!state.healthTimer) {
      state.healthTimer = setInterval(() => {
        if (!document.hidden) refreshCampusData({announce: false});
      }, 10000);
    }
    if (mobile.error === "offline") mobile.error = "";
    $("mobileCity").disabled = false;
    renderMobileCampus();
    renderMobile();
  } catch (error) {
    $("routeResult").replaceChildren(dataErrorMessage(error.message));
    $("mapStatus").className = "map-status map-status--error";
    $("mapStatus").lastChild.textContent = " Данные недоступны";
    showMobileError("offline");
  }
}

bindMobileEvents();
renderMobile();
boot();
