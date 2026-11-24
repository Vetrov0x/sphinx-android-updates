(function () {
  "use strict";
  // GitHub may finish after the bounded local fallback. Bootstrap only once.
  if (window.__sphinxPortalStarted) return;
  window.__sphinxPortalStarted = true;
  var capturedInvite = typeof window.__sphinxInvite === "string" ? window.__sphinxInvite : "";
  delete window.__sphinxInvite;
  var byId = function (id) { return document.getElementById(id); };
  var session = null, devices = [], activeProfile = null, pendingReport = null, accountLoadVersion = 0, profileLoadVersion = 0;
  var activeRequests = new Set(), recoveryLoadVersion=0, pendingRecoveryAnswer=null, recoveryRows=[];
  var platformLabels = {android:"Android",iphone:"iPhone / iPad",win10:"Windows 10 / 11",win7:"Windows 7",mac:"Mac"};
  var clientLabels = {amnezia:"Amnezia",v2rayng:"v2rayNG",v2rayn:"v2rayN",clashverge:"Clash Verge",hiddify:"Hiddify",other:"Другое приложение"};
  var symptomLabels = {disconnect:"Периодически отключается",connected_nointernet:"Подключено, но сайты не открываются",slow:"Медленно работает",setup:"Настраиваю впервые"};
  var providerLabels = {beeline:"Билайн",mts:"МТС",megafon:"МегаФон",tele2:"Т2 (Теле2)",yota:"Yota",rostelecom:"Ростелеком",domru:"Дом.ру",mgts:"МГТС",other:"Другой / не знаю"};
  function validInvitationEntry(value) {
    if (/^[A-Za-z0-9_-]{43}$/.test(value)) return true;
    if (value.length > 160) return false;
    var phrase=value.normalize("NFKC").trim().replace(/\p{White_Space}+/gu," ").toLocaleLowerCase("ru").replace(/ё/g,"е");
    return phrase.length>=8&&phrase.length<=120&&/^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+){1,7}$/u.test(phrase);
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function showError(id, message, field) {
    if (field && field.id === "invite-code") { byId("invite-entry").hidden = false; byId("invite-ready").hidden = true; }
    var target = byId(id); target.textContent = message; target.hidden = false;
    if (field) { field.setAttribute("aria-invalid", "true"); field.focus(); }
  }
  function clearError(id) {
    byId(id).textContent = ""; byId(id).hidden = true;
  }
  function toast(message) {
    var node = byId("global-status"); node.textContent = message; node.hidden = false;
    window.clearTimeout(toast.timer); toast.timer = window.setTimeout(function () { node.hidden = true; }, 5500);
  }
  function requestId() {
    var bytes = new Uint8Array(16); window.crypto.getRandomValues(bytes);
    return Array.from(bytes, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }
  function friendlyError(error) {
    if (error.status === 401) return "Войдите снова с кодом доступа.";
    if (error.status === 403) return "Действие недоступно. Обновите страницу или свяжитесь с оператором.";
    if (error.status === 409) return "Данные изменились. Список обновлён — проверьте выбор и попробуйте снова.";
    if (error.status === 429) return "Слишком много попыток. Попробуйте через минуту.";
    if (error.status >= 500) return "Сервис временно не отвечает. Попробуйте позже; инструкции ниже остаются доступны.";
    if (error.uncertain) return error.message;
    if (error.network) return "Не удалось получить ответ. Проверьте интернет и попробуйте снова.";
    return typeof error.message === "string" && error.message.length < 280 ? error.message : "Не удалось выполнить действие. Проверьте поля и попробуйте снова.";
  }
  var accessBusy = false;
  function accessControls(disabled) {
    accessBusy = disabled;
    byId("access-fields").disabled = disabled;
    byId("access-check").disabled = disabled;
    byId("access-enter").disabled = disabled;
  }
  function showAccess(state, focus) {
    var text = {
      pending:"Заявка принята. Проверьте статус в этом же браузере.",
      approved:"Доступ открыт.",
      rejected:"Оператор отклонил заявку."
    };
    if (!["none", "pending", "approved", "rejected"].includes(state)) throw new Error("Не удалось прочитать статус заявки.");
    var status = byId("access-status");
    status.textContent = text[state] || "";
    status.hidden = state === "none";
    byId("access-form").hidden = state !== "none";
    byId("access-check").hidden = state !== "pending";
    byId("access-enter").hidden = state !== "approved";
    if (focus && !status.hidden) status.focus();
  }
  async function checkAccess(focus) {
    if (accessBusy) return;
    accessControls(true); clearError("access-error");
    try { showAccess((await api("/portal/access/status")).state, focus); }
    catch (error) { showError("access-error", friendlyError(error)); }
    finally { accessControls(false); }
  }
  // Separate origins keep browser connection pools apart. Reserve for a possible
  // preflight even when its cache means the browser does not send one.
  var poolCooldown = 30000, poolCursor = 1;
  var usePortPools = !!window.location && window.location.origin === "https://sphinx.md";
  var portPools = [443,2053,2083,2087,2096,8443].map(function (port) {
    return {port:port,used:port === 443 ? 2 : 0,at:Date.now()};
  });
  function cancelledRequest() { var error = new Error("Запрос отменён."); error.network = true; error.cancelled = true; return error; }
  function poolPause(milliseconds, signal) {
    return new Promise(function (resolve, reject) {
      if (signal.aborted) { reject(cancelledRequest()); return; }
      var timer = window.setTimeout(done, milliseconds);
      function done() { signal.removeEventListener("abort", abort); resolve(); }
      function abort() { window.clearTimeout(timer); signal.removeEventListener("abort", abort); reject(cancelledRequest()); }
      signal.addEventListener("abort", abort, {once:true});
    });
  }
  async function reservePool(post, signal, primaryOnly) {
    if (!usePortPools) { if (signal.aborted) throw cancelledRequest(); return null; }
    while (true) {
      if (signal.aborted) throw cancelledRequest();
      var now = Date.now(), wait = poolCooldown;
      for (var offset = 0; offset < (primaryOnly ? 1 : portPools.length); offset++) {
        var index = primaryOnly ? 0 : (poolCursor + offset) % portPools.length, pool = portPools[index];
        if (pool.used && now - pool.at >= poolCooldown) pool.used = 0;
        var cost = post && pool.port !== 443 ? 2 : 1;
        if ((!post || pool.used === 0) && pool.used + cost <= 2) {
          pool.used += cost; pool.at = now;
          poolCursor = pool.used === 2 ? (index + 1) % portPools.length : index;
          return pool;
        }
        wait = Math.min(wait, Math.max(1, pool.at + poolCooldown - now));
      }
      await poolPause(wait, signal);
    }
  }
  function retirePool(pool) {
    if (!pool) return;
    pool.used = 2; pool.at = Date.now();
    if (portPools[poolCursor] === pool) poolCursor = (poolCursor + 1) % portPools.length;
  }
  async function api(path, body, format) {
    var operation = new AbortController(), post = body !== undefined, primaryOnly = false;
    activeRequests.add(operation);
    try {
      for (var attempt = 0; attempt < (post ? 1 : 3); attempt++) {
        var pool = await reservePool(post, operation.signal, primaryOnly);
        var controller = new AbortController();
        var abort = function () { controller.abort(); };
        operation.signal.addEventListener("abort", abort, {once:true});
        var timedOut = false;
        var timer = window.setTimeout(function () { timedOut = true; controller.abort(); }, 5000);
        var options = {method:post ? "POST" : "GET",credentials:"include",cache:"no-store",redirect:"error",signal:controller.signal,headers:{Accept:format === "text" ? "text/plain" : "application/json"}};
        if (post) {
          options.headers["Content-Type"] = "application/json";
          if (session && session.csrf) options.headers["X-CSRF-Token"] = session.csrf;
          options.body = JSON.stringify(body);
        }
        try {
          if (operation.signal.aborted) throw cancelledRequest();
          var response = await fetch((pool && pool.port !== 443 ? "https://sphinx.md:" + pool.port : "") + path, options);
          var data = response.ok && format === "text" ? await response.text() : await response.json();
          if (operation.signal.aborted) throw cancelledRequest();
          if (!response.ok) {
            var failure = new Error(data.message || "Запрос не выполнен."); failure.status = response.status; failure.code = data.code; throw failure;
          }
          return data;
        } catch (error) {
          if (operation.signal.aborted || error.cancelled) throw cancelledRequest();
          if (error.status) throw error;
          retirePool(pool);
          if (post || attempt === 2) {
            var networkError = new Error(post ? "Ответ не получен. Действие могло выполниться. Обновите кабинет и проверьте результат перед повтором." : "Ответ не получен");
            networkError.network = true; networkError.uncertain = post; throw networkError;
          }
          // An unavailable alternate may be blocked by this network. Fall back
          // to 443, respecting its budget and cooldown before sending again.
          primaryOnly = !!pool && pool.port !== 443 && !timedOut && error.name === "TypeError";
        } finally {
          window.clearTimeout(timer); operation.signal.removeEventListener("abort", abort);
        }
      }
    } finally { activeRequests.delete(operation); }
  }
  function hideProfile() {
    profileLoadVersion++; activeProfile = null; byId("profile-content").value = ""; byId("profile-panel").hidden = true; byId("profile-status").textContent = "";
  }
  function clearAccount() {
    accountLoadVersion++;
    activeRequests.forEach(function (controller) { controller.abort(); });
    session = null; devices = []; pendingReport = null; recoveryRows=[]; pendingRecoveryAnswer=null; recoveryLoadVersion++; var recoveryPanel=byId("recovery-panel"); if(recoveryPanel){recoveryPanel.replaceChildren();recoveryPanel.hidden=true;} hideProfile();
    var ownerLink=byId("owner-people-link");if(ownerLink)ownerLink.remove();
    byId("devices-list").replaceChildren(); byId("cases-list").replaceChildren(); byId("account-name").textContent = "";
    byId("report-form").reset(); byId("report-disclosure").open = false; byId("cases-panel").open = false; byId("invite-entry").hidden = false; byId("invite-ready").hidden = true; byId("report-status").textContent = "";
    byId("account-view").hidden = true; byId("public-view").hidden = false; byId("help").hidden = false;
  }
  function appendOptions(select, options) {
    Object.keys(options).forEach(function (value) { var option = element("option", "", options[value]); option.value = value; select.appendChild(option); });
  }
  function profilePath(device, kind, download, format) {
    return "/portal/devices/" + encodeURIComponent(device.id) + (download ? "/download" : "/profile") + "?kind=" + encodeURIComponent(kind) + (format ? "&format=" + encodeURIComponent(format) : "");
  }
  async function openProfile(device, kind, button, format) {
    button.disabled = true; hideProfile(); var version = accountLoadVersion, profileVersion = profileLoadVersion;
    try {
      var data = await api(profilePath(device, kind, false, format));
      if (!session || version !== accountLoadVersion || profileVersion !== profileLoadVersion) return;
      if (typeof data.content !== "string" || !["uri", "clash_yaml"].includes(data.format)) throw new Error("Профиль пока недоступен. Обновите список устройств.");
      activeProfile = {device:device,kind:kind,format:data.format,button:button};
      byId("profile-title").textContent = data.label || device.label;
      byId("profile-content").value = data.content;
      byId("profile-status").textContent = Array.isArray(data.instructions) ? data.instructions.slice(0, 5).join(" ") : "";
      byId("profile-panel").hidden = false; byId("profile-title").focus(); byId("profile-panel").scrollIntoView({block:"nearest"});
    } catch (error) { if (version === accountLoadVersion && profileVersion === profileLoadVersion) await handleAccountError(error); }
    finally { button.disabled = false; }
  }
  function recoveryPanel() {
    var panel=byId("recovery-panel"); if(!panel){panel=element("section","profile-panel");panel.id="recovery-panel";panel.setAttribute("aria-live","polite");panel.hidden=true;byId("devices-list").after(panel);}return panel;
  }
  async function openRecovery(device, episodeId) {
    if(!session)return; hideProfile();var version=accountLoadVersion,load=++recoveryLoadVersion,panel=recoveryPanel();panel.hidden=false;panel.replaceChildren(element("p","notice","Открываем проверку…"));
    try{if(!episodeId){var started=await api("/portal/recovery/"+encodeURIComponent(device.id)+"/start",{generation:device.generation,revision:session.revision,requestId:requestId()});if(!session||version!==accountLoadVersion||load!==recoveryLoadVersion)return;episodeId=started.episodeId;}
      var view=await api("/portal/recovery/"+encodeURIComponent(episodeId)+"/question",{});if(!session||version!==accountLoadVersion||load!==recoveryLoadVersion)return;renderRecoveryQuestion(device,view,version,load);
    }catch(error){if(version===accountLoadVersion&&load===recoveryLoadVersion){panel.replaceChildren(element("p","notice",friendlyError(error)));await handleAccountError(error);}}
  }
  function renderRecoveryQuestion(device,view,version,load) {
    var panel=recoveryPanel(),title=element("h2","",device.label+" · Проверка связи"),question=element("p","",view.title),buttons=element("div","button-row"),status=element("p","field-help");title.tabIndex=-1;panel.replaceChildren(title,question);panel.hidden=false;
    if(view.profileLabel)panel.appendChild(element("p","field-help",view.profileLabel+" · "+view.platform));
    async function answer(value){
      if(!session||version!==accountLoadVersion||load!==recoveryLoadVersion)return;var key=view.questionId+":"+value+":"+view.receiptId;if(!pendingRecoveryAnswer||pendingRecoveryAnswer.key!==key)pendingRecoveryAnswer={key:key,body:{questionId:view.questionId,receiptId:view.receiptId,value:value,requestId:requestId()}};var body=pendingRecoveryAnswer.body;buttons.querySelectorAll("button").forEach(function(b){b.disabled=true;});status.textContent="Сохраняем…";
      try{await api("/portal/recovery/"+encodeURIComponent(view.episodeId)+"/answer",body);if(!session||version!==accountLoadVersion||load!==recoveryLoadVersion)return;pendingRecoveryAnswer=null;await openRecovery(device,view.episodeId);}
      catch(error){if(version!==accountLoadVersion||load!==recoveryLoadVersion)return;if(!error.network)pendingRecoveryAnswer=null;status.textContent=friendlyError(error);buttons.querySelectorAll("button").forEach(function(b){b.disabled=false;});await handleAccountError(error);}
    }
    if(view.detail){var form=element("form",""),input=element("input","");input.type="text";input.maxLength=120;input.autocomplete="off";input.spellcheck=false;input.id="recovery-detail";var label=element("label","","До120 символов. Без ссылок, ключей и паролей. Можно «не знаю».");label.htmlFor=input.id;var submit=element("button","button button-primary","Ответить");submit.type="submit";form.append(label,input,submit);panel.appendChild(form);form.addEventListener("submit",function(event){event.preventDefault();if(input.value.trim())answer(input.value.trim());});}
    (Array.isArray(view.choices)?view.choices:[]).forEach(function(choice){var button=element("button","button button-outline",choice.label);button.type="button";button.addEventListener("click",function(){answer(choice.value);});buttons.appendChild(button);});
    if(view.kind==="outcome"&&view.profile){var profile=element("button","quiet-button","Открыть мой профиль");profile.type="button";profile.addEventListener("click",function(){openProfile(device,view.profile,profile,"uri");});buttons.appendChild(profile);}
    panel.append(buttons,status);title.focus();panel.scrollIntoView({block:"nearest"});
  }
  function openHelp(device) {
    if (device && (!Array.isArray(device.profiles) || !device.profiles.length)) { var help = byId("help"); help.hidden = false; help.open = true; help.querySelector("summary").focus(); help.scrollIntoView({block:"nearest"}); return; }
    var panel = byId("report-disclosure"); panel.open = true;
    if (device) { byId("report-device").value = device.id; if (clientLabels[device.client]) byId("report-client").value = device.client; }
    byId("report-symptom").focus(); panel.scrollIntoView({block:"nearest"});
  }
  function renderDevices() {
    var list = byId("devices-list"), select = byId("report-device"), previous = select.value;
    list.replaceChildren(); select.replaceChildren(element("option", "", "Выберите устройство")); select.firstChild.value = "";
    if (!devices.length) list.appendChild(element("p", "notice", "Устройств пока нет. Обратитесь к оператору."));
    devices.forEach(function (device) {
      var profiles = Array.isArray(device.profiles) ? device.profiles.filter(function (p) { return ["primary", "tcp_reserve"].includes(p.kind); }) : [];
      var card = element("article", "device-card"), header = element("div", "device-heading"), icon = element("span", "device-icon" + (["android", "iphone"].includes(device.platform) ? " phone" : "")), details = element("div", "device-details"); icon.setAttribute("aria-hidden", "true"); header.appendChild(icon);
      details.appendChild(element("h3", "", device.label || "Моё устройство"));
      details.appendChild(element("p", "device-meta", (platformLabels[device.platform] || "Устройство") + " · " + (clientLabels[device.client] || "Приложение VPN")));
      var state = element("p", "device-state"); state.appendChild(element("span", "state-dot")); state.appendChild(document.createTextNode(profiles.length ? "Профиль готов" : ["preparing", "requested"].includes(device.state) ? "Профиль готовится" : "Профиль пока недоступен")); details.appendChild(state); header.appendChild(details); card.appendChild(header);
      var actions = element("div", "device-actions"), mainProfile = profiles.find(function (p) { return p.kind === "tcp_reserve"; }) || profiles[0], connect = element("button", "button button-primary", "Подключить"); connect.type = "button"; connect.disabled = !mainProfile;
      connect.addEventListener("click", function () { if (mainProfile) openProfile(device, mainProfile.kind, connect, "uri"); }); actions.appendChild(connect);
      var check=element("button","quiet-button","Проверить связь");check.type="button";check.disabled=!mainProfile;check.addEventListener("click",function(){var row=recoveryRows.find(function(r){return r.deviceId===device.id;});openRecovery(device,row&&row.episodeId);});actions.appendChild(check);
      var help = element("button", "quiet-button", "Нужна помощь"); help.type = "button"; help.addEventListener("click", function () { openHelp(device); }); actions.appendChild(help); card.appendChild(actions);
      var alternatives = element("details", "device-formats"), summary = element("summary", "", "Другие варианты"), alternateActions = element("div", "device-format-actions"), count = 0; alternatives.appendChild(summary);
      profiles.forEach(function (profile) { var formats = Array.isArray(profile.formats) ? profile.formats : [profile.format || "uri"]; formats.filter(function (f) { return ["uri", "clash_yaml"].includes(f); }).forEach(function (format) {
        if (mainProfile === profile && format === "uri") return;
        var button = element("button", "quiet-button", format === "clash_yaml" ? "YAML для Clash · дополнительно" : profile.kind === "primary" ? "Основная VLESS-ссылка" : "Резервная VLESS-ссылка"); button.type = "button"; button.addEventListener("click", function () { openProfile(device, profile.kind, button, format); }); alternateActions.appendChild(button); count++;
      }); }); if (count) { alternatives.appendChild(alternateActions); card.appendChild(alternatives); }
      list.appendChild(card);
      if (profiles.length && Object.prototype.hasOwnProperty.call(platformLabels, device.platform)) { var option = element("option", "", device.label || "Моё устройство"); option.value = device.id; select.appendChild(option); }
    });
    if (devices.some(function (device) { return device.id === previous; }) && Array.from(select.options).some(function (o) { return o.value === previous; })) select.value = previous;
    else if (select.options.length === 2) select.selectedIndex = 1;
    byId("report-submit").disabled = select.options.length < 2;
    if (!byId("report-client").value && select.value) { var selected = devices.find(function (device) { return device.id === select.value; }); if (selected && clientLabels[selected.client]) byId("report-client").value = selected.client; }
  }
  function dateLabel(value) {
    var date = new Date(value); return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("ru-RU", {day:"numeric",month:"long"});
  }
  function notificationLabel(value) {
    return value === "confirmed" ? "Уведомление отправлено" : value === "unknown" ? "Доставка не подтверждена" : "Уведомление в очереди";
  }
  function renderCases(cases) {
    var list = byId("cases-list"); list.replaceChildren(); byId("cases-panel").hidden = cases.length === 0;
    cases.forEach(function (item, index) {
      var row = element("article", "case-row"), copy = element("div", "");
      copy.appendChild(element("h3", "", item.deviceLabel || "Обращение по устройству"));
      copy.appendChild(element("p", "", dateLabel(item.createdAt) + (dateLabel(item.createdAt) ? " · " : "") + notificationLabel(item.notification)));
      var detailButton = element("button", "quiet-button", "Открыть обращение"); detailButton.type = "button";
      var detail = element("div", "case-detail"); detail.id = "case-detail-" + index; detail.hidden = true;
      detailButton.setAttribute("aria-expanded", "false");
      detailButton.setAttribute("aria-controls", detail.id);
      detailButton.addEventListener("click", async function () {
        if (!detail.hidden) { detail.hidden = true; detailButton.setAttribute("aria-expanded", "false"); return; }
        detailButton.disabled = true; var version = accountLoadVersion;
        try { var data = await api("/portal/cases/" + encodeURIComponent(item.id)); if (!session || version !== accountLoadVersion) return; renderCaseDetail(detail, data); detail.hidden = false; detailButton.setAttribute("aria-expanded", "true"); }
        catch (error) { if (version === accountLoadVersion) await handleAccountError(error); } finally { detailButton.disabled = false; }
      });
      copy.appendChild(detailButton); copy.appendChild(detail); row.appendChild(copy); row.appendChild(element("span", "case-state", item.status === "resolved" ? "Решено" : "Открыто")); list.appendChild(row);
    });
  }
  function renderCaseDetail(target, item) {
    target.replaceChildren();
    if (Array.isArray(item.answers)) item.answers.slice(0, 12).forEach(function (answer) { target.appendChild(element("p", "", answer.label + ": " + answer.value)); });
    if (Array.isArray(item.recommendations)) item.recommendations.slice(0, 8).forEach(function (text) { target.appendChild(element("p", "", text)); });
    if (Array.isArray(item.questions)) item.questions.slice(0, 5).forEach(function (question) { target.appendChild(element("p", "", question.title + (question.summary ? ". " + question.summary : ""))); });
    var device = devices.find(function (d) { return d.id === item.deviceId; });
    if (device && item.status !== "resolved") {
      var fieldset = element("fieldset", "sites-feedback"), legend = element("legend", "", "Теперь нужные сайты открываются с VPN?"); fieldset.appendChild(legend);
      var controls = element("div", "button-row");
      [["yes","Да, открываются"],["no","Нет"],["unknown","Ещё не проверял"]].forEach(function (choice) {
        var button = element("button", "button button-outline", choice[1]); button.type = "button";
        var retryBody = null;
        button.addEventListener("click", async function () {
          if (!session) return; var version = accountLoadVersion; fieldset.disabled = true;
          if (!retryBody) retryBody = {value:choice[0],generation:device.generation,revision:session.revision,requestId:requestId()};
          try { await api("/portal/cases/" + encodeURIComponent(item.id) + "/sites", retryBody); if (!session || version !== accountLoadVersion) return; toast(choice[0] === "yes" ? "Спасибо. Вы подтвердили, что сайты открываются." : "Результат сохранён. Уведомление оператору в очереди."); await loadAccount(false); }
          catch (error) { if (!error.network) retryBody = null; if (version === accountLoadVersion) await handleAccountError(error); } finally { fieldset.disabled = false; }
        }); controls.appendChild(button);
      }); fieldset.appendChild(controls); target.appendChild(fieldset);
    }
  }
  async function loadAccount(focus) {
    var version = ++accountLoadVersion;
    var data = await api("/portal/bootstrap"), current = data.session;
    if (version !== accountLoadVersion) return;
    session = current; devices = Array.isArray(data.devices) ? data.devices : []; recoveryRows=Array.isArray(data.recoveries)?data.recoveries:[];
    var ownerLink=byId("owner-people-link");if(ownerLink)ownerLink.remove();
    if(current.operator===true){ownerLink=element("a","quiet-button","Люди");ownerLink.id="owner-people-link";ownerLink.href="/portal/owner/people";byId("account-name").parentNode.insertBefore(ownerLink,byId("logout-button"));}
    byId("account-name").textContent = current.user && current.user.name ? current.user.name : "Личный доступ";
    renderDevices(); renderCases(Array.isArray(data.cases) ? data.cases : []);
    byId("public-view").hidden = true; byId("account-view").hidden = false; byId("help").hidden = true;
    var awaiting=recoveryRows.find(function(r){return r.channel==="web"&&r.episodeId&&!r.complete;});if(awaiting){var recoveryDevice=devices.find(function(d){return d.id===awaiting.deviceId;});if(recoveryDevice)openRecovery(recoveryDevice,awaiting.episodeId);}
    byId("account-status").hidden = current.delivery !== "queued";
    byId("account-status").textContent = "Уведомления оператору в очереди. Обращение сохранится здесь.";
    if (focus) byId("account-title").focus();
  }
  async function handleAccountError(error) {
    if (error.status === 401 || error.status === 403) { clearAccount(); showError("login-error", friendlyError(error), byId("invite-code")); }
    else { toast(friendlyError(error)); if (error.status === 409) { hideProfile(); pendingReport = null; try { await loadAccount(false); } catch (_) { toast("Не удалось обновить данные. Обновите страницу."); } } }
  }

  if (window.__sphinxInviteBlocked) { showError("login-error", "Браузер не смог очистить личное приглашение из адреса. Закройте эту вкладку, откройте главную страницу сайта и вставьте код вручную."); return; }
  appendOptions(byId("report-symptom"), symptomLabels);
  appendOptions(byId("report-network"), {wifi:"Домашняя сеть · Wi-Fi / кабель",mobile:"Мобильная сеть"});
  appendOptions(byId("report-provider"), providerLabels); appendOptions(byId("report-client"), clientLabels);
  byId("login-fields").disabled = false;
  byId("access-fields").disabled = false;
  byId("access-request").addEventListener("toggle", function () { if (this.open) checkAccess(); });
  byId("access-check").addEventListener("click", function () { checkAccess(true); });
  byId("access-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    if (accessBusy) return;
    var name = byId("access-name").value.trim(), contact = byId("access-contact").value.trim();
    var compactPhone = contact.replace(/[\s().-]/g, "");
    var phone = /^\+?[1-9]\d{6,14}$/.test(compactPhone);
    clearError("access-error");
    if (!name) { showError("access-error", "Укажите имя.", byId("access-name")); return; }
    if (!phone && !/^@?[A-Za-z0-9_]{1,32}$/.test(contact)) {
      showError("access-error", "Укажите @ник или номер телефона с кодом страны.", byId("access-contact")); return;
    }
    var form = this;
    accessControls(true);
    try {
      var previous = await api("/portal/access/status");
      if (previous.state !== "none") { form.reset(); showAccess(previous.state, true); return; }
      var result = await api("/portal/access/request", {name:name,contactKind:phone?"phone":"telegram",contact:phone?compactPhone:contact});
      form.reset(); showAccess(result.state, true);
    } catch (error) {
      showError("access-error", error.status === 409 ? "Обновите страницу и отправьте заявку ещё раз." : friendlyError(error));
    } finally { accessControls(false); }
  });
  byId("access-form").addEventListener("input", function (event) {
    event.target.removeAttribute("aria-invalid"); clearError("access-error");
  });
  byId("access-enter").addEventListener("click", async function () {
    if (accessBusy) return;
    accessControls(true); clearError("access-error");
    try { await api("/portal/access/enter", {}); await loadAccount(true); }
    catch (error) { showError("access-error", error.status === 401 ? "Доступ недоступен. Проверьте статус заявки." : friendlyError(error)); }
    finally { accessControls(false); }
  });
  if (capturedInvite && validInvitationEntry(capturedInvite)) { byId("invite-code").value = capturedInvite; byId("invite-entry").hidden = true; byId("invite-ready").hidden = false; }
  else if (capturedInvite) showError("login-error", "Код в приглашении повреждён. Вставьте код вручную или попросите новое приглашение.");
  capturedInvite = "";
  byId("invite-code").addEventListener("input", function () { clearError("login-error"); this.removeAttribute("aria-invalid"); byId("invite-ready").hidden = true; });
  byId("login-form").addEventListener("submit", async function (event) {
    event.preventDefault(); clearError("login-error");
    var input = byId("invite-code"), invite = input.value.trim();
    if (!validInvitationEntry(invite)) { showError("login-error", "Вставьте полный код приглашения.", input); return; }
    accountLoadVersion++;
    var button = byId("login-submit"); button.disabled = true; button.textContent = "Входим…"; input.value = ""; byId("invite-ready").hidden = true;
    try { await api("/portal/exchange", {invite:invite}); invite = ""; await loadAccount(true); }
    catch (error) {
      invite = "";
      if (error.network) {
        try { await loadAccount(true); return; } catch (_) { showError("login-error", "Обновите страницу и попробуйте войти снова.", input); }
      } else showError("login-error", error.status === 400 || error.status === 401 || error.status === 410 ? "Код не подходит. Проверьте его и попробуйте снова." : friendlyError(error), input);
    } finally { invite = ""; button.disabled = false; button.textContent = "Войти"; }
  });
  byId("logout-button").addEventListener("click", async function () {
    var button = this; button.disabled = true; hideProfile(); accountLoadVersion++;
    try { await api("/portal/logout", {}); clearAccount(); toast("Вы вышли из кабинета."); byId("invite-code").focus(); }
    catch (error) { await handleAccountError(error); } finally { button.disabled = false; }
  });
  byId("refresh-button").addEventListener("click", async function () { this.disabled = true; hideProfile(); try { await loadAccount(false); toast("Данные обновлены."); } catch (error) { await handleAccountError(error); } finally { this.disabled = false; } });
  byId("profile-close").addEventListener("click", function () { var button = activeProfile && activeProfile.button; hideProfile(); if (button && button.isConnected) button.focus(); });
  byId("profile-copy").addEventListener("click", async function () {
    if (!activeProfile) return;
    try { await navigator.clipboard.writeText(byId("profile-content").value); byId("profile-status").textContent = "Профиль скопирован. Теперь импортируйте его в приложение VPN."; }
    catch (_) { byId("profile-content").focus(); byId("profile-content").select(); byId("profile-status").textContent = "Профиль выделен. Скопируйте его вручную через меню браузера."; }
  });
  byId("profile-download").addEventListener("click", async function () {
    if (!activeProfile || !session) return;
    var button = this, profile = activeProfile, version = accountLoadVersion, profileVersion = profileLoadVersion;
    button.disabled = true;
    try {
      var content = await api(profilePath(profile.device, profile.kind, true, profile.format), undefined, "text");
      if (!session || version !== accountLoadVersion || profileVersion !== profileLoadVersion) return;
      var url = URL.createObjectURL(new Blob([content], {type:profile.format === "clash_yaml" ? "application/yaml" : "text/plain"}));
      var anchor = element("a", ""); anchor.href = url; anchor.download = profile.format === "clash_yaml" ? "sphinx-profile.yaml" : "sphinx-profile.txt";
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      byId("profile-status").textContent = "Запрошен файл профиля. Найдите его в загрузках и импортируйте в приложение VPN.";
    } catch (error) { if (version === accountLoadVersion && profileVersion === profileLoadVersion) await handleAccountError(error); }
    finally { button.disabled = false; }
  });
  byId("report-device").addEventListener("change", function () { var device = devices.find(function (d) { return d.id === byId("report-device").value; }); if (device && clientLabels[device.client]) byId("report-client").value = device.client; });
  byId("report-form").addEventListener("input", function (event) { event.target.removeAttribute("aria-invalid"); clearError("report-error"); });
  byId("report-form").addEventListener("submit", async function (event) {
    event.preventDefault(); clearError("report-error"); byId("report-status").textContent = "";
    if (!session) return;
    var required = ["report-device","report-symptom","report-network","report-provider","report-client"];
    var missing = required.find(function (id) { return !byId(id).value; });
    if (missing) { showError("report-error", "Выберите ответ в каждом поле.", byId(missing)); return; }
    var device = devices.find(function (d) { return d.id === byId("report-device").value; });
    if (!device) { showError("report-error", "Выберите устройство из своего списка.", byId("report-device")); return; }
    var answers = {device:device.platform,connection:byId("report-network").value,provider:byId("report-provider").value,client:byId("report-client").value,symptom:byId("report-symptom").value};
    var key = JSON.stringify({deviceId:device.id,generation:device.generation,answers:answers});
    if (!pendingReport || pendingReport.key !== key) pendingReport = {key:key,body:{deviceId:device.id,generation:device.generation,revision:session.revision,requestId:requestId(),answers:answers}};
    var version = accountLoadVersion, button = byId("report-submit"); button.disabled = true; button.textContent = "Сохраняем…";
    try { await api("/portal/incidents", pendingReport.body); if (!session || version !== accountLoadVersion) return; pendingReport = null; byId("report-status").textContent = "Обращение сохранено. Уведомление оператору в очереди. Статус можно посмотреть ниже."; await loadAccount(false); }
    catch (error) { if (version !== accountLoadVersion) return; if (!error.network) pendingReport = null; showError("report-error", friendlyError(error)); await handleAccountError(error); }
    finally { button.disabled = devices.length === 0; button.textContent = "Отправить"; }
  });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") hideProfile(); });
  window.addEventListener("pagehide", function () { clearAccount(); byId("invite-code").value = ""; byId("access-form").reset(); });
  window.addEventListener("pageshow", function (event) { if (event.persisted) loadAccount(false).catch(function () { clearAccount(); }); });
  loadAccount(false).catch(function (error) { if (error.status !== 401) showError("login-error", friendlyError(error)); });
})();
