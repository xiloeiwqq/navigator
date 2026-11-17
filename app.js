"use strict";

const $ = id => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";
const state = {
  data: null,
  result: null,
  alternatives: {fastest: null, accessible: null},
  lesson: null,
  activeFloor: "1",
  closed: new Set(),
  accessible: false,
  zoom: 1,
  locationSource: "manual",
  hasQrStart: false,
  explicitTarget: false,
  lessonRequest: 0
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

function svgElement(name, attributes = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

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
  $("scannerStatus").textContent = "Наведите камеру на QR-код";
  $("scanPayload").textContent = "";
  $("scanSuccessKicker").textContent = "QR-код распознан";
  $("scanSuccessTitle").textContent = "Точка найдена";
  $("scanSuccessText").textContent = "Стартовая точка маршрута обновлена.";
  $("scannerContinueButton").hidden = false;
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
}

function cameraError(error) {
  if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") {
    return ["Нет доступа к камере", "Разрешите камеру в настройках сайта или откройте системную камеру кнопкой ниже.", true];
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

function nodeIdFromPayload(payload) {
  const value = String(payload || "").trim();
  if (!value) return null;
  if (state.data.graph.nodes.some(node => node.id === value)) return value;

  try {
    const parsed = JSON.parse(value);
    const candidate = parsed.start_node || parsed.node_id;
    if (state.data.graph.nodes.some(node => node.id === candidate)) return candidate;
  } catch (_error) {
    // Обычная QR-ссылка не является JSON — продолжаем разбор как URL.
  }

  try {
    const url = new URL(value, location.href);
    const candidate = url.searchParams.get("start_node") || url.searchParams.get("node_id");
    if (state.data.graph.nodes.some(node => node.id === candidate)) return candidate;
  } catch (_error) {
    return null;
  }
  return null;
}

function applyScannedLocation(nodeId) {
  const node = nodeById(nodeId);
  if (!node) return;
  $("start").value = nodeId;
  state.locationSource = "qr";
  state.hasQrStart = true;
  state.activeFloor = node.floor;
  updateQueryStart(nodeId);
  updateCurrentLocation();
  findRoute();
}

function completeScan(payload) {
  stopCamera();
  const nodeId = nodeIdFromPayload(payload);
  const node = nodeId ? nodeById(nodeId) : null;
  $("cameraFallback").hidden = true;
  $("cameraPlaceholder").classList.add("camera-placeholder--hidden");
  $("scannerView").className = `scanner-view scanner-view--success${node ? "" : " scanner-view--invalid"}`;
  $("scanPayload").textContent = payload ? String(payload).slice(0, 180) : "QR-код без текста";
  if (node) {
    applyScannedLocation(node.id);
    $("scanSuccessTitle").textContent = node.label;
    $("scanSuccessText").textContent = `Старт обновлён: ${formatFloor(node.floor).toLowerCase()}. Маршрут уже перестроен.`;
  } else {
    $("scanSuccessKicker").textContent = "Неизвестная метка";
    $("scanSuccessTitle").textContent = "Точка не найдена";
    $("scanSuccessText").textContent = "Этот QR-код не содержит известный start_node или node_id. Попробуйте метку навигатора ещё раз.";
    $("scannerContinueButton").hidden = true;
    $("scanSuccess").querySelector("use")?.setAttribute("href", "#icon-alert");
  }
  $("scanSuccess").hidden = false;
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
  $("cameraFallbackTitle").textContent = "Ищем QR-код…";
  $("cameraFallbackText").textContent = "Обрабатываем снимок прямо на устройстве.";
  try {
    const image = await loadImageFile(file);
    const payload = decodeCanvasSource(image, image.naturalWidth, image.naturalHeight);
    if (payload !== null) completeScan(payload);
    else showCameraFallback("QR-код не найден", "Попробуйте снять код ближе, без бликов и целиком внутри кадра.", window.isSecureContext);
  } catch (_error) {
    showCameraFallback("Не удалось прочитать снимок", "Сделайте новый снимок или выберите другое изображение.", window.isSecureContext);
  }
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

function savedGroup() {
  try { return localStorage.getItem("navigator_group") || ""; }
  catch (_error) { return ""; }
}

function saveGroup(groupId) {
  try { localStorage.setItem("navigator_group", groupId); }
  catch (_error) { /* Хранилище может быть отключено политикой браузера. */ }
}

function updateQueryStart(id) {
  const url = new URL(window.location.href);
  url.searchParams.delete("node_id");
  url.searchParams.set("start_node", id);
  history.replaceState({}, "", url);
}

function updateCurrentLocation() {
  const current = nodeById($("start").value);
  $("currentLocation").textContent = current ? `${current.label} · ${formatFloor(current.floor)}` : "Точка не выбрана";
}

function updateScheduleSource(demo) {
  const source = $("scheduleSource");
  source.textContent = demo ? "Тестовое расписание для проверки функционала" : "Актуальное расписание корпуса";
  source.classList.toggle("schedule-source--real", !demo);
}

function dataMode(data) {
  return data.graph.demo || data.schedule?.demo ? "DEMO" : "Production";
}

function defaultScheduleTime(timetable, groupId, currentTime, demo) {
  if (!demo || timetable.some(lesson => lesson.group_id === groupId && `${lesson.date}T${lesson.end}` > currentTime)) {
    return currentTime;
  }
  const firstLesson = timetable
    .filter(lesson => lesson.group_id === groupId)
    .sort((first, second) => `${first.date}T${first.start}`.localeCompare(`${second.date}T${second.start}`))[0];
  return firstLesson ? `${firstLesson.date}T${firstLesson.start}` : currentTime;
}

function populateControls() {
  const {graph, timetable} = state.data;
  const start = $("start");
  const target = $("target");
  const group = $("group");
  start.replaceChildren();
  target.replaceChildren();
  group.replaceChildren();

  for (const node of graph.nodes) option(start, node.id, `${node.label} · ${formatFloor(node.floor)}`);
  for (const node of graph.nodes.filter(node => node.room)) option(target, node.id, node.label);
  for (const groupId of [...new Set(timetable.map(lesson => lesson.group_id))]) option(group, groupId, groupId);

  const query = new URLSearchParams(location.search);
  const queryStart = query.get("start_node") || query.get("node_id");
  const knownStart = graph.nodes.some(node => node.id === queryStart);
  const fallbackStart = graph.nodes.some(node => node.id === "entrance") ? "entrance" : graph.nodes[0].id;
  start.value = knownStart ? queryStart : fallbackStart;

  const queryTarget = query.get("target");
  const knownTarget = graph.nodes.some(node => node.id === queryTarget && node.room);
  const fallbackTarget = graph.nodes.some(node => node.id === "lab1") ? "lab1" : target.options[0]?.value;
  target.value = knownTarget ? queryTarget : fallbackTarget;
  state.explicitTarget = knownTarget;

  const preferredGroup = query.get("group_id") || savedGroup() || "ИСП-21";
  group.value = [...group.options].some(item => item.value === preferredGroup) ? preferredGroup : group.options[0]?.value;
  const queryTime = query.get("at");
  const currentTime = currentLocalTime(graph.timezone);
  $("clock").value = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(queryTime || "")
    ? queryTime
    : defaultScheduleTime(timetable, group.value, currentTime, Boolean(state.data.schedule?.demo));

  state.accessible = ["1", "true"].includes((query.get("accessible") || "").toLowerCase());
  state.activeFloor = nodeById(start.value).floor;
  state.locationSource = knownStart ? "qr" : "manual";
  state.hasQrStart = knownStart;
  updateCurrentLocation();

  if (queryStart && !knownStart) {
    setTimeout(() => showToast("QR содержит неизвестную точку — выбран главный вход", "error"), 150);
  }
}

function populateSettings() {
  const list = $("closedList");
  list.replaceChildren();
  state.closed = new Set(state.data.graph.edges.filter(edge => edge.closed === true).map(edge => edge.id));
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
    input.checked = edge.closed === true;
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
  if (!state.lesson) {
    card.hidden = true;
    return;
  }
  const lesson = state.lesson;
  const room = nodeById(lesson.room_id);
  const currentTime = $("clock").value;
  $("lessonState").textContent = currentTime >= `${lesson.date}T${lesson.start}` ? "Идёт сейчас" : "Следующая пара";
  $("lessonTime").textContent = `${lesson.start}–${lesson.end}`;
  $("lessonTitle").textContent = lesson.title;
  $("lessonRoom").textContent = `${room.label} · ${formatFloor(room.floor)}`;
  card.hidden = false;
}

async function goToNextLesson({silent = false, advance = false} = {}) {
  const requestId = ++state.lessonRequest;
  const button = $("nextLessonButton");
  const groupId = $("group").value;
  const selectedTime = $("clock").value;
  const lookupTime = advance && state.lesson?.group_id === groupId
    ? `${state.lesson.date}T${state.lesson.end}`
    : selectedTime;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const query = new URLSearchParams({group_id: groupId, at: lookupTime});
    const response = await fetch(`/api/timetable?${query}`, {cache: "no-store"});
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    if (requestId !== state.lessonRequest) return;
    const lesson = payload.lesson;
    if (!lesson) {
      // При последовательном просмотре сохраняем последнюю пару, чтобы повторное
      // нажатие не начинало расписание заново с выбранного времени.
      if (!advance) {
        state.lesson = null;
        renderLesson();
        findRoute();
      }
      if (!silent) {
        const message = advance && state.lesson
          ? "После этой пары занятий больше нет"
          : "Для выбранного времени занятий больше нет";
        showToast(message, "error");
      }
      return;
    }
    if (!nodeById(lesson.room_id)) throw new Error("В расписании указана новая аудитория — обновите страницу");
    state.lesson = lesson;
    $("target").value = lesson.room_id;
    state.explicitTarget = false;
    renderLesson();
    findRoute();
    if (advance && !silent) {
      const room = nodeById(lesson.room_id);
      showToast(`Следующая пара: ${lesson.start} · ${room.label}`);
    }
  } catch (error) {
    if (requestId !== state.lessonRequest) return;
    // При кратком сетевом сбое интерфейс остаётся работоспособным на уже загруженной копии.
    try {
      const fallback = window.NavigatorGraph.nextLesson(state.data.timetable, groupId, lookupTime);
      if (fallback) {
        state.lesson = fallback;
        $("target").value = fallback.room_id;
        renderLesson();
        findRoute();
      } else {
        state.lesson = null;
        renderLesson();
        findRoute();
      }
    } catch (_fallbackError) {
      // Исходная ошибка API содержит более полезную диагностику.
    }
    showToast(`Расписание не обновлено: ${error.message}`, "error");
  } finally {
    if (requestId === state.lessonRequest) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
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
  renderRouteOptions(container);

  if (!state.result) {
    const error = document.createElement("div");
    error.className = "route-error";
    error.append(icon("alert"));
    const copy = document.createElement("div");
    const title = document.createElement("h3");
    title.id = "routeResultTitle";
    title.textContent = "Маршрут недоступен";
    const text = document.createElement("p");
    text.textContent = state.accessible && state.alternatives.fastest
      ? "Безбарьерного пути нет. Выберите быстрый маршрут или откройте доступный проход."
      : "Откройте один из проходов или измените параметры пути.";
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
  for (const [value, label] of [[`${result.length_m} м`, "расстояние"], [`~${minutes} мин`, "пешком"], [String(routeFloors.size), routeFloors.size === 1 ? "этаж" : "этажа"]]) {
    const metric = document.createElement("span");
    metric.className = "route-metric";
    const strong = document.createElement("strong");
    strong.textContent = value;
    const small = document.createElement("span");
    small.textContent = label;
    metric.append(strong, small);
    metrics.append(metric);
  }
  summary.append(metrics);
  container.append(summary);

  const stepsHead = document.createElement("div");
  stepsHead.className = "steps-head";
  const stepsTitle = document.createElement("h3");
  stepsTitle.textContent = "По шагам";
  const stepsCount = document.createElement("span");
  stepsCount.textContent = formatStepCount(result.edges.length + 1);
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

  result.edges.forEach((edgeId, index) => {
    const edge = edgeById(edgeId);
    const from = nodeById(result.nodes[index]);
    const to = nodeById(result.nodes[index + 1]);
    list.append(createRouteStep({
      title: instructionFor(edge, from, to),
      subtitle: `${to.label} · ${formatFloor(to.floor)}`,
      distance: `${edge.length_m} м`,
      floor: to.floor,
      iconName: stepIcon(edge, from, to),
      last: index === result.edges.length - 1
    }));
  });
  container.append(list);
}

function edgePoints(edge, floorId) {
  if (edge.path && edge.path[floorId]) return edge.path[floorId];
  const from = nodeById(edge.from);
  const to = nodeById(edge.to);
  if (from.floor === floorId && to.floor === floorId) return [[from.x, from.y], [to.x, to.y]];
  return null;
}

function drawPlan(svg, floor) {
  svg.append(svgElement("rect", {x: 18, y: 28, width: 404, height: 234, rx: 8, class: "floor-shell"}));
  for (const zone of floor.zones || []) {
    const className = zone.type === "corridor" ? "map-corridor" : `map-room${zone.type === "service" || zone.type === "stairs" || zone.type === "lift" ? " map-room--service" : ""}`;
    svg.append(svgElement("rect", {x: zone.x, y: zone.y, width: zone.width, height: zone.height, rx: zone.type === "corridor" ? 0 : 3, class: className}));
    if (zone.label) svg.append(svgElement("text", {x: zone.x + zone.width / 2, y: zone.y + zone.height / 2 + 3, class: "map-room-label"}, zone.label));
    if (zone.type === "stairs") {
      for (let offset = 11; offset < zone.width - 4; offset += 9) {
        svg.append(svgElement("line", {x1: zone.x + offset, y1: zone.y + 9, x2: zone.x + offset, y2: zone.y + zone.height - 9, class: "stairs-lines"}));
      }
    }
    if (zone.type === "lift") {
      const cx = zone.x + zone.width / 2;
      const cy = zone.y + zone.height / 2;
      svg.append(svgElement("path", {d: `M${cx} ${cy-13}v26M${cx-5} ${cy-8}l5-5 5 5M${cx-5} ${cy+8}l5 5 5-5`, class: "lift-glyph"}));
    }
  }
  svg.append(svgElement("text", {x: 385, y: 248, class: "map-floor-label", "text-anchor": "end"}, floor.id));
}

function drawMarker(svg, node, kind) {
  if (kind === "start") svg.append(svgElement("circle", {cx: node.x, cy: node.y, r: 19, class: "map-node-pulse", style: `transform-origin:${node.x}px ${node.y}px`}));
  const circleClass = kind === "start" ? "map-marker-start" : "map-marker-end";
  svg.append(svgElement("circle", {cx: node.x, cy: node.y, r: 12, class: circleClass}));
  svg.append(svgElement("text", {x: node.x, y: node.y + .5, class: `map-marker-letter${kind === "end" ? " map-marker-letter--end" : ""}`}, kind === "start" ? "A" : "B"));

  const label = kind === "start" ? "Вы здесь" : node.label.replace("Аудитория ", "");
  const width = Math.max(51, Math.min(105, label.length * 5.2 + 16));
  const labelY = Math.max(34, node.y - 34);
  svg.append(svgElement("rect", {x: node.x - width / 2, y: labelY - 13, width, height: 19, rx: 7, class: "map-node-label-bg"}));
  svg.append(svgElement("text", {x: node.x, y: labelY, class: "map-node-label"}, label));
}

function renderFloorTabs() {
  const tabs = $("floorTabs");
  tabs.replaceChildren();
  const routeFloors = new Set(state.result ? state.result.nodes.map(id => nodeById(id).floor) : []);
  for (const floor of state.data.graph.floors) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "floor-tab";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(state.activeFloor === floor.id));
    button.textContent = floor.label;
    if (routeFloors.has(floor.id)) {
      const dot = document.createElement("i");
      dot.className = "floor-tab__route";
      button.append(dot);
    }
    button.addEventListener("click", () => {
      state.activeFloor = floor.id;
      state.zoom = 1;
      renderMap();
    });
    tabs.append(button);
  }
}

function renderMap() {
  if (!state.data) return;
  renderFloorTabs();
  const floor = floorById(state.activeFloor) || state.data.graph.floors[0];
  const canvas = $("mapCanvas");
  canvas.replaceChildren();
  const viewWidth = 440 / state.zoom;
  const viewHeight = 290 / state.zoom;
  const viewX = (440 - viewWidth) / 2;
  const viewY = (290 - viewHeight) / 2;
  const svg = svgElement("svg", {
    viewBox: `${viewX} ${viewY} ${viewWidth} ${viewHeight}`,
    class: "floor-map",
    role: "img",
    "aria-label": `${floor.label}, схема маршрута`,
    preserveAspectRatio: "xMidYMid meet"
  });
  drawPlan(svg, floor);

  for (const edge of state.data.graph.edges) {
    const points = edgePoints(edge, floor.id);
    if (!points) continue;
    svg.append(svgElement("polyline", {
      points: points.map(point => point.join(",")).join(" "),
      class: `network-path${edge.closed === true || state.closed.has(edge.id) ? " network-path--closed" : ""}`
    }));
  }

  const selectedEdges = new Set(state.result?.edges || []);
  for (const edgeId of selectedEdges) {
    const edge = edgeById(edgeId);
    const points = edgePoints(edge, floor.id);
    if (!points) continue;
    const serialized = points.map(point => point.join(",")).join(" ");
    svg.append(svgElement("polyline", {points: serialized, class: "active-path-shadow"}));
    svg.append(svgElement("polyline", {points: serialized, class: "active-path", pathLength: 1}));
  }

  const selectedNodes = new Set(state.result?.nodes || []);
  for (const node of state.data.graph.nodes.filter(item => item.floor === floor.id && selectedNodes.has(item.id))) {
    svg.append(svgElement("circle", {cx: node.x, cy: node.y, r: 5, class: "map-node map-node--route"}));
  }

  const start = nodeById($("start").value);
  const target = nodeById($("target").value);
  if (start.floor === floor.id) drawMarker(svg, start, "start");
  if (target.floor === floor.id) drawMarker(svg, target, "end");
  canvas.append(svg);

  const status = $("mapStatus");
  status.className = `map-status${state.result ? "" : " map-status--error"}`;
  status.replaceChildren(document.createElement("span"), document.createTextNode(state.result ? ` Маршрут · ${state.result.length_m} м` : " Путь не найден"));
  $("zoomIn").disabled = state.zoom >= 1.6;
  $("zoomOut").disabled = state.zoom <= 1;
}

function findRoute() {
  if (!state.data) return;
  try {
    const start = $("start").value;
    const target = $("target").value;
    const closed = [...state.closed];
    const fastest = window.NavigatorGraph.route(state.data.graph, start, target, closed, false);
    const accessible = window.NavigatorGraph.route(state.data.graph, start, target, closed, true);
    state.alternatives = {fastest, accessible};
    state.result = state.accessible ? accessible : fastest;
    const currentFloor = nodeById(start).floor;
    const routeFloors = new Set(state.result ? state.result.nodes.map(id => nodeById(id).floor) : [currentFloor]);
    if (!routeFloors.has(state.activeFloor)) state.activeFloor = currentFloor;
    renderRouteResult();
    renderMap();
  } catch (error) {
    state.result = null;
    state.alternatives = {fastest: null, accessible: null};
    renderRouteResult();
    renderMap();
    showToast(error.message, "error");
  }
}

async function copyRouteLink() {
  const url = new URL(location.href);
  url.searchParams.delete("node_id");
  url.searchParams.set("start_node", $("start").value);
  url.searchParams.set("target", $("target").value);
  url.searchParams.set("group_id", $("group").value);
  url.searchParams.set("at", $("clock").value);
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

async function checkHealth({announce = true} = {}) {
  const button = $("healthButton");
  button.disabled = true;
  try {
    const response = await fetch("/api/health", {cache: "no-store"});
    const health = await response.json().catch(() => ({}));
    if (!response.ok || health.status !== "ok") throw new Error(health.error || `HTTP ${response.status}`);
    $("serverStatus").textContent = "API доступен";
    $("serverStatusDot").classList.remove("data-card__dot--error");
    const scheduleLabel = health.schedule_demo ? "тестовое расписание" : "расписание корпуса";
    $("dataVersion").textContent = `Версия ${health.graph_version || health.version} · ${health.mode} · ${scheduleLabel}`;
    $("modePill").lastChild.textContent = health.mode === "DEMO" ? " Демо-режим" : " Production";
    updateScheduleSource(Boolean(health.schedule_demo));
    if (announce) showToast("Сервер и данные доступны");
  } catch (error) {
    $("serverStatus").textContent = "API недоступен";
    $("serverStatusDot").classList.add("data-card__dot--error");
    $("dataVersion").textContent = error.message;
    if (announce) showToast(`Ошибка API: ${error.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

function bindEvents() {
  $("routeForm").addEventListener("submit", event => {
    event.preventDefault();
    state.lesson = null;
    renderLesson();
    findRoute();
  });
  $("nextLessonButton").addEventListener("click", () => goToNextLesson({advance: true}));
  $("target").addEventListener("change", () => {
    state.lesson = null;
    state.explicitTarget = true;
    renderLesson();
    findRoute();
  });
  $("group").addEventListener("change", () => {
    saveGroup($("group").value);
    state.lesson = null;
    renderLesson();
    goToNextLesson();
  });
  $("clock").addEventListener("change", () => {
    state.lesson = null;
    renderLesson();
    goToNextLesson();
  });
  $("start").addEventListener("change", () => {
    const start = nodeById($("start").value);
    state.locationSource = "manual";
    state.hasQrStart = false;
    state.activeFloor = start.floor;
    updateQueryStart(start.id);
    updateCurrentLocation();
    findRoute();
  });
  $("accessible").addEventListener("change", event => setAccessibility(event.target.checked));
  $("accessibleQuick").addEventListener("change", event => setAccessibility(event.target.checked));
  $("settingsButton").addEventListener("click", () => openDialog($("settingsDialog")));
  $("changeLocationButton").addEventListener("click", showScanner);
  $("copyRouteButton").addEventListener("click", copyRouteLink);
  $("healthButton").addEventListener("click", () => checkHealth());
  $("zoomIn").addEventListener("click", () => { state.zoom = Math.min(1.6, state.zoom + .2); renderMap(); });
  $("zoomOut").addEventListener("click", () => { state.zoom = Math.max(1, state.zoom - .2); renderMap(); });

  document.querySelectorAll(".dialog-close").forEach(button => {
    button.addEventListener("click", () => closeDialog(button.closest("dialog")));
  });
  document.querySelectorAll("dialog").forEach(dialog => {
    dialog.addEventListener("click", event => { if (event.target === dialog) closeDialog(dialog); });
  });

  $("scannerCloseButton").addEventListener("click", () => closeDialog($("scannerDialog")));
  $("continueWithoutScanButton").addEventListener("click", () => closeDialog($("scannerDialog")));
  $("scannerContinueButton").addEventListener("click", () => {
    closeDialog($("scannerDialog"));
    $("mapStage").scrollIntoView({behavior: "smooth", block: "center"});
  });
  $("cameraRetryButton").addEventListener("click", () => {
    resetScannerUi();
    startCamera();
  });
  $("scanAgainButton").addEventListener("click", () => {
    resetScannerUi();
    startCamera();
  });
  $("cameraCaptureButton").addEventListener("click", () => $("cameraCaptureInput").click());
  $("cameraCaptureInput").addEventListener("change", event => scanCapturedImage(event.target.files?.[0]));
  $("scannerDialog").addEventListener("close", stopCamera);
  $("scannerDialog").addEventListener("cancel", stopCamera);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && $("scannerDialog").open) stopCamera();
  });
}

async function boot() {
  try {
    const response = await fetch("/api/data", {cache: "no-store"});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    populateControls();
    populateSettings();
    const mode = dataMode(state.data);
    const scheduleDemo = Boolean(state.data.schedule?.demo);
    updateScheduleSource(scheduleDemo);
    $("modePill").lastChild.textContent = mode === "DEMO" ? " Демо-режим" : " Production";
    $("dataVersion").textContent = `Версия ${state.data.graph.version} · ${mode} · ${scheduleDemo ? "тестовое расписание" : "расписание корпуса"}`;
    bindEvents();
    updateSettingsState();
    if (state.explicitTarget) findRoute();
    else await goToNextLesson({silent: true});
    checkHealth({announce: false});
    if (!state.hasQrStart) showScanner();
  } catch (error) {
    const container = $("routeResult");
    container.innerHTML = "";
    const message = document.createElement("div");
    message.className = "route-error";
    message.append(icon("alert"));
    const copy = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = "Не удалось загрузить данные";
    const text = document.createElement("p");
    text.textContent = `${error.message}. Запустите приложение через python app.py.`;
    copy.append(title, text);
    message.append(copy);
    container.append(message);
    $("mapStatus").className = "map-status map-status--error";
    $("mapStatus").lastChild.textContent = " Данные недоступны";
  }
}

boot();
