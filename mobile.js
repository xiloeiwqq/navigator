"use strict";

const mobileViewport = matchMedia("(max-width: 600px)");
const reducedMobileMotion = matchMedia("(prefers-reduced-motion: reduce)");
let mobileSheetAnimations = [];
const mobile = {
  screen: "welcome",
  city: "",
  campusChosen: false,
  routeRequested: false,
  stepsOpen: false,
  menu: "",
  campusMenu: "",
  picking: "",
  error: "",
  scannerFrom: ""
};

const mobileErrors = {
  offline: {
    title: "Загрузка не удалась",
    text: "Похоже, пропал интернет. Проверь подключение к Wi-Fi кампуса и попробуй снова.",
    action: "Повторить"
  },
  blocked: {
    title: "Путь временно закрыт",
    text: "Зона или проход к ней сейчас недоступны. Выбери другое место или обратись к куратору.",
    image: "blocked.png",
    action: "Выбрать другое место"
  },
  campus: {
    title: "Корпус временно не работает",
    text: "Выбери другой корпус, чтобы построить маршрут.",
    image: "blocked.png",
    action: "Выбрать корпус"
  },
  camera: {
    title: "Камера недоступна",
    text: "Разреши доступ к камере в настройках браузера или выбери место вручную.",
    image: "camera-error.png",
    action: "Выбрать место"
  },
  qr: {
    title: "Не удалось распознать QR-код",
    text: "Код устарел или не относится к навигатору. Попробуй соседнюю табличку или выбери место вручную.",
    image: "qr-error.png",
    action: "Выбрать место"
  }
};

function mobilePlaceButton(field) {
  return $(field === "start" ? "mobileStart" : "mobileTarget");
}

function renderMobileCampus() {
  if (!state.catalog) return;
  const city = $("mobileCity");
  const campus = $("mobileCampus");
  const campuses = state.catalog.campuses;
  city.replaceChildren();
  campus.replaceChildren();
  option(city, "", "Выбери город");
  option(campus, "", "Выбери корпус");
  for (const name of [...new Set(campuses.map(item => item.city))].sort((a, b) => a.localeCompare(b, "ru"))) {
    option(city, name, name);
  }
  for (const item of campuses.filter(item => item.city === mobile.city).sort((a, b) => a.short_name.localeCompare(b.short_name, "ru"))) {
    option(campus, item.id, item.temporarily_closed ? `${item.short_name} · временно не работает` : item.short_name);
    campus.lastElementChild.disabled = item.temporarily_closed;
  }
  city.value = mobile.city;
  campus.value = mobile.campusChosen ? state.campusId : "";
  campus.disabled = !mobile.city;
  for (const select of [city, campus]) {
    const trigger = $(`${select.id}Trigger`);
    trigger.disabled = select.disabled;
    trigger.firstElementChild.textContent = select.selectedOptions[0]?.textContent || select.options[0].textContent;
  }
}

function renderMobileLesson() {
  const next = state.scheduleContext?.next;
  const room = next && nodeById(next.room_id);
  $("mobileLesson").hidden = !room || Boolean(state.dataError);
  if (room) {
    $("mobileLessonTitle").textContent = next.title;
    $("mobileLessonRoom").textContent = `${room.label} · ${formatFloor(room.floor)}`;
  }
  $("mobileScheduleRoute").disabled = $("nextLessonButton").disabled;
}

function renderMobile() {
  const start = state.data && nodeById($("start").value);
  const target = state.data && nodeById($("target").value);
  const ready = mobile.campusChosen && mobile.routeRequested && Boolean(state.result);
  const arrived = ready && (state.navigation.arrived || state.result.length_m === 0);
  const stepsOpen = ready && mobile.stepsOpen;
  const view = mobile.error ? "error" : mobile.screen;
  if (!ready || view !== "map") stopMobileSheetAnimation();
  document.body.dataset.mobileScreen = view;
  document.body.dataset.mobileCampus = String(mobile.campusChosen);
  document.body.dataset.mobileRoute = String(ready);
  document.body.dataset.mobileSteps = String(stepsOpen);
  if (!ready) delete $("mapCanvas").dataset.routeKey;
  $("mobileWelcome").hidden = view !== "welcome";
  $("mobileLocated").hidden = view !== "located";
  $("mobileError").hidden = view !== "error";
  $("mobileWelcomeScan").disabled = !state.data;
  $("mobileManual").disabled = !state.data;
  $("mobileRouteTitle").textContent = arrived ? "Ты на месте!" : ready ? "Маршрут построен" : "Твой маршрут";
  $("mobileEditRoute").hidden = !ready;
  $("mobileEditRoute").textContent = arrived ? "Построить новый маршрут" : "Изменить маршрут";
  $("mobileStepsToggle").hidden = !ready;
  $("mobileStepsToggle").setAttribute("aria-expanded", String(stepsOpen));
  $("mobileStepsToggle").setAttribute("aria-label", stepsOpen ? "Свернуть шаги маршрута" : "Показать шаги маршрута");
  $("mobileMapPrompt").hidden = !mobile.picking;
  $("mobileCopy").disabled = !ready;
  $("mobileReset").disabled = !start;
  $("mobileSwap").disabled = !mobile.campusChosen || (!start && !target);
  for (const [field, node] of [["start", start], ["target", target]]) {
    const button = mobilePlaceButton(field);
    button.disabled = !mobile.campusChosen;
    button.querySelector("strong").textContent = node && mobile.campusChosen
      ? `${node.label} · ${formatFloor(node.floor)}` : "Выбрать";
  }
  if (start) $("mobileLocation").textContent = `${start.label} · ${formatFloor(start.floor)}`;
  if (start && view === "located") {
    const floor = floorById(start.floor);
    const plan = $("mobileLocatedPlan");
    const photo = $("mobileCampusPhoto");
    const isVectorPlan = Boolean(floor?.outline && !floor.image);
    plan.toggleAttribute("hidden", !isVectorPlan);
    photo.hidden = isVectorPlan;
    if (isVectorPlan) {
      const key = `${state.campusId}:${floor.id}:${state.data.graph.version}`;
      if (plan.dataset.floorKey !== key) {
        const {x, y, width, height} = floor.outline;
        plan.setAttribute("viewBox", `${x - 2} ${y - 2} ${width + 4} ${height + 4}`);
        plan.setAttribute("aria-label", `План этажа · ${floor.label}`);
        plan.replaceChildren();
        drawPlan(plan, floor);
        plan.dataset.floorKey = key;
      }
    } else {
      const planImage = !state.data.graph.demo && floor?.image;
      const source = planImage || "/assets/mobile/campus-photo.png";
      if (photo.getAttribute("src") !== source) photo.src = source;
      photo.classList.toggle("mobile-campus-photo--plan", Boolean(planImage));
    }
  }
  renderMobileLesson();
}

function stopMobileSheetAnimation() {
  if (!mobileSheetAnimations.length) return;
  for (const animation of mobileSheetAnimations) animation.cancel();
  mobileSheetAnimations = [];
  const panel = $("mobileRoutePanel");
  panel.classList.remove("mobile-sheet-moving");
  panel.parentElement.style.removeProperty("--mobile-collapsed-sheet");
}

function toggleMobileSteps() {
  const panel = $("mobileRoutePanel");
  const controls = [$("floorTabs"), $("zoomIn").parentElement];
  const previousTops = controls.map(control => control.getBoundingClientRect().top);
  const previousHeight = panel.getBoundingClientRect().height;
  stopMobileSheetAnimation();
  mobile.stepsOpen = !mobile.stepsOpen;
  renderMobile();
  if (reducedMobileMotion.matches || !panel.animate) return;

  const height = panel.getBoundingClientRect().height;
  if (Math.abs(previousHeight - height) < 1) return;
  const timing = {duration: 260, easing: "cubic-bezier(.22, .7, .24, 1)", fill: "both"};
  if (!mobile.stepsOpen) panel.parentElement.style.setProperty("--mobile-collapsed-sheet", `${height}px`);
  panel.classList.add("mobile-sheet-moving");
  const sheet = panel.animate(
    [{height: `${previousHeight}px`}, {height: `${height}px`}],
    timing
  );
  mobileSheetAnimations = [sheet, ...controls.map((control, index) => {
    const offset = previousTops[index] - control.getBoundingClientRect().top;
    return control.animate([{translate: `0 ${offset}px`}, {translate: "0"}], timing);
  })];
  sheet.onfinish = stopMobileSheetAnimation;
}

function showMobileError(kind) {
  if (!mobileViewport.matches) return;
  const details = mobileErrors[kind];
  mobile.error = kind;
  $("mobileError").dataset.kind = kind;
  $("mobileErrorTitle").textContent = details.title;
  $("mobileErrorText").textContent = details.text;
  const offline = kind === "offline";
  if (!offline) $("mobileErrorImage").src = `/assets/mobile/${details.image}`;
  $("mobileErrorImage").hidden = offline;
  $("mobileOfflineImage").hidden = !offline;
  $("mobileWifiLabel").hidden = kind !== "offline";
  $("mobileErrorAction").textContent = details.action;
  $("mobileErrorRetry").hidden = kind !== "qr" && kind !== "camera";
  $("mobileErrorCapture").hidden = kind !== "camera";
  renderMobile();
}

function mobileFinishScan(node, errorKind = "qr") {
  if (!mobileViewport.matches) return;
  closeDialog($("scannerDialog"));
  if (!node) {
    showMobileError(errorKind);
    return;
  }
  if (mobile.scannerFrom !== "map") mobile.screen = "located";
  mobile.campusChosen = true;
  mobile.city = campusById(state.campusId).city;
  mobile.error = "";
  renderMobileCampus();
  renderMobile();
}

function mobileOpenScanner() {
  mobile.scannerFrom = mobile.screen;
  mobile.error = "";
  mobileCloseMenu();
  mobileCloseCampusMenu();
  mobilePick("");
  renderMobile();
  showScanner();
}

function mobileCloseCampusMenu(returnFocus = false) {
  if (!mobile.campusMenu) return;
  const field = mobile.campusMenu;
  mobile.campusMenu = "";
  const menu = $(`${field}Menu`);
  menu.hidden = true;
  menu.inert = true;
  const trigger = $(`${field}Trigger`);
  trigger.setAttribute("aria-expanded", "false");
  if (returnFocus) trigger.focus();
}

function mobileOpenCampusMenu(field) {
  const wasOpen = mobile.campusMenu === field;
  mobileCloseCampusMenu();
  mobileCloseMenu();
  if (wasOpen) return;
  mobile.campusMenu = field;
  const select = $(field);
  const trigger = $(`${field}Trigger`);
  const menu = $(`${field}Menu`);
  menu.replaceChildren();
  for (const option of select.options) {
    if (!option.value) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.textContent;
    button.disabled = option.disabled;
    button.classList.toggle("is-selected", option.selected);
    button.addEventListener("click", () => {
      mobileCloseCampusMenu(true);
      if (select.value === option.value) return;
      select.value = option.value;
      select.dispatchEvent(new Event("change"));
    });
    menu.append(button);
  }
  menu.inert = false;
  menu.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  menu.querySelector(".is-selected, button:not(:disabled)")?.focus();
}

function mobileCloseMenu(returnFocus = false) {
  if (!mobile.menu) return;
  const button = mobilePlaceButton(mobile.menu);
  button.setAttribute("aria-expanded", "false");
  const menu = $("mobilePlaceMenu");
  menu.hidden = true;
  menu.inert = true;
  mobile.menu = "";
  if (returnFocus) button.focus();
}

function mobilePick(field) {
  if (mobile.picking === field) return;
  mobile.picking = field;
  renderMobile();
  renderMap();
}

function mobileOpenPlaceMenu(field) {
  const wasOpen = mobile.menu === field;
  mobileCloseMenu();
  mobileCloseCampusMenu();
  mobilePick("");
  if (wasOpen) return;
  mobile.menu = field;
  const menu = $("mobilePlaceMenu");
  const trigger = mobilePlaceButton(field);
  menu.dataset.field = field;
  menu.replaceChildren();
  const addItem = (label, action, className = "") => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", action);
    menu.append(button);
    return button;
  };
  for (const item of $(field).options) {
    if (!item.value) continue;
    const button = addItem(item.textContent, () => mobileSelectPoint(field, item.value));
    button.classList.toggle("is-selected", item.selected);
  }
  const pick = addItem("Указать на карте", () => {
    mobileCloseMenu();
    mobilePick(field);
    $("mapCanvas").querySelector(".mobile-map-point")?.focus();
  }, "mobile-place-pick");
  const image = document.createElement("img");
  image.src = "/assets/mobile/pick.svg";
  image.alt = "";
  pick.prepend(image);
  menu.inert = false;
  menu.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  (menu.querySelector(".is-selected") || pick).focus();
}

function mobileSelectPoint(field, id) {
  mobileCloseMenu();
  mobile.picking = "";
  mobile.routeRequested = false;
  const select = $(field);
  select.value = id;
  select.dispatchEvent(new Event("change"));
  mobilePlaceButton(field).focus();
}

function drawMobilePickPoints(svg, floor) {
  if (!mobileViewport.matches || !mobile.picking) return;
  const field = mobile.picking;
  const options = new Set(Array.from($(field).options, item => item.value));
  const nodes = state.data.graph.nodes.filter(node => node.floor === floor.id && options.has(node.id));
  const zones = (floor.zones || []).filter(zone => zone.type !== "corridor");
  for (const node of nodes) {
    const zone = zones.find(item => item.node_id === node.id) || zones.find(item =>
      item.label === node.label && node.x >= item.x && node.x <= item.x + item.width &&
      node.y >= item.y && node.y <= item.y + item.height);
    const attributes = {class: "mobile-map-point", role: "button", tabindex: "0", "aria-label": node.label};
    const area = zone
      ? svgElement("rect", {...attributes, x: zone.x, y: zone.y, width: zone.width, height: zone.height, rx: zone.node_id ? 2 : 8})
      : svgElement("circle", {...attributes, cx: node.x, cy: node.y, r: 10});
    area.append(svgElement("title", {}, node.label));
    area.addEventListener("click", () => mobileSelectPoint(field, node.id));
    area.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      mobileSelectPoint(field, node.id);
    });
    svg.append(area);
  }
}

function bindMobileEvents() {
  const openMap = () => {
    mobile.screen = "map";
    mobile.error = "";
    renderMobile();
  };
  const editRoute = () => {
    mobile.routeRequested = false;
    mobile.stepsOpen = false;
    if (state.navigation.arrived || state.result?.length_m === 0) {
      moveStartToNode(nodeById($("target").value), "manual");
      $("target").value = "";
      findRoute();
    }
    openMap();
    if (state.mapRouteFrame) {
      state.mapRouteFrame = null;
      animateMapView(state.mapCenter, 0, Math.max(1, state.zoom));
    }
  };
  $("mobileManual").addEventListener("click", openMap);
  $("mobileChooseDestination").addEventListener("click", openMap);
  $("mobileChangeOrigin").addEventListener("click", () => {
    openMap();
    mobileOpenPlaceMenu("start");
  });
  $("mobileWelcomeScan").addEventListener("click", mobileOpenScanner);
  $("mobileScan").addEventListener("click", mobileOpenScanner);
  $("mobileErrorRetry").addEventListener("click", mobileOpenScanner);
  $("mobileErrorCapture").addEventListener("click", () => {
    $("cameraCaptureInput").value = "";
    $("cameraCaptureInput").click();
  });
  $("mobileErrorAction").addEventListener("click", async () => {
    if (mobile.error === "offline") {
      const button = $("mobileErrorAction");
      button.disabled = true;
      await (state.data ? refreshCampusData() : boot());
      button.disabled = false;
    } else if (mobile.error === "blocked") {
      editRoute();
      mobileOpenPlaceMenu("target");
    } else {
      openMap();
      if (mobile.campusChosen) mobileOpenPlaceMenu("start");
    }
  });
  $("mobileCity").addEventListener("change", event => {
    mobile.city = event.target.value;
    mobile.campusChosen = false;
    mobile.routeRequested = false;
    mobileCloseMenu();
    mobilePick("");
    renderMobileCampus();
    renderMobile();
  });
  $("mobileCityTrigger").addEventListener("click", () => mobileOpenCampusMenu("mobileCity"));
  $("mobileCampusTrigger").addEventListener("click", () => mobileOpenCampusMenu("mobileCampus"));
  $("mobileCampus").addEventListener("change", async event => {
    if (!event.target.value) {
      mobile.campusChosen = false;
      mobile.routeRequested = false;
      renderMobile();
      return;
    }
    $("mobileCity").disabled = true;
    $("mobileCampus").disabled = true;
    $("mobileCityTrigger").disabled = true;
    $("mobileCampusTrigger").disabled = true;
    try {
      await switchCampus(event.target.value);
    } catch (error) {
      showToast(`Не удалось переключить корпус: ${error.message}`, "error");
    } finally {
      $("mobileCity").disabled = false;
      renderMobileCampus();
      renderMobile();
    }
  });
  $("mobileStart").addEventListener("click", () => mobileOpenPlaceMenu("start"));
  $("mobileTarget").addEventListener("click", () => mobileOpenPlaceMenu("target"));
  $("mobileCancelPick").addEventListener("click", () => {
    const field = mobile.picking;
    mobilePick("");
    if (field) mobilePlaceButton(field).focus();
  });
  $("mobileSwap").addEventListener("click", () => {
    const start = $("start").value;
    const target = $("target").value;
    mobile.routeRequested = false;
    mobile.stepsOpen = false;
    $("target").value = [...$("target").options].some(item => item.value === start) ? start : "";
    $("start").value = target;
    if (start && !$("target").value) showToast("Стартовую точку нельзя выбрать как пункт назначения");
    $("start").dispatchEvent(new Event("change"));
    showMapDestination();
  });
  $("mobileEditRoute").addEventListener("click", editRoute);
  $("mobileStepsToggle").addEventListener("click", toggleMobileSteps);
  $("mobileLessonRoute").addEventListener("click", () => {
    const next = state.scheduleContext?.next;
    if (!next) return;
    $("target").value = next.room_id;
    openMap();
    $("routeForm").requestSubmit();
  });
  $("mobileSettings").addEventListener("click", () => openDialog($("settingsDialog")));
  $("mobileGroup").addEventListener("change", event => {
    $("group").value = event.target.value;
    $("group").dispatchEvent(new Event("change"));
  });
  $("mobileScheduleRoute").addEventListener("click", () => {
    closeDialog($("settingsDialog"));
    mobile.routeRequested = true;
    $("nextLessonButton").click();
  });
  for (const [mobileId, originalId] of [
    ["mobileDetect", "detectCampusButton"], ["mobileCompass", "compassButton"],
    ["mobileReset", "resetCalibrationButton"], ["mobileCopy", "copyRouteButton"]
  ]) {
    $(mobileId).addEventListener("click", () => $(originalId).click());
  }
  document.addEventListener("pointerdown", event => {
    if (mobile.menu && !event.target.closest(".mobile-places")) mobileCloseMenu();
    if (mobile.campusMenu && !event.target.closest(".mobile-select")) mobileCloseCampusMenu();
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    mobileCloseMenu(true);
    mobileCloseCampusMenu(true);
  });
  mobileViewport.addEventListener("change", () => {
    stopMobileSheetAnimation();
    mobileCloseMenu();
    mobileCloseCampusMenu();
    mobile.picking = "";
    state.manualMapView = false;
    state.mapAngle = 0;
    renderMap();
    renderMobile();
  });
  reducedMobileMotion.addEventListener("change", stopMobileSheetAnimation);
}
